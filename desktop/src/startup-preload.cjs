const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('quazarStartup', {
  state: () => ipcRenderer.invoke('startup:state'),
  retry: () => ipcRenderer.invoke('startup:retry'),
  continueWithoutCheck: () => ipcRenderer.invoke('startup:continue'),
  quit: () => ipcRenderer.send('startup:quit'),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('startup:state-changed', listener);
    return () => ipcRenderer.removeListener('startup:state-changed', listener);
  },
});
