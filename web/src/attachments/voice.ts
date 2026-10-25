/**
 * Голосовое в сообщении — текст «VOC1:{json}» со ссылкой на вложение, ключом к нему,
 * длительностью и формой волны (чтобы нарисовать пузырь, не скачивая звук).
 * Файл шифруется так же, как картинка (attachments/image.ts → encryptFile).
 */
export const VOICE_PREFIX = "VOC1:";
/** Столбиков в форме волны. */
export const WAVE_BARS = 48;
/** Высота столбика: 0…WAVE_MAX. */
export const WAVE_MAX = 31;
/** Дольше — запись останавливается сама (при 32 кбит/с это ~2.4 МБ). */
export const MAX_VOICE_SEC = 10 * 60;
/** Короче — считаем случайным нажатием и не отправляем. */
export const MIN_VOICE_SEC = 0.5;

export type VoiceMime = "audio/webm" | "audio/ogg" | "audio/mp4";

export interface VoiceRef {
  /** id вложения на сервере. */
  id: string;
  /** base64 ключа secretbox (32 байта). */
  key: string;
  mime: VoiceMime;
  /** Длительность, секунды (с десятыми). */
  dur: number;
  size: number;
  /** WAVE_BARS чисел 0…WAVE_MAX. */
  wave: number[];
}

const MIMES: readonly string[] = ["audio/webm", "audio/ogg", "audio/mp4"];
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function encodeVoice(ref: VoiceRef): string {
  return VOICE_PREFIX + JSON.stringify(ref);
}

export function parseVoice(payload: string): VoiceRef | null {
  if (!payload.startsWith(VOICE_PREFIX)) return null;
  try {
    const raw = JSON.parse(payload.slice(VOICE_PREFIX.length));
    if (
      typeof raw?.id !== "string" || !ID_RE.test(raw.id) ||
      typeof raw.key !== "string" ||
      !MIMES.includes(raw.mime) ||
      !Number.isFinite(raw.dur) || raw.dur <= 0 ||
      !Number.isFinite(raw.size) ||
      !Array.isArray(raw.wave)
    ) {
      return null;
    }
    const wave = (raw.wave as unknown[])
      .slice(0, WAVE_BARS)
      .map((v) => (Number.isFinite(v) ? Math.max(0, Math.min(WAVE_MAX, Math.round(v as number))) : 0));
    return { id: raw.id, key: raw.key, mime: raw.mime, dur: raw.dur, size: raw.size, wave };
  } catch {
    return null;
  }
}

/** Тип звука по сигнатуре; не звук (или чужой формат) — null. */
export function detectVoiceMime(bytes: Uint8Array): VoiceMime | null {
  if (bytes.length < 12) return null;
  // EBML — WebM/Matroska.
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "audio/webm";
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
  if (ascii(0, 4) === "OggS") return "audio/ogg";
  if (ascii(4, 8) === "ftyp") return "audio/mp4";
  return null;
}

/**
 * Громкость, снятая во время записи (0…1, сколько угодно точек), → WAVE_BARS столбиков 0…WAVE_MAX.
 * Берём максимум в каждом отрезке и нормируем по самому громкому месту — тихая запись
 * тоже выглядит как волна, а не как ровная линия.
 */
export function buildWave(levels: number[], bars = WAVE_BARS): number[] {
  if (!levels.length) return new Array(bars).fill(0);
  const out: number[] = [];
  for (let i = 0; i < bars; i++) {
    const from = Math.floor((i * levels.length) / bars);
    const to = Math.max(from + 1, Math.floor(((i + 1) * levels.length) / bars));
    let peak = 0;
    for (let j = from; j < to && j < levels.length; j++) peak = Math.max(peak, levels[j]);
    out.push(peak);
  }
  const top = Math.max(...out);
  if (top <= 0) return out.map(() => 0);
  return out.map((v) => Math.round((v / top) * WAVE_MAX));
}

/** 75.4 → «1:15». */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export const VOICE_PREVIEW = "🎤 Голосовое";

export function voicePreview(ref: VoiceRef): string {
  return `${VOICE_PREVIEW} ${formatDuration(ref.dur)}`;
}
