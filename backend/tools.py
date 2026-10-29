"""Инструменты, которые может вызывать модель.

* У каждого чата своя рабочая папка: workspace/<id чата>/. Относительные пути считаются от неё,
  выйти за её пределы нельзя. Папка создаётся при первом обращении.
* Файлы: чтение, список и запись. Инструмент send_file готовит файл из папки чата к скачиванию.
* Код: python, javascript (Node.js) и bash запускаются отдельным процессом в папке чата
  с ограничением времени, размера файлов и (для Python) памяти.

Подтверждения пользователя не требуются: все инструменты выполняются сразу.
Это не полноценная песочница: процесс работает под вашим пользователем и видит ваши файлы
за пределами рабочих папок, если знает пути. Не запускайте то, что вы не готовы выполнить.
"""

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
WORKSPACE = BASE_DIR / "workspace"
WORKSPACE.mkdir(exist_ok=True)

MAX_OUTPUT_CHARS = 12000
MAX_FILE_BYTES = 1024 * 1024
MAX_SEND_BYTES = 50 * 1024 * 1024
MAX_CODE_CHARS = 100000
MAX_LIST_ITEMS = 500
RUN_TIMEOUT_S = 20
MEMORY_LIMIT_BYTES = 1024 ** 3
FILE_SIZE_LIMIT_BYTES = 50 * 1024 * 1024

CHAT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,100}$")


class ToolError(Exception):
    """Ошибка, которую стоит показать и пользователю, и модели."""


TOOL_CATEGORIES = {
    "files": "Работа с файлами и директориями (чтение, запись, просмотр, скачивание)",
    "execution": "Выполнение кода и скриптов (Python, JavaScript, Bash)",
    "visualization": "Визуализация и медиа (HTML-панели, рендер видео)",
    "skills": "Управление навыками (скилами) и базой знаний",
    "memory": "Запоминание информации о пользователе",
}

TOOL_SPECS = {
    "read_file": {
        "category": "files",
        "description": "Прочитать текстовый файл из рабочей папки этого чата.",
        "parameters": {
            "type": "object",
            "properties": {"path": {"type": "string", "description": "Путь относительно рабочей папки чата"}},
            "required": ["path"],
        },
        "approval": False,
    },
    "list_files": {
        "category": "files",
        "description": "Показать файлы и папки в рабочей папке этого чата.",
        "parameters": {
            "type": "object",
            "properties": {"path": {"type": "string", "description": "Папка относительно рабочей папки, по умолчанию корень"}},
        },
        "approval": False,
    },
    "write_file": {
        "category": "files",
        "description": "Записать текстовый файл в рабочую папку этого чата. Существующий файл будет перезаписан.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Путь относительно рабочей папки чата"},
                "content": {"type": "string", "description": "Полное содержимое файла"},
            },
            "required": ["path", "content"],
        },
        "approval": False,
    },
    "send_file": {
        "category": "files",
        "description": "Отправить пользователю файл из рабочей папки чата, чтобы он мог его скачать.",
        "parameters": {
            "type": "object",
            "properties": {"path": {"type": "string", "description": "Путь к файлу относительно рабочей папки чата"}},
            "required": ["path"],
        },
        "approval": False,
    },
    "run_code": {
        "category": "execution",
        "description": "Выполнить код в рабочей папке чата. Языки: python, javascript (Node.js), bash. Время выполнения ограничено.",
        "parameters": {
            "type": "object",
            "properties": {
                "language": {"type": "string", "enum": ["python", "javascript", "bash"]},
                "code": {"type": "string", "description": "Исходный код для выполнения"},
            },
            "required": ["language", "code"],
        },
        "approval": False,
    },
    "show_html": {
        "category": "visualization",
        "description": (
            "Показать в ответе HTML-панель: HTML, CSS и JavaScript (например дерево, схему, график, рисунок, интерфейс). "
            "Панель работает в изолированном фрейме и не имеет доступа к приложению. Аргументы: title (необязательно), "
            "html (полный HTML-документ или фрагмент), height (в пикселях, от 100 до 900, по умолчанию 360)."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Заголовок панели"},
                "html": {"type": "string", "description": "HTML-код панели"},
                "height": {"type": "integer", "description": "Высота в пикселях"},
            },
            "required": ["html"],
        },
        "approval": False,
    },
    "load_skill": {
        "category": "skills",
        "description": (
            "Загрузить инструкции скила по его имени. Вызывай, когда задача подходит под описание одного из скилов "
            "из системного промпта. Аргумент name — имя скила."
        ),
        "parameters": {
            "type": "object",
            "properties": {"name": {"type": "string", "description": "Имя скила, например code-review"}},
            "required": ["name"],
        },
        "approval": False,
    },
    "create_skill": {
        "category": "skills",
        "description": (
            "Сохранить новый скил: многоразовую инструкцию для будущих задач. Аргументы: name (латиницей, "
            "через дефис), description (что делает и когда применять), instructions (полный текст инструкций)."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Имя латиницей, например meeting-notes"},
                "description": {"type": "string", "description": "Что делает скил и когда его применять"},
                "instructions": {"type": "string", "description": "Полный текст инструкций в Markdown"},
            },
            "required": ["name", "description", "instructions"],
        },
        "approval": False,
    },
    "render_video": {
        "category": "visualization",
        "description": (
            "Отрендерить видео из HTML-сцены. Сцена — один HTML-документ с глобальной константой DURATION (секунды) "
            "и функцией renderFrame(t), которая рисует кадр в момент t и не использует реальное время. "
            "Аргументы: html (сцена целиком), name (латиницей), duration, fps, width, height."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "html": {"type": "string", "description": "HTML-сцена целиком"},
                "name": {"type": "string", "description": "Имя файла латиницей, например intro"},
                "duration": {"type": "number", "description": "Длительность в секундах, 0.5–30"},
                "fps": {"type": "integer", "description": "Кадров в секунду, 5–60, по умолчанию 30"},
                "width": {"type": "integer", "description": "Ширина, 320–1920, по умолчанию 1280"},
                "height": {"type": "integer", "description": "Высота, 240–1080, по умолчанию 720"},
            },
            "required": ["html"],
        },
        "approval": False,
    },
    "remember": {
        "category": "memory",
        "description": (
            "Запомнить устойчивый факт о пользователе (имя, профессия, интересы, предпочтения). "
            "Вызывай только для фактов, которые пользователь сообщил о себе сам. Аргумент fact — короткая фраза."
        ),
        "parameters": {
            "type": "object",
            "properties": {"fact": {"type": "string", "description": "Короткая фраза, например «Работает инженером-геологом»"}},
            "required": ["fact"],
        },
        "approval": False,
    },
}


def get_tools_by_category(category=None):
    """Возвращает словари инструментов, сгруппированные по категориям или отфильтрованные по выбранной категории."""
    if category:
        if category not in TOOL_CATEGORIES:
            raise ToolError(f"Неизвестная категория: {category}. Доступные: {list(TOOL_CATEGORIES.keys())}")
        return {name: spec for name, spec in TOOL_SPECS.items() if spec.get("category") == category}

    result = {}
    for cat_id, cat_name in TOOL_CATEGORIES.items():
        result[cat_id] = {
            "title": cat_name,
            "tools": {name: spec for name, spec in TOOL_SPECS.items() if spec.get("category") == cat_id},
        }
    return result


def list_modes():
    """Возвращает список доступных категорий/режимов работы с их описаниями."""
    return [
        {"id": cat_id, "description": cat_desc, "tools_count": len([s for s in TOOL_SPECS.values() if s.get("category") == cat_id])}
        for cat_id, cat_desc in TOOL_CATEGORIES.items()
    ]


def requires_approval(name):
    spec = TOOL_SPECS.get(name)
    return True if spec is None else spec["approval"]


def tool_schemas(names):
    """Определения инструментов в формате OpenAI tools. Только зарегистрированные имена."""
    return [
        {
            "type": "function",
            "function": {
                "name": name,
                "description": TOOL_SPECS[name]["description"],
                "parameters": TOOL_SPECS[name]["parameters"],
            },
        }
        for name in names
        if name in TOOL_SPECS
    ]


def chat_dir(chat_id, create=True):
    """Рабочая папка чата: workspace/<chat_id>. Идентификатор проверяется, чтобы не выйти из workspace."""
    if not isinstance(chat_id, str) or not CHAT_ID_RE.match(chat_id):
        raise ToolError("Не определён чат для рабочей папки.")
    path = WORKSPACE / chat_id
    if create:
        path.mkdir(exist_ok=True)
    return path


def _safe_path(root, rel):
    if not isinstance(rel, str) or not rel.strip():
        raise ToolError("Не указан путь к файлу.")
    target = (root / rel).resolve()
    root_resolved = root.resolve()
    if target != root_resolved and root_resolved not in target.parents:
        raise ToolError("Путь выходит за пределы рабочей папки чата.")
    return target


def _read_file(args, root):
    path = _safe_path(root, args.get("path"))
    if not path.is_file():
        raise ToolError("Файл не найден.")
    raw = path.read_bytes()[:MAX_FILE_BYTES]
    if b"\x00" in raw:
        raise ToolError("Файл не является текстовым.")
    return raw.decode("utf-8", errors="replace")[:MAX_OUTPUT_CHARS], None


def _list_files(args, root):
    folder = _safe_path(root, args.get("path") or ".")
    if not folder.is_dir():
        raise ToolError("Папка не найдена.")
    items = sorted(folder.iterdir())[:MAX_LIST_ITEMS]
    lines = []
    for item in items:
        rel = item.relative_to(root.resolve()).as_posix()
        lines.append(f"[папка] {rel}" if item.is_dir() else rel)
    return "\n".join(lines) or "Папка пуста.", None


def _write_file(args, root):
    path = _safe_path(root, args.get("path"))
    content = args.get("content")
    if not isinstance(content, str):
        raise ToolError("Содержимое файла должно быть строкой.")
    if len(content.encode("utf-8")) > MAX_FILE_BYTES:
        raise ToolError("Файл слишком большой (лимит 1 МБ).")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    rel = path.relative_to(root.resolve()).as_posix()
    return f"Записано: {rel} ({len(content)} симв.)", None


def _send_file(args, root):
    path = _safe_path(root, args.get("path"))
    if not path.is_file():
        raise ToolError("Файл не найден. Проверьте путь через list_files.")
    size = path.stat().st_size
    if size > MAX_SEND_BYTES:
        raise ToolError("Файл слишком большой для отправки (лимит 50 МБ).")
    rel = path.relative_to(root.resolve()).as_posix()
    return f"Файл «{rel}» готов к скачиванию ({size} байт).", {"path": rel, "size": size}


MAX_HTML_CHARS = 200000


def _show_html(args, root):
    html = args.get("html")
    if not isinstance(html, str) or not html.strip():
        raise ToolError("Нет HTML-кода для панели.")
    if len(html) > MAX_HTML_CHARS:
        raise ToolError("HTML-панель слишком большая (лимит 200 000 символов).")
    return "Панель показана пользователю.", None


def _python_loader():
    """Код Python читается из stdin и выполняется с лимитами внутри процесса.

    Так не нужен preexec_fn (он небезопасен в многопоточном сервере) и сохраняются номера строк в ошибках.
    """
    limit_cpu = RUN_TIMEOUT_S + 5
    return (
        "import sys\n"
        "try:\n"
        "    import resource as _r\n"
        f"    _r.setrlimit(_r.RLIMIT_CPU, ({limit_cpu}, {limit_cpu}))\n"
        f"    _r.setrlimit(_r.RLIMIT_FSIZE, ({FILE_SIZE_LIMIT_BYTES}, {FILE_SIZE_LIMIT_BYTES}))\n"
        f"    _r.setrlimit(_r.RLIMIT_AS, ({MEMORY_LIMIT_BYTES}, {MEMORY_LIMIT_BYTES}))\n"
        "except (ImportError, ValueError, OSError):\n"
        "    pass\n"
        "_src = sys.stdin.read()\n"
        "exec(compile(_src, '<code>', 'exec'), {'__name__': '__main__'})\n"
    )


def _kill_tree(proc):
    """Останавливает процесс вместе с его дочерними процессами (POSIX: вся группа)."""
    try:
        if os.name == "posix":
            os.killpg(proc.pid, signal.SIGKILL)
        else:
            proc.kill()
    except (ProcessLookupError, PermissionError, OSError):
        pass


def _run_code(args, root):
    language = args.get("language")
    code = args.get("code")
    if language not in ("python", "javascript", "bash"):
        raise ToolError("Неизвестный язык. Доступны: python, javascript, bash.")
    if not isinstance(code, str) or not code.strip():
        raise ToolError("Код пустой.")
    if len(code) > MAX_CODE_CHARS:
        raise ToolError("Код слишком длинный.")

    stdin_data = None
    if language == "python":
        cmd = [sys.executable, "-I", "-c", _python_loader()]
        stdin_data = code
    elif language == "javascript":
        node = shutil.which("node")
        if not node:
            raise ToolError("Node.js не найден. Установите Node.js, чтобы выполнять JavaScript.")
        cmd = [node, "--max-old-space-size=512", "-e", code]
    else:
        bash = shutil.which("bash")
        if not bash:
            raise ToolError("bash не найден. В Windows используйте Git Bash или WSL.")
        # ulimit задаёт ограничения времени процессора и размера файлов для всей оболочки.
        prelude = f"ulimit -t {RUN_TIMEOUT_S + 5} 2>/dev/null; ulimit -f {FILE_SIZE_LIMIT_BYTES // 1024} 2>/dev/null\n"
        cmd = [bash, "-c", prelude + code]

    start = time.monotonic()
    proc = subprocess.Popen(
        cmd,
        cwd=root,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        start_new_session=(os.name == "posix"),
    )
    try:
        out, err = proc.communicate(input=stdin_data, timeout=RUN_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        _kill_tree(proc)
        proc.communicate()
        raise ToolError(f"Выполнение остановлено: превышено {RUN_TIMEOUT_S} с.")
    elapsed = time.monotonic() - start
    out = (out or "")[:MAX_OUTPUT_CHARS]
    err = (err or "")[:MAX_OUTPUT_CHARS]
    text = f"Код завершён с кодом {proc.returncode} за {elapsed:.2f} с.\n--- stdout ---\n{out}\n--- stderr ---\n{err}"
    return text, None


def delete_chat_folder(chat_id):
    """Удаляет рабочую папку чата целиком. Возвращает True, если папка существовала."""
    root = chat_dir(chat_id, create=False)
    if root.is_dir():
        shutil.rmtree(root)
        return True
    return False


RENDER_SCRIPT = BASE_DIR / "backend" / "render_scene.py"
RENDER_TIMEOUT_S = 300
MAX_RENDER_FRAMES = 900
VIDEO_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,60}$")


def _number_arg(args, key, default, low, high, integer=False):
    value = args.get(key, default)
    if value is None:
        value = default
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not (low <= value <= high):
        raise ToolError(f"Параметр «{key}» должен быть числом от {low} до {high}.")
    return int(value) if integer else float(value)


def _render_video(args, root):
    """Сохраняет сцену в папку чата и рендерит её в MP4 отдельным процессом (Playwright + ffmpeg)."""
    html = args.get("html")
    if not isinstance(html, str) or not html.strip():
        raise ToolError("Нет HTML-сцены для рендера.")
    if len(html) > MAX_HTML_CHARS:
        raise ToolError("HTML-сцена слишком большая (лимит 200 000 символов).")
    name = args.get("name") or "video"
    if not isinstance(name, str) or not VIDEO_NAME_RE.match(name):
        raise ToolError("Имя видео: латинские буквы, цифры, дефис или подчёркивание, до 60 знаков.")
    width = _number_arg(args, "width", 1280, 320, 1920, integer=True)
    height = _number_arg(args, "height", 720, 240, 1080, integer=True)
    fps = _number_arg(args, "fps", 30, 5, 60, integer=True)
    duration = _number_arg(args, "duration", 4, 0.5, 30)
    if round(duration * fps) > MAX_RENDER_FRAMES:
        raise ToolError(f"Слишком много кадров (лимит {MAX_RENDER_FRAMES}). Уменьшите длительность или fps.")

    scene = root / f"{name}.html"
    scene.write_text(html, encoding="utf-8")
    out = root / f"{name}.mp4"
    params = json.dumps({"width": width, "height": height, "fps": fps, "duration": duration})
    try:
        proc = subprocess.run(
            [sys.executable, "-I", str(RENDER_SCRIPT), str(scene), str(out), params],
            cwd=root, capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=RENDER_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        raise ToolError(f"Рендер остановлен: превышено {RENDER_TIMEOUT_S} с.")
    if proc.returncode != 0:
        message = (proc.stderr or proc.stdout or "").strip()[-800:]
        raise ToolError(f"Рендер не удался: {message or 'неизвестная ошибка'}")
    try:
        info = json.loads(proc.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        info = {"frames": round(duration * fps), "duration": duration}
    rel = out.relative_to(root.resolve()).as_posix()
    size = out.stat().st_size
    text = (
        f"Видео «{rel}» готово: {info['frames']} кадров, {info['duration']} с, "
        f"{width}×{height}, {fps} fps ({size} байт)."
    )
    return text, {"path": rel, "size": size}


def _client_only(args, root):
    """Скилы хранятся в браузере, поэтому load_skill и create_skill выполняет интерфейс, а не сервер."""
    raise ToolError("Этот инструмент выполняется в интерфейсе Cogniflux.")


HANDLERS = {
    "read_file": _read_file,
    "list_files": _list_files,
    "write_file": _write_file,
    "send_file": _send_file,
    "show_html": _show_html,
    "run_code": _run_code,
    "load_skill": _client_only,
    "create_skill": _client_only,
    "remember": _client_only,
    "render_video": _render_video,
}


def execute_tool(name, args, chat_id):
    """Выполняет инструмент в рабочей папке чата.

    Возвращает (успех, текст результата, файл или None). Файл — словарь {"path", "size"}
    для send_file; ссылку на скачивание строит вызывающий код.
    """
    if name not in HANDLERS:
        return False, f"Инструмент «{name}» не зарегистрирован.", None
    if not isinstance(args, dict):
        return False, "Аргументы инструмента должны быть объектом JSON.", None
    try:
        root = chat_dir(chat_id)
        text, file_info = HANDLERS[name](args, root)
        return True, text, file_info
    except ToolError as exc:
        return False, str(exc), None
    except OSError as exc:
        return False, f"Ошибка файловой системы: {exc}", None
