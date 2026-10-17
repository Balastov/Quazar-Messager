/**
 * Выбор микрофона и динамика для звонков и Планет.
 *
 * Пустая строка = «По умолчанию» (системное устройство). Выбор запоминается на устройстве;
 * если выбранное устройство отключили — тихо возвращаемся к системному.
 *
 * Динамик: в Chrome/Edge/Firefox — HTMLMediaElement.setSinkId; где его нет (Safari, iOS),
 * выбор динамика не показываем. На iPhone вместо этого — переключатель «у уха / громкая связь»
 * через navigator.audioSession (Safari 16.4+): как iOS поведёт звук, зависит от устройства.
 */

const INPUT_KEY = "quazar_audio_input";
const OUTPUT_KEY = "quazar_audio_output";
const IOS_ROUTE_KEY = "quazar_ios_audio_route";

export interface AudioDevice {
  deviceId: string;
  label: string;
}

export type IosRoute = "speaker" | "receiver";

function read(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function write(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export const getPreferredInput = () => read(INPUT_KEY);
export const setPreferredInput = (id: string) => write(INPUT_KEY, id);
export const getPreferredOutput = () => read(OUTPUT_KEY);
export const setPreferredOutput = (id: string) => write(OUTPUT_KEY, id);

export function canSelectOutput(): boolean {
  return typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
}

/** Системные «default»/«communications» — это и есть «По умолчанию», в списке не дублируем. */
function isAlias(deviceId: string): boolean {
  return deviceId === "" || deviceId === "default" || deviceId === "communications";
}

export async function listAudioDevices(): Promise<{
  inputs: AudioDevice[];
  outputs: AudioDevice[];
  /** Названия скрыты, пока не разрешён доступ к микрофону. */
  labelsHidden: boolean;
}> {
  if (!navigator.mediaDevices?.enumerateDevices) return { inputs: [], outputs: [], labelsHidden: false };
  const devices = await navigator.mediaDevices.enumerateDevices();
  const pick = (kind: MediaDeviceKind, fallback: string) =>
    devices
      .filter((d) => d.kind === kind && !isAlias(d.deviceId))
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `${fallback} ${i + 1}` }));
  return {
    inputs: pick("audioinput", "Микрофон"),
    outputs: pick("audiooutput", "Динамик"),
    labelsHidden: devices.some((d) => d.kind === "audioinput" && !d.label),
  };
}

/**
 * Микрофон с учётом выбора. Выбранного устройства нет (отключили гарнитуру) —
 * берём системное, а не оставляем человека без звука.
 */
export async function getMicrophone(audio: MediaTrackConstraints, deviceId = getPreferredInput()): Promise<MediaStream> {
  if (deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { ...audio, deviceId: { exact: deviceId } } });
    } catch (err) {
      const name = err instanceof DOMException || err instanceof Error ? err.name : "";
      if (name !== "OverconstrainedError" && name !== "NotFoundError") throw err;
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio });
}

/** Направить звук элемента в выбранный динамик (где браузер это умеет). */
export async function applyOutput(el: HTMLMediaElement | null, deviceId = getPreferredOutput()): Promise<void> {
  if (!el || !canSelectOutput()) return;
  const target = el as HTMLMediaElement & { setSinkId(id: string): Promise<void>; sinkId?: string };
  if ((target.sinkId ?? "") === deviceId) return;
  try {
    await target.setSinkId(deviceId);
  } catch {
    // Устройство пропало — играем в системное.
    await target.setSinkId("").catch(() => {});
  }
}

// --- iPhone: у уха / громкая связь ----------------------------------------

type AudioSessionType = "auto" | "playback" | "transient" | "transient-solo" | "ambient" | "play-and-record";
interface AudioSession {
  type: AudioSessionType;
}

function audioSession(): AudioSession | null {
  return (navigator as Navigator & { audioSession?: AudioSession }).audioSession ?? null;
}

export function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

export function canSwitchIosRoute(): boolean {
  return isIos() && audioSession() !== null;
}

export function getIosRoute(): IosRoute {
  return read(IOS_ROUTE_KEY) === "receiver" ? "receiver" : "speaker";
}

/**
 * «У уха» — сессия play-and-record (iOS обычно ведёт звук в разговорный динамик),
 * «громкая связь» — auto (как сейчас). Наушники и AirPods iOS подключает сам.
 */
export function applyIosRoute(route: IosRoute = getIosRoute()): void {
  const session = audioSession();
  if (!session || !isIos()) return;
  try {
    session.type = route === "receiver" ? "play-and-record" : "auto";
  } catch {
    // ignore
  }
}

export function setIosRoute(route: IosRoute): void {
  write(IOS_ROUTE_KEY, route === "receiver" ? "receiver" : "");
  applyIosRoute(route);
}
