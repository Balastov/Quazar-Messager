import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { applyFormat, continueList, formatForKey, insideCodeFence, type Edit, type FormatKind } from "../../chat/format";
import { COMPACT_COMPOSER } from "../../chat/useCompactComposer";

type TextareaProps = Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange">;

interface Props extends TextareaProps {
  value: string;
  onValueChange: (value: string) => void;
  /** Самая большая высота, дальше — прокрутка внутри поля. */
  maxHeight?: number;
  /** Для документов с собственной прокруткой ограничение мобильного чата не нужно. */
  limitToViewport?: boolean;
  /** false — Enter всегда переносит строку (заметки), отправки нет. */
  submitOnEnter?: boolean;
}

export interface ComposerHandle {
  focus: () => void;
  format: (kind: FormatKind) => void;
  insertText: (text: string) => void;
}

/** На тач-экранах Enter переносит строку, отправка — кнопкой (как в мобильных мессенджерах). */
const enterSends = () => !!window.matchMedia?.("(hover: hover) and (pointer: fine)").matches;

/**
 * Поле сообщения: многострочное, растёт по мере набора. Enter — отправить форму, Shift+Enter —
 * новая строка (в списке — новый пункт), внутри ``` Enter переносит строку. ⌘/Ctrl+B, I, E,
 * ⇧X, ⇧9, ⇧8, ⇧7, ⌥⇧C — разметка. Правки идут через insertText, поэтому ⌘Z их отменяет.
 */
const ComposerInput = forwardRef<HTMLTextAreaElement, Props & { handleRef?: React.Ref<ComposerHandle> }>(
  function ComposerInput(
    { value, onValueChange, maxHeight = 200, limitToViewport = true, submitOnEnter = true, onKeyDown, handleRef, style, ...rest },
    ref
  ) {
    const inner = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(ref, () => inner.current as HTMLTextAreaElement);

    const resize = useCallback(() => {
      const el = inner.current;
      if (!el) return;
      const compact = limitToViewport && window.matchMedia?.(COMPACT_COMPOSER).matches;
      const viewport = window.visualViewport?.height ?? window.innerHeight;
      const computed = getComputedStyle(el);
      const lineHeight = parseFloat(computed.lineHeight) || (parseFloat(computed.fontSize) || 16) * 1.375;
      const padding = (parseFloat(computed.paddingTop) || 0) + (parseFloat(computed.paddingBottom) || 0);
      const border = (parseFloat(computed.borderTopWidth) || 0) + (parseFloat(computed.borderBottomWidth) || 0);
      const borderBox = computed.boxSizing === "border-box";
      const threeLines = lineHeight * 3 + (borderBox ? padding + border : 0);
      // Three text lines at most; a short visual viewport can reduce that further.
      const limit = compact ? Math.min(maxHeight, threeLines, Math.max(44, Math.floor(viewport * 0.3))) : maxHeight;
      el.style.maxHeight = `${limit}px`;
      el.style.height = "auto";
      const height = el.scrollHeight + (borderBox ? border : -padding);
      el.style.height = `${Math.min(height, limit)}px`;
      el.style.overflowY = height > limit ? "auto" : "hidden";
    }, [maxHeight, limitToViewport]);

    useLayoutEffect(resize, [value, resize]);
    useLayoutEffect(() => {
      const el = inner.current;
      if (!el) return;
      const viewport = window.visualViewport;
      window.addEventListener("resize", resize);
      viewport?.addEventListener("resize", resize);
      let width = el.clientWidth;
      const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
        if (el.clientWidth !== width) { width = el.clientWidth; resize(); }
      });
      observer?.observe(el);
      return () => {
        window.removeEventListener("resize", resize);
        viewport?.removeEventListener("resize", resize);
        observer?.disconnect();
      };
    }, [resize]);

    const apply = (edit: Edit) => {
      const el = inner.current;
      if (!el) return;
      const old = el.value;
      // Меняем только отличающийся кусок — так правка попадает в историю отмены поля.
      let a = 0;
      while (a < old.length && a < edit.value.length && old[a] === edit.value[a]) a++;
      let b = 0;
      while (
        b < old.length - a &&
        b < edit.value.length - a &&
        old[old.length - 1 - b] === edit.value[edit.value.length - 1 - b]
      )
        b++;
      el.focus();
      el.setSelectionRange(a, old.length - b);
      const inserted = edit.value.slice(a, edit.value.length - b);
      let ok = false;
      try {
        ok = inserted ? document.execCommand("insertText", false, inserted) : document.execCommand("delete");
      } catch {
        ok = false;
      }
      // execCommand не сработал (пустая вставка или старый браузер) — ставим значение сами.
      if (!ok || el.value !== edit.value) onValueChange(edit.value);
      requestAnimationFrame(() => {
        el.setSelectionRange(edit.start, edit.end);
      });
    };

    const format = (kind: FormatKind) => {
      const el = inner.current;
      if (!el) return;
      apply(applyFormat(el.value, el.selectionStart, el.selectionEnd, kind));
    };

    const insertText = (text: string) => {
      const el = inner.current;
      if (!el) return;
      const start = el.selectionStart, end = el.selectionEnd;
      if (el.maxLength >= 0 && el.value.length - (end - start) + text.length > el.maxLength) return;
      apply({ value: el.value.slice(0, start) + text + el.value.slice(end), start: start + text.length, end: start + text.length });
    };
    useImperativeHandle(handleRef, () => ({ focus: () => inner.current?.focus(), format, insertText }));

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      onKeyDown?.(e);
      if (e.defaultPrevented) return;
      const kind = formatForKey(e);
      if (kind) {
        e.preventDefault();
        format(kind);
        return;
      }
      if (e.key !== "Enter" || e.nativeEvent.isComposing || e.keyCode === 229) return;
      const el = e.currentTarget;
      const newline =
        !submitOnEnter || e.shiftKey || e.altKey || !enterSends() || insideCodeFence(el.value, el.selectionStart);
      if (newline) {
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        const edit = continueList(el.value, el.selectionStart, el.selectionEnd);
        if (edit) {
          e.preventDefault();
          apply(edit);
        }
        return;
      }
      e.preventDefault();
      el.form?.requestSubmit();
    };

    return (
      <textarea
        {...rest}
        ref={inner}
        rows={1}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={handleKeyDown}
        style={{ resize: "none", ...style }}
      />
    );
  }
);

export default ComposerInput;
