import { describe, expect, it } from "vitest";
import type { StarMember, StarTag } from "../../../api/stars";
import { starMentionKind, starMentionOptions } from "../starMentions";
import { isAllWord } from "../../../chat/mentions";

const member = (id: string, tagIds: string[] = []): StarMember =>
  ({ user: { id, username: id }, role: "member", joined_at: "2026-10-30T00:00:00Z", tag_ids: tagIds }) as StarMember;

const tag = (id: string, name: string, handle: string | null): StarTag => ({
  id,
  name,
  color: "#22aa88",
  self_assign: false,
  handle,
  position: 0,
});

const detail = {
  members: [member("anna", ["t1"]), member("boris", ["t1", "t2"]), member("vera")],
  tags: [tag("t1", "Бэкенд", "backend"), tag("t2", "Дизайн", "Design"), tag("t3", "Танк", null)],
  my_role: "member" as const,
};

describe("упоминания в Звезде", () => {
  it("подсказывает группы с числом участников, без ролей без имени", () => {
    expect(starMentionOptions(detail)).toEqual([
      { name: "backend", hint: "Бэкенд · 2 человека" },
      { name: "Design", hint: "Дизайн · 1 человек" },
    ]);
  });

  it("модераторам — ещё @here и @channel", () => {
    const names = starMentionOptions({ ...detail, my_role: "moderator" }).map((o) => o.name);
    expect(names).toEqual(["backend", "Design", "here", "channel"]);
  });

  it("моя группа подсвечивается как упоминание меня", () => {
    const kind = starMentionKind(detail, "anna");
    expect(kind("Backend")).toBe("me");
    expect(kind("design")).toBe("other");
    expect(kind("anna")).toBe("me");
    expect(kind("vera")).toBe("other");
    expect(kind("Танк")).toBeNull();
    expect(kind("here")).toBe("other");
  });

  it("ник важнее группы с тем же именем", () => {
    const clash = { ...detail, tags: [tag("t9", "Вера-группа", "vera")] };
    expect(starMentionKind(clash, "anna")("vera")).toBe("other");
    expect(starMentionKind(clash, "vera")("vera")).toBe("me");
  });

  it("@channel, @канал, @here, @тут — массовые", () => {
    for (const w of ["channel", "Канал", "here", "тут", "здесь", "все"]) expect(isAllWord(w)).toBe(true);
    expect(isAllWord("backend")).toBe(false);
  });
});
