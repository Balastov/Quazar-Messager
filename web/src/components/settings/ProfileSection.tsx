import { useRef } from "react";
import { usersApi } from "../../api/users";
import { useAuthStore } from "../../store/auth";
import { useUiStore } from "../../store/ui";
import { activityTracker, IDLE_MINUTES_OPTIONS, systemIdleSupported } from "../../presence/activity";
import { displayName } from "../../utils/profile";
import { formatRuPhoneDisplay } from "../../utils/phone";
import UserAvatar from "../UserAvatar";
import ProfileEditor from "../profile/ProfileEditor";
import StatusPicker from "../StatusPicker";
import CustomStatusEditor from "../status/CustomStatusEditor";
import { MyWorkSchedule } from "../constellation/WorkSettings";
import { useSettingsRun } from "./useSettingsRun";
import s from "../SettingsView.module.css";

const MAX_AVATAR_BYTES = 3 * 1024 * 1024;

/** Профиль: всё, что о вас видят другие, — фото, имя, статус и рабочее время. */
export default function ProfileSection() {
  const user = useAuthStore((st) => st.user);
  const setUser = useAuthStore((st) => st.setUser);
  const systemIdle = useUiStore((st) => st.systemIdle);
  const setSystemIdle = useUiStore((st) => st.setSystemIdle);
  const idleMinutes = useUiStore((st) => st.idleMinutes);
  const setIdleMinutes = useUiStore((st) => st.setIdleMinutes);
  const fileRef = useRef<HTMLInputElement>(null);
  const { busy, run, setStatus, setError, feedback } = useSettingsRun();
  if (!user) return null;

  return (
    <>
      <section className={s.card}>
        <div className={s.profileRow}>
          <UserAvatar username={displayName(user)} avatarUrl={user.avatar_url} size="lg" />
          <div className={s.meta}>
            <div className={s.name}>{displayName(user)}</div>
            <div className={s.phone}>
              @{user.username} · {formatRuPhoneDisplay(user.phone)}
              {user.phone_discoverable === false && " · скрыт"}
            </div>
          </div>
        </div>
        <p className={s.hint}>Фото: JPEG, PNG, WebP или GIF, не больше 3 МБ.</p>
        <div className={s.rowBtns}>
          <button type="button" className={s.primary} disabled={busy} onClick={() => fileRef.current?.click()}>
            Загрузить фото
          </button>
          {user.avatar_url && (
            <button
              type="button"
              className={s.secondary}
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setUser(await usersApi.removeAvatar());
                  setStatus("Аватар удалён");
                })
              }
            >
              Удалить фото
            </button>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          className={s.hidden}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            void run(async () => {
              if (file.size > MAX_AVATAR_BYTES) throw new Error("Файл больше 3 МБ");
              if (!file.type.startsWith("image/")) throw new Error("Нужен файл изображения");
              setUser(await usersApi.uploadAvatar(file));
              setStatus("Аватар обновлён");
            });
          }}
        />
        <h3 className={s.sectionTitle}>Имя и контакты</h3>
        <ProfileEditor user={user} />
      </section>

      <section className={s.card} aria-label="Статус">
        <h3 className={s.sectionTitle}>Свой статус</h3>
        <p className={s.hint}>
          Значок, текст и до какого времени — видят все, с кем у вас общий чат или Звезда. Только
          подпись: уведомления и звонки работают как обычно.
        </p>
        <CustomStatusEditor />
        <h3 className={s.sectionTitle} style={{ marginTop: 8 }}>На встрече или не беспокоить</h3>
        <StatusPicker />
        <p className={`${s.hint} ${s.desktopOnly}`}>
          Быстро поменять статус можно и кнопкой со своим именем внизу боковой панели.
        </p>
      </section>

      <section className={s.card}>
        <h3 className={s.sectionTitle}>Когда я «в сети» и «отошёл»</h3>
        <p className={s.hint}>
          🟢 в сети — вы работаете с Quazar или вы в звонке, на Планете, в Комнате. 🟡 отошёл(ла) —
          на компьютере долго не трогали мышь и клавиатуру, на телефоне приложение свёрнуто или
          экран погас. 🔴 на встрече или не беспокоить — вы поставили сами. Иначе — «был(а) …».
        </p>
        <label className={s.selectRow}>
          <span className={s.toggleLabel}>Считать, что я отошёл, через</span>
          <select className={s.select} value={idleMinutes} onChange={(e) => setIdleMinutes(Number(e.target.value))}>
            {IDLE_MINUTES_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {m} мин
              </option>
            ))}
          </select>
        </label>
        <p className={s.hint}>
          Без мыши и клавиатуры на этом устройстве. Больше — если часто сидите на встречах в
          Zoom или Телемосте и не хотите выглядеть «отошедшим».
        </p>
        {systemIdleSupported() && (
          <>
            <label className={s.toggle}>
              <input
                type="checkbox"
                checked={systemIdle}
                onChange={(e) => {
                  const on = e.target.checked;
                  if (!on) {
                    setSystemIdle(false);
                    activityTracker?.stopSystemIdle();
                    return;
                  }
                  void activityTracker?.startSystemIdle(true).then((ok) => {
                    setSystemIdle(ok);
                    if (!ok) setError("Браузер не дал доступ к определению простоя");
                  });
                }}
              />
              <span className={s.toggleUi} />
              <span className={s.toggleLabel}>Точнее определять, что я отошёл</span>
            </label>
            <p className={s.hint}>
              Браузер сообщит, когда вы {idleMinutes} мин не пользуетесь компьютером вообще (в
              любых программах) или заблокировали экран. Пока вы работаете в другом окне, вы
              будете «в сети».
            </p>
          </>
        )}
      </section>

      <section className={s.card}>
        <h3 className={s.sectionTitle}>Рабочее время</h3>
        <p className={s.hint}>
          Для рабочих Звёзд, где владелец включил рабочее время. Коллеги увидят, что у вас
          нерабочее время, а стуки и приглашения вне ваших часов придут без звука и уведомлений.
        </p>
        <MyWorkSchedule />
      </section>
      {feedback}
    </>
  );
}
