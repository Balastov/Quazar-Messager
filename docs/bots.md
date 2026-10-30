# Боты Quazar: Bot API и исходящие события

Бот принадлежит Звезде: пишет в её Спутники, читает их и получает события — новые сообщения и
нажатия кнопок под своими сообщениями. Создаётся в настройках Звезды → «Боты» (нужно право
«Каналы»). Токен и секрет подписи показываются один раз; потерялись — «Новый токен».

Базовый адрес: `https://quazar-msg.ru/api/bot-api`

Каждый запрос — с заголовком:

```
Authorization: Bearer qzb.<id>.<secret>
```

## Методы

| Метод | Путь | Что делает |
|---|---|---|
| GET | `/me` | Бот и его Звезда |
| GET | `/channels` | Спутники Звезды: `[{id, name, announcement}]` |
| GET | `/channels/{channel_id}/messages?limit=20` | Последние сообщения (до 100), старые первыми |
| POST | `/channels/{channel_id}/messages` | Написать сообщение |
| PATCH | `/messages/{message_id}` | Исправить своё сообщение: текст и/или кнопки |
| DELETE | `/messages/{message_id}` | Удалить своё сообщение |

Тело `POST /channels/{id}/messages`:

```json
{
  "text": "Выкатить **0.9.0** на прод?",
  "thread_id": null,
  "reply_to_id": null,
  "buttons": [
    {"id": "approve", "label": "Одобрить", "style": "primary"},
    {"id": "reject", "label": "Отклонить", "style": "danger"}
  ]
}
```

- `text` — до 4000 символов, с разметкой сообщений (`**жирный**`, `` `код` ``, блоки кода…) и
  `@упоминаниями` участников Звезды.
- `buttons` — до 5 кнопок; `id` — латиница, цифры, `_ . : -` (до 64), `label` — до 40 символов,
  `style` — `default` | `primary` | `danger`. В `PATCH` `"buttons": []` убирает кнопки, отсутствие
  поля — оставляет как есть.
- Не больше 30 сообщений и правок в минуту на бота (иначе 429).

## События

Если у бота указан адрес событий, сервер шлёт на него `POST` с JSON:

```http
POST /quazar HTTP/1.1
Content-Type: application/json
X-Quazar-Event: message
X-Quazar-Signature: sha256=5d41402abc4b2a76b9719d911017c592...
X-Quazar-Delivery: 9f8e7d6c5b4a3210
```

**message** — новое сообщение в Спутнике Звезды (кроме сообщений самого бота; можно выключить
в настройках бота):

```json
{"type": "message", "bot_id": "…", "star_id": "…", "channel_id": "…",
 "message": {"id": "…", "text": "…", "sender": {"id": "…", "username": "anna_dev", …}, …},
 "sent_at": "2026-10-31T10:00:00+00:00"}
```

**button** — участник нажал кнопку под сообщением бота:

```json
{"type": "button", "bot_id": "…", "star_id": "…", "channel_id": "…",
 "message_id": "…", "button_id": "approve",
 "user": {"id": "…", "username": "boris_ops", "display_name": "Борис"},
 "sent_at": "…"}
```

На `button` можно ответить сразу (за 5 секунд) JSON-объектом — сообщение обновится у всех, а
нажавший увидит `notice`:

```json
{"text": "✅ Выкатку одобрил @boris_ops", "buttons": [], "notice": "Принято"}
```

Ответ не JSON или пустой — сообщение не меняется (можно обновить его позже через `PATCH`).
Ответ с ошибкой (4xx/5xx), переадресация или таймаут — нажавший увидит «Бот не обработал
нажатие», а в настройках бота — последнюю ошибку.

Адрес событий — только публичный `http(s)`: внутренние адреса (localhost, 10.x, 192.168.x и т. п.)
сервер не вызывает, переадресации не выполняет.

## Проверка подписи

`X-Quazar-Signature` — `sha256=` + HMAC-SHA256 тела запроса с секретом подписи бота. Проверяйте
её по сырому телу, до разбора JSON:

```python
import hashlib, hmac, json
from flask import Flask, request, abort, jsonify

SECRET = b"…секрет подписи…"
app = Flask(__name__)

@app.post("/quazar")
def events():
    expected = "sha256=" + hmac.new(SECRET, request.get_data(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, request.headers.get("X-Quazar-Signature", "")):
        abort(401)
    event = json.loads(request.get_data())
    if event["type"] == "button" and event["button_id"] == "approve":
        who = event["user"]["username"]
        return jsonify(text=f"✅ Одобрил @{who}", buttons=[], notice="Принято")
    if event["type"] == "button" and event["button_id"] == "reject":
        return jsonify(text="⛔ Отклонено", buttons=[])
    return "", 204
```

Отправить сообщение с кнопками:

```bash
curl -X POST https://quazar-msg.ru/api/bot-api/channels/$CHANNEL/messages \
  -H "Authorization: Bearer $QUAZAR_BOT_TOKEN" -H "Content-Type: application/json" \
  -d '{"text": "Выкатить релиз?", "buttons": [{"id": "approve", "label": "Одобрить", "style": "primary"}, {"id": "reject", "label": "Отклонить", "style": "danger"}]}'
```
