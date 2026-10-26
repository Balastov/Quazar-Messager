/**
 * Рация (push-to-talk) и горячие клавиши Планет. Настройки — на этом устройстве.
 * Работают, пока вкладка Quazar в фокусе: браузер не даёт сайтам глобальные клавиши.
 */

export interface VoiceKeyPrefs {
  /** Рация: микрофон включён, только пока держишь клавишу. */
  ptt: boolean;
  /** KeyboardEvent.code клавиши рации. */
  pttKey: string;
}

const KEY = "quazar_voice_keys";
const DEFAULTS: VoiceKeyPrefs = { ptt: false, pttKey: "Backquote" };

export function loadVoiceKeys(): VoiceKeyPrefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<VoiceKeyPrefs>) };
  } catch {
    return DEFAULTS;
  }
}

export function saveVoiceKeys(prefs: VoiceKeyPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // ignore
  }
}

/** «`» → «Ё/`», KeyV → «V», Space → «Пробел». */
export function keyLabel(code: string): string {
  if (code === "Backquote") return "Ё / `";
  if (code === "Space") return "Пробел";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  return code.replace(/(Left|Right)$/, " $1");
}

/** Печатают текст — клавиши рации и горячие клавиши не перехватываем. */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

/** Ctrl+Shift+M — микрофон, Ctrl+Shift+D — звук собеседников. */
export function hotkey(e: KeyboardEvent): "mic" | "deafen" | null {
  if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return null;
  if (e.code === "KeyM") return "mic";
  if (e.code === "KeyD") return "deafen";
  return null;
}
