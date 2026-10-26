import { describe, expect, it } from "vitest";
import { insertMention, mentionQuery, mentionsName, splitMentions, suggestNames } from "../mentions";
import { cleanFileName, encodeFile, fileIcon, formatSize, parseFile } from "../../attachments/file";
import { channelLevel, chatLevel, levelSummary, wants, type NotifySetting } from "../../notifications/levels";

describe("mentions", () => {
  it("splits @names like the server parses them", () => {
    expect(splitMentions("@Alice, привет! почта x@alice.ru и @bob.k.")).toEqual([
      { type: "mention", text: "@Alice", name: "Alice" },
      { type: "text", text: ", привет! почта x@alice.ru и " },
      { type: "mention", text: "@bob.k", name: "bob.k" },
      { type: "text", text: "." },
    ]);
    expect(mentionsName("эй @ALICE", "alice")).toBe(true);
    expect(mentionsName("@все на планёрку", "alice")).toBe(true);
    expect(mentionsName("@все на планёрку", "alice", false)).toBe(false);
    expect(mentionsName("alice@mail.ru", "alice")).toBe(false);
  });

  it("suggests and inserts at the caret", () => {
    expect(mentionQuery("привет @al", 10)).toEqual({ start: 7, query: "al" });
    expect(mentionQuery("mail@al", 7)).toBeNull();
    expect(mentionQuery("@al bob", 7)).toBeNull();
    expect(suggestNames(["bob", "alice", "malika"], "al")).toEqual(["alice", "malika"]);
    expect(insertMention("привет @al как дела", 7, 10, "alice")).toEqual({ text: "привет @alice как дела", caret: 14 });
  });
});

describe("files", () => {
  it("round-trips and sanitizes the name", () => {
    const ref = { id: "0f0e0d0c-0000-4000-8000-000000000001", key: "k", name: "../../отчёт.pdf", mime: "application/pdf", size: 10 };
    expect(parseFile(encodeFile(ref))?.name).toBe("отчёт.pdf");
    expect(parseFile("FILE1:{bad")).toBeNull();
    expect(parseFile(encodeFile({ ...ref, id: "x" }))).toBeNull();
    expect(cleanFileName("a\u0000b.txt")).toBe("ab.txt");
    expect(cleanFileName("...")).toBe("file");
  });

  it("formats sizes and icons", () => {
    expect(formatSize(512)).toBe("512 Б");
    expect(formatSize(1536)).toBe("1,5 КБ");
    expect(formatSize(50 * 1024 * 1024)).toBe("50 МБ");
    expect(formatSize(2 * 1024 * 1024)).toBe("2 МБ");
    expect(fileIcon("Отчёт.PDF")).toBe("📕");
    expect(fileIcon("x.unknown")).toBe("📎");
  });
});

describe("notify levels", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  const set = (scope: NotifySetting["scope"], id: string, level: NotifySetting["level"], muted?: string) => ({
    [`${scope}:${id}`]: { scope, target_id: id, level, muted_until: muted ?? null },
  });

  it("resolves channel → star → default, with mute winning", () => {
    expect(channelLevel({}, "s", "c", now)).toBe("mentions");
    expect(channelLevel(set("star", "s", "all"), "s", "c", now)).toBe("all");
    expect(channelLevel({ ...set("star", "s", "all"), ...set("channel", "c", "none") }, "s", "c", now)).toBe("none");
    expect(channelLevel(set("star", "s", "all", "2026-10-27T13:00:00Z"), "s", "c", now)).toBe("none");
    expect(channelLevel(set("star", "s", "all", "2026-10-27T11:00:00Z"), "s", "c", now)).toBe("all");
    expect(chatLevel({}, "x", now)).toBe("all");
  });

  it("decides and describes", () => {
    expect([wants("all", false), wants("mentions", false), wants("mentions", true), wants("none", true)]).toEqual([
      true,
      false,
      true,
      false,
    ]);
    const muted = { scope: "chat" as const, target_id: "x", level: null, muted_until: "2026-10-27T13:30:00Z" };
    expect(levelSummary("all", muted, now)).toMatch(/^Выключены до \d\d:30$/);
    expect(levelSummary("mentions", undefined, now)).toBe("Только упоминания");
  });
});
