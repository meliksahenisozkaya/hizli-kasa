// Hızlı Kasa - web sürümü köprüsü.
// Masaüstü (Electron) sürümündeki window.kasa işlevlerinin tarayıcı karşılıkları.
(function () {
  if (window.kasa) return;
  const download = (blob, name) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  window.kasa = {
    isWeb: true,
    listPrinters: async () => [],
    // Fişi/raporu gizli bir çerçevede açıp tarayıcının yazdırma penceresini gösterir
    printHtml: (html) => new Promise(res => {
      const f = document.createElement('iframe');
      f.setAttribute('aria-hidden', 'true');
      f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
      document.body.appendChild(f);
      f.onload = () => setTimeout(() => {
        try { f.contentWindow.focus(); f.contentWindow.print(); } catch (_) {}
        setTimeout(() => f.remove(), 2000);
        res({ success: true });
      }, 250);
      f.srcdoc = html;
    }),
    readExcel: async bytes => {
      if (!window.XLSX) throw new Error('Excel okuyucu yüklenemedi');
      const wb = XLSX.read(bytes, { type: 'array', cellDates: false });
      const ws = wb.Sheets[wb.SheetNames[0]];
      return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
    },
    saveExcel: async (rows, name) => {
      if (!window.XLSX) throw new Error('Excel yazıcı yüklenemedi');
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = [10, 40, 16, 7, 18, 14, 8, 18, 18, 38].map(wch => ({ wch }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Fiyat Listesi');
      XLSX.writeFile(wb, name || 'urunler.xlsx');
      return { saved: true, path: 'İndirilenler / ' + (name || 'urunler.xlsx') };
    },
    saveArchive: async (name, b64) => {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      download(new Blob([bytes], { type: 'application/gzip' }), name);
      return 'İndirilenler / ' + name;
    },
    onUpdate: () => {},
    installUpdate: () => {},
    version: async () => 'web'
  };
})();
