// Разбор вызовов инструментов, написанных моделью в тексте ответа.
// Чистые функции без DOM и без глобального состояния, поэтому их можно проверять в Node.js.

export const TOOL_BLOCK_OPEN = "<tool_call>";
export const TOOL_BLOCK_CLOSE = "</tool_call>";

/** Сбалансированный JSON-объект, начиная с позиции start. Строки учитываются. Возвращает индекс «}» или -1. */
export function matchBrace(src, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = start; j < src.length; j++) {
    const c = src[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/** Строка — вызов известного инструмента с объектом arguments? Тогда канонический блок (JSON), иначе null. */
export function canonicalToolCall(chunk, names) {
  let obj;
  try {
    obj = JSON.parse(chunk);
  } catch (_) {
    return null;
  }
  if (!obj || typeof obj !== "object" || typeof obj.name !== "string" || !names.includes(obj.name)) return null;
  let args = obj.arguments ?? {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch (_) {
      return null;
    }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  return JSON.stringify({ name: obj.name, arguments: args });
}

/** Голые JSON-вызовы в тексте (один или несколько) приводятся к блокам с маркером. Текст вокруг сохраняется. */
export function normalizeBareToolCalls(content, names) {
  const src = content;
  if (src.includes(TOOL_BLOCK_OPEN) || !src.includes("{")) return content;
  let out = "";
  let changed = false;
  let i = 0;
  while (i < src.length) {
    if (src[i] !== "{") {
      out += src[i++];
      continue;
    }
    const end = matchBrace(src, i);
    const canonical = end < 0 ? null : canonicalToolCall(src.slice(i, end + 1), names);
    if (canonical) {
      out += `${TOOL_BLOCK_OPEN}${canonical}${TOOL_BLOCK_CLOSE}`;
      i = end + 1;
      changed = true;
    } else {
      out += src[i++];
    }
  }
  return changed ? out : content;
}

const GEMMA_QUOTE = '<|"|>';

/**
 * Формат модели: {key:<|"|>строка<|"|>, n:400} — ключи без кавычек, строки в маркерах.
 * Переводит такой объект в JSON. Возвращает строку JSON или null.
 */
export function gemmaObjectToJson(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src.startsWith(GEMMA_QUOTE, i)) {
      const end = src.indexOf(GEMMA_QUOTE, i + GEMMA_QUOTE.length);
      if (end < 0) return null;
      out += JSON.stringify(src.slice(i + GEMMA_QUOTE.length, end));
      i = end + GEMMA_QUOTE.length;
      continue;
    }
    const c = src[i];
    const prev = out.trimEnd().slice(-1);
    if (/[A-Za-z_]/.test(c) && (prev === "{" || prev === ",")) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      out += JSON.stringify(src.slice(i, j));
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  try {
    JSON.parse(out);
    return out;
  } catch (_) {
    return null;
  }
}

/** Тело блока: JSON {name, arguments} или запись name{…} в формате модели. Возвращает { name, args } или null. */
export function parseCallBody(body) {
  let obj = null;
  try {
    obj = JSON.parse(body);
  } catch (_) {
    obj = null;
  }
  if (obj && typeof obj.name === "string" && obj.name) {
    return { name: obj.name, args: obj.arguments === undefined ? {} : obj.arguments };
  }
  const m = /^\s*([A-Za-z_][\w-]*)\s*(\{[\s\S]*\})\s*$/.exec(body);
  if (m) {
    const json = gemmaObjectToJson(m[2]);
    if (json) return { name: m[1], args: JSON.parse(json) };
  }
  return null;
}

/** Блоки <tool_call>…</tool_call> в тексте. Незакрытый блок пропускается: он может быть ещё не дописан. */
export function parseTextToolCalls(src) {
  const calls = [];
  let pos = 0;
  while (true) {
    const start = src.indexOf(TOOL_BLOCK_OPEN, pos);
    if (start < 0) break;
    const end = src.indexOf(TOOL_BLOCK_CLOSE, start);
    if (end < 0) break;
    const body = src.slice(start + TOOL_BLOCK_OPEN.length, end).trim();
    pos = end + TOOL_BLOCK_CLOSE.length;
    const parsed = parseCallBody(body);
    const valid = parsed && typeof parsed.args === "object" && parsed.args !== null && !Array.isArray(parsed.args);
    calls.push({
      name: valid ? parsed.name : "invalid_call",
      args: valid ? JSON.stringify(parsed.args) : body,
    });
  }
  return calls;
}

/** Текст для показа: без блоков инструментов, включая незакрытый блок и частично пришедший маркер. */
export function stripToolBlocks(src) {
  let out = src;
  let start = out.indexOf(TOOL_BLOCK_OPEN);
  while (start >= 0) {
    const end = out.indexOf(TOOL_BLOCK_CLOSE, start);
    out = end < 0 ? out.slice(0, start) : out.slice(0, start) + out.slice(end + TOOL_BLOCK_CLOSE.length);
    start = out.indexOf(TOOL_BLOCK_OPEN);
  }
  for (let k = TOOL_BLOCK_OPEN.length - 1; k >= 1; k--) {
    if (out.endsWith(TOOL_BLOCK_OPEN.slice(0, k))) {
      out = out.slice(0, -k);
      break;
    }
  }
  return out;
}

/** Инструкция модели о формате вызова. descriptions — словарь «имя → описание». */
export function toolProtocolPrompt(names, descriptions = {}) {
  const list = names.map((n) => `- ${n}: ${descriptions[n] || n}`).join("\n");
  return [
    "Ты можешь вызывать инструменты. Чтобы вызвать инструмент, сначала напиши короткое пояснение,",
    "затем отдельной строкой блок такого вида:",
    `${TOOL_BLOCK_OPEN}{"name": "имя_инструмента", "arguments": {...}}${TOOL_BLOCK_CLOSE}`,
    "Один блок — один вызов. Внутри блока — только валидный JSON: строки в двойных кавычках, без комментариев.",
    "Результат придёт в следующем сообщении. Не придумывай результат сам и не пиши его внутри блока.",
    "Все пути — относительно рабочей папки этого чата; файлы сохраняй там. Чтобы пользователь получил файл, вызови send_file.",
    "Доступные инструменты:",
    list,
  ].join("\n");
}
