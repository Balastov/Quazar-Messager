/**
 * Запись встречи, которую веду я (пишет мой браузер, см. voice/meetingRecorder.ts).
 *
 * Перед выходом из комнаты запись останавливается и дописывает хвост; вышел из комнаты иначе
 * (обрыв, перешёл в другую) — тоже останавливается. Когда в моей комнате кто-то включил запись,
 * играет короткий сигнал (флаг recording в присутствии комнаты).
 */
import { create } from "zustand";
import { starsApi } from "../api/stars";
import { apiError } from "../components/constellation/rules";
import { playStarSound } from "../sounds/starSounds";
import { MeetingRecorder } from "../voice/meetingRecorder";
import { useAuthStore } from "./auth";
import { useStarsStore } from "./stars";
import { setBeforeLeave, useVoiceStore } from "./voice";

interface RecordingState {
  /** Идущая моя запись: в какой комнате и с какого времени. */
  active: { starId: string; channelId: string; startedAt: number } | null;
  starting: boolean;
  stopping: boolean;
  /** Что сказать: не получилось начать или запись остановилась сама. */
  notice: string | null;

  start: (starId: string, channelId: string, roomName: string) => Promise<void>;
  stop: () => Promise<void>;
  /** Модератор останавливает чужую запись в комнате. */
  stopInRoom: (starId: string, channelId: string) => Promise<void>;
  clearNotice: () => void;
}

let recorder: MeetingRecorder | null = null;

export const useRecordingStore = create<RecordingState>((set, get) => ({
  active: null,
  starting: false,
  stopping: false,
  notice: null,

  start: async (starId, channelId, roomName) => {
    if (recorder || get().starting) return;
    set({ starting: true, notice: null });
    try {
      const next = await MeetingRecorder.start({
        starId,
        channelId,
        roomName,
        onEnded: (message) => {
          if (recorder !== next) return;
          recorder = null;
          setBeforeLeave(null);
          set({ active: null, notice: message });
        },
      });
      // Пока начинали, успели выйти из комнаты — сразу останавливаем.
      const voice = useVoiceStore.getState();
      if (voice.status === "idle" || voice.channelId !== channelId) {
        await next.stop();
        return;
      }
      recorder = next;
      setBeforeLeave(() => get().stop());
      set({ active: { starId, channelId, startedAt: next.startedAt } });
    } catch (err) {
      set({ notice: err instanceof Error && !("isAxiosError" in err) ? err.message : apiError(err) });
    } finally {
      set({ starting: false });
    }
  },

  stop: async () => {
    const current = recorder;
    if (!current) return;
    recorder = null;
    setBeforeLeave(null);
    set({ stopping: true, active: null });
    try {
      await current.stop();
    } finally {
      set({ stopping: false });
    }
  },

  stopInRoom: async (starId, channelId) => {
    set({ notice: null });
    try {
      await starsApi.stopRoomRecording(starId, channelId);
    } catch (err) {
      set({ notice: apiError(err, "Не получилось остановить запись") });
    }
  },

  clearNotice: () => set({ notice: null }),
}));

// Вышел из комнаты без кнопки (обрыв связи, перешёл в другую) — останавливаем запись.
useVoiceStore.subscribe((voice) => {
  if (recorder && (voice.status === "idle" || voice.channelId !== recorder.channelId)) {
    void useRecordingStore.getState().stop();
  }
});

// Закрывают вкладку во время записи — браузер переспросит (хвост иначе пропадёт).
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (event) => {
    if (!recorder) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

/** Кто ведёт запись в моей комнате (ключ «комната:человек»), чтобы сигнал звучал один раз. */
let heardRecording: string | null = null;

function recordingInMyRoom(): string | null {
  const voice = useVoiceStore.getState();
  if (voice.status !== "connected" || !voice.starId || !voice.channelId) return null;
  const presence = useStarsStore.getState().details[voice.starId]?.voice?.[voice.channelId] ?? [];
  const who = presence.find((p) => p.recording)?.user_id;
  return who ? `${voice.channelId}:${who}` : null;
}

function checkRecordingSound() {
  const key = recordingInMyRoom();
  if (key && key !== heardRecording) void playStarSound("recordOn");
  heardRecording = key;
}

useStarsStore.subscribe(checkRecordingSound);

/** Сервер уже показывал «Идёт запись» у меня — значит, пропажа флага значит, что запись остановили. */
let sawMyFlag = false;

// Модератор остановил мою запись: флаг пропал из присутствия. Сразу отдаём кусок — сервер
// ответит, что запись остановлена, и она закончится у меня тоже (не ждём 10 секунд). Если флаг
// пропал по другой причине (перезапуск сервера), кусок просто примут.
function watchMyFlag() {
  const active = useRecordingStore.getState().active;
  const myId = useAuthStore.getState().user?.id;
  if (!recorder || !active || !myId) {
    sawMyFlag = false;
    return;
  }
  const presence = useStarsStore.getState().details[active.starId]?.voice?.[active.channelId];
  const mine = presence?.find((p) => p.user_id === myId);
  if (mine?.recording) sawMyFlag = true;
  else if (sawMyFlag && mine) {
    sawMyFlag = false;
    recorder.ping();
  }
}

// Флаг обычно приходит раньше, чем запись у меня считается начатой, — смотрим и тогда.
useStarsStore.subscribe(watchMyFlag);
useRecordingStore.subscribe(watchMyFlag);
useVoiceStore.subscribe(checkRecordingSound);
