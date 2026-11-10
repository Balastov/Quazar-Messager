import { version } from "../../../package.json";
import { desktop } from "../../platform/desktop";
import { useUiStore } from "../../store/ui";
import DesktopDownloadButton from "../DesktopDownloadButton";
import s from "../SettingsView.module.css";

export default function AboutSection() {
  const bridge = desktop();
  return (
    <>
      <section className={s.card}>
        <h3 className={s.sectionTitle}>Версия</h3>
        <p className={s.hint}>
          {bridge ? `Приложение для компьютера ${bridge.version}` : `Веб-версия ${version}`}
        </p>
        <DesktopDownloadButton />
      </section>
      <section className={s.card}>
        <h3 className={s.sectionTitle}>Обратная связь</h3>
        <p className={s.hint}>
          Предложение, вопрос или ошибка — напишите команде Квазара. Ответим в чате с Quazar_Admin_bot.
        </p>
        <div className={s.rowBtns}>
          <button type="button" className={s.secondary} onClick={() => useUiStore.getState().setFeedbackOpen(true)}>
            Написать команде
          </button>
        </div>
      </section>
    </>
  );
}
