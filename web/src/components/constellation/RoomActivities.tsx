import { useEffect, useState, type ReactNode } from "react";
import type { StarChannel, StarDetail } from "../../api/stars";
import { useVoiceStore } from "../../store/voice";
import { useAuthStore } from "../../store/auth";
import { pointerSharers, useRoomActivities } from "../../store/roomActivities";
import { socket } from "../../ws/socket";
import { apiError } from "./rules";
import ScreenStages, { type StageScreen } from "./ScreenStages";
import FocusOrbit from "./FocusOrbit";
import RoomTools from "./RoomTools";
import RoomBoard from "./RoomBoard";
import RoomVideo from "./RoomVideo";
import ActivityFrame from "./ActivityFrame";
import ScreenAudioControls, { ShareScreenAudioToggle } from "../ScreenAudioControls";
import s from "./RoomActivities.module.css";

/** Кто показывает экран: в игровой Планете — один, в рабочей Комнате — до двух. */
export interface RoomSharer {
  userId: string;
  name: string;
  /** Остановить: свой показ — всегда, чужой — модератор. */
  onStop?: () => void;
}

export default function RoomActivities({ detail, channel, sharers, controls }: {
  detail: StarDetail; channel: StarChannel; sharers: RoomSharer[]; controls: ReactNode;
}) {
  const sharerId = sharers[0]?.userId ?? null;
  const sharerKey = sharers.map((sharer) => sharer.userId).join(",");
  const myId = useAuthStore((st) => st.user?.id);
  const status = useVoiceStore((st) => st.status);
  const screens = useVoiceStore((st) => st.screens);
  const screenAudioAvailable = useVoiceStore((st) => st.screenAudioAvailable);
  const screenAudioSharing = useVoiceStore((st) => st.screenAudioSharing);
  const setScreenAudioSharing = useVoiceStore((st) => st.setScreenAudioSharing);
  const room = useRoomActivities((st) => st.rooms[channel.id]);
  const load = useRoomActivities((st) => st.load);
  const setPointers = useRoomActivities((st) => st.setPointers);
  const point = useRoomActivities((st) => st.point);
  const [view, setView] = useState<"screen" | "board" | "video" | null>(sharerId ? "screen" : null);
  const [error, setError] = useState<string | null>(null);
  const present = detail.voice?.[channel.id] ?? [];
  const confirmed = present.some((p) => p.user_id === myId);
  const me = detail.members.find((m) => m.user.id === myId);
  const readOnly = status !== "connected" || detail.rules_accepted === false ||
    !!(me?.timeout_until && Date.parse(me.timeout_until) > Date.now());
  const canClear = ["owner", "admin", "moderator"].includes(detail.my_role) || present.some((p) => p.user_id === myId && p.is_host);
  useEffect(() => {
    setView(sharerId ? "screen" : null); setError(null);
  }, [channel.id]);
  // Начался показ (в том числе второй) — открываем «Экран», если ничего другого не смотрели.
  useEffect(() => { if (sharerKey) setView((current) => current ?? "screen"); }, [sharerKey]);
  useEffect(() => {
    if (room?.video?.playing && room.video.file_id) setView((current) => current ?? "video");
  }, [room?.video?.playing, room?.video?.file_id]);
  // Посетитель по гостевой ссылке видит людей и показ экрана; доска и видео — для участников.
  const visitor = detail.my_role === "visitor";
  useEffect(() => {
    if (visitor || !confirmed || status !== "connected") return;
    let active = true;
    const refresh = () => void load(detail.id, channel.id).then(() => { if (active) setError(null); }).catch((err) => {
      if (active) setError(apiError(err, "Не удалось загрузить активности комнаты"));
    });
    refresh();
    const off = socket.onStatus((open) => { if (open) refresh(); });
    const timer = setInterval(refresh, 30_000);
    return () => { active = false; off(); clearInterval(timer); };
  }, [detail.id, channel.id, confirmed, status, load, visitor]);
  const withPointers = room ? pointerSharers(room) : [];
  // «Орбита фокуса» — для работы: только в комнатах рабочих Звёзд.
  const focus = room?.ready && detail.kind === "work";
  const fullscreenControls = <>{controls}{focus && <FocusOrbit detail={detail} channel={channel} room={room} readOnly={readOnly} compact />}</>;
  return (
    <div className={s.activities}>
      <RoomTools detail={detail} channel={channel}
        summary={focus && <FocusOrbit detail={detail} channel={channel} room={room} readOnly compact />}>
        {focus && <FocusOrbit detail={detail} channel={channel} room={room} readOnly={readOnly} />}
      </RoomTools>
      <div className={s.tabs} role="group" aria-label="Активности комнаты">
        {([ [null, "Участники"], ["screen", "Экран"], ["board", "Доска"], ["video", "Видео"] ] as const)
          .filter(([id]) => !visitor || id === null || id === "screen").map(([id, label]) =>
          <button key={id ?? "people"} type="button" className={view === id ? s.activeButton : s.button}
            aria-pressed={view === id} onClick={() => setView(id)}>{label}{id === "screen" && sharers.length > 1 ? " · идут 2 показа" : id === "screen" && sharerId ? " · идёт показ"
              : id === "video" && room?.video?.playing ? " · смотрим" : ""}</button>)}
      </div>
      {error && <div role="alert" className={s.error}>{error}
        <button type="button" className={s.button} onClick={() => void load(detail.id, channel.id).then(() => setError(null))
          .catch((err) => setError(apiError(err, "Не удалось загрузить активности")))}>Повторить</button>
      </div>}
      {view === "screen" && (sharers.length ? <ScreenStages
        placeInside={detail.kind === "work" ? "в Комнате" : "на Планете"}
        controls={fullscreenControls}
        pointers={Object.values(room?.pointers ?? {})}
        screens={sharers.map((sharer): StageScreen => {
          const mine = sharer.userId === myId;
          const screen = screens.find((sc) => sc.userId === sharer.userId) ?? null;
          const pointersOn = withPointers.includes(sharer.userId);
          return {
            userId: sharer.userId, name: sharer.name, screen, isMine: mine, onStop: sharer.onStop,
            pointersEnabled: pointersOn,
            audioControls: mine ? <ShareScreenAudioToggle enabled={screenAudioSharing} available={screenAudioAvailable}
              onChange={(enabled) => void setScreenAudioSharing(enabled).catch((err) => setError(apiError(err, "Не удалось изменить передачу звука")))} />
              // Два показа — у каждого своя громкость.
              : <ScreenAudioControls available={!!screen?.hasAudio} sharerId={sharers.length > 1 ? sharer.userId : undefined}
                label={sharers.length > 1 ? sharer.name : undefined} />,
            onPoint: !readOnly && pointersOn ? (x, y) => point(detail.id, channel.id, sharer.userId, x, y) : undefined,
            onTogglePointers: mine && room?.ready && !readOnly ? () => {
              void setPointers(detail.id, channel.id, !pointersOn).catch((err) => setError(apiError(err, "Не удалось изменить указатели")));
            } : undefined,
          };
        })}
      /> : <p className={s.hint}>Сейчас никто не показывает экран. Начать показ можно кнопкой в панели разговора.</p>)}
      {(view === "board" || view === "video") && !room?.ready && !error && <p className={s.hint}>Подключаем активности комнаты…</p>}
      {view === "board" && room?.ready && <ActivityFrame title="Общая доска" controls={fullscreenControls}>
        <RoomBoard key={channel.id} starId={detail.id} channelId={channel.id} room={room} readOnly={readOnly} canClear={canClear} />
      </ActivityFrame>}
      {view === "video" && room?.ready && <ActivityFrame title="Совместный просмотр" controls={fullscreenControls}>
        <RoomVideo key={channel.id} detail={detail} channel={channel} room={room} readOnly={readOnly} />
      </ActivityFrame>}
    </div>
  );
}
