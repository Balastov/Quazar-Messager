const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('capturePicker', {
  list: () => ipcRenderer.invoke('capture:list'),
  select: (id, audio) => ipcRenderer.send('capture:select', { id, audio }),
});
