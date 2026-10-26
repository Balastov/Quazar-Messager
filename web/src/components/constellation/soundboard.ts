/** Встроенные звуки панели (файлы — public/sounds/board/, список — backend star_play.BUILTIN_SOUNDS). */
export const BUILTIN_SOUNDS: Record<string, { name: string; emoji: string }> = {
  tada: { name: "Тадам", emoji: "🎉" },
  rimshot: { name: "Ба-дум-тсс", emoji: "🥁" },
  gong: { name: "Гонг", emoji: "🔔" },
  fail: { name: "Провал", emoji: "📉" },
};
