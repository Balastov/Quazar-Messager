import type { ReactNode } from "react";
import { useProfileStore, type ProfileHint } from "../../store/profile";
import s from "./UserProfile.module.css";

interface Props {
  /** Нет id (бот, бывший участник, гость) — просто показываем содержимое. */
  userId: string | null | undefined;
  starId?: string | null;
  hint?: ProfileHint;
  className?: string;
  children: ReactNode;
}

/** Аватар или имя, по нажатию на которые открывается профиль человека. */
export default function ProfileLink({ userId, starId, hint, className, children }: Props) {
  const open = useProfileStore((st) => st.open);
  if (!userId) return <>{children}</>;
  return (
    <button
      type="button"
      className={[s.link, className ?? ""].filter(Boolean).join(" ")}
      title="Открыть профиль"
      onClick={(e) => {
        // Не даём нажатию дойти до строки или сообщения (меню, выделение).
        e.stopPropagation();
        open({ userId, starId, hint });
      }}
    >
      {children}
    </button>
  );
}
