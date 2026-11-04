// Только CI: отдельное приложение и профиль, API и данные пользователей не используются.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('./fixture.json');
const { Updates } = require('./updates.cjs');
const { Startup } = require('./startup.cjs');
fs.mkdirSync(cfg.profile, { recursive: true }); app.setPath('userData', cfg.profile);
if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(async () => {
  const marker = path.join(cfg.profile, 'session-marker.json');
  if (app.getVersion() === '0.0.1') fs.writeFileSync(marker, JSON.stringify({ session: 'fixture-retained' }));
  const { autoUpdater } = require('electron-updater');
  const updates = new Updates({ updater: autoUpdater, platform: 'win32', arch: 'x64', version: app.getVersion(), packaged: true,
    feed: cfg.feed, isBusy: () => false, openExternal: async () => {}, quitAndInstall: () => autoUpdater.quitAndInstall(true, true) });
  const startup = new Startup(updates);
  const fail = message => { fs.writeFileSync(cfg.result, JSON.stringify({ error: message, state: startup.state })); app.exit(1); };
  startup.on('state', state => {
    if (state.phase === 'error') { fail(state.message); return; }
    if (state.phase !== 'ready') return;
    if (app.getVersion() !== '0.0.2') { fail('Old app opened before the required update'); return; }
    const saved = JSON.parse(fs.readFileSync(marker, 'utf8'));
    fs.writeFileSync(cfg.result, JSON.stringify({ version: app.getVersion(), profilePreserved: saved.session === 'fixture-retained' }));
    app.quit();
  });
  await startup.start();
}).catch(error => { fs.writeFileSync(cfg.result, JSON.stringify({ error: error.message })); app.exit(1); });
