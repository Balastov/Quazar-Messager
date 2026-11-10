import s from "./Premium.module.css";

// Пятиконечная звезда со скруглёнными углами — только контур.
const STAR = Array.from({ length: 10 }, (_, i) => {
  const r = i % 2 ? 4.4 : 10;
  const a = (Math.PI * 2 * i) / 10 - Math.PI / 2;
  return `${(12 + r * Math.cos(a)).toFixed(2)},${(12.6 + r * Math.sin(a)).toFixed(2)}`;
}).join(" ");

/** Quazar Premium — фирменная зелёная звезда-контур с лёгким свечением рядом с именем. */
export default function PremiumBadge({ size = 15 }: { size?: number }) {
  return (
    <span className={s.badge} title="Quazar Premium" role="img" aria-label="Quazar Premium">
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
        <polygon points={STAR} fill="none" stroke="var(--qz-online)" strokeWidth="2" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
