import { useEffect, useState } from "react";
import type { AccountProof } from "../../crypto/keys";
import { useAuthStore } from "../../store/auth";
import { reauthCode, startReauth, type ReauthPurpose } from "../../auth/reauth";

/**
 * Подтвердить важное действие: пароль аккаунта — или, если пароля нет (аккаунт через Яндекс),
 * кнопка «Подтвердить через Яндекс ID». Готовое подтверждение отдаёт через onChange (null — ещё нет).
 */
export default function AccountProofInput({
  purpose,
  onChange,
  disabled,
  inputClassName,
  buttonClassName,
  hintClassName,
  placeholder = "Пароль аккаунта",
}: {
  purpose: ReauthPurpose;
  onChange: (proof: AccountProof | null) => void;
  disabled?: boolean;
  inputClassName?: string;
  buttonClassName?: string;
  hintClassName?: string;
  placeholder?: string;
}) {
  const hasPassword = useAuthStore((st) => st.user?.has_password !== false);
  const [password, setPassword] = useState("");
  const [code] = useState(reauthCode);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasPassword && code) onChange({ reauthCode: code });
    // onChange — новая функция на каждый рендер родителя; подтверждение отдаём один раз.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasPassword, code]);

  if (hasPassword) {
    return (
      <input
        className={inputClassName}
        type="password"
        placeholder={placeholder}
        value={password}
        onChange={(e) => {
          setPassword(e.target.value);
          onChange(e.target.value.length >= 8 ? { password: e.target.value } : null);
        }}
        disabled={disabled}
        autoComplete="current-password"
      />
    );
  }
  if (code) return <p className={hintClassName}>✓ Подтверждено через Яндекс ID</p>;
  return (
    <>
      <button
        type="button"
        className={buttonClassName}
        disabled={disabled}
        onClick={() => void startReauth(purpose).catch(() => setError("Не получилось открыть Яндекс ID"))}
      >
        Подтвердить через Яндекс ID
      </button>
      {error && <p className={hintClassName}>{error}</p>}
    </>
  );
}
