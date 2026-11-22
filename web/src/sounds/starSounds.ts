/**
 * Звуки Созвездия — один мягкий набор для всех Звёзд (игровых и рабочих).
 * Синтез через Web Audio API, без аудиофайлов.
 *
 * «Орбита»: вход — две стеклянные ноты вверх с эхом, выход — те же ноты вниз; кто-то вошёл или
 * вышел — то же, но выше, короче, тише и с более коротким эхом; стук — «деревянная дверь»,
 * тук-тук-тук; приглашение — «орбита-фанфара»; запись — «красный пинг» вверх и вниз.
 */
import { getCtx } from "../notifications/sound";
import { useUiStore } from "../store/ui";
import { isDoNotDisturb } from "../store/presence";

export type StarSoundEvent =
  /** Я вошёл на Планету / в Комнату. */
  | "enter"
  /** Я вышел. */
  | "leave"
  /** Кто-то зашёл, пока я внутри. */
  | "peerJoin"
  /** Кто-то вышел. */
  | "peerLeave"
  /** Стучатся (просят впустить) — слышат те, кто впускает. */
  | "knock"
  /** Меня зовут: в Звезду или на Планету / в Комнату. */
  | "invite"
  /** В комнате включили запись встречи. */
  | "recordOn"
  /** Запись встречи в комнате закончилась. */
  | "recordOff";

type Synth = (ctx: BaseAudioContext, out: AudioNode, t: number) => void;

// --- Кирпичики ---------------------------------------------------------------------------

let noiseBuffer: AudioBuffer | null = null;

function noise(ctx: BaseAudioContext): AudioBufferSourceNode {
  if (!noiseBuffer || noiseBuffer.sampleRate !== ctx.sampleRate) {
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  return src;
}

/** Огибающая: быстрая атака, экспоненциальный спад. */
function env(param: AudioParam, t: number, peak: number, attack: number, decay: number) {
  param.setValueAtTime(0.0001, t);
  param.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
  param.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

function tone(
  ctx: BaseAudioContext,
  out: AudioNode,
  t: number,
  opts: { type?: OscillatorType; freq: number; to?: number; glide?: number; peak: number; attack?: number; decay: number }
) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = opts.type ?? "sine";
  osc.frequency.setValueAtTime(opts.freq, t);
  if (opts.to) osc.frequency.exponentialRampToValueAtTime(opts.to, t + (opts.glide ?? opts.decay));
  env(gain.gain, t, opts.peak, opts.attack ?? 0.01, opts.decay);
  osc.connect(gain).connect(out);
  osc.start(t);
  osc.stop(t + (opts.attack ?? 0.01) + opts.decay + 0.05);
}

/** Шум через фильтр: шаги, стук, «ветер» варпа. */
function burst(
  ctx: BaseAudioContext,
  out: AudioNode,
  t: number,
  opts: { type: BiquadFilterType; freq: number; to?: number; q?: number; peak: number; attack?: number; decay: number }
) {
  const src = noise(ctx);
  const filter = ctx.createBiquadFilter();
  const gain = ctx.createGain();
  filter.type = opts.type;
  filter.frequency.setValueAtTime(opts.freq, t);
  if (opts.to) filter.frequency.exponentialRampToValueAtTime(opts.to, t + (opts.attack ?? 0.005) + opts.decay);
  filter.Q.value = opts.q ?? 0.8;
  env(gain.gain, t, opts.peak, opts.attack ?? 0.005, opts.decay);
  src.connect(filter).connect(gain).connect(out);
  src.start(t, Math.random());
  src.stop(t + (opts.attack ?? 0.005) + opts.decay + 0.05);
}

// --- Общий набор: мягкие современные звуки -------------------------------------------

/** Мягкая нота: синус с тихим вторым обертоном и плавной атакой — «стеклянная капля». */
function softNote(ctx: BaseAudioContext, out: AudioNode, t: number, freq: number, peak: number, decay: number) {
  tone(ctx, out, t, { freq, peak, attack: 0.014, decay });
  tone(ctx, out, t, { freq: freq * 2, peak: peak * 0.16, attack: 0.012, decay: decay * 0.55 });
}

/** Эхо «большой комнаты»: задержка с затуханием и приглушёнными верхами. Петлю задержки разбираем,
 * когда эхо стихло (сама она не исчезнет). */
function orbitEcho(ctx: BaseAudioContext, out: AudioNode, time: number, feedback: number, cutoff = 2200): AudioNode {
  const input = ctx.createGain();
  const delay = ctx.createDelay(1);
  const fb = ctx.createGain();
  const damp = ctx.createBiquadFilter();
  delay.delayTime.value = time;
  fb.gain.value = feedback;
  damp.type = "lowpass";
  damp.frequency.value = cutoff;
  input.connect(out);
  input.connect(delay);
  delay.connect(damp).connect(fb).connect(delay);
  fb.connect(out);
  setTimeout(() => {
    input.disconnect();
    fb.disconnect();
  }, 3000);
  return input;
}

/** Я вошёл: две ноты вверх (A4, E5) с эхом. */
const softEnter: Synth = (ctx, out, t) => {
  const fx = orbitEcho(ctx, out, 0.2, 0.28);
  softNote(ctx, fx, t, 440, 0.22, 0.16);
  softNote(ctx, fx, t + 0.13, 659.25, 0.26, 0.45);
};

/** Я вышел: те же ноты вниз, последняя без обертона — глуше. */
const softLeave: Synth = (ctx, out, t) => {
  const fx = orbitEcho(ctx, out, 0.2, 0.28);
  softNote(ctx, fx, t, 659.25, 0.22, 0.16);
  tone(ctx, fx, t + 0.13, { freq: 440, peak: 0.28, attack: 0.014, decay: 0.45 });
};

/** Кто-то вошёл: две короткие ноты вверх (D5, A5), эхо короче и тише. */
const peerIn: Synth = (ctx, out, t) => {
  const fx = orbitEcho(ctx, out, 0.16, 0.22);
  softNote(ctx, fx, t, 587.33, 0.13, 0.1);
  softNote(ctx, fx, t + 0.09, 880, 0.14, 0.2);
};

/** Кто-то вышел: те же ноты вниз. */
const peerOut: Synth = (ctx, out, t) => {
  const fx = orbitEcho(ctx, out, 0.16, 0.22);
  softNote(ctx, fx, t, 880, 0.13, 0.1);
  softNote(ctx, fx, t + 0.09, 587.33, 0.14, 0.2);
};

/** Удар костяшками в деревянную дверь: низкий глухой тон, обертон и шум удара. */
function knockWood(ctx: BaseAudioContext, out: AudioNode, t: number, peak: number) {
  tone(ctx, out, t, { freq: 210, to: 168, glide: 0.05, peak, attack: 0.002, decay: 0.09 });
  tone(ctx, out, t, { freq: 567, peak: peak * 0.25, attack: 0.001, decay: 0.03 });
  burst(ctx, out, t, { type: "bandpass", freq: 900, q: 1.2, peak: peak * 0.7, attack: 0.001, decay: 0.02 });
}

/** Стук: «деревянная дверь» — три глухих удара, последний чуть сильнее. */
const softKnock: Synth = (ctx, out, t) => {
  knockWood(ctx, out, t, 0.145);
  knockWood(ctx, out, t + 0.17, 0.145);
  knockWood(ctx, out, t + 0.34, 0.165);
};

/** Приглашение (в Звезду, на Планету, в Комнату): «орбита-фанфара» — до-ми-соль-до стеклом с эхом. */
const stationChime: Synth = (ctx, out, t) => {
  const fx = orbitEcho(ctx, out, 0.2, 0.3);
  [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => softNote(ctx, fx, t + i * 0.12, freq, 0.2, i === 3 ? 0.6 : 0.16));
};

/** Включили запись: «красный пинг» — два пинга вверх (A5 → D6) с эхом, родственник «сонара». */
const recordBeeps: Synth = (ctx, out, t) => {
  const fx = orbitEcho(ctx, out, 0.28, 0.35, 1800);
  softNote(ctx, fx, t, 880, 0.14, 0.12);
  softNote(ctx, fx, t + 0.18, 1174.66, 0.15, 0.16);
};

/** Запись остановлена: те же пинги вниз (D6 → A5). */
const recordEndBeeps: Synth = (ctx, out, t) => {
  const fx = orbitEcho(ctx, out, 0.28, 0.35, 1800);
  softNote(ctx, fx, t, 1174.66, 0.16, 0.12);
  softNote(ctx, fx, t + 0.18, 880, 0.17, 0.16);
};

const SOUNDS: Record<StarSoundEvent, Synth> = {
  enter: softEnter,
  leave: softLeave,
  peerJoin: peerIn,
  peerLeave: peerOut,
  knock: softKnock,
  invite: stationChime,
  recordOn: recordBeeps,
  recordOff: recordEndBeeps,
};

/** Сыграть звук события; force — для кнопок «Прослушать» в настройках. */
export async function playStarSound(event: StarSoundEvent, { force = false }: { force?: boolean } = {}): Promise<void> {
  if (!force && !useUiStore.getState().starSounds) return;
  // «Не беспокоить»: не стучим и не зовём звуком (свои вход/выход — тоже тихо).
  if (!force && isDoNotDisturb()) return;
  const ctx = getCtx();
  if (!ctx) return;
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      return;
    }
  }
  // Браузер не дал звук без нажатия — молча пропускаем.
  if (ctx.state !== "running") return;
  const master = ctx.createGain();
  master.gain.value = 0.8;
  master.connect(ctx.destination);
  try {
    synthStarSound(ctx, master, event, ctx.currentTime + 0.02);
  } catch {
    // Старый браузер без нужных узлов — без звука.
  }
}

/** Собрать звук в любом контексте (в том числе OfflineAudioContext — для проверки). */
export function synthStarSound(ctx: BaseAudioContext, out: AudioNode, event: StarSoundEvent, at: number): void {
  SOUNDS[event](ctx, out, at);
}
