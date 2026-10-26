import { useMemo } from "react";
import { splitLinks } from "../utils/linkify";
import { splitMentions } from "../chat/mentions";

/** Чьё это @имя: меня («me»), другого участника («other») или ничьё (null — простой текст). */
export type MentionKind = (name: string) => "me" | "other" | null;

interface Props {
  text: string;
  linkClassName?: string;
  /** Подсветка @упоминаний; без неё «@имя» — обычный текст. */
  mention?: MentionKind;
  mentionClassName?: string;
  mentionMeClassName?: string;
}

/** Текст сообщения, где ссылки кликабельны и открываются в новой вкладке, а @имена подсвечены. */
export default function LinkifiedText({ text, linkClassName, mention, mentionClassName, mentionMeClassName }: Props) {
  const parts = useMemo(() => splitLinks(text), [text]);
  return (
    <>
      {parts.map((part, i) =>
        part.type === "link" ? (
          <a
            key={i}
            href={part.href}
            className={linkClassName}
            target="_blank"
            // Открытая страница не получит доступа к вкладке мессенджера и адреса, откуда пришли.
            rel="noopener noreferrer nofollow"
          >
            {part.text}
          </a>
        ) : mention && part.text.includes("@") ? (
          splitMentions(part.text).map((p, j) => {
            const kind = p.type === "mention" ? mention(p.name) : null;
            return kind ? (
              <span key={`${i}-${j}`} className={kind === "me" ? `${mentionClassName} ${mentionMeClassName}` : mentionClassName}>
                {p.text}
              </span>
            ) : (
              p.text
            );
          })
        ) : (
          part.text
        )
      )}
    </>
  );
}
