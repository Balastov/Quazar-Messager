import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Стор интерфейса сохраняет вкладку и раздел — ему нужен localStorage до импорта.
const memory = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) });
// Хранилище чатов перечитывает список при смене статуса шифрования — сеть здесь ни к чему.
vi.mock("../../store/chat", async () => {
  const { create } = await import("zustand");
  return { useChatStore: create(() => ({})) };
});
vi.mock("../../store/e2e", async () => {
  const { create } = await import("zustand");
  return { useE2EStore: create(() => ({ status: "idle" })) };
});
vi.mock("../../api/tutorials", () => ({ tutorialsApi: { list: vi.fn(), mark: vi.fn() } }));
const { tutorialsApi } = await import("../../api/tutorials");
const { useTourStore } = await import("../store");
const { MAIN_TOUR, SETTINGS_TOUR, TOURS, stepPosition } = await import("../tours");
const { useUiStore } = await import("../../store/ui");
const { useE2EStore } = await import("../../store/e2e");
const { SETTINGS_SECTIONS } = await import("../../components/settings/sections");
const { default: securitySource } = await import("../../components/settings/SecuritySection.tsx?raw");
const { default: devicesSource } = await import("../../components/devices/DeviceSessions.tsx?raw");
const { findTarget, placeCard, spotlight } = await import("../geometry");
const { isNewAccount, tourToOffer } = await import("../../components/tour/TourHost");

const viewport = { width: 400, height: 800 };

describe("tour geometry", () => {
  it("frames the element with padding, inside the screen", () => {
    expect(spotlight({ top: 0, left: 10, width: 50, height: 20 }, viewport)).toEqual({ top: 2, left: 4, width: 62, height: 24 });
  });

  it("puts the card below, above, beside or in the center", () => {
    const card = { width: 300, height: 150 };
    expect(placeCard({ top: 100, left: 20, width: 60, height: 40 }, card, viewport)).toMatchObject({ side: "bottom", top: 152, left: 8 });
    // Нижнее меню телефона: места снизу нет — над ним, и не под вырезом/полоской «домой».
    expect(placeCard({ top: 720, left: 0, width: 400, height: 70 }, card, viewport, { top: 47, right: 0, bottom: 34, left: 0 }))
      .toMatchObject({ side: "top", top: 558 });
    expect(placeCard({ top: 0, left: 0, width: 60, height: 800 }, card, { width: 1000, height: 800 })).toMatchObject({ side: "right", left: 72 });
    expect(placeCard({ top: 0, left: 0, width: 400, height: 800 }, card, viewport).side).toBe("center");
  });

  it("highlights whichever marked element is on screen", () => {
    document.body.innerHTML = '<nav data-tour="nav" id="side"></nav><nav data-tour="nav" id="bottom"></nav>';
    const side = document.getElementById("side")!, bottom = document.getElementById("bottom")!;
    side.getBoundingClientRect = () => ({ width: 0, height: 0 }) as DOMRect;
    bottom.getBoundingClientRect = () => ({ width: 300, height: 60 }) as DOMRect;
    expect(findTarget("nav")).toBe(bottom);
    expect(findTarget("missing")).toBeNull();
  });
});

describe("which tour to offer", () => {
  const tour = (id: string, extra: object = {}) => ({ id, subject: "", title: id, description: "", inviteTitle: "", steps: [], ...extra }) as never;
  it("offers one untouched tour at a time, in order, on its own screen, once the previous one is dealt with", () => {
    let onStars = false;
    let hasWork = false;
    const tours = [
      tour("main"),
      tour("stars", { after: "main", offerHere: () => onStars }),
      tour("star_work", { after: "stars", offerHere: () => onStars, unavailable: () => (hasWork ? null : "нет") }),
    ];
    const ids = (p: object) => (tourToOffer(p as never, tours) as { id: string } | null)?.id ?? null;
    expect(ids({})).toBe("main");
    expect(ids({ main: { state: "dismissed" } })).toBeNull(); // не в Созвездии
    onStars = true;
    expect(ids({ main: { state: "dismissed" } })).toBe("stars");
    expect(ids({ main: { state: "done" }, stars: { state: "done" } })).toBeNull(); // нет рабочей Звезды
    hasWork = true;
    expect(ids({ main: { state: "done" }, stars: { state: "dismissed" } })).toBe("star_work");
  });
});

describe("main tour per layout", () => {
  it("shows «Контакты» only on a phone, feedback and status only on a computer, and counts what is shown", () => {
    const targets = (phone: boolean) => MAIN_TOUR.steps.filter((st) => !st.only || st.only === (phone ? "phone" : "desktop")).map((st) => st.target);
    expect(targets(true)).toContain("nav-contacts");
    expect(targets(true)).not.toContain("feedback");
    expect(targets(false)).not.toContain("nav-contacts");
    expect(targets(false)).toEqual(expect.arrayContaining(["new-chat", "feedback", "profile"]));
    const contacts = MAIN_TOUR.steps.findIndex((st) => st.target === "nav-contacts");
    // На компьютере шага «Контакты» нет: следующий за ним — второй из всех.
    expect(stepPosition(MAIN_TOUR, contacts + 1, false)).toEqual({ n: 2, total: targets(false).length });
    expect(stepPosition(MAIN_TOUR, contacts + 1, true)).toEqual({ n: 3, total: targets(true).length });
  });
});

describe("settings tour", () => {
  it("is offered in settings once the main tour is dealt with", () => {
    useUiStore.setState({ tab: "chats" });
    expect(tourToOffer({ main: { state: "done", at: "" } })).toBeNull();
    useUiStore.setState({ tab: "settings" });
    expect(tourToOffer({ main: { state: "done", at: "" } })?.id).toBe("settings");
    expect(tourToOffer({})?.id).toBe("main");
    expect(TOURS[TOURS.length - 1]).toBe(SETTINGS_TOUR);
  });

  it("points only at elements that exist", () => {
    const sections = new Set(SETTINGS_SECTIONS.map((section) => `settings-${section.id}`));
    const source = securitySource + devicesSource;
    for (const { target } of SETTINGS_TOUR.steps) {
      if (target === "nav-settings") continue;
      if (target.startsWith("settings-")) expect(sections.has(target), target).toBe(true);
      else expect(source.includes(`data-tour="${target}"`), target).toBe(true);
    }
  });

  it("opens Security for its cards and skips the recovery password while chats are not readable here", () => {
    useUiStore.setState({ tab: "chats", settingsSection: null });
    const backup = SETTINGS_TOUR.steps.find((step) => step.target === "security-backup")!;
    SETTINGS_TOUR.steps.find((step) => step.target === "security-e2e")!.prepare!();
    expect(useUiStore.getState()).toMatchObject({ tab: "settings", settingsSection: "security" });
    useE2EStore.setState({ status: "needs_restore" });
    expect(backup.when!()).toBe(false);
    useE2EStore.setState({ status: "ready" });
    expect(backup.when!()).toBe(true);
  });
});

describe("tour progress", () => {
  beforeEach(() => {
    vi.mocked(tutorialsApi.mark).mockImplementation(async (id, state) => ({ [id]: { state, at: "now" } }));
    useTourStore.getState().reset();
    useTourStore.setState({ progress: {} });
  });
  afterEach(() => vi.clearAllMocks());

  it("walks the steps and congratulates at the end", () => {
    const tour = useTourStore.getState();
    tour.start("main");
    for (let i = 1; i < MAIN_TOUR.steps.length; i++) useTourStore.getState().next();
    expect(useTourStore.getState().active).toEqual({ id: "main", index: MAIN_TOUR.steps.length - 1 });
    useTourStore.getState().next();
    expect(useTourStore.getState()).toMatchObject({ active: null, finished: "main" });
    expect(useTourStore.getState().progress?.main?.state).toBe("done");
    expect(tutorialsApi.mark).toHaveBeenCalledWith("main", "done");
  });

  it("skipping remembers not to offer again, but keeps «done»", () => {
    useTourStore.getState().start("main");
    useTourStore.getState().skip();
    expect(useTourStore.getState()).toMatchObject({ active: null, finished: null });
    expect(tutorialsApi.mark).toHaveBeenCalledWith("main", "dismissed");
    useTourStore.setState({ progress: { main: { state: "done", at: "x" } } });
    useTourStore.getState().dismiss("main");
    expect(useTourStore.getState().progress?.main?.state).toBe("done");
  });

  it("starts by itself only for new accounts", () => {
    const now = Date.parse("2026-11-18T12:00:00Z");
    expect(isNewAccount("2026-11-17T12:00:00Z", now)).toBe(true);
    expect(isNewAccount("2026-10-01T12:00:00Z", now)).toBe(false);
    expect(isNewAccount(undefined, now)).toBe(false);
  });
});
