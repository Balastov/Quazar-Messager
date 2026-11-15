import { getPreferredInput } from "./devices";

/** Показываем, пока микрофона нет: звонок не обрывается, звук вернётся сам. */
export const MIC_LOST = "Микрофон отключён — подключите его снова, звук включится сам";
export const MIC_BACK = "Микрофон снова работает";

/**
 * Нужно ли взять микрофон заново:
 * - прежний физически отключили (трек завершился или онемел, а устройство пропало из списка);
 * - выбранный в настройках микрофон снова подключили, а сейчас работает другой;
 * - выбран «системный», и система сменила устройство по умолчанию (вставили гарнитуру).
 */
export async function micNeedsSwitch(track: MediaStreamTrack | null | undefined): Promise<boolean> {
  if (!track) return false;
  if (track.readyState === "ended") return true;
  if (!navigator.mediaDevices?.enumerateDevices) return false;
  const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
  const settings = track.getSettings();
  // Safari и часть систем не завершают трек выдернутого микрофона, а глушат его: устройство пропало
  // из списка или вернулось, а трек так и остался немым.
  if (settings.deviceId && !inputs.some((d) => d.deviceId === settings.deviceId)) return true;
  if (track.muted) return true;
  const preferred = getPreferredInput();
  if (preferred) return inputs.some((d) => d.deviceId === preferred) && settings.deviceId !== preferred;
  // Chromium показывает системное устройство отдельной записью «default» с groupId настоящего устройства;
  // открытый трек остаётся на прежнем. Safari и Firefox такой записи не дают — там не угадываем.
  const fallback = inputs.find((d) => d.deviceId === "default");
  return !!fallback?.groupId && !!settings.groupId && fallback.groupId !== settings.groupId;
}

/**
 * Одна проверка за раз: «устройство изменилось» приходит пачкой. Пока идёт проверка, новые
 * вызовы ждут её и запускают ещё одну — по свежему состоянию устройств.
 */
export function serial(work: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;
  return () => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await work();
        } while (again);
      } finally {
        running = null;
      }
    })();
    return running;
  };
}
