import { useState } from "react";
import { formatWhen, toLocalInput, whenPresets } from "../../chat/when";
import ChatDialog from "./ChatDialog";
import c from "../constellation/Constellation.module.css";
import s from "./Chat.module.css";

interface Props {
  title: string;
  hint?: string;
  /** Бросает Error с текстом для пользователя. */
  onPick: (at: Date) => Promise<void>;
  onClose: () => void;
}

/** Когда: быстрые варианты или своя дата. Для отложенной отправки и напоминаний. */
export default function WhenDialog({ title, hint, onPick, onClose }: Props) {
  const presets = whenPresets();
  const [custom, setCustom] = useState(() => toLocalInput(new Date(Date.now() + 2 * 3600_000)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async (at: Date) => {
    if (busy) return;
    if (!Number.isFinite(at.getTime()) || at.getTime() < Date.now() + 60_000) {
      setError("Выберите время хотя бы через минуту");
      return;
    }
    if (at.getTime() > Date.now() + 365 * 86400_000) {
      setError("Выберите время не дальше чем через год");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onPick(at);
      onClose();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Не получилось — попробуйте ещё раз");
      setBusy(false);
    }
  };

  return (
    <ChatDialog title={title} onClose={onClose}>
      {hint && <p className={c.hint}>{hint}</p>}
      <div className={s.options}>
        {presets.map((p) => (
          <button key={p.label} type="button" className={s.option} disabled={busy} onClick={() => void pick(p.at)}>
            {p.label}
            <span className={s.optionHint}>{formatWhen(p.at)}</span>
          </button>
        ))}
      </div>
      <label className={c.label}>
        Своё время (часовой пояс устройства)
        <div className={s.custom}>
          <input
            type="datetime-local"
            className={c.input}
            value={custom}
            disabled={busy}
            min={toLocalInput(new Date())}
            onChange={(e) => setCustom(e.target.value)}
          />
          <button
            type="button"
            className={c.primary}
            disabled={busy || !custom}
            onClick={() => void pick(new Date(custom))}
          >
            Готово
          </button>
        </div>
      </label>
      {error && <div className={c.error}>{error}</div>}
    </ChatDialog>
  );
}
