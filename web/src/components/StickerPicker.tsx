import { useEffect, useId, useRef, useState } from "react";
import { stickerFileUrl, type StickerInfo } from "../api/stickers";
import type { StarAsset } from "../api/stars";
import { EMOJI } from "../chat/emoji";
import { useStickersStore } from "../store/stickers";
import Sticker from "./Sticker";
import s from "./StickerPicker.module.css";

interface Props {
  onPick: (packId: string, sticker: StickerInfo) => void;
  onEmoji: (emoji: string) => void;
  onClose: () => void;
  assets?: StarAsset[];
  onStarSticker?: (asset: StarAsset) => void;
}
const NONE: StarAsset[] = [];

/** A smile opens emoji first; stickers and packs stay in their own tab. */
export default function StickerPicker({ onPick, onEmoji, onClose, assets = NONE, onStarSticker }: Props) {
  const packs = useStickersStore(st => st.packs);
  const loaded = useStickersStore(st => st.loaded);
  const load = useStickersStore(st => st.load);
  const emoji = assets.filter(asset => asset.kind === "emoji");
  const stickers = assets.filter(asset => asset.kind === "sticker");
  const [tab, setTab] = useState<"emoji" | "stickers">("emoji");
  const [packId, setPackId] = useState<string | null>(stickers.length ? "star" : null);
  const rootRef = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (rootRef.current?.contains(target) || target?.closest("[data-sticker-toggle]")) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onDown); };
  }, [onClose]);
  const star = packId === "star" && stickers.length > 0;
  const pack = star ? undefined : packs.find(item => item.id === packId) ?? packs[0];

  return <div ref={rootRef} className={s.picker} role="dialog" aria-label="Смайлы и стикеры">
    <div className={`${s.tabs} ${s.mainTabs}`} role="tablist" aria-label="Смайлы и стикеры">
      {(["emoji", "stickers"] as const).map(value => <button key={value} type="button" role="tab"
        id={`${id}-${value}`} aria-controls={`${id}-panel`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1}
        data-picker-tab={value} className={tab === value ? s.tabActive : s.tab}
        onMouseDown={event => event.preventDefault()} onClick={() => setTab(value)}
        onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? "emoji" : event.key === "End" ? "stickers" : value === "emoji" ? "stickers" : "emoji";
          setTab(next);
          rootRef.current?.querySelector<HTMLButtonElement>(`[data-picker-tab="${next}"]`)?.focus();
        }}>
        {value === "emoji" ? "Смайлы" : "Стикеры"}
      </button>)}
    </div>
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}`} className={s.body}>
      {tab === "emoji" ? <div className={s.emojiGrid}>
        {emoji.map(asset => <button key={asset.id} type="button" className={s.emojiCell}
          title={`:${asset.name}:`} aria-label={`Смайл :${asset.name}:`}
          onMouseDown={event => event.preventDefault()} onClick={() => onEmoji(`:${asset.name}:`)}>
          <img src={asset.url} alt={`:${asset.name}:`} loading="lazy" />
        </button>)}
        {EMOJI.map(value => <button key={value} type="button" className={s.emojiCell}
          aria-label={`Смайл ${value}`} title={value} onMouseDown={event => event.preventDefault()} onClick={() => onEmoji(value)}>{value}</button>)}
      </div> : <>
        {(packs.length > 1 || stickers.length > 0) && <div className={s.tabs} role="group" aria-label="Наборы стикеров">
          {stickers.length > 0 && <button type="button" className={star ? s.tabActive : s.tab} aria-pressed={!!star} onClick={() => setPackId("star")}>Звезда</button>}
          {packs.map(item => <button key={item.id} type="button" className={pack?.id === item.id ? s.tabActive : s.tab}
            aria-pressed={pack?.id === item.id} onClick={() => setPackId(item.id)}>{item.title}</button>)}
        </div>}
        <div className={s.grid}>
          {!loaded && !star && <div className={s.hint}>Загружаем стикеры…</div>}
          {loaded && !pack && !star && <div className={s.hint}>Стикеров пока нет</div>}
          {star ? stickers.map(asset => <button key={asset.id} type="button" className={s.cell} title={asset.name}
            aria-label={`Отправить стикер ${asset.name}`} onClick={() => onStarSticker?.(asset)}>
            <img className={s.starSticker} src={asset.url} alt={asset.name} loading="lazy" />
          </button>) : pack?.stickers.map(sticker => <button key={sticker.id} type="button" className={s.cell}
            onClick={() => onPick(pack.id, sticker)} title={sticker.emoji} aria-label={`Отправить стикер ${sticker.emoji}`}>
            <Sticker url={stickerFileUrl(sticker)} emoji={sticker.emoji} size={64} mode="hover" />
          </button>)}
        </div>
        {pack && <div className={s.credit}>{pack.title}{pack.author ? ` · ${pack.author}` : ""}
          {pack.license && <>{" · "}{pack.license_url ? <a href={pack.license_url} target="_blank" rel="noopener noreferrer">{pack.license}</a> : pack.license}</>}
        </div>}
      </>}
    </div>
  </div>;
}
