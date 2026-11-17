import { describe, expect, it } from "vitest";
import type { StarChannel, StarDetail, StarMember } from "../../../api/stars";
import { lfgFloor, needsFloorPeople, organizerCandidates } from "../lfgOrganizers";
import { doorKind, doorLabel, roomDoor } from "../rules";

const member = (id: string, username: string, display_name = username) =>
  ({ user: { id, username, display_name, avatar_url: null }, role: "member", joined_at: "" }) as unknown as StarMember;
const members = [member("me", "me"), member("b", "boris", "Борис"), member("a", "anna", "Анна"), member("c", "kate", "Катя")];
const floors = [{ id: "f1", name: "1 этаж" }, { id: "f2", name: "2 этаж" }] as StarDetail["floors"];

describe("gathering organizers", () => {
  it("picks the floor open on the map, else the first", () => {
    expect(lfgFloor(floors, "f2")?.id).toBe("f2");
    expect(lfgFloor(floors, "gone")?.id).toBe("f1");
    expect(lfgFloor([], undefined)).toBeNull();
  });

  it("asks the server about floor people only with several floors", () => {
    expect(needsFloorPeople({ kind: "work", floors })).toBe(true);
    expect(needsFloorPeople({ kind: "work", floors: floors.slice(0, 1) })).toBe(false);
    expect(needsFloorPeople({ kind: "gaming", floors: [] })).toBe(false);
  });

  it("offers everyone but me, from the floor, matching the search, sorted", () => {
    expect(organizerCandidates(members, null, "me", "").map((m) => m.user.id)).toEqual(["a", "b", "c"]);
    expect(organizerCandidates(members, ["b", "me"], "me", "").map((m) => m.user.id)).toEqual(["b"]);
    expect(organizerCandidates(members, null, "me", "@kat").map((m) => m.user.id)).toEqual(["c"]);
  });
});

describe("gathering door", () => {
  const room = {
    id: "r", kind: "planet", room_kind: null, access: "gathering",
    gathering_members: ["joined"], gathering_admins: ["author", "boss"],
  } as unknown as StarChannel;
  const detail = (perms: string[] = []) =>
    ({ my_permissions: perms, voice: {}, room_passes: {} }) as unknown as StarDetail;

  it("lets in the signed-up and organizers, and only organizers answer", () => {
    expect(doorKind(room)).toBe("gathering");
    expect(doorLabel("gathering")).toBe("для участников сбора");
    expect(roomDoor(detail(), room, "joined")).toMatchObject({ entersFreely: true, canAnswer: false });
    expect(roomDoor(detail(), room, "boss")).toMatchObject({ entersFreely: true, canAnswer: true });
    // Пустая комната сбора всем подряд не открывается.
    expect(roomDoor(detail(), room, "stranger")).toMatchObject({ entersFreely: false, canAnswer: false });
    expect(roomDoor(detail(["admit"]), room, "stranger")).toMatchObject({ entersFreely: true, canAnswer: true });
  });
});
