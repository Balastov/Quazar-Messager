import { useCallback, useEffect, useState } from "react";
import { adminApi, type AdminNews, type NewsText } from "../../api/admin";
import { formatWhen } from "../../chat/when";
import { apiError } from "../constellation/rules";
import s from "./BlackHole.module.css";

const MAX_TITLE = 100;
const MAX_CHANGE = 400;
const MAX_CHANGES = 20;

/** Так сообщение увидят люди — тот же формат, что у сервера. */
export function newsMessage(version: string, text: NewsText): string {
  return `Quazar ${version} · ${text.title.trim()}\n\n` + text.changes.map((change) => `• ${change.trim()}`).join("\n");
}

function problem(text: NewsText): string | null {
  if (!text.title.trim()) return "Добавьте заголовок";
  if (text.title.trim().length > MAX_TITLE) return `Заголовок длиннее ${MAX_TITLE} символов`;
  if (!text.changes.length) return "Нужен хотя бы один пункт";
  if (text.changes.length > MAX_CHANGES) return `Пунктов больше ${MAX_CHANGES} — объедините или уберите лишние`;
  if (text.changes.some((change) => !change.trim())) return "Есть пустой пункт — заполните или удалите его";
  if (text.changes.some((change) => change.trim().length > MAX_CHANGE)) return `Пункт длиннее ${MAX_CHANGE} символов`;
  return null;
}

const STATUS: Record<AdminNews["status"], string> = {
  draft: "Ждёт одобрения",
  published: "Опубликована",
  skipped: "Не публиковали",
  merged: "Объединена",
};

/**
 * Новости об обновлениях: деплой приносит черновик, его проверяют, правят и одобряют здесь.
 * Только после «Опубликовать» news_bot отправляет текст всем.
 */
export default function News({ onChange }: { onChange: () => void }) {
  const [items, setItems] = useState<AdminNews[] | null>(null);
  const [recipients, setRecipients] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    adminApi
      .news()
      .then((value) => {
        setItems(value.items);
        setRecipients(value.recipients);
      })
      .catch((err) => setError(apiError(err)));
  }, []);
  useEffect(load, [load]);

  const drafts = items?.filter((item) => item.status === "draft") ?? [];
  const history = items?.filter((item) => item.status !== "draft") ?? [];
  return (
    <>
      <p className={s.hint}>
        Текст новости приходит сюда при каждом выпуске. Пока вы его не опубликуете, пользователи ничего
        не получат. Если выпусков без одобрения несколько, их новости собираются в одну.
      </p>
      {error && <div className={s.error}>{error}</div>}
      {items && drafts.length === 0 && <p className={s.empty}>Новых черновиков нет</p>}
      {drafts.map((item) => (
        <Draft
          key={`${item.version}:${item.revision}`}
          item={item}
          recipients={recipients}
          onDone={() => {
            load();
            onChange();
          }}
        />
      ))}
      {history.length > 0 && <h3 className={s.sectionTitle}>Раньше</h3>}
      <div className={s.list}>
        {history.map((item) => (
          <details key={item.version} className={s.newsPast}>
            <summary>
              <b>Quazar {item.version}</b>
              <span className={item.status === "published" ? s.badge : `${s.badge} ${s.badgeMuted}`}>
                {STATUS[item.status]}
              </span>
              <span className={s.meta}>
                {item.status === "published" &&
                  `${item.published_at ? formatWhen(item.published_at) : ""}${item.published_by ? ` · @${item.published_by}` : ""} · доставлено ${item.sent} из ${item.total}`}
                {item.status === "merged" && `вошла в новость ${item.merged_into}`}
                {item.status === "skipped" && item.updated_by && `решил(а) @${item.updated_by}`}
              </span>
            </summary>
            <pre className={s.newsPreview}>{item.payload}</pre>
          </details>
        ))}
      </div>
    </>
  );
}

function Draft({ item, recipients, onDone }: { item: AdminNews; recipients: number; onDone(): void }) {
  const initial: NewsText = { title: item.title ?? "", changes: item.changes ?? [] };
  const [text, setText] = useState<NewsText>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const dirty = JSON.stringify(text) !== JSON.stringify(initial);
  const invalid = problem(text);

  const setChange = (index: number, value: string) =>
    setText((prev) => ({ ...prev, changes: prev.changes.map((c, i) => (i === index ? value.replace(/\s*\n\s*/g, " ") : c)) }));
  const move = (index: number, by: number) =>
    setText((prev) => {
      const changes = [...prev.changes];
      const [value] = changes.splice(index, 1);
      changes.splice(index + by, 0, value);
      return { ...prev, changes };
    });

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await fn();
      if (done) setNote(done);
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(false);
    }
  };
  /** Сохраняет правки, если они есть, и отдаёт актуальную ревизию. */
  const save = async () => (dirty ? (await adminApi.editNews(item.version, text, item.revision)).revision : item.revision);

  return (
    <section className={s.newsDraft} aria-label={`Черновик новости ${item.version}`}>
      <div className={s.name}>
        Quazar {item.version}
        <span className={`${s.badge} ${s.badgeWarn}`}>Ждёт одобрения</span>
      </div>
      <div className={s.meta}>
        {item.versions.length > 1 ? `Объединяет выпуски ${item.versions.join(", ")}` : "Один выпуск"}
        {item.updated_by && ` · правил(а) @${item.updated_by}${item.updated_at ? ` ${formatWhen(item.updated_at)}` : ""}`}
      </div>

      <label className={s.field}>
        <span className={s.fieldLabel}>Заголовок</span>
        <input
          className={s.input}
          value={text.title}
          maxLength={MAX_TITLE + 20}
          disabled={busy}
          onChange={(e) => setText((prev) => ({ ...prev, title: e.target.value }))}
        />
      </label>
      <div className={s.fieldLabel}>Что нового</div>
      <ol className={s.newsChanges}>
        {text.changes.map((change, index) => (
          <li key={index} className={s.newsChange}>
            <textarea
              className={s.input}
              aria-label={`Пункт ${index + 1}`}
              rows={2}
              value={change}
              disabled={busy}
              onChange={(e) => setChange(index, e.target.value)}
            />
            <span className={change.trim().length > MAX_CHANGE ? `${s.counter} ${s.counterOver}` : s.counter}>
              {change.trim().length}/{MAX_CHANGE}
            </span>
            <div className={s.newsChangeTools}>
              <button type="button" className={s.btn} disabled={busy || index === 0} onClick={() => move(index, -1)} aria-label="Выше">
                ↑
              </button>
              <button
                type="button"
                className={s.btn}
                disabled={busy || index === text.changes.length - 1}
                onClick={() => move(index, 1)}
                aria-label="Ниже"
              >
                ↓
              </button>
              <button
                type="button"
                className={s.btn}
                disabled={busy}
                onClick={() => setText((prev) => ({ ...prev, changes: prev.changes.filter((_, i) => i !== index) }))}
                aria-label="Удалить пункт"
              >
                ✕
              </button>
            </div>
          </li>
        ))}
      </ol>
      <div className={s.actions}>
        <button
          type="button"
          className={s.btn}
          disabled={busy || text.changes.length >= MAX_CHANGES}
          onClick={() => setText((prev) => ({ ...prev, changes: [...prev.changes, ""] }))}
        >
          + Добавить пункт
        </button>
      </div>

      <div className={s.fieldLabel}>Так увидят пользователи</div>
      <pre className={s.newsPreview}>{newsMessage(item.version, text)}</pre>

      {invalid && <div className={s.error}>{invalid}</div>}
      {error && <div className={s.error}>{error}</div>}
      {note && <div className={s.ok}>{note}</div>}
      <div className={s.actions}>
        <button
          type="button"
          className={`${s.btn} ${s.btnPrimary}`}
          disabled={busy || !!invalid}
          onClick={() => {
            if (!window.confirm(`Отправить новость о Quazar ${item.version} всем пользователям (${recipients.toLocaleString("ru-RU")})? После этого изменить её будет нельзя.`)) return;
            void run(async () => {
              await adminApi.publishNews(item.version, await save());
              onDone();
            });
          }}
        >
          Опубликовать
        </button>
        <button type="button" className={s.btn} disabled={busy || !dirty || !!invalid} onClick={() => void run(async () => { await save(); onDone(); })}>
          Сохранить
        </button>
        <button
          type="button"
          className={s.btn}
          disabled={busy || !!invalid}
          onClick={() => void run(() => adminApi.testNews(item.version, text), "Проба отправлена вам в чат Quazar_news_bot — придёт через несколько секунд")}
        >
          Отправить себе на пробу
        </button>
        {dirty && (
          <button type="button" className={s.btn} disabled={busy} onClick={() => setText(initial)}>
            Отменить правки
          </button>
        )}
        <button
          type="button"
          className={`${s.btn} ${s.btnDanger}`}
          disabled={busy}
          onClick={() => {
            if (!window.confirm(`Не публиковать новость о Quazar ${item.version}? Она не уйдёт пользователям и не войдёт в следующую.`)) return;
            void run(async () => {
              await adminApi.skipNews(item.version, item.revision);
              onDone();
            });
          }}
        >
          Не публиковать
        </button>
      </div>
    </section>
  );
}
