import { isForeignPhoneInput } from "../../utils/phone";

/** Под полем номера: как ввести номер другой страны и как его подтвердят. */
export default function PhoneCountryHint({ phone, className }: { phone: string; className?: string }) {
  if (!isForeignPhoneInput(phone)) {
    // Пока номер не начали набирать: дальше подсказка только мешала бы российским номерам.
    if (phone.replace(/\D/g, "").replace(/^[78]/, "")) return null;
    return <p className={className}>Номер другой страны — сотрите «7» и введите код страны, например +44.</p>;
  }
  // Страну не называем: у +44, +1 и других кодов несколько стран, и библиотека может назвать не ту.
  return <p className={className}>Код подтверждения придёт в Telegram, привязанный к этому номеру.</p>;
}
