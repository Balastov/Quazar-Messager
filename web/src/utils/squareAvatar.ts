/**
 * Аватар перед загрузкой: квадрат по центру, не больше 512 px. GIF не трогаем — сохраняем анимацию.
 * Сервер всё равно проверяет тип по сигнатуре и размер (до 3 МБ).
 */
import { detectImageMime, fitSize, imageBlob } from "../attachments/image";

export const AVATAR_SIDE = 512;
const MAX_AVATAR_BYTES = 3 * 1024 * 1024;

/** Квадрат по центру исходника: откуда вырезать и какого размера сделать. */
export function squareCrop(w: number, h: number, maxSide = AVATAR_SIDE) {
  const side = Math.min(w, h);
  return {
    sx: Math.floor((w - side) / 2),
    sy: Math.floor((h - side) / 2),
    side,
    out: fitSize(side, side, maxSide, maxSide).width,
  };
}

export async function squareAvatar(file: File): Promise<Blob> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = detectImageMime(bytes);
  if (!mime) throw new Error("Подойдёт картинка JPEG, PNG, WebP или GIF");
  if (mime === "image/gif") {
    if (bytes.length > MAX_AVATAR_BYTES) throw new Error("GIF должен быть не больше 3 МБ");
    return imageBlob(bytes, mime);
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(imageBlob(bytes, mime), { imageOrientation: "from-image" });
  } catch {
    throw new Error("Не удалось открыть картинку — файл повреждён?");
  }
  const { sx, sy, side, out } = squareCrop(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("Не удалось обработать картинку");
  }
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, out, out);
  bitmap.close();
  // WebP сохраняет прозрачность; где браузер его не умеет, toBlob вернёт PNG.
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/webp", 0.9)
  );
  if (!blob) throw new Error("Не удалось обработать картинку");
  return blob;
}
