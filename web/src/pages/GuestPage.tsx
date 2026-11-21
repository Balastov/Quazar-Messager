import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import axios from "axios";
import type { LocalTrack, Participant, RemoteAudioTrack, Room, Track } from "livekit-client";
import { http } from "../api/client";
import { rememberGuestLink } from "../api/stars";
import { useAuthStore } from "../store/auth";
import { compareNames } from "../utils/profile";
import ScreenStages from "../components/constellation/ScreenStages";
import ScreenAudioControls from "../components/ScreenAudioControls";
import { screenAudioVolume, useScreenAudio } from "../store/screenAudio";
import PeerVideo from "../components/constellation/PeerVideo";
import { cameraErrorText } from "../calls/cameraErrors";
import s from "./GuestPage.module.css";

interface GuestInfo {
  star_name: string;
  room_name: string;
  expires_at: string;
  listen_only: boolean;
}

interface GuestJoin {
  url: string;
  token: string;
  room: string;
  identity: string;
  room_name: string;
  star_name: string;
  /** Ключ гостя: им он включает и выключает свою камеру. */
  secret: string;
}

interface Person {
  id: string;
  name: string;
  speaking: boolean;
  micOn: boolean;
  me: boolean;
  /** Видео с камеры, если она включена. */
  camera: Track | null;
}

/** Опубликованная камера участника (своя или чужая, на которую подписались). */
function cameraOf(p: Participant): Track | null {
  for (const pub of p.trackPublications.values()) {
    if (pub.source === "camera" && pub.track && !pub.isMuted) return pub.track;
  }
  return null;
}

/** Сервер разрешил публиковать камеру (enum TrackSource: CAMERA = 1). */
function cameraAllowed(room: Room): boolean {
  const perms = room.localParticipant.permissions;
  const sources = (perms?.canPublishSources ?? []) as unknown as number[];
  return !!perms?.canPublish && sources.includes(1);
}

interface GuestScreen {
  userId: string;
  name: string;
  track: Track | null;
  hasAudio: boolean;
}

const NAME_KEY = "quazar-guest-name";

/** Идёт ли в комнате запись встречи: сервер пишет это в метаданные комнаты. */
function roomRecording(metadata: string | undefined): boolean {
  try {
    return !!JSON.parse(metadata || "{}").recording;
  } catch {
    return false;
  }
}

function errorText(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err) && typeof err.response?.data?.detail === "string") return err.response.data.detail;
  return fallback;
}

function people(room: Room): Person[] {
  const all: Participant[] = [room.localParticipant, ...room.remoteParticipants.values()];
  return all.map((p) => ({
    id: p.identity,
    name: p.name || "Участник",
    speaking: p.isSpeaking,
    micOn: p.isMicrophoneEnabled,
    me: p === room.localParticipant,
    camera: cameraOf(p),
  })).sort((a, b) => compareNames(a.name, b.name));
}

/**
 * Гость по ссылке: без аккаунта, только эта комната. Видит, кто внутри и кто говорит,
 * смотрит демонстрацию экрана, может выключить микрофон и выйти.
 * Больше ничего из Звезды гостю не видно.
 *
 * Вошли в аккаунт Quazar — ссылка открывается в приложении: Комната появится там под вашим
 * именем, пока ссылка действует.
 */
export default function GuestPage() {
  const { code = "" } = useParams();
  const navigate = useNavigate();
  const signedIn = useAuthStore((st) => !!st.token);
  const [info, setInfo] = useState<GuestInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(NAME_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [state, setState] = useState<"form" | "joining" | "in" | "left">("form");
  const [list, setList] = useState<Person[]>([]);
  const [micOn, setMicOn] = useState(false);
  const [needsUnlock, setNeedsUnlock] = useState(false);
  // Показы экрана: в рабочей Комнате их может быть два.
  const [screens, setScreens] = useState<GuestScreen[]>([]);
  // Кто-то из участников записывает встречу (метаданные комнаты LiveKit).
  const [recording, setRecording] = useState(false);
  const roomRef = useRef<Room | null>(null);
  const audioRef = useRef<HTMLDivElement>(null);
  // Аудиоплееры: для звука показа — чей это показ (своя громкость у каждого), для голоса — null.
  const audioTracks = useRef(new Map<RemoteAudioTrack, string | null>());
  const attemptRef = useRef(0);
  // Камера гостя: кто он в комнате и его ключ (из ответа на вход), идёт ли включение.
  const meRef = useRef<{ identity: string; secret: string } | null>(null);
  const lkRef = useRef<typeof import("livekit-client") | null>(null);
  const stoppingCamera = useRef(false);
  const [cameraBusy, setCameraBusy] = useState(false);
  // Развёрнутое видео: чьё.
  const [bigCamera, setBigCamera] = useState<string | null>(null);

  const clearAudio = () => {
    for (const track of audioTracks.current.keys()) track.detach().forEach((el) => el.remove());
    audioTracks.current.clear();
  };

  useEffect(() => {
    let active = true;
    setInfo(null); setError(null); setState("form"); setScreens([]); setList([]);
    http
      .get<GuestInfo>(`/guest/${encodeURIComponent(code)}`)
      .then((r) => { if (active) setInfo(r.data); })
      .catch((err) => { if (active) setError(errorText(err, "Ссылка не открывается")); });
    return () => { active = false; };
  }, [code]);

  // С аккаунтом — сразу в приложение: там ссылку «примут» и покажут Комнату.
  const openInApp = () => {
    rememberGuestLink(code);
    navigate(signedIn ? "/" : "/auth", { replace: true });
  };
  useEffect(() => {
    if (signedIn && info) openInApp();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, info]);

  useEffect(() => () => {
    attemptRef.current++;
    const room = roomRef.current;
    roomRef.current = null;
    clearAudio();
    void room?.disconnect();
  }, [code]);

  useEffect(() => useScreenAudio.subscribe(() => {
    for (const [track, sharer] of audioTracks.current) {
      if (sharer) track.setVolume(screenAudioVolume(sharer));
    }
  }), []);

  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = name.trim();
    if (!clean) return;
    const attempt = ++attemptRef.current;
    setError(null);
    setState("joining");
    try {
      localStorage.setItem(NAME_KEY, clean);
    } catch {
      // ignore
    }
    try {
      const { data } = await http.post<GuestJoin>(`/guest/${encodeURIComponent(code)}/join`, { name: clean });
      const lk = await import("livekit-client");
      if (attempt !== attemptRef.current) return;
      lkRef.current = lk;
      meRef.current = { identity: data.identity, secret: data.secret };
      const room = new lk.Room({ adaptiveStream: true, dynacast: true, disconnectOnPageLeave: true });
      roomRef.current = room;
      const sync = () => {
        if (roomRef.current !== room) return;
        setList(people(room));
        setMicOn(room.localParticipant.isMicrophoneEnabled);
        setRecording(roomRecording(room.metadata));
        setScreens([...room.remoteParticipants.values()].flatMap((sharer) => {
          const video = sharer.getTrackPublication(lk.Track.Source.ScreenShare);
          const audio = sharer.getTrackPublication(lk.Track.Source.ScreenShareAudio);
          return video ? [{ userId: sharer.identity, name: sharer.name || "Участник",
            track: video.track ?? null, hasAudio: !!audio?.track && !audio.isMuted }] : [];
        }));
      };
      room
        .on(lk.RoomEvent.ParticipantConnected, sync)
        .on(lk.RoomEvent.ParticipantDisconnected, sync)
        .on(lk.RoomEvent.ActiveSpeakersChanged, sync)
        .on(lk.RoomEvent.TrackMuted, sync)
        .on(lk.RoomEvent.TrackUnmuted, sync)
        .on(lk.RoomEvent.LocalTrackPublished, sync)
        .on(lk.RoomEvent.LocalTrackUnpublished, sync)
        .on(lk.RoomEvent.TrackPublished, sync)
        .on(lk.RoomEvent.TrackUnpublished, sync)
        .on(lk.RoomEvent.ParticipantNameChanged, sync)
        .on(lk.RoomEvent.Reconnected, sync)
        .on(lk.RoomEvent.RoomMetadataChanged, sync)
        .on(lk.RoomEvent.LocalTrackUnpublished, (pub) => {
          // Камеру сняли (сами, модератор или «Только слушать») — место в комнате освобождаем.
          if (pub.source === "camera") void cameraRequest(false).catch(() => {});
        })
        .on(lk.RoomEvent.ParticipantPermissionsChanged, (_prev, participant) => {
          if (participant !== room.localParticipant || stoppingCamera.current) return;
          const camera = cameraOf(room.localParticipant);
          if (camera && !cameraAllowed(room)) {
            setError("Модератор выключил вашу камеру");
            void room.localParticipant.unpublishTrack(camera as LocalTrack).then(sync);
          }
        })
        .on(lk.RoomEvent.TrackSubscribed, (track, publication, participant) => {
          if (roomRef.current !== room) return;
          if (track.kind === "audio") {
            const audio = track as RemoteAudioTrack;
            if (!audioTracks.current.has(audio)) {
              const isScreen = publication.source === lk.Track.Source.ScreenShareAudio || track.source === lk.Track.Source.ScreenShareAudio;
              const sharer = isScreen ? (participant?.identity ?? "") : null;
              audioTracks.current.set(audio, sharer);
              if (sharer !== null) audio.setVolume(screenAudioVolume(sharer || undefined));
              audioRef.current?.appendChild(audio.attach());
            }
          }
          sync();
        })
        .on(lk.RoomEvent.TrackUnsubscribed, (track) => {
          // Видео и его DOM-узел принадлежат ScreenStage; здесь освобождаем только аудиоплееры.
          if (track.kind === "audio") {
            track.detach().forEach((el) => el.remove());
            audioTracks.current.delete(track as RemoteAudioTrack);
          }
          sync();
        })
        .on(lk.RoomEvent.AudioPlaybackStatusChanged, () => {
          if (roomRef.current === room) setNeedsUnlock(!room.canPlaybackAudio);
        })
        .on(lk.RoomEvent.Disconnected, () => {
          if (roomRef.current !== room) return;
          roomRef.current = null;
          clearAudio();
          meRef.current = null;
          setScreens([]); setList([]); setMicOn(false); setNeedsUnlock(false); setCameraBusy(false); setState("left");
        });
      await room.connect(data.url, data.token);
      if (attempt !== attemptRef.current || roomRef.current !== room) return;
      if (!info?.listen_only) {
        await room.localParticipant.setMicrophoneEnabled(true).catch(() => {
          setError("Микрофон не включился — вас не слышно, но вы слышите всех");
        });
      }
      await room.startAudio().catch(() => {});
      if (attempt !== attemptRef.current || roomRef.current !== room) return;
      setNeedsUnlock(!room.canPlaybackAudio);
      setState("in");
      sync();
    } catch (err) {
      if (attempt !== attemptRef.current) return;
      const room = roomRef.current;
      roomRef.current = null;
      clearAudio();
      void room?.disconnect();
      setScreens([]);
      setState("form");
      setError(errorText(err, "Не удалось войти — попробуйте ещё раз"));
    }
  };

  const toggleMic = async () => {
    const room = roomRef.current;
    if (!room) return;
    await room.localParticipant.setMicrophoneEnabled(!room.localParticipant.isMicrophoneEnabled).catch(() => {});
    if (roomRef.current !== room) return;
    setMicOn(room.localParticipant.isMicrophoneEnabled);
    setList(people(room));
  };

  const leave = async () => {
    await roomRef.current?.disconnect();
  };

  const cameraRequest = (on: boolean) => {
    const me = meRef.current;
    if (!me) return Promise.resolve();
    return http.post(`/guest/${encodeURIComponent(code)}/camera`, { ...me, on });
  };

  /** Право на камеру приходит от LiveKit чуть позже ответа сервера — ждём его. */
  const waitForCamera = (room: Room, lk: typeof import("livekit-client")) =>
    new Promise<void>((resolve, reject) => {
      if (cameraAllowed(room)) return resolve();
      const timer = setTimeout(() => { room.off(lk.RoomEvent.ParticipantPermissionsChanged, check); reject(new Error("timeout")); }, 5000);
      function check() {
        if (!cameraAllowed(room)) return;
        clearTimeout(timer);
        room.off(lk.RoomEvent.ParticipantPermissionsChanged, check);
        resolve();
      }
      room.on(lk.RoomEvent.ParticipantPermissionsChanged, check);
    });

  const refresh = (room: Room) => {
    if (roomRef.current === room) setList(people(room));
  };

  const toggleCamera = async () => {
    const room = roomRef.current;
    const lk = lkRef.current;
    if (!room || !lk || cameraBusy) return;
    const current = cameraOf(room.localParticipant);
    if (current) {
      stoppingCamera.current = true;
      try {
        // LiveKit сам гасит камеру при снятии; место освобождает LocalTrackUnpublished.
        await room.localParticipant.unpublishTrack(current as LocalTrack).catch(() => {});
      } finally {
        stoppingCamera.current = false;
      }
      refresh(room);
      return;
    }
    setCameraBusy(true);
    setError(null);
    // Сначала камера: если браузер её не даст, место в комнате не занимаем.
    let track: MediaStreamTrack;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } },
      });
      track = stream.getVideoTracks()[0];
    } catch (err) {
      setError(cameraErrorText(err));
      setCameraBusy(false);
      return;
    }
    try {
      await cameraRequest(true);
      await waitForCamera(room, lk);
      if (roomRef.current !== room) throw new Error("left");
      const publication = await room.localParticipant.publishTrack(track, {
        source: lk.Track.Source.Camera,
        name: "camera",
        simulcast: true,
        videoEncoding: lk.VideoPresets.h720.encoding,
        videoSimulcastLayers: [lk.VideoPresets.h180, lk.VideoPresets.h360],
      });
      // Камеру выдернули — выключаем, как будто нажали кнопку.
      track.addEventListener("ended", () => {
        if (roomRef.current === room && publication.track && cameraOf(room.localParticipant) === publication.track) {
          void room.localParticipant.unpublishTrack(publication.track).then(() => refresh(room));
        }
      });
    } catch (err) {
      track.stop();
      void cameraRequest(false).catch(() => {});
      if (roomRef.current === room) setError(errorText(err, "Не удалось включить камеру. Попробуйте ещё раз."));
    }
    setCameraBusy(false);
    refresh(room);
  };

  const me = list.find((p) => p.me);
  const cameras = list.filter((p) => p.camera);

  const controls = <div className={s.controls}>
    {recording && <div className={s.recording} role="status">● Идёт запись встречи</div>}
    {needsUnlock && <button type="button" className={s.primary} onClick={() => void roomRef.current?.startAudio().then(() => setNeedsUnlock(false))}>
      🔊 Нажмите, чтобы слышать собеседников
    </button>}
    {!info?.listen_only && <button type="button" className={micOn ? s.secondary : s.danger} onClick={() => void toggleMic()}>
      {micOn ? "🎙 Выключить микрофон" : "🔇 Включить микрофон"}
    </button>}
    {!info?.listen_only && <button type="button" className={s.secondary} disabled={cameraBusy} aria-pressed={!!me?.camera}
      onClick={() => void toggleCamera()}>
      {cameraBusy ? "📷 Включаем камеру…" : me?.camera ? "📷 Выключить камеру" : "📷 Включить камеру"}
    </button>}
    <button type="button" className={s.danger} onClick={() => void leave()}>Выйти из Комнаты</button>
  </div>;

  return (
    <div className={s.page}>
      <div className={`${s.card} ${state === "in" && screens.length ? s.cardWithScreen
        : state === "in" && cameras.length ? s.cardWithCameras : ""}`}>
        <img className={s.logo} src="/logo-mark.png?v=neon-q-2" alt="Quazar" />
        {!info && !error && <p className={s.hint}>Открываем приглашение…</p>}
        {info && (
          <>
            <div className={s.title}>{info.room_name}</div>
            <div className={s.sub}>{info.star_name} · вас пригласили как гостя</div>
          </>
        )}
        {error && <div className={s.error}>{error}</div>}

        {info && signedIn && <p className={s.hint}>Открываем в Quazar…</p>}
        {info && !signedIn && state !== "in" && state !== "left" && (
          <form className={s.form} onSubmit={(e) => void join(e)}>
            <input
              className={s.input}
              value={name}
              maxLength={40}
              autoFocus
              placeholder="Как вас представить?"
              aria-label="Ваше имя"
              onChange={(e) => setName(e.target.value)}
            />
            <button type="submit" className={s.primary} disabled={!name.trim() || state === "joining"}>
              {state === "joining" ? "Входим…" : "Войти в Комнату"}
            </button>
            <p className={s.hint}>
              {info.listen_only
                ? "В этой комнате только слушают — микрофон не понадобится."
                : "Браузер спросит доступ к микрофону. Регистрироваться не нужно."}
            </p>
            {state === "form" && (
              <p className={s.hint}>
                Есть аккаунт Quazar?{" "}
                <button type="button" className={s.linkButton} onClick={openInApp}>
                  Войдите
                </button>{" "}
                — и Комната появится в приложении под вашим именем.
              </p>
            )}
          </form>
        )}

        {state === "in" && (
          <>
            {screens.length > 0 && <section aria-label="Демонстрация экрана в комнате">
              <ScreenStages placeInside="в комнате" controls={controls}
                screens={screens.map((screen) => ({
                  userId: screen.userId, name: screen.name, isMine: false, pointersEnabled: false,
                  screen: screen.track ? { userId: screen.userId, isLocal: false, track: screen.track, hasAudio: screen.hasAudio } : null,
                  audioControls: <ScreenAudioControls available={screen.hasAudio}
                    sharerId={screens.length > 1 ? screen.userId : undefined} label={screens.length > 1 ? screen.name : undefined} />,
                }))} />
            </section>}
            {cameras.length > 0 && <section className={s.cameras} aria-label="Камеры">
              {cameras.map((p) => {
                const big = bigCamera === p.id;
                return <button key={p.id} type="button"
                  className={`${s.cameraTile} ${big ? s.cameraBig : ""} ${p.speaking && p.micOn ? s.cameraSpeaking : ""}`}
                  onClick={() => setBigCamera(big ? null : p.id)}
                  aria-label={big ? "Свернуть видео" : `Развернуть видео: ${p.name}`}>
                  <PeerVideo track={p.camera!} mirror={p.me} className={s.cameraVideo} />
                  <span className={s.cameraName}>{p.name}{p.me ? " — вы" : ""}</span>
                </button>;
              })}
            </section>}
            <div className={s.people} aria-label="Кто в комнате">
              {list.map((p) => (
                <div key={p.id} className={s.person}>
                  <span className={p.speaking && p.micOn ? `${s.avatar} ${s.speaking}` : s.avatar}>
                    {p.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className={s.personName}>
                    {p.name}
                    {p.me ? " — вы" : ""}
                  </span>
                  <span className={s.personState}>{p.micOn ? (p.speaking ? "говорит" : "") : "🔇"}</span>
                </div>
              ))}
            </div>
            {controls}
          </>
        )}

        {state === "left" && (
          <>
            <p className={s.hint}>Вы вышли из Комнаты.</p>
            <button type="button" className={s.secondary} onClick={() => setState("form")}>
              Войти снова
            </button>
          </>
        )}
      </div>
      <div ref={audioRef} hidden />
    </div>
  );
}
