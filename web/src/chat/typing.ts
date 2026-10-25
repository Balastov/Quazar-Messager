/** «Печатает…»: как часто сообщать о наборе и сколько показывать подпись. */

/** Пока человек набирает, сообщаем серверу не чаще этого. */
export const TYPING_SEND_EVERY_MS = 3000;
/** Подпись гаснет, если от человека столько времени ничего не приходило. */
export const TYPING_SHOW_MS = 6000;

/** Пропускает отправку, если для этой цели (чат, Спутник) уже отправляли недавно. */
export function createTypingThrottle(everyMs = TYPING_SEND_EVERY_MS, now = () => Date.now()) {
  const last = new Map<string, number>();
  return {
    shouldSend(target: string): boolean {
      const t = now();
      if (t - (last.get(target) ?? -Infinity) < everyMs) return false;
      last.set(target, t);
      return true;
    },
    /** Отправили сообщение — следующий набор сообщаем сразу. */
    reset(target: string) {
      last.delete(target);
    },
  };
}

/** «Аня печатает…», «Аня и Боря печатают…», «Аня и ещё 2 печатают…». */
export function typingLabel(names: string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return `${names[0]} печатает…`;
  if (names.length === 2) return `${names[0]} и ${names[1]} печатают…`;
  return `${names[0]} и ещё ${names.length - 1} печатают…`;
}
