import { useMemo, useState } from "react";
import type { Message } from "../../api/types";
import { chatTitle, SAVED_CHAT_TITLE, useChatStore } from "../../store/chat";
import { useAuthStore } from "../../store/auth";
import { notifyInfo } from "../../notifications/notify";
import { E2EError } from "../../crypto/errors";
import { AttachmentError } from "../../attachments/image";
import UserAvatar from "../UserAvatar";
import SavedAvatar from "./SavedAvatar";
import ChatDialog from "./ChatDialog";
import c from "../constellation/Constellation.module.css";
import s from "./Chat.module.css";

/** Переслать сообщение: «Записная книжка» первой, дальше чаты по свежести. */
export default function ForwardDialog({ message, onClose }: { message: Message; onClose: () => void }) {
  const chats = useChatStore((st) => st.chats);
  const forwardMessage = useChatStore((st) => st.forwardMessage);
  const ensureSavedChat = useChatStore((st) => st.ensureSavedChat);
  const myId = useAuthStore((st) => st.user?.id);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const saved = chats.find((ch) => ch.type === "saved");
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return chats
      .filter((ch) => ch.type !== "saved")
      .filter((ch) => !q || chatTitle(ch, myId).toLowerCase().includes(q));
  }, [chats, query, myId]);

  const send = async (chatId: string | null) => {
    setBusy(chatId ?? "saved");
    setError(null);
    try {
      // «Записной книжки» ещё нет — создаём, не уходя из текущего чата.
      const target = chatId ?? (await ensureSavedChat()).id;
      await forwardMessage(message, target);
      const ch = useChatStore.getState().chats.find((x) => x.id === target);
      notifyInfo({ title: "Переслано", body: `В «${chatTitle(ch, myId)}»`, chatId: target });
      onClose();
    } catch (err) {
      setError(err instanceof E2EError || err instanceof AttachmentError ? err.message : "Не удалось переслать");
      setBusy(null);
    }
  };

  const showSaved = !query.trim() || SAVED_CHAT_TITLE.toLowerCase().includes(query.trim().toLowerCase());

  return (
    <ChatDialog title="Переслать" onClose={onClose}>
      <input
        className={c.input}
        placeholder="Поиск чата"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />
      <div className={s.chatList}>
        {showSaved && (
          <button type="button" className={s.chatRow} disabled={!!busy} onClick={() => void send(saved?.id ?? null)}>
            <SavedAvatar size="sm" />
            {SAVED_CHAT_TITLE}
          </button>
        )}
        {list.map((ch) => {
          const other = ch.type === "direct" ? ch.members.find((m) => m.user.id !== myId)?.user : undefined;
          return (
            <button key={ch.id} type="button" className={s.chatRow} disabled={!!busy} onClick={() => void send(ch.id)}>
              <UserAvatar
                username={chatTitle(ch, myId)}
                avatarUrl={other?.avatar_url ?? null}
                userId={other?.id ?? null}
                size="sm"
              />
              {chatTitle(ch, myId)}
            </button>
          );
        })}
        {!showSaved && list.length === 0 && <p className={c.hint}>Ничего не нашлось</p>}
      </div>
      {busy && <p className={c.hint}>Пересылаем…</p>}
      {error && <div className={c.error}>{error}</div>}
    </ChatDialog>
  );
}
