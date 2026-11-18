import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { devicesApi, type PairView } from "../../api/devices";
import type { WsEvent } from "../../api/types";
import { checkPairKey, checkPairUpdate } from "../../auth/deviceLink";
import { pairKeys } from "../../crypto/deviceTransfer";
import { socket } from "../../ws/socket";
import { apiErrorText } from "../../utils/profile";
import Dialog from "../constellation/Dialog";
import { DeviceAuthorizer } from "./DeviceAuthorizer";
import { KeyNumberApproval, type KeyOutcome as Outcome } from "./KeyNumberApproval";
import { usePairLifetime } from "./PairWidgets";
import s from "./Pairing.module.css";

export type KeyRequest = Extract<WsEvent, { type: "device_key_request" }>;

/** Сколько висит «Готово» после передачи, прежде чем окно закроется само. */
const DONE_CLOSE_MS = 3000;

export interface IncomingKeyRequest {
  request: KeyRequest | null;
  /** Пользователь начал отвечать на этом устройстве: запрос не пропадает, пока окно открыто. */
  engaged: boolean;
  setEngaged(value: boolean): void;
  clear(): void;
}

/**
 * Запрос ключей от другого моего устройства: приходит по WebSocket, а если приложение только что
 * открыли (например, из уведомления) — из списка ожидающих. Пропадает, когда его занял другой экран,
 * отменили или он истёк, — но не посреди ответа на этом устройстве.
 */
export function useIncomingKeyRequest(enabled: boolean): IncomingKeyRequest {
  const [request, setRequest] = useState<KeyRequest | null>(null);
  const [engaged, setEngagedState] = useState(false);
  const engagedRef = useRef(false);
  const setEngaged = useCallback((value: boolean) => { engagedRef.current = value; setEngagedState(value); }, []);
  const clear = useCallback(() => { setEngaged(false); setRequest(null); }, [setEngaged]);
  useEffect(() => {
    if (!enabled) return;
    const offer = (event: KeyRequest) => {
      if (!engagedRef.current && Date.parse(event.expires_at) > Date.now()) setRequest(event);
    };
    const load = () => {
      if (engagedRef.current || document.visibilityState === "hidden") return;
      void devicesApi.pendingKeyRequests().then(rows => {
        if (rows[0]) offer({ ...rows[0], type: "device_key_request" });
      }).catch(() => {});
    };
    const off = socket.on(event => {
      if (event.type === "device_key_request") offer(event);
      else if (event.type === "device_key_request_closed" && !engagedRef.current) {
        setRequest(current => current?.id === event.id ? null : current);
      }
    });
    // Пропущенный запрос (приложение было закрыто или без связи) подхватываем при возвращении.
    const offStatus = socket.onStatus(open => { if (open) load(); });
    document.addEventListener("visibilitychange", load);
    load();
    return () => { off(); offStatus(); document.removeEventListener("visibilitychange", load); };
  }, [enabled]);
  // Истёкший запрос убираем, если на него не начали отвечать.
  useEffect(() => {
    if (!request || engaged) return;
    const timer = setTimeout(clear, Math.max(0, Date.parse(request.expires_at) - Date.now()));
    return () => clearTimeout(timer);
  }, [request, engaged, clear]);
  return { request, engaged, setEngaged, clear };
}

function ago(iso: string | undefined): string {
  const minutes = iso ? Math.floor((Date.now() - Date.parse(iso)) / 60_000) : 0;
  return minutes < 1 ? "только что" : `${minutes} мин назад`;
}

/** Ответ на «Это вы входите?»: занимает запрос этим устройством и ведёт до сверки числа. */
function Answer({ request, onOutcome, onDeny }: { request: KeyRequest; onOutcome(outcome: Outcome): void; onDeny(): void }) {
  const [keys] = useState(pairKeys);
  const [flow, setFlow] = useState<PairView | null>(null), [error, setError] = useState("");
  const row = useRef(flow); row.current = flow;
  const accept = (value: PairView) => { const next = checkPairUpdate(row.current, value, keys, false); row.current = next; setFlow(next); };
  // Закрыли окно на середине — запрос отклоняется, новое устройство предложит попробовать снова.
  usePairLifetime(keys, row, value => devicesApi.reject(value.id), true);
  const initial = useRef<Promise<PairView>>();
  useEffect(() => {
    let active = true;
    initial.current ??= devicesApi.claim({ public_key: keys.publicKey, request_id: request.id, expected_key: request.receiver_public_key });
    void initial.current.then(value => {
      if (!active) return;
      checkPairKey(value, keys, false);
      if (value.receiver_public_key !== request.receiver_public_key) throw new Error("Запрос изменился. Начните заново на новом устройстве");
      // Хэш числа должен быть тем же, что пришёл вместе с вопросом, — до того, как мы отправим своё.
      if (value.commitment !== request.commitment) throw new Error("Запрос изменился. Начните заново на новом устройстве");
      accept(value);
    }).catch(err => { if (active) setError(apiErrorText(err, "Не удалось открыть запрос")); });
    return () => { active = false; };
  }, [keys, request]);
  if (error) return <div className={`${s.stack} ${s.center}`}>
    <p className={s.error} role="alert">{error}</p>
    <button type="button" className={s.linkBtn} onClick={onDeny}>Это не я</button>
  </div>;
  if (!flow) return <p className={s.hint} role="status">Открываем запрос…</p>;
  return <KeyNumberApproval flow={flow} keys={keys} onChange={accept} onOutcome={onOutcome} />;
}

/** Окно «Это вы входите?» на устройстве, где переписка читается. */
export default function KeyRequestPrompt({ incoming }: { incoming: IncomingKeyRequest & { request: KeyRequest } }) {
  const { request, engaged, setEngaged, clear } = incoming;
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  // «Это не я» ещё в пути: окно держим, но запрос этим устройством не занимаем.
  const [denying, setDenying] = useState(false);
  const name = request.device_name;

  useEffect(() => {
    if (outcome !== "done") return;
    const timer = setTimeout(clear, DONE_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [outcome, clear]);

  const deny = async () => {
    setBusy(true); setError(""); setDenying(true);
    // Сервер закроет запрос у всех раньше, чем ответит, — здесь окно должно остаться с пояснением.
    setEngaged(true);
    try { await devicesApi.deny(request.id); setOutcome("denied"); }
    catch (err) { setEngaged(false); setError(apiErrorText(err, "Не удалось завершить тот вход")); }
    finally { setBusy(false); setDenying(false); }
  };

  const question = <div className={`${s.stack} ${s.center}`}>
    <p className={s.waiting}><strong>{name}</strong> — {ago(request.created_at)}.</p>
    <p className={s.hint}>Если это вы, на следующем шаге нажмите число, которое видно на новом устройстве.</p>
    <button type="button" className={s.primary} disabled={busy} onClick={() => setEngaged(true)}>Да, это я</button>
    {error && <p className={s.error} role="alert">{error}</p>}
    <button type="button" className={s.linkBtn} disabled={busy} onClick={() => void deny()}>Это не я</button>
  </div>;

  let body: React.ReactNode;
  if (outcome === "done") {
    body = <p className={s.done} role="status">Готово. На «{name}» переписка откроется через пару секунд.</p>;
  } else if (outcome === "mismatch" || outcome === "denied") {
    body = <div className={`${s.stack} ${s.center}`}>
      <p className={s.waiting} role="status">
        {outcome === "mismatch"
          ? "Число не совпало, запрос отменён. Если это вы — начните заново на новом устройстве."
          : `Мы завершили вход на «${name}». Никому не сообщайте коды из сообщений Quazar.`}
      </p>
      <button type="button" className={s.secondary} onClick={clear}>Понятно</button>
    </div>;
  } else if (!request.commitment) {
    // Старая версия приложения на новом устройстве: сверка кодом, как раньше.
    body = engaged && !denying
      ? <DeviceAuthorizer key={request.id} link={{ kind: "request", id: request.id, key: request.receiver_public_key }} />
      : question;
  } else {
    body = engaged && !denying ? <Answer request={request} onOutcome={setOutcome} onDeny={() => void deny()} /> : question;
  }

  return createPortal(
    <Dialog title={outcome ? "Вход на новом устройстве" : "Это вы входите?"} onClose={clear}>{body}</Dialog>,
    document.body,
  );
}
