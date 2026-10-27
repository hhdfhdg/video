# АПОКАЛИПСИС — вертикальное видео 1080x1920, 30 fps, 60 сек

Готовый проект автогенерации вертикального ролика про апокалипсис:
Canvas-визуал (Playwright-рендер покадрово) + озвучка **ElevenLabs
голосом Artem Lebedev** (speed 0.9 / stability 0.42 / similarity 0.75,
модель `eleven_multilingual_v2`) + процедурная музыка и SFX
(numpy/scipy) + крупные субтитры. Итог — `video.mp4` (H.264 + AAC).

## Структура

```
apocalypse_video/
├── index.html → web/index.html   # страница-превью (?t=<float>)
├── style.css  → web/style.css    # оформление превью
├── script.js  → web/script.js    # детерминированный рендер кадра на canvas
├── scenario.py                   # таймлайн реплик/субтитров (единый источник)
├── make_voice.py                 # ElevenLabs TTS (Artem Lebedev) -> voice/*.mp3 -> voice.wav
├── make_audio.py                 # numpy/scipy: music.wav + sfx.wav
├── mix_audio.py                  # ffmpeg amix: voice 1.0 + music 0.35 + sfx 0.7 -> audio_final.wav
├── render.py                     # Playwright chromium -> frames/%05d.png -> video.mp4
├── requirements.txt
└── README.md
```

## Быстрый старт

```bash
pip install -r requirements.txt
playwright install chromium          # ffmpeg системный или из imageio-ffmpeg

# 1) Ключ ElevenLabs (ОБЯЗАТЕЛЬНО, edge-tts не используется):
#    elevenlabs.io -> Profile -> API Keys -> скопировать ключ
echo "ELEVENLABS_API_KEY=sk_ВАШ_КЛЮЧ" > .env
#    Голос Artem Lebedev должен быть в аккаунте:
#    Voice Library -> поиск "Artem Lebedev" -> Add to My Voices
#    (make_voice.py сам найдёт его через client.voices.get_all();
#     можно задать напрямую: ARTEM_VOICE_ID=<id> в .env)

python make_voice.py    # voice/*.mp3 по репликам + voice.wav по таймкодам (adelay)
python make_audio.py    # audio/music.wav (эмбиент 60 с, бас-дроп на 52 с)
                        # audio/sfx.wav (удар 0:00, стук 22–26, шаги 26–30, рык 35–42)
python mix_audio.py     # audio_final.wav
python render.py        # 1800 кадров -> video.mp4
```

Тест одного акта без звука: `python render.py --act 2`

## Таймлайн (акты)

| Время | Содержание |
|---|---|
| 00:00–00:12 | Титр «ВО ВСЁМ ГОРОДЕ ПОГАС СВЕТ», город гаснет, пустая улица |
| 00:12–00:35 | Герой с фонариком, 6 правил (оружие, припасы, баррикада, слух, ожидание рассвета) |
| 00:35–00:52 | Шёпот «Я же не включал…», свет включается сам, дверь — зомби, погоня, крыша, «их тысячи» |
| 00:52–01:00 | Бас-дроп, город в огне, тизер Части 2 |

Стиль: палитра `#0a0a0a / #8a8a8a / #8b0000 / #d4a017`, зерно плёнки,
виньетка, glitch-артефакты; субтитры — крупный жирный белый с чёрной
обводкой в нижней трети.

## Пересборка одной командой

```bash
cd apocalypse_video && python make_voice.py && python make_audio.py \
  && python mix_audio.py && python render.py
```

## Замечания

* `make_voice.py` останавливается с инструкцией, если нет
  `ELEVENLABS_API_KEY` или голос «Artem Lebedev» не добавлен в My Voices
  (печатает список доступных голосов). Обход через edge-tts не предусмотрен.
* Реплики синтезируются отдельными mp3 (`voice/act1_00_00.mp3` и т.д.),
  сборка на таймлайн — ffmpeg `adelay`+`amix` в `voice.wav`.
* Повторный запуск `make_voice.py` не пересинтезирует уже готовые mp3
  (удалите `voice/` для полного пересинтеза).
* Для локального просмотра: откройте `web/index.html` (ползунок времени
  + live-play).
