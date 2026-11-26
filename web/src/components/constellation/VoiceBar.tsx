import { useEffect } from "react";
import { useAuthStore } from "../../store/auth";
import { useStarsStore } from "../../store/stars";
import { useUiStore } from "../../store/ui";
import { useVoiceStore } from "../../store/voice";
import { IconPlanet, IconScreenStop, IconStarMic, IconStarHeadphones, IconStarHeadphonesOff, IconStarMicOff } from "../icons";
import { placeNouns, roomWords } from "./words";
import { RecordingClock, RecordingAlertHost } from "./RecordingAlert";
import { presenceName } from "./rules";
import s from "./Constellation.module.css";

/** «Вы на Планете …» с микрофоном и выходом. floating — поверх других вкладок. */
export function VoiceBar({ floating = false }: { floating?: boolean }) {
  const status = useVoiceStore((st) => st.status);
  const starId = useVoiceStore((st) => st.starId);
  const channelId = useVoiceStore((st) => st.channelId);
  const micOn = useVoiceStore((st) => st.micOn);
  const micUnavailable = useVoiceStore((st) => st.micUnavailable);
  const serverMuted = useVoiceStore((st) => st.serverMuted);
  const listenOnly = useVoiceStore((st) => st.listenOnly);
  const toggleMic = useVoiceStore((st) => st.toggleMic);
  const deafened = useVoiceStore((st) => st.deafened);
  const toggleDeafen = useVoiceStore((st) => st.toggleDeafen);
  const retryMic = useVoiceStore((st) => st.retryMic);
  const leave = useVoiceStore((st) => st.leave);
  const sharingScreen = useVoiceStore((st) => st.sharingScreen);
  const stopScreenShare = useVoiceStore((st) => st.stopScreenShare);
  const detail = useStarsStore((st) => (starId ? st.details[starId] : undefined));
  const myId = useAuthStore((st) => st.user?.id);

  if (status === "idle" || !starId || !channelId) return null;
  const planet = detail?.channels.find((c) => c.id === channelId);
  // Запись в комнате видна и отсюда — с другой вкладки: кто записывает и сколько уже.
  const recorder = status === "connected" ? detail?.voice?.[channelId]?.find((p) => p.recording) : undefined;
  const recorderName = recorder && detail ? (recorder.user_id === myId ? "вы" : presenceName(detail, recorder)) : "";
  const words = roomWords(detail?.kind, planet?.name ?? "");

  const open = () => {
    useUiStore.getState().setTab("stars");
    const stars = useStarsStore.getState();
    void stars.selectStar(starId).then(() => stars.selectChannel(channelId));
    stars.setMobileChannelOpen(true);
  };

  return (
    <div className={floating ? `${s.voiceBar} ${s.voiceBarFloating}` : s.voiceBar}>
      <IconPlanet />
      <button type="button" className={s.voiceBarInfo} onClick={open}>
        <span className={s.voiceBarTitle}>
          {status === "connected" ? words.here : words.entering}
        </span>
        <span className={s.voiceBarSub}>
          {planet?.name ?? placeNouns(detail?.kind).one}
          {detail ? ` · ${detail.name}` : ""}
        </span>
      </button>
      {/* Кнопки — одной группой: в узкой плашке уходят строкой ниже, не сжимая название. */}
      <div className={s.voiceBarActions}>
        {listenOnly ? (
          <span className={s.voiceBarListen} title={`${placeNouns(detail?.kind).one} «Только слушать»: микрофон не используется`}>
            🎧
          </span>
        ) : (
          <button
            type="button"
            className={`${s.secondary} ${s.voiceBarBtn} ${micOn ? "" : s.voiceToggleOff}`}
            onClick={() => void (micUnavailable ? retryMic() : toggleMic())}
            disabled={serverMuted || status !== "connected"}
            aria-label={micOn ? "Выключить микрофон" : "Включить микрофон"}
            title={micOn ? "Выключить микрофон" : "Включить микрофон"}
          >
            {micOn ? <IconStarMic size={18} /> : <IconStarMicOff size={18} />}
          </button>
        )}
        <button
          type="button"
          className={`${s.secondary} ${s.voiceBarBtn} ${deafened ? s.voiceToggleOff : ""}`}
          onClick={() => void toggleDeafen()}
          disabled={status !== "connected"}
          aria-pressed={deafened}
          aria-label={deafened ? "Включить звук собеседников" : "Выключить звук собеседников"}
          title={deafened ? "Вы никого не слышите — включить звук собеседников" : "Выключить звук собеседников и свой микрофон"}
        >
          {deafened ? <IconStarHeadphonesOff size={18} /> : <IconStarHeadphones size={18} />}
        </button>
        {sharingScreen && (
          <button
            type="button"
            className={`${s.secondary} ${s.voiceBarBtn} ${s.screenActive}`}
            onClick={() => void stopScreenShare()}
            aria-label="Остановить показ экрана"
            title="Вы показываете экран — остановить"
          >
            <IconScreenStop size={18} />
          </button>
        )}
        <button
          type="button"
          className={`${s.danger} ${s.voiceBarBtn}`}
          onClick={() => void leave()}
          aria-label={words.leave}
          title={words.leave}
        >
          ✕
        </button>
      </div>
      {recorder && (
        <span className={s.voiceBarRecording} role="status" title={`Идёт запись — записывает ${recorderName}`}>
          <span className={s.recordingDot} aria-hidden />
          Идёт запись · {recorderName}
          {recorder.recording_since && (
            <>
              {" · "}
              <RecordingClock since={recorder.recording_since} />
            </>
          )}
        </span>
      )}
    </div>
  );
}

/** Монтируется на странице мессенджера: плашка вне Созвездия и уведомления голоса. */
export default function VoiceBarHost() {
  const tab = useUiStore((st) => st.tab);
  const mobileChatOpen = useUiStore((st) => st.mobileChatOpen);
  const notice = useVoiceStore((st) => st.notice);
  const dismiss = useVoiceStore((st) => st.dismissNotice);
  const status = useVoiceStore((st) => st.status);
  const channelId = useVoiceStore((st) => st.channelId);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(dismiss, 6000);
    return () => clearTimeout(timer);
  }, [notice, dismiss]);

  // Плашка видна поверх вкладки — списки оставляют под ней место (data-voicebar на <html>).
  const floating = tab !== "stars" && !mobileChatOpen && status !== "idle" && !!channelId;
  useEffect(() => {
    document.documentElement.toggleAttribute("data-voicebar", floating);
    return () => document.documentElement.removeAttribute("data-voicebar");
  }, [floating]);

  return (
    <>
      {floating && <VoiceBar floating />}
      <RecordingAlertHost />
      {notice && (
        <div className={s.notice} role="status">
          <span className={s.noticeText}>{notice}</span>
          <button type="button" className={s.close} onClick={dismiss} aria-label="Закрыть">
            ✕
          </button>
        </div>
      )}
    </>
  );
}
