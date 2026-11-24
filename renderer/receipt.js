// Termal yazıcı için fiş ve gün sonu raporu şablonları (58 / 80 mm)
const Receipt = (() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const tl = n => Number(n || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const qtyFmt = n => Number(n).toLocaleString('tr-TR', { maximumFractionDigits: 3 });
  const dt = iso => new Date(iso).toLocaleString('tr-TR');

  function shell(settings, body) {
    const w = settings.paper === '58' ? 48 : 72;
    const fs = settings.paper === '58' ? 11 : 12;
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      @page { margin: 0; }
      * { box-sizing: border-box; }
      body { margin: 0; padding: 2mm 3mm; width: ${w + 6}mm; font: ${fs}px/1.35 "Consolas","Courier New",monospace; color: #000; }
      .c { text-align: center; } .r { text-align: right; } .b { font-weight: bold; }
      .big { font-size: ${fs + 5}px; font-weight: bold; }
      hr { border: 0; border-top: 1px dashed #000; margin: 4px 0; }
      table { width: 100%; border-collapse: collapse; } td { vertical-align: top; padding: 1px 0; }
      .row { display: flex; justify-content: space-between; gap: 4px; }
      .small { font-size: ${fs - 2}px; }
    </style></head><body>${body}</body></html>`;
  }

  function header(settings) {
    return `<div class="c b" style="font-size:1.2em">${esc(settings.storeName || 'İŞLETME ADI')}</div>
      ${settings.storeAddress ? `<div class="c small">${esc(settings.storeAddress).replace(/\n/g, '<br>')}</div>` : ''}
      ${settings.storePhone ? `<div class="c small">Tel: ${esc(settings.storePhone)}</div>` : ''}<hr>`;
  }

  function sale(s, settings) {
    const items = s.items.map(i => `
      <tr><td colspan="2">${esc(i.name)}</td></tr>
      <tr><td class="small">&nbsp;${qtyFmt(i.qty)} ${esc(i.unit || '')} x ${tl(i.price)}</td><td class="r">${tl(i.total)}</td></tr>`).join('');
    const vat = {};
    s.items.forEach(i => {
      const r = Number(i.vat_rate || 0);
      vat[r] = (vat[r] || 0) + (i.total - i.total / (1 + r / 100));
    });
    const vatRows = Object.keys(vat).sort((a, b) => a - b).map(r =>
      `<div class="row small"><span>KDV %${r}</span><span>${tl(vat[r])}</span></div>`).join('');
    return shell(settings, `
      ${header(settings)}
      <div class="row small"><span>${dt(s.created_at)}</span><span>Fiş No: ${s.sale_no}</span></div>
      ${s.status === 'cancelled' ? '<div class="c b">*** İPTAL EDİLDİ ***</div>' : ''}
      <hr><table>${items}</table><hr>
      <div class="row big"><span>TOPLAM</span><span>${tl(s.total)} ₺</span></div>
      ${vatRows}
      <hr>
      <div class="row"><span>Ödeme</span><span>${s.payment_type === 'cash' ? 'NAKİT' : 'KREDİ KARTI'}</span></div>
      ${s.payment_type === 'cash' && s.cash_given ? `
        <div class="row"><span>Alınan</span><span>${tl(s.cash_given)}</span></div>
        <div class="row b"><span>Para Üstü</span><span>${tl(s.change_amount)}</span></div>` : ''}
      <hr>
      ${settings.footer ? `<div class="c">${esc(settings.footer).replace(/\n/g, '<br>')}</div>` : ''}
      <div class="c small">Bu bir bilgi fişidir. Mali değeri yoktur.</div>
      <br>&nbsp;`);
  }

  function dayReport(r, settings) {
    const top = r.top.slice(0, 15).map(t =>
      `<tr><td>${esc(t.name)}</td><td class="r">${qtyFmt(t.qty)}</td><td class="r">${tl(t.total)}</td></tr>`).join('');
    return shell(settings, `
      ${header(settings)}
      <div class="c b">GÜN SONU RAPORU</div>
      <div class="c">${esc(r.dateLabel)}</div>
      <div class="c small">Yazdırma: ${new Date().toLocaleString('tr-TR')}</div><hr>
      <div class="row"><span>Satış adedi</span><span>${r.count}</span></div>
      <div class="row"><span>Nakit</span><span>${tl(r.cash)}</span></div>
      <div class="row"><span>Kredi kartı</span><span>${tl(r.card)}</span></div>
      <hr><div class="row big"><span>TOPLAM</span><span>${tl(r.total)} ₺</span></div><hr>
      ${r.cancelled ? `<div class="row small"><span>İptal edilen (${r.cancelled})</span><span>${tl(r.cancelledTotal)}</span></div><hr>` : ''}
      ${r.firstSale ? `<div class="row small"><span>İlk satış</span><span>${r.firstSale}</span></div>
      <div class="row small"><span>Son satış</span><span>${r.lastSale}</span></div><hr>` : ''}
      ${top ? `<div class="b">En çok satanlar</div><table class="small">${top}</table><hr>` : ''}
      <br>&nbsp;`);
  }

  function test(settings) {
    return shell(settings, `${header(settings)}<div class="c big">TEST FİŞİ</div>
      <div class="c">${new Date().toLocaleString('tr-TR')}</div><hr>
      <div class="c">Yazıcı çalışıyor ✓</div><br>&nbsp;`);
  }

  return { sale, dayReport, test };
})();
