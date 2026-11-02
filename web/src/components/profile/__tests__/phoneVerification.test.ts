import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ setToken: vi.fn(), setUser: vi.fn(), user: { id: "me", phone: "+79160001122", phone_verified_at: null } }));
vi.mock("../../../store/auth", () => ({ useAuthStore: Object.assign(
  (selector: (state: typeof auth) => unknown) => selector(auth), { getState: () => auth },
) }));
vi.mock("../../../api/phoneVerification", () => ({ phoneVerificationApi: { start: vi.fn(), status: vi.fn() } }));
vi.mock("../../../api/auth", () => ({ authApi: { providers: vi.fn(), register: vi.fn() } }));
vi.mock("../../../api/users", () => ({ usersApi: { me: vi.fn() } }));
vi.mock("../../../auth/reauth", () => ({ reauthCode: () => null }));
vi.mock("../useUsernameCheck", () => ({ useUsernameCheck: () => ({ state: "ok" }) }));

const { phoneVerificationApi } = await import("../../../api/phoneVerification");
const { authApi } = await import("../../../api/auth");
const { usersApi } = await import("../../../api/users");
const { default: PhoneVerification } = await import("../PhoneVerification");
const { default: PhoneVerificationSetting } = await import("../PhoneVerificationSetting");
const { default: AuthPage } = await import("../../../pages/AuthPage");

let host: HTMLDivElement, root: Root;
const phone = "+79160001122", token = "test-browser-token".repeat(3);
const pending = () => ({ state: "pending" as const, phone, call_phone: "+79863067372",
  verification_token: token, expires_at: new Date(Date.now() + 300_000).toISOString() });
function button(text: string) {
  const el = [...host.querySelectorAll("button")].find(node => node.textContent?.trim() === text);
  if (!el) throw new Error(`Missing button: ${text}`);
  return el;
}
async function change(selector: string, value: string) {
  const el = host.querySelector<HTMLInputElement>(selector)!;
  expect(el).not.toBeNull();
  await act(async () => { el.value = value; Simulate.change(el); });
}
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); sessionStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.mocked(authApi.providers).mockResolvedValue({ yandex: false, phone_verification: true });
  vi.mocked(phoneVerificationApi.start).mockImplementation(async () => pending());
  vi.mocked(phoneVerificationApi.status).mockImplementation(async () => ({ ...pending(), verification_token: null, state: "verified" }));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); sessionStorage.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("starts verification only after a click and exposes the provider's dial number", async () => {
  const verified = vi.fn();
  await act(async () => root.render(createElement(PhoneVerification, { phone, onVerified: verified })));
  expect(phoneVerificationApi.start).not.toHaveBeenCalled();
  await act(async () => button("Подтвердить телефон звонком").click());
  expect(phoneVerificationApi.start).toHaveBeenCalledWith(phone, false);
  expect(host.querySelector("a")?.getAttribute("href")).toBe("tel:+79863067372");
  expect(verified).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(4000));
  expect(phoneVerificationApi.status).toHaveBeenCalledWith(token, false);
  expect(verified).toHaveBeenCalledWith(token);
  expect(host.textContent).toContain("Телефон подтверждён");
});

it("resumes a pending verification after page reload without creating another paid request", async () => {
  sessionStorage.setItem(`quazar-phone-check:false:${phone}`, JSON.stringify(pending()));
  const verified = vi.fn();
  await act(async () => root.render(createElement(PhoneVerification, { phone, onVerified: verified })));
  expect(host.querySelector("a")?.getAttribute("href")).toBe("tel:+79863067372");
  expect(verified).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(4000));
  expect(verified).toHaveBeenCalledWith(token);
  expect(phoneVerificationApi.start).not.toHaveBeenCalled();
});

it("never treats a provider error or an expired verification as success", async () => {
  const verified = vi.fn();
  vi.mocked(phoneVerificationApi.status).mockRejectedValueOnce(new Error("unavailable"))
    .mockResolvedValueOnce({ ...pending(), state: "expired" });
  await act(async () => root.render(createElement(PhoneVerification, { phone, onVerified: verified })));
  await act(async () => button("Подтвердить телефон звонком").click());
  await act(async () => vi.advanceTimersByTimeAsync(4000));
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(verified).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(8000));
  expect(host.textContent).toContain("Время проверки истекло");
  expect(verified).not.toHaveBeenCalled();
  expect(button("Подтвердить телефон звонком")).toBeDefined();
});

it("ignores a late result for the previous phone and stops polling after unmount", async () => {
  let finish!: (value: ReturnType<typeof pending>) => void;
  vi.mocked(phoneVerificationApi.start).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const verified = vi.fn();
  await act(async () => root.render(createElement(PhoneVerification, { phone, onVerified: verified })));
  await act(async () => button("Подтвердить телефон звонком").click());
  await act(async () => root.render(createElement(PhoneVerification, { phone: "+79160001123", onVerified: verified })));
  await act(async () => finish(pending()));
  expect(host.querySelector("a")).toBeNull();
  await act(async () => root.render(null));
  await act(async () => vi.advanceTimersByTimeAsync(20_000));
  expect(phoneVerificationApi.status).not.toHaveBeenCalled();
  expect(verified).not.toHaveBeenCalled();
});

it("requires a phone check before completing registration and sends its one-time proof", async () => {
  vi.mocked(authApi.register).mockResolvedValue({ access_token: "fresh-session", token_type: "bearer" });
  await act(async () => root.render(createElement(MemoryRouter, { future: { v7_startTransition: true, v7_relativeSplatPath: true } }, createElement(AuthPage))));
  await act(async () => button("Создать аккаунт").click());
  await change('input[type="tel"]', phone);
  await change('input[placeholder="никнейм"]', "new_user");
  await change('input[type="password"]', "password123");
  await act(async () => button("Нет").click());
  await act(async () => Simulate.submit(host.querySelector("form")!));
  expect(button("Пропустить").disabled).toBe(true);
  expect(authApi.register).not.toHaveBeenCalled();
  await act(async () => button("Подтвердить телефон звонком").click());
  await act(async () => vi.advanceTimersByTimeAsync(4000));
  expect(button("Пропустить").disabled).toBe(false);
  await act(async () => button("Пропустить").click());
  expect(authApi.register).toHaveBeenCalledWith(expect.objectContaining({ phone, phone_verification_token: token }));
  expect(auth.setToken).toHaveBeenCalledWith("fresh-session");
});

it("confirms an existing user's number from settings and reloads the updated profile", async () => {
  vi.mocked(usersApi.me).mockResolvedValue({ ...auth.user, phone_verified_at: new Date().toISOString() } as never);
  await act(async () => root.render(createElement(PhoneVerificationSetting)));
  await act(async () => button("Подтвердить телефон звонком").click());
  expect(phoneVerificationApi.start).toHaveBeenCalledWith(phone, true);
  await act(async () => vi.advanceTimersByTimeAsync(4000));
  expect(phoneVerificationApi.status).toHaveBeenCalledWith(token, true);
  expect(auth.setUser).toHaveBeenCalledWith(expect.objectContaining({ phone_verified_at: expect.any(String) }));
});

it("shows verification when the initial capability request fails but registration requires it", async () => {
  vi.mocked(authApi.providers).mockRejectedValueOnce(new Error("network"));
  vi.mocked(authApi.register).mockRejectedValueOnce({ isAxiosError: true,
    response: { data: { detail: "Подтвердите телефон звонком перед регистрацией" } } });
  await act(async () => root.render(createElement(MemoryRouter, { future: { v7_startTransition: true, v7_relativeSplatPath: true } }, createElement(AuthPage))));
  await act(async () => button("Создать аккаунт").click());
  await change('input[type="tel"]', phone);
  await change('input[placeholder="никнейм"]', "new_user");
  await change('input[type="password"]', "password123");
  await act(async () => button("Нет").click());
  await act(async () => Simulate.submit(host.querySelector("form")!));
  await act(async () => button("Пропустить").click());
  expect(button("Подтвердить телефон звонком")).toBeDefined();
  expect(button("Пропустить").disabled).toBe(true);
});
