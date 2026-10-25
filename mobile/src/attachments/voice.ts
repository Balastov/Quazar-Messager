/**
 * Голосовое «VOC1:{json}» (формат — web/src/attachments/voice.ts). Записывать и слушать в приложении
 * пока нечем — нужна нативная библиотека звука; показываем плашку с длительностью.
 */
export const VOICE_PREFIX = 'VOC1:';

export interface VoiceInfo {
  /** Секунды. */
  dur: number;
}

export function parseVoice(payload: string): VoiceInfo | null {
  if (!payload.startsWith(VOICE_PREFIX)) {
    return null;
  }
  try {
    const raw = JSON.parse(payload.slice(VOICE_PREFIX.length));
    return typeof raw?.id === 'string' && Number.isFinite(raw.dur) && raw.dur > 0
      ? {dur: raw.dur}
      : null;
  } catch {
    return null;
  }
}

/** 75.4 → «1:15». */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function voicePreview(voice: VoiceInfo): string {
  return `🎤 Голосовое ${formatDuration(voice.dur)}`;
}
