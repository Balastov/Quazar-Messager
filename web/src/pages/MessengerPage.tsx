import { useEffect } from "react";
import { useChatStore } from "../store/chat";
import { useUiStore } from "../store/ui";
import { consumeMigrationUiFlag } from "../crypto/keys";
import AppNav from "../components/AppNav";
import ContactsPane from "../components/ContactsPane";
import MessageView from "../components/MessageView";
import PeerPanel from "../components/PeerPanel";
import CallsView from "../components/CallsView";
import SettingsView from "../components/SettingsView";
import ToastStack from "../components/ToastStack";
import NotifyPrompt from "../components/NotifyPrompt";
import s from "./MessengerPage.module.css";

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
    // Сброс залипшего оверлея из старого localStorage
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
    </div>
  );
}
