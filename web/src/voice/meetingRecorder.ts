/**
 * Запись встречи в комнате рабочей Звезды — в браузере того, кто её включил (у сервера нет
 * ресурсов писать сам).
 *
 * Звук: всё, что звучит в комнате (мой микрофон, собеседники, звук показа экрана), сводится через
 * WebAudio в одну дорожку. Видео: холст 1280×720, на нём показ экрана (один или два рядом), а когда
 * никто не показывает — заставка с названием комнаты. Пишутся две записи: видео со звуком и
 * отдельно только звук (для расшифровки). Каждые 10 секунд куски по порядку уходят на сервер,
 * после остановки сервер собирает файлы и кладёт сообщение «Запись встречи» в чат комнаты.
 *
 * Сервер — app/core/recordings.py.
 */
import axios from "axios";
import { starsApi } from "../api/stars";
import { roomMediaForRecording } from "../store/voice";

export type RecordingKind = "video" | "audio";

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 15;
/** Как часто MediaRecorder отдаёт кусок (и он уходит на сервер). */
const TIMESLICE_MS = 10_000;
/** Как часто пересобирать звук и экраны (кто-то вошёл, начал показ). */
const SYNC_EVERY_MS = 1000;
/** Сколько ждём досылки хвоста после остановки, прежде чем сдаться. */
const DRAIN_MS = 60_000;
/** Нет связи так долго, что в памяти скопилось столько, — останавливаем, чтобы не съесть всю память. */
const MAX_QUEUED_BYTES = 300 * 1024 * 1024;

const VIDEO_TYPES = ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm", "video/mp4"];
const AUDIO_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

/** Первый тип, который умеет этот браузер, или null. */
export function chooseType(candidates: string[], supported: (type: string) => boolean): string | null {
  return candidates.find((type) => supported(type)) ?? null;
}

/** «video/webm;codecs=vp8,opus» → «video/webm» (так тип хранит сервер). */
export function baseMime(type: string): string {
  return type.split(";")[0].trim();
}

function supported(type: string): boolean {
  try {
    return typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type);
  } catch {
    return false;
  }
}

/** Умеет ли браузер писать встречи (Chrome, Edge, Firefox, Safari 18+, приложение для ПК). */
export function canRecordMeetings(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    typeof AudioContext !== "undefined" &&
    typeof HTMLCanvasElement !== "undefined" &&
    "captureStream" in HTMLCanvasElement.prototype &&
    !!chooseType(VIDEO_TYPES, supported) &&
    !!chooseType(AUDIO_TYPES, supported)
  );
}

/** Вписать картинку sw×sh в прямоугольник с полями по краям (без обрезки). */
export function fitRect(
  sw: number,
  sh: number,
  x: number,
  y: number,
  w: number,
  h: number
): [number, number, number, number] {
  if (!sw || !sh) return [x, y, w, h];
  const scale = Math.min(w / sw, h / sh);
  const dw = Math.round(sw * scale);
  const dh = Math.round(sh * scale);
  return [x + Math.round((w - dw) / 2), y + Math.round((h - dh) / 2), dw, dh];
}

/** Подпись для имён файлов в местном времени: «21.11 14:00». */
export function recordingLabel(at: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(at.getDate())}.${two(at.getMonth() + 1)} ${two(at.getHours())}:${two(at.getMinutes())}`;
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Отправить кусок. Ошибка с HTTP-статусом — сервер ответил; без статуса — нет связи. */
export type SendChunk = (kind: RecordingKind, seq: number, data: Blob) => Promise<void>;

/** Почему сервер больше не принимает куски — текст для пользователя. */
function refusal(err: unknown): string | null {
  if (!axios.isAxiosError(err) || !err.response) return null;
  const { status, data } = err.response;
  if (![403, 404, 409, 413, 507].includes(status)) return null;
  const detail = (data as { detail?: unknown } | undefined)?.detail;
  if (typeof detail === "string") return detail;
  return status === 409 ? "Запись остановлена" : "Сервер больше не принимает запись";
}

/**
 * Очередь кусков: по порядку для каждого вида, кусок уходит из памяти, только когда сервер его
 * принял. Нет связи — повторяем с паузой (до 15 с). Сервер отказал (остановили, нет места, предел
 * размера) — очередь «умирает» и сообщает причину.
 */
export class ChunkUploader {
  private queue: { kind: RecordingKind; seq: number; data: Blob }[] = [];
  private next: Record<RecordingKind, number> = { video: 0, audio: 0 };
  private queuedBytes = 0;
  private pumping = false;
  private giveUpAt: number | null = null;
  dead = false;

  constructor(
    private send: SendChunk,
    private onDead: (message: string) => void,
    private wait: (ms: number) => Promise<void> = sleep,
    private now: () => number = Date.now
  ) {}

  push(kind: RecordingKind, data: Blob): void {
    if (this.dead || !data.size) return;
    this.queue.push({ kind, seq: this.next[kind]++, data });
    this.queuedBytes += data.size;
    if (this.queuedBytes > MAX_QUEUED_BYTES) {
      this.die("Долго нет связи с сервером — запись остановлена, сохранено то, что успело уйти");
      return;
    }
    void this.pump();
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Дождаться, пока всё уйдёт (или очередь сдастся через timeoutMs). */
  async drain(timeoutMs = DRAIN_MS): Promise<void> {
    this.giveUpAt = this.now() + timeoutMs;
    void this.pump();
    while (!this.dead && (this.queue.length || this.pumping)) await this.wait(200);
  }

  private die(message: string) {
    if (this.dead) return;
    this.dead = true;
    this.queue = [];
    this.queuedBytes = 0;
    this.onDead(message);
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length && !this.dead) {
        const chunk = this.queue[0];
        for (let attempt = 0; ; attempt++) {
          try {
            await this.send(chunk.kind, chunk.seq, chunk.data);
            break;
          } catch (err) {
            const reason = refusal(err);
            if (reason) return this.die(reason);
            if (this.giveUpAt !== null && this.now() > this.giveUpAt) {
              return this.die("Не удалось дослать конец записи — сохранено то, что успело уйти");
            }
            await this.wait(Math.min(15_000, 1000 * 2 ** attempt));
          }
        }
        this.queue.shift();
        this.queuedBytes -= chunk.data.size;
      }
    } finally {
      this.pumping = false;
    }
  }
}

/** Тики для рисования: воркер (не замедляется в фоне), без него — обычный таймер. */
function startTicks(periodMs: number, tick: () => void): () => void {
  try {
    const worker = new Worker(new URL("./recordingTick.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = tick;
    worker.postMessage(periodMs);
    return () => worker.terminate();
  } catch {
    const timer = setInterval(tick, periodMs);
    return () => clearInterval(timer);
  }
}

export interface MeetingRecorderOptions {
  starId: string;
  channelId: string;
  roomName: string;
  /** Запись кончилась сама: сервер её остановил, нет места, нет связи. */
  onEnded: (message: string) => void;
}

/** Идущая запись: stop() дописывает хвост и просит сервер собрать файлы. */
export class MeetingRecorder {
  readonly id: string;
  readonly startedAt = Date.now();
  private stopping: Promise<void> | null = null;
  private torn = false;

  private constructor(
    private opts: MeetingRecorderOptions,
    id: string,
    private uploader: ChunkUploader,
    private recorders: MediaRecorder[],
    private teardownMedia: () => void
  ) {
    this.id = id;
  }

  static async start(opts: MeetingRecorderOptions): Promise<MeetingRecorder> {
    const videoType = chooseType(VIDEO_TYPES, supported);
    const audioType = chooseType(AUDIO_TYPES, supported);
    if (!videoType || !audioType || !canRecordMeetings()) {
      throw new Error("Этот браузер не умеет записывать встречи — откройте Quazar в Chrome, Edge или приложении для ПК");
    }
    // Звук сводим сразу, по нажатию: иначе браузер может не дать включить AudioContext.
    const media = buildMedia(opts.roomName);
    let id: string;
    try {
      ({ id } = await starsApi.startRecording(opts.starId, opts.channelId, {
        label: recordingLabel(new Date()),
        video_mime: baseMime(videoType),
        audio_mime: baseMime(audioType),
      }));
    } catch (err) {
      media.teardown();
      throw err;
    }

    let self: MeetingRecorder | null = null;
    const uploader = new ChunkUploader(
      (kind, seq, data) => starsApi.recordingChunk(opts.starId, id, kind, seq, data).then(() => undefined),
      (message) => self?.endedByServer(message)
    );
    try {
      const video = new MediaRecorder(media.videoStream, {
        mimeType: videoType,
        videoBitsPerSecond: 1_000_000,
        audioBitsPerSecond: 96_000,
      });
      const audio = new MediaRecorder(media.audioStream, { mimeType: audioType, audioBitsPerSecond: 48_000 });
      video.ondataavailable = (e) => uploader.push("video", e.data);
      audio.ondataavailable = (e) => uploader.push("audio", e.data);
      video.start(TIMESLICE_MS);
      audio.start(TIMESLICE_MS);
      self = new MeetingRecorder(opts, id, uploader, [video, audio], media.teardown);
      return self;
    } catch (err) {
      media.teardown();
      await starsApi.stopRecording(opts.starId, id).catch(() => {});
      throw err;
    }
  }

  get channelId(): string {
    return this.opts.channelId;
  }

  /** Остановить: последние куски уходят на сервер, потом он собирает файлы. */
  stop(): Promise<void> {
    this.stopping ??= (async () => {
      await Promise.all(this.recorders.map(stopRecorder));
      this.teardown();
      await this.uploader.drain();
      if (!this.uploader.dead) await starsApi.stopRecording(this.opts.starId, this.id).catch(() => {});
    })();
    return this.stopping;
  }

  private endedByServer(message: string) {
    for (const recorder of this.recorders) {
      if (recorder.state !== "inactive") {
        recorder.ondataavailable = null;
        recorder.stop();
      }
    }
    this.teardown();
    if (!this.stopping) this.opts.onEnded(message);
  }

  private teardown() {
    if (this.torn) return;
    this.torn = true;
    this.teardownMedia();
  }
}

/** Остановить MediaRecorder и дождаться последнего куска. */
function stopRecorder(recorder: MediaRecorder): Promise<void> {
  if (recorder.state === "inactive") return Promise.resolve();
  return new Promise((done) => {
    recorder.addEventListener("stop", () => done(), { once: true });
    recorder.stop();
    // Подстраховка: событие не пришло (трек пропал) — не висим.
    setTimeout(done, 3000);
  });
}

/** Звук комнаты, сведённый в одну дорожку, и холст с показом экрана. */
function buildMedia(roomName: string) {
  const ctx = new AudioContext();
  void ctx.resume().catch(() => {});
  const mix = ctx.createMediaStreamDestination();
  const sources = new Map<MediaStreamTrack, MediaStreamAudioSourceNode>();

  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const g = canvas.getContext("2d");
  const videos = new Map<MediaStreamTrack, HTMLVideoElement>();
  const startedAt = Date.now();

  const sync = () => {
    const { audio, screens } = roomMediaForRecording();
    for (const track of audio) {
      if (sources.has(track)) continue;
      try {
        const node = ctx.createMediaStreamSource(new MediaStream([track]));
        node.connect(mix);
        sources.set(track, node);
      } catch {
        // Трек уже закончился — пропускаем.
      }
    }
    for (const [track, node] of sources) {
      if (!audio.includes(track)) {
        node.disconnect();
        sources.delete(track);
      }
    }
    for (const track of screens) {
      if (videos.has(track)) continue;
      const el = document.createElement("video");
      el.muted = true;
      el.playsInline = true;
      el.srcObject = new MediaStream([track]);
      void el.play().catch(() => {});
      videos.set(track, el);
    }
    for (const [track, el] of videos) {
      if (!screens.includes(track)) {
        el.srcObject = null;
        videos.delete(track);
      }
    }
  };

  const draw = () => {
    if (!g) return;
    g.fillStyle = "#0f1117";
    g.fillRect(0, 0, WIDTH, HEIGHT);
    const shown = [...videos.values()].filter((el) => el.videoWidth > 0).slice(0, 2);
    if (shown.length) {
      const slot = WIDTH / shown.length;
      shown.forEach((el, i) => {
        const [x, y, w, h] = fitRect(el.videoWidth, el.videoHeight, i * slot, 0, slot, HEIGHT);
        g.drawImage(el, x, y, w, h);
      });
      return;
    }
    // Никто не показывает экран: заставка, чтобы видео шло и время было видно.
    g.textAlign = "center";
    g.fillStyle = "#6c63ff";
    g.font = "600 44px system-ui, sans-serif";
    g.fillText(`Quazar · ${roomName}`, WIDTH / 2, HEIGHT / 2 - 20);
    g.fillStyle = "#8b8fa3";
    g.font = "28px system-ui, sans-serif";
    g.fillText("Экран сейчас не показывают", WIDTH / 2, HEIGHT / 2 + 30);
    const sec = Math.floor((Date.now() - startedAt) / 1000);
    const two = (n: number) => String(n).padStart(2, "0");
    g.fillText(`${Math.floor(sec / 3600)}:${two(Math.floor(sec / 60) % 60)}:${two(sec % 60)}`, WIDTH / 2, HEIGHT / 2 + 80);
  };

  sync();
  draw();
  let ticks = 0;
  const syncEvery = Math.round(SYNC_EVERY_MS / (1000 / FPS));
  const stopTicks = startTicks(Math.round(1000 / FPS), () => {
    if (++ticks % syncEvery === 0) sync();
    draw();
  });

  const canvasStream = canvas.captureStream(FPS);
  const mixTrack = mix.stream.getAudioTracks()[0];
  const videoStream = new MediaStream([...canvasStream.getVideoTracks(), mixTrack]);
  const audioStream = new MediaStream([mixTrack]);

  return {
    videoStream,
    audioStream,
    teardown: () => {
      stopTicks();
      for (const node of sources.values()) node.disconnect();
      sources.clear();
      for (const el of videos.values()) el.srcObject = null;
      videos.clear();
      for (const track of canvasStream.getTracks()) track.stop();
      void ctx.close().catch(() => {});
    },
  };
}
