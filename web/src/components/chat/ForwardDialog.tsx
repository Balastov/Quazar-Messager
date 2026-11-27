import { useState } from "react";
import type { Message } from "../../api/types";
import { chatTitle, useChatStore } from "../../store/chat";
import { useAuthStore } from "../../store/auth";
import { notifyInfo } from "../../notifications/notify";
import { E2EError } from "../../crypto/errors";
import { AttachmentError } from "../../attachments/image";
import ChatDialog from "./ChatDialog";
import ChatPicker from "./ChatPicker";
import c from "../constellation/Constellation.module.css";

/** Переслать сообщение в выбранный чат, не уходя из текущего. */
export default function ForwardDialog({ message, onClose }: { message: Message; onClose: () => void }) {
  const forwardMessage = useChatStore((st) => st.forwardMessage);
  const ensureSavedChat = useChatStore((st) => st.ensureSavedChat);
  const myId = useAuthStore((st) => st.user?.id);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <ChatDialog title="Переслать" onClose={onClose}>
      <ChatPicker busy={!!busy} onPick={(id) => void send(id)} />
      {busy && <p className={c.hint}>Пересылаем…</p>}
      {error && <div className={c.error}>{error}</div>}
    </ChatDialog>
  );
}
