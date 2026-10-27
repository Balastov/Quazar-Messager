import { useCallback, useEffect, useRef, useState } from "react";
import { adminApi, type AdminTicket, type AdminTicketDetail, type AdminUser, type TicketFilter } from "../../api/admin";
import { socket } from "../../ws/socket";
import { parseImage } from "../../attachments/image";
import { messagePreview } from "../../store/stickers";
import { apiError } from "../constellation/rules";
import ChatImage from "../ChatImage";
import TicketCard, { TicketStatusChip } from "../support/TicketCard";
import {
  KIND_ICON,
  KIND_LABEL,
  KINDS,
  STATUS_LABEL,
  STATUSES,
  TICKET_TEXT_MAX,
  parseTicket,
  type TicketKind,
} from "../../support/ticket";
import s from "./BlackHole.module.css";

/** Дата и время целиком: «28.10.2026, 14:05». */
const stamp = (iso: string) =>
  new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

const who = (u: AdminUser | null) =>
  u ? [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username : "удалённый аккаунт";

/** «Обращения»: предложения, вопросы и ошибки от людей; ответ уходит им в чат с Quazar_Admin_bot. */
export default function Tickets({ onChange }: { onChange: () => void }) {
  const [status, setStatus] = useState<TicketFilter>("open");
  const [kind, setKind] = useState<TicketKind | "">("");
  const [tickets, setTickets] = useState<AdminTicket[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    adminApi
      .tickets(status, kind || undefined)
      .then(setTickets)
      .catch((err) => setError(apiError(err)));
  }, [status, kind]);
  useEffect(load, [load]);

  // Новое обращение, дописка или чужой ответ — список обновляется сам.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = socket.on((event) => {
      if (event.type !== "support_ticket") return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        load();
        onChange();
      }, 300);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [load, onChange]);

  return (
    <>
      <div className={s.toolbar}>
        <select className={s.select} value={status} onChange={(e) => setStatus(e.target.value as TicketFilter)}>
          <option value="open">Не готовые</option>
          {STATUSES.map((st) => (
            <option key={st} value={st}>
              {STATUS_LABEL[st]}
            </option>
          ))}
          <option value="all">Все</option>
        </select>
        <select className={s.select} value={kind} onChange={(e) => setKind(e.target.value as TicketKind | "")}>
          <option value="">Все типы</option>
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.icon} {k.label}
            </option>
          ))}
        </select>
      </div>
      {error && <div className={s.error}>{error}</div>}
      <div className={s.list}>
        {tickets?.map((t) =>
          openId === t.id ? (
            <TicketDetail
              key={t.id}
              ticket={t}
              onClose={() => setOpenId(null)}
              onChanged={() => {
                load();
                onChange();
              }}
            />
          ) : (
            <button key={t.id} type="button" className={s.ticket} onClick={() => setOpenId(t.id)}>
              <div className={s.ticketHead}>
                <span className={s.ticketKind}>
                  {KIND_ICON[t.kind]} {KIND_LABEL[t.kind]} · №{t.number}
                </span>
                <TicketStatusChip status={t.status} />
                {t.unread > 0 && <span className={s.ticketNew}>новое · {t.unread}</span>}
              </div>
              <span className={s.meta}>
                {who(t.author)} {t.author && <span className={s.nick}>@{t.author.username}</span>} · {stamp(t.created_at)}
                {t.images.length > 0 && ` · 🖼 ${t.images.length}`}
              </span>
              <span className={s.ticketText}>{t.text || "Картинка без текста"}</span>
            </button>
          )
        )}
        {tickets && tickets.length === 0 && <p className={s.empty}>Обращений нет</p>}
      </div>
    </>
  );
}

function TicketDetail({
  ticket,
  onClose,
  onChanged,
}: {
  ticket: AdminTicket;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<AdminTicketDetail | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const hadUnread = useRef(ticket.unread > 0);

  useEffect(() => {
    adminApi
      .ticket(ticket.id)
      .then((d) => {
        setDetail(d);
        // Открыли — сообщения автора прочитаны, «новое» в списке гаснет.
        if (hadUnread.current) {
          hadUnread.current = false;
          onChangedRef.current();
        }
      })
      .catch((err) => setError(apiError(err)));
  }, [ticket.id]);

  // Человек дописал, пока обращение открыто, — подтягиваем.
  useEffect(() => {
    const off = socket.on((event) => {
      if (event.type === "support_ticket" && event.ticket_id === ticket.id) {
        void adminApi.ticket(ticket.id).then(setDetail).catch(() => {});
      }
    });
    return () => {
      off();
    };
  }, [ticket.id]);

  const run = async (fn: () => Promise<AdminTicketDetail>) => {
    setBusy(true);
    setError(null);
    try {
      setDetail(await fn());
      onChanged();
      return true;
    } catch (err) {
      setError(apiError(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const current = detail ?? ticket;
  const download = (attachmentId: string) => adminApi.ticketAttachment(ticket.id, attachmentId);

  return (
    <div className={`${s.report} ${s.ticketOpen}`}>
      <div className={s.ticketHead}>
        <span className={s.ticketKind}>
          {KIND_ICON[current.kind]} {KIND_LABEL[current.kind]} · №{current.number}
        </span>
        <TicketStatusChip status={current.status} />
        <button type="button" className={`${s.btn} ${s.ticketClose}`} onClick={onClose}>
          Свернуть
        </button>
      </div>
      <span className={s.meta}>
        {who(current.author)} {current.author && <span className={s.nick}>@{current.author.username}</span>}
        {current.author?.phone ? ` · ${current.author.phone}` : ""} · создано {stamp(current.created_at)}
      </span>

      <div className={s.thread}>
        {detail?.messages.map((m) => {
          const card = parseTicket(m.payload);
          const image = parseImage(m.payload);
          return (
            <div key={m.id} className={m.sender === "user" ? s.msgUser : s.msgBot}>
              <span className={s.msgWho}>
                {m.sender === "user" ? who(current.author) : m.admin ? `Quazar_Admin_bot · ${who(m.admin)}` : "Quazar_Admin_bot"}
                {" · "}
                {stamp(m.created_at)}
              </span>
              {card ? (
                <TicketCard chatId={current.chat_id} ticket={card} download={download} />
              ) : image ? (
                <ChatImage chatId={current.chat_id} image={image} download={() => download(image.id)} maxW={240} maxH={240} />
              ) : (
                <span className={s.msgText}>{messagePreview(m.payload)}</span>
              )}
            </div>
          );
        })}
        {!detail && !error && <p className={s.empty}>Загрузка…</p>}
      </div>

      <textarea
        className={`${s.input} ${s.replyBox}`}
        placeholder="Ответ уйдёт человеку в чат с Quazar_Admin_bot"
        maxLength={TICKET_TEXT_MAX}
        value={reply}
        onChange={(e) => setReply(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && reply.trim() && !busy) {
            void run(() => adminApi.replyTicket(ticket.id, reply.trim())).then((ok) => ok && setReply(""));
          }
        }}
      />
      {error && <div className={s.error}>{error}</div>}
      <div className={s.actions}>
        <button
          type="button"
          className={`${s.btn} ${s.btnPrimary}`}
          disabled={busy || !reply.trim()}
          onClick={() => void run(() => adminApi.replyTicket(ticket.id, reply.trim())).then((ok) => ok && setReply(""))}
        >
          Ответить
        </button>
        <span className={s.statusSwitch} role="radiogroup" aria-label="Статус">
          {STATUSES.map((st) => (
            <button
              key={st}
              type="button"
              role="radio"
              aria-checked={current.status === st}
              className={current.status === st ? `${s.btn} ${s.btnOn}` : s.btn}
              disabled={busy || current.status === st}
              onClick={() => void run(() => adminApi.setTicketStatus(ticket.id, st))}
            >
              {STATUS_LABEL[st]}
            </button>
          ))}
        </span>
      </div>
    </div>
  );
}
