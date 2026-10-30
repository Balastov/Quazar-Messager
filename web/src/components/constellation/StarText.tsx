import { Fragment } from "react";
import LinkifiedText, { type MentionKind } from "../LinkifiedText";
import FormattedText from "../messages/FormattedText";
import g from "./Gaming.module.css";
import w from "./Work.module.css";

const EMOJI_RE = /:([a-z0-9_]{2,32}):/g;

/** Текст сообщения Спутника: разметка, ссылки кликабельны, :name: — эмодзи Звезды картинкой. */
export default function StarText({
  text,
  emoji,
  linkClassName,
  mention,
  headings,
}: {
  text: string;
  /** имя → адрес картинки */
  emoji: Record<string, string>;
  linkClassName?: string;
  /** Подсветка @имён участников. */
  mention?: MentionKind;
  /** Заголовки и черта — в заметках Спутника. */
  headings?: boolean;
}) {
  return (
    <FormattedText
      text={text}
      headings={headings}
      leaf={(chunk, key) => <StarLeaf key={key} text={chunk} emoji={emoji} linkClassName={linkClassName} mention={mention} />}
    />
  );
}

/** Кусок обычного текста (не код): ссылки, @имена и эмодзи Звезды. */
function StarLeaf({
  text,
  emoji,
  linkClassName,
  mention,
}: {
  text: string;
  emoji: Record<string, string>;
  linkClassName?: string;
  mention?: MentionKind;
}) {
  const linked = (chunk: string, key?: string) => (
    <LinkifiedText
      key={key}
      text={chunk}
      linkClassName={linkClassName}
      mention={mention}
      mentionClassName={w.mention}
      mentionMeClassName={w.mentionMe}
    />
  );
  if (!text.includes(":")) return linked(text);
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(EMOJI_RE)) {
    const url = emoji[m[1]];
    if (!url) continue;
    const at = m.index ?? 0;
    if (at > last) parts.push(linked(text.slice(last, at), `t${at}`));
    parts.push(<img key={`e${at}`} className={g.inlineEmoji} src={url} alt={`:${m[1]}:`} title={`:${m[1]}:`} />);
    last = at + m[0].length;
  }
  if (!parts.length) return linked(text);
  if (last < text.length) parts.push(linked(text.slice(last), "tail"));
  return <Fragment>{parts}</Fragment>;
}

/** Сообщение — только эмодзи Звезды (1–3 штуки): показываем крупно. */
export function onlyEmoji(text: string, emoji: Record<string, string>): boolean {
  const rest = text.replace(EMOJI_RE, (all, name: string) => (emoji[name] ? "" : all)).trim();
  const count = (text.match(EMOJI_RE) ?? []).length;
  return rest === "" && count > 0 && count <= 3;
}
