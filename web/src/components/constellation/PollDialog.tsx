import { useState } from "react";
import { starsApi } from "../../api/stars";
import Dialog from "./Dialog";
import { apiError } from "./rules";
import s from "./Constellation.module.css";
import g from "./Gaming.module.css";

const DURATIONS: { label: string; minutes: number | null }[] = [
  { label: "Пока не закроют", minutes: null },
  { label: "1 час", minutes: 60 },
  { label: "1 день", minutes: 1440 },
  { label: "1 неделя", minutes: 10080 },
];

/** Новый опрос в Спутнике: вопрос, 2–10 вариантов, один или несколько, анонимно или нет. */
export default function PollDialog({ starId, channelId, onClose }: { starId: string; channelId: string; onClose: () => void }) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [multiple, setMultiple] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filled = options.map((o) => o.trim()).filter(Boolean);
  const valid = question.trim() && filled.length >= 2;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await starsApi.createPoll(starId, channelId, {
        question: question.trim(),
        options: filled,
        multiple,
        anonymous,
        closes_in_minutes: duration,
      });
      onClose();
    } catch (err) {
      setError(apiError(err, "Не удалось создать опрос"));
      setBusy(false);
    }
  };

  return (
    <Dialog title="Опрос" onClose={onClose}>
      <form className={g.form} onSubmit={(e) => void submit(e)}>
        <label className={s.label}>
          Вопрос
          <input className={s.input} value={question} maxLength={300} autoFocus onChange={(e) => setQuestion(e.target.value)} placeholder="Какую карту играем?" />
        </label>
        <div className={s.label}>
          Варианты
          {options.map((o, i) => (
            <div key={i} className={g.optionRow}>
              <input
                className={s.input}
                value={o}
                maxLength={100}
                placeholder={`Вариант ${i + 1}`}
                onChange={(e) => setOptions((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
              />
              {options.length > 2 && (
                <button type="button" className={g.iconButton} aria-label="Убрать вариант" onClick={() => setOptions((prev) => prev.filter((_, j) => j !== i))}>
                  ✕
                </button>
              )}
            </div>
          ))}
          {options.length < 10 && (
            <button type="button" className={`${s.secondary} ${s.small}`} onClick={() => setOptions((prev) => [...prev, ""])}>
              + Вариант
            </button>
          )}
        </div>
        <label className={g.check}>
          <input type="checkbox" checked={multiple} onChange={(e) => setMultiple(e.target.checked)} />
          Можно выбрать несколько
        </label>
        <label className={g.check}>
          <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} />
          Анонимно — не показывать, кто как голосовал
        </label>
        <label className={s.label}>
          Закрыть сам
          <select className={s.select} value={duration ?? ""} onChange={(e) => setDuration(e.target.value ? Number(e.target.value) : null)}>
            {DURATIONS.map((d) => (
              <option key={d.label} value={d.minutes ?? ""}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        {error && <div className={s.error}>{error}</div>}
        <button type="submit" className={s.primary} disabled={!valid || busy}>
          Опубликовать
        </button>
      </form>
    </Dialog>
  );
}
