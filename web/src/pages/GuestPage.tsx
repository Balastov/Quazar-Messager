import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import axios from "axios";
import type { Participant, RemoteAudioTrack, Room, Track } from "livekit-client";
import { http } from "../api/client";
import { compareNames } from "../utils/profile";
import ScreenStage from "../components/constellation/ScreenStage";
import ScreenAudioControls from "../components/ScreenAudioControls";
import { screenAudioVolume, useScreenAudio } from "../store/screenAudio";
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
}

interface Person {
  id: string;
  name: string;
  speaking: boolean;
  micOn: boolean;
  me: boolean;
}

interface GuestScreen {
  userId: string;
  name: string;
  track: Track | null;
  hasAudio: boolean;
}

const NAME_KEY = "quazar-guest-name";

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
  })).sort((a, b) => compareNames(a.name, b.name));
}

/**
 * Гость по ссылке: без аккаунта, только эта комната. Видит, кто внутри и кто говорит,
 * смотрит демонстрацию экрана, может выключить микрофон и выйти.
 * Больше ничего из Звезды гостю не видно.
 */
export default function GuestPage() {
  const { code = "" } = useParams();
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
  const [screen, setScreen] = useState<GuestScreen | null>(null);
  const roomRef = useRef<Room | null>(null);
  const audioRef = useRef<HTMLDivElement>(null);
  const audioTracks = useRef(new Map<RemoteAudioTrack, boolean>());
  const attemptRef = useRef(0);

  const clearAudio = () => {
    for (const track of audioTracks.current.keys()) track.detach().forEach((el) => el.remove());
    audioTracks.current.clear();
  };

  useEffect(() => {
    let active = true;
    setInfo(null); setError(null); setState("form"); setScreen(null); setList([]);
    http
      .get<GuestInfo>(`/guest/${encodeURIComponent(code)}`)
      .then((r) => { if (active) setInfo(r.data); })
      .catch((err) => { if (active) setError(errorText(err, "Ссылка не открывается")); });
    return () => { active = false; };
  }, [code]);

  useEffect(() => () => {
    attemptRef.current++;
    const room = roomRef.current;
    roomRef.current = null;
    clearAudio();
    void room?.disconnect();
  }, [code]);

  useEffect(() => useScreenAudio.subscribe(() => {
    for (const [track, isScreen] of audioTracks.current) {
      if (isScreen) track.setVolume(screenAudioVolume());
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
      const room = new lk.Room({ adaptiveStream: true, dynacast: true, disconnectOnPageLeave: true });
      roomRef.current = room;
      const sync = () => {
        if (roomRef.current !== room) return;
        setList(people(room));
        setMicOn(room.localParticipant.isMicrophoneEnabled);
        const sharer = [...room.remoteParticipants.values()].find((p) => p.getTrackPublication(lk.Track.Source.ScreenShare));
        const video = sharer?.getTrackPublication(lk.Track.Source.ScreenShare);
        const audio = sharer?.getTrackPublication(lk.Track.Source.ScreenShareAudio);
        setScreen(sharer && video ? { userId: sharer.identity, name: sharer.name || "Участник",
          track: video.track ?? null, hasAudio: !!audio?.track && !audio.isMuted } : null);
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
        .on(lk.RoomEvent.TrackSubscribed, (track, publication) => {
          if (roomRef.current !== room) return;
          if (track.kind === "audio") {
            const audio = track as RemoteAudioTrack;
            if (!audioTracks.current.has(audio)) {
              const isScreen = publication.source === lk.Track.Source.ScreenShareAudio || track.source === lk.Track.Source.ScreenShareAudio;
              audioTracks.current.set(audio, isScreen);
              if (isScreen) audio.setVolume(screenAudioVolume());
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
          setScreen(null); setList([]); setMicOn(false); setNeedsUnlock(false); setState("left");
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
      setScreen(null);
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

  const controls = <div className={s.controls}>
    {needsUnlock && <button type="button" className={s.primary} onClick={() => void roomRef.current?.startAudio().then(() => setNeedsUnlock(false))}>
      🔊 Нажмите, чтобы слышать собеседников
    </button>}
    {!info?.listen_only && <button type="button" className={micOn ? s.secondary : s.danger} onClick={() => void toggleMic()}>
      {micOn ? "🎙 Выключить микрофон" : "🔇 Включить микрофон"}
    </button>}
    <button type="button" className={s.danger} onClick={() => void leave()}>Выйти</button>
  </div>;

  return (
    <div className={s.page}>
      <div className={`${s.card} ${state === "in" && screen ? s.cardWithScreen : ""}`}>
        <img className={s.logo} src="/logo-mark.png?v=neon-q-2" alt="Quazar" />
        {!info && !error && <p className={s.hint}>Открываем приглашение…</p>}
        {info && (
          <>
            <div className={s.title}>{info.room_name}</div>
            <div className={s.sub}>{info.star_name} · вас пригласили как гостя</div>
          </>
        )}
        {error && <div className={s.error}>{error}</div>}

        {info && state !== "in" && state !== "left" && (
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
              {state === "joining" ? "Входим…" : "Войти в комнату"}
            </button>
            <p className={s.hint}>
              {info.listen_only
                ? "В этой комнате только слушают — микрофон не понадобится."
                : "Браузер спросит доступ к микрофону. Регистрироваться не нужно."}
            </p>
          </form>
        )}

        {state === "in" && (
          <>
            {screen && <section aria-label="Демонстрация экрана в комнате">
              <ScreenStage sharerName={screen.name} placeInside="в комнате" isMine={false}
                screen={screen.track ? { userId: screen.userId, isLocal: false, track: screen.track, hasAudio: screen.hasAudio } : null}
                controls={controls} audioControls={<ScreenAudioControls available={screen.hasAudio} />} />
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
            <p className={s.hint}>Вы вышли из комнаты.</p>
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
