import { useEffect } from "react";
import { useAuthStore } from "../store/auth";
import { useChatStore } from "../store/chat";
import { consumeMigrationUiFlag } from "../crypto/keys";
import ChatList from "../components/ChatList";
import MessageView from "../components/MessageView";
import s from "./MessengerPage.module.css";

export default function MessengerPage() {
  const logout = useAuthStore((s) => s.logout);

  useEffect(() => {
    if (consumeMigrationUiFlag()) {
      useChatStore.setState({ showMigrationNotice: true });
    }
  }, []);

  return (
    <div className={s.root}>
      <div className={s.sidebar}>
        <ChatList />
        <button className={s.logout} onClick={logout} title="Выйти">⏏</button>
      </div>
      <MessageView />
    </div>
  );
}
