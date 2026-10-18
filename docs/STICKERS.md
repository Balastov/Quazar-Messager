# Стикеры

Стикер — Lottie-анимация из стикерпака. В чат уходит обычное сообщение с текстом
`STK1:<pack>/<id>` (например, `STK1:noto/1f602`):

- в личных чатах оно шифруется как любое сообщение — сервер не знает, что отправили стикер;
- клиенты по паку и id находят анимацию и рисуют её без «пузыря»;
- в списке чатов и уведомлениях — «Стикер 😂»;
- старые версии мобильного приложения покажут текст `STK1:…` как есть.

## Где что

| Часть | Файлы |
|---|---|
| Паки | `backend/stickers/<pack_id>/` — `manifest.json`, анимации `*.json`, лицензия |
| Каталог | `GET /stickers/packs` — паки пользователя (сейчас: все паки с `"default": true`) |
| Анимации | `GET /stickers/files/<pack>/<file>?v=<version>` — кэш навсегда (`immutable`) |
| Веб | `web/src/components/Sticker.tsx` (lottie-web, сборка `lottie_light` без `eval` — её пропускает CSP), `StickerPicker.tsx` |
| Мобильное | `mobile/src/components/Sticker.tsx` (lottie-react-native), `StickerPanel.tsx` |

## Паки

**Noto Emoji** (по умолчанию у всех) — анимированные эмодзи Google,
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Автор указан в панели стикеров и в
`backend/stickers/noto/ATTRIBUTION.md`. Пересобрать: `python scripts/sticker_pack.py noto`
(список эмодзи — `NOTO_EMOJI` в скрипте).

## Добавить свой пак

Нужны права на распространение стикеров в мессенджере. Пак из Telegram (`.tgs`) или Lottie
(`.json`):

```bash
cd backend
python scripts/sticker_pack.py import ./путь/к/папке --id my_pack --title "Мой пак" \
    --author "Автор" --license "CC BY 4.0" --license-url https://... [--default]
```

Эмодзи стикера берётся из начала имени файла («😂_laugh.tgs»). Если меняете файлы уже
выложенного пака — увеличьте `--version`, иначе браузеры покажут старые анимации из кэша.
Удалять пак, которым уже пользовались, не стоит: такие сообщения превратятся в «Стикер недоступен».
