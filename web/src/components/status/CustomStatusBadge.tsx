import { useCustomStatus } from "../../store/presence";
import { untilText } from "../../utils/presence";
import { STATUS_ICONS } from "./statusIcons";
import s from "./CustomStatus.module.css";

/** Свой статус человека: значок и текст (compact — только значок, текст в подсказке). */
export default function CustomStatusBadge({
  userId,
  compact = false,
  className,
}: {
  userId: string | null | undefined;
  compact?: boolean;
  className?: string;
}) {
  const custom = useCustomStatus(userId);
  if (!custom) return null;
  const icon = custom.icon ? STATUS_ICONS[custom.icon] : undefined;
  const title = [custom.text || icon?.label, custom.until ? untilText(custom.until) : ""].filter(Boolean).join(" · ");
  return (
    <span className={`${compact ? s.badgeCompact : s.badge} ${className ?? ""}`} title={title}>
      {icon && <icon.Icon size={compact ? 14 : 15} strokeWidth={2} aria-hidden />}
      {!compact && custom.text && <span className={s.text}>{custom.text}</span>}
    </span>
  );
}
