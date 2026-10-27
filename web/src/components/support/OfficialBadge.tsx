import s from "./Support.module.css";

// Розетка-печать: 12 лучей со скруглёнными краями, внутри галочка.
const SEAL = Array.from({ length: 24 }, (_, i) => {
  const r = i % 2 ? 9.4 : 11;
  const a = (Math.PI * 2 * i) / 24 - Math.PI / 2;
  return `${(12 + r * Math.cos(a)).toFixed(2)},${(12 + r * Math.sin(a)).toFixed(2)}`;
}).join(" ");

/** Официальный аккаунт Квазара — фирменная зелёная печать с галочкой рядом с именем. */
export default function OfficialBadge({ size = 16 }: { size?: number }) {
  return (
    <span className={s.official} title="Официальный аккаунт Квазара" role="img" aria-label="Официальный аккаунт Квазара">
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
        <polygon points={SEAL} fill="var(--qz-online)" stroke="var(--qz-online)" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M7.6 12.3l3 3 5.8-6.1" fill="none" stroke="#06281c" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
