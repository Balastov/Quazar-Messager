import s from "./Chat.module.css";

const SIZES = { sm: 36, md: 44, lg: 84 } as const;

/** Аватар «Записной книжки» — закладка вместо инициалов. */
export default function SavedAvatar({ size = "md" }: { size?: keyof typeof SIZES }) {
  const px = SIZES[size];
  return (
    <span className={s.saved} style={{ width: px, height: px }} aria-hidden>
      <svg width={px * 0.45} height={px * 0.45} viewBox="0 0 24 24" fill="currentColor">
        <path d="M6 3h12a1 1 0 0 1 1 1v17.2a.6.6 0 0 1-.95.5L12 17.5l-6.05 4.2A.6.6 0 0 1 5 21.2V4a1 1 0 0 1 1-1Z" />
      </svg>
    </span>
  );
}
