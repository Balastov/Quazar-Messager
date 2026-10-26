import { useCallback, useEffect, useState } from "react";
import { messagesApi } from "../../api/messages";
import type { Message } from "../../api/types";
import { loadImageUrl } from "../../attachments/cache";
import { parseImage, type ImageRef } from "../../attachments/image";
import { parseVoice } from "../../attachments/voice";
import { parseFile } from "../../attachments/file";
import ChatFile from "./ChatFile";
import { openMessages, useChatStore } from "../../store/chat";
import { splitLinks } from "../../utils/linkify";
import VoiceMessage from "../voice/VoiceMessage";
import s from "./Chat.module.css";

export type GalleryTab = "photos" | "voice" | "files" | "links";

/** Ссылки ищем по истории не дальше стольких сообщений. */
const LINK_SCAN_LIMIT = 2000;

const dateOf = (iso: string) => new Date(iso).toLocaleDateString("ru", { day: "numeric", month: "short", year: "numeric" });

/**
 * Галерея в профиле: фото, голосовые, файлы, ссылки.
 * Сервер знает только, у каких сообщений есть вложения; что внутри — расшифровываем здесь.
 */
export default function ChatGallery({ chatId, tab }: { chatId: string; tab: GalleryTab }) {
  return tab === "links" ? <Links chatId={chatId} /> : <Media chatId={chatId} kind={tab} />;
}

function Media({ chatId, kind }: { chatId: string; kind: "photos" | "voice" | "files" }) {
  const openMessage = useChatStore((st) => st.openMessage);
  const [items, setItems] = useState<Message[]>([]);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (before?: string) => {
      setLoading(true);
      try {
        const page = await openMessages(await messagesApi.media(chatId, before));
        setItems((prev) => (before ? [...prev, ...page] : page));
        setDone(page.length < 60);
      } finally {
        setLoading(false);
      }
    },
    [chatId]
  );

  // Новое фото или голосовое в чате — перечитываем первую страницу.
  const attachmentsInFeed = useChatStore(
    (st) =>
      (st.messages[chatId] ?? []).filter((m) => parseImage(m.payload) || parseVoice(m.payload) || parseFile(m.payload))
        .length
  );

  useEffect(() => {
    setItems([]);
    setDone(false);
    void load().catch(() => setDone(true));
  }, [load, attachmentsInFeed]);

  const photos = items.flatMap((m) => {
    const ref = parseImage(m.payload);
    return ref ? [{ m, ref }] : [];
  });
  const voices = items.flatMap((m) => {
    const ref = parseVoice(m.payload);
    return ref ? [{ m, ref }] : [];
  });
  const files = items.flatMap((m) => {
    const ref = parseFile(m.payload);
    return ref ? [{ m, ref }] : [];
  });
  const shown = kind === "photos" ? photos.length : kind === "voice" ? voices.length : files.length;

  return (
    <>
      {kind === "photos" ? (
        <div className={s.grid}>
          {photos.map(({ m, ref }) => (
            <Thumb key={m.id} chatId={chatId} image={ref} onOpen={() => void openMessage(chatId, m.id)} />
          ))}
        </div>
      ) : kind === "files" ? (
        <div className={s.galleryList}>
          {files.map(({ m, ref }) => (
            <div key={m.id} className={s.voiceRow}>
              <ChatFile chatId={chatId} file={ref} />
              <span className={s.galleryDate}>{dateOf(m.created_at)}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className={s.galleryList}>
          {voices.map(({ m, ref }) => (
            <div key={m.id} className={s.voiceRow}>
              <VoiceMessage chatId={chatId} voice={ref} tone="other" />
              <span className={s.galleryDate}>{dateOf(m.created_at)}</span>
            </div>
          ))}
        </div>
      )}
      {!loading && done && shown === 0 && (
        <p className={s.optionHint}>
          {kind === "photos" ? "Фото пока нет" : kind === "voice" ? "Голосовых пока нет" : "Файлов пока нет"}
        </p>
      )}
      {!done && (
        <button type="button" className={s.more} disabled={loading} onClick={() => void load(items[items.length - 1]?.id)}>
          {loading ? "Загрузка…" : "Показать ещё"}
        </button>
      )}
    </>
  );
}

function Thumb({ chatId, image, onOpen }: { chatId: string; image: ImageRef; onOpen: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    loadImageUrl(chatId, image)
      .then((u) => alive && setUrl(u))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [chatId, image]);
  return (
    <button type="button" className={s.thumb} onClick={onOpen} title="Показать в чате">
      {url && <img src={url} alt="" loading="lazy" />}
    </button>
  );
}

interface FoundLink {
  key: string;
  href: string;
  text: string;
  at: string;
}

function extractLinks(messages: Message[]): FoundLink[] {
  const out: FoundLink[] = [];
  for (const m of [...messages].reverse()) {
    splitLinks(m.payload).forEach((part, i) => {
      if (part.type === "link") out.push({ key: `${m.id}-${i}`, href: part.href, text: part.text, at: m.created_at });
    });
  }
  return out;
}

/** Ссылки: сначала из загруженной ленты, по кнопке — по всей истории. */
function Links({ chatId }: { chatId: string }) {
  const loaded = useChatStore((st) => st.messages[chatId]);
  const [history, setHistory] = useState<Message[] | null>(null);
  const [scanning, setScanning] = useState(false);

  useEffect(() => setHistory(null), [chatId]);

  const scanAll = async () => {
    setScanning(true);
    const all: Message[] = [];
    let before: string | undefined;
    try {
      while (all.length < LINK_SCAN_LIMIT) {
        const page = await messagesApi.list(chatId, before);
        if (!page.length) break;
        all.unshift(...(await openMessages(page)));
        before = page[0].id;
        if (page.length < 50) break;
      }
      setHistory(all);
    } finally {
      setScanning(false);
    }
  };

  const links = extractLinks(history ?? loaded ?? []);
  return (
    <div className={s.galleryList}>
      {links.map((l) => (
        <a key={l.key} className={s.linkRow} href={l.href} target="_blank" rel="noopener noreferrer">
          <span className={s.linkHref}>{l.text}</span>
          <span className={s.galleryDate}>{dateOf(l.at)}</span>
        </a>
      ))}
      {links.length === 0 && !scanning && <p className={s.optionHint}>Ссылок пока нет</p>}
      {!history && (
        <button type="button" className={s.more} disabled={scanning} onClick={() => void scanAll()}>
          {scanning ? "Ищем по истории…" : "Искать во всей истории"}
        </button>
      )}
    </div>
  );
}
