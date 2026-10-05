import { useEffect } from "react";
import { useChatStore } from "../store/chat";
import { useCallStore } from "../store/call";
import { useUiStore } from "../store/ui";
import { consumeMigrationUiFlag } from "../crypto/keys";
import { socket } from "../ws/socket";
import AppNav from "../components/AppNav";
import ContactsPane from "../components/ContactsPane";
import MessageView from "../components/MessageView";
import PeerPanel from "../components/PeerPanel";
import CallsView from "../components/CallsView";
import SettingsView from "../components/SettingsView";
import ToastStack from "../components/ToastStack";
import NotifyPrompt from "../components/NotifyPrompt";
import CallOverlay from "../components/CallOverlay";
import s from "./MessengerPage.module.css";

type CallEventDetail = {
  callId?: string | null;
  chatId?: string | null;
  callerId?: string | null;
  callerName?: string | null;
  media?: { audio: boolean; video: boolean } | null;
};

export default function MessengerPage() {
  const tab = useUiStore((st) => st.tab);
  const mobileChatOpen = useUiStore((st) => st.mobileChatOpen);
  const setMobileChatOpen = useUiStore((st) => st.setMobileChatOpen);
  const peerPanelOpen = useUiStore((st) => st.peerPanelOpen);
  const activeChatId = useChatStore((st) => st.activeChatId);
  const selectChat = useChatStore((st) => st.selectChat);

  const showMobileChat =
    mobileChatOpen && !!activeChatId && (tab === "chats" || tab === "contacts");

  useEffect(() => {
    if (consumeMigrationUiFlag()) {
      useChatStore.setState({ showMigrationNotice: true });
    }
    useUiStore.setState({ mobileChatOpen: false });
  }, []);

  useEffect(() => {
    if (mobileChatOpen && !activeChatId) {
      setMobileChatOpen(false);
    }
  }, [mobileChatOpen, activeChatId, setMobileChatOpen]);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const chatId = (e as CustomEvent<{ chatId: string }>).detail?.chatId;
      if (chatId) {
        void selectChat(chatId);
        useUiStore.getState().setTab("chats");
        useUiStore.getState().setMobileChatOpen(true);
      }
    };
    window.addEventListener("quazar-open-chat", onOpen);
    return () => window.removeEventListener("quazar-open-chat", onOpen);
  }, [selectChat]);

  useEffect(() => {
    const applyCall = (
      detail: CallEventDetail | undefined,
      action?: "accept" | "reject"
    ) => {
      if (!detail?.callId || !detail.chatId) return;
      useCallStore.getState().prepareIncomingFromPush({
        callId: detail.callId,
        chatId: detail.chatId,
        callerId: detail.callerId,
        callerName: detail.callerName,
        media: detail.media,
      });
      void selectChat(detail.chatId);
      useUiStore.getState().setTab("chats");
      useUiStore.getState().setMobileChatOpen(true);
      if (action === "reject") {
        void socket.waitUntilOpen().then((ok) => {
          if (ok) useCallStore.getState().reject();
        });
      }
      if (action === "accept") {
        void socket.waitUntilOpen().then((ok) => {
          if (ok) void useCallStore.getState().accept();
        });
      }
    };

    const onOpenCall = (e: Event) => {
      applyCall((e as CustomEvent<CallEventDetail>).detail);
    };
    const onAccept = (e: Event) => {
      applyCall((e as CustomEvent<CallEventDetail>).detail, "accept");
    };
    const onReject = (e: Event) => {
      applyCall((e as CustomEvent<CallEventDetail>).detail, "reject");
    };

    window.addEventListener("quazar-open-call", onOpenCall);
    window.addEventListener("quazar-accept-call", onAccept);
    window.addEventListener("quazar-reject-call", onReject);

    const params = new URLSearchParams(window.location.search);
    const callId = params.get("call");
    const chatId = params.get("chat");
    const callAction = params.get("callAction");
    if (callId && chatId) {
      applyCall(
        { callId, chatId },
        callAction === "accept" ? "accept" : callAction === "reject" ? "reject" : undefined
      );
      params.delete("call");
      params.delete("callAction");
      const next = params.toString();
      window.history.replaceState({}, "", next ? `/?${next}` : "/");
    }

    return () => {
      window.removeEventListener("quazar-open-call", onOpenCall);
      window.removeEventListener("quazar-accept-call", onAccept);
      window.removeEventListener("quazar-reject-call", onReject);
    };
  }, [selectChat]);

  return (
    <div className={s.root}>
      <AppNav />

      <div className={`${s.main} ${showMobileChat ? s.mainChatOpen : ""}`}>
        {(tab === "contacts" || tab === "chats") && (
          <>
            <div className={s.listPane}>
              <ContactsPane />
            </div>
            <div className={s.chatPane}>
              <MessageView />
              {tab === "chats" && peerPanelOpen && <PeerPanel />}
            </div>
          </>
        )}

        {tab === "calls" && (
          <div className={s.fullPane}>
            <CallsView />
          </div>
        )}

        {tab === "settings" && (
          <div className={s.fullPane}>
            <SettingsView />
          </div>
        )}
      </div>

      {showMobileChat && (
        <div className={s.mobileChat}>
          <MessageView showBack />
        </div>
      )}

      {!showMobileChat && <NotifyPrompt />}
      <ToastStack />
      <CallOverlay />
    </div>
  );
}
