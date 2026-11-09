import { useEffect, useRef, useState } from "react";
import { devicesApi, type PairView } from "../../api/devices";
import { checkPairUpdate, deviceLink } from "../../auth/deviceLink";
import { openDeviceKeys, pairKeys, receiverSecret } from "../../crypto/deviceTransfer";
import { importDeviceIdentities } from "../../crypto/webcrypto";
import { useE2EStore } from "../../store/e2e";
import { apiErrorText } from "../../utils/profile";
import { PairCode, PairExpiry, PairQr, currentDeviceName, usePairLifetime } from "./PairWidgets";
import s from "./Pairing.module.css";

/**
 * Устройство уже вошло в аккаунт, но ключа переписки здесь нет: просим его у другого своего устройства.
 * Выходить из аккаунта не нужно, пароль резервной копии тоже.
 */
export default function DeviceKeyReceiver({ userId, onDone }: { userId: string; onDone?(): void }) {
  const [round, setRound] = useState(0);
  return <KeyAttempt key={round} userId={userId} onDone={onDone} onRestart={() => setRound(value => value + 1)} />;
}

function KeyAttempt({ userId, onDone, onRestart }: { userId: string; onDone?(): void; onRestart(): void }) {
  const [keys] = useState(pairKeys), [secret] = useState(receiverSecret);
  const [flow, setFlow] = useState<PairView | null>(null), [code, setCode] = useState("");
  const [error, setError] = useState(""), [saving, setSaving] = useState(false);
  const row = useRef(flow); row.current = flow;
  const accept = (value: PairView) => { const next = checkPairUpdate(row.current, value, keys, true); row.current = next; setFlow(next); };
  const mounted = usePairLifetime(keys, row, value => devicesApi.cancel(value.id, secret), false);
  const initial = useRef<ReturnType<typeof devicesApi.requestKeys>>();
  const finishing = useRef(false);

  useEffect(() => {
    let active = true;
    initial.current ??= devicesApi.requestKeys({ public_key: keys.publicKey, receiver_secret: secret, device_name: currentDeviceName() });
    void initial.current.then(result => {
      if (!active) return;
      accept(result.request); setCode(result.code);
    }).catch(err => { if (active) setError(apiErrorText(err, "Не удалось начать передачу ключей")); });
    return () => { active = false; };
  }, [keys, secret]);

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
    timer = setTimeout(poll, 1500);
    return () => { active = false; clearTimeout(timer); };
  }, [flow?.id, flow?.state, flow?.expires_at, keys, secret]);

  // Другое устройство подтвердило: забираем ключи сразу — коды уже сверены там.
  useEffect(() => {
    if (flow?.state !== "approved" || finishing.current) return;
    finishing.current = true;
    const expected = flow;
    void (async () => {
      setSaving(true); setError("");
      try {
        const result = await devicesApi.consumeKeys(expected.id, secret);
        const done = checkPairUpdate(expected, result.request, keys, true);
        if (!result.encrypted_keys) throw new Error("Ключи не пришли. Повторите передачу");
        if (done.account?.id !== userId) throw new Error("Ключи относятся к другому аккаунту");
        const transferred = await openDeviceKeys(result.encrypted_keys, done, keys);
        try {
          await importDeviceIdentities(userId, transferred.seed, transferred.archived);
        } finally {
          transferred.seed.fill(0); transferred.archived.forEach(seed => seed.fill(0));
        }
        row.current = done;
        if (mounted.current) setFlow(done);
        await useE2EStore.getState().sync(userId);
        onDone?.();
      } catch (err) {
        finishing.current = false;
        if (mounted.current) setError(apiErrorText(err, "Не удалось сохранить ключи"));
      } finally {
        if (mounted.current) setSaving(false);
      }
    })();
  }, [flow?.state]);

  const expired = flow && (flow.state === "expired" || (flow.state !== "consumed" && Date.parse(flow.expires_at) <= Date.now()));
  return <div className={`${s.stack} ${s.center}`}>
    {!flow && !error && <p className={s.hint}>Готовим запрос…</p>}
    {flow && !expired && flow.state !== "rejected" && <>
      {flow.state === "pending" && <>
        <p className={s.hint}>
          Откройте Quazar там, где переписка читается. Если там открыт сайт или приложение для компьютера,
          запрос появится сам — нажмите «Передать ключи». Иначе отсканируйте QR-код камерой телефона
          или введите код: «Настройки → Устройства → Подключить по QR или коду»,
          в приложении на телефоне — «Профиль → Ключи шифрования».
        </p>
        <PairQr value={deviceLink({ kind: "request", id: flow.id, key: keys.publicKey })} />
        <div className={s.code} aria-label="Одноразовый код"><span>{code.slice(0, 4)}-{code.slice(4)}</span></div>
      </>}
      {flow.state !== "pending" && <>
        <p className={s.hint}>Сверьте код с экраном другого устройства и подтвердите передачу там.</p>
        <PairCode flow={flow} />
        <p className={s.hint} role="status">
          {saving ? "Сохраняем ключи…" : flow.state === "consumed" ? "Ключи получены" : "Ждём подтверждение на другом устройстве…"}
        </p>
      </>}
      {flow.state !== "consumed" && <PairExpiry flow={flow} />}
    </>}
    {(expired || flow?.state === "rejected") && <p className={s.hint}>{flow?.state === "rejected" ? "Передача отменена" : "Время запроса истекло"}</p>}
    {error && <p className={s.error} role="alert">{error}</p>}
    {(expired || error || flow?.state === "rejected") && <button type="button" className={s.secondary} onClick={onRestart}>Новый код</button>}
  </div>;
}
