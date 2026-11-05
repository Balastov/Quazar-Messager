// Four isolated Chromium profiles, the real renderer/API, no real user accounts or external network.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const jsQR = require('../../web/node_modules/jsqr');
const base = process.env.PAIR_TEST_URL;
const bootstrap = JSON.parse(fs.readFileSync(process.env.PAIR_TEST_BOOTSTRAP, 'utf8'));
app.setName('Quazar Device Test');
fs.mkdirSync(process.env.PAIR_TEST_PROFILE, { recursive: true });
app.setPath('userData', process.env.PAIR_TEST_PROFILE);
app.on('window-all-closed', () => {});
const windows = [];
const timeout = setTimeout(() => { console.error('Device pairing browser test timed out'); app.exit(1); }, 120_000);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(work, title, ms = 20_000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    try { const value = await work(); if (value) return value; } catch { /* wait for render/network */ }
    await wait(100);
  }
  throw new Error('Timed out: ' + title);
}
async function make(name, phone = false) {
  const ses = session.fromPartition('persist:pair-test-' + name);
  ses.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
  ses.webRequest.onBeforeRequest((details, reply) => {
    try { const url = new URL(details.url), local = new URL(base); reply({ cancel: !['data:', 'blob:'].includes(url.protocol) && !(url.hostname === local.hostname && url.port === local.port) }); }
    catch { reply({ cancel: true }); }
  });
  const win = new BrowserWindow({ show: false, width: phone ? 390 : 1280, height: phone ? 844 : 900,
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.setUserAgent(phone ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1' : name === 'computer' ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/130.0' : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36');
  windows.push(win); await win.loadURL(base + '/auth'); return win;
}
async function click(win, text) {
  await until(() => win.webContents.executeJavaScript(`(() => {
    const el = [...document.querySelectorAll('button')].find(node => node.textContent.trim() === ${JSON.stringify(text)} && node.getClientRects().length && !node.disabled);
    if (!el) return false; el.scrollIntoView({block:'center'}); el.click(); return true;
  })()`), 'button ' + text);
}
async function settings(win) { await click(win, 'Настройки'); await until(() => win.webContents.executeJavaScript("!!document.querySelector('section[aria-label=\"Устройства\"]')"), 'device settings'); }
async function code(win) {
  return until(() => win.webContents.executeJavaScript("document.querySelector('[aria-label=\"Код сравнения\"]')?.textContent?.replace(/\\s/g,'')"), 'comparison code').then(async value => {
    if (/^[A-F0-9]{16}$/.test(value)) return value;
    return until(async () => { const next = await win.webContents.executeJavaScript("document.querySelector('[aria-label=\"Код сравнения\"]')?.textContent?.replace(/\\s/g,'')"); return /^[A-F0-9]{16}$/.test(next ?? '') ? next : false; }, 'comparison digest');
  });
}
async function approve(source, target) {
  assert.equal(await code(source), await code(target));
  await source.webContents.executeJavaScript("(() => { const label=[...document.querySelectorAll('label')].find(el=>el.textContent.includes('Код на обоих устройствах совпадает'));const input=label?.querySelector('input');if(!input)throw Error('No confirmation');input.click(); })()");
  await click(source, 'Это моё устройство — разрешить вход');
  await until(() => target.webContents.executeJavaScript("[...document.querySelectorAll('button')].some(node => node.textContent.startsWith('Войти как ') && !node.disabled)"), 'approval received');
  await target.webContents.executeJavaScript("[...document.querySelectorAll('button')].find(node => node.textContent.startsWith('Войти как ')).click()");
}
async function proof(win) {
  return win.webContents.executeJavaScript(`(async () => {
    const auth = JSON.parse(localStorage.getItem('quazar-auth') || 'null')?.state;
    if (!auth?.token || !auth.user) return null;
    const db = await new Promise((resolve,reject) => { const r=indexedDB.open('quazar-crypto'); r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error); });
    if (!db.objectStoreNames.contains('keys')) { db.close(); return null; }
    const key = await new Promise((resolve,reject)=>{const r=db.transaction('keys').objectStore('keys').get('identity');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});db.close();
    if (!key?.seed || key.accountId !== auth.user.id) return null;
    const server=await fetch('/api/users/'+auth.user.id+'/key',{headers:{Authorization:'Bearer '+auth.token}}).then(r=>r.json());
    if (server.public_key !== key.publicKeyB64) return null;
    const hex=buffer=>[...new Uint8Array(buffer)].map(x=>x.toString(16).padStart(2,'0')).join('');
    return { user:auth.user.id, key:key.publicKeyB64, seed:hex(await crypto.subtle.digest('SHA-256',key.seed)), session:hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(auth.token))) };
  })()`);
}
async function decodeQr(win) {
  const rect = await until(() => win.webContents.executeJavaScript("(() => { const el=document.querySelector('[aria-label=\"QR-код подключения\"]');if(!el)return null;const r=el.getBoundingClientRect();return {x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)} })()"), 'QR rendering');
  const img = await win.webContents.capturePage(rect);
  const size = img.getSize(), bytes = img.toBitmap();
  const scale = Math.sqrt(bytes.length / (size.width * size.height * 4));
  const result = jsQR(new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.length), Math.round(size.width * scale), Math.round(size.height * scale));
  assert.ok(result, 'Rendered QR must decode'); return result.data;
}
async function signedOut(win) {
  return until(() => win.webContents.executeJavaScript("!JSON.parse(localStorage.getItem('quazar-auth') || 'null')?.state?.token"), 'session revoked', 15_000);
}

app.whenReady().then(async () => {
  const source = await make('source');
  await source.webContents.executeJavaScript(`localStorage.setItem('quazar-auth', JSON.stringify({state:${JSON.stringify(bootstrap)},version:0}))`);
  await source.webContents.reload();
  const original = await until(() => proof(source), 'initial account key');
  await settings(source);
  const phone = await make('phone', true);
  await click(phone, 'Войти по QR-коду');
  const short = await until(() => phone.webContents.executeJavaScript("document.querySelector('[aria-label=\"Одноразовый код\"]')?.textContent"), 'one-time code');
  await click(source, 'Подключить по QR или коду');
  await source.webContents.executeJavaScript(`(() => { const input=document.querySelector('[aria-label="Одноразовый код"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(short)});input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await click(source, 'Продолжить');
  await approve(source, phone);
  const firstPhone = await until(() => proof(phone), 'phone key transfer');
  assert.equal(firstPhone.seed, original.seed); assert.notEqual(firstPhone.session, original.session);
  console.log('PAIR_E2E_CODE_OK: account session and encrypted identity transferred');
  await source.webContents.executeJavaScript("document.querySelector('[role=dialog] [aria-label=\"Закрыть\"]').click()");

  const computer = await make('computer'); await click(computer, 'Войти по QR-коду');
  await phone.loadURL(await decodeQr(computer));
  await approve(phone, computer);
  const linkedComputer = await until(() => proof(computer), 'reverse QR key transfer');
  assert.equal(linkedComputer.seed, original.seed); assert.notEqual(linkedComputer.session, firstPhone.session);
  console.log('PAIR_E2E_REVERSE_QR_OK: authenticated phone authorized a new browser');
  await click(phone, 'Вернуться в Quazar'); await settings(phone);
  await phone.webContents.executeJavaScript("window.confirm=()=>true; true");
  await until(() => phone.webContents.executeJavaScript("(() => {const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Завершить сеанс'&&b.parentElement.textContent.includes('Firefox'));if(!b)return false;b.click();return true})()"), 'specific device revoke');
  await signedOut(computer);
  assert.ok(await proof(source)); assert.ok(await proof(phone));
  console.log('PAIR_E2E_REVOKE_OK: target disconnected, other devices retained');

  await source.webContents.executeJavaScript("window.confirm=()=>true; true");
  await click(source, 'Завершить остальные сеансы'); await signedOut(phone);
  await until(async () => { const value = await proof(source); return value && value.session !== original.session; }, 'current session rotated');
  const secondPhone = await make('phone-two', true);
  await click(source, 'Подключить телефон');
  await secondPhone.loadURL(await decodeQr(source));
  await approve(source, secondPhone);
  const invited = await until(() => proof(secondPhone), 'phone invitation transfer');
  assert.equal(invited.seed, original.seed);
  console.log('PAIR_E2E_INVITE_OK: browser QR invitation authorized a phone');
  clearTimeout(timeout); windows.forEach(win => win.destroy()); app.quit();
}).catch(async error => {
  console.error(String(error.stack ?? error));
  for (const [index, win] of windows.entries()) {
    try { fs.writeFileSync(path.join(process.env.PAIR_TEST_PROFILE, `failure-${index}.png`), (await win.webContents.capturePage()).toPNG()); } catch {}
  }
  clearTimeout(timeout); app.exit(1);
});
