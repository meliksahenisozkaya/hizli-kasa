const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kasa', {
  listPrinters: () => ipcRenderer.invoke('printers:list'),
  printHtml: (html, opts) => ipcRenderer.invoke('print:html', html, opts),
  readExcel: bytes => ipcRenderer.invoke('excel:read', bytes),
  version: () => ipcRenderer.invoke('app:version')
});
