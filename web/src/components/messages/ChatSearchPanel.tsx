import { useMemo, useState } from "react";
import { matches, queryWords, snippet } from "../../chat/search";
import { useChatStore } from "../../store/chat";
import { messagePreview } from "../../store/stickers";
import { formatWhen } from "../../chat/when";
import s from "./SearchBar.module.css";

const EMPTY: never[] = [];

/**
 * Поиск в чате. Переписку сервер прочитать не может (в личных чатах она зашифрована),
 * поэтому ищем на устройстве: в загруженной ленте, а по кнопке — глубже в истории.
 */
export default function ChatSearchPanel({
  chatId,
  nameOf,
  onClose,
}: {
  chatId: string;
  nameOf: (userId: string | null | undefined) => string;
  onClose: () => void;
}) {
  const messages = useChatStore((st) => st.messages[chatId] ?? EMPTY);
  const done = useChatStore((st) => !!st.historyDone[chatId]);
  const loadOlder = useChatStore((st) => st.loadOlder);
  const openMessage = useChatStore((st) => st.openMessage);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const words = queryWords(query);

  const results = useMemo(() => {
    if (words.join(" ").length < 2) return [];
    return [...messages].reverse().filter((m) => matches(messagePreview(m.payload), words)).slice(0, 100);
  }, [messages, words.join(" ")]); // eslint-disable-line react-hooks/exhaustive-deps

  const deeper = async () => {
    setLoading(true);
    try {
      // Десять страниц за раз (до 500 сообщений).
      for (let i = 0; i < 10; i++) if (!(await loadOlder(chatId))) break;
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={s.panel}>
      <div className={s.row}>
        <input
          className={s.input}
          type="search"
          autoFocus
          value={query}
          placeholder="Поиск в этом чате"
          aria-label="Поиск в чате"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && onClose()}
        />
        <button type="button" className={s.close} onClick={onClose} aria-label="Закрыть поиск">
          ✕
        </button>
      </div>
      {words.join(" ").length >= 2 && (
        <>
          <div className={s.results}>
            {results.map((m) => (
              <button key={m.id} type="button" className={s.result} onClick={() => void openMessage(chatId, m.id)}>
                <span className={s.meta}>
                  {nameOf(m.sender_id)} · {formatWhen(m.created_at)}
                </span>
                <span className={s.snippet}>
                  {snippet(messagePreview(m.payload), words).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : p.text))}
                </span>
              </button>
            ))}
          </div>
          <div className={s.status}>
            {results.length ? `Найдено: ${results.length}` : "В загруженных сообщениях не нашлось"}
            {!done && (
              <button type="button" className={s.more} disabled={loading} onClick={() => void deeper()}>
                {loading ? "Ищем…" : "Искать глубже в истории"}
              </button>
            )}
            {done && <span>· просмотрена вся история</span>}
          </div>
        </>
      )}
    </div>
  );
}
