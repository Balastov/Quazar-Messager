/**
 * Нейросетевое шумоподавление микрофона (RNNoise) для звонков.
 *
 * Микрофон → AudioWorklet с RNNoise (WASM) → MediaStreamDestination → RTCPeerConnection.
 * Убирает клавиатуру, вентиляторы, улицу и бытовые звуки — то, что встроенный
 * noiseSuppression браузера не берёт. Если что-то не поддерживается, create() вернёт null
 * и звонок пойдёт со встроенной обработкой браузера.
 */
import workletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import wasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import simdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";

const PREF_KEY = "quazar_noise_suppression";
/** RNNoise работает только на 48 кГц. */
const SAMPLE_RATE = 48_000;
const RESUME_TIMEOUT_MS = 1500;

export function getNoiseSuppressionPref(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setNoiseSuppressionPref(enabled: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, enabled ? "1" : "0");
  } catch {
    // ignore
  }
}

export function isNoiseSuppressionSupported(): boolean {
  return (
    typeof AudioContext !== "undefined" &&
    typeof AudioWorkletNode !== "undefined" &&
    typeof WebAssembly !== "undefined"
  );
}

/** Встроенное шумоподавление браузера: выключаем, пока работает RNNoise, чтобы не обрабатывать дважды. */
export async function setBrowserNoiseSuppression(
  track: MediaStreamTrack,
  enabled: boolean
): Promise<void> {
  try {
    await track.applyConstraints({
      echoCancellation: true,
      autoGainControl: true,
      noiseSuppression: enabled,
    });
  } catch {
    // Не все браузеры меняют обработку на лету — не критично.
  }
}

let libPromise: Promise<typeof import("@sapphi-red/web-noise-suppressor")> | null = null;
let wasmPromise: Promise<ArrayBuffer> | null = null;

function loadLib() {
  libPromise ??= import("@sapphi-red/web-noise-suppressor").catch((err) => {
    libPromise = null;
    throw err;
  });
  return libPromise;
}

/** Загрузка модели (~150 КБ); можно начать заранее, параллельно с запросом микрофона. */
export function preloadNoiseSuppression(): Promise<ArrayBuffer> {
  wasmPromise ??= loadLib()
    .then((lib) => lib.loadRnnoise({ url: wasmUrl, simdUrl: simdWasmUrl }))
    .catch((err) => {
      wasmPromise = null;
      throw err;
    });
  return wasmPromise;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
  ]);
}

function isRunning(ctx: AudioContext): boolean {
  return ctx.state === "running";
}

export class NoiseSuppressedMic {
  /** Вызывается, если аудиоконтекст остановился и не перезапускается (например, прерывание на iOS). */
  onFailed: (() => void) | null = null;

  private enabled = true;
  private closed = false;

  private constructor(
    private readonly ctx: AudioContext,
    private readonly source: MediaStreamAudioSourceNode,
    private readonly rnnoise: AudioWorkletNode & { destroy(): void },
    private readonly destination: MediaStreamAudioDestinationNode,
    /** Очищенный трек — его отправляем собеседнику. */
    readonly track: MediaStreamTrack
  ) {
    ctx.onstatechange = () => void this.recover();
  }

  static async create(input: MediaStreamTrack): Promise<NoiseSuppressedMic | null> {
    if (!isNoiseSuppressionSupported()) return null;

    let ctx: AudioContext | null = null;
    try {
      const [lib, wasmBinary] = await Promise.all([loadLib(), preloadNoiseSuppression()]);

      ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
      if (ctx.sampleRate !== SAMPLE_RATE) throw new Error(`sample rate ${ctx.sampleRate}`);
      await ctx.audioWorklet.addModule(workletUrl);

      // Без жеста пользователя (например, звонок принят из уведомления) браузер может
      // не запустить аудио — тогда честно откатываемся, а не шлём тишину.
      if (!isRunning(ctx)) await withTimeout(ctx.resume(), RESUME_TIMEOUT_MS);
      if (!isRunning(ctx)) throw new Error(`AudioContext ${ctx.state}`);

      const source = ctx.createMediaStreamSource(new MediaStream([input]));
      const rnnoise = new lib.RnnoiseWorkletNode(ctx, { wasmBinary, maxChannels: 1 });
      // Стерео-микрофоны сводим в моно до RNNoise: голосу в звонке второй канал не нужен.
      rnnoise.channelCount = 1;
      rnnoise.channelCountMode = "explicit";
      rnnoise.channelInterpretation = "speakers";
      const destination = ctx.createMediaStreamDestination();
      destination.channelCount = 1;
      destination.channelCountMode = "explicit";

      source.connect(rnnoise);
      rnnoise.connect(destination);

      const track = destination.stream.getAudioTracks()[0];
      if (!track) throw new Error("no output track");
      return new NoiseSuppressedMic(ctx, source, rnnoise, destination, track);
    } catch (err) {
      console.warn("Noise suppression unavailable, using browser processing", err);
      void ctx?.close().catch(() => {});
      return null;
    }
  }

  /** Вкл/выкл без пересогласования звонка: RNNoise просто обходится в графе. */
  setEnabled(enabled: boolean): void {
    if (this.closed || enabled === this.enabled) return;
    this.enabled = enabled;
    this.source.disconnect();
    if (enabled) {
      this.source.connect(this.rnnoise);
    } else {
      this.source.connect(this.destination);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ctx.onstatechange = null;
    this.track.stop();
    this.source.disconnect();
    this.rnnoise.disconnect();
    this.rnnoise.destroy();
    void this.ctx.close().catch(() => {});
  }

  private async recover(): Promise<void> {
    if (this.closed || isRunning(this.ctx)) return;
    await withTimeout(this.ctx.resume().catch(() => {}), RESUME_TIMEOUT_MS);
    if (!this.closed && !isRunning(this.ctx) && this.ctx.state !== "closed") {
      this.onFailed?.();
    }
  }
}
