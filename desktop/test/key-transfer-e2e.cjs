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
// Число на новом устройстве и такое же — нажатием на старом (там три числа на выбор).
async function shownNumber(win) {
  return until(async () => {
    const value = await js(win, "document.querySelector('[aria-label=\"Число для подтверждения\"]')?.textContent");
    return /^\d{2}$/.test(value ?? '') ? value : false;
  }, 'number on the new device');
}
async function choices(win) {
  return until(async () => {
    const values = await js(win, "[...document.querySelectorAll('[aria-label=\"Число с нового устройства\"] button')].map(el => el.textContent)");
    return values.length === 3 ? values : false;
  }, 'three numbers on the old device');
}
async function confirmAndPass(source, target, { wrongFirst = false } = {}) {
  await until(async () => (await text(source)).includes('Это вы входите?'), 'question on the source');
  await click(source, 'Да, это я');
  let number = await shownNumber(target);
  if (wrongFirst) {
    // Неверное число отменяет запрос; новое устройство предлагает отправить его снова.
    await click(source, (await choices(source)).find(value => value !== number));
    await until(async () => (await text(source)).includes('Число не совпало'), 'mismatch on the source');
    await click(source, 'Понятно');
    await until(async () => (await text(target)).includes('Запрос отменён на другом устройстве'), 'mismatch on the target');
    await click(target, 'Отправить запрос снова');
    await until(async () => (await text(source)).includes('Это вы входите?'), 'question again');
    await click(source, 'Да, это я');
    number = await shownNumber(target);
  }
  assert.ok((await choices(source)).includes(number));
  await click(source, number);
  await until(async () => (await text(source)).includes('переписка откроется через пару секунд'), 'source confirms transfer');
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

  // 1. Второй вход без ключа: запрос уходит сам, на старом устройстве — «Это вы входите?» и число.
  const desktop = await make('desktop', bootstrap.extra_tokens[0]);
  await until(async () => (await text(desktop)).includes('Откройте переписку на этом устройстве'), 'restore dialog');
  await confirmAndPass(source, desktop);
  const received = await until(() => proof(desktop), 'desktop key import');
  assert.equal(received.seed, original.seed);
  assert.equal(received.token, bootstrap.extra_tokens[0]);
  await until(async () => !(await text(desktop)).includes('Откройте переписку на этом устройстве'), 'restore dialog closes');
  console.log('KEY_E2E_PROMPT_OK: signed-in device got the account key by tapping the matching number');

  // 2. Цепочкой с только что подключённого устройства; сначала — неверное число.
  const laptop = await make('laptop', bootstrap.extra_tokens[1]);
  await until(async () => (await text(laptop)).includes('Откройте переписку на этом устройстве'), 'second restore dialog');
  await confirmAndPass(desktop, laptop, { wrongFirst: true });
  const chained = await until(() => proof(laptop), 'laptop key import');
  assert.equal(chained.seed, original.seed);
  assert.equal(chained.token, bootstrap.extra_tokens[1]);
  console.log('KEY_E2E_CHAIN_OK: a wrong number cancels, the retry passes the key on');

  // 3. Сервер знает, где ключ: все устройства сообщили, что он у них есть.
  const devices = `fetch('/api/auth/devices',{headers:{Authorization:'Bearer '+JSON.parse(localStorage.getItem('quazar-auth')).state.token}}).then(r=>r.json())`;
  await until(async () => { const rows = await js(source, devices); return rows.length >= 3 && rows.every(row => row.has_account_key === true); }, 'devices report the account key');
  console.log('KEY_E2E_REPORT_OK: every signed-in device reported the account key');

  // 4. Выход с чужого компьютера: ключ и сеанс стираются, на остальных устройствах ключ остаётся.
  await click(laptop, 'Настройки');
  await until(() => js(laptop, `(() => { const el=[...document.querySelectorAll('[data-settings-section="account"]')].find(n=>n.getClientRects().length); el?.click(); return !!el; })()`), 'account settings');
  await click(laptop, 'Выйти');
  await until(() => js(laptop, "(() => { const box=document.querySelector('[role=dialog] input[type=checkbox]'); if (!box) return false; box.click(); return box.checked; })()"), 'wipe checkbox');
  await click(laptop, 'Удалить ключи и выйти');
  await until(() => js(laptop, "!JSON.parse(localStorage.getItem('quazar-auth') || 'null')?.state?.token"), 'laptop signed out');
  const identity = await js(laptop, `new Promise((resolve,reject) => { const r=indexedDB.open('quazar-crypto'); r.onerror=()=>reject(r.error); r.onsuccess=()=>{ const db=r.result; const q=db.transaction('keys').objectStore('keys').get('identity'); q.onsuccess=()=>{ db.close(); resolve(q.result ? 'present' : 'gone'); }; }; })`);
  assert.equal(identity, 'gone');
  assert.equal((await proof(source)).seed, original.seed);
  console.log('KEY_E2E_FORGET_OK: signing out with wipe removed the key from that device only');
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
