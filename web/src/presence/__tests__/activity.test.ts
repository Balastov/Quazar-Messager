import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityTracker, HIDDEN_AFTER_MS, IDLE_AFTER_MS } from "../activity";

let visibility: "visible" | "hidden" = "visible";
Object.defineProperty(document, "visibilityState", { get: () => visibility, configurable: true });

function setVisibility(v: "visible" | "hidden") {
  visibility = v;
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("ActivityTracker", () => {
  let reports: string[];
  let tracker: ActivityTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    visibility = "visible";
    reports = [];
  });
  afterEach(() => {
    tracker.stop();
    vi.useRealTimers();
  });

  const make = (mobile: boolean) => {
    tracker = new ActivityTracker((s) => reports.push(s), () => Date.now(), mobile);
    tracker.start();
  };

  it("desktop: idle after minutes without mouse or keyboard, active again on input", () => {
    make(false);
    vi.advanceTimersByTime(IDLE_AFTER_MS - 1000);
    window.dispatchEvent(new Event("pointermove"));
    vi.advanceTimersByTime(IDLE_AFTER_MS - 1000);
    expect(reports).toEqual([]); // мышь двигали — ещё активен
    vi.advanceTimersByTime(2000);
    expect(reports).toEqual(["idle"]);
    window.dispatchEvent(new Event("keydown"));
    expect(reports).toEqual(["idle", "active"]);
  });

  it("desktop: a hidden tab alone does not make you idle at once", () => {
    make(false);
    setVisibility("hidden");
    vi.advanceTimersByTime(HIDDEN_AFTER_MS * 2);
    expect(reports).toEqual([]);
  });

  it("phone: idle soon after the app goes to background, active when opened", () => {
    make(true);
    setVisibility("hidden");
    vi.advanceTimersByTime(HIDDEN_AFTER_MS - 1000);
    expect(reports).toEqual([]);
    vi.advanceTimersByTime(2000);
    expect(reports).toEqual(["idle"]);
    setVisibility("visible");
    expect(reports).toEqual(["idle", "active"]);
  });

  it("a Quazar call or Planet keeps you active, idle is counted from its end", () => {
    make(false);
    tracker.setInCall(true);
    vi.advanceTimersByTime(IDLE_AFTER_MS * 3);
    expect(reports).toEqual([]); // сидит на встрече без мыши
    tracker.setInCall(false);
    vi.advanceTimersByTime(IDLE_AFTER_MS - 1000);
    expect(reports).toEqual([]);
    vi.advanceTimersByTime(2000);
    expect(reports).toEqual(["idle"]);
  });

  it("phone in a call stays active with the screen off; custom threshold works", () => {
    make(true);
    tracker.setInCall(true);
    setVisibility("hidden");
    vi.advanceTimersByTime(HIDDEN_AFTER_MS * 10);
    expect(reports).toEqual([]);
    tracker.setInCall(false);
    expect(reports).toEqual(["idle"]); // разговор кончился, а приложение давно в фоне

    setVisibility("visible");
    tracker.setIdleAfter(15);
    vi.advanceTimersByTime(IDLE_AFTER_MS * 2);
    expect(reports).toEqual(["idle", "active"]);
    vi.advanceTimersByTime(IDLE_AFTER_MS + 1000);
    expect(reports).toEqual(["idle", "active", "idle"]);
  });

  it("phone: a quick glance away does not count", () => {
    make(true);
    setVisibility("hidden");
    vi.advanceTimersByTime(5000);
    setVisibility("visible");
    vi.advanceTimersByTime(HIDDEN_AFTER_MS);
    expect(reports).toEqual([]);
  });
});
