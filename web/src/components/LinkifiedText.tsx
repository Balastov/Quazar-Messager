import { useMemo } from "react";
import { splitLinks } from "../utils/linkify";

interface Props {
  text: string;
  linkClassName?: string;
}

/** Текст сообщения, где ссылки кликабельны и открываются в новой вкладке. */
export default function LinkifiedText({ text, linkClassName }: Props) {
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
        ) : (
          part.text
        )
      )}
    </>
  );
}
