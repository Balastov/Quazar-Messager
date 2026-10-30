import { describe, expect, it } from "vitest";
import type { StarMember, StarRole } from "../../../api/stars";
import type { PresenceStatus } from "../../../utils/presence";
import { groupMembers } from "../members";

const now = new Date(2026, 9, 22, 15, 0);
const m = (id: string, role: StarRole = "member"): StarMember => ({
  user: { id, username: id, avatar_url: null },
  role,
  joined_at: "2026-10-01T00:00:00Z",
});
const st = (patch: Partial<PresenceStatus>): PresenceStatus => ({
  status: "offline",
  online: false,
  awaySince: null,
  lastSeen: null,
  manual: null,
  ...patch,
});

describe("groupMembers", () => {
  it("groups by status and sorts names, me always online", () => {
    const groups = groupMembers(
      [m("яна"), m("борис", "admin"), m("алла"), m("влад", "owner"), m("я"), m("гоша")],
      {
        "яна": st({ status: "online", online: true }),
        "борис": st({ status: "away", online: true, awaySince: new Date(now.getTime() - 12 * 60_000).toISOString() }),
        "алла": st({ status: "online", online: true, manual: { kind: "meeting", until: null } }),
        "влад": st({ status: "offline", lastSeen: new Date(now.getTime() - 5 * 60_000).toISOString() }),
      },
      "я",
      now
    );
    expect(groups.map((g) => [g.title, g.rows.map((r) => r.member.user.id)])).toEqual([
      ["В сети", ["алла", "я", "яна"]],
      ["Отошли", ["борис"]],
      ["Не в сети", ["влад", "гоша"]],
    ]);
    const text = Object.fromEntries(groups.flatMap((g) => g.rows.map((r) => [r.member.user.id, r.text])));
    expect(text).toMatchObject({
      "алла": "на встрече",
      "борис": "отошёл(ла) 12 мин назад",
      "влад": "был(а) 5 мин назад",
      "я": "в сети",
      "гоша": null, // статус неизвестен
    });
  });

  it("skips empty groups", () => {
    expect(groupMembers([m("я")], {}, "я", now).map((g) => g.key)).toEqual(["online"]);
  });

  it("sorts each status group by displayed name and script regardless of role or join date", () => {
    const members = [
      { ...m("owner", "owner"), user: { ...m("owner").user, display_name: "Яков" } },
      { ...m("zoya"), user: { ...m("zoya").user, display_name: "Анна" } },
      m("alice", "admin"),
      { ...m("first", "moderator"), user: { ...m("first").user, display_name: "123" } },
    ];
    const snapshot = members.slice();
    const groups = groupMembers(members, {}, undefined, now);
    expect(groups[0].rows.map((r) => r.member.user.id)).toEqual(["zoya", "owner", "alice", "first"]);
    expect(members).toEqual(snapshot);
  });
});
