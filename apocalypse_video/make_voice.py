# -*- coding: utf-8 -*-
"""Озвучка через ElevenLabs API. Голос: Artem Lebedev (Voice Library).

НЕ использует edge-tts и любой другой бесплатный TTS — только ElevenLabs.

Требования:
  pip install elevenlabs python-dotenv
Переменные окружения / .env:
  ELEVENLABS_API_KEY   — ОБЯЗАТЕЛЬНО (elevenlabs.io -> Profile -> API Keys)
  ARTEM_VOICE_ID       — опционально (если известен voice_id голоса)

Запуск:  python make_voice.py
Результат:
  voice/<id>.mp3   — по одному файлу на реплику
  voice.wav        — собранная дорожка 60 с (adelay по таймкодам, ffmpeg)
"""
import os
import subprocess
import sys
import time

from dotenv import load_dotenv

from scenario import LINES, DURATION, export_json

HERE = os.path.dirname(os.path.abspath(__file__))
VOICE_DIR = os.path.join(HERE, "voice")
VOICE_WAV = os.path.join(HERE, "voice.wav")
SCENARIO_JSON = os.path.join(HERE, "web", "scenario.json")

ARTEM_NAME = "Artem Lebedev"
MODEL_ID = "eleven_multilingual_v2"
STABILITY = 0.42
SIMILARITY_BOOST = 0.75
SPEED = 0.9


def die(msg):
    print("\n" + "=" * 60)
    print("ОСТАНОВКА: " + msg)
    print("=" * 60 + "\n")
    sys.exit(1)


def get_client():
    load_dotenv(os.path.join(HERE, ".env"))
    load_dotenv(os.path.join(HERE, "..", ".env"))
    api_key = os.getenv("ELEVENLABS_API_KEY")
    if not api_key:
        die(
            "Не найден ELEVENLABS_API_KEY.\n\n"
            "Где взять ключ:\n"
            "  1. Зайдите на https://elevenlabs.io и войдите в аккаунт.\n"
            "  2. Нажмите на аватар (Profile) -> Profile -> API Keys.\n"
            "  3. Скопируйте ключ и положите его в файл apocalypse_video/.env:\n"
            "       ELEVENLABS_API_KEY=sk_XXXXXXXXXXXXXXXX\n"
            "     либо экспортируйте: export ELEVENLABS_API_KEY=sk_XXXX\n\n"
            "Edge-tts и другие бесплатные TTS НЕ используются: голос\n"
            "Artem Lebedev доступен только через ElevenLabs."
        )
    from elevenlabs.client import ElevenLabs
    return ElevenLabs(api_key=api_key)


def find_artem_voice_id(client):
    """Ищем 'Artem Lebedev' среди голосов аккаунта (get_all, со страницей)."""
    vid = os.getenv("ARTEM_VOICE_ID")
    if vid:
        print(f"ARTEM_VOICE_ID из окружения: {vid}")
        return vid
    try:
        resp = client.voices.get_all(page_size=100)
    except Exception as e:
        die(f"Ошибка запроса списка голосов ElevenLabs: {e}")
    voices = list(getattr(resp, "voices", None) or [])
    # если голосов больше страницы — идём дальше
    next_cursor = getattr(resp, "next_page_cursor", None)
    while next_cursor:
        resp = client.voices.get_all(page_size=100, cursor=next_cursor)
        voices += list(getattr(resp, "voices", None) or [])
        next_cursor = getattr(resp, "next_page_cursor", None)

    for v in voices:
        if (v.name or "").strip().lower() == ARTEM_NAME.strip().lower():
            print(f"Найден голос: {v.name}  voice_id={v.voice_id}")
            return v.voice_id

    names = sorted((v.name or "?") for v in voices)
    print("\nДоступные голоса в аккаунте:")
    for n in names:
        print("  -", n)
    die(
        f"Голос «{ARTEM_NAME}» не найден в вашем аккаунте ElevenLabs.\n"
        f"Добавьте его: elevenlabs.io -> Voice Library -> поиск «{ARTEM_NAME}» ->\n"
        "«Add to My Voices», затем перезапустите make_voice.py\n"
        "(или пропишите ARTEM_VOICE_ID=<voice_id> в .env)."
    )


def tts(client, voice_id, text, out_mp3, whisper=False):
    from elevenlabs import VoiceSettings
    settings = VoiceSettings(
        stability=STABILITY,
        similarity_boost=SIMILARITY_BOOST,
        speed=SPEED,
        use_speaker_boost=True,
    )
    if whisper:
        text = "(шёпотом, очень тихо и напряжённо) " + text
    for attempt in range(3):
        try:
            stream = client.text_to_speech.convert(
                text=text,
                voice_id=voice_id,
                model_id=MODEL_ID,
                voice_settings=settings,
            )
            with open(out_mp3, "wb") as f:
                for chunk in stream:
                    if chunk:
                        f.write(chunk)
            return
        except Exception as e:
            print(f"  попытка {attempt+1} не удалась: {e}", file=sys.stderr)
            time.sleep(2 * (attempt + 1))
    die(f"Не удалось синтезировать реплику в {out_mp3}")


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


def main():
    export_json(SCENARIO_JSON)
    os.makedirs(VOICE_DIR, exist_ok=True)

    client = get_client()
    voice_id = find_artem_voice_id(client)

    items = []
    for (lid, start, window, text, whisper) in LINES:
        mp3 = os.path.join(VOICE_DIR, f"{lid}.mp3")
        if not (os.path.exists(mp3) and os.path.getsize(mp3) > 1000):
            print(f"TTS [{lid}] @{start:.0f}s: {text[:50]}...")
            tts(client, voice_id, text, mp3, whisper)
        d = duration_of(mp3)
        print(f"  {lid}.mp3 длительность {d:.2f}s (окно {window:.1f}s)"
              + ("  !!! ДЛИННЕЕ ОКНА" if d > window else ""))
        items.append((start, mp3))

    build_timeline_wav(items)
    print(f"\nOK: {len(items)} реплик -> voice/ , собран {VOICE_WAV} "
          f"({duration_of(VOICE_WAV):.2f}s)")


if __name__ == "__main__":
    main()
