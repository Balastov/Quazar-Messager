import { useCallback, useState } from "react";
import { FingerprintQr, FingerprintScanner, type ScanResult } from "./chat/KeyQr";
import s from "./E2EStatusPanel.module.css";

interface Props {
  username: string;
  fingerprint: string | null;
  trustStatus: "ok" | "new" | "unverified" | "changed" | "missing" | null;
  onVerify: () => void;
  onAcceptKey: () => void;
  onClose: () => void;
}

export default function E2EStatusPanel({
  username,
  fingerprint,
  trustStatus,
  onVerify,
  onAcceptKey,
  onClose,
}: Props) {
  const [mode, setMode] = useState<"digits" | "qr" | "scan">("digits");
  const [scan, setScan] = useState<ScanResult | null>(null);

  const onScan = useCallback(
    (result: ScanResult) => {
      setScan(result);
      setMode("digits");
      if (result === "match" && trustStatus !== "ok" && trustStatus !== "changed") onVerify();
    },
    [onVerify, trustStatus]
  );

  const statusLabel = () => {
    switch (trustStatus) {
      case "ok":
        return "Ключ проверен";
      case "new":
        return "Первый контакт — ключ ещё не проверен";
      case "unverified":
        return "Шифрование активно, ключ не проверен";
      case "changed":
        return "Ключ собеседника изменился";
      default:
        return "Статус шифрования";
    }
  };

  const statusClass = () => {
    if (trustStatus === "ok") return s.statusOk;
    if (trustStatus === "changed") return s.statusChanged;
    return s.statusPending;
  };

  return (
    <div className={s.overlay} onClick={onClose}>
      <div className={s.panel} onClick={(e) => e.stopPropagation()}>
        <div className={s.header}>
          <h3 className={s.title}>Проверка шифрования</h3>
          <button type="button" className={s.close} onClick={onClose} aria-label="Закрыть">
            ✕
          </button>
        </div>

        <p className={s.subtitle}>Чат с {username}</p>
        <p className={`${s.status} ${statusClass()}`}>{statusLabel()}</p>

        {fingerprint ? (
          <div className={s.fingerprintBox}>
            <span className={s.fingerprintLabel}>Код безопасности</span>
            {mode === "digits" && <code className={s.fingerprint}>{fingerprint}</code>}
            {mode === "qr" && <FingerprintQr fingerprint={fingerprint} />}
            {mode === "scan" && <FingerprintScanner fingerprint={fingerprint} onResult={onScan} />}
            <p className={s.hint}>
              {mode === "qr"
                ? `Пусть ${username} откроет эту панель у себя и отсканирует QR.`
                : mode === "scan"
                  ? `Наведите камеру на QR в панели «Проверка шифрования» у ${username}.`
                  : "Сверьте код с собеседником лично или по другому защищённому каналу — или отсканируйте QR, если вы рядом."}
            </p>
            {scan === "match" && <p className={s.scanOk}>✓ Коды совпали — ключ настоящий</p>}
            {scan === "mismatch" && (
              <p className={s.scanBad}>
                Коды не совпадают. Возможно, ключ подменили — не пишите ничего важного и сверьтесь лично.
              </p>
            )}
            <div className={s.modes}>
              {(
                [
                  ["digits", "Цифры"],
                  ["qr", "Мой QR"],
                  ["scan", "Сканировать"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={mode === id ? s.modeActive : s.mode}
                  onClick={() => {
                    setScan(null);
                    setMode(id);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <p className={s.hint}>Публичный ключ собеседника недоступен.</p>
        )}

        <div className={s.actions}>
          {trustStatus === "changed" && (
            <button type="button" className={s.primary} onClick={onAcceptKey}>
              Доверяю новому ключу
            </button>
          )}
          {trustStatus !== "ok" && trustStatus !== "changed" && fingerprint && (
            <button type="button" className={s.primary} onClick={onVerify}>
              Я проверил код
            </button>
          )}
          <button type="button" className={s.secondary} onClick={onClose}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}
