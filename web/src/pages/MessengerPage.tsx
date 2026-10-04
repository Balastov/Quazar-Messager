import { useEffect, useState } from "react";
import { useAuthStore } from "../store/auth";
import { useChatStore } from "../store/chat";
import { consumeMigrationUiFlag, hasBackupDone } from "../crypto/keys";
import ChatList from "../components/ChatList";
import MessageView from "../components/MessageView";
import SecurityPanel from "../components/SecurityPanel";
import ProfileSettings from "../components/ProfileSettings";
import ToastStack from "../components/ToastStack";
import NotifyPrompt from "../components/NotifyPrompt";
import s from "./MessengerPage.module.css";

export default function MessengerPage() {
  const logout = useAuthStore((st) => st.logout);
  const selectChat = useChatStore((st) => st.selectChat);
  const [showSecurity, setShowSecurity] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showBackupHint, setShowBackupHint] = useState(false);

  useEffect(() => {
    if (consumeMigrationUiFlag()) {
      useChatStore.setState({ showMigrationNotice: true });
    }
    if (!hasBackupDone()) {
      setShowBackupHint(true);
    }
  }, []);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const chatId = (e as CustomEvent<{ chatId: string }>).detail?.chatId;
      if (chatId) void selectChat(chatId);
    };
    window.addEventListener("quazar-open-chat", onOpen);
    return () => window.removeEventListener("quazar-open-chat", onOpen);
  }, [selectChat]);

  return (
    <div className={s.root}>
      <div className={s.sidebar}>
        <ChatList />
        <NotifyPrompt />
        {showBackupHint && (
          <button
            type="button"
            className={s.backupHint}
            onClick={() => {
              setShowSecurity(true);
              setShowBackupHint(false);
            }}
          >
            Создайте резервную копию ключей
          </button>
        )}
        <div className={s.sidebarActions}>
          <button
            className={s.actionBtn}
            onClick={() => setShowProfile(true)}
            title="Профиль"
          >
            👤
          </button>
          <button
            className={s.actionBtn}
            onClick={() => setShowSecurity(true)}
            title="Безопасность"
          >
            🔐
          </button>
          <button className={s.actionBtn} onClick={logout} title="Выйти">
            ⏏
          </button>
        </div>
      </div>
      <MessageView />
      <ToastStack />
      {showProfile && <ProfileSettings onClose={() => setShowProfile(false)} />}
      {showSecurity && <SecurityPanel onClose={() => setShowSecurity(false)} />}
    </div>
  );
}
