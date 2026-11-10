import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AdminNews } from "../../../api/admin";

vi.mock("../../../api/admin", () => ({ adminApi: { news: vi.fn(), editNews: vi.fn(), publishNews: vi.fn(), skipNews: vi.fn(), testNews: vi.fn() } }));
const { adminApi } = await import("../../../api/admin");
const { default: News } = await import("../News");

const draft = (patch: Partial<AdminNews> = {}): AdminNews => ({
  version: "1.0.3", status: "draft", title: "Настройки по разделам", changes: ["Первый пункт.", "Второй пункт."],
  versions: ["1.0.2", "1.0.3"], payload: "", revision: 4, created_at: "2026-11-10T10:00:00Z", updated_at: null, updated_by: null,
  published_at: null, published_by: null, merged_into: null, sent: 0, total: 0, ...patch,
});
let host: HTMLDivElement, root: Root;
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === label)!;
const flush = async () => { for (let i = 0; i < 3; i++) await act(async () => {}); };

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  vi.mocked(adminApi.news).mockResolvedValue({ items: [draft(), draft({ version: "1.0.1", status: "published", payload: "Quazar 1.0.1 · Ключи", sent: 5, total: 6, published_by: "owner" })], recipients: 6 });
  vi.mocked(adminApi.editNews).mockImplementation(async (version, text) => draft({ version, ...text, revision: 5 }));
  vi.mocked(adminApi.publishNews).mockResolvedValue(draft({ status: "published" }));
  vi.stubGlobal("confirm", vi.fn(() => true));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(News, { onChange: () => {} })));
  await flush();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("shows the merged draft with a live preview of the bot message", async () => {
  expect(host.textContent).toContain("Объединяет выпуски 1.0.2, 1.0.3");
  const preview = host.querySelector("pre")!;
  expect(preview.textContent).toBe("Quazar 1.0.3 · Настройки по разделам\n\n• Первый пункт.\n• Второй пункт.");
  const second = host.querySelector<HTMLTextAreaElement>('[aria-label="Пункт 2"]')!;
  await act(async () => Simulate.change(second, { target: { value: "Исправлено\nв одну строку." } } as never));
  expect(preview.textContent).toContain("• Исправлено в одну строку.");
  expect(host.textContent).toContain("доставлено 5 из 6");
});

it("saves the edits and publishes exactly the reviewed revision", async () => {
  const items = [...host.querySelectorAll("li")];
  // «Выше» у первого пункта недоступна — двигаем второй.
  await act(async () => Simulate.click(items[1].querySelector<HTMLButtonElement>('[aria-label="Выше"]')!));
  await act(async () => Simulate.click(button("Опубликовать")));
  await flush();
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("всем пользователям (6)"));
  expect(adminApi.editNews).toHaveBeenCalledWith("1.0.3", { title: "Настройки по разделам", changes: ["Второй пункт.", "Первый пункт."] }, 4);
  expect(adminApi.publishNews).toHaveBeenCalledWith("1.0.3", 5);
});

it("publishes without saving when nothing changed and blocks invalid text", async () => {
  await act(async () => Simulate.click(button("Опубликовать")));
  await flush();
  expect(adminApi.editNews).not.toHaveBeenCalled();
  expect(adminApi.publishNews).toHaveBeenCalledWith("1.0.3", 4);
  const title = host.querySelector<HTMLInputElement>("input")!;
  await act(async () => Simulate.change(title, { target: { value: " " } } as never));
  expect(host.textContent).toContain("Добавьте заголовок");
  expect(button("Опубликовать").disabled).toBe(true);
});
