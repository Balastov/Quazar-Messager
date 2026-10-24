/**
 * Громкость каждого собеседника на Планетах: «этот слишком тихий — погромче, тот — потише».
 *
 * Настройка своя для каждого человека (по userId), запоминается на устройстве и действует
 * на всех Планетах. 1 = как есть, 0…2 = 0…200 %.
 *
 * Тише 100 % — просто громкость элемента <audio>: звук идёт прежним путём WebRTC.
 * Громче 100 % (и на iPhone, где громкость элемента не меняется) — через WebAudio:
 * усиление → мягкий ограничитель, чтобы громкий голос не хрипел, → отдельный <audio>, которому
 * можно выбрать динамик так же, как обычному.
 */
import { applyOutput, isIos } from "./devices";

const KEY = "quazar_peer_volumes";
export const MIN_PEER_VOLUME = 0;
export const MAX_PEER_VOLUME = 2;

export type PeerVolumes = Record<string, number>;

export function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(MAX_PEER_VOLUME, Math.max(MIN_PEER_VOLUME, v));
}

export function loadPeerVolumes(): PeerVolumes {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    if (!raw || typeof raw !== "object") return {};
    const out: PeerVolumes = {};
    for (const [id, v] of Object.entries(raw)) {
      if (typeof v === "number" && v !== 1) out[id] = clampVolume(v);
    }
    return out;
  } catch {
    return {};
  }
}

/** 100 % не храним — это и так по умолчанию. */
export function savePeerVolumes(volumes: PeerVolumes): void {
  try {
    const kept = Object.fromEntries(Object.entries(volumes).filter(([, v]) => v !== 1));
    if (Object.keys(kept).length) localStorage.setItem(KEY, JSON.stringify(kept));
    else localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

/** Нужен ли путь через WebAudio для такой громкости. */
export function needsAmplifier(volume: number): boolean {
  return volume > 1 || (volume !== 1 && isIos());
}

let context: AudioContext | null = null;

/** До этого уровня звук не трогаем, выше — плавно прижимаем к 1, а не обрезаем. */
const KNEE = 0.8;

/**
 * Кривая ограничителя. WaveShaper принимает только −1…1, поэтому усиление делим на
 * MAX_PEER_VOLUME, а кривая растягивает это обратно на −MAX…MAX.
 * (DynamicsCompressor не подошёл: сам добавляет ~14 % громкости.)
 */
let limiterCurve: Float32Array<ArrayBuffer> | null = null;
function softLimit(): Float32Array<ArrayBuffer> {
  if (limiterCurve) return limiterCurve;
  const n = 4096;
  limiterCurve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * MAX_PEER_VOLUME;
    const a = Math.abs(x);
    const y = a <= KNEE ? a : KNEE + (1 - KNEE) * Math.tanh((a - KNEE) / (1 - KNEE));
    limiterCurve[i] = Math.sign(x) * y;
  }
  return limiterCurve;
}

function audioContext(): AudioContext {
  context ??= new AudioContext({ latencyHint: "interactive" });
  if (context.state !== "running") void context.resume().catch(() => {});
  return context;
}

/** Браузер не дал запустить звук без нажатия — запускаем по кнопке. */
export async function resumeAmplifiers(): Promise<void> {
  if (context && context.state !== "running") await context.resume().catch(() => {});
}

/** Вышли с Планеты — WebAudio больше не нужен. */
export function closeAmplifiers(): void {
  void context?.close().catch(() => {});
  context = null;
}

/** Звук одного трека собеседника через усилитель. Исходный <audio> при этом молчит. */
export class Amplifier {
  readonly output: HTMLAudioElement;
  private readonly source: MediaStreamAudioSourceNode;
  private readonly gain: GainNode;
  private readonly limiter: WaveShaperNode;

  constructor(track: MediaStreamTrack, parent: HTMLElement) {
    const ctx = audioContext();
    this.source = ctx.createMediaStreamSource(new MediaStream([track]));
    this.gain = ctx.createGain();
    this.limiter = ctx.createWaveShaper();
    this.limiter.curve = softLimit();
    this.limiter.oversample = "2x";
    const dest = ctx.createMediaStreamDestination();
    this.source.connect(this.gain).connect(this.limiter).connect(dest);

    this.output = document.createElement("audio");
    this.output.autoplay = true;
    this.output.srcObject = dest.stream;
    parent.appendChild(this.output);
    void applyOutput(this.output);
  }

  setVolume(volume: number): void {
    const ctx = this.gain.context;
    this.gain.gain.setTargetAtTime(volume / MAX_PEER_VOLUME, ctx.currentTime, 0.03);
  }

  /** false — браузер не дал играть без нажатия. */
  async play(): Promise<boolean> {
    await resumeAmplifiers();
    try {
      await this.output.play();
      return context?.state === "running";
    } catch {
      return false;
    }
  }

  close(): void {
    this.source.disconnect();
    this.gain.disconnect();
    this.limiter.disconnect();
    this.output.srcObject = null;
    this.output.remove();
  }
}
