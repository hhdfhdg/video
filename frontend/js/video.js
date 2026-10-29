// Режим «Видео»: модель пишет HTML-сцену, сервер рендерит её в MP4 (Playwright + ffmpeg).
// Чистые функции без DOM, поэтому их можно проверять в Node.js.

export const VIDEO_PROMPT = [
  "Режим «Видео». Пользователь описывает видео, а ты делаешь его как HTML-анимацию и вызываешь инструмент render_video.",
  "Контракт сцены, соблюдай строго:",
  "1. Один HTML-документ со скриптом. Размер холста — по window.innerWidth и window.innerHeight.",
  "2. Глобальная константа DURATION — длительность в секундах, например const DURATION = 4;",
  "3. Глобальная функция renderFrame(t) рисует один кадр в момент t (секунды от 0 до DURATION). Она должна быть детерминированной: никаких реальных часов, requestAnimationFrame, setTimeout и Math.random без зерна. Всё движение — только через t.",
  "4. Внешние библиотеки не используй. Фон, текст и фигуры рисуй в canvas или SVG.",
  "5. Передай весь HTML в аргументе html инструмента render_video. Не пиши HTML в тексте ответа: пользователь увидит только результат.",
  "6. После рендера коротко опиши, что получилось (2–3 предложения) и предложи правки, если нужны. Для правок вызови render_video снова с обновлённой сценой целиком.",
].join("\n");

/**
 * Версия сцены для предпросмотра в чате: кадры крутятся по времени, чтобы анимация была видна.
 * Предпросмотр не влияет на рендер, который делает сервер.
 */
export function previewHtml(html) {
  const loop = [
    "<script>",
    "(function(){",
    "  if (typeof renderFrame !== 'function') return;",
    "  var dur = (typeof DURATION === 'number' && DURATION > 0) ? DURATION : 4;",
    "  var t0 = performance.now();",
    "  (function loop(now){ renderFrame(((now - t0) / 1000) % dur); requestAnimationFrame(loop); })(t0);",
    "})();",
    "</script>",
  ].join("\n");
  return `${html}\n${loop}`;
}

/** Имя видео по умолчанию из аргументов инструмента (для подписи). */
export function videoName(name) {
  return String(name || "video").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60) || "video";
}
