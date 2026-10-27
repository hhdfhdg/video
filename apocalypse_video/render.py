# -*- coding: utf-8 -*-
"""Рендер видеокадра: Playwright(chromium) -> PNG-кадры -> video.mp4.

Использование:
    python render.py                 # весь таймлайн 0..60 с (1800 кадров)
    python render.py --act 1         # только акт (быстрый тест): 1->0-12, 2->12-35,
                                     # 3->35-52, 4->52-60
    python render.py --no-audio      # без звуковой дорожки (только видео)

Шаги:
 1) Поднимает локальный file:// интерфейс web/index.html?t=<float>&render=1
 2) Ждёт window.__frameReady, делает screenshot 1080x1920 в frames/%05d.png
 3) ffmpeg: -framerate 30 frames + audio_final.wav -> video.mp4 (H.264/AAC)
"""
import argparse
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(HERE, "web")
FRAMES_DIR = os.path.join(HERE, "frames")
VIDEO = os.path.join(HERE, "video.mp4")
AUDIO = os.path.join(HERE, "audio_final.wav")

FPS = 30
DUR = 60.0
W, H = 1080, 1920

ACTS = {1: (0.0, 12.0), 2: (12.0, 35.0), 3: (35.0, 52.0), 4: (52.0, 60.0)}


def render_frames(t0, t1, prefix="f"):
    from playwright.sync_api import sync_playwright
    os.makedirs(FRAMES_DIR, exist_ok=True)
    url_page = "file://" + os.path.join(WEB_DIR, "index.html")
    n = int(round((t1 - t0) * FPS))
    print(f"Рендер {n} кадров: t={t0}..{t1} c")
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--force-color-profile=srgb",
                                          "--disable-lcd-text"])
        page = browser.new_page(viewport={"width": W, "height": H},
                                device_scale_factor=1)
        page.goto(url_page + "?t=0&render=1")
        for i in range(n):
            t = t0 + i / FPS
            page.evaluate(f"""() => {{
                document.body.classList.add('rendering');
                window.renderFrame({t});
            }}""")
            page.wait_for_function("window.__frameReady === true", timeout=10000)
            path = os.path.join(FRAMES_DIR, f"{prefix}{i:05d}.png")
            page.locator("#scene").screenshot(path=path)
            if i % 150 == 0:
                print(f"  кадр {i}/{n} (t={t:.2f})")
        browser.close()
    return n


def encode(prefix, out_video, with_audio=True, start_sec=0.0):
    cmd = ["ffmpeg", "-y", "-v", "error",
           "-framerate", str(FPS)]
    if start_sec > 0:
        cmd += ["-start_number", "0"]
    cmd += ["-i", os.path.join(FRAMES_DIR, prefix + "%05d.png")]
    if with_audio and os.path.exists(AUDIO):
        inputs = ["-i", AUDIO]
        if start_sec > 0:
            inputs = ["-ss", f"{start_sec}", "-i", AUDIO]
        cmd += inputs + ["-c:v", "libx264", "-preset", "medium",
                         "-crf", "19", "-pix_fmt", "yuv420p",
                         "-c:a", "aac", "-b:a", "192k",
                         "-ar", "48000", "-shortest", out_video]
    else:
        cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", "19",
                "-pix_fmt", "yuv420p", "-an", out_video]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr[-2000:], file=sys.stderr)
        sys.exit("ffmpeg encode failed")
    print("encoded ->", out_video)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--act", type=int, choices=[1, 2, 3, 4], default=None,
                    help="прорендерить только один акт (тест)")
    ap.add_argument("--no-audio", action="store_true")
    args = ap.parse_args()

    if args.act is not None:
        t0, t1 = ACTS[args.act]
        render_frames(t0, t1, prefix=f"act{args.act}_")
        encode(f"act{args.act}_", os.path.join(HERE, f"test_act{args.act}.mp4"),
               with_audio=False)
        print("Тестовый акт готов (без звука). Полный рендер: python render.py")
        return

    render_frames(0.0, DUR)
    encode("f", VIDEO, with_audio=not args.no_audio)


if __name__ == "__main__":
    main()
