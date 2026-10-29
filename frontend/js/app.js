// Cogniflux — интерфейс чата. Ванильный JavaScript (ES-модули), без сборки.
import { Store } from "./storage.js";
import { fetchModels, streamChat, runTool, extractFile, deleteChatFiles, ApiError } from "./api.js";
import { parseTextToolCalls, normalizeBareToolCalls, stripToolBlocks, toolProtocolPrompt } from "./toolparse.js";
import { historyWithinBudget } from "./context.js";
import { VIDEO_PROMPT, previewHtml } from "./video.js";
import { memoryPrompt, mergeFacts, parseFactLines, buildExtractionInput, cleanFact, EXTRACT_PROMPT } from "./memory.js";
import { BUILTIN_SKILLS, allSkills, enabledSkills, normalizeSkill, skillCatalogPrompt, activeSkillPrompt, loadSkillResult, findSlashSkill, createSkillModePrompt, skillToMd } from "./skills.js";
import { WEBDEV_PROMPT, WINDOW_PROMPT, CONTINUE_PROMPT, elideHtml, findHtmlBlocks, splitByHtml, injectCsp, suggestFileName, htmlStats, cleanContinuation, stripThink } from "./webdev.js";

/* =========================================================
   Константы и утилиты
   ========================================================= */
const DAY = 86400000;
const MAX_TEXT_FILE_BYTES = 512 * 1024;
const MAX_DOC_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_CHARS = 200000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TABS_RECENT = 20;
const MAX_TOOL_ROUNDS = 6;
const TEXT_EXT = ["txt", "md", "csv", "json", "log", "py", "js", "html", "css", "xml", "yaml", "yml"];
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const NONE = "__none";
const CHAT_ID_OK = /^[A-Za-z0-9_-]{1,100}$/;
// Защита от подмены содержимого iframe: запрет сети, разрешены только скрипты и стили из https и встроенные.
const PANEL_CSP = `<meta name="color-scheme" content="light"><style>:root{color-scheme:light}</style><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob:">`;
// Инструменты, которые выполняются без подтверждения (только чтение внутри workspace).
const AUTO_TOOLS = ["read_file", "list_files", "send_file"];
const ALL_TOOLS = ["read_file", "list_files", "write_file", "send_file", "show_html", "run_code"];
// Инструменты скилов выполняются в браузере: их данные (скилы) хранятся в IndexedDB.
const CLIENT_TOOLS = new Set(["load_skill", "create_skill", "remember"]);
const MODE_KEYS = { thinking: "thinking", code: "codeExec", functions: "functions", windows: "windows", skills: "skills", memory: "memory", createSkill: "createSkill", webdev: "webdev", video: "video" };
const MAX_AUTO_CONTINUE = 8; // сколько раз подряд продолжать ответ веб-страницы, если он оборвался по длине
const TOOL_KEYS = { read_file: "toolRead", list_files: "toolList", write_file: "toolWrite", send_file: "toolSend", show_html: "toolPanel", run_code: "toolRun", load_skill: "toolLoadSkill", create_skill: "toolCreateSkill", remember: "toolRemember", render_video: "toolRenderVideo" };
const TOOL_DESCRIPTIONS = {
  read_file: "прочитать текстовый файл в рабочей папке чата; аргумент path",
  list_files: "список файлов в рабочей папке чата; аргумент path (необязательно)",
  write_file: "записать текстовый файл в рабочую папку чата; аргументы path, content",
  send_file: "отправить пользователю файл из рабочей папки чата для скачивания; аргумент path",
  show_html: "показать в ответе HTML-панель (HTML/CSS/JS: дерево, схема, график, рисунок); аргументы title, html, height",
  run_code: "выполнить код; аргументы language (python, javascript или bash) и code",
  load_skill: "загрузить инструкции скила по имени; аргумент name",
  create_skill: "сохранить новый скил; аргументы name, description, instructions",
  remember: "запомнить устойчивый факт о пользователе; аргумент fact",
  render_video: "отрендерить HTML-сцену в видео; аргументы html, name, duration, fps, width, height",
};

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const isMobile = () => window.matchMedia("(max-width: 900px)").matches;
const byUpdated = (a, b) => b.updatedAt - a.updatedAt;
const requiresApproval = () => false; // подтверждения отключены: инструменты выполняются сразу

const ICON_PATHS = {
  plus: "M12 5v14M5 12h14",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  sidebar: "M4 4h16v16H4zM9 4v16",
  panel: "M4 4h16v16H4zM15 4v16",
  dots: "M5 12h.01M12 12h.01M19 12h.01",
  copy: "M9 9h11v11H9zM4 15V4h11",
  edit: "M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4",
  refresh: "M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5",
  send: "M12 19V5M6 11l6-6 6 6",
  close: "M6 6l12 12M18 6L6 18",
  pin: "M9 3h6l-1 6 3 3H7l3-3-1-6zM12 12v9",
  folder: "M3 6h6l2 2h10v10H3z",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  attach: "M21 11.5l-8.5 8.5a5 5 0 0 1-7-7L14 4.5a3.5 3.5 0 0 1 5 5L10.5 18a2 2 0 0 1-3-3L16 6.5",
  mic: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3",
  chevron: "M9 6l6 6-6 6",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  check: "M5 12l4 4 9-9",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  download: "M12 4v12M6 10l6 6 6-6M4 20h16",
  upload: "M12 20V8M6 14l6-6 6 6M4 4h16",
  arrowRight: "M5 12h11M12 6l6 6-6 6",
  warn: "M12 3l10 18H2zM12 10v5M12 18h.01",
  file: "M6 3h8l4 4v14H6zM14 3v4h4",
  history: "M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 7v5l3 2",
  tool: "M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z",
};
const icon = (name, { cls = "" } = {}) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" class="${cls}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICON_PATHS[name]}"/></svg>`;

const LOGO = `<svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true"><defs><linearGradient id="lgg" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#4f7cff"/><stop offset="1" stop-color="#7c5cff"/></linearGradient></defs><rect width="32" height="32" rx="9" fill="url(#lgg)"/><path d="M21 11.5a7 7 0 1 0 0 9" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"/></svg>`;

/* =========================================================
   Тексты интерфейса
   ========================================================= */
const DICT = {
  ru: {
    appName: "Cogniflux", newChat: "Новый чат", search: "Поиск по чатам", searchResults: "Результаты поиска",
    noResults: "Ничего не найдено", noChats: "Чатов пока нет. Начните новый диалог.",
    pinned: "Закреплённые", folders: "Папки", newFolder: "Новая папка", folderName: "Название папки",
    emptyFolder: "Папка пуста", today: "Сегодня", yesterday: "Вчера", week: "Последние 7 дней", earlier: "Более ранние",
    archive: "Архив", rename: "Переименовать", renamePrompt: "Новое название", pin: "Закрепить", unpin: "Открепить",
    duplicate: "Дублировать", archiveAct: "В архив", unarchive: "Вернуть из архива", moveTo: "Переместить в папку",
    noFolder: "Без папки", delete: "Удалить", deleteFolder: "Удалить папку", renameFolder: "Переименовать папку",
    confirmDeleteChat: "Удалить чат «{0}»? Историю и файлы из его рабочей папки нельзя будет восстановить.",
    confirmDeleteFolder: "Удалить папку «{0}»? Чаты из неё не удалятся — они переместятся в список без папки.",
    copy: "Копировать", copied: "Скопировано", copyFailed: "Не удалось скопировать", edit: "Редактировать",
    cancel: "Отмена", saveAndSend: "Сохранить и отправить", send: "Отправить", stop: "Остановить",
    retry: "Повторить", regenerate: "Перегенерировать", continue: "Продолжить", continuePrompt: "Продолжи ответ с того места, где остановился.",
    emptyReply: "Модель вернула пустой ответ.", stopped: "Генерация остановлена.", errorTitle: "Ошибка запроса",
    greeting: "Чем могу помочь?", tagline: "Локальный ИИ-чат на базе LM Studio. Ваши данные остаются на этом компьютере.",
    placeholder: "Напишите сообщение…", hint: "Enter — отправить · Shift+Enter — новая строка",
    noModelHint: "Модель не выбрана. Откройте настройки → Подключение.", modelInfo: "Модель: {0}",
    connUnknown: "Не проверено", connChecking: "Проверка…", connOk: "Подключено · моделей: {0}", connError: "Нет подключения",
    connNoUrl: "Укажите адрес сервера.", connNoModels: "Сервер доступен, но моделей нет. Загрузите модель в LM Studio.",
    noModel: "Сначала выберите модель в настройках подключения.", noModelsLoaded: "Список моделей не загружен.",
    settings: "Настройки", inspector: "Панель информации", modelSection: "Модель", connStatus: "Статус",
    contextUnknown: "Размер контекста через OpenAI-совместимый API не передаётся.", genParams: "Параметры генерации",
    chatInfo: "О чате", title: "Название", messages: "Сообщений", created2: "Создан", exportMd: "Экспорт в Markdown",
    clearChat: "Очистить историю", confirmClear: "Очистить всю историю этого чата? Это действие нельзя отменить.",
    noActiveChat: "Откройте чат, чтобы увидеть его параметры.", closeTab: "Закрыть вкладку",
    recentlyClosed: "Недавно закрытые", noClosed: "Закрытых вкладок нет", you: "Вы",
    plus: "Ещё", attachFile: "Прикрепить файл", attachImage: "Прикрепить изображение",
    addContext: "Добавить контекст", chooseTool: "Выбор инструментов", voice: "Голосовой ввод", unavailable: "недоступно",
    thinking: "Размышление", codeExec: "Выполнение кода", functions: "Функции",
    featHintThinking: "Модель рассуждает пошагово: в промпт добавляется просьба думать в тегах <think>. Качество зависит от модели.",
    featHintCode: "Модель может запускать Python, JavaScript и bash. Выполняется в рабочей папке чата.",
    featHintFunctions: "Модель может читать и выводить файлы из рабочей папки этого чата, записывать их и отправлять вам для скачивания. Может показывать HTML-панели.",
    thinkPrompt: "Перед ответом рассуждай пошагово: разбери задачу, проверь варианты и возможные ошибки. Рассуждение пиши внутри тегов <think> и </think>, а итоговый ответ — после закрывающего тега.",
    reasoning: "Ход рассуждений",
    toolRead: "Чтение файла", toolList: "Список файлов", toolWrite: "Запись файла", toolSend: "Отправка файла", toolRun: "Запуск кода",
    chatFolder: "Рабочая папка", downloadFile: "Скачать",
    thinkingNow: "Думает…", noStreamNotice: "Сервер не передаёт ответ потоком: текст появится целиком.", contextTrimmed: "ранних сообщений не передано: {0}", contextLimit: "Контекст", contextLimitSetting: "Лимит контекста, символов", reasoningNow: "Размышляет…", runningTool: "Выполняю: {0}…", toolPanel: "HTML-панель",
    toolPending: "Ждёт подтверждения", toolRunning: "Выполняется…", toolDone: "Готово", toolError: "Ошибка", toolDenied: "Отклонено",
    toolResult: "Результат", approve: "Выполнить", deny: "Отклонить",
    toolLimit: "Достигнут лимит последовательных вызовов инструментов (6). Продолжите диалог сообщением.",
    toolsUnsupported: "Возможно, модель или сервер не поддерживают вызов инструментов. Отключите «Функции» и «Выполнение кода» и попробуйте снова.",
    contextPrompt: "Системный контекст для этого чата: инструкции, факты о задаче. Оставьте пустым, чтобы убрать.",
    contextSaved: "Контекст сохранён", tabTools: "Инструменты",
    toolsNote: "Чтение файлов выполняется сразу. Все инструменты выполняются сразу, без подтверждения. Файлы доступны только в папке workspace.",
    toolsWorkspace: "Рабочая папка",
    tabGeneral: "Общие", tabAppearance: "Внешний вид", tabConnection: "Подключение", tabGeneration: "Генерация",
    tabData: "Данные и приватность", tabHotkeys: "Горячие клавиши",
    language: "Язык интерфейса", sidebarSide: "Положение боковой панели", left: "Слева", right: "Справа",
    enterSends: "Enter отправляет сообщение (Ctrl+Enter — если выключено)",
    theme: "Тема", themeLight: "Светлая", themeDark: "Тёмная", themeSystem: "Системная",
    fontSize: "Размер шрифта", msgWidth: "Ширина области сообщений", autoScroll: "Автопрокрутка во время ответа",
    baseUrl: "Base URL", baseUrlHint: "Обычно http://localhost:1234/v1. Запросы идут через сервер Cogniflux, поэтому CORS настраивать не нужно.",
    apiKey: "API key", apiKeyHint: "Нужен, только если в LM Studio включена авторизация. Хранится в браузере и не записывается на диск сервера.",
    show: "Показать", hide: "Скрыть", checkConnection: "Проверить подключение",
    selectModel: "Модель",
    temperature: "Temperature", topP: "Top P", maxTokens: "Макс. токенов ответа", freqPenalty: "Frequency penalty",
    presPenalty: "Presence penalty", seed: "Seed (пусто — не передавать)",
    genNote: "Параметры применяются ко всем чатам. Размышление, функции и выполнение кода включаются кнопками под полем ввода.",
    dataStats: "Чатов сохранено", exportAll: "Экспорт всей истории (JSON)", importAll: "Импорт истории (JSON)",
    deleteAll: "Удалить все локальные данные", confirmDeleteAll: "Удалить все чаты, папки и настройки в этом браузере? Действие необратимо.",
    importOk: "История импортирована: чатов — {0}", importBad: "Файл не похож на экспорт Cogniflux или повреждён.",
    newChatHk: "Новый чат", searchHk: "Поиск по чатам", closeTabHk: "Закрыть вкладку", sendHk: "Отправить сообщение",
    newlineHk: "Новая строка", escHk: "Закрыть окно или меню",
    fileTooBig: "Файл «{0}» слишком большой.", fileUnsupported: "Формат «{0}» не поддерживается. Поддерживаются текстовые файлы, PDF, DOCX и изображения.",
    textTooLong: "Текст файла «{0}» слишком длинный и будет обрезан.", fileRead: "Не удалось прочитать файл «{0}».",
    voiceUnsupported: "Голосовой ввод недоступен в этом браузере.", listening: "Слушаю…", voiceError: "Ошибка голосового ввода.",
    editBranch: "Ответы после этого сообщения будут удалены, чтобы не смешивать ветки диалога. Продолжить?",
    emptyMessage: "Сообщение не может быть пустым.", networkLost: "Соединение потеряно.",
    dropHint: "Отпустите файлы, чтобы прикрепить", reopened: "Вкладка открыта снова", duplicated: "Копия чата создана",
    copyWord: "копия", hideSidebar: "Свернуть панель",
    importing: "Импорт…", activeModel: "Текущая модель", conn: "Подключение", tools: "Инструменты",
    skills: "Скилы", createSkill: "Создать скил", webdev: "Веб-разработка",
    featHintSkills: "Модель подгружает скилы — наборы инструкций под задачу. Скил можно вызвать командой /имя в начале сообщения.",
    featHintCreateSkill: "Режим создания скила: модель уточнит задачу и сохранит инструкцию, которую потом можно использовать в любом чате.",
    featHintWebdev: "Режим веб-разработки: модель пишет одну HTML-страницу без ограничения длины и показывает её в предпросмотре по мере написания. Инструменты в этом режиме отключены.",
    toolLoadSkill: "Загрузка скила", toolCreateSkill: "Создание скила",
    tabSkills: "Скилы", skillsNote: "Встроенные скилы можно выключить. Пользовательские появляются в режиме «Создать скил» и хранятся в этом браузере.",
    skillBuiltin: "встроенный", skillDelete: "Удалить", confirmDeleteSkill: "Удалить скил «{0}»?", noSkills: "Скилов пока нет.",
    webdevTitle: "Страница", webdevWriting: "Пишет страницу…", webdevDone: "Готово", webdevCut: "Оборвано", webdevLines: "строк",
    webdevCode: "Код", webdevDownload: "Скачать .html", webdevContinuing: "Продолжаю: ответ достиг лимита длины…",
    webdevAutoStop: "Достигнут предел автопродолжений. Напишите «продолжи», чтобы дописать страницу.",
    windows: "Окна", featHintWindows: "Модель открывает окна прямо в ответе: HTML-блок выводится живым окном с графикой, схемой или интерактивом и обновляется по мере написания.",
    windowTitle: "Окно", windowExpand: "Развернуть",
    modes: "Режимы", modesHint: "Режимы ответа, инструменты и скилы", modeLabel: "Режим", skillForChat: "Скил для этого чата", noSkill: "Без скила", skillSelected: "Скил выбран для чата",
    memory: "Память", tabMemory: "Память", memoryNote: "Факты о вас из всех чатов. Модель учитывает их во всех новых диалогах. Всё хранится в этом браузере.", memoryEmpty: "Пока ничего не запомнено.",
    memoryScanBtn: "Собрать из прошлых чатов", memoryScanning: "Собираю…", memoryClear: "Очистить память", confirmClearMemory: "Удалить все сохранённые факты о вас?",
    memoryAdded: "Новых фактов: {0}", memoryNothing: "В чатах нет ваших сообщений для анализа.", toolRemember: "Запоминание",
    video: "Видео", featHintVideo: "Режим видео: вы описываете сцену, модель пишет её как HTML-анимацию, а сервер рендерит MP4 через Playwright и ffmpeg.", toolRenderVideo: "Рендер видео", videoScene: "Сцена",
    speak: "Озвучить", stopSpeak: "Остановить озвучивание", speakUnsupported: "Озвучивание недоступно в этом браузере.",
    statsLine: "{0} с · {1} симв.", jumpBottom: "Вниз", shortcutsHk: "Список горячих клавиш",
  },
  en: {
    appName: "Cogniflux", newChat: "New chat", search: "Search chats", searchResults: "Search results",
    noResults: "Nothing found", noChats: "No chats yet. Start a new conversation.",
    pinned: "Pinned", folders: "Folders", newFolder: "New folder", folderName: "Folder name",
    emptyFolder: "Folder is empty", today: "Today", yesterday: "Yesterday", week: "Last 7 days", earlier: "Earlier",
    archive: "Archive", rename: "Rename", renamePrompt: "New name", pin: "Pin", unpin: "Unpin",
    duplicate: "Duplicate", archiveAct: "Archive", unarchive: "Unarchive", moveTo: "Move to folder",
    noFolder: "No folder", delete: "Delete", deleteFolder: "Delete folder", renameFolder: "Rename folder",
    confirmDeleteChat: "Delete chat “{0}”? History and files in its working folder cannot be restored.",
    confirmDeleteFolder: "Delete folder “{0}”? Its chats are kept and moved out of the folder.",
    copy: "Copy", copied: "Copied", copyFailed: "Copy failed", edit: "Edit",
    cancel: "Cancel", saveAndSend: "Save and send", send: "Send", stop: "Stop",
    retry: "Retry", regenerate: "Regenerate", continue: "Continue", continuePrompt: "Continue your previous answer from where it stopped.",
    emptyReply: "The model returned an empty reply.", stopped: "Generation stopped.", errorTitle: "Request failed",
    greeting: "How can I help?", tagline: "A local AI chat on top of LM Studio. Your data stays on this computer.",
    placeholder: "Write a message…", hint: "Enter — send · Shift+Enter — new line",
    noModelHint: "No model selected. Open Settings → Connection.", modelInfo: "Model: {0}",
    connUnknown: "Not checked", connChecking: "Checking…", connOk: "Connected · models: {0}", connError: "Not connected",
    connNoUrl: "Enter the server address.", connNoModels: "Server is reachable, but no models are loaded in LM Studio.",
    noModel: "Select a model in connection settings first.", noModelsLoaded: "Model list not loaded.",
    settings: "Settings", inspector: "Info panel", modelSection: "Model", connStatus: "Status",
    contextUnknown: "Context size is not exposed by the OpenAI-compatible API.", genParams: "Generation parameters",
    chatInfo: "Chat info", title: "Title", messages: "Messages", created2: "Created", exportMd: "Export to Markdown",
    clearChat: "Clear history", confirmClear: "Clear the whole history of this chat? This cannot be undone.",
    noActiveChat: "Open a chat to see its details.", closeTab: "Close tab",
    recentlyClosed: "Recently closed", noClosed: "No recently closed tabs", you: "You",
    plus: "More", attachFile: "Attach file", attachImage: "Attach image",
    addContext: "Add context", chooseTool: "Choose tools", voice: "Voice input", unavailable: "unavailable",
    thinking: "Reasoning", codeExec: "Code execution", functions: "Functions",
    featHintThinking: "The model reasons step by step: a prompt asks it to think inside <think> tags. Quality depends on the model.",
    featHintCode: "The model can run Python, JavaScript and bash. Runs in the chat's working folder.",
    featHintFunctions: "The model can read and list files in this chat's working folder, write them and send them to you for download. Can show HTML panels.",
    thinkPrompt: "Before answering, reason step by step: break the task down, check options and possible mistakes. Write the reasoning inside <think> and </think> tags, and the final answer after the closing tag.",
    reasoning: "Reasoning",
    toolRead: "Read file", toolList: "List files", toolWrite: "Write file", toolSend: "Send file", toolRun: "Run code",
    chatFolder: "Working folder", downloadFile: "Download",
    thinkingNow: "Thinking…", noStreamNotice: "The server does not stream replies: the text will appear at once.", contextTrimmed: "earlier messages not sent: {0}", contextLimit: "Context", contextLimitSetting: "Context limit, characters", reasoningNow: "Reasoning…", runningTool: "Running: {0}…", toolPanel: "HTML panel",
    toolPending: "Waiting for approval", toolRunning: "Running…", toolDone: "Done", toolError: "Error", toolDenied: "Denied",
    toolResult: "Result", approve: "Approve", deny: "Deny",
    toolLimit: "Tool call limit reached (6). Send a message to continue.",
    toolsUnsupported: "The model or server may not support tool calling. Turn off “Functions” and “Code execution” and try again.",
    contextPrompt: "System context for this chat: instructions, task facts. Leave empty to remove.",
    contextSaved: "Context saved", tabTools: "Tools",
    toolsNote: "File reads run immediately. All tools run immediately, without approval. Files are only available in the workspace folder.",
    toolsWorkspace: "Workspace folder",
    tabGeneral: "General", tabAppearance: "Appearance", tabConnection: "Connection", tabGeneration: "Generation",
    tabData: "Data & privacy", tabHotkeys: "Shortcuts",
    language: "Interface language", sidebarSide: "Sidebar position", left: "Left", right: "Right",
    enterSends: "Enter sends the message (Ctrl+Enter when off)",
    theme: "Theme", themeLight: "Light", themeDark: "Dark", themeSystem: "System",
    fontSize: "Font size", msgWidth: "Message width", autoScroll: "Auto-scroll while generating",
    baseUrl: "Base URL", baseUrlHint: "Usually http://localhost:1234/v1. Requests go through the Cogniflux server, so CORS does not need configuring.",
    apiKey: "API key", apiKeyHint: "Only needed if LM Studio requires authorization. Stored in the browser, not on the server disk.",
    show: "Show", hide: "Hide", checkConnection: "Check connection",
    selectModel: "Model",
    temperature: "Temperature", topP: "Top P", maxTokens: "Max response tokens", freqPenalty: "Frequency penalty",
    presPenalty: "Presence penalty", seed: "Seed (empty — don't send)",
    genNote: "Parameters apply to all chats. Reasoning, functions and code execution are toggled under the input field.",
    dataStats: "Chats saved", exportAll: "Export all history (JSON)", importAll: "Import history (JSON)",
    deleteAll: "Delete all local data", confirmDeleteAll: "Delete all chats, folders and settings in this browser? This cannot be undone.",
    importOk: "History imported: chats — {0}", importBad: "The file does not look like a Cogniflux export or is damaged.",
    newChatHk: "New chat", searchHk: "Search chats", closeTabHk: "Close tab", sendHk: "Send message",
    newlineHk: "New line", escHk: "Close dialog or menu",
    fileTooBig: "File “{0}” is too large.", fileUnsupported: "Format “{0}” is not supported. Text files, PDF, DOCX and images are supported.",
    textTooLong: "Text of “{0}” is too long and will be truncated.", fileRead: "Could not read “{0}”.",
    voiceUnsupported: "Voice input is not available in this browser.", listening: "Listening…", voiceError: "Voice input error.",
    editBranch: "Replies after this message will be deleted so the branches do not mix. Continue?",
    emptyMessage: "The message cannot be empty.", networkLost: "Connection lost.",
    dropHint: "Drop files to attach", reopened: "Tab reopened", duplicated: "Chat duplicated",
    copyWord: "copy", hideSidebar: "Hide sidebar",
    importing: "Importing…", activeModel: "Current model", conn: "Connection", tools: "Tools",
    skills: "Skills", createSkill: "Create skill", webdev: "Web development",
    featHintSkills: "The model loads skills — instruction sets for the task. Call a skill with /name at the start of a message.",
    featHintCreateSkill: "Skill creation mode: the model asks a few questions and saves an instruction set you can reuse in any chat.",
    featHintWebdev: "Web development mode: the model writes one HTML page without a length limit and shows a live preview while it writes. Tools are off in this mode.",
    toolLoadSkill: "Load skill", toolCreateSkill: "Create skill",
    tabSkills: "Skills", skillsNote: "Built-in skills can be turned off. Custom ones appear in “Create skill” mode and are kept in this browser.",
    skillBuiltin: "built-in", skillDelete: "Delete", confirmDeleteSkill: "Delete skill “{0}”?", noSkills: "No skills yet.",
    webdevTitle: "Page", webdevWriting: "Writing the page…", webdevDone: "Done", webdevCut: "Cut off", webdevLines: "lines",
    webdevCode: "Code", webdevDownload: "Download .html", webdevContinuing: "Continuing: the reply hit the length limit…",
    webdevAutoStop: "Auto-continue limit reached. Write “continue” to finish the page.",
    windows: "Windows", featHintWindows: "The model opens windows right in the reply: an HTML block is shown as a live window with graphics, a diagram or interactive content, updated while it is written.",
    windowTitle: "Window", windowExpand: "Expand",
    modes: "Modes", modesHint: "Response modes, tools and skills", modeLabel: "Mode", skillForChat: "Skill for this chat", noSkill: "No skill", skillSelected: "Skill selected for the chat",
    memory: "Memory", tabMemory: "Memory", memoryNote: "Facts about you from all chats. The model uses them in every new chat. Everything is stored in this browser.", memoryEmpty: "Nothing remembered yet.",
    memoryScanBtn: "Collect from past chats", memoryScanning: "Collecting…", memoryClear: "Clear memory", confirmClearMemory: "Delete all saved facts about you?",
    memoryAdded: "New facts: {0}", memoryNothing: "No messages from you in the chats to analyze.", toolRemember: "Remember",
    video: "Video", featHintVideo: "Video mode: you describe a scene, the model writes it as an HTML animation, and the server renders an MP4 with Playwright and ffmpeg.", toolRenderVideo: "Render video", videoScene: "Scene",
    speak: "Read aloud", stopSpeak: "Stop reading", speakUnsupported: "Read-aloud is not available in this browser.",
    statsLine: "{0} s · {1} chars", jumpBottom: "Down", shortcutsHk: "Keyboard shortcuts list",
  },
};

function t(key, ...args) {
  const lang = S.settings.language === "en" ? "en" : "ru";
  let s = DICT[lang][key] ?? DICT.ru[key] ?? key;
  args.forEach((a, i) => { s = s.replaceAll(`{${i}}`, a); });
  return s;
}

const EXAMPLES = {
  ru: [
    "Объясни простыми словами, как работает квантовый компьютер",
    "Напиши функцию на Python, которая находит дубликаты в списке",
    "Составь план изучения SQL на две недели",
    "Помоги написать вежливое письмо работодателю с просьбой об отпуске",
  ],
  en: [
    "Explain how a quantum computer works in simple terms",
    "Write a Python function that finds duplicates in a list",
    "Make a two-week plan for learning SQL",
    "Help me write a polite email asking my manager for vacation",
  ],
};

/* =========================================================
   Состояние
   ========================================================= */
const DEFAULT_SETTINGS = {
  language: "ru",
  theme: "light",
  fontSize: 15,
  messageWidth: 760,
  sidebarSide: "left",
  sidebarCollapsed: false,
  inspectorOpen: false,
  autoScroll: true,
  contextChars: 48000,
  enterSends: true,
  baseUrl: "",
  apiKey: "",
  model: "",
  params: { temperature: 0.7, top_p: 1, max_tokens: 2048, frequency_penalty: 0, presence_penalty: 0, seed: null },
  features: { thinking: false, code: false, functions: false, skills: false, createSkill: false, webdev: false, windows: true, memory: true, video: false },
  tools: { read_file: true, list_files: true, write_file: true, send_file: true, show_html: true, run_code: true, load_skill: true, create_skill: true },
  skillsOff: {}, // встроенные и пользовательские скилы, которые выключены: «имя → true»
};

const S = {
  settings: structuredClone(DEFAULT_SETTINGS),
  workspace: "",
  folders: [],
  memory: [],                // факты о пользователе, общие для всех чатов: { id, text, createdAt }
  skills: [],                // пользовательские скилы: { name, description, instructions }
  chats: new Map(),
  tabs: [],
  activeId: null,
  recentlyClosed: [],
  streams: new Map(),        // chatId -> AbortController
  attachments: new Map(),    // chatId|NONE -> вложения черновика
  draftNone: "",
  composerFor: undefined,
  editingId: null,
  search: "",
  showArchive: false,
  contextNote: null,
  models: [],
  conn: { state: "unknown", message: "" },
  ui: { sidebar: false, inspector: false, settings: false, settingsTab: "general" },
};

/* =========================================================
   Сохранение
   ========================================================= */
const saveTimers = new Map();

function saveChatSoon(id, delay = 500) {
  clearTimeout(saveTimers.get(id));
  saveTimers.set(id, setTimeout(() => saveChat(id), delay));
}

async function saveChat(id) {
  const chat = S.chats.get(id);
  if (!chat) return;
  clearTimeout(saveTimers.get(id));
  try {
    await Store.putChat(chat);
  } catch (err) {
    console.error(err);
    toast(`${t("networkLost")} ${err.message || ""}`.trim(), "error");
  }
}

function persistMeta() {
  Store.setKV("folders", S.folders).catch(console.error);
  Store.setKV("tabs", { tabs: S.tabs, activeId: S.activeId, recentlyClosed: S.recentlyClosed }).catch(console.error);
}

function persistSettings() {
  Store.setKV("settings", S.settings).catch(console.error);
}

function persistMemory() {
  Store.setKV("memory", S.memory).catch(console.error);
}

function persistSkills() {
  Store.setKV("skills", S.skills).catch(console.error);
}

async function loadState() {
  const [settings, folders, tabs, chats, skills, memory] = await Promise.all([
    Store.getKV("settings"),
    Store.getKV("folders"),
    Store.getKV("tabs"),
    Store.getAllChats(),
    Store.getKV("skills"),
    Store.getKV("memory"),
  ]);
  S.memory = Array.isArray(memory)
    ? memory.filter((f) => f && typeof f.text === "string" && f.text.trim()).slice(-200)
    : [];
  S.skills = Array.isArray(skills)
    ? skills.filter((s) => s && typeof s.name === "string" && typeof s.description === "string" && typeof s.instructions === "string")
    : [];
  if (settings && typeof settings === "object") {
    S.settings = {
      ...DEFAULT_SETTINGS,
      ...settings,
      params: { ...DEFAULT_SETTINGS.params, ...(settings.params || {}) },
      features: { ...DEFAULT_SETTINGS.features, ...(settings.features || {}) },
      tools: { ...DEFAULT_SETTINGS.tools, ...(settings.tools || {}) },
    };
  }
  S.folders = Array.isArray(folders) ? folders.filter((f) => f && f.id && f.name) : [];
  for (const chat of chats || []) {
    for (const m of chat.messages || []) {
      if (m.status === "streaming") m.status = "stopped";
      if (m.toolCalls) {
        // Незавершённые вызовы после перезагрузки считаются отменёнными.
        for (const c of m.toolCalls) if (c.status === "pending" || c.status === "running") c.status = "denied", c.result = c.result || "Прервано перезагрузкой страницы.";
      }
    }
    S.chats.set(chat.id, chat);
  }
  if (tabs) {
    S.tabs = (tabs.tabs || []).filter((id) => S.chats.has(id));
    S.activeId = S.chats.has(tabs.activeId) ? tabs.activeId : S.tabs[0] ?? null;
    S.recentlyClosed = (tabs.recentlyClosed || []).filter((id) => S.chats.has(id) && !S.tabs.includes(id)).slice(0, MAX_TABS_RECENT);
  }
}

/* =========================================================
   Чаты и вкладки
   ========================================================= */
const active = () => (S.activeId ? S.chats.get(S.activeId) ?? null : null);

function displayTitle(chat) {
  if (chat.title) return chat.title;
  const first = chat.messages.find((m) => m.role === "user" && m.content.trim());
  if (first) return truncate(first.content.trim().split("\n")[0], 60);
  return t("newChat");
}

function createChat() {
  const now = Date.now();
  const chat = {
    id: uid(),
    title: "",
    folderId: null,
    pinned: false,
    archived: false,
    createdAt: now,
    updatedAt: now,
    messages: [],
    draft: "",
    context: "",
    scrollTop: null,
  };
  S.chats.set(chat.id, chat);
  return chat;
}

function newChat() {
  saveCurrentDraft();
  const chat = createChat();
  S.tabs.push(chat.id);
  S.activeId = chat.id;
  saveChat(chat.id);
  persistMeta();
  if (isMobile()) { S.ui.sidebar = false; applyLayout(); }
  renderAll();
  requestAnimationFrame(() => $("#composer-input")?.focus());
  return chat;
}

function ensureChat() {
  const current = active();
  if (current) return current;
  const chat = newChat();
  const pending = S.attachments.get(NONE);
  if (pending) {
    S.attachments.set(chat.id, pending);
    S.attachments.delete(NONE);
  }
  if (S.draftNone) {
    chat.draft = S.draftNone;
    S.draftNone = "";
  }
  return chat;
}

function openChat(id) {
  if (!S.chats.has(id)) return;
  if (S.activeId !== id) saveCurrentDraft();
  if (!S.tabs.includes(id)) S.tabs.push(id);
  S.recentlyClosed = S.recentlyClosed.filter((x) => x !== id);
  S.activeId = id;
  S.editingId = null;
  persistMeta();
  if (isMobile()) { S.ui.sidebar = false; applyLayout(); }
  renderAll();
}

function reopenRecent(id) {
  openChat(id);
  toast(t("reopened"));
}

function closeTab(id) {
  const idx = S.tabs.indexOf(id);
  if (idx < 0) return;
  if (S.activeId === id) saveCurrentDraft();
  S.tabs.splice(idx, 1);
  S.recentlyClosed = [id, ...S.recentlyClosed.filter((x) => x !== id)].slice(0, MAX_TABS_RECENT);
  if (S.activeId === id) {
    S.activeId = S.tabs[Math.min(idx, S.tabs.length - 1)] ?? null;
    S.editingId = null;
  }
  persistMeta();
  renderAll();
}

function removeChatEverywhere(id) {
  S.tabs = S.tabs.filter((x) => x !== id);
  S.recentlyClosed = S.recentlyClosed.filter((x) => x !== id);
  if (S.activeId === id) S.activeId = S.tabs[S.tabs.length - 1] ?? null;
  S.chats.delete(id);
  S.attachments.delete(id);
  S.streams.get(id)?.abort();
  Store.deleteChat(id).catch(console.error);
  persistMeta();
}

function deleteChat(id) {
  const chat = S.chats.get(id);
  if (!chat) return;
  if (!confirm(t("confirmDeleteChat", displayTitle(chat)))) return;
  removeChatEverywhere(id);
  deleteChatFiles(id).catch((err) => toast(err.message, "error"));
  renderAll();
}

function duplicateChat(id) {
  const src = S.chats.get(id);
  if (!src) return;
  const copy = createChat();
  copy.title = `${displayTitle(src)} (${t("copyWord")})`;
  copy.folderId = src.folderId;
  copy.context = src.context || "";
  copy.messages = src.messages.map((m) => ({
    ...structuredClone(m),
    id: uid(),
    status: m.status === "streaming" ? "stopped" : m.status,
  }));
  saveChat(copy.id);
  toast(t("duplicated"));
  renderAll();
}

function togglePin(id) {
  const c = S.chats.get(id);
  if (!c) return;
  c.pinned = !c.pinned;
  saveChat(id);
  renderAll();
}

function toggleArchive(id) {
  const c = S.chats.get(id);
  if (!c) return;
  c.archived = !c.archived;
  if (c.archived && S.tabs.includes(id)) closeTab(id);
  saveChat(id);
  renderAll();
}

function moveChat(id, folderId) {
  const c = S.chats.get(id);
  if (!c) return;
  c.folderId = folderId || null;
  saveChat(id);
  renderAll();
}

function renameChat(id, name) {
  const c = S.chats.get(id);
  const value = (name || "").trim();
  if (!c || !value) return;
  c.title = value;
  saveChat(id);
  renderAll();
}

function setContext() {
  const chat = ensureChat();
  const value = prompt(t("contextPrompt"), chat.context || "");
  if (value === null) return;
  chat.context = value.trim();
  saveChat(chat.id);
  renderAll();
  toast(t("contextSaved"));
}

function createFolder() {
  const name = prompt(t("folderName"), "");
  if (!name || !name.trim()) return;
  S.folders.push({ id: uid(), name: name.trim(), expanded: true });
  persistMeta();
  renderAll();
}

function renameFolder(id) {
  const f = S.folders.find((x) => x.id === id);
  if (!f) return;
  const name = prompt(t("renameFolder"), f.name);
  if (!name || !name.trim()) return;
  f.name = name.trim();
  persistMeta();
  renderAll();
}

function deleteFolder(id) {
  const f = S.folders.find((x) => x.id === id);
  if (!f) return;
  if (!confirm(t("confirmDeleteFolder", f.name))) return;
  S.folders = S.folders.filter((x) => x.id !== id);
  for (const c of S.chats.values()) {
    if (c.folderId === id) {
      c.folderId = null;
      saveChat(c.id);
    }
  }
  persistMeta();
  renderAll();
}

function toggleFolder(id) {
  const f = S.folders.find((x) => x.id === id);
  if (!f) return;
  f.expanded = !f.expanded;
  persistMeta();
  renderSidebar();
}

/* =========================================================
   Отрисовка
   ========================================================= */
function buildShell() {
  $("#app").innerHTML = `
    <aside class="sidebar" id="sidebar">
      <div class="sb-top">
        <div class="brand">${LOGO}<span>Cogniflux</span></div>
        <button class="icon-btn" data-action="toggleSidebar" id="sb-toggle" aria-label="sidebar">${icon("sidebar")}</button>
      </div>
      <div class="sb-actions">
        <button class="btn-primary" data-action="newChat">${icon("plus")}<span data-i18n="newChat"></span></button>
        <label class="search">${icon("search")}<input id="search" type="search" data-i18n-ph="search" autocomplete="off"></label>
      </div>
      <nav class="sb-list" id="sb-list" aria-label="chats"></nav>
    </aside>

    <main class="main" id="main">
      <header class="topbar">
        <button class="icon-btn" id="btn-sidebar" data-action="toggleSidebar" aria-label="sidebar" title="${esc(t("hideSidebar"))}">${icon("sidebar")}</button>
        <div class="topbar-title" id="topbar-title"></div>
        <div class="topbar-right">
          <span class="conn-pill" id="conn-pill" data-action="openSettings" data-tab="connection" role="button" tabindex="0"></span>
          <button class="icon-btn" id="btn-inspector" data-action="toggleInspector" aria-label="info">${icon("panel")}</button>
          <button class="icon-btn" data-action="openSettings" aria-label="settings">${icon("settings")}</button>
        </div>
      </header>
      <div class="tabs-bar">
        <div class="tabs" id="tabs" role="tablist"></div>
        <button class="icon-btn small" id="btn-reopen" data-action="reopenMenu" aria-label="recent">${icon("history")}</button>
        <button class="icon-btn small" data-action="newChat" aria-label="new">${icon("plus")}</button>
      </div>
      <section class="chat" id="chat">
        <div class="messages" id="messages"></div>
        <button class="jump-btn" id="jump-btn" data-action="jumpBottom" aria-label="${t("jumpBottom")}" hidden>${icon("arrowRight")}<span>${t("jumpBottom")}</span></button>
      </section>
      <footer class="composer-wrap">
        <div class="composer-inner">
          <div class="attachments" id="attachments"></div>
          <div class="composer-box">
            <textarea id="composer-input" rows="1" data-i18n-ph="placeholder" aria-label="message"></textarea>
            <div class="composer-bar">
              <div class="composer-left">
                <button class="icon-btn round" id="plus-btn" data-action="plusMenu" aria-label="more">${icon("plus")}</button>
                <div class="feature-toggles"><button class="feature-chip modes-btn" id="modes-btn" data-action="featuresMenu" aria-haspopup="menu"></button></div>
              </div>
              <div class="composer-right">
                <span class="counter" id="counter"></span>
                <button class="send-btn" id="send-btn" data-action="sendOrStop" aria-label="send"></button>
              </div>
            </div>
          </div>
          <div class="composer-hint" data-i18n="hint"></div>
        </div>
      </footer>
    </main>

    <aside class="inspector" id="inspector"></aside>`;
  applyStaticLabels();
}

function applyStaticLabels() {
  document.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => (el.placeholder = t(el.dataset.i18nPh)));
  const reopen = $("#btn-reopen");
  if (reopen) reopen.title = t("recentlyClosed");
  const sbToggle = $("#sb-toggle");
  if (sbToggle) sbToggle.title = t("hideSidebar");
}

function applySettings() {
  const root = document.documentElement;
  const dark = S.settings.theme === "dark" || (S.settings.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  root.dataset.theme = dark ? "dark" : "light";
  root.lang = S.settings.language;
  root.style.setProperty("--font-size", `${S.settings.fontSize}px`);
  root.style.setProperty("--msg-width", `${S.settings.messageWidth}px`);
  $("#hljs-light").disabled = dark;
  $("#hljs-dark").disabled = !dark;
  $("#app").classList.toggle("sidebar-right", S.settings.sidebarSide === "right");
  applyLayout();
}

function applyLayout() {
  const app = $("#app");
  if (!app) return;
  app.classList.toggle("sb-collapsed", !isMobile() && S.settings.sidebarCollapsed);
  app.classList.toggle("sb-open", isMobile() && S.ui.sidebar);
  app.classList.toggle("inspector-open", isMobile() ? S.ui.inspector : S.settings.inspectorOpen);
  $("#overlay")?.classList.toggle("on", isMobile() && (S.ui.sidebar || S.ui.inspector));
  $("#btn-inspector")?.classList.toggle("active", isMobile() ? S.ui.inspector : S.settings.inspectorOpen);
  $("#btn-sidebar")?.classList.toggle("active", isMobile() ? S.ui.sidebar : !S.settings.sidebarCollapsed);
}

function renderAll() {
  applyStaticLabels();
  renderSidebar();
  renderTabs();
  renderTopbar();
  renderMessages();
  renderComposer();
  renderInspector();
  renderSettings();
  applyLayout();
}

function groupKey(ts) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= start) return "today";
  if (ts >= start - DAY) return "yesterday";
  if (ts >= start - 7 * DAY) return "week";
  return "earlier";
}

function snippetOf(text, q) {
  const i = text.toLowerCase().indexOf(q);
  const start = Math.max(0, i - 30);
  const part = text.slice(start, i + q.length + 60).replace(/\s+/g, " ");
  return esc((start ? "…" : "") + part + "…");
}

function chatRow(c, snippet = "") {
  const isActive = c.id === S.activeId;
  const streaming = S.streams.has(c.id);
  return `
    <div class="chat-row ${isActive ? "active" : ""}" data-action="openChat" data-id="${c.id}" role="button" tabindex="0">
      <div class="chat-row-text">
        <span class="chat-row-title">${esc(displayTitle(c))}</span>
        ${snippet ? `<small>${snippet}</small>` : ""}
      </div>
      ${streaming ? '<span class="dot pulse" aria-label="generating"></span>' : ""}
      <button class="icon-btn small row-menu" data-action="chatMenu" data-id="${c.id}" aria-label="${esc(t("edit"))}">${icon("dots")}</button>
    </div>`;
}

function renderSidebar() {
  const list = $("#sb-list");
  if (!list) return;
  const q = S.search.trim().toLowerCase();

  if (q) {
    const hits = [];
    for (const c of S.chats.values()) {
      const title = displayTitle(c);
      const msg = c.messages.find((m) => m.content.toLowerCase().includes(q));
      if (title.toLowerCase().includes(q) || msg) hits.push({ c, snippet: msg ? snippetOf(msg.content, q) : "" });
    }
    hits.sort((a, b) => byUpdated(a.c, b.c));
    list.innerHTML = hits.length
      ? `<div class="sb-group-title">${t("searchResults")}</div>` + hits.map(({ c, snippet }) => chatRow(c, snippet)).join("")
      : `<div class="sb-empty">${t("noResults")}</div>`;
    return;
  }

  const all = [...S.chats.values()];
  const visible = all.filter((c) => !c.archived);
  const pinned = visible.filter((c) => c.pinned).sort(byUpdated);
  const rest = visible.filter((c) => !c.pinned);
  let html = "";

  if (pinned.length) html += `<div class="sb-group-title">${t("pinned")}</div>` + pinned.map((c) => chatRow(c)).join("");

  html += `<div class="sb-group-title sb-folders-head"><span>${t("folders")}</span>
      <button class="icon-btn small" data-action="newFolder" aria-label="${t("newFolder")}" title="${t("newFolder")}">${icon("plus")}</button></div>`;
  for (const f of S.folders) {
    const items = rest.filter((c) => c.folderId === f.id).sort(byUpdated);
    html += `
      <div class="folder ${f.expanded ? "expanded" : ""}">
        <div class="folder-row">
          <button class="folder-toggle" data-action="toggleFolder" data-id="${f.id}" aria-expanded="${f.expanded}">
            ${icon("chevron")}<span>${esc(f.name)}</span><small>${items.length}</small>
          </button>
          <button class="icon-btn small" data-action="folderMenu" data-id="${f.id}" aria-label="${t("edit")}">${icon("dots")}</button>
        </div>
        ${f.expanded
          ? `<div class="folder-children">${items.map((c) => chatRow(c)).join("") || `<div class="sb-empty small">${t("emptyFolder")}</div>`}</div>`
          : ""}
      </div>`;
  }

  const loose = rest.filter((c) => !c.folderId).sort(byUpdated);
  const groups = { today: [], yesterday: [], week: [], earlier: [] };
  for (const c of loose) groups[groupKey(c.updatedAt)].push(c);
  for (const key of ["today", "yesterday", "week", "earlier"]) {
    if (!groups[key].length) continue;
    html += `<div class="sb-group-title">${t(key)}</div>` + groups[key].map((c) => chatRow(c)).join("");
  }

  const archived = all.filter((c) => c.archived).sort(byUpdated);
  if (archived.length) {
    html += `<button class="sb-group-head clickable" data-action="toggleArchive">
        <span>${t("archive")} (${archived.length})</span>${icon("chevron", { cls: S.showArchive ? "rot" : "" })}</button>`;
    if (S.showArchive) html += archived.map((c) => chatRow(c)).join("");
  }

  list.innerHTML = html || `<div class="sb-empty">${t("noChats")}</div>`;
}

function renderTabs() {
  const el = $("#tabs");
  if (!el) return;
  el.innerHTML = S.tabs
    .map((id) => {
      const c = S.chats.get(id);
      if (!c) return "";
      const isActive = id === S.activeId;
      const title = displayTitle(c);
      return `
        <div class="tab ${isActive ? "active" : ""}" role="tab" aria-selected="${isActive}">
          <button class="tab-main" data-action="openChat" data-id="${id}" title="${esc(title)}">
            ${S.streams.has(id) ? '<span class="dot pulse"></span>' : ""}
            <span>${esc(truncate(title, 34))}</span>
          </button>
          <button class="tab-close" data-action="closeTab" data-id="${id}" aria-label="${t("closeTab")}" title="${t("closeTab")}">${icon("close")}</button>
        </div>`;
    })
    .join("");
  el.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  $("#btn-reopen").disabled = !S.recentlyClosed.length;
}

function connLabel() {
  if (S.conn.state === "ok" || S.conn.state === "error") return S.conn.message;
  if (S.conn.state === "checking") return t("connChecking");
  return t("connUnknown");
}

function renderTopbar() {
  const c = active();
  $("#topbar-title").textContent = c ? displayTitle(c) : t("appName");
  const pill = $("#conn-pill");
  pill.className = `conn-pill ${S.conn.state}`;
  pill.innerHTML = `<span class="dot"></span><span>${esc(connLabel())}</span>`;
}

function welcomeHtml(chat) {
  if (!chat) {
    return `
      <div class="welcome">
        <div class="welcome-logo">${LOGO}</div>
        <h1>${t("greeting")}</h1>
        <p class="muted">${t("tagline")}</p>
        <button class="btn-primary" data-action="newChat">${icon("plus")}${t("newChat")}</button>
      </div>`;
  }
  const examples = EXAMPLES[S.settings.language] || EXAMPLES.ru;
  const modelLine = S.settings.model
    ? `<p class="model-note">${icon("check")} ${esc(t("modelInfo", S.settings.model))}</p>`
    : `<p class="model-note warn">${icon("warn")} ${t("noModelHint")}</p>`;
  return `
    <div class="welcome">
      <div class="welcome-logo">${LOGO}</div>
      <h1>${t("greeting")}</h1>
      <p>${t("tagline")}</p>
      <div class="example-grid">
        ${examples.map((p) => `<button class="example-card" data-action="example" data-prompt="${esc(p)}">${esc(p)}</button>`).join("")}
      </div>
      ${modelLine}
    </div>`;
}

function toolLabel(name) {
  return TOOL_KEYS[name] ? t(TOOL_KEYS[name]) : name;
}

function toolCardsHtml(m) {
  if (!m.toolCalls?.length) return "";
  const statusKey = { pending: "toolPending", running: "toolRunning", done: "toolDone", error: "toolError", denied: "toolDenied" };
  return `<div class="tool-list">${m.toolCalls
    .map((c, i) => {
      let view = c.args || "{}";
      try {
        const a = JSON.parse(c.args || "{}");
        if (c.name === "show_html") view = a.title || t("toolPanel");
        else if (c.name === "run_code") view = `# ${a.language || ""}\n${a.code || ""}`;
        else if (c.name === "write_file") view = `${a.path || ""}\n${(a.content || "").slice(0, 4000)}`;
        else view = Object.entries(a).map(([k, v]) => `${k}: ${v}`).join("\n") || "{}";
      } catch (_) {
        view = c.args;
      }
      const buttons = c.status === "pending" && requiresApproval(c.name)
        ? `<div class="tool-actions">
             <button class="btn-primary small" data-action="toolApprove" data-id="${m.id}" data-index="${i}">${t("approve")}</button>
             <button class="btn-ghost small" data-action="toolDeny" data-id="${m.id}" data-index="${i}">${t("deny")}</button>
           </div>`
        : "";
      return `
        <div class="tool-card s-${c.status}">
          <div class="tool-head"><span class="tool-name">${icon("tool")}${esc(toolLabel(c.name))}</span><span class="tool-status">${t(statusKey[c.status] || "toolDone")}</span></div>
          <pre class="tool-args">${esc(view)}</pre>
          ${c.result != null ? `<details class="tool-result"><summary>${t("toolResult")}</summary><pre>${esc(c.result)}</pre></details>` : ""}
          ${c.file && /\.(mp4|webm)$/i.test(c.file.name) ? `<video class="video-preview" controls preload="metadata" src="${esc(c.file.url)}"></video>` : ""}
          ${c.file ? `<a class="file-link" href="${esc(c.file.url)}" download>${icon("download")}<span>${esc(c.file.name)}</span><small>${fmtSize(c.file.size)}</small><b>${t("downloadFile")}</b></a>` : ""}
          ${c.panel ? `<div class="html-panel-wrap">${c.panel.title ? `<div class="html-panel-title">${esc(c.panel.title)}</div>` : ""}<iframe class="html-panel" sandbox="allow-scripts" title="${esc(c.panel.title || t("toolPanel"))}" style="height:${c.panel.height}px" srcdoc="${esc(PANEL_CSP + c.panel.html)}"></iframe></div>` : ""}
          ${buttons}
        </div>`;
    })
    .join("")}</div>`;
}

/** Строка статуса: что модель делает сейчас. Пустая строка, если ничего не происходит. */
function statusHtml(m) {
  let text = null;
  const running = m.toolCalls?.find((c) => c.status === "running");
  if (running) text = t("runningTool", toolLabel(running.name));
  else if (m.status === "streaming") {
    if (!m.content) text = t("thinkingNow");
    else if (splitThink(stripToolBlocks(m.content)).open) text = t("reasoningNow");
  }
  return text ? `<div class="status-line"><span class="dot pulse"></span><span>${esc(text)}</span></div>` : "";
}

function statsHtml(m) {
  if (!m.stats || !m.stats.seconds) return "";
  return `<span class="msg-stats">${esc(t("statsLine", m.stats.seconds.toFixed(1), m.stats.chars))}</span>`;
}

function messageHtml(chat, m, index) {
  const time = fmtTime(m.ts);
  if (m.role === "user") {
    if (S.editingId === m.id) {
      return `
        <article class="msg user editing" data-msg-id="${m.id}">
          <textarea class="edit-area" id="edit-area" aria-label="${t("edit")}">${esc(m.content)}</textarea>
          <div class="msg-actions-row">
            <button class="btn-ghost small" data-action="cancelEdit">${t("cancel")}</button>
            <button class="btn-primary small" data-action="saveEdit" data-id="${m.id}">${t("saveAndSend")}</button>
          </div>
        </article>`;
    }
    const atts = (m.attachments || [])
      .map((a) => (a.kind === "image" ? `<img class="msg-img" src="${a.dataUrl}" alt="${esc(a.name)}">` : `<span class="att-chip">${icon("file")}${esc(a.name)}</span>`))
      .join("");
    return `
      <article class="msg user" data-msg-id="${m.id}">
        <div class="user-bubble">
          ${atts ? `<div class="msg-atts">${atts}</div>` : ""}
          ${m.content ? `<div class="user-text">${esc(m.content)}</div>` : ""}
        </div>
        <div class="msg-foot">
          <time>${time}</time>
          <button class="icon-btn small" data-action="copyMsg" data-id="${m.id}" aria-label="${t("copy")}" title="${t("copy")}">${icon("copy")}</button>
          <button class="icon-btn small" data-action="editMsg" data-id="${m.id}" aria-label="${t("edit")}" title="${t("edit")}">${icon("edit")}</button>
        </div>
      </article>`;
  }

  const streaming = m.status === "streaming";
  const isLast = index === chat.messages.length - 1;
  let status = "";
  if (streaming && !m.content) status = `<div class="typing"><span></span><span></span><span></span></div>`;
  if (m.status === "error") {
    status = `
      <div class="msg-error">${icon("warn")}
        <div>
          <strong>${t("errorTitle")}</strong>
          <p>${esc(m.error || "")}</p>
          <button class="btn-ghost small" data-action="retry" data-id="${m.id}">${icon("refresh")}${t("retry")}</button>
        </div>
      </div>`;
  } else if (m.status === "stopped") {
    status = `<div class="msg-note">${t("stopped")}</div>`;
  }

  let actions = "";
  if (!streaming) {
    if (m.content) actions += `<button class="icon-btn small" data-action="copyMsg" data-id="${m.id}" aria-label="${t("copy")}" title="${t("copy")}">${icon("copy")}</button>`;
    if (m.content) actions += `<button class="icon-btn small" data-action="speakMsg" data-id="${m.id}" aria-label="${t("speak")}" title="${t("speak")}">${icon("eye")}</button>`;
    if (m.status === "stopped" && m.content && isLast) actions += `<button class="icon-btn small" data-action="continueMsg" data-id="${m.id}" aria-label="${t("continue")}" title="${t("continue")}">${icon("arrowRight")}</button>`;
    if (m.status === "done" && isLast && !m.toolCalls?.length) actions += `<button class="icon-btn small" data-action="regen" aria-label="${t("regenerate")}" title="${t("regenerate")}">${icon("refresh")}</button>`;
  }

  return `
    <article class="msg ai ${streaming ? "streaming" : ""}" data-msg-id="${m.id}">
      <div class="avatar">${LOGO.replace('width="26" height="26"', 'width="18" height="18"')}</div>
      <div class="msg-main">
        <div class="md" data-msg-body="${m.id}">${m.content ? renderMarkdown(m.content, m.id) : ""}</div>
        ${status}
        <div class="msg-status" data-status="${m.id}">${statusHtml(m)}</div>
        ${toolCardsHtml(m)}
        <div class="msg-foot"><time>${time}</time>${statsHtml(m)}${actions}</div>
      </div>
    </article>`;
}

function renderMessages() {
  const box = $("#messages");
  if (!box) return;
  const chat = active();
  if (!chat || !chat.messages.length) {
    box.innerHTML = welcomeHtml(chat);
    box.dataset.chat = chat ? chat.id : "";
    return;
  }
  const sameChat = box.dataset.chat === chat.id && box.querySelector(".msg-list");
  const prevTop = box.scrollTop;
  const wasAtBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  box.innerHTML = `<div class="msg-list">${chat.messages.map((m, i) => messageHtml(chat, m, i)).join("")}</div>`;
  enhanceCode(box);
  if (windowsMode()) {
    for (const m of chat.messages) if (m.role === "assistant") syncWindows(m, { final: m.status !== "streaming" });
  }
  box.dataset.chat = chat.id;
  if (sameChat) {
    box.scrollTop = wasAtBottom && S.settings.autoScroll ? box.scrollHeight : prevTop;
  } else if (chat.scrollTop != null) {
    box.scrollTop = chat.scrollTop;
  } else {
    box.scrollTop = box.scrollHeight;
  }
}

/** Обновляет только тело потокового ответа: без пересоздания блока сообщения (иначе текст мигает). */
function updateStreamingMessage(chat, m) {
  if (chat.id !== S.activeId) return;
  const body = document.querySelector(`[data-msg-body="${m.id}"]`);
  if (!body) {
    renderMessages();
    return;
  }
  const box = $("#messages");
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  fillBody(m, body);
  if (m.content) body.closest(".msg")?.querySelector(".typing")?.remove();
  const statusEl = document.querySelector(`[data-status="${m.id}"]`);
  if (statusEl) statusEl.innerHTML = statusHtml(m);
  if (windowsMode()) syncWindows(m, { final: m.status !== "streaming" });
  if (S.settings.autoScroll && stick) box.scrollTop = box.scrollHeight;
}

/** Полная перерисовка сообщений после изменения структуры (инструменты, ошибки и т.п.). */
function refreshChat(chatId) {
  if (chatId === S.activeId) renderMessages();
  renderSidebar();
  renderTabs();
  renderComposer();
}

function renderComposer() {
  const chat = active();
  const key = chat ? chat.id : NONE;
  const atts = S.attachments.get(key) || [];
  $("#attachments").innerHTML = atts
    .map(
      (a, i) => `
      <div class="att">
        ${a.kind === "image" ? `<img src="${a.dataUrl}" alt="">` : icon("file")}
        <span>${esc(a.name)}</span><small>${fmtSize(a.size)}</small>
        <button class="icon-btn small" data-action="removeAtt" data-index="${i}" aria-label="${t("cancel")}">${icon("close")}</button>
      </div>`
    )
    .join("");

  const input = $("#composer-input");
  if (S.composerFor !== key) {
    input.value = chat ? chat.draft || "" : S.draftNone;
    S.composerFor = key;
    autosize(input);
  }
  const value = input.value;
  $("#counter").textContent = value.length > 200 ? `${value.length}` : "";

  const modesBtn = $("#modes-btn");
  if (modesBtn) {
    const f = S.settings.features;
    const on = Object.keys(MODE_KEYS).filter((k) => f[k]);
    const skill = chat?.skill ? ` · ${chat.skill}` : "";
    const names = on.map((k) => t(MODE_KEYS[k])).join(", ");
    modesBtn.innerHTML = `${icon("tool")}<span>${esc(truncate((names || t("modes")) + skill, 60))}</span>`;
    modesBtn.classList.toggle("active", on.length > 0 || !!chat?.skill);
    modesBtn.title = t("modesHint");
  }

  const streaming = !!chat && S.streams.has(chat.id);
  const btn = $("#send-btn");
  btn.dataset.mode = streaming ? "stop" : "send";
  btn.innerHTML = streaming
    ? `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="3" fill="currentColor"/></svg>`
    : icon("send");
  btn.title = streaming ? t("stop") : t("send");
  btn.setAttribute("aria-label", streaming ? t("stop") : t("send"));
  btn.disabled = !streaming && !value.trim() && !atts.length;
}

function autosize(el) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
}

function renderInspector() {
  const el = $("#inspector");
  if (!el) return;
  const c = active();
  const p = S.settings.params;
  el.innerHTML = `
    <div class="insp-head">
      <strong>${t("inspector")}</strong>
      <button class="icon-btn small" data-action="toggleInspector" aria-label="close">${icon("close")}</button>
    </div>

    <section class="card">
      <h3>${t("modelSection")}</h3>
      <div class="kv"><span>${t("connStatus")}</span>${connPillHtml()}</div>
      ${modelSelectHtml()}
      <div class="kv"><span>${t("tools")}</span><b>${enabledToolNames().length}</b></div>
      ${S.contextNote && c && S.contextNote.chatId === c.id ? `<div class="kv"><span>${t("contextLimit")}</span><b>${t("contextTrimmed", S.contextNote.dropped)}</b></div>` : ""}
      <p class="muted small">${t("contextUnknown")}</p>
    </section>

    <section class="card">
      <h3>${t("genParams")}</h3>
      ${sliderHtml("temperature", t("temperature"), 0, 2, 0.05, p.temperature)}
      ${sliderHtml("top_p", t("topP"), 0, 1, 0.01, p.top_p)}
      ${sliderHtml("frequency_penalty", t("freqPenalty"), -2, 2, 0.1, p.frequency_penalty)}
      ${sliderHtml("presence_penalty", t("presPenalty"), -2, 2, 0.1, p.presence_penalty)}
      <label class="field"><span>${t("maxTokens")}</span>
        <input type="number" min="1" max="32768" step="1" data-setting="params.max_tokens" value="${p.max_tokens ?? ""}">
      </label>
      <label class="field"><span>${t("seed")}</span>
        <input type="number" min="0" step="1" data-setting="params.seed" value="${p.seed ?? ""}">
      </label>
    </section>

    <section class="card">
      <h3>${t("chatInfo")}</h3>
      ${c
        ? `
        <label class="field"><span>${t("title")}</span>
          <input type="text" id="chat-title-input" value="${esc(c.title || displayTitle(c))}">
        </label>
        <div class="kv"><span>${t("chatFolder")}</span><b class="mono">workspace/${esc(c.id)}</b></div>
        <div class="kv"><span>${t("messages")}</span><b>${c.messages.length}</b></div>
        <div class="kv"><span>${t("created2")}</span><b>${fmtDate(c.createdAt)}</b></div>
        <button class="btn-ghost" data-action="setContext">${icon("edit")}${t("addContext")}</button>
        <button class="btn-ghost" data-action="exportChat">${icon("download")}${t("exportMd")}</button>
        <button class="btn-ghost danger" data-action="clearChat">${icon("trash")}${t("clearChat")}</button>`
        : `<p class="muted small">${t("noActiveChat")}</p>`}
    </section>`;
}

function sliderHtml(key, label, min, max, step, value) {
  const v = value ?? 0;
  return `
    <label class="field"><span>${label}</span>
      <div class="range-row">
        <input type="range" min="${min}" max="${max}" step="${step}" value="${v}" data-setting="params.${key}">
        <output>${v}</output>
      </div>
    </label>`;
}

function modelSelectHtml() {
  const list = S.models.map((m) => m.id);
  if (S.settings.model && !list.includes(S.settings.model)) list.unshift(S.settings.model);
  if (!list.length) return `<p class="muted small">${t("noModelsLoaded")}</p>`;
  return `
    <label class="field"><span>${t("selectModel")}</span>
      <select data-setting="model">
        ${list.map((id) => `<option value="${esc(id)}" ${id === S.settings.model ? "selected" : ""}>${esc(id)}</option>`).join("")}
      </select>
    </label>`;
}

function connPillHtml() {
  return `<span class="conn-pill static ${S.conn.state}"><span class="dot"></span><span>${esc(connLabel())}</span></span>`;
}

/* ---------- память: сбор фактов из прошлых чатов ---------- */
let memoryScanning = false;
async function scanMemory() {
  if (memoryScanning) return;
  if (!S.settings.model) {
    toast(t("noModel"), "error");
    return;
  }
  const chats = [...S.chats.values()].map((c) => ({ title: displayTitle(c), updatedAt: c.updatedAt, messages: c.messages }));
  const input = buildExtractionInput(chats, Number(S.settings.contextChars) || 48000);
  if (!input) {
    toast(t("memoryNothing"));
    return;
  }
  memoryScanning = true;
  renderSettings();
  let acc = "";
  try {
    await streamChat({
      settings: { ...S.settings, params: { ...S.settings.params, max_tokens: 1024 } },
      messages: [{ role: "system", content: EXTRACT_PROMPT }, { role: "user", content: input }],
      toolNames: [],
      onDelta: (d) => { acc += d; },
    });
    const before = S.memory.length;
    S.memory = mergeFacts(S.memory, parseFactLines(acc));
    persistMemory();
    toast(t("memoryAdded", S.memory.length - before));
  } catch (err) {
    toast(err.message || String(err), "error");
  } finally {
    memoryScanning = false;
    renderSettings();
  }
}

/* ---------- настройки ---------- */
function openSettings(tab) {
  S.ui.settings = true;
  if (tab) S.ui.settingsTab = tab;
  renderSettings();
}

function closeSettings() {
  S.ui.settings = false;
  renderSettings();
}

function renderSettings() {
  const root = $("#modal-root");
  if (!root) return;
  if (!S.ui.settings) {
    root.innerHTML = "";
    return;
  }
  const tabs = ["general", "appearance", "connection", "generation", "tools", "skills", "memory", "data", "hotkeys"];
  const tabLabel = {
    general: "tabGeneral", appearance: "tabAppearance", connection: "tabConnection",
    generation: "tabGeneration", tools: "tabTools", skills: "tabSkills", memory: "tabMemory", data: "tabData", hotkeys: "tabHotkeys",
  };
  root.innerHTML = `
    <div class="modal-backdrop" data-action="closeSettings"></div>
    <div class="modal" role="dialog" aria-modal="true" aria-label="${t("settings")}">
      <header class="modal-head">
        <h2>${t("settings")}</h2>
        <button class="icon-btn" data-action="closeSettings" aria-label="close">${icon("close")}</button>
      </header>
      <div class="modal-body">
        <nav class="modal-nav">
          ${tabs.map((k) => `<button class="${S.ui.settingsTab === k ? "active" : ""}" data-action="settingsTab" data-tab="${k}">${t(tabLabel[k])}</button>`).join("")}
        </nav>
        <div class="modal-pane">${settingsPaneHtml(S.ui.settingsTab)}</div>
      </div>
    </div>`;
}

function settingsPaneHtml(tab) {
  const s = S.settings;
  const check = (key, label) =>
    `<label class="checkbox"><input type="checkbox" data-setting="${key}" ${s[key] ? "checked" : ""}><span>${label}</span></label>`;
  const select = (key, label, options) =>
    `<label class="field"><span>${label}</span><select data-setting="${key}">${options
      .map(([v, l]) => `<option value="${v}" ${String(s[key]) === String(v) ? "selected" : ""}>${l}</option>`)
      .join("")}</select></label>`;

  if (tab === "general") {
    return `<h3>${t("tabGeneral")}</h3>
      ${select("language", t("language"), [["ru", "Русский"], ["en", "English"]])}
      ${select("sidebarSide", t("sidebarSide"), [["left", t("left")], ["right", t("right")]])}
      ${check("enterSends", t("enterSends"))}`;
  }

  if (tab === "appearance") {
    return `<h3>${t("tabAppearance")}</h3>
      ${select("theme", t("theme"), [["light", t("themeLight")], ["dark", t("themeDark")], ["system", t("themeSystem")]])}
      <label class="field"><span>${t("fontSize")}: <b>${s.fontSize}px</b></span>
        <input type="range" min="13" max="18" step="1" value="${s.fontSize}" data-setting="fontSize"></label>
      <label class="field"><span>${t("msgWidth")}: <b>${s.messageWidth}px</b></span>
        <input type="range" min="600" max="1000" step="20" value="${s.messageWidth}" data-setting="messageWidth"></label>
      ${check("autoScroll", t("autoScroll"))}`;
  }

  if (tab === "connection") {
    return `<h3>${t("tabConnection")}</h3>
      <label class="field"><span>${t("baseUrl")}</span>
        <input type="text" data-setting="baseUrl" value="${esc(s.baseUrl)}" spellcheck="false" autocomplete="off">
        <small>${t("baseUrlHint")}</small>
      </label>
      <label class="field"><span>${t("apiKey")}</span>
        <div class="field-row">
          <input type="password" id="api-key-input" data-setting="apiKey" value="${esc(s.apiKey)}" autocomplete="off">
          <button class="btn-ghost small" data-action="toggleKey">${icon("eye")}<span id="key-toggle-label">${t("show")}</span></button>
        </div>
        <small>${t("apiKeyHint")}</small>
      </label>
      <div class="actions-col">
        <button class="btn-primary" data-action="checkConn">${icon("refresh")}${t("checkConnection")}</button>
        <span class="conn-pill static ${S.conn.state}"><span class="dot"></span><span>${esc(connLabel())}</span></span>
      </div>
      <section>
        <label class="field"><span>${t("selectModel")}</span>${modelSelectHtml()}</label>
      </section>`;
  }

  if (tab === "generation") {
    const p = s.params;
    return `<h3>${t("tabGeneration")}</h3>
      ${sliderHtml("temperature", t("temperature"), 0, 2, 0.05, p.temperature)}
      ${sliderHtml("top_p", t("topP"), 0, 1, 0.01, p.top_p)}
      ${sliderHtml("frequency_penalty", t("freqPenalty"), -2, 2, 0.1, p.frequency_penalty)}
      ${sliderHtml("presence_penalty", t("presPenalty"), -2, 2, 0.1, p.presence_penalty)}
      <label class="field"><span>${t("maxTokens")}</span><input type="number" min="1" max="32768" data-setting="params.max_tokens" value="${p.max_tokens ?? ""}"></label>
      <label class="field"><span>${t("seed")}</span><input type="number" min="0" data-setting="params.seed" value="${p.seed ?? ""}"></label>
      <label class="field"><span>${t("contextLimitSetting")}</span><input type="number" min="4000" max="1000000" step="1000" data-setting="contextChars" value="${s.contextChars}"></label>
      <p class="muted small">${t("genNote")}</p>`;
  }

  if (tab === "skills") {
    const off = s.skillsOff || {};
    const rows = allSkills(S.skills).map((sk) => `
      <div class="skill-row">
        <label class="checkbox"><input type="checkbox" data-action="skillToggle" data-name="${esc(sk.name)}" ${off[sk.name] ? "" : "checked"}>
          <span><b>${esc(sk.name)}</b> <small class="muted">${sk.builtin ? esc(t("skillBuiltin")) : ""}</small><br><small class="muted">${esc(sk.description)}</small></span></label>
        <div class="skill-actions">
          <button class="icon-btn small" data-action="skillExport" data-name="${esc(sk.name)}" aria-label="${esc(t("exportMd"))}" title="${esc(t("exportMd"))}">${icon("download")}</button>
          ${sk.builtin ? "" : `<button class="icon-btn small danger" data-action="skillDelete" data-name="${esc(sk.name)}" aria-label="${esc(t("skillDelete"))}" title="${esc(t("skillDelete"))}">${icon("trash")}</button>`}
        </div>
      </div>`).join("");
    return `<h3>${t("tabSkills")}</h3>
      <p class="muted small">${t("skillsNote")}</p>
      ${rows || `<p class="muted small">${t("noSkills")}</p>`}`;
  }

  if (tab === "memory") {
    const rows = S.memory.slice().reverse().map((f) => `
      <div class="skill-row">
        <span class="memory-text">${esc(f.text)}</span>
        <div class="skill-actions">
          <button class="icon-btn small danger" data-action="memoryDelete" data-id="${esc(f.id)}" aria-label="${esc(t("skillDelete"))}" title="${esc(t("skillDelete"))}">${icon("trash")}</button>
        </div>
      </div>`).join("");
    return `<h3>${t("tabMemory")}</h3>
      <p class="muted small">${t("memoryNote")}</p>
      <div class="actions-col">
        <button class="btn-primary" data-action="memoryScan" ${memoryScanning ? "disabled" : ""}>${icon("refresh")}${t(memoryScanning ? "memoryScanning" : "memoryScanBtn")}</button>
        ${S.memory.length ? `<button class="btn-ghost danger" data-action="memoryClear">${icon("trash")}${t("memoryClear")}</button>` : ""}
      </div>
      ${rows || `<p class="muted small">${t("memoryEmpty")}</p>`}`;
  }

  if (tab === "tools") {
    const rows = ALL_TOOLS.map(
      (n) => `<label class="checkbox"><input type="checkbox" data-setting="tools.${n}" ${s.tools[n] !== false ? "checked" : ""}><span>${t(TOOL_KEYS[n])}</span></label>`
    ).join("");
    return `<h3>${t("tabTools")}</h3>
      <p class="muted small">${t("toolsNote")}</p>
      ${rows}
      <div class="kv"><span>${t("toolsWorkspace")}</span><b>${esc(S.workspace || "—")}</b></div>`;
  }

  if (tab === "data") {
    return `<h3>${t("tabData")}</h3>
      <div class="kv"><span>${t("dataStats")}</span><b>${S.chats.size}</b></div>
      <section>
        <div class="actions-col">
          <button class="btn-ghost" data-action="exportAll">${icon("download")}${t("exportAll")}</button>
          <button class="btn-ghost" data-action="importAll">${icon("upload")}${t("importAll")}</button>
          <button class="btn-ghost danger" data-action="deleteAll">${icon("trash")}${t("deleteAll")}</button>
        </div>
      </section>`;
  }

  return `<h3>${t("tabHotkeys")}</h3>
    <table class="hotkeys">
      <tr><td>${t("newChatHk")}</td><td><kbd>Alt</kbd> + <kbd>N</kbd></td></tr>
      <tr><td>${t("searchHk")}</td><td><kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>K</kbd></td></tr>
      <tr><td>${t("closeTabHk")}</td><td><kbd>Alt</kbd> + <kbd>W</kbd></td></tr>
      <tr><td>${t("sendHk")}</td><td><kbd>Enter</kbd></td></tr>
      <tr><td>${t("newlineHk")}</td><td><kbd>Shift</kbd> + <kbd>Enter</kbd></td></tr>
      <tr><td>${t("escHk")}</td><td><kbd>Esc</kbd></td></tr>
      <tr><td>${t("shortcutsHk")}</td><td><kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>/</kbd></td></tr>
    </table>`;
}

/* =========================================================
   Контекстные меню
   ========================================================= */
let menuHandler = null;

function openMenu(anchor, items, handler, placement = "below") {
  closeMenu();
  menuHandler = handler;
  const root = $("#menu-root");
  root.innerHTML = `<div class="menu" role="menu">${items
    .map((it) =>
      it.sep
        ? `<div class="menu-sep"></div>`
        : it.labelOnly
          ? `<div class="menu-label">${esc(it.label)}</div>`
          : `<button class="menu-item ${it.danger ? "danger" : ""}" role="menuitem" ${it.disabled ? "disabled" : ""}
              data-menu-kind="${it.kind}" data-menu-id="${esc(it.id ?? "")}" data-menu-value="${esc(it.value ?? "")}">
              <span>${esc(it.label)}</span>${it.hint ? `<small>${esc(it.hint)}</small>` : ""}
            </button>`
    )
    .join("")}</div>`;
  const menu = root.firstElementChild;
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const left = Math.min(r.left, window.innerWidth - w - 8);
  let top = placement === "above" ? r.top - h - 8 : r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
  menu.querySelector(".menu-item:not([disabled])")?.focus();
}

function closeMenu() {
  const root = $("#menu-root");
  if (root) root.innerHTML = "";
  menuHandler = null;
}

function chatMenu(anchor, id) {
  const c = S.chats.get(id);
  if (!c) return;
  openMenu(anchor, [
    { kind: "rename", id, label: t("rename") },
    { kind: "pin", id, label: c.pinned ? t("unpin") : t("pin") },
    { kind: "duplicate", id, label: t("duplicate") },
    { kind: "archive", id, label: c.archived ? t("unarchive") : t("archiveAct") },
    { sep: true },
    { label: t("moveTo"), labelOnly: true },
    { kind: "move", id, value: "", label: t("noFolder") },
    ...S.folders.map((f) => ({ kind: "move", id, value: f.id, label: f.name })),
    { sep: true },
    { kind: "delete", id, label: t("delete"), danger: true },
  ], menuAction);
}

function folderMenu(anchor, id) {
  openMenu(anchor, [
    { kind: "folderRename", id, label: t("renameFolder") },
    { kind: "folderDelete", id, label: t("deleteFolder"), danger: true },
  ], menuAction);
}

function reopenMenu(anchor) {
  const items = S.recentlyClosed
    .map((id) => S.chats.get(id))
    .filter(Boolean)
    .map((c) => ({ kind: "reopenItem", id: c.id, label: truncate(displayTitle(c), 40) }));
  if (!items.length) {
    toast(t("noClosed"));
    return;
  }
  openMenu(anchor, items, menuAction);
}

function plusMenu(anchor) {
  const voiceOk = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  openMenu(anchor, [
    { kind: "plus", id: "file", label: t("attachFile") },
    { kind: "plus", id: "image", label: t("attachImage") },
    { kind: "addContext", label: t("addContext") },
    { kind: "plus", id: "tools", label: t("chooseTool") },
    { kind: "plus", id: "voice", label: t("voice"), disabled: !voiceOk, hint: voiceOk ? "" : t("unavailable") },
  ], menuAction, "above");
}

function featuresMenu(anchor) {
  const f = S.settings.features;
  const chat = active();
  const item = (id, on, label) => ({ kind: "feature", id, label: `${on ? "✓  " : "      "}${label}` });
  const items = [
    item("thinking", f.thinking, t("thinking")),
    item("code", f.code, t("codeExec")),
    item("functions", f.functions, t("functions")),
    item("windows", f.windows, t("windows")),
    item("skills", f.skills, t("skills")),
    item("memory", f.memory, t("memory")),
    { sep: true },
    { label: t("modeLabel"), labelOnly: true },
    item("createSkill", f.createSkill, t("createSkill")),
    item("webdev", f.webdev, t("webdev")),
    item("video", f.video, t("video")),
    { sep: true },
    { label: t("skillForChat"), labelOnly: true },
    { kind: "skillPick", id: "", label: `${!chat?.skill ? "✓  " : "      "}${t("noSkill")}` },
    ...allSkills(S.skills).map((sk) => ({
      kind: "skillPick", id: sk.name, label: `${chat?.skill === sk.name ? "✓  " : "      "}${sk.name}`,
    })),
  ];
  openMenu(anchor, items, menuAction, "above");
}

function setChatSkill(name) {
  const chat = ensureChat();
  chat.skill = name || null;
  chat.updatedAt = Date.now();
  saveChat(chat.id);
  renderAll();
  toast(name ? `${t("skillSelected")}: ${name}` : t("noSkill"));
}

function toolMenu(anchor) {
  openMenu(anchor, ALL_TOOLS.map((n) => ({
    kind: "toggleTool",
    id: n,
    label: `${S.settings.tools[n] !== false ? "✓  " : "      "}${t(TOOL_KEYS[n])}`,
  })), menuAction, "above");
}

function menuAction(kind, id, value) {
  switch (kind) {
    case "rename": {
      const c = S.chats.get(id);
      const name = prompt(t("renamePrompt"), c ? displayTitle(c) : "");
      if (name) renameChat(id, name);
      break;
    }
    case "pin": togglePin(id); break;
    case "duplicate": duplicateChat(id); break;
    case "archive": toggleArchive(id); break;
    case "move": moveChat(id, value); break;
    case "delete": deleteChat(id); break;
    case "folderRename": renameFolder(id); break;
    case "folderDelete": deleteFolder(id); break;
    case "reopenItem": reopenRecent(id); break;
    case "plus": plusAction(id); break;
    case "addContext": setContext(); break;
    case "feature": toggleFeature(id); break;
    case "skillPick": setChatSkill(id); break;
    case "toggleTool": {
      const on = S.settings.tools[id] !== false;
      S.settings.tools[id] = !on;
      persistSettings();
      renderComposer();
      renderInspector();
      break;
    }
    default: break;
  }
}

function plusAction(id) {
  if (id === "file") $("#file-input").click();
  if (id === "image") $("#image-input").click();
  if (id === "tools") toolMenu($("#plus-btn"));
  if (id === "voice") toggleVoice();
}

/* =========================================================
   Режимы: размышление, функции, код
   ========================================================= */
/** Инструменты, доступные модели прямо сейчас: режимы + отдельные переключатели инструментов. */
function enabledToolNames() {
  const f = S.settings.features;
  // Режим создания скила: модель может только сохранить скил. Режим веб-разработки: инструментов нет.
  if (f.createSkill) return ["create_skill"];
  if (f.webdev) return [];
  if (f.video) return ["render_video"];
  const names = [];
  if (f.functions) names.push("read_file", "list_files", "write_file", "send_file", "show_html");
  if (f.code) names.push("run_code");
  if (f.skills && enabledSkills(S.skills, S.settings.skillsOff).length) names.push("load_skill");
  if (f.memory) names.push("remember");
  return names.filter((n) => S.settings.tools[n] !== false);
}

function toggleFeature(key) {
  const f = S.settings.features;
  const next = !f[key];
  f[key] = next;
  // Режимы «Создать скил» и «Веб-разработка» взаимно исключают друг друга.
  const MODES = ["createSkill", "webdev", "video"];
  if (next && MODES.includes(key)) for (const m of MODES) if (m !== key) f[m] = false;
  persistSettings();
  renderComposer();
  renderInspector();
}

/* =========================================================
   Ввод и отправка
   ========================================================= */
function saveCurrentDraft() {
  const input = $("#composer-input");
  if (!input) return;
  const chat = active();
  if (chat) {
    if (chat.draft !== input.value) {
      chat.draft = input.value;
      saveChatSoon(chat.id, 300);
    }
  } else {
    S.draftNone = input.value;
  }
}

function sendOrStop() {
  const chat = active();
  if (chat && S.streams.has(chat.id)) {
    stopGeneration(chat.id);
    return;
  }
  sendMessage();
}

async function sendMessage() {
  const input = $("#composer-input");
  const text = input.value.trim();
  const key = active() ? active().id : NONE;
  const atts = S.attachments.get(key) || [];
  if (!text && !atts.length) return;

  const target = ensureChat();
  if (S.streams.has(target.id)) return;
  const msg = {
    id: uid(),
    role: "user",
    content: text,
    ts: Date.now(),
    status: "done",
    attachments: atts.map((a) => ({ ...a })),
  };
  target.messages.push(msg);
  target.draft = "";
  target.updatedAt = Date.now();
  S.attachments.delete(target.id);
  S.attachments.delete(NONE);
  input.value = "";
  S.composerFor = target.id;
  autosize(input);
  await saveChat(target.id);
  renderAll();
  generate(target.id);
}

/** Сообщение в формате API. Ответ с вызовами инструментов разворачивается в assistant + tool-сообщения. */
function toApiMessages(m) {
  if (m.role === "assistant" && m.toolCalls?.length && m.toolCalls.some((c) => c.protocol === "text")) {
    // Вызовы в текстовом формате: модель видит свой ответ как есть, результаты — отдельным сообщением.
    const results = m.toolCalls
      .map((c) => `Результат ${c.name}:\n${c.result ?? "Нет результата."}`)
      .join("\n\n");
    return [
      { role: "assistant", content: m.content || " " },
      { role: "user", content: results },
    ];
  }
  if (m.role === "assistant" && m.toolCalls?.length) {
    const out = [{
      role: "assistant",
      content: m.content || "",
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.args || "{}" },
      })),
    }];
    for (const c of m.toolCalls) {
      out.push({ role: "tool", tool_call_id: c.id, content: c.result ?? "Нет результата." });
    }
    return out;
  }
  const files = (m.attachments || []).filter((a) => a.kind === "text");
  const images = (m.attachments || []).filter((a) => a.kind === "image");
  const fileText = files.map((a) => "Файл «" + a.name + "»:\n```\n" + a.text + "\n```").join("\n\n");
  const text = [fileText, m.content].filter(Boolean).join("\n\n");
  if (!images.length) return [{ role: m.role, content: text }];
  return [{
    role: m.role,
    content: [
      { type: "text", text: text || " " },
      ...images.map((i) => ({ type: "image_url", image_url: { url: i.dataUrl } })),
    ],
  }];
}

async function generate(chatId, { continueMsg = null, autoRound = 0 } = {}) {
  const chat = S.chats.get(chatId);
  if (!chat || S.streams.has(chatId)) return;
  if (!S.settings.model) {
    toast(t("noModel"), "error");
    return;
  }

  const f = S.settings.features;
  const webdev = !!f.webdev;
  const toolNames = enabledToolNames();
  const enabled = enabledSkills(S.skills, S.settings.skillsOff);
  const system = [];
  if (f.thinking) system.push({ role: "system", content: t("thinkPrompt") });
  if (webdev) system.push({ role: "system", content: WEBDEV_PROMPT });
  if (f.video) system.push({ role: "system", content: VIDEO_PROMPT });
  if (f.windows && !webdev && !f.video) system.push({ role: "system", content: WINDOW_PROMPT });
  if (f.createSkill) system.push({ role: "system", content: createSkillModePrompt(allSkills(S.skills).map((s) => s.name)) });
  if (f.skills && !webdev && !f.createSkill && enabled.length) system.push({ role: "system", content: skillCatalogPrompt(enabled) });
  // Явный вызов скила «/имя» в последнем сообщении пользователя: полные инструкции сразу.
  const lastUser = [...chat.messages].reverse().find((m) => m.role === "user");
  // Скил, выбранный для чата, применяется всегда; «/имя» в сообщении — разовый вызов.
  const chatSkill = chat.skill ? enabled.find((sk) => sk.name === chat.skill) : null;
  const slash = lastUser && !f.createSkill && !chatSkill ? findSlashSkill(lastUser.content, enabled) : null;
  if (chatSkill) system.push({ role: "system", content: activeSkillPrompt(chatSkill) });
  else if (slash) system.push({ role: "system", content: activeSkillPrompt(slash.skill) });
  if (f.memory && S.memory.length && !webdev) system.push({ role: "system", content: memoryPrompt(S.memory) });
  if (toolNames.length) system.push({ role: "system", content: toolProtocolPrompt(toolNames, TOOL_DESCRIPTIONS) });
  if (chat.context) system.push({ role: "system", content: chat.context });

  let msg = continueMsg;
  let history;
  if (msg) {
    history = chat.messages.slice(0, chat.messages.indexOf(msg) + 1);
  } else {
    msg = { id: uid(), role: "assistant", content: "", ts: Date.now(), status: "streaming", error: null };
    chat.messages.push(msg);
    history = chat.messages.slice(0, -1);
  }
  const budget = Number(S.settings.contextChars) || 48000;
  const { kept: trimmedHistory, dropped } = historyWithinBudget(history, budget);
  S.contextNote = dropped ? { chatId, dropped } : null;
  // В режиме веб-разработки старые версии страницы не отправляем: модели нужна только последняя.
  const lastAssistantIdx = trimmedHistory.map((m) => m.role).lastIndexOf("assistant");
  const historyForApi = trimmedHistory.map((m, i) =>
    windowsMode() && m.role === "assistant" && i !== lastAssistantIdx && m.content ? { ...m, content: elideHtml(m.content) } : m
  );
  const apiMessages = [
    ...system,
    ...historyForApi
      .filter((m) => m.role !== "assistant" || ((m.content || m.toolCalls?.length) && m.status !== "error"))
      .flatMap(toApiMessages),
  ];
  if (continueMsg) apiMessages.push({ role: "user", content: webdev ? CONTINUE_PROMPT : t("continuePrompt") });

  msg.status = "streaming";
  msg.error = null;
  const controller = new AbortController();
  S.streams.set(chatId, controller);
  renderSidebar();
  renderTabs();
  renderComposer();
  if (chatId === S.activeId) updateStreamingMessage(chat, msg);

  // Отрисовка не чаще одного раза за кадр; последний фрагмент всегда попадает на экран (через rAF и finally).
  let paintQueued = false;
  const schedulePaint = () => {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => {
      paintQueued = false;
      updateStreamingMessage(chat, msg);
    });
  };
  // Веб-разработка: без лимита токенов ответа (параметр не передаётся). Продолжение склеивается без повторов.
  const contBase = continueMsg && webdev ? msg.content : null;
  let contText = "";
  let result = { toolCalls: [], finishReason: null };
  let textCalls = [];
  const startedAt = performance.now();
  try {
    result = await streamChat({
      settings: webdev ? { ...S.settings, params: { ...S.settings.params, max_tokens: null } } : S.settings,
      messages: apiMessages,
      toolNames,
      signal: controller.signal,
      onMeta(meta) {
        if (meta.stream === false) toast(t("noStreamNotice"), "error");
      },
      onDelta(delta) {
        if (contBase !== null) {
          contText += delta;
          msg.content = contBase + cleanContinuation(contBase, contText);
        } else {
          msg.content += delta;
        }
        schedulePaint();
        saveChatSoon(chatId, 800);
      },
    });
    if (!result.toolCalls.length && toolNames.length) {
      msg.content = normalizeBareToolCalls(msg.content, toolNames);
      textCalls = parseTextToolCalls(msg.content).map((c) => ({ ...c, id: uid() }));
    }
    if (msg.content.trim() || result.toolCalls.length) {
      msg.status = "done";
    } else {
      msg.status = "error";
      msg.error = t("emptyReply");
    }
  } catch (err) {
    if (err.name === "AbortError") {
      msg.status = "stopped";
    } else {
      msg.status = "error";
      msg.error = err.message || String(err);
      if (toolNames.length && err.code === "upstream") msg.error += " " + t("toolsUnsupported");
    }
  } finally {
    S.streams.delete(chatId);
    if (msg.status === "done" && msg.content) {
      msg.stats = { seconds: (performance.now() - startedAt) / 1000, chars: msg.content.length };
    }
    chat.updatedAt = Date.now();
    await saveChat(chatId);
    refreshChat(chatId);
    renderTopbar();
  }

  // Ответ страницы оборвался по длине: продолжаем тот же ответ автоматически.
  if (webdev && msg.status === "done" && result.finishReason === "length") {
    if (autoRound < MAX_AUTO_CONTINUE) {
      toast(t("webdevContinuing"));
      generate(chatId, { continueMsg: msg, autoRound: autoRound + 1 });
      return;
    }
    toast(t("webdevAutoStop"), "error");
  }

  const native = result.toolCalls.length > 0;
  const calls = native ? result.toolCalls : textCalls;
  if (msg.status === "done" && !continueMsg && calls.length) {
    msg.toolCalls = calls.map((c) => ({
      id: c.id,
      name: c.name,
      args: c.arguments ?? c.args,
      status: "pending",
      result: null,
      protocol: native ? "native" : "text",
    }));
    await saveChat(chatId);
    await processToolCalls(chatId, msg);
  }
}

/* Разбор вызовов инструментов в тексте — в toolparse.js. */

function stopGeneration(chatId) {
  S.streams.get(chatId)?.abort();
}

/* ---------- инструменты ---------- */
/** Инструменты скилов: load_skill отдаёт инструкции, create_skill сохраняет новый скил в браузере. */
function runClientTool(name, args, chatId) {
  if (name === "remember") {
    const fact = cleanFact(args.fact);
    if (!fact) return { ok: false, result: "Пустой факт. Укажите короткую фразу." };
    const before = S.memory.length;
    S.memory = mergeFacts(S.memory, [fact]);
    if (S.memory.length === before) return { ok: true, result: "Этот факт уже известен." };
    persistMemory();
    renderSettings();
    return { ok: true, result: `Запомнено: ${fact}` };
  }
  if (name === "load_skill") {
    const list = enabledSkills(S.skills, S.settings.skillsOff);
    const wanted = String(args.name || "").trim().toLowerCase();
    const skill = list.find((s) => s.name === wanted);
    if (!skill) {
      return { ok: false, result: `Скил «${args.name ?? ""}» не найден. Доступны: ${list.map((s) => s.name).join(", ") || "нет"}.` };
    }
    // Тот же скил в этом диалоге уже загружен: его инструкции есть в истории, повторно не грузим.
    const chat = S.chats.get(chatId);
    const loaded = chat?.messages.some((m) => (m.toolCalls || []).some((c) => c.name === "load_skill" && c.status === "done" && c.result === loadSkillResult(skill)));
    if (loaded) {
      return { ok: true, result: `Скил «${skill.name}» уже загружен в этом диалоге. Продолжай по его инструкциям, которые есть выше.` };
    }
    return { ok: true, result: loadSkillResult(skill) };
  }
  if (name === "create_skill") {
    const res = normalizeSkill(args);
    if (!res.ok) return { ok: false, result: res.error };
    if (allSkills(S.skills).some((s) => s.name === res.skill.name)) {
      return { ok: false, result: `Имя «${res.skill.name}» уже занято. Выберите другое имя.` };
    }
    S.skills.push(res.skill);
    persistSkills();
    renderSettings();
    return {
      ok: true,
      result: `Скил «${res.skill.name}» сохранён. Его можно вызвать командой /${res.skill.name} или включить переключатель «Скилы».`,
    };
  }
  return { ok: false, result: `Инструмент «${name}» не найден.` };
}

/** Аргументы show_html -> данные панели с ограничениями. */
function normalizePanel(a) {
  const h = Math.min(900, Math.max(100, Math.round(Number(a.height)) || 360));
  return { title: String(a.title || "").slice(0, 200), html: String(a.html || "").slice(0, 200000), height: h };
}

async function runCall(chatId, msg, call) {
  call.status = "running";
  refreshChat(chatId);
  let args = null;
  try {
    args = JSON.parse(call.args || "{}");
  } catch (_) {
    args = null;
  }
  if (!args || typeof args !== "object") {
    call.status = "error";
    call.result = "Некорректные аргументы вызова (не JSON-объект).";
  } else {
    try {
      const r = CLIENT_TOOLS.has(call.name) ? runClientTool(call.name, args, chatId) : await runTool(call.name, args, chatId);
      call.status = r.ok ? "done" : "error";
      call.result = r.result;
      call.file = r.file || null;
      if (call.name === "show_html" && r.ok && args) call.panel = normalizePanel(args);
      if (call.name === "render_video" && r.ok && args && typeof args.html === "string") {
        call.panel = normalizePanel({ title: t("videoScene"), html: previewHtml(args.html), height: 360 });
      }
    } catch (err) {
      call.status = "error";
      call.result = err.message || String(err);
    }
  }
  const chat = S.chats.get(chatId);
  if (chat) {
    chat.updatedAt = Date.now();
    saveChatSoon(chatId, 200);
  }
  refreshChat(chatId);
}

/** Выполняет вызовы по порядку. Вызов, требующий подтверждения, останавливает очередь до решения пользователя. */
async function processToolCalls(chatId, msg) {
  for (const call of msg.toolCalls) {
    if (call.status !== "pending") continue;
    if (requiresApproval(call.name)) {
      refreshChat(chatId);
      return;
    }
    await runCall(chatId, msg, call);
  }
  refreshChat(chatId);
  continueAfterTools(chatId);
}

async function approveCall(msgId, index) {
  const chat = active();
  const msg = chat?.messages.find((m) => m.id === msgId);
  const call = msg?.toolCalls?.[index];
  if (!chat || !call || call.status !== "pending") return;
  await runCall(chat.id, msg, call);
  await processToolCalls(chat.id, msg);
}

function denyCall(msgId, index) {
  const chat = active();
  const msg = chat?.messages.find((m) => m.id === msgId);
  const call = msg?.toolCalls?.[index];
  if (!chat || !call || call.status !== "pending") return;
  call.status = "denied";
  call.result = "Пользователь отклонил выполнение этого вызова.";
  saveChat(chat.id);
  processToolCalls(chat.id, msg);
}

/** Все результаты получены — отправляем модели продолжение, если не превышен лимит вызовов. */
function continueAfterTools(chatId) {
  const chat = S.chats.get(chatId);
  if (!chat || S.streams.has(chatId)) return;
  let rounds = 0;
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const m = chat.messages[i];
    if (m.role === "user") break;
    if (m.toolCalls?.length) rounds++;
  }
  if (rounds >= MAX_TOOL_ROUNDS) {
    toast(t("toolLimit"), "error");
    return;
  }
  generate(chatId);
}

/* ---------- прочие действия с сообщениями ---------- */
function regenerate() {
  const chat = active();
  if (!chat || S.streams.has(chat.id)) return;
  const last = chat.messages[chat.messages.length - 1];
  if (!last || last.role !== "assistant") return;
  chat.messages.pop();
  saveChat(chat.id);
  renderAll();
  generate(chat.id);
}

function retryMessage(id) {
  const chat = active();
  if (!chat || S.streams.has(chat.id)) return;
  const idx = chat.messages.findIndex((m) => m.id === id);
  if (idx < 0) return;
  chat.messages.splice(idx);
  saveChat(chat.id);
  renderAll();
  generate(chat.id);
}

function continueMessage(id) {
  const chat = active();
  if (!chat || S.streams.has(chat.id)) return;
  const msg = chat.messages.find((m) => m.id === id);
  if (msg) generate(chat.id, { continueMsg: msg });
}

function startEdit(id) {
  const chat = active();
  if (!chat || S.streams.has(chat.id)) {
    toast(t("stop"));
    return;
  }
  S.editingId = id;
  renderMessages();
  const ta = $("#edit-area");
  if (ta) {
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }
}

function cancelEdit() {
  S.editingId = null;
  renderMessages();
}

function saveEdit(id) {
  const chat = active();
  if (!chat) return;
  const idx = chat.messages.findIndex((m) => m.id === id);
  const ta = $("#edit-area");
  const text = ta ? ta.value.trim() : "";
  if (idx < 0) return;
  if (!text) {
    toast(t("emptyMessage"), "error");
    return;
  }
  if (chat.messages.length - idx - 1 > 0 && !confirm(t("editBranch"))) return;
  chat.messages[idx].content = text;
  chat.messages.splice(idx + 1);
  S.editingId = null;
  chat.updatedAt = Date.now();
  saveChat(chat.id);
  renderAll();
  generate(chat.id);
}

/* =========================================================
   Вложения и голосовой ввод
   ========================================================= */
function readAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file, "utf-8");
  });
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function addFiles(fileList) {
  const key = S.activeId ?? NONE;
  const list = S.attachments.get(key) || [];
  for (const file of Array.from(fileList)) {
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    try {
      if (IMAGE_TYPES.includes(file.type)) {
        if (file.size > MAX_IMAGE_BYTES) {
          toast(t("fileTooBig", file.name), "error");
          continue;
        }
        list.push({ kind: "image", name: file.name, size: file.size, dataUrl: await readAsDataUrl(file) });
      } else if (TEXT_EXT.includes(ext)) {
        if (file.size > MAX_TEXT_FILE_BYTES) {
          toast(t("fileTooBig", file.name), "error");
          continue;
        }
        let text = await readAsText(file);
        if (text.includes("\u0000")) {
          toast(t("fileUnsupported", ext), "error");
          continue;
        }
        if (text.length > MAX_TEXT_CHARS) {
          text = text.slice(0, MAX_TEXT_CHARS);
          toast(t("textTooLong", file.name));
        }
        list.push({ kind: "text", name: file.name, size: file.size, text });
      } else if (ext === "pdf" || ext === "docx") {
        if (file.size > MAX_DOC_BYTES) {
          toast(t("fileTooBig", file.name), "error");
          continue;
        }
        const doc = await extractFile(file);
        list.push({ kind: "text", name: file.name, size: file.size, text: doc.text });
        if (doc.truncated) toast(t("textTooLong", file.name));
      } else {
        toast(t("fileUnsupported", ext || "?"), "error");
      }
    } catch (err) {
      toast(err.message || t("fileRead", file.name), "error");
    }
  }
  S.attachments.set(key, list);
  renderComposer();
}

let recognition = null;
function toggleVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    toast(t("voiceUnsupported"), "error");
    return;
  }
  if (recognition) {
    recognition.stop();
    return;
  }
  recognition = new SR();
  recognition.lang = S.settings.language === "en" ? "en-US" : "ru-RU";
  recognition.interimResults = false;
  recognition.onresult = (e) => {
    const text = Array.from(e.results).map((r) => r[0].transcript).join(" ");
    const input = $("#composer-input");
    input.value = (input.value ? input.value + " " : "") + text;
    autosize(input);
    saveCurrentDraft();
    renderComposer();
  };
  recognition.onerror = () => toast(t("voiceError"), "error");
  recognition.onend = () => {
    recognition = null;
    renderComposer();
  };
  recognition.start();
  toast(t("listening"));
}

/* =========================================================
   Подключение к LM Studio
   ========================================================= */
function setConn(state, message = "") {
  S.conn = { state, message };
  renderTopbar();
  renderInspector();
  if (S.ui.settings && S.ui.settingsTab === "connection") renderSettings();
}

async function checkConnection({ silent = false } = {}) {
  if (!S.settings.baseUrl || !S.settings.baseUrl.trim()) {
    setConn("error", t("connNoUrl"));
    return false;
  }
  setConn("checking", t("connChecking"));
  try {
    S.models = await fetchModels(S.settings);
    if (!S.models.length) {
      setConn("error", t("connNoModels"));
      return false;
    }
    if (!S.models.some((m) => m.id === S.settings.model)) {
      S.settings.model = S.models[0].id;
      persistSettings();
    }
    setConn("ok", t("connOk", S.models.length));
    renderSettings();
    return true;
  } catch (err) {
    S.models = [];
    setConn("error", err.message || String(err));
    if (!silent) toast(err.message, "error");
    return false;
  }
}

/* =========================================================
   Настройки, данные, экспорт и импорт
   ========================================================= */
/** Ключи вида "params.temperature" и "tools.run_code" пишутся во вложенные объекты настроек. */
function setSetting(key, value) {
  const [group, name] = key.split(".");
  if (name !== undefined) S.settings[group][name] = value;
  else S.settings[key] = value;
  persistSettings();
}

function download(name, text, type = "application/json") {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const safeName = (s) => s.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80) || "chat";

function exportAll() {
  const payload = {
    format: "cogniflux",
    version: 1,
    exportedAt: new Date().toISOString(),
    folders: S.folders,
    chats: [...S.chats.values()],
  };
  download(`cogniflux-export-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2));
}

function exportChatMd(id) {
  const c = S.chats.get(id || S.activeId);
  if (!c) return;
  const body = c.messages
    .map((m) => `## ${m.role === "user" ? t("you") : "Cogniflux"} · ${fmtDateTime(m.ts)}\n\n${m.content}`)
    .join("\n\n");
  download(`${safeName(displayTitle(c))}.md`, `# ${displayTitle(c)}\n\n${body}\n`, "text/markdown");
}

function isValidChat(c) {
  return (
    c &&
    typeof c.id === "string" &&
    c.id.length > 0 &&
    c.id.length <= 100 &&
    Array.isArray(c.messages) &&
    c.messages.every(
      (m) =>
        m &&
        ["user", "assistant", "system"].includes(m.role) &&
        typeof m.content === "string" &&
        (m.ts === undefined || typeof m.ts === "number")
    )
  );
}

async function importFile(file) {
  try {
    const data = JSON.parse(await readAsText(file));
    if (!data || data.format !== "cogniflux" || data.version !== 1 || !Array.isArray(data.chats)) {
      throw new Error("bad format");
    }
    const chats = data.chats.filter(isValidChat);
    if (!chats.length && data.chats.length) throw new Error("bad chats");
    for (const f of Array.isArray(data.folders) ? data.folders : []) {
      if (f && typeof f.id === "string" && typeof f.name === "string" && !S.folders.some((x) => x.id === f.id)) {
        S.folders.push({ id: f.id, name: f.name.slice(0, 120), expanded: true });
      }
    }
    for (const raw of chats) {
      const chat = {
        id: CHAT_ID_OK.test(raw.id) ? raw.id : uid(),
        title: typeof raw.title === "string" ? raw.title.slice(0, 200) : "",
        folderId: typeof raw.folderId === "string" ? raw.folderId : null,
        pinned: !!raw.pinned,
        archived: !!raw.archived,
        createdAt: Number(raw.createdAt) || Date.now(),
        updatedAt: Number(raw.updatedAt) || Date.now(),
        messages: raw.messages.map((m) => ({
          id: typeof m.id === "string" ? m.id : uid(),
          role: m.role,
          content: m.content,
          ts: m.ts || Date.now(),
          status: m.status === "streaming" ? "stopped" : m.status || "done",
          attachments: Array.isArray(m.attachments) ? m.attachments.slice(0, 20) : [],
        })),
        draft: "",
        context: typeof raw.context === "string" ? raw.context.slice(0, 20000) : "",
        scrollTop: null,
      };
      S.chats.set(chat.id, chat);
      await saveChat(chat.id);
    }
    persistMeta();
    toast(t("importOk", chats.length));
    renderAll();
  } catch (_) {
    toast(t("importBad"), "error");
  }
}

async function deleteAllData() {
  if (!confirm(t("confirmDeleteAll"))) return;
  try {
    await Store.clearAll();
  } catch (err) {
    toast(err.message, "error");
    return;
  }
  location.reload();
}

/* =========================================================
   Действия и события
   ========================================================= */
function toggleLayoutTarget(which) {
  if (isMobile()) {
    if (which === "sidebar") {
      S.ui.sidebar = !S.ui.sidebar;
      S.ui.inspector = false;
    } else {
      S.ui.inspector = !S.ui.inspector;
      S.ui.sidebar = false;
    }
  } else if (which === "sidebar") {
    S.settings.sidebarCollapsed = !S.settings.sidebarCollapsed;
    persistSettings();
  } else {
    S.settings.inspectorOpen = !S.settings.inspectorOpen;
    persistSettings();
  }
  applyLayout();
}

const actions = {
  newChat: () => newChat(),
  openChat: (el, e) => {
    if (e.target.closest("[data-action='closeTab'],[data-action='chatMenu']")) return;
    openChat(el.dataset.id);
  },
  closeTab: (el) => closeTab(el.dataset.id),
  chatMenu: (el) => chatMenu(el, el.dataset.id),
  folderMenu: (el) => folderMenu(el, el.dataset.id),
  toggleFolder: (el) => toggleFolder(el.dataset.id),
  newFolder: () => createFolder(),
  toggleArchive: () => {
    S.showArchive = !S.showArchive;
    renderSidebar();
  },
  reopenMenu: (el) => reopenMenu(el),
  toggleSidebar: () => toggleLayoutTarget("sidebar"),
  toggleInspector: () => toggleLayoutTarget("inspector"),
  overlayClose: () => {
    S.ui.sidebar = false;
    S.ui.inspector = false;
    applyLayout();
  },
  plusMenu: (el) => plusMenu(el),
  toggleFeature: (el) => toggleFeature(el.dataset.key),
  sendOrStop: () => sendOrStop(),
  copyMsg: (el) => {
    const m = active()?.messages.find((x) => x.id === el.dataset.id);
    if (m) copyText(m.content);
  },
  speakMsg: (el) => speakMessage(el, el.dataset.id),
  jumpBottom: () => {
    const box = $("#messages");
    box?.scrollTo({ top: box.scrollHeight, behavior: "smooth" });
  },
  copyCode: (el) => {
    const code = el.closest(".codeblock")?.querySelector("code");
    if (code) copyText(code.textContent);
  },
  editMsg: (el) => startEdit(el.dataset.id),
  cancelEdit: () => cancelEdit(),
  saveEdit: (el) => saveEdit(el.dataset.id),
  regen: () => regenerate(),
  retry: (el) => retryMessage(el.dataset.id),
  continueMsg: (el) => continueMessage(el.dataset.id),
  toolApprove: (el) => approveCall(el.dataset.id, Number(el.dataset.index)),
  toolDeny: (el) => denyCall(el.dataset.id, Number(el.dataset.index)),
  example: (el) => {
    const input = $("#composer-input");
    input.value = el.dataset.prompt;
    S.composerFor = active()?.id ?? NONE;
    autosize(input);
    saveCurrentDraft();
    renderComposer();
    input.focus();
  },
  removeAtt: (el) => {
    const key = S.activeId ?? NONE;
    const list = S.attachments.get(key) || [];
    list.splice(Number(el.dataset.index), 1);
    S.attachments.set(key, list);
    renderComposer();
  },
  setContext: () => setContext(),
  openSettings: (el) => openSettings(el?.dataset?.tab),
  closeSettings: () => closeSettings(),
  settingsTab: (el) => {
    S.ui.settingsTab = el.dataset.tab;
    renderSettings();
  },
  toggleKey: () => {
    const input = $("#api-key-input");
    if (!input) return;
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    $("#key-toggle-label").textContent = show ? t("hide") : t("show");
  },
  checkConn: () => checkConnection(),
  exportAll: () => exportAll(),
  importAll: () => $("#import-input").click(),
  deleteAll: () => deleteAllData(),
  exportChat: () => exportChatMd(S.activeId),
  featuresMenu: (el) => featuresMenu(el),
  memoryDelete: (el) => {
    S.memory = S.memory.filter((f) => f.id !== el.dataset.id);
    persistMemory();
    renderSettings();
  },
  memoryClear: () => {
    if (!S.memory.length || !confirm(t("confirmClearMemory"))) return;
    S.memory = [];
    persistMemory();
    renderSettings();
  },
  memoryScan: () => scanMemory(),
  webdevDownload: (el) => {
    const m = active()?.messages.find((x) => x.id === el.dataset.id);
    const blocks = m ? findHtmlBlocks(stripToolBlocks(m.content || "")) : [];
    const block = blocks[Number(el.dataset.index) || 0];
    if (!block) return;
    download(suggestFileName(block.html), block.html, "text/html");
  },
  windowExpand: (el) => {
    el.closest(".webdev-card")?.classList.toggle("expanded");
  },
  skillToggle: (el) => {
    S.settings.skillsOff = S.settings.skillsOff || {};
    if (el.checked) delete S.settings.skillsOff[el.dataset.name];
    else S.settings.skillsOff[el.dataset.name] = true;
    persistSettings();
    renderInspector();
  },
  skillDelete: (el) => {
    const skill = S.skills.find((s) => s.name === el.dataset.name);
    if (!skill || !confirm(t("confirmDeleteSkill", skill.name))) return;
    S.skills = S.skills.filter((s) => s.name !== skill.name);
    persistSkills();
    renderSettings();
  },
  skillExport: (el) => {
    const skill = allSkills(S.skills).find((s) => s.name === el.dataset.name);
    if (skill) download(`${skill.name}.md`, skillToMd(skill), "text/markdown");
  },
  clearChat: () => {
    const c = active();
    if (!c || !confirm(t("confirmClear"))) return;
    if (S.streams.has(c.id)) stopGeneration(c.id);
    c.messages = [];
    c.draft = "";
    saveChat(c.id);
    renderAll();
  },
};

let speaking = null;
function speakMessage(el, id) {
  if (!("speechSynthesis" in window)) {
    toast(t("speakUnsupported"), "error");
    return;
  }
  const synth = window.speechSynthesis;
  if (speaking === id) {
    synth.cancel();
    speaking = null;
    refreshChat(S.activeId);
    return;
  }
  const m = active()?.messages.find((x) => x.id === id);
  if (!m) return;
  // Убираем разметку и код: озвучиваем только текст.
  const text = stripToolBlocks(m.content || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_#>|~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = S.settings.language === "en" ? "en-US" : "ru-RU";
  u.onend = u.onerror = () => {
    if (speaking === id) speaking = null;
    refreshChat(S.activeId);
  };
  speaking = id;
  synth.speak(u);
  refreshChat(S.activeId);
}

function copyText(text) {
  if (!navigator.clipboard) {
    toast(t("copyFailed"), "error");
    return;
  }
  navigator.clipboard.writeText(text).then(
    () => toast(t("copied")),
    () => toast(t("copyFailed"), "error")
  );
}

function bindEvents() {
  document.addEventListener("click", (e) => {
    const menuItem = e.target.closest("[data-menu-kind]");
    if (menuItem && !menuItem.disabled) {
      const handler = menuHandler;
      const { menuKind, menuId, menuValue } = menuItem.dataset;
      closeMenu();
      handler?.(menuKind, menuId, menuValue);
      return;
    }
    if (!e.target.closest("#menu-root")) closeMenu();

    const el = e.target.closest("[data-action]");
    if (!el) return;
    const handler = actions[el.dataset.action];
    if (handler) handler(el, e);
  });

  document.addEventListener("input", (e) => {
    const el = e.target;
    if (el.id === "search") {
      S.search = el.value;
      renderSidebar();
      return;
    }
    if (el.id === "composer-input") {
      autosize(el);
      saveCurrentDraft();
      renderComposer();
      return;
    }
    if (el.dataset && el.dataset.setting) {
      const v = readField(el);
      setSetting(el.dataset.setting, v);
      const out = el.parentElement?.querySelector("output");
      if (out) out.textContent = v;
      if (["theme", "fontSize", "messageWidth"].includes(el.dataset.setting)) applySettings();
    }
  });

  document.addEventListener("change", (e) => {
    const el = e.target;
    if (el.id === "chat-title-input") {
      renameChat(S.activeId, el.value);
      return;
    }
    if (el.id === "file-input" || el.id === "image-input") {
      if (el.files && el.files.length) addFiles(el.files);
      el.value = "";
      return;
    }
    if (el.id === "import-input") {
      if (el.files && el.files[0]) importFile(el.files[0]);
      el.value = "";
      return;
    }
    if (el.dataset && el.dataset.setting) {
      const key = el.dataset.setting;
      setSetting(key, readField(el));
      if (key === "language") renderAll();
      else if (key === "baseUrl") setConn("unknown", "");
      else if (key === "model") renderAll();
      else if (key === "sidebarSide" || key === "enterSends" || key === "autoScroll") applySettings();
      else renderSettings();
      applySettings();
    }
  });

  document.addEventListener("keydown", (e) => {
    const target = e.target;
    if (target.id === "composer-input" && e.key === "Enter" && !e.isComposing) {
      const send = S.settings.enterSends ? !e.shiftKey : e.ctrlKey || e.metaKey;
      if (send) {
        e.preventDefault();
        sendMessage(); // Enter не останавливает генерацию; остановка — только кнопкой
      }
      return;
    }
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && document.querySelector("#menu-root .menu")) {
      const items = [...document.querySelectorAll("#menu-root .menu-item:not([disabled])")];
      if (items.length) {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        const i = items.indexOf(document.activeElement);
        const next = i < 0 ? (step > 0 ? 0 : items.length - 1) : (i + step + items.length) % items.length;
        items[next].focus();
      }
      return;
    }
    if (e.key === "Escape") {
      if (S.ui.settings) return closeSettings();
      closeMenu();
      if (S.ui.sidebar || S.ui.inspector) {
        S.ui.sidebar = false;
        S.ui.inspector = false;
        applyLayout();
      }
      return;
    }
    if (e.key === "Enter" && target.matches?.("[data-action='openChat']")) {
      target.click();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === "/") {
      e.preventDefault();
      openSettings("hotkeys");
    }
    if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (isMobile()) {
        S.ui.sidebar = true;
        applyLayout();
      }
      $("#search")?.focus();
    }
    if (e.altKey && !mod && e.key.toLowerCase() === "n") {
      e.preventDefault();
      newChat();
    }
    if (e.altKey && !mod && e.key.toLowerCase() === "w" && S.activeId) {
      e.preventDefault();
      closeTab(S.activeId);
    }
  });

  const main = $("#main");
  let dragDepth = 0;
  main.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    dragDepth++;
    main.classList.add("dragging");
    main.dataset.drop = t("dropHint");
  });
  main.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) main.classList.remove("dragging");
  });
  main.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  });
  main.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    main.classList.remove("dragging");
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });

  $("#composer-input").addEventListener("paste", (e) => {
    const files = Array.from(e.clipboardData?.files || []);
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });

  $("#messages").addEventListener("scroll", (e) => {
    const far = e.target.scrollHeight - e.target.scrollTop - e.target.clientHeight > 260;
    $("#jump-btn")?.toggleAttribute("hidden", !far);
    const c = active();
    if (!c || !e.target.querySelector(".msg-list")) return;
    c.scrollTop = e.target.scrollTop;
    saveChatSoon(c.id, 1000);
  }, { passive: true });

  window.addEventListener("resize", () => applyLayout());
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    if (S.settings.theme === "system") applySettings();
  });
  window.addEventListener("beforeunload", () => saveCurrentDraft());
}

/* =========================================================
   Markdown, блоки «размышления» и подсветка кода
   ========================================================= */
const SANITIZE = { ADD_TAGS: ["details", "summary"], ADD_ATTR: ["open"] };

function renderPlain(src) {
  // Без CDN-библиотек текст показываем экранированным, окна при этом работают.
  if (!window.marked || !window.DOMPurify) return `<p>${esc(src)}</p>`;
  return window.DOMPurify.sanitize(window.marked.parse(src || "", { gfm: true, breaks: true }), SANITIZE);
}

/** Отделяет содержимое <think>…</think>. Незакрытый тег во время потока считается открытым. */
function splitThink(src) {
  const m = src.match(/<think>([\s\S]*?)(<\/think>|$)/);
  if (!m) return { think: null, text: src, open: false };
  const closed = m[2] === "</think>";
  const text = (src.slice(0, m.index) + src.slice(m.index + m[0].length)).trim();
  return { think: m[1].trim(), text, open: !closed };
}

function windowsMode() {
  return !!(S.settings.features.webdev || S.settings.features.windows);
}

/** Части ответа по порядку: обычный текст и HTML-окна. */
function bodyParts(m) {
  return splitByHtml(stripToolBlocks(m.content || ""));
}

/** Один текстовый кусок: markdown и блок «размышления». */
function renderTextPart(src) {
  const { think, text, open } = splitThink(src);
  let html = "";
  if (think !== null) {
    html += `<details class="think"${open ? " open" : ""}><summary>${esc(t("reasoning"))}</summary>
      <div class="think-body">${think ? renderPlain(think) : ""}</div></details>`;
  }
  return html + renderPlain(text);
}

function structureHtml(msgId, parts) {
  return parts
    .map((p, i) => (p.type === "text"
      ? `<div class="seg">${renderTextPart(p.text)}</div>`
      : `<div class="seg win" data-win="${msgId}:${i}"></div>`))
    .join("");
}

function renderMarkdown(src, msgId = "") {
  if (windowsMode()) return structureHtml(msgId, splitByHtml(stripToolBlocks(src)));
  return renderTextPart(stripToolBlocks(src));
}

/**
 * Обновляет тело ответа. Если структура (текст и окна) не изменилась, меняются только текстовые куски,
 * а окна остаются на месте: иначе iframe перезагружался бы на каждом кадре.
 */
function fillBody(m, body) {
  if (!windowsMode()) {
    body.innerHTML = m.content ? renderMarkdown(m.content) : "";
    enhanceCode(body);
    return;
  }
  const parts = bodyParts(m);
  const kids = [...body.children];
  const same = kids.length === parts.length
    && parts.every((p, i) => kids[i].classList.contains("win") === (p.type === "html"));
  if (!same) {
    body.innerHTML = structureHtml(m.id, parts);
  } else {
    parts.forEach((p, i) => {
      if (p.type === "text") kids[i].innerHTML = renderTextPart(p.text);
    });
  }
  body.querySelectorAll(".seg:not(.win)").forEach((seg) => enhanceCode(seg));
}

/* ---------- окна с HTML ---------- */
const winTimers = new Map();
const winStamp = new Map();
const winLast = new Map();
const WINDOW_THROTTLE_MS = 350;

function windowTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return (m ? m[1].trim() : "") || t("windowTitle");
}

function windowSkeleton(msgId, index) {
  return `
    <div class="webdev-card">
      <div class="webdev-head">
        <span class="webdev-title">${icon("file")}<span data-wd="title"></span></span>
        <span class="webdev-meta" data-wd="meta"></span>
        <button class="icon-btn small" data-action="windowExpand" aria-label="${esc(t("windowExpand"))}" title="${esc(t("windowExpand"))}">${icon("panel")}</button>
        <button class="btn-ghost small" data-action="webdevDownload" data-id="${msgId}" data-index="${index}">${icon("download")}<span>${esc(t("webdevDownload"))}</span></button>
      </div>
      <iframe class="webdev-frame" sandbox="allow-scripts" title="${esc(t("windowTitle"))}" data-wd="frame"></iframe>
      <details class="wd-code"><summary>${esc(t("webdevCode"))}</summary><pre><code data-wd="code"></code></pre></details>
    </div>`;
}

/** Обновляет одно окно: srcdoc меняется только если код изменился. */
function updateWindowCard(el, msgId, index, block, streaming) {
  const key = `${msgId}:${index}`;
  if (!el.querySelector("iframe")) {
    el.innerHTML = windowSkeleton(msgId, index);
    winLast.delete(key);
  }
  if (winLast.get(key) !== block.html) {
    winLast.set(key, block.html);
    el.querySelector('[data-wd="frame"]').srcdoc = injectCsp(block.html);
    el.querySelector('[data-wd="title"]').textContent = windowTitle(block.html);
    el.querySelector('[data-wd="code"]').textContent = block.html;
  }
  const state = streaming ? t("webdevWriting") : block.complete ? t("webdevDone") : t("webdevCut");
  el.querySelector('[data-wd="meta"]').textContent = `${htmlStats(block.html).lines} ${t("webdevLines")} · ${state}`;
  const card = el.querySelector(".webdev-card");
  card.classList.toggle("is-writing", streaming);
  // В обычном чате окно маленькое (для демонстрации) и вписывается в выбранный модели формат; в веб-разработке — большой предпросмотр.
  const compact = !S.settings.features.webdev;
  card.classList.toggle("win-compact", compact);
  const frame = el.querySelector('[data-wd="frame"]');
  if (compact) {
    const box = fitBox(block.aspect || { w: 16, h: 9 }, WINDOW_MAX_PX);
    card.style.width = `${box.w}px`;
    frame.style.width = `${box.w}px`;
    frame.style.height = `${box.h}px`;
  } else {
    card.style.width = "";
    frame.style.width = "";
    frame.style.height = "";
  }
}

const WINDOW_MAX_PX = 480;
/** Размер окна с сохранением пропорций: большая сторона — не больше max. */
function fitBox({ w, h }, max) {
  if (w >= h) return { w: max, h: Math.round((max * h) / w) };
  return { w: Math.round((max * w) / h), h: max };
}

/** Обновляет все окна сообщения. Во время потока — не чаще WINDOW_THROTTLE_MS; последний кадр догоняет таймер. */
function syncWindows(m, { final = false } = {}) {
  const streaming = m.status === "streaming" && !final;
  const now = Date.now();
  const last = winStamp.get(m.id) || 0;
  if (streaming && now - last < WINDOW_THROTTLE_MS) {
    if (!winTimers.has(m.id)) {
      winTimers.set(m.id, setTimeout(() => {
        winTimers.delete(m.id);
        syncWindows(m);
      }, WINDOW_THROTTLE_MS - (now - last)));
    }
    return;
  }
  clearTimeout(winTimers.get(m.id));
  winTimers.delete(m.id);
  winStamp.set(m.id, now);
  const body = document.querySelector(`[data-msg-body="${m.id}"]`);
  if (!body) return;
  bodyParts(m).forEach((p, i) => {
    if (p.type !== "html") return;
    const el = body.querySelector(`[data-win="${m.id}:${i}"]`);
    if (el) updateWindowCard(el, m.id, p.index, p.block, streaming);
  });
}

function enhanceCode(root) {
  root.querySelectorAll("pre").forEach((pre) => {
    if (pre.parentElement?.classList.contains("codeblock")) return;
    const code = pre.querySelector("code");
    if (code && window.hljs && !code.dataset.hl) {
      try {
        window.hljs.highlightElement(code);
      } catch (_) {
        // подсветка необязательна
      }
      code.dataset.hl = "1";
    }
    const m = code && code.className.match(/language-([\w+#.-]+)/);
    const lang = m ? m[1] : "text";
    const wrap = document.createElement("div");
    wrap.className = "codeblock";
    wrap.innerHTML = `<div class="codeblock-head"><span>${esc(lang)}</span>
      <button class="copy-btn" data-action="copyCode">${icon("copy")}<span>${t("copy")}</span></button></div>`;
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);
  });
  root.querySelectorAll("table").forEach((table) => {
    if (table.parentElement?.classList.contains("table-wrap")) return;
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    table.parentNode.insertBefore(wrap, table);
    wrap.appendChild(table);
  });
}

/* =========================================================
   Форматирование и уведомления
   ========================================================= */
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString(S.settings.language === "en" ? "en-GB" : "ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString(S.settings.language === "en" ? "en-GB" : "ru-RU");
}

function fmtDateTime(ts) {
  return `${fmtDate(ts)} ${fmtTime(ts)}`;
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function toast(message, kind = "info") {
  const root = $("#toast-root");
  const el = document.createElement("div");
  el.className = `toast ${kind === "error" ? "error" : ""}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), kind === "error" ? 5000 : 2800);
}

function readField(el) {
  if (el.type === "checkbox") return el.checked;
  if (el.type === "range" || el.type === "number") {
    if (el.value === "") return null;
    const n = Number(el.value);
    return Number.isFinite(n) ? n : null;
  }
  return el.value;
}

/* =========================================================
   Запуск
   ========================================================= */
async function init() {
  buildShell();
  try {
    await loadState();
  } catch (err) {
    console.error(err);
    toast(`${t("networkLost")} ${err.message || ""}`.trim(), "error");
  }

  if (window.DOMPurify) {
    window.DOMPurify.addHook("afterSanitizeAttributes", (node) => {
      if (node.tagName === "A") {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      }
    });
  }

  try {
    const cfg = await (await fetch("/api/config")).json();
    S.workspace = cfg.workspace || "";
    if (!S.settings.baseUrl) {
      S.settings.baseUrl = cfg.default_base_url;
      persistSettings();
    }
  } catch (_) {
    if (!S.settings.baseUrl) S.settings.baseUrl = "http://localhost:1234/v1";
  }

  applySettings();
  bindEvents();
  renderAll();
  persistMeta();
  checkConnection({ silent: true });
}

init();
