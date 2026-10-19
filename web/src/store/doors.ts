/**
 * Двери комнат Созвездия: приглашения («Позвать»), стук и ответы, зал ожидания.
 */
import { create } from "zustand";
import axios from "axios";
import { starsApi, type KnockAnswer, type KnockEvent, type StarEvent } from "../api/stars";
import { notifyDoor, type DoorLink } from "../notifications/notify";
import { socket } from "../ws/socket";
import { useAuthStore } from "./auth";
import { useStarsStore } from "./stars";
import { useUiStore } from "./ui";
import { useVoiceStore } from "./voice";

export interface Invite {
  starId: string;
  channelId: string;
  fromName: string;
  roomName: string;
  starName: string;
  expiresAt: number;
}

export interface MyKnock {
  knockId: string;
  starId: string;
  channelId: string;
  roomName: string;
  status: "pending" | "waiting";
  expiresAt: number;
}

interface DoorsState {
  invites: Invite[];
  /** Стуки, которые я вижу (в моей комнате или я могу впускать): id → событие. */
  knocks: Record<string, KnockEvent & { receivedAt: number }>;
  myKnock: MyKnock | null;
  notice: string | null;

  knock: (starId: string, channelId: string, roomName: string) => Promise<void>;
  cancelKnock: () => Promise<void>;
  answer: (knockId: string, action: KnockAnswer) => Promise<void>;
  invite: (starId: string, channelId: string, userId: string) => Promise<void>;
  acceptInvite: (invite: Invite) => Promise<void>;
  dismissInvite: (invite: Invite) => void;
  loadKnocks: (starId: string) => Promise<void>;
  openDoorLink: (link: DoorLink) => Promise<void>;
  dismissNotice: () => void;
  reset: () => void;
}

const KNOCK_TTL_MS = 120_000;

function errorText(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const detail = err.response?.data?.detail;
    if (typeof detail === "string") return detail;
  }
  return fallback;
}

/** Открыть Звезду и войти на Планету. */
async function goToPlanet(starId: string, channelId: string): Promise<void> {
  useUiStore.getState().setTab("stars");
  const stars = useStarsStore.getState();
  await stars.selectStar(starId);
  await useVoiceStore.getState().join(starId, channelId);
}

export const useDoorsStore = create<DoorsState>((set, get) => {
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;

  function watchMyKnock(knock: MyKnock) {
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => {
      const mine = get().myKnock;
      if (mine?.knockId === knock.knockId && mine.status === "pending") {
        set({ myKnock: null, notice: `Никто не ответил на стук в «${knock.roomName}». Попробуйте позже.` });
      }
    }, Math.max(0, knock.expiresAt - Date.now()));
  }

  function handle(event: StarEvent) {
    const myId = useAuthStore.getState().user?.id;
    switch (event.type) {
      case "planet_invite": {
        const invite: Invite = {
          starId: event.star_id,
          channelId: event.channel_id,
          fromName: event.from_name,
          roomName: event.room_name,
          starName: event.star_name,
          expiresAt: Date.now() + event.expires_in * 1000,
        };
        set((s) => ({
          invites: [...s.invites.filter((i) => i.channelId !== invite.channelId), invite],
        }));
        void notifyDoor(
          { starId: invite.starId, channelId: invite.channelId, door: "invite" },
          {
            title: `${invite.fromName} зовёт вас`,
            body: `в «${invite.roomName}» · ${invite.starName}`,
            actions: [{ action: "join", title: "Зайти" }],
          }
        );
        break;
      }
      case "planet_knock": {
        if (event.knock.user_id === myId) break;
        const isNew = !get().knocks[event.knock.id];
        set((s) => ({ knocks: { ...s.knocks, [event.knock.id]: { ...event, receivedAt: Date.now() } } }));
        if (isNew && event.knock.status === "pending") {
          void notifyDoor(
            { starId: event.star_id, channelId: event.knock.channel_id, door: "knock", knockId: event.knock.id },
            {
              title: `${event.user_name} стучится`,
              body: `в «${event.room_name}» · ${event.star_name}`,
              actions: [
                { action: "admit", title: "Впустить" },
                { action: "deny", title: "Отказать" },
              ],
            }
          );
        }
        break;
      }
      case "planet_knock_closed":
        set((s) => {
          const knocks = { ...s.knocks };
          delete knocks[event.knock_id];
          return { knocks };
        });
        break;
      case "planet_knock_answer": {
        const mine = get().myKnock;
        if (mine && mine.knockId !== event.knock_id) break;
        const link: DoorLink = {
          starId: event.star_id,
          channelId: event.channel_id,
          door: event.action,
          knockId: event.knock_id,
          lobbyChannelId: event.lobby_channel_id ?? null,
        };
        void get().openDoorLink(link);
        void notifyDoor(link, {
          title:
            event.action === "admit"
              ? "Вас впустили"
              : event.action === "wait"
                ? "Подождите в зале ожидания"
                : event.action === "free"
                  ? "Комната освободилась"
                  : "Вам отказали",
          body:
            event.action === "free"
              ? `«${event.room_name}» · ${event.star_name} — можно заходить`
              : `«${event.room_name}» · ${event.star_name}`,
        });
        break;
      }
    }
  }

  socket.on((event) => {
    if (event.type.startsWith("planet_")) handle(event as StarEvent);
  });

  return {
    invites: [],
    knocks: {},
    myKnock: null,
    notice: null,

    knock: async (starId, channelId, roomName) => {
      try {
        const knock = await starsApi.knock(starId, channelId);
        const mine: MyKnock = {
          knockId: knock.id,
          starId,
          channelId,
          roomName,
          status: knock.status,
          expiresAt: Date.now() + KNOCK_TTL_MS,
        };
        set({ myKnock: mine, notice: null });
        useVoiceStore.setState({ locked: null });
        watchMyKnock(mine);
      } catch (err) {
        set({ notice: errorText(err, "Не удалось постучаться") });
      }
    },

    cancelKnock: async () => {
      const mine = get().myKnock;
      if (!mine) return;
      set({ myKnock: null });
      await starsApi.cancelKnock(mine.starId, mine.knockId).catch(() => {});
    },

    answer: async (knockId, action) => {
      const knock = get().knocks[knockId];
      if (!knock) return;
      try {
        await starsApi.answerKnock(knock.star_id, knockId, action);
        if (action !== "wait") {
          set((s) => {
            const knocks = { ...s.knocks };
            delete knocks[knockId];
            return { knocks };
          });
        }
      } catch (err) {
        set({ notice: errorText(err, "Не удалось ответить на стук") });
        if (axios.isAxiosError(err) && err.response?.status === 404) {
          set((s) => {
            const knocks = { ...s.knocks };
            delete knocks[knockId];
            return { knocks };
          });
        }
      }
    },

    invite: async (starId, channelId, userId) => {
      await starsApi.invite(starId, channelId, userId);
    },

    acceptInvite: async (invite) => {
      get().dismissInvite(invite);
      await goToPlanet(invite.starId, invite.channelId);
    },

    dismissInvite: (invite) =>
      set((s) => ({ invites: s.invites.filter((i) => i.channelId !== invite.channelId) })),

    loadKnocks: async (starId) => {
      try {
        const list = await starsApi.knocks(starId);
        const myId = useAuthStore.getState().user?.id;
        set((s) => {
          const knocks = Object.fromEntries(
            Object.entries(s.knocks).filter(([, k]) => k.star_id !== starId)
          );
          for (const k of list) {
            if (k.knock.user_id !== myId) knocks[k.knock.id] = { ...k, receivedAt: Date.now() };
          }
          const mine = list.find((k) => k.knock.user_id === myId);
          return {
            knocks,
            myKnock:
              mine && !s.myKnock
                ? {
                    knockId: mine.knock.id,
                    starId,
                    channelId: mine.knock.channel_id,
                    roomName: mine.room_name,
                    status: mine.knock.status,
                    expiresAt: Date.now() + mine.expires_in * 1000,
                  }
                : s.myKnock,
          };
        });
      } catch {
        // не критично
      }
    },

    /** Открыть по уведомлению или по ответу на стук. */
    openDoorLink: async (link) => {
      switch (link.door) {
        case "invite":
          set((s) => ({ invites: s.invites.filter((i) => i.channelId !== link.channelId) }));
          await goToPlanet(link.starId, link.channelId);
          break;
        case "knock":
          useUiStore.getState().setTab("stars");
          await useStarsStore.getState().selectStar(link.starId);
          await get().loadKnocks(link.starId);
          if (link.knockId && (link.action === "admit" || link.action === "deny")) {
            await get().answer(link.knockId, link.action);
          }
          break;
        case "admit":
          set({ myKnock: null, notice: null });
          await goToPlanet(link.starId, link.channelId);
          break;
        case "wait": {
          const mine = get().myKnock;
          if (mine) set({ myKnock: { ...mine, status: "waiting", expiresAt: Date.now() + 3_600_000 } });
          set({ notice: "Вы в зале ожидания — вас впустят, когда смогут" });
          if (link.lobbyChannelId) await goToPlanet(link.starId, link.lobbyChannelId);
          break;
        }
        case "deny":
          set({ myKnock: null, notice: "Вам отказали во входе в комнату" });
          break;
        case "free": {
          // В комнате никого не осталось — дверь открыта, заходит человек сам.
          set({ myKnock: null, notice: "Комната освободилась — можно заходить" });
          useUiStore.getState().setTab("stars");
          const stars = useStarsStore.getState();
          await stars.selectStar(link.starId);
          await stars.selectChannel(link.channelId);
          stars.setMobileChannelOpen(true);
          break;
        }
      }
    },

    dismissNotice: () => set({ notice: null }),
    reset: () => {
      if (expiryTimer) clearTimeout(expiryTimer);
      set({ invites: [], knocks: {}, myKnock: null, notice: null });
    },
  };
});
