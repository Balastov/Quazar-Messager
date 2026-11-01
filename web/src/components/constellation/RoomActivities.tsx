import { useEffect, useState, type ReactNode } from "react";
import type { StarChannel, StarDetail } from "../../api/stars";
import { useVoiceStore } from "../../store/voice";
import { useAuthStore } from "../../store/auth";
import { useRoomActivities } from "../../store/roomActivities";
import { socket } from "../../ws/socket";
import { apiError } from "./rules";
import ScreenStage from "./ScreenStage";
import FocusOrbit from "./FocusOrbit";
import RoomBoard from "./RoomBoard";
import RoomVideo from "./RoomVideo";
import ActivityFrame from "./ActivityFrame";
import s from "./RoomActivities.module.css";

export default function RoomActivities({ detail, channel, sharerId, sharerName, onStop, controls }: {
  detail: StarDetail; channel: StarChannel; sharerId: string | null; sharerName: string;
  onStop?: () => void; controls: ReactNode;
}) {
  const myId = useAuthStore((st) => st.user?.id);
  const status = useVoiceStore((st) => st.status);
  const screens = useVoiceStore((st) => st.screens);
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
  useEffect(() => { if (sharerId) setView((current) => current ?? "screen"); }, [sharerId]);
  useEffect(() => {
    if (room?.video?.playing && room.video.file_id) setView((current) => current ?? "video");
  }, [room?.video?.playing, room?.video?.file_id]);
  useEffect(() => {
    if (!confirmed || status !== "connected") return;
    let active = true;
    const refresh = () => void load(detail.id, channel.id).then(() => { if (active) setError(null); }).catch((err) => {
      if (active) setError(apiError(err, "Не удалось загрузить активности комнаты"));
    });
    refresh();
    const off = socket.onStatus((open) => { if (open) refresh(); });
    const timer = setInterval(refresh, 30_000);
    return () => { active = false; off(); clearInterval(timer); };
  }, [detail.id, channel.id, confirmed, status, load]);
  const pointersEnabled = !!sharerId && room?.pointers_sharer_id === sharerId;
  const fullscreenControls = <>{controls}{room?.ready && <FocusOrbit detail={detail} channel={channel} room={room} readOnly={readOnly} compact />}</>;
  return (
    <div className={s.activities}>
      {room?.ready && <FocusOrbit detail={detail} channel={channel} room={room} readOnly={readOnly} />}
      <div className={s.tabs} role="group" aria-label="Активности комнаты">
        {([ [null, "Участники"], ["screen", "Экран"], ["board", "Доска"], ["video", "Видео"] ] as const).map(([id, label]) =>
          <button key={id ?? "people"} type="button" className={view === id ? s.activeButton : s.button}
            aria-pressed={view === id} onClick={() => setView(id)}>{label}{id === "screen" && sharerId ? " · идёт показ"
              : id === "video" && room?.video?.playing ? " · смотрим" : ""}</button>)}
      </div>
      {error && <div role="alert" className={s.error}>{error}
        <button type="button" className={s.button} onClick={() => void load(detail.id, channel.id).then(() => setError(null))
          .catch((err) => setError(apiError(err, "Не удалось загрузить активности")))}>Повторить</button>
      </div>}
      {view === "screen" && (sharerId ? <ScreenStage
        sharerName={sharerName} placeInside={detail.kind === "work" ? "в Комнате" : "на Планете"}
        screen={screens.find((screen) => screen.userId === sharerId) ?? null} isMine={sharerId === myId}
        controls={fullscreenControls} onStop={onStop} pointersEnabled={pointersEnabled}
        pointers={Object.values(room?.pointers ?? {})}
        onPoint={!readOnly && pointersEnabled ? (x, y) => point(detail.id, channel.id, sharerId, x, y) : undefined}
        onTogglePointers={sharerId === myId && room?.ready && !readOnly ? () => {
          void setPointers(detail.id, channel.id, !pointersEnabled).catch((err) => setError(apiError(err, "Не удалось изменить указатели")));
        } : undefined}
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
