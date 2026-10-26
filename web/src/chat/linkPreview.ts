/**
 * Превью ссылки. Собирает отправитель: сервер Quazar открывает страницу (POST /link-preview),
 * картинку устройство уменьшает само. В чатах превью уходит внутри сообщения —
 * «LNK1:{"body","preview"}» — и в личных чатах шифруется вместе с ним, так что получатели
 * ничего не скачивают. В Спутниках превью — отдельное поле сообщения.
 * Тот же формат — в mobile/src/chat/linkPreview.ts.
 */
import { http } from "../api/client";
import { splitLinks } from "../utils/linkify";

export const PREVIEW_PREFIX = "LNK1:";
const PREFS_KEY = "quazar-link-previews";
const THUMB = 320;

export interface LinkPreview {
  url: string;
  title: string;
  description: string;
  site: string;
  /** data:image/jpeg;base64,… — уже уменьшенная. */
  image: string | null;
}

/** Первая ссылка в тексте (её и показываем превью). */
export function firstLink(text: string): string | null {
  const link = splitLinks(text).find((p) => p.type === "link");
  return link && link.type === "link" ? link.href : null;
}

function cleanPreview(raw: unknown): LinkPreview | null {
  const p = raw as Partial<LinkPreview> | null;
  if (!p || typeof p.url !== "string" || !/^https?:\/\//.test(p.url) || typeof p.title !== "string" || !p.title) {
    return null;
  }
  const image = typeof p.image === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(p.image) ? p.image : null;
  return {
    url: p.url,
    title: p.title.slice(0, 200),
    description: typeof p.description === "string" ? p.description.slice(0, 300) : "",
    site: typeof p.site === "string" ? p.site.slice(0, 100) : "",
    image,
  };
}

export function encodeWithPreview(body: string, preview: LinkPreview): string {
  return PREVIEW_PREFIX + JSON.stringify({ body, preview });
}

/** Снять обёртку превью: текст и превью (null — без превью). */
export function unwrapPreview(payload: string): { payload: string; preview: LinkPreview | null } {
  if (!payload.startsWith(PREVIEW_PREFIX)) return { payload, preview: null };
  try {
    const raw = JSON.parse(payload.slice(PREVIEW_PREFIX.length));
    if (typeof raw?.body !== "string" || raw.body.startsWith(PREVIEW_PREFIX)) return { payload, preview: null };
    return { payload: raw.body, preview: cleanPreview(raw.preview) };
  } catch {
    return { payload, preview: null };
  }
}

export function previewsEnabled(): boolean {
  try {
    return localStorage.getItem(PREFS_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setPreviewsEnabled(on: boolean): void {
  try {
    localStorage.setItem(PREFS_KEY, on ? "on" : "off");
  } catch {
    // ignore
  }
}

/** Картинку страницы — в JPEG до 320 px: так она поместится в сообщение. */
async function shrink(dataUrl: string): Promise<string | null> {
  try {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const scale = Math.min(1, THUMB / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")?.drawImage(img, 0, 0, w, h);
    const out = canvas.toDataURL("image/jpeg", 0.72);
    return out.length <= 100_000 ? out : null;
  } catch {
    return null;
  }
}

const cache = new Map<string, Promise<LinkPreview | null>>();

/** Превью ссылки (с кэшем на сессию). Ошибки — null: превью необязательно. */
export function fetchPreview(url: string): Promise<LinkPreview | null> {
  let pending = cache.get(url);
  if (!pending) {
    pending = http
      .post<LinkPreview | null>("/link-preview", { url })
      .then(async (r) => {
        const raw = r.data;
        if (!raw) return null;
        return cleanPreview({ ...raw, image: raw.image ? await shrink(raw.image) : null });
      })
      .catch(() => null);
    cache.set(url, pending);
  }
  return pending;
}
