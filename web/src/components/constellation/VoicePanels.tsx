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

/** Десктоп: оверлей поверх окон и клавиши в других программах. */
function OverlaySettings() {
  const { enabled, globalKeys, corner, setPrefs } = useOverlayPrefs();
  return (
    <>
      <label className={g.check}>
        <input type="checkbox" checked={enabled} onChange={(e) => setPrefs({ enabled: e.target.checked })} />
        Оверлей поверх окон: кто в комнате и кто говорит
      </label>
      {enabled && (
        <div className={s.row}>
          <span className={s.hint}>Где:</span>
          <select className={s.select} value={corner} aria-label="Где показывать оверлей"
            onChange={(e) => setPrefs({ corner: e.target.value as OverlayCorner })}>
            {CORNERS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </div>
      )}
      <label className={g.check}>
        <input type="checkbox" checked={globalKeys} onChange={(e) => setPrefs({ globalKeys: e.target.checked })} />
        Клавиши работают и в других программах
      </label>
      <p className={s.hint}>
        Ctrl+Shift+M — микрофон, Ctrl+Shift+D — выключить звук собеседников. Оверлей появляется, когда
        окно Quazar не впереди; его видно поверх программ и игр в оконном режиме, но не в полноэкранном
        режиме игр. В показ экрана он не попадает.
      </p>
    </>
  );
}
