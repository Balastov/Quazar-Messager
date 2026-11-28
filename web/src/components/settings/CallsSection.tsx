import AudioDevices from "../AudioDevices";
import NoiseSettings from "./NoiseSettings";
import s from "../SettingsView.module.css";

export default function CallsSection() {
  return (
    <>
      <NoiseSettings />
      <section className={s.card}>
        <h3 className={s.sectionTitle}>Микрофон и динамики</h3>
        <AudioDevices />
      </section>
    </>
  );
}
