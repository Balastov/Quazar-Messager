import { describe, expect, it } from "vitest";
import type { StarChannel, StarDetail, StarMember, VoicePresence } from "../../../api/stars";
import { latestPass, passUntil, presenceAvatar, presenceName, ROLE_LABEL, roomDoor } from "../rules";
import { isStaff, roleRank } from "../../../store/stars";

const room = (patch: Partial<StarChannel> = {}): StarChannel => ({
  id: "room",
  star_id: "star",
  kind: "planet",
  name: "Сейф",
  position: 0,
  capacity: 10,
  room_kind: "meeting",
  access: "invite",
  floor_id: "closed",
  map_x: 0,
  map_y: 0,
  map_w: 4,
  map_h: 3,
  ...patch,
});

const member = (id: string, name: string, avatar: string | null = null) =>
  ({ user: { id, username: id, display_name: name, avatar_url: avatar }, role: "member" }) as unknown as StarMember;

const presence = (patch: Partial<VoicePresence>): VoicePresence => ({
  user_id: "x",
  joined_at: "",
  server_muted: false,
  ...patch,
});

const detail = (patch: Partial<StarDetail>) =>
  ({ my_role: "member", my_permissions: [], members: [], voice: {}, room_passes: {}, ...patch }) as unknown as StarDetail;

describe("guest link passes", () => {
  it("lets a pass holder into an invite room without knocking", () => {
    const occupied = { room: [presence({ user_id: "ann", is_host: true })] };
    expect(roomDoor(detail({ voice: occupied }), room(), "me").entersFreely).toBe(false);
    const holder = detail({ voice: occupied, room_passes: { room: "2026-11-15T18:00:00Z" } });
    expect(roomDoor(holder, room(), "me")).toMatchObject({ entersFreely: true, canAnswer: false, hostId: "ann" });
    // Пропуск — только в свою Комнату.
    expect(roomDoor(holder, room({ id: "other" }), "me").entersFreely).toBe(true);
    expect(roomDoor({ ...holder, voice: { other: occupied.room } } as StarDetail, room({ id: "other" }), "me").entersFreely).toBe(false);
  });

  it("tells when the link ends", () => {
    const d = detail({ room_passes: { a: "2026-11-15T10:00:00Z", b: "2026-11-16T10:00:00Z" } });
    expect(passUntil(d, "a")).toMatch(/15 ноября/);
    expect(passUntil(d, "nope")).toBeNull();
    expect(latestPass(d)).toMatch(/16 ноября/);
    expect(latestPass(detail({}))).toBeNull();
  });

  it("names people the visitor cannot find among members", () => {
    const d = detail({ members: [member("ann", "Анна", "/a.png")] });
    expect(presenceName(d, presence({ user_id: "ann", name: "Псевдоним" }))).toBe("Анна");
    expect(presenceAvatar(d, presence({ user_id: "ann" }))).toBe("/a.png");
    // Посетитель по ссылке: его нет в списке участников — имя и фото от сервера.
    const visitor = presence({ user_id: "carol", name: "Карол", avatar_url: "/c.png", visitor: true });
    expect(presenceName(d, visitor)).toBe("Карол");
    expect(presenceAvatar(d, visitor)).toBe("/c.png");
    // Гость без аккаунта — по имени со страницы гостя.
    expect(presenceName(d, presence({ user_id: "guest-1", guest_name: "Аудитор" }))).toBe("Аудитор");
    expect(presenceName(d, presence({ user_id: "nobody" }))).toBe("Участник");
  });

  it("ranks a visitor below every member", () => {
    expect(roleRank("visitor")).toBeLessThan(roleRank("member"));
    expect(isStaff("visitor")).toBe(false);
    expect(ROLE_LABEL.visitor).toBe("Гость по ссылке");
  });
});
