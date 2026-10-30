/**
 * Подсветка кода в блоках ```lang: лёгкий токенизатор без зависимостей. Не парсер — цвет для
 * ключевых слов, строк, чисел, комментариев и вызовов функций. Без языка — угадываем по виду,
 * не угадали — без подсветки. Те же правила в мобильной копии.
 */

export type TokenKind = "kw" | "str" | "num" | "com" | "fn" | "lit" | "prop" | "tag" | "attr" | "add" | "del" | "meta";
export interface Token {
  kind: TokenKind | null;
  text: string;
}

interface Lang {
  line?: string[];
  block?: [string, string][];
  quotes: string[];
  /** Строки в тройных кавычках (Python). */
  triple?: boolean;
  keywords: Set<string>;
  literals?: Set<string>;
  ignoreCase?: boolean;
  /** $VAR в bash. */
  vars?: boolean;
  /** «ключ:» в YAML / «"ключ":» в JSON — свойство. */
  props?: boolean;
  /** «@decorator», «#include». */
  meta?: string;
}

const words = (s: string) => new Set(s.split(" "));

const C_LITERALS = words("true false null nullptr NULL nil undefined NaN Infinity this self super");

const JS = words(
  "break case catch class const continue debugger default delete do else export extends finally for from function " +
    "if import in instanceof let new of return static switch throw try typeof var void while with yield async await " +
    "as interface type enum implements private protected public readonly abstract declare namespace keyof satisfies get set"
);
const PY = words(
  "and as assert async await break class continue def del elif else except finally for from global if import in is " +
    "lambda nonlocal not or pass raise return try while with yield match case print"
);
const GO = words(
  "break case chan const continue default defer else fallthrough for func go goto if import interface map package " +
    "range return select struct switch type var string int int64 int32 uint byte rune float64 bool error any"
);
const RUST = words(
  "as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub " +
    "ref return static struct trait type unsafe use where while Self i32 i64 u8 u32 u64 usize f64 bool str String Vec Option Result Some None Ok Err"
);
const JAVA = words(
  "abstract assert boolean break byte case catch char class const continue default do double else enum extends final " +
    "finally float for goto if implements import instanceof int interface long native new package private protected " +
    "public return short static strictfp super switch synchronized throw throws transient try void volatile while var " +
    "fun val when object companion data sealed override open internal suspend lateinit is in out " +
    "namespace using string bool decimal async await readonly ref get set"
);
const C = words(
  "auto break case char const continue default do double else enum extern float for goto if inline int long register " +
    "return short signed sizeof static struct switch typedef union unsigned void volatile while class namespace template " +
    "typename public private protected virtual override new delete using std bool constexpr include define"
);
const SQL = words(
  "select from where and or not insert into values update set delete create table drop alter add index primary key " +
    "foreign references join left right inner outer full on as group by order having limit offset distinct union all " +
    "case when then else end is null like in between exists returning with default constraint unique asc desc count " +
    "sum avg min max coalesce varchar text integer bigint boolean timestamp serial begin commit rollback"
);
const SH = words(
  "if then else elif fi for while until do done case esac in function return exit export local readonly echo cd " +
    "sudo source alias unset set shift break continue"
);
const CSS = words("important media import keyframes font-face supports from to");
const NONE = new Set<string>();

const LANGS: Record<string, Lang> = {
  js: { line: ["//"], block: [["/*", "*/"]], quotes: ['"', "'", "`"], keywords: JS, literals: C_LITERALS },
  py: { line: ["#"], quotes: ['"', "'"], triple: true, keywords: PY, literals: words("True False None self cls"), meta: "@" },
  go: { line: ["//"], block: [["/*", "*/"]], quotes: ['"', "'", "`"], keywords: GO, literals: words("true false nil iota") },
  rust: { line: ["//"], block: [["/*", "*/"]], quotes: ['"'], keywords: RUST, literals: words("true false self"), meta: "#" },
  java: { line: ["//"], block: [["/*", "*/"]], quotes: ['"', "'"], keywords: JAVA, literals: C_LITERALS, meta: "@" },
  c: { line: ["//"], block: [["/*", "*/"]], quotes: ['"', "'"], keywords: C, literals: C_LITERALS, meta: "#" },
  sql: { line: ["--"], block: [["/*", "*/"]], quotes: ["'", '"'], keywords: SQL, literals: words("true false null"), ignoreCase: true },
  sh: { line: ["#"], quotes: ['"', "'"], keywords: SH, literals: words("true false"), vars: true },
  json: { quotes: ['"'], keywords: NONE, literals: words("true false null"), props: true },
  yaml: { line: ["#"], quotes: ['"', "'"], keywords: NONE, literals: words("true false null yes no on off ~"), props: true },
  css: { block: [["/*", "*/"]], quotes: ['"', "'"], keywords: CSS, meta: "@" },
  php: { line: ["//", "#"], block: [["/*", "*/"]], quotes: ['"', "'"], keywords: JAVA, literals: C_LITERALS, vars: true },
  rb: { line: ["#"], quotes: ['"', "'"], keywords: words("def end class module if elsif else unless while until do return yield require begin rescue ensure then puts attr_accessor"), literals: words("true false nil self") },
};

const ALIASES: Record<string, string> = {
  javascript: "js", jsx: "js", ts: "js", typescript: "js", tsx: "js", mjs: "js", node: "js",
  python: "py", python3: "py", golang: "go", rs: "rust",
  kotlin: "java", kt: "java", csharp: "java", cs: "java", "c#": "java", scala: "java", swift: "java", dart: "java",
  cpp: "c", "c++": "c", h: "c", hpp: "c", objc: "c",
  postgres: "sql", postgresql: "sql", mysql: "sql", sqlite: "sql", psql: "sql",
  bash: "sh", shell: "sh", zsh: "sh", console: "sh", shellscript: "sh", dockerfile: "sh",
  yml: "yaml", toml: "yaml", ini: "yaml", env: "yaml",
  scss: "css", less: "css", ruby: "rb",
};

const MARKUP = new Set(["html", "xml", "svg", "vue", "jsx-html"]);

/** Язык блока: по подписи после ``` или по виду кода. */
export function resolveLang(lang: string, code: string): string {
  const l = lang.toLowerCase();
  if (l === "diff" || l === "patch") return "diff";
  if (MARKUP.has(l)) return "html";
  if (LANGS[l]) return l;
  if (ALIASES[l]) return ALIASES[l];
  if (l) return "";
  return guessLang(code);
}

function guessLang(code: string): string {
  const s = code.trim();
  if (!s) return "";
  if (/^[[{]/.test(s)) {
    try {
      JSON.parse(s);
      return "json";
    } catch {
      // не JSON
    }
  }
  if (/^<(!doctype|[a-z][\w-]*)[\s>/]/i.test(s)) return "html";
  if (/^(diff --git|--- |\+\+\+ |@@ )/m.test(s) && /^[+-]/m.test(s)) return "diff";
  if (/^\s*(select|insert\s+into|update|delete\s+from|create\s+(table|index)|alter\s+table|with)\s/i.test(s)) return "sql";
  const shellCommand = /^\s*(sudo|apt|brew|npm|npx|yarn|pip|git|docker|kubectl|curl|cd|export) /m.test(s);
  if (/^(#!\/|\$ )/.test(s) || (shellCommand && !/[;{}]\s*$/m.test(s))) return "sh";
  const pyImport = /^\s*(from \S+ )?import \S+\s*$/m.test(s);
  if (/^\s*(def|class) \w+.*:\s*$/m.test(s) || (pyImport && !/;\s*$/m.test(s))) return "py";
  if (/^\s*package \w+/m.test(s) && /\bfunc\b/.test(s)) return "go";
  if (/\bfn \w+\s*\(/.test(s) && /\blet (mut )?\w/.test(s)) return "rust";
  if (/^\s*(public |private )?(static )?(class|interface) \w+/m.test(s) && /;\s*$/m.test(s)) return "java";
  if (/^#include\s*[<"]/m.test(s)) return "c";
  if (/\b(const|let|var|function|import|export|interface|async)\b[\s\S]*([=;(]|=>)/.test(s)) return "js";
  if (/^[\w-]+:\s/m.test(s) && /^\s*[\w-]+:(\s|$)/m.test(s) && !/[;{}]/.test(s)) return "yaml";
  if (/^[.#]?[\w-]+[^{]*\{[\s\S]*:[^;]+;/m.test(s)) return "css";
  return "";
}

function isIdentStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_" || ch === "$";
}

function isIdent(ch: string | undefined): boolean {
  return !!ch && (isIdentStart(ch) || (ch >= "0" && ch <= "9"));
}

const NUM_RE = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[a-zA-Z%]*/;

function push(out: Token[], kind: TokenKind | null, text: string) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.kind === kind) last.text += text;
  else out.push({ kind, text });
}

function highlightDiff(code: string): Token[] {
  const out: Token[] = [];
  code.split("\n").forEach((line, i) => {
    if (i) push(out, null, "\n");
    const kind = line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@") ? "meta" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : null;
    push(out, kind, line);
  });
  return out;
}

function highlightHtml(code: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < code.length) {
    if (code.startsWith("<!--", i)) {
      const end = code.indexOf("-->", i + 4);
      const to = end < 0 ? code.length : end + 3;
      push(out, "com", code.slice(i, to));
      i = to;
      continue;
    }
    const tag = /^<\/?[A-Za-z][\w:.-]*/.exec(code.slice(i, i + 64));
    if (tag) {
      push(out, null, tag[0].startsWith("</") ? "</" : "<");
      push(out, "tag", tag[0].replace(/^<\/?/, ""));
      i += tag[0].length;
      // атрибуты до «>»
      while (i < code.length && code[i] !== ">") {
        const ch = code[i];
        if (ch === '"' || ch === "'") {
          const end = code.indexOf(ch, i + 1);
          const to = end < 0 ? code.length : end + 1;
          push(out, "str", code.slice(i, to));
          i = to;
          continue;
        }
        const attr = /^[A-Za-z_:@][\w:.-]*/.exec(code.slice(i, i + 64));
        if (attr) {
          push(out, "attr", attr[0]);
          i += attr[0].length;
          continue;
        }
        push(out, null, ch);
        i++;
      }
      continue;
    }
    push(out, null, code[i]);
    i++;
  }
  return out;
}

/** Токены кода; язык уже разрешён через resolveLang («» — без подсветки). */
export function highlight(code: string, lang: string): Token[] {
  if (!lang) return [{ kind: null, text: code }];
  if (lang === "diff") return highlightDiff(code);
  if (lang === "html") return highlightHtml(code);
  const spec = LANGS[lang];
  if (!spec) return [{ kind: null, text: code }];
  const out: Token[] = [];
  let i = 0;
  // Чтобы не красить «#» внутри слова в sh (a#b) и т. п.
  const lineStartOrSpace = (at: number) => at === 0 || /\s/.test(code[at - 1]);

  outer: while (i < code.length) {
    const ch = code[i];

    for (const [open, close] of spec.block ?? []) {
      if (code.startsWith(open, i)) {
        const end = code.indexOf(close, i + open.length);
        const to = end < 0 ? code.length : end + close.length;
        push(out, "com", code.slice(i, to));
        i = to;
        continue outer;
      }
    }
    for (const open of spec.line ?? []) {
      if (code.startsWith(open, i) && (open !== "#" || lang !== "sh" || lineStartOrSpace(i))) {
        const end = code.indexOf("\n", i);
        const to = end < 0 ? code.length : end;
        push(out, "com", code.slice(i, to));
        i = to;
        continue outer;
      }
    }

    if (spec.quotes.includes(ch)) {
      const q = spec.triple && code.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
      let j = i + q.length;
      while (j < code.length) {
        if (code[j] === "\\") {
          j += 2;
          continue;
        }
        if (code.startsWith(q, j)) {
          j += q.length;
          break;
        }
        // Обычная строка не переходит через строку кода (кроме `…` и тройных).
        if (code[j] === "\n" && q.length === 1 && q !== "`") break;
        j++;
      }
      const text = code.slice(i, Math.min(j, code.length));
      let k = i + text.length;
      while (code[k] === " ") k++;
      push(out, spec.props && code[k] === ":" ? "prop" : "str", text);
      i += text.length;
      continue;
    }

    if (spec.vars && ch === "$" && (isIdent(code[i + 1]) || code[i + 1] === "{")) {
      const m = /^\$(\{[^}\n]*\}|\w+)/.exec(code.slice(i, i + 64));
      if (m) {
        push(out, "lit", m[0]);
        i += m[0].length;
        continue;
      }
    }

    if (spec.meta && ch === spec.meta && !isIdent(code[i - 1])) {
      const m = /^[@#]!?\[?[\w.:]+/.exec(code.slice(i, i + 64));
      if (m && m[0].length > 1) {
        push(out, "meta", m[0]);
        i += m[0].length;
        continue;
      }
    }

    if (ch >= "0" && ch <= "9" && !isIdent(code[i - 1])) {
      const m = NUM_RE.exec(code.slice(i, i + 64));
      if (m) {
        push(out, "num", m[0]);
        i += m[0].length;
        continue;
      }
    }
    if (spec.props && lang === "yaml" && lineStartOrSpace(i) && (ch === "-" || isIdentStart(ch))) {
      const m = /^[\w.-]+(?=\s*:(\s|$))/.exec(code.slice(i, i + 128));
      if (m && /^\s*(- )?$/.test(code.slice(code.lastIndexOf("\n", i - 1) + 1, i))) {
        push(out, "prop", m[0]);
        i += m[0].length;
        continue;
      }
    }

    if (isIdentStart(ch)) {
      let j = i + 1;
      while (isIdent(code[j]) || (lang === "css" && code[j] === "-")) j++;
      const word = code.slice(i, j);
      const key = spec.ignoreCase ? word.toLowerCase() : word;
      let k = j;
      while (code[k] === " ") k++;
      const kind: TokenKind | null = spec.keywords.has(key)
        ? "kw"
        : spec.literals?.has(key)
          ? "lit"
          : lang === "css" && code[k] === ":" && code[k + 1] !== ":"
            ? "prop"
            : code[k] === "(" && !isIdent(code[i - 1])
              ? "fn"
              : null;
      push(out, kind, word);
      i = j;
      continue;
    }

    push(out, null, ch);
    i++;
  }
  return out;
}
