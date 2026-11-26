const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('quazarOverlay', {
  onState: callback => { ipcRenderer.on('overlay:state', (_event, state) => callback(state)); },
  // Нажатая кнопка (id всплывашки и кнопки) и «курсор над кнопкой» — main-процесс проверит, что они есть.
  act: (toast, action) => ipcRenderer.send('overlay:action', { toast: String(toast), action: String(action) }),
  hover: on => ipcRenderer.send('overlay:hover', on === true),
});
