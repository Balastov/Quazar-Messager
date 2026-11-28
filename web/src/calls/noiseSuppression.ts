/**
 * Нейросетевое шумоподавление микрофона для звонков и Планет.
 *
 * Микрофон → AudioWorklet с нейросетью (WASM) → порог микрофона → MediaStreamDestination → звонок.
 * Нейросети на выбор (меню у кнопки шумодава, настройки звонков): RNNoise — лёгкая, хорошо
 * убирает ровный фон; GTCRN (по умолчанию) — новее, гораздо лучше справляется с отрывистыми
 * звуками: щелчки клавиатуры без речи у RNNoise ≈ −19 дБ, у GTCRN ≈ −49 дБ. Чуть тяжелее.
 * Порог микрофона (micGateWorklet.js) глушит всё, пока человек молчит.
 * Если что-то не поддерживается, create() вернёт null
 * и звонок пойдёт со встроенной обработкой браузера.
 *
 * RNNoise — это WebAssembly внутри AudioWorklet, поэтому в CSP нужен 'wasm-unsafe-eval'
 * (index.html, vite.config.ts): без него модуль молча не компилируется и выдаёт нули.
 *
 * Если модуль всё же не запустился (бывает в отдельных браузерах), сторож тишины сравнивает
 * уровень до и после RNNoise и при «речь есть, а на выходе тишина» вызывает onFailed:
 * звонок переключается на обычный микрофон, а устройство запоминается как неподходящее.
 */
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import gtcrnWorkletUrl from "@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?url";
import gtcrnWasmUrl from "@sapphi-red/web-noise-suppressor/gtcrn.wasm?url";
import gateWorkletUrl from "./micGateWorklet.js?url";

const PREF_KEY = "quazar_noise_suppression";
const ENGINE_KEY = "quazar_noise_engine";
const GATE_KEY = "quazar_mic_gate";
/**
 * RNNoise на этом устройстве уже выдавал тишину — не пробуем, пока человек сам не включит снова.
 * v2: до исправления CSP отметку получили все устройства — старую не учитываем.
 */
const UNSUPPORTED_KEY = "quazar_noise_suppression_failed_v2";
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

export type NoiseEngine = "rnnoise" | "gtcrn";
export const NOISE_ENGINES: readonly NoiseEngine[] = ["rnnoise", "gtcrn"];

/** По умолчанию GTCRN: заметно лучше убирает клавиатуру и щелчки (замеры — в шапке файла). */
export const DEFAULT_NOISE_ENGINE: NoiseEngine = "gtcrn";

export function getNoiseEnginePref(): NoiseEngine {
  try {
    const value = localStorage.getItem(ENGINE_KEY);
    return value === "rnnoise" || value === "gtcrn" ? value : DEFAULT_NOISE_ENGINE;
  } catch {
    return DEFAULT_NOISE_ENGINE;
  }
}

const engineListeners = new Set<() => void>();

/** Подписка на смену нейросети (меню у кнопки шумодава, настройки). Возвращает отписку. */
export function subscribeNoiseEngine(listener: () => void): () => void {
  engineListeners.add(listener);
  return () => engineListeners.delete(listener);
}

/** GTCRN на этом устройстве выдавал тишину — в разговорах берём RNNoise. */
const ENGINE_FAILED_KEY = "quazar_noise_engine_failed";

export function engineFailedOnThisDevice(engine: NoiseEngine): boolean {
  try {
    return engine !== "rnnoise" && localStorage.getItem(ENGINE_FAILED_KEY) === engine;
  } catch {
    return false;
  }
}

function markEngineFailed(engine: NoiseEngine): void {
  try {
    localStorage.setItem(ENGINE_FAILED_KEY, engine);
  } catch {
    // ignore
  }
}

/** Меняет нейросеть, в том числе у микрофона, который сейчас в разговоре. */
export function setNoiseEnginePref(engine: NoiseEngine): void {
  try {
    localStorage.setItem(ENGINE_KEY, engine);
    // Человек выбрал сам — даём нейросети ещё один шанс.
    localStorage.removeItem(ENGINE_FAILED_KEY);
  } catch {
    // ignore
  }
  for (const mic of liveMics) void mic.setEngine(engine);
  for (const listener of engineListeners) listener();
}

/** Порог микрофона в дБ: ниже — тишина. */
export const GATE_MIN_DB = -70;
export const GATE_MAX_DB = -20;
export const GATE_DEFAULT_DB = -50;

function clampGate(db: number): number {
  return Math.min(GATE_MAX_DB, Math.max(GATE_MIN_DB, Math.round(db)));
}

/** Порог микрофона (дБ) или null — выключен. */
export function getMicGatePref(): number | null {
  try {
    const raw = localStorage.getItem(GATE_KEY);
    if (raw === null || raw === "off") return null;
    const db = Number(raw);
    return Number.isFinite(db) ? clampGate(db) : null;
  } catch {
    return null;
  }
}

/** Последнее значение порога, даже если он сейчас выключен (для ползунка). */
export function getMicGateLevelPref(): number {
  const active = getMicGatePref();
  if (active !== null) return active;
  try {
    const db = Number(localStorage.getItem(GATE_KEY + "_level"));
    return localStorage.getItem(GATE_KEY + "_level") !== null && Number.isFinite(db) ? clampGate(db) : GATE_DEFAULT_DB;
  } catch {
    return GATE_DEFAULT_DB;
  }
}

/** Включает/меняет (число) или выключает (null) порог, в том числе прямо в разговоре. */
export function setMicGatePref(db: number | null): void {
  const value = db === null ? null : clampGate(db);
  try {
    localStorage.setItem(GATE_KEY, value === null ? "off" : String(value));
    if (value !== null) localStorage.setItem(GATE_KEY + "_level", String(value));
  } catch {
    // ignore
  }
  for (const mic of liveMics) mic.setGate(value);
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

type Lib = typeof import("@sapphi-red/web-noise-suppressor");
type EngineNode = AudioWorkletNode & { destroy(): void };

let libPromise: Promise<Lib> | null = null;
const wasmPromises = new Map<NoiseEngine, Promise<ArrayBuffer>>();

function loadLib() {
  libPromise ??= import("@sapphi-red/web-noise-suppressor").catch((err) => {
    libPromise = null;
    throw err;
  });
  return libPromise;
}

const ENGINES: Record<NoiseEngine, {
  worklet: string;
  load: (lib: Lib) => Promise<ArrayBuffer>;
  node: (lib: Lib, ctx: AudioContext, wasmBinary: ArrayBuffer) => EngineNode;
}> = {
  rnnoise: {
    worklet: rnnoiseWorkletUrl,
    load: (lib) => lib.loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl }),
    node: (lib, ctx, wasmBinary) => new lib.RnnoiseWorkletNode(ctx, { wasmBinary, maxChannels: 1 }),
  },
  gtcrn: {
    worklet: gtcrnWorkletUrl,
    load: (lib) => lib.loadGtcrn({ url: gtcrnWasmUrl }),
    node: (lib, ctx, wasmBinary) => new lib.GtcrnWorkletNode(ctx, { wasmBinary, maxChannels: 1 }),
  },
};

/** Загрузка модели (~150–200 КБ); можно начать заранее, параллельно с запросом микрофона. */
export function preloadNoiseSuppression(engine: NoiseEngine = getNoiseEnginePref()): Promise<ArrayBuffer> {
  let promise = wasmPromises.get(engine);
  if (!promise) {
    promise = loadLib()
      .then((lib) => ENGINES[engine].load(lib))
      .catch((err) => {
        wasmPromises.delete(engine);
        throw err;
      });
    wasmPromises.set(engine, promise);
  }
  return promise;
}

/** Узел нейросети в этом AudioContext (модуль AudioWorklet подгружается один раз на контекст). */
async function createEngineNode(ctx: AudioContext, engine: NoiseEngine, loaded: Set<NoiseEngine>): Promise<EngineNode> {
  const [lib, wasmBinary] = await Promise.all([loadLib(), preloadNoiseSuppression(engine)]);
  if (!loaded.has(engine)) {
    await ctx.audioWorklet.addModule(ENGINES[engine].worklet);
    loaded.add(engine);
  }
  const node = ENGINES[engine].node(lib, ctx, wasmBinary);
  // Стерео-микрофоны сводим в моно: голосу в звонке второй канал не нужен.
  node.channelCount = 1;
  node.channelCountMode = "explicit";
  node.channelInterpretation = "speakers";
  return node;
}

/** Микрофоны, которые сейчас в работе: им сразу применяются новые настройки. */
const liveMics = new Set<NoiseSuppressedMic>();

/** Уровень перед порогом (дБ) и пропускает ли порог звук — для настройки ползунка. */
export interface GateMeter {
  levelDb: number;
  open: boolean;
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
   * Шумоподавление перестало работать: выдаёт тишину ("silent") или аудио на устройстве
   * остановилось и не перезапускается ("suspended", например прерывание на iOS).
   */
  onFailed: ((reason: DenoiserFailure) => void) | null = null;
  /** Уровень перед порогом микрофона, ~20 раз в секунду, пока включён setMeter(true). */
  onGateMeter: ((meter: GateMeter) => void) | null = null;
  /** Для диагностики: ошибка внутри AudioWorklet, если браузер её сообщил. */
  processorError: string | null = null;
  watchdog = new SilenceWatchdog();

  private enabled = true;
  private closed = false;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private switching: Promise<void> = Promise.resolve();
  private readonly rawBuffer: Float32Array<ArrayBuffer>;
  private readonly outBuffer: Float32Array<ArrayBuffer>;

  private constructor(
    private readonly ctx: AudioContext,
    private readonly source: MediaStreamAudioSourceNode,
    /** Уровень до нейросети (стоит в цепочке, поэтому браузер его точно обрабатывает). */
    private readonly rawProbe: AnalyserNode,
    private denoiser: EngineNode,
    private engineName: NoiseEngine,
    private readonly loadedEngines: Set<NoiseEngine>,
    /** Уровень после нейросети (до порога: сторож тишины следит за самой нейросетью). */
    private readonly outProbe: AnalyserNode,
    private readonly gate: AudioWorkletNode,
    private readonly destination: MediaStreamAudioDestinationNode,
    /** Очищенный трек — его отправляем собеседнику. */
    readonly track: MediaStreamTrack,
    followSettings: boolean
  ) {
    this.rawBuffer = new Float32Array(rawProbe.fftSize);
    this.outBuffer = new Float32Array(outProbe.fftSize);
    ctx.onstatechange = () => void this.recover();
    this.watchErrors(denoiser);
    gate.port.onmessage = (event: MessageEvent<GateMeter>) => this.onGateMeter?.(event.data);
    this.startWatching();
    if (followSettings) liveMics.add(this);
  }

  /**
   * force — запустить даже там, где шумоподавление раньше отказало (для проверки микрофона).
   * engine/gateDb — по умолчанию из настроек; followSettings: false — не менять их вслед
   * за настройками (сравнение нейросетей на записи).
   */
  static async create(
    input: MediaStreamTrack,
    {
      force = false,
      engine = getNoiseEnginePref(),
      gateDb = getMicGatePref(),
      followSettings = true,
    }: { force?: boolean; engine?: NoiseEngine; gateDb?: number | null; followSettings?: boolean } = {}
  ): Promise<NoiseSuppressedMic | null> {
    if (!(force ? canRunNoiseSuppression() : isNoiseSuppressionSupported())) return null;
    if (!force && engineFailedOnThisDevice(engine)) engine = "rnnoise";

    let ctx: AudioContext | null = null;
    try {
      ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
      if (ctx.sampleRate !== SAMPLE_RATE) throw new Error(`sample rate ${ctx.sampleRate}`);
      const loaded = new Set<NoiseEngine>();
      let denoiser: EngineNode;
      try {
        denoiser = await createEngineNode(ctx, engine, loaded);
      } catch (err) {
        if (engine === "rnnoise") throw err;
        // Выбранная нейросеть не загрузилась — пробуем основную.
        console.warn(`Noise engine ${engine} unavailable, falling back to RNNoise`, err);
        engine = "rnnoise";
        denoiser = await createEngineNode(ctx, engine, loaded);
      }
      await ctx.audioWorklet.addModule(gateWorkletUrl);

      // Без жеста пользователя (например, звонок принят из уведомления) браузер может
      // не запустить аудио — тогда честно откатываемся, а не шлём тишину.
      if (!isRunning(ctx)) await withTimeout(ctx.resume(), RESUME_TIMEOUT_MS);
      if (!isRunning(ctx)) throw new Error(`AudioContext ${ctx.state}`);

      const source = ctx.createMediaStreamSource(new MediaStream([input]));
      const rawProbe = ctx.createAnalyser();
      const outProbe = ctx.createAnalyser();
      const gate = new AudioWorkletNode(ctx, "quazar-mic-gate", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: "explicit",
        processorOptions: { thresholdDb: gateDb },
      });
      const destination = ctx.createMediaStreamDestination();
      destination.channelCount = 1;
      destination.channelCountMode = "explicit";

      // микрофон → проба → нейросеть → проба → порог → трек для собеседника
      source.connect(rawProbe);
      rawProbe.connect(denoiser);
      denoiser.connect(outProbe);
      outProbe.connect(gate);
      gate.connect(destination);

      const track = destination.stream.getAudioTracks()[0];
      if (!track) throw new Error("no output track");
      return new NoiseSuppressedMic(ctx, source, rawProbe, denoiser, engine, loaded, outProbe, gate, destination, track, followSettings);
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

  /** Нейросеть, которая работает сейчас. */
  get engine(): NoiseEngine {
    return this.engineName;
  }

  /** Пиковые уровни до и после нейросети (0…1). */
  levels(): { input: number; output: number } {
    if (this.closed) return { input: 0, output: 0 };
    return { input: peak(this.rawProbe, this.rawBuffer), output: peak(this.outProbe, this.outBuffer) };
  }

  /** Вкл/выкл без пересогласования звонка: нейросеть и порог просто обходятся в графе. */
  setEnabled(enabled: boolean): void {
    if (this.closed || enabled === this.enabled) return;
    this.enabled = enabled;
    this.rawProbe.disconnect();
    this.rawProbe.connect(enabled ? this.denoiser : this.destination);
  }

  /** Порог микрофона (дБ) или null — выключить. Применяется сразу. */
  setGate(thresholdDb: number | null): void {
    if (this.closed) return;
    this.gate.port.postMessage({ thresholdDb });
  }

  /** Присылать ли уровень перед порогом (onGateMeter) — для настройки ползунка. */
  setMeter(on: boolean): void {
    if (this.closed) return;
    this.gate.port.postMessage({ meter: on });
  }

  /** Меняет нейросеть на лету: тот же трек, звонок не пересогласуется. */
  setEngine(engine: NoiseEngine): Promise<void> {
    this.switching = this.switching.then(() => this.swapEngine(engine)).catch((err) => {
      console.warn(`Noise engine ${engine} unavailable, keeping ${this.engineName}`, err);
    });
    return this.switching;
  }

  private async swapEngine(engine: NoiseEngine): Promise<void> {
    if (this.closed || engine === this.engineName) return;
    const next = await createEngineNode(this.ctx, engine, this.loadedEngines);
    if (this.closed) {
      next.destroy();
      return;
    }
    const old = this.denoiser;
    next.connect(this.outProbe);
    if (this.enabled) {
      this.rawProbe.disconnect();
      this.rawProbe.connect(next);
    }
    old.disconnect();
    old.destroy();
    this.denoiser = next;
    this.engineName = engine;
    this.watchErrors(next);
    // Новая модель — заново убеждаемся, что она не выдаёт тишину.
    this.watchdog = new SilenceWatchdog();
    this.startWatching();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    liveMics.delete(this);
    this.stopWatching();
    this.ctx.onstatechange = null;
    this.onGateMeter = null;
    this.track.stop();
    this.source.disconnect();
    this.rawProbe.disconnect();
    this.denoiser.disconnect();
    this.outProbe.disconnect();
    this.gate.disconnect();
    this.gate.port.onmessage = null;
    this.denoiser.destroy();
    void this.ctx.close().catch(() => {});
  }

  private watchErrors(node: EngineNode): void {
    node.onprocessorerror = (event) => {
      this.processorError = (event as ErrorEvent).message || "processorerror";
    };
  }

  private startWatching(): void {
    this.stopWatching();
    this.watchTimer = setInterval(() => this.watch(), WATCH_INTERVAL_MS);
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
    if (state !== "failed") return;
    console.warn(`${this.engineName} outputs silence on this device`, {
      processorError: this.processorError,
      sampleRate: this.ctx.sampleRate,
    });
    if (this.engineName !== "rnnoise") {
      // Дополнительная нейросеть не заработала — переходим на основную, микрофон остаётся.
      markEngineFailed(this.engineName);
      void this.setEngine("rnnoise");
      return;
    }
    markUnsupportedHere();
    this.onFailed?.("silent");
  }

  private async recover(): Promise<void> {
    if (this.closed || isRunning(this.ctx)) return;
    await withTimeout(this.ctx.resume().catch(() => {}), RESUME_TIMEOUT_MS);
    if (!this.closed && !isRunning(this.ctx) && this.ctx.state !== "closed") {
      this.onFailed?.("suspended");
    }
  }
}
