# Ссылка `quazar://` — возврат после входа через Яндекс ID

Сервер возвращает человека из Яндекса по адресу `quazar://auth/yandex#code=…`
(`backend/app/api/oauth.py`). Приложение должно открываться по этой схеме. В Android это уже сделано
(`mobile/android/app/src/main/AndroidManifest.xml`); папки `ios/` в репозитории пока нет — после
её создания добавьте в неё то, что описано ниже для iOS.

Код из ссылки сам по себе бесполезен: обменять его на сессию можно только с секретом, который
приложение создало перед входом (`src/auth/yandex.ts`). Поэтому чужое приложение, перехватившее
ссылку `quazar://`, войти не сможет.

## Android — `android/app/src/main/AndroidManifest.xml` (сделано)

Внутри `<activity android:name=".MainActivity" …>` (у неё уже должно быть
`android:launchMode="singleTask"`, иначе ссылка откроет второе окно приложения):

```xml
<intent-filter>
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="quazar" android:host="auth" />
</intent-filter>
```

## iOS — `ios/QuazarMobile/Info.plist`

```xml
<key>CFBundleURLTypes</key>
<array>
    <dict>
        <key>CFBundleURLName</key>
        <string>ru.quazar-msg.auth</string>
        <key>CFBundleURLSchemes</key>
        <array>
            <string>quazar</string>
        </array>
    </dict>
</array>
```

## iOS — `ios/QuazarMobile/AppDelegate.mm`

Чтобы `Linking` в JS получал ссылку:

```objc
#import <React/RCTLinkingManager.h>

- (BOOL)application:(UIApplication *)application
            openURL:(NSURL *)url
            options:(NSDictionary<UIApplicationOpenURLOptionsKey, id> *)options
{
  return [RCTLinkingManager application:application openURL:url options:options];
}
```

## Проверка

- Android: `adb shell am start -W -a android.intent.action.VIEW -d "quazar://auth/yandex#error=denied" ru.quazarmsg.app`
  — на экране входа появится «Вход через Яндекс отменён».
- iOS: `xcrun simctl openurl booted "quazar://auth/yandex#error=denied"`.
- Сервер: в окружении нужны `YANDEX_CLIENT_ID`, `YANDEX_CLIENT_SECRET`; адрес `API_BASE_URL`
  в `src/api/client.ts` должен вести на тот же сервер, что указан у Яндекса как адрес возврата
  (`{PUBLIC_URL}/api/auth/yandex/callback`). С эмулятором и `http://10.0.2.2:8000` вход пройдёт,
  только если у приложения Яндекса указан адрес возврата этого же сервера — проще проверять на
  сборке, смотрящей на https://quazar-msg.ru/api.
