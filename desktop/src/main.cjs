const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, protocol, session, net, shell, dialog, Notification, desktopCapturer, powerMonitor } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { APP_URL, SERVER_ORIGIN, isAppUrl, externalUrl, allowedNotification, authUrl, authReturn } = require('./policy.cjs');
const { createProtocolHandler } = require('./protocol.cjs');
const { installCapture } = require('./capture.cjs');
const { Updates } = require('./updates.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'quazar-app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
app.setName('Quazar');
// Путь не содержит версии: обновление не меняет профиль, токены и ключи IndexedDB.
const profile = path.join(app.getPath('appData'), 'Quazar');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
if (process.platform === 'win32') app.setAppUserModelId('ru.quazar.messenger');
let window = null, tray = null, quitting = false, busy = false, updates = null;
let pendingAuth = null, rendererReady = false;
const notifications = new Map();
const mainSender = event => !!window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === event.sender.mainFrame && isAppUrl(event.senderFrame.url);
const show = () => { if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } };
const send = (channel, value) => { if (window && !window.isDestroyed()) window.webContents.send(channel, value); };
const openExternal = value => { const url = externalUrl(value); return url ? shell.openExternal(url) : Promise.resolve(); };

async function quit() {
  if (busy) {
    const answer = await dialog.showMessageBox(window, { type: 'question', message: 'Завершить Quazar и прервать разговор?', buttons: ['Остаться', 'Завершить'], defaultId: 0, cancelId: 0 });
    if (answer.response !== 1) return;
  }
  quitting = true; app.quit();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  const receiveAuth = value => {
    const fragment = authReturn(value);
    if (!fragment) return;
    if (rendererReady) send('desktop:auth-returned', fragment); else pendingAuth = fragment;
    show();
  };
  app.on('open-url', (event, url) => { event.preventDefault(); receiveAuth(url); });
  app.on('second-instance', (_event, argv) => { const link = argv.find(value => value.startsWith('quazar-desktop:')); if (link) receiveAuth(link); show(); });
  const initialLink = process.argv.find(value => value.startsWith('quazar-desktop:'));
  if (initialLink) receiveAuth(initialLink);
  app.on('activate', show);
  app.on('window-all-closed', () => {});
  app.on('before-quit', event => {
    if (!quitting && busy) { event.preventDefault(); void quit(); return; }
    quitting = true;
  });
  app.whenReady().then(async () => {
    if (app.isPackaged) app.setAsDefaultProtocolClient('quazar-desktop');
    const root = path.join(app.getAppPath(), 'renderer');
    const ses = session.fromPartition('persist:quazar-v1');
    ses.protocol.handle('quazar-app', createProtocolHandler(root, (url, options) => net.fetch(url, options)));
    const allowedPermissions = new Set(['media', 'notifications', 'clipboard-sanitized-write', 'fullscreen', 'display-capture', 'speaker-selection']);
    ses.setPermissionCheckHandler((contents, permission, origin) => contents === window?.webContents && isAppUrl(origin) && allowedPermissions.has(permission));
    ses.setPermissionRequestHandler((contents, permission, callback, details) => callback(contents === window?.webContents && isAppUrl(details.requestingUrl) && allowedPermissions.has(permission)));
    window = new BrowserWindow({ width: 1240, height: 820, minWidth: 380, minHeight: 560, show: false, backgroundColor: '#07060f', title: 'Quazar',
      icon: path.join(root, 'icons/icon-512.png'), autoHideMenuBar: true,
      webPreferences: { partition: 'persist:quazar-v1', preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true,
        nodeIntegration: false, webSecurity: true, backgroundThrottling: false,
        additionalArguments: [`--quazar-version=${app.getVersion()}`, `--quazar-server=${SERVER_ORIGIN}`] } });
    window.on('close', event => { if (!quitting && tray && !tray.isDestroyed()) { event.preventDefault(); window.hide(); } });
    window.on('closed', () => { window = null; if (!quitting) { quitting = true; app.quit(); } });
    window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) rendererReady = false; });
    window.webContents.on('did-finish-load', () => { rendererReady = true; if (pendingAuth) { send('desktop:auth-returned', pendingAuth); pendingAuth = null; } });
    window.webContents.on('will-navigate', (event, url) => {
      if (isAppUrl(url) && !new URL(url).pathname.startsWith('/api/')) return;
      event.preventDefault(); void openExternal(isAppUrl(url) ? SERVER_ORIGIN + new URL(url).pathname + new URL(url).search : url);
    });
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.setWindowOpenHandler(({ url }) => { void openExternal(url); return { action: 'deny' }; });
    window.webContents.on('render-process-gone', () => { busy = false; });
    installCapture({ session: ses, BrowserWindow, desktopCapturer, ipcMain, getWindow: () => window });

    const { autoUpdater } = require('electron-updater');
    updates = new Updates({ updater: autoUpdater, platform: process.platform, arch: process.arch, version: app.getVersion(), packaged: app.isPackaged,
      isBusy: () => busy, openExternal, quitAndInstall: () => { quitting = true; autoUpdater.quitAndInstall(false, true); } });
    updates.on('state', state => send('desktop:update', state));
    const checkWithFeedback = async () => {
      show();
      const state = await updates.check();
      send('desktop:update', { ...state, requested: true });
      if (['error', 'up-to-date', 'disabled'].includes(state.status)) {
        await dialog.showMessageBox(window, { type: 'info', message: state.status === 'up-to-date' ? 'Установлена актуальная версия Quazar.'
          : state.status === 'disabled' ? 'Проверка обновлений доступна в установленном приложении.' : state.message, buttons: ['OK'] });
      }
    };
    const guarded = handler => (event, ...args) => { if (!mainSender(event)) throw new Error('Forbidden'); return handler(...args); };
    ipcMain.handle('desktop:update-state', guarded(() => updates.state));
    ipcMain.handle('desktop:update-check', guarded(() => updates.check()));
    ipcMain.handle('desktop:update-install', guarded(() => updates.install()));
    ipcMain.handle('desktop:auth-open', guarded(value => { const url = authUrl(value); if (!url) throw new Error('Invalid auth URL'); return shell.openExternal(url); }));
    ipcMain.handle('desktop:auth-return', guarded(() => { const fragment = pendingAuth; pendingAuth = null; return fragment; }));
    ipcMain.on('desktop:busy', (event, value) => { if (mainSender(event)) busy = value === true; });
    ipcMain.on('desktop:clear-notifications', event => { if (mainSender(event)) { for (const note of notifications.values()) note.close(); notifications.clear(); } });
    ipcMain.on('desktop:close-notification', (event, tag) => { if (mainSender(event) && typeof tag === 'string') notifications.get(tag)?.close(); });
    ipcMain.handle('desktop:notification', guarded(value => {
      const options = allowedNotification(value);
      if (!options || !Notification.isSupported()) return false;
      const key = options.tag || String(Date.now());
      notifications.get(key)?.close();
      const note = new Notification({ title: options.title, body: options.body, silent: options.silent, icon: path.join(root, 'icons/icon-192.png') });
      note.on('click', () => { show(); send('desktop:navigate', options.data); });
      note.on('close', () => { if (notifications.get(key) === note) notifications.delete(key); });
      notifications.set(key, note);
      if (notifications.size > 100) { const first = notifications.keys().next().value; notifications.get(first)?.close(); notifications.delete(first); }
      note.show(); return true;
    }));
    const menu = Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ label: 'Quazar', submenu: [{ label: 'Открыть Quazar', click: show }, { label: 'Проверить обновления', click: checkWithFeedback }, { type: 'separator' }, { label: 'Завершить Quazar', accelerator: 'Cmd+Q', click: quit }] }] : []),
      { label: 'Правка', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'Вид', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }, ...(!app.isPackaged ? [{ role: 'toggleDevTools' }] : [])] },
      ...(process.platform !== 'darwin' ? [{ label: 'Quazar', submenu: [{ label: 'Проверить обновления', click: checkWithFeedback }, { label: 'Завершить Quazar', accelerator: 'Control+Q', click: quit }] }] : []),
    ]);
    Menu.setApplicationMenu(menu);
    try {
      tray = new Tray(nativeImage.createFromPath(path.join(root, 'icons/icon-48.png')).resize({ width: process.platform === 'darwin' ? 18 : 24, height: process.platform === 'darwin' ? 18 : 24 }));
      tray.setToolTip('Quazar');
      tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Открыть Quazar', click: show }, { label: 'Проверить обновления', click: checkWithFeedback }, { type: 'separator' }, { label: 'Завершить Quazar', click: quit }]));
      tray.on('double-click', show);
      if (process.platform === 'darwin') tray.on('click', show);
    } catch { tray = null; }
    powerMonitor.on('resume', () => { send('desktop:navigate', { kind: 'resume' }); void updates.check(); });
    const interval = setInterval(() => void updates.check(), 30 * 60_000); interval.unref();
    await window.loadURL(APP_URL + '/');
    let timeout;
    await Promise.race([updates.check(), new Promise(resolve => { timeout = setTimeout(resolve, 4000); })]);
    clearTimeout(timeout);
    if (updates.state.status === 'downloaded' && !busy) await updates.install(); else show();
  }).catch(error => { dialog.showErrorBox('Quazar не запустился', String(error.message).slice(0, 500)); quitting = true; app.quit(); });
}
