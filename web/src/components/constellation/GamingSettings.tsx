import { useCallback, useEffect, useRef, useState } from "react";
import { starsApi, type AssetKind, type AuditEntry, type StarAsset, type StarDetail, type StarTag } from "../../api/stars";
import { useStarsStore } from "../../store/stars";
import { formatWhen } from "../../chat/when";
import { apiError } from "./rules";
import { TagChip } from "./MyTags";
import { auditText } from "./audit";
import { BUILTIN_SOUNDS } from "./soundboard";
import s from "./Constellation.module.css";
import g from "./Gaming.module.css";

function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>, doneText?: string) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await fn();
      if (doneText) setDone(doneText);
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(false);
    }
  }, []);
  const status = (
    <>
      {error && <div className={s.error}>{error}</div>}
      {done && <div className={s.ok}>{done}</div>}
    </>
  );
  return { busy, run, status };
}

/** Правила, приветствие новичков, запрещённые слова, звуковая панель. */
export function CommunityTab({ detail }: { detail: StarDetail }) {
  const satellites = detail.channels.filter((c) => c.kind === "satellite");
  const [rules, setRules] = useState(detail.rules_text ?? "");
  const [welcomeChannel, setWelcomeChannel] = useState(detail.welcome_channel_id ?? "");
  const [welcome, setWelcome] = useState(detail.welcome_text ?? "");
  const [words, setWords] = useState((detail.banned_words ?? []).join("\n"));
  const [soundboard, setSoundboard] = useState(detail.soundboard ?? true);
  const { busy, run, status } = useRun();

  const save = () =>
    run(
      () =>
        starsApi.community(detail.id, {
          rules_text: rules.trim() || null,
          welcome_channel_id: welcomeChannel || null,
          welcome_text: welcome.trim() || null,
          banned_words: words.split(/[\n,]/).map((w) => w.trim()).filter(Boolean),
          soundboard,
        }),
      "Сохранено"
    );

  return (
    <div className={g.form}>
      <label className={s.label}>
        Правила
        <textarea className={s.input} rows={6} maxLength={4000} value={rules} onChange={(e) => setRules(e.target.value)} placeholder="Без оскорблений и спама. Ссылки на читы — бан." />
        <span className={s.hint}>
          Новички видят их вместо поля ввода и пишут только после «Согласен». Поменяете текст — согласиться
          нужно будет заново. Модераторов и выше это не касается.
        </span>
      </label>
      <label className={s.label}>
        Приветствовать новичков в Спутнике
        <select className={s.select} value={welcomeChannel} onChange={(e) => setWelcomeChannel(e.target.value)}>
          <option value="">Не приветствовать</option>
          {satellites.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {welcomeChannel && (
        <label className={s.label}>
          Текст приветствия
          <input className={s.input} maxLength={300} value={welcome} onChange={(e) => setWelcome(e.target.value)} placeholder="Встречайте {name} — теперь в Звезде!" />
          <span className={s.hint}>{"{name}"} заменится на имя новичка.</span>
        </label>
      )}
      <label className={s.label}>
        Запрещённые слова
        <textarea className={s.input} rows={4} value={words} onChange={(e) => setWords(e.target.value)} placeholder={"по слову или фразе в строке"} />
        <span className={s.hint}>Сообщения с ними не отправятся (у всех, кроме владельца и админов). Слово ищется целиком, регистр и «ё» не важны.</span>
      </label>
      <label className={g.check}>
        <input type="checkbox" checked={soundboard} onChange={(e) => setSoundboard(e.target.checked)} />
        Звуковая панель на Планетах
      </label>
      {status}
      <button type="button" className={s.primary} disabled={busy} onClick={() => void save()}>
        Сохранить
      </button>
    </div>
  );
}

const PALETTE = ["#f87171", "#fb923c", "#facc15", "#4ade80", "#22d3ee", "#60a5fa", "#a78bfa", "#f472b6"];

/** Свои роли с цветами: создать, переименовать, удалить; можно ли брать себе самому. */
export function TagsTab({ detail }: { detail: StarDetail }) {
  const tags = detail.tags ?? [];
  const [name, setName] = useState("");
  const [color, setColor] = useState(PALETTE[6]);
  const [selfAssign, setSelfAssign] = useState(false);
  const { busy, run, status } = useRun();

  return (
    <div className={g.form}>
      <p className={s.hint}>
        Роли с цветом — подписи: цвет имени в Спутниках, отметка в списке участников. Права даёт только
        встроенная роль (участник, модератор, админ). «Можно взять себе» — участник выберет сам в правилах
        или в списке участников.
      </p>
      {tags.map((t) => (
        <TagRow key={t.id} detail={detail} tag={t} />
      ))}
      <div className={s.row}>
        <input className={s.input} style={{ flex: 1, minWidth: 140 }} maxLength={32} placeholder="Новая роль: «Танк»" value={name} onChange={(e) => setName(e.target.value)} />
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Цвет" />
      </div>
      <label className={g.check}>
        <input type="checkbox" checked={selfAssign} onChange={(e) => setSelfAssign(e.target.checked)} />
        Можно взять себе
      </label>
      {status}
      <button
        type="button"
        className={s.primary}
        disabled={busy || !name.trim()}
        onClick={() =>
          void run(async () => {
            await starsApi.createTag(detail.id, { name: name.trim(), color, self_assign: selfAssign });
            setName("");
          })
        }
      >
        Добавить роль
      </button>
    </div>
  );
}

function TagRow({ detail, tag }: { detail: StarDetail; tag: StarTag }) {
  const holders = detail.members.filter((m) => m.tag_ids?.includes(tag.id)).length;
  const { busy, run, status } = useRun();
  return (
    <div className={s.row}>
      <TagChip tag={tag} />
      <span className={s.hint}>
        {holders} · {tag.self_assign ? "можно взять себе" : "выдают админы"}
      </span>
      <button
        type="button"
        className={`${s.secondary} ${s.small}`}
        disabled={busy}
        onClick={() => void run(() => starsApi.updateTag(detail.id, tag.id, { name: tag.name, color: tag.color, self_assign: !tag.self_assign }))}
      >
        {tag.self_assign ? "Только админы" : "Можно себе"}
      </button>
      <button
        type="button"
        className={`${s.danger} ${s.small}`}
        disabled={busy}
        onClick={() => {
          if (window.confirm(`Удалить роль «${tag.name}»? Она пропадёт у всех.`)) void run(() => starsApi.deleteTag(detail.id, tag.id));
        }}
      >
        Удалить
      </button>
      {status}
    </div>
  );
}

const KIND_TITLE: Record<AssetKind, string> = { sticker: "Стикеры", emoji: "Эмодзи", sound: "Звуки панели" };
const KIND_HINT: Record<AssetKind, string> = {
  sticker: "PNG, WebP, GIF или JPEG до 512 КБ — отправляются в Спутниках из панели 🙂.",
  emoji: "Маленькие картинки до 128 КБ; в тексте — :имя: (латиница, цифры, _).",
  sound: "OGG, MP3, WAV, WebM или M4A до 400 КБ, лучше короче 5 секунд. Слышат все на Планете.",
};

/** Стикеры, эмодзи и звуки Звезды. */
export function AssetsTab({ detail }: { detail: StarDetail }) {
  const assets = useStarsStore((st) => st.assets[detail.id]);
  const loadAssets = useStarsStore((st) => st.loadAssets);
  useEffect(() => {
    void loadAssets(detail.id).catch(() => {});
  }, [detail.id, loadAssets]);

  return (
    <div className={g.form}>
      {(["sticker", "emoji", "sound"] as const).map((kind) => (
        <AssetSection key={kind} detail={detail} kind={kind} items={(assets ?? []).filter((a) => a.kind === kind)} />
      ))}
    </div>
  );
}

function AssetSection({ detail, kind, items }: { detail: StarDetail; kind: AssetKind; items: StarAsset[] }) {
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("🔊");
  const fileRef = useRef<HTMLInputElement>(null);
  const { busy, run, status } = useRun();

  const upload = (file: File) =>
    void run(async () => {
      await starsApi.uploadAsset(detail.id, kind, name.trim() || file.name.replace(/\.[^.]+$/, "").slice(0, 32), file, kind === "sound" ? emoji : undefined);
      setName("");
    });

  return (
    <section className={g.form}>
      <div className={g.cardTitle}>
        {KIND_TITLE[kind]} · {items.length}
      </div>
      <p className={s.hint}>{KIND_HINT[kind]}</p>
      <div className={g.assetGrid}>
        {kind === "sound" &&
          Object.entries(BUILTIN_SOUNDS).map(([id, b]) => (
            <span key={id} className={g.assetItem} title="Встроенный звук">
              {b.emoji} {b.name}
            </span>
          ))}
        {items.map((a) => (
          <span key={a.id} className={g.assetItem}>
            {kind === "sound" ? (
              <button type="button" className={g.cardLink} onClick={() => void new Audio(a.url).play().catch(() => {})}>
                {a.emoji ?? "🔊"} {a.name}
              </button>
            ) : (
              <>
                <img src={a.url} alt={a.name} className={kind === "emoji" ? g.inlineEmoji : g.assetThumb} />
                {kind === "emoji" ? `:${a.name}:` : a.name}
              </>
            )}
            <button
              type="button"
              className={g.iconButton}
              aria-label={`Удалить ${a.name}`}
              onClick={() => void run(() => starsApi.deleteAsset(detail.id, a.id))}
            >
              ✕
            </button>
          </span>
        ))}
      </div>
      <div className={s.row}>
        {kind === "sound" && (
          <input className={s.input} style={{ width: 64 }} maxLength={4} value={emoji} onChange={(e) => setEmoji(e.target.value)} aria-label="Значок" />
        )}
        <input
          className={s.input}
          style={{ flex: 1, minWidth: 140 }}
          maxLength={32}
          placeholder={kind === "emoji" ? "имя: pogchamp" : "Название"}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="button" className={`${s.secondary} ${s.small}`} disabled={busy} onClick={() => fileRef.current?.click()}>
          Загрузить…
        </button>
        <input
          ref={fileRef}
          type="file"
          hidden
          accept={kind === "sound" ? "audio/*" : "image/png,image/webp,image/gif,image/jpeg"}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) upload(file);
          }}
        />
      </div>
      {status}
    </section>
  );
}

/** Журнал: кто кого выгнал, заглушил, кому сменил роль, что настроил. */
export function AuditTab({ detail }: { detail: StarDetail }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [done, setDone] = useState(false);
  const { busy, run, status } = useRun();

  const load = useCallback(
    (before?: string) =>
      run(async () => {
        const page = await starsApi.audit(detail.id, before);
        setEntries((prev) => (before ? [...prev, ...page] : page));
        setDone(page.length < 50);
      }),
    [detail.id, run]
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className={g.form}>
      {entries.length === 0 && !busy && <p className={s.hint}>Пока ничего не происходило.</p>}
      {entries.map((e) => (
        <div key={e.id} className={g.auditRow}>
          <span className={g.auditWhen}>{formatWhen(e.created_at)}</span>
          <span>{auditText(e)}</span>
        </div>
      ))}
      {status}
      {!done && entries.length > 0 && (
        <button type="button" className={`${s.secondary} ${s.small}`} disabled={busy} onClick={() => void load(entries[entries.length - 1].created_at)}>
          Раньше
        </button>
      )}
    </div>
  );
}
