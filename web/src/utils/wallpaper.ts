/**
 * Фон приложения — обои body (--qz-wallpaper), которые просвечивают сквозь стеклянные панели.
 * Какой показать: открыт чат с общим фоном → он; открыта Звезда с фоном → он;
 * иначе личный фон пользователя; иначе стандартный из theme.css.
 */
import { AttachmentError, detectImageMime, imageBlob } from "../attachments/image";
import { MAX_SOURCE_BYTES, prepareImage } from "../attachments/compress";

export interface WallpaperSources {
  /** Виден ли сейчас чат (на телефоне — только когда он открыт поверх списка). */
  chatVisible: boolean;
  chatUrl: string | null;
  starVisible: boolean;
  starUrl: string | null;
  personalUrl: string | null;
}

export function pickWallpaper(src: WallpaperSources): string | null {
  if (src.chatVisible && src.chatUrl) return src.chatUrl;
  if (src.starVisible && src.starUrl) return src.starUrl;
  return src.personalUrl;
}

/** Значение --qz-wallpaper: картинка с тем же затемнением, что у стандартного фона. */
export function wallpaperCss(url: string): string {
  return [
    "linear-gradient(180deg, rgba(7, 6, 15, 0.18), rgba(7, 6, 15, 0.45))",
    `url(${JSON.stringify(url)}) center / cover no-repeat`,
    "#07060f",
  ].join(", ");
}

/** Картинка для фона: уменьшить до 2560 px и пережать (как фото в чате). */
export async function prepareBackground(file: File): Promise<Blob> {
  if (file.size > MAX_SOURCE_BYTES) {
    throw new AttachmentError("Файл больше 50 МБ — такую картинку не поставить");
  }
  const source = new Uint8Array(await file.arrayBuffer());
  const mime = detectImageMime(source);
  if (!mime) throw new AttachmentError("Подойдёт картинка JPEG, PNG, WebP или GIF");
  const prepared = await prepareImage(source, mime);
  return imageBlob(prepared.bytes, prepared.mime);
}
