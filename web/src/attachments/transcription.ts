/** Текст хранится только в памяти вкладки. Ключи вложений на сервер не отправляются. */
import { http } from "../api/client";
import { loadVoiceUrl } from "./cache";
import type { VoiceRef } from "./voice";

const results = new Map<string, Promise<string>>();
const statuses = new Map<string, Promise<boolean>>();

export function clearVoiceTranscripts(): void {
  results.clear();
  statuses.clear();
}

export function cachedVoiceTranscript(userId: string, chatId: string, voiceId: string): Promise<string> | undefined {
  return results.get(`${userId}:${chatId}:${voiceId}`);
}

export function transcriptionEnabled(userId: string): Promise<boolean> {
  let result = statuses.get(userId);
  if (!result) {
    result = http.get<{ enabled: boolean }>("/transcription/status")
      .then(({ data }) => data.enabled)
      .catch(() => { statuses.delete(userId); return false; });
    statuses.set(userId, result);
  }
  return result;
}

export function transcribeVoice(userId: string, chatId: string, voice: VoiceRef): Promise<string> {
  const key = `${userId}:${chatId}:${voice.id}`;
  const cached = results.get(key);
  if (cached) return cached;
  const authorization = http.defaults.headers.common["Authorization"];
  const result = (async () => {
    const url = await loadVoiceUrl(chatId, voice);
    const response = await fetch(url);
    if (!response.ok) throw new Error("Голосовое недоступно");
    const blob = await response.blob();
    if (!authorization || http.defaults.headers.common["Authorization"] !== authorization) {
      throw new Error("Сессия изменилась. Откройте голосовое снова");
    }
    const { data } = await http.post<{ text: string }>(
      `/chats/${encodeURIComponent(chatId)}/attachments/${encodeURIComponent(voice.id)}/transcribe`,
      blob,
      { headers: { "Content-Type": blob.type, "X-Transcription-Consent": "cloudflare", Authorization: authorization }, timeout: 120_000 },
    );
    return data.text;
  })();
  // Повторные нажатия/два пузыря одного вложения используют один запрос.
  results.set(key, result);
  result.catch(() => { if (results.get(key) === result) results.delete(key); });
  return result;
}
