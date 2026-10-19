/**
 * Как называть вход и выход: в игровых Звёздах — «Отправиться на планету …» / «Покинуть
 * планету», в рабочих — «Войти в …» / «Покинуть комнату». Без импортов сторов: модуль берут
 * и стор голоса, и компоненты.
 */
import type { StarKind } from "../../api/stars";

export interface RoomWords {
  /** Кнопка входа: «Отправиться на планету Рейд» / «Войти в Переговорную». */
  enter: string;
  /** Пока подключаемся. */
  entering: string;
  /** Плашка «где я». */
  here: string;
  leave: string;
  full: string;
  removed: string;
  closed: string;
  otherDevice: string;
  lost: string;
  failed: string;
  /** Пока стучались, внутри никого не осталось. */
  freed: string;
  /** «… — можно войти» / «… — можно отправиться». */
  freeHint: string;
  /** «Вывести Анну с планеты?» */
  removeConfirm: (who: string) => string;
}

export function roomWords(kind: StarKind | undefined, name: string): RoomWords {
  if (kind === "work") {
    return {
      enter: `Войти в ${name}`,
      entering: `Входим в ${name}…`,
      here: "Вы в комнате",
      leave: "Покинуть комнату",
      full: "Комната заполнена",
      removed: "Вас вывели из комнаты",
      closed: "Комнату закрыли",
      otherDevice: "Вы вошли в комнату с другого устройства",
      lost: "Связь с комнатой прервалась",
      failed: `Не удалось войти в ${name}. Попробуйте ещё раз.`,
      freed: "Комната освободилась",
      freeHint: "можно войти",
      removeConfirm: (who) => `Вывести ${who} из комнаты?`,
    };
  }
  return {
    enter: `Отправиться на планету ${name}`,
    entering: `Отправляемся на планету ${name}…`,
    here: "Вы на планете",
    leave: "Покинуть планету",
    full: "Планета заполнена",
    removed: "Вас вывели с планеты",
    closed: "Планету закрыли",
    otherDevice: "Вы отправились на планету с другого устройства",
    lost: "Связь с планетой прервалась",
    failed: `Не удалось отправиться на планету ${name}. Попробуйте ещё раз.`,
    freed: "Планета освободилась",
    freeHint: "можно отправиться",
    removeConfirm: (who) => `Вывести ${who} с планеты?`,
  };
}
