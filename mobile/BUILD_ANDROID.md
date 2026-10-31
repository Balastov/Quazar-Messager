# Сборка Android

Приложение `ru.quazarmsg.app`. Релизная сборка ходит на `https://quazar-msg.ru`, отладочная — на
бэкенд этого компьютера (`src/api/client.ts`).

## Один раз: инструменты

```sh
brew install openjdk@17
brew install --cask android-commandlinetools
SDK=~/Library/Android/sdk
sdkmanager --sdk_root=$SDK "platform-tools" "platforms;android-35" "build-tools;35.0.0" \
  "ndk;26.1.10909125" "cmake;3.22.1"
echo "sdk.dir=$SDK" > android/local.properties
```

В `~/.zshrc`:

```sh
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
export ANDROID_HOME=$HOME/Library/Android/sdk
export PATH=$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH
```

## Ключ подписи

Релизные сборки подписываются ключом `~/.android-keys/quazar-release.keystore`; пароль и путь —
в `~/.gradle/gradle.properties` (`QUAZAR_UPLOAD_STORE_FILE`, `QUAZAR_UPLOAD_KEY_ALIAS`,
`QUAZAR_UPLOAD_STORE_PASSWORD`, `QUAZAR_UPLOAD_KEY_PASSWORD`). В репозитории ключа нет.

**Храните копию ключа и пароля в надёжном месте.** Без них нельзя выпустить обновление: Android
примет новую версию, только если она подписана тем же ключом.

Без этих свойств релизная сборка остановится с ошибкой (отладочная собирается и так).

## Сборка

```sh
npm install
npm run build:apk   # android/app/build/outputs/apk/release/app-release.apk — ставить на телефон
npm run build:aab   # android/app/build/outputs/bundle/release/app-release.aab — для RuStore / Google Play
```

Перед выпуском поднимите `versionCode` (целое, всегда растёт) и `versionName` в
`android/app/build.gradle`.

## Отладка

`npm start` (Metro) и `npm run android` — на эмуляторе или телефоне с отладкой по USB. Для телефона
впишите IP компьютера в `DEV_HOST` (`src/api/client.ts`).

## Заметки

- Новая архитектура React Native выключена (`newArchEnabled=false`): с ней не дружит react-native-webrtc.
- react-native-screens закреплён на 4.4.0 — более новые требуют React Native 0.79+.
- Шифрование — чистый JS (@noble), случайные байты — системный генератор через
  react-native-get-random-values (подключается первым в `index.js`). react-native-libsodium убран:
  его нативная часть не собирается с RN 0.76.
