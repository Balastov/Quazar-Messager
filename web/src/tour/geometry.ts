/** Геометрия обучения: какой элемент подсвечивать и где поставить подсказку. Без React — для тестов. */

export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Видимый элемент с меткой data-tour. Метка может стоять на нескольких (боковое меню на
 * компьютере и нижнее на телефоне) — берём тот, что сейчас на экране.
 */
export function findTarget(name: string, root: ParentNode = document): HTMLElement | null {
  for (const el of root.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`)) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== "hidden") return el;
  }
  return null;
}

/** Рамка вокруг элемента — с отступом, но не за краем экрана. */
export function spotlight(rect: Box, viewport: { width: number; height: number }, pad = 6): Box {
  const left = Math.max(2, rect.left - pad);
  const top = Math.max(2, rect.top - pad);
  const right = Math.min(viewport.width - 2, rect.left + rect.width + pad);
  const bottom = Math.min(viewport.height - 2, rect.top + rect.height + pad);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export type Side = "bottom" | "top" | "right" | "left" | "center";

/**
 * Где поставить подсказку размером card рядом с рамкой: под ней, над ней, справа или слева —
 * где хватает места; не помещается нигде (рамка на весь экран) — по центру. Всегда внутри
 * безопасной зоны экрана (вырез, полоска «домой»).
 */
export function placeCard(
  target: Box,
  card: { width: number; height: number },
  viewport: { width: number; height: number },
  safe: Insets = { top: 0, right: 0, bottom: 0, left: 0 },
  gap = 12
): { top: number; left: number; side: Side } {
  const minX = safe.left + 8, maxX = viewport.width - safe.right - 8 - card.width;
  const minY = safe.top + 8, maxY = viewport.height - safe.bottom - 8 - card.height;
  const clampX = (x: number) => Math.min(Math.max(x, minX), Math.max(minX, maxX));
  const clampY = (y: number) => Math.min(Math.max(y, minY), Math.max(minY, maxY));
  const centerX = target.left + target.width / 2 - card.width / 2;
  const centerY = target.top + target.height / 2 - card.height / 2;
  const below = target.top + target.height + gap;
  if (below + card.height <= viewport.height - safe.bottom - 8) return { top: below, left: clampX(centerX), side: "bottom" };
  const above = target.top - gap - card.height;
  if (above >= minY) return { top: above, left: clampX(centerX), side: "top" };
  const right = target.left + target.width + gap;
  if (right + card.width <= viewport.width - safe.right - 8) return { top: clampY(centerY), left: right, side: "right" };
  const left = target.left - gap - card.width;
  if (left >= minX) return { top: clampY(centerY), left, side: "left" };
  return { top: clampY((viewport.height - card.height) / 2), left: clampX((viewport.width - card.width) / 2), side: "center" };
}
