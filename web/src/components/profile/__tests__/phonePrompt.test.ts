import {act, createElement} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, beforeEach, expect, it, vi} from "vitest";

vi.mock("../../../store/auth", async () => {
  const {create} = await import("zustand");
  const store = create<any>((set) => ({user: null, phonePromptPending: false,
    dismissPhonePrompt: () => set({phonePromptPending: false})}));
  return {useAuthStore: store};
});
vi.mock("../../../api/phoneVerification", () => ({phoneVerificationApi: {reminder: vi.fn()}}));
vi.mock("../PhoneVerification", () => ({default: () => null}));
const {useAuthStore} = await import("../../../store/auth");
const {phoneVerificationApi} = await import("../../../api/phoneVerification");
const {default: PhonePrompt} = await import("../PhoneVerificationPrompt");
let host: HTMLDivElement, root: Root;
const before = {due: false, server_time: "2026-11-02T08:59:59Z", next_at: "2026-11-02T09:00:00Z"};
const after = {due: true, server_time: "2026-11-02T09:00:00Z", next_at: "2026-11-09T09:00:00Z"};
const user = {id: "legacy", phone: "+79160001122", phone_verified_at: null, phone_discoverable: true};
function dialog() {return document.querySelector('[role="dialog"]');}
async function close() {
  const button = [...document.querySelectorAll("button")].find(el => el.textContent === "Напомнить позже")!;
  await act(async () => button.click());
}
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useAuthStore.setState({user: user as never, phonePromptPending: false});
  vi.mocked(phoneVerificationApi.reminder).mockResolvedValue(before);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals();});

it("prompts after each new authentication and allows postponing without prompting on rerender", async () => {
  useAuthStore.setState({phonePromptPending: true});
  await act(async () => root.render(createElement(PhonePrompt)));
  expect(dialog()?.textContent).toContain("поможет защитить аккаунт и позволит входить без пароля");
  expect(dialog()?.textContent).not.toContain("дополнительным функциям");
  await close(); expect(dialog()).toBeNull();
  await act(async () => root.render(createElement(PhonePrompt)));
  expect(dialog()).toBeNull();
  await act(async () => useAuthStore.setState({phonePromptPending: true}));
  expect(dialog()).not.toBeNull();
});

it("shows the weekly prompt at Monday noon Moscow using the server clock", async () => {
  vi.mocked(phoneVerificationApi.reminder).mockResolvedValueOnce(before).mockResolvedValueOnce(after)
    .mockResolvedValue({...after, due: false});
  await act(async () => root.render(createElement(PhonePrompt)));
  expect(dialog()).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(dialog()).not.toBeNull();
  await close();
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(dialog()).toBeNull();
});

it("does not reopen a dismissed login prompt when the weekly claim arrives late", async () => {
  let finish!: (value: typeof after) => void;
  vi.mocked(phoneVerificationApi.reminder).mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
  useAuthStore.setState({phonePromptPending: true});
  await act(async () => root.render(createElement(PhonePrompt)));
  await close();
  await act(async () => finish(after));
  expect(dialog()).toBeNull();
});

it("never prompts confirmed accounts or claims reminders for them", async () => {
  useAuthStore.setState({user: {...user, phone_verified_at: "2026-11-01T10:00:00Z"} as never, phonePromptPending: true});
  await act(async () => root.render(createElement(PhonePrompt)));
  expect(dialog()).toBeNull();
  expect(phoneVerificationApi.reminder).not.toHaveBeenCalled();
});

it("does not repeat a dismissed login prompt after a failed weekly claim is retried", async () => {
  vi.mocked(phoneVerificationApi.reminder).mockRejectedValueOnce(new Error("network")).mockResolvedValue(after);
  useAuthStore.setState({phonePromptPending: true});
  await act(async () => root.render(createElement(PhonePrompt)));
  await close();
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(dialog()).toBeNull();
});
