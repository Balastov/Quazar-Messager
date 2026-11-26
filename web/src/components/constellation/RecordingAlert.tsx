// «Идёт запись»: сколько она длится и окно «Ведётся запись разговора» для всех в комнате.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useAuthStore } from "../../store/auth";
import { useStarsStore } from "../../store/stars";
import { useVoiceStore } from "../../store/voice";
import Dialog from "./Dialog";
import { presenceName } from "./rules";
import s from "./Constellation.module.css";

/** Сколько идёт запись: «0:07», «12:34», «1:02:03». */
export function recordingElapsed(since: string | number, now = Date.now()): string {
  const start = typeof since === "number" ? since : Date.parse(since);
  const total = Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / 1000)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** Время записи, обновляется раз в секунду (перерисовывается только оно). */
export function RecordingClock({ since }: { since: string | number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className={s.recordingClock}>{recordingElapsed(since, now)}</span>;
}

// «Больше не показывать» — по комнатам: в этой комнате окно больше не появится, в других — да.
const OFF_KEY = "quazar-recording-alert-off";

function readOff(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(OFF_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** room — «channelId» у участников, «guest:код» у гостей по ссылке; owner — чей выбор (id аккаунта). */
export function recordingAlertOff(room: string, owner = ""): boolean {
  return readOff().includes(`${owner}:${room}`);
}

export function turnRecordingAlertOff(room: string, owner = ""): void {
  const list = readOff();
  const key = `${owner}:${room}`;
  if (list.includes(key)) return;
  try {
    // Список не растёт бесконечно: самые старые комнаты забываются.
    localStorage.setItem(OFF_KEY, JSON.stringify([...list, key].slice(-500)));
  } catch {
    // Хранилище недоступно (приватное окно) — окно просто покажется снова.
  }
}

/** Окно «Ведётся запись разговора». Закрыли крестиком — как «Понятно» без галочки. */
export function RecordingAlert({ who, where, onClose }: { who: string; where: string; onClose(dontShow: boolean): void }) {
  const [dontShow, setDontShow] = useState(false);
  // В портале: панели со стеклом создают свой слой, и окно внутри них оказалось бы под ними.
  return createPortal(
    <Dialog title="Ведётся запись разговора" onClose={() => onClose(false)}>
      <div className={s.recordingAlert}>
        <p className={s.recordingAlertText}>
          <span className={s.recordingDot} aria-hidden /> {who} записывает разговор: звук всех участников и показ
          экрана. {where}
        </p>
        <label className={s.recordingAlertCheck}>
          <input type="checkbox" checked={dontShow} onChange={(e) => setDontShow(e.target.checked)} />
          Больше не показывать
        </label>
        <button type="button" className={s.okGreen} autoFocus onClick={() => onClose(dontShow)}>
          Понятно
        </button>
      </div>
    </Dialog>,
    document.body
  );
}

// Какие записи уже показали: «комната:кто:с какого времени». Новая запись — снова окно.
// Переживает перезагрузку страницы (sessionStorage), чтобы та же запись не всплывала заново.
const SEEN_KEY = "quazar-recording-alert-seen";
const acknowledged = {
  read(): string[] {
    try {
      const value = JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? "[]");
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  },
  has(key: string): boolean {
    return this.read().includes(key);
  },
  add(key: string): void {
    try {
      sessionStorage.setItem(SEEN_KEY, JSON.stringify([...this.read(), key].slice(-50)));
    } catch {
      // Хранилище недоступно — после перезагрузки окно покажется ещё раз.
    }
  },
  clear(): void {
    try {
      sessionStorage.removeItem(SEEN_KEY);
    } catch {
      // ignore
    }
  },
};

/** Для участников Звезды: я в комнате, а запись ведёт кто-то другой — окно (если в этой комнате не отключено). */
export function RecordingAlertHost() {
  const status = useVoiceStore((st) => st.status);
  const starId = useVoiceStore((st) => st.starId);
  const channelId = useVoiceStore((st) => st.channelId);
  const myId = useAuthStore((st) => st.user?.id);
  const detail = useStarsStore((st) => (starId ? st.details[starId] : undefined));
  const [, rerender] = useState(0);

  const recorder = channelId ? detail?.voice?.[channelId]?.find((p) => p.recording) : undefined;
  if (status !== "connected" || !detail || !channelId || !recorder || recorder.user_id === myId) return null;
  const key = `${channelId}:${recorder.user_id}:${recorder.recording_since ?? ""}`;
  if (acknowledged.has(key) || recordingAlertOff(channelId, myId)) return null;

  return (
    <RecordingAlert
      who={presenceName(detail, recorder)}
      where="Запись появится в чате комнаты."
      onClose={(dontShow) => {
        acknowledged.add(key);
        if (dontShow) turnRecordingAlertOff(channelId, myId);
        rerender((n) => n + 1);
      }}
    />
  );
}

export function resetRecordingAlertsForTests(): void {
  acknowledged.clear();
}
