import { Fragment, useMemo, useState, type ReactNode } from "react";
import { hasMarkup, parseBlocks, type Block, type Inline, type ListItem } from "../../chat/markdown";
import { highlight, resolveLang } from "../../chat/highlight";
import f from "./Formatted.module.css";

/** Обычный текст внутри разметки: ссылки, @имена, эмодзи Звезды. Код сюда не попадает. */
export type RenderLeaf = (text: string, key: string) => ReactNode;

const plainLeaf: RenderLeaf = (text) => text;

function InlineParts({ parts, leaf, k }: { parts: Inline[]; leaf: RenderLeaf; k: string }) {
  return (
    <>
      {parts.map((p, i) => {
        const key = `${k}.${i}`;
        if (p.t === "text") return <Fragment key={key}>{leaf(p.text, key)}</Fragment>;
        if (p.t === "code") return <code key={key} className={f.code}>{p.text}</code>;
        const inner = <InlineParts parts={p.children} leaf={leaf} k={key} />;
        if (p.t === "bold") return <strong key={key}>{inner}</strong>;
        if (p.t === "italic") return <em key={key}>{inner}</em>;
        return <s key={key}>{inner}</s>;
      })}
    </>
  );
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const resolved = useMemo(() => resolveLang(lang, text), [lang, text]);
  const tokens = useMemo(() => highlight(text, resolved), [text, resolved]);
  const copy = () => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };
  return (
    <div className={f.pre}>
      {/* Без подписи языка — только кнопка поверх кода, без лишней строки. */}
      <div className={lang ? f.preBar : `${f.preBar} ${f.preBarFloat}`}>
        {lang && <span className={f.lang}>{lang}</span>}
        <button
          type="button"
          className={f.copy}
          onClick={copy}
          // Клик по кнопке не открывает меню сообщения.
          onContextMenu={(e) => e.stopPropagation()}
          aria-label="Копировать код"
        >
          {copied ? "Скопировано" : "Копировать"}
        </button>
      </div>
      <pre>
        <code>
          {tokens.map((t, i) => (t.kind ? <span key={i} className={f[t.kind]}>{t.text}</span> : t.text))}
        </code>
      </pre>
    </div>
  );
}

function List({ ordered, items, leaf, k }: { ordered: boolean; items: ListItem[]; leaf: RenderLeaf; k: string }) {
  const Tag = ordered ? "ol" : "ul";
  return (
    <Tag className={f.list}>
      {items.map((item, i) => (
        <li
          key={i}
          value={ordered ? item.n : undefined}
          style={item.depth ? { marginLeft: `${item.depth * 1.2}em` } : undefined}
          className={item.depth % 2 ? f.nested : undefined}
        >
          <InlineParts parts={item.children} leaf={leaf} k={`${k}.${i}`} />
        </li>
      ))}
    </Tag>
  );
}

function Blocks({ blocks, leaf, k }: { blocks: Block[]; leaf: RenderLeaf; k: string }) {
  return (
    <>
      {blocks.map((b, i) => {
        const key = `${k}.${i}`;
        if (b.t === "para")
          return (
            <div key={key} className={f.p}>
              <InlineParts parts={b.children} leaf={leaf} k={key} />
            </div>
          );
        if (b.t === "code") return <CodeBlock key={key} lang={b.lang} text={b.text} />;
        if (b.t === "quote")
          return (
            <blockquote key={key} className={f.quote}>
              <Blocks blocks={b.children} leaf={leaf} k={key} />
            </blockquote>
          );
        if (b.t === "heading") {
          const Tag = (["h3", "h4", "h5"] as const)[b.level - 1];
          return (
            <Tag key={key} className={f[`h${b.level}`]}>
              <InlineParts parts={b.children} leaf={leaf} k={key} />
            </Tag>
          );
        }
        if (b.t === "rule") return <hr key={key} className={f.rule} />;
        return <List key={key} ordered={b.ordered} items={b.items} leaf={leaf} k={key} />;
      })}
    </>
  );
}

/**
 * Текст сообщения с разметкой: **жирный**, _курсив_, ~~зачёркнутый~~, `код`, блоки кода с
 * подсветкой, цитаты и списки. Без разметки — просто leaf(text), как раньше.
 */
export default function FormattedText({
  text,
  leaf = plainLeaf,
  headings = false,
}: {
  text: string;
  leaf?: RenderLeaf;
  /** Заголовки «#» и черта «---» — для заметок Спутника. */
  headings?: boolean;
}) {
  const blocks = useMemo(
    () => (headings || hasMarkup(text) ? parseBlocks(text, { headings }) : null),
    [text, headings]
  );
  if (!blocks) return <div className={f.p}>{leaf(text, "t")}</div>;
  return (
    <div className={f.root}>
      <Blocks blocks={blocks} leaf={leaf} k="b" />
    </div>
  );
}
