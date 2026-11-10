import { Bell, EyeOff, Info, KeyRound, Palette, Phone, ShieldCheck, UserRound } from "lucide-react";
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
  { id: "account", title: "Аккаунт и вход", subtitle: "Телефон, способы входа, выход", Icon: KeyRound },
  { id: "appearance", title: "Оформление", subtitle: "Прозрачность, фон", Icon: Palette },
  { id: "notifications", title: "Уведомления и звуки", subtitle: "Уведомления, звуки, проверка связи", Icon: Bell },
  { id: "calls", title: "Звонки", subtitle: "Шумоподавление, микрофон и динамики", Icon: Phone },
  { id: "privacy", title: "Конфиденциальность", subtitle: "Номер телефона, превью ссылок, контакты", Icon: EyeOff },
  { id: "security", title: "Безопасность", subtitle: "Ключи шифрования, устройства", Icon: ShieldCheck },
  { id: "about", title: "О приложении", subtitle: "Версия, приложения, обратная связь", Icon: Info },
];

export function sectionInfo(id: SettingsSection | null): SectionInfo | undefined {
  return SETTINGS_SECTIONS.find((section) => section.id === id);
}
