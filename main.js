// Hızlı Kasa - Electron ana süreci
const { app, BrowserWindow, ipcMain, Menu, shell, dialog, net } = require('electron');
const path = require('path');

let win;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1366,
    height: 768,
    minWidth: 1024,
    minHeight: 640,
    title: 'Hızlı Kasa',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  Menu.setApplicationMenu(null);
  win.maximize();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // F11 tam ekran, Ctrl+Shift+I geliştirici araçları
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    if (input.control && input.shift && input.key.toLowerCase() === 'i') win.webContents.toggleDevTools();
  });

  // Harici bağlantılar varsayılan tarayıcıda açılsın
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

ipcMain.handle('printers:list', async () => {
  if (!win) return [];
  const list = await win.webContents.getPrintersAsync();
  return list.map(p => ({ name: p.name, displayName: p.displayName || p.name, isDefault: !!p.isDefault }));
});

ipcMain.handle('print:html', async (_e, html, opts = {}) => {
  const pw = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await pw.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const deviceName = opts.deviceName || '';
    return await new Promise(resolve => {
      const o = opts.a4
        ? { silent: false, printBackground: true, pageSize: 'A4', margins: { marginType: 'default' } }
        : { silent: !!deviceName, deviceName: deviceName || undefined, printBackground: false, margins: { marginType: 'none' } };
      pw.webContents.print(o, (success, reason) => resolve({ success, reason: reason || '' }));
    });
  } finally {
    setTimeout(() => { if (!pw.isDestroyed()) pw.close(); }, 500);
  }
});

ipcMain.handle('excel:read', async (_e, bytes) => {
  const XLSX = require('xlsx');
  const wb = XLSX.read(Buffer.from(bytes), { type: 'buffer', cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
});

ipcMain.handle('excel:save', async (_e, rows, name) => {
  const XLSX = require('xlsx');
  const r = await dialog.showSaveDialog(win, {
    title: 'Excel dosyasını kaydet',
    defaultPath: path.join(app.getPath('downloads'), name || 'ornek.xlsx'),
    filters: [{ name: 'Excel', extensions: ['xlsx'] }]
  });
  if (r.canceled || !r.filePath) return { saved: false };
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 10 }, { wch: 40 }, { wch: 16 }, { wch: 7 }, { wch: 18 }, { wch: 14 }, { wch: 8 }, { wch: 18 }, { wch: 38 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Fiyat Listesi');
  XLSX.writeFile(wb, r.filePath);
  shell.showItemInFolder(r.filePath);
  return { saved: true, path: r.filePath };
});

ipcMain.handle('image:fetch', async (_e, url) => {
  if (!/^https:\/\//.test(url)) throw new Error('Geçersiz adres');
  const r = await net.fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const type = r.headers.get('content-type') || 'image/png';
  if (!type.startsWith('image/')) throw new Error('Resim değil');
  const buf = Buffer.from(await r.arrayBuffer());
  return 'data:' + type + ';base64,' + buf.toString('base64');
});

ipcMain.handle('archive:save', async (_e, name, base64) => {
  const fs = require('fs');
  const dir = path.join(app.getPath('documents'), 'Hizli Kasa Arsiv');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, String(name).replace(/[^\w.-]/g, '_'));
  fs.writeFileSync(file, Buffer.from(base64, 'base64'));
  return file;
});

ipcMain.handle('app:version', () => app.getVersion());

// ---- Otomatik güncelleme (GitHub Releases) ----
function setupAutoUpdate() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (_) { return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;   // tıklanmasa bile program kapanınca kurulur
  const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };
  autoUpdater.on('update-available', i => send('update:status', { state: 'downloading', version: i.version }));
  autoUpdater.on('update-downloaded', i => send('update:status', { state: 'ready', version: i.version }));
  autoUpdater.on('error', e => console.error('Güncelleme hatası:', e && e.message));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});   // internet yoksa sessizce geç
  setTimeout(check, 5000);
  setInterval(check, 60 * 60 * 1000);
  ipcMain.handle('update:install', () => { setImmediate(() => autoUpdater.quitAndInstall(true, true)); });
}

app.whenReady().then(() => { createWindow(); setupAutoUpdate(); });
app.on('window-all-closed', () => app.quit());
