// Real local splash renderer: no production API or user profile.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { trustedMainFrame } = require('../src/policy.cjs');
const version = require('../package.json').version;
const [major, minor] = version.split('.').map(Number);
const nextVersion = `${major}.${minor + 1}.0`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'quazar-splash-'));
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
let win;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('Splash renderer test timed out'); app.exit(1); }, 30_000);
app.whenReady().then(async () => {
  const file = path.resolve(__dirname, '../src/startup.html');
  const ses = session.fromPartition('splash-test');
  ses.webRequest.onBeforeRequest((details, reply) => reply({ cancel: !details.url.startsWith('file:') }));
  ipcMain.handle('startup:state', event => {
    assert.ok(trustedMainFrame(event, win.webContents, url => url === pathToFileURL(file).href));
    return { phase: 'checking', currentVersion: version, canContinue: false };
  });
  win = new BrowserWindow({ width: 480, height: 540, frame: false, show: false, backgroundColor: '#090811',
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false, preload: path.resolve(__dirname, '../src/startup-preload.cjs') } });
  const errors = [];
  win.webContents.on('console-message', details => { if (/Refused to|Uncaught/.test(details.message)) errors.push(details.message); });
  await win.loadFile(file); await pause(350);
  const inspect = () => win.webContents.executeJavaScript(`(() => {
    const main = document.querySelector('main'), image = document.querySelector('img');
    return { phase: main.dataset.phase, logo: image.complete && image.naturalWidth > 0,
      overflow: main.scrollHeight > innerHeight || main.scrollWidth > innerWidth,
      percent: document.querySelector('#percentage').textContent, progress: document.querySelector('progress').value,
      canContinue: !document.querySelector('#continue').hidden, retry: !document.querySelector('#retry').hidden,
      motion: getComputedStyle(image).transform,
      animated: document.getAnimations().filter(animation => animation.playState === 'running').length };
  })()`);
  const screenshot = async name => {
    if (!process.env.QUAZAR_STARTUP_PREVIEW) return;
    fs.mkdirSync(process.env.QUAZAR_STARTUP_PREVIEW, { recursive: true });
    fs.writeFileSync(path.join(process.env.QUAZAR_STARTUP_PREVIEW, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  const set = async (phase, extra = {}) => {
    win.webContents.send('startup:state-changed', { phase, currentVersion: version, canContinue: false, ...extra });
    await pause(180);
    const value = await inspect(); assert.equal(value.phase, phase); assert.equal(value.overflow, false, phase);
    return value;
  };
  const initial = await inspect(); assert.ok(initial.logo); assert.equal(initial.overflow, false); assert.ok(initial.animated > 0);
  await pause(220); assert.notEqual((await inspect()).motion, initial.motion);
  await screenshot('checking');
  const downloading = await set('downloading', { version: nextVersion, progress: 63 });
  assert.equal(downloading.percent, '63%'); assert.equal(downloading.progress, 63); await screenshot('downloading');
  assert.equal((await set('installing', { version: nextVersion })).progress, 100);
  const required = await set('error', { version: nextVersion, message: 'Обновление не удалось установить. Повторите попытку или завершите приложение.' });
  assert.equal(required.canContinue, false); assert.equal(required.retry, true);
  const offline = await set('error', { canContinue: true, message: 'Не удалось проверить обновления. Проверьте подключение к интернету.' });
  assert.equal(offline.canContinue, true); await screenshot('offline');
  await set('ready');
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await pause(100);
  assert.equal((await inspect()).animated, 0, 'Reduced motion must disable animations');
  win.webContents.debugger.detach();
  assert.deepEqual(errors, []);
  console.log('STARTUP_VISUAL_OK: logo, animation, reduced motion, progress and error layouts');
  clearTimeout(deadline); win.destroy(); app.quit();
}).catch(error => {
  console.error(error);
  console.error('::error title=Startup renderer check::' + String(error.stack ?? error).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A'));
  clearTimeout(deadline); app.exit(1);
});
