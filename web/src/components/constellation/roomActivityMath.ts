import type { FocusState, VideoState } from "../../api/roomActivities";

export function focusAt(focus: FocusState | null, serverNow: number): FocusState | null {
  if (!focus?.running || !focus.ends_at || serverNow < Date.parse(focus.ends_at)) return focus;
  let next = { ...focus };
  if (next.phase === "work") {
    next = { ...next, phase: "break", version: next.version + 1, remaining_seconds: next.break_seconds,
      ends_at: new Date(Date.parse(next.ends_at!) + next.break_seconds * 1000).toISOString() };
  }
  if (serverNow >= Date.parse(next.ends_at!)) {
    next = { ...next, phase: "done", running: false, ends_at: null, remaining_seconds: 0, version: next.version + 1 };
  }
  return next;
}

export function remaining(focus: FocusState, serverNow: number): number {
  return focus.running && focus.ends_at ? Math.max(0, (Date.parse(focus.ends_at) - serverNow) / 1000) : focus.remaining_seconds;
}

export function videoTime(video: VideoState, serverNow: number): number {
  const elapsed = video.playing ? Math.max(0, (serverNow - Date.parse(video.updated_at)) / 1000) : 0;
  return Math.max(0, Math.min(video.position + elapsed, video.duration || 86400));
}

export function clock(seconds: number): string {
  const value = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

/** Прямоугольник самого видео внутри object-fit: contain, без чёрных полей. */
export function containedVideo(width: number, height: number, videoWidth: number, videoHeight: number) {
  if (width <= 0 || height <= 0 || videoWidth <= 0 || videoHeight <= 0) return null;
  const scale = Math.min(width / videoWidth, height / videoHeight);
  const w = Math.min(width, videoWidth * scale), h = Math.min(height, videoHeight * scale);
  return { left: (width - w) / 2, top: (height - h) / 2, width: w, height: h };
}

export const BOARD_COLORS = {
  green: "#34d399", purple: "#c084fc", amber: "#fbbf24", pink: "#f472b6", blue: "#60a5fa", white: "#f4f1ff",
};

export function boardPoint(rect: { left: number; top: number; width: number; height: number }, clientX: number, clientY: number) {
  const fit = containedVideo(rect.width, rect.height, 1200, 700);
  if (!fit) return null;
  const x = (clientX - rect.left - fit.left) * 1200 / fit.width;
  const y = (clientY - rect.top - fit.top) * 700 / fit.height;
  return x < 0 || x > 1200 || y < 0 || y > 700 ? null : { x, y };
}

export function pointerColor(userId: string): string {
  let hash = 0;
  for (const char of userId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return Object.values(BOARD_COLORS)[hash % Object.keys(BOARD_COLORS).length];
}

export function wrapBoardText(text: string): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let rest = paragraph;
    while (rest.length > 25) {
      const space = rest.lastIndexOf(" ", 25);
      const cut = space > 8 ? space : 25;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
    lines.push(rest);
  }
  return lines.slice(0, 7).map((line, index) => index === 6 && lines.length > 7 ? `${line.slice(0, 23)}…` : line);
}
