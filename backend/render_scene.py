"""Рендер HTML-сцены в видео.

Контракт сцены: в HTML есть функция renderFrame(t), которая рисует кадр в момент t (секунды),
и (необязательно) константа DURATION — длительность в секундах. Кадры снимаются в Chromium
(Playwright), затем собираются в MP4 через ffmpeg.

Запуск:  python render_scene.py <scene.html> <out.mp4> '<json: width, height, fps, duration>'
Печатает последней строкой JSON: {"frames": N, "duration": D}.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def find_ffmpeg():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg  # необязательный пакет с готовым ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001 - пакет может быть не установлен
        return None


def fail(message, code=2):
    print(message, file=sys.stderr)
    sys.exit(code)


def main():
    if len(sys.argv) != 4:
        fail("Нужны аргументы: scene.html out.mp4 params-json")
    scene_path = Path(sys.argv[1]).resolve()
    out_path = Path(sys.argv[2]).resolve()
    params = json.loads(sys.argv[3])
    width, height = int(params["width"]), int(params["height"])
    fps, duration = int(params["fps"]), float(params["duration"])

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        fail("Не найден ffmpeg. Установите ffmpeg или выполните: pip install imageio-ffmpeg")
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        fail("Не установлен Playwright. Выполните: pip install playwright && python -m playwright install chromium")

    scene_uri = scene_path.as_uri()
    frames_dir = Path(tempfile.mkdtemp(prefix="frames-", dir=out_path.parent))
    try:
        with sync_playwright() as pw:
            try:
                browser = pw.chromium.launch(args=["--disable-gpu"])
            except Exception as exc:  # noqa: BLE001
                fail(f"Не удалось запустить Chromium: {exc}. Выполните: python -m playwright install chromium")
            page = browser.new_page(viewport={"width": width, "height": height})
            # Сцена может читать только собственный файл и сеть по https; остальные локальные файлы закрыты.
            page.route("file://**", lambda route: route.continue_() if route.request.url == scene_uri else route.abort())
            page.goto(scene_uri)
            try:
                page.wait_for_function("typeof renderFrame === 'function'", timeout=15000)
            except Exception:  # noqa: BLE001
                fail("В сцене нет функции renderFrame(t). Добавьте её и попробуйте снова.")
            declared = page.evaluate("typeof DURATION === 'number' ? DURATION : null")
            if declared:
                duration = float(declared)
            frames = max(1, round(duration * fps))
            for i in range(frames):
                t = i / fps
                page.evaluate("t => renderFrame(t)", t)
                page.screenshot(path=str(frames_dir / f"f{i:05d}.png"))
            browser.close()

        cmd = [
            ffmpeg, "-y", "-loglevel", "error",
            "-framerate", str(fps), "-i", str(frames_dir / "f%05d.png"),
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            str(out_path),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if proc.returncode != 0:
            fail(f"ffmpeg завершился с ошибкой: {proc.stderr[-500:]}")
    finally:
        shutil.rmtree(frames_dir, ignore_errors=True)
    print(json.dumps({"frames": frames, "duration": duration}))


if __name__ == "__main__":
    main()
