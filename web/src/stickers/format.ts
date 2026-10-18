/**
 * Стикер в сообщении — текст «STK1:<pack>/<id>». В личных чатах он шифруется как обычное
 * сообщение, поэтому сервер не знает, что отправили стикер.
 */

export const STICKER_PREFIX = "STK1:";
const STICKER_RE = /^STK1:([a-z0-9_]{2,32})\/([A-Za-z0-9_-]{1,64})$/;

export interface StickerRef {
  pack: string;
  id: string;
}

export function encodeSticker(pack: string, id: string): string {
  return `${STICKER_PREFIX}${pack}/${id}`;
}

export function parseSticker(payload: string): StickerRef | null {
  const m = STICKER_RE.exec(payload);
  return m ? { pack: m[1], id: m[2] } : null;
}

/** Текст для списка чатов и уведомлений: «Стикер 😂». */
export function stickerPreview(emoji: string | undefined): string {
  return emoji ? `Стикер ${emoji}` : "Стикер";
}
