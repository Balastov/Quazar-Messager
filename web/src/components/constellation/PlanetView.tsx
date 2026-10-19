import { useState } from "react";
import { starsApi, type StarChannel, type StarDetail } from "../../api/stars";
import { useAuthStore } from "../../store/auth";
import { useCallStore } from "../../store/call";
import { useDoorsStore } from "../../store/doors";
import { canShareScreen, useVoiceStore, type VoicePeer } from "../../store/voice";
import UserAvatar from "../UserAvatar";
import { IconBack, IconGear, IconPlanet } from "../icons";
import Dialog from "./Dialog";
import AudioDevices from "../AudioDevices";
import ScreenStage from "./ScreenStage";
import { apiError, can, canStopScreen, outranks, ROOM_LABEL, roomDoor } from "./rules";
import { roomWords } from "./words";
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
  const [inviteOpen, setInviteOpen] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const myKnock = useDoorsStore((st) => st.myKnock);
  const allKnocks = useDoorsStore((st) => st.knocks);
  const doors = useDoorsStore.getState();

  const here = voice.channelId === channel.id && voice.status !== "idle";
  const presence = detail.voice?.[channel.id] ?? [];
  const capacity = channel.capacity ?? 10;
  const iAmInside = presence.some((p) => p.user_id === myId);
  const full = presence.length >= capacity && !iAmInside;
  const inCall = callPhase !== "idle" && callPhase !== "ended";
  const room = channel.room_kind ? ROOM_LABEL[channel.room_kind] : null;
  // Дверь: «По приглашениям» (главный — первый вошедший) или личный кабинет.
  const door = roomDoor(detail, channel, myId);
  const closed = door.kind !== "open";
  const personal = door.kind === "personal";
  const listenOnly = !!channel.listen_only;
  const words = roomWords(detail.kind, channel.name);
  const mustKnock = !door.entersFreely && !iAmInside;
  const myKnockHere = myKnock?.channelId === channel.id ? myKnock : null;
  const knocksHere = Object.values(allKnocks).filter((k) => k.knock.channel_id === channel.id);
  const canInvite = !closed || door.canAnswer;
  const iAmHost = door.kind === "invite" && door.hostId === myId;

  const member = (userId: string) => detail.members.find((m) => m.user.id === userId);
  const cabinetOwnerName = personal
    ? (member(channel.cabinet_owner_id ?? "")?.user.username ?? "без хозяина")
    : "";
  /** «главный» в комнате по приглашениям, «хозяин» — в своём кабинете. */
  const badge = (userId: string) =>
    door.kind === "invite" && userId === door.hostId
      ? "👑 главный"
      : personal && userId === channel.cabinet_owner_id
        ? "🔑 хозяин кабинета"
        : null;
  const serverMuted = (userId: string) =>
    presence.find((p) => p.user_id === userId)?.server_muted ?? false;
  // Кто показывает экран — решает сервер; чужие треки экрана без слота не показываем.
  const sharerId = presence.find((p) => p.screen_sharing)?.user_id ?? null;
  const sharerName = sharerId ? (member(sharerId)?.user.username ?? "Участник") : "";
  const sharerRole = sharerId ? member(sharerId)?.role : undefined;
  const canStopSharer =
    !!sharerId && sharerId !== myId && !!sharerRole && canStopScreen(detail, sharerRole);
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
          {personal
            ? `🔑 кабинет ${cabinetOwnerName} · `
            : closed
              ? "🔒 по приглашениям · "
              : "Планета · "}
          {listenOnly ? "🎧 только слушать · " : ""}
          {room ? `${room} · ` : ""}
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
                      {badge(p.user_id) && <span className={s.listSub}>{badge(p.user_id)}</span>}
                      {p.server_muted && (
                        <span className={`${s.listSub} ${s.voicePeerMuted}`}>
                          микрофон выключил модератор
                        </span>
                      )}
                      {p.screen_sharing && <span className={s.listSub}>🖥 показывает экран</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {voice.error && <div className={s.error}>{voice.error}</div>}
          {inCall && <p className={s.hint}>Сначала завершите личный звонок.</p>}
          {listenOnly && (
            <p className={s.hint}>
              🎧 Только слушать: микрофон здесь не включается — браузер его даже не запросит.
              Показывать экран можно.
            </p>
          )}
          {personal && channel.cabinet_owner_id !== myId && (
            <p className={s.hint}>
              🔑 Личный кабинет {cabinetOwnerName}: постучитесь — впустить может хозяин кабинета,
              админ или владелец Звезды. Или попросите кого-то из них позвать вас.
            </p>
          )}
          {door.kind === "invite" && mustKnock && (
            <p className={s.hint}>
              🔒 Комната по приглашениям, внутри уже есть люди: постучитесь — главный в комнате
              впустит вас, отправит в зал ожидания или откажет. Или попросите позвать вас.
            </p>
          )}
          {door.kind === "invite" && !mustKnock && presence.length === 0 && (
            <p className={s.hint}>
              🔒 Комната по приглашениям. Сейчас пусто — заходите, и вы станете в ней главным:
              будете впускать тех, кто стучится, и звать людей.
            </p>
          )}
          {mustKnock && myKnockHere ? (
            <>
              <div className={s.hint}>
                {myKnockHere.status === "pending"
                  ? "✊ Вы постучались — ждём ответа…"
                  : "🛋 Вы в зале ожидания — вас впустят, когда смогут"}
              </div>
              <button type="button" className={s.secondary} onClick={() => void doors.cancelKnock()}>
                {myKnockHere.status === "pending" ? "Отменить стук" : "Больше не ждать"}
              </button>
            </>
          ) : mustKnock || voice.locked?.channelId === channel.id ? (
            <button
              type="button"
              className={s.primary}
              disabled={full || inCall}
              onClick={() => void doors.knock(detail.id, channel.id, channel.name)}
            >
              {full ? words.full : "✊ Постучаться"}
            </button>
          ) : (
            <button
              type="button"
              className={s.primary}
              disabled={full || inCall || voice.status === "connecting"}
              onClick={() => void voice.join(detail.id, channel.id)}
            >
              {full
                ? words.full
                : voice.status === "connecting" && voice.channelId === channel.id
                  ? words.entering
                  : words.enter}
            </button>
          )}
        </div>
      </>
    );
  }

  const statusText =
    voice.status === "connecting"
      ? words.entering
      : voice.status === "reconnecting"
        ? "Связь прерывается — восстанавливаем…"
        : null;

  const peerState = (peer: VoicePeer) => {
    if (listenOnly) return { text: peer.speaking ? "звук экрана" : "слушает", muted: false };
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
        {door.canAnswer && knocksHere.length > 0 && (
          <div className={s.list}>
            {knocksHere.map((k) => (
              <div key={k.knock.id} className={s.listItem}>
                <div className={s.listMain}>
                  <span className={s.listTitle}>
                    {k.knock.status === "pending" ? "✊ Стучится" : "🛋 Ждёт в зале ожидания"}:{" "}
                    {k.user_name}
                  </span>
                </div>
                <button type="button" className={`${s.primary} ${s.small}`} onClick={() => void doors.answer(k.knock.id, "admit")}>
                  Впустить
                </button>
                {k.knock.status === "pending" && (
                  <button type="button" className={`${s.secondary} ${s.small}`} onClick={() => void doors.answer(k.knock.id, "wait")}>
                    В зал ожидания
                  </button>
                )}
                <button type="button" className={`${s.danger} ${s.small}`} onClick={() => void doors.answer(k.knock.id, "deny")}>
                  Отказать
                </button>
              </div>
            ))}
          </div>
        )}
        {voice.serverMuted && (
          <p className={`${s.hint} ${s.warn}`}>
            Модератор выключил вам микрофон. Вы слышите всех, но вас пока не слышно.
          </p>
        )}
        {sharerId && (
          <ScreenStage
            sharerName={sharerName}
            screen={voice.screens.find((sc) => sc.userId === sharerId) ?? null}
            isMine={sharerId === myId}
            onStop={
              sharerId === myId
                ? () => void voice.stopScreenShare()
                : canStopSharer
                  ? () => {
                      if (window.confirm(`Остановить показ экрана ${sharerName}?`)) {
                        void moderate(() => starsApi.stopScreenOf(detail.id, channel.id, sharerId));
                      }
                    }
                  : undefined
            }
          />
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
                {badge(peer.userId) && <span className={s.voicePeerState}>{badge(peer.userId)}</span>}
                {peer.userId === sharerId && <span className={s.voicePeerState}>🖥 показывает экран</span>}
                {iAmHost && !peer.isLocal && (
                  <button
                    type="button"
                    className={`${s.secondary} ${s.small}`}
                    onClick={() => {
                      const name = m?.user.username ?? peer.name;
                      if (window.confirm(`Сделать ${name} главным в комнате? Впускать и звать будет он.`)) {
                        void moderate(() => starsApi.makeHost(detail.id, channel.id, peer.userId));
                      }
                    }}
                  >
                    👑 Сделать главным
                  </button>
                )}
                {canModerate(peer.userId) && (
                  <div className={s.row} style={{ justifyContent: "center" }}>
                    {!listenOnly && (
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
                    )}
                    <button
                      type="button"
                      className={`${s.danger} ${s.small}`}
                      onClick={() => {
                        const name = m?.user.username ?? peer.name;
                        if (window.confirm(words.removeConfirm(name))) {
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
        {voice.listenOnly ? (
          <span className={s.listenOnlyBadge} title="Микрофон на этой Планете не используется">
            🎧 Только слушать
          </span>
        ) : (
          <>
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
          </>
        )}
        {canShareScreen() &&
          (voice.sharingScreen || sharerId === myId ? (
            <button
              type="button"
              className={`${s.secondary} ${s.screenActive}`}
              onClick={() => void voice.stopScreenShare()}
              aria-pressed
            >
              🖥 Остановить показ
            </button>
          ) : (
            <button
              type="button"
              className={s.secondary}
              onClick={() => void voice.startScreenShare()}
              disabled={!!sharerId || voice.screenStarting || voice.status !== "connected"}
              title={sharerId ? `Сейчас экран показывает ${sharerName}` : "Показать экран всем на Планете"}
            >
              {voice.screenStarting ? "🖥 Выбираем экран…" : "🖥 Показать экран"}
            </button>
          ))}
        <button type="button" className={s.secondary} onClick={() => setDevicesOpen(true)}>
          🎧 Устройства
        </button>
        {canInvite && (
          <button type="button" className={s.secondary} onClick={() => setInviteOpen(true)}>
            🚪 Позвать
          </button>
        )}
        <button type="button" className={s.danger} onClick={() => void voice.leave()}>
          {words.leave}
        </button>
      </div>
      {devicesOpen && (
        <Dialog title="Микрофон и динамик" onClose={() => setDevicesOpen(false)}>
          <AudioDevices />
        </Dialog>
      )}
      {inviteOpen && (
        <InviteDialog
          detail={detail}
          channel={channel}
          insideIds={new Set(presence.map((p) => p.user_id))}
          onClose={() => setInviteOpen(false)}
        />
      )}
    </>
  );
}

/** «Позвать» в комнату: участнику Звезды придёт «… зовёт вас в …». */
function InviteDialog({
  detail,
  channel,
  insideIds,
  onClose,
}: {
  detail: StarDetail;
  channel: StarChannel;
  insideIds: Set<string>;
  onClose: () => void;
}) {
  const myId = useAuthStore((st) => st.user?.id);
  const [sent, setSent] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const candidates = detail.members.filter((m) => m.user.id !== myId && !insideIds.has(m.user.id));

  const invite = async (userId: string) => {
    setError(null);
    try {
      await useDoorsStore.getState().invite(detail.id, channel.id, userId);
      setSent((prev) => new Set(prev).add(userId));
    } catch (err) {
      setError(apiError(err));
    }
  };

  return (
    <Dialog title={`Позвать в «${channel.name}»`} onClose={onClose}>
      {candidates.length === 0 && <p className={s.hint}>Все участники Звезды уже здесь.</p>}
      <div className={s.list}>
        {candidates.map((m) => (
          <div key={m.user.id} className={s.listItem}>
            <UserAvatar username={m.user.username} avatarUrl={m.user.avatar_url} size="sm" />
            <div className={s.listMain}>
              <span className={s.listTitle}>{m.user.username}</span>
            </div>
            <button
              type="button"
              className={`${sent.has(m.user.id) ? s.secondary : s.primary} ${s.small}`}
              onClick={() => void invite(m.user.id)}
              disabled={sent.has(m.user.id)}
            >
              {sent.has(m.user.id) ? "Позвали ✓" : "Позвать"}
            </button>
          </div>
        ))}
      </div>
      {error && <div className={s.error}>{error}</div>}
    </Dialog>
  );
}
