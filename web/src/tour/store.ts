import { create } from "zustand";
import { tutorialsApi, type TourId, type TourProgress, type TourState } from "../api/tutorials";
import { useAuthStore } from "../store/auth";
import { tourById } from "./tours";

interface TourStore {
  /** null — ещё не загружали (не предлагаем, пока не знаем, что пройдено). */
  progress: TourProgress | null;
  /** Идёт обучение: какое и на каком шаге. */
  active: { id: TourId; index: number } | null;
  /** Обучение пройдено — показываем поздравление. */
  finished: TourId | null;
  /** Что уже предлагали в этой вкладке: одно и то же обучение второй раз сами не предлагаем. */
  offered: TourId[];
  /** Чей прогресс загружен: при смене аккаунта всё начинаем заново. */
  owner: string | null;
  load: () => Promise<void>;
  start: (id: TourId) => void;
  next: () => void;
  /** «Пропустить»: больше сами не предлагаем (повторить можно в настройках). */
  skip: () => void;
  /** «Не сейчас» на предложении пройти обучение. */
  dismiss: (id: TourId) => void;
  /** Карточку с предложением показали. */
  markOffered: (id: TourId) => void;
  closeFinished: () => void;
  /** Другой аккаунт (или выход): забыть прогресс и предложения. */
  reset: (owner?: string | null) => void;
}

// Отметки «пройдено/отложено» — ещё и на устройстве, пока сервер их не подтвердил. Иначе отметка,
// которая не дошла (обрыв связи) или которую обогнала загрузка прогресса, терялась, и то же
// обучение предлагалось снова и снова.
const LOCAL_KEY = (userId: string) => `quazar-tours:${userId}`;

function ownerId(): string | null {
  return useAuthStore.getState().user?.id ?? null;
}

function readLocal(userId: string | null): TourProgress {
  if (!userId) return {};
  try {
    const raw = JSON.parse(localStorage.getItem(LOCAL_KEY(userId)) ?? "{}");
    return raw && typeof raw === "object" ? (raw as TourProgress) : {};
  } catch {
    return {};
  }
}

function writeLocal(userId: string | null, progress: TourProgress) {
  if (!userId) return;
  try {
    if (Object.keys(progress).length) localStorage.setItem(LOCAL_KEY(userId), JSON.stringify(progress));
    else localStorage.removeItem(LOCAL_KEY(userId));
  } catch {
    // Приватный режим или запрет хранилища — останется только серверная отметка.
  }
}

/** «Пройдено» сильнее «отложено»; из двух одинаковых — более позднее. */
function stronger(a: TourState | undefined, b: TourState | undefined): TourState | undefined {
  if (!a || !b) return a ?? b;
  if (a.state !== b.state) return a.state === "done" ? a : b;
  return a.at >= b.at ? a : b;
}

export function mergeProgress(server: TourProgress, local: TourProgress): TourProgress {
  const out: TourProgress = { ...server };
  for (const id of Object.keys(local) as TourId[]) out[id] = stronger(server[id], local[id]);
  return out;
}

/** Локальные отметки, которых на сервере нет (или там слабее), — их надо отправить ещё раз. */
function unsynced(server: TourProgress, local: TourProgress): [TourId, TourState][] {
  return (Object.entries(local) as [TourId, TourState][]).filter(
    ([id, mark]) => server[id]?.state !== mark.state && stronger(server[id], mark) === mark
  );
}

function send(id: TourId, state: TourState["state"], set: (patch: Partial<TourStore>) => void, get: () => TourStore) {
  const userId = ownerId();
  void tutorialsApi
    .mark(id, state)
    .then((saved) => {
      // Сервер запомнил — локальная копия этой отметки больше не нужна («пройдено» он не меняет на «отложено»).
      if (saved[id]) {
        const local = readLocal(userId);
        delete local[id];
        writeLocal(userId, local);
      }
      // Отметки, сделанные на экране, пока шёл запрос, ответом сервера не затираем.
      if (ownerId() === userId) set({ progress: mergeProgress(saved, get().progress ?? {}) });
    })
    .catch(() => {
      // Не дошло — отправим при следующей загрузке; локальная отметка уже не даст предложить снова.
    });
}

function mark(id: TourId, state: "done" | "dismissed", set: (patch: Partial<TourStore>) => void, get: () => TourStore) {
  const progress = get().progress ?? {};
  const now: TourState = { state, at: new Date().toISOString() };
  const kept = stronger(progress[id], now) ?? now;
  set({ progress: { ...progress, [id]: kept } });
  const userId = ownerId();
  writeLocal(userId, { ...readLocal(userId), [id]: kept });
  send(id, state, set, get);
}

export const useTourStore = create<TourStore>((set, get) => ({
  progress: null,
  active: null,
  finished: null,
  offered: [],
  owner: null,
  load: async () => {
    const userId = ownerId();
    const local = readLocal(userId);
    try {
      const server = await tutorialsApi.list();
      if (ownerId() !== userId) return;
      // Отметки, сделанные, пока шла загрузка, тоже учитываем.
      set({ progress: mergeProgress(mergeProgress(server, local), get().progress ?? {}) });
      const pending = unsynced(server, local);
      // То, что сервер уже знает, локально не держим; недошедшее отправляем ещё раз.
      writeLocal(userId, Object.fromEntries(pending) as TourProgress);
      for (const [id, mark] of pending) send(id, mark.state, set, get);
    } catch {
      // Сервер недоступен: хотя бы не предлагаем то, что на этом устройстве уже прошли или отложили.
      if (Object.keys(local).length) set({ progress: mergeProgress(get().progress ?? {}, local) });
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
  markOffered: (id) => {
    if (!get().offered.includes(id)) set({ offered: [...get().offered, id] });
  },
  closeFinished: () => set({ finished: null }),
  reset: (owner = null) => set({ progress: null, active: null, finished: null, offered: [], owner }),
}));
