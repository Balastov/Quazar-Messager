/**
 * Звуки сообщений и звонков через Web Audio API — без внешних файлов.
 */

let sharedCtx: AudioContext | null = null;

/** Общий AudioContext для всех звуков приложения (создаётся при первом звуке). */
export function getCtx(): AudioContext | null {
  const AC =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  if (!sharedCtx) sharedCtx = new AC();
  return sharedCtx;
}

/** Короткая нота с тихим октавным обертоном: быстро стихает, поэтому не сливается со следующей. */
function pluck(ctx: BaseAudioContext, out: AudioNode, t: number, freq: number, peak: number, decay: number) {
  const partials = [
    { mult: 1, level: 1, length: 1 },
    { mult: 2, level: 0.2, length: 0.5 },
  ];
  for (const p of partials) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq * p.mult;
    const end = t + 0.008 + decay * p.length;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak * p.level, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(gain).connect(out);
    osc.start(t);
    osc.stop(end + 0.02);
  }
}

/** Сообщение: три отдельные ноты вверх (G5, C6, E6). */
export function synthMessageChime(ctx: BaseAudioContext, out: AudioNode, t: number): void {
  pluck(ctx, out, t, 783.99, 0.26, 0.2);
  pluck(ctx, out, t + 0.15, 1046.5, 0.26, 0.2);
  pluck(ctx, out, t + 0.3, 1318.51, 0.28, 0.45);
}

/** Ждём разрешения браузера на звук: сообщения за это время не должны прозвучать хором. */
let chimeWaiting = false;

export async function playSoftChime(): Promise<void> {
  const ctx = getCtx();
  if (!ctx) return;

  if (ctx.state === "suspended") {
    // Chrome не завершит resume() без нажатия, поэтому пробуем на каждое сообщение: после
    // нажатия новый вызов разбудит и ждущий. Прозвучит только этот ждущий.
    const resumed = ctx.resume().catch(() => {});
    if (chimeWaiting) return;
    chimeWaiting = true;
    await resumed;
    chimeWaiting = false;
  }
  if (ctx.state !== "running") return;

  synthMessageChime(ctx, ctx.destination, ctx.currentTime);
}

const RING_CYCLE_MS = 3000;
const RING_BURST = 0.4;
const RING_GAP = 0.2;
/** Частота переливов: как у телефонного звонка с бойком. */
const RING_TRILL_STEP = 0.05;

/** Одна трель: тон быстро переключается между C6 и E6. */
function ringBurst(ctx: BaseAudioContext, out: AudioNode, t: number) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "triangle";
  const steps = Math.round(RING_BURST / RING_TRILL_STEP);
  for (let i = 0; i < steps; i++) {
    osc.frequency.setValueAtTime(i % 2 ? 1318.51 : 1046.5, t + i * RING_TRILL_STEP);
  }
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(0.32, t + 0.01);
  gain.gain.setValueAtTime(0.32, t + RING_BURST - 0.03);
  gain.gain.linearRampToValueAtTime(0, t + RING_BURST);
  osc.connect(gain).connect(out);
  osc.start(t);
  osc.stop(t + RING_BURST + 0.02);
}

/** Один цикл входящего звонка: «дзынь-дзынь», дальше пауза. */
export function synthCallRing(ctx: BaseAudioContext, out: AudioNode, t: number): void {
  ringBurst(ctx, out, t);
  ringBurst(ctx, out, t + RING_BURST + RING_GAP);
}

/** Телефонная трель для входящего звонка (останавливается через возвращённую функцию). */
export function startCallRingtone(): () => void {
  const ctx = getCtx();
  if (!ctx) return () => {};

  let timer: ReturnType<typeof setTimeout> | null = null;
  const master = ctx.createGain();
  master.connect(ctx.destination);

  const tick = () => {
    const running = ctx.state === "running";
    if (running) synthCallRing(ctx, master, ctx.currentTime + 0.02);
    // Браузер ещё не дал звук (не было нажатия) — пробуем снова, циклы не копятся.
    else void ctx.resume().catch(() => {});
    timer = setTimeout(tick, running ? RING_CYCLE_MS : 300);
  };
  tick();

  return () => {
    if (timer) clearTimeout(timer);
    // Трель обрывается сразу, как только на звонок ответили.
    master.gain.setTargetAtTime(0, ctx.currentTime, 0.01);
    setTimeout(() => master.disconnect(), 100);
  };
}

/** Два тихих низких тона вниз — «связь пропала». */
async function playSoftLostTone(): Promise<void> {
  const ctx = getCtx();
  if (!ctx) return;
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      return;
    }
  }

  const now = ctx.currentTime;
  const notes = [
    { freq: 392.0, t: 0 }, // G4
    { freq: 293.66, t: 0.32 }, // D4
  ];
  const master = ctx.createGain();
  master.gain.value = 0.35;
  master.connect(ctx.destination);

  for (const note of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    osc.type = "sine";
    osc.frequency.value = note.freq;
    filter.type = "lowpass";
    filter.frequency.value = 1200;

    const t0 = now + note.t;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.1, t0 + 0.06);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.7);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    osc.start(t0);
    osc.stop(t0 + 0.75);
  }
}

/** Мягкие повторяющиеся сигналы, пока у нас нет связи во время звонка. */
export function startConnectionLostTone(): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = () => {
    if (stopped) return;
    void playSoftLostTone();
    timer = setTimeout(tick, 2500);
  };
  tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
