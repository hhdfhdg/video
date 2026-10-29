// Память о пользователе: устойчивые факты (имя, профессия, интересы), общие для всех чатов.
// Чистые функции без DOM, поэтому их можно проверять в Node.js.

export const MAX_FACTS = 200;
export const MAX_FACT_LEN = 300;

/** Факт в одну короткую строку: без маркеров списка, пробелов и лишней длины. */
export function cleanFact(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-•*\d.)\s]+/, "")
    .trim()
    .slice(0, MAX_FACT_LEN);
}

/** Ключ для сравнения: без регистра, знаков и лишних пробелов. */
export function factKey(text) {
  return cleanFact(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Добавляет новые факты, пропуская повторы. Возвращает новый список (не больше MAX_FACTS, самые свежие). */
export function mergeFacts(existing, texts, now = Date.now()) {
  const seen = new Set(existing.map((f) => factKey(f.text)));
  const out = [...existing];
  for (const raw of texts) {
    const text = cleanFact(raw);
    const key = factKey(text);
    if (!text || !key || seen.has(key)) continue;
    seen.add(key);
    out.push({ id: `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`, text, createdAt: now });
  }
  return out.slice(-MAX_FACTS);
}

/** Строки ответа модели в виде списка («- факт») → массив текстов фактов. */
export function parseFactLines(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^([-•*]|\d+[.)])\s+/.test(line))
    .map(cleanFact)
    .filter((line) => line && line !== "-");
}

/** Системный промпт: что известно о собеседнике. Пустая строка, если фактов нет. */
export function memoryPrompt(facts) {
  if (!facts.length) return "";
  const list = facts.map((f) => `- ${f.text}`).join("\n");
  return [
    "Ты знаешь о собеседнике из его прошлых разговоров:",
    list,
    "Учитывай это, когда уместно: подбирай примеры и уровень объяснения. Не перечисляй всё подряд и не говори «я помню, что…» без повода.",
    "Если пользователь сообщает новый устойчивый факт о себе (имя, профессия, навыки, интересы, предпочтения, проекты), вызови инструмент remember с коротким фактом. Не вызывай его для временных состояний и для фактов, которые уже есть в списке.",
    "Никогда не запоминай пароли, ключи, номера документов, адреса и данные других людей.",
  ].join("\n");
}

/** Промпт для извлечения фактов из сообщений пользователя во всех чатах. */
export const EXTRACT_PROMPT = [
  "Ты извлекаешь устойчивые факты о пользователе из его сообщений в прошлых чатах: имя, профессия, роль, навыки, интересы, предпочтения, цели, проекты, язык общения.",
  "Пиши только то, что пользователь сказал о себе явно или очень очевидно. Не добавляй догадок, секретов (пароли, ключи, номера, адреса), данных о других людях и временных состояний.",
  "Ответ — список, по одному факту в строке, начинающейся с «- ». Каждый факт — короткой фразой на языке пользователя, не больше 15 слов.",
  "Если фактов нет, ответь одной строкой «-».",
].join("\n");

/**
 * Сообщения пользователя из всех чатов, начиная с самых свежих, в пределах budget символов.
 * chats: [{ title, updatedAt, messages }]. Возвращает текст или "".
 */
export function buildExtractionInput(chats, budget) {
  const sorted = [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
  const parts = [];
  let total = 0;
  for (const chat of sorted) {
    const lines = chat.messages
      .filter((m) => m.role === "user" && typeof m.content === "string" && m.content.trim())
      .map((m) => `- ${m.content.trim().replace(/\s+/g, " ").slice(0, 1000)}`);
    if (!lines.length) continue;
    const block = `## ${chat.title || "Чат"}\n${lines.join("\n")}`;
    if (total + block.length > budget) {
      const room = budget - total;
      if (room > 200) parts.push(block.slice(0, room));
      break;
    }
    parts.push(block);
    total += block.length;
  }
  return parts.join("\n\n");
}
