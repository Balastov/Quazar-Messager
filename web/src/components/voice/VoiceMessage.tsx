import { useEffect, useRef, useState } from "react";
import { isAxiosError } from "axios";
import { loadVoiceUrl } from "../../attachments/cache";
import { formatDuration, WAVE_MAX, type VoiceRef } from "../../attachments/voice";
import { applyOutput } from "../../calls/devices";
import s from "./Voice.module.css";

const SPEEDS = [1, 1.5, 2] as const;

/** Играет одно голосовое за раз: новое ставит предыдущее на паузу. */
let playing: HTMLAudioElement | null = null;

interface Props {
  chatId: string;
  voice: VoiceRef;
  tone: "own" | "other";
}

/** Голосовое в пузыре: кнопка, форма волны с прогрессом (нажатие — перемотка), время, скорость. */
export default function VoiceMessage({ chatId, voice, tone }: Props) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "playing" | "paused">("idle");
  const [position, setPosition] = useState(0);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [failed, setFailed] = useState<"expired" | "error" | null>(null);

  useEffect(
    () => () => {
      const audio = audioRef.current;
      if (!audio) return;
      audio.pause();
      if (playing === audio) playing = null;
    },
    []
  );

  /** Аудио-элемент: создаём при первом нажатии, когда звук скачан и расшифрован. */
  const ensureAudio = async (): Promise<HTMLAudioElement | null> => {
    if (audioRef.current) return audioRef.current;
    setState("loading");
    try {
      const url = await loadVoiceUrl(chatId, voice);
      const audio = new Audio(url);
      audio.preload = "auto";
      audio.playbackRate = speed;
      audio.ontimeupdate = () => setPosition(audio.currentTime);
      audio.onplay = () => setState("playing");
      audio.onpause = () => setState("paused");
      audio.onended = () => {
        setState("idle");
        setPosition(0);
        if (playing === audio) playing = null;
      };
      await applyOutput(audio);
      audioRef.current = audio;
      return audio;
    } catch (err) {
      setState("idle");
      // 404 — сервер удалил файл по сроку хранения (30 дней).
      setFailed(isAxiosError(err) && err.response?.status === 404 ? "expired" : "error");
      return null;
    }
  };

  const play = async (from?: number) => {
    const audio = await ensureAudio();
    if (!audio) return;
    if (playing && playing !== audio) playing.pause();
    playing = audio;
    if (from !== undefined) {
      audio.currentTime = from;
      setPosition(from);
    }
    try {
      await audio.play();
    } catch {
      setState("paused");
    }
  };

  const toggle = () => {
    const audio = audioRef.current;
    if (audio && !audio.paused) audio.pause();
    else void play();
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    void play(ratio * voice.dur);
  };

  const cycleSpeed = (e: React.MouseEvent) => {
    e.stopPropagation();
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };

  if (failed) {
    return (
      <div className={s.failed}>
        🎤 {failed === "expired" ? "Голосовое удалено — они хранятся 30 дней" : "Голосовое недоступно"}
      </div>
    );
  }

  // У записей MediaRecorder в WebM часто нет длительности в заголовке — опираемся на свою.
  const progress = Math.min(1, position / voice.dur);
  const active = state === "playing" || state === "paused" || position > 0;

  return (
    <div className={tone === "own" ? s.ownVoice : s.voice}>
      <button
        type="button"
        className={s.play}
        onClick={(e) => {
          e.stopPropagation();
          toggle();
        }}
        aria-label={state === "playing" ? "Пауза" : "Слушать"}
        disabled={state === "loading"}
      >
        {state === "loading" ? <span className={s.spinner} /> : state === "playing" ? <PauseIcon /> : <PlayIcon />}
      </button>
      <div className={s.body}>
        <div
          className={s.wave}
          onClick={seek}
          role="slider"
          aria-label="Перемотка"
          aria-valuemin={0}
          aria-valuemax={Math.round(voice.dur)}
          aria-valuenow={Math.round(position)}
        >
          {voice.wave.map((v, i) => (
            <span
              key={i}
              className={(i + 0.5) / voice.wave.length <= progress ? s.barPlayed : s.bar}
              style={{ height: `${Math.max(12, (v / WAVE_MAX) * 100)}%` }}
            />
          ))}
        </div>
        <div className={s.info}>
          <span>{formatDuration(active ? position : voice.dur)}</span>
          {active && (
            <button type="button" className={s.speed} onClick={cycleSpeed} aria-label="Скорость">
              {speed}×
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const PlayIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
    <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" fill="currentColor" />
  </svg>
);

const PauseIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
    <rect x="6" y="5" width="4" height="14" rx="1.2" fill="currentColor" />
    <rect x="14" y="5" width="4" height="14" rx="1.2" fill="currentColor" />
  </svg>
);
