/**
 * Активен ли человек на этом устройстве — для статуса «отошёл(ла)».
 *
 * - ПК: IDLE_AFTER_MS без мыши, клавиатуры, колеса и касаний — неактивен (даже если вкладка
 *   открыта). Если включён системный детектор простоя (Chrome/Edge, по разрешению), решает он:
 *   человек работает в любой программе — активен; не трогает компьютер или экран
 *   заблокирован — неактивен.
 * - Телефон и планшет: приложение свёрнуто или экран погас дольше HIDDEN_AFTER_MS —
 *   неактивен; открыли снова — сразу активен.
 * - Звонок или Планета/Комната в Quazar — всегда активен: человек на встрече, хоть и не
 *   трогает мышь (а телефон может лежать с погасшим экраном).
 */
import { socket, type Activity } from "../ws/socket";
import { isMobileDevice } from "../utils/device";

export const IDLE_AFTER_MS = 5 * 60_000;
/** Варианты порога «отошёл» в настройках, минуты. */
export const IDLE_MINUTES_OPTIONS = [5, 15, 30] as const;
export const HIDDEN_AFTER_MS = 30_000;

const INPUT_EVENTS = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart", "scroll"] as const;

interface IdleDetectorLike extends EventTarget {
  userState: "active" | "idle" | null;
  screenState: "locked" | "unlocked" | null;
  start(opts: { threshold: number; signal: AbortSignal }): Promise<void>;
}
type IdleDetectorClass = {
  new (): IdleDetectorLike;
  requestPermission(): Promise<"granted" | "denied">;
};

function idleDetectorClass(): IdleDetectorClass | null {
  return (window as unknown as { IdleDetector?: IdleDetectorClass }).IdleDetector ?? null;
}

/** Есть ли системный детектор простоя (Chrome и Edge на компьютере). */
export function systemIdleSupported(): boolean {
  return typeof window !== "undefined" && !!idleDetectorClass() && !isMobileDevice();
}

export class ActivityTracker {
  private lastInput = Date.now();
  private hiddenSince: number | null = null;
  private state: Activity = "active";
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** null — системного детектора нет; true/false — что он говорит. */
  private systemIdle: boolean | null = null;
  private detectorAbort: AbortController | null = null;
  private readonly mobile: boolean;
  /** Идёт звонок или мы на Планете — активен, что бы ни было. */
  private inCall = false;
  private idleAfterMs = IDLE_AFTER_MS;

  constructor(
    private readonly report: (state: Activity) => void = (s) => socket.setActivity(s),
    private readonly now: () => number = Date.now,
    mobile = isMobileDevice()
  ) {
    this.mobile = mobile;
  }

  start() {
    for (const name of INPUT_EVENTS) {
      window.addEventListener(name, this.onInput, { passive: true, capture: true });
    }
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("focus", this.onInput);
    this.onVisibility();
  }

  stop() {
    for (const name of INPUT_EVENTS) window.removeEventListener(name, this.onInput, { capture: true });
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("focus", this.onInput);
    this.stopSystemIdle();
    if (this.timer) clearTimeout(this.timer);
  }

  current(): Activity {
    return this.state;
  }

  setInCall(inCall: boolean) {
    if (inCall === this.inCall) return;
    this.inCall = inCall;
    // Закончили звонок — отсчёт простоя с этого момента.
    if (!inCall) this.lastInput = this.now();
    this.evaluate();
  }

  setIdleAfter(minutes: number) {
    if (this.idleAfterMs === minutes * 60_000) return;
    this.idleAfterMs = minutes * 60_000;
    // Системный детектор берёт порог при запуске — перезапускаем с новым.
    if (this.detectorAbort) {
      this.stopSystemIdle();
      void this.startSystemIdle(false);
    }
    this.evaluate();
  }

  /** Включить системный детектор. prompt — можно спросить разрешение (нужно нажатие). */
  async startSystemIdle(prompt: boolean): Promise<boolean> {
    const Detector = idleDetectorClass();
    if (!Detector || this.detectorAbort) return !!this.detectorAbort;
    try {
      if (prompt) {
        if ((await Detector.requestPermission()) !== "granted") return false;
      } else {
        const perm = await navigator.permissions?.query({ name: "idle-detection" as PermissionName });
        if (perm?.state !== "granted") return false;
      }
      const detector = new Detector();
      const abort = new AbortController();
      detector.addEventListener("change", () => {
        this.systemIdle = detector.userState === "idle" || detector.screenState === "locked";
        this.evaluate();
      });
      await detector.start({ threshold: this.idleAfterMs, signal: abort.signal });
      this.detectorAbort = abort;
      this.systemIdle = false;
      this.evaluate();
      return true;
    } catch {
      return false;
    }
  }

  stopSystemIdle() {
    this.detectorAbort?.abort();
    this.detectorAbort = null;
    this.systemIdle = null;
    this.evaluate();
  }

  private onInput = () => {
    this.lastInput = this.now();
    if (this.state === "idle") this.evaluate();
  };

  private onVisibility = () => {
    if (document.visibilityState === "hidden") {
      this.hiddenSince ??= this.now();
    } else {
      // Открыли вкладку или приложение — это и есть активность.
      this.hiddenSince = null;
      this.lastInput = this.now();
    }
    this.evaluate();
  };

  /** Пересчитать состояние и запланировать следующую проверку. */
  evaluate() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const now = this.now();
    let next: Activity;
    let recheckIn: number | null = null;

    if (this.inCall) {
      next = "active";
    } else if (this.mobile && this.hiddenSince !== null) {
      const left = HIDDEN_AFTER_MS - (now - this.hiddenSince);
      next = left <= 0 ? "idle" : "active";
      if (left > 0) recheckIn = left;
    } else if (this.systemIdle !== null) {
      next = this.systemIdle ? "idle" : "active";
    } else {
      const left = this.idleAfterMs - (now - this.lastInput);
      next = left <= 0 ? "idle" : "active";
      if (left > 0) recheckIn = left;
    }

    if (recheckIn !== null) this.timer = setTimeout(() => this.evaluate(), recheckIn + 50);
    if (next !== this.state) {
      this.state = next;
      this.report(next);
    }
  }
}

/** Один трекер на вкладку. */
export const activityTracker = typeof window !== "undefined" ? new ActivityTracker() : null;
