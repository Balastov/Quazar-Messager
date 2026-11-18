import { useEffect, useRef, useState } from "react";
import { devicesApi, type PairView } from "../../api/devices";
import { checkPairUpdate } from "../../auth/deviceLink";
import { openDeviceKeys, pairKeys, receiverSecret } from "../../crypto/deviceTransfer";
import { commitNonce, keyNumber, randomNonce } from "../../crypto/keyNumber";
import { importDeviceIdentities } from "../../crypto/webcrypto";
import { useE2EStore } from "../../store/e2e";
import { socket } from "../../ws/socket";
import { apiErrorText } from "../../utils/profile";
import { currentDeviceName, usePairLifetime } from "./PairWidgets";
import s from "./Pairing.module.css";

/** Сколько показываем «Готово», прежде чем окно закроется само. */
export const DONE_PAUSE_MS = 1500;

/**
 * Устройство уже вошло в аккаунт, но переписка здесь не читается: просим ключ у другого своего
 * устройства. Запрос уходит сам; там спросят «Это вы входите?», здесь появится число — его нажимают там.
 */
export default function DeviceKeyReceiver({ userId, onDone }: { userId: string; onDone?(): void }) {
  const [round, setRound] = useState(0);
  return <KeyAttempt key={round} userId={userId} onDone={onDone} onRestart={() => setRound(value => value + 1)} />;
}

function KeyAttempt({ userId, onDone, onRestart }: { userId: string; onDone?(): void; onRestart(): void }) {
  const [keys] = useState(pairKeys), [secret] = useState(receiverSecret), [nonce] = useState(randomNonce);
  const [flow, setFlow] = useState<PairView | null>(null), [number, setNumber] = useState<number | null>(null);
  const [error, setError] = useState(""), [saving, setSaving] = useState(false), [done, setDone] = useState(false);
  const row = useRef(flow); row.current = flow;
  // Число подтверждающего, под которое раскрыли своё: после этого оно меняться не может.
  const pinned = useRef<string | null>(null);
  const accept = (value: PairView) => {
    const next = checkPairUpdate(row.current, value, keys, true);
    if (pinned.current && next.approver_nonce !== pinned.current) throw new Error("Данные запроса изменились. Отправьте запрос снова");
    row.current = next; setFlow(next);
  };
  const mounted = usePairLifetime(keys, row, value => devicesApi.cancel(value.id, secret), false);
  const initial = useRef<Promise<{ request: PairView; code: string }>>();
  const finishing = useRef(false), revealing = useRef(false);
  const [nudge, setNudge] = useState(0);

  useEffect(() => {
    let active = true;
    initial.current ??= commitNonce(keys.publicKey, nonce).then(commitment =>
      devicesApi.requestKeys({ public_key: keys.publicKey, receiver_secret: secret, device_name: currentDeviceName(), commitment }));
    void initial.current.then(result => { if (active) accept(result.request); })
      .catch(err => { if (active) setError(apiErrorText(err, "Не удалось отправить запрос")); });
    return () => { active = false; };
  }, [keys, secret, nonce]);

  // Другое устройство ответило — проверяем сразу, не дожидаясь опроса.
  useEffect(() => {
    const off = socket.on(event => {
      if ((event.type === "device_key_request_changed" || event.type === "device_key_request_closed") && event.id === row.current?.id) setNudge(value => value + 1);
    });
    return () => { off(); };
  }, []);

  useEffect(() => {
    if (!flow || !["pending", "claimed"].includes(flow.state)) return;
    let active = true, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (Date.parse(flow.expires_at) <= Date.now()) { if (active) setFlow(value => value && { ...value, state: "expired" }); return; }
      try {
        const value = await devicesApi.status(flow.id, secret);
        if (!active) return;
        accept(value); setError("");
      } catch (err) { if (active) setError(apiErrorText(err, "Не удалось проверить запрос")); }
      if (active) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, nudge ? 0 : 1500);
    return () => { active = false; clearTimeout(timer); };
  }, [flow?.id, flow?.state, flow?.expires_at, flow?.approver_nonce, nudge, keys, secret]);

  // Другое устройство прислало своё число — раскрываем наше и показываем общее.
  useEffect(() => {
    if (!flow || flow.state !== "claimed" || !flow.approver_nonce || revealing.current) return;
    revealing.current = true;
    pinned.current = flow.approver_nonce;
    void (async () => {
      try {
        const value = flow.receiver_nonce ? flow : await devicesApi.reveal(flow.id, secret, nonce);
        if (!mounted.current) return;
        accept(value);
        if (value.receiver_nonce !== nonce) throw new Error("Данные запроса изменились. Отправьте запрос снова");
        setNumber(await keyNumber({ ...value, receiver_nonce: nonce, approver_nonce: pinned.current! }));
      } catch (err) {
        if (mounted.current) setError(apiErrorText(err, "Не удалось показать число"));
      }
    })();
  }, [flow?.state, flow?.approver_nonce]);

  // Другое устройство подтвердило: забираем ключи сразу — число уже сверено там.
  useEffect(() => {
    if (flow?.state !== "approved" || finishing.current) return;
    finishing.current = true;
    const expected = flow;
    void (async () => {
      setSaving(true); setError("");
      try {
        const result = await devicesApi.consumeKeys(expected.id, secret);
        const consumed = checkPairUpdate(expected, result.request, keys, true);
        if (!result.encrypted_keys) throw new Error("Переписка не пришла. Отправьте запрос снова");
        if (consumed.account?.id !== userId) throw new Error("Запрос относится к другому аккаунту");
        const transferred = await openDeviceKeys(result.encrypted_keys, consumed, keys);
        try {
          await importDeviceIdentities(userId, transferred.seed, transferred.archived);
        } finally {
          transferred.seed.fill(0); transferred.archived.forEach(seed => seed.fill(0));
        }
        row.current = consumed;
        if (mounted.current) { setFlow(consumed); setDone(true); }
        await new Promise(resolve => setTimeout(resolve, DONE_PAUSE_MS));
        await useE2EStore.getState().sync(userId);
        onDone?.();
      } catch (err) {
        finishing.current = false;
        if (mounted.current) setError(apiErrorText(err, "Не удалось открыть переписку"));
      } finally {
        if (mounted.current) setSaving(false);
      }
    })();
  }, [flow?.state]);

  const expired = flow && (flow.state === "expired" || (flow.state !== "consumed" && Date.parse(flow.expires_at) <= Date.now()));
  const rejected = flow?.state === "rejected";
  if (done) return <p className={s.done} role="status">Готово, переписка открыта</p>;
  return <div className={`${s.stack} ${s.center}`}>
    {!flow && !error && <p className={s.hint} role="status">Отправляем запрос…</p>}
    {flow && !expired && !rejected && (number === null ? <>
      <p className={s.waiting} role="status">
        {flow.state === "pending" ? "Ждём ответа…" : "Готовим число…"}
      </p>
      <p className={s.hint}>Там появится вопрос «Это вы входите?» — нажмите «Да, это я».</p>
    </> : <>
      <div className={s.number} aria-label="Число для подтверждения">{number}</div>
      <p className={s.hint}>Нажмите это число на другом устройстве.</p>
      <p className={s.waiting} role="status">{saving ? "Открываем переписку…" : "Ждём подтверждения…"}</p>
    </>)}
    {rejected && <p className={s.hint} role="status">Запрос отменён на другом устройстве. Если число не совпало — попробуйте ещё раз.</p>}
    {expired && !rejected && <p className={s.hint} role="status">Ответа не дождались — запрос истёк.</p>}
    {error && <p className={s.error} role="alert">{error}</p>}
    {(expired || error || rejected) && <button type="button" className={s.secondary} onClick={onRestart}>Отправить запрос снова</button>}
  </div>;
}
