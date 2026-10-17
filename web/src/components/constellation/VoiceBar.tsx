import { useEffect } from "react";
import { useStarsStore } from "../../store/stars";
import { useUiStore } from "../../store/ui";
import { useVoiceStore } from "../../store/voice";
import { IconPlanet } from "../icons";
import s from "./Constellation.module.css";

/** «Вы на Планете …» с микрофоном и выходом. floating — поверх других вкладок. */
export function VoiceBar({ floating = false }: { floating?: boolean }) {
  const status = useVoiceStore((st) => st.status);
  const starId = useVoiceStore((st) => st.starId);
  const channelId = useVoiceStore((st) => st.channelId);
  const micOn = useVoiceStore((st) => st.micOn);
  const micUnavailable = useVoiceStore((st) => st.micUnavailable);
  const serverMuted = useVoiceStore((st) => st.serverMuted);
  const toggleMic = useVoiceStore((st) => st.toggleMic);
  const retryMic = useVoiceStore((st) => st.retryMic);
  const leave = useVoiceStore((st) => st.leave);
  const detail = useStarsStore((st) => (starId ? st.details[starId] : undefined));

  if (status === "idle" || !starId || !channelId) return null;
  const planet = detail?.channels.find((c) => c.id === channelId);

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
          {status === "connected" ? "Вы на Планете" : "Подключаемся…"}
        </span>
        <span className={s.voiceBarSub}>
          {planet?.name ?? "Планета"}
          {detail ? ` · ${detail.name}` : ""}
        </span>
      </button>
      <button
        type="button"
        className={`${s.secondary} ${s.small} ${micOn ? "" : s.voiceToggleOff}`}
        onClick={() => void (micUnavailable ? retryMic() : toggleMic())}
        disabled={serverMuted || status !== "connected"}
        aria-label={micOn ? "Выключить микрофон" : "Включить микрофон"}
        title={micOn ? "Выключить микрофон" : "Включить микрофон"}
      >
        {micOn ? "🎙" : "🔇"}
      </button>
      <button
        type="button"
        className={`${s.danger} ${s.small}`}
        onClick={() => void leave()}
        aria-label="Выйти с Планеты"
        title="Выйти с Планеты"
      >
        ✕
      </button>
    </div>
  );
}

/** Монтируется на странице мессенджера: плашка вне Созвездия и уведомления голоса. */
export default function VoiceBarHost() {
  const tab = useUiStore((st) => st.tab);
  const mobileChatOpen = useUiStore((st) => st.mobileChatOpen);
  const notice = useVoiceStore((st) => st.notice);
  const dismiss = useVoiceStore((st) => st.dismissNotice);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(dismiss, 6000);
    return () => clearTimeout(timer);
  }, [notice, dismiss]);

  return (
    <>
      {tab !== "stars" && !mobileChatOpen && <VoiceBar floating />}
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
