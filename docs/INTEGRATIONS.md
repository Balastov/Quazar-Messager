# Интеграции: события внешних сервисов в Спутник

Настройки Звезды → «Интеграции» (тем, кто может создавать каналы). Создаёте интеграцию — получаете
адрес вида `https://quazar-msg.ru/api/hooks/<id>/<токен>` и вставляете его в настройки сервиса.
События приходят в выбранный Спутник сообщениями от имени интеграции (с пометкой «бот»).

Адрес — как пароль: кто его знает, тот пишет в Спутник. Утёк — «Новый адрес» (старый перестанет
работать). Удалили интеграцию — её прошлые сообщения остаются.

## Grafana

1. Grafana → Alerting → Contact points → «+ Add contact point».
2. Integration: **Webhook**, URL — адрес из Quazar, метод POST. «Test» — в Спутник придёт тестовое оповещение.
3. Notification policies — направить на этот contact point нужные правила.

Сообщение: `🔥 Сработало: <название>` или `✅ Решено: …`, затем до пяти оповещений — `alertname · instance ·
severity — summary` и ссылка на дашборд или правило. Старый формат Grafana (до unified alerting —
`title`, `state`, `ruleUrl`) тоже понимаем.

## Prometheus Alertmanager

В `alertmanager.yml`:

```yaml
receivers:
  - name: quazar
    webhook_configs:
      - url: https://quazar-msg.ru/api/hooks/<id>/<токен>
```

## GitHub, GitLab, Jira

| Сервис | Где настроить | Что показываем |
|---|---|---|
| GitHub | Settings → Webhooks, Content type `application/json` | push, PR (открыт, закрыт, слит, на ревью), issues, комментарии, релизы, workflow runs |
| GitLab | Settings → Webhooks | push и теги, MR, issues, комментарии, пайплайны (успех, ошибка, отмена), релизы |
| Jira | Settings → System → WebHooks | задача создана, изменена (что поменялось), удалена; новый комментарий |

Остальные события сервисов принимаем без сообщения (сервис не считает доставку сбоем), причину видно
в настройках интеграции: «пропущено: …».

## Свой скрипт

```bash
curl -X POST -H 'Content-Type: application/json' \
  -d '{"title": "Деплой", "text": "v1.2 выкачен на прод"}' \
  https://quazar-msg.ru/api/hooks/<id>/<токен>
```

Поле `text` (или `content`, `message` — как у Slack и Discord), необязательный `title`. Не JSON —
тело целиком станет текстом.

## Ограничения

- До 30 сообщений в минуту на интеграцию (дальше — 429), тело до 256 КБ, текст до 4000 символов.
- До 25 интеграций в Звезде.
- Уведомления — как о любом сообщении Спутника (по уровню уведомлений; см. `docs/NOTIFICATIONS.md`).
  Чтобы получать push о каждом оповещении, поставьте Спутнику с оповещениями «Все сообщения».

Код: `backend/app/core/webhooks.py` (разбор событий), `backend/app/api/webhooks.py`,
`web/src/components/constellation/Integrations.tsx`.
