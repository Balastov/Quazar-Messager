export function extractRuLocalDigits(input: string): string {
  let digits = input.replace(/\D/g, '');
  if (digits.startsWith('8')) digits = digits.slice(1);
  if (digits.startsWith('7')) digits = digits.slice(1);
  return digits.slice(0, 10);
}

export function formatRuPhoneMask(input: string): string {
  const d = extractRuLocalDigits(input);
  const p1 = d.slice(0, 3);
  const p2 = d.slice(3, 6);
  const p3 = d.slice(6, 8);
  const p4 = d.slice(8, 10);

  let out = '+7';
  if (p1) out += ` (${p1}`;
  if (p1.length === 3) out += ')';
  if (p2) out += ` ${p2}`;
  if (p3) out += `-${p3}`;
  if (p4) out += `-${p4}`;
  return out;
}

export function toE164Ru(input: string): string | null {
  const d = extractRuLocalDigits(input);
  if (d.length !== 10) return null;
  return `+7${d}`;
}

export function isCompleteRuPhone(input: string): boolean {
  return extractRuLocalDigits(input).length === 10;
}
