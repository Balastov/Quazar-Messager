// Интеграционный тест Electron на CI: временный профиль, скрытое окно, API без реальных пользователей.
const { app, BrowserWindow, session, protocol, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { APP_URL, SERVER_ORIGIN } = require('../src/policy.cjs');
const { createProtocolHandler } = require('../src/protocol.cjs');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'quazar-smoke-'));
app.setPath('userData', profile);
protocol.registerSchemesAsPrivileged([{ scheme: 'quazar-app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
const timeout = setTimeout(() => { console.error('Desktop smoke timed out'); app.exit(1); }, 40_000);
app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:smoke');
  let requests = 0;
  ses.protocol.handle('quazar-app', createProtocolHandler(path.resolve(__dirname, '../renderer'), async url => {
    assert.ok(url.startsWith(SERVER_ORIGIN + '/api/'));
    requests++;
    return new Response(JSON.stringify({ yandex: false, phone_verification: true }), { headers: { 'Content-Type': 'application/json' } });
  }));
  ipcMain.handle('desktop:update-state', () => ({ status: 'disabled', currentVersion: '0.19.2', manual: false }));
  ipcMain.handle('desktop:auth-return', () => null);
  const win = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false,
    preload: path.resolve(__dirname, '../src/preload.cjs'), additionalArguments: ['--quazar-version=0.19.2', '--quazar-server=' + SERVER_ORIGIN] } });
  await win.loadURL(APP_URL + '/auth');
  const state = await win.webContents.executeJavaScript(`(async () => {
    for (let i = 0; i < 100 && !document.body.textContent.includes('Создать аккаунт'); i++) await new Promise(resolve => setTimeout(resolve, 50));
    const response = await fetch('/api/auth/providers');
    return { title: document.body.textContent, secure: window.isSecureContext, crypto: !!crypto.subtle,
      storage: typeof indexedDB, bridge: typeof window.quazarDesktop?.updateState,
      node: typeof window.require, api: await response.json() };
  })()`);
  assert.match(state.title, /Создать аккаунт/);
  assert.equal(state.secure, true);
  assert.equal(state.crypto, true);
  assert.equal(state.storage, 'object');
  assert.equal(state.bridge, 'function');
  assert.equal(state.node, 'undefined');
  assert.equal(state.api.phone_verification, true);
  assert.ok(requests > 0);
  clearTimeout(timeout); win.destroy();
  console.log('DESKTOP_SMOKE_OK: shared renderer, secure crypto, IndexedDB, isolated preload and API proxy');
  app.quit();
}).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); });
