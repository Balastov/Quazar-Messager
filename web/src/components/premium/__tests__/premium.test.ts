import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PremiumInfo } from "../../../api/premium";

const memory = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) });
vi.mock("../../../api/premium", () => ({ premiumApi: { get: vi.fn(), startTrial: vi.fn() } }));
vi.mock("../../../api/users", () => ({ usersApi: { me: vi.fn() } }));
const auth = vi.hoisted(() => ({ user: { id: "alice" }, setUser: vi.fn() }));
vi.mock("../../../store/auth", () => ({
  useAuthStore: Object.assign((selector: (value: typeof auth) => unknown) => selector(auth), { getState: () => auth }),
}));
const { premiumApi } = await import("../../../api/premium");
const { usersApi } = await import("../../../api/users");
const { premiumStatus, ownStars } = await import("../premiumText");
const { default: PremiumSection } = await import("../../settings/PremiumSection");
const { default: PremiumBadge } = await import("../PremiumBadge");

const free: PremiumInfo = {
  active: false, kind: null, forever: false, until: null, trial_available: true, trial_unavailable_reason: null, trial_days: 30,
  star_limit: 2, owned_stars: 2, star_limits: { free: 2, trial: 3, premium: 5 },
};
let host: HTMLDivElement, root: Root;
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === label);
const flush = async () => { for (let i = 0; i < 3; i++) await act(async () => {}); };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); document.body.innerHTML = ""; });

it("names every kind of Premium with its end date", () => {
  expect(premiumStatus({ active: true, kind: "trial", forever: false, until: "2026-12-10T12:00:00Z" })).toEqual({ text: "Пробный Premium до", until: "10 декабря 2026" });
  expect(premiumStatus({ active: true, kind: "purchase", forever: false, until: "2027-01-05T12:00:00Z" }).text).toBe("Premium куплен до");
  expect(premiumStatus({ active: true, kind: "superuser", forever: true, until: null })).toEqual({ text: "Бессрочный Premium", until: null });
  expect(premiumStatus({ active: false, kind: null, forever: false, until: null }).text).toBe("Premium не подключён");
  expect([1, 2, 5, 11, 22].map(ownStars)).toEqual(["1 своя Звезда", "2 своих Звезды", "5 своих Звёзд", "11 своих Звёзд", "22 своих Звезды"]);
});

it("draws the badge as a green outline star", async () => {
  await act(async () => root.render(createElement(PremiumBadge)));
  const star = host.querySelector("polygon")!;
  expect(star.getAttribute("fill")).toBe("none");
  expect(star.getAttribute("stroke")).toBe("var(--qz-online)");
  expect(host.querySelector('[aria-label="Quazar Premium"]')).not.toBeNull();
});

it("starts the free month and highlights the trial column", async () => {
  vi.mocked(premiumApi.get).mockResolvedValue(free);
  vi.mocked(premiumApi.startTrial).mockResolvedValue({ ...free, active: true, kind: "trial", until: "2026-12-10T12:00:00Z", trial_available: false, trial_unavailable_reason: "Пробный месяц уже использован", star_limit: 3 });
  vi.mocked(usersApi.me).mockResolvedValue({ id: "alice", is_premium: true } as never);
  await act(async () => root.render(createElement(PremiumSection)));
  await flush();
  expect(host.textContent).toContain("Premium не подключён");
  await act(async () => Simulate.click(button("Попробовать бесплатно — 1 месяц")!));
  await flush();
  expect(premiumApi.startTrial).toHaveBeenCalledOnce();
  expect(auth.setUser).toHaveBeenCalledWith({ id: "alice", is_premium: true });
  expect(host.textContent).toContain("Пробный Premium до 10 декабря 2026");
  expect(host.querySelector('[class*="until"]')?.textContent).toBe("10 декабря 2026");
  expect(host.textContent).toContain("Своих Звёзд сейчас: 2 из 3");
  expect(button("Попробовать бесплатно — 1 месяц")).toBeUndefined();
});

it("explains that buying is not available yet", async () => {
  vi.mocked(premiumApi.get).mockResolvedValue({ ...free, trial_available: false, trial_unavailable_reason: "Пробный месяц уже использован" });
  await act(async () => root.render(createElement(PremiumSection)));
  await flush();
  expect(host.textContent).toContain("Пробный месяц уже использован");
  await act(async () => Simulate.click(button("Купить")!));
  expect(document.body.textContent).toContain("Quazar Premium пока в ранней разработке — купить его сейчас нельзя");
});

it("offers no purchase for forever Premium", async () => {
  vi.mocked(premiumApi.get).mockResolvedValue({ ...free, active: true, kind: "superuser", forever: true, trial_available: false, trial_unavailable_reason: "У вас бессрочный Quazar Premium", star_limit: null });
  await act(async () => root.render(createElement(PremiumSection)));
  await flush();
  expect(host.textContent).toContain("Бессрочный Premium");
  expect(host.textContent).toContain("без ограничения");
  expect(button("Купить")).toBeUndefined();
});
