import { create } from "zustand";

/** Этаж, открытый на карте офиса, — по Звёздам. Нужен не только карте: сбор группы
 * появляется на текущем этаже, и организаторов выбирают из тех, кто на нём бывает. */
interface OfficeFloorState {
  byStar: Record<string, string>;
  setFloor: (starId: string, floorId: string) => void;
}

export const useOfficeFloorStore = create<OfficeFloorState>((set) => ({
  byStar: {},
  setFloor: (starId, floorId) => set((st) => ({ byStar: { ...st.byStar, [starId]: floorId } })),
}));
