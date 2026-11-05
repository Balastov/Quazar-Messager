import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import qrcode from "qrcode-generator";
import type { PairView } from "../../api/devices";
import { displayPairCode, pairBinding, type PairKeys } from "../../crypto/deviceTransfer";
import { apiErrorText } from "../../utils/profile";
import { desktop } from "../../platform/desktop";
import s from "./Pairing.module.css";

export function currentDeviceName(): string {
  const bridge = desktop();
  const ua = navigator.userAgent;
  const browser = bridge ? "Quazar Desktop" : /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Браузер";
  const platform = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) || (/Mac/.test(navigator.platform) && navigator.maxTouchPoints > 1) ? "iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return platform ? `${browser} · ${platform}` : browser;
}

export function PairQr({ value }: { value: string }) {
  const markup = useMemo(() => {
    const qr = qrcode(0, "M"); qr.addData(value); qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
  }, [value]);
  return <div className={s.qr} role="img" aria-label="QR-код подключения" dangerouslySetInnerHTML={{ __html: markup }} />;
}

export function PairCode({ flow, onBinding }: { flow: PairView; onBinding?: (binding: string) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const callback = useRef(onBinding); callback.current = onBinding;
  useEffect(() => {
    let active = true; setValue(""); setError("");
    void pairBinding(flow).then(binding => { if (active) { setValue(displayPairCode(binding)); callback.current?.(binding); } })
      .catch(err => { if (active) setError(apiErrorText(err)); });
    return () => { active = false; };
  }, [flow.id, flow.receiver_public_key, flow.approver_public_key, flow.account?.id, flow.account_public_key, flow.device_name]);
  return error ? <p className={s.error} role="alert">{error}</p> : <div className={s.code} aria-label="Код сравнения" role="status">
    {value ? value.split(" ").map((part, index) => <span key={index}>{part}</span>) : "Вычисляем код…"}
  </div>;
}

export function PairExpiry({ flow }: { flow: PairView }) {
  const [time, setTime] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setTime(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const seconds = Math.max(0, Math.ceil((Date.parse(flow.expires_at) - time) / 1000));
  return <p className={s.hint}>{seconds ? `Осталось ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "Время подключения истекло"}</p>;
}

/** Delayed cleanup distinguishes a real unmount from React StrictMode's effect replay. */
export function usePairLifetime(keys: PairKeys, row: MutableRefObject<PairView | null>, cancel: (row: PairView) => Promise<unknown>, owner: boolean) {
  const mounted = useRef(false), cancelRef = useRef(cancel); cancelRef.current = cancel;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      setTimeout(() => {
        if (mounted.current) return;
        const flow = row.current;
        keys.secretKey.fill(0);
        if (flow && (owner ? ["offered", "claimed"] : ["pending", "claimed", "approved"]).includes(flow.state)) void cancelRef.current(flow).catch(() => {});
      }, 0);
    };
  }, [keys, row, owner]);
  return mounted;
}

export function PairAccount({ flow }: { flow: PairView }) {
  return flow.account ? <div className={s.account}><strong>{flow.account.display_name}</strong><p className={s.hint}>@{flow.account.username}</p></div> : null;
}
