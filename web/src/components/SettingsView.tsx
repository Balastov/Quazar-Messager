import { useEffect, useRef, useState, type ComponentType } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useAuthStore } from "../store/auth";
import { useE2EStore } from "../store/e2e";
import { useUiStore, type SettingsSection } from "../store/ui";
import SwipeBack from "../navigation/SwipeBack";
import { SETTINGS_SECTIONS, sectionInfo } from "./settings/sections";
import KeyWarning from "./settings/KeyWarning";
import ProfileSection from "./settings/ProfileSection";
import PremiumSection from "./settings/PremiumSection";
import AccountSection from "./settings/AccountSection";
import AppearanceSection from "./settings/AppearanceSection";
import NotificationsSection from "./settings/NotificationsSection";
import CallsSection from "./settings/CallsSection";
import PrivacySection from "./settings/PrivacySection";
import SecuritySection from "./settings/SecuritySection";
import AboutSection from "./settings/AboutSection";
import base from "./SettingsView.module.css";
import s from "./settings/Settings.module.css";

const CONTENT: Record<SettingsSection, ComponentType> = {
  profile: ProfileSection,
  premium: PremiumSection,
  account: AccountSection,
  appearance: AppearanceSection,
  notifications: NotificationsSection,
  calls: CallsSection,
  privacy: PrivacySection,
  security: SecuritySection,
  about: AboutSection,
};

const PHONE_QUERY = "(max-width: 767px)";

function useIsPhone(): boolean {
  const [phone, setPhone] = useState(() => !!window.matchMedia?.(PHONE_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia?.(PHONE_QUERY);
    if (!query) return;
    const sync = () => setPhone(query.matches);
    sync();
    query.addEventListener?.("change", sync);
    return () => query.removeEventListener?.("change", sync);
  }, []);
  return phone;
}

/** Точка у раздела «Безопасность»: красная — нет ключа, жёлтая — нет резервной копии. */
function useSecurityMark(): "alert" | "warn" | null {
  const status = useE2EStore((st) => st.status);
  const hasServerBackup = useE2EStore((st) => st.hasServerBackup);
  if (status === "needs_restore") return "alert";
  if (status === "ready" && !hasServerBackup) return "warn";
  return null;
}

/**
 * Настройки по разделам. На компьютере — список разделов слева и открытый раздел справа,
 * на телефоне — список, раздел открывается отдельным экраном (назад — кнопкой или свайпом).
 */
export default function SettingsView() {
  const user = useAuthStore((st) => st.user);
  const stored = useUiStore((st) => st.settingsSection);
  const setSection = useUiStore((st) => st.setSettingsSection);
  const phone = useIsPhone();
  const mark = useSecurityMark();
  const rootRef = useRef<HTMLDivElement>(null);
  // Сохранённый раздел мог исчезнуть в новой версии.
  const known = sectionInfo(stored) ? stored : null;
  const section: SettingsSection | null = known ?? (phone ? null : "profile");

  useEffect(() => {
    rootRef.current?.scrollTo?.({ top: 0 });
  }, [section]);

  if (!user) return null;

  const nav = (
    <nav className={s.nav} aria-label="Разделы настроек">
      {SETTINGS_SECTIONS.map(({ id, title, subtitle, Icon }) => (
        <button
          key={id}
          type="button"
          className={s.navItem}
          data-settings-section={id}
          aria-current={!phone && section === id ? "page" : undefined}
          onClick={() => setSection(id)}
        >
          <span className={s.navIcon}>
            <Icon size={18} aria-hidden />
          </span>
          <span className={s.navText}>
            <span className={s.navTitle}>{title}</span>
            {phone && <span className={s.navSubtitle}>{subtitle}</span>}
          </span>
          {id === "security" && mark && (
            <span
              className={`${s.mark} ${mark === "alert" ? s.markAlert : s.markWarn}`}
              aria-label={mark === "alert" ? "Нет ключей шифрования" : "Нет резервной копии ключа"}
            />
          )}
          {phone && <ChevronRight size={18} className={s.chevron} aria-hidden />}
        </button>
      ))}
    </nav>
  );

  if (phone && !section) {
    return (
      <div className={base.root} ref={rootRef}>
        <div className={s.phoneList}>
          <h2 className={base.title}>Настройки</h2>
          <KeyWarning />
          {nav}
        </div>
      </div>
    );
  }

  const info = sectionInfo(section)!;
  const Content = CONTENT[info.id];
  const content = (
    <div className={s.content}>
      {phone ? (
        <div className={s.phoneHeader}>
          <button
            type="button"
            className={s.back}
            aria-label="Назад к разделам настроек"
            onClick={() => setSection(null)}
          >
            <ChevronLeft size={20} aria-hidden /> Назад
          </button>
          <h2 className={base.title}>{info.title}</h2>
        </div>
      ) : (
        <h2 className={base.title}>{info.title}</h2>
      )}
      {/* В «Безопасности» о ключе говорит своя карточка. */}
      {info.id !== "security" && <KeyWarning />}
      <Content key={info.id} />
    </div>
  );

  if (phone) {
    return (
      <SwipeBack className={s.swipe} screenId={info.id} onBack={() => setSection(null)}>
        <div className={base.root} ref={rootRef}>
          {content}
        </div>
      </SwipeBack>
    );
  }

  return (
    <div className={base.root} ref={rootRef}>
      <div className={s.layout}>
        <aside className={s.side}>
          <h2 className={base.title}>Настройки</h2>
          {nav}
        </aside>
        {content}
      </div>
    </div>
  );
}
