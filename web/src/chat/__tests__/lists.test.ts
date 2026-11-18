import { describe, expect, it } from "vitest";
import type { Chat, Message, User } from "../../api/types";
import { chatsByLastMessage, contactRows } from "../lists";

const user = (id: string, username: string, display_name = username, extra: Partial<User> = {}) =>
  ({ id, username, display_name, avatar_url: null, created_at: "", ...extra }) as User;
const me = user("me", "me");
const chat = (id: string, type: Chat["type"], other: User | null, created_at = "2026-11-01T00:00:00Z") =>
  ({ id, type, name: null, created_at, members: [{ user: me }, ...(other ? [{ user: other }] : [])] }) as unknown as Chat;
const msg = (at: string) => ({ created_at: at }) as Message;

describe("chats tab", () => {
  it("keeps conversations only, newest message first, saved notes apart", () => {
    const anna = user("a", "anna"), boris = user("b", "boris"), dan = user("d", "dan");
    const chats = [chat("saved", "saved", null), chat("silent", "direct", dan), chat("old", "direct", anna),
      chat("new", "direct", boris), chat("group", "group", null, "2026-11-10T00:00:00Z")];
    const last: Record<string, Message | null> = { old: msg("2026-11-02T10:00:00Z"), new: msg("2026-11-12T10:00:00Z"), saved: msg("2026-11-20T00:00:00Z") };
    expect(chatsByLastMessage(chats, (c) => last[c.id] ?? null).map((c) => c.id)).toEqual(["new", "group", "old"]);
    // Закреплённые — сверху в порядке закрепления, даже без сообщений.
    expect(chatsByLastMessage(chats, (c) => last[c.id] ?? null, ["old", "silent"]).map((c) => c.id))
      .toEqual(["old", "silent", "new", "group"]);
  });
});

describe("contacts tab", () => {
  it("lists people from personal chats and the phone book from А to Я, by name, else by nickname", () => {
    const chats = [
      chat("c1", "direct", user("1", "zed", "Яна")),
      chat("c2", "direct", user("2", "anton", "anton")), // имя не заполнено — по никнейму
      chat("c3", "direct", user("3", "boris", "Борис")),
      chat("g", "group", user("4", "groupie", "Гена")),
      chat("bot", "support", user("5", "Quazar_Admin_bot", "Quazar_Admin_bot", { is_official: true })),
    ];
    const phonebook = [{ user: user("6", "vika", "Вика"), name: "Виктория (работа)" }, { user: user("3", "boris", "Борис"), name: "" }];
    const rows = contactRows(chats, phonebook, "me", { "6": "Виктория (работа)" });
    // Системные боты — тоже контакты, по алфавиту вместе со всеми; групп нет.
    expect(rows.map((r) => r.name)).toEqual(["Борис", "Виктория (работа)", "Яна", "anton", "Quazar_Admin_bot"]);
    expect(rows.find((r) => r.user.id === "5")).toMatchObject({ chatId: "bot", bot: "support" });
    expect(rows.find((r) => r.user.id === "3")?.chatId).toBe("c3");
    expect(rows.find((r) => r.user.id === "6")?.chatId).toBeNull();
    const pinned = contactRows(chats, phonebook, "me", { "6": "Виктория (работа)" }, ["2", "1"]);
    expect(pinned.map((r) => r.name).slice(0, 3)).toEqual(["anton", "Яна", "Борис"]);
  });
});
