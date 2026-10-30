import { useEffect, useMemo, useState } from "react";
import {
  starsApi,
  type StarBookmark,
  type StarChannel,
  type StarDetail,
  type StarFileItem,
  type StarMessage,
} from "../../api/stars";
import { fileIcon } from "../../attachments/file";
import { formatWhen } from "../../chat/when";
import { isStaff } from "../../store/stars";
import { displayName } from "../../utils/profile";
import MessageMenu, { type MenuAction } from "../messages/MessageMenu";
import Dialog from "./Dialog";
import { downloadStarFile } from "./StarFileView";
import StarText from "./StarText";
import { apiError } from "./rules";
import s from "./Constellation.module.css";
import t from "./ChannelTabs.module.css";

export type ChannelTab = "messages" | "notes" | "pins" | "files";

/** Можно ли добавлять закладки: писать в Спутник может каждый, в объявления — модераторы и выше. */
export function canAddBookmark(detail: StarDetail, channel: StarChannel): boolean {
  return !channel.announcement || isStaff(detail.my_role);
}

/** Вкладки Спутника под шапкой: «Сообщения», «Заметки», «Закреплённые», «Файлы» и «+ Закладка». */
export function ChannelTabs({
  tab,
  onTab,
  pinCount,
  onAddBookmark,
}: {
  tab: ChannelTab;
  onTab: (tab: ChannelTab) => void;
  pinCount: number;
  onAddBookmark?: () => void;
}) {
  const tabs: { id: ChannelTab; label: string }[] = [
    { id: "messages", label: "Сообщения" },
    { id: "notes", label: "Заметки" },
    { id: "pins", label: pinCount ? `Закреплённые · ${pinCount}` : "Закреплённые" },
    { id: "files", label: "Файлы" },
  ];
  return (
    <div className={t.tabs} role="tablist" aria-label="Разделы Спутника">
      {tabs.map((x) => (
        <button
          key={x.id}
          type="button"
          role="tab"
          aria-selected={tab === x.id}
          className={tab === x.id ? `${t.tab} ${t.tabActive}` : t.tab}
          onClick={() => onTab(x.id)}
        >
          {x.label}
        </button>
      ))}
      {onAddBookmark && (
        <button type="button" className={t.addBookmark} onClick={onAddBookmark} title="Добавить ссылку или документ">
          + Закладка
        </button>
      )}
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Полоса закладок: нажатие открывает ссылку или скачивает файл, правая кнопка — изменить или удалить. */
export function BookmarksBar({
  detail,
  bookmarks,
  myId,
  onEdit,
}: {
  detail: StarDetail;
  bookmarks: StarBookmark[];
  myId: string | undefined;
  onEdit: (bookmark: StarBookmark) => void;
}) {
  const [menu, setMenu] = useState<{ bookmark: StarBookmark; x: number; y: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const staff = isStaff(detail.my_role);
  if (!bookmarks.length) return null;

  const open = (b: StarBookmark) => {
    setError(null);
    if (b.url) window.open(b.url, "_blank", "noopener,noreferrer");
    else if (b.file) void downloadStarFile(detail.id, b.file).catch((err) => setError(apiError(err, "Не удалось скачать")));
  };

  const actions = (b: StarBookmark): MenuAction[] => {
    const list: MenuAction[] = [{ label: b.url ? "Открыть ссылку" : "Скачать файл", onClick: () => open(b) }];
    if (b.url) list.push({ label: "Копировать ссылку", onClick: () => void navigator.clipboard?.writeText(b.url!).catch(() => {}) });
    if (b.created_by === myId || staff) {
      list.push({ label: "Изменить…", onClick: () => onEdit(b) });
      list.push({
        label: "Удалить закладку",
        danger: true,
        onClick: () =>
          void starsApi
            .deleteBookmark(detail.id, b.channel_id, b.id)
            .catch((err) => setError(apiError(err, "Не удалось удалить"))),
      });
    }
    if (staff && bookmarks.length > 1) {
      const i = bookmarks.indexOf(b);
      const move = (to: number) => {
        const ids = bookmarks.map((x) => x.id);
        ids.splice(i, 1);
        ids.splice(to, 0, b.id);
        void starsApi.reorderBookmarks(detail.id, b.channel_id, ids).catch((err) => setError(apiError(err, "Не удалось")));
      };
      if (i > 0) list.push({ label: "← Левее", onClick: () => move(i - 1) });
      if (i < bookmarks.length - 1) list.push({ label: "Правее →", onClick: () => move(i + 1) });
    }
    return list;
  };

  return (
    <div className={t.bar} aria-label="Закладки">
      {bookmarks.map((b) => (
        <button
          key={b.id}
          type="button"
          className={t.chip}
          onClick={() => open(b)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ bookmark: b, x: e.clientX, y: e.clientY });
          }}
          title={b.url ? `${b.title} — ${b.url}` : `${b.title} — ${b.file?.name}`}
        >
          <span aria-hidden>{b.emoji || (b.file ? fileIcon(b.file.name) : "🔗")}</span>
          <span className={t.chipTitle}>{b.title}</span>
          {b.url && <span className={t.chipHost}>{hostOf(b.url)}</span>}
        </button>
      ))}
      {error && <span className={s.error}>{error}</span>}
      {menu && (
        <MessageMenu
          at={{ x: menu.x, y: menu.y }}
          reaction={null}
          actions={actions(menu.bookmark)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/** Добавить или изменить закладку: ссылка или файл, уже отправленный в эту Звезду. */
export function BookmarkDialog({
  detail,
  channel,
  bookmark,
  onClose,
}: {
  detail: StarDetail;
  channel: StarChannel;
  bookmark?: StarBookmark;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<"link" | "file">(bookmark?.file ? "file" : "link");
  const [title, setTitle] = useState(bookmark?.title ?? "");
  const [url, setUrl] = useState(bookmark?.url ?? "");
  const [emoji, setEmoji] = useState(bookmark?.emoji ?? "");
  const [fileId, setFileId] = useState(bookmark?.file?.id ?? "");
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<StarFileItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (kind !== "file") return;
    const timer = setTimeout(() => {
      starsApi
        .files(detail.id, { q: query.trim() || undefined, kind: "all" })
        .then((page) => setFiles(page.files))
        .catch((err) => setError(apiError(err, "Не удалось загрузить файлы")));
    }, 200);
    return () => clearTimeout(timer);
  }, [kind, query, detail.id]);

  // Файлы этого Спутника — первыми.
  const sorted = useMemo(
    () => (files ?? []).slice().sort((a, b) => Number(b.channel_id === channel.id) - Number(a.channel_id === channel.id)),
    [files, channel.id]
  );

  const ready = title.trim() && (kind === "link" ? url.trim() : fileId);
  const save = async () => {
    setBusy(true);
    setError(null);
    const body = {
      title: title.trim(),
      emoji: emoji.trim() || null,
      url: kind === "link" ? url.trim() : null,
      file_id: kind === "file" ? fileId : null,
    };
    try {
      if (bookmark) await starsApi.updateBookmark(detail.id, channel.id, bookmark.id, body);
      else await starsApi.addBookmark(detail.id, channel.id, body);
      onClose();
    } catch (err) {
      setError(apiError(err, "Не удалось сохранить закладку"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={bookmark ? "Закладка" : `Закладка в «${channel.name}»`} onClose={onClose}>
      <div className={t.form}>
        <div className={t.kinds} role="radiogroup" aria-label="Что добавить">
          {(["link", "file"] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              className={kind === k ? `${t.kind} ${t.kindActive}` : t.kind}
              onClick={() => setKind(k)}
            >
              {k === "link" ? "🔗 Ссылка" : "📎 Файл из Звезды"}
            </button>
          ))}
        </div>
        {kind === "link" ? (
          <input
            className={s.input}
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              if (!title.trim() && /^https?:\/\/\S+$/.test(e.target.value)) setTitle(hostOf(e.target.value));
            }}
            placeholder="https://wiki.example.com/onboarding"
            aria-label="Ссылка"
            autoFocus
          />
        ) : (
          <>
            <input
              className={s.input}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Найти файл по названию"
              aria-label="Найти файл"
            />
            <div className={t.files} role="listbox" aria-label="Файлы Звезды">
              {files && !sorted.length && (
                <div className={s.empty}>
                  {query ? "Ничего не нашлось" : "Файлов пока нет — сначала отправьте документ в Спутник"}
                </div>
              )}
              {sorted.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="option"
                  aria-selected={fileId === f.id}
                  className={fileId === f.id ? `${t.file} ${t.fileActive}` : t.file}
                  onClick={() => {
                    setFileId(f.id);
                    if (!title.trim()) setTitle(f.name.replace(/\.[^.]+$/, "").slice(0, 80));
                  }}
                >
                  <span aria-hidden>{fileIcon(f.name)}</span>
                  <span className={t.fileName}>{f.name}</span>
                  <span className={t.fileMeta}>
                    #{detail.channels.find((c) => c.id === f.channel_id)?.name ?? "—"} · {formatWhen(f.created_at)}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
        <div className={t.row}>
          <input
            className={`${s.input} ${t.emoji}`}
            value={emoji}
            onChange={(e) => setEmoji(e.target.value.slice(0, 8))}
            placeholder="—"
            title="Значок (необязательно): 📘, 📈, 🧭"
            aria-label="Значок"
          />
          <input
            className={s.input}
            style={{ flex: 1 }}
            value={title}
            maxLength={80}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Название: «Онбординг», «Регламент релизов»"
            aria-label="Название"
          />
        </div>
        {error && <div className={s.error}>{error}</div>}
        <button type="button" className={s.primary} disabled={!ready || busy} onClick={() => void save()}>
          {bookmark ? "Сохранить" : "Добавить закладку"}
        </button>
      </div>
    </Dialog>
  );
}

/** Вкладка «Закреплённые»: все закрепы списком, нажатие — к сообщению в ленте. */
export function PinnedList({
  pins,
  emoji,
  onOpen,
  onUnpin,
}: {
  pins: StarMessage[] | undefined;
  emoji: Record<string, string>;
  onOpen: (message: StarMessage) => void;
  onUnpin?: (message: StarMessage) => void;
}) {
  if (!pins) return <div className={s.empty}>Загрузка…</div>;
  if (!pins.length) {
    return <div className={s.empty}>Закреплённых нет. Модераторы закрепляют важное через меню сообщения.</div>;
  }
  return (
    <div className={t.pinned}>
      {pins.map((p) => (
        <div key={p.id} className={t.pin}>
          <div className={t.pinHead}>
            <b>{p.bot_name ?? displayName(p.sender) ?? "Бывший участник"}</b>
            <span>{formatWhen(p.created_at)}</span>
          </div>
          <div className={t.pinText}>
            {p.text ? <StarText text={p.text} emoji={emoji} /> : p.file ? `📎 ${p.file.name}` : ""}
          </div>
          <div className={t.pinActions}>
            <button type="button" className={`${s.secondary} ${s.small}`} onClick={() => onOpen(p)}>
              К сообщению
            </button>
            {onUnpin && (
              <button type="button" className={`${s.secondary} ${s.small}`} onClick={() => onUnpin(p)}>
                Открепить
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
