import { useEffect, useRef, useState } from "react";
import { devicesApi, type PairView } from "../../api/devices";
import { checkPairUpdate, deviceLink, finishDeviceLogin, type DeviceLink } from "../../auth/deviceLink";
import { pairKeys, receiverSecret } from "../../crypto/deviceTransfer";
import { apiErrorText } from "../../utils/profile";
import { PairAccount, PairCode, PairExpiry, PairQr, currentDeviceName, usePairLifetime } from "./PairWidgets";
import s from "./Pairing.module.css";

export default function DeviceReceiver({ invite, onDone }: { invite?: Extract<DeviceLink, { kind: "invite" }>; onDone(): void }) {
  const [round, setRound] = useState(0);
  return <ReceiveAttempt key={round} invite={invite} onDone={onDone} onRestart={() => setRound(value => value + 1)} />;
}

function ReceiveAttempt({ invite, onDone, onRestart }: { invite?: Extract<DeviceLink, { kind: "invite" }>; onDone(): void; onRestart(): void }) {
  const [keys] = useState(pairKeys), [secret] = useState(receiverSecret);
  const [flow, setFlow] = useState<PairView | null>(null), [code, setCode] = useState("");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const finishing = useRef(false);
  const row = useRef(flow); row.current = flow;
  const accept = (value: PairView) => { const next = checkPairUpdate(row.current, value, keys, true); row.current = next; setFlow(next); };
  const mounted = usePairLifetime(keys, row, value => devicesApi.cancel(value.id, secret), false);
  const initial = useRef<Promise<{ request: PairView; code: string }>>();
  useEffect(() => {
    let active = true;
    const body = { public_key: keys.publicKey, receiver_secret: secret, device_name: currentDeviceName() };
    initial.current ??= invite ? devicesApi.accept(invite.id, { ...body, invite_secret: invite.secret, expected_key: invite.key })
      .catch(async error => {
        try { return await devicesApi.status(invite.id, secret); } catch { throw error; }
      }).then(request => ({ request, code: "" })) : devicesApi.create(body);
    void initial.current.then(result => {
      if (!active) return;
      if (invite && result.request.approver_public_key !== invite.key) throw new Error("Приглашение изменилось. Создайте новое");
      accept(result.request); setCode(result.code);
    }).catch(err => { if (active) setError(apiErrorText(err, "Не удалось начать подключение")); });
    return () => { active = false; };
  }, [keys, secret, invite]);
  useEffect(() => {
    if (!flow || ["expired", "rejected"].includes(flow.state)) return;
    let active = true, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (Date.parse(flow.expires_at) <= Date.now()) { if (active) setFlow(value => value && { ...value, state: "expired" }); return; }
      try {
        const value = await devicesApi.status(flow.id, secret);
        if (!active) return;
        if (invite && value.approver_public_key !== invite.key) throw new Error("Ключ приглашения изменился");
        accept(value); setError("");
      } catch (err) { if (active) setError(apiErrorText(err, "Не удалось проверить подключение")); }
      if (active) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 1500);
    return () => { active = false; clearTimeout(timer); };
  }, [flow?.id, flow?.state, flow?.expires_at, keys, secret, invite]);
  const finish = async () => {
    if (!flow || finishing.current) return;
    finishing.current = true;
    setBusy(true); setError("");
    try {
      const result = await devicesApi.consume(flow.id, secret);
      if (!mounted.current) { void devicesApi.discard(result.access_token).catch(() => {}); return; }
      accept(result.request);
      await finishDeviceLogin(result, keys, flow);
      onDone();
    } catch (err) { if (mounted.current) setError(apiErrorText(err, "Не удалось завершить вход")); }
    finally { finishing.current = false; if (mounted.current) setBusy(false); }
  };
  const expired = flow && (flow.state === "expired" || Date.parse(flow.expires_at) <= Date.now());
  return <div className={`${s.stack} ${s.center}`}>
    {!flow && !error && <p className={s.hint}>Подготавливаем подключение…</p>}
    {flow && !expired && flow.state !== "rejected" && <>
      {flow.state === "pending" && <>
        <p className={s.hint}>На устройстве, где вы уже вошли, откройте «Настройки → Безопасность → Подключить по QR или коду».</p>
        <PairQr value={deviceLink({ kind: "request", id: flow.id, key: keys.publicKey })} />
        <p className={s.hint}>Без камеры: введите там этот одноразовый код</p>
        <div className={s.code} aria-label="Одноразовый код"><span>{code.slice(0, 4)}-{code.slice(4)}</span></div>
      </>}
      {flow.account && <>
        <PairAccount flow={flow} />
        <p className={s.hint}>Сверьте этот код на двух устройствах и подтвердите подключение на авторизованном.</p>
        <PairCode flow={flow} />
        {["approved", "consumed"].includes(flow.state) ? <>
          {!flow.transferred_keys && flow.account_public_key && <p className={s.hint}>Вход разрешён без переноса переписки. Для личных чатов понадобится восстановить ключи.</p>}
          <button type="button" className={s.primary} disabled={busy} onClick={() => void finish()}>{busy ? "Подключаем…" : `Войти как ${flow.account.display_name}`}</button>
        </> : <p className={s.hint} role="status">Ждём подтверждение на другом устройстве…</p>}
      </>}
      <PairExpiry flow={flow} />
    </>}
    {(expired || flow?.state === "rejected") && <p className={s.hint}>{flow?.state === "rejected" ? "Подключение отменено" : "Время подключения истекло"}</p>}
    {invite && (expired || error) && <p className={s.hint}>Если приглашение уже использовано, создайте новое на авторизованном устройстве.</p>}
    {error && <p className={s.error} role="alert">{error}</p>}
    {(expired || error || flow?.state === "rejected") && <button type="button" className={s.secondary} onClick={onRestart}>
      {invite ? "Повторить подключение" : "Новый QR-код и код подключения"}
    </button>}
  </div>;
}
