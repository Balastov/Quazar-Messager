/**
 * Нейросетевое шумоподавление микрофона (RNNoise) для звонков.
 *
 * Микрофон → AudioWorklet с RNNoise (WASM) → MediaStreamDestination → RTCPeerConnection.
 * Убирает клавиатуру, вентиляторы, улицу и бытовые звуки — то, что встроенный
 * noiseSuppression браузера не берёт. Если что-то не поддерживается, create() вернёт null
 * и звонок пойдёт со встроенной обработкой браузера.
 *
 * В некоторых браузерах (замечено в Safari и Яндекс Браузере) модуль RNNoise внутри
 * AudioWorklet может молча не запуститься и выдавать нули. Поэтому сторож тишины сравнивает
 * уровень до и после RNNoise и при «речь есть, а на выходе тишина» вызывает onFailed:
 * звонок переключается на обычный микрофон, а устройство запоминается как неподходящее.
 */
import workletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import wasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import simdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";

const PREF_KEY = "quazar_noise_suppression";
/** RNNoise на этом устройстве уже выдавал тишину — не пробуем, пока человек сам не включит снова. */
const UNSUPPORTED_KEY = "quazar_noise_suppression_failed";
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
    // Человек сам включил шумоподавление — даём RNNoise ещё один шанс.
    if (enabled) localStorage.removeItem(UNSUPPORTED_KEY);
  } catch {
    // ignore
  }
}

export function clearFailedOnThisDevice(): void {
  try {
    localStorage.removeItem(UNSUPPORTED_KEY);
  } catch {
    // ignore
  }
}

function markUnsupportedHere(): void {
  try {
    localStorage.setItem(UNSUPPORTED_KEY, "1");
  } catch {
    // ignore
  }
}

export function failedOnThisDevice(): boolean {
  try {
    return localStorage.getItem(UNSUPPORTED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Технически возможно в этом браузере (без учёта прошлых неудач). */
export function canRunNoiseSuppression(): boolean {
  return (
    typeof AudioContext !== "undefined" &&
    typeof AudioWorkletNode !== "undefined" &&
    typeof WebAssembly !== "undefined"
  );
}

export function isNoiseSuppressionSupported(): boolean {
  return canRunNoiseSuppression() && !failedOnThisDevice();
}

/**
 * Решает, работает ли RNNoise, по пикам уровня до и после него.
 * «Работает» — как только на выходе появился звук. «Не работает» — если набралось
 * FAIL_AFTER_MS речи на входе, а на выходе всё это время цифровая тишина.
 * Тишина на входе (человек молчит) решения не приближает.
 */
export class SilenceWatchdog {
  static readonly INPUT_ACTIVE = 0.003;
  static readonly OUTPUT_ALIVE = 0.0001;
  static readonly FAIL_AFTER_MS = 3000;

  private activeMs = 0;
  state: "checking" | "working" | "failed" = "checking";

  feed(inputPeak: number, outputPeak: number, dtMs: number): SilenceWatchdog["state"] {
    if (this.state !== "checking") return this.state;
    if (outputPeak > SilenceWatchdog.OUTPUT_ALIVE) {
      this.state = "working";
    } else if (inputPeak > SilenceWatchdog.INPUT_ACTIVE) {
      this.activeMs += dtMs;
      if (this.activeMs >= SilenceWatchdog.FAIL_AFTER_MS) this.state = "failed";
    }
    return this.state;
  }
}

function peak(analyser: AnalyserNode, buffer: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buffer);
  let max = 0;
  for (let i = 0; i < buffer.length; i++) {
    const v = Math.abs(buffer[i]);
    if (v > max) max = v;
  }
  return max;
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

export type DenoiserFailure = "silent" | "suspended";

const WATCH_INTERVAL_MS = 200;

export class NoiseSuppressedMic {
  /**
   * RNNoise перестал работать: выдаёт тишину ("silent") или аудио на устройстве
   * остановилось и не перезапускается ("suspended", например прерывание на iOS).
   */
  onFailed: ((reason: DenoiserFailure) => void) | null = null;
  /** Для диагностики: ошибка внутри AudioWorklet, если браузер её сообщил. */
  processorError: string | null = null;
  readonly watchdog = new SilenceWatchdog();

  private enabled = true;
  private closed = false;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private readonly rawBuffer: Float32Array<ArrayBuffer>;
  private readonly outBuffer: Float32Array<ArrayBuffer>;

  private constructor(
    private readonly ctx: AudioContext,
    private readonly source: MediaStreamAudioSourceNode,
    /** Уровень до RNNoise (стоит в цепочке, поэтому браузер его точно обрабатывает). */
    private readonly rawProbe: AnalyserNode,
    private readonly rnnoise: AudioWorkletNode & { destroy(): void },
    /** Уровень после RNNoise. */
    private readonly outProbe: AnalyserNode,
    private readonly destination: MediaStreamAudioDestinationNode,
    /** Очищенный трек — его отправляем собеседнику. */
    readonly track: MediaStreamTrack
  ) {
    this.rawBuffer = new Float32Array(rawProbe.fftSize);
    this.outBuffer = new Float32Array(outProbe.fftSize);
    ctx.onstatechange = () => void this.recover();
    rnnoise.onprocessorerror = (event) => {
      this.processorError = (event as ErrorEvent).message || "processorerror";
    };
    this.watchTimer = setInterval(() => this.watch(), WATCH_INTERVAL_MS);
  }

  /** force — запустить даже там, где RNNoise раньше отказал (для проверки микрофона). */
  static async create(
    input: MediaStreamTrack,
    { force = false }: { force?: boolean } = {}
  ): Promise<NoiseSuppressedMic | null> {
    if (!(force ? canRunNoiseSuppression() : isNoiseSuppressionSupported())) return null;

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
      const rawProbe = ctx.createAnalyser();
      const rnnoise = new lib.RnnoiseWorkletNode(ctx, { wasmBinary, maxChannels: 1 });
      // Стерео-микрофоны сводим в моно до RNNoise: голосу в звонке второй канал не нужен.
      rnnoise.channelCount = 1;
      rnnoise.channelCountMode = "explicit";
      rnnoise.channelInterpretation = "speakers";
      const outProbe = ctx.createAnalyser();
      const destination = ctx.createMediaStreamDestination();
      destination.channelCount = 1;
      destination.channelCountMode = "explicit";

      // микрофон → проба → RNNoise → проба → трек для собеседника
      source.connect(rawProbe);
      rawProbe.connect(rnnoise);
      rnnoise.connect(outProbe);
      outProbe.connect(destination);

      const track = destination.stream.getAudioTracks()[0];
      if (!track) throw new Error("no output track");
      return new NoiseSuppressedMic(ctx, source, rawProbe, rnnoise, outProbe, destination, track);
    } catch (err) {
      console.warn("Noise suppression unavailable, using browser processing", err);
      void ctx?.close().catch(() => {});
      return null;
    }
  }

  /** Для диагностики. */
  get sampleRate(): number {
    return this.ctx.sampleRate;
  }

  get contextState(): AudioContextState {
    return this.ctx.state;
  }

  /** Пиковые уровни до и после RNNoise (0…1). */
  levels(): { input: number; output: number } {
    if (this.closed) return { input: 0, output: 0 };
    return { input: peak(this.rawProbe, this.rawBuffer), output: peak(this.outProbe, this.outBuffer) };
  }

  /** Вкл/выкл без пересогласования звонка: RNNoise просто обходится в графе. */
  setEnabled(enabled: boolean): void {
    if (this.closed || enabled === this.enabled) return;
    this.enabled = enabled;
    this.rawProbe.disconnect();
    if (enabled) {
      this.rawProbe.connect(this.rnnoise);
    } else {
      this.rawProbe.connect(this.destination);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopWatching();
    this.ctx.onstatechange = null;
    this.track.stop();
    this.source.disconnect();
    this.rawProbe.disconnect();
    this.rnnoise.disconnect();
    this.outProbe.disconnect();
    this.rnnoise.destroy();
    void this.ctx.close().catch(() => {});
  }

  private stopWatching(): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
  }

  private watch(): void {
    if (this.closed) return this.stopWatching();
    if (!this.enabled || !isRunning(this.ctx)) return;
    const { input, output } = this.levels();
    const state = this.watchdog.feed(input, output, WATCH_INTERVAL_MS);
    if (state === "checking") return;
    this.stopWatching();
    if (state === "failed") {
      console.warn("RNNoise outputs silence on this device; falling back to the plain microphone", {
        processorError: this.processorError,
        sampleRate: this.ctx.sampleRate,
      });
      markUnsupportedHere();
      this.onFailed?.("silent");
    }
  }

  private async recover(): Promise<void> {
    if (this.closed || isRunning(this.ctx)) return;
    await withTimeout(this.ctx.resume().catch(() => {}), RESUME_TIMEOUT_MS);
    if (!this.closed && !isRunning(this.ctx) && this.ctx.state !== "closed") {
      this.onFailed?.("suspended");
    }
  }
}
