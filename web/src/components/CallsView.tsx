import { useState } from "react";
import { useAuthStore } from "../store/auth";
import { useChatStore } from "../store/chat";
import UserAvatar from "./UserAvatar";
import { IconPhone, IconVideo } from "./icons";
import s from "./CallsView.module.css";

export default function CallsView() {
  const [tab, setTab] = useState<"all" | "missed">("all");
  const chats = useChatStore((st) => st.chats);
  const currentUser = useAuthStore((st) => st.user);

  const peers = chats
    .filter((c) => c.type === "direct")
    .map((c) => {
      const other = c.members.find((m) => m.user.id !== currentUser?.id)?.user;
      return {
        id: c.id,
        username: other?.username ?? "Неизвестный",
        avatar_url: other?.avatar_url ?? null,
      };
    });

  return (
    <div className={s.root}>
      <div className={s.header}>
        <h2 className={s.title}>Звонки</h2>
      </div>
      <div className={s.tabs}>
        <button
          type="button"
          className={tab === "all" ? s.tabActive : s.tab}
          onClick={() => setTab("all")}
        >
          Все
        </button>
        <button
          type="button"
          className={tab === "missed" ? s.tabActive : s.tab}
          onClick={() => setTab("missed")}
        >
          Пропущенные
        </button>
      </div>

      <div className={s.banner}>
        Аудио- и видеозвонки появятся в следующем обновлении. Сейчас — только дизайн и список
        контактов для быстрого доступа.
      </div>

      <div className={s.list}>
        {peers.length === 0 && (
          <div className={s.empty}>Нет контактов для звонка. Начните чат — они появятся здесь.</div>
        )}
        {tab === "missed" && peers.length > 0 && (
          <div className={s.empty}>Пропущенных звонков нет — история заработает вместе со звонками.</div>
        )}
        {tab === "all" &&
          peers.map((p, idx) => (
            <div key={p.id} className={s.item}>
              <UserAvatar username={p.username} avatarUrl={p.avatar_url} />
              <div className={s.meta}>
                <div className={s.name}>{p.username}</div>
                <div className={s.detail}>
                  {idx % 2 === 0 ? "Исходящий · скоро" : "Входящий · скоро"}
                </div>
              </div>
              <div className={s.actions}>
                <button type="button" className={s.iconBtn} title="Скоро">
                  <IconPhone size={16} />
                </button>
                <button type="button" className={s.iconBtn} title="Скоро">
                  <IconVideo size={16} />
                </button>
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}
