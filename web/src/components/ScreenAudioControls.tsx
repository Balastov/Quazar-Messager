import { sharerAudio, useScreenAudio } from "../store/screenAudio";
import s from "./ScreenAudioControls.module.css";

/**
 * Личные настройки зрителя. Не управляют микрофоном или звуком других участников.
 * sharerId — звук только этого показа (когда в Комнате показывают двое).
 */
export default function ScreenAudioControls({ available, sharerId, label }: {
  available: boolean; sharerId?: string; label?: string;
}) {
  const state = useScreenAudio();
  const { enabled, volume } = sharerAudio(state, sharerId);
  const setEnabled = (value: boolean) => (sharerId ? state.setSharerAudio(sharerId, { enabled: value }) : state.setEnabled(value));
  const setVolume = (value: number) => (sharerId ? state.setSharerAudio(sharerId, { volume: value }) : state.setVolume(value));
  return (
    <div className={s.root} role="group" aria-label={label ? `Звук трансляции: ${label}` : "Звук трансляции"}>
      <label className={s.toggle}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Звук трансляции: {enabled ? "включён" : "отключён"}
      </label>
      <label className={s.volume}>Громкость
        <input type="range" min={0} max={100} step={1} value={Math.round(volume * 100)}
          disabled={!enabled || !available} aria-label="Громкость трансляции"
          onChange={(e) => setVolume(Number(e.target.value) / 100)} />
        <span>{Math.round(volume * 100)}%</span>
      </label>
      {!available && <span className={s.hint}>Ведущий не передаёт звук.</span>}
    </div>
  );
}

export function ShareScreenAudioToggle({ enabled, available, onChange }: {
  enabled: boolean; available: boolean; onChange: (enabled: boolean) => void;
}) {
  return <div className={s.root}>
    <label className={s.toggle}><input type="checkbox" checked={enabled} disabled={!available}
      onChange={(e) => onChange(e.target.checked)} />Поделиться звуком: {enabled ? "да" : "нет"}</label>
    {!available && <span className={s.hint}>Звуковая дорожка не захвачена. Для добавления звука повторите показ и выберите источник с поддержкой передачи звука.</span>}
  </div>;
}
