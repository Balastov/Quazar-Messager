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
            <code className={s.fingerprint}>{fingerprint}</code>
            <p className={s.hint}>
              Сверьте этот код с собеседником лично или по другому защищённому каналу.
            </p>
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
