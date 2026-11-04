import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { messagesApi, type MessageReader } from "../../api/messages";
import { useAuthStore } from "../../store/auth";
import { socket } from "../../ws/socket";
import { apiErrorText, compareUsers, displayName } from "../../utils/profile";
import { formatWhen } from "../../chat/when";
import Dialog from "../constellation/Dialog";
import UserAvatar from "../UserAvatar";
import s from "./ReadByDialog.module.css";

export default function ReadByDialog({ chatId, messageId, authorId, onClose }: {
  chatId: string; messageId: string; authorId: string; onClose(): void;
}) {
  const myId = useAuthStore(state => state.user?.id);
  const [readers, setReaders] = useState<MessageReader[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (myId !== authorId) return;
    let active = true, request = 0;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      const current = ++request;
      try {
        const result = await messagesApi.readers(chatId, messageId);
        if (active && current === request) { setReaders([...result].sort(compareUsers)); setError(""); }
      } catch (err) {
        if (active && current === request) setError(apiErrorText(err, "Не удалось загрузить список прочитавших"));
      } finally { if (active && current === request) setLoading(false); }
    };
    setReaders([]); setLoading(true); setError(""); void load();
    const refresh = () => { clearTimeout(timer); timer = setTimeout(() => void load(), 150); };
    const off = socket.on(event => { if (event.type === "message_read" && event.chat_id === chatId && event.message_id === messageId) refresh(); });
    const offStatus = socket.onStatus(open => { if (open) refresh(); });
    return () => { active = false; clearTimeout(timer); off(); offStatus(); };
  }, [chatId, messageId, myId, authorId, round]);
  if (myId !== authorId) return null;
  return createPortal(<Dialog title="Кто прочитал" onClose={onClose}>
    <div className={s.body}>
      {loading ? <p className={s.hint} role="status">Загрузка…</p> : error ? <>
        <p role="alert" className={s.error}>{error}</p><button className={s.retry} type="button" onClick={() => setRound(value => value + 1)}>Повторить</button>
      </> : <>
        <p className={s.hint}>{readers.length ? `Прочитали: ${readers.length}` : "Пока нет подтверждений прочтения."}</p>
        <ul className={s.list}>
          {readers.map(reader => <li className={s.reader} key={reader.id}>
            <UserAvatar username={displayName(reader)} avatarUrl={reader.avatar_url} userId={reader.id} size="sm" />
            <span className={s.name}>{displayName(reader)}<span className={s.username}>@{reader.username}</span></span>
            <time className={s.time} dateTime={reader.read_at}>{formatWhen(reader.read_at)}</time>
          </li>)}
        </ul>
      </>}
      <p className={s.hint}>Список виден только вам. Для старых сообщений отметки могут быть неполными; они появляются при прочтении обновлённым приложением.</p>
    </div>
  </Dialog>, document.body);
}
