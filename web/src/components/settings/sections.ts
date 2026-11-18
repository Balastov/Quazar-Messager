import { Bell, EyeOff, GraduationCap, Info, KeyRound, Palette, Phone, ShieldCheck, Star, UserRound } from "lucide-react";
import type { SettingsSection } from "../../store/ui";

export interface SectionInfo {
  id: SettingsSection;
  title: string;
  /** Что внутри — подпись в списке разделов. */
  subtitle: string;
  Icon: typeof Bell;
}

export const SETTINGS_SECTIONS: SectionInfo[] = [
  { id: "profile", title: "Профиль", subtitle: "Фото, имя, статус, рабочее время", Icon: UserRound },
  { id: "premium", title: "Quazar Premium", subtitle: "Больше Звёзд, значок у имени", Icon: Star },
  { id: "account", title: "Аккаунт и вход", subtitle: "Телефон, способы входа, выход", Icon: KeyRound },
  { id: "appearance", title: "Оформление", subtitle: "Прозрачность, фон", Icon: Palette },
  { id: "notifications", title: "Уведомления и звуки", subtitle: "Уведомления, звуки, проверка связи", Icon: Bell },
  { id: "calls", title: "Звонки", subtitle: "Шумоподавление, микрофон и динамики", Icon: Phone },
  { id: "privacy", title: "Конфиденциальность", subtitle: "Номер телефона, превью ссылок, контакты", Icon: EyeOff },
  { id: "security", title: "Безопасность", subtitle: "Ключи шифрования, устройства", Icon: ShieldCheck },
  { id: "learning", title: "Обучение", subtitle: "Подсказки: где что находится и как работает", Icon: GraduationCap },
  { id: "about", title: "О приложении", subtitle: "Версия, приложения, обратная связь", Icon: Info },
];

/**
 * Порядок разделов: «Обучение» — первым и в зелёной рамке, пока не пройдено; пройдено (или ещё
 * не знаем) — последним, как обычный раздел.
 */
export function orderedSections(learningPending: boolean): SectionInfo[] {
  const learning = SETTINGS_SECTIONS.find((section) => section.id === "learning")!;
  const rest = SETTINGS_SECTIONS.filter((section) => section.id !== "learning");
  return learningPending ? [learning, ...rest] : [...rest, learning];
}

export function sectionInfo(id: SettingsSection | null): SectionInfo | undefined {
  return SETTINGS_SECTIONS.find((section) => section.id === id);
}
