import { useEffect, useState } from "react";
import type { AccountProof } from "../../crypto/keys";
import { useAuthStore } from "../../store/auth";
import { reauthCode, startReauth, type ReauthPurpose } from "../../auth/reauth";
import PhoneVerification from "./PhoneVerification";
import { authApi } from "../../api/auth";

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
  const user = useAuthStore(st => st.user);
  const phoneVerified = !!user?.phone_verified_at;
  const [phoneProof, setPhoneProof] = useState<string>();
  const [hasYandex, setHasYandex] = useState(false);
  useEffect(() => { if (phoneVerified) void authApi.signInMethods().then(methods => setHasYandex(methods.identities.some(i => i.provider === "yandex"))).catch(() => {}); }, [phoneVerified]);
  const [password, setPassword] = useState("");
  const [code] = useState(reauthCode);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if ((phoneVerified || !hasPassword) && code) onChange({ reauthCode: code });
    else onChange(null);
    // onChange — новая функция на каждый рендер родителя; подтверждение отдаём один раз.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasPassword, phoneVerified, code]);

  if (phoneVerified) return <>
    {code ? <p className={hintClassName}>✓ Подтверждено через Яндекс ID</p> : <>
      <PhoneVerification phone={user!.phone!} account="reauth" proof={phoneProof} onVerified={token => { setPhoneProof(token); onChange({phoneProof: token}); }} />
      {hasYandex && <button type="button" className={buttonClassName} disabled={disabled}
        onClick={() => void startReauth(purpose).catch(() => setError("Не получилось открыть Яндекс ID"))}>Подтвердить через Яндекс ID</button>}
    </>}
    {error && <p className={hintClassName}>{error}</p>}
  </>;

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
