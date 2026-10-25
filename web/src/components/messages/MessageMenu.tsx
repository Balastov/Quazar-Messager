import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { REACTIONS } from "../../chat/reactions";
import s from "./Messages.module.css";

export interface MenuAction {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

interface Props {
  /** Точка, у которой открыть меню (клик правой кнопкой, долгое нажатие, кнопка «⋯»). */
  at: { x: number; y: number };
  /** null — реакции здесь ставить нельзя (например, нет ключей шифрования). */
  reaction: { current: string | null; onPick: (emoji: string) => void } | null;
  actions: MenuAction[];
  onClose: () => void;
}

const EDGE = 8;

/**
 * Меню сообщения: строка реакций и действия. Рисуется в body — пузыри и панели
 * со стеклом (backdrop-filter) иначе перекрывают его, какой z-index ни ставь.
 */
export default function MessageMenu({ at, reaction, actions, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: at.x, top: at.y });

  // Не вылезать за край экрана: у нижнего края — раскрываться вверх, у правого — влево.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // offset*, а не getBoundingClientRect: тот учитывает scale анимации появления.
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const left = Math.max(EDGE, Math.min(at.x, window.innerWidth - width - EDGE));
    const top =
      at.y + height + EDGE > window.innerHeight
        ? Math.max(EDGE, at.y - height)
        : at.y;
    setPos({ left, top });
  }, [at.x, at.y]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Прокрутили ленту или изменили окно — меню уже не у своего сообщения.
    const onMove = () => onClose();
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onMove);
    document.addEventListener("wheel", onMove, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onMove);
      document.removeEventListener("wheel", onMove);
    };
  }, [onClose]);

  const run = (fn: () => void) => {
    onClose();
    fn();
  };

  return createPortal(
    <div ref={ref} className={s.menu} style={pos} role="menu">
      {reaction && (
        <div className={s.menuReactions} role="group" aria-label="Реакции">
          {REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className={emoji === reaction.current ? s.menuEmojiActive : s.menuEmoji}
              aria-pressed={emoji === reaction.current}
              aria-label={emoji === reaction.current ? `Убрать ${emoji}` : `Реакция ${emoji}`}
              onClick={() => run(() => reaction.onPick(emoji))}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
      {actions.map((a) => (
        <button
          key={a.label}
          type="button"
          role="menuitem"
          className={a.danger ? s.menuItemDanger : s.menuItem}
          onClick={() => run(a.onClick)}
        >
          {a.label}
        </button>
      ))}
    </div>,
    document.body
  );
}
