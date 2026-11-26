import { useRef } from "react";
import type { ReactionGroup } from "../../chat/reactions";
import s from "./Messages.module.css";

/** Цитата в пузыре ответа. Нажатие — прокрутить к исходному сообщению. */
export function ReplyQuote({
  author,
  text,
  onClick,
  tone = "other",
}: {
  author: string;
  text: string;
  onClick?: () => void;
  tone?: "own" | "other";
}) {
  return (
    <button
      type="button"
      className={tone === "own" ? s.quoteOwn : s.quote}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
      title="Показать сообщение"
    >
      <span className={s.quoteAuthor}>{author}</span>
      <span className={s.quoteText}>{text}</span>
    </button>
  );
}

/** Реакции под сообщением; нажатие на чип — поставить такую же или снять свою. */
export function ReactionChips({
  groups,
  nameOf,
  onToggle,
}: {
  groups: ReactionGroup[];
  nameOf: (userId: string) => string;
  /** undefined — только смотреть (например, нет ключей шифрования). */
  onToggle?: (emoji: string) => void;
}) {
  if (!groups.length) return null;
  return (
    <div className={s.reactions}>
      {groups.map((g) => (
        <button
          key={g.emoji}
          type="button"
          className={g.mine ? s.chipMine : s.chip}
          disabled={!onToggle}
          aria-pressed={g.mine}
          title={g.userIds.map(nameOf).join(", ")}
          onClick={(e) => {
            e.stopPropagation();
            onToggle?.(g.emoji);
          }}
        >
          <span>{g.emoji}</span>
          {g.count > 1 && <span className={s.chipCount}>{g.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Полоса над полем ввода: «Ответ Ане: …» или «Редактирование». */
export function ComposerContext({
  kind,
  title,
  text,
  onCancel,
}: {
  kind: "reply" | "edit";
  title: string;
  text: string;
  onCancel: () => void;
}) {
  return (
    <div className={s.context}>
      <span className={s.contextIcon} aria-hidden>
        {kind === "reply" ? "↩" : "✎"}
      </span>
      <div className={s.contextBody}>
        <span className={s.contextTitle}>{title}</span>
        <span className={s.contextText}>{text}</span>
      </div>
      <button
        type="button"
        className={s.contextClose}
        onClick={onCancel}
        aria-label={kind === "reply" ? "Не отвечать" : "Отменить правку"}
        title="Esc"
      >
        ✕
      </button>
    </div>
  );
}

/** Подпись «изменено» рядом со временем. */
/** «изменено»; с onOpen — кнопка, открывающая историю правок. */
export function EditedMark({ at, onOpen }: { at: string | null | undefined; onOpen?: () => void }) {
  if (!at) return null;
  const when = new Date(at).toLocaleString("ru");
  if (!onOpen) {
    return (
      <span className={s.edited} title={when}>
        изменено
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`${s.edited} ${s.editedButton}`}
      title={`${when} — показать историю правок`}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      onContextMenu={(e) => e.stopPropagation()}
    >
      изменено
    </button>
  );
}

const LONG_PRESS_MS = 450;

/** Подпись к «Ответить» в меню: «⌥+клик» на Mac, «Alt+клик» на остальных; без мыши — не нужна. */
export function altClickHint(): string | undefined {
  if (typeof window === "undefined" || !window.matchMedia?.("(hover: hover) and (pointer: fine)").matches) return undefined;
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || "";
  return /mac/i.test(platform) ? "⌥+клик" : "Alt+клик";
}

/**
 * Открыть меню сообщения: правой кнопкой мыши или долгим нажатием пальцем
 * (iOS Safari contextmenu на долгое нажатие не шлёт — считаем сами).
 * onAltClick — клик с зажатым Alt (⌥ на Mac): сразу ответить на сообщение.
 */
export function useMessageMenuTrigger(open: (x: number, y: number) => void, onAltClick?: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);

  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  };

  return {
    onClickCapture: (e: React.MouseEvent) => {
      // Alt+клик — ответ на сообщение. Обычные клики (ссылки, картинки, кнопки) — как раньше.
      // На фазе захвата: раньше ссылок, цитат и аватаров внутри (Alt+клик по ссылке иначе скачал бы её).
      if (!e.altKey || !onAltClick || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      window.getSelection()?.removeAllRanges();
      onAltClick();
    },
    onContextMenu: (e: React.MouseEvent) => {
      // Ссылку и картинку правой кнопкой — как обычно (открыть, сохранить).
      if ((e.target as HTMLElement).closest("a, img, video")) return;
      e.preventDefault();
      cancel();
      open(e.clientX, e.clientY);
    },
    onTouchStart: (e: React.TouchEvent) => {
      if (e.touches.length !== 1) return cancel();
      const t = e.touches[0];
      start.current = { x: t.clientX, y: t.clientY };
      timer.current = setTimeout(() => {
        const at = start.current;
        cancel();
        if (at) open(at.x, at.y);
      }, LONG_PRESS_MS);
    },
    onTouchMove: (e: React.TouchEvent) => {
      const t = e.touches[0];
      const at = start.current;
      // Палец поехал — это прокрутка, а не долгое нажатие.
      if (at && Math.hypot(t.clientX - at.x, t.clientY - at.y) > 10) cancel();
    },
    onTouchEnd: cancel,
    onTouchCancel: cancel,
  };
}

/** Прокрутить ленту к сообщению и ненадолго подсветить его. */
export function revealMessage(container: HTMLElement | null, messageId: string): boolean {
  const el = container?.querySelector<HTMLElement>(`[data-mid="${CSS.escape(messageId)}"]`);
  if (!el) return false;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove(s.flash);
  void el.offsetWidth; // перезапустить анимацию, если подсветка ещё идёт
  el.classList.add(s.flash);
  setTimeout(() => el.classList.remove(s.flash), 1600);
  return true;
}
