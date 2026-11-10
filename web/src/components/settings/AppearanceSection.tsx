import { useRef } from "react";
import { useUiStore } from "../../store/ui";
import { useWallpaperStore } from "../../store/wallpaper";
import { DEFAULT_GLASS_TRANSPARENCY } from "../../styles/glass";
import { prepareBackground } from "../../utils/wallpaper";
import { useSettingsRun } from "./useSettingsRun";
import s from "../SettingsView.module.css";

export default function AppearanceSection() {
  const glassTransparency = useUiStore((st) => st.glassTransparency);
  const setGlassTransparency = useUiStore((st) => st.setGlassTransparency);
  const personalWallpaper = useWallpaperStore((st) => st.personalUrl);
  const setPersonalWallpaper = useWallpaperStore((st) => st.setPersonal);
  const wallpaperRef = useRef<HTMLInputElement>(null);
  const { busy, run, setStatus, feedback } = useSettingsRun();

  return (
    <>
      <section className={s.card}>
        <div className={s.sliderHead}>
          <label htmlFor="glass-transparency" className={s.toggleLabel}>
            Прозрачность
          </label>
          <span className={s.sliderValue}>{glassTransparency}%</span>
        </div>
        <input
          id="glass-transparency"
          type="range"
          min={0}
          max={100}
          step={1}
          value={glassTransparency}
          onChange={(e) => setGlassTransparency(Number(e.target.value))}
          className={s.slider}
          style={{ "--fill": `${glassTransparency}%` } as React.CSSProperties}
        />
        <div className={s.sliderScale}>
          <span>Матовое стекло</span>
          <span>Прозрачное</span>
        </div>
        {glassTransparency !== DEFAULT_GLASS_TRANSPARENCY && (
          <div className={s.rowBtns}>
            <button type="button" className={s.secondary} onClick={() => setGlassTransparency(DEFAULT_GLASS_TRANSPARENCY)}>
              По умолчанию
            </button>
          </div>
        )}
      </section>

      <section className={s.card}>
        <div className={s.wallpaperRow}>
          <div
            className={s.wallpaperPreview}
            style={{ backgroundImage: `url(${JSON.stringify(personalWallpaper ?? "/bg-desktop.jpg")})` }}
            aria-hidden
          />
          <div className={s.meta}>
            <div className={s.toggleLabel}>Фон приложения</div>
            <p className={s.hint}>
              Видите только вы — на всех своих устройствах. В чате с общим фоном и в Звезде со
              своим фоном показывается их фон.
            </p>
          </div>
        </div>
        <div className={s.rowBtns}>
          <button type="button" className={s.primary} disabled={busy} onClick={() => wallpaperRef.current?.click()}>
            Выбрать картинку
          </button>
          {personalWallpaper && (
            <button
              type="button"
              className={s.secondary}
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await setPersonalWallpaper(null);
                  setStatus("Вернули стандартный фон");
                })
              }
            >
              Стандартный
            </button>
          )}
        </div>
        <input
          ref={wallpaperRef}
          aria-label="Картинка для фона приложения"
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          className={s.hidden}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            void run(async () => {
              await setPersonalWallpaper(await prepareBackground(file));
              setStatus("Фон приложения обновлён");
            });
          }}
        />
      </section>
      {feedback}
    </>
  );
}
