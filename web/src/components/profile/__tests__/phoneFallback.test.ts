import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Telegram Gateway на сервере не настроен: номера других стран — пока звонком.
vi.mock("../../../api/auth", () => ({ authApi: { providers: vi.fn(async () => ({ yandex: false, phone_verification: true, telegram_codes: false })) } }));
vi.mock("../../../api/phoneVerification", () => ({ phoneVerificationApi: { start: vi.fn(), status: vi.fn() } }));
vi.mock("../../../store/auth", () => ({ useAuthStore: Object.assign(() => null, { getState: () => ({ refreshSession: vi.fn() }) }) }));

const { phoneVerificationApi } = await import("../../../api/phoneVerification");
const { default: PhoneVerification } = await import("../PhoneVerification");
const { default: PhoneCountryHint } = await import("../PhoneCountryHint");

let host: HTMLDivElement, root: Root;
const uk = "+447911123456";
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("without Telegram codes a foreign number is confirmed by the call and warned about the cost", async () => {
  vi.mocked(phoneVerificationApi.start).mockResolvedValue({ state: "pending", method: "call", phone: uk, call_phone: "+79863067372",
    verification_token: "t".repeat(48), expires_at: new Date(Date.now() + 300_000).toISOString() });
  await act(async () => root.render(createElement("div", null,
    createElement(PhoneCountryHint, { phone: "+44 7911 123456" }),
    createElement(PhoneVerification, { phone: uk, onVerified: vi.fn() }))));
  await act(async () => { await Promise.resolve(); });
  expect(host.textContent).toContain("подтверждается звонком на российский номер");
  expect(host.textContent).not.toContain("Telegram");
  const button = [...host.querySelectorAll("button")].find(b => b.textContent === "Подтвердить телефон звонком")!;
  await act(async () => button.click());
  expect(host.querySelector("a")?.getAttribute("href")).toBe("tel:+79863067372");
  expect(host.textContent).toContain("плату за международный звонок");
  expect(host.querySelector("input[aria-label='Код из Telegram']")).toBeNull();
});
