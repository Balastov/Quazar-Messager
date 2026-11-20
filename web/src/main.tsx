import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { capturePendingInvite } from "./api/stars";
import { registerNotifyServiceWorker } from "./notifications/notify";
import {startPushLifecycle} from "./notifications/push";
import {pushWasShown} from "./notifications/delivery";
import { isPresenting } from "./notifications/presenting";
import { useUiStore } from "./store/ui";
import { applyGlassTransparency } from "./styles/glass";
import "./index.css";
import { startDesktop } from "./platform/bootstrap";
import { startAndroidPush } from "./platform/androidPush";
import DesktopUpdates from "./components/DesktopUpdates";
import AndroidUpdates from "./components/AndroidUpdates";
import Quiet from "./components/Quiet";
import { DesktopDownloads } from "./components/DesktopDownload";

applyGlassTransparency(useUiStore.getState().glassTransparency);
useUiStore.subscribe((st, prev) => {
  if (st.glassTransparency !== prev.glassTransparency) {
    applyGlassTransparency(st.glassTransparency);
  }
});

// Ссылка-приглашение в Звезду могла открыться до входа — запоминаем её.
capturePendingInvite();
startDesktop();
// Приложение для Android: нажатие на уведомление могло и запустить его — подписываемся сразу.
startAndroidPush();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DesktopDownloads>
      <App />
      <DesktopUpdates />
      <Quiet><AndroidUpdates /></Quiet>
    </DesktopDownloads>
  </StrictMode>
);

void registerNotifyServiceWorker();
startPushLifecycle();

type SwCallMsg = {
  type?: string;
  callId?: string | null;
  chatId?: string | null;
  callerId?: string | null;
  callerName?: string | null;
  media?: { audio: boolean; video: boolean } | null;
};

function handleCallMessage(data: SwCallMsg) {
  if (!data?.type) return;
  if (data.type === "quazar-push-shown") {
    const note = data as {messageId?: string; userId?: string};
    if (note.messageId) pushWasShown(note.messageId, note.userId);
    return;
  }
  if (data.type === "quazar-open-inbox") {
    const link = data as { notificationId?: string; starId?: string; channelId?: string };
    window.dispatchEvent(new CustomEvent("quazar-open-inbox", { detail: link }));
    return;
  }
  if (data.type === "quazar-star-door") {
    window.dispatchEvent(
      new CustomEvent("quazar-star-door", { detail: (data as { link?: unknown }).link })
    );
    return;
  }
  if (data.type === "quazar-open-star") {
    const link = data as { starId?: string; channelId?: string; messageId?: string; threadId?: string };
    window.dispatchEvent(new CustomEvent("quazar-open-star", { detail: { starId: link.starId, channelId: link.channelId, messageId: link.messageId, threadId: link.threadId } }));
    return;
  }
  if (data.type === "quazar-open-chat" && data.chatId) {
    window.dispatchEvent(
      new CustomEvent("quazar-open-chat", { detail: { chatId: data.chatId } })
    );
    return;
  }
  if (
    data.type === "quazar-open-call" ||
    data.type === "quazar-accept-call" ||
    data.type === "quazar-reject-call"
  ) {
    window.dispatchEvent(
      new CustomEvent(data.type, {
        detail: {
          callId: data.callId,
          chatId: data.chatId,
          callerId: data.callerId,
          callerName: data.callerName,
          media: data.media,
        },
      })
    );
  }
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    // Service worker спрашивает перед push-уведомлением, не показываем ли мы экран.
    if ((event.data as SwCallMsg | null)?.type === "quazar-presenting?") {
      event.ports[0]?.postMessage({ presenting: isPresenting() });
      return;
    }
    handleCallMessage(event.data as SwCallMsg);
  });
}
