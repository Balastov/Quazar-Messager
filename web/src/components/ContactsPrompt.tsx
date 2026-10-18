import { useEffect, useState } from "react";
import { useContactsStore } from "../store/contacts";
import { isMobileDevice } from "../utils/device";
import ContactsImport from "./ContactsImport";
import s from "./ContactsPrompt.module.css";

const ASKED_KEY = "quazar-contacts-asked";

function wasAsked(): boolean {
  try {
    return localStorage.getItem(ASKED_KEY) === "1";
  } catch {
    return true;
  }
}

function markAsked() {
  try {
    localStorage.setItem(ASKED_KEY, "1");
  } catch {
    // Приватный режим — спросим в следующий раз.
  }
}

/**
 * Первое открытие на телефоне или планшете: предлагаем найти знакомых из телефонной книги.
 * Закрыли — кнопки остаются в Настройках.
 */
export default function ContactsPrompt() {
  const loaded = useContactsStore((st) => st.loaded);
  const syncedAt = useContactsStore((st) => st.syncedAt);
  const [open, setOpen] = useState(() => isMobileDevice() && !wasAsked());
  const [done, setDone] = useState(false);
  // Решаем один раз, когда пришёл список: уже загружали контакты (например, с другого
  // телефона) — не спрашиваем. Импорт в этом окне тоже задаёт syncedAt, но окно не закрывает.
  const [alreadyHad, setAlreadyHad] = useState<boolean | null>(null);
  useEffect(() => {
    if (loaded && alreadyHad === null) setAlreadyHad(!!syncedAt);
  }, [loaded, syncedAt, alreadyHad]);

  if (!open || alreadyHad !== false) return null;

  const close = () => {
    markAsked();
    setOpen(false);
  };

  return (
    <div className={s.backdrop} role="dialog" aria-modal="true" aria-label="Найти знакомых">
      <div className={s.card}>
        <div className={s.icon}>📇</div>
        <h3 className={s.title}>Найти знакомых в Quazar?</h3>
        <p className={s.text}>
          Выберите контакты из телефона — покажем, кто из них уже здесь. Номера сверяются на
          сервере и не сохраняются: остаются только найденные люди и имена, под которыми они у
          вас записаны.
        </p>
        <ContactsImport
          onDone={() => {
            markAsked();
            setDone(true);
          }}
        />
        <button type="button" className={s.later} onClick={close}>
          {done ? "Готово" : "Не сейчас"}
        </button>
        {!done && <p className={s.note}>Найти знакомых можно и позже — в Настройках.</p>}
      </div>
    </div>
  );
}
