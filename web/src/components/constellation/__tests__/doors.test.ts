import { describe, expect, it } from "vitest";
import type { StarChannel, StarDetail, StarPerm, StarRole } from "../../../api/stars";
import { roomDoor } from "../rules";

const room = (patch: Partial<StarChannel>): StarChannel => ({
  id: "room",
  star_id: "star",
  kind: "planet",
  name: "Комната",
  position: 0,
  capacity: 10,
  room_kind: "meeting",
  access: "open",
  floor_id: null,
  map_x: null,
  map_y: null,
  map_w: null,
  map_h: null,
  ...patch,
});

const star = (role: StarRole, perms: StarPerm[], inside: { id: string; host?: boolean }[] = []) =>
  ({
    my_role: role,
    my_permissions: perms,
    voice: {
      room: inside.map((p) => ({
        user_id: p.id,
        joined_at: "",
        server_muted: false,
        is_host: !!p.host,
      })),
    },
  }) as unknown as StarDetail;

describe("room doors", () => {
  const invite = room({ access: "invite" });

  it("lets anyone into an empty invite room and makes the host answer", () => {
    expect(roomDoor(star("member", []), invite, "me").entersFreely).toBe(true);

    const occupied = star("member", [], [{ id: "ann", host: true }]);
    expect(roomDoor(occupied, invite, "me")).toMatchObject({ entersFreely: false, canAnswer: false, hostId: "ann" });
    expect(roomDoor(occupied, invite, "ann").canAnswer).toBe(true);
    // Право «Впускать» — как и раньше: без стука и с ответами на стук.
    expect(roomDoor(star("moderator", ["admit"], [{ id: "ann", host: true }]), invite, "me")).toMatchObject({
      entersFreely: true,
      canAnswer: true,
    });
  });

  it("opens a personal cabinet only to its owner", () => {
    const cabinet = room({ access: "personal", cabinet_owner_id: "boss" });
    expect(roomDoor(star("member", []), cabinet, "boss")).toMatchObject({ entersFreely: true, canAnswer: true });
    expect(roomDoor(star("owner", ["admit"]), cabinet, "me")).toMatchObject({ entersFreely: false, canAnswer: true });
    expect(roomDoor(star("admin", ["admit"]), cabinet, "me").canAnswer).toBe(true);
    expect(roomDoor(star("moderator", ["admit"]), cabinet, "me")).toMatchObject({ entersFreely: false, canAnswer: false });
  });

  it("treats the waiting room as open", () => {
    expect(roomDoor(star("member", []), room({ access: "personal", room_kind: "lobby" }), "me").kind).toBe("open");
  });
});
