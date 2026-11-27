import type { TourId } from "../api/tutorials";
import { useUiStore } from "../store/ui";
import { useStarsStore } from "../store/stars";
import { useE2EStore } from "../store/e2e";
import { isPhoneLayout } from "../navigation/usePhoneLayout";
import {
  activeStar,
  canInvite,
  closeChannel,
  hasSatellite,
  hasStar,
  openFirstSatellite,
  openOfficeMap,
  openStar,
  openStarsTab,
} from "./starNav";

export interface TourStep {
  /** data-tour элемента, который подсвечиваем. Нет на этом экране — шаг пропускается. */
  target: string;
  title: string;
  text: string;
  /** Свой текст для телефонной раскладки (нижнее меню). */
  phoneText?: string;
  /** Шаг только для телефонной или только для компьютерной раскладки — на другой его нет. */
  only?: "phone" | "desktop";
  /** Есть ли что показывать (например, у Звезды нет Спутников) — если нет, шаг пропускается сразу. */
  when?: () => boolean;
  /** Открыть нужный экран перед шагом. */
  prepare?: () => void;
  /** Сколько ждать элемент, мс: Звезда может ещё загружаться. */
  wait?: number;
}

export interface Tour {
  id: TourId;
  /** «Поздравляем, вы теперь знаете <subject>». */
  subject: string;
  /** В списке «Настройки → Обучение». */
  title: string;
  description: string;
  /** Заголовок карточки-предложения. */
  inviteTitle: string;
  /** Почему пройти нельзя (нет нужной Звезды), или null — можно. */
  unavailable?: () => string | null;
  /** Предлагать сейчас: человек как раз на нужном экране. */
  offerHere?: () => boolean;
  /** Предлагаем только после того, как с этим обучением разобрались (прошли или отложили). */
  after?: TourId;
  /** Что предложить в поздравлении следующим. */
  next?: () => TourId | null;
  steps: TourStep[];
}

const openChats = () => useUiStore.getState().setTab("chats");

export const MAIN_TOUR: Tour = {
  id: "main",
  subject: "главный экран Quazar",
  title: "Главный экран",
  description: "Где чаты, звонки, Созвездия и настройки, как начать переписку, закрепить важное и пригласить друзей.",
  inviteTitle: "Показать, где что находится?",
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
      text: "Ищет по вашим чатам и среди всех в Quazar: введите никнейм, имя или номер телефона — и можно сразу написать.",
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

// В Созвездии, и на телефоне не открыт канал поверх списка (иначе карточка закрыла бы поле ввода).
const inStars = () =>
  useUiStore.getState().tab === "stars" && !(isPhoneLayout() && useStarsStore.getState().mobileChannelOpen);
const memberOfActive = () => {
  const detail = activeStar();
  return !!detail && detail.my_role !== "visitor";
};
const WAIT_STAR_MS = 4000;

export const STARS_TOUR: Tour = {
  id: "stars",
  subject: "Созвездие",
  title: "Созвездие: основы",
  description: "Что такое Звёзды, какими они бывают и как создать свою или вступить в чужую.",
  inviteTitle: "Показать, как устроено Созвездие?",
  offerHere: inStars,
  after: "main",
  next: () => (hasStar() ? "star" : null),
  steps: [
    {
      target: "nav-stars",
      title: "Созвездие",
      text: "Здесь живут Звёзды — общие пространства для сообществ и команд: с текстовыми каналами и голосовыми комнатами. Пройдёмся — это займёт минуту.",
      prepare: openStarsTab,
    },
    {
      target: "star-rail",
      title: "Ваши Звёзды",
      text: "Звёзды, в которых вы состоите. Нажмите на Звезду, чтобы открыть её; число на значке — непрочитанные сообщения.",
      prepare: openStarsTab,
    },
    {
      target: "star-create",
      title: "Создать Звезду",
      text: "Звёзды бывают двух видов. 🎮 Игровая — как в Discord: до 3 текстовых Спутников и до 5 голосовых Планет. 💼 Рабочая — сколько угодно каналов и офис на карте: коворкинг, переговорные, кухня.",
    },
    {
      target: "star-join",
      title: "Вступить по приглашению",
      text: "Вас пригласили в Звезду? Вставьте сюда ссылку или код приглашения — а можно просто открыть ссылку.",
    },
  ],
};

export const STAR_TOUR: Tour = {
  id: "star",
  subject: "устройство Звезды",
  title: "Внутри Звезды",
  description: "Спутники и их разделы, Планеты и Комнаты, участники, уведомления и приглашения.",
  inviteTitle: "Показать, что внутри Звезды?",
  unavailable: () => (hasStar() ? null : "Сначала создайте Звезду или вступите в неё."),
  offerHere: () => inStars() && memberOfActive(),
  after: "stars",
  next: () => {
    const kind = activeStar()?.kind;
    return kind === "work" ? "star_work" : kind === "gaming" ? "star_game" : null;
  },
  steps: [
    {
      target: "star-header",
      title: "Звезда",
      text: "Название, вид Звезды — игровая или рабочая, — сколько в ней участников и ваша роль.",
      prepare: () => openStar(),
      wait: WAIT_STAR_MS,
    },
    {
      target: "star-section-satellite",
      title: "Спутники",
      text: "Текстовые каналы Звезды — у каждого своя тема. Нажмите на Спутник, чтобы открыть переписку.",
      prepare: closeChannel,
    },
    {
      target: "satellite-tabs",
      title: "Внутри Спутника",
      text: "Сообщения; Заметки — общий текст Спутника для договорённостей, ссылок и правил; Закреплённые сообщения и Файлы этого Спутника.",
      when: hasSatellite,
      prepare: openFirstSatellite,
      wait: WAIT_STAR_MS,
    },
    {
      target: "composer-plus",
      title: "Не только текст",
      text: "Кнопка «+» — прикрепить файл, создать опрос или собрать группу: на игру, встречу или любое общее дело.",
      when: hasSatellite,
    },
    {
      target: "star-files",
      title: "Файлы Звезды",
      text: "Все файлы из всех Спутников — в одном месте, с поиском по названию.",
      prepare: closeChannel,
    },
    {
      target: "star-section-planet",
      title: "Голосовые",
      text: "В игровых Звёздах это Планеты, в рабочих — Комнаты. Нажмите, чтобы войти: голос, показ экрана, общая доска и видео. Под названием видно, кто уже внутри.",
    },
    {
      target: "star-members",
      title: "Участники",
      text: "Кто в Звезде и кто сейчас на связи. Здесь же можно взять псевдоним — имя только для этой Звезды.",
    },
    {
      target: "star-notify",
      title: "Уведомления Звезды",
      text: "Обо всём, только об упоминаниях или ничего — для всей Звезды. Для отдельного Спутника можно выбрать своё.",
    },
    {
      target: "star-settings",
      title: "Настройки Звезды",
      text: "Участники и приглашения, а у владельца и админов — правила, роли, права и всё остальное.",
    },
    {
      target: "star-invite",
      title: "Пригласить людей",
      text: "Ссылка-приглашение в Звезду — можно со сроком действия и ограничением по числу людей.",
      when: canInvite,
    },
  ],
};

const activeWork = () => activeStar()?.kind === "work";
const activeGaming = () => activeStar()?.kind === "gaming";

export const WORK_TOUR: Tour = {
  id: "star_work",
  subject: "рабочие Звёзды",
  title: "Рабочая Звезда",
  description: "Карта офиса и этажи, двери комнат и стук, гостевые ссылки.",
  inviteTitle: "Показать, как устроен офис?",
  unavailable: () => (hasStar("work") ? null : "Откройте рабочую Звезду — создайте свою или вступите по приглашению."),
  offerHere: () => inStars() && memberOfActive() && activeWork(),
  after: "star",
  steps: [
    {
      target: "star-map",
      title: "Карта офиса",
      text: "Офис как настоящий: этажи и комнаты — коворкинг, переговорные, кухня. Видно, кто где сидит.",
      prepare: () => openStar("work"),
      wait: WAIT_STAR_MS,
    },
    {
      target: "office-map",
      title: "Комнаты",
      text: "Нажмите на комнату, чтобы войти: внутри голос, показ экрана и доска. На карточке — сколько людей внутри и кто они.",
      prepare: openOfficeMap,
      wait: WAIT_STAR_MS,
    },
    {
      target: "office-map",
      title: "Двери",
      text: "🔒 — вход по приглашению: нажмите на комнату, чтобы постучаться, и вас впустят. 🔑 — чей-то личный кабинет. В остальные комнаты входите сразу.",
    },
    {
      target: "office-floors",
      title: "Этажи",
      text: "Переключайтесь между этажами. 🔒 у этажа — доступ только выбранным участникам.",
      when: () => (activeStar()?.floors.length ?? 0) > 1,
    },
    {
      target: "star-section-planet",
      title: "Комнаты списком",
      text: "Те же комнаты — списком по этажам. Человеку без аккаунта можно дать гостевую ссылку в комнату: кнопкой «Пригласить» внутри неё.",
      prepare: () => {
        const detail = activeStar();
        if (detail) useStarsStore.getState().setView(detail.id, "channel");
        closeChannel();
      },
    },
  ],
};

export const GAME_TOUR: Tour = {
  id: "star_game",
  subject: "игровые Звёзды",
  title: "Игровая Звезда",
  description: "Лимиты Спутников и Планет, временные Планеты, сбор группы на игру, правила и роли.",
  inviteTitle: "Показать, что есть в игровой Звезде?",
  unavailable: () => (hasStar("gaming") ? null : "Откройте игровую Звезду — создайте свою или вступите по приглашению."),
  offerHere: () => inStars() && memberOfActive() && activeGaming(),
  after: "star",
  steps: [
    {
      target: "star-section-satellite",
      title: "Как в Discord",
      text: "В игровой Звезде до 3 Спутников и до 5 Планет — счётчик рядом с заголовком.",
      prepare: () => openStar("gaming"),
      wait: WAIT_STAR_MS,
    },
    {
      target: "star-temp",
      title: "Временная Планета",
      text: "Своя голосовая Планета на время: в лимит не входит и исчезает, когда все уйдут. Удобно, чтобы собраться отдельной компанией.",
    },
    {
      target: "composer-plus",
      title: "Сбор группы",
      text: "«+» → «Сбор группы»: укажите игру и сколько нужно людей. Записавшиеся попадут во временную Планету, а остальных впустит организатор.",
      when: hasSatellite,
      prepare: openFirstSatellite,
      wait: WAIT_STAR_MS,
    },
    {
      target: "star-settings",
      title: "Правила и роли",
      text: "Владелец и админы задают в настройках правила Звезды и приветствие новичков, роли с цветными подписями и звуки для звуковой панели на Планетах.",
      prepare: closeChannel,
    },
  ],
};

// Список разделов: на компьютере он всегда слева, на телефоне — отдельный экран до входа в раздел.
const showSettingsList = () => {
  const ui = useUiStore.getState();
  if (ui.tab !== "settings") ui.setTab("settings");
  if (isPhoneLayout()) ui.setSettingsSection(null);
};
const openSecurity = () => {
  if (useUiStore.getState().settingsSection !== "security") useUiStore.getState().openSettings("security");
};
const inSettings = () => useUiStore.getState().tab === "settings";

export const SETTINGS_TOUR: Tour = {
  id: "settings",
  subject: "настройки Quazar и то, как защищена ваша переписка",
  title: "Настройки и безопасность",
  description: "Что где в настройках, как защищены личные сообщения и как открыть переписку на новом устройстве.",
  inviteTitle: "Показать, что есть в настройках?",
  offerHere: inSettings,
  after: "main",
  steps: [
    {
      target: "nav-settings",
      title: "Настройки",
      text: "Здесь всё о вашем аккаунте и приложении. Пройдёмся по разделам, а подробнее — о том, как защищена ваша переписка.",
      prepare: showSettingsList,
    },
    {
      target: "settings-profile",
      title: "Профиль",
      text: "Фото, имя и статус — то, что видят о вас другие. Здесь же рабочее время для рабочих Звёзд: вне ваших часов стуки и приглашения придут без звука.",
      prepare: showSettingsList,
    },
    {
      target: "settings-account",
      title: "Аккаунт и вход",
      text: "Номер телефона, способы входа — пароль и Яндекс ID — и выход из аккаунта.",
      prepare: showSettingsList,
    },
    {
      target: "settings-notifications",
      title: "Уведомления и звуки",
      text: "О чём присылать уведомления и с каким звуком. Не приходят уведомления — «Проверка» подскажет, в чём дело. Ниже — «Звонки»: шумоподавление, микрофон и динамики.",
      prepare: showSettingsList,
    },
    {
      target: "settings-privacy",
      title: "Конфиденциальность",
      text: "Кто может найти вас по номеру телефона, показывать ли превью ссылок и кто из ваших контактов уже в Quazar.",
      prepare: showSettingsList,
    },
    {
      target: "security-e2e",
      title: "Шифрование переписки",
      text: "Личные сообщения шифруются прямо на ваших устройствах: прочитать их можете только вы и собеседник — даже Quazar их не видит. Здесь видно, читается ли переписка на этом устройстве.",
      prepare: openSecurity,
    },
    {
      target: "security-backup",
      title: "Пароль для восстановления",
      text: "Вернёт переписку, если все ваши устройства окажутся недоступны: телефон потерялся, компьютер сломался. Это не пароль от аккаунта — придумайте отдельный и сохраните его. Без него старые сообщения на новом устройстве не открыть.",
      when: () => useE2EStore.getState().status === "ready",
      prepare: openSecurity,
    },
    {
      target: "security-devices",
      title: "Устройства",
      text: "Здесь можно подключить новое устройство — без номера и пароля, а ниже — все устройства, где вы вошли в Quazar. Незнакомое — завершите его сеанс; не уверены — «Завершить остальные сеансы».",
      prepare: openSecurity,
    },
    {
      target: "security-more",
      title: "Вход на новом устройстве",
      text: "Вошли в Quazar на новом телефоне или компьютере — на устройстве, где вы уже в Quazar, появится вопрос «Это вы входите?». Нажмите «Да, это я», а затем то же число, что на новом устройстве, — и переписка откроется. Входите не вы — нажмите «Это не я»: тот вход сразу завершится. Подробнее — здесь.",
      prepare: openSecurity,
    },
    {
      target: "settings-learning",
      title: "Обучение",
      text: "Здесь можно снова пройти любое обучение — по главному экрану, Созвездию и настройкам.",
      prepare: showSettingsList,
    },
  ],
};

/** Все обучения — по порядку в «Настройки → Обучение» (и в этом же порядке их предлагаем). */
export const TOURS: Tour[] = [MAIN_TOUR, STARS_TOUR, STAR_TOUR, WORK_TOUR, GAME_TOUR, SETTINGS_TOUR];

/** Можно ли пройти обучение сейчас (есть ли нужная Звезда). */
export function tourAvailable(tour: Tour): boolean {
  return !tour.unavailable?.();
}

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
