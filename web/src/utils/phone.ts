/** Russian phone mask helpers: display +7 (999) 000-00-00, store +7XXXXXXXXXX */

export function extractRuLocalDigits(input: string): string {
  let digits = input.replace(/\D/g, "");
  if (digits.startsWith("8")) digits = digits.slice(1);
  if (digits.startsWith("7")) digits = digits.slice(1);
  return digits.slice(0, 10);
}

/** Format as +7 (999) 000-00-00 while typing */
export function formatRuPhoneMask(input: string): string {
  const d = extractRuLocalDigits(input);
  const p1 = d.slice(0, 3);
  const p2 = d.slice(3, 6);
  const p3 = d.slice(6, 8);
  const p4 = d.slice(8, 10);

  let out = "+7";
  if (p1) out += ` (${p1}`;
  if (p1.length === 3) out += ")";
  if (p2) out += ` ${p2}`;
  if (p3) out += `-${p3}`;
  if (p4) out += `-${p4}`;
  return out;
}

/** Convert mask/input to +7XXXXXXXXXX or null if incomplete */
export function toE164Ru(input: string): string | null {
  const d = extractRuLocalDigits(input);
  if (d.length !== 10) return null;
  return `+7${d}`;
}

export function isCompleteRuPhone(input: string): boolean {
  return extractRuLocalDigits(input).length === 10;
}

/** Format stored +7XXXXXXXXXX (or raw) for UI */
export function formatRuPhoneDisplay(input: string | null | undefined): string {
  if (!input) return "";
  const e164 = toE164Ru(input) ?? (input.startsWith("+7") && input.length >= 12 ? input : null);
  if (!e164) return input;
  return formatRuPhoneMask(e164);
}

/** Query looks like a phone fragment (enough digits to search). */
export function looksLikePhoneQuery(input: string): boolean {
  return extractRuLocalDigits(input).length >= 3;
}

/** Whether the search box has enough input to query the API. */
export function canSearchUsers(input: string): boolean {
  const q = input.trim();
  if (!q) return false;
  const digits = extractRuLocalDigits(q);
  const mostlyPhone = digits.length > 0 && digits.length >= q.replace(/\s/g, "").replace(/[+\-()]/g, "").length * 0.6;
  if (mostlyPhone || looksLikePhoneQuery(q)) {
    return digits.length >= 3;
  }
  return q.length >= 2;
}
