import { useEffect, useState } from "react";
import { useDoorsStore } from "../../store/doors";
import { useStarsStore } from "../../store/stars";
import { useVoiceStore } from "../../store/voice";
import s from "./Constellation.module.css";

/** Приглашения «Позвать», стуки в двери и статус своего стука — поверх любой вкладки. */
export default function DoorToasts() {
  const invites = useDoorsStore((st) => st.invites);
  const knocks = useDoorsStore((st) => st.knocks);
  const myKnock = useDoorsStore((st) => st.myKnock);
  const notice = useDoorsStore((st) => st.notice);
  const { acceptInvite, dismissInvite, answer, cancelKnock, dismissNotice } = useDoorsStore.getState();
  const details = useStarsStore((st) => st.details);
  const voiceChannelId = useVoiceStore((st) => (st.status !== "idle" ? st.channelId : null));
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(dismissNotice, 7000);
    return () => clearTimeout(timer);
  }, [notice, dismissNotice]);

  const liveInvites = invites.filter((i) => i.expiresAt > now);
  // Карточки стука: тем, кто может впускать, — с кнопками; кто просто в комнате — для сведения.
  const pending = Object.values(knocks).filter(
    (k) => k.knock.status === "pending" && k.receivedAt + k.expires_in * 1000 > now
  );
  const canAnswer = (starId: string) => details[starId]?.my_permissions.includes("admit") ?? true;
  const visibleKnocks = pending.filter(
    (k) => canAnswer(k.star_id) || voiceChannelId === k.knock.channel_id
  );

  if (!liveInvites.length && !visibleKnocks.length && !myKnock && !notice) return null;

  return (
    <div className={s.doorStack} aria-live="polite">
      {liveInvites.map((invite) => (
        <div key={invite.channelId} className={s.doorCard}>
          <div className={s.doorTitle}>
            🚪 {invite.fromName} зовёт вас в «{invite.roomName}»
          </div>
          <div className={s.doorSub}>{invite.starName}</div>
          <div className={s.doorActions}>
            <button type="button" className={`${s.primary} ${s.small}`} onClick={() => void acceptInvite(invite)}>
              Зайти
            </button>
            <button type="button" className={`${s.secondary} ${s.small}`} onClick={() => dismissInvite(invite)}>
              Не сейчас
            </button>
          </div>
        </div>
      ))}

      {visibleKnocks.map((k) => (
        <div key={k.knock.id} className={`${s.doorCard} ${s.doorCardKnock}`}>
          <div className={s.doorTitle}>
            ✊ {k.user_name} стучится в «{k.room_name}»
          </div>
          <div className={s.doorSub}>{k.star_name}</div>
          {canAnswer(k.star_id) ? (
            <div className={s.doorActions}>
              <button type="button" className={`${s.primary} ${s.small}`} onClick={() => void answer(k.knock.id, "admit")}>
                Впустить
              </button>
              <button type="button" className={`${s.secondary} ${s.small}`} onClick={() => void answer(k.knock.id, "wait")}>
                В зал ожидания
              </button>
              <button type="button" className={`${s.danger} ${s.small}`} onClick={() => void answer(k.knock.id, "deny")}>
                Отказать
              </button>
            </div>
          ) : (
            <div className={s.doorSub}>Впустить могут модераторы и админы</div>
          )}
        </div>
      ))}

      {myKnock && (
        <div className={s.doorCard}>
          <div className={s.doorTitle}>
            {myKnock.status === "pending"
              ? `✊ Вы постучались в «${myKnock.roomName}» — ждём ответа…`
              : `🛋 Вы в зале ожидания — вас впустят в «${myKnock.roomName}»`}
          </div>
          <div className={s.doorActions}>
            <button type="button" className={`${s.secondary} ${s.small}`} onClick={() => void cancelKnock()}>
              {myKnock.status === "pending" ? "Отменить стук" : "Больше не ждать"}
            </button>
          </div>
        </div>
      )}

      {notice && (
        <div className={s.doorCard}>
          <div className={s.doorTitle}>{notice}</div>
          <div className={s.doorActions}>
            <button type="button" className={`${s.secondary} ${s.small}`} onClick={dismissNotice}>
              Понятно
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
