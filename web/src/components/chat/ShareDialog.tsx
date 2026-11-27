import { useState } from "react";
import { useChatStore } from "../../store/chat";
import { useUiStore } from "../../store/ui";
import { describeShare, TRAY_IMAGE, useShareStore } from "../../platform/androidShare";
import ChatDialog from "./ChatDialog";
import ChatPicker from "./ChatPicker";
import c from "../constellation/Constellation.module.css";

/** Прислали из другого приложения («Поделиться» на Android) — в какой чат это отправить. */
export default function ShareDialog() {
  const incoming = useShareStore((st) => st.incoming);
  const deliver = useShareStore((st) => st.deliver);
  const dismiss = useShareStore((st) => st.dismiss);
  const ensureSavedChat = useChatStore((st) => st.ensureSavedChat);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!incoming) return null;

  const pick = async (chatId: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const target = chatId ?? (await ensureSavedChat()).id;
      deliver(target);
      useUiStore.getState().setTab("chats");
      window.dispatchEvent(new CustomEvent("quazar-open-chat", { detail: { chatId: target } }));
    } catch {
      setError("Не удалось открыть «Записную книжку»");
    } finally {
      setBusy(false);
    }
  };

  const sentAtOnce = incoming.files.some((f) => !TRAY_IMAGE.test(f.type));
  const summary = describeShare(incoming);
  return (
    <ChatDialog title="Отправить в…" onClose={dismiss}>
      {summary && <p className={c.hint}>{summary}</p>}
      {incoming.text && !/^https?:\/\/\S+$/.test(incoming.text) && (
        <p className={c.hint} style={{ whiteSpace: "pre-wrap", maxHeight: "4.5em", overflow: "hidden" }}>{incoming.text}</p>
      )}
      {incoming.skipped.length > 0 && (
        <div className={c.error}>
          Не добавлено (больше 50 МБ или не открылось): {incoming.skipped.join(", ")}
        </div>
      )}
      {incoming.files.length > 0 || incoming.text ? (
        <>
          <ChatPicker busy={busy} onPick={(id) => void pick(id)} autoFocus={false} />
          <p className={c.hint}>
            {sentAtOnce
              ? "Файлы отправятся, как только выберете чат. Текст и фото подождут в поле — можно дописать и нажать «Отправить»."
              : "Откроется чат: можно дописать сообщение и нажать «Отправить»."}
          </p>
        </>
      ) : null}
      {error && <div className={c.error}>{error}</div>}
    </ChatDialog>
  );
}
