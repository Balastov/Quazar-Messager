import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledStarMessage, StarDetail, StarEvent, StarMessage } from "../../api/stars";

const memoryStorage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => memoryStorage.get(k) ?? null,
  setItem: (k: string, v: string) => void memoryStorage.set(k, String(v)),
  removeItem: (k: string) => void memoryStorage.delete(k),
  clear: () => memoryStorage.clear(),
});

const handlers: ((e: unknown) => void)[] = [];
const statusHandlers: ((open: boolean) => void)[] = [];
vi.mock("../../ws/socket", () => ({
  socket: {
    on: (h: (e: unknown) => void) => handlers.push(h),
    onStatus: (h: (open: boolean) => void) => {
      statusHandlers.push(h);
      return () => {};
    },
    send: () => {},
  },
}));

/** Сбой при загрузке Звезды: сеть (без ответа) или ответ сервера с кодом. */
let failGet: { status?: number } | null = null;

const ME = "me";

function detail(id: string, name = "Звезда"): StarDetail {
  return {
    id,
    name,
    kind: "gaming",
    owner_id: ME,
    avatar_url: null,
    background_url: null,
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
        if (failGet) {
          throw { isAxiosError: true, response: failGet.status ? { status: failGet.status } : undefined };
        }
        if (!details[id]) throw { isAxiosError: true, response: { status: 404 } };
        return details[id];
      },
      messages: async (starId: string, channelId: string) => [message(starId, channelId, "m0")],
      scheduled: vi.fn(),
      schedule: vi.fn(),
      cancelScheduled: vi.fn(),
      thread: async (starId: string, channelId: string, rootId: string) => [
        message(starId, channelId, rootId),
        { ...message(starId, channelId, "r0"), thread_id: rootId },
      ],
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
const { starsApi } = await import("../../api/stars");

function emit(event: StarEvent) {
  for (const h of handlers) h(event);
}

beforeEach(() => {
  vi.mocked(starsApi.scheduled).mockReset().mockResolvedValue([]);
  vi.mocked(starsApi.schedule).mockReset();
  vi.mocked(starsApi.cancelScheduled).mockReset().mockResolvedValue({} as never);
  failGet = null;
  for (const k of Object.keys(details)) delete details[k];
  details.a = detail("a", "Альфа");
  details.b = detail("b", "Бета");
  useStarsStore.getState().reset();
  useAuthStore.setState({ user: { id: ME, username: "я" } as never });
  useUiStore.setState({ tab: "stars" });
});

describe("scheduled satellite messages", () => {
  const at = new Date("2026-12-01T12:00:00Z");
  const item: ScheduledStarMessage = {
    id: "later-1", star_id: "a", channel_id: "a-general", text: "Позже",
    send_at: at.toISOString(), created_at: "2026-10-30T10:00:00Z",
    reply_to_id: "reply-1", ack_required: false, link_preview: null,
  };

  it("queues in the explicitly chosen channel even if a different Star is active", async () => {
    await useStarsStore.getState().load();
    await useStarsStore.getState().selectStar("b");
    const before = useStarsStore.getState().messages["a-general"];
    vi.mocked(starsApi.schedule).mockResolvedValue(item);
    await useStarsStore.getState().scheduleMessage("a", "a-general", "Позже", at, { reply_to_id: "reply-1" });
    expect(starsApi.schedule).toHaveBeenCalledWith("a", "a-general", "Позже", at, { reply_to_id: "reply-1" });
    expect(useStarsStore.getState().scheduled["a-general"]).toEqual([item]);
    expect(useStarsStore.getState().messages["a-general"]).toBe(before);
  });

  it("orders the queue by delivery time", async () => {
    const later = { ...item, id: "later-2", send_at: "2026-12-02T12:00:00Z" };
    vi.mocked(starsApi.schedule).mockResolvedValueOnce(later).mockResolvedValueOnce(item);
    await useStarsStore.getState().scheduleMessage("a", "a-general", "Завтра", new Date(later.send_at));
    await useStarsStore.getState().scheduleMessage("a", "a-general", "Позже", at);
    expect(useStarsStore.getState().scheduled["a-general"].map((x) => x.id)).toEqual([item.id, later.id]);
  });

  it("keeps the queue on cancellation failure and removes the item after success", async () => {
    useStarsStore.setState({ scheduled: { "a-general": [item] } });
    vi.mocked(starsApi.cancelScheduled).mockRejectedValueOnce(new Error("offline"));
    await expect(useStarsStore.getState().cancelScheduled("a", "a-general", item.id)).rejects.toThrow("offline");
    expect(useStarsStore.getState().scheduled["a-general"]).toEqual([item]);
    await useStarsStore.getState().cancelScheduled("a", "a-general", item.id);
    expect(starsApi.cancelScheduled).toHaveBeenLastCalledWith("a", "a-general", item.id);
    expect(useStarsStore.getState().scheduled["a-general"]).toEqual([]);
  });

  it("refreshes a loaded queue when another device changes it or delivery occurs", async () => {
    useStarsStore.setState({ scheduled: { "a-general": [item] } });
    emit({ type: "star_scheduled_changed", star_id: "a", channel_id: "a-general" });
    await vi.waitFor(() => expect(useStarsStore.getState().scheduled["a-general"]).toEqual([]));
    expect(starsApi.scheduled).toHaveBeenCalledWith("a", "a-general");
  });

  it("does not refill the queue from an old account after logout", async () => {
    let finish!: (items: ScheduledStarMessage[]) => void;
    vi.mocked(starsApi.scheduled).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const loading = useStarsStore.getState().loadScheduled("a", "a-general");
    useAuthStore.setState({ user: null });
    useStarsStore.getState().reset();
    finish([item]);
    await loading;
    expect(useStarsStore.getState().scheduled).toEqual({});
  });

  it("does not let an earlier list response hide a newly queued message", async () => {
    let finish!: (items: ScheduledStarMessage[]) => void;
    vi.mocked(starsApi.scheduled).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const loading = useStarsStore.getState().loadScheduled("a", "a-general");
    vi.mocked(starsApi.schedule).mockResolvedValue(item);
    await useStarsStore.getState().scheduleMessage("a", "a-general", "Позже", at);
    finish([]);
    await loading;
    expect(useStarsStore.getState().scheduled["a-general"]).toEqual([item]);
  });
});

describe("star list stays in sync", () => {
  it("a network error while opening a Star keeps it in the list", async () => {
    failGet = {}; // нет связи
    await useStarsStore.getState().load();
    let st = useStarsStore.getState();
    expect(st.stars.map((s) => s.id)).toEqual(["a", "b"]);
    expect(st.activeStarId).toBe("a");
    expect(st.details.a).toBeUndefined();

    // Связь вернулась — Звезда открывается.
    failGet = null;
    for (const h of statusHandlers) h(true);
    await vi.waitFor(() => expect(useStarsStore.getState().details.a).toBeDefined());
    st = useStarsStore.getState();
    expect(st.stars.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("a server error (deploy) does not drop the Star either; 404 does", async () => {
    await useStarsStore.getState().load();
    failGet = { status: 502 };
    await useStarsStore.getState().refreshStar("b");
    expect(useStarsStore.getState().stars.map((s) => s.id)).toEqual(["a", "b"]);
    failGet = { status: 404 };
    await useStarsStore.getState().refreshStar("b");
    expect(useStarsStore.getState().stars.map((s) => s.id)).toEqual(["a"]);
  });

  it("reconnecting picks up Stars joined elsewhere and drops removed ones", async () => {
    await useStarsStore.getState().load();
    details.c = detail("c", "Гамма"); // вступил с телефона
    delete details.b; // выгнали, пока не было связи
    for (const h of statusHandlers) h(true);
    await vi.waitFor(() =>
      expect(useStarsStore.getState().stars.map((s) => s.id)).toEqual(["a", "c"])
    );
  });

  it("being accepted from another device adds the Star right away", async () => {
    await useStarsStore.getState().load();
    details.c = detail("c", "Гамма");
    emit({
      type: "star_member_upsert",
      star_id: "c",
      member: { user: { id: ME, username: "я", avatar_url: null }, role: "member", joined_at: "2026-10-21T00:00:00Z" },
    });
    await vi.waitFor(() => expect(useStarsStore.getState().stars.map((s) => s.id)).toContain("c"));
  });
});

describe("stars store", () => {
  it("sorts members by name when loading and after membership updates", async () => {
    const base = details.a.members[0];
    details.a.members = [
      { ...base, user: { ...base.user, id: "owner", username: "owner", display_name: "Яков" }, role: "owner" },
      { ...base, user: { ...base.user, id: "alice", username: "alice", display_name: "" }, role: "admin" },
      { ...base, user: { ...base.user, id: "anna", username: "zoya", display_name: "Анна" }, role: "member" },
    ];
    await useStarsStore.getState().load();
    const ids = () => useStarsStore.getState().details.a.members.map((m) => m.user.id);
    expect(ids()).toEqual(["anna", "owner", "alice"]);
    emit({ type: "star_member_upsert", star_id: "a", member: {
      ...base, user: { ...base.user, id: "boris", username: "boris", display_name: "Борис" }, role: "moderator",
    } });
    expect(ids()).toEqual(["anna", "boris", "owner", "alice"]);
    emit({ type: "star_member_upsert", star_id: "a", member: {
      ...base, user: { ...base.user, id: "anna", username: "zoya", display_name: "Zoë" }, role: "member",
    } });
    expect(ids()).toEqual(["boris", "owner", "alice", "anna"]);
  });

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

  it("shows a new Star avatar to everyone at once", async () => {
    await useStarsStore.getState().load();
    const url = "/media/avatars/stars/a.webp?v=1";
    emit({ type: "star_updated", star_id: "a", name: "Альфа", owner_id: ME, avatar_url: url, background_url: null });
    let st = useStarsStore.getState();
    expect(st.stars.find((s) => s.id === "a")?.avatar_url).toBe(url);
    expect(st.details.a?.avatar_url).toBe(url);

    emit({ type: "star_updated", star_id: "a", name: "Альфа", owner_id: ME, avatar_url: null, background_url: null });
    st = useStarsStore.getState();
    expect(st.stars.find((s) => s.id === "a")?.avatar_url).toBeNull();
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

describe("threads", () => {
  it("keeps replies out of the feed and unread, and updates the root summary", async () => {
    await useStarsStore.getState().load();
    useUiStore.setState({ tab: "chats" });
    const reply = (id: string) => ({ ...message("a", "a-general", id), thread_id: "m0" });

    emit({ type: "star_message", star_id: "a", message: reply("r1") });
    let st = useStarsStore.getState();
    expect(st.messages["a-general"].map((m) => m.id)).toEqual(["m0"]);
    expect(st.unread["a-general"]).toBeUndefined();

    emit({ type: "star_thread", star_id: "a", channel_id: "a-general", root_id: "m0", count: 2, last_at: "2026-10-16T11:00:00Z", participants: ["other"] });
    expect(useStarsStore.getState().messages["a-general"][0].thread_count).toBe(2);

    await useStarsStore.getState().openThread(useStarsStore.getState().messages["a-general"][0]);
    emit({ type: "star_message", star_id: "a", message: reply("r2") });
    st = useStarsStore.getState();
    expect(st.thread?.messages.map((m) => m.id)).toEqual(["m0", "r0", "r2"]);
    expect(st.messages["a-general"].map((m) => m.id)).toEqual(["m0"]);

    // Ответ правят и удаляют прямо в открытой ветке.
    emit({ type: "star_message_edited", star_id: "a", channel_id: "a-general", message_id: "r2", text: "исправлено", edited_at: "2026-10-16T12:00:00Z" });
    expect(useStarsStore.getState().thread?.messages[2].text).toBe("исправлено");
    emit({ type: "star_message_deleted", star_id: "a", channel_id: "a-general", message_id: "r0" });
    expect(useStarsStore.getState().thread?.messages.map((m) => m.id)).toEqual(["m0", "r2"]);

    // Корень удалили — ветка закрывается.
    emit({ type: "star_message_deleted", star_id: "a", channel_id: "a-general", message_id: "m0" });
    expect(useStarsStore.getState().thread).toBeNull();
  });

  it("keeps replies that arrive while the thread is loading", async () => {
    await useStarsStore.getState().load();
    const opening = useStarsStore.getState().openThread(useStarsStore.getState().messages["a-general"][0]);
    emit({ type: "star_message", star_id: "a", message: { ...message("a", "a-general", "early"), thread_id: "m0" } });
    await opening;
    expect(useStarsStore.getState().thread?.messages.map((m) => m.id)).toEqual(["m0", "r0", "early"]);
  });

  it("closes the thread when switching to another channel", async () => {
    await useStarsStore.getState().load();
    await useStarsStore.getState().openThread(useStarsStore.getState().messages["a-general"][0]);
    expect(useStarsStore.getState().thread?.rootId).toBe("m0");
    await useStarsStore.getState().selectChannel("a-news");
    expect(useStarsStore.getState().thread).toBeNull();
  });

  it("applies acknowledgement counts and work hours", async () => {
    await useStarsStore.getState().load();
    emit({ type: "star_ack", star_id: "a", channel_id: "a-general", message_id: "m0", ack_count: 3 });
    expect(useStarsStore.getState().messages["a-general"][0].ack_count).toBe(3);
    const schedule = { days: [1, 2, 3], start: "08:00", end: "17:00", tz: "UTC" };
    emit({ type: "star_work_hours", star_id: "a", enabled: true, schedule });
    expect(useStarsStore.getState().details.a).toMatchObject({ work_hours_enabled: true, work_hours: schedule });
  });
});

describe("mentions and notification levels", () => {
  it("counts mentions separately and toasts only what the level allows", async () => {
    const { useToastStore } = await import("../../notifications/toastStore");
    const { useNotifyStore } = await import("../../notifications/levels");
    const { mentionsForStar } = await import("../stars");
    useNotifyStore.setState({ settings: {} });
    useToastStore.setState({ toasts: [] });
    await useStarsStore.getState().load();
    useUiStore.setState({ tab: "chats" });

    // По умолчанию в Звёздах — только упоминания: обычное сообщение без всплывашки.
    emit({ type: "star_message", star_id: "a", message: message("a", "a-news", "p1") });
    expect(useToastStore.getState().toasts).toHaveLength(0);

    emit({ type: "star_message", star_id: "a", message: { ...message("a", "a-news", "p2"), mentions: [ME] } });
    const st = useStarsStore.getState();
    expect(st.unread["a-news"]).toMatchObject({ count: 2, mentions: 1 });
    expect(mentionsForStar(st.unread, "a")).toBe(1);
    expect(useToastStore.getState().toasts.map((t) => [t.starId, t.channelId])).toEqual([["a", "a-news"]]);

    // В этом Спутнике — «Ничего»: даже @все молчит.
    useNotifyStore.setState({
      settings: { "channel:a-news": { scope: "channel", target_id: "a-news", level: "none", muted_until: null } },
    });
    emit({ type: "star_message", star_id: "a", message: { ...message("a", "a-news", "p3"), mention_all: true } });
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });
});
