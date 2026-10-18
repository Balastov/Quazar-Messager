import { describe, expect, it } from "vitest";
import { splitLinks } from "../linkify";

const links = (text: string) =>
  splitLinks(text)
    .filter((p) => p.type === "link")
    .map((p) => (p.type === "link" ? [p.text, p.href] : []));

describe("splitLinks", () => {
  it("keeps plain text as one part", () => {
    expect(splitLinks("Привет! Как дела?")).toEqual([{ type: "text", text: "Привет! Как дела?" }]);
  });

  it("finds links with a scheme and keeps the text around them", () => {
    expect(splitLinks("смотри https://quazar-msg.ru/stars?x=1#top и пиши")).toEqual([
      { type: "text", text: "смотри " },
      { type: "link", text: "https://quazar-msg.ru/stars?x=1#top", href: "https://quazar-msg.ru/stars?x=1#top" },
      { type: "text", text: " и пиши" },
    ]);
    expect(links("http://example.com")).toEqual([["http://example.com", "http://example.com/"]]);
  });

  it("adds https to www. and bare domains with a known zone", () => {
    expect(links("www.youtube.com/watch?v=1")).toEqual([
      ["www.youtube.com/watch?v=1", "https://www.youtube.com/watch?v=1"],
    ]);
    expect(links("заходи на quazar-msg.ru")).toEqual([["quazar-msg.ru", "https://quazar-msg.ru/"]]);
    expect(links("сайт пример.рф/страница")[0][0]).toBe("пример.рф/страница");
  });

  it("does not treat files, emails and abbreviations as links", () => {
    expect(links("открой main.py и index.js, readme.md")).toEqual([]);
    expect(links("пиши на ivan@mail.ru")).toEqual([]);
    expect(links("т.е. и т.д. v1.2.3, 3.14")).toEqual([]);
    expect(links("https:// и www.")).toEqual([]);
  });

  it("drops trailing punctuation but keeps balanced parentheses", () => {
    expect(links("Вот: https://x.ru/a.")).toEqual([["https://x.ru/a", "https://x.ru/a"]]);
    expect(links("(см. https://x.ru/a)")).toEqual([["https://x.ru/a", "https://x.ru/a"]]);
    expect(links("https://ru.wikipedia.org/wiki/Свет_(значения)!")[0][0]).toBe(
      "https://ru.wikipedia.org/wiki/Свет_(значения)"
    );
    expect(links("«https://x.ru»")).toEqual([["https://x.ru", "https://x.ru/"]]);
  });

  it("splits a link glued to a word", () => {
    expect(splitLinks("тут:https://x.ru")).toEqual([
      { type: "text", text: "тут:" },
      { type: "link", text: "https://x.ru", href: "https://x.ru/" },
    ]);
  });

  it("only produces http(s) links", () => {
    expect(links("javascript:alert(1) data:text/html,x ftp://x.ru")).toEqual([]);
  });

  it("keeps line breaks and several links", () => {
    const parts = splitLinks("a.ru\nb.com");
    expect(parts.map((p) => p.text)).toEqual(["a.ru", "\n", "b.com"]);
    expect(parts.filter((p) => p.type === "link")).toHaveLength(2);
  });
});
