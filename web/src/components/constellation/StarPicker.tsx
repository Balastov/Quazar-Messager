import { useEffect, useRef, useState } from "react";
import type { StarAsset } from "../../api/stars";
import { stickerFileUrl, type StickerInfo } from "../../api/stickers";
import { useStickersStore } from "../../store/stickers";
import Sticker from "../Sticker";
import p from "../StickerPicker.module.css";
import g from "./Gaming.module.css";

interface Props {
  /** Стикеры и эмодзи этой Звезды. */
  assets: StarAsset[];
  onSticker: (text: string) => void;
  onEmoji: (code: string) => void;
  onClose: () => void;
}

/** Панель Спутника: эмодзи и стикеры Звезды, общие стикеры. */
export default function StarPicker({ assets, onSticker, onEmoji, onClose }: Props) {
  const packs = useStickersStore((st) => st.packs);
  const load = useStickersStore((st) => st.load);
  const emoji = assets.filter((a) => a.kind === "emoji");
  const stickers = assets.filter((a) => a.kind === "sticker");
  const hasStar = emoji.length + stickers.length > 0;
  const [tab, setTab] = useState<string>(hasStar ? "star" : "");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (rootRef.current?.contains(target) || target?.closest("[data-sticker-toggle]")) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [onClose]);

  const pack = packs.find((x) => x.id === tab) ?? (tab === "star" ? undefined : packs[0]);

  return (
    <div ref={rootRef} className={`${p.picker} ${g.picker}`} role="dialog" aria-label="Стикеры и эмодзи">
      <div className={p.tabs}>
        {hasStar && (
          <button type="button" className={tab === "star" ? p.tabActive : p.tab} onClick={() => setTab("star")}>
            Звезда
          </button>
        )}
        {packs.map((x) => (
          <button key={x.id} type="button" className={pack?.id === x.id ? p.tabActive : p.tab} onClick={() => setTab(x.id)}>
            {x.title}
          </button>
        ))}
      </div>
      {tab === "star" ? (
        <div className={g.pickerBody}>
          {emoji.length > 0 && (
            <div className={g.emojiGrid}>
              {emoji.map((e) => (
                <button key={e.id} type="button" className={g.emojiButton} title={`:${e.name}:`} onClick={() => onEmoji(`:${e.name}:`)}>
                  <img src={e.url} alt={`:${e.name}:`} />
                </button>
              ))}
            </div>
          )}
          <div className={p.grid}>
            {stickers.map((st) => (
              <button key={st.id} type="button" className={p.cell} title={st.name} onClick={() => onSticker(`STK1:star/${st.id}`)}>
                <img className={g.starSticker} src={st.url} alt={st.name} />
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className={p.grid}>
          {pack?.stickers.map((st: StickerInfo) => (
            <button key={st.id} type="button" className={p.cell} title={st.emoji} onClick={() => onSticker(`STK1:${pack.id}/${st.id}`)}>
              <Sticker url={stickerFileUrl(st)} emoji={st.emoji} size={72} mode="hover" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
