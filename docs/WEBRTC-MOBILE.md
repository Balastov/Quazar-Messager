# Звонки в React Native (часть 4)

В `mobile/` добавлены **аудио- и видеозвонки 1:1** по тому же WS/WebRTC протоколу, что и web.

## Что в коде

| Файл | Назначение |
|------|------------|
| `src/calls/peer.ts` | `react-native-webrtc` peer |
| `src/store/call.ts` | сигналинг, mute/camera/flip |
| `src/components/CallOverlay.tsx` | полноэкранный UI звонка |
| `src/screens/ChatScreen.tsx` | кнопки 📞 / 🎥 в шапке |
| `src/calls/permissions.ts` | Android runtime permissions |

Сигналинг и ICE (`/api/calls/ice-servers`) — те же, что для web (TURN/VAPID уже на сервере).

## Зависимость

```bash
cd mobile
npm install
# или: npm install react-native-webrtc@^124.0.6
```

В репозитории **нет** папок `android/` / `ios/` — их нужно сгенерировать/подтянуть отдельно (`npx @react-native-community/cli init` / существующий native shell), затем:

```bash
cd ios && pod install && cd ..
```

## Права

### Android — `AndroidManifest.xml`

```xml
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
<uses-permission android:name="android.permission.CHANGE_NETWORK_STATE" />
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
<uses-permission android:name="android.permission.INTERNET" />
```

Подробнее: [Android install](https://github.com/react-native-webrtc/react-native-webrtc/blob/master/Documentation/AndroidInstallation.md)

### iOS — `Info.plist`

```xml
<key>NSCameraUsageDescription</key>
<string>Quazar нужен доступ к камере для видеозвонков</string>
<key>NSMicrophoneUsageDescription</key>
<string>Quazar нужен доступ к микрофону для звонков</string>
```

Подробнее: [iOS install](https://github.com/react-native-webrtc/react-native-webrtc/blob/master/Documentation/iOSInstallation.md)

Готовые сниппеты также в `mobile/native-setup/`.

## API URL

В `src/api/client.ts` сейчас эмулятор (`10.0.2.2`). Для реального устройства / продакшена укажите:

```ts
export const API_BASE_URL = 'https://quazar-msg.ru/api';
export const WS_BASE_URL = 'wss://quazar-msg.ru';
```

(или ваш локальный IP в LAN).

## Проверка

1. Два аккаунта: web ↔ mobile или mobile ↔ mobile  
2. В чате 📞 / 🎥 → принять  
3. Mic / Cam / Flip на видеозвонке  

**Push (FCM/APNs)** для входящего при убитом процессе — следующий этап (часть 5 polish); сейчас входящий работает, пока приложение открыто / в фоне с живым WS.

## Часть 5 (позже)

- FCM/APNs + CallKit / ConnectionService  
- Видео polish, speaker routing (`InCallManager`)  
- Background audio
