import { useChatStore } from "../store/chat";
import { useStarsStore } from "../store/stars";
import { useToastStore } from "../notifications/toastStore";
import s from "./ToastStack.module.css";

export default function ToastStack() {
  const toasts = useToastStore((st) => st.toasts);
  const dismiss = useToastStore((st) => st.dismiss);
  const selectChat = useChatStore((st) => st.selectChat);
  const openMessage = useChatStore((st) => st.openMessage);

  if (toasts.length === 0) return null;

  return (
    <div className={s.stack} aria-live="polite">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          className={s.toast}
          onClick={() => {
            if (toast.starId && toast.channelId) void useStarsStore.getState().openChannelLink(toast.starId, toast.channelId);
            else if (toast.chatId && toast.messageId) void openMessage(toast.chatId, toast.messageId);
            else if (toast.chatId) void selectChat(toast.chatId);
            dismiss(toast.id);
          }}
        >
          <span className={s.accent} />
          <span className={s.content}>
            <span className={s.title}>{toast.title}</span>
            <span className={s.body}>{toast.body}</span>
          </span>
          <span
            className={s.close}
            role="presentation"
            onClick={(e) => {
              e.stopPropagation();
              dismiss(toast.id);
            }}
          >
            ✕
          </span>
        </button>
      ))}
    </div>
  );
}
