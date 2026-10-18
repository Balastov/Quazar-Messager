/**
 * Разбор файла контактов vCard (.vcf) — выгрузка из «Контактов» iPhone, iCloud, Google, Android.
 * Нужны только имя и телефоны; всё остальное (фото, почта, адреса) пропускаем.
 */

export interface VCardContact {
  name: string;
  phones: string[];
}

/** Строки vCard переносятся: продолжение начинается с пробела или табуляции. */
function unfold(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && lines.length) {
      lines[lines.length - 1] += raw.slice(1);
    } else {
      lines.push(raw);
    }
  }
  // Quoted-printable: строка, оканчивающаяся на «=», продолжается на следующей.
  const out: string[] = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    if (prev !== undefined && /ENCODING=QUOTED-PRINTABLE/i.test(prev) && prev.endsWith("=")) {
      out[out.length - 1] = prev.slice(0, -1) + line;
    } else {
      out.push(line);
    }
  }
  return out;
}

function decodeQuotedPrintable(value: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(value.slice(i + 1, i + 3))) {
      bytes.push(parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(...new TextEncoder().encode(ch));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function unescapeValue(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_m, c: string) => (c === "n" || c === "N" ? " " : c));
}

interface Property {
  name: string;
  params: string;
  value: string;
}

function parseLine(line: string): Property | null {
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const [rawName, ...params] = head.split(";");
  // «item1.TEL» — группа Apple; имя свойства после точки.
  const name = rawName.slice(rawName.lastIndexOf(".") + 1).toUpperCase();
  let value = line.slice(colon + 1);
  const paramText = params.join(";");
  if (/ENCODING=QUOTED-PRINTABLE/i.test(paramText)) value = decodeQuotedPrintable(value);
  return { name, params: paramText, value };
}

export function parseVCards(text: string): VCardContact[] {
  const contacts: VCardContact[] = [];
  let current: { fn: string; n: string; org: string; phones: string[] } | null = null;
  for (const line of unfold(text)) {
    const prop = parseLine(line.trim());
    if (!prop) continue;
    if (prop.name === "BEGIN" && /^vcard$/i.test(prop.value.trim())) {
      current = { fn: "", n: "", org: "", phones: [] };
    } else if (prop.name === "END" && current) {
      const phones = [...new Set(current.phones)].slice(0, 10);
      const name = (current.fn || current.n || current.org).replace(/\s+/g, " ").trim();
      if (phones.length) contacts.push({ name, phones });
      current = null;
    } else if (current) {
      if (prop.name === "FN") current.fn = unescapeValue(prop.value);
      else if (prop.name === "N") {
        // N:Фамилия;Имя;Отчество;Префикс;Суффикс
        const [family = "", given = "", middle = ""] = prop.value.split(";").map(unescapeValue);
        current.n = [given, middle, family].filter(Boolean).join(" ");
      } else if (prop.name === "ORG") current.org = unescapeValue(prop.value.split(";")[0]);
      else if (prop.name === "TEL") {
        const phone = prop.value.replace(/^tel:/i, "").trim();
        if (/\d{5,}/.test(phone.replace(/\D/g, ""))) current.phones.push(phone);
      }
    }
  }
  return contacts;
}
