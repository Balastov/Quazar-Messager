import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { http } from "../../api/client";
import { loadVoiceUrl } from "../cache";
import { cachedVoiceTranscript, clearVoiceTranscripts, transcriptionEnabled, transcribeVoice } from "../transcription";
import type { VoiceRef } from "../voice";

vi.mock("../../api/client", () => ({ http: {
  get: vi.fn(), post: vi.fn(), defaults: { headers: { common: { Authorization: "Bearer user-one" } } },
} }));
vi.mock("../cache", () => ({ loadVoiceUrl: vi.fn() }));
const voice: VoiceRef = { id: "voice", key: "secret-key", mime: "audio/webm", dur: 12, size: 10, wave: [] };
beforeEach(() => {
  clearVoiceTranscripts(); vi.clearAllMocks();
  http.defaults.headers.common.Authorization = "Bearer user-one";
  vi.mocked(loadVoiceUrl).mockResolvedValue("blob:voice");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(["audio"], { type: "audio/webm" }) }));
  vi.mocked(http.post).mockResolvedValue({ data: { text: "Привет" } });
});
afterEach(() => vi.unstubAllGlobals());

it("shares pending and completed requests, sends audio and explicit consent without attachment key", async () => {
  const first = transcribeVoice("user", "chat", voice);
  expect(transcribeVoice("user", "chat", voice)).toBe(first);
  expect(await first).toBe("Привет");
  expect(await transcribeVoice("user", "chat", voice)).toBe("Привет");
  expect(http.post).toHaveBeenCalledTimes(1);
  const [url, body, options] = vi.mocked(http.post).mock.calls[0];
  expect(url).toBe("/chats/chat/attachments/voice/transcribe");
  expect(body).toBeInstanceOf(Blob);
  expect(options?.headers?.["X-Transcription-Consent"]).toBe("cloudflare");
  expect(JSON.stringify(options)).not.toContain("secret-key");
  expect(cachedVoiceTranscript("other-user", "chat", voice.id)).toBeUndefined();
});
it("allows manual retry after error and clears results on logout", async () => {
  vi.mocked(http.post).mockRejectedValueOnce(new Error("quota"));
  await expect(transcribeVoice("user", "chat", voice)).rejects.toThrow("quota");
  expect(cachedVoiceTranscript("user", "chat", voice.id)).toBeUndefined();
  expect(await transcribeVoice("user", "chat", voice)).toBe("Привет");
  clearVoiceTranscripts();
  expect(cachedVoiceTranscript("user", "chat", voice.id)).toBeUndefined();
});
it("does not upload old audio after switching accounts while loading", async () => {
  vi.mocked(loadVoiceUrl).mockImplementationOnce(async () => {
    http.defaults.headers.common.Authorization = "Bearer another-user";
    return "blob:voice";
  });
  await expect(transcribeVoice("user", "chat", voice)).rejects.toThrow("Сессия изменилась");
  expect(http.post).not.toHaveBeenCalled();
});
it("checks availability once per user without sending audio", async () => {
  vi.mocked(http.get).mockResolvedValue({ data: { enabled: true } });
  expect(await transcriptionEnabled("user")).toBe(true);
  expect(await transcriptionEnabled("user")).toBe(true);
  expect(http.get).toHaveBeenCalledTimes(1);
  expect(http.post).not.toHaveBeenCalled();
  expect(loadVoiceUrl).not.toHaveBeenCalled();
});
