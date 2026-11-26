import { useEffect, useState } from "react";
import { starsApi, type StarAsset, type StarDetail } from "../../api/stars";
import { useStarsStore } from "../../store/stars";
import { useVoiceStore } from "../../store/voice";
import { keyLabel } from "../../voice/keys";
import { desktop } from "../../platform/desktop";
import { overlaySupported, useOverlayPrefs, type OverlayCorner } from "../../platform/overlay";
import { BUILTIN_SOUNDS } from "./soundboard";
import { apiError } from "./rules";
import s from "./Constellation.module.css";
import g from "./Gaming.module.css";

const NO_ASSETS: StarAsset[] = [];

/** Звуковая панель: встроенные звуки и звуки Звезды. Слышат все на этой Планете. */
export function Soundboard({ detail, channelId }: { detail: StarDetail; channelId: string }) {
  const assets = useStarsStore((st) => st.assets[detail.id] ?? NO_ASSETS);
  const loadAssets = useStarsStore((st) => st.loadAssets);
  const [error, setError] = useState<string | null>(null);
  const sounds = assets.filter((a) => a.kind === "sound");

  useEffect(() => {
    void loadAssets(detail.id).catch(() => {});
  }, [detail.id, loadAssets]);

  const play = (sound: string) => {
    setError(null);
    void starsApi.playSound(detail.id, channelId, sound).catch((err) => setError(apiError(err)));
  };

  return (
    <div className={g.soundboard}>
      <div className={g.soundGrid}>
        {Object.entries(BUILTIN_SOUNDS).map(([id, b]) => (
          <button key={id} type="button" className={g.soundButton} onClick={() => play(`builtin:${id}`)}>
            <span className={g.soundEmoji}>{b.emoji}</span>
            {b.name}
          </button>
        ))}
        {sounds.map((a) => (
          <button key={a.id} type="button" className={g.soundButton} onClick={() => play(a.id)}>
            <span className={g.soundEmoji}>{a.emoji ?? "🔊"}</span>
            {a.name}
          </button>
        ))}
      </div>
      <p className={s.hint}>Звук услышат все на Планете — у себя, не через микрофон. Не чаще раза в 2,5 секунды.</p>
      {error && <div className={s.error}>{error}</div>}
    </div>
  );
}

/** Рация и горячие клавиши — в окне «Микрофон и динамик» на Планете. */
export function VoiceKeysSettings() {
  const keys = useVoiceStore((st) => st.keys);
  const setVoiceKeys = useVoiceStore((st) => st.setVoiceKeys);
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setCapturing(false);
      if (e.code !== "Escape") void setVoiceKeys({ ...keys, pttKey: e.code });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, keys, setVoiceKeys]);

  return (
    <div className={g.form} style={{ marginTop: 16 }}>
      <label className={g.check}>
        <input type="checkbox" checked={keys.ptt} onChange={(e) => void setVoiceKeys({ ...keys, ptt: e.target.checked })} />
        Рация: говорить, только пока держу клавишу
      </label>
      {keys.ptt && (
        <div className={s.row}>
          <span className={s.hint}>Клавиша:</span>
          <button type="button" className={`${s.secondary} ${s.small}`} onClick={() => setCapturing(true)}>
            {capturing ? "Нажмите клавишу… (Esc — отмена)" : keyLabel(keys.pttKey)}
          </button>
        </div>
      )}
      {overlaySupported(desktop()) ? (
        <OverlaySettings />
      ) : (
        <p className={s.hint}>
          Ctrl+Shift+M — микрофон, Ctrl+Shift+D — выключить звук собеседников. Клавиши работают, пока
          открыта вкладка Quazar.
        </p>
      )}
    </div>
  );
}

const CORNERS: { value: OverlayCorner; label: string }[] = [
  { value: "top-left", label: "Слева сверху" },
  { value: "top-right", label: "Справа сверху" },
  { value: "bottom-left", label: "Слева снизу" },
  { value: "bottom-right", label: "Справа снизу" },
];

const SIZES: { value: number; label: string }[] = [
  { value: 0.75, label: "Маленький" },
  { value: 1, label: "Обычный" },
  { value: 1.25, label: "Крупный" },
  { value: 1.5, label: "Очень крупный" },
];

const KEY_NAMES: Record<string, string> = { mic: "Ctrl+Shift+M", deafen: "Ctrl+Shift+D" };

type Display = { id: number; name: string; primary: boolean };

/** Мониторы от десктопа; перечитываем, когда окно Quazar снова в фокусе (могли подключить второй). */
function useDisplays(): Display[] {
  const [displays, setDisplays] = useState<Display[]>([]);
  useEffect(() => {
    const bridge = desktop();
    if (!bridge?.listDisplays) return;
    let alive = true;
    const load = () => void bridge.listDisplays!().then((next) => { if (alive && Array.isArray(next)) setDisplays(next); }, () => {});
    load();
    window.addEventListener("focus", load);
    return () => { alive = false; window.removeEventListener("focus", load); };
  }, []);
  return displays;
}

/** Десктоп: оверлей поверх окон и клавиши в других программах. */
function OverlaySettings() {
  const { enabled, globalKeys, corner, onlySpeaking, scale, opacity, display, keysTaken, alerts, placing, setPrefs } = useOverlayPrefs();
  const bridge = desktop();
  const displays = useDisplays();
  // Выбранный монитор отключили — оверлей на основном, так и показываем.
  const shownDisplay = displays.some((d) => d.id === display) ? String(display) : "";
  const taken = keysTaken.map((k) => KEY_NAMES[k]).filter(Boolean);
  return (
    <>
      <label className={g.check}>
        <input type="checkbox" checked={enabled} onChange={(e) => setPrefs({ enabled: e.target.checked })} />
        Оверлей поверх окон: кто в комнате и кто говорит
      </label>
      {enabled && (
        <>
          <label className={g.check}>
            <input type="checkbox" checked={onlySpeaking} onChange={(e) => setPrefs({ onlySpeaking: e.target.checked })} />
            Только те, кто говорит
          </label>
          {bridge?.onOverlayAction && (
            <label className={g.check}>
              <input type="checkbox" checked={alerts} onChange={(e) => setPrefs({ alerts: e.target.checked })} />
              Звонки, стук, приглашения и «Скоро встреча» — в оверлее, с кнопками
            </label>
          )}
          {onlySpeaking && (
            <p className={s.hint}>Строка гаснет через 2 секунды после того, как человек замолчал. Вас видно и тогда, когда у вас выключен микрофон или звук.</p>
          )}
          <div className={s.row}>
            <span className={s.hint}>Где:</span>
            <select className={s.select} value={corner} aria-label="Где показывать оверлей"
              onChange={(e) => setPrefs({ corner: e.target.value as OverlayCorner, position: null })}>
              {CORNERS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              {corner === "custom" && <option value="custom">Своё место</option>}
            </select>
            {displays.length > 1 && (
              <select className={s.select} value={shownDisplay} aria-label="На каком мониторе"
                onChange={(e) => setPrefs({ display: e.target.value ? Number(e.target.value) : null })}>
                <option value="">Основной монитор</option>
                {displays.filter((d) => !d.primary).map((d) => <option key={d.id} value={String(d.id)}>{d.name}</option>)}
              </select>
            )}
            {bridge?.placeOverlay && (
              <button type="button" className={`${s.secondary} ${s.small}`} aria-pressed={placing}
                onClick={() => bridge.placeOverlay!(!placing)}>
                {placing ? "Готово" : "Переставить"}
              </button>
            )}
          </div>
          {placing && (
            <p className={s.hint} role="status">Перетащите оверлей мышью куда удобно — хоть на другой монитор — и нажмите «Готово».</p>
          )}
          <div className={s.row}>
            <span className={s.hint}>Размер:</span>
            <select className={s.select} value={String(scale)} aria-label="Размер оверлея"
              onChange={(e) => setPrefs({ scale: Number(e.target.value) })}>
              {SIZES.map((size) => <option key={size.value} value={String(size.value)}>{size.label}</option>)}
            </select>
            <label className={s.hint}>
              Фон: {opacity}%{" "}
              <input type="range" min={20} max={100} step={1} value={opacity} aria-label="Непрозрачность фона оверлея"
                onChange={(e) => setPrefs({ opacity: Number(e.target.value) })} />
            </label>
          </div>
        </>
      )}
      <label className={g.check}>
        <input type="checkbox" checked={globalKeys} onChange={(e) => setPrefs({ globalKeys: e.target.checked })} />
        Клавиши работают и в других программах
      </label>
      {globalKeys && taken.length > 0 && (
        <p className={`${s.hint} ${s.warn}`} role="status">
          {taken.join(" и ")} {taken.length > 1 ? "заняты" : "занята"} другой программой: в других программах{" "}
          {taken.length > 1 ? "они не сработают" : "она не сработает"}. В окне Quazar — работает. Закройте ту программу или
          смените в ней сочетание — Quazar попробует снова, когда вы в следующий раз переключитесь на другое окно.
        </p>
      )}
      <p className={s.hint}>
        Ctrl+Shift+M — микрофон, Ctrl+Shift+D — выключить звук собеседников. Оверлей появляется, когда
        окно Quazar не впереди; его видно поверх программ и игр в оконном режиме, но не в полноэкранном
        режиме игр. В показ экрана он не попадает.
      </p>
    </>
  );
}
