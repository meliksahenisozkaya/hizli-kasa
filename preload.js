const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kasa', {
  listPrinters: () => ipcRenderer.invoke('printers:list'),
  printHtml: (html, opts) => ipcRenderer.invoke('print:html', html, opts),
  readExcel: bytes => ipcRenderer.invoke('excel:read', bytes),
  fetchImage: url => ipcRenderer.invoke('image:fetch', url),
  saveArchive: (name, b64) => ipcRenderer.invoke('archive:save', name, b64),
  saveExcel: (rows, name, opts) => ipcRenderer.invoke('excel:save', rows, name, opts),
  onUpdate: cb => ipcRenderer.on('update:status', (_e, d) => cb(d)),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  version: () => ipcRenderer.invoke('app:version'),
  journalAppend: lines => ipcRenderer.invoke('journal:append', lines),
  journalRead: () => ipcRenderer.invoke('journal:read'),
  journalTrim: keepFrom => ipcRenderer.invoke('journal:trim', keepFrom),
  stateSave: obj => ipcRenderer.invoke('state:save', obj),
  stateRead: () => ipcRenderer.invoke('state:read')
});
