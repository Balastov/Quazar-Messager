/** Прозрачность стекла по умолчанию, %. */
export const DEFAULT_GLASS_TRANSPARENCY = 45;

/**
 * Прозрачность 0..100 → CSS-переменные стекла: чем прозрачнее, тем слабее
 * тонировка и размытие (как «clear»-вариант liquid glass в iOS).
 */
export function applyGlassTransparency(transparency: number): void {
  const t = Math.min(100, Math.max(0, transparency)) / 100;
  const alpha = 0.9 - 0.82 * t;
  const blur = 32 - 18 * t;
  const root = document.documentElement.style;
  root.setProperty("--qz-glass-a", alpha.toFixed(3));
  root.setProperty("--qz-glass-blur", `${blur.toFixed(1)}px`);
}
