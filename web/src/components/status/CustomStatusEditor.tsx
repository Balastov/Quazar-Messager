import { useEffect, useState } from "react";
import { setMyCustomStatus } from "../../store/presence";
import { useAuthStore } from "../../store/auth";
import { useCustomStatus } from "../../store/presence";
import { toLocalInput } from "../../chat/when";
import { untilText } from "../../utils/presence";
import { STATUS_ICONS, STATUS_ICON_NAMES } from "./statusIcons";
import s from "./CustomStatus.module.css";

type UntilChoice = "none" | "30m" | "1h" | "4h" | "today" | "week" | "custom";

const UNTIL_OPTIONS: { id: UntilChoice; label: string }[] = [
  { id: "none", label: "Не снимать" },
  { id: "30m", label: "30 минут" },
  { id: "1h", label: "1 час" },
  { id: "4h", label: "4 часа" },
  { id: "today", label: "До конца дня" },
  { id: "week", label: "До конца недели" },
  { id: "custom", label: "Выбрать дату и время…" },
];

function untilFor(choice: UntilChoice, custom: string): Date | null {
  const now = new Date();
  switch (choice) {
    case "30m":
      return new Date(now.getTime() + 30 * 60_000);
    case "1h":
      return new Date(now.getTime() + 60 * 60_000);
    case "4h":
      return new Date(now.getTime() + 4 * 60 * 60_000);
    case "today": {
      const d = new Date(now);
      d.setHours(23, 59, 0, 0);
      return d;
    }
    case "week": {
      const d = new Date(now);
      d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
      d.setHours(23, 59, 0, 0);
      return d;
    }
    case "custom":
      return custom ? new Date(custom) : null;
    default:
      return null;
  }
}

/** Свой статус: значок из набора, текст и «до». Только подпись — уведомления и звонки не трогает. */
export default function CustomStatusEditor({ onDone }: { onDone?: () => void }) {
  const myId = useAuthStore((st) => st.user?.id);
  const current = useCustomStatus(myId);
  const [icon, setIcon] = useState<string | null>(current?.icon ?? null);
  const [text, setText] = useState(current?.text ?? "");
  const [choice, setChoice] = useState<UntilChoice>(current?.until ? "custom" : "none");
  const [custom, setCustom] = useState(current?.until ? toLocalInput(new Date(current.until)) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setIcon(current?.icon ?? null);
    setText(current?.text ?? "");
    setChoice(current?.until ? "custom" : "none");
    setCustom(current?.until ? toLocalInput(new Date(current.until)) : "");
  }, [current?.icon, current?.text, current?.until]);

  const save = async () => {
    const until = untilFor(choice, custom);
    if (choice === "custom" && (!until || Number.isNaN(until.getTime()) || until <= new Date())) {
      setError("Выберите время в будущем");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await setMyCustomStatus({ icon, text: text.trim(), until });
      onDone?.();
    } catch {
      setError("Не удалось сохранить статус. Проверьте интернет.");
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    setError(null);
    try {
      await setMyCustomStatus(null);
      onDone?.();
    } catch {
      setError("Не удалось снять статус.");
    } finally {
      setBusy(false);
    }
  };

  const Selected = icon ? STATUS_ICONS[icon]?.Icon : undefined;

  return (
    <div className={s.editor}>
      <div className={s.inputRow}>
        <span className={s.preview} aria-hidden>
          {Selected ? <Selected size={18} /> : "🙂"}
        </span>
        <input
          className={s.input}
          value={text}
          maxLength={80}
          placeholder={icon ? STATUS_ICONS[icon]?.label : "Что у вас сейчас? Например, «в отпуске»"}
          aria-label="Текст статуса"
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      <div className={s.icons} role="listbox" aria-label="Значок статуса">
        {STATUS_ICON_NAMES.map((name) => {
          const { Icon, label } = STATUS_ICONS[name];
          return (
            <button
              key={name}
              type="button"
              role="option"
              aria-selected={icon === name}
              className={icon === name ? `${s.iconBtn} ${s.iconActive}` : s.iconBtn}
              title={label}
              aria-label={label}
              onClick={() => setIcon(icon === name ? null : name)}
            >
              <Icon size={18} />
            </button>
          );
        })}
      </div>
      <label className={s.label}>
        Снять статус
        <select className={s.select} value={choice} onChange={(e) => setChoice(e.target.value as UntilChoice)}>
          {UNTIL_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {choice === "custom" && (
        <input
          className={s.input}
          type="datetime-local"
          value={custom}
          min={toLocalInput(new Date())}
          aria-label="До"
          onChange={(e) => setCustom(e.target.value)}
        />
      )}
      {current?.until && <p className={s.hint}>Сейчас стоит {untilText(current.until)}</p>}
      {error && <div className={s.error}>{error}</div>}
      <div className={s.actions}>
        <button type="button" className={s.save} disabled={busy || (!icon && !text.trim())} onClick={() => void save()}>
          Сохранить
        </button>
        {current && (
          <button type="button" className={s.clearBtn} disabled={busy} onClick={() => void clear()}>
            Снять
          </button>
        )}
      </div>
    </div>
  );
}
