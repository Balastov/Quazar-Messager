import { useCallback, useEffect, useState } from "react";
import { starsApi, webhookUrl, type StarDetail, type StarWebhook, type WebhookKind } from "../../api/stars";
import { formatWhen } from "../../chat/when";
import { apiError } from "./rules";
import s from "./Constellation.module.css";
import g from "./Gaming.module.css";
import w from "./Work.module.css";

const KIND_LABEL: Record<WebhookKind, string> = {
  auto: "Определять само",
  grafana: "Grafana",
  alertmanager: "Prometheus Alertmanager",
  github: "GitHub",
  gitlab: "GitLab",
  jira: "Jira",
  generic: "Свой JSON",
};

/** Где в сервисе вставить адрес. */
function Guide({ kind }: { kind: WebhookKind }) {
  switch (kind) {
    case "grafana":
      return (
        <ol className={w.guide}>
          <li>Grafana → Alerting → Contact points → «+ Add contact point».</li>
          <li>Integration: <b>Webhook</b>, URL — адрес ниже, метод POST. Сохраните и нажмите «Test».</li>
          <li>В Notification policies направьте нужные оповещения на этот contact point.</li>
        </ol>
      );
    case "alertmanager":
      return (
        <ol className={w.guide}>
          <li>В alertmanager.yml добавьте receiver с <code>webhook_configs: - url: &lt;адрес&gt;</code>.</li>
          <li>Направьте на него route и перезапустите Alertmanager.</li>
        </ol>
      );
    case "github":
      return (
        <ol className={w.guide}>
          <li>Репозиторий → Settings → Webhooks → Add webhook.</li>
          <li>Payload URL — адрес ниже, Content type — <b>application/json</b>.</li>
          <li>События: push, pull requests, issues, releases, workflow runs — что нужно.</li>
        </ol>
      );
    case "gitlab":
      return (
        <ol className={w.guide}>
          <li>Проект → Settings → Webhooks → Add new webhook, URL — адрес ниже.</li>
          <li>Триггеры: push, merge request, issues, pipeline, comments, releases.</li>
        </ol>
      );
    case "jira":
      return (
        <ol className={w.guide}>
          <li>Jira → Settings → System → WebHooks → Create a WebHook, URL — адрес ниже.</li>
          <li>События: Issue created / updated / deleted, Comment created.</li>
        </ol>
      );
    case "generic":
      return (
        <p className={s.hint}>
          POST с JSON <code>{'{"text": "Деплой v1.2 готов"}'}</code> (можно ещё <code>"title"</code>). Подойдут и
          вебхуки в стиле Slack и Discord — поля <code>text</code> и <code>content</code>.
        </p>
      );
    default:
      return (
        <p className={s.hint}>
          Сервис узнаём по запросу: GitHub, GitLab, Jira, Grafana, Alertmanager или свой JSON с полем{" "}
          <code>text</code>.
        </p>
      );
  }
}

function HookUrl({ hook }: { hook: StarWebhook }) {
  const [copied, setCopied] = useState(false);
  const url = webhookUrl(hook);
  return (
    <div className={w.hookUrl}>
      <code title={url}>{url}</code>
      <button
        type="button"
        className={`${s.secondary} ${s.small}`}
        onClick={() =>
          void navigator.clipboard
            ?.writeText(url)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
            .catch(() => {})
        }
      >
        {copied ? "Скопировано" : "Копировать"}
      </button>
    </div>
  );
}

/** Интеграции: события внешних сервисов сообщениями в Спутник. Тем, кто может создавать каналы. */
export function IntegrationsTab({ detail }: { detail: StarDetail }) {
  const satellites = detail.channels.filter((c) => c.kind === "satellite");
  const [hooks, setHooks] = useState<StarWebhook[] | null>(null);
  const [name, setName] = useState("Grafana");
  const [kind, setKind] = useState<WebhookKind>("grafana");
  const [channelId, setChannelId] = useState(satellites[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setHooks(await starsApi.webhooks(detail.id));
  }, [detail.id]);

  useEffect(() => {
    void reload().catch((err) => setError(apiError(err)));
  }, [reload]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(false);
    }
  };

  const channelName = (id: string) => detail.channels.find((c) => c.id === id)?.name ?? "удалённый Спутник";

  return (
    <div className={g.form}>
      <p className={s.hint}>
        События GitHub, GitLab, Jira, оповещения Grafana и Alertmanager или любой свой скрипт — сообщениями в
        Спутник. Адрес — как пароль: кто его знает, тот пишет в Спутник. Утёк — выпустите новый.
      </p>
      {hooks?.map((hook) => (
        <div key={hook.id} className={w.hookCard}>
          <div className={s.row}>
            <b>{hook.name}</b>
            <span className={s.hint}>
              {KIND_LABEL[hook.kind]} → #{channelName(hook.channel_id)}
            </span>
          </div>
          <HookUrl hook={hook} />
          <span className={s.hint}>
            {hook.last_used_at ? `Последнее событие: ${formatWhen(hook.last_used_at)}` : "Событий ещё не было"}
            {hook.last_error ? ` · пропущено: ${hook.last_error}` : ""}
          </span>
          <div className={s.row}>
            <button
              type="button"
              className={`${s.secondary} ${s.small}`}
              disabled={busy}
              onClick={() => {
                if (window.confirm("Выпустить новый адрес? Старый перестанет работать — его нужно будет заменить в сервисе.")) {
                  void run(() => starsApi.updateWebhook(detail.id, hook.id, { new_token: true }));
                }
              }}
            >
              Новый адрес
            </button>
            <button
              type="button"
              className={`${s.danger} ${s.small}`}
              disabled={busy}
              onClick={() => {
                if (window.confirm(`Удалить интеграцию «${hook.name}»? Сообщения останутся.`)) {
                  void run(() => starsApi.deleteWebhook(detail.id, hook.id));
                }
              }}
            >
              Удалить
            </button>
          </div>
        </div>
      ))}
      {hooks && hooks.length === 0 && <p className={s.hint}>Интеграций пока нет.</p>}

      <h4 className={w.sectionTitle}>Новая интеграция</h4>
      <label className={s.label}>
        Сервис
        <select
          className={s.select}
          value={kind}
          onChange={(e) => {
            const next = e.target.value as WebhookKind;
            if (name === KIND_LABEL[kind] || !name.trim()) setName(next === "auto" || next === "generic" ? "Интеграция" : KIND_LABEL[next]);
            setKind(next);
          }}
        >
          {(Object.keys(KIND_LABEL) as WebhookKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </label>
      <label className={s.label}>
        Имя в Спутнике
        <input className={s.input} value={name} maxLength={48} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className={s.label}>
        Спутник
        <select className={s.select} value={channelId} onChange={(e) => setChannelId(e.target.value)}>
          {satellites.map((c) => (
            <option key={c.id} value={c.id}>
              #{c.name}
            </option>
          ))}
        </select>
      </label>
      <Guide kind={kind} />
      {error && <div className={s.error}>{error}</div>}
      <button
        type="button"
        className={s.primary}
        disabled={busy || !name.trim() || !channelId}
        onClick={() => void run(() => starsApi.createWebhook(detail.id, channelId, { name: name.trim(), kind }))}
      >
        Создать и получить адрес
      </button>
    </div>
  );
}
