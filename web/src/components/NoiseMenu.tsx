/**
 * Меню у кнопки шумодава (звонок, Планета): «Без обработки», RNNoise, GTCRN.
 * Рисуется в body — стеклянные панели (backdrop-filter) иначе перекрывают его.
 * Привязано к нажатой кнопке (event.currentTarget): Safari не переводит фокус на кнопку.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  getNoiseEnginePref,
  setNoiseEnginePref,
  subscribeNoiseEngine,
  type NoiseEngine,
} from "../calls/noiseSuppression";
import s from "./NoiseMenu.module.css";

export type NoiseMode = "off" | NoiseEngine;

const MODES: { id: NoiseMode; title: string; hint: string; strength: number }[] = [
  { id: "off", title: "Без обработки", hint: "Только базовый фильтр браузера", strength: 0 },
  { id: "rnnoise", title: "RNNoise", hint: "Лёгкая: вентилятор, гул, улица", strength: 2 },
  { id: "gtcrn", title: "GTCRN", hint: "Сильная: ещё клавиатура и геймпад", strength: 3 },
];

export const NOISE_MODE_TITLE: Record<NoiseMode, string> = { off: "без обработки", rnnoise: "RNNoise", gtcrn: "GTCRN" };

/** Выбранная нейросеть; обновляется, когда её меняют в меню или настройках. */
export function useNoiseEngine(): NoiseEngine {
  return useSyncExternalStore(subscribeNoiseEngine, getNoiseEnginePref);
}

const EDGE = 8;
const GAP = 10;

/**
 * Состояние и меню для кнопки шумодава.
 * enabled/toggle — шумоподавление в сторе разговора (звонок или Планета);
 * unavailable — включено, но на этом устройстве не запустилось.
 */
export function useNoiseMenu({ enabled, toggle, unavailable = false }: {
  enabled: boolean;
  toggle: () => void | Promise<void>;
  unavailable?: boolean;
}) {
  const engine = useNoiseEngine();
  const mode: NoiseMode = enabled ? engine : "off";
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const close = useCallback(() => setAnchor(null), []);

  const onButtonClick = (event: React.MouseEvent<HTMLElement>) => {
    const target = event.currentTarget;
    setAnchor((current) => (current === target ? null : target));
  };

  const pick = (next: NoiseMode) => {
    if (next === "off") {
      if (enabled) void toggle();
    } else {
      if (next !== engine) setNoiseEnginePref(next);
      if (!enabled) void toggle();
    }
  };

  const menu = anchor ? (
    <NoiseMenu anchor={anchor} mode={mode} unavailable={unavailable && enabled} onPick={pick} onClose={close} />
  ) : null;
  return { mode, engine, expanded: anchor !== null, onButtonClick, menu };
}

function NoiseMenu({ anchor, mode, unavailable, onPick, onClose }: {
  anchor: HTMLElement;
  mode: NoiseMode;
  unavailable: boolean;
  onPick: (mode: NoiseMode) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Над кнопкой (панель управления разговором — внизу); не влезает — под ней.
  useLayoutEffect(() => {
    const place = () => {
      const el = ref.current;
      if (!el) return;
      const rect = anchor.getBoundingClientRect();
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      const left = Math.max(EDGE, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - EDGE));
      const above = rect.top - GAP - height;
      const top = above >= EDGE ? above : Math.min(rect.bottom + GAP, window.innerHeight - height - EDGE);
      setPos({ left, top: Math.max(EDGE, top) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor]);

  // Фокус — на выбранный вариант: меню сразу управляется стрелками.
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, []);

  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      // Нажатие на саму кнопку закроет меню её же обработчиком.
      if (!ref.current?.contains(target) && !anchor.contains(target)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        anchor.focus();
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  return createPortal(
    <div
      ref={ref}
      className={s.menu}
      style={pos ?? { left: -9999, top: -9999 }}
      role="menu"
      aria-label="Шумоподавление"
      onKeyDown={onKeyDown}
    >
      <div className={s.title}>Шумоподавление</div>
      {MODES.map((item) => {
        const checked = item.id === mode;
        return (
          <button
            key={item.id}
            type="button"
            role="menuitemradio"
            aria-checked={checked}
            className={checked ? `${s.item} ${s.checked}` : s.item}
            onClick={() => {
              onPick(item.id);
              onClose();
            }}
          >
            <span className={s.radio} aria-hidden />
            <span className={s.text}>
              <span className={s.name}>
                {item.title}
                {item.id === "gtcrn" && <span className={s.badge}>по умолчанию</span>}
              </span>
              <span className={s.hint}>{item.hint}</span>
            </span>
            <span className={s.strength} aria-hidden>
              {[1, 2, 3].map((bar) => (
                <span key={bar} className={bar <= item.strength ? s.barOn : s.bar} style={{ height: 4 + bar * 4 }} />
              ))}
            </span>
          </button>
        );
      })}
      {unavailable && (
        <p className={s.note} role="status">
          На этом устройстве нейросеть не запустилась — работает фильтр браузера.
        </p>
      )}
    </div>,
    document.body
  );
}
