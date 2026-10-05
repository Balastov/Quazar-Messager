import { useEffect, useRef } from "react";
import { useCallStore } from "../store/call";
import UserAvatar from "./UserAvatar";
import { IconPhone } from "./icons";
import s from "./CallOverlay.module.css";

function statusLabel(phase: string, error: string | null, endReason: string | null) {
  if (error) return error;
  switch (phase) {
    case "outgoing":
      return "Вызов…";
    case "incoming":
      return "Входящий звонок";
    case "connecting":
      return "Соединение…";
    case "active":
      return "Разговор";
    case "ended":
      if (endReason === "busy") return "Занято";
      if (endReason === "unavailable") return "Недоступен";
      if (endReason === "reject") return "Отклонён";
      if (endReason === "failed") return "Сбой соединения";
      if (endReason === "timeout") return "Нет ответа";
      return "Звонок завершён";
    default:
      return "";
  }
}

export default function CallOverlay() {
  const phase = useCallStore((st) => st.phase);
  const peerUsername = useCallStore((st) => st.peerUsername);
  const peerAvatarUrl = useCallStore((st) => st.peerAvatarUrl);
  const muted = useCallStore((st) => st.muted);
  const remoteStream = useCallStore((st) => st.remoteStream);
  const error = useCallStore((st) => st.error);
  const endReason = useCallStore((st) => st.endReason);
  const accept = useCallStore((st) => st.accept);
  const reject = useCallStore((st) => st.reject);
  const hangup = useCallStore((st) => st.hangup);
  const toggleMute = useCallStore((st) => st.toggleMute);

  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    if (remoteStream) {
      el.srcObject = remoteStream;
      void el.play().catch(() => {
        // Autoplay may require a user gesture; accept/hangup already is one.
      });
    } else {
      el.srcObject = null;
    }
  }, [remoteStream]);

  if (phase === "idle") return null;

  const name = peerUsername || "Собеседник";

  return (
    <div className={s.root} role="dialog" aria-label="Звонок">
      <audio ref={audioRef} autoPlay playsInline />
      <div className={s.card}>
        <div className={s.pulse} aria-hidden />
        <UserAvatar username={name} avatarUrl={peerAvatarUrl} size="lg" />
        <div className={s.name}>{name}</div>
        <div className={s.status}>{statusLabel(phase, error, endReason)}</div>
        <div className={s.hint}>Аудио · E2E медиа позже</div>

        <div className={s.actions}>
          {phase === "incoming" && (
            <>
              <button type="button" className={s.reject} onClick={reject} aria-label="Отклонить">
                <IconPhone size={22} />
              </button>
              <button
                type="button"
                className={s.accept}
                onClick={() => void accept()}
                aria-label="Принять"
              >
                <IconPhone size={22} />
              </button>
            </>
          )}

          {(phase === "outgoing" || phase === "connecting" || phase === "active") && (
            <>
              <button
                type="button"
                className={muted ? s.muteOn : s.mute}
                onClick={toggleMute}
                aria-label={muted ? "Включить микрофон" : "Выключить микрофон"}
              >
                {muted ? "Mic off" : "Mic"}
              </button>
              <button type="button" className={s.reject} onClick={hangup} aria-label="Завершить">
                <IconPhone size={22} />
              </button>
            </>
          )}

          {phase === "ended" && (
            <button type="button" className={s.dismiss} onClick={() => useCallStore.getState().clearEnded()}>
              Закрыть
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
