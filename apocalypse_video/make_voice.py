# -*- coding: utf-8 -*-
"""Озвучка через БЕСПЛАТНЫЙ edge-tts (Microsoft Edge Neural TTS).

Голос: ru-RU-DmitryNeural (мужской, русский) — бесплатная замена
голоса Artem Lebedev из ElevenLabs. Параметры speech-обложки
(Microsoft Prosody):
  rate="+0%"    базовая скорость (edge-tts уже говорит размеренно;
                запас на ускорение даёт atempo в postprocess_all)
  pitch="-4Hz"  чуть ниже/драматичнее
  volume="+0%"  (шёпотные строки: -6%)

Финальная подгонка тайминга (как speed=0.9 в ElevenLabs) делается
автоматически: ffmpeg atempo по фактическим длительностям реплик,
чтобы ни одна реплика не залезала на следующую.

НЕ требует API-ключей и аккаунтов. Интернет нужен только для синтеза.

Запуск:  python make_voice.py
Результат:
  voice/<id>.mp3   — по одному файлу на реплику (сырой синтез)
  voice/<id>_fit.mp3 — после темповой подгонки atempo
  voice.wav        — собранная дорожка 60 с (adelay по таймкодам, ffmpeg)

Переменные окружения (опционально):
  EDGE_VOICE      — другой голос (например ru-RU-SvetlanaNeural)
  EDGE_RATE / EDGE_PITCH — свои параметры (% и Гц)
"""
import asyncio
import os
import subprocess
import sys
import time

from scenario import LINES, DURATION, export_json

HERE = os.path.dirname(os.path.abspath(__file__))
VOICE_DIR = os.path.join(HERE, "voice")
VOICE_WAV = os.path.join(HERE, "voice.wav")
SCENARIO_JSON = os.path.join(HERE, "web", "scenario.json")

DEFAULT_VOICE = "ru-RU-DmitryNeural"
RATE = os.getenv("EDGE_RATE", "+0")        # %
PITCH = os.getenv("EDGE_PITCH", "-4")      # Hz
GAP = 0.25          # тишина между соседними репликами, сек
MAX_TEMPO = 1.35    # предел ускорения atempo (выше — «бульканье»)
MIN_TEMPO = 0.85    # предел замедления


def die(msg):
    print("\n" + "=" * 60)
    print("ОСТАНОВКА: " + msg)
    print("=" * 60 + "\n")
    sys.exit(1)


async def synth_line(text, out_mp3, whisper=False):
    """Синтез одной реплики через edge_tts (с повторами при сетевых сбоях).

    Microsoft Edge TTS периодически отдаёт NoAudioReceived (rate-limit/дрейф
    токена) — это временно, помогает экспоненциальный retry.
    """
    import edge_tts

    kwargs = dict(rate=f"{RATE}%", volume="-6%" if whisper else "+0%",
                  pitch=f"{PITCH}Hz")

    last_err = None
    for attempt in range(8):
        try:
            communicate = edge_tts.Communicate(text, get_voice(), **kwargs)
            await communicate.save(out_mp3)
            if os.path.exists(out_mp3) and os.path.getsize(out_mp3) > 500:
                return
            raise RuntimeError("пустой файл")
        except Exception as e:
            last_err = e
            print(f"  попытка {attempt+1} не удалась: {e}", file=sys.stderr)
            time.sleep(min(3 * (attempt + 1), 20))
    die(f"Не удалось синтезировать реплику «{text[:40]}…» в {out_mp3}: {last_err}")


def get_voice():
    return os.getenv("EDGE_VOICE", DEFAULT_VOICE)


def duration_of(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", path],
        capture_output=True, text=True)
    try:
        return float(out.stdout.strip())
    except ValueError:
        return 0.0


def build_timeline_wav(items):
    """items: [(start_sec, mp3_path)] -> voice.wav длиной DURATION."""
    inputs, filters, tags = [], [], []
    for i, (start, p) in enumerate(items):
        delay_ms = int(round(start * 1000))
        inputs += ["-i", p]
        filters.append(f"[{i}:a]adelay={delay_ms}|{delay_ms}[a{i}]")
        tags.append(f"[a{i}]")
    total_in = len(items)
    filt = ";".join(filters) + ";" + "".join(tags) + \
        f"amix=inputs={total_in}:normalize=0[mix];" \
        f"[mix]apad=whole_dur={DURATION},atrim=0:{DURATION}[out]"
    cmd = (["ffmpeg", "-y", "-v", "error"] + inputs +
           ["-filter_complex", filt, "-map", "[out]",
            "-ar", "48000", "-ac", "2", VOICE_WAV])
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        die("ffmpeg сборка voice.wav: " + r.stderr[-1500:])


def postprocess_all():
    """Подгонка длительностей: ffmpeg atempo, чтобы реплики не overlapping.

    Итеративный алгоритм (сборка с конца): для каждой позиции считаем
    доступное окно = (время начала уже поставленной следующей реплики) - GAP.
    Если реплика длиннее окна — ускоряем её atempo (аналог speed в
    ElevenLabs). Если даже при MAX_TEMPO не влезает и при этом следующая
    позиция ещё не озвучена — сдвигаем начало следующей реплики позже
    (авто-коррекция таймлайна; результат пишется в web/scenario.json,
    поэтому субтитры в рендере подстроятся автоматически).
    Результат — *_fit.mp3, из них собирается voice.wav.
    """
    n = len(LINES)
    starts = [float(s) for (_, s, _, _, _) in LINES]
    srcs = [os.path.join(VOICE_DIR, f"{lid}.mp3") for (lid, *_) in LINES]
    durs = [duration_of(p) for p in srcs]

    use = [None] * n          # путь итогового файла
    tempo = [1.0] * n
    placed_end = [None] * n   # конец уже поставленной реплики

    def fit_one(i, avail):
        """Возвращает (tempo, new_dur) или None, если не влезает."""
        t = 1.0 if durs[i] <= avail * 1.02 else min(durs[i] / avail, MAX_TEMPO)
        nd = durs[i] / t
        if nd <= avail * 1.02:
            return t, nd
        return None

    # проход с конца вперёд
    for i in range(n - 1, -1, -1):
        nxt = starts[i + 1] if i + 1 < n else DURATION
        avail = nxt - starts[i] - GAP
        r = fit_one(i, avail)
        if r is None and i + 1 < n and placed_end[i + 1] is None:
            # сдвигаем следующую реплику так, чтобы текущая влезла на max темпе
            need = durs[i] / MAX_TEMPO + GAP
            new_start = max(starts[i + 1], starts[i] + need)
            # не залезаем на реплику i+2 (если она уже зафиксирована)
            limit = (starts[i + 2] - GAP) if i + 2 < n else (DURATION - GAP)
            new_start = min(new_start, limit)
            if new_start > starts[i + 1]:
                print(f"  {LINES[i][0]}: сдвигаем [{LINES[i+1][0]}] "
                      f"{starts[i+1]:.1f}s -> {new_start:.1f}s")
                starts[i + 1] = new_start
            avail = starts[i + 1] - starts[i] - GAP
            r = fit_one(i, avail)
        if r is None:
            r = (MAX_TEMPO, durs[i] / MAX_TEMPO)
            print(f"  {LINES[i][0]}: НЕ влезает даже при atempo={MAX_TEMPO} "
                  f"(d={durs[i]:.2f}s, окно={avail:.2f}s) — накладываемся")
        tempo[i], nd = r
        placed_end[i] = starts[i] + nd

    # применяем atempo и собираем items
    items = []
    for i, (lid, _s, _w, _t, _wh) in enumerate(LINES):
        fit = os.path.join(VOICE_DIR, f"{lid}_fit.mp3")
        if abs(tempo[i] - 1.0) > 0.01:
            cmd = ["ffmpeg", "-y", "-v", "error", "-i", srcs[i],
                   "-filter:a", f"atempo={tempo[i]:.4f}",
                   "-b:a", "128k", fit]
            r = subprocess.run(cmd, capture_output=True, text=True)
            if r.returncode != 0:
                die(f"atempo {lid}: {r.stderr[-800:]}")
            use_path = fit
            print(f"  {lid}: atempo={tempo[i]:.2f}  {durs[i]:.2f}s -> "
                  f"{placed_end[i]-starts[i]:.2f}s @ {starts[i]:.2f}s")
        else:
            use_path = srcs[i]
            print(f"  {lid}: {durs[i]:.2f}s влезает @ {starts[i]:.2f}s")
        items.append((starts[i], use_path))

    # сохраняем скорректированные старты в scenario.json (для субтитров)
    export_json_adjusted(SCENARIO_JSON, starts)
    return items


def export_json_adjusted(path, starts):
    """Экспорт сценария с авто-скорректированными таймкодами реплик.

    Субтитры растягиваются/сдвигаются по новой сетке стартов, чтобы
    текст на экране совпадал со звуком.
    """
    import json as _json
    from scenario import SUBTITLES, DURATION as DUR, FPS, WIDTH, HEIGHT
    n = len(starts)
    subs = []
    for j, (a, b, txt) in enumerate(SUBTITLES):
        na = starts[j] if j < n else a
        nb = starts[j + 1] if (j + 1) < n else DUR
        subs.append({"start": round(na, 2), "end": round(nb, 2), "text": txt})
    data = {
        "duration": DUR, "fps": FPS, "width": WIDTH, "height": HEIGHT,
        "lines": [{"id": LINES[i][0], "start": round(starts[i], 2),
                   "window": LINES[i][2], "text": LINES[i][3],
                   "whisper": LINES[i][4]} for i in range(n)],
        "subtitles": subs,
    }
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        _json.dump(data, f, ensure_ascii=False, indent=2)


async def amain():
    export_json(SCENARIO_JSON)
    os.makedirs(VOICE_DIR, exist_ok=True)

    # 1) Синтез (пропуск уже готовых файлов — можно докачивать по частям)
    for (lid, start, window, text, whisper) in LINES:
        mp3 = os.path.join(VOICE_DIR, f"{lid}.mp3")
        if not (os.path.exists(mp3) and os.path.getsize(mp3) > 1000):
            print(f"TTS [{lid}] @{start:.0f}s: {text[:50]}")
            await synth_line(text, mp3, whisper)
            await asyncio.sleep(1.0)  # мягкий троттлинг к API Microsoft

    # 1b) Повторный проход по недостающим (если сеть штормило весь прошлый запуск)
    missing = [lid for (lid, *_rest) in LINES
               if not (os.path.exists(os.path.join(VOICE_DIR, f"{lid}.mp3"))
                       and os.path.getsize(os.path.join(VOICE_DIR, f"{lid}.mp3")) > 1000)]
    if missing:
        print("Докачиваю недостающие:", ", ".join(missing))
        for (lid, start, window, text, whisper) in LINES:
            if lid not in missing:
                continue
            mp3 = os.path.join(VOICE_DIR, f"{lid}.mp3")
            await synth_line(text, mp3, whisper)
            await asyncio.sleep(1.0)

    # 2) Подгонка тайминга + 3) сборка voice.wav
    items = postprocess_all()
    build_timeline_wav(items)
    print(f"\nOK: {len(items)} реплик -> voice/ , собран {VOICE_WAV} "
          f"({duration_of(VOICE_WAV):.2f}s)")


def main():
    try:
        import edge_tts  # noqa: F401
    except ImportError:
        die("edge-tts не установлен.\nУстановите: pip install edge-tts")
    asyncio.run(amain())


if __name__ == "__main__":
    main()
