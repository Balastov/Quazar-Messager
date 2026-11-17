import type { StarDetail, StarFloor, StarMember } from "../../api/stars";
import { compareUsers } from "../../utils/profile";
import { matchesMember } from "./memberSearch";

/**
 * Этаж сбора в рабочей Звезде: открытый на карте, иначе первый.
 * Без этажей (игровая Звезда) — null: организаторов выбирают из всей Звезды.
 */
export function lfgFloor(floors: StarFloor[], current: string | undefined): StarFloor | null {
  return floors.find((f) => f.id === current) ?? floors[0] ?? null;
}

/** Нужно ли спрашивать сервер, кто бывает на этаже: этаж один — это просто вся Звезда. */
export function needsFloorPeople(detail: Pick<StarDetail, "kind" | "floors">): boolean {
  return detail.kind === "work" && detail.floors.length > 1;
}

/**
 * Кого можно назначить организатором: участники (с этажа, если people известны), кроме меня,
 * подходящие под поиск; по алфавиту.
 */
export function organizerCandidates(
  members: StarMember[],
  people: string[] | null,
  myId: string | undefined,
  query: string
): StarMember[] {
  const onFloor = people ? new Set(people) : null;
  return members
    .filter((m) => m.user.id !== myId && (!onFloor || onFloor.has(m.user.id)) && matchesMember(m, query))
    .sort((a, b) => compareUsers(a.user, b.user));
}
