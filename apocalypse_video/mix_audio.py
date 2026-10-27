# -*- coding: utf-8 -*-
"""Финальный микс: voice.wav (1.0) + music.wav (0.35) + sfx.wav (0.7).

Запуск:  python mix_audio.py
Результат: audio_final.wav (48 кГц, стерео, 60 с, лимитер)
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
VOICE = os.path.join(HERE, "voice.wav")
MUSIC = os.path.join(HERE, "audio", "music.wav")
SFX = os.path.join(HERE, "audio", "sfx.wav")
OUT = os.path.join(HERE, "audio_final.wav")

G_VOICE, G_MUSIC, G_SFX = 1.0, 0.35, 0.7


def main():
    for p in (MUSIC, SFX):
        if not os.path.exists(p):
            sys.exit(f"Нет файла {p}. Сначала: python make_audio.py")
    if not os.path.exists(VOICE):
        print("ВНИМАНИЕ: voice.wav отсутствует — микшуем только музыку и SFX.")

    inputs, chain = [], []
    idx = 0
    vols = []
    paths = []
    if os.path.exists(VOICE):
        paths.append(VOICE); vols.append(G_VOICE)
    paths.append(MUSIC); vols.append(G_MUSIC)
    paths.append(SFX); vols.append(G_SFX)

    labels = []
    for i, (p, v) in enumerate(zip(paths, vols)):
        inputs += ["-i", p]
        chain.append(f"[{i}:a]volume={v}[g{i}]")
        labels.append(f"[g{i}]")
    filt = (";".join(chain) + ";" + "".join(labels) +
            f"amix=inputs={len(paths)}:duration=longest:normalize=0,"
            "alimiter=limit=0.95[aout]")

    cmd = ["ffmpeg", "-y", "-v", "error"] + inputs + [
        "-filter_complex", filt, "-map", "[aout]",
        "-t", "60", "-ar", "48000", "-ac", "2", OUT]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr[-2000:], file=sys.stderr)
        sys.exit("mix failed")
    print("mix ok ->", OUT)


if __name__ == "__main__":
    main()
