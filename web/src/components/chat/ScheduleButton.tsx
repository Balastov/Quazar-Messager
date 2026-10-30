import { Clock3 } from "lucide-react";
import s from "./Chat.module.css";

export default function ScheduleButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className={s.scheduleButton} onClick={onClick} disabled={disabled}
      title="Отправить позже" aria-label="Отправить позже">
      <Clock3 size={18} />
    </button>
  );
}
