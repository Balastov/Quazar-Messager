import { useRef, useState } from "react";
import { importErrorText, useContactsStore, type ImportResult } from "../store/contacts";
import { isContactPickerSupported, pickManyContacts } from "../utils/contactsPicker";
import { isAndroid, isIOS } from "../utils/device";
import { parseVCards } from "../utils/vcard";
import s from "./ContactsImport.module.css";

const MAX_FILE_BYTES = 20 * 1024 * 1024;

function resultText({ checked, added }: ImportResult): string {
  if (!checked) return "В выбранном нет телефонных номеров";
  if (!added) return `Сверили ${checked} — новых знакомых в Quazar не нашлось`;
  return `Сверили ${checked} — нашли в Quazar: ${added}. Они во вкладке «Контакты» → «Из телефона».`;
}

/**
 * Поиск знакомых из телефонной книги в PWA. Браузер не даёт читать книгу сам, поэтому:
 * Android (Chrome) — системный выбор контактов; любое устройство — файл .vcf.
 */
export default function ContactsImport({ onDone }: { onDone?: (result: ImportResult) => void }) {
  const importContacts = useContactsStore((st) => st.importContacts);
  const importing = useContactsStore((st) => st.importing);
  const fileRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const picker = isContactPickerSupported();
  const ios = isIOS();

  const run = async (entries: { name: string; phones: string[] }[] | null) => {
    if (!entries) return; // закрыли выбор
    setStatus(null);
    setError(null);
    try {
      const result = await importContacts(entries);
      setStatus(resultText(result));
      onDone?.(result);
    } catch (err) {
      setError(importErrorText(err));
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setError("Файл больше 20 МБ — выгрузите контакты без фотографий");
      return;
    }
    const entries = parseVCards(await file.text());
    if (!entries.length) {
      setStatus(null);
      setError("В файле не нашлось контактов с телефонами. Нужен файл .vcf из «Контактов».");
      return;
    }
    await run(entries);
  };

  return (
    <div className={s.root}>
      <div className={s.buttons}>
        {picker && (
          <button
            type="button"
            className={s.primary}
            disabled={importing}
            onClick={() => void pickManyContacts().then(run)}
          >
            📇 Выбрать из контактов
          </button>
        )}
        <button
          type="button"
          className={picker ? s.secondary : s.primary}
          disabled={importing}
          onClick={() => fileRef.current?.click()}
        >
          {ios ? "📇 Загрузить контакты из файла" : "Загрузить файл .vcf"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".vcf,text/vcard,text/x-vcard"
          className={s.hidden}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            void onFile(file);
          }}
        />
      </div>
      {importing && <div className={s.status}>Сверяем контакты…</div>}
      {status && <div className={s.status}>{status}</div>}
      {error && <div className={s.error}>{error}</div>}
      {ios ? (
        <details className={s.howto} open={!picker}>
          <summary>Как получить файл контактов на iPhone</summary>
          <ol>
            <li>Откройте «Контакты» и нажмите «Списки» в левом верхнем углу.</li>
            <li>Нажмите и удерживайте «Все контакты» → «Экспортировать» → «Сохранить в Файлы».</li>
            <li>Вернитесь сюда, нажмите кнопку выше и выберите сохранённый файл.</li>
          </ol>
          <p>Или выгрузите контакты на icloud.com → «Контакты» → выделите все → «Экспорт vCard».</p>
        </details>
      ) : (
        isAndroid() && (
          <details className={s.howto}>
            <summary>Как сохранить все контакты в файл на Android</summary>
            <p>
              «Контакты» → меню или «Управление контактами» → «Экспорт» → «Экспорт в файл .vcf».
              Затем нажмите «Загрузить файл .vcf» и выберите его.
            </p>
          </details>
        )
      )}
    </div>
  );
}
