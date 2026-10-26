/**
 * Пересланное сообщение — «FWD1:{"from","body"}» (формат — web/src/chat/forward.ts).
 * В личных чатах обёртка зашифрована вместе с сообщением.
 */
import {stripPreview} from './linkPreview';

export const FORWARD_PREFIX = 'FWD1:';

/** Снять обёртки: что показывать и от кого переслано (null — не пересланное); превью ссылки — убрать. */
export function unwrapForward(payload: string): {payload: string; forwardedFrom: string | null} {
  if (!payload.startsWith(FORWARD_PREFIX)) {
    return {payload: stripPreview(payload), forwardedFrom: null};
  }
  try {
    const raw = JSON.parse(payload.slice(FORWARD_PREFIX.length));
    if (typeof raw?.from === 'string' && typeof raw.body === 'string' && raw.body && !raw.body.startsWith(FORWARD_PREFIX)) {
      return {payload: stripPreview(raw.body), forwardedFrom: raw.from.slice(0, 64)};
    }
  } catch {
    // битая обёртка — показываем как есть
  }
  return {payload, forwardedFrom: null};
}
