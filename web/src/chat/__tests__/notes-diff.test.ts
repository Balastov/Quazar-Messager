import { describe, expect, it } from "vitest";
import { parseBlocks, stripMarkup } from "../markdown";
import { diffStats, lineDiff, wordDiff } from "../diff";

describe("заголовки в заметках", () => {
  it("только с опцией headings", () => {
    const text = "# Онбординг\n## Доступы\n### Мелочи\n---\nтекст";
    expect(parseBlocks(text, { headings: true }).map((b) => b.t)).toEqual(["heading", "heading", "heading", "rule", "para"]);
    // В сообщениях «# 1 пункт» — просто текст.
    expect(parseBlocks(text).map((b) => b.t)).toEqual(["para"]);
  });

  it("уровни, закрывающие решётки и «C#»", () => {
    const [h1, h2, h3] = parseBlocks("# Язык C#\n## Раздел ##\n#### не заголовок", { headings: true });
    expect(h1).toEqual({ t: "heading", level: 1, children: [{ t: "text", text: "Язык C#" }] });
    expect(h2).toEqual({ t: "heading", level: 2, children: [{ t: "text", text: "Раздел" }] });
    expect(h3.t).toBe("para");
    expect(parseBlocks("#хэштег", { headings: true })[0].t).toBe("para");
  });

  it("заголовки внутри цитаты и превью без значков", () => {
    const [quote] = parseBlocks("> # Важно", { headings: true });
    expect(quote.t === "quote" && quote.children[0].t).toBe("heading");
  });

  it("stripMarkup не теряет текст заметок", () => {
    expect(stripMarkup("**Итог** и `код`")).toBe("Итог и код");
  });
});

describe("diff", () => {
  it("по строкам: добавили, убрали, общее", () => {
    const parts = lineDiff("a\nb\nc\nd", "a\nc\nd\ne");
    expect(parts).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "same", text: "c" },
      { kind: "same", text: "d" },
      { kind: "add", text: "e" },
    ]);
    expect(diffStats(parts)).toEqual({ added: 1, removed: 1 });
  });

  it("одинаковые и пустые тексты", () => {
    expect(diffStats(lineDiff("x\ny", "x\ny"))).toEqual({ added: 0, removed: 0 });
    expect(lineDiff("", "новое")).toEqual([
      { kind: "del", text: "" },
      { kind: "add", text: "новое" },
    ]);
  });

  it("по словам, соседние части склеены", () => {
    expect(wordDiff("релиз в четверг вечером", "релиз в пятницу вечером")).toEqual([
      { kind: "same", text: "релиз в " },
      { kind: "del", text: "четверг" },
      { kind: "add", text: "пятницу" },
      { kind: "same", text: " вечером" },
    ]);
  });

  it("очень длинные тексты не считает по частям", () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join("\n");
    const stats = diffStats(lineDiff(a, b));
    expect(stats).toEqual({ added: 3000, removed: 3000 });
  });
});
