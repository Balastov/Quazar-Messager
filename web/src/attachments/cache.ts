/** Расшифрованные картинки и голосовые как blob: URL — одна загрузка на вложение за сессию. */
import { attachmentsApi } from "../api/attachments";
import { decryptFile, detectImageMime, imageBlob, type ImageRef } from "./image";
import { detectVoiceMime, type VoiceRef } from "./voice";

const urls = new Map<string, Promise<string>>();

/** Своя только что отправленная картинка — показываем сразу, без скачивания. */
export function seedImageUrl(id: string, bytes: Uint8Array, mime: string): void {
  urls.set(id, Promise.resolve(URL.createObjectURL(imageBlob(bytes, mime))));
}

export function loadImageUrl(chatId: string, ref: ImageRef): Promise<string> {
  let url = urls.get(ref.id);
  if (!url) {
    url = attachmentsApi.download(chatId, ref.id).then((blob) => {
      const bytes = decryptFile(blob, ref.key);
      // Тип берём из самих байтов, а не из сообщения: blob: URL не станет HTML/SVG.
      const mime = bytes && detectImageMime(bytes);
      if (!bytes || !mime) throw new Error("Не удалось расшифровать картинку");
      return URL.createObjectURL(imageBlob(bytes, mime));
    });
    url.catch(() => urls.delete(ref.id));
    urls.set(ref.id, url);
  }
  return url;
}

/** Своё только что записанное голосовое — играем сразу, без скачивания. */
export function seedVoiceUrl(id: string, bytes: Uint8Array, mime: string): void {
  urls.set(id, Promise.resolve(URL.createObjectURL(imageBlob(bytes, mime))));
}

export function loadVoiceUrl(chatId: string, ref: VoiceRef): Promise<string> {
  let url = urls.get(ref.id);
  if (!url) {
    url = attachmentsApi.download(chatId, ref.id).then((blob) => {
      const bytes = decryptFile(blob, ref.key);
      // Тип — по самим байтам: blob: URL не станет ничем, кроме звука.
      const mime = bytes && detectVoiceMime(bytes);
      if (!bytes || !mime) throw new Error("Не удалось расшифровать голосовое");
      return URL.createObjectURL(imageBlob(bytes, mime));
    });
    url.catch(() => urls.delete(ref.id));
    urls.set(ref.id, url);
  }
  return url;
}
