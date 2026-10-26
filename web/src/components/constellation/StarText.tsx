import { Fragment } from "react";
import LinkifiedText from "../LinkifiedText";
import g from "./Gaming.module.css";

const EMOJI_RE = /:([a-z0-9_]{2,32}):/g;

/** Текст сообщения Спутника: ссылки кликабельны, :name: — эмодзи Звезды картинкой. */
export default function StarText({
  text,
  emoji,
  linkClassName,
}: {
  text: string;
  /** имя → адрес картинки */
  emoji: Record<string, string>;
  linkClassName?: string;
}) {
  if (!text.includes(":")) return <LinkifiedText text={text} linkClassName={linkClassName} />;
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(EMOJI_RE)) {
    const url = emoji[m[1]];
    if (!url) continue;
    const at = m.index ?? 0;
    if (at > last) parts.push(<LinkifiedText key={`t${at}`} text={text.slice(last, at)} linkClassName={linkClassName} />);
    parts.push(<img key={`e${at}`} className={g.inlineEmoji} src={url} alt={`:${m[1]}:`} title={`:${m[1]}:`} />);
    last = at + m[0].length;
  }
  if (!parts.length) return <LinkifiedText text={text} linkClassName={linkClassName} />;
  if (last < text.length) parts.push(<LinkifiedText key="tail" text={text.slice(last)} linkClassName={linkClassName} />);
  return <Fragment>{parts}</Fragment>;
}

/** Сообщение — только эмодзи Звезды (1–3 штуки): показываем крупно. */
export function onlyEmoji(text: string, emoji: Record<string, string>): boolean {
  const rest = text.replace(EMOJI_RE, (all, name: string) => (emoji[name] ? "" : all)).trim();
  const count = (text.match(EMOJI_RE) ?? []).length;
  return rest === "" && count > 0 && count <= 3;
}
