// Интеграционный тест Electron на CI: временный профиль, скрытое окно, API без реальных пользователей.
const { app, BrowserWindow, session, protocol, ipcMain, net } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { APP_URL, SERVER_ORIGIN, trustedMainFrame } = require('../src/policy.cjs');
const { createProtocolHandler } = require('../src/protocol.cjs');
const version = require('../package.json').version;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'quazar-smoke-'));
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
protocol.registerSchemesAsPrivileged([{ scheme: 'quazar-app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
const timeout = setTimeout(() => { console.error('Desktop smoke timed out'); app.exit(1); }, 40_000);
app.whenReady().then(async () => {
  const startupState = { phase: 'checking', currentVersion: version, canContinue: false };
  const splashFile = path.resolve(__dirname, '../src/startup.html');
  ipcMain.handle('startup:state', event => {
    const allowed = trustedMainFrame(event, splash.webContents, url => url === pathToFileURL(splashFile).href);
    assert.ok(allowed, JSON.stringify({ sender: event.sender === splash.webContents, frame: event.senderFrame === event.sender.mainFrame,
      url: event.senderFrame?.url, expected: pathToFileURL(splashFile).href }));
    return startupState;
  });
  const splash = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.resolve(__dirname, '../src/startup-preload.cjs') } });
  await splash.loadFile(splashFile);
  assert.equal(await splash.webContents.executeJavaScript("typeof window.quazarStartup.state"), 'function');
  assert.equal((await splash.webContents.executeJavaScript('window.quazarStartup.state()')).currentVersion, version);
  splash.webContents.send('startup:state-changed', { phase: 'error', currentVersion: version, version: '9.0.0', canContinue: false, message: 'Known update failed' });
  const blocked = await splash.webContents.executeJavaScript("new Promise(resolve => setTimeout(() => resolve(document.getElementById('continue').hidden), 100))");
  assert.equal(blocked, true);
  splash.webContents.send('startup:state-changed', { phase: 'error', currentVersion: version, canContinue: true, message: 'Offline' });
  const offline = await splash.webContents.executeJavaScript("new Promise(resolve => setTimeout(() => resolve(document.getElementById('continue').hidden), 100))");
  assert.equal(offline, false); splash.destroy();
  // Реальный сетевой транспорт Electron, но только локальный API с одноразовыми тестовыми данными.
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url === '/api/_smoke' ? {
      body, authorization: request.headers.authorization,
    } : { yandex: false, phone_verification: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const backend = `http://127.0.0.1:${server.address().port}`;
  const ses = session.fromPartition('persist:smoke');
  let requests = 0;
  ses.protocol.handle('quazar-app', createProtocolHandler(path.resolve(__dirname, '../renderer'), async (url, options) => {
    assert.ok(url.startsWith(SERVER_ORIGIN + '/api/'));
    requests++;
    return net.fetch(backend + new URL(url).pathname, options);
  }));
  ipcMain.handle('desktop:update-state', event => { assert.ok(trustedMainFrame(event, win.webContents)); return { status: 'disabled', currentVersion: version, manual: false }; });
  ipcMain.handle('desktop:auth-return', () => null);
  const win = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false,
    preload: path.resolve(__dirname, '../src/preload.cjs'), additionalArguments: ['--quazar-version=' + version, '--quazar-server=' + SERVER_ORIGIN] } });
  await win.loadURL(APP_URL + '/auth');
  assert.equal((await win.webContents.executeJavaScript('window.quazarDesktop.updateState()')).status, 'disabled');
  const state = await win.webContents.executeJavaScript(`(async () => {
    for (let i = 0; i < 100 && !document.body.textContent.includes('Создать аккаунт'); i++) await new Promise(resolve => setTimeout(resolve, 50));
    const response = await fetch('/api/auth/providers');
    const posted = await fetch('/api/_smoke', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer smoke-only' }, body: JSON.stringify({ text: 'Привет' }) });
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('quazar-smoke', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('keys');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('keys', 'readwrite');
      transaction.objectStore('keys').put(key, 'identity');
      transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
    });
    db.close();
    localStorage.setItem('quazar-smoke-profile', 'retained');
    return { title: document.body.textContent, secure: window.isSecureContext, crypto: !!crypto.subtle,
      storage: typeof indexedDB, bridge: typeof window.quazarDesktop?.updateState,
      node: typeof window.require, api: await response.json(), posted: await posted.json() };
  })()`);
  assert.match(state.title, /Создать аккаунт/);
  assert.doesNotMatch(state.title, /Скачать десктоп версию/);
  assert.equal(state.secure, true);
  assert.equal(state.crypto, true);
  assert.equal(state.storage, 'object');
  assert.equal(state.bridge, 'function');
  assert.equal(state.node, 'undefined');
  assert.equal(state.api.phone_verification, true);
  assert.equal(state.posted.authorization, 'Bearer smoke-only');
  assert.deepEqual(JSON.parse(state.posted.body), { text: 'Привет' });
  assert.ok(requests > 0);
  const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  win.webContents.reload(); await loaded;
  const persisted = await win.webContents.executeJavaScript(`(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('quazar-smoke', 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const key = await new Promise((resolve, reject) => {
      const request = db.transaction('keys').objectStore('keys').get('identity');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    db.close();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('retained key'));
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
    return { profile: localStorage.getItem('quazar-smoke-profile'), keyWorks: new TextDecoder().decode(decrypted) === 'retained key', extractable: key.extractable };
  })()`);
  assert.equal(persisted.profile, 'retained');
  assert.equal(persisted.keyWorks, true);
  assert.equal(persisted.extractable, false);
  server.close();
  clearTimeout(timeout); win.destroy();
  console.log('DESKTOP_SMOKE_OK: shared renderer, isolated preload, native GET/POST, persistent non-extractable crypto key');
  app.quit();
}).catch(error => {
  console.error(error);
  console.error('::error title=Desktop runtime check::' + String(error.stack ?? error).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A'));
  clearTimeout(timeout); app.exit(1);
});
