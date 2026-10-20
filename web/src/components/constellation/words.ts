/**
 * Как называть голосовые каналы: в игровых Звёздах — Планеты («Посетить Планету» /
 * «Покинуть Планету»), в рабочих — Комнаты («Войти в Комнату» / «Выйти из Комнаты»).
 * Без импортов сторов: модуль берут и стор голоса, и компоненты.
 */
import type { StarKind } from "../../api/stars";

/** Название голосового канала во всех нужных формах. */
export interface PlaceNouns {
  /** Планета / Комната */
  one: string;
  /** Планету / Комнату */
  acc: string;
  /** Планеты / Комнаты (и родительный падеж, и множественное число) */
  gen: string;
  /** Планет / Комнат */
  manyGen: string;
  /** на Планете / в Комнате */
  inside: string;
  /** на Планету / в Комнату */
  into: string;
  /** с Планеты / из Комнаты */
  outOf: string;
  /** Новая Планета / Новая Комната */
  created: string;
}

export function placeNouns(kind: StarKind | undefined): PlaceNouns {
  if (kind === "work") {
    return {
      one: "Комната",
      acc: "Комнату",
      gen: "Комнаты",
      manyGen: "Комнат",
      inside: "в Комнате",
      into: "в Комнату",
      outOf: "из Комнаты",
      created: "Новая Комната",
    };
  }
  return {
    one: "Планета",
    acc: "Планету",
    gen: "Планеты",
    manyGen: "Планет",
    inside: "на Планете",
    into: "на Планету",
    outOf: "с Планеты",
    created: "Новая Планета",
  };
}

export interface RoomWords {
  /** Кнопка входа: «Посетить Планету» / «Войти в Комнату». */
  enter: string;
  /** Пока подключаемся. */
  entering: string;
  /** Плашка «где я». */
  here: string;
  /** «Покинуть Планету» / «Выйти из Комнаты». */
  leave: string;
  full: string;
  removed: string;
  closed: string;
  otherDevice: string;
  lost: string;
  failed: string;
  /** Пока стучались, внутри никого не осталось. */
  freed: string;
  /** «… — можно посетить» / «… — можно войти». */
  freeHint: string;
  /** «Вывести Анну с Планеты?» */
  removeConfirm: (who: string) => string;
}

export function roomWords(kind: StarKind | undefined, name: string): RoomWords {
  const n = placeNouns(kind);
  const named = name ? ` «${name}»` : "";
  if (kind === "work") {
    return {
      enter: "Войти в Комнату",
      entering: `Входим в Комнату${named}…`,
      here: "Вы в Комнате",
      leave: "Выйти из Комнаты",
      full: "Комната заполнена",
      removed: "Вас вывели из Комнаты",
      closed: "Комнату закрыли",
      otherDevice: "Вы вошли в Комнату с другого устройства",
      lost: "Связь с Комнатой прервалась",
      failed: `Не удалось войти в Комнату${named}. Попробуйте ещё раз.`,
      freed: "Комната освободилась",
      freeHint: "можно войти",
      removeConfirm: (who) => `Вывести ${who} ${n.outOf}?`,
    };
  }
  return {
    enter: "Посетить Планету",
    entering: `Летим на Планету${named}…`,
    here: "Вы на Планете",
    leave: "Покинуть Планету",
    full: "Планета заполнена",
    removed: "Вас вывели с Планеты",
    closed: "Планету закрыли",
    otherDevice: "Вы посетили Планету с другого устройства",
    lost: "Связь с Планетой прервалась",
    failed: `Не удалось посетить Планету${named}. Попробуйте ещё раз.`,
    freed: "Планета освободилась",
    freeHint: "можно посетить",
    removeConfirm: (who) => `Вывести ${who} ${n.outOf}?`,
  };
}
