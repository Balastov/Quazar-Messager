import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import VoiceTranscript from "../VoiceTranscript";
import { cachedVoiceTranscript, transcriptionEnabled, transcribeVoice } from "../../../attachments/transcription";
import type { VoiceRef } from "../../../attachments/voice";

vi.mock("../../../store/auth", () => ({ useAuthStore: (select: (state: unknown) => unknown) => select({ user: { id: "user" } }) }));
vi.mock("../../../attachments/transcription", () => ({
  cachedVoiceTranscript: vi.fn(), transcriptionEnabled: vi.fn(), transcribeVoice: vi.fn(),
}));
const voice: VoiceRef = { id: "voice", key: "key", mime: "audio/webm", dur: 12, size: 10, wave: [] };
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(cachedVoiceTranscript).mockReturnValue(undefined);
  vi.mocked(transcriptionEnabled).mockResolvedValue(true);
  vi.mocked(transcribeVoice).mockResolvedValue("Привет, мир!");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = async () => { await act(async () => root.render(createElement(VoiceTranscript, { chatId: "chat", voice }))); };
const click = async (label: string) => {
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent === label);
  expect(button).toBeDefined(); await act(async () => button!.click());
};
it("sends nothing until explicit confirmation; cancel keeps the audio private", async () => {
  await render(); await click("Расшифровать");
  expect(host.textContent).toContain("Cloudflare"); expect(transcribeVoice).not.toHaveBeenCalled();
  await click("Отмена"); expect(transcribeVoice).not.toHaveBeenCalled();
  await click("Расшифровать"); await click("Отправить и расшифровать");
  expect(transcribeVoice).toHaveBeenCalledOnce(); expect(host.textContent).toContain("Привет, мир!");
});
it("hides the action when backend is not configured", async () => {
  vi.mocked(transcriptionEnabled).mockResolvedValue(false);
  await render(); expect(host.querySelector("button")).toBeNull(); expect(transcribeVoice).not.toHaveBeenCalled();
});
it("shows cached text without sending it again", async () => {
  vi.mocked(cachedVoiceTranscript).mockReturnValue(Promise.resolve("Уже готово"));
  await render(); expect(host.textContent).toContain("Уже готово"); expect(transcribeVoice).not.toHaveBeenCalled();
});
