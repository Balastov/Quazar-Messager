# Quazar для iOS

Обёртка над веб-версией на Capacitor — как приложение для Android (`../android`): открывает
`https://quazar-msg.ru` внутри себя (без адресной строки, со своим значком и разрешениями на камеру и
микрофон). Интерфейс приходит с сервера, поэтому каждая выкладка веба сразу видна в приложении. Нет
связи — показывается `www/offline.html`. Нативный проект — `native/App` (Xcode, зависимости через Swift
Package Manager, CocoaPods не нужен).

Пока это **заготовка для локальной пробы и TestFlight**: уведомлений (APNs) и звонков на весь экран
(CallKit + PushKit) ещё нет — их подключим, когда будет аккаунт Apple Developer. Веб-часть знает, что
открыта в приложении (`web/src/platform/ios.ts`): не предлагает скачать мобильное приложение и честно
пишет в настройках уведомлений, что они пока не приходят.

## Что настроено

- Bundle ID `ru.quazarmsg.app`, название «Quazar», язык — русский, версия `2.6.0` (сборка `20600`,
  `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` в `App.xcodeproj` — меняются вместе с `package.json`).
- Иконка 1024×1024 без прозрачности (из `web/public/icons/icon-maskable-512.png`), тёмный экран
  загрузки с логотипом, тёмное оформление (`UIUserInterfaceStyle = Dark`) — светлая строка состояния.
- Камера и микрофон: пояснения в `Info.plist`; доступ странице Capacitor выдаёт сам, человек видит
  только системный вопрос iOS один раз. Видео играет прямо на странице (`allowsInlineMediaPlayback`).
- iOS 15+, только arm64.

## Сборка у себя

Нужен Xcode (и для симулятора — среда iOS: `xcodebuild -downloadPlatform iOS`, ~8 ГБ).

```sh
npm ci
npx cap sync ios
npx cap open ios          # Xcode: выбрать симулятор или свой iPhone и нажать ▶
```

Без Xcode-окна — симулятор:

```sh
xcodebuild -project native/App/App.xcodeproj -scheme App -sdk iphonesimulator \
  -configuration Debug -derivedDataPath build CODE_SIGNING_ALLOWED=NO build
xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/App.app
xcrun simctl launch booted ru.quazarmsg.app
```

**На своём iPhone без платного аккаунта:** в Xcode → таргет App → Signing & Capabilities → Team —
свой Apple ID (Personal Team); на телефоне — Настройки → Основные → VPN и управление устройством →
доверять разработчику. Такая подпись живёт 7 дней, потом приложение нужно поставить из Xcode заново.
Bundle ID `ru.quazarmsg.app` может быть занят для Personal Team — тогда временно поменять его в Xcode
(например, на `ru.quazarmsg.app.dev`), не коммитя.

## Дальше (с аккаунтом Apple Developer)

1. Карточка приложения в App Store Connect, политика конфиденциальности на сайте.
2. Уведомления через APNs (тот же сервер, что и FCM для Android) и звонки через CallKit + PushKit:
   системный экран звонка iPhone, в том числе на заблокированном телефоне.
3. Сборка и загрузка в TestFlight из GitHub Actions (ключ App Store Connect API в секретах); сборка
   живёт 90 дней — выкладывать новую хотя бы раз в квартал.
