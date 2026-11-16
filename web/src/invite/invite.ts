/**
 * «Пригласить друзей»: текст со ссылкой на сайт и способы его отправить.
 * На телефоне открываем «Сообщения» с готовым текстом (ссылка sms:) — получателя человек
 * выбирает сам. На компьютере SMS нет: системное «Поделиться», а без него — копируем текст.
 * Новый способ (e-mail и т. п.) — ещё одна функция-ссылка рядом со smsHref.
 */
import { isIOS, isMobileDevice } from "../utils/device";

/** Приглашаем всегда на основной сайт, даже из тестовой сборки. */
export const INVITE_URL = "https://quazar-msg.ru";
export const INVITE_TEXT = `Привет! Я общаюсь в Quazar — присоединяйся: ${INVITE_URL}`;

/**
 * Ссылка, открывающая SMS с текстом. iPhone понимает тело только после «&»,
 * Android — после «?»; получатель пустой.
 */
export function smsHref(text = INVITE_TEXT, ios = isIOS()): string {
  return `sms:${ios ? "&" : "?"}body=${encodeURIComponent(text)}`;
}

/** SMS можно открыть только на телефоне или планшете (в том числе в приложении для Android). */
export function canOpenSms(): boolean {
  return isMobileDevice();
}

export type ShareResult = "shared" | "copied" | "cancelled" | "manual";

interface ShareEnv {
  share?: (data: ShareData) => Promise<void>;
  copy?: (text: string) => Promise<void>;
  prompt: (message: string, text: string) => void;
}

function browserEnv(): ShareEnv {
  return {
    share: typeof navigator.share === "function" ? (data) => navigator.share(data) : undefined,
    copy: navigator.clipboard?.writeText ? (text) => navigator.clipboard.writeText(text) : undefined,
    prompt: (message, text) => void window.prompt(message, text),
  };
}

/**
 * Без SMS: системное окно «Поделиться», если есть; отказ человека — не ошибка.
 * Не вышло — копируем текст, а не получилось и это — показываем его, чтобы скопировали вручную.
 */
export async function shareInvite(text = INVITE_TEXT, env: ShareEnv = browserEnv()): Promise<ShareResult> {
  if (env.share) {
    try {
      await env.share({ title: "Quazar", text });
      return "shared";
    } catch (err) {
      if ((err as { name?: string } | null)?.name === "AbortError") return "cancelled";
    }
  }
  if (env.copy) {
    try {
      await env.copy(text);
      return "copied";
    } catch {
      // буфер обмена недоступен — ниже покажем текст
    }
  }
  env.prompt("Скопируйте приглашение и отправьте другу:", text);
  return "manual";
}
