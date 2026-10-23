/**
 * Перед отправкой фото уменьшаем, как Telegram: длинная сторона до 2560 px, JPEG 0.85.
 * Заодно пропадают EXIF (геопозиция, модель телефона). GIF не трогаем — сломается анимация.
 */
import { AttachmentError, fitSize, imageBlob, MAX_IMAGE_BYTES, type ImageMime } from "./image";

export const MAX_SIDE = 2560;
export const JPEG_QUALITY = 0.85;
/** Исходник больше этого не открываем — браузер может не потянуть по памяти. */
export const MAX_SOURCE_BYTES = 50 * 1024 * 1024;

export interface PreparedImage {
  bytes: Uint8Array;
  mime: ImageMime;
  w: number;
  h: number;
}

/**
 * Оставить исходник вместо пережатого JPEG: только PNG/WebP, которым не нужно уменьшение
 * и которые и так не больше (скриншоты часто лучше жмутся в PNG). JPEG пережимаем всегда —
 * ради EXIF с геопозицией.
 */
export function keepOriginal(
  mime: ImageMime,
  resized: boolean,
  originalBytes: number,
  encodedBytes: number
): boolean {
  return mime !== "image/jpeg" && !resized && originalBytes <= encodedBytes;
}

async function decode(bytes: Uint8Array, mime: ImageMime): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(imageBlob(bytes, mime), { imageOrientation: "from-image" });
  } catch {
    throw new AttachmentError("Не удалось открыть картинку — файл повреждён?");
  }
}

export async function prepareImage(bytes: Uint8Array, mime: ImageMime): Promise<PreparedImage> {
  const bitmap = await decode(bytes, mime);
  const srcW = bitmap.width;
  const srcH = bitmap.height;

  if (mime === "image/gif") {
    bitmap.close();
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new AttachmentError("GIF больше 10 МБ — такой не отправить");
    }
    return { bytes, mime, w: srcW, h: srcH };
  }

  const { width, height } = fitSize(srcW, srcH, MAX_SIDE, MAX_SIDE);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new AttachmentError("Не удалось обработать картинку");
  }
  // Прозрачные PNG в JPEG — на белом, а не на чёрном.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY)
  );
  if (!blob) throw new AttachmentError("Не удалось обработать картинку");
  const encoded = new Uint8Array(await blob.arrayBuffer());

  const resized = width !== srcW || height !== srcH;
  const result: PreparedImage = keepOriginal(mime, resized, bytes.length, encoded.length)
    ? { bytes, mime, w: srcW, h: srcH }
    : { bytes: encoded, mime: "image/jpeg", w: width, h: height };
  if (result.bytes.length > MAX_IMAGE_BYTES) {
    throw new AttachmentError("Картинка больше 10 МБ даже после сжатия — такую не отправить");
  }
  return result;
}
