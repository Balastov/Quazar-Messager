import { useEffect } from "react";
import { useTourStore } from "../../tour/store";
import { TOURS } from "../../tour/tours";
import { useStarsStore } from "../../store/stars";
import s from "../SettingsView.module.css";

/** «Обучение»: пройти подсказки снова — по главному экрану, Созвездию и настройкам. */
export default function LearningSection() {
  const progress = useTourStore((st) => st.progress);
  const start = useTourStore((st) => st.start);
  // Обучения по Звёздам доступны, когда есть нужная Звезда, — список Звёзд нужен уже здесь.
  useStarsStore((st) => st.stars);
  const starsLoaded = useStarsStore((st) => st.loaded);
  useEffect(() => {
    if (!useTourStore.getState().progress) void useTourStore.getState().load();
    if (!useStarsStore.getState().loaded) void useStarsStore.getState().load().catch(() => {});
  }, []);
  return (
    <>
      {TOURS.map((tour) => {
        const done = progress?.[tour.id]?.state === "done";
        const reason = tour.unavailable ? (starsLoaded ? tour.unavailable() : "Загружаем Звёзды…") : null;
        return (
          <section key={tour.id} className={s.card}>
            <h3 className={s.sectionTitle}>{tour.title}</h3>
            <p className={s.hint}>{tour.description}</p>
            {done && <p className={s.statusOk}>✓ Пройдено</p>}
            {reason && <p className={s.hint}>{reason}</p>}
            <div className={s.rowBtns}>
              <button type="button" className={s.secondary} onClick={() => start(tour.id)} disabled={!!reason}>
                {done ? "Пройти снова" : "Пройти"}
              </button>
            </div>
          </section>
        );
      })}
    </>
  );
}
