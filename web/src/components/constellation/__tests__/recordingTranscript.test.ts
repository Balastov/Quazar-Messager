import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import RecordingTranscript from "../RecordingTranscript";
import { starsApi, type RecordingTranscript as Transcript } from "../../../api/stars";

vi.mock("../../../store/auth", () => ({ useAuthStore: (select: (state: unknown) => unknown) => select({ user: { id: "user" } }) }));
vi.mock("../../../api/stars", () => ({ starsApi: { recordingTranscript: vi.fn(), transcribeRecording: vi.fn() } }));
const idle: Transcript = { enabled: true, status: "idle", text: "", processed_seconds: 0, total_seconds: 0, error: null };
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(starsApi.recordingTranscript).mockResolvedValue({ ...idle });
  vi.mocked(starsApi.transcribeRecording).mockResolvedValue({ ...idle, status: "queued" });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function render() { await act(async () => root.render(createElement(RecordingTranscript, { starId: "star", recordingId: "rec" }))); }
async function click(label: string) {
  const button = [...host.querySelectorAll("button")].find((button) => button.textContent === label);
  expect(button).toBeDefined(); await act(async () => button!.click());
}

it("requires confirmation, then polls a durable background job", async () => {
  await render(); expect(starsApi.transcribeRecording).not.toHaveBeenCalled();
  await click("Расшифровать встречу"); expect(host.textContent).toContain("Cloudflare");
  await click("Отмена"); expect(starsApi.transcribeRecording).not.toHaveBeenCalled();
  await click("Расшифровать встречу");
  vi.mocked(starsApi.recordingTranscript).mockResolvedValue({ ...idle, status: "running", processed_seconds: 300, total_seconds: 3600 });
  await click("Отправить и расшифровать");
  expect(starsApi.transcribeRecording).toHaveBeenCalledWith("star", "rec");
  expect(host.textContent).toContain("5:00 из 60:00"); expect(host.textContent).toContain("Можно закрыть вкладку");
  vi.mocked(starsApi.recordingTranscript).mockResolvedValue({ ...idle, status: "ready", text: "[00:00:00]\nОбсудили план" });
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(host.textContent).toContain("Расшифровка готова");
  await click("Показать расшифровку"); expect(host.textContent).toContain("Обсудили план");
  expect(starsApi.transcribeRecording).toHaveBeenCalledTimes(1);
});
it("loads a shared completed transcript without starting or charging another job", async () => {
  vi.mocked(starsApi.recordingTranscript).mockResolvedValue({ ...idle, enabled: false, status: "ready", text: "Сохранено для комнаты" });
  await render(); await click("Показать расшифровку");
  expect(host.textContent).toContain("Сохранено для комнаты");
  expect(starsApi.transcribeRecording).not.toHaveBeenCalled();
});
it("preserves partial text and explains where a budget-limited job will resume", async () => {
  vi.mocked(starsApi.recordingTranscript).mockResolvedValue({ ...idle, status: "failed", processed_seconds: 1800,
    total_seconds: 3600, text: "Первая половина", error: "Дневной лимит расшифровки исчерпан" });
  await render(); expect(host.textContent).toContain("30:00"); expect(host.textContent).toContain("Дневной лимит");
  await click("Показать расшифровку"); expect(host.textContent).toContain("Первая половина");
  await click("Продолжить расшифровку"); expect(starsApi.transcribeRecording).not.toHaveBeenCalled();
});
it("does not expose stale text after access is revoked while polling", async () => {
  vi.mocked(starsApi.recordingTranscript).mockResolvedValueOnce({ ...idle, status: "running", text: "Закрытая встреча" });
  await render(); await click("Показать расшифровку");
  expect(host.textContent).toContain("Закрытая встреча");
  vi.mocked(starsApi.recordingTranscript).mockRejectedValue(new Error("forbidden"));
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(host.textContent).not.toContain("Закрытая встреча");
  expect(host.textContent).toContain("Не удалось загрузить");
});
