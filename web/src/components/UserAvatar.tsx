import { usePresence, usePresenceStore } from "../store/presence";
import { activeManual, MANUAL_LABEL } from "../utils/presence";
import s from "./UserAvatar.module.css";

interface Props {
  username: string;
  avatarUrl?: string | null;
  size?: "sm" | "md" | "lg";
  className?: string;
  /** С id — зелёная точка, когда человек в сети. */
  userId?: string | null;
}

export default function UserAvatar({ username, avatarUrl, size = "md", className, userId }: Props) {
  const presence = usePresence(userId);
  usePresenceStore((st) => st.minute); // истёк таймер ручного статуса — перерисуемся
  const manual = activeManual(presence);
  const status = presence?.status;
  const letter = (username?.[0] ?? "?").toUpperCase();
  const sizeClass = size === "sm" ? s.sm : size === "lg" ? s.lg : s.md;
  const classes = [s.root, sizeClass, className].filter(Boolean).join(" ");

  const avatar = avatarUrl ? (
    <img className={`${classes} ${s.image}`} src={avatarUrl} alt="" loading="lazy" />
  ) : (
    <span className={classes}>{letter}</span>
  );
  if (!userId) return avatar;

  return (
    <span className={`${s.wrap} ${sizeClass}`}>
      {avatar}
      {manual && (
        <span
          className={`${s.online} ${manual.kind === "dnd" ? s.dnd : s.busy}`}
          role="img"
          aria-label={MANUAL_LABEL[manual.kind]}
          title={MANUAL_LABEL[manual.kind]}
        />
      )}
      {!manual && status === "online" && <span className={s.online} role="img" aria-label="в сети" title="в сети" />}
      {!manual && status === "away" && (
        <span className={`${s.online} ${s.away}`} role="img" aria-label="отошёл(ла)" title="отошёл(ла)" />
      )}
    </span>
  );
}
