import { useCallStore } from "../../store/call";
import AudioDevices from "../AudioDevices";
import s from "../SettingsView.module.css";

export default function CallsSection() {
  const noiseSuppression = useCallStore((st) => st.noiseSuppression);
  const toggleNoiseSuppression = useCallStore((st) => st.toggleNoiseSuppression);
  return (
    <>
      <section className={s.card}>
        <label className={s.toggle}>
          <input type="checkbox" checked={noiseSuppression} onChange={() => void toggleNoiseSuppression()} />
          <span className={s.toggleUi} />
          <span className={s.toggleLabel}>Шумоподавление микрофона</span>
        </label>
        <p className={s.hint}>
          Убирает из вашего голоса клавиатуру, вентилятор, улицу и бытовые звуки. Можно
          переключать прямо во время звонка.
        </p>
      </section>
      <section className={s.card}>
        <h3 className={s.sectionTitle}>Микрофон и динамики</h3>
        <AudioDevices />
      </section>
    </>
  );
}
