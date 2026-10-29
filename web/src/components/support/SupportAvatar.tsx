import s from "./Support.module.css";

const SIZES = { sm: 36, md: 44, lg: 84 } as const;

/** Аватар Quazar_Admin_bot — знак Квазара. */
export default function SupportAvatar({ size = "md" }: { size?: keyof typeof SIZES }) {
  const px = SIZES[size];
  return (
    <span className={s.avatar} style={{ width: px, height: px }} aria-hidden>
      <img src="/logo-mark.png?v=neon-q-2" alt="" width={px} height={px} />
    </span>
  );
}
