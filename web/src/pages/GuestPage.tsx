import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import axios from "axios";
import type { Participant, Room } from "livekit-client";
import { http } from "../api/client";
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
  }));
}

/**
 * Гость по ссылке: без аккаунта, только эта комната. Видит, кто внутри и кто говорит,
 * может выключить микрофон и выйти. Больше ничего из Звезды гостю не видно.
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
  const roomRef = useRef<Room | null>(null);
  const audioRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    http
      .get<GuestInfo>(`/guest/${encodeURIComponent(code)}`)
      .then((r) => setInfo(r.data))
      .catch((err) => setError(errorText(err, "Ссылка не открывается")));
  }, [code]);

  useEffect(() => () => void roomRef.current?.disconnect(), []);

  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = name.trim();
    if (!clean) return;
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
      const room = new lk.Room({ adaptiveStream: true, dynacast: true, disconnectOnPageLeave: true });
      roomRef.current = room;
      const sync = () => {
        setList(people(room));
        setMicOn(room.localParticipant.isMicrophoneEnabled);
      };
      room
        .on(lk.RoomEvent.ParticipantConnected, sync)
        .on(lk.RoomEvent.ParticipantDisconnected, sync)
        .on(lk.RoomEvent.ActiveSpeakersChanged, sync)
        .on(lk.RoomEvent.TrackMuted, sync)
        .on(lk.RoomEvent.TrackUnmuted, sync)
        .on(lk.RoomEvent.LocalTrackPublished, sync)
        .on(lk.RoomEvent.TrackSubscribed, (track) => {
          if (track.kind === "audio") audioRef.current?.appendChild(track.attach());
          sync();
        })
        .on(lk.RoomEvent.TrackUnsubscribed, (track) => {
          track.detach().forEach((el) => el.remove());
          sync();
        })
        .on(lk.RoomEvent.AudioPlaybackStatusChanged, () => setNeedsUnlock(!room.canPlaybackAudio))
        .on(lk.RoomEvent.Disconnected, () => {
          setState("left");
          roomRef.current = null;
        });
      await room.connect(data.url, data.token);
      if (!info?.listen_only) {
        await room.localParticipant.setMicrophoneEnabled(true).catch(() => {
          setError("Микрофон не включился — вас не слышно, но вы слышите всех");
        });
      }
      await room.startAudio().catch(() => {});
      setNeedsUnlock(!room.canPlaybackAudio);
      setState("in");
      sync();
    } catch (err) {
      setState("form");
      setError(errorText(err, "Не удалось войти — попробуйте ещё раз"));
    }
  };

  const toggleMic = async () => {
    const room = roomRef.current;
    if (!room) return;
    await room.localParticipant.setMicrophoneEnabled(!room.localParticipant.isMicrophoneEnabled).catch(() => {});
    setMicOn(room.localParticipant.isMicrophoneEnabled);
    setList(people(room));
  };

  const leave = async () => {
    await roomRef.current?.disconnect();
  };

  return (
    <div className={s.page}>
      <div className={s.card}>
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
            {needsUnlock && (
              <button type="button" className={s.primary} onClick={() => void roomRef.current?.startAudio().then(() => setNeedsUnlock(false))}>
                🔊 Нажмите, чтобы слышать собеседников
              </button>
            )}
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
            <div className={s.controls}>
              {!info?.listen_only && (
                <button type="button" className={micOn ? s.secondary : s.danger} onClick={() => void toggleMic()}>
                  {micOn ? "🎙 Выключить микрофон" : "🔇 Включить микрофон"}
                </button>
              )}
              <button type="button" className={s.danger} onClick={() => void leave()}>
                Выйти
              </button>
            </div>
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
