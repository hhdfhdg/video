// Режим веб-разработки: поиск HTML в ответе модели (в том числе недописанного), безопасная
// подготовка документа для предпросмотра и склейка продолжений, если ответ оборвался по длине.
// Чистые функции без DOM и без глобального состояния, поэтому их можно проверять в Node.js.

export const WEBDEV_PROMPT = [
  "Режим «Веб-разработка». Ты сильный фронтенд-разработчик и дизайнер. Результат твоей работы — одна полностью рабочая HTML-страница. Пользователь видит её в окне предпросмотра прямо в момент, когда ты пишешь код.",
  "Правила:",
  "1. Весь результат — ОДИН самодостаточный HTML-файл в одном блоке кода ```html … ```. CSS в <style> внутри <head>, JavaScript в <script> в конце <body>. Никаких отдельных файлов и ссылок на локальные ресурсы.",
  "2. Порядок написания важен для живого предпросмотра: сначала <!DOCTYPE html>, <head> с <meta viewport>, <title> и ВСЕМИ стилями; затем разметка <body> сверху вниз, от шапки к подвалу; последним скрипт. Так страница проявляется на глазах у пользователя.",
  "3. Пиши код полностью. Никаких «…», «остальной код без изменений», заглушек и TODO. Страница должна работать сразу. Объём не ограничен: если нужна большая страница или игра, пиши всё.",
  "4. Внешние библиотеки только по https с CDN (cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com, fonts.googleapis.com) и только если они действительно нужны. Запросы fetch из страницы закрыты, данные держи внутри страницы. Картинки делай встроенным SVG, CSS-градиентами или data: URI, не выдумывай ссылки.",
  "5. Делай аккуратный современный дизайн: адаптивная вёрстка (телефон и компьютер), цвета в переменных :root, продуманная типографика и отступы, состояния :hover и :focus, достаточный контраст, семантические теги. localStorage и cookies не используй: в песочнице предпросмотра они недоступны.",
  "6. Перед блоком кода напиши не больше одного-двух предложений о том, что строишь. После блока: короткий список (2–4 пункта) о том, что сделано и как этим пользоваться. Не повторяй код после блока.",
  "7. Если пользователь просит изменить страницу, верни ПОЛНЫЙ обновлённый файл целиком в одном блоке ```html. Опирайся на последнюю версию файла в диалоге: в более ранних ответах код может быть заменён пометкой. Не присылай патчи и diff.",
  "8. Перед отправкой проверь себя: все теги закрыты, скрипт не обращается к несуществующим элементам, синтаксических ошибок нет.",
].join("\n");

export const WINDOW_PROMPT = [
  "Ты можешь показать небольшое окно прямо в ответе: HTML-страницу, которую пользователь видит маленьким блоком в тексте.",
  "Открывай окно ТОЛЬКО тогда, когда нужно что-то продемонстрировать: рисунок, простой график, схему, интерактивный пример. Для обычного ответа окно не нужно.",
  "Формат окна выбираешь сам по содержимому: широкий график или схема — 16:9, вертикальный мобильный экран или узкий список — 9:16, квадрат — 1:1, классический кадр — 4:3. Формат пиши в строке открытия блока: ```html 9:16 (по умолчанию 16:9).",
  "Блок ```html с полным HTML-документом (или фрагментом). CSS — в <style>, JavaScript — в <script>. Внешние библиотеки только по https с CDN. Окно работает без сети и без localStorage.",
  "Для обычного кода используй блок с языком программирования (python, js и т.д.), а не html. Чтобы изменить окно, пришли полный обновлённый блок html.",
].join("\n");

export const CONTINUE_PROMPT =
  "Твой предыдущий ответ оборвался из-за лимита длины. Продолжи ровно с того места, где он остановился: без повторов уже написанного, без вступлений и без повторного открытия блока кода. Допиши оставшуюся часть файла и закрой блок кода.";

export const ELIDED_MARK = "[Прежняя версия HTML опущена для экономии контекста. Актуальная версия — в последнем ответе с кодом.]";

/** Политика безопасности предпросмотра: сети нет, скрипты и стили только встроенные или с https. */
export const PREVIEW_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https:; style-src 'unsafe-inline' https:; " +
  "img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; form-action 'none'";

/* ---------- поиск HTML в тексте ---------- */

/** Текст без блоков <think>…</think>. Незакрытый блок отрезается до конца. */
export function stripThink(text) {
  return String(text ?? "")
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<think>[\s\S]*$/, "");
}

const HTML_LANGS = new Set(["html", "htm", "xhtml"]);

/**
 * Формат окна: из строки ```html 9:16 или из первой строки <!-- aspect: 9:16 -->. По умолчанию 16:9.
 * Соотношение ограничено от 1:3 до 3:1, чтобы окно не стало полоской или башней.
 */
export function parseAspect(info, html) {
  const fromInfo = /(\d{1,3})\s*[:x×]\s*(\d{1,3})/.exec(String(info ?? ""));
  const fromComment = /<!--\s*(?:aspect|ratio|формат)\s*:\s*(\d{1,3})\s*[:x×]\s*(\d{1,3})\s*-->/i.exec(String(html ?? "").slice(0, 300));
  const m = fromInfo || fromComment;
  let w = m ? Number(m[1]) : 16;
  let h = m ? Number(m[2]) : 9;
  if (!w || !h) return { w: 16, h: 9 };
  const r = w / h;
  if (r > 3) w = h * 3;
  if (r < 1 / 3) h = w * 3;
  return { w, h };
}
const LOOKS_LIKE_HTML = /^\s*(<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<!--)/i;

/**
 * Все HTML-документы в тексте. Недописанный блок (нет закрывающих кавычек ```) тоже находится,
 * у него complete = false. Если кодовых блоков нет, но в тексте есть сам документ, берётся он.
 * Возвращает [{ start, end, html, complete }], индексы относятся к переданной строке.
 */
export function findHtmlBlocks(text) {
  const src = String(text ?? "");
  const blocks = [];
  const open = /^[ \t]*```[ \t]*([\w+-]*)([^\n]*)\n/gm;
  const closeRe = /^[ \t]*```[ \t]*$/m;
  let m;
  while ((m = open.exec(src))) {
    const lang = m[1].toLowerCase();
    const bodyStart = m.index + m[0].length;
    const rest = src.slice(bodyStart);
    const close = closeRe.exec(rest);
    const end = close ? bodyStart + close.index + close[0].length : src.length;
    const isHtml = HTML_LANGS.has(lang) || (lang === "" && LOOKS_LIKE_HTML.test(rest));
    if (isHtml) {
      const body = close ? rest.slice(0, close.index) : rest;
      const html = body.replace(/\n$/, "");
      blocks.push({ start: m.index, end, html, complete: !!close, aspect: parseAspect(m[2], html) });
    }
    open.lastIndex = end;
  }
  if (blocks.length) return blocks;

  const bare = /<!doctype\s+html|<html[\s>]/i.exec(src);
  if (bare) {
    const tail = src.slice(bare.index);
    const closeIdx = tail.search(/<\/html\s*>/i);
    const len = closeIdx >= 0 ? closeIdx + tail.slice(closeIdx).match(/<\/html\s*>/i)[0].length : tail.length;
    const html = tail.slice(0, len);
    return [{ start: bare.index, end: bare.index + len, html, complete: closeIdx >= 0, aspect: parseAspect("", html) }];
  }
  return [];
}

/** Последний HTML-документ в ответе или null. Думающую часть (<think>) модели не учитываем. */
export function extractHtml(text) {
  const blocks = findHtmlBlocks(stripThink(text));
  return blocks.length ? blocks[blocks.length - 1] : null;
}

/**
 * Режет текст на куски: обычный текст и HTML-документы. Нужно, чтобы показывать вместо кода карточку.
 * Возвращает [{ type: "text", text } | { type: "html", block, index }].
 */
export function splitByHtml(text) {
  const src = String(text ?? "");
  const blocks = findHtmlBlocks(src);
  const parts = [];
  let pos = 0;
  blocks.forEach((block, index) => {
    if (block.start > pos) parts.push({ type: "text", text: src.slice(pos, block.start) });
    parts.push({ type: "html", block, index });
    pos = block.end;
  });
  if (pos < src.length) parts.push({ type: "text", text: src.slice(pos) });
  return parts;
}

/** Заменяет все HTML-документы пометкой. Нужно, чтобы не раздувать контекст старыми версиями. */
export function elideHtml(text, mark = ELIDED_MARK) {
  return splitByHtml(text)
    .map((p) => (p.type === "html" ? `${mark}\n` : p.text))
    .join("")
    .trim();
}

/** Строки и размер документа для карточки. */
export function htmlStats(html) {
  const s = String(html ?? "");
  return { lines: s ? s.split("\n").length : 0, bytes: new TextEncoder().encode(s).length };
}

/** Имя файла по <title> страницы. */
export function suggestFileName(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html ?? ""));
  const slug = (m ? m[1] : "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${slug || "index"}.html`;
}

/* ---------- документ для предпросмотра ---------- */

/** Вставляет политику безопасности так, чтобы не сломать doctype: иначе страница уйдёт в режим совместимости. */
export function injectCsp(html, csp = PREVIEW_CSP) {
  // color-scheme: light — иначе в тёмной системной теме текст в окне становится светлым на светлом фоне.
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="color-scheme" content="light"><style>:root{color-scheme:light}</style>`;
  const src = String(html ?? "");
  const head = /<head(\s[^>]*)?>/i.exec(src);
  if (head) return src.slice(0, head.index + head[0].length) + meta + src.slice(head.index + head[0].length);
  const htmlTag = /<html(\s[^>]*)?>/i.exec(src);
  if (htmlTag) return src.slice(0, htmlTag.index + htmlTag[0].length) + `<head>${meta}</head>` + src.slice(htmlTag.index + htmlTag[0].length);
  const doctype = /<!doctype[^>]*>/i.exec(src);
  if (doctype) return src.slice(0, doctype.index + doctype[0].length) + meta + src.slice(doctype.index + doctype[0].length);
  return meta + src;
}

/* ---------- продолжение оборванного ответа ---------- */

/** Если новое продолжение повторяет конец уже написанного, лишнее отрезается. */
export function trimOverlap(prev, next, { max = 600, min = 16 } = {}) {
  const tail = String(prev ?? "").slice(-max);
  const add = String(next ?? "");
  const limit = Math.min(tail.length, add.length);
  for (let k = limit; k >= min; k--) {
    if (tail.endsWith(add.slice(0, k))) return add.slice(k);
  }
  return add;
}

/** Модель может заново открыть блок ```html при продолжении. Если прежний блок не закрыт, такую строку убираем. */
export function stripReopenedFence(prev, next) {
  const last = findHtmlBlocks(stripThink(prev)).pop();
  if (last && !last.complete) return String(next ?? "").replace(/^\s*```[ \t]*(?:html|htm)?[ \t]*\n/i, "");
  return String(next ?? "");
}

/** Готовое продолжение: без повторно открытой ограды и без пересечения с уже написанным. */
export function cleanContinuation(prev, next) {
  return trimOverlap(prev, stripReopenedFence(prev, next));
}
