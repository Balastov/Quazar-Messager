import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const e2e = vi.hoisted(() => ({
  status: "needs_restore", hasServerBackup: false, hasLocalKey: false, error: null as string | null,
  setRestorePromptOpen: vi.fn(), sync: vi.fn(),
}));
vi.mock("../../../store/e2e", () => ({
  useE2EStore: Object.assign((selector: (value: typeof e2e) => unknown) => selector(e2e), { getState: () => e2e }),
}));
const auth = vi.hoisted(() => ({ user: { id: "alice", username: "alice" }, logout: vi.fn() }));
vi.mock("../../../store/auth", () => ({
  useAuthStore: Object.assign((selector: (value: typeof auth) => unknown) => selector(auth), { getState: () => auth }),
}));
vi.mock("../../../auth/forgetDevice", () => ({ logoutAndForgetDevice: vi.fn() }));
// Хранилище настроек запоминает раздел — ему нужен localStorage до импорта.
const memory = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) });
vi.mock("../../../api/devices", () => ({ devicesApi: { list: vi.fn() } }));
// Содержимое разделов проверяется отдельно — здесь только навигация.
for (const name of ["Profile", "Premium", "Account", "Appearance", "Notifications", "Calls", "Privacy", "Security", "About"]) {
  vi.doMock(`../${name}Section`, () => ({ default: () => createElement("p", null, `content:${name}`) }));
}
const { devicesApi } = await import("../../../api/devices");
const { useUiStore } = await import("../../../store/ui");
const { default: SettingsView } = await import("../../SettingsView");
const { default: KeyHelp } = await import("../KeyHelp");
const { default: LogoutDialog } = await import("../LogoutDialog");
const { logoutAndForgetDevice } = await import("../../../auth/forgetDevice");

let host: HTMLDivElement, root: Root;
const text = () => document.body.textContent ?? "";
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === label);
const section = (id: string) => document.querySelector<HTMLButtonElement>(`[data-settings-section="${id}"]`)!;
const phoneWidth = (phone: boolean) => vi.stubGlobal("matchMedia", (query: string) => ({ matches: phone && query.includes("max-width"), addEventListener() {}, removeEventListener() {} }));
const device = (name: string, current = false, has_account_key?: boolean | null) => ({ id: name, name, current, has_account_key, last_seen_at: "2026-11-09T10:00:00Z", created_at: "2026-11-01T10:00:00Z", expires_at: "2026-12-01T10:00:00Z" });
const flush = async () => { for (let i = 0; i < 3; i++) await act(async () => {}); };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  Object.assign(e2e, { status: "needs_restore", hasServerBackup: false, hasLocalKey: false });
  useUiStore.setState({ settingsSection: null });
  vi.mocked(devicesApi.list).mockResolvedValue([]);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

it("shows sections side by side on a computer and remembers the open one", async () => {
  phoneWidth(false);
  await act(async () => root.render(createElement(SettingsView)));
  expect(text()).toContain("content:Profile");
  expect(section("profile").getAttribute("aria-current")).toBe("page");
  // Нет ключа — предупреждение видно над разделом, а у «Безопасности» красная точка.
  expect(text()).toContain("На этом устройстве нет ключей шифрования");
  expect(section("security").querySelector('[aria-label="Нет ключей шифрования"]')).not.toBeNull();
  await act(async () => Simulate.click(section("security")));
  expect(text()).toContain("content:Security");
  expect(text()).not.toContain("content:Profile");
  expect(useUiStore.getState().settingsSection).toBe("security");
  // В самой «Безопасности» о ключе говорит её карточка — без повтора сверху.
  expect(text()).not.toContain("На этом устройстве нет ключей шифрования");
});

it("opens a section as its own screen on a phone and goes back to the list", async () => {
  phoneWidth(true);
  await act(async () => root.render(createElement(SettingsView)));
  expect(text()).toContain("Шумоподавление, микрофон и динамики");
  expect(text()).not.toContain("content:");
  await act(async () => Simulate.click(section("calls")));
  expect(text()).toContain("content:Calls");
  expect(document.querySelector("[data-settings-section]")).toBeNull();
  await act(async () => Simulate.click(document.querySelector('[aria-label="Назад к разделам настроек"]')!));
  expect(text()).not.toContain("content:Calls");
  expect(useUiStore.getState().settingsSection).toBeNull();
});

it("opens plain-language help from the missing key warning", async () => {
  phoneWidth(false);
  await act(async () => root.render(createElement(SettingsView)));
  await act(async () => Simulate.click(button("Что с этим делать?")!));
  await flush();
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Зачем нужны ключи");
  expect(dialog.textContent).toContain("группы, Звёзды и Планеты, звонки");
  await act(async () => Simulate.click(button("Открыть восстановление ключей")!));
  expect(e2e.setRestorePromptOpen).toHaveBeenCalledWith(true);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("recommends the other signed-in device and names it", async () => {
  e2e.hasServerBackup = true;
  vi.mocked(devicesApi.list).mockResolvedValue([device("Этот браузер", true), device("Quazar Desktop · Windows", false, true),
    device("Старый ноутбук"), device("Телефон", false, false)]);
  await act(async () => root.render(createElement(KeyHelp)));
  await flush();
  expect(text()).toContain("Ключ есть здесь: Quazar Desktop · Windows");
  expect(text()).toContain("Может быть ключ и здесь: Старый ноутбук");
  expect(text()).toContain("Ключа нет здесь: Телефон");
  expect(text()).not.toContain("Этот браузер");
  const option = [...document.querySelectorAll("b")].find((node) => node.textContent?.startsWith("1."))!.parentElement!;
  expect(option.textContent).toContain("Ваш вариант");
  expect(text()).toContain("не пароль от аккаунта");
});

it("points a new device to the server backup when no other device is signed in", async () => {
  e2e.hasServerBackup = true;
  await act(async () => root.render(createElement(KeyHelp)));
  await flush();
  expect(text()).toContain("В списке сеансов других устройств нет");
  const option = [...document.querySelectorAll("b")].find((node) => node.textContent?.startsWith("2."))!.parentElement!;
  expect(option.textContent).toContain("Ваш вариант");
});

it("does not promise a way out when there is neither a backup nor another device", async () => {
  await act(async () => root.render(createElement(KeyHelp)));
  await flush();
  expect(text()).not.toContain("Ваш вариант");
  expect(text()).toContain("Копии на сервере нет");
  expect(text()).toContain("Если ключа нет нигде");
});

it("explains a key that was changed on another device", async () => {
  e2e.hasLocalKey = true;
  await act(async () => root.render(createElement(KeyHelp)));
  expect(text()).toContain("ключ аккаунта сменили на другом устройстве");
  expect(text()).toContain("старая переписка им по-прежнему откроется");
});

it("only explains encryption when the key is here", async () => {
  e2e.status = "ready";
  await act(async () => root.render(createElement(KeyHelp)));
  expect(text()).toContain("На этом устройстве ключ есть");
  expect(text()).toContain("Резервной копии пока нет");
  expect(text()).not.toContain("Что делать");
});

it("skips devices known to have no key and points to the backup", async () => {
  e2e.hasServerBackup = true;
  vi.mocked(devicesApi.list).mockResolvedValue([device("Телефон", false, false)]);
  await act(async () => root.render(createElement(KeyHelp)));
  await flush();
  expect(text()).toContain("Ни на одном другом устройстве, где вы сейчас вошли, ключа нет");
  const option = [...document.querySelectorAll("b")].find((node) => node.textContent?.startsWith("2."))!.parentElement!;
  expect(option.textContent).toContain("Ваш вариант");
});

it("signs out normally unless the user asks to wipe the keys", async () => {
  e2e.status = "ready"; e2e.hasServerBackup = true;
  await act(async () => root.render(createElement(LogoutDialog, { onClose: () => {} })));
  await act(async () => Simulate.click(button("Выйти")!));
  expect(auth.logout).toHaveBeenCalledOnce();
  expect(logoutAndForgetDevice).not.toHaveBeenCalled();
});

it("warns before wiping the only copy of the key and wipes on request", async () => {
  e2e.status = "ready";
  vi.mocked(devicesApi.list).mockResolvedValue([device("Этот браузер", true, true), device("Телефон", false, false)]);
  await act(async () => root.render(createElement(LogoutDialog, { onClose: () => {} })));
  await flush();
  const box = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')!;
  await act(async () => Simulate.change(box, { target: { checked: true } } as never));
  expect(text()).toContain("Ключ есть только на этом устройстве, а резервной копии нет");
  await act(async () => Simulate.click(button("Удалить ключи и выйти")!));
  expect(logoutAndForgetDevice).toHaveBeenCalledWith("alice");
  expect(auth.logout).not.toHaveBeenCalled();
});

it("keeps the user signed in when the keys could not be wiped", async () => {
  e2e.status = "ready"; e2e.hasServerBackup = true;
  vi.mocked(logoutAndForgetDevice).mockRejectedValueOnce(new Error("IndexedDB недоступна"));
  await act(async () => root.render(createElement(LogoutDialog, { onClose: () => {} })));
  const box = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')!;
  await act(async () => Simulate.change(box, { target: { checked: true } } as never));
  await act(async () => Simulate.click(button("Удалить ключи и выйти")!));
  await flush();
  expect(text()).toContain("Не удалось стереть ключи — вы остались в аккаунте");
  expect(auth.logout).not.toHaveBeenCalled();
  expect(text()).not.toContain("Ключ есть только на этом устройстве");
});
