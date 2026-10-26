import type { LinkPreview } from "../../chat/linkPreview";
import s from "./LinkPreviewCard.module.css";

/** Превью ссылки под сообщением (или над полем ввода, с крестиком). */
export default function LinkPreviewCard({
  preview,
  tone = "other",
  onRemove,
}: {
  preview: LinkPreview;
  tone?: "own" | "other";
  onRemove?: () => void;
}) {
  return (
    <div className={`${s.card} ${tone === "own" ? s.own : ""}`}>
      <a className={s.link} href={preview.url} target="_blank" rel="noopener noreferrer nofollow">
        {preview.image && <img className={s.image} src={preview.image} alt="" loading="lazy" />}
        <span className={s.body}>
          {preview.site && <span className={s.site}>{preview.site}</span>}
          <span className={s.title}>{preview.title}</span>
          {preview.description && <span className={s.description}>{preview.description}</span>}
        </span>
      </a>
      {onRemove && (
        <button type="button" className={s.remove} onClick={onRemove} aria-label="Без превью" title="Отправить без превью">
          ✕
        </button>
      )}
    </div>
  );
}
