import { useState } from "react";
import { FORMAT_HINTS, type FormatKind } from "../../chat/format";
import f from "./Formatted.module.css";

const BUTTONS: { kind: FormatKind; label: React.ReactNode }[] = [
  { kind: "bold", label: <b>B</b> },
  { kind: "italic", label: <i>I</i> },
  { kind: "strike", label: <s>S</s> },
  { kind: "code", label: <span className={f.barMono}>{"</>"}</span> },
  { kind: "codeblock", label: <span className={f.barMono}>{"{ }"}</span> },
  { kind: "quote", label: "❝" },
  { kind: "bullet", label: "•≡" },
  { kind: "numbered", label: "1." },
];

const KEY = "quazar.formatBar";

/** Показывать ли панель разметки над полем ввода — запоминаем выбор. */
export function useFormatBarOpen(): [boolean, () => void] {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setOpen((v) => {
      try {
        localStorage.setItem(KEY, v ? "0" : "1");
      } catch {
        // без localStorage — просто не запомним
      }
      return !v;
    });
  return [open, toggle];
}

/** Кнопки разметки. Нажатие не уводит фокус из поля, поэтому выделение сохраняется. */
export default function FormatBar({
  onFormat,
  disabled,
  className,
}: {
  onFormat: (kind: FormatKind) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={className ? `${f.bar} ${className}` : f.bar} role="toolbar" aria-label="Форматирование">
      {BUTTONS.map((b) => (
        <button
          key={b.kind}
          type="button"
          className={f.barBtn}
          title={FORMAT_HINTS[b.kind]}
          aria-label={FORMAT_HINTS[b.kind]}
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onFormat(b.kind)}
        >
          {b.label}
        </button>
      ))}
    </div>
  );
}
