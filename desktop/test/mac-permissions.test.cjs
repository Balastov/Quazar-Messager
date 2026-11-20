const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// С Hardened Runtime macOS даёт камеру и микрофон только приложению с этими правами и с текстом,
// который покажет системный запрос доступа. Без права на камеру видео молча не работает.
const root = path.join(__dirname, '..');
const mac = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).build.mac;

test('the macOS app may use the camera and microphone and explains why', () => {
  assert.equal(mac.hardenedRuntime, true);
  for (const file of new Set([mac.entitlements, mac.entitlementsInherit])) {
    const plist = fs.readFileSync(path.join(root, file), 'utf8');
    for (const key of ['com.apple.security.device.camera', 'com.apple.security.device.audio-input']) {
      assert.match(plist, new RegExp(`<key>${key.replace(/\./g, '\\.')}</key>\\s*<true/>`), `${file}: ${key}`);
    }
  }
  assert.ok(mac.extendInfo.NSCameraUsageDescription);
  assert.ok(mac.extendInfo.NSMicrophoneUsageDescription);
});
