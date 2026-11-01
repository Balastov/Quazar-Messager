/**
 * Звуки Созвездия — один мягкий набор для всех Звёзд (игровых и рабочих).
 * Синтез через Web Audio API, без аудиофайлов.
 *
 * Вход — две ноты вверх, выход — те же ноты вниз; кто-то вошёл или вышел — то же,
 * но выше, короче и тише; стук — два мягких касания; приглашение — вокзальный «дин-дон-дан».
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
  | "invite";

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

/** Колокольчик: основной тон и негармоничные обертоны с разным спадом. */
function bell(ctx: BaseAudioContext, out: AudioNode, t: number, freq: number, peak: number, decay: number) {
  tone(ctx, out, t, { freq, peak, attack: 0.006, decay });
  tone(ctx, out, t, { freq: freq * 2.01, peak: peak * 0.35, attack: 0.004, decay: decay * 0.55 });
  tone(ctx, out, t, { freq: freq * 3.02, peak: peak * 0.12, attack: 0.003, decay: decay * 0.3 });
}

// --- Общий набор: мягкие современные звуки -------------------------------------------

/** Мягкая нота: синус с тихим вторым обертоном и плавной атакой — «стеклянная капля». */
function softNote(ctx: BaseAudioContext, out: AudioNode, t: number, freq: number, peak: number, decay: number) {
  tone(ctx, out, t, { freq, peak, attack: 0.014, decay });
  tone(ctx, out, t, { freq: freq * 2, peak: peak * 0.16, attack: 0.012, decay: decay * 0.55 });
}

/** Я вошёл: две ноты вверх (A4, E5). */
const softEnter: Synth = (ctx, out, t) => {
  softNote(ctx, out, t, 440, 0.22, 0.16);
  softNote(ctx, out, t + 0.13, 659.25, 0.26, 0.45);
};

/** Я вышел: те же ноты вниз, последняя без обертона — глуше. */
const softLeave: Synth = (ctx, out, t) => {
  softNote(ctx, out, t, 659.25, 0.22, 0.16);
  tone(ctx, out, t + 0.13, { freq: 440, peak: 0.28, attack: 0.014, decay: 0.45 });
};

/** Кто-то вошёл: две короткие ноты вверх (D5, A5). */
const peerIn: Synth = (ctx, out, t) => {
  softNote(ctx, out, t, 587.33, 0.13, 0.1);
  softNote(ctx, out, t + 0.09, 880, 0.14, 0.2);
};

/** Кто-то вышел: те же ноты вниз. */
const peerOut: Synth = (ctx, out, t) => {
  softNote(ctx, out, t, 880, 0.13, 0.1);
  softNote(ctx, out, t + 0.09, 587.33, 0.14, 0.2);
};

/** Стук: два мягких «деревянных» касания — тук-тук. */
const softKnock: Synth = (ctx, out, t) => {
  [0, 0.14].forEach((dt, i) => {
    const g = i === 0 ? 1 : 0.8;
    tone(ctx, out, t + dt, { freq: 760, to: 700, glide: 0.06, peak: 0.16 * g, attack: 0.003, decay: 0.1 });
    tone(ctx, out, t + dt, { type: "triangle", freq: 1520, peak: 0.03 * g, attack: 0.002, decay: 0.05 });
    burst(ctx, out, t + dt, { type: "lowpass", freq: 900, peak: 0.08 * g, attack: 0.001, decay: 0.025 });
  });
};

/** Приглашение (в Звезду, на Планету, в Комнату): вокзальный «дин-дон-дан». */
const stationChime: Synth = (ctx, out, t) => {
  bell(ctx, out, t, 1046.5, 0.16, 1.3);
  bell(ctx, out, t + 0.34, 880, 0.16, 1.3);
  bell(ctx, out, t + 0.68, 698.46, 0.17, 1.6);
};

const SOUNDS: Record<StarSoundEvent, Synth> = {
  enter: softEnter,
  leave: softLeave,
  peerJoin: peerIn,
  peerLeave: peerOut,
  knock: softKnock,
  invite: stationChime,
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
