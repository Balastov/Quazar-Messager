import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminTicketDetail } from "../../../api/admin";

const mocks = vi.hoisted(() => ({ refreshSession: vi.fn(), setToken: vi.fn() }));
vi.mock("../../../store/auth", () => ({ useAuthStore: Object.assign(
  (select: (state: typeof mocks) => unknown) => select(mocks), { getState: () => mocks },
) }));
vi.mock("../../../api/auth", () => ({ authApi: {
  providers: vi.fn(), forgotPassword: vi.fn(), signInMethods: vi.fn(), setPassword: vi.fn(),
} }));
vi.mock("../../../api/admin", () => ({ adminApi: { tickets: vi.fn(), ticket: vi.fn(), assignPassword: vi.fn() } }));
vi.mock("../../../auth/reauth", () => ({ reauthCode: () => null, clearReauth: vi.fn(), startReauth: vi.fn() }));
vi.mock("../useUsernameCheck", () => ({ useUsernameCheck: () => ({ state: "idle" }) }));
vi.mock("../../../ws/socket", () => ({ socket: { on: () => () => {} } }));
vi.mock("../../../store/stickers", () => ({ messagePreview: (value: string) => value }));
vi.mock("../../constellation/rules", () => ({ apiError: () => "Не удалось выполнить запрос" }));
vi.mock("../../ChatImage", () => ({ default: () => null }));
vi.mock("../../support/TicketCard", () => ({ default: () => null, TicketStatusChip: () => null }));

const { authApi } = await import("../../../api/auth");
const { adminApi } = await import("../../../api/admin");
const { newPasswordProblem } = await import("../../../auth/password");
const { default: SignInSettings } = await import("../SignInSettings");
const { default: AuthPage } = await import("../../../pages/AuthPage");
const { default: Tickets } = await import("../../blackhole/Tickets");

let host: HTMLDivElement;
let root: Root;
const recovery = { id: "request-1", number: 1, kind: "bug", text: "Забыл пароль", images: [],
  status: "queued", recovery_login: "@alice", password_reset_at: null, author: null, unread: 0,
  chat_id: "support-chat", created_at: "2026-11-02T10:00:00Z", messages: [],
} as unknown as AdminTicketDetail;
function button(text: string): HTMLButtonElement {
  const result = [...document.querySelectorAll("button")].find(el => el.textContent?.trim() === text);
  if (!result) throw new Error(`Missing button: ${text}`);
  return result;
}
async function input(label: string, value: string) {
  const el = document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  expect(el).not.toBeNull();
  await act(async () => { el.value = value; Simulate.change(el); });
}
async function submit(form: HTMLFormElement) { await act(async () => Simulate.submit(form)); }
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.mocked(authApi.providers).mockResolvedValue({ yandex: false });
  vi.mocked(authApi.signInMethods).mockResolvedValue({ has_password: true, identities: [], providers: { yandex: false } });
  vi.mocked(adminApi.tickets).mockResolvedValue([recovery]);
  vi.mocked(adminApi.ticket).mockResolvedValue(recovery);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("password recovery and change", () => {
  it("checks confirmation and bcrypt's UTF-8 limit without rejecting short Unicode passwords", () => {
    expect(newPasswordProblem("пароль123", "пароль123")).toBeNull();
    expect(newPasswordProblem("password1", "password2")).toContain("не совпадают");
    expect(newPasswordProblem("я".repeat(37), "я".repeat(37))).toContain("длинный");
    expect(newPasswordProblem("        ", "        ")).not.toBeNull();
  });

  it("opens recovery from login and sends the claimed login without a password", async () => {
    vi.mocked(authApi.forgotPassword).mockResolvedValue({ message: "Если аккаунт найден, запрос передан администратору." });
    await act(async () => root.render(createElement(MemoryRouter, null, createElement(AuthPage))));
    await act(async () => button("Войти").click());
    await act(async () => button("Забыл пароль").click());
    await input("Логин для восстановления", "  @alice  ");
    await submit(document.querySelector('[role="dialog"] form')!);
    expect(authApi.forgotPassword).toHaveBeenCalledWith("@alice");
    expect(document.querySelector('[role="status"]')?.textContent).toContain("Если аккаунт найден");
    expect(mocks.setToken).not.toHaveBeenCalled();
  });

  it("requires the old password and matching new passwords, then refreshes the current session", async () => {
    vi.mocked(authApi.setPassword).mockResolvedValue({ access_token: "fresh-token", token_type: "bearer" });
    await act(async () => root.render(createElement(SignInSettings)));
    await act(async () => button("Изменить пароль").click());
    await input("Старый пароль", "old-password");
    await input("Новый пароль", "new-password");
    await input("Повторите новый пароль", "mismatched-password");
    expect(button("Изменить пароль").disabled).toBe(true);
    await submit(host.querySelector("form")!);
    expect(authApi.setPassword).not.toHaveBeenCalled();
    await input("Повторите новый пароль", "new-password");
    await submit(host.querySelector("form")!);
    expect(authApi.setPassword).toHaveBeenCalledWith("new-password", {
      currentPassword: "old-password", confirmPassword: "new-password",
    });
    expect(mocks.refreshSession).toHaveBeenCalledWith("fresh-token");
    expect(host.textContent).toContain("Пароль изменён");
    expect(host.querySelector('input[type="password"]')).toBeNull();
  });

  it("keeps the password form open when the old password is incorrect", async () => {
    vi.mocked(authApi.setPassword).mockRejectedValue({ isAxiosError: true, response: { status: 400, data: { detail: "Неверный текущий пароль" } } });
    await act(async () => root.render(createElement(SignInSettings)));
    await act(async () => button("Изменить пароль").click());
    await input("Старый пароль", "wrong-password");
    await input("Новый пароль", "new-password");
    await input("Повторите новый пароль", "new-password");
    await submit(host.querySelector("form")!);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Неверный текущий пароль");
    expect(host.querySelector("form")).not.toBeNull();
    expect(mocks.refreshSession).not.toHaveBeenCalled();
  });

  it("lets Black Hole administrators assign a password only after matching confirmation", async () => {
    const done = { ...recovery, status: "done" as const, password_reset_at: "2026-11-02T11:00:00Z" };
    vi.mocked(adminApi.assignPassword).mockResolvedValue({ ticket: done, access_token: null });
    await act(async () => root.render(createElement(Tickets, { onChange: vi.fn() })));
    await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
    expect(host.textContent).toContain("Указанный логин: @alice");
    await input("Новый пароль пользователя", "assigned-password");
    expect(button("Назначить новый пароль").disabled).toBe(true);
    await input("Повторите новый пароль пользователя", "assigned-password");
    await submit(host.querySelector("form")!);
    expect(adminApi.assignPassword).toHaveBeenCalledWith("request-1", "assigned-password", "assigned-password");
    expect(host.textContent).toContain("Восстановление завершено");
    expect(host.querySelector('input[type="password"]')).toBeNull();
    expect(mocks.refreshSession).not.toHaveBeenCalled();
  });

  it("does not expose password assignment for ordinary error reports", async () => {
    const ordinary = { ...recovery, recovery_login: null };
    vi.mocked(adminApi.tickets).mockResolvedValue([ordinary]);
    vi.mocked(adminApi.ticket).mockResolvedValue(ordinary);
    await act(async () => root.render(createElement(Tickets, { onChange: vi.fn() })));
    await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
    expect(host.textContent).not.toContain("Назначить новый пароль");
  });
});
