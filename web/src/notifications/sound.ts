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

/** Шаг мелодии рингтона (шестнадцатая при 125 ударах в минуту) и длина круга: 32 шага. */
const RING_STEP = 0.12;
const RING_CYCLE_MS = 3840;

/** Нота калимбы: металлический язычок на деревянном корпусе — нота чуть «подъезжает» снизу вверх
 * (на 1,2 %) и долго звенит, плюс тихая октава и короткий негармоничный обертон ×5,4. */
function kalimba(ctx: BaseAudioContext, out: AudioNode, t: number, freq: number, peak: number, decay: number) {
  const partials = [
    { mult: 1, level: 1, attack: 0.002, decay, bend: 1.012 },
    { mult: 2, level: 0.06, attack: 0.002, decay: 0.25, bend: 1 },
    { mult: 5.4, level: 0.12, attack: 0.001, decay: 0.04, bend: 1 },
  ];
  for (const p of partials) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq * p.mult * p.bend, t);
    if (p.bend !== 1) osc.frequency.exponentialRampToValueAtTime(freq * p.mult, t + 0.03);
    const end = t + p.attack + p.decay;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak * p.level, t + p.attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(gain).connect(out);
    osc.start(t);
    osc.stop(end + 0.05);
  }
}

const midi = (note: number) => 440 * 2 ** ((note - 69) / 12);

/** «Калимба-капель»: арпеджио ре мажора вверх-вниз, в конце — взлёт и долгая нота. [шаг, нота MIDI]. */
const RING_MELODY: [number, number][] = [
  [0, 74], [2, 78], [4, 81], [6, 86], [8, 85], [10, 81], [12, 78], [14, 76],
  [16, 74], [18, 78], [20, 81], [22, 88], [24, 86],
];

/** Лёгкое эхо (0,24 с — ровно шаг мелодии, отзвук ложится в ритм). Возвращает вход и разборку. */
function ringEcho(ctx: BaseAudioContext, out: AudioNode): { input: AudioNode; dispose: () => void } {
  const input = ctx.createGain();
  const delay = ctx.createDelay(1);
  const feedback = ctx.createGain();
  const damp = ctx.createBiquadFilter();
  delay.delayTime.value = RING_STEP * 2;
  feedback.gain.value = 0.22;
  damp.type = "lowpass";
  damp.frequency.value = 3000;
  input.connect(out);
  input.connect(delay);
  delay.connect(damp).connect(feedback).connect(delay);
  feedback.connect(out);
  return { input, dispose: () => { input.disconnect(); feedback.disconnect(); } };
}

/** Один круг входящего звонка (без эха — его добавляет startCallRingtone). */
export function synthCallRing(ctx: BaseAudioContext, out: AudioNode, t: number): void {
  RING_MELODY.forEach(([step, note], i) => {
    const last = i === RING_MELODY.length - 1;
    kalimba(ctx, out, t + step * RING_STEP, midi(note), 0.21, last ? 1.4 : 0.8);
  });
}

/** Рингтон входящего звонка «Калимба-капель» (останавливается через возвращённую функцию). */
export function startCallRingtone(): () => void {
  const ctx = getCtx();
  if (!ctx) return () => {};

  let timer: ReturnType<typeof setTimeout> | null = null;
  const master = ctx.createGain();
  master.connect(ctx.destination);
  const echo = ringEcho(ctx, master);

  const tick = () => {
    const running = ctx.state === "running";
    if (running) synthCallRing(ctx, echo.input, ctx.currentTime + 0.02);
    // Браузер ещё не дал звук (не было нажатия) — пробуем снова, круги не копятся.
    else void ctx.resume().catch(() => {});
    timer = setTimeout(tick, running ? RING_CYCLE_MS : 300);
  };
  tick();

  return () => {
    if (timer) clearTimeout(timer);
    // Рингтон обрывается сразу, как только на звонок ответили.
    master.gain.setTargetAtTime(0, ctx.currentTime, 0.01);
    setTimeout(() => {
      echo.dispose();
      master.disconnect();
    }, 100);
  };
}

// --- Звонок у звонящего: гудки, «соединились», «звонок завершён» -----------------------

const RINGBACK_CYCLE_MS = 3500;

/** Мягкий гудок: 425 Гц (как в телефонной сети), 0,8 с; плавно нарастает и стихает, без резкого края. */
export function synthRingback(ctx: BaseAudioContext, out: AudioNode, t: number): void {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(0.12, t + 0.15);
  gain.gain.setValueAtTime(0.12, t + 0.5);
  gain.gain.linearRampToValueAtTime(0, t + 0.8);
  gain.connect(out);
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = 425;
  osc.connect(gain);
  osc.start(t);
  osc.stop(t + 0.82);
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

/** «Сонар» — связь пропала: тихий пинг (D6) с затухающим эхом, будто ищем сигнал. */
export function synthConnectionLost(ctx: BaseAudioContext, out: AudioNode, t: number): () => void {
  const delay = ctx.createDelay(1);
  const feedback = ctx.createGain();
  const damp = ctx.createBiquadFilter();
  delay.delayTime.value = 0.28;
  feedback.gain.value = 0.42;
  damp.type = "lowpass";
  damp.frequency.value = 1500;
  const input = ctx.createGain();
  input.connect(out);
  input.connect(delay);
  delay.connect(damp).connect(feedback).connect(delay);
  feedback.connect(out);
  for (const { mult, level, attack, decay } of [
    { mult: 1, level: 1, attack: 0.014, decay: 0.12 },
    { mult: 2, level: 0.16, attack: 0.012, decay: 0.066 },
  ]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 1174.66 * mult;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.031 * level, t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    osc.connect(gain).connect(input);
    osc.start(t);
    osc.stop(t + attack + decay + 0.05);
  }
  // Петля задержки сама не исчезнет — её разбирают, когда эхо стихло.
  return () => {
    input.disconnect();
    feedback.disconnect();
  };
}

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
  const dispose = synthConnectionLost(ctx, ctx.destination, ctx.currentTime + 0.02);
  // Эхо стихает примерно за две секунды.
  setTimeout(dispose, 2400);
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
