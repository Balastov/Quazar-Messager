import { useCallback, useEffect, useState } from "react";
import { starsApi, type StarChannel, type StarDetail, type StarFileItem } from "../../api/stars";
import { fileIcon, formatSize } from "../../attachments/file";
import { formatWhen } from "../../chat/when";
import { IconBack } from "../icons";
import { downloadStarFile } from "./StarFileView";
import { apiError } from "./rules";
import s from "./Constellation.module.css";
import w from "./Work.module.css";

type Kind = "all" | "images" | "docs";

/** «Файлы» Звезды: всё, что отправили в Спутники, с поиском по названию. */
export default function StarFilesView({
  detail,
  onBack,
  onOpenChannel,
}: {
  detail: StarDetail;
  onBack?: () => void;
  onOpenChannel: (channel: StarChannel) => void;
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [kind, setKind] = useState<Kind>("all");
  const [channelId, setChannelId] = useState("");
  const [files, setFiles] = useState<StarFileItem[]>([]);
  const [usage, setUsage] = useState<{ used: number; quota: number } | null>(null);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const satellites = detail.channels.filter((c) => c.kind === "satellite");

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const load = useCallback(
    async (before?: string) => {
      setLoading(true);
      setError(null);
      try {
        const page = await starsApi.files(detail.id, {
          q: debounced || undefined,
          kind,
          channel_id: channelId || undefined,
          before,
        });
        setFiles((prev) => (before ? [...prev, ...page.files] : page.files));
        setUsage({ used: page.used_bytes, quota: page.quota_bytes });
        setMore(page.files.length >= 50);
      } catch (err) {
        setError(apiError(err, "Не удалось загрузить файлы"));
      } finally {
        setLoading(false);
      }
    },
    [detail.id, debounced, kind, channelId]
  );

  useEffect(() => {
    void load();
  }, [load]);

  const channelName = (id: string) => detail.channels.find((c) => c.id === id)?.name ?? "удалённый Спутник";

  return (
    <>
      <div className={s.channelHeader}>
        {onBack && (
          <button type="button" className={s.iconBtn} onClick={onBack} aria-label="Назад">
            <IconBack />
          </button>
        )}
        <span aria-hidden style={{ fontSize: 20 }}>
          📁
        </span>
        <div className={s.channelTitle}>
          <span className={s.channelTitleName}>Файлы</span>
          <span className={s.channelTitleSub}>{detail.name} · всё, что отправили в Спутники</span>
        </div>
      </div>
      <div className={w.filesToolbar}>
        <input
          className={s.input}
          type="search"
          value={query}
          placeholder="Найти по названию"
          aria-label="Найти файл"
          onChange={(e) => setQuery(e.target.value)}
        />
        <select className={s.select} value={kind} onChange={(e) => setKind(e.target.value as Kind)} aria-label="Тип">
          <option value="all">Все файлы</option>
          <option value="docs">Документы</option>
          <option value="images">Картинки</option>
        </select>
        <select className={s.select} value={channelId} onChange={(e) => setChannelId(e.target.value)} aria-label="Спутник">
          <option value="">Все Спутники</option>
          {satellites.map((c) => (
            <option key={c.id} value={c.id}>
              #{c.name}
            </option>
          ))}
        </select>
      </div>
      <div className={w.filesList}>
        {error && <div className={s.error}>{error}</div>}
        {!loading && !error && files.length === 0 && (
          <div className={s.empty}>
            {debounced || channelId || kind !== "all"
              ? "Ничего не нашлось"
              : "Файлов пока нет. Отправьте документ в любой Спутник — «+» → «Файл» или перетащите его в окно."}
          </div>
        )}
        {files.map((f) => {
          const channel = detail.channels.find((c) => c.id === f.channel_id);
          return (
            <div key={f.id} className={w.fileRow}>
              <span className={w.fileIcon} aria-hidden>
                {fileIcon(f.name)}
              </span>
              <div className={w.fileMain}>
                <span className={w.fileName} title={f.name}>
                  {f.name}
                </span>
                <span className={w.fileMeta}>
                  {formatSize(f.size)} · {f.uploader?.username ?? "бывший участник"} · {formatWhen(f.created_at)} · #
                  {channelName(f.channel_id)}
                </span>
              </div>
              {channel && (
                <button type="button" className={`${s.secondary} ${s.small}`} onClick={() => onOpenChannel(channel)}>
                  В Спутник
                </button>
              )}
              <button
                type="button"
                className={`${s.primary} ${s.small}`}
                onClick={() => void downloadStarFile(detail.id, f).catch((err) => setError(apiError(err, "Не удалось скачать")))}
              >
                Скачать
              </button>
            </div>
          );
        })}
        {more && (
          <button
            type="button"
            className={`${s.secondary} ${s.small}`}
            disabled={loading}
            onClick={() => void load(files[files.length - 1]?.created_at)}
          >
            {loading ? "Загрузка…" : "Показать ещё"}
          </button>
        )}
      </div>
      {usage && (
        <div className={w.quota}>
          Занято {formatSize(usage.used)} из {formatSize(usage.quota)}
          <div className={w.quotaBar}>
            <span style={{ width: `${Math.min(100, (usage.used / Math.max(1, usage.quota)) * 100)}%` }} />
          </div>
        </div>
      )}
    </>
  );
}
