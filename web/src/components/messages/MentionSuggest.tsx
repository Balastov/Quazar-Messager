import { useEffect, useState } from "react";
import { insertMention, mentionQuery, suggestNames } from "../../chat/mentions";
import w from "../constellation/Work.module.css";

interface Options {
  text: string;
  setText: (value: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** Кого можно упомянуть (без себя). */
  names: string[];
  /** Предлагать ли @все. */
  allowAll?: boolean;
}

/**
 * Подсказка «@имя» в поле ввода. Возвращает всплывающий список (класть в обёртку с
 * position: relative) и обработчик клавиш: ↑↓ — выбор, Enter/Tab — подставить, Esc — скрыть.
 */
export function useMentionSuggest({ text, setText, inputRef, names, allowAll = false }: Options) {
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [hiddenFor, setHiddenFor] = useState<string | null>(null);

  const query = mentionQuery(text, caret);
  const candidates = allowAll ? [...names, "все"] : names;
  const items = query && hiddenFor !== text ? suggestNames(candidates, query.query) : [];

  useEffect(() => setActive(0), [query?.query]);

  const syncCaret = () => setCaret(inputRef.current?.selectionStart ?? text.length);

  const pick = (name: string) => {
    if (!query) return;
    const next = insertMention(text, query.start, caret, name);
    setText(next.text);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  };

  /** true — клавишу обработала подсказка (форме её не отдавать). */
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): boolean => {
    if (!items.length) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      pick(items[Math.min(active, items.length - 1)]);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setHiddenFor(text);
      return true;
    }
    return false;
  };

  const popup = items.length ? (
    <div className={w.suggest} role="listbox" aria-label="Кого упомянуть">
      {items.map((name, i) => (
        <button
          key={name}
          type="button"
          role="option"
          aria-selected={i === active}
          className={i === active ? `${w.suggestItem} ${w.suggestActive}` : w.suggestItem}
          // mousedown: до того как поле потеряет фокус.
          onMouseDown={(e) => {
            e.preventDefault();
            pick(name);
          }}
        >
          @{name}
          {name === "все" && <span className={w.suggestHint}>всем участникам</span>}
        </button>
      ))}
    </div>
  ) : null;

  return { popup, onKeyDown, syncCaret };
}
