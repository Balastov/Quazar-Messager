import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  token: null as string | null,
  user: null as Record<string, unknown> | null,
  setToken: vi.fn(), setUser: vi.fn(), logout: vi.fn(), refreshSession: vi.fn(),
}));
vi.mock("../../store/auth", () => ({ useAuthStore: Object.assign(
  (selector: (state: typeof auth) => unknown) => selector(auth), { getState: () => auth },
) }));
vi.mock("../../api/oauthProvider", () => ({ oauthProviderApi: { client: vi.fn(), register: vi.fn(), authorize: vi.fn() } }));
vi.mock("../../api/users", () => ({ usersApi: { me: vi.fn(), updateMe: vi.fn() } }));
vi.mock("../../api/phoneVerification", () => ({ phoneVerificationApi: { start: vi.fn(), status: vi.fn() } }));

const { oauthProviderApi } = await import("../../api/oauthProvider");
const { usersApi } = await import("../../api/users");
const { phoneVerificationApi } = await import("../../api/phoneVerification");
const { default: OAuthAuthorizePage } = await import("../OAuthAuthorizePage");

const REDIRECT = "https://www.padma.ru/api/auth/quazar/callback";
const query = (extra: Record<string, string> = {}) => "/oauth/authorize?" + new URLSearchParams({
  response_type: "code", client_id: "padma", redirect_uri: REDIRECT, state: "st",
  code_challenge: "a".repeat(43), code_challenge_method: "S256", ...extra,
}).toString();
const token = "browser-token-".repeat(4);
let host: HTMLDivElement, root: Root;

function button(text: string) {
  const el = [...host.querySelectorAll("button")].find(node => node.textContent?.trim() === text);
  if (!el) throw new Error(`Missing button: ${text}\n${host.textContent}`);
  return el;
}
async function change(selector: string, value: string) {
  const el = host.querySelector<HTMLInputElement>(selector);
  if (!el) throw new Error(`Missing input: ${selector}`);
  await act(async () => { el.value = value; Simulate.change(el); });
}
async function render(path: string) {
  await act(async () => root.render(createElement(MemoryRouter, { initialEntries: [path] },
    createElement(Routes, null,
      createElement(Route, { path: "/oauth/authorize", element: createElement(OAuthAuthorizePage) }),
      createElement(Route, { path: "/auth", element: createElement("p", null, "AUTH PAGE") })))));
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  auth.token = null; auth.user = null;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.mocked(oauthProviderApi.client).mockResolvedValue({ name: "Padma" });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("prompt=create shows the short Padma signup: phone proof, then last and first name only", async () => {
  vi.mocked(phoneVerificationApi.start).mockResolvedValue({ state: "pending", method: "call", phone: "+79160001122",
    call_phone: "+79863067372", verification_token: token, expires_at: new Date(Date.now() + 300_000).toISOString() });
  vi.mocked(phoneVerificationApi.status).mockResolvedValue({ state: "verified", method: "call", phone: "+79160001122",
    call_phone: null, verification_token: null, expires_at: new Date(Date.now() + 300_000).toISOString() });
  vi.mocked(oauthProviderApi.register).mockResolvedValue({ access_token: "session" });
  vi.useFakeTimers();
  try {
    await render(query({ prompt: "create" }));
    expect(host.textContent).toContain("Регистрация для Padma");
    expect(host.textContent).not.toContain("AUTH PAGE");
    await change("input[aria-label='Номер телефона']", "9160001122");
    await act(async () => button("Подтвердить телефон звонком").click());
    await act(async () => vi.advanceTimersByTimeAsync(4000));
  } finally { vi.useRealTimers(); }
  expect(host.querySelector("input[autocomplete=username]")).toBeNull();
  expect(host.querySelector("input[type=email]")).toBeNull();
  expect(host.textContent).not.toContain("Вас можно найти по номеру");
  expect(button("Создать аккаунт").disabled).toBe(true);
  await change("input[aria-label='Фамилия']", "Иванов");
  await change("input[aria-label='Имя']", " Пётр ");
  await act(async () => button("Создать аккаунт").click());
  expect(oauthProviderApi.register).toHaveBeenCalledWith({ client_id: "padma", redirect_uri: REDIRECT, phone: "+79160001122",
    phone_verification_token: token, last_name: "Иванов", first_name: "Пётр" });
  expect(auth.setToken).toHaveBeenCalledWith("session");
  expect(oauthProviderApi.authorize).not.toHaveBeenCalled();
});

it("without prompt=create a signed-out visitor still goes to the normal sign-in", async () => {
  await render(query());
  expect(host.textContent).toContain("AUTH PAGE");
});

it("signup offers the normal sign-in for an existing Quazar account", async () => {
  await render(query({ prompt: "create" }));
  await act(async () => button("Уже есть аккаунт Quazar — войти").click());
  expect(host.textContent).toContain("AUTH PAGE");
  expect(JSON.parse(sessionStorage.getItem("quazar-return-after-login")!).path).toContain("prompt=create");
});

it("a signed-in user without a last name fills it in before Continue; it is saved to the profile", async () => {
  const user = { id: "me", username: "anna", display_name: "Анна", phone: "+79991234512",
    phone_verified_at: "2026-11-01T00:00:00Z", first_name: "Анна", last_name: null };
  auth.token = "t"; auth.user = user;
  vi.mocked(usersApi.me).mockResolvedValue(user as never);
  vi.mocked(usersApi.updateMe).mockResolvedValue({ ...user, last_name: "Иванова" } as never);
  vi.mocked(oauthProviderApi.authorize).mockResolvedValue({ redirect_to: REDIRECT + "?code=c&state=st" });
  const assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, assign });
  await render(query({ prompt: "create" }));
  expect(host.textContent).toContain("Войти в Padma как");
  expect(host.querySelector<HTMLInputElement>("input[aria-label='Имя']")!.value).toBe("Анна");
  expect(button("Продолжить").disabled).toBe(true);
  await change("input[aria-label='Фамилия']", "Иванова");
  await act(async () => button("Продолжить").click());
  expect(usersApi.updateMe).toHaveBeenCalledWith({ last_name: "Иванова", first_name: "Анна" });
  expect(oauthProviderApi.authorize).toHaveBeenCalled();
  expect(vi.mocked(usersApi.updateMe).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(oauthProviderApi.authorize).mock.invocationCallOrder[0]);
});

it("a user with both names sees no name fields", async () => {
  const user = { id: "me", username: "anna", display_name: "Анна Иванова", phone: "+79991234512",
    phone_verified_at: "2026-11-01T00:00:00Z", first_name: "Анна", last_name: "Иванова" };
  auth.token = "t"; auth.user = user;
  vi.mocked(usersApi.me).mockResolvedValue(user as never);
  await render(query());
  expect(host.querySelector("input[aria-label='Фамилия']")).toBeNull();
  expect(button("Продолжить").disabled).toBe(false);
});
