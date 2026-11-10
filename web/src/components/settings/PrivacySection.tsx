import { useState } from "react";
import { previewsEnabled, setPreviewsEnabled } from "../../chat/linkPreview";
import { useAuthStore } from "../../store/auth";
import { useContactsStore } from "../../store/contacts";
import ContactsImport from "../ContactsImport";
import PhoneVisibilitySetting from "../profile/PhoneVisibilitySetting";
import { useSettingsRun } from "./useSettingsRun";
import s from "../SettingsView.module.css";

export default function PrivacySection() {
  const user = useAuthStore((st) => st.user);
  const phonebook = useContactsStore((st) => st.contacts);
  const phonebookSyncedAt = useContactsStore((st) => st.syncedAt);
  const phonebookTotal = useContactsStore((st) => st.total);
  const forgetPhonebook = useContactsStore((st) => st.forget);
  const [linkPreviews, setLinkPreviews] = useState(() => previewsEnabled());
  const { busy, run, setStatus, feedback } = useSettingsRun();
  if (!user) return null;

  return (
    <>
      <section className={s.card}>
        <h3 className={s.sectionTitle}>Номер телефона</h3>
        <PhoneVisibilitySetting user={user} />
      </section>

      <section className={s.card}>
        <h3 className={s.sectionTitle}>Превью ссылок</h3>
        <label className={s.toggle}>
          <input
            type="checkbox"
            checked={linkPreviews}
            onChange={(e) => {
              setLinkPreviews(e.target.checked);
              setPreviewsEnabled(e.target.checked);
            }}
          />
          <span className={s.toggleUi} />
          <span className={s.toggleLabel}>Показывать превью ссылок, которые я отправляю</span>
        </label>
        <p className={s.hint}>
          Пока вы пишете, сервер Quazar открывает первую ссылку из сообщения и берёт заголовок и
          картинку — переписку он при этом не видит. В личных чатах превью уходит внутри
          зашифрованного сообщения, собеседник сайт не открывает. Выключите, если не хотите,
          чтобы сервер узнавал ваши ссылки.
        </p>
      </section>

      <section className={s.card}>
        <h3 className={s.sectionTitle}>Контакты из телефона</h3>
        <p className={s.hint}>
          Покажем, кто из ваших контактов уже в Quazar. Номера сверяются на сервере и не
          сохраняются: остаются только найденные люди и имена, под которыми они у вас записаны.
        </p>
        <ContactsImport />
        {phonebookSyncedAt && (
          <>
            <p className={s.hint}>
              Найдено в Quazar: {phonebook.length} (сверено контактов: {phonebookTotal}) ·
              обновлено {new Date(phonebookSyncedAt).toLocaleString("ru")}. Список — во вкладке
              «Контакты» → «Из телефона».
            </p>
            <div className={s.rowBtns}>
              <button
                type="button"
                className={s.secondary}
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      "Удалить найденные контакты с сервера? Люди останутся в Quazar, просто пропадут из списка «Из телефона»."
                    )
                  ) {
                    void run(async () => {
                      await forgetPhonebook();
                      setStatus("Контакты удалены с сервера");
                    });
                  }
                }}
              >
                Очистить список
              </button>
            </div>
          </>
        )}
      </section>
      {feedback}
    </>
  );
}
