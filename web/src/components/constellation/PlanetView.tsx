import { useState } from "react";
import { starsApi, type StarChannel, type StarDetail } from "../../api/stars";
import { useAuthStore } from "../../store/auth";
import { useCallStore } from "../../store/call";
import { useVoiceStore, type VoicePeer } from "../../store/voice";
import UserAvatar from "../UserAvatar";
import { IconBack, IconGear, IconPlanet } from "../icons";
import { apiError, can, outranks, ROOM_LABEL } from "./rules";
import s from "./Constellation.module.css";

interface Props {
  detail: StarDetail;
  channel: StarChannel;
  onBack?: () => void;
  onEdit: () => void;
}

export default function PlanetView({ detail, channel, onBack, onEdit }: Props) {
  const myId = useAuthStore((st) => st.user?.id);
  const voice = useVoiceStore();
  const callPhase = useCallStore((st) => st.phase);
  const [modError, setModError] = useState<string | null>(null);

  const here = voice.channelId === channel.id && voice.status !== "idle";
  const elsewhere = voice.status !== "idle" && !here;
  const presence = detail.voice?.[channel.id] ?? [];
  const capacity = channel.capacity ?? 10;
  const iAmInside = presence.some((p) => p.user_id === myId);
  const full = presence.length >= capacity && !iAmInside;
  const inCall = callPhase !== "idle" && callPhase !== "ended";
  const room = channel.room_kind ? ROOM_LABEL[channel.room_kind] : null;

  const member = (userId: string) => detail.members.find((m) => m.user.id === userId);
  const serverMuted = (userId: string) =>
    presence.find((p) => p.user_id === userId)?.server_muted ?? false;
  const canModerate = (userId: string) => {
    const role = member(userId)?.role;
    return userId !== myId && !!role && can(detail, "voice_moderate") && outranks(detail.my_role, role);
  };

  const moderate = async (fn: () => Promise<unknown>) => {
    setModError(null);
    try {
      await fn();
    } catch (err) {
      setModError(apiError(err));
    }
  };

  const header = (
    <div className={s.channelHeader}>
      {onBack && (
        <button type="button" className={s.iconBtn} onClick={onBack} aria-label="Назад">
          <IconBack />
        </button>
      )}
      <IconPlanet />
      <div className={s.channelTitle}>
        <span className={s.channelTitleName}>{channel.name}</span>
        <span className={s.channelTitleSub}>
          Планета · {room ? `${room} · ` : ""}
          {presence.length} из {capacity}
        </span>
      </div>
      {can(detail, "manage_channels") && (
        <button
          type="button"
          className={s.iconBtn}
          onClick={onEdit}
          aria-label="Изменить Планету"
          title="Изменить Планету"
        >
          <IconGear />
        </button>
      )}
    </div>
  );

  if (!here) {
    return (
      <>
        {header}
        <div className={s.planet}>
          <div className={s.planetIcon}>
            <IconPlanet size={44} />
          </div>
          <div className={s.planetName}>{channel.name}</div>
          <div>
            {presence.length
              ? `Сейчас здесь ${presence.length} из ${capacity}`
              : `Пока никого · до ${capacity} человек`}
          </div>
          {presence.length > 0 && (
            <div className={s.list} style={{ width: "100%" }}>
              {presence.map((p) => {
                const m = member(p.user_id);
                return (
                  <div key={p.user_id} className={s.listItem}>
                    <UserAvatar
                      username={m?.user.username ?? "?"}
                      avatarUrl={m?.user.avatar_url ?? null}
                      size="sm"
                    />
                    <div className={s.listMain}>
                      <span className={s.listTitle}>{m?.user.username ?? "Участник"}</span>
                      {p.server_muted && (
                        <span className={`${s.listSub} ${s.voicePeerMuted}`}>
                          микрофон выключил модератор
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {voice.error && <div className={s.error}>{voice.error}</div>}
          {inCall && <p className={s.hint}>Сначала завершите личный звонок.</p>}
          <button
            type="button"
            className={s.primary}
            disabled={full || inCall || voice.status === "connecting"}
            onClick={() => void voice.join(detail.id, channel.id)}
          >
            {full
              ? "Планета заполнена"
              : voice.status === "connecting" && voice.channelId === channel.id
                ? "Подключаемся…"
                : elsewhere
                  ? "Перейти на эту Планету"
                  : "Зайти на Планету"}
          </button>
        </div>
      </>
    );
  }

  const statusText =
    voice.status === "connecting"
      ? "Подключаемся…"
      : voice.status === "reconnecting"
        ? "Связь прерывается — восстанавливаем…"
        : null;

  const peerState = (peer: VoicePeer) => {
    if (serverMuted(peer.userId)) return { text: "микрофон выключил модератор", muted: true };
    if (!peer.micOn) return { text: "микрофон выключен", muted: true };
    if (peer.speaking) return { text: "говорит", muted: false };
    return { text: "на связи", muted: false };
  };

  return (
    <>
      {header}
      <div className={s.voice}>
        {statusText && <div className={s.voiceStatus}>{statusText}</div>}
        {voice.needsAudioUnlock && (
          <button type="button" className={s.primary} onClick={() => void voice.unlockAudio()}>
            🔊 Нажмите, чтобы слышать собеседников
          </button>
        )}
        {voice.micUnavailable && voice.micError && (
          <div className={s.listItem} role="alert">
            <div className={s.listMain}>
              <span className={s.listTitle}>Вас не слышно: микрофон не включился</span>
              <span className={s.listSub}>{voice.micError}</span>
            </div>
            <button type="button" className={s.primary} onClick={() => void voice.retryMic()}>
              Включить микрофон
            </button>
          </div>
        )}
        {voice.serverMuted && (
          <p className={`${s.hint} ${s.warn}`}>
            Модератор выключил вам микрофон. Вы слышите всех, но вас пока не слышно.
          </p>
        )}
        <div className={s.voiceGrid}>
          {voice.peers.map((peer) => {
            const m = member(peer.userId);
            const state = peerState(peer);
            return (
              <div key={peer.userId} className={s.voicePeer}>
                <div
                  className={`${s.voiceAvatar} ${peer.speaking && peer.micOn ? s.voiceAvatarSpeaking : ""}`}
                >
                  <UserAvatar
                    username={m?.user.username ?? peer.name}
                    avatarUrl={m?.user.avatar_url ?? null}
                    size="lg"
                  />
                </div>
                <span className={s.voicePeerName}>
                  {m?.user.username ?? peer.name}
                  {peer.isLocal ? " (вы)" : ""}
                </span>
                <span className={`${s.voicePeerState} ${state.muted ? s.voicePeerMuted : ""}`}>
                  {state.text}
                </span>
                {canModerate(peer.userId) && (
                  <div className={s.row} style={{ justifyContent: "center" }}>
                    <button
                      type="button"
                      className={`${s.secondary} ${s.small}`}
                      onClick={() =>
                        void moderate(() =>
                          starsApi.voiceMute(detail.id, channel.id, peer.userId, !serverMuted(peer.userId))
                        )
                      }
                    >
                      {serverMuted(peer.userId) ? "Вернуть микрофон" : "Выключить микрофон"}
                    </button>
                    <button
                      type="button"
                      className={`${s.danger} ${s.small}`}
                      onClick={() => {
                        const name = m?.user.username ?? peer.name;
                        if (window.confirm(`Вывести ${name} с Планеты?`)) {
                          void moderate(() => starsApi.voiceRemove(detail.id, channel.id, peer.userId));
                        }
                      }}
                    >
                      Вывести
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {modError && <div className={s.error}>{modError}</div>}
      </div>

      <div className={s.voiceControls}>
        <button
          type="button"
          className={`${s.secondary} ${voice.micOn ? s.voiceToggle : s.voiceToggleOff}`}
          onClick={() => void (voice.micUnavailable ? voice.retryMic() : voice.toggleMic())}
          disabled={voice.serverMuted || voice.status !== "connected"}
          aria-pressed={voice.micOn}
        >
          {voice.micUnavailable
            ? "🎙 Включить микрофон"
            : voice.micOn
              ? "🎙 Микрофон вкл"
              : "🔇 Микрофон выкл"}
        </button>
        <button
          type="button"
          className={s.secondary}
          onClick={() => void voice.toggleNoise()}
          aria-pressed={voice.noiseSuppression}
          title="Шумоподавление: убирает клавиатуру, вентилятор, улицу"
        >
          {voice.noiseSuppression ? (voice.noiseActive || voice.micUnavailable ? "Шум: вкл" : "Шум: —") : "Шум: выкл"}
        </button>
        <button type="button" className={s.danger} onClick={() => void voice.leave()}>
          Выйти с Планеты
        </button>
      </div>
    </>
  );
}
