const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('quazarOverlay', {
  onState: callback => { ipcRenderer.on('overlay:state', (_event, state) => callback(state)); },
});
