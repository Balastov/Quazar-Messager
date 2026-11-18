import { useEffect, useRef, useState } from "react";
import { devicesApi, type PairView } from "../../api/devices";
import { checkPairKey } from "../../auth/deviceLink";
import { inspectTransfer, pairBinding, sealDeviceKeys, type PairKeys } from "../../crypto/deviceTransfer";
import { commitmentMatches, keyNumber, numberChoices, randomNonce } from "../../crypto/keyNumber";
import { useAuthStore } from "../../store/auth";
import { socket } from "../../ws/socket";
import { apiErrorText } from "../../utils/profile";
import s from "./Pairing.module.css";

export type KeyOutcome = "done" | "mismatch" | "denied";

/**
 * Сверка числом на устройстве, где переписка читается: своё число уходит на сервер только после того,
 * как новое устройство зафиксировало своё (commitment), а кнопки-числа появляются, когда оно раскрыто.
 */
export function KeyNumberApproval({ flow, keys, onChange, onOutcome }: {
  flow: PairView; keys: PairKeys; onChange(value: PairView): void; onOutcome(outcome: KeyOutcome): void;
}) {
  const userId = useAuthStore(state => state.user?.id);
  const [nonce] = useState(randomNonce);
  const [choices, setChoices] = useState<number[] | null>(null);
  const [correct, setCorrect] = useState<number | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [nudge, setNudge] = useState(0);
  const sent = useRef(false), computed = useRef(false);
  const latest = useRef(flow); latest.current = flow;

  useEffect(() => {
    const off = socket.on(event => {
      if (event.type === "device_key_request_changed" && event.id === latest.current.id) setNudge(value => value + 1);
    });
    return () => { off(); };
  }, []);

  // 1. Своё число — один раз и только после того, как увидели хэш нового устройства.
  useEffect(() => {
    if (sent.current || flow.state !== "claimed" || !flow.commitment) return;
    sent.current = true;
    if (flow.approver_nonce) { if (flow.approver_nonce !== nonce) setError("Запрос уже открыт на другом устройстве"); return; }
    void devicesApi.approverNonce(flow.id, nonce).then(onChange).catch(err => setError(apiErrorText(err, "Не удалось продолжить")));
  }, [flow.state, flow.commitment]);

  // 2. Ждём, пока новое устройство раскроет своё число.
  useEffect(() => {
    if (flow.state !== "claimed" || flow.receiver_nonce || flow.approver_nonce !== nonce) return;
    let active = true;
    const timer = setTimeout(() => {
      void devicesApi.owned(flow.id).then(value => { if (active) onChange(value); })
        .catch(err => { if (active) setError(apiErrorText(err, "Не удалось проверить запрос")); });
    }, nudge ? 0 : 1200);
    return () => { active = false; clearTimeout(timer); };
  }, [flow.state, flow.receiver_nonce, flow.approver_nonce, nudge, flow]);

  // 3. Раскрыто: сверяем с хэшем и считаем число.
  useEffect(() => {
    if (computed.current || !flow.receiver_nonce || flow.approver_nonce !== nonce) return;
    computed.current = true;
    void (async () => {
      try {
        if (!await commitmentMatches(flow)) throw new Error("Запрос изменился по дороге. Отклоните его и начните заново на новом устройстве");
        const value = await keyNumber(flow);
        setCorrect(value); setChoices(numberChoices(value));
      } catch (err) { setError(apiErrorText(err, "Не удалось подготовить числа")); }
    })();
  }, [flow.receiver_nonce, flow.approver_nonce]);

  const pick = async (value: number) => {
    if (busy || correct === null) return;
    setBusy(true); setError("");
    try {
      if (value !== correct) {
        await devicesApi.reject(flow.id).catch(() => {});
        onOutcome("mismatch");
        return;
      }
      checkPairKey(flow, keys, false);
      if (userId !== flow.account?.id) throw new Error("Аккаунт изменился. Начните заново");
      const inspection = await inspectTransfer(flow);
      if (!inspection.available) throw new Error("На этом устройстве тоже нет ключа переписки — передать его отсюда не получится");
      const encrypted = await sealDeviceKeys(flow, keys);
      onChange(await devicesApi.approve(flow.id, await pairBinding(flow), encrypted, false));
      onOutcome("done");
    } catch (err) { setError(apiErrorText(err, "Не удалось передать переписку")); }
    finally { setBusy(false); }
  };

  const notMe = async () => {
    setBusy(true); setError("");
    try { await devicesApi.deny(flow.id); onOutcome("denied"); }
    catch (err) { setError(apiErrorText(err, "Не удалось завершить тот вход")); }
    finally { setBusy(false); }
  };

  if (["rejected", "expired"].includes(flow.state)) {
    return <p className={s.hint} role="status">Запрос отменён или истёк. Если это вы — начните заново на новом устройстве.</p>;
  }
  return <div className={`${s.stack} ${s.center}`}>
    {choices ? <>
      <p className={s.waiting}>Нажмите число, которое видите на новом устройстве.</p>
      <div className={s.choices} role="group" aria-label="Число с нового устройства">
        {choices.map(value => <button key={value} type="button" className={s.choice} disabled={busy} onClick={() => void pick(value)}>{value}</button>)}
      </div>
    </> : !error && <p className={s.hint} role="status">Ждём число с нового устройства…</p>}
    {error && <p className={s.error} role="alert">{error}</p>}
    <button type="button" className={s.linkBtn} disabled={busy} onClick={() => void notMe()}>Это не я</button>
  </div>;
}
