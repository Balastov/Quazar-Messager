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

/** Браузер уже даёт странице звук: можно играть свой сигнал и в фоне, без нажатия. */
export function soundReady(): boolean {
  return sharedCtx?.state === "running";
}

// Звук разрешается только после нажатия. Будим его на первом же нажатии или клавише, чтобы
// сообщение, пришедшее, пока окно в фоне, прозвучало нашим «о-оу», а не звуком системы.
if (typeof window !== "undefined") {
  const unlock = () => {
    const ctx = getCtx();
    if (!ctx || ctx.state === "running") return done();
    void ctx.resume().then(() => { if (ctx.state === "running") done(); }).catch(() => {});
  };
  const done = () => {
    window.removeEventListener("pointerdown", unlock, true);
    window.removeEventListener("keydown", unlock, true);
  };
  window.addEventListener("pointerdown", unlock, true);
  window.addEventListener("keydown", unlock, true);
}

/** Удар маримбы: основной тон и два коротких негармоничных обертона (×3.9 и ×9.2), как у деревянной пластины. */
function marimba(ctx: BaseAudioContext, out: AudioNode, t: number, freq: number, peak: number, decay: number) {
  const partials = [
    { mult: 1, level: 1, attack: 0.003, decay },
    { mult: 3.9, level: 0.2, attack: 0.002, decay: 0.05 },
    { mult: 9.2, level: 0.05, attack: 0.001, decay: 0.02 },
  ];
  for (const p of partials) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq * p.mult;
    const end = t + p.attack + p.decay;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak * p.level, t + p.attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(gain).connect(out);
    osc.start(t);
    osc.stop(end + 0.05);
  }
}

/** Сообщение: «деревянное о-оу» — две ноты маримбы сверху вниз (G5, D♯5), по мотивам «О-оу» из аськи. */
export function synthMessageChime(ctx: BaseAudioContext, out: AudioNode, t: number): void {
  marimba(ctx, out, t, 783.99, 0.27, 0.22);
  marimba(ctx, out, t + 0.18, 622.25, 0.27, 0.45);
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

// --- Звонок у звонящего: гудки, «соединились», «звонок завершён» -----------------------

const RINGBACK_CYCLE_MS = 4000;

/** Один гудок: 425 Гц (как в телефонной сети), 0,8 с, мягкие края — без щелчков. */
export function synthRingback(ctx: BaseAudioContext, out: AudioNode, t: number): void {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(0.11, t + 0.04);
  gain.gain.setValueAtTime(0.11, t + 0.76);
  gain.gain.linearRampToValueAtTime(0, t + 0.8);
  gain.connect(out);
  for (const { freq, level } of [{ freq: 425, level: 1 }, { freq: 850, level: 0.08 }]) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    g.gain.value = level;
    osc.connect(g).connect(gain);
    osc.start(t);
    osc.stop(t + 0.82);
  }
}

/** Гудки, пока собеседник не ответил (останавливаются через возвращённую функцию). */
export function startRingback(): () => void {
  const ctx = getCtx();
  if (!ctx) return () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  const master = ctx.createGain();
  master.connect(ctx.destination);
  const tick = () => {
    const running = ctx.state === "running";
    if (running) synthRingback(ctx, master, ctx.currentTime + 0.02);
    else void ctx.resume().catch(() => {});
    timer = setTimeout(tick, running ? RINGBACK_CYCLE_MS : 300);
  };
  tick();
  return () => {
    if (timer) clearTimeout(timer);
    // Ответили — гудок обрывается сразу.
    master.gain.setTargetAtTime(0, ctx.currentTime, 0.01);
    setTimeout(() => master.disconnect(), 100);
  };
}

export type CallSound = "connected" | "ended";

/** Соединились: две короткие мягкие ноты вверх (C5 → G5). */
export function synthCallConnected(ctx: BaseAudioContext, out: AudioNode, t: number): void {
  marimba(ctx, out, t, 523.25, 0.16, 0.12);
  marimba(ctx, out, t + 0.1, 783.99, 0.18, 0.3);
}

/** Звонок завершён: те же ноты вниз и тише (G4 → C4). */
export function synthCallEnded(ctx: BaseAudioContext, out: AudioNode, t: number): void {
  marimba(ctx, out, t, 392.0, 0.16, 0.14);
  marimba(ctx, out, t + 0.14, 261.63, 0.17, 0.4);
}

export async function playCallSound(kind: CallSound): Promise<void> {
  const ctx = getCtx();
  if (!ctx) return;
  if (ctx.state === "suspended") await ctx.resume().catch(() => {});
  if (ctx.state !== "running") return;
  (kind === "connected" ? synthCallConnected : synthCallEnded)(ctx, ctx.destination, ctx.currentTime + 0.02);
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

/** Мягкие повторяющиеся сигналы, пока у нас нет связи (в звонке и в комнате Звезды). */
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

// --- Орбита фокуса: общий таймер комнаты ---------------------------------------------------
//
// Мягкие колокольчики на чистых синусах с плавной атакой — без щелчка в начале и тише сообщений.
// Различаются направлением мелодии: вверх — начали работать, вниз — отдыхаем, три ноты вниз
// с долгим хвостом — сеанс закончен.

export type FocusSound = "work" | "break" | "end";

/** Нота-колокольчик: атака 40 мс, долгое затухание, тихий обертон на октаву выше. */
function softBell(ctx: BaseAudioContext, out: AudioNode, t: number, freq: number, peak: number, decay: number) {
  for (const { mult, level } of [{ mult: 1, level: 1 }, { mult: 2, level: 0.12 }]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq * mult;
    const end = t + 0.04 + decay;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak * level, t + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(gain).connect(out);
    osc.start(t);
    osc.stop(end + 0.02);
  }
}

/** Начало работы: две ноты вверх (C5 → G5). */
export function synthFocusWork(ctx: BaseAudioContext, out: AudioNode, t: number): void {
  softBell(ctx, out, t, 523.25, 0.16, 0.55);
  softBell(ctx, out, t + 0.22, 783.99, 0.17, 0.9);
}

/** Перерыв: две ноты вниз, медленнее (E5 → C5) — «выдох». */
export function synthFocusBreak(ctx: BaseAudioContext, out: AudioNode, t: number): void {
  softBell(ctx, out, t, 659.25, 0.15, 0.7);
  softBell(ctx, out, t + 0.32, 523.25, 0.15, 1.2);
}

/** Конец сеанса: три ноты вниз (G5 → E5 → C5), последняя долго звучит. */
export function synthFocusEnd(ctx: BaseAudioContext, out: AudioNode, t: number): void {
  softBell(ctx, out, t, 783.99, 0.14, 0.5);
  softBell(ctx, out, t + 0.24, 659.25, 0.14, 0.5);
  softBell(ctx, out, t + 0.48, 523.25, 0.15, 1.6);
}

const FOCUS_SYNTH: Record<FocusSound, typeof synthFocusWork> = {
  work: synthFocusWork,
  break: synthFocusBreak,
  end: synthFocusEnd,
};

export async function playFocusSound(kind: FocusSound): Promise<void> {
  const ctx = getCtx();
  if (!ctx) return;
  // В комнате звук уже разрешён (голос), но после долгого простоя браузер мог усыпить контекст.
  if (ctx.state === "suspended") await ctx.resume().catch(() => {});
  if (ctx.state !== "running") return;
  FOCUS_SYNTH[kind](ctx, ctx.destination, ctx.currentTime + 0.02);
}

/** Скоро встреча: три колокольчика вверх (E5 → G5 → C6) — «пора собираться». */
export function synthMeetingSoon(ctx: BaseAudioContext, out: AudioNode, t: number): void {
  softBell(ctx, out, t, 659.25, 0.17, 0.35);
  softBell(ctx, out, t + 0.16, 783.99, 0.17, 0.35);
  softBell(ctx, out, t + 0.32, 1046.5, 0.19, 1.1);
}

export async function playMeetingSoon(): Promise<void> {
  const ctx = getCtx();
  if (!ctx) return;
  if (ctx.state === "suspended") await ctx.resume().catch(() => {});
  if (ctx.state !== "running") return;
  synthMeetingSoon(ctx, ctx.destination, ctx.currentTime + 0.02);
}
