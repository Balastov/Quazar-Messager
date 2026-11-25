import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { adminApi, type AdminUser, type AuthCount, type AuthEvent, type AuthEventKind, type AuthSummary } from "../../api/admin";
import Dialog from "../constellation/Dialog";
import { apiError } from "../constellation/rules";
import { stamp } from "./stamp";
import s from "./BlackHole.module.css";

const KIND: Record<AuthEventKind, string> = {
  login: "Вход",
  login_failed: "Неудачный вход",
  rejected: "Сервер отказал",
  logout: "Выход",
  revoked: "Вход завершён",
};

/** Какие группы показывать в сводке и в каком порядке: сначала то, что объясняет «выкинуло». */
const GROUPS: [AuthEventKind, string][] = [
  ["rejected", "Сервер отказал в сессии"],
  ["revoked", "Входы завершили"],
  ["logout", "Вышли сами (по данным приложения)"],
  ["login", "Входы"],
  ["login_failed", "Неудачные входы"],
];

const DAYS = [7, 30, 90];

const client = (e: AuthEvent) => e.client ?? (e.user_agent?.includes("Electron") ? "десктоп до журнала" : "—");

/** Сводка: почему выходят из аккаунта за последние дни. */
export function AuthSummaryView() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<AuthSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setError(null);
    adminApi.authSummary(days).then((value) => alive && setData(value)).catch((err) => alive && setError(apiError(err)));
    return () => { alive = false; };
  }, [days]);
  const group = (kind: AuthEventKind): AuthCount[] => data?.counts.filter((c) => c.event === kind) ?? [];
  return (
    <>
      <div className={s.toolbar}>
        <select className={s.select} value={days} aria-label="Период" onChange={(e) => setDays(Number(e.target.value))}>
          {DAYS.map((d) => <option key={d} value={d}>За {d} дней</option>)}
        </select>
      </div>
      {error && <div className={s.error}>{error}</div>}
      {data && (
        <>
          <p className={s.hint}>
            Журнал хранится {data.keep_days} дней. Подробности по человеку — «Журнал входов» во вкладке «Пользователи».
          </p>
          <div className={s.stats}>
            <div className={data.lost_on_device ? `${s.stat} ${s.statWarn}` : s.stat}>
              <span className={s.statValue}>{data.lost_on_device.toLocaleString("ru-RU")}</span>
              <span className={s.statLabel}>
                Входов, когда прежний вход ещё действовал ({data.lost_on_device_users} чел.): устройство потеряло вход само, сервер его не завершал
              </span>
            </div>
          </div>
          {GROUPS.map(([kind, title]) => {
            const rows = group(kind);
            if (!rows.length) return null;
            return (
              <section key={kind}>
                <h3 className={s.sectionTitle}>{title}</h3>
                <div className={s.list}>
                  {rows.map((c) => (
                    <div key={`${c.event}:${c.reason}`} className={s.row}>
                      <div className={s.main}>
                        <span className={s.name}>{c.label || c.reason || "—"}</span>
                        <span className={s.meta}>{c.events.toLocaleString("ru-RU")} раз · {c.users.toLocaleString("ru-RU")} чел.</span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
          {!data.counts.length && <p className={s.empty}>За эти дни записей нет</p>}
        </>
      )}
    </>
  );
}

/** Журнал входов одного человека, новые сверху. */
export function AuthLogDialog({ user, onClose }: { user: AdminUser; onClose(): void }) {
  const [events, setEvents] = useState<AuthEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    adminApi.authEvents(user.id).then((list) => alive && setEvents(list)).catch((err) => alive && setError(apiError(err)));
    return () => { alive = false; };
  }, [user.id]);
  return createPortal(
    <Dialog title={`Журнал входов · @${user.username}`} onClose={onClose}>
      {error && <div className={s.error}>{error}</div>}
      {!events && !error && <p className={s.hint}>Загружаем…</p>}
      {events && events.length === 0 && <p className={s.empty}>Записей нет</p>}
      <div className={s.list}>
        {events?.map((e) => (
          <div key={e.id} className={s.row}>
            <div className={s.main}>
              <span className={s.name}>
                <span className={e.event === "rejected" || e.event === "revoked" ? `${s.badge} ${s.badgeDanger}` : s.badge}>{KIND[e.event]}</span>{" "}
                {e.label || e.reason || ""}
              </span>
              {e.detail && <span className={s.meta}>{e.detail}</span>}
              <span className={s.meta}>
                {stamp(e.at)} · {client(e)}
                {e.ip ? ` · ${e.ip}` : ""}
                {e.path ? ` · ${e.path}` : ""}
                {e.session_id ? ` · вход ${e.session_id.slice(0, 8)}` : ""}
              </span>
              {e.user_agent && <span className={s.meta} title={e.user_agent}>{e.user_agent}</span>}
            </div>
          </div>
        ))}
      </div>
    </Dialog>,
    document.body,
  );
}
