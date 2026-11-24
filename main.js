// Hızlı Kasa - Electron ana süreci
const { app, BrowserWindow, ipcMain, Menu, shell } = require('electron');
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
      pw.webContents.print({
        silent: !!deviceName,
        deviceName: deviceName || undefined,
        printBackground: false,
        margins: { marginType: 'none' }
      }, (success, reason) => resolve({ success, reason: reason || '' }));
    });
  } finally {
    setTimeout(() => { if (!pw.isDestroyed()) pw.close(); }, 500);
  }
});

ipcMain.handle('app:version', () => app.getVersion());

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
