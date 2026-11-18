import type { TourId } from "../api/tutorials";
import { useUiStore } from "../store/ui";

export interface TourStep {
  /** data-tour элемента, который подсвечиваем. Нет на этом экране — шаг пропускается. */
  target: string;
  title: string;
  text: string;
  /** Свой текст для телефонной раскладки (нижнее меню). */
  phoneText?: string;
  /** Шаг только для телефонной или только для компьютерной раскладки — на другой его нет. */
  only?: "phone" | "desktop";
  /** Открыть нужный экран перед шагом. */
  prepare?: () => void;
}

export interface Tour {
  id: TourId;
  /** «Поздравляем, вы теперь знаете <subject>». */
  subject: string;
  /** В списке «Настройки → Обучение». */
  title: string;
  description: string;
  steps: TourStep[];
}

const openChats = () => useUiStore.getState().setTab("chats");

export const MAIN_TOUR: Tour = {
  id: "main",
  subject: "главный экран Quazar",
  title: "Главный экран",
  description: "Где чаты, звонки, Созвездия и настройки, как начать переписку, закрепить важное и пригласить друзей.",
  steps: [
    {
      target: "nav",
      title: "Главное меню",
      text: "Здесь все разделы Quazar. Пройдёмся по ним — это займёт минуту.",
      prepare: openChats,
    },
    {
      target: "nav-contacts",
      title: "Контакты",
      text: "Все ваши люди — от А до Я: с кем вы переписывались, знакомые из телефонной книги и боты Quazar. Нажмите на человека, чтобы написать ему, а важных закрепите сверху кнопкой 📌.",
      only: "phone",
    },
    {
      target: "nav-chats",
      title: "Чаты",
      text: "Все переписки — личные и групповые, сверху самые свежие. Число на значке — сколько сообщений вы ещё не прочитали.",
    },
    {
      target: "nav-stars",
      title: "Созвездие",
      text: "Звёзды — пространства для сообществ и команд: текстовые Спутники, голосовые Планеты, офис с комнатами. О них — отдельное обучение.",
    },
    {
      target: "nav-calls",
      title: "Звонки",
      text: "История звонков: кому вы звонили и кто звонил вам. Позвонить можно из чата или из карточки человека.",
    },
    {
      target: "nav-settings",
      title: "Настройки",
      text: "Профиль, оформление, уведомления и безопасность — в том числе ключи шифрования ваших сообщений.",
    },
    {
      target: "search",
      title: "Поиск",
      text: "Ищет по вашим чатам и среди всех в Quazar: введите никнейм, имя или номер +7 — и можно сразу написать.",
      prepare: openChats,
    },
    {
      target: "new-chat",
      title: "Новый чат",
      text: "Нажмите, чтобы начать переписку: откроется список ваших людей от А до Я. Кого нет в списке — найдёте там же по нику, имени или номеру.",
    },
    {
      target: "invite",
      title: "Пригласить друзей",
      text: "Друга ещё нет в Quazar? Отправьте ему приглашение по СМС или ссылкой.",
    },
    {
      target: "chat-list",
      title: "Ваши чаты",
      text: "Сверху — «Записная книжка» для заметок, под ней закреплённые чаты, ниже — остальные. Чтобы закрепить чат, наведите на него и нажмите 📌 справа: до 5 чатов, с Premium — до 10. Личные сообщения шифруются — их читаете только вы и собеседник.",
      phoneText: "Сверху — «Записная книжка» для заметок, под ней закреплённые чаты, ниже — остальные. Чтобы закрепить чат, нажмите 📌 справа в его строке: до 5 чатов, с Premium — до 10. Личные сообщения шифруются — их читаете только вы и собеседник.",
    },
    {
      target: "feedback",
      title: "Обратная связь",
      text: "Предложение, вопрос или ошибка — напишите команде Quazar. Ответим в чате с Quazar_Admin_bot.",
      only: "desktop",
    },
    {
      target: "profile",
      title: "Ваш статус",
      text: "Нажмите на себя, чтобы поставить статус: свой, «на встрече» или «не беспокоить».",
      only: "desktop",
    },
  ],
};

/** Все обучения — по порядку в «Настройки → Обучение». Созвездия и настройки появятся следом. */
export const TOURS: Tour[] = [MAIN_TOUR];

export function tourById(id: TourId): Tour | undefined {
  return TOURS.find((tour) => tour.id === id);
}

/** Где обучение можно пройти снова — в поздравлении. */
export const REPLAY_PLACE = "«Настройки → Обучение»";

/** Есть ли шаг на этой раскладке. */
export function stepApplies(step: TourStep, phone: boolean): boolean {
  return !step.only || step.only === (phone ? "phone" : "desktop");
}

/** «N из M» — считаем только шаги этой раскладки. */
export function stepPosition(tour: Tour, index: number, phone: boolean): { n: number; total: number } {
  const shown = tour.steps.filter((step) => stepApplies(step, phone));
  const n = tour.steps.slice(0, index + 1).filter((step) => stepApplies(step, phone)).length;
  return { n: Math.max(1, n), total: shown.length };
}
