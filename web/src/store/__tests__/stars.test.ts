import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StarDetail, StarEvent, StarMessage } from "../../api/stars";

const memoryStorage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => memoryStorage.get(k) ?? null,
  setItem: (k: string, v: string) => void memoryStorage.set(k, String(v)),
  removeItem: (k: string) => void memoryStorage.delete(k),
  clear: () => memoryStorage.clear(),
});

const handlers: ((e: unknown) => void)[] = [];
vi.mock("../../ws/socket", () => ({
  socket: {
    on: (h: (e: unknown) => void) => handlers.push(h),
    onStatus: () => () => {},
    send: () => {},
  },
}));

const ME = "me";

function detail(id: string, name = "Звезда"): StarDetail {
  return {
    id,
    name,
    kind: "gaming",
    owner_id: ME,
    created_at: "2026-10-01T00:00:00Z",
    member_count: 1,
    my_role: "owner",
    my_permissions: ["invite", "delete_messages", "kick", "manage_channels"],
    role_permissions: { moderator: [], member: [] },
    voice: {},
    floors: [],
    members: [
      {
        user: { id: ME, username: "я", avatar_url: null },
        role: "owner",
        joined_at: "2026-10-01T00:00:00Z",
      },
    ],
    channels: [
      { id: `${id}-planet`, star_id: id, kind: "planet", name: "Общая", position: 0, capacity: 10, room_kind: null, access: "open", floor_id: null, map_x: null, map_y: null, map_w: null, map_h: null },
      { id: `${id}-general`, star_id: id, kind: "satellite", name: "общий", position: 0, capacity: null, room_kind: null, access: "open", floor_id: null, map_x: null, map_y: null, map_w: null, map_h: null },
      { id: `${id}-news`, star_id: id, kind: "satellite", name: "новости", position: 1, capacity: null, room_kind: null, access: "open", floor_id: null, map_x: null, map_y: null, map_w: null, map_h: null },
    ],
  };
}

function message(starId: string, channelId: string, id: string, from = "other"): StarMessage {
  return {
    id,
    star_id: starId,
    channel_id: channelId,
    sender: { id: from, username: from, avatar_url: null },
    text: `текст ${id}`,
    created_at: "2026-10-16T10:00:00Z",
  };
}

const details: Record<string, StarDetail> = {};

vi.mock("../../api/stars", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/stars")>();
  return {
    ...actual,
    starsApi: {
      list: async () =>
        Object.values(details).map(({ id, name, kind, owner_id, created_at, member_count, my_role }) => ({
          id, name, kind, owner_id, created_at, member_count, my_role,
        })),
      limits: async () => ({ max_owned_stars: 2, owned_stars: 1 }),
      get: async (id: string) => {
        if (!details[id]) throw new Error("404");
        return details[id];
      },
      messages: async (starId: string, channelId: string) => [message(starId, channelId, "m0")],
      create: async (name: string) => {
        details.created = detail("created", name);
        return details.created;
      },
    },
  };
});

const { useStarsStore, unreadForStar } = await import("../stars");
const { useAuthStore } = await import("../auth");
const { useUiStore } = await import("../ui");

function emit(event: StarEvent) {
  for (const h of handlers) h(event);
}

beforeEach(() => {
  for (const k of Object.keys(details)) delete details[k];
  details.a = detail("a", "Альфа");
  details.b = detail("b", "Бета");
  useStarsStore.getState().reset();
  useAuthStore.setState({ user: { id: ME, username: "я" } as never });
  useUiStore.setState({ tab: "stars" });
});

describe("stars store", () => {
  it("opens the first star on its first satellite with history", async () => {
    await useStarsStore.getState().load();
    const st = useStarsStore.getState();
    expect(st.activeStarId).toBe("a");
    expect(st.activeChannelByStar.a).toBe("a-general");
    expect(st.messages["a-general"]).toHaveLength(1);
  });

  it("counts unread only for channels not on screen", async () => {
    await useStarsStore.getState().load();
    emit({ type: "star_message", star_id: "a", message: message("a", "a-general", "m1") });
    emit({ type: "star_message", star_id: "a", message: message("a", "a-news", "m2") });
    emit({ type: "star_message", star_id: "b", message: message("b", "b-general", "m3") });
    emit({ type: "star_message", star_id: "a", message: message("a", "a-news", "m4", ME) });

    const st = useStarsStore.getState();
    expect(st.messages["a-general"].map((m) => m.id)).toEqual(["m0", "m1"]);
    expect(st.unread["a-general"]).toBeUndefined();
    expect(st.unread["a-news"]?.count).toBe(1);
    expect(unreadForStar(st.unread, "b")).toBe(1);

    await useStarsStore.getState().selectChannel("a-news");
    expect(useStarsStore.getState().unread["a-news"]).toBeUndefined();
  });

  it("counts unread when the user is on another tab", async () => {
    await useStarsStore.getState().load();
    useUiStore.setState({ tab: "chats" });
    emit({ type: "star_message", star_id: "a", message: message("a", "a-general", "m1") });
    expect(useStarsStore.getState().unread["a-general"]?.count).toBe(1);
  });

  it("forgets a star after a kick and explains why", async () => {
    await useStarsStore.getState().load();
    emit({ type: "star_removed", star_id: "a", reason: "kick" });
    const st = useStarsStore.getState();
    expect(st.stars.map((s) => s.id)).toEqual(["b"]);
    expect(st.activeStarId).toBe("b");
    expect(st.notice).toBe("Вас исключили из Звезды «Альфа»");
  });

  it("switches away from a deleted channel", async () => {
    await useStarsStore.getState().load();
    await useStarsStore.getState().selectChannel("a-news");
    emit({ type: "star_channel_deleted", star_id: "a", channel_id: "a-news" });
    const st = useStarsStore.getState();
    expect(st.details.a.channels.some((c) => c.id === "a-news")).toBe(false);
    expect(st.activeChannelByStar.a).toBe("a-general");
  });

  it("keeps members in sync", async () => {
    await useStarsStore.getState().load();
    emit({
      type: "star_member_upsert",
      star_id: "a",
      member: { user: { id: "u2", username: "гость", avatar_url: null }, role: "member", joined_at: "2026-10-16T00:00:00Z" },
    });
    expect(useStarsStore.getState().details.a.member_count).toBe(2);
    emit({ type: "star_member_removed", star_id: "a", user_id: "u2", reason: "leave" });
    expect(useStarsStore.getState().details.a.member_count).toBe(1);
  });

  it("applies floor list and saved layouts from other people", async () => {
    await useStarsStore.getState().load();
    emit({
      type: "star_floors",
      star_id: "a",
      floors: [
        { id: "f2", name: "2 этаж", position: 1, version: 0 },
        { id: "f1", name: "1 этаж", position: 0, version: 4 },
      ],
    });
    expect(useStarsStore.getState().details.a.floors.map((f) => f.id)).toEqual(["f1", "f2"]);

    emit({
      type: "star_layout",
      star_id: "a",
      floor: { id: "f1", name: "1 этаж", position: 0, version: 5 },
      rooms: [{ channel_id: "a-planet", x: 3, y: 4, w: 6, h: 5 }],
    });
    const st = useStarsStore.getState().details.a;
    expect(st.floors.find((f) => f.id === "f1")?.version).toBe(5);
    expect(st.channels.find((c) => c.id === "a-planet")).toMatchObject({ map_x: 3, map_y: 4, map_w: 6, map_h: 5 });
  });

  it("selects a newly created star", async () => {
    await useStarsStore.getState().load();
    await useStarsStore.getState().createStar("Новая", "gaming");
    const st = useStarsStore.getState();
    expect(st.activeStarId).toBe("created");
    expect(st.stars.map((s) => s.id)).toContain("created");
  });
});
