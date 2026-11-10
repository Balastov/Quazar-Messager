import { useEffect, useState } from "react";
import { devicesApi, type DeviceSession } from "../../api/devices";
import { useE2EStore } from "../../store/e2e";
import s from "./KeyHelp.module.css";

type Route = "device" | "backup" | "new";

/** Что можно сделать прямо сейчас — по тому, что известно об аккаунте. */
export function recommendedRoute(others: DeviceSession[] | null, hasServerBackup: boolean): Route | null {
  // Устройство, о котором известно, что ключа там нет, — не вариант; неизвестное (старая версия) — возможно.
  if (others === null || others.some((device) => device.has_account_key !== false)) return "device";
  if (hasServerBackup) return "backup";
  // Других сеансов и копии нет: подскажем все пути, но ни один не обещаем.
  return null;
}

/** Другие сеансы аккаунта; null — пока не знаем (не загрузились). */
function useOtherDevices(): DeviceSession[] | null {
  const [others, setOthers] = useState<DeviceSession[] | null>(null);
  useEffect(() => {
    let active = true;
    devicesApi
      .list()
      .then((all) => active && setOthers(all.filter((device) => !device.current)))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  return others;
}

function lastSeen(device: DeviceSession): string {
  return new Date(device.last_seen_at).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}

function DeviceNames({ devices }: { devices: DeviceSession[] }) {
  return (
    <>
      {devices.map((device, i) => (
        <span key={device.id}>
          {i > 0 && ", "}
          <b>{device.name}</b> (активность {lastSeen(device)})
        </span>
      ))}
    </>
  );
}

/**
 * Справка о ключах шифрования простыми словами: что это, почему ключа нет на этом устройстве
 * и что делать в ситуации пользователя. onRestore открывает окно восстановления.
 */
export default function KeyHelp({ onRestore }: { onRestore?: () => void }) {
  const status = useE2EStore((st) => st.status);
  const hasServerBackup = useE2EStore((st) => st.hasServerBackup);
  const hasLocalKey = useE2EStore((st) => st.hasLocalKey);
  const others = useOtherDevices();
  const missing = status === "needs_restore";
  const route = recommendedRoute(others, hasServerBackup);
  const withKey = others?.filter((device) => device.has_account_key === true) ?? [];
  const unknown = others?.filter((device) => device.has_account_key == null) ?? [];
  const withoutKey = others?.filter((device) => device.has_account_key === false) ?? [];
  const badge = (value: Route) => missing && route === value && <span className={s.badge}>Ваш вариант</span>;

  return (
    <div className={s.root}>
      <section className={s.block}>
        <h4 className={s.title}>Зачем нужны ключи</h4>
        <p>
          Личные сообщения в Quazar шифруются прямо на ваших устройствах. Прочитать их можете
          только вы и ваш собеседник. Ни сервер Quazar, ни наша команда, ни тот, кто перехватит
          интернет-трафик или взломает сервер, увидит только набор случайных символов.
        </p>
        <p>
          Работает это как почтовый ящик с замком: опустить письмо может любой, а открыть — только
          ваш ключ. Ключ один на весь аккаунт и хранится <b>только на ваших устройствах</b>. На
          сервер он попадает, только если вы сами сохраните резервную копию, — и то запертым вашим
          паролем. Поэтому на каждом новом устройстве ключ нужно получить — с другого своего
          устройства или из резервной копии.
        </p>
        <p>
          Вход в аккаунт и ключ — разные вещи: войти можно по номеру или паролю, а прочитать
          переписку — только с ключом.
        </p>
      </section>

      {missing ? (
        <>
          <section className={s.block}>
            <h4 className={s.title}>Что сейчас не работает</h4>
            <p>
              На этом устройстве не открываются и не отправляются личные сообщения. Остальное
              работает как обычно: группы, Звёзды и Планеты, звонки, чат поддержки.
            </p>
            <p>
              Ничего не потеряно: сообщения, которые вам присылают сейчас, прочитаются здесь, как
              только появится ключ.
            </p>
          </section>

          <section className={s.block}>
            <h4 className={s.title}>Что делать</h4>
            <p>Выберите один из способов — сверху самые простые.</p>

            <div className={s.option}>
              <div className={s.optionHead}>
                <b>1. Перенести ключ с другого своего устройства</b>
                {badge("device")}
              </div>
              <p>Пароль не нужен, занимает минуту.</p>
              {withKey.length > 0 && (
                <p>
                  Ключ есть здесь: <DeviceNames devices={withKey} />. Откройте Quazar на одном из
                  этих устройств.
                </p>
              )}
              {unknown.length > 0 && (
                <p>
                  {withKey.length > 0 ? "Может быть ключ и здесь" : "Возможно, ключ есть здесь"}:{" "}
                  <DeviceNames devices={unknown} /> — там старая версия Quazar, проверьте, читаются ли
                  личные сообщения.
                </p>
              )}
              {withoutKey.length > 0 && (
                <p className={s.muted}>
                  Ключа нет здесь: <DeviceNames devices={withoutKey} /> — оттуда передать не получится.
                </p>
              )}
              {others && withKey.length + unknown.length === 0 && (
                <p>
                  {others.length === 0
                    ? "В списке сеансов других устройств нет."
                    : "Ни на одном другом устройстве, где вы сейчас вошли, ключа нет."}{" "}
                  Если раньше вы читали переписку в другом браузере, на компьютере или телефоне,
                  откройте Quazar там (при необходимости войдите снова: при выходе ключ обычно
                  остаётся на устройстве).
                </p>
              )}
              <ol>
                <li>Здесь нажмите «Получить ключи с другого устройства» — появятся QR-код и короткий код.</li>
                <li>
                  На том устройстве появится запрос — нажмите «Передать ключи». Не появился: в браузере
                  и приложении для компьютера — «Настройки → Безопасность → Подключить по QR или
                  коду», на телефоне — «Профиль → Ключи шифрования». Введите код или отсканируйте QR.
                </li>
                <li>Сверьте код сравнения на обоих экранах и подтвердите. Через несколько секунд переписка откроется здесь.</li>
              </ol>
            </div>

            <div className={s.option}>
              <div className={s.optionHead}>
                <b>2. Восстановить из резервной копии</b>
                {badge("backup")}
              </div>
              {hasServerBackup ? (
                <>
                  <p>
                    На сервере есть ваша резервная копия ключа. Она зашифрована паролем, который вы
                    придумали сами, когда её сохраняли. Это <b>не пароль от аккаунта</b> и не код из
                    СМС или звонка.
                  </p>
                  <ol>
                    <li>В окне восстановления введите пароль копии.</li>
                    <li>Нажмите «Восстановить».</li>
                  </ol>
                  <p>
                    Не помните пароль — восстановить его нельзя, его не знаем даже мы. Тогда
                    перенесите ключ с другого устройства (способ 1), а там сохраните новую копию с
                    новым паролем.
                  </p>
                </>
              ) : (
                <p>
                  Копии на сервере нет. Если вы скачивали файл копии (<code>.quazar-key</code>) —
                  восстановите ключ из файла: введите пароль копии и нажмите «Из файла».
                </p>
              )}
            </div>

            <div className={s.option}>
              <div className={s.optionHead}>
                <b>3. Если ключа нет нигде — создать новые ключи</b>
              </div>
              <p>Это крайний случай. Перед ним убедитесь, что ни на одном устройстве переписка не читается.</p>
              <ul>
                <li>старая переписка здесь не откроется — на устройствах, где был прежний ключ, она останется читаемой;</li>
                <li>новые сообщения будут шифроваться новым ключом;</li>
                <li>собеседники увидят, что ваш ключ сменился;</li>
                <li>на остальных устройствах ключ придётся получить заново.</li>
              </ul>
              <p>Понадобится пароль от аккаунта или подтверждение входа.</p>
            </div>

            {onRestore && (
              <button type="button" className={s.primary} onClick={onRestore}>
                Открыть восстановление ключей
              </button>
            )}
          </section>

          <section className={s.block}>
            <h4 className={s.title}>Почему ключа здесь нет</h4>
            {hasLocalKey ? (
              <p className={s.note}>
                Похоже, ключ аккаунта сменили на другом устройстве («Создать новые ключи»). Прежний
                ключ на этом устройстве остался — старая переписка им по-прежнему откроется, а для
                новой нужен новый ключ.
              </p>
            ) : (
              <ul>
                <li>вы впервые вошли с этого устройства, браузера или приложения;</li>
                <li>данные браузера очистили, или открыто приватное окно (инкогнито) — оно всё стирает при закрытии;</li>
                <li>приложение переустановили;</li>
                <li>ключ аккаунта сменили на другом устройстве.</li>
              </ul>
            )}
          </section>
        </>
      ) : status === "ready" ? (
        <section className={s.block}>
          <h4 className={s.title}>На этом устройстве ключ есть</h4>
          <p>
            Личные сообщения здесь читаются.{" "}
            {hasServerBackup
              ? "Резервная копия на сервере сохранена."
              : "Резервной копии пока нет — если потеряете все устройства, переписку будет не вернуть."}
          </p>
          <p>
            С этого устройства можно передать ключ другому своему: когда там попросят ключи, здесь
            появится запрос «Передать ключи».
          </p>
        </section>
      ) : null}

      <section className={s.block}>
        <h4 className={s.title}>Как не остаться без ключа</h4>
        <ul>
          <li>
            Сохраните резервную копию: «Настройки → Безопасность», придумайте отдельный пароль и
            нажмите «Сохранить и скачать». Пароль запишите в надёжное место, например в менеджер
            паролей.
          </li>
          <li>Держите Quazar хотя бы на двух устройствах — тогда ключ всегда есть откуда перенести.</li>
          <li>Не ведите переписку в приватном окне браузера: ключ исчезнет, когда окно закроется.</li>
          <li>
            На чужом компьютере при выходе отметьте «Удалить ключи шифрования и черновики с этого
            устройства» — при обычном выходе ключ остаётся на устройстве.
          </li>
        </ul>
      </section>

      <section className={s.block}>
        <h4 className={s.title}>Почему поддержка не может восстановить ключ</h4>
        <p>
          У нас нет ни вашего ключа, ни пароля резервной копии — поэтому вашу переписку не может
          прочитать никто, кроме вас и собеседника. Обратная сторона: вернуть ключ за вас мы тоже
          не можем.
        </p>
      </section>
    </div>
  );
}
