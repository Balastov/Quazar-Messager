import { useState } from "react";
import type { StarDetail, StarMessage } from "../../api/stars";
import { useAuthStore } from "../../store/auth";
import { isStaff, useStarsStore } from "../../store/stars";
import { useDoorsStore } from "../../store/doors";
import { formatWhen } from "../../chat/when";
import UserAvatar from "../UserAvatar";
import { apiError } from "./rules";
import g from "./Gaming.module.css";
import { displayName } from "../../utils/profile";

/** Сбор группы: кто записался, сколько мест, когда; в начале — временная Планета для всех. */
export default function LfgCard({ message, detail }: { message: StarMessage; detail: StarDetail }) {
  const lfg = message.lfg!;
  const myId = useAuthStore((st) => st.user?.id);
  const lfgAction = useStarsStore((st) => st.lfgAction);
  const [error, setError] = useState<string | null>(null);
  const joined = !!myId && lfg.members.includes(myId);
  const full = lfg.members.length >= lfg.slots;
  const manage = lfg.created_by === myId || isStaff(detail.my_role);
  const planet = lfg.planet_id ? detail.channels.find((c) => c.id === lfg.planet_id) : undefined;
  const member = (id: string) => detail.members.find((m) => m.user.id === id)?.user;

  const act = (action: "join" | "leave" | "start" | "cancel") =>
    void lfgAction(message, action).catch((err) => setError(apiError(err)));

  return (
    <div className={g.card}>
      <div className={g.cardTitle}>🎮 {lfg.title}</div>
      <div className={g.cardMeta}>
        {lfg.status === "cancelled"
          ? "Сбор отменён"
          : lfg.status === "started"
            ? "Сбор начался"
            : `${lfg.members.length} из ${lfg.slots}${full ? " — группа собрана" : ""}`}
        {lfg.status === "open" && lfg.starts_at ? ` · начало ${formatWhen(lfg.starts_at)}` : ""}
      </div>
      <div className={g.slots}>
        {Array.from({ length: lfg.slots }, (_, i) => {
          const user = lfg.members[i] ? member(lfg.members[i]) : undefined;
          return user ? (
            <span key={i} className={g.slot} title={displayName(user)}>
              <UserAvatar username={displayName(user)} avatarUrl={user.avatar_url} size="sm" userId={user.id} />
            </span>
          ) : (
            <span key={i} className={g.slotEmpty} aria-label="Свободное место" />
          );
        })}
      </div>
      <div className={g.cardFooter}>
        {lfg.status === "open" && !joined && !full && (
          <button type="button" className={g.cardAction} onClick={() => act("join")}>
            Записаться
          </button>
        )}
        {lfg.status === "open" && joined && (
          <button type="button" className={g.cardLink} onClick={() => act("leave")}>
            Выйти из сбора
          </button>
        )}
        {lfg.status === "open" && manage && (
          <>
            <button type="button" className={g.cardAction} onClick={() => act("start")}>
              Начать сейчас
            </button>
            <button type="button" className={g.cardLink} onClick={() => act("cancel")}>
              Отменить
            </button>
          </>
        )}
        {lfg.status === "started" && planet && joined && (
          <button
            type="button"
            className={g.cardAction}
            onClick={() => {
              // Приглашение на эту Планету больше не нужно — входим отсюда.
              const doors = useDoorsStore.getState();
              doors.invites.filter((i) => i.channelId === planet.id).forEach(doors.dismissInvite);
              void doors.enterRoom(detail, planet);
            }}
          >
            Войти на Планету
          </button>
        )}
        {lfg.status === "started" && !planet && <span>Планета уже закрылась</span>}
      </div>
      {error && <div className={g.cardError}>{error}</div>}
    </div>
  );
}
