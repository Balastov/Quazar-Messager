import { useCallback, useEffect, useState } from "react";
import { adminApi, type AdminReport, type AdminStar, type AdminStats, type AdminUser } from "../../api/admin";
import { useStarsStore } from "../../store/stars";
import { useUiStore } from "../../store/ui";
import { useAuthStore } from "../../store/auth";
import { formatWhen } from "../../chat/when";
import { apiError } from "../constellation/rules";
import Tickets from "./Tickets";
import { compareUsers } from "../../utils/profile";
import s from "./BlackHole.module.css";

type Section = "users" | "stars" | "reports" | "tickets";

const REASON: Record<string, string> = { spam: "Спам", abuse: "Оскорбления", fraud: "Мошенничество", other: "Другое" };

const fullName = (u: AdminUser) => [u.first_name, u.last_name].filter(Boolean).join(" ");

/** «Чёрная дыра»: администрирование всего ресурса. Видна только его владельцам. */
export default function BlackHoleView() {
  const [section, setSection] = useState<Section>("users");
  const [stats, setStats] = useState<AdminStats | null>(null);

  const reloadStats = useCallback(() => {
    void adminApi.me().then(setStats).catch(() => {});
  }, []);
  useEffect(reloadStats, [reloadStats]);

  return (
    <div className={s.root}>
      <header className={s.header}>
        <div>
          <h2 className={s.title}>Чёрная дыра</h2>
          <p className={s.sub}>Администрирование всего ресурса. Этот раздел видят только владельцы ресурса.</p>
        </div>
      </header>
      {stats && (
        <div className={s.stats}>
          <Stat label="Пользователей" value={stats.users} />
          <Stat label="Сейчас в сети" value={stats.online} />
          <Stat label="Заблокировано" value={stats.blocked} />
          <Stat label="Звёзд" value={stats.stars} />
          <Stat label="Чатов" value={stats.chats} />
          <Stat label="Сообщений сегодня" value={stats.messages_today} />
          <Stat label="Жалоб ждёт" value={stats.open_reports} warn={stats.open_reports > 0} />
          <Stat label="Обращений в очереди" value={stats.queued_tickets} warn={stats.queued_tickets > 0} />
        </div>
      )}
      <nav className={s.tabs}>
        {(
          [
            ["users", "Пользователи"],
            ["stars", "Звёзды"],
            ["reports", `Жалобы${stats?.open_reports ? ` · ${stats.open_reports}` : ""}`],
            ["tickets", `Обращения${stats?.queued_tickets ? ` · ${stats.queued_tickets}` : ""}`],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" className={section === id ? `${s.tab} ${s.tabOn}` : s.tab} onClick={() => setSection(id)}>
            {label}
          </button>
        ))}
      </nav>
      <div className={s.body}>
        {section === "users" && <Users onChange={reloadStats} />}
        {section === "stars" && <Stars />}
        {section === "reports" && <Reports onChange={reloadStats} />}
        {section === "tickets" && <Tickets onChange={reloadStats} />}
      </div>
    </div>
  );
}

function Stat({ label, value, warn = false }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className={warn ? `${s.stat} ${s.statWarn}` : s.stat}>
      <span className={s.statValue}>{value.toLocaleString("ru-RU")}</span>
      <span className={s.statLabel}>{label}</span>
    </div>
  );
}

function Users({ onChange }: { onChange: () => void }) {
  const myId = useAuthStore((st) => st.user?.id);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "blocked" | "superusers">("all");
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      adminApi
        .users({ q: q.trim() || undefined, filter })
        .then((list) => alive && setUsers(list))
        .catch((err) => alive && setError(apiError(err)));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q, filter]);

  const act = async (fn: () => Promise<AdminUser>) => {
    setError(null);
    try {
      const updated = await fn();
      setUsers((list) => (list ?? []).map((u) => (u.id === updated.id ? updated : u)));
      onChange();
    } catch (err) {
      setError(apiError(err));
    }
  };

  return (
    <>
      <div className={s.toolbar}>
        <input className={s.input} type="search" value={q} placeholder="Ник, имя или телефон" onChange={(e) => setQ(e.target.value)} />
        <select className={s.select} value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="all">Все</option>
          <option value="blocked">Заблокированные</option>
          <option value="superusers">Владельцы ресурса</option>
        </select>
      </div>
      {error && <div className={s.error}>{error}</div>}
      <div className={s.list}>
        {users?.slice().sort((a, b) => compareUsers(
          { username: a.username, display_name: fullName(a) },
          { username: b.username, display_name: fullName(b) },
        )).map((u) => (
          <div key={u.id} className={u.blocked_at ? `${s.row} ${s.rowBlocked}` : s.row}>
            <span className={u.online ? `${s.dot} ${s.dotOn}` : s.dot} title={u.online ? "в сети" : "не в сети"} />
            <div className={s.main}>
              <span className={s.name}>
                {fullName(u) || u.username} <span className={s.nick}>@{u.username}</span>
                {u.is_superuser && <span className={s.badge}>владелец ресурса</span>}
                {u.blocked_at && <span className={`${s.badge} ${s.badgeDanger}`}>заблокирован</span>}
              </span>
              <span className={s.meta}>
                {u.phone} · с {u.created_at ? formatWhen(u.created_at) : "—"}
                {u.blocked_at ? ` · заблокирован ${formatWhen(u.blocked_at)}${u.blocked_reason ? `: ${u.blocked_reason}` : ""}` : ""}
              </span>
            </div>
            <div className={s.actions}>
              {u.id !== myId &&
                (u.blocked_at ? (
                  <button type="button" className={s.btn} onClick={() => void act(() => adminApi.unblock(u.id))}>
                    Разблокировать
                  </button>
                ) : (
                  !u.is_superuser && (
                    <button
                      type="button"
                      className={`${s.btn} ${s.btnDanger}`}
                      onClick={() => {
                        const reason = window.prompt(`Заблокировать @${u.username} на всём ресурсе? Причина (видна только владельцам ресурса):`, "");
                        if (reason !== null) void act(() => adminApi.block(u.id, reason));
                      }}
                    >
                      Заблокировать
                    </button>
                  )
                ))}
              {!u.blocked_at &&
                (u.is_superuser ? (
                  <button
                    type="button"
                    className={s.btn}
                    onClick={() => {
                      if (window.confirm(`Снять с @${u.username} роль владельца ресурса?`)) void act(() => adminApi.revoke(u.id));
                    }}
                  >
                    Снять роль
                  </button>
                ) : (
                  <button
                    type="button"
                    className={s.btn}
                    onClick={() => {
                      if (window.confirm(`Сделать @${u.username} владельцем ресурса? Появится доступ к «Чёрной дыре» и власть в любой Звезде.`)) {
                        void act(() => adminApi.grant(u.id));
                      }
                    }}
                  >
                    Сделать владельцем
                  </button>
                ))}
            </div>
          </div>
        ))}
        {users && users.length === 0 && <p className={s.empty}>Никого не нашлось</p>}
      </div>
    </>
  );
}

function Stars() {
  const [q, setQ] = useState("");
  const [stars, setStars] = useState<AdminStar[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      adminApi
        .stars(q.trim())
        .then((list) => alive && setStars(list))
        .catch((err) => alive && setError(apiError(err)));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q]);

  const open = (star: AdminStar) => {
    useUiStore.getState().setTab("stars");
    void useStarsStore.getState().selectStar(star.id);
  };

  return (
    <>
      <div className={s.toolbar}>
        <input className={s.input} type="search" value={q} placeholder="Название Звезды" onChange={(e) => setQ(e.target.value)} />
      </div>
      <p className={s.hint}>
        В любой Звезде вы действуете как её владелец. Если вы не участник, вас нет в списке участников, а
        изменения в ней видны после обновления.
      </p>
      {error && <div className={s.error}>{error}</div>}
      <div className={s.list}>
        {stars?.map((st) => (
          <div key={st.id} className={s.row}>
            <div className={s.main}>
              <span className={s.name}>
                {st.name} <span className={s.nick}>{st.kind === "work" ? "работа" : "игры"}</span>
                {st.i_am_member && <span className={s.badge}>вы участник</span>}
              </span>
              <span className={s.meta}>
                владелец {st.owner_name ? `@${st.owner_name}` : "—"} · участников {st.member_count} · с {formatWhen(st.created_at)}
              </span>
            </div>
            <div className={s.actions}>
              <button type="button" className={s.btn} onClick={() => open(st)}>
                Открыть
              </button>
            </div>
          </div>
        ))}
        {stars && stars.length === 0 && <p className={s.empty}>Звёзд не нашлось</p>}
      </div>
    </>
  );
}

function Reports({ onChange }: { onChange: () => void }) {
  const [status, setStatus] = useState<"open" | "all">("open");
  const [reports, setReports] = useState<AdminReport[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    adminApi
      .reports(status)
      .then(setReports)
      .catch((err) => setError(apiError(err)));
  }, [status]);
  useEffect(load, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      load();
      onChange();
    } catch (err) {
      setError(apiError(err));
    }
  };

  return (
    <>
      <div className={s.toolbar}>
        <select className={s.select} value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="open">Ждут разбора</option>
          <option value="all">Все</option>
        </select>
      </div>
      {error && <div className={s.error}>{error}</div>}
      <div className={s.list}>
        {reports?.map((r) => (
          <div key={r.id} className={s.report}>
            <div className={s.name}>
              {REASON[r.reason] ?? r.reason}: {r.reporter ? `@${r.reporter.username}` : "—"} → {r.target ? `@${r.target.username}` : "удалённый аккаунт"}
              {r.resolved_at && <span className={s.badge}>разобрана</span>}
              {r.target?.blocked_at && <span className={`${s.badge} ${s.badgeDanger}`}>заблокирован</span>}
            </div>
            <div className={s.meta}>{formatWhen(r.created_at)}</div>
            {r.comment && <p className={s.comment}>{r.comment}</p>}
            {r.evidence.length > 0 && (
              <div className={s.evidence}>
                {r.evidence.map((e, i) => (
                  <div key={i} className={e.sender === "them" ? s.evThem : s.evMe}>
                    <b>{e.sender === "them" ? r.target?.username ?? "нарушитель" : r.reporter?.username ?? "автор жалобы"}:</b> {e.text}
                  </div>
                ))}
              </div>
            )}
            <div className={s.actions}>
              {r.target && !r.target.blocked_at && !r.target.is_superuser && (
                <button
                  type="button"
                  className={`${s.btn} ${s.btnDanger}`}
                  onClick={() => {
                    if (window.confirm(`Заблокировать @${r.target!.username} на всём ресурсе?`)) {
                      void run(() => adminApi.block(r.target!.id, `Жалоба: ${REASON[r.reason] ?? r.reason}`));
                    }
                  }}
                >
                  Заблокировать нарушителя
                </button>
              )}
              {!r.resolved_at && (
                <button type="button" className={s.btn} onClick={() => void run(() => adminApi.resolve(r.id))}>
                  Закрыть жалобу
                </button>
              )}
            </div>
          </div>
        ))}
        {reports && reports.length === 0 && <p className={s.empty}>{status === "open" ? "Новых жалоб нет" : "Жалоб нет"}</p>}
      </div>
    </>
  );
}
