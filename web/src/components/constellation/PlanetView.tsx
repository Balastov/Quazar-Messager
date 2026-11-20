import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { starsApi, type StarChannel, type StarDetail } from "../../api/stars";
import { useAuthStore } from "../../store/auth";
import { useCallStore } from "../../store/call";
import { useDoorsStore } from "../../store/doors";
import { canShareScreen, useVoiceStore, type VoicePeer } from "../../store/voice";
import UserAvatar from "../UserAvatar";
import ProfileLink from "../profile/ProfileLink";
import { IconBack, IconGear, IconPlanet, IconStarCamera, IconStarCameraOff, IconStarMic, IconStarMicOff, IconNoiseFilter, IconScreenShare, IconScreenStop, IconStarHeadphones, IconStarInvite, IconStarVolume } from "../icons";
import { ActiveTime, activeSince } from "./ActiveTime";
import Dialog from "./Dialog";
import AudioDevices from "../AudioDevices";
import RoomActivities, { type RoomSharer } from "./RoomActivities";
import ScreenShareDialog from "../ScreenShareDialog";
import { Soundboard, VoiceKeysSettings } from "./VoicePanels";
import { keyLabel } from "../../voice/keys";
import { apiError, can, canStopScreen, MAX_CAMERAS, outranks, passUntil, presenceAvatar, presenceName, ROOM_LABEL, roomDoor, screenLimit } from "./rules";
import { placeNouns, roomWords } from "./words";
import RoomTools from "./RoomTools";
import RoomChat from "./RoomChat";
import PeerVideo from "./PeerVideo";
import ChatResizer from "./ChatResizer";
import { savedChatWidth, saveChatWidth } from "./roomChatWidth";
import UnreadBadge from "../chat/UnreadBadge";
import { hasRoomChat, useStarsStore } from "../../store/stars";
import w from "./Work.module.css";
import { confirmKnock } from "./work";
import s from "./Constellation.module.css";
import { usePresence, usePresenceText } from "../../store/presence";
import { presenceTone } from "../../utils/presence";
import { compareNames, compareUsers, displayName } from "../../utils/profile";

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
  // Развёрнутое видео с камеры: чьё (null — все в сетке).
  const [bigCamera, setBigCamera] = useState<string | null>(null);
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
  const nouns = placeNouns(detail.kind);
  const mustKnock = !door.entersFreely && !iAmInside;
  const myKnockHere = myKnock?.channelId === channel.id ? myKnock : null;
  const knocksHere = Object.values(allKnocks).filter((k) => k.knock.channel_id === channel.id);
  const iAmHost = door.kind === "invite" && door.hostId === myId;
  const chatAvailable = hasRoomChat(channel);
  const chatOpen = useStarsStore((st) => st.roomChatOpen) && chatAvailable;
  const setChatOpen = useStarsStore((st) => st.setRoomChatOpen);
  const chatUnread = useStarsStore((st) => st.unread[channel.id]);
  // Ширина чата на компьютере: тянут за левый край; null — по умолчанию из вёрстки.
  const [chatWidth, setChatWidth] = useState<number | null>(savedChatWidth);
  const layoutRef = useRef<HTMLDivElement>(null);
  const chatRef = useRef<HTMLElement>(null);

  const member = (userId: string) => detail.members.find((m) => m.user.id === userId);
  const userName = (userId: string, fallback?: string | null) =>
    displayName(member(userId)?.user) ?? (fallback?.trim() || "Участник");
  const sortedPresence = [...presence].sort((a, b) =>
    compareNames(presenceName(detail, a), presenceName(detail, b))
  );
  const pass = passUntil(detail, channel.id);
  const cabinetOwnerName = personal
    ? (displayName(member(channel.cabinet_owner_id ?? "")?.user) ?? "без хозяина")
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
  // Кто показывает экран (в рабочей Комнате — до двух человек), в порядке входа.
  const sharing = presence.filter((p) => p.screen_sharing);
  const sharers: RoomSharer[] = sharing.map((p) => {
    const name = presenceName(detail, p);
    const role = member(p.user_id)?.role;
    const canStop = p.user_id !== myId && !!role && canStopScreen(detail, role);
    return {
      userId: p.user_id,
      name,
      onStop:
        p.user_id === myId
          ? () => void voice.stopScreenShare()
          : canStop
            ? () => {
                if (window.confirm(`Остановить показ экрана ${name}?`)) {
                  void moderate(() => starsApi.stopScreenOf(detail.id, channel.id, p.user_id));
                }
              }
            : undefined,
    };
  });
  const canModerate = (userId: string) => {
    // Гостя по ссылке выключает и выводит модератор или главный в комнате.
    if (userId.startsWith("guest-")) return can(detail, "voice_moderate") || door.hostId === myId;
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
            : door.kind === "gathering"
              ? "🔒 для участников сбора · "
              : closed
                ? "🔒 по приглашениям · "
                : `${nouns.one} · `}
          {listenOnly ? "🎧 только слушать · " : ""}
          {room ? `${room} · ` : ""}
          {presence.length} из {capacity}
          {activeSince(detail, channel.id) && (
            <>
              {" · "}
              <ActiveTime since={activeSince(detail, channel.id)} />
            </>
          )}
        </span>
      </div>
      {chatAvailable && !chatOpen && (
        <button
          type="button"
          className={`${s.iconBtn} ${w.roomChatToggle}`}
          onClick={() => setChatOpen(true)}
          aria-label="Открыть чат"
          title="Чат"
        >
          💬
          <UnreadBadge count={chatUnread?.count ?? 0} mentions={chatUnread?.mentions ?? 0} className={w.roomChatBadge} />
        </button>
      )}
      {can(detail, "manage_channels") && (
        <button
          type="button"
          className={s.iconBtn}
          onClick={onEdit}
          aria-label={`Изменить ${nouns.acc}`}
          title={`Изменить ${nouns.acc}`}
        >
          <IconGear />
        </button>
      )}
    </div>
  );

  /** Комната слева, её чат справа (на телефоне — чат вместо комнаты). */
  const withChat = (room: ReactNode, footer?: ReactNode) => (
    <>
      <div ref={layoutRef} className={`${w.roomLayout} ${chatOpen ? w.roomLayoutChat : ""}`}>
        <div className={w.roomMain}>{room}</div>
        {chatOpen && (
          <aside ref={chatRef} className={w.roomChat} aria-label="Чат"
            style={chatWidth ? ({ "--room-chat-width": `${chatWidth}px` } as CSSProperties) : undefined}>
            <ChatResizer layout={layoutRef} panel={chatRef} width={chatWidth} onChange={setChatWidth}
              onCommit={(width) => { setChatWidth(width); saveChatWidth(width); }}
              onReset={() => { setChatWidth(null); saveChatWidth(null); }} />
            <RoomChat key={channel.id} detail={detail} channel={channel} inside={iAmInside} onClose={() => setChatOpen(false)} />
          </aside>
        )}
      </div>
      {footer}
    </>
  );

  if (!here) {
    return withChat(
      <>
        {header}
        <div className={s.planet}>
          <div className={s.planetIcon}>
            <IconPlanet size={44} />
          </div>
          <div className={s.planetName}>{channel.name}</div>
          <div>
            {presence.length ? (
              <>
                Сейчас здесь {presence.length} из {capacity}
                {activeSince(detail, channel.id) && (
                  <>
                    {" · идёт "}
                    <ActiveTime since={activeSince(detail, channel.id)} />
                  </>
                )}
              </>
            ) : (
              `Пока никого · до ${capacity} человек`
            )}
          </div>
          {presence.length > 0 && (
            <div className={s.list} style={{ width: "100%" }}>
              {sortedPresence.map((p) => {
                return (
                  <div key={p.user_id} className={s.listItem}>
                    <ProfileLink userId={p.guest_name || p.user_id.startsWith("guest-") ? null : p.user_id} starId={detail.id}
                      hint={{ display_name: presenceName(detail, p), avatar_url: presenceAvatar(detail, p) }}>
                      <UserAvatar
                        username={presenceName(detail, p)}
                        avatarUrl={presenceAvatar(detail, p)}
                        size="sm"
                      />
                    </ProfileLink>
                    <div className={s.listMain}>
                      <span className={s.listTitle}>
                        <ProfileLink userId={p.guest_name || p.user_id.startsWith("guest-") ? null : p.user_id} starId={detail.id}
                          hint={{ display_name: presenceName(detail, p), avatar_url: presenceAvatar(detail, p) }}>
                          {presenceName(detail, p)}
                        </ProfileLink>
                      </span>
                      {p.visitor && <span className={s.listSub}>🎟 гость по ссылке</span>}
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
          <RoomTools detail={detail} channel={channel} />
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
          {door.kind === "gathering" && mustKnock && (
            <p className={s.hint}>
              🔒 Без стука сюда входят только записавшиеся на сбор и его организаторы. Постучитесь —
              организатор впустит вас, отправит в зал ожидания или откажет. Или попросите позвать вас.
            </p>
          )}
          {door.kind === "invite" && mustKnock && (
            <p className={s.hint}>
              🔒 {nouns.one} по приглашениям, внутри уже есть люди: постучитесь — главный{" "}
              {nouns.inside} впустит вас, отправит в зал ожидания или откажет. Или попросите
              позвать вас.
            </p>
          )}
          {door.kind === "invite" && !mustKnock && presence.length === 0 && detail.my_role !== "visitor" && (
            <p className={s.hint}>
              🔒 {nouns.one} по приглашениям. Сейчас пусто — заходите, и вы станете в ней главным:
              будете впускать тех, кто стучится, и звать людей.
            </p>
          )}
          {pass && (
            <p className={s.hint}>
              🎟 Вас пригласили гостевой ссылкой: входите без стука, пока она действует — до {pass}.
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
              onClick={() => {
                if (confirmKnock(channel)) void doors.knock(detail.id, channel.id, channel.name);
              }}
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

  return withChat(
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
        {(
          <RoomActivities
            detail={detail}
            channel={channel}
            sharers={sharers}
            controls={<RoomControls detail={detail} channel={channel} />}
          />
        )}
        <div className={s.voiceGrid}>
          {[...voice.peers].sort((a, b) =>
            compareNames(userName(a.userId, a.name), userName(b.userId, b.name))
          ).map((peer) => {
            const m = member(peer.userId);
            const state = peerState(peer);
            const camera = voice.cameras.find((c) => c.userId === peer.userId);
            const big = !!camera && bigCamera === peer.userId;
            const speaking = peer.speaking && peer.micOn;
            const presenceOf = presence.find((p) => p.user_id === peer.userId);
            return (
              <div key={peer.userId}
                className={`${s.voicePeer} ${camera ? s.voicePeerVideo : ""} ${big ? s.voicePeerBig : ""}`}>
                {camera ? (
                  // Карточка с камерой — видео; нажатие разворачивает его на всю ширину и обратно.
                  <button type="button" className={`${s.peerVideo} ${speaking ? s.peerVideoSpeaking : ""}`}
                    onClick={() => setBigCamera(big ? null : peer.userId)}
                    aria-label={big ? "Свернуть видео" : `Развернуть видео: ${displayName(m?.user) ?? peer.name}`}
                    title={big ? "Свернуть" : "Развернуть"}>
                    <PeerVideo track={camera.track} mirror={camera.isLocal} className={s.peerVideoEl} />
                  </button>
                ) : (
                  <div className={`${s.voiceAvatar} ${speaking ? s.voiceAvatarSpeaking : ""}`}>
                    <ProfileLink userId={m ? peer.userId : null} starId={detail.id} hint={m?.user}>
                      <UserAvatar
                        username={displayName(m?.user) ?? peer.name}
                        avatarUrl={m?.user.avatar_url ?? presenceOf?.avatar_url ?? null}
                        size="lg"
                      />
                    </ProfileLink>
                  </div>
                )}
                <span className={s.voicePeerName}>
                  <ProfileLink userId={m ? peer.userId : null} starId={detail.id} hint={m?.user}>
                    {displayName(m?.user) ?? peer.name}
                  </ProfileLink>
                  {peer.isLocal ? " (вы)" : ""}
                </span>
                <span className={`${s.voicePeerState} ${state.muted ? s.voicePeerMuted : ""}`}>
                  {state.text}
                </span>
                {badge(peer.userId) && <span className={s.voicePeerState}>{badge(peer.userId)}</span>}
                {sharing.some((p) => p.user_id === peer.userId) && <span className={s.voicePeerState}>🖥 показывает экран</span>}
                {!peer.isLocal && <PeerVolume userId={peer.userId} name={displayName(m?.user) ?? peer.name} />}
                {iAmHost && !peer.isLocal && !peer.userId.startsWith("guest-") && (
                  <button
                    type="button"
                    className={`${s.secondary} ${s.small}`}
                    onClick={() => {
                      const name = displayName(m?.user) ?? peer.name;
                      if (window.confirm(`Сделать ${name} главным ${nouns.inside}? Впускать и звать будет он.`)) {
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
                    {!listenOnly && (presenceOf?.camera || presenceOf?.camera_blocked) && (
                      <button
                        type="button"
                        className={`${s.secondary} ${s.small}`}
                        onClick={() =>
                          void moderate(() =>
                            starsApi.blockCamera(detail.id, channel.id, peer.userId, !presenceOf?.camera_blocked)
                          )
                        }
                      >
                        {presenceOf?.camera_blocked ? "Разрешить камеру" : "Выключить камеру"}
                      </button>
                    )}
                    <button
                      type="button"
                      className={`${s.danger} ${s.small}`}
                      onClick={() => {
                        const name = displayName(m?.user) ?? peer.name;
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
    </>,
    // Панель управления разговором — под комнатой и чатом: на телефоне видна и из чата.
    <RoomControls detail={detail} channel={channel} />
  );
}

/**
 * Панель Комнаты/Планеты внизу: микрофон, шумоподавление, звук, экран, устройства, «Позвать»
 * и «Покинуть Планету» / «Выйти из Комнаты». Та же панель стоит под картой офиса, пока вы в Комнате этой Звезды.
 */
export function RoomControls({ detail, channel }: { detail: StarDetail; channel: StarChannel }) {
  const myId = useAuthStore((st) => st.user?.id);
  const voice = useVoiceStore();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [soundsOpen, setSoundsOpen] = useState(false);
  const [screenDialogOpen, setScreenDialogOpen] = useState(false);

  const presence = detail.voice?.[channel.id] ?? [];
  const door = roomDoor(detail, channel, myId);
  const canInvite = door.kind === "open" || door.canAnswer;
  // Посетитель по гостевой ссылке: говорит и слушает, но звать людей, показывать экран и
  // включать звуки могут только участники.
  const visitor = detail.my_role === "visitor";
  const words = roomWords(detail.kind, channel.name);
  const nouns = placeNouns(detail.kind);
  // Показывают другие: в рабочей Комнате — двое одновременно, на игровой Планете — один.
  const othersSharing = presence.filter((p) => p.screen_sharing && p.user_id !== myId);
  const slotsFull = othersSharing.length >= screenLimit(detail.kind);
  const othersNames = othersSharing.map((p) => presenceName(detail, p)).join(" и ");
  // Камеры: до 9 в комнате; модератор может выключить мою и не давать включить.
  const mine = presence.find((p) => p.user_id === myId);
  const cameraBlocked = !!mine?.camera_blocked;
  const camerasFull = !voice.cameraOn && presence.filter((p) => p.camera && p.user_id !== myId).length >= MAX_CAMERAS;

  return (
    <>
      <div className={s.voiceControls} role="toolbar" aria-label="Управление разговором">
        {voice.listenOnly ? (
          <span className={s.listenOnlyBadge} title={`Микрофон ${nouns.inside} не используется`}>
            🎧 Только слушать
          </span>
        ) : (
          <>
            <ControlButton
              icon={voice.micOn ? <IconStarMic /> : <IconStarMicOff />}
              tone={voice.micOn ? (voice.pttActive ? "on" : "default") : "off"}
              label={
                voice.serverMuted
                  ? "Микрофон выключен (модератор или тайм-аут)"
                  : voice.keys.ptt
                    ? `Рация: говорите, пока держите ${keyLabel(voice.keys.pttKey)}`
                  : voice.micUnavailable
                    ? "Включить микрофон"
                    : voice.micOn
                      ? "Выключить микрофон"
                      : "Включить микрофон"
              }
              pressed={voice.micOn}
              disabled={voice.serverMuted || voice.status !== "connected" || voice.keys.ptt}
              onClick={() => void (voice.micUnavailable ? voice.retryMic() : voice.toggleMic())}
            />
            <ControlButton
              icon={<IconNoiseFilter />}
              tone={voice.noiseSuppression ? "on" : "default"}
              label={
                !voice.noiseSuppression
                  ? "Шумоподавление выключено — включить"
                  : voice.noiseActive || voice.micUnavailable
                    ? "Шумоподавление включено: убирает клавиатуру, вентилятор, улицу"
                    : "Шумоподавление включено, но не работает на этом устройстве"
              }
              pressed={voice.noiseSuppression}
              onClick={() => void voice.toggleNoise()}
            />
            <ControlButton
              icon={voice.cameraOn ? <IconStarCamera /> : <IconStarCameraOff />}
              tone={voice.cameraOn ? "on" : "default"}
              label={
                cameraBlocked
                  ? "Модератор выключил вам камеру"
                  : voice.cameraStarting
                    ? "Включаем камеру…"
                    : voice.cameraOn
                      ? "Выключить камеру"
                      : camerasFull
                        ? `Камер уже ${MAX_CAMERAS} — подождите, пока кто-то выключит свою`
                        : "Включить камеру"
              }
              pressed={voice.cameraOn}
              disabled={(cameraBlocked && !voice.cameraOn) || voice.cameraStarting || camerasFull || voice.status !== "connected"}
              onClick={() => void voice.toggleCamera()}
            />
          </>
        )}
        <ControlButton
          icon={<span aria-hidden>{voice.deafened ? "🔇" : "🔈"}</span>}
          tone={voice.deafened ? "off" : "default"}
          label={voice.deafened ? "Включить звук собеседников (Ctrl+Shift+D)" : "Выключить звук собеседников (Ctrl+Shift+D)"}
          pressed={voice.deafened}
          disabled={voice.status !== "connected"}
          onClick={() => void voice.toggleDeafen()}
        />
        {detail.soundboard !== false && !visitor && (
          <ControlButton
            icon={<span aria-hidden>🎵</span>}
            label="Звуковая панель"
            disabled={voice.status !== "connected"}
            onClick={() => setSoundsOpen(true)}
          />
        )}
        {canShareScreen() && !visitor &&
          (voice.sharingScreen || presence.some((p) => p.screen_sharing && p.user_id === myId) ? (
            <ControlButton
              icon={<IconScreenStop />}
              tone="on"
              label={`Остановить показ экрана · смотрят ${Math.max(0, presence.length - 1)}`}
              pressed
              onClick={() => void voice.stopScreenShare()}
            />
          ) : (
            <ControlButton
              icon={<IconScreenShare />}
              label={
                slotsFull
                  ? othersSharing.length > 1
                    ? `Сейчас экраны показывают ${othersNames} — одновременно не больше двух`
                    : `Сейчас экран показывает ${othersNames}`
                  : voice.screenStarting
                    ? "Выбираем экран…"
                    : othersSharing.length
                      ? `Показать свой экран рядом с показом ${othersNames}`
                      : `Показать экран всем ${nouns.inside}`
              }
              disabled={slotsFull || voice.screenStarting || voice.status !== "connected"}
              onClick={() => setScreenDialogOpen(true)}
            />
          ))}
        <ControlButton
          icon={<IconStarHeadphones />}
          label="Микрофон и динамик"
          onClick={() => setDevicesOpen(true)}
        />
        {canInvite && !visitor && (
          <ControlButton
            icon={<IconStarInvite />}
            label={`Позвать ${nouns.into}`}
            onClick={() => setInviteOpen(true)}
          />
        )}
        <button type="button" className={`${s.danger} ${s.leaveBtn}`} onClick={() => void voice.leave()}>
          {words.leave}
        </button>
      </div>
      {devicesOpen && (
        <Dialog title="Микрофон и динамик" onClose={() => setDevicesOpen(false)}>
          <AudioDevices />
          <VoiceKeysSettings />
        </Dialog>
      )}
      {soundsOpen && (
        <Dialog title="Звуковая панель" onClose={() => setSoundsOpen(false)}>
          <Soundboard detail={detail} channelId={channel.id} />
        </Dialog>
      )}
      {screenDialogOpen && <ScreenShareDialog onStart={(mode, shareAudio) => void voice.startScreenShare(mode, shareAudio)}
        onClose={() => setScreenDialogOpen(false)} />}
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
  const candidates = detail.members.filter((m) => m.user.id !== myId && !insideIds.has(m.user.id))
    .sort((a, b) => compareUsers(a.user, b.user));

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
            <UserAvatar username={displayName(m.user)} avatarUrl={m.user.avatar_url} size="sm" userId={m.user.id} />
            <div className={s.listMain}>
              <span className={s.listTitle}>{displayName(m.user)}</span>
              <MemberPresence userId={m.user.id} />
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

/** «в сети» / «был(а) 5 мин назад» — кого звать прямо сейчас. */
function MemberPresence({ userId }: { userId: string }) {
  const status = usePresence(userId);
  const text = usePresenceText(userId);
  if (!text) return null;
  const tone =
    { online: s.presenceOnline, away: s.presenceAway, busy: s.presenceBusy, none: "" }[presenceTone(status) ?? "none"] ?? "";
  return <span className={`${s.listSub} ${tone}`}>{text}</span>;
}

/** Громкость одного собеседника: 0…200 %, у каждого своя. Щелчок по проценту — снова 100 %. */
function PeerVolume({ userId, name }: { userId: string; name: string }) {
  const volume = useVoiceStore((st) => st.volumes[userId] ?? 1);
  const setPeerVolume = useVoiceStore((st) => st.setPeerVolume);
  const percent = Math.round(volume * 100);
  return (
    <div className={s.peerVolume}>
      <button
        type="button"
        className={s.peerVolumeIcon}
        onClick={() => setPeerVolume(userId, volume === 0 ? 1 : 0)}
        aria-label={volume === 0 ? `Вернуть звук ${name}` : `Заглушить ${name} для себя`}
        title={volume === 0 ? "Вернуть звук" : "Заглушить для себя"}
      >
        <IconStarVolume volume={volume} size={18} />
      </button>
      <input
        type="range"
        min={0}
        max={200}
        step={5}
        value={percent}
        onChange={(e) => setPeerVolume(userId, Number(e.target.value) / 100)}
        className={s.peerVolumeSlider}
        style={{ "--fill": `${percent / 2}%` } as React.CSSProperties}
        aria-label={`Громкость ${name}`}
        aria-valuetext={`${percent} %`}
        title="Слышно только вам"
      />
      <button
        type="button"
        className={`${s.peerVolumeValue} ${percent !== 100 ? s.peerVolumeChanged : ""}`}
        onClick={() => setPeerVolume(userId, 1)}
        disabled={percent === 100}
        title={percent === 100 ? "Громкость как есть" : "Вернуть 100 %"}
      >
        {percent}%
      </button>
    </div>
  );
}

/** Круглая стеклянная кнопка-иконка: подсказка при наведении, подпись — для экранных дикторов. */
function ControlButton({
  icon,
  label,
  onClick,
  tone = "default",
  pressed,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  tone?: "default" | "on" | "off";
  pressed?: boolean;
  disabled?: boolean;
}) {
  const toneClass = tone === "on" ? s.ctrlOn : tone === "off" ? s.ctrlOff : "";
  return (
    <button
      type="button"
      className={`${s.ctrl} ${toneClass}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
    >
      {icon}
    </button>
  );
}
