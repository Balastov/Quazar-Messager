import { describe, expect, it } from "vitest";
import { parseVCards } from "../vcard";

describe("parseVCards", () => {
  it("reads an iPhone export with several contacts", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "PRODID:-//Apple Inc.//iPhone OS 18.0//EN",
      "N:Петров;Боб;;;",
      "FN:Боб Петров",
      "item1.TEL;type=pref:+7 (999) 111-00-02",
      "TEL;type=CELL;type=VOICE:8 912 345-67-89",
      "EMAIL;type=INTERNET:bob@example.com",
      "PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQAAAQABAAD",
      " /2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:3.0",
      "N:;Мама;;;",
      "TEL:+79991110003",
      "END:VCARD",
      "BEGIN:VCARD",
      "FN:Без телефона",
      "EMAIL:x@y.z",
      "END:VCARD",
    ].join("\r\n");
    expect(parseVCards(vcf)).toEqual([
      { name: "Боб Петров", phones: ["+7 (999) 111-00-02", "8 912 345-67-89"] },
      { name: "Мама", phones: ["+79991110003"] },
    ]);
  });

  it("decodes quoted-printable names from old Android exports", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:2.1",
      "N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:;=D0=90=D0=BD=D1=8F;;;",
      "FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=D0=90=D0=BD=D1=8F =D0=A1=D0=BC=",
      "=D0=B8=D1=80=D0=BD=D0=BE=D0=B2=D0=B0",
      "TEL;CELL:89991110004",
      "END:VCARD",
    ].join("\n");
    expect(parseVCards(vcf)).toEqual([{ name: "Аня Смирнова", phones: ["89991110004"] }]);
  });

  it("handles vCard 4 tel: URIs, folded lines, escapes and company-only cards", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "FN:Иванов\\, Иван",
      "TEL;VALUE=uri;TYPE=cell:tel:+7-999-111-",
      " 00-05",
      "END:VCARD",
      "BEGIN:VCARD",
      "ORG:Сантехника 24;Офис",
      "TEL:+7 900 123 45 67",
      "TEL:+7 900 123 45 67",
      "TEL:112",
      "END:VCARD",
    ].join("\n");
    expect(parseVCards(vcf)).toEqual([
      { name: "Иванов, Иван", phones: ["+7-999-111-00-05"] },
      { name: "Сантехника 24", phones: ["+7 900 123 45 67"] },
    ]);
  });

  it("ignores garbage", () => {
    expect(parseVCards("hello\nworld")).toEqual([]);
    expect(parseVCards("")).toEqual([]);
  });
});
