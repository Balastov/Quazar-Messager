import { useEffect, useRef, useState } from "react";
import { applyOutput } from "../calls/devices";
import { useCallStore, type Reconnecting } from "../store/call";
import { useDevicesStore } from "../store/devices";
import AudioDevices from "./AudioDevices";
import Dialog from "./constellation/Dialog";
import UserAvatar from "./UserAvatar";
import { IconPhone, IconScreenShare, IconScreenStop, IconVideo } from "./icons";
import s from "./CallOverlay.module.css";

/** «Переподключение… 7 с» и пояснение, чья связь пропала. */
function ReconnectNotice({ reason, deadline }: { reason: Reconnecting; deadline: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!reason) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [reason]);
  if (!reason) return null;
  const left = deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : null;
  return (
    <div className={s.reconnect} role="status" aria-live="polite">
      <div className={s.reconnectTitle}>
        Переподключение…{left !== null ? ` ${left} с` : ""}
      </div>
      {reason === "self" && (
        <div className={s.reconnectHint}>Пропала связь с интернетом. Ждём, когда сеть вернётся</div>
      )}
      {reason === "peer" && <div className={s.reconnectHint}>У собеседника пропала связь</div>}
    </div>
  );
}

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
  const reconnecting = useCallStore((st) => st.reconnecting);
  const reconnectDeadline = useCallStore((st) => st.reconnectDeadline);
  const accept = useCallStore((st) => st.accept);
  const reject = useCallStore((st) => st.reject);
  const hangup = useCallStore((st) => st.hangup);
  const toggleMute = useCallStore((st) => st.toggleMute);
  const toggleCamera = useCallStore((st) => st.toggleCamera);
  const flipCamera = useCallStore((st) => st.flipCamera);
  const toggleScreenShare = useCallStore((st) => st.toggleScreenShare);
  const canSendVideo = useCallStore((st) => st.canSendVideo);
  const localVideo = useCallStore((st) => st.localVideo);
  const remoteVideo = useCallStore((st) => st.remoteVideo);
  const noiseSuppression = useCallStore((st) => st.noiseSuppression);
  const noiseSuppressionActive = useCallStore((st) => st.noiseSuppressionActive);
  const toggleNoiseSuppression = useCallStore((st) => st.toggleNoiseSuppression);

  const audioRef = useRef<HTMLAudioElement>(null);
  const output = useDevicesStore((st) => st.output);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);

  const isVideo = media.video === true;
  const remoteShows = remoteVideo.video || remoteVideo.screen;
  // Видео появилось хотя бы с одной стороны — даже в аудиозвонке переходим на экран с видео.
  const showVideoStage =
    (isVideo || !!localVideo || remoteShows) &&
    (phase === "outgoing" || phase === "connecting" || phase === "active" || phase === "incoming");
  const showRemoteVideo = !!remoteStream && remoteShows;

  // Звук собеседника всегда идёт через <audio>, видео — без звука: при переключениях
  // камеры и экрана звук не прерывается и не двоится.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    if (remoteStream) {
      el.srcObject = remoteStream;
      void el.play().catch(() => undefined);
    } else {
      el.srcObject = null;
    }
  }, [remoteStream]);

  useEffect(() => {
    const el = remoteVideoRef.current;
    if (!el) return;
    if (remoteStream && showRemoteVideo) {
      el.srcObject = remoteStream;
      void el.play().catch(() => undefined);
    } else {
      el.srcObject = null;
    }
  }, [remoteStream, showRemoteVideo, showVideoStage]);

  // Звук собеседника — в выбранный динамик (где браузер это умеет).
  useEffect(() => {
    void applyOutput(audioRef.current, output);
  }, [output, remoteStream]);

  useEffect(() => {
    const el = localVideoRef.current;
    if (!el) return;
    if (localStream && localVideo) {
      el.srcObject = localStream;
      void el.play().catch(() => undefined);
    } else {
      el.srcObject = null;
    }
  }, [localStream, localVideo, cameraOff, showVideoStage]);

  if (phase === "idle") return null;

  const name = peerUsername || "Собеседник";
  const inCallControls =
    phase === "outgoing" || phase === "connecting" || phase === "active";

  // Включено, но устройство не тянет RNNoise — работает обычная обработка браузера.
  const noiseUnavailable = noiseSuppression && !noiseSuppressionActive && localStream !== null;
  const devicesButton = (
    <button
      type="button"
      className={s.mute}
      onClick={() => setDevicesOpen(true)}
      title="Микрофон и динамик"
      aria-label="Микрофон и динамик"
    >
      🎧
    </button>
  );

  const videoReady = phase === "active" && canSendVideo();
  const videoHint = phase !== "active" ? "Станет доступно, когда соединение установится" : "Собеседник не поддерживает видео в этом звонке";
  const canShareScreen = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;
  const canPip = typeof document !== "undefined" && document.pictureInPictureEnabled && showRemoteVideo;

  const videoButtons = (
    <>
      <button
        type="button"
        className={localVideo === "camera" ? s.mute : s.muteOn}
        onClick={() => void toggleCamera()}
        disabled={!videoReady}
        aria-label={localVideo === "camera" ? "Выключить камеру" : "Включить камеру"}
        title={videoReady ? (localVideo === "camera" ? "Выключить камеру" : "Включить камеру") : videoHint}
      >
        <IconVideo size={16} />
        {localVideo === "camera" ? "" : " off"}
      </button>
      {canShareScreen && (
        <button
          type="button"
          className={localVideo === "screen" ? s.screenOn : s.mute}
          onClick={() => void toggleScreenShare()}
          disabled={!videoReady}
          aria-label={localVideo === "screen" ? "Остановить показ экрана" : "Показать экран"}
          title={videoReady ? (localVideo === "screen" ? "Остановить показ экрана" : "Показать экран") : videoHint}
        >
          {localVideo === "screen" ? <IconScreenStop size={16} /> : <IconScreenShare size={16} />}
        </button>
      )}
    </>
  );

  const pipButton = canPip ? (
    <button
      type="button"
      className={s.mute}
      onClick={() => void remoteVideoRef.current?.requestPictureInPicture().catch(() => {})}
      aria-label="Картинка в картинке"
      title="Картинка в картинке: видео собеседника поверх других окон"
    >
      ⧉
    </button>
  ) : null;

  const noiseButton = (
    <button
      type="button"
      className={s.mute}
      onClick={() => void toggleNoiseSuppression()}
      aria-pressed={noiseSuppression}
      title={
        noiseUnavailable
          ? "Шумоподавление недоступно на этом устройстве — работает обычная обработка"
          : noiseSuppression
            ? "Шумоподавление включено: фоновые звуки убираются"
            : "Шумоподавление выключено"
      }
    >
      {noiseSuppression ? (noiseUnavailable ? "Шум: —" : "Шум: вкл") : "Шум: выкл"}
    </button>
  );

  return (
    <div className={s.root} role="dialog" aria-label={isVideo ? "Видеозвонок" : "Звонок"}>
      <audio ref={audioRef} autoPlay playsInline />

      {showVideoStage ? (
        <div className={s.videoStage}>
          {showRemoteVideo ? (
            <video
              ref={remoteVideoRef}
              className={remoteVideo.screen ? `${s.remoteVideo} ${s.remoteScreen}` : s.remoteVideo}
              autoPlay
              playsInline
              muted
            />
          ) : (
            <div className={s.videoPlaceholder}>
              <UserAvatar username={name} avatarUrl={peerAvatarUrl} size="lg" />
              <div className={s.name}>{name}</div>
              {reconnecting ? (
                <ReconnectNotice reason={reconnecting} deadline={reconnectDeadline} />
              ) : (
                <div className={s.status}>{statusLabel(phase, error, endReason, isVideo)}</div>
              )}
            </div>
          )}

          <div className={s.localPip}>
            {localStream && localVideo ? (
              <video
                ref={localVideoRef}
                className={localVideo === "screen" ? `${s.localVideo} ${s.localScreen}` : s.localVideo}
                autoPlay
                playsInline
                muted
              />
            ) : (
              <div className={s.localOff}>Камера выкл.</div>
            )}
          </div>

          <div className={s.videoChrome}>
            <div className={s.videoMeta}>
              <div className={s.name}>{name}</div>
              {reconnecting ? (
                <ReconnectNotice reason={reconnecting} deadline={reconnectDeadline} />
              ) : (
                <div className={s.status}>{statusLabel(phase, error, endReason, isVideo)}</div>
              )}
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
                  {noiseButton}
                  {devicesButton}
                  {videoButtons}
                  <button
                    type="button"
                    className={s.mute}
                    onClick={() => void flipCamera()}
                    aria-label="Переключить камеру"
                    disabled={localVideo !== "camera"}
                  >
                    Flip
                  </button>
                  {pipButton}
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
          {reconnecting ? (
            <ReconnectNotice reason={reconnecting} deadline={reconnectDeadline} />
          ) : (
            <div className={s.status}>{statusLabel(phase, error, endReason, isVideo)}</div>
          )}
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
                {noiseButton}
                {devicesButton}
                {videoButtons}
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
      {devicesOpen && (
        <Dialog title="Микрофон и динамик" onClose={() => setDevicesOpen(false)}>
          <AudioDevices />
        </Dialog>
      )}
    </div>
  );
}
