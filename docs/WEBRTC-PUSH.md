# Web Push для входящих звонков (часть 2)

Когда PWA свёрнута или вкладка в фоне, входящий звонок приходит как **системное уведомление**.  
Если WebSocket уже оборван (типично на мобильном), сервер всё равно звонит, пока у абонента есть **push‑подписка**.

## Что сделано в коде

| Слой | Поведение |
|------|-----------|
| Local notify | При `call_invite` по WS — уведомление + рингтон, кнопки Принять/Отклонить |
| Web Push | VAPID → подписка в БД → push на invite, если WS нет |
| SW `sw.js` | `push` + `notificationclick` → открыть приложение / принять / отклонить |
| Сигналинг | Звонок не сразу `unavailable`, если есть push; таймаут звонка ~45 с; при reconnect — повторный invite |

## Настройка на сервере (один раз)

На Mac сгенерируйте ключи:

```bash
npx --yes web-push generate-vapid-keys
```

В `/opt/quazar/.env.prod` добавьте:

```bash
VAPID_PUBLIC_KEY=...   # Public Key
VAPID_PRIVATE_KEY=...  # Private Key
VAPID_SUBJECT=mailto:admin@quazar-msg.ru
CALL_RING_TIMEOUT_SEC=45
```

Перезапустите backend:

```bash
cd /opt/quazar
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build backend
```

Проверка: `GET /api/push/vapid-public-key` → `{ "configured": true, "publicKey": "..." }`.

## Клиент

1. Разрешите уведомления (баннер или Настройки).  
2. После логина приложение само вызывает `ensurePushSubscription()`.  
3. Сверните PWA / переключите вкладку → позвоните со второго аккаунта → должно прийти уведомление.  
4. Тап по уведомлению открывает приложение; «Принять» запускает accept.

## Ограничения iOS

На iPhone Web Push для PWA работает только если приложение **добавлено на домашний экран** и ОС ≥ 16.4. В обычном Safari в фоне push часто недоступен — это ограничение платформы, не бага Quazar.

## Дальше

- Часть 3: видеозвонки в web  
- Часть 4: звонки в native mobile (FCM/APNs надёжнее PWA на iOS)
