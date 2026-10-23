import { http } from "./client";

export const attachmentsApi = {
  /** Тело — уже зашифрованные байты картинки. */
  upload: (chatId: string, blob: Uint8Array) =>
    http
      .post<{ id: string; size: number }>(`/chats/${chatId}/attachments`, blob, {
        headers: { "Content-Type": "application/octet-stream" },
      })
      .then((r) => r.data),

  download: (chatId: string, id: string) =>
    http
      .get<ArrayBuffer>(`/chats/${chatId}/attachments/${id}`, { responseType: "arraybuffer" })
      .then((r) => new Uint8Array(r.data)),
};
