# Quazar для Android

Обёртка над веб-версией на Capacitor: приложение открывает `https://quazar-msg.ru` внутри себя (без
адресной строки, со своим значком и разрешениями на микрофон и камеру). Интерфейс приходит с сервера,
поэтому каждая выкладка веба сразу видна в приложении. Нет связи — показывается `www/offline.html`.

Сама обёртка обновляется APK-файлом, без магазина:

1. Веб-часть (`web/src/components/AndroidUpdates.tsx`) раз в 6 часов и при возвращении в приложение
   читает `/desktop-updates/android/latest.json` — `{version, versionCode, url, sha256}`.
2. Есть версия новее — баннер «Доступна версия … для Android». Если Quazar ещё не разрешено ставить
   приложения, кнопка «Разрешить установку» открывает системные настройки (один раз).
3. «Обновить» — нативный модуль `UpdaterPlugin` качает APK только с того же сервера, сверяет SHA-256,
   имя пакета, версию и **подпись** (тот же ключ), затем открывает системное окно «Обновить?».

Код версии: `1.3.0` → `10300` (`app/build.gradle`, из `package.json`). Он больше, чем у прежней
нативной сборки 0.12.1 (1201), — обёртка встаёт поверх неё.

## Сборка у себя

Нужны JDK 21 и Android SDK 36 (`platforms;android-36`, `build-tools;36.0.0`).

```sh
npm ci
export JAVA_HOME=/opt/homebrew/opt/openjdk@21
npm run build:debug      # app/build/outputs/apk/debug — отладочный ключ, ставится только на чистое устройство
npm run build:release    # подпись ключом из ~/.gradle/gradle.properties (QUAZAR_UPLOAD_*)
```

Отладочная сборка разрешает `http`, чтобы открыть свой сервер из эмулятора (`10.0.2.2`). Адрес задаётся
в `native/app/src/main/assets/capacitor.config.json` после `npx cap sync` (файл не в git).

## Подпись

Обновление встаёт поверх установленного приложения, только если подписано **тем же ключом**.
Ключ — `~/.android-keys/quazar-release.keystore` (alias `quazar`). Потеряете ключ — всем придётся
удалить приложение и поставить заново. Отпечаток сертификата — в `signing-certificate.sha256`;
CI сверяет с ним каждую сборку.

В CI ключ берётся из секретов репозитория (Settings → Secrets and variables → Actions):

| Секрет | Что положить |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -i ~/.android-keys/quazar-release.keystore` |
| `ANDROID_KEYSTORE_PASSWORD` | `QUAZAR_UPLOAD_STORE_PASSWORD` из `~/.gradle/gradle.properties` |
| `ANDROID_KEY_ALIAS` | `quazar` |
| `ANDROID_KEY_PASSWORD` | `QUAZAR_UPLOAD_KEY_PASSWORD` |

Без секретов CI собирает неподписанную проверочную сборку и APK не выкладывает.

## Выпуск

Вместе с ПК-версией (`docs` → порядок выпуска): версия в `android/package.json` = версии `web` и
`desktop`; в `.github/desktop-release.json` — `"android": true`. Тогда выпуск требует артефакт
`quazar-desktop-android`, прикладывает APK к выпуску на GitHub и публикует
`/desktop-updates/android/Quazar-<версия>-android.apk` и `latest.json` тем же скриптом, что и файлы
обновлений ПК. После публикации — `ANDROID_RELEASE` в `web/src/platform/desktopDownloads.ts`:
сайт начнёт предлагать APK на Android вместо «почти готово».

## Пока не сделано

- Push-уведомления при закрытом приложении (нужен проект Firebase).
- Показ своего экрана — встроенный браузер Android этого не умеет (смотреть чужие показы можно).
- Вход через Яндекс (уводит в браузер).
- Звонок при погашенном экране без службы переднего плана — проверить на реальных телефонах.
