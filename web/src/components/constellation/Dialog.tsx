import { useEffect } from "react";
import s from "./Constellation.module.css";

interface Props {
  title: string;
  onClose: () => void;
  wide?: boolean;
  children: React.ReactNode;
}

export default function Dialog({ title, onClose, wide = false, children }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className={s.overlay} onClick={onClose}>
      <div
        className={wide ? `${s.dialog} ${s.dialogWide}` : s.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={s.dialogHeader}>
          <h3 className={s.dialogTitle}>{title}</h3>
          <button type="button" className={s.close} onClick={onClose} aria-label="Закрыть">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
