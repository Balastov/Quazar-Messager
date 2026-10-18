import { useEffect, useRef, useState } from "react";
import { stickerFileUrl, type StickerInfo } from "../api/stickers";
import { useStickersStore } from "../store/stickers";
import Sticker from "./Sticker";
import s from "./StickerPicker.module.css";

interface Props {
  onPick: (packId: string, sticker: StickerInfo) => void;
  onClose: () => void;
}

/** Панель стикеров над полем ввода: вкладки паков и сетка, нажатие — сразу отправка. */
export default function StickerPicker({ onPick, onClose }: Props) {
  const packs = useStickersStore((st) => st.packs);
  const loaded = useStickersStore((st) => st.loaded);
  const load = useStickersStore((st) => st.load);
  const [packId, setPackId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      // Кнопка, открывающая панель, сама её и закроет.
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

  const pack = packs.find((p) => p.id === packId) ?? packs[0];

  return (
    <div ref={rootRef} className={s.picker} role="dialog" aria-label="Стикеры">
      {packs.length > 1 && (
        <div className={s.tabs}>
          {packs.map((p) => (
            <button
              key={p.id}
              type="button"
              className={p.id === pack?.id ? s.tabActive : s.tab}
              onClick={() => setPackId(p.id)}
            >
              {p.title}
            </button>
          ))}
        </div>
      )}
      <div className={s.grid}>
        {!loaded && <div className={s.hint}>Загружаем стикеры…</div>}
        {pack?.stickers.map((st) => (
          <button
            key={st.id}
            type="button"
            className={s.cell}
            onClick={() => onPick(pack.id, st)}
            title={st.emoji}
            aria-label={`Отправить стикер ${st.emoji}`}
          >
            <Sticker url={stickerFileUrl(st)} emoji={st.emoji} size={64} mode="hover" />
          </button>
        ))}
      </div>
      {pack && (
        <div className={s.credit}>
          {pack.title}
          {pack.author ? ` · ${pack.author}` : ""}
          {pack.license && (
            <>
              {" · "}
              {pack.license_url ? (
                <a href={pack.license_url} target="_blank" rel="noopener noreferrer">
                  {pack.license}
                </a>
              ) : (
                pack.license
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
