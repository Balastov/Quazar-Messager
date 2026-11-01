import { useEffect, useRef, useState } from "react";
import type { StarChannel, StarDetail } from "../../api/stars";
import { roomActivitiesApi, type VideoAction } from "../../api/roomActivities";
import { useRoomActivities, type RoomCache } from "../../store/roomActivities";
import { useAuthStore } from "../../store/auth";
import { useVoiceStore } from "../../store/voice";
import { useDevicesStore } from "../../store/devices";
import { applyOutput } from "../../calls/devices";
import { displayName } from "../../utils/profile";
import { clock, videoTime } from "./roomActivityMath";
import { apiError } from "./rules";
import s from "./RoomActivities.module.css";

export default function RoomVideo({ detail, channel, room, readOnly }: {
  detail: StarDetail; channel: StarChannel; room: RoomCache; readOnly: boolean;
}) {
  const myId = useAuthStore((st) => st.user?.id);
  const deafened = useVoiceStore((st) => st.deafened);
  const output = useDevicesStore((st) => st.output);
  const action = useRoomActivities((st) => st.video);
  const upload = useRoomActivities((st) => st.uploadVideo);
  const remove = useRoomActivities((st) => st.deleteVideo);
  const player = useRef<HTMLVideoElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsPlay, setNeedsPlay] = useState(false);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [seek, setSeek] = useState<number | null>(null);
  const [volume, setVolume] = useState(65);
  const video = room.video;
  const fileId = video?.file_id;
  const current = room.videos.find((f) => f.id === fileId);
  const present = detail.voice?.[channel.id] ?? [];
  const privileged = ["owner", "admin", "moderator"].includes(detail.my_role) ||
    present.some((p) => p.user_id === myId && p.is_host);
  const isController = !video || video.owner_id === myId || privileged || !present.some((p) => p.user_id === video.owner_id);
  const canControl = !readOnly && (isController || !!video?.shared_controls);
  const owner = displayName(detail.members.find((m) => m.user.id === video?.owner_id)?.user) ?? "Ведущий";

  useEffect(() => {
    const controller = new AbortController();
    let alive = true, objectUrl: string | null = null;
    setUrl(null); setLoadedId(null); setError(null); setNeedsPlay(false); setDuration(0); setPosition(0); setSeek(null);
    if (!fileId) { setLoading(false); return; }
    setLoading(true);
    void roomActivitiesApi.videoBlob(detail.id, channel.id, fileId, controller.signal).then((blob) => {
      if (!alive) return;
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); setLoadedId(fileId); setLoading(false);
    }).catch((err) => {
      if (alive) { setLoading(false); setError(apiError(err, "Не удалось загрузить ролик")); }
    });
    return () => { alive = false; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [detail.id, channel.id, fileId]);

  useEffect(() => {
    const el = player.current;
    if (!el || !url || !video || loadedId !== video.file_id) return;
    const sync = () => {
      if (el.readyState < 1) return;
      const target = Math.min(videoTime(video, Date.now() + room.clockOffset), Number.isFinite(el.duration) ? el.duration : 86400);
      const diff = target - el.currentTime;
      if (Math.abs(diff) > 1.1 || (!video.playing && Math.abs(diff) > 0.1)) el.currentTime = target;
      el.playbackRate = video.playing && Math.abs(diff) > 0.25 && Math.abs(diff) <= 1.1 ? diff > 0 ? 1.03 : 0.97 : 1;
      if (video.playing && el.paused && !el.ended) {
        void el.play().then(() => setNeedsPlay(false)).catch(() => setNeedsPlay(true));
      } else if (!video.playing && !el.paused) el.pause();
      setPosition(target);
    };
    sync();
    el.addEventListener("loadedmetadata", sync);
    const timer = setInterval(sync, 1000);
    return () => { clearInterval(timer); el.removeEventListener("loadedmetadata", sync); el.playbackRate = 1; };
  }, [url, loadedId, video?.version, video?.playing, room.clockOffset]);

  useEffect(() => { if (player.current) player.current.volume = volume / 100; }, [volume, url]);
  useEffect(() => { void applyOutput(player.current, output); }, [output, url]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); }
    catch (err) { setError(apiError(err, err instanceof Error ? err.message : "Не удалось изменить воспроизведение")); }
    finally { setBusy(false); }
  };
  const command = (kind: VideoAction, extra: Parameters<typeof action>[3] = {}) =>
    run(() => action(detail.id, channel.id, kind, { version: video?.version ?? 0, ...extra }));
  const commitSeek = () => {
    if (seek === null || !canControl) return;
    const value = seek; setSeek(null);
    void command("seek", { position: value, ...(duration > 0 ? { duration } : {}) });
  };
  const uploadFile = async (file: File) => {
    if (file.size > 50 * 1024 * 1024) { setError("Видео должно быть не больше 50 МБ"); return; }
    if (!["video/mp4", "video/webm", "video/ogg"].includes(file.type)) { setError("Выберите видео MP4, WebM или Ogg"); return; }
    setUploadProgress(0);
    await run(() => upload(detail.id, channel.id, file, setUploadProgress));
    setUploadProgress(null);
  };

  return (
    <div className={s.watch}>
      <div className={s.videoBox}>
        {url && loadedId === fileId ? <video ref={player} src={url} className={s.video} playsInline muted={deafened}
          onLoadedMetadata={() => { const value = player.current?.duration; setDuration(value && Number.isFinite(value) ? value : 0); }}
          onError={() => setError("Браузер не может воспроизвести этот ролик. Попробуйте MP4 с H.264 или WebM.")}
          onEnded={() => { if (!video?.duration && canControl && !busy && loadedId === fileId)
            void command("next", { file_id: loadedId ?? undefined }); }} />
          : <div className={s.videoEmpty}>{loading ? "Загружаем ролик…" : current ? current.name
            : room.videos.length ? "Выберите ролик из очереди" : "Добавьте ролик — он появится у всех участников комнаты"}</div>}
        {url && needsPlay && video?.playing && <button type="button" className={s.unlock} onClick={() => {
          void player.current?.play().then(() => setNeedsPlay(false)).catch(() => setError("Нажмите ещё раз, чтобы разрешить воспроизведение"));
        }}>Включить видео и звук у меня</button>}
      </div>
      <div className={s.playerControls}>
        <button type="button" className={s.primary} disabled={busy || !canControl || !url || !video} onClick={() => {
          if (!video) return;
          if (!video.playing && player.current) {
            const el = player.current;
            void el.play().then(() => el.pause()).catch(() => {});
          }
          void command(video.playing ? "pause" : "play", { position: videoTime(video, Date.now() + room.clockOffset),
            ...(duration > 0 ? { duration } : {}) });
        }}>{video?.playing ? "Пауза для всех" : "Смотреть вместе"}</button>
        <button type="button" className={s.button} disabled={busy || !canControl || !video?.file_id} onClick={() => void command("next")}>Следующий</button>
        <span className={s.videoTime}>{clock(seek ?? position)} / {clock(duration || video?.duration || 0)}</span>
        <input className={s.seek} type="range" min={0} max={duration || video?.duration || 1} step="0.1"
          aria-label="Позиция видео для всех" value={seek ?? Math.min(position, duration || video?.duration || 1)}
          disabled={!canControl || busy || !url || !duration} onChange={(e) => setSeek(Number(e.target.value))}
          onPointerUp={commitSeek} onKeyUp={commitSeek} onBlur={commitSeek} />
        <label className={s.volume}>Громкость у меня <input type="range" min={0} max={100} value={volume}
          onChange={(e) => setVolume(Number(e.target.value))} aria-label="Громкость видео у меня" /></label>
      </div>
      <div className={s.videoInfo}>
        <strong>{current?.name ?? "Совместный просмотр"}</strong>
        <span className={s.hint}>Ведущий: {owner}. {video?.shared_controls ? "Управлять могут все участники." : "Пауза и перемотка — у ведущего."}</span>
        {isController && video && <label className={s.check}>
          <input type="checkbox" checked={video.shared_controls} disabled={readOnly || busy}
            onChange={(e) => void command("share", { shared_controls: e.target.checked })} />
          Разрешить управление всем
        </label>}
      </div>
      <div className={s.queueHeader}>
        <strong>Очередь · {room.videos.length} / 20</strong>
        <button type="button" className={s.button} disabled={readOnly || busy || room.videos.length >= 20}
          onClick={() => input.current?.click()}>{uploadProgress !== null ? `Загрузка ${Math.round(uploadProgress * 100)}%` : "Добавить видео"}</button>
        <input ref={input} type="file" accept="video/mp4,video/webm,video/ogg,.mp4,.webm,.ogv" hidden onChange={(e) => {
          const file = e.target.files?.[0]; e.target.value = ""; if (file) void uploadFile(file);
        }} />
      </div>
      <div className={s.queue}>
        {room.videos.map((file) => <div key={file.id} className={file.id === fileId ? s.queueCurrent : s.queueItem}>
          <button type="button" className={s.queueName} disabled={busy || !canControl}
            onClick={() => void command("select", { file_id: file.id })}>{file.id === fileId ? "Сейчас · " : ""}{file.name}</button>
          <span className={s.hint}>{file.duration ? `${clock(file.duration)} · ` : ""}{(file.size / 1024 / 1024).toFixed(1)} МБ</span>
          {(file.uploader_id === myId || privileged) && <button type="button" className={s.button} disabled={busy || readOnly}
            aria-label={`Удалить ${file.name}`} onClick={() => {
              if (window.confirm(`Удалить «${file.name}» из общей очереди?`)) void run(() => remove(detail.id, channel.id, file.id));
            }}>Удалить</button>}
        </div>)}
      </div>
      <p className={s.hint}>MP4, WebM или Ogg до 50 МБ. Видео загружается каждому участнику из Quazar; позиция и пауза общие, громкость — личная.</p>
      {error && <p role="alert" className={s.error}>{error}</p>}
    </div>
  );
}
