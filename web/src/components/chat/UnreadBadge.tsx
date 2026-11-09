import s from "./UnreadBadge.module.css";
export default function UnreadBadge({ count, mentions = 0, quiet = false, className = "" }: { count: number; mentions?: number; quiet?: boolean; className?: string }) {
  if (count <= 0) return null;
  const label = `Непрочитанных: ${count}${mentions > 0 ? `. Упоминаний: ${mentions}` : ""}`;
  return <span role="img" className={`${s.badge} ${quiet ? s.quiet : ""} ${className}`} aria-label={label} title={label}>
    <span aria-hidden="true">{count > 99 ? "99+" : count}</span>
    {mentions > 0 && <span aria-hidden="true">@</span>}
  </span>;
}
