import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AdminUser } from "../../../api/admin";

// Настоящий adminApi: allUsers догружает страницы через подменённый users.
const { adminApi } = await import("../../../api/admin");
const { default: BlackHoleView } = await import("../BlackHoleView");

const user = (patch: Partial<AdminUser>): AdminUser => ({
  id: "u", username: "user", first_name: null, last_name: null, phone: "+79990000000", created_at: "2026-11-01T09:30:00Z",
  last_seen_at: null, is_superuser: false, premium_kind: null, premium_until: null, blocked_at: null, blocked_reason: null,
  online: false, ...patch,
});
let host: HTMLDivElement, root: Root;
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => {}); };
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === label)!;

beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.restoreAllMocks();
  for (const key of ["me", "users", "grantPremium"] as const) vi.spyOn(adminApi, key);
  vi.mocked(adminApi.me).mockResolvedValue({ users: 2, online: 1, blocked: 0, stars: 0, chats: 0, messages_today: 0, open_reports: 0, queued_tickets: 0 });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const open = async () => {
  await act(async () => root.render(createElement(BlackHoleView)));
  await act(async () => { vi.advanceTimersByTime(300); });
  await flush();
};

it("lists every user with nickname, name, registration, last seen and Premium", async () => {
  vi.mocked(adminApi.users).mockResolvedValue([
    user({ id: "a", username: "alice", first_name: "Алиса", last_name: "Иванова", last_seen_at: "2026-11-15T18:05:00Z", premium_kind: "gift", premium_until: null }),
    // Старый аккаунт без номера и без имени.
    user({ id: "b", username: "bob", phone: null, online: true }),
  ]);
  await open();
  const rows = [...host.querySelectorAll("[class*=row]")].map((row) => row.textContent ?? "");
  const alice = rows.find((text) => text.includes("@alice"))!;
  expect(alice).toContain("Алиса Иванова");
  expect(alice).toContain(`Регистрация: ${new Date("2026-11-01T09:30:00Z").toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}`);
  expect(alice).toContain(`В сети: ${new Date("2026-11-15T18:05:00Z").toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}`);
  expect(alice).toContain("Premium выдан, бессрочно");
  const bob = rows.find((text) => text.includes("@bob"))!;
  expect(bob).toContain("имя не указано");
  expect(bob).toContain("В сети: сейчас");
  expect(bob).toContain("Premium нет");
  expect(host.textContent).toContain("Всего: 2");
});

it("loads the list page by page until the end", async () => {
  const many = Array.from({ length: 200 }, (_, i) => user({ id: `p${i}`, username: `user${String(i).padStart(3, "0")}` }));
  vi.mocked(adminApi.users).mockImplementation(async ({ offset = 0 }) => (offset === 0 ? many : [user({ id: "last", username: "zed" })]));
  await open();
  expect(vi.mocked(adminApi.users).mock.calls.map(([params]) => params.offset)).toEqual([0, 200]);
  expect(host.textContent).toContain("Всего: 201");
  expect(host.textContent).toContain("@zed");
});

it("gifts Premium for a month, a year or forever", async () => {
  vi.mocked(adminApi.users).mockResolvedValue([user({ id: "a", username: "alice" })]);
  vi.mocked(adminApi.grantPremium).mockResolvedValue(user({ id: "a", username: "alice", premium_kind: "gift", premium_until: "2027-11-16T10:00:00Z" }));
  await open();
  await act(async () => button("Выдать Premium").click());
  expect(["1 месяц", "1 год", "Бессрочно"].map((label) => !!button(label))).toEqual([true, true, true]);
  await act(async () => button("1 год").click());
  await flush();
  expect(adminApi.grantPremium).toHaveBeenCalledWith("a", 12);
  expect(host.textContent).toContain("Premium выдан до 16 ноября 2027");
});
