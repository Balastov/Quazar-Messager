/**
 * Превью ссылки «LNK1:{"body","preview"}» (формат — web/src/chat/linkPreview.ts). Само превью
 * в приложении пока не рисуем — показываем текст сообщения.
 */
export const PREVIEW_PREFIX = 'LNK1:';

export function stripPreview(payload: string): string {
  if (!payload.startsWith(PREVIEW_PREFIX)) {
    return payload;
  }
  try {
    const raw = JSON.parse(payload.slice(PREVIEW_PREFIX.length));
    return typeof raw?.body === 'string' && !raw.body.startsWith(PREVIEW_PREFIX) ? raw.body : payload;
  } catch {
    return payload;
  }
}
