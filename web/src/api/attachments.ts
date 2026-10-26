import { http } from "./client";

export const attachmentsApi = {
  /** Тело — уже зашифрованные байты (картинки, голосового, файла). */
  upload: (chatId: string, blob: Uint8Array, onProgress?: (share: number) => void) =>
    http
      .post<{ id: string; size: number }>(`/chats/${chatId}/attachments`, blob, {
        headers: { "Content-Type": "application/octet-stream" },
        onUploadProgress: onProgress
          ? (e) => onProgress(e.total ? Math.min(1, e.loaded / e.total) : 0)
          : undefined,
      })
      .then((r) => r.data),

  download: (chatId: string, id: string) =>
    http
      .get<ArrayBuffer>(`/chats/${chatId}/attachments/${id}`, { responseType: "arraybuffer" })
      .then((r) => new Uint8Array(r.data)),
};
