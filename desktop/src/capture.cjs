const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { isAppUrl } = require('./policy.cjs');

function installCapture({ session, BrowserWindow, desktopCapturer, ipcMain, getWindow }) {
  let picker = null;
  let finish = null;
  let sources = [];
  let audioRequested = false;
  let pending = false;
  const pickerFile = path.join(__dirname, 'source-picker.html');
  const trustedPicker = e => !!picker && e.sender === picker.webContents && e.senderFrame === e.sender.mainFrame && e.senderFrame.url === pathToFileURL(pickerFile).href;
  ipcMain.handle('capture:list', e => {
    if (!trustedPicker(e)) throw new Error('Forbidden');
    return { audioRequested, sources: sources.map(source => ({ id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL() })) };
  });
  ipcMain.on('capture:select', (e, value) => {
    if (!trustedPicker(e) || !finish) return;
    const source = sources.find(item => item.id === value?.id);
    finish(source ? { video: source, ...(audioRequested && value.audio === true ? { audio: 'loopback' } : {}) } : {});
  });
  session.setDisplayMediaRequestHandler(async (request, callback) => {
    const owner = getWindow();
    if (!owner || request.frame !== owner.webContents.mainFrame || !isAppUrl(request.securityOrigin) || !request.userGesture || pending) { callback({}); return; }
    pending = true;
    try {
      sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 240, height: 150 }, fetchWindowIcons: false });
      if (owner.isDestroyed()) { pending = false; callback({}); return; }
      audioRequested = request.audioRequested;
      picker = new BrowserWindow({ width: 720, height: 540, parent: owner, modal: true, title: 'Выберите источник трансляции',
        autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'picker-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
      const timer = setTimeout(() => finish?.({}), 90_000);
      finish = result => {
        if (!finish) return;
        finish = null; pending = false; clearTimeout(timer);
        const current = picker; picker = null; sources = [];
        if (current && !current.isDestroyed()) current.close();
        callback(result);
      };
      picker.on('closed', () => finish?.({}));
      picker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      picker.webContents.on('will-navigate', event => event.preventDefault());
      await picker.loadFile(pickerFile);
    } catch { if (finish) finish({}); else { pending = false; callback({}); } }
  }, { useSystemPicker: process.platform === 'darwin' });
}
module.exports = { installCapture };
