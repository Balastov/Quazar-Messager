import { useEffect, useState } from "react";
import { starsApi, type StarDetail, type StarMessage } from "../../api/stars";
import { queryWords, snippet } from "../../chat/search";
import { formatWhen } from "../../chat/when";
import { useStarsStore } from "../../store/stars";
import { apiError } from "./rules";
import s from "../messages/SearchBar.module.css";
import { displayName } from "../../utils/profile";

/** Поиск по Спутникам Звезды (на сервере): текст сообщений и названия файлов. */
export default function StarSearchPanel({
  detail,
  channelId,
  onClose,
}: {
  detail: StarDetail;
  /** С какого Спутника начали — по умолчанию ищем в нём. */
  channelId: string;
  onClose: () => void;
}) {
  const jumpTo = useStarsStore((st) => st.jumpTo);
  const [query, setQuery] = useState("");
  const [everywhere, setEverywhere] = useState(false);
  const [results, setResults] = useState<StarMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const words = queryWords(query);
  const q = query.trim();

  useEffect(() => {
    setResults(null);
    setError(null);
    if (q.length < 2) return;
    let alive = true;
    const timer = setTimeout(() => {
      starsApi
        .search(detail.id, q, everywhere ? {} : { channel_id: channelId })
        .then((list) => {
          if (!alive) return;
          setResults(list);
          setMore(list.length >= 30);
        })
        .catch((err) => alive && setError(apiError(err, "Не удалось найти")));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [detail.id, q, everywhere, channelId]);

  const loadMore = async () => {
    const last = results?.[results.length - 1];
    if (!last) return;
    const list = await starsApi.search(detail.id, q, { ...(everywhere ? {} : { channel_id: channelId }), before: last.created_at });
    setResults((prev) => [...(prev ?? []), ...list]);
    setMore(list.length >= 30);
  };

  const channelName = (id: string) => detail.channels.find((c) => c.id === id)?.name ?? "Спутник";
  const author = (m: StarMessage) => m.bot_name ?? displayName(m.sender) ?? "Бывший участник";

  return (
    <div className={s.panel}>
      <div className={s.row}>
        <input
          className={s.input}
          type="search"
          autoFocus
          value={query}
          placeholder={everywhere ? `Поиск по всей Звезде` : `Поиск в #${channelName(channelId)}`}
          aria-label="Поиск сообщений"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && onClose()}
        />
        <button type="button" className={s.more} onClick={() => setEverywhere((v) => !v)}>
          {everywhere ? "Во всех Спутниках" : "Только здесь"}
        </button>
        <button type="button" className={s.close} onClick={onClose} aria-label="Закрыть поиск">
          ✕
        </button>
      </div>
      {q.length >= 2 && (
        <>
          <div className={s.results}>
            {(results ?? []).map((m) => (
              <button key={m.id} type="button" className={s.result} onClick={() => void jumpTo(m)}>
                <span className={s.meta}>
                  {author(m)} · {everywhere ? `#${channelName(m.channel_id)} · ` : ""}
                  {m.thread_id ? "в ветке · " : ""}
                  {formatWhen(m.created_at)}
                </span>
                <span className={s.snippet}>
                  {snippet(m.text || (m.file ? `📎 ${m.file.name}` : ""), words).map((p, i) =>
                    p.hit ? <mark key={i}>{p.text}</mark> : p.text
                  )}
                </span>
              </button>
            ))}
          </div>
          <div className={s.status}>
            {error ?? (results === null ? "Ищем…" : results.length ? `Найдено: ${results.length}${more ? "+" : ""}` : "Ничего не нашлось")}
            {more && (
              <button type="button" className={s.more} onClick={() => void loadMore().catch(() => {})}>
                Ещё
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
