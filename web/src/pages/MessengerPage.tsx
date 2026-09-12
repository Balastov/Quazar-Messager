import { useEffect, useState } from "react";
import { useAuthStore } from "../store/auth";
import { useChatStore } from "../store/chat";
import { consumeMigrationUiFlag, hasBackupDone } from "../crypto/keys";
import ChatList from "../components/ChatList";
import MessageView from "../components/MessageView";
import SecurityPanel from "../components/SecurityPanel";
import s from "./MessengerPage.module.css";

export default function MessengerPage() {
  const logout = useAuthStore((st) => st.logout);
  const [showSecurity, setShowSecurity] = useState(false);
  const [showBackupHint, setShowBackupHint] = useState(false);

  useEffect(() => {
    if (consumeMigrationUiFlag()) {
      useChatStore.setState({ showMigrationNotice: true });
    }
    if (!hasBackupDone()) {
      setShowBackupHint(true);
    }
  }, []);

  return (
    <div className={s.root}>
      <div className={s.sidebar}>
        <ChatList />
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
      {showSecurity && <SecurityPanel onClose={() => setShowSecurity(false)} />}
    </div>
  );
}
