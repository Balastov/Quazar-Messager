const { contextBridge, ipcRenderer } = require('electron');
const argument = key => process.argv.find(value => value.startsWith(key + '='))?.slice(key.length + 1) ?? '';
const subscribe = (channel, callback) => {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('quazarDesktop', {
  platform: process.platform,
  version: argument('--quazar-version'),
  serverOrigin: argument('--quazar-server'),
  updateState: () => ipcRenderer.invoke('desktop:update-state'),
  checkForUpdates: () => ipcRenderer.invoke('desktop:update-check'),
  installUpdate: () => ipcRenderer.invoke('desktop:update-install'),
  onUpdate: callback => subscribe('desktop:update', callback),
  setSessionBusy: busy => ipcRenderer.send('desktop:busy', busy === true),
  setOverlay: state => ipcRenderer.send('desktop:overlay', state ?? null),
  onHotkey: callback => subscribe('desktop:hotkey', callback),
  listDisplays: () => ipcRenderer.invoke('desktop:displays'),
  onOverlayKeys: callback => subscribe('desktop:overlay-keys', callback),
  placeOverlay: on => ipcRenderer.send('desktop:overlay-place', on === true),
  onOverlayAction: callback => subscribe('desktop:overlay-action', callback),
  onOverlayMoved: callback => subscribe('desktop:overlay-moved', callback),
  onOverlayPlacing: callback => subscribe('desktop:overlay-placing', callback),
  showNotification: options => ipcRenderer.invoke('desktop:notification', options),
  clearNotifications: () => ipcRenderer.send('desktop:clear-notifications'),
  closeNotification: tag => ipcRenderer.send('desktop:close-notification', tag),
  onNavigate: callback => subscribe('desktop:navigate', callback),
  openAuth: url => ipcRenderer.invoke('desktop:auth-open', url),
  takeAuthReturn: () => ipcRenderer.invoke('desktop:auth-return'),
  onAuthReturn: callback => subscribe('desktop:auth-returned', callback),
});
