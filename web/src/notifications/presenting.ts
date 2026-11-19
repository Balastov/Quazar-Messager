import { create } from "zustand";

/** Где сейчас показываем свой экран: в звонке один на один или в голосовой комнате Созвездия. */
export type PresentingSource = "call" | "room";

interface PresentingState {
  call: boolean;
  room: boolean;
}

/** Пока идёт демонстрация экрана, Quazar ничего не показывает поверх: всплывашки и системные
 * уведомления увидели бы зрители. Звук сообщений остаётся, входящий звонок молчит. */
export const usePresentingStore = create<PresentingState>(() => ({ call: false, room: false }));

export function setPresenting(source: PresentingSource, on: boolean): void {
  if (usePresentingStore.getState()[source] !== on) usePresentingStore.setState({ [source]: on });
}

export function isPresenting(): boolean {
  const { call, room } = usePresentingStore.getState();
  return call || room;
}

export function usePresenting(): boolean {
  return usePresentingStore((st) => st.call || st.room);
}
