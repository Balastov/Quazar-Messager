import { useEffect } from "react";
import { useTourStore } from "../../tour/store";
import { TOURS } from "../../tour/tours";
import s from "../SettingsView.module.css";

/** «Обучение»: пройти подсказки снова — по главному экрану, а потом и по Созвездиям, настройкам. */
export default function LearningSection() {
  const progress = useTourStore((st) => st.progress);
  const start = useTourStore((st) => st.start);
  useEffect(() => {
    if (!useTourStore.getState().progress) void useTourStore.getState().load();
  }, []);
  return (
    <>
      {TOURS.map((tour) => {
        const done = progress?.[tour.id]?.state === "done";
        return (
          <section key={tour.id} className={s.card}>
            <h3 className={s.sectionTitle}>{tour.title}</h3>
            <p className={s.hint}>{tour.description}</p>
            {done && <p className={s.statusOk}>✓ Пройдено</p>}
            <div className={s.rowBtns}>
              <button type="button" className={s.secondary} onClick={() => start(tour.id)}>
                {done ? "Пройти снова" : "Пройти"}
              </button>
            </div>
          </section>
        );
      })}
      <section className={s.card}>
        <h3 className={s.sectionTitle}>Скоро</h3>
        <p className={s.hint}>Обучение по Созвездиям и по настройкам — с отдельным рассказом о ключах шифрования.</p>
      </section>
    </>
  );
}
