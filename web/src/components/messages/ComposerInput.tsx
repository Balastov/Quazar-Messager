import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { applyFormat, continueList, formatForKey, insideCodeFence, type Edit, type FormatKind } from "../../chat/format";

type TextareaProps = Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange">;

interface Props extends TextareaProps {
  value: string;
  onValueChange: (value: string) => void;
  /** Самая большая высота, дальше — прокрутка внутри поля. */
  maxHeight?: number;
}

export interface ComposerHandle {
  focus: () => void;
  format: (kind: FormatKind) => void;
}

/** На тач-экранах Enter переносит строку, отправка — кнопкой (как в мобильных мессенджерах). */
const enterSends = () => !!window.matchMedia?.("(hover: hover) and (pointer: fine)").matches;

/**
 * Поле сообщения: многострочное, растёт по мере набора. Enter — отправить форму, Shift+Enter —
 * новая строка (в списке — новый пункт), внутри ``` Enter переносит строку. ⌘/Ctrl+B, I, E,
 * ⇧X, ⇧9, ⇧8, ⇧7, ⌥⇧C — разметка. Правки идут через insertText, поэтому ⌘Z их отменяет.
 */
const ComposerInput = forwardRef<HTMLTextAreaElement, Props & { handleRef?: React.Ref<ComposerHandle> }>(
  function ComposerInput({ value, onValueChange, maxHeight = 200, onKeyDown, handleRef, style, ...rest }, ref) {
    const inner = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(ref, () => inner.current as HTMLTextAreaElement);

    useLayoutEffect(() => {
      const el = inner.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
      el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
    }, [value, maxHeight]);

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

    useImperativeHandle(handleRef, () => ({ focus: () => inner.current?.focus(), format }));

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
      const newline = e.shiftKey || e.altKey || !enterSends() || insideCodeFence(el.value, el.selectionStart);
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
