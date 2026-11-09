// Устройство уже вошло в аккаунт, но без ключа переписки: ключ переносится с другого устройства без выхода.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const base = process.env.PAIR_TEST_URL;
const bootstrap = JSON.parse(fs.readFileSync(process.env.PAIR_TEST_BOOTSTRAP, 'utf8'));
app.setName('Quazar Key Transfer Test');
fs.mkdirSync(process.env.PAIR_TEST_PROFILE, { recursive: true });
app.setPath('userData', process.env.PAIR_TEST_PROFILE);
app.on('window-all-closed', () => {});
const windows = [];
const timeout = setTimeout(() => { console.error('Key transfer browser test timed out'); app.exit(1); }, 120_000);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let step = 'start';
async function until(work, title, ms = 20_000) {
  step = title;
  const started = Date.now();
  while (Date.now() - started < ms) {
    try { const value = await work(); if (value) return value; } catch { /* wait for render/network */ }
    await wait(100);
  }
  throw new Error('Timed out: ' + title);
}
async function make(name, token) {
  const ses = session.fromPartition('persist:key-test-' + name);
  ses.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
  ses.webRequest.onBeforeRequest((details, reply) => {
    try { const url = new URL(details.url), local = new URL(base); reply({ cancel: !['data:', 'blob:'].includes(url.protocol) && !(url.hostname === local.hostname && url.port === local.port) }); }
    catch { reply({ cancel: true }); }
  });
  const win = new BrowserWindow({ show: false, width: 1280, height: 900,
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36');
  windows.push(win);
  await win.loadURL(base + '/auth');
  await win.webContents.executeJavaScript(`localStorage.setItem('quazar-auth', JSON.stringify({state:${JSON.stringify({ token, user: bootstrap.user })},version:0}))`);
  await win.webContents.reload();
  return win;
}
const js = (win, code) => win.webContents.executeJavaScript(code);
const text = win => js(win, 'document.body.innerText');
async function click(win, label) {
  await until(() => js(win, `(() => {
    const el = [...document.querySelectorAll('button')].find(node => node.textContent.trim() === ${JSON.stringify(label)} && node.getClientRects().length && !node.disabled);
    if (!el) return false; el.scrollIntoView({block:'center'}); el.click(); return true;
  })()`), 'button ' + label);
}
async function code(win) {
  return until(async () => {
    const value = await js(win, "document.querySelector('[aria-label=\"Код сравнения\"]')?.textContent?.replace(/\\s/g,'')");
    return /^[A-F0-9]{16}$/.test(value ?? '') ? value : false;
  }, 'comparison code');
}
async function confirmAndPass(source, target) {
  assert.equal(await code(source), await code(target));
  await js(source, "(() => { const label=[...document.querySelectorAll('label')].find(el=>el.textContent.includes('Код на обоих устройствах совпадает'));label.querySelector('input').click(); })()");
  await click(source, 'Передать ключи');
  await until(async () => (await text(source)).includes('Ключи переданы'), 'source confirms transfer');
}
// Ключ в IndexedDB этого браузера, совпадающий с ключом аккаунта на сервере, и хэш токена (сессия не менялась).
async function proof(win) {
  return js(win, `(async () => {
    const auth = JSON.parse(localStorage.getItem('quazar-auth') || 'null')?.state;
    if (!auth?.token || !auth.user) return null;
    const db = await new Promise((resolve,reject) => { const r=indexedDB.open('quazar-crypto'); r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error); });
    if (!db.objectStoreNames.contains('keys')) { db.close(); return null; }
    const key = await new Promise((resolve,reject)=>{const r=db.transaction('keys').objectStore('keys').get('identity');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});db.close();
    if (!key?.seed || key.accountId !== auth.user.id) return null;
    const server=await fetch('/api/users/'+auth.user.id+'/key',{headers:{Authorization:'Bearer '+auth.token}}).then(r=>r.json());
    if (server.public_key !== key.publicKeyB64) return null;
    const hex=buffer=>[...new Uint8Array(buffer)].map(x=>x.toString(16).padStart(2,'0')).join('');
    return { seed:hex(await crypto.subtle.digest('SHA-256',key.seed)), token:auth.token };
  })()`);
}

app.whenReady().then(async () => {
  const source = await make('source', bootstrap.token);
  const original = await until(() => proof(source), 'initial account key');

  // 1. Второй вход без ключа: окно восстановления, запрос с другого устройства, всплывающее предложение.
  const desktop = await make('desktop', bootstrap.extra_tokens[0]);
  await until(async () => (await text(desktop)).includes('Восстановите ключи шифрования'), 'restore dialog');
  await click(desktop, 'Получить ключи с другого устройства');
  await until(() => js(desktop, "/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(document.querySelector('[aria-label=\"Одноразовый код\"]')?.textContent ?? '')"), 'one-time code');
  await until(async () => (await text(source)).includes('просит ключи шифрования'), 'key request banner on the source');
  await click(source, 'Передать ключи');
  await confirmAndPass(source, desktop);
  const received = await until(() => proof(desktop), 'desktop key import');
  assert.equal(received.seed, original.seed);
  assert.equal(received.token, bootstrap.extra_tokens[0]);
  await until(async () => !(await text(desktop)).includes('Восстановите ключи шифрования'), 'restore dialog closes');
  console.log('KEY_E2E_PROMPT_OK: signed-in device got the account key without signing out');
  await js(source, "document.querySelector('[role=dialog] [aria-label=\"Закрыть\"]')?.click()");

  // 2. Тот же перенос по одноразовому коду из настроек — без всплывающего предложения.
  const laptop = await make('laptop', bootstrap.extra_tokens[1]);
  await until(async () => (await text(laptop)).includes('Восстановите ключи шифрования'), 'second restore dialog');
  await click(laptop, 'Получить ключи с другого устройства');
  const short = await until(() => js(laptop, "document.querySelector('[aria-label=\"Одноразовый код\"]')?.textContent"), 'second one-time code');
  await until(async () => (await text(desktop)).includes('просит ключи шифрования'), 'banner reaches the newly keyed device');
  await click(desktop, 'Настройки');
  await until(() => js(desktop, "!!document.querySelector('section[aria-label=\"Устройства\"]')"), 'device settings');
  await click(desktop, 'Подключить по QR или коду');
  await js(desktop, `(() => { const input=document.querySelector('[role=dialog] [aria-label="Одноразовый код"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(short)});input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await click(desktop, 'Продолжить');
  await confirmAndPass(desktop, laptop);
  const chained = await until(() => proof(laptop), 'laptop key import');
  assert.equal(chained.seed, original.seed);
  assert.equal(chained.token, bootstrap.extra_tokens[1]);
  console.log('KEY_E2E_CODE_OK: key passed on by one-time code from settings');
  clearTimeout(timeout); windows.forEach(win => win.destroy()); app.quit();
}).catch(async error => {
  const pages = [];
  for (const [index, win] of windows.entries()) {
    try { pages.push(`window ${index}: ${(await text(win)).replace(/\s+/g, ' ').slice(0, 600)}`); } catch {}
    try { fs.writeFileSync(path.join(process.env.PAIR_TEST_PROFILE, `failure-${index}.png`), (await win.webContents.capturePage()).toPNG()); } catch {}
  }
  console.error(`::error title=Key transfer e2e (${step})::${String(error.message ?? error)} | ${pages.join(' | ')}`);
  console.error(String(error.stack ?? error));
  clearTimeout(timeout); app.exit(1);
});
