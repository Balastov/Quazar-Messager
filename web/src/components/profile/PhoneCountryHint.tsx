import { isForeignPhoneInput, toE164 } from "../../utils/phone";
import { usePhoneMethod } from "../../auth/phoneMethod";

/** Под полем номера: как ввести номер другой страны и как его подтвердят. */
export default function PhoneCountryHint({ phone, className }: { phone: string; className?: string }) {
  const method = usePhoneMethod(toE164(phone) ?? (isForeignPhoneInput(phone) ? "+1" : "+7"));
  if (!isForeignPhoneInput(phone)) {
    // Пока номер не начали набирать: дальше подсказка только мешала бы российским номерам.
    if (phone.replace(/\D/g, "").replace(/^[78]/, "")) return null;
    return <p className={className}>Номер другой страны — сотрите «7» и введите код страны, например +44.</p>;
  }
  // Страну не называем: у +44, +1 и других кодов несколько стран, и библиотека может назвать не ту.
  if (method === "call") {
    return <p className={className}>Номер подтверждается звонком на российский номер: оператор может взять плату за международный звонок.</p>;
  }
  return <p className={className}>Код подтверждения придёт в Telegram, привязанный к этому номеру.</p>;
}
