import { useEffect, useState } from "react";
import { useAuthStore } from "../store/auth";
import { useChatStore } from "../store/chat";
import { useCallStore } from "../store/call";
import UserAvatar from "./UserAvatar";
import { IconPhone, IconVideo } from "./icons";
import s from "./CallsView.module.css";

function formatWhen(iso: string) {
  try {
    return new Date(iso).toLocaleString("ru", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function statusLabel(status: string, isOut: boolean) {
  const dir = isOut ? "Исходящий" : "Входящий";
  const map: Record<string, string> = {
    ended: "завершён",
    missed: "пропущен",
    rejected: "отклонён",
    busy: "занято",
    failed: "сбой",
    ringing: "вызов",
    active: "идёт",
  };
  return `${dir} · ${map[status] ?? status}`;
}

export default function CallsView() {
  const [tab, setTab] = useState<"all" | "missed">("all");
  const chats = useChatStore((st) => st.chats);
  const currentUser = useAuthStore((st) => st.user);
  const history = useCallStore((st) => st.history);
  const loadHistory = useCallStore((st) => st.loadHistory);
  const startAudioCall = useCallStore((st) => st.startAudioCall);
  const callPhase = useCallStore((st) => st.phase);
  const callBusy = callPhase !== "idle" && callPhase !== "ended";

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const peers = chats
    .filter((c) => c.type === "direct")
    .map((c) => {
      const other = c.members.find((m) => m.user.id !== currentUser?.id)?.user;
      return {
        chatId: c.id,
        userId: other?.id ?? "",
        username: other?.username ?? "Неизвестный",
        avatar_url: other?.avatar_url ?? null,
      };
    })
    .filter((p) => p.userId);

  const filteredHistory =
    tab === "missed"
      ? history.filter((h) => h.status === "missed" || h.status === "rejected")
      : history;

  const peerName = (userId: string | null) => {
    if (!userId) return "Неизвестный";
    const p = peers.find((x) => x.userId === userId);
    return p?.username ?? "Пользователь";
  };

  const peerAvatar = (userId: string | null) => {
    if (!userId) return null;
    return peers.find((x) => x.userId === userId)?.avatar_url ?? null;
  };

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
        MVP: аудиозвонки 1:1 через WebRTC. Видео и звонки при закрытом приложении — в следующих
        обновлениях. Для стабильной связи за NAT нужен TURN.
      </div>

      {filteredHistory.length > 0 && (
        <div className={s.list}>
          {filteredHistory.map((h) => {
            const isOut = h.caller_id === currentUser?.id;
            const otherId = isOut ? h.callee_id : h.caller_id;
            const name = peerName(otherId);
            return (
              <div key={h.id} className={s.item}>
                <UserAvatar username={name} avatarUrl={peerAvatar(otherId)} />
                <div className={s.meta}>
                  <div className={s.name}>{name}</div>
                  <div className={s.detail}>
                    {statusLabel(h.status, isOut)}
                    {h.duration_sec != null ? ` · ${h.duration_sec}с` : ""}
                    {" · "}
                    {formatWhen(h.started_at)}
                  </div>
                </div>
                <div className={s.actions}>
                  <button
                    type="button"
                    className={s.iconBtn}
                    title="Перезвонить"
                    disabled={!otherId || !h.chat_id || callBusy}
                    onClick={() => {
                      if (otherId && h.chat_id) void startAudioCall(h.chat_id, otherId);
                    }}
                  >
                    <IconPhone size={16} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className={s.list}>
        <div className={s.sectionLabel}>Контакты</div>
        {peers.length === 0 && (
          <div className={s.empty}>Нет контактов для звонка. Начните чат — они появятся здесь.</div>
        )}
        {peers.map((p) => (
          <div key={p.chatId} className={s.item}>
            <UserAvatar username={p.username} avatarUrl={p.avatar_url} />
            <div className={s.meta}>
              <div className={s.name}>{p.username}</div>
              <div className={s.detail}>Аудиозвонок</div>
            </div>
            <div className={s.actions}>
              <button
                type="button"
                className={s.iconBtn}
                title="Аудиозвонок"
                disabled={callBusy}
                onClick={() => void startAudioCall(p.chatId, p.userId)}
              >
                <IconPhone size={16} />
              </button>
              <button type="button" className={s.iconBtn} title="Видео — скоро" disabled>
                <IconVideo size={16} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
