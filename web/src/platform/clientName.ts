import { desktop } from "./desktop";
import { inAndroidApp } from "./android";
import { inIosApp } from "./ios";

/**
 * Какое приложение обращается к серверу — для журнала входов: «desktop/2.8.0», «android», «ios», «web».
 * Сборки до появления журнала его не присылают.
 */
export function clientName(): string {
  try {
    const bridge = desktop();
    if (bridge) return `desktop/${bridge.version}`.slice(0, 32);
    if (inAndroidApp()) return "android";
    if (inIosApp()) return "ios";
  } catch {
    // Мост приложения недоступен — значит, обычный браузер.
  }
  return "web";
}
