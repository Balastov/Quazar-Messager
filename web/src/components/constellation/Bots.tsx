import { useCallback, useEffect, useState } from "react";
import { starsApi, type BotButton, type StarBot, type StarBotSecrets, type StarDetail, type StarMessage } from "../../api/stars";
import { formatWhen } from "../../chat/when";
import { notifyInfo } from "../../notifications/notify";
import { apiError } from "./rules";
import s from "./Constellation.module.css";
import g from "./Gaming.module.css";
import w from "./Work.module.css";
import b from "./Bots.module.css";

/** Кнопки под сообщением бота: нажатие уходит боту, он может обновить сообщение и ответить всплывашкой. */
export function BotButtons({ starId, message }: { starId: string; message: StarMessage }) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!message.buttons?.length) return null;

  const press = async (button: BotButton) => {
    setPending(button.id);
    setError(null);
    try {
      const res = await starsApi.pressButton(starId, message.channel_id, message.id, button.id);
      if (res.notice) notifyInfo({ title: message.bot_name ?? "Бот", body: res.notice });
    } catch (err) {
      setError(apiError(err, "Бот не ответил"));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className={b.buttons}>
      {message.buttons.map((btn) => (
        <button
          key={btn.id}
          type="button"
          className={`${b.button} ${btn.style === "primary" ? b.primary : btn.style === "danger" ? b.danger : ""}`}
          disabled={pending !== null}
          onClick={(e) => {
            e.stopPropagation();
            void press(btn);
          }}
        >
          {pending === btn.id ? "…" : btn.label}
        </button>
      ))}
      {error && <span className={b.error}>{error}</span>}
    </div>
  );
}

/** Токен и секрет подписи — показываем один раз, сразу после создания или перевыпуска. */
function SecretsCard({ secrets, onClose }: { secrets: StarBotSecrets; onClose: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (key: string, value: string) =>
    void navigator.clipboard
      ?.writeText(value)
      .then(() => setCopied(key))
      .catch(() => {});
  return (
    <div className={b.secrets}>
      <b>Сохраните сейчас — больше их не покажем</b>
      {(
        [
          ["token", "Токен Bot API", secrets.token],
          ["secret", "Секрет подписи событий", secrets.signing_secret],
        ] as const
      ).map(([key, label, value]) => (
        <div key={key} className={b.secretRow}>
          <span className={s.hint}>{label}</span>
          <code>{value}</code>
          <button type="button" className={`${s.secondary} ${s.small}`} onClick={() => copy(key, value)}>
            {copied === key ? "Скопировано" : "Копировать"}
          </button>
        </div>
      ))}
      <button type="button" className={`${s.secondary} ${s.small}`} onClick={onClose}>
        Готово
      </button>
    </div>
  );
}

const API = `${window.location.origin}/api/bot-api`;

/** Коротко, как подключить: адреса, заголовки, формат событий и ответа на нажатие. */
function BotGuide() {
  return (
    <details className={b.guide}>
      <summary>Как подключить бота</summary>
      <p>
        Все запросы — с заголовком <code>Authorization: Bearer &lt;токен&gt;</code>, тело — JSON.
      </p>
      <pre>{`GET  ${API}/channels                     — Спутники Звезды
GET  ${API}/channels/<id>/messages        — последние сообщения
POST ${API}/channels/<id>/messages        — написать
     {"text": "Выкатить релиз?", "buttons": [
       {"id": "ok", "label": "Одобрить", "style": "primary"},
       {"id": "no", "label": "Отклонить", "style": "danger"}]}
PATCH  ${API}/messages/<id>  {"text": "…", "buttons": []}
DELETE ${API}/messages/<id>`}</pre>
      <p>
        События приходят POST'ом на адрес событий: <code>{"{\"type\": \"message\" | \"button\", …}"}</code>. Подпись —
        заголовок <code>X-Quazar-Signature: sha256=…</code> (HMAC-SHA256 тела с секретом подписи). На нажатие кнопки можно
        сразу ответить JSON <code>{"{\"text\": \"✅ Одобрено\", \"buttons\": [], \"notice\": \"Готово\"}"}</code> — сообщение
        обновится, а нажавший увидит notice. Не больше 30 сообщений и правок в минуту, до 5 кнопок.
      </p>
    </details>
  );
}

/** Раздел «Боты» настроек Звезды. */
export function BotsTab({ detail }: { detail: StarDetail }) {
  const [list, setList] = useState<StarBot[] | null>(null);
  const [secrets, setSecrets] = useState<StarBotSecrets | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => setList(await starsApi.bots(detail.id)), [detail.id]);
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

  return (
    <div className={g.form}>
      <p className={s.hint}>
        Бот пишет в Спутники этой Звезды через Bot API и получает события — новые сообщения и нажатия кнопок под
        его сообщениями («Одобрить / Отклонить»). Подойдёт для дежурств, согласований, CI и опросов.
      </p>
      <BotGuide />
      {secrets && <SecretsCard secrets={secrets} onClose={() => setSecrets(null)} />}
      {list?.map((bot) => (
        <BotCard key={bot.id} detail={detail} bot={bot} busy={busy} run={run} onSecrets={setSecrets} />
      ))}
      {list && list.length === 0 && <p className={s.hint}>Ботов пока нет.</p>}

      <h4 className={w.sectionTitle}>Новый бот</h4>
      <label className={s.label}>
        Имя в Спутниках
        <input className={s.input} value={name} maxLength={48} placeholder="Дежурный, Деплой, Согласования" onChange={(e) => setName(e.target.value)} />
      </label>
      <label className={s.label}>
        Адрес событий (необязательно)
        <input className={s.input} value={url} placeholder="https://bot.example.com/quazar" onChange={(e) => setUrl(e.target.value)} />
        <span className={s.hint}>Сюда придут новые сообщения и нажатия кнопок. Без адреса бот только пишет.</span>
      </label>
      {error && <div className={s.error}>{error}</div>}
      <button
        type="button"
        className={s.primary}
        disabled={busy || !name.trim()}
        onClick={() =>
          void run(async () => {
            setSecrets(await starsApi.createBot(detail.id, { name: name.trim(), events_url: url.trim() || null, message_events: true }));
            setName("");
            setUrl("");
          })
        }
      >
        Создать и получить токен
      </button>
    </div>
  );
}

function BotCard({
  detail,
  bot,
  busy,
  run,
  onSecrets,
}: {
  detail: StarDetail;
  bot: StarBot;
  busy: boolean;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  onSecrets: (secrets: StarBotSecrets) => void;
}) {
  const [url, setUrl] = useState(bot.events_url ?? "");
  useEffect(() => setUrl(bot.events_url ?? ""), [bot.events_url]);
  const save = (patch: Partial<{ events_url: string | null; message_events: boolean }>) =>
    run(() =>
      starsApi.updateBot(detail.id, bot.id, {
        name: bot.name,
        events_url: bot.events_url,
        message_events: bot.message_events,
        ...patch,
      })
    );
  return (
    <div className={w.hookCard}>
      <div className={s.row}>
        <b>🤖 {bot.name}</b>
        <span className={s.hint}>
          {bot.last_used_at ? `Активен ${formatWhen(bot.last_used_at)}` : "Ещё не работал"}
          {bot.last_error ? ` · ошибка: ${bot.last_error}` : ""}
        </span>
      </div>
      <div className={s.row}>
        <input
          className={s.input}
          style={{ flex: 1 }}
          value={url}
          placeholder="Адрес событий — пусто, если бот только пишет"
          onChange={(e) => setUrl(e.target.value)}
          aria-label="Адрес событий"
        />
        {url.trim() !== (bot.events_url ?? "") && (
          <button type="button" className={`${s.primary} ${s.small}`} disabled={busy} onClick={() => void save({ events_url: url.trim() || null })}>
            Сохранить
          </button>
        )}
      </div>
      <label className={g.check}>
        <input
          type="checkbox"
          checked={bot.message_events}
          disabled={busy || !bot.events_url}
          onChange={(e) => void save({ message_events: e.target.checked })}
        />
        Присылать все новые сообщения (нажатия кнопок приходят всегда)
      </label>
      <div className={s.row}>
        <button
          type="button"
          className={`${s.secondary} ${s.small}`}
          disabled={busy}
          onClick={() => {
            if (window.confirm("Выпустить новый токен и секрет? Старые сразу перестанут работать.")) {
              void run(async () => onSecrets(await starsApi.reissueBotSecrets(detail.id, bot.id)));
            }
          }}
        >
          Новый токен
        </button>
        <button
          type="button"
          className={`${s.danger} ${s.small}`}
          disabled={busy}
          onClick={() => {
            if (window.confirm(`Удалить бота «${bot.name}»? Его сообщения останутся.`)) {
              void run(() => starsApi.deleteBot(detail.id, bot.id));
            }
          }}
        >
          Удалить
        </button>
      </div>
    </div>
  );
}
