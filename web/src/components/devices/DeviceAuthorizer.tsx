import { useEffect, useRef, useState } from "react";
import { devicesApi, type PairView } from "../../api/devices";
import { checkPairKey, checkPairUpdate, deviceLink, parseDeviceLink, type DeviceLink } from "../../auth/deviceLink";
import { inspectTransfer, pairKeys, sealDeviceKeys, type PairKeys } from "../../crypto/deviceTransfer";
import { useAuthStore } from "../../store/auth";
import { apiErrorText } from "../../utils/profile";
import DeviceQrScanner from "./DeviceQrScanner";
import { PairAccount, PairCode, PairExpiry, PairQr, usePairLifetime } from "./PairWidgets";
import s from "./Pairing.module.css";

function Approval({ flow, keys, onChange }: { flow: PairView; keys: PairKeys; onChange(value: PairView): void }) {
  const userId = useAuthStore(state => state.user?.id);
  const [binding, setBinding] = useState(""), [matches, setMatches] = useState(false), [withoutKeys, setWithoutKeys] = useState(false);
  const [inspection, setInspection] = useState<Awaited<ReturnType<typeof inspectTransfer>> | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    let active = true; setInspection(null);
    void inspectTransfer(flow).then(value => { if (active) setInspection(value); })
      .catch(() => { if (active) setInspection({ available: false, needsKeys: !!flow.account_public_key, skippedArchives: 0 }); });
    return () => { active = false; };
  }, [flow.account_public_key, flow.account?.id]);
  const approve = async () => {
    if (!matches || !binding || !inspection || busy || (!inspection.available && !withoutKeys)) return;
    setBusy(true); setError("");
    try {
      checkPairKey(flow, keys, false);
      if (userId !== flow.account?.id) throw new Error("Аккаунт изменился. Начните заново");
      const encrypted = inspection.available ? await sealDeviceKeys(flow, keys) : null;
      onChange(await devicesApi.approve(flow.id, binding, encrypted, withoutKeys));
    } catch (err) { setError(apiErrorText(err, "Не удалось разрешить подключение")); }
    finally { setBusy(false); }
  };
  const keysOnly = flow.kind === "keys";
  if (keysOnly && ["approved", "consumed"].includes(flow.state)) return <p className={s.hint} role="status">Ключи переданы. На устройстве «{flow.device_name}» переписка откроется через несколько секунд.</p>;
  if (flow.state === "consumed") return <p className={s.hint} role="status">Устройство подключено. Его можно найти в списке устройств.</p>;
  if (flow.state === "approved") return <p className={s.hint} role="status">Подключение разрешено. Завершите вход на новом устройстве.</p>;
  if (keysOnly) return <div className={s.stack}>
    <p className={s.hint}>Ключи переписки просит: <strong>{flow.device_name}</strong></p>
    <PairAccount flow={flow} />
    <p className={s.hint}>Это устройство уже вошло в ваш аккаунт, но не может читать личные сообщения. Передавайте ключи только своему устройству и сверьте код с его экраном.</p>
    <PairCode flow={flow} onBinding={setBinding} />
    <label className={s.check}><input type="checkbox" checked={matches} onChange={event => setMatches(event.target.checked)} />Код на обоих устройствах совпадает</label>
    {inspection && !inspection.available && <p className={s.error} role="alert">На этом устройстве тоже нет ключа переписки. Передайте ключи с устройства, где личные сообщения читаются.</p>}
    {!!inspection?.skippedArchives && <p className={s.hint}>Часть архивной переписки останется доступна только на этом устройстве.</p>}
    <button type="button" className={s.primary} disabled={busy || !matches || !inspection?.available || !binding} onClick={() => void approve()}>
      {busy ? "Передаём…" : "Передать ключи"}
    </button>
    {error && <p className={s.error} role="alert">{error}</p>}
  </div>;
  return <div className={s.stack}>
    <p className={s.hint}>Подключается: <strong>{flow.device_name}</strong></p>
    <PairAccount flow={flow} />
    <p className={s.hint}>На новом устройстве должен быть открыт сайт quazar-msg.ru или приложение Quazar. Подтверждайте только свой вход и сверьте код с его экраном.</p>
    <PairCode flow={flow} onBinding={setBinding} />
    <label className={s.check}><input type="checkbox" checked={matches} onChange={event => setMatches(event.target.checked)} />Код на обоих устройствах совпадает</label>
    {inspection && !inspection.available && <>
      <p className={s.hint}>На этом устройстве нет доступного ключа личной переписки.</p>
      <label className={s.check}><input type="checkbox" checked={withoutKeys} onChange={event => setWithoutKeys(event.target.checked)} />Разрешить вход без переноса переписки. Ключи нужно будет восстановить отдельно.</label>
    </>}
    {!!inspection?.skippedArchives && <p className={s.hint}>Часть архивной переписки останется доступна только на исходном устройстве.</p>}
    <button type="button" className={s.primary} disabled={busy || !matches || !inspection || !binding || (!inspection.available && !withoutKeys)} onClick={() => void approve()}>
      {busy ? "Подключаем…" : "Это моё устройство — разрешить вход"}
    </button>
    {error && <p className={s.error} role="alert">{error}</p>}
  </div>;
}

export function DeviceAuthorizer({ link }: { link?: Extract<DeviceLink, { kind: "request" }> }) {
  const [keys] = useState(pairKeys), [flow, setFlow] = useState<PairView | null>(null);
  const [code, setCode] = useState(""), [scan, setScan] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const row = useRef(flow); row.current = flow;
  const accept = (value: PairView) => { const next = checkPairUpdate(row.current, value, keys, false); row.current = next; setFlow(next); };
  const mounted = usePairLifetime(keys, row, value => devicesApi.reject(value.id), true);
  const initial = useRef<Promise<PairView>>();
  useEffect(() => {
    if (!link) return;
    let active = true;
    initial.current ??= devicesApi.claim({ public_key: keys.publicKey, request_id: link.id, expected_key: link.key });
    void initial.current.then(value => { if (active) {
      checkPairKey(value, keys, false);
      if (value.receiver_public_key !== link.key) throw new Error("Ключ QR-кода изменился");
      accept(value);
    } })
      .catch(err => { if (active) setError(apiErrorText(err)); });
    return () => { active = false; };
  }, [link, keys]);
  const claim = async (qr?: Extract<DeviceLink, { kind: "request" }>) => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const value = await devicesApi.claim(qr ? { public_key: keys.publicKey, request_id: qr.id, expected_key: qr.key } : { public_key: keys.publicKey, code });
      if (mounted.current) {
        checkPairKey(value, keys, false);
        if (qr && value.receiver_public_key !== qr.key) throw new Error("Ключ QR-кода изменился");
        accept(value);
      }
    } catch (err) { if (mounted.current) setError(apiErrorText(err)); }
    finally { if (mounted.current) setBusy(false); }
  };
  return <div className={s.stack}>
    {flow ? <><Approval flow={flow} keys={keys} onChange={accept} /><PairExpiry flow={flow} /></> : link ? <p className={s.hint}>Открываем запрос подключения…</p> : <>
      <p className={s.hint}>На новом устройстве откройте «Войти по QR-коду», затем отсканируйте его QR или введите код. Так же передаются ключи переписки устройству, где вы уже вошли: код показан в его окне «Восстановите ключи шифрования».</p>
      <button type="button" className={s.secondary} onClick={() => setScan(value => !value)}>{scan ? "Закрыть камеру" : "Сканировать QR-код"}</button>
      {scan && <DeviceQrScanner onScan={value => {
        const parsed = parseDeviceLink(value);
        if (parsed.kind !== "request") throw new Error("Нужен QR-код со страницы входа");
        setScan(false); void claim(parsed);
      }} />}
      <form className={s.stack} onSubmit={event => { event.preventDefault(); void claim(); }}>
        <label className={s.hint}>Одноразовый код<input className={s.input} aria-label="Одноразовый код" autoComplete="off" autoCapitalize="characters" spellCheck={false}
          maxLength={20} value={code} onChange={event => setCode(event.target.value.toUpperCase())} placeholder="ABCD-EFGH" /></label>
        <button type="submit" className={s.primary} disabled={busy || code.replace(/[ -]/g, "").length !== 8}>{busy ? "Открываем…" : "Продолжить"}</button>
      </form>
    </>}
    {error && <p className={s.error} role="alert">{error}</p>}
  </div>;
}

export function DeviceInvitation() {
  const [round, setRound] = useState(0);
  return <InviteAttempt key={round} onRestart={() => setRound(value => value + 1)} />;
}

function InviteAttempt({ onRestart }: { onRestart(): void }) {
  const [keys] = useState(pairKeys), [flow, setFlow] = useState<PairView | null>(null), [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const row = useRef(flow); row.current = flow;
  const accept = (value: PairView) => { const next = checkPairUpdate(row.current, value, keys, false); row.current = next; setFlow(next); };
  usePairLifetime(keys, row, value => devicesApi.reject(value.id), true);
  const initial = useRef<ReturnType<typeof devicesApi.invite>>();
  useEffect(() => {
    let active = true;
    initial.current ??= devicesApi.invite(keys.publicKey);
    void initial.current.then(value => { if (active) { accept(value.request); setSecret(value.invite_secret); } })
      .catch(err => { if (active) setError(apiErrorText(err)); });
    return () => { active = false; };
  }, [keys]);
  useEffect(() => {
    if (!flow || ["consumed", "expired", "rejected"].includes(flow.state)) return;
    let active = true, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (Date.parse(flow.expires_at) <= Date.now()) { if (active) setFlow(value => value && { ...value, state: "expired" }); return; }
      try {
        const value = await devicesApi.owned(flow.id);
        if (!active) return;
        accept(value); setError("");
      } catch (err) { if (active) setError(apiErrorText(err)); }
      if (active) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 1500);
    return () => { active = false; clearTimeout(timer); };
  }, [flow?.id, flow?.state, flow?.expires_at, keys]);
  return <div className={s.stack}>
    {!flow && !error && <p className={s.hint}>Подготавливаем приглашение…</p>}
    {flow?.state === "offered" && <>
      <p className={s.hint}>Отсканируйте этот QR обычной камерой телефона. Откроется Quazar; затем сравните коды и подтвердите подключение здесь.</p>
      <PairQr value={deviceLink({ kind: "invite", id: flow.id, key: keys.publicKey, secret })} />
    </>}
    {flow && ["claimed", "approved", "consumed"].includes(flow.state) && <Approval flow={flow} keys={keys} onChange={accept} />}
    {flow && flow.state !== "consumed" && <PairExpiry flow={flow} />}
    {flow && ["expired", "rejected"].includes(flow.state) && <p className={s.hint}>Приглашение истекло или отменено</p>}
    {error && <p className={s.error} role="alert">{error}</p>}
    {(error || (flow && ["expired", "rejected"].includes(flow.state))) && <button type="button" className={s.secondary} onClick={onRestart}>Новое приглашение</button>}
  </div>;
}
