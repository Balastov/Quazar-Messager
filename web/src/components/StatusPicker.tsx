import { useState } from "react";
import { setMyManualStatus, useMyManualStatus } from "../store/presence";
import { MANUAL_LABEL, untilText, type ManualKind } from "../utils/presence";
import s from "./StatusPicker.module.css";

type Duration = { label: string; until: () => Date | null };

const DURATIONS: Duration[] = [
  { label: "30 минут", until: () => new Date(Date.now() + 30 * 60_000) },
  { label: "1 час", until: () => new Date(Date.now() + 60 * 60_000) },
  { label: "2 часа", until: () => new Date(Date.now() + 120 * 60_000) },
  {
    label: "До конца дня",
    until: () => {
      const d = new Date();
      d.setHours(23, 59, 0, 0);
      return d;
    },
  },
  { label: "Пока не сниму", until: () => null },
];

const KINDS: { kind: ManualKind; icon: string; hint: string }[] = [
  { kind: "meeting", icon: "📅", hint: "Видно собеседникам вместо «отошёл(ла)» — например, пока вы в Zoom или Телемосте" },
  { kind: "dnd", icon: "⛔", hint: "Ещё и без уведомлений о сообщениях, стуке и приглашениях. Звонки звонят как обычно" },
];

/** «На встрече» / «Не беспокоить» с таймером. */
export default function StatusPicker({ onDone }: { onDone?: () => void }) {
  const current = useMyManualStatus();
  const [kind, setKind] = useState<ManualKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = async (nextKind: ManualKind | null, until: Date | null) => {
    setBusy(true);
    setError(null);
    try {
      await setMyManualStatus(nextKind, until);
      setKind(null);
      onDone?.();
    } catch {
      setError("Не удалось сменить статус. Проверьте интернет.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.root}>
      {current && (
        <div className={s.current}>
          <span>
            {current.kind === "dnd" ? "⛔" : "📅"} Сейчас: {MANUAL_LABEL[current.kind]}
            {current.until ? ` ${untilText(current.until)}` : ""}
          </span>
          <button type="button" className={s.clear} disabled={busy} onClick={() => void apply(null, null)}>
            Снять
          </button>
        </div>
      )}
      {KINDS.map((k) => (
        <div key={k.kind} className={s.kind}>
          <button
            type="button"
            className={kind === k.kind ? s.kindBtnActive : s.kindBtn}
            onClick={() => setKind(kind === k.kind ? null : k.kind)}
            disabled={busy}
            aria-expanded={kind === k.kind}
          >
            <span>
              {k.icon} {MANUAL_LABEL[k.kind][0].toUpperCase() + MANUAL_LABEL[k.kind].slice(1)}
            </span>
            <span className={s.hint}>{k.hint}</span>
          </button>
          {kind === k.kind && (
            <div className={s.durations}>
              {DURATIONS.map((d) => (
                <button
                  key={d.label}
                  type="button"
                  className={s.duration}
                  disabled={busy}
                  onClick={() => void apply(k.kind, d.until())}
                >
                  {d.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
      {error && <div className={s.error}>{error}</div>}
    </div>
  );
}
