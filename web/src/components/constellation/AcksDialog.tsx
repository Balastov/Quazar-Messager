import { useEffect, useState } from "react";
import { starsApi, type StarAcks, type StarMessage } from "../../api/stars";
import UserAvatar from "../UserAvatar";
import Dialog from "./Dialog";
import { apiError } from "./rules";
import s from "./Constellation.module.css";
import w from "./Work.module.css";

/** Кто ознакомился с объявлением и кто ещё нет — автору и админам. */
export default function AcksDialog({ message, onClose }: { message: StarMessage; onClose: () => void }) {
  const [acks, setAcks] = useState<StarAcks | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    starsApi
      .acks(message.star_id, message.id)
      .then(setAcks)
      .catch((err) => setError(apiError(err, "Не удалось загрузить")));
  }, [message.star_id, message.id, message.ack_count]);

  const list = (title: string, people: StarAcks["acked"]) => (
    <>
      <h4 className={w.sectionTitle}>
        {title} · {people.length}
      </h4>
      {people.length ? (
        <div className={w.peopleList}>
          {people.map((u) => (
            <div key={u.id} className={w.person}>
              <UserAvatar username={u.username} avatarUrl={u.avatar_url} size="sm" />
              {u.username}
            </div>
          ))}
        </div>
      ) : (
        <p className={s.hint}>Никого</p>
      )}
    </>
  );

  return (
    <Dialog title="Ознакомление" onClose={onClose}>
      {error && <div className={s.error}>{error}</div>}
      {!acks && !error && <p className={s.hint}>Загрузка…</p>}
      {acks && (
        <>
          {list("Ознакомились", acks.acked)}
          {list("Ещё нет", acks.pending)}
        </>
      )}
    </Dialog>
  );
}
