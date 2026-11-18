import { create } from "zustand";
import { tutorialsApi, type TourId, type TourProgress } from "../api/tutorials";
import { tourById } from "./tours";

interface TourStore {
  /** null — ещё не загружали (не предлагаем, пока не знаем, что пройдено). */
  progress: TourProgress | null;
  /** Идёт обучение: какое и на каком шаге. */
  active: { id: TourId; index: number } | null;
  /** Обучение пройдено — показываем поздравление. */
  finished: TourId | null;
  load: () => Promise<void>;
  start: (id: TourId) => void;
  next: () => void;
  /** «Пропустить»: больше сами не предлагаем (повторить можно в настройках). */
  skip: () => void;
  /** «Не сейчас» на предложении пройти обучение. */
  dismiss: (id: TourId) => void;
  closeFinished: () => void;
  reset: () => void;
}

function mark(id: TourId, state: "done" | "dismissed", set: (patch: Partial<TourStore>) => void, get: () => TourStore) {
  // Сразу на экране; сервер — в фоне (не дошло — предложим ещё раз в другой день, не страшно).
  const progress = get().progress ?? {};
  if (!(state === "dismissed" && progress[id]?.state === "done")) {
    set({ progress: { ...progress, [id]: { state, at: new Date().toISOString() } } });
  }
  void tutorialsApi.mark(id, state).then((saved) => set({ progress: saved })).catch(() => {});
}

export const useTourStore = create<TourStore>((set, get) => ({
  progress: null,
  active: null,
  finished: null,
  load: async () => {
    try {
      set({ progress: await tutorialsApi.list() });
    } catch {
      /* Без прогресса просто не предлагаем — обучение доступно в настройках. */
    }
  },
  start: (id) => {
    if (!tourById(id)) return;
    set({ active: { id, index: 0 }, finished: null });
  },
  next: () => {
    const active = get().active;
    if (!active) return;
    const tour = tourById(active.id);
    if (!tour || active.index + 1 >= tour.steps.length) {
      set({ active: null, finished: active.id });
      mark(active.id, "done", set, get);
      return;
    }
    set({ active: { ...active, index: active.index + 1 } });
  },
  skip: () => {
    const active = get().active;
    if (!active) return;
    set({ active: null });
    mark(active.id, "dismissed", set, get);
  },
  dismiss: (id) => mark(id, "dismissed", set, get),
  closeFinished: () => set({ finished: null }),
  reset: () => set({ progress: null, active: null, finished: null }),
}));
