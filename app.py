"""Cogniflux — локальный веб-сервер.

Раздаёт фронтенд, проксирует запросы к OpenAI-compatible API LM Studio (с потоковой выдачей),
выполняет инструменты по подтверждению пользователя и извлекает текст из PDF/DOCX.

Запуск:  python app.py
"""

import io
import json
import os
import shutil
import socket
import sys
from urllib.parse import urlparse

import requests
from flask import Flask, Response, jsonify, request, send_from_directory, stream_with_context

from urllib.parse import quote

from backend.tools import TOOL_SPECS, WORKSPACE, ToolError, chat_dir, delete_chat_folder, execute_tool, tool_schemas

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")

DEFAULT_CONFIG = {
    "host": "127.0.0.1",
    "port": 8080,
    "default_base_url": "http://localhost:1234/v1",
    "request_timeout_seconds": 300,
    "connect_timeout_seconds": 5,
}

ALLOWED_ROLES = {"system", "user", "assistant", "tool"}
PARAM_RANGES = {
    "temperature": (0.0, 2.0),
    "top_p": (0.0, 1.0),
    "max_tokens": (1, 32768),
    "frequency_penalty": (-2.0, 2.0),
    "presence_penalty": (-2.0, 2.0),
    "seed": (0, 2**31 - 1),
}
INT_PARAMS = {"max_tokens", "seed"}
MAX_DOC_BYTES = 20 * 1024 * 1024
MAX_EXTRACT_CHARS = 200000


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, encoding="utf-8") as fh:
                cfg.update(json.load(fh))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"[Cogniflux] Не удалось прочитать config.json ({exc}). Использую значения по умолчанию.")
    return cfg


CFG = load_config()

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 40 * 1024 * 1024


# ---------- вспомогательные функции ----------

def clean_base_url(raw):
    if not isinstance(raw, str):
        return None
    url = raw.strip().rstrip("/")
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return None
    return url


def auth_headers(api_key):
    headers = {"Content-Type": "application/json"}
    if isinstance(api_key, str) and api_key.strip():
        headers["Authorization"] = f"Bearer {api_key.strip()}"
    return headers


def error(status, code, message):
    return jsonify({"error": {"code": code, "message": message}}), status


def connection_error(exc):
    if isinstance(exc, requests.exceptions.Timeout):
        return error(504, "timeout", "Сервер не ответил вовремя. Проверьте, что модель загружена в LM Studio.")
    if isinstance(exc, requests.exceptions.ConnectionError):
        return error(
            502,
            "unreachable",
            "Сервер LM Studio недоступен. Проверьте, что LM Studio запущен, локальный сервер включён "
            "и адрес указан верно (по умолчанию http://localhost:1234/v1).",
        )
    return error(502, "request_failed", f"Запрос завершился ошибкой: {exc}")


def check_upstream(resp):
    if resp.ok:
        return None
    try:
        detail = resp.text[:300]
    except Exception:  # noqa: BLE001 - тело ошибки необязательно
        detail = ""
    resp.close()
    if resp.status_code in (401, 403):
        return error(401, "auth", "Ошибка авторизации: сервер не принял API key. Проверьте ключ в настройках подключения.")
    if resp.status_code == 404:
        return error(404, "not_found", "Адрес или модель не найдены. Проверьте Base URL (обычно заканчивается на /v1) и выбранную модель.")
    return error(502, "upstream", f"Сервер вернул ошибку HTTP {resp.status_code}. {detail}".strip())


def sse_error(message):
    payload = json.dumps({"error": {"message": message}}, ensure_ascii=False)
    return f"data: {payload}\n\n".encode("utf-8")


# ---------- маршруты ----------

LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1", "[::1]"}


@app.before_request
def guard_local_api():
    """Защита локального API.

    * Запросы принимаются только с адресов этого компьютера (защита от DNS rebinding).
    * Заголовок Origin, если есть, тоже должен быть локальным.
    * Изменяющие запросы обязаны содержать заголовок X-Cogniflux. Браузер не отправит его с чужой страницы
      без предварительного запроса (CORS), на который сервер не отвечает, поэтому сайт из другой вкладки
      не сможет запускать инструменты.
    """
    if not request.path.startswith("/api/"):
        return None
    host = request.host or ""
    hostname = host[: host.index("]") + 1] if host.startswith("[") else host.split(":")[0]
    if hostname not in LOCAL_HOSTS:
        return error(403, "forbidden", "Запросы допускаются только с этого компьютера.")
    origin = request.headers.get("Origin")
    if origin:
        origin_host = urlparse(origin).hostname or ""
        if origin_host not in {"127.0.0.1", "localhost", "::1"}:
            return error(403, "forbidden", "Запрос пришёл с чужого сайта.")
    if request.method in ("POST", "PUT", "PATCH", "DELETE") and request.headers.get("X-Cogniflux") != "1":
        return error(403, "forbidden", "Нет служебного заголовка Cogniflux.")
    return None


@app.delete("/api/chats/<chat_id>/files")
def delete_chat_files(chat_id):
    try:
        removed = delete_chat_folder(chat_id)
    except ToolError:
        return error(400, "bad_chat", "Некорректный идентификатор чата.")
    except OSError as exc:
        return error(500, "fs_error", f"Не удалось удалить папку чата: {exc}")
    return jsonify({"ok": True, "removed": removed})


@app.get("/api/config")
def get_config():
    return jsonify(
        {
            "default_base_url": CFG["default_base_url"],
            "port": CFG["port"],
            "workspace": str(WORKSPACE),
        }
    )


@app.post("/api/models")
def list_models():
    body = request.get_json(silent=True) or {}
    base = clean_base_url(body.get("base_url"))
    if not base:
        return error(400, "bad_url", "Некорректный адрес. Укажите полный URL, например http://localhost:1234/v1.")
    try:
        resp = requests.get(
            f"{base}/models",
            headers=auth_headers(body.get("api_key")),
            timeout=(CFG["connect_timeout_seconds"], 30),
        )
    except requests.RequestException as exc:
        return connection_error(exc)

    bad = check_upstream(resp)
    if bad:
        return bad
    try:
        payload = resp.json()
    except ValueError:
        return error(502, "bad_response", "Сервер ответил не JSON. Возможно, адрес указывает не на OpenAI-совместимый API.")
    if not isinstance(payload, dict):
        return error(502, "bad_response", "Неожиданный формат ответа сервера.")

    models = [
        {"id": item["id"]}
        for item in payload.get("data", [])
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    ]
    return jsonify({"models": models})


@app.post("/api/chat")
def chat():
    body = request.get_json(silent=True) or {}
    base = clean_base_url(body.get("base_url"))
    if not base:
        return error(400, "bad_url", "Некорректный адрес сервера LM Studio.")

    model = body.get("model")
    if not isinstance(model, str) or not model.strip():
        return error(400, "no_model", "Модель не выбрана. Откройте настройки подключения и выберите модель.")

    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        return error(400, "no_messages", "Нет сообщений для отправки.")

    clean_messages = []
    for item in messages:
        if not isinstance(item, dict) or item.get("role") not in ALLOWED_ROLES:
            return error(400, "bad_message", "Некорректный формат сообщения.")
        role = item["role"]
        content = item.get("content")
        tool_calls = item.get("tool_calls")
        if content is not None and not isinstance(content, (str, list)):
            return error(400, "bad_message", "Содержимое сообщения должно быть строкой или списком.")
        if content is None and not (role == "assistant" and tool_calls):
            return error(400, "bad_message", "Пустое сообщение.")
        msg = {"role": role, "content": content if content is not None else ""}
        if tool_calls is not None:
            if role != "assistant" or not isinstance(tool_calls, list):
                return error(400, "bad_message", "Некорректные вызовы инструментов.")
            msg["tool_calls"] = tool_calls
        if role == "tool":
            if not isinstance(item.get("tool_call_id"), str):
                return error(400, "bad_message", "Для результата инструмента нужен tool_call_id.")
            msg["tool_call_id"] = item["tool_call_id"]
        clean_messages.append(msg)

    payload = {"model": model.strip(), "messages": clean_messages, "stream": True}

    params = body.get("params") or {}
    for key, (low, high) in PARAM_RANGES.items():
        value = params.get(key)
        if value is None:
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not (low <= value <= high):
            return error(400, "bad_param", f"Параметр «{key}» вне допустимого диапазона.")
        payload[key] = int(value) if key in INT_PARAMS else float(value)

    tool_names = body.get("tool_names") or []
    if not isinstance(tool_names, list) or not all(isinstance(n, str) for n in tool_names):
        return error(400, "bad_tools", "Список инструментов должен быть массивом строк.")
    unknown = [n for n in tool_names if n not in TOOL_SPECS]
    if unknown:
        return error(400, "bad_tools", f"Неизвестные инструменты: {', '.join(unknown)}.")
    if tool_names:
        payload["tools"] = tool_schemas(tool_names)
        payload["tool_choice"] = "auto"

    try:
        upstream = requests.post(
            f"{base}/chat/completions",
            json=payload,
            headers=auth_headers(body.get("api_key")),
            stream=True,
            timeout=(CFG["connect_timeout_seconds"], CFG["request_timeout_seconds"]),
        )
    except requests.RequestException as exc:
        return connection_error(exc)

    bad = check_upstream(upstream)
    if bad:
        return bad

    def generate():
        try:
            content_type = upstream.headers.get("Content-Type", "")
            if "text/event-stream" not in content_type:
                # Сервер проигнорировал stream=true: отдаём полный ответ одним событием.
                # Сначала служебное событие, чтобы интерфейс мог сообщить пользователю об этом.
                yield b'data: {"meta": {"stream": false}}\n\n'
                try:
                    data = upstream.json()
                    choice = data["choices"][0]["message"]
                except (ValueError, KeyError, IndexError, TypeError):
                    yield sse_error("Сервер вернул ответ неожиданного формата.")
                    return
                delta = {"content": choice.get("content")}
                if choice.get("tool_calls"):
                    delta["tool_calls"] = [dict(tc, index=i) for i, tc in enumerate(choice["tool_calls"])]
                chunk = json.dumps({"choices": [{"delta": delta}]}, ensure_ascii=False)
                yield f"data: {chunk}\n\ndata: [DONE]\n\n".encode("utf-8")
                return
            for piece in upstream.iter_content(chunk_size=None):
                if piece:
                    yield piece
        except requests.RequestException as exc:
            yield sse_error(f"Соединение с LM Studio прервано: {exc}")
        finally:
            # Срабатывает и при отмене генерации клиентом (закрытие соединения).
            upstream.close()

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/tools/run")
def run_tool():
    """Выполняет инструмент. Подтверждение пользователя проверяется во фронтенде до вызова."""
    body = request.get_json(silent=True) or {}
    chat_id = body.get("chat_id")
    ok, result, file_info = execute_tool(body.get("name"), body.get("arguments") or {}, chat_id)
    response = {"ok": ok, "result": result}
    if ok and file_info:
        response["file"] = {
            "name": file_info["path"].rsplit("/", 1)[-1],
            "size": file_info["size"],
            "url": f"/api/files/{quote(chat_id)}/{quote(file_info['path'], safe='/')}",
        }
    return jsonify(response)


@app.get("/api/files/<chat_id>/<path:rel>")
def download_chat_file(chat_id, rel):
    """Скачивание файла из рабочей папки чата. Выход за пределы папки блокирует send_from_directory."""
    try:
        root = chat_dir(chat_id, create=False)
    except ToolError:
        return error(404, "not_found", "Файл не найден.")
    if not root.is_dir():
        return error(404, "not_found", "Файл не найден.")
    return send_from_directory(root, rel, as_attachment=True)


@app.post("/api/extract")
def extract_document():
    upload = request.files.get("file")
    if upload is None:
        return error(400, "no_file", "Файл не передан.")
    filename = (upload.filename or "").lower()
    ext = filename.rsplit(".", 1)[-1] if "." in filename else ""
    data = upload.read(MAX_DOC_BYTES + 1)
    if len(data) > MAX_DOC_BYTES:
        return error(413, "too_large", "Документ больше 20 МБ.")
    try:
        if ext == "pdf":
            from pypdf import PdfReader

            reader = PdfReader(io.BytesIO(data))
            text = "\n\n".join((page.extract_text() or "") for page in reader.pages)
        elif ext == "docx":
            import docx

            document = docx.Document(io.BytesIO(data))
            text = "\n".join(paragraph.text for paragraph in document.paragraphs)
        else:
            return error(400, "unsupported", f"Извлечение текста из .{ext or '?'} не поддерживается.")
    except ImportError:
        return error(501, "missing_lib", "Не установлены библиотеки для PDF/DOCX. Выполните: pip install -r requirements.txt")
    except Exception as exc:  # noqa: BLE001 - повреждённый файл
        return error(422, "parse_failed", f"Не удалось извлечь текст: {exc}")

    text = text.strip()
    if not text:
        return error(422, "empty", "В документе нет текстового слоя. Если это скан, нужен OCR — он пока не подключён.")
    return jsonify({"text": text[:MAX_EXTRACT_CHARS], "truncated": len(text) > MAX_EXTRACT_CHARS})


# ---------- раздача фронтенда ----------

@app.get("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.get("/<path:filename>")
def static_files(filename):
    return send_from_directory(FRONTEND_DIR, filename)


# ---------- запуск ----------

def port_is_free(host, port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind((host, port))
            return True
        except OSError:
            return False


if __name__ == "__main__":
    host, port = CFG["host"], int(CFG["port"])
    if not port_is_free(host, port):
        print(
            f"Порт {port} уже занят другой программой.\n"
            f"Закройте её или измените \"port\" в config.json и запустите Cogniflux снова."
        )
        sys.exit(1)
    print(f"Cogniflux запущен: http://{host}:{port}")
    print(f"Адрес LM Studio по умолчанию: {CFG['default_base_url']} (меняется в настройках приложения)")
    print(f"Рабочая папка для файлов и кода: {WORKSPACE}")
    app.run(host=host, port=port, threaded=True, debug=False)
