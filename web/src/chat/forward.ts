/**
 * Пересланное сообщение — «FWD1:{"from","body"}»: имя автора и исходное содержимое
 * (текст, «IMG1:…», «VOC1:…», стикер). В личных чатах вся обёртка шифруется вместе
 * с сообщением, так что сервер не знает ни что переслали, ни откуда.
 * Тот же формат — в mobile/src/chat/forward.ts.
 */
import { unwrapPreview, type LinkPreview } from "./linkPreview";
export const FORWARD_PREFIX = "FWD1:";
const MAX_FROM = 64;

export interface Forwarded {
  from: string;
  body: string;
}

export function encodeForward(from: string, body: string): string {
  return FORWARD_PREFIX + JSON.stringify({ from: from.slice(0, MAX_FROM), body });
}

export function parseForward(payload: string): Forwarded | null {
  if (!payload.startsWith(FORWARD_PREFIX)) return null;
  try {
    const raw = JSON.parse(payload.slice(FORWARD_PREFIX.length));
    if (typeof raw?.from !== "string" || typeof raw.body !== "string" || !raw.body) return null;
    // Пересланное пересланного не вкладываем — внутри всегда исходное содержимое.
    if (raw.body.startsWith(FORWARD_PREFIX)) return null;
    return { from: raw.from.slice(0, MAX_FROM), body: raw.body };
  } catch {
    return null;
  }
}

/** Снять обёртки: что показывать, от кого переслано (null — не пересланное) и превью ссылки. */
export function unwrapForward(payload: string): {
  payload: string;
  forwardedFrom: string | null;
  preview: LinkPreview | null;
} {
  const fwd = parseForward(payload);
  const inner = unwrapPreview(fwd ? fwd.body : payload);
  return { payload: inner.payload, forwardedFrom: fwd ? fwd.from : null, preview: inner.preview };
}
