// Уровни уведомлений: тот же расчёт, что backend/app/core/notify.py.
import { create } from "zustand";
import { http } from "../api/client";
import { socket } from "../ws/socket";

export type NotifyLevel = "all" | "mentions_only" | "replies" | "mentions" | "none";
export type NotifyScope = "chat" | "star" | "channel";

export interface NotifySetting {
  scope: NotifyScope;
  target_id: string;
  /** null — как уровнем выше. */
  level: NotifyLevel | null;
  /** ISO; тишина до этого момента. */
  muted_until: string | null;
}

export const CHAT_DEFAULT: NotifyLevel = "all";
export const STAR_DEFAULT: NotifyLevel = "all";

export const LEVEL_LABEL: Record<NotifyLevel, string> = {
  all: "Все сообщения",
  mentions_only: "Только упоминания",
  replies: "Только ответы мне",
  mentions: "Упоминания и ответы мне",
  none: "Ничего",
};

type Settings = Record<string, NotifySetting>;

export const settingKey = (scope: NotifyScope, id: string) => `${scope}:${id}`;

export function mutedNow(setting: NotifySetting | undefined, now = Date.now()): boolean {
  return !!setting?.muted_until && Date.parse(setting.muted_until) > now;
}

export function chatLevel(settings: Settings, chatId: string, now = Date.now()): NotifyLevel {
  const s = settings[settingKey("chat", chatId)];
  if (mutedNow(s, now)) return "none";
  return s?.level ?? CHAT_DEFAULT;
}

/** Уровень Звезды без учёта Спутника — для подписи «Как в Звезде (…)». */
export function starLevel(settings: Settings, starId: string, now = Date.now()): NotifyLevel {
  const s = settings[settingKey("star", starId)];
  if (mutedNow(s, now)) return "none";
  return s?.level ?? STAR_DEFAULT;
}

export function channelLevel(settings: Settings, starId: string, channelId: string, now = Date.now()): NotifyLevel {
  const star = settings[settingKey("star", starId)];
  const channel = settings[settingKey("channel", channelId)];
  if (mutedNow(star, now) || mutedNow(channel, now)) return "none";
  return channel?.level ?? star?.level ?? STAR_DEFAULT;
}

/** Показать ли всплывашку и звук. */
export function wants(level: NotifyLevel, mentioned: boolean, replied = false): boolean {
  return level === "all" || (level === "mentions_only" && mentioned) || (level === "replies" && replied) || (level === "mentions" && (mentioned || replied));
}

/** Варианты «выключить на…»; null — навсегда (уровень «Ничего»). */
export const MUTE_OPTIONS: { label: string; minutes: number }[] = [
  { label: "На 1 час", minutes: 60 },
  { label: "На 8 часов", minutes: 8 * 60 },
  { label: "На сутки", minutes: 24 * 60 },
  { label: "На неделю", minutes: 7 * 24 * 60 },
];

interface NotifyState {
  settings: Settings;
  loaded: boolean;
  load: () => Promise<void>;
  save: (scope: NotifyScope, targetId: string, body: { level: NotifyLevel | null; muted_until: string | null }) => Promise<void>;
  reset: () => void;
}

export const useNotifyStore = create<NotifyState>((set, get) => {
  let epoch = 0, revision = 0;
  let pending: Promise<void> | null = null;
  const changes = new Map<string, {revision: number; setting: NotifySetting}>();
  const apply = (s: NotifySetting) => {
    changes.set(settingKey(s.scope, s.target_id), {revision: ++revision, setting: s});
    set((st) => {
      const settings = { ...st.settings };
      const key = settingKey(s.scope, s.target_id);
      if (s.level === null && !s.muted_until) delete settings[key];
      else settings[key] = s;
      return { settings };
    });
  };

  socket.on((event) => {
    if (event.type === "notify_setting") apply(event as unknown as NotifySetting);
  });
  socket.onStatus?.((open) => {if (open && get().loaded) void get().load().catch(() => {});});

  return {
    settings: {},
    loaded: false,
    load: () => {
      if (pending) return pending;
      const actor = epoch, started = revision;
      const task = http.get<NotifySetting[]>("/users/me/notify").then(({data: list}) => {
        if (actor !== epoch) return;
        const settings: Settings = Object.fromEntries(list.map(s => [settingKey(s.scope, s.target_id), s]));
        for (const [key, change] of changes) if (change.revision > started) {
          const value = change.setting;
          if (value.level === null && !value.muted_until) delete settings[key]; else settings[key] = value;
        }
        set({settings, loaded: true});
      }).finally(() => {if (pending === task) pending = null;});
      pending = task;
      return task;
    },
    save: async (scope, targetId, body) => {
      const actor = epoch;
      const out = (await http.put<NotifySetting>(`/users/me/notify/${scope}/${targetId}`, body)).data;
      if (actor !== epoch) return;
      apply(out);
      if (!get().loaded) void get().load().catch(() => {});
    },
    reset: () => {epoch++; pending = null; changes.clear(); set({ settings: {}, loaded: false });},
  };
});

/** «Выключены до 18:30», «Только упоминания» — для подписи в списке и настройках. */
export function levelSummary(level: NotifyLevel, setting: NotifySetting | undefined, now = Date.now()): string {
  if (mutedNow(setting, now)) {
    const until = new Date(setting!.muted_until!);
    const sameDay = until.toDateString() === new Date(now).toDateString();
    const time = until.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    return `Выключены до ${sameDay ? time : `${until.toLocaleDateString("ru-RU", { day: "numeric", month: "short" })} ${time}`}`;
  }
  return level === "none" ? "Выключены" : LEVEL_LABEL[level];
}
