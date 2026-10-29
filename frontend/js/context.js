// Ограничение истории по размеру контекста. Чистые функции для тестов.

/** Примерный размер сообщения в символах: текст, вложения с текстом, результаты и аргументы инструментов. */
export function messageSize(m) {
  let size = (m.content || "").length;
  for (const a of m.attachments || []) size += (a.text || "").length;
  for (const c of m.toolCalls || []) size += (c.args || "").length + (c.result || "").length;
  return size;
}

/**
 * Оставляет с конца истории столько сообщений, сколько помещается в budget символов.
 * Всегда сохраняет последнее сообщение. Начало диалога обрезается до сообщения пользователя,
 * чтобы не начинать с ответа модели или результата инструмента.
 * Возвращает { kept, dropped }.
 */
export function historyWithinBudget(history, budget) {
  let total = 0;
  let start = history.length;
  for (let i = history.length - 1; i >= 0; i--) {
    const size = messageSize(history[i]);
    if (start < history.length && total + size > budget) break;
    total += size;
    start = i;
  }
  // Если в оставшемся хвосте есть сообщение пользователя, начинаем с него.
  const firstUser = history.findIndex((m, i) => i >= start && m.role === "user");
  if (firstUser >= 0) start = firstUser;
  return { kept: history.slice(start), dropped: start };
}
