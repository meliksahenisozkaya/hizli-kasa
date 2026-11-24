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
    const tm = iso => new Date(iso).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    const ok = (r.sales || []).filter(s => s.status === 'completed').slice().sort((a, b) => a.created_at.localeCompare(b.created_at));
    const block = (title, type, sum) => {
      const list = ok.filter(s => s.payment_type === type);
      return `<div class="b">${title} (${list.length})</div>
        ${list.length ? `<table class="small">${list.map(s => `<tr><td>${tm(s.created_at)}</td><td>#${s.sale_no}</td><td class="r">${tl(s.total)}</td></tr>`).join('')}</table>`
          : '<div class="small">Satış yok</div>'}
        <div class="row b"><span>${title} toplamı</span><span>${tl(sum)}</span></div><hr>`;
    };
    const top = r.top.slice(0, 15).map(t =>
      `<tr><td>${esc(t.name)}</td><td class="r">${qtyFmt(t.qty)}</td><td class="r">${tl(t.total)}</td></tr>`).join('');
    return shell(settings, `
      ${header(settings)}
      <div class="c b">GÜN SONU RAPORU</div>
      <div class="c">${esc(r.dateLabel)}</div>
      <div class="c small">Yazdırma: ${new Date().toLocaleString('tr-TR')}</div><hr>
      ${block('NAKİT SATIŞLAR', 'cash', r.cash)}
      ${block('KREDİ KARTI SATIŞLARI', 'card', r.card)}
      <div class="row"><span>Nakit</span><span>${tl(r.cash)}</span></div>
      <div class="row"><span>Kredi kartı</span><span>${tl(r.card)}</span></div>
      <div class="row"><span>Satış adedi</span><span>${r.count}</span></div>
      <hr><div class="row big"><span>TOPLAM</span><span>${tl(r.total)} ₺</span></div><hr>
      ${r.cancelled ? `<div class="row small"><span>İptal edilen (${r.cancelled})</span><span>${tl(r.cancelledTotal)}</span></div><hr>` : ''}
      ${top ? `<div class="b">En çok satanlar</div><table class="small">${top}</table><hr>` : ''}
      <br>&nbsp;`);
  }

  function test(settings) {
    return shell(settings, `${header(settings)}<div class="c big">TEST FİŞİ</div>
      <div class="c">${new Date().toLocaleString('tr-TR')}</div><hr>
      <div class="c">Yazıcı çalışıyor ✓</div><br>&nbsp;`);
  }

  // A4 aylık satış raporu
  function monthA4(d, settings) {
    const ok = d.sales.filter(s => s.status === 'completed').sort((a, b) => a.created_at.localeCompare(b.created_at));
    const days = new Map();
    ok.forEach(s => {
      const k = new Date(s.created_at).toLocaleDateString('tr-TR');
      const x = days.get(k) || { cash: 0, card: 0, n: 0 };
      x[s.payment_type] += s.total; x.n++; days.set(k, x);
    });
    const rows = d.sales.slice().sort((a, b) => a.created_at.localeCompare(b.created_at)).map(s => {
      const t = new Date(s.created_at);
      const items = s.items.map(i => `${esc(i.name)} × ${qtyFmt(i.qty)}`).join(', ');
      return `<tr class="${s.status !== 'completed' ? 'x' : ''}"><td>${t.toLocaleDateString('tr-TR')}</td><td>${t.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}</td>
        <td>#${s.sale_no}</td><td>${s.payment_type === 'cash' ? 'Nakit' : 'Kart'}${s.status !== 'completed' ? ' (iptal)' : ''}</td><td class="it">${items}</td><td class="r">${tl(s.total)}</td></tr>`;
    }).join('');
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      @page { size: A4; margin: 12mm; }
      body { font: 10.5pt/1.35 "Segoe UI", Arial, sans-serif; color: #111; margin: 0; }
      h1 { font-size: 17pt; margin: 0; } .sub { color: #555; margin: 2px 0 12px; }
      .cards { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin-bottom: 14px; }
      .card { border: 1px solid #ddd; border-radius: 6px; padding: 8px 10px; } .card b { display: block; font-size: 13pt; margin-top: 2px; }
      .card.main { border-color: #ff5b1f; }
      h2 { font-size: 12pt; margin: 14px 0 6px; border-bottom: 2px solid #ff5b1f; padding-bottom: 3px; }
      table { width: 100%; border-collapse: collapse; } th, td { padding: 4px 6px; border-bottom: 1px solid #e5e5e5; text-align: left; vertical-align: top; }
      th { background: #f5f2ef; font-size: 9pt; text-transform: uppercase; } .r { text-align: right; white-space: nowrap; }
      td.it { font-size: 9pt; color: #333; } tr.x td { color: #999; text-decoration: line-through; }
      tfoot td { font-weight: bold; border-top: 2px solid #333; } thead { display: table-header-group; } tr { page-break-inside: avoid; }
      .foot { margin-top: 14px; color: #777; font-size: 8.5pt; }
    </style></head><body>
      <h1>${esc(settings.storeName || 'Hızlı Kasa')} — Aylık Satış Raporu</h1>
      <div class="sub">${esc(d.label)} · Hazırlanma: ${new Date().toLocaleString('tr-TR')}</div>
      <div class="cards">
        <div class="card main">Toplam ciro<b>${tl(d.total)} ₺</b></div><div class="card">Nakit<b>${tl(d.cash)} ₺</b></div>
        <div class="card">Kredi kartı<b>${tl(d.card)} ₺</b></div><div class="card">Satış adedi<b>${d.count}</b></div>
        <div class="card">İptal<b>${d.cancelled} · ${tl(d.cancelledTotal)} ₺</b></div></div>
      <h2>Günlük özet</h2>
      <table><thead><tr><th>Gün</th><th class="r">Satış</th><th class="r">Nakit</th><th class="r">Kart</th><th class="r">Toplam</th></tr></thead><tbody>
      ${[...days].map(([k, x]) => `<tr><td>${k}</td><td class="r">${x.n}</td><td class="r">${tl(x.cash)}</td><td class="r">${tl(x.card)}</td><td class="r">${tl(x.cash + x.card)}</td></tr>`).join('')}
      </tbody><tfoot><tr><td>Toplam</td><td class="r">${d.count}</td><td class="r">${tl(d.cash)}</td><td class="r">${tl(d.card)}</td><td class="r">${tl(d.total)}</td></tr></tfoot></table>
      <h2>Tüm satışlar</h2>
      <table><thead><tr><th>Tarih</th><th>Saat</th><th>Fiş</th><th>Ödeme</th><th>Ürünler</th><th class="r">Tutar</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="foot">Bu rapor bilgi amaçlıdır. Hızlı Kasa · ${esc(d.month)}</div>
    </body></html>`;
  }

  return { sale, dayReport, monthA4, test };
})();
