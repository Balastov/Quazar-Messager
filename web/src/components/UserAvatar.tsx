import s from "./UserAvatar.module.css";

interface Props {
  username: string;
  avatarUrl?: string | null;
  size?: "sm" | "md" | "lg";
  className?: string;
}

export default function UserAvatar({ username, avatarUrl, size = "md", className }: Props) {
  const letter = (username?.[0] ?? "?").toUpperCase();
  const sizeClass = size === "sm" ? s.sm : size === "lg" ? s.lg : s.md;
  const classes = [s.root, sizeClass, className].filter(Boolean).join(" ");

  if (avatarUrl) {
    return (
      <img
        className={`${classes} ${s.image}`}
        src={avatarUrl}
        alt=""
        loading="lazy"
      />
    );
  }

  return <span className={classes}>{letter}</span>;
}
