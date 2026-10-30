import { describe, expect, it } from "vitest";
import { parseBlocks, parseInline, plainPreview, stripMarkup, type Inline } from "../markdown";
import { highlight, resolveLang } from "../highlight";
import { applyFormat, continueList, formatForKey, insideCodeFence } from "../format";

/** Компактная запись дерева: **x** → «b(x)», _x_ → «i(x)», ~~x~~ → «s(x)», `x` → «c(x)». */
function show(parts: Inline[]): string {
  return parts
    .map((p) =>
      p.t === "text" ? p.text : p.t === "code" ? `c(${p.text})` : `${p.t[0]}(${show(p.children)})`
    )
    .join("");
}

describe("строчная разметка", () => {
  it("жирный, курсив, зачёркнутый, код", () => {
    expect(show(parseInline("**жирный** и _курсив_ и *тоже* и ~~нет~~ и ~так~ и `код`"))).toBe(
      "b(жирный) и i(курсив) и i(тоже) и s(нет) и s(так) и c(код)"
    );
  });

  it("вложенная разметка", () => {
    expect(show(parseInline("**жирный _и курсив_**"))).toBe("b(жирный i(и курсив))");
    expect(show(parseInline("*курсив **и жирный** внутри*"))).toBe("i(курсив b(и жирный) внутри)");
  });

  it("не трогает обычный текст", () => {
    for (const text of [
      "snake_case_name",
      "__init__",
      "2*3*4 = 24",
      "a * b * c",
      "~ примерно ~",
      "**",
      "* не список в строке",
      "цена 5 * 3",
      "email_me@test.ru",
    ]) {
      expect(show(parseInline(text))).toBe(text);
    }
  });

  it("не режет ссылки", () => {
    expect(show(parseInline("https://x.ru/_a_/b_c_d"))).toBe("https://x.ru/_a_/b_c_d");
    expect(show(parseInline("**см. https://x.ru/a_b_**"))).toBe("b(см. https://x.ru/a_b_)");
    expect(show(parseInline("_тут www.x.ru/*a*_"))).toBe("i(тут www.x.ru/*a*)");
  });

  it("внутри кода разметки нет", () => {
    expect(show(parseInline("`**не жирный**` и **жирный**"))).toBe("c(**не жирный**) и b(жирный)");
    expect(show(parseInline("``код с ` кавычкой``"))).toBe("c(код с ` кавычкой)");
    expect(show(parseInline("`незакрытый"))).toBe("`незакрытый");
  });

  it("кириллица на границах слов", () => {
    expect(show(parseInline("слово_внутри_слова"))).toBe("слово_внутри_слова");
    expect(show(parseInline("(_курсив_)"))).toBe("(i(курсив))");
  });
});

describe("блоки", () => {
  it("абзацы сохраняют переносы", () => {
    expect(parseBlocks("раз\nдва\n\nтри")).toEqual([{ t: "para", children: [{ t: "text", text: "раз\nдва\n\nтри" }] }]);
  });

  it("блок кода с языком", () => {
    expect(parseBlocks("смотри:\n```ts\nconst a = 1;\n**b**\n```\nготово")).toEqual([
      { t: "para", children: [{ t: "text", text: "смотри:" }] },
      { t: "code", lang: "ts", text: "const a = 1;\n**b**" },
      { t: "para", children: [{ t: "text", text: "готово" }] },
    ]);
  });

  it("блок кода в одну строку и незакрытый", () => {
    expect(parseBlocks("```x = 1```")).toEqual([{ t: "code", lang: "", text: "x = 1" }]);
    expect(parseBlocks("```\nfoo\nbar")).toEqual([{ t: "code", lang: "", text: "foo\nbar" }]);
    expect(parseBlocks("```\nfoo\nbar```")).toEqual([{ t: "code", lang: "", text: "foo\nbar" }]);
    expect(parseBlocks("```print(1)\n```")).toEqual([{ t: "code", lang: "", text: "print(1)" }]);
  });

  it("цитата со вложенными блоками", () => {
    const [quote] = parseBlocks("> **важно**\n> - пункт");
    expect(quote.t).toBe("quote");
    if (quote.t !== "quote") return;
    expect(quote.children.map((b) => b.t)).toEqual(["para", "list"]);
  });

  it("смайлик >_< — не цитата", () => {
    expect(parseBlocks(">_<")[0].t).toBe("para");
  });

  it("списки: маркеры, номера автора, отступы", () => {
    const blocks = parseBlocks("- один\n* два\n  • вложенный\n3. три\n5) пять");
    expect(blocks).toHaveLength(2);
    const [bullets, numbered] = blocks;
    if (bullets.t !== "list" || numbered.t !== "list") throw new Error("не списки");
    expect(bullets.ordered).toBe(false);
    expect(bullets.items.map((i) => [i.depth, show(i.children)])).toEqual([[0, "один"], [0, "два"], [1, "вложенный"]]);
    expect(numbered.ordered).toBe(true);
    expect(numbered.items.map((i) => i.n)).toEqual([3, 5]);
  });

  it("превью без разметки", () => {
    expect(stripMarkup("**Итог**\n- `a`\n- _b_")).toBe("Итог\na\nb");
    expect(plainPreview("> цитата\n```js\nx()\n```")).toBe("цитата x()");
    expect(stripMarkup("обычный текст")).toBe("обычный текст");
  });
});

describe("подсветка", () => {
  const kinds = (code: string, lang: string) =>
    highlight(code, resolveLang(lang, code))
      .filter((t) => t.kind)
      .map((t) => `${t.kind}:${t.text}`);

  it("js: ключевые слова, строки, числа, комментарии, вызовы", () => {
    expect(kinds('const a = "x"; // c\nfoo(42)', "ts")).toEqual(["kw:const", 'str:"x"', "com:// c", "fn:foo", "num:42"]);
  });

  it("python: тройные кавычки, декораторы, литералы", () => {
    expect(kinds('@app.get\ndef f():\n    """doc"""\n    return None', "python")).toEqual([
      "meta:@app.get",
      "kw:def",
      "fn:f",
      'str:"""doc"""',
      "kw:return",
      "lit:None",
    ]);
  });

  it("sql без учёта регистра, json-ключи, diff", () => {
    expect(kinds("SELECT id FROM users", "sql")).toEqual(["kw:SELECT", "kw:FROM"]);
    expect(kinds('{"a": 1}', "")).toEqual(['prop:"a"', "num:1"]);
    expect(kinds("-old\n+new", "diff")).toEqual(["del:-old", "add:new".replace("add:", "add:+")]);
  });

  it("угадывает язык и не красит простой текст", () => {
    expect(resolveLang("", "SELECT * FROM t")).toBe("sql");
    expect(resolveLang("", "def main():\n    pass")).toBe("py");
    expect(resolveLang("", "const x = () => 1;")).toBe("js");
    expect(resolveLang("", "просто текст в блоке")).toBe("");
    expect(resolveLang("brainfuck", "+++")).toBe("");
    expect(highlight("abc", "").map((t) => t.text).join("")).toBe("abc");
  });

  it("токены собираются обратно в исходный код", () => {
    const code = 'fn main() {\n    let s = "a\\"b"; /* x */ println!("{}", s);\n}';
    expect(highlight(code, "rust").map((t) => t.text).join("")).toBe(code);
  });
});

describe("поле ввода", () => {
  it("оборачивает выделение и снимает повторно", () => {
    const on = applyFormat("привет мир", 7, 10, "bold");
    expect(on).toEqual({ value: "привет **мир**", start: 9, end: 12 });
    expect(applyFormat(on.value, on.start, on.end, "bold")).toEqual({ value: "привет мир", start: 7, end: 10 });
  });

  it("пустое выделение — пара знаков и курсор внутри", () => {
    expect(applyFormat("ab", 1, 1, "code")).toEqual({ value: "a``b", start: 2, end: 2 });
  });

  it("знаки прижимаются к тексту, разметка по строкам", () => {
    expect(applyFormat(" мир ", 0, 5, "italic").value).toBe(" _мир_ ");
    expect(applyFormat("раз\nдва", 0, 7, "strike").value).toBe("~~раз~~\n~~два~~");
  });

  it("цитата и списки по целым строкам, с переключением", () => {
    expect(applyFormat("раз\nдва", 1, 5, "quote").value).toBe("> раз\n> два");
    expect(applyFormat("> раз\n> два", 0, 11, "quote").value).toBe("раз\nдва");
    expect(applyFormat("раз\nдва", 0, 7, "numbered").value).toBe("1. раз\n2. два");
    expect(applyFormat("- раз\n- два", 0, 11, "numbered").value).toBe("1. раз\n2. два");
  });

  it("блок кода на отдельных строках", () => {
    expect(applyFormat("см x()", 3, 6, "codeblock").value).toBe("см \n```\nx()\n```");
  });

  it("Enter внутри ``` переносит строку", () => {
    expect(insideCodeFence("```js", 5)).toBe(true);
    expect(insideCodeFence("```\nfoo", 7)).toBe(true);
    expect(insideCodeFence("```\nfoo\n```", 11)).toBe(false);
    expect(insideCodeFence("```x```", 7)).toBe(false);
    expect(insideCodeFence("текст", 5)).toBe(false);
  });

  it("продолжение списка и выход из него", () => {
    expect(continueList("- раз", 5, 5)).toEqual({ value: "- раз\n- ", start: 8, end: 8 });
    expect(continueList("9. раз", 6, 6)?.value).toBe("9. раз\n10. ");
    expect(continueList("- раз\n- ", 8, 8)).toEqual({ value: "- раз\n", start: 6, end: 6 });
    expect(continueList("просто", 6, 6)).toBeNull();
  });

  it("сочетания по физическим клавишам", () => {
    const key = (code: string, extra: Partial<{ shiftKey: boolean; altKey: boolean }> = {}) =>
      formatForKey({ code, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, ...extra });
    expect(key("KeyB")).toBe("bold");
    expect(key("KeyX", { shiftKey: true })).toBe("strike");
    expect(key("KeyC", { shiftKey: true, altKey: true })).toBe("codeblock");
    expect(key("KeyV")).toBeNull();
    expect(formatForKey({ code: "KeyB", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false })).toBeNull();
  });
});
