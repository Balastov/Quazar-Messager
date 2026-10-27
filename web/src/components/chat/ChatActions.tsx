import { useCallback, useState } from "react";
import type { Chat } from "../../api/types";
import { ttlLabel } from "../../chat/ttl";
import { useAuthStore } from "../../store/auth";
import { useUiStore } from "../../store/ui";
import { useBlocksStore } from "../../store/blocks";
import { useChatStore } from "../../store/chat";
import { notifyInfo } from "../../notifications/notify";
import MessageMenu, { type MenuAction } from "../messages/MessageMenu";
import ReportDialog from "./ReportDialog";
import NotifyDialog from "../NotifyDialog";
import { CHAT_DEFAULT, chatLevel, levelSummary, settingKey, useNotifyStore } from "../../notifications/levels";
import { chatTitle } from "../../store/chat";
import TtlDialog from "./TtlDialog";

interface Props {
  chat: Chat;
  className: string;
  title?: string;
  children: React.ReactNode;
}

/**
 * Кнопка «⋯» / «Ещё» у чата: проверка шифрования, исчезающие сообщения,
 * блокировка и жалоба. Меню и окна живут здесь же.
 */
export default function ChatActions({ chat, className, title = "Ещё", children }: Props) {
  const myId = useAuthStore((st) => st.user?.id);
  const setShowE2ePanel = useChatStore((st) => st.setShowE2ePanel);
  const blockedIds = useBlocksStore((st) => st.ids);
  const block = useBlocksStore((st) => st.block);
  const unblock = useBlocksStore((st) => st.unblock);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [dialog, setDialog] = useState<"ttl" | "report" | "notify" | null>(null);
  const notifySettings = useNotifyStore((st) => st.settings);
  const closeMenu = useCallback(() => setMenuAt(null), []);

  const peer = chat.type === "direct" ? chat.members.find((m) => m.user.id !== myId)?.user : undefined;
  const blocked = !!peer && blockedIds.includes(peer.id);
  const myRole = chat.members.find((m) => m.user.id === myId)?.role;
  const canChangeTtl = chat.type !== "group" || myRole === "owner" || myRole === "admin";

  const toggleBlock = async () => {
    if (!peer) return;
    if (!blocked && !window.confirm(`Заблокировать ${peer.username}? Сообщения и звонки от него перестанут приходить.`)) {
      return;
    }
    try {
      if (blocked) await unblock(peer.id);
      else await block(peer.id);
      notifyInfo({ title: peer.username, body: blocked ? "Разблокирован(а)" : "Заблокирован(а)" });
    } catch {
      notifyInfo({ title: peer.username, body: "Не получилось — попробуйте ещё раз" });
    }
  };

  const actions: MenuAction[] = [];
  if (chat.type !== "saved") {
    const summary = levelSummary(chatLevel(notifySettings, chat.id), notifySettings[settingKey("chat", chat.id)]);
    actions.push({ label: `🔔 Уведомления: ${summary.toLowerCase()}`, onClick: () => setDialog("notify") });
  }
  if (chat.type === "direct") actions.push({ label: "Проверка шифрования", onClick: () => setShowE2ePanel(true) });
  // Переписка с поддержкой не исчезает: по ней команда разбирает обращения.
  if (chat.type !== "support") {
    actions.push({
      label: chat.ttl_seconds ? `Исчезающие: ${ttlLabel(chat.ttl_seconds)}` : "Исчезающие сообщения",
      onClick: () => setDialog("ttl"),
    });
  } else {
    actions.push({ label: "Новое обращение", onClick: () => useUiStore.getState().setFeedbackOpen(true) });
  }
  if (peer) {
    actions.push({ label: blocked ? "Разблокировать" : "Заблокировать", danger: !blocked, onClick: () => void toggleBlock() });
    actions.push({ label: "Пожаловаться", danger: true, onClick: () => setDialog("report") });
  }

  return (
    <>
      <button
        type="button"
        className={className}
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenuAt({ x: r.right - 220, y: r.bottom + 6 });
        }}
      >
        {children}
      </button>
      {menuAt && <MessageMenu at={menuAt} reaction={null} actions={actions} onClose={closeMenu} />}
      {dialog === "ttl" && <TtlDialog chat={chat} canChange={canChangeTtl} onClose={() => setDialog(null)} />}
      {dialog === "notify" && (
        <NotifyDialog
          scope="chat"
          targetId={chat.id}
          title={`Уведомления: ${chatTitle(chat, myId)}`}
          inherited={CHAT_DEFAULT}
          mentions={chat.type === "group"}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "report" && peer && (
        <ReportDialog userId={peer.id} username={peer.username} chatId={chat.id} onClose={() => setDialog(null)} />
      )}
    </>
  );
}
