import { useEffect, useState } from "react";
import type { StarChannel, StarDetail } from "../../api/stars";
import { useAuthStore } from "../../store/auth";
import { useRoomActivities, type RoomCache } from "../../store/roomActivities";
import type { FocusAction } from "../../api/roomActivities";
import { displayName } from "../../utils/profile";
import { apiError } from "./rules";
import { clock, focusAt, remaining } from "./roomActivityMath";
import s from "./RoomActivities.module.css";

export default function FocusOrbit({ detail, channel, room, readOnly, compact = false }: {
  detail: StarDetail; channel: StarChannel; room: RoomCache; readOnly: boolean; compact?: boolean;
}) {
  const myId = useAuthStore((st) => st.user?.id);
  const action = useRoomActivities((st) => st.focus);
  const [now, setNow] = useState(Date.now);
  const [open, setOpen] = useState(false);
  const [work, setWork] = useState(25);
  const [rest, setRest] = useState(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  const serverNow = now + room.clockOffset;
  const focus = focusAt(room.focus, serverNow);
  const active = !!focus && focus.phase !== "done";
  const present = detail.voice?.[channel.id] ?? [];
  const canControl = !readOnly && (!focus || myId === focus.owner_id ||
    ["owner", "admin", "moderator"].includes(detail.my_role) ||
    present.some((p) => p.user_id === myId && p.is_host) || !present.some((p) => p.user_id === focus.owner_id));
  const owner = displayName(detail.members.find((m) => m.user.id === focus?.owner_id)?.user) ?? "Ведущий";
  const run = async (kind: FocusAction) => {
    setBusy(true); setError(null);
    try { await action(detail.id, channel.id, kind, work, rest); }
    catch (err) { setError(apiError(err, "Не удалось изменить таймер")); }
    finally { setBusy(false); }
  };
  const seconds = focus ? remaining(focus, serverNow) : 0;
  const duration = focus?.phase === "work" ? focus.work_seconds : focus?.break_seconds ?? 1;
  const progress = active ? Math.min(1, seconds / duration) : 0;
  if (compact) return active ? <div className={s.focusCompact} role="timer">
    <strong>{focus.phase === "work" ? "Фокус" : "Общий перерыв"} · {clock(seconds)}</strong>
    {!focus.running && <span>На паузе</span>}
    {canControl && <button type="button" className={s.button} disabled={busy}
      onClick={() => void run(focus.running ? "pause" : "resume")}>{focus.running ? "Пауза" : "Продолжить"}</button>}
    {error && <span role="alert" className={s.error}>{error}</span>}
  </div> : null;
  return (
    <section className={s.focus} aria-label="Орбита фокуса">
      <div className={s.focusHead}>
        <svg width="42" height="42" viewBox="0 0 44 44" aria-hidden>
          <circle cx="22" cy="22" r="18" fill="none" stroke="currentColor" strokeOpacity="0.16" strokeWidth="3" />
          <circle cx="22" cy="22" r="18" fill="none" stroke="currentColor" strokeWidth="3"
            strokeDasharray={`${progress * 113.1} 113.1`} transform="rotate(-90 22 22)" />
        </svg>
        <div className={s.focusTitle}>
          <strong>{active ? focus.phase === "work" ? "Фокус" : "Общий перерыв" : "Орбита фокуса"}</strong>
          <span className={s.hint}>{active ? `${owner} · ${focus.running ? "общий таймер комнаты" : "на паузе"}`
            : focus ? "Сеанс завершён. Можно начать новый." : "Работаем вместе, затем отдыхаем"}</span>
        </div>
        {active && <span className={s.countdown} role="timer" aria-label={`Осталось ${clock(seconds)}`}>{clock(seconds)}</span>}
        <button type="button" className={s.button} onClick={() => setOpen(!open)} aria-expanded={open}>
          {active ? "Управление" : "Начать"}
        </button>
      </div>
      {open && <div className={s.focusActions}>
        {!active ? <>
          <button type="button" className={s.button} onClick={() => { setWork(25); setRest(5); }}>25 / 5</button>
          <button type="button" className={s.button} onClick={() => { setWork(50); setRest(10); }}>50 / 10</button>
          <label className={s.smallLabel}>Фокус, мин <input type="number" min={1} max={180} value={work}
            onChange={(e) => setWork(Number(e.target.value))} /></label>
          <label className={s.smallLabel}>Перерыв, мин <input type="number" min={1} max={60} value={rest}
            onChange={(e) => setRest(Number(e.target.value))} /></label>
          <button type="button" className={s.primary} disabled={busy || readOnly || !Number.isInteger(work) || !Number.isInteger(rest) || work < 1 || work > 180 || rest < 1 || rest > 60}
            onClick={() => void run("start")}>Запустить для комнаты</button>
        </> : <>
          <button type="button" className={s.button} disabled={busy || !canControl}
            onClick={() => void run(focus.running ? "pause" : "resume")}>{focus.running ? "Пауза" : "Продолжить"}</button>
          {focus.phase === "work" && <button type="button" className={s.button} disabled={busy || !canControl}
            onClick={() => void run("break")}>К перерыву</button>}
          <button type="button" className={s.danger} disabled={busy || !canControl} onClick={() => void run("stop")}>Завершить</button>
          {!canControl && <span className={s.hint}>Таймером управляет {owner}</span>}
        </>}
      </div>}
      {error && <p role="alert" className={s.error}>{error}</p>}
    </section>
  );
}
