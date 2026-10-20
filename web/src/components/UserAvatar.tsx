import { usePresence } from "../store/presence";
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
  const online = !!usePresence(userId)?.online;
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
      {online && <span className={s.online} role="img" aria-label="в сети" title="в сети" />}
    </span>
  );
}
