import ChatImage from "../ChatImage";
import LinkifiedText from "../LinkifiedText";
import { KIND_ICON, KIND_LABEL, STATUS_LABEL, type TicketCard as Ticket } from "../../support/ticket";
import s from "./Support.module.css";

export function TicketStatusChip({ status }: { status: Ticket["status"] }) {
  const cls = status === "done" ? s.statusDone : status === "in_progress" ? s.statusWork : s.statusQueued;
  return <span className={`${s.status} ${cls}`}>{STATUS_LABEL[status]}</span>;
}

/** Карточка обращения в чате с Quazar_Admin_bot: тип, номер, статус, текст и картинки. */
export default function TicketCard({
  chatId,
  ticket,
  download,
}: {
  chatId: string;
  ticket: Ticket;
  /** В «Чёрной дыре» картинки качаются через её адрес. */
  download?: (attachmentId: string) => Promise<Uint8Array>;
}) {
  return (
    <div className={s.card}>
      <div className={s.cardHead}>
        <span className={s.cardKind}>
          {KIND_ICON[ticket.kind]} {KIND_LABEL[ticket.kind]} · №{ticket.number}
        </span>
        <TicketStatusChip status={ticket.status} />
      </div>
      {ticket.text && (
        <span className={s.cardText}>
          <LinkifiedText text={ticket.text} linkClassName={s.link} />
        </span>
      )}
      {ticket.images.length > 0 && (
        <div className={s.cardImages}>
          {ticket.images.map((img) => (
            <ChatImage
              key={img.id}
              chatId={chatId}
              image={img}
              maxW={ticket.images.length > 1 ? 140 : 280}
              maxH={ticket.images.length > 1 ? 140 : 280}
              download={download ? () => download(img.id) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}
