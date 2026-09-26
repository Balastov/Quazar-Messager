# Деплой Quazar Messager на quazar-msg.ru

Пошаговая инструкция для новичка. Делай шаги **по порядку**. После каждого шага
можно писать ассистенту результат (скопируй вывод терминала).

Итоговый адрес: **https://quazar-msg.ru**

---

## Что понадобится

1. IP-адрес виртуальной машины (например `203.0.113.10`)
2. SSH-доступ (логин `root` или `ubuntu`, пароль или ключ)
3. Email для Let's Encrypt (любой твой email)
4. Доступ к панели DNS домена `quazar-msg.ru` (где покупал домен)

---

## Шаг 1. DNS — привязать домен к серверу

В панели регистратора домена создай **A-записи**:

| Имя / Host | Тип | Значение |
|------------|-----|----------|
| `@` или `quazar-msg.ru` | A | IP твоей VM |
| `www` | A | IP твоей VM |

Подожди 5–30 минут. Проверка с Mac:

```bash
dig +short quazar-msg.ru
```

Должен вернуться IP сервера. Если пусто — DNS ещё не обновился.

---

## Шаг 2. Зайти на сервер по SSH

С Mac в Terminal:

```bash
ssh root@IP_СЕРВЕРА
```

или

```bash
ssh ubuntu@IP_СЕРВЕРА
```

Если спросит про fingerprint — напиши `yes`.

Проверь ОС:

```bash
cat /etc/os-release | head -5
```

Инструкция ниже рассчитана на **Ubuntu 22.04 / 24.04**.

---

## Шаг 3. Установить Docker

На сервере выполни:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker $USER
```

Выйди из SSH (`exit`) и зайди снова, чтобы группа `docker` применилась.

Проверка:

```bash
docker --version
docker compose version
```

---

## Шаг 4. Открыть порты 80 и 443

**В панели хостинга / облака** (Security Group / Firewall) разреши входящие:

- TCP **22** (SSH)
- TCP **80** (HTTP / Let's Encrypt)
- TCP **443** (HTTPS)

На самой Ubuntu (если включён ufw):

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

---

## Шаг 5. Скачать проект

```bash
sudo apt-get install -y git
cd /opt
sudo git clone https://github.com/Balastov/Quazar-Messager.git quazar
sudo chown -R $USER:$USER /opt/quazar
cd /opt/quazar
```

Если репозиторий приватный — сначала настрой SSH-ключ GitHub или Personal Access Token.

Убедись, что на сервере есть свежий код с `docker-compose.prod.yml`:

```bash
ls docker-compose.prod.yml .env.prod.example docs/DEPLOY.md
```

---

## Шаг 6. Создать секреты `.env.prod`

```bash
cd /opt/quazar
cp .env.prod.example .env.prod
nano .env.prod
```

Замени:

1. `POSTGRES_PASSWORD` — длинный случайный пароль  
2. `JWT_SECRET` — сгенерируй так:

```bash
openssl rand -hex 32
```

Вставь результат в `JWT_SECRET=...`

3. `LETSENCRYPT_EMAIL` — твой email  
4. `DOMAIN=quazar-msg.ru` — оставь как есть  

Сохрани в nano: `Ctrl+O`, Enter, `Ctrl+X`.

Проверка, что файл не в git:

```bash
grep -n PASSWORD .env.prod
# не коммить этот файл!
```

---

## Шаг 7. Запустить контейнеры

```bash
cd /opt/quazar
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

Первый запуск может занять несколько минут (сборка frontend/backend).

Статус:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod ps
docker compose -f docker-compose.prod.yml --env-file .env.prod logs --tail=50
```

Все сервисы `postgres`, `backend`, `web`, `nginx` должны быть `Up`.

Открой в браузере `https://quazar-msg.ru` — может быть предупреждение о сертификате (временный self-signed). Это нормально до шага 8.

---

## Шаг 8. Настоящий HTTPS (Let's Encrypt)

DNS уже должен указывать на сервер (шаг 1), порты 80/443 открыты.

```bash
cd /opt/quazar
bash deploy/scripts/get-cert.sh
```

Если успех — браузер откроет сайт **без** предупреждения о сертификате.

Продление сертификата (раз в ~2 месяца или по cron):

```bash
cd /opt/quazar
bash deploy/scripts/get-cert.sh
```

Пример cron (раз в месяц, 03:00):

```bash
crontab -e
```

Добавь строку:

```
0 3 1 * * cd /opt/quazar && bash deploy/scripts/get-cert.sh >> /var/log/quazar-cert.log 2>&1
```

---

## Шаг 9. Проверка мессенджера

1. Открой https://quazar-msg.ru  
2. Зарегистрируй двух пользователей (два окна / два браузера)  
3. Найди друг друга, напиши сообщение  
4. Убедись, что сообщения приходят в реальном времени (WebSocket)  
5. В сайдбаре 🔐 — создай резервную копию ключей  

Если сообщения не live — проверь в DevTools → Network → WS, должен быть `wss://quazar-msg.ru/ws`.

---

## Обновление кода после изменений

На сервере:

```bash
cd /opt/quazar
git pull
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

---

## Полезные команды

```bash
# Логи API
docker compose -f docker-compose.prod.yml --env-file .env.prod logs -f backend

# Логи nginx
docker compose -f docker-compose.prod.yml --env-file .env.prod logs -f nginx

# Остановить всё
docker compose -f docker-compose.prod.yml --env-file .env.prod down

# Остановить и УДАЛИТЬ базу (осторожно!)
docker compose -f docker-compose.prod.yml --env-file .env.prod down -v
```

---

## Частые проблемы

| Симптом | Что проверить |
|---------|----------------|
| `dig` не показывает IP | DNS ещё не обновился / неверная A-запись |
| Certbot: connection refused / timeout | Порт 80 закрыт в firewall / DNS не на эту VM |
| 502 Bad Gateway | `docker compose ... logs backend` — API не поднялся |
| Сайт открывается, чат не обновляется | WebSocket / прокси `/ws` — смотри логи nginx |
| CORS ошибки | В `.env.prod` должен быть `CORS_ORIGINS=https://quazar-msg.ru,...` |

---

## Архитектура

- `https://quazar-msg.ru/` → React (контейнер `web`)
- `https://quazar-msg.ru/api/...` → FastAPI (`backend`)
- `wss://quazar-msg.ru/ws` → WebSocket FastAPI
- PostgreSQL только внутри Docker-сети (снаружи не открыт)
