import { beforeEach, describe, expect, it, vi } from "vitest";

const memoryStorage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => memoryStorage.get(k) ?? null,
  setItem: (k: string, v: string) => void memoryStorage.set(k, String(v)),
  removeItem: (k: string) => void memoryStorage.delete(k),
  clear: () => memoryStorage.clear(),
});

const handlers: ((e: unknown) => void)[] = [];
vi.mock("../../ws/socket", () => ({
  socket: { on: (h: (e: unknown) => void) => handlers.push(h), send: () => {} },
}));
vi.mock("../../notifications/notify", () => ({ notifyDoor: vi.fn(async () => {}) }));

const knockApi = vi.fn(async () => ({
  id: "k1", star_id: "s1", channel_id: "room", user_id: "me", status: "pending", lobby_channel_id: null,
}));
const answerApi = vi.fn(async () => ({}));
vi.mock("../../api/stars", () => ({
  starsApi: {
    knock: (...a: unknown[]) => knockApi(...(a as [])),
    answerKnock: (...a: unknown[]) => answerApi(...(a as [])),
    cancelKnock: vi.fn(async () => ({})),
    invite: vi.fn(async () => ({})),
    knocks: vi.fn(async () => []),
  },
}));

const selectStar = vi.fn(async () => {});
vi.mock("../stars", () => ({
  useStarsStore: { getState: () => ({ selectStar, stars: [{ id: "s1", kind: "work" }, { id: "g1", kind: "gaming" }] }) },
}));
const playStarSound = vi.fn(async () => {});
vi.mock("../../sounds/starSounds", () => ({ playStarSound: (...a: unknown[]) => playStarSound(...(a as [])) }));

const join = vi.fn(async () => {});
vi.mock("../voice", () => ({
  useVoiceStore: { getState: () => ({ join, channelId: null, status: "idle" }), setState: () => {} },
}));

const { useDoorsStore } = await import("../doors");
const { useAuthStore } = await import("../auth");
const { useUiStore } = await import("../ui");

function emit(event: Record<string, unknown>) {
  for (const h of handlers) h(event);
}

beforeEach(() => {
  useDoorsStore.getState().reset();
  useAuthStore.setState({ user: { id: "me", username: "я" } as never });
  useUiStore.setState({ tab: "chats" });
  join.mockClear();
  selectStar.mockClear();
  answerApi.mockClear();
});

describe("entering a room (double click, office map)", () => {
  const room = {
    id: "room", star_id: "s1", kind: "planet", name: "Переговорная", position: 0, capacity: 2,
    room_kind: "meeting", access: "open", floor_id: null, map_x: null, map_y: null, map_w: null, map_h: null,
  };
  const detail = (_access: string, inside: string[] = [], extra: Record<string, unknown> = {}) =>
    ({
      id: "s1", kind: "work", my_role: "member", my_permissions: [],
      voice: { room: inside.map((id, i) => ({ user_id: id, joined_at: "", server_muted: false, is_host: i === 0 })) },
      ...extra,
    }) as never;

  it("walks into an open room", async () => {
    await useDoorsStore.getState().enterRoom(detail("open"), room as never);
    expect(join).toHaveBeenCalledWith("s1", "room");
    expect(knockApi).not.toHaveBeenCalled();
  });

  it("knocks when the door is closed to me", async () => {
    knockApi.mockClear();
    await useDoorsStore.getState().enterRoom(detail("invite", ["anna"]), { ...room, access: "invite" } as never);
    expect(join).not.toHaveBeenCalled();
    expect(knockApi).toHaveBeenCalledWith("s1", "room");
    expect(useDoorsStore.getState().myKnock?.channelId).toBe("room");
  });

  it("enters an empty invite room and the own cabinet without knocking", async () => {
    await useDoorsStore.getState().enterRoom(detail("invite"), { ...room, access: "invite" } as never);
    await useDoorsStore
      .getState()
      .enterRoom(detail("personal"), { ...room, access: "personal", cabinet_owner_id: "me" } as never);
    expect(join).toHaveBeenCalledTimes(2);
  });

  it("says the room is full", async () => {
    await useDoorsStore.getState().enterRoom(detail("open", ["a", "b"]), room as never);
    expect(join).not.toHaveBeenCalled();
    expect(useDoorsStore.getState().notice).toBe("Комната заполнена: Переговорная");
  });
});

describe("door sounds", () => {
  it("plays the invite sound of the Star kind", () => {
    playStarSound.mockClear();
    emit({
      type: "planet_invite", star_id: "g1", channel_id: "p1", from_user_id: "u2",
      from_name: "Анна", room_name: "Рейд", star_name: "Клан", expires_in: 300,
    });
    expect(playStarSound).toHaveBeenCalledWith("invite", "gaming");
  });

  it("plays the knock sound once per new knock", () => {
    playStarSound.mockClear();
    const knock = {
      type: "planet_knock", star_id: "s1", user_name: "Анна", room_name: "Переговорная", star_name: "Офис",
      knock: { id: "kk", channel_id: "room", user_id: "u2", status: "pending" },
    };
    emit(knock);
    emit(knock);
    expect(playStarSound).toHaveBeenCalledTimes(1);
    expect(playStarSound).toHaveBeenCalledWith("knock", "work");
  });
});

describe("doors store", () => {
  it("accepting an invite opens the Star and joins the room", async () => {
    emit({
      type: "planet_invite", star_id: "s1", channel_id: "room", from_user_id: "u2",
      from_name: "Анна", room_name: "Переговорная", star_name: "Офис", expires_in: 300,
    });
    const invite = useDoorsStore.getState().invites[0];
    expect(invite).toMatchObject({ fromName: "Анна", roomName: "Переговорная" });

    await useDoorsStore.getState().acceptInvite(invite);
    expect(useUiStore.getState().tab).toBe("stars");
    expect(selectStar).toHaveBeenCalledWith("s1");
    expect(join).toHaveBeenCalledWith("s1", "room");
    expect(useDoorsStore.getState().invites).toHaveLength(0);
  });

  it("admit lets me into the room I knocked on", async () => {
    await useDoorsStore.getState().knock("s1", "room", "Переговорная");
    expect(useDoorsStore.getState().myKnock).toMatchObject({ knockId: "k1", status: "pending" });

    emit({
      type: "planet_knock_answer", star_id: "s1", channel_id: "room", knock_id: "k1", action: "admit",
      room_name: "Переговорная", star_name: "Офис", by_name: "Модератор",
    });
    await vi.waitFor(() => expect(join).toHaveBeenCalledWith("s1", "room"));
    expect(useDoorsStore.getState().myKnock).toBeNull();
  });

  it("wait sends me to the waiting room", async () => {
    await useDoorsStore.getState().knock("s1", "room", "Переговорная");
    emit({
      type: "planet_knock_answer", star_id: "s1", channel_id: "room", knock_id: "k1", action: "wait",
      room_name: "Переговорная", star_name: "Офис", by_name: "Модератор", lobby_channel_id: "lobby",
    });
    await vi.waitFor(() => expect(join).toHaveBeenCalledWith("s1", "lobby"));
    expect(useDoorsStore.getState().myKnock?.status).toBe("waiting");
  });

  it("deny tells me and forgets the knock", async () => {
    await useDoorsStore.getState().knock("s1", "room", "Переговорная");
    emit({
      type: "planet_knock_answer", star_id: "s1", channel_id: "room", knock_id: "k1", action: "deny",
      room_name: "Переговорная", star_name: "Офис", by_name: "Модератор",
    });
    await vi.waitFor(() => expect(useDoorsStore.getState().notice).toMatch(/отказали/));
    expect(useDoorsStore.getState().myKnock).toBeNull();
    expect(join).not.toHaveBeenCalled();
  });

  it("shows other people's knocks until someone answers", async () => {
    const knock = {
      type: "planet_knock", star_id: "s1", user_name: "Борис", room_name: "Переговорная",
      star_name: "Офис", expires_in: 120,
      knock: { id: "k9", star_id: "s1", channel_id: "room", user_id: "u3", status: "pending", lobby_channel_id: null },
    };
    emit(knock);
    expect(Object.keys(useDoorsStore.getState().knocks)).toEqual(["k9"]);
    // Свой собственный стук в списке «кто стучится» не показываем.
    emit({ ...knock, knock: { ...knock.knock, id: "mine", user_id: "me" } });
    expect(Object.keys(useDoorsStore.getState().knocks)).toEqual(["k9"]);

    await useDoorsStore.getState().answer("k9", "admit");
    expect(answerApi).toHaveBeenCalledWith("s1", "k9", "admit");
    expect(useDoorsStore.getState().knocks.k9).toBeUndefined();

    emit(knock);
    emit({ type: "planet_knock_closed", star_id: "s1", knock_id: "k9" });
    expect(useDoorsStore.getState().knocks.k9).toBeUndefined();
  });

  it("answering from a notification button works after opening the app", async () => {
    await useDoorsStore.getState().openDoorLink({
      starId: "s1", channelId: "room", door: "knock", knockId: "k5", action: "deny",
    });
    // Стука нет в загруженном списке — отвечать не на что, но Звезда открыта.
    expect(selectStar).toHaveBeenCalledWith("s1");
    expect(useUiStore.getState().tab).toBe("stars");
  });
});
