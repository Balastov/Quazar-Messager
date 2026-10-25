/**
 * Запись голосового: MediaRecorder + замер громкости для формы волны.
 * Формат — какой умеет браузер: Opus в WebM (Chrome, Firefox, Safari 18.4+),
 * иначе AAC в MP4 (старый Safari). Тип уходит в сообщение, слушатель играет как есть.
 */
import { getMicrophone } from "../calls/devices";
import { buildWave, MAX_VOICE_SEC, type VoiceMime } from "../attachments/voice";

const CANDIDATES: { type: string; mime: VoiceMime }[] = [
  { type: "audio/webm;codecs=opus", mime: "audio/webm" },
  { type: "audio/ogg;codecs=opus", mime: "audio/ogg" },
  { type: "audio/mp4", mime: "audio/mp4" },
  { type: "audio/webm", mime: "audio/webm" },
];

/** Как часто снимать громкость. */
const LEVEL_EVERY_MS = 50;

export interface Recording {
  bytes: Uint8Array;
  mime: VoiceMime;
  /** Секунды. */
  dur: number;
  wave: number[];
}

/** Ошибка с текстом для пользователя. */
export class RecorderError extends Error {}

export function canRecordVoice(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    CANDIDATES.some((c) => MediaRecorder.isTypeSupported(c.type))
  );
}

export class VoiceRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private ctx: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private chunks: Blob[] = [];
  private levels: number[] = [];
  private startedAt = 0;
  private mime: VoiceMime = "audio/webm";
  private finished: Promise<void> | null = null;

  /** Каждые 50 мс: громкость 0…1 и сколько секунд уже записано. */
  onTick: ((level: number, elapsed: number) => void) | null = null;
  /** Упёрлись в MAX_VOICE_SEC — запись остановлена, осталось отправить. */
  onLimit: (() => void) | null = null;

  async start(): Promise<void> {
    const pick = CANDIDATES.find((c) => MediaRecorder.isTypeSupported(c.type));
    if (!pick) throw new RecorderError("Этот браузер не умеет записывать звук");
    this.mime = pick.mime;

    try {
      this.stream = await getMicrophone({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      throw new RecorderError(
        name === "NotAllowedError"
          ? "Нет доступа к микрофону — разрешите его в настройках браузера"
          : "Не удалось включить микрофон"
      );
    }

    const recorder = new MediaRecorder(this.stream, { mimeType: pick.type, audioBitsPerSecond: 32_000 });
    this.recorder = recorder;
    this.chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    this.finished = new Promise((resolve) => {
      recorder.onstop = () => resolve();
    });

    // Громкость — для формы волны и живого индикатора.
    this.levels = [];
    this.ctx = new AudioContext();
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 1024;
    this.ctx.createMediaStreamSource(this.stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);

    recorder.start(1000);
    this.startedAt = performance.now();
    this.timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) sum += v * v;
      // RMS речи редко выше 0.3 — растягиваем, чтобы индикатор жил.
      const level = Math.min(1, Math.sqrt(sum / samples.length) * 4);
      this.levels.push(level);
      const elapsed = this.elapsed();
      this.onTick?.(level, elapsed);
      if (elapsed >= MAX_VOICE_SEC) {
        this.pause();
        this.onLimit?.();
      }
    }, LEVEL_EVERY_MS);
  }

  elapsed(): number {
    return this.startedAt ? (performance.now() - this.startedAt) / 1000 : 0;
  }

  /** Остановить и получить запись. */
  async stop(): Promise<Recording> {
    const dur = this.elapsed();
    this.pause();
    await this.finished;
    const blob = new Blob(this.chunks, { type: this.mime });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    this.release();
    return { bytes, mime: this.mime, dur: Math.round(dur * 10) / 10, wave: buildWave(this.levels) };
  }

  /** Бросить запись. */
  cancel(): void {
    this.pause();
    this.release();
  }

  private pause() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.recorder?.state === "recording") this.recorder.stop();
  }

  private release() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.recorder = null;
    this.chunks = [];
  }
}
