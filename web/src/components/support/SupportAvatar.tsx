import s from "./Support.module.css";
import { Megaphone } from "lucide-react";

const SIZES = { sm: 36, md: 44, lg: 84 } as const;

/** Аватар Quazar_Admin_bot — знак Квазара. */
export default function SupportAvatar({ size = "md", kind = "support" }: { size?: keyof typeof SIZES; kind?: "support" | "news" }) {
  const px = SIZES[size];
  return (
    <span className={s.avatar} style={{ width: px, height: px }} aria-hidden>
      {kind === "news" ? <Megaphone size={px * .55} color="var(--qz-online)" />
        : <img src="/logo-mark.png?v=neon-q-2" alt="" width={px} height={px} />}
    </span>
  );
}
