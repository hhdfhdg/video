# -*- coding: utf-8 -*-
"""Музыка и SFX, синтезированные процедурно (numpy/scipy).

Запуск:  python make_audio.py
Результат:
  audio/music.wav  — тёмный эмбиент-дрон 60 с, бас-дроп на 52 с
  audio/sfx.wav    — удар 0:00, стук в дверь 22–26 с, шаги 26–30 с,
                     рык зомби 35–42 с + доп. акценты по таймлайну
Оба файла: 48 кГц, стерео, 16-bit PCM.
"""
import os

import numpy as np
from scipy.signal import butter, lfilter

SR = 48000
DUR = 60.0
N = int(SR * DUR)
HERE = os.path.dirname(os.path.abspath(__file__))
AUDIO_DIR = os.path.join(HERE, "audio")

rng = np.random.default_rng(777)


def t_axis(n=N):
    return np.arange(n) / SR


def save_wav(path, x):
    x = np.asarray(x, dtype=np.float64)
    peak = np.max(np.abs(x)) or 1.0
    if peak > 0.98:
        x = x / peak * 0.98
    pcm = (x * 32767.0).astype(np.int16)
    import wave
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    print("saved", path)


def band(x, lo, hi, order=2, btype="bandpass"):
    b, a = butter(order, [lo / (SR / 2), hi / (SR / 2)], btype=btype)
    return lfilter(b, a, x)


def lowpass(x, cutoff, order=2):
    b, a = butter(order, cutoff / (SR / 2), btype="lowpass")
    return lfilter(b, a, x)


def env_ad(n, attack, decay):
    """Attack-decay огибающая (экспоненциальный хвост)."""
    e = np.ones(n)
    na = max(1, int(attack * SR))
    e[:na] = np.linspace(0, 1, na)
    d = np.arange(n) / SR
    e *= np.exp(-np.maximum(d - attack, 0) / max(decay, 1e-6))
    return e


def place(buf, start, sig):
    i = int(start * SR)
    j = min(i + len(sig), len(buf))
    buf[i:j] += sig[: j - i]


# ---------------------------------------------------------------- MUSIC ----
def make_music():
    t = t_axis()
    L = np.zeros(N)
    R = np.zeros(N)

    # --- Дрон: D1 (~36.7 Гц) + квинта A1 + октавы, медленное биение ---
    def osc(f, ph, lfo=0.15, lfo_depth=0.12):
        mod = 1.0 + lfo_depth * np.sin(2 * np.pi * lfo * t + ph)
        return np.sin(2 * np.pi * f * t * mod + ph)

    drone = (0.50 * osc(36.71, 0.0) +
             0.30 * osc(55.00, 1.1, lfo=0.11) +
             0.16 * osc(73.42, 2.3, lfo=0.07) +
             0.08 * osc(146.83, 0.6, lfo=0.21))
    drone = lowpass(drone, 320)

    # --- Зловещий минорный пад (Fm над D) после 12 с ---
    swell_env = np.clip((t - 10.0) / 14.0, 0, 1) * np.exp(-np.clip(t - 30, 0, None) / 25)
    pad = (0.25 * np.sin(2 * np.pi * 87.31 * t) +
           0.20 * np.sin(2 * np.pi * 103.83 * t) +
           0.15 * np.sin(2 * np.pi * 130.81 * t)) * swell_env
    pad = lowpass(pad, 600)

    # --- Шумовой ветер/пыль ---
    noise = rng.standard_normal(N)
    wind = band(noise, 120, 900) * 0.05
    gust = 0.5 + 0.5 * np.sin(2 * np.pi * 0.07 * t + 3 * np.sin(2 * np.pi * 0.023 * t))
    wind *= gust

    # --- Пульс «сердцебиения» 22–35 с (нагнетание) ---
    heart = np.zeros(N)
    hb_start, hb_end, bpm = 20.0, 35.0, 66.0
    period = 60.0 / bpm
    s = hb_start
    while s < hb_end:
        for (off, amp) in ((0.0, 0.55), (0.22, 0.35)):
            st = s + off
            nlen = int(0.35 * SR)
            tt = np.arange(nlen) / SR
            thump = amp * np.sin(2 * np.pi * 48 * tt) * np.exp(-tt * 14)
            place(heart, st, thump)
        s += period
    heart *= np.clip((hb_end - t) / 3.0, 0, 1)
    heart *= np.clip((t - hb_start) / 3.0, 0, 1)

    # --- Тревоговый высокочастотный дилемма-тон после 42 с (погоня) ---
    chase = np.zeros(N)
    mask = t >= 42.0
    trem = 0.5 + 0.5 * np.sin(2 * np.pi * 6.0 * t)
    chase[mask] = (0.06 * trem[mask] *
                   (np.sin(2 * np.pi * 587.33 * t[mask]) +
                    0.6 * np.sin(2 * np.pi * 622.0 * t[mask])))
    chase *= np.clip((t - 42.0) / 3.0, 0, 1) * np.clip((52.0 - t) / 2.0, 0, 1)

    # --- БАС-ДРОП на 52 с ---
    drop = np.zeros(N)
    m = t >= 52.0
    td = t[m] - 52.0
    sub = np.sin(2 * np.pi * (46 - 14 * np.exp(-td * 3)) * td) * np.exp(-td * 0.55)
    grit = band(rng.standard_normal(int(m.sum())), 60, 240) * 0.35 * np.exp(-td * 1.2)
    hit = np.sin(2 * np.pi * 90 * td) * np.exp(-td * 22) * 0.9
    drop[m] = 0.85 * sub + 0.30 * grit + hit
    rise = np.zeros(N)  # восходящий riser перед дропом 49–52 с
    mr = (t >= 48.5) & (t < 52.0)
    tr = (t[mr] - 48.5) / 3.5
    rise[mr] = (band(rng.standard_normal(int(mr.sum())), 200, 4000) *
                (0.05 + 0.25 * tr ** 2))

    mix = 0.9 * drone + pad + wind + 0.8 * heart + chase + rise + 1.25 * drop
    # лёгкий стерео-уидер
    dl = int(0.012 * SR)
    L = mix.copy()
    Rmix = np.zeros(N)
    Rmix[dl:] = mix[:-dl]
    Rmix[:dl] = mix[:1]
    R = 0.92 * Rmix + 0.10 * drone

    # затухания: вход 1.5 с, финальный хвост после 58.5 с
    L *= np.clip(t / 1.5, 0, 1); R *= np.clip(t / 1.5, 0, 1)
    out_fade = np.clip((60.0 - t) / 1.5, 0, 1)
    L *= out_fade; R *= out_fade

    stereo = np.stack([L, R], axis=1)
    save_wav(os.path.join(AUDIO_DIR, "music.wav"), stereo)


# ------------------------------------------------------------------ SFX ----
def make_sfx():
    t = t_axis()
    L = np.zeros(N)
    R = np.zeros(N)

    # 1) УДАР на 0:00 — низкий boom + треск (город гаснет)
    nlen = int(2.2 * SR)
    tt = np.arange(nlen) / SR
    boom = (np.sin(2 * np.pi * 55 * tt - 8 * np.exp(-tt * 6)) * np.exp(-tt * 3.2) * 1.1
            + band(rng.standard_normal(nlen), 400, 6000) * 0.5 * np.exp(-tt * 30))
    place(L, 0.0, boom)
    place(R, 0.0, boom * 0.9)
    # гул отключения электричества
    hum_n = int(1.6 * SR)
    th = np.arange(hum_n) / SR
    hum = np.sin(2 * np.pi * 120 * th) * np.exp(-th * 3.0) * 0.25
    place(L, 0.05, hum)
    place(R, 0.07, hum)

    # 2) СТУК В ДВЕРЬ 22–26 с — 6 глухих удара, нарастают
    k = 0
    s = 22.0
    while s < 26.0:
        k += 1
        amp = 0.5 + 0.09 * k
        nlen = int(0.5 * SR)
        tt = np.arange(nlen) / SR
        knock = amp * (np.sin(2 * np.pi * 70 * tt) * np.exp(-tt * 25)
                       + band(rng.standard_normal(nlen), 150, 1200) * 0.35 * np.exp(-tt * 40))
        pan = 0.5 + 0.25 * (-1 if k % 2 else 1)
        place(L, s, knock * pan)
        place(R, s, knock * (1 - pan) * 2 * 0.5 + knock * 0.2)
        s += 0.62 - min(0.03 * k, 0.15)

    # 3) ШАГИ 26–30 с — медленные, неровные
    s = 26.0
    k = 0
    while s < 30.0:
        k += 1
        nlen = int(0.28 * SR)
        tt = np.arange(nlen) / SR
        step = (band(rng.standard_normal(nlen), 80, 420) * 0.30 * np.exp(-tt * 22)
                + np.sin(2 * np.pi * 62 * tt) * 0.18 * np.exp(-tt * 30))
        side = 0.62 if k % 2 else 0.38
        place(L, s, step * side * 2)
        place(R, s, step * (1 - side) * 2)
        s += 0.55 + 0.07 * rng.random()

    # 4) РЫК ЗОМБИ 35–42 с — модулированный низкий growl
    seg = int(7.0 * SR)
    tt = np.arange(seg) / SR
    f0 = 58 + 14 * np.sin(2 * np.pi * 0.9 * tt) + 6 * np.sin(2 * np.pi * 2.3 * tt)
    phase = 2 * np.pi * np.cumsum(f0) / SR
    growl = (np.sin(phase) * 0.55
             + band(rng.standard_normal(seg), 90, 700) * 0.5)
    growl *= (0.35 + 0.65 * np.abs(np.sin(2 * np.pi * 0.55 * tt)))
    growl *= np.clip(tt / 1.2, 0, 1) * np.clip((7.0 - tt) / 1.5, 0, 1) * 0.75
    place(L, 35.0, growl)
    place(R, 35.0, np.roll(growl, int(0.02 * SR)) * 0.9)
    # скрежет выше
    rasp = band(rng.standard_normal(seg), 900, 3200) * 0.10
    rasp *= np.clip(tt / 2.0, 0, 1) * np.clip((7.0 - tt) / 2.0, 0, 1)
    place(L, 36.0, rasp)
    place(R, 36.5, rasp)

    # 5) Крик/стеклянный взрыв на 38 с («Они выходят»)
    nlen = int(1.4 * SR)
    tt = np.arange(nlen) / SR
    crash = (band(rng.standard_normal(nlen), 1200, 9000) * 0.6 * np.exp(-tt * 6)
             + np.sin(2 * np.pi * 2100 * tt * (1 + 0.3 * np.sin(2 * np.pi * 7 * tt)))
             * 0.12 * np.exp(-tt * 8))
    place(L, 38.0, crash)
    place(R, 38.05, crash * 0.85)

    # 6) Погоня 42–52 с: частые бегающие шаги + дыхание
    s = 42.0
    k = 0
    while s < 51.0:
        k += 1
        nlen = int(0.2 * SR)
        tt = np.arange(nlen) / SR
        run = band(rng.standard_normal(nlen), 100, 900) * 0.34 * np.exp(-tt * 30)
        side = 0.6 if k % 2 else 0.4
        place(L, s, run * side * 2)
        place(R, s, run * (1 - side) * 2)
        s += 0.30 + 0.04 * rng.random()
    brth_n = int(0.9 * SR)
    tb = np.arange(brth_n) / SR
    breath = band(rng.standard_normal(brth_n), 300, 1800) * 0.16 * np.sin(np.pi * tb / 0.9) ** 2
    for st in (43.2, 45.1, 47.4, 49.3):
        place(L, st, breath)
        place(R, st + 0.05, breath * 0.8)

    # 7) Орда («Их — тысячи») 47–52 с — далёкий гул толпы
    crowd_n = int(5.0 * SR)
    tc = np.arange(crowd_n) / SR
    crowd = band(rng.standard_normal(crowd_n), 150, 1100) * 0.30
    crowd *= np.clip(tc / 2.0, 0, 1) * np.clip((5.0 - tc) / 1.0, 0, 1)
    place(L, 47.0, crowd)
    place(R, 47.0, np.roll(crowd, int(0.03 * SR)))

    # 8) Финал: раскат после дропа 52–58 с + вспышка огня
    fire_n = int(6.0 * SR)
    tf = np.arange(fire_n) / SR
    fire = band(rng.standard_normal(fire_n), 700, 5200) * 0.10
    fire *= np.clip(tf / 1.5, 0, 1) * np.clip((6.0 - tf) / 2.5, 0, 1)
    rumble = band(rng.standard_normal(fire_n), 30, 120) * 0.35
    rumble *= np.clip(tf / 2.0, 0, 1) * np.clip((6.0 - tf) / 1.5, 0, 1)
    place(L, 52.0, fire + rumble)
    place(R, 52.1, fire * 0.9 + rumble)

    # нормализация
    for ch in (L, R):
        p = np.max(np.abs(ch)) or 1.0
        if p > 0.98:
            ch /= p
    stereo = np.stack([L, R], axis=1)
    save_wav(os.path.join(AUDIO_DIR, "sfx.wav"), stereo)


if __name__ == "__main__":
    os.makedirs(AUDIO_DIR, exist_ok=True)
    make_music()
    make_sfx()
    print("make_audio: готово")
