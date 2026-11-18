/** Обучение по Созвездию: открыть нужное место — сам раздел, Звезду, Спутник, карту офиса.
 * Только открывает: ничего не создаёт, в голосовые комнаты не входит. */
import type { StarDetail, StarKind } from "../api/stars";
import { firstSatellite, useStarsStore } from "../store/stars";
import { useUiStore } from "../store/ui";

export function activeStar(): StarDetail | undefined {
  const st = useStarsStore.getState();
  return st.activeStarId ? st.details[st.activeStarId] : undefined;
}

/** Есть ли Звезда (этого вида), где вы участник, а не гость по ссылке. */
export function hasStar(kind?: StarKind): boolean {
  return useStarsStore.getState().stars.some((star) => (!kind || star.kind === kind) && star.my_role !== "visitor");
}

export function openStarsTab() {
  const ui = useUiStore.getState();
  if (ui.tab !== "stars") ui.setTab("stars");
  useStarsStore.getState().setMobileChannelOpen(false);
}

/** Открыть Звезду: текущую, если подходит, иначе первую подходящую. */
export function openStar(kind?: StarKind) {
  openStarsTab();
  const st = useStarsStore.getState();
  if (!st.loaded) {
    void st.load().then(() => openStar(kind)).catch(() => {});
    return;
  }
  const current = st.stars.find((star) => star.id === st.activeStarId);
  const fits = (star: { kind: StarKind; my_role: string }) => (!kind || star.kind === kind) && star.my_role !== "visitor";
  const target = current && fits(current) ? current : st.stars.find(fits);
  if (target && target.id !== st.activeStarId) void st.selectStar(target.id);
}

/** Закрыть открытый поверх списка экран (на телефоне) — снова видно панель Звезды. */
export function closeChannel() {
  useStarsStore.getState().setMobileChannelOpen(false);
}

export function hasSatellite(): boolean {
  return !!firstSatellite(activeStar());
}

/** Открыть первый Спутник Звезды (на телефоне — поверх списка). */
export function openFirstSatellite() {
  const detail = activeStar();
  const satellite = firstSatellite(detail);
  if (!detail || !satellite) return;
  const st = useStarsStore.getState();
  st.setView(detail.id, "channel");
  void st.selectChannel(satellite);
  st.setMobileChannelOpen(true);
}

/** Открыть карту офиса рабочей Звезды. */
export function openOfficeMap() {
  const detail = activeStar();
  if (!detail || detail.kind !== "work") return;
  const st = useStarsStore.getState();
  st.setView(detail.id, "map");
  st.setMobileChannelOpen(true);
}

export function canInvite(): boolean {
  return !!activeStar()?.my_permissions.includes("invite");
}
