import { useId } from "react";
import { EyeOff, Phone } from "lucide-react";
import s from "./PhoneVisibilityChoice.module.css";

export const PHONE_VISIBILITY_QUESTION = "Вас можно найти по номеру телефона?";

const OPTIONS = [
  {
    value: true,
    label: "Да",
    Icon: Phone,
    hint: "вас могут найти через поиск, зная ваш номер телефона.",
  },
  {
    value: false,
    label: "Нет",
    Icon: EyeOff,
    hint: "вас найдут только по никнейму или по имени и фамилии. Номер не увидит никто.",
  },
] as const;

interface Props {
  /** null — ещё не выбрано: значения по умолчанию нет, выбор обязателен. */
  value: boolean | null;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  /** Вопрос над переключателем (в окне он уже в заголовке). */
  showQuestion?: boolean;
}

/** «Да / Нет» с бегунком и расшифровкой вариантов. */
export default function PhoneVisibilityChoice({ value, onChange, disabled, showQuestion = true }: Props) {
  const questionId = useId();

  const onKey = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") onChange(true);
    else if (e.key === "ArrowRight" || e.key === "ArrowDown") onChange(false);
    else return;
    e.preventDefault();
  };

  return (
    <div className={s.root}>
      {showQuestion && (
        <div id={questionId} className={s.question}>
          {PHONE_VISIBILITY_QUESTION}
        </div>
      )}
      <div
        role="radiogroup"
        aria-labelledby={showQuestion ? questionId : undefined}
        aria-label={showQuestion ? undefined : PHONE_VISIBILITY_QUESTION}
        className={s.track}
        data-value={value === null ? "none" : value ? "yes" : "no"}
        data-disabled={disabled || undefined}
        onKeyDown={onKey}
      >
        <span className={s.thumb} aria-hidden />
        {OPTIONS.map(({ value: v, label, Icon }) => {
          const checked = value === v;
          return (
            <button
              key={label}
              type="button"
              role="radio"
              aria-checked={checked}
              // Пока не выбрано — в группу попадаем на «Да», дальше стрелками.
              tabIndex={checked || (value === null && v) ? 0 : -1}
              className={s.option}
              disabled={disabled}
              onClick={() => onChange(v)}
            >
              <Icon size={16} strokeWidth={2.2} aria-hidden />
              {label}
            </button>
          );
        })}
      </div>
      <ul className={s.legend}>
        {OPTIONS.map(({ value: v, label, hint }) => (
          <li key={label} className={s.legendItem} data-state={value === null ? "none" : value === v ? "on" : "off"}>
            <b>{label}</b> — {hint}
          </li>
        ))}
      </ul>
    </div>
  );
}
