import { useEffect, useRef } from "react";
import { useCallStore } from "../store/call";
import UserAvatar from "./UserAvatar";
import { IconPhone, IconVideo } from "./icons";
import s from "./CallOverlay.module.css";

function statusLabel(
  phase: string,
  error: string | null,
  endReason: string | null,
  isVideo: boolean
) {
  if (error) return error;
  switch (phase) {
    case "outgoing":
      return isVideo ? "Видеовызов…" : "Вызов…";
    case "incoming":
      return isVideo ? "Входящий видеозвонок" : "Входящий звонок";
    case "connecting":
      return "Соединение…";
    case "active":
      return isVideo ? "Видеосвязь" : "Разговор";
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
  const media = useCallStore((st) => st.media);
  const muted = useCallStore((st) => st.muted);
  const cameraOff = useCallStore((st) => st.cameraOff);
  const remoteStream = useCallStore((st) => st.remoteStream);
  const localStream = useCallStore((st) => st.localStream);
  const error = useCallStore((st) => st.error);
  const endReason = useCallStore((st) => st.endReason);
  const accept = useCallStore((st) => st.accept);
  const reject = useCallStore((st) => st.reject);
  const hangup = useCallStore((st) => st.hangup);
  const toggleMute = useCallStore((st) => st.toggleMute);
  const toggleCamera = useCallStore((st) => st.toggleCamera);
  const flipCamera = useCallStore((st) => st.flipCamera);

  const audioRef = useRef<HTMLAudioElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);

  const isVideo = media.video === true;
  const showVideoStage =
    isVideo && (phase === "outgoing" || phase === "connecting" || phase === "active" || phase === "incoming");

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    // When video UI is up, remote audio plays via the remote <video>.
    if (isVideo && showVideoStage) {
      el.srcObject = null;
      return;
    }
    if (remoteStream) {
      el.srcObject = remoteStream;
      void el.play().catch(() => undefined);
    } else {
      el.srcObject = null;
    }
  }, [remoteStream, isVideo, showVideoStage]);

  useEffect(() => {
    const el = remoteVideoRef.current;
    if (!el) return;
    if (remoteStream) {
      el.srcObject = remoteStream;
      void el.play().catch(() => undefined);
    } else {
      el.srcObject = null;
    }
  }, [remoteStream, showVideoStage]);

  useEffect(() => {
    const el = localVideoRef.current;
    if (!el) return;
    if (localStream && !cameraOff) {
      el.srcObject = localStream;
      void el.play().catch(() => undefined);
    } else {
      el.srcObject = null;
    }
  }, [localStream, cameraOff, showVideoStage]);

  if (phase === "idle") return null;

  const name = peerUsername || "Собеседник";
  const inCallControls =
    phase === "outgoing" || phase === "connecting" || phase === "active";

  return (
    <div className={s.root} role="dialog" aria-label={isVideo ? "Видеозвонок" : "Звонок"}>
      <audio ref={audioRef} autoPlay playsInline />

      {showVideoStage ? (
        <div className={s.videoStage}>
          {remoteStream ? (
            <video ref={remoteVideoRef} className={s.remoteVideo} autoPlay playsInline />
          ) : (
            <div className={s.videoPlaceholder}>
              <UserAvatar username={name} avatarUrl={peerAvatarUrl} size="lg" />
              <div className={s.name}>{name}</div>
              <div className={s.status}>{statusLabel(phase, error, endReason, isVideo)}</div>
            </div>
          )}

          <div className={s.localPip}>
            {localStream && !cameraOff ? (
              <video ref={localVideoRef} className={s.localVideo} autoPlay playsInline muted />
            ) : (
              <div className={s.localOff}>Камера выкл.</div>
            )}
          </div>

          <div className={s.videoChrome}>
            <div className={s.videoMeta}>
              <div className={s.name}>{name}</div>
              <div className={s.status}>{statusLabel(phase, error, endReason, isVideo)}</div>
            </div>

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

              {inCallControls && (
                <>
                  <button
                    type="button"
                    className={muted ? s.muteOn : s.mute}
                    onClick={toggleMute}
                    aria-label={muted ? "Включить микрофон" : "Выключить микрофон"}
                  >
                    {muted ? "Mic off" : "Mic"}
                  </button>
                  <button
                    type="button"
                    className={cameraOff ? s.muteOn : s.mute}
                    onClick={toggleCamera}
                    aria-label={cameraOff ? "Включить камеру" : "Выключить камеру"}
                  >
                    <IconVideo size={16} />
                    {cameraOff ? " off" : ""}
                  </button>
                  <button
                    type="button"
                    className={s.mute}
                    onClick={() => void flipCamera()}
                    aria-label="Переключить камеру"
                    disabled={cameraOff}
                  >
                    Flip
                  </button>
                  <button type="button" className={s.reject} onClick={hangup} aria-label="Завершить">
                    <IconPhone size={22} />
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className={s.card}>
          <div className={s.pulse} aria-hidden />
          <UserAvatar username={name} avatarUrl={peerAvatarUrl} size="lg" />
          <div className={s.name}>{name}</div>
          <div className={s.status}>{statusLabel(phase, error, endReason, isVideo)}</div>
          <div className={s.hint}>{isVideo ? "Видеозвонок" : "Аудиозвонок"}</div>

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

            {inCallControls && (
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
              <button
                type="button"
                className={s.dismiss}
                onClick={() => useCallStore.getState().clearEnded()}
              >
                Закрыть
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
