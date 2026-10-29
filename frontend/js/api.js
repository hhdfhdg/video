// Клиент к серверу Cogniflux (app.py), который проксирует запросы к LM Studio.

export class ApiError extends Error {
  constructor(message, code = "error") {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

// Заголовок X-Cogniflux обязателен для изменяющих запросов: сервер отклоняет запросы без него.
const JSON_HEADERS = { "Content-Type": "application/json", "X-Cogniflux": "1" };

async function readApiError(res) {
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    // тело ответа не JSON
  }
  return new ApiError(
    data?.error?.message || `Ошибка сервера (HTTP ${res.status}).`,
    data?.error?.code || "http"
  );
}

function connectionProblem() {
  return new ApiError(
    "Не удалось связаться с сервером Cogniflux. Проверьте, что приложение (python app.py) запущено.",
    "local"
  );
}

function compactParams(params = {}) {
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") out[key] = value;
  }
  return out;
}

/** Список моделей LM Studio. Бросает ApiError с понятным сообщением. */
export async function fetchModels(settings) {
  let res;
  try {
    res = await fetch("/api/models", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ base_url: settings.baseUrl, api_key: settings.apiKey }),
    });
  } catch (_) {
    throw connectionProblem();
  }
  if (!res.ok) throw await readApiError(res);
  const data = await res.json();
  return Array.isArray(data.models) ? data.models : [];
}

/**
 * Потоковая генерация по SSE (OpenAI-compatible).
 * onDelta получает каждый фрагмент choices[0].delta.content.
 * Возвращает { toolCalls } — вызовы инструментов, собранные из фрагментов delta.tool_calls.
 */
export async function streamChat({ settings, messages, toolNames = [], signal, onDelta, onMeta }) {
  let res;
  try {
    res = await fetch("/api/chat", {
      method: "POST",
      headers: JSON_HEADERS,
      signal,
      body: JSON.stringify({
        base_url: settings.baseUrl,
        api_key: settings.apiKey,
        model: settings.model,
        messages,
        params: compactParams(settings.params),
        tool_names: toolNames,
      }),
    });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw connectionProblem();
  }
  if (!res.ok) throw await readApiError(res);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const calls = new Map();
  let buffer = "";
  let finished = false;
  let finishReason = null;

  const handleLine = (rawLine) => {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    if (payload === "[DONE]") {
      finished = true;
      return;
    }
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch (_) {
      return; // повреждённый фрагмент пропускаем
    }
    if (chunk.error) {
      throw new ApiError(chunk.error.message || "Ошибка в потоке ответа.", "stream");
    }
    if (chunk.meta) {
      onMeta?.(chunk.meta);
      return;
    }
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const delta = choice?.delta;
    if (delta?.content) onDelta(delta.content);
    if (Array.isArray(delta?.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const index = tc.index ?? 0;
        const cur = calls.get(index) || { id: "", name: "", arguments: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name && !cur.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.arguments += tc.function.arguments;
        calls.set(index, cur);
      }
    }
  };

  try {
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while (!finished && (nl = buffer.indexOf("\n")) !== -1) {
        handleLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    }
    if (!finished) {
      buffer += decoder.decode();
      if (buffer.trim()) handleLine(buffer);
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  const toolCalls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, c]) => ({
      id: c.id || `call_${Date.now()}_${index}`,
      name: c.name,
      arguments: c.arguments || "{}",
    }))
    .filter((c) => c.name);
  return { toolCalls, finishReason };
}

/** Запуск инструмента в рабочей папке чата. Возвращает { ok, result, file? }. */
export async function runTool(name, args, chatId) {
  let res;
  try {
    res = await fetch("/api/tools/run", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name, arguments: args, chat_id: chatId }),
    });
  } catch (_) {
    throw connectionProblem();
  }
  if (!res.ok) throw await readApiError(res);
  return res.json();
}

/** Извлечение текста из PDF/DOCX на сервере. Возвращает { text, truncated }. */
export async function extractFile(file) {
  const form = new FormData();
  form.append("file", file);
  let res;
  try {
    res = await fetch("/api/extract", { method: "POST", headers: { "X-Cogniflux": "1" }, body: form });
  } catch (_) {
    throw connectionProblem();
  }
  if (!res.ok) throw await readApiError(res);
  return res.json();
}

/** Удаляет рабочую папку чата на сервере (файлы, созданные моделью). */
export async function deleteChatFiles(chatId) {
  let res;
  try {
    res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/files`, {
      method: "DELETE",
      headers: { "X-Cogniflux": "1" },
    });
  } catch (_) {
    throw connectionProblem();
  }
  if (!res.ok) throw await readApiError(res);
  return res.json();
}
