import { useEffect, useState } from "react";
import { starsApi, type StarAsset, type StarDetail } from "../../api/stars";
import { useStarsStore } from "../../store/stars";
import { useVoiceStore } from "../../store/voice";
import { keyLabel } from "../../voice/keys";
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
      <p className={s.hint}>
        Ctrl+Shift+M — микрофон, Ctrl+Shift+D — выключить звук собеседников. Клавиши работают, пока
        открыта вкладка Quazar.
      </p>
    </div>
  );
}
