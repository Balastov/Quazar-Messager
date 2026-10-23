/** Расшифрованные картинки как data: URI — одна загрузка на вложение за сессию. */
import {attachmentsApi} from '../api/attachments';
import {encodeB64} from '../crypto/base64';
import {decryptFile, detectImageMime, type ImageRef} from './image';

const uris = new Map<string, Promise<string>>();

function dataUri(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${encodeB64(bytes)}`;
}

/** Своя только что отправленная картинка — показываем сразу, без скачивания. */
export function seedImageUri(id: string, base64: string, mime: string): void {
  uris.set(id, Promise.resolve(`data:${mime};base64,${base64}`));
}

export function loadImageUri(chatId: string, ref: ImageRef): Promise<string> {
  let uri = uris.get(ref.id);
  if (!uri) {
    uri = attachmentsApi.download(chatId, ref.id).then(async blob => {
      const bytes = await decryptFile(blob, ref.key);
      const mime = bytes && detectImageMime(bytes);
      if (!bytes || !mime) {
        throw new Error('Не удалось расшифровать картинку');
      }
      return dataUri(bytes, mime);
    });
    uri.catch(() => uris.delete(ref.id));
    uris.set(ref.id, uri);
  }
  return uri;
}
