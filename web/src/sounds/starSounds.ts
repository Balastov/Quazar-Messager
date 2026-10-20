/**
 * Звуки Созвездия — синтез через Web Audio API, без аудиофайлов.
 *
 * Игры: фантастика — «варп» при входе и выходе, блипы, когда заходят и уходят другие,
 * дроид при стуке (запросе на посещение), роботизированный вуп-вуп при приглашении.
 * Работа: шаги и дверь при своём входе и выходе, мягкие ноты, когда заходят и уходят другие,
 * стук в дверь, вокзальный «дин-дон» при приглашении.
 */
import type { StarKind } from "../api/stars";
import { getCtx } from "../notifications/sound";
import { useUiStore } from "../store/ui";

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

/** Шаг: глухой удар каблука и шорох подошвы. */
function step(ctx: BaseAudioContext, out: AudioNode, t: number, gain: number, far = false) {
  const lp = far ? 700 : 1100;
  tone(ctx, out, t, { freq: 105, to: 60, glide: 0.07, peak: 0.5 * gain, attack: 0.003, decay: 0.08 });
  burst(ctx, out, t, { type: "lowpass", freq: lp, peak: 0.45 * gain, attack: 0.002, decay: 0.07 });
  burst(ctx, out, t + 0.035, { type: "bandpass", freq: lp * 1.6, q: 1.2, peak: 0.12 * gain, attack: 0.01, decay: 0.09 });
}

/** Скрип петель: резонансная пила с «дрожащей» высотой. */
function creak(ctx: BaseAudioContext, out: AudioNode, t: number, from: number, to: number, dur: number, peak: number) {
  const osc = ctx.createOscillator();
  const wobble = ctx.createOscillator();
  const wobbleGain = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  const gain = ctx.createGain();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(from, t);
  osc.frequency.linearRampToValueAtTime(to, t + dur);
  wobble.frequency.value = 23;
  wobbleGain.gain.value = 14;
  wobble.connect(wobbleGain).connect(osc.frequency);
  filter.type = "bandpass";
  filter.frequency.value = 1300;
  filter.Q.value = 6;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + dur * 0.25);
  gain.gain.exponentialRampToValueAtTime(peak * 0.6, t + dur * 0.7);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(filter).connect(gain).connect(out);
  osc.start(t);
  wobble.start(t);
  osc.stop(t + dur + 0.05);
  wobble.stop(t + dur + 0.05);
}

/** Щелчок защёлки или ручки. */
function latch(ctx: BaseAudioContext, out: AudioNode, t: number, peak: number) {
  burst(ctx, out, t, { type: "highpass", freq: 2500, peak, attack: 0.001, decay: 0.018 });
  burst(ctx, out, t + 0.03, { type: "bandpass", freq: 1800, q: 3, peak: peak * 0.6, attack: 0.001, decay: 0.03 });
}

// --- Игры: фантастика --------------------------------------------------------------------

/** Вход на Планету: подъём «варпа», шелест и звёздные искры в конце. */
const warpIn: Synth = (ctx, out, t) => {
  tone(ctx, out, t, { type: "sine", freq: 160, to: 1250, glide: 0.75, peak: 0.28, attack: 0.25, decay: 0.75 });
  tone(ctx, out, t + 0.02, { type: "triangle", freq: 240, to: 1880, glide: 0.75, peak: 0.1, attack: 0.3, decay: 0.7 });
  burst(ctx, out, t, { type: "bandpass", freq: 350, to: 4200, q: 1.4, peak: 0.22, attack: 0.45, decay: 0.45 });
  [2093, 2637, 3136, 4186].forEach((f, i) => bell(ctx, out, t + 0.62 + i * 0.07, f, 0.07, 0.9));
};

/** Выход с Планеты: «варп» вниз и глухой удар. */
const warpOut: Synth = (ctx, out, t) => {
  [3136, 2637, 2093].forEach((f, i) => bell(ctx, out, t + i * 0.05, f, 0.05, 0.4));
  tone(ctx, out, t + 0.08, { type: "sine", freq: 1300, to: 120, glide: 0.7, peak: 0.26, attack: 0.04, decay: 0.75 });
  tone(ctx, out, t + 0.1, { type: "triangle", freq: 1950, to: 180, glide: 0.65, peak: 0.08, attack: 0.04, decay: 0.7 });
  burst(ctx, out, t + 0.05, { type: "bandpass", freq: 4000, to: 260, q: 1.4, peak: 0.2, attack: 0.05, decay: 0.7 });
  tone(ctx, out, t + 0.72, { type: "sine", freq: 85, to: 45, glide: 0.3, peak: 0.35, attack: 0.01, decay: 0.32 });
};

/** Кто-то прилетел: два восходящих бипа. */
const blipIn: Synth = (ctx, out, t) => {
  tone(ctx, out, t, { type: "triangle", freq: 620, to: 930, glide: 0.07, peak: 0.16, attack: 0.008, decay: 0.12 });
  tone(ctx, out, t + 0.11, { type: "triangle", freq: 930, to: 1400, glide: 0.07, peak: 0.16, attack: 0.008, decay: 0.2 });
  bell(ctx, out, t + 0.16, 2800, 0.03, 0.35);
};

/** Кто-то улетел: два нисходящих бипа. */
const blipOut: Synth = (ctx, out, t) => {
  tone(ctx, out, t, { type: "triangle", freq: 1400, to: 930, glide: 0.07, peak: 0.15, attack: 0.008, decay: 0.12 });
  tone(ctx, out, t + 0.11, { type: "triangle", freq: 930, to: 560, glide: 0.08, peak: 0.15, attack: 0.008, decay: 0.22 });
};

/** Запрос на посещение: щебет дроида — быстрые трели и свист (каждый раз немного другой). */
const droid: Synth = (ctx, out, t) => {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  osc.type = "sine";
  filter.type = "lowpass";
  filter.frequency.value = 5200;
  osc.connect(filter).connect(gain).connect(out);
  let at = t;
  osc.frequency.setValueAtTime(1800, at);
  gain.gain.setValueAtTime(0.0001, at);
  const chirps = 7 + Math.floor(Math.random() * 4);
  for (let i = 0; i < chirps; i++) {
    const len = 0.045 + Math.random() * 0.07;
    const from = 1100 + Math.random() * 2300;
    const to = 900 + Math.random() * 2800;
    osc.frequency.setValueAtTime(from, at);
    osc.frequency.exponentialRampToValueAtTime(to, at + len);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.16, at + 0.008);
    gain.gain.setValueAtTime(0.16, at + len - 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + len);
    at += len + (Math.random() < 0.3 ? 0.04 : 0.012);
  }
  // Вопросительный свист вверх в конце.
  osc.frequency.setValueAtTime(1300, at);
  osc.frequency.exponentialRampToValueAtTime(3400, at + 0.22);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(0.15, at + 0.03);
  gain.gain.setValueAtTime(0.15, at + 0.17);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.24);
  osc.start(t);
  osc.stop(at + 0.3);
};

/** Приглашение в игровую Звезду или на Планету: роботизированный «вуп-вуп». */
const roboWhoop: Synth = (ctx, out, t) => {
  for (const start of [t, t + 0.42]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    // Амплитудная модуляция квадратом — «металлический» голос робота.
    const robot = ctx.createOscillator();
    const robotDepth = ctx.createGain();
    const am = ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(260, start);
    osc.frequency.exponentialRampToValueAtTime(780, start + 0.26);
    osc.frequency.exponentialRampToValueAtTime(700, start + 0.34);
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(700, start);
    filter.frequency.exponentialRampToValueAtTime(1900, start + 0.26);
    filter.Q.value = 2.5;
    robot.type = "square";
    robot.frequency.value = 48;
    robotDepth.gain.value = 0.5;
    am.gain.value = 0.5;
    robot.connect(robotDepth).connect(am.gain);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.32, start + 0.04);
    gain.gain.setValueAtTime(0.32, start + 0.26);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.36);
    osc.connect(filter).connect(am).connect(gain).connect(out);
    osc.start(start);
    robot.start(start);
    osc.stop(start + 0.4);
    robot.stop(start + 0.4);
  }
};

// --- Работа: офис ------------------------------------------------------------------------

/** Вход в Комнату: шаги всё ближе, ручка, дверь со скрипом открывается. */
const stepsAndDoorOpen: Synth = (ctx, out, t) => {
  [0.18, 0.3, 0.45, 0.62].forEach((g, i) => step(ctx, out, t + i * 0.3, g));
  const door = t + 1.32;
  latch(ctx, out, door, 0.35);
  creak(ctx, out, door + 0.08, 170, 255, 0.62, 0.4);
  burst(ctx, out, door + 0.1, { type: "lowpass", freq: 600, peak: 0.12, attack: 0.15, decay: 0.5 });
};

/** Выход из Комнаты: дверь закрывается, хлопок, шаги удаляются. */
const doorCloseAndSteps: Synth = (ctx, out, t) => {
  creak(ctx, out, t, 250, 175, 0.38, 0.35);
  const shut = t + 0.4;
  tone(ctx, out, shut, { freq: 78, to: 52, glide: 0.18, peak: 0.5, attack: 0.004, decay: 0.22 });
  burst(ctx, out, shut, { type: "lowpass", freq: 520, peak: 0.55, attack: 0.002, decay: 0.16 });
  latch(ctx, out, shut + 0.04, 0.3);
  [0.55, 0.38, 0.24, 0.13].forEach((g, i) => step(ctx, out, shut + 0.45 + i * 0.3, g, i > 1));
};

/** Кто-то вошёл: две мягкие восходящие ноты (как системные звуки iPhone). */
const softIn: Synth = (ctx, out, t) => {
  bell(ctx, out, t, 783.99, 0.16, 0.45);
  bell(ctx, out, t + 0.09, 1174.66, 0.14, 0.6);
};

/** Кто-то вышел: те же ноты вниз. */
const softOut: Synth = (ctx, out, t) => {
  bell(ctx, out, t, 1174.66, 0.13, 0.4);
  bell(ctx, out, t + 0.09, 783.99, 0.14, 0.55);
};

/** Стук в Комнату: тук-тук… тук. */
const doorKnock: Synth = (ctx, out, t) => {
  [0, 0.16, 0.42].forEach((dt, i) => {
    const g = i === 2 ? 0.85 : 1;
    tone(ctx, out, t + dt, { freq: 165, to: 120, glide: 0.05, peak: 0.55 * g, attack: 0.002, decay: 0.07 });
    burst(ctx, out, t + dt, { type: "bandpass", freq: 520, q: 1.6, peak: 0.6 * g, attack: 0.001, decay: 0.05 });
    burst(ctx, out, t + dt, { type: "highpass", freq: 1800, peak: 0.08 * g, attack: 0.001, decay: 0.015 });
  });
};

/** Приглашение в рабочую Звезду или Комнату: вокзальный «дин-дон-дан». */
const stationChime: Synth = (ctx, out, t) => {
  bell(ctx, out, t, 1046.5, 0.16, 1.3);
  bell(ctx, out, t + 0.34, 880, 0.16, 1.3);
  bell(ctx, out, t + 0.68, 698.46, 0.17, 1.6);
};

const SOUNDS: Record<"gaming" | "work", Record<StarSoundEvent, Synth>> = {
  gaming: {
    enter: warpIn,
    leave: warpOut,
    peerJoin: blipIn,
    peerLeave: blipOut,
    knock: droid,
    invite: roboWhoop,
  },
  work: {
    enter: stepsAndDoorOpen,
    leave: doorCloseAndSteps,
    peerJoin: softIn,
    peerLeave: softOut,
    knock: doorKnock,
    invite: stationChime,
  },
};

/** Сыграть звук события; force — для кнопок «Прослушать» в настройках. */
export async function playStarSound(
  event: StarSoundEvent,
  kind: StarKind | undefined,
  { force = false }: { force?: boolean } = {}
): Promise<void> {
  if (!force && !useUiStore.getState().starSounds) return;
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
    synthStarSound(ctx, master, event, kind, ctx.currentTime + 0.02);
  } catch {
    // Старый браузер без нужных узлов — без звука.
  }
}

/** Собрать звук в любом контексте (в том числе OfflineAudioContext — для проверки). */
export function synthStarSound(
  ctx: BaseAudioContext,
  out: AudioNode,
  event: StarSoundEvent,
  kind: StarKind | undefined,
  at: number
): void {
  SOUNDS[kind === "work" ? "work" : "gaming"][event](ctx, out, at);
}
