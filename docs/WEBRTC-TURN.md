# WebRTC TURN (часть 1) — звонки за NAT / мобильный интернет

Без **TURN** многие звонки между телефоном и домашним Wi‑Fi не устанавливаются: браузер не может пробить symmetric NAT.  
**STUN** (публичный Google) уже включён по умолчанию; для продакшена нужен **свой TURN** на `quazar-msg.ru`.

## Что добавлено в проект

| Компонент | Назначение |
|-----------|------------|
| `coturn` в `docker-compose.prod.yml` (profile `turn`) | relay‑сервер UDP/TCP :3478 |
| `deploy/coturn/turnserver.conf` | генерируется на сервере, не в git |
| `WEBRTC_*` в `.env.prod` | те же логин/пароль отдаёт API `/api/calls/ice-servers` |
| `deploy/scripts/setup-turn-secrets.sh` | однократно дописать секреты в `.env.prod` |
| `deploy/scripts/render-turn-config.sh` | собрать конфиг coturn из `.env.prod` |

## Однократная настройка на сервере

SSH на VM, каталог `/opt/quazar`:

```bash
cd /opt/quazar
git pull origin main

# если ещё нет TURN-переменных:
bash deploy/scripts/setup-turn-secrets.sh

nano .env.prod
# обязательно: TURN_EXTERNAL_IP=176.x.x.x   (публичный IPv4 этой VM)
```

Сгенерировать конфиг и поднять coturn:

```bash
bash deploy/scripts/render-turn-config.sh
docker compose -f docker-compose.prod.yml --env-file .env.prod --profile turn up -d --build
```

Открыть порты в firewall (пример UFW):

```bash
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 49152:49252/udp
```

Перезапустить backend, чтобы подхватил `WEBRTC_*`:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d backend
```

Автодеплой из GitHub (`remote-deploy.sh`) сам включает profile `turn`, если в `.env.prod` задан непустой `WEBRTC_TURN_CREDENTIAL`.

## Проверка

1. Войти в мессенджер, DevTools → Network → запрос `GET /api/calls/ice-servers` (с Authorization).  
   В ответе должны быть `iceServers` с **TURN** (`username` / `credential`), не только STUN.

2. Два пользователя: один с **мобильного LTE**, другой с Wi‑Fi → аудиозвонок 1:1.  
   Если без TURN «висит на Соединение…», с TURN обычно переходит в «Разговор».

3. На сервере: `docker compose -f docker-compose.prod.yml --env-file .env.prod logs coturn --tail 50`  
   при звонке должны появляться allocation/session записи.

## Переменные `.env.prod`

| Переменная | Пример |
|------------|--------|
| `TURN_EXTERNAL_IP` | публичный IPv4 VM |
| `TURN_REALM` | `quazar-msg.ru` (по умолчанию = `DOMAIN`) |
| `WEBRTC_STUN_URLS` | `stun:quazar-msg.ru:3478,stun:stun.l.google.com:19302` |
| `WEBRTC_TURN_URLS` | `turn:quazar-msg.ru:3478?transport=udp,turn:quazar-msg.ru:3478?transport=tcp` |
| `WEBRTC_TURN_USERNAME` | `quazar` |
| `WEBRTC_TURN_CREDENTIAL` | длинный секрет (`openssl rand -hex 24`) |

**Не коммитьте** `.env.prod` и `deploy/coturn/turnserver.conf`.

## Дальше (не часть 1)

- **TURNS** (TLS на 5349) — если корпоративные сети режут UDP  
- **Временные TURN‑credentials** (REST API coturn) вместо статического пароля  
- Push на входящий звонок (часть 2)
