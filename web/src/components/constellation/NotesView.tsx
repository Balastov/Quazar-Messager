import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isAxiosError } from "axios";
import { starsApi, type StarChannel, type StarDetail, type StarNote, type StarNoteRevision } from "../../api/stars";
import { diffStats, lineDiff } from "../../chat/diff";
import { formatWhen } from "../../chat/when";
import { useStarsStore } from "../../store/stars";
import { displayName } from "../../utils/profile";
import type { MentionKind } from "../LinkifiedText";
import ComposerInput, { type ComposerHandle } from "../messages/ComposerInput";
import FormatBar from "../messages/FormatBar";
import StarText from "./StarText";
import { apiError } from "./rules";
import s from "./Constellation.module.css";
import n from "./NotesView.module.css";

type Mode = "view" | "edit" | "history";

/** Несохранённая правка по Спутникам: ушли на другую вкладку — вернёмся к ней же. */
const drafts = new Map<string, { text: string; base: number }>();

const TEMPLATE = `# Добро пожаловать

Коротко: зачем этот Спутник и кто за что отвечает.

## Полезное
- Регламент:
- Дежурные:

## Как мы работаем
1.
`;

/**
 * Вкладка «Заметки»: вики-страница Спутника в markdown. Правка — с версией, от которой начали:
 * если кто-то сохранил раньше, предлагаем сверить, а не затираем молча. История — все версии
 * с тем, что изменилось.
 */
export default function NotesView({
  detail,
  channel,
  emoji,
  mention,
}: {
  detail: StarDetail;
  channel: StarChannel;
  emoji: Record<string, string>;
  mention: MentionKind;
}) {
  const [note, setNote] = useState<StarNote | null>(null);
  const [mode, setMode] = useState<Mode>("view");
  const [draft, setDraft] = useState("");
  const [baseVersion, setBaseVersion] = useState(0);
  const [preview, setPreview] = useState(false);
  const [conflict, setConflict] = useState<StarNote | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handle = useRef<ComposerHandle>(null);
  const remoteVersion = useStarsStore((st) => st.notesVersion[channel.id]);

  // Вернулись на вкладку с несохранённой правкой — продолжаем её.
  useEffect(() => {
    const saved = drafts.get(channel.id);
    if (!saved) return;
    drafts.delete(channel.id);
    setDraft(saved.text);
    setBaseVersion(saved.base);
    setMode("edit");
  }, [channel.id]);

  const latest = useRef({ mode, draft, baseVersion, original: "" });
  useEffect(() => {
    return () => {
      const { mode: m, draft: d, baseVersion: b, original } = latest.current;
      if (m === "edit" && d !== original) drafts.set(channel.id, { text: d, base: b });
    };
  }, [channel.id]);

  const load = useCallback(async () => {
    try {
      setNote(await starsApi.notes(detail.id, channel.id));
    } catch (err) {
      setError(apiError(err, "Не удалось загрузить заметки"));
    }
  }, [detail.id, channel.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Кто-то сохранил новую версию — перечитываем (правку не трогаем, только показываем полосу).
  useEffect(() => {
    if (note && remoteVersion && remoteVersion > note.version) void load();
  }, [remoteVersion, note, load]);

  const dirty = mode === "edit" && draft !== (note?.text ?? "");
  latest.current = { mode, draft, baseVersion, original: note?.text ?? "" };
  const staleWhileEditing = mode === "edit" && !!note && note.version > baseVersion;

  // Не потерять правку при закрытии вкладки браузера.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const startEdit = (text?: string) => {
    if (!note) return;
    setDraft(text ?? (note.text || TEMPLATE));
    setBaseVersion(note.version);
    setConflict(null);
    setPreview(false);
    setError(null);
    setMode("edit");
    requestAnimationFrame(() => handle.current?.focus());
  };

  const save = async (text: string, base: number) => {
    setSaving(true);
    setError(null);
    try {
      const saved = await starsApi.saveNotes(detail.id, channel.id, text, base);
      setNote(saved);
      setConflict(null);
      setMode("view");
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 409 && err.response.data?.note) {
        setConflict(err.response.data.note as StarNote);
        setNote(err.response.data.note as StarNote);
      } else {
        setError(apiError(err, "Не удалось сохранить"));
      }
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    if (dirty && !window.confirm("Выйти без сохранения? Правка пропадёт.")) return;
    setMode("view");
    setConflict(null);
  };

  if (!note) {
    return <div className={s.empty}>{error ?? "Загрузка…"}</div>;
  }

  const meta = note.updated_at ? (
    <span className={n.meta}>
      Версия {note.version} · {displayName(note.updated_by) ?? "бывший участник"} · {formatWhen(note.updated_at)}
    </span>
  ) : (
    <span className={n.meta}>Заметок пока нет</span>
  );

  if (mode === "history") {
    return <History detail={detail} channel={channel} note={note} emoji={emoji} mention={mention} onBack={() => setMode("view")} onRestore={(text) => startEdit(text)} />;
  }

  if (mode === "edit") {
    return (
      <div className={n.wrap}>
        <div className={n.toolbar}>
          <span className={n.meta}>{baseVersion ? `Правка версии ${baseVersion}` : "Новые заметки"}</span>
          <button type="button" className={`${s.secondary} ${s.small}`} onClick={() => setPreview((p) => !p)}>
            {preview ? "Править" : "Просмотр"}
          </button>
          <button type="button" className={`${s.secondary} ${s.small}`} onClick={cancel} disabled={saving}>
            Отмена
          </button>
          <button
            type="button"
            className={`${s.primary} ${s.small}`}
            onClick={() => void save(draft, baseVersion)}
            disabled={saving || !dirty}
            title="⌘/Ctrl+S"
          >
            {saving ? "Сохраняю…" : "Сохранить"}
          </button>
        </div>
        {conflict ? (
          <div className={n.banner}>
            <span>
              Пока вы правили, {displayName(conflict.updated_by) ?? "кто-то"} сохранил(а) версию {conflict.version}.
            </span>
            <button type="button" className={`${s.secondary} ${s.small}`} onClick={() => startEdit(conflict.text)}>
              Взять их версию
            </button>
            <button type="button" className={`${s.danger} ${s.small}`} onClick={() => void save(draft, conflict.version)}>
              Сохранить мою поверх
            </button>
          </div>
        ) : (
          staleWhileEditing && (
            <div className={n.banner}>
              {displayName(note.updated_by) ?? "Кто-то"} только что сохранил(а) версию {note.version}. При сохранении
              предложим сверить.
            </div>
          )
        )}
        {error && <div className={s.error}>{error}</div>}
        {!preview && <FormatBar onFormat={(kind) => handle.current?.format(kind)} />}
        <div className={n.scroll}>
          {preview ? (
            <div className={n.page}>
              <StarText text={draft} emoji={emoji} mention={mention} linkClassName={s.messageLink} headings />
            </div>
          ) : (
            <ComposerInput
              handleRef={handle}
              className={n.editor}
              value={draft}
              onValueChange={setDraft}
              submitOnEnter={false}
              maxHeight={100_000}
              maxLength={100_000}
              aria-label="Текст заметок"
              placeholder="# Заголовок, списки, **жирный**, `код`, ссылки…"
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.code === "KeyS") {
                  e.preventDefault();
                  if (dirty && !saving) void save(draft, baseVersion);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancel();
                }
              }}
            />
          )}
        </div>
        <div className={n.hint}>
          # Заголовок · ## Подзаголовок · --- черта · **жирный** · _курсив_ · `код` · ```блок``` · &gt; цитата · - список
        </div>
      </div>
    );
  }

  return (
    <div className={n.wrap}>
      <div className={n.toolbar}>
        {meta}
        {note.version > 0 && (
          <button type="button" className={`${s.secondary} ${s.small}`} onClick={() => setMode("history")}>
            История
          </button>
        )}
        {note.can_edit && (
          <button type="button" className={`${s.primary} ${s.small}`} onClick={() => startEdit()}>
            {note.text ? "Изменить" : "Начать"}
          </button>
        )}
      </div>
      {error && <div className={s.error}>{error}</div>}
      <div className={n.scroll}>
        {note.text ? (
          <div className={n.page}>
            <StarText text={note.text} emoji={emoji} mention={mention} linkClassName={s.messageLink} headings />
          </div>
        ) : (
          <div className={s.empty}>
            Здесь удобно держать то, что не должно теряться в ленте: регламенты, онбординг, контакты дежурных,
            полезные ссылки. Заметки видят все участники Звезды, у каждой правки сохраняется версия.
          </div>
        )}
      </div>
    </div>
  );
}

/** История: версии сверху вниз, у выбранной — что изменилось относительно предыдущей. */
function History({
  detail,
  channel,
  note,
  emoji,
  mention,
  onBack,
  onRestore,
}: {
  detail: StarDetail;
  channel: StarChannel;
  note: StarNote;
  emoji: Record<string, string>;
  mention: MentionKind;
  onBack: () => void;
  onRestore: (text: string) => void;
}) {
  const [list, setList] = useState<StarNoteRevision[] | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [texts, setTexts] = useState<Record<number, string>>({});
  const [view, setView] = useState<"diff" | "page">("diff");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    starsApi
      .noteRevisions(detail.id, channel.id)
      .then((revs) => {
        setList(revs);
        setPicked(revs[0]?.version ?? null);
      })
      .catch((err) => setError(apiError(err, "Не удалось загрузить историю")));
  }, [detail.id, channel.id, note.version]);

  // Выбранная версия и предыдущая — для сравнения.
  const prev = list && picked !== null ? list.find((r) => r.version < picked)?.version ?? null : null;
  useEffect(() => {
    for (const v of [picked, prev]) {
      if (v === null || texts[v] !== undefined) continue;
      starsApi
        .noteRevision(detail.id, channel.id, v)
        .then((r) => setTexts((t) => ({ ...t, [v]: r.text ?? "" })))
        .catch((err) => setError(apiError(err, "Не удалось загрузить версию")));
    }
  }, [picked, prev, texts, detail.id, channel.id]);

  const current = picked !== null ? texts[picked] : undefined;
  const before = prev !== null ? texts[prev] : picked === list?.[list.length - 1]?.version ? "" : undefined;
  const parts = useMemo(
    () => (current !== undefined && before !== undefined ? lineDiff(before, current) : null),
    [current, before]
  );
  const stats = parts ? diffStats(parts) : null;
  const rev = list?.find((r) => r.version === picked);

  return (
    <div className={n.wrap}>
      <div className={n.toolbar}>
        <button type="button" className={`${s.secondary} ${s.small}`} onClick={onBack}>
          ← К заметкам
        </button>
        <span className={n.meta}>История правок · хранятся последние 100 версий</span>
      </div>
      {error && <div className={s.error}>{error}</div>}
      <div className={n.history}>
        <div className={n.revisions} role="listbox" aria-label="Версии">
          {list?.map((r) => (
            <button
              key={r.version}
              type="button"
              role="option"
              aria-selected={r.version === picked}
              className={r.version === picked ? `${n.revision} ${n.revisionActive}` : n.revision}
              onClick={() => setPicked(r.version)}
            >
              <b>
                Версия {r.version}
                {r.version === note.version ? " · текущая" : ""}
              </b>
              <span>
                {displayName(r.author) ?? "бывший участник"} · {formatWhen(r.created_at)}
              </span>
            </button>
          ))}
          {list && !list.length && <div className={s.empty}>Версий пока нет</div>}
        </div>
        <div className={n.revisionBody}>
          {rev && (
            <div className={n.toolbar}>
              <span className={n.meta}>
                {stats ? `+${stats.added} −${stats.removed} строк` : "…"}
              </span>
              <button type="button" className={`${s.secondary} ${s.small}`} onClick={() => setView(view === "diff" ? "page" : "diff")}>
                {view === "diff" ? "Как страница" : "Что изменилось"}
              </button>
              {note.can_edit && rev.version !== note.version && current !== undefined && (
                <button type="button" className={`${s.primary} ${s.small}`} onClick={() => onRestore(current)}>
                  Вернуть эту версию
                </button>
              )}
            </div>
          )}
          <div className={n.scroll}>
            {current === undefined ? (
              list?.length ? <div className={s.empty}>Загрузка…</div> : null
            ) : view === "page" ? (
              <div className={n.page}>
                <StarText text={current} emoji={emoji} mention={mention} linkClassName={s.messageLink} headings />
              </div>
            ) : (
              <pre className={n.diff}>
                {parts?.map((p, i) => (
                  <div key={i} className={p.kind === "add" ? n.add : p.kind === "del" ? n.del : n.same}>
                    <span aria-hidden>{p.kind === "add" ? "+" : p.kind === "del" ? "−" : " "}</span>
                    {p.text || " "}
                  </div>
                ))}
              </pre>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
