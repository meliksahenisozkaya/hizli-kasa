// Termal yazıcı için fiş ve gün sonu raporu şablonları (58 / 80 mm)
const Receipt = (() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const tl = n => Number(n || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const qtyFmt = n => Number(n).toLocaleString('tr-TR', { maximumFractionDigits: 3 });
  const dt = iso => new Date(iso).toLocaleString('tr-TR');
  // Bir satışın ödeme dağılımı: nakit / kart / veresiye (iade kayıtlarında eksi)
  function payOf(s) {
    const t = Number(s.total) || 0;
    if (s.payment_type === 'mixed') return { cash: Number(s.cash_amount) || 0, card: Number(s.card_amount) || 0, credit: 0 };
    if (s.payment_type === 'card') return { cash: 0, card: t, credit: 0 };
    if (s.payment_type === 'credit') return { cash: 0, card: 0, credit: t };
    return { cash: t, card: 0, credit: 0 };
  }
  const PAY_LABEL = { cash: 'Nakit', card: 'Kart', mixed: 'Nakit + Kart', credit: 'Veresiye' };
  const payLabel = s => (s.kind === 'refund' ? 'İade · ' : '') + (PAY_LABEL[s.payment_type] || s.payment_type);
  const lineDisc = i => (i.list_price != null && i.list_price > i.price) ? (i.list_price - i.price) * i.qty : 0;

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
    const refund = s.kind === 'refund';
    const items = s.items.map(i => `
      <tr><td colspan="2">${esc(i.name)}</td></tr>
      <tr><td class="small">&nbsp;${qtyFmt(Math.abs(i.qty))} ${esc(i.unit || '')} x ${tl(i.price)}${lineDisc(i) > 0 ? ` <s>${tl(i.list_price)}</s>` : ''}</td><td class="r">${tl(Math.abs(i.total))}</td></tr>`).join('');
    const vat = {};
    const factor = s.subtotal ? (Number(s.total) / Number(s.subtotal)) : 1;
    s.items.forEach(i => {
      const r = Number(i.vat_rate || 0), t = Math.abs(i.total) * (refund ? 1 : factor);
      vat[r] = (vat[r] || 0) + (t - t / (1 + r / 100));
    });
    const vatRows = Object.keys(vat).sort((a, b) => a - b).map(r =>
      `<div class="row small"><span>KDV %${r}</span><span>${tl(vat[r])}</span></div>`).join('');
    const disc = s.items.reduce((a, i) => a + lineDisc(i), 0) + (Number(s.discount) || 0);
    const p = payOf(s);
    return shell(settings, `
      ${header(settings)}
      ${refund ? `<div class="c big">İADE FİŞİ</div><div class="c small">Satış fişi #${s.ref_sale_no || '-'}</div>` : ''}
      <div class="row small"><span>${dt(s.created_at)}</span><span>Fiş No: ${s.sale_no}</span></div>
      ${s.cashier && s.cashier.name ? `<div class="small">Kasiyer: ${esc(s.cashier.name)}</div>` : ''}
      ${s.status === 'cancelled' ? '<div class="c b">*** İPTAL EDİLDİ ***</div>' : ''}
      ${s.order_no ? `<div class="small">Onaylı sipariş #${s.order_no}${s.order_note ? ' · ' + esc(s.order_note) : ''}</div>` : ''}
      ${s.customer_name ? `<div class="small">Müşteri: ${esc(s.customer_name)}</div>` : ''}
      <hr><table>${items}</table><hr>
      ${!refund && Number(s.discount) > 0 ? `<div class="row"><span>Ara toplam</span><span>${tl(s.subtotal)}</span></div>
        <div class="row"><span>Fiş indirimi</span><span>-${tl(s.discount)}</span></div>` : ''}
      <div class="row big"><span>${refund ? 'İADE' : 'TOPLAM'}</span><span>${tl(Math.abs(s.total))} ₺</span></div>
      ${!refund && disc > 0.004 ? `<div class="row small"><span>Toplam indirim</span><span>${tl(disc)}</span></div>` : ''}
      ${vatRows}
      <hr>
      <div class="row"><span>${refund ? 'İade şekli' : 'Ödeme'}</span><span>${(PAY_LABEL[s.payment_type] || '').toLocaleUpperCase('tr-TR')}</span></div>
      ${s.payment_type === 'mixed' ? `<div class="row small"><span>Nakit</span><span>${tl(p.cash)}</span></div><div class="row small"><span>Kart</span><span>${tl(p.card)}</span></div>` : ''}
      ${s.payment_type === 'cash' && s.cash_given ? `
        <div class="row"><span>Alınan</span><span>${tl(s.cash_given)}</span></div>
        <div class="row b"><span>Para Üstü</span><span>${tl(s.change_amount)}</span></div>` : ''}
      ${s.payment_type === 'credit' && s.balance_after != null ? `<div class="row small"><span>Güncel borç</span><span>${tl(s.balance_after)}</span></div>` : ''}
      <hr>
      ${settings.footer && !refund ? `<div class="c">${esc(settings.footer).replace(/\n/g, '<br>')}</div>` : ''}
      <div class="c small">Bu bir bilgi fişidir. Mali değeri yoktur.</div>
      <br>&nbsp;`);
  }

  // Veresiye tahsilat makbuzu
  function collect(e, settings) {
    return shell(settings, `${header(settings)}
      <div class="c big">TAHSİLAT MAKBUZU</div>
      <div class="row small"><span>${dt(e.created_at)}</span></div><hr>
      <div class="row"><span>Müşteri</span><span>${esc(e.customer_name || '')}</span></div>
      <div class="row big"><span>ALINAN</span><span>${tl(Math.abs(e.amount))} ₺</span></div>
      <div class="row"><span>Ödeme</span><span>${e.method === 'card' ? 'KART' : 'NAKİT'}</span></div>
      ${e.note ? `<div class="small">${esc(e.note)}</div>` : ''}
      ${e.balance_after != null ? `<hr><div class="row b"><span>Kalan borç</span><span>${tl(e.balance_after)}</span></div>` : ''}
      <br>&nbsp;`);
  }

  // Müşteri ekstresi (termal)
  function statement(c, rows, balance, settings) {
    return shell(settings, `${header(settings)}
      <div class="c b">MÜŞTERİ EKSTRESİ</div><div class="c">${esc(c.name)}</div>
      <div class="c small">${new Date().toLocaleString('tr-TR')}</div><hr>
      <table class="small">${rows.map(r => `<tr><td>${new Date(r.created_at).toLocaleDateString('tr-TR')} ${esc(r.label)}</td><td class="r">${r.amount > 0 ? '' : '-'}${tl(Math.abs(r.amount))}</td></tr>`).join('')}</table><hr>
      <div class="row big"><span>BAKİYE</span><span>${tl(balance)} ₺</span></div><br>&nbsp;`);
  }

  function dayReport(r, settings) {
    const tm = iso => new Date(iso).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    const ok = (r.sales || []).filter(s => s.status === 'completed').slice().sort((a, b) => a.created_at.localeCompare(b.created_at));
    const lines = list => `<table class="small">${list.map(s => `<tr class="b"><td>${tm(s.created_at)}  #${s.sale_no}${s.customer_name ? ' ' + esc(s.customer_name) : ''}${s.kind === 'refund' && s.ref_sale_no ? ' (fiş #' + s.ref_sale_no + ')' : ''}</td><td class="r">${tl(s.total)}</td></tr>`
      + (s.payment_type === 'mixed' ? `<tr><td colspan="2">&nbsp;&nbsp;Nakit ${tl(s.cash_amount)} · Kart ${tl(s.card_amount)}</td></tr>` : '')
      + (s.items || []).map(i => `<tr><td colspan="2">&nbsp;&nbsp;${esc(i.name)}</td></tr>
        <tr><td>&nbsp;&nbsp;&nbsp;&nbsp;${qtyFmt(i.qty)} ${esc(i.unit || '')} x ${tl(i.price)}</td><td class="r">${tl(i.total)}</td></tr>`).join('')
      + (Number(s.discount) > 0 ? `<tr><td>&nbsp;&nbsp;Fiş indirimi</td><td class="r">-${tl(s.discount)}</td></tr>` : '')
      + `<tr><td colspan="2" style="height:5px"></td></tr>`).join('')}</table>`;
    const block = (title, list, sum, always) => {
      if (!list.length && !always) return '';
      return `<div class="b">${title} (${list.length})</div>
        ${list.length ? lines(list) : '<div class="small">Satış yok</div>'}
        <div class="row b"><span>${title} toplamı</span><span>${tl(sum)}</span></div><hr>`;
    };
    const sales = ok.filter(s => s.kind !== 'refund'), refunds = ok.filter(s => s.kind === 'refund');
    const of = t => sales.filter(s => s.payment_type === t);
    const sumT = l => l.reduce((a, s) => a + s.total, 0);
    const k = r.kasa || {};
    return shell(settings, `
      ${header(settings)}
      <div class="c b">GÜN SONU RAPORU</div>
      <div class="c">${esc(r.dateLabel)}</div>
      <div class="c small">Yazdırma: ${new Date().toLocaleString('tr-TR')}</div><hr>
      ${block('NAKİT SATIŞLAR', of('cash'), sumT(of('cash')), true)}
      ${block('KREDİ KARTI SATIŞLARI', of('card'), sumT(of('card')), true)}
      ${block('PARÇALI ÖDEMELER', of('mixed'), sumT(of('mixed')))}
      ${block('VERESİYE SATIŞLAR', of('credit'), sumT(of('credit')))}
      ${block('İADELER', refunds, sumT(refunds))}
      <div class="row"><span>Nakit</span><span>${tl(r.cash)}</span></div>
      <div class="row"><span>Kredi kartı</span><span>${tl(r.card)}</span></div>
      ${r.credit ? `<div class="row"><span>Veresiye</span><span>${tl(r.credit)}</span></div>` : ''}
      ${r.discountTotal ? `<div class="row small"><span>Yapılan indirimler</span><span>${tl(r.discountTotal)}</span></div>` : ''}
      ${r.refundTotal ? `<div class="row small"><span>İadeler (${r.refundCount})</span><span>-${tl(r.refundTotal)}</span></div>` : ''}
      <div class="row"><span>Satış adedi</span><span>${r.count}</span></div>
      <hr><div class="row big"><span>TOPLAM</span><span>${tl(r.total)} ₺</span></div><hr>
      ${r.cancelled ? `<div class="row small"><span>İptal edilen (${r.cancelled})</span><span>${tl(r.cancelledTotal)}</span></div><hr>` : ''}
      <div class="b">KASA</div>
      <div class="row"><span>Açılış</span><span>${tl(k.opening || 0)}</span></div>
      <div class="row"><span>Nakit satış (net)</span><span>${tl(r.cash)}</span></div>
      ${k.collectCash ? `<div class="row"><span>Veresiye tahsilatı</span><span>${tl(k.collectCash)}</span></div>` : ''}
      ${(k.ins || []).map(m => `<div class="row small"><span>+ ${esc(m.note || 'Para girişi')}</span><span>${tl(m.amount)}</span></div>`).join('')}
      ${(k.outs || []).map(m => `<div class="row small"><span>- ${esc(m.note || 'Para çıkışı')}</span><span>-${tl(m.amount)}</span></div>`).join('')}
      <div class="row b"><span>Kasada olması gereken</span><span>${tl(k.expected || 0)}</span></div>
      ${k.count ? `<div class="row"><span>Sayılan (${tm(k.count.created_at)})</span><span>${tl(k.count.amount)}</span></div>
        <div class="row b"><span>Fark</span><span>${(k.count.amount - k.expected) >= 0 ? '+' : ''}${tl(k.count.amount - k.expected)}</span></div>` : '<div class="small">Kasa sayımı yapılmadı</div>'}
      ${k.collectCard ? `<div class="row small"><span>Kartla tahsilat</span><span>${tl(k.collectCard)}</span></div>` : ''}
      <hr>
      ${(r.byCashier || []).length > 1 ? `<div class="b">KASİYERLER</div>${r.byCashier.map(c => `<div class="row small"><span>${esc(c.name)} (${c.n})</span><span>${tl(c.total)}</span></div>`).join('')}<hr>` : ''}
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
      const x = days.get(k) || { cash: 0, card: 0, credit: 0, n: 0 };
      const p = payOf(s); x.cash += p.cash; x.card += p.card; x.credit += p.credit; if (s.kind !== 'refund') x.n++; days.set(k, x);
    });
    const rows = d.sales.slice().sort((a, b) => a.created_at.localeCompare(b.created_at)).map(s => {
      const t = new Date(s.created_at);
      const items = s.items.map(i => `${esc(i.name)} × ${qtyFmt(i.qty)}`).join(', ');
      return `<tr class="${s.status !== 'completed' ? 'x' : ''}"><td>${t.toLocaleDateString('tr-TR')}</td><td>${t.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}</td>
        <td>#${s.sale_no}</td><td>${payLabel(s)}${s.customer_name ? ' · ' + esc(s.customer_name) : ''}${s.status !== 'completed' ? ' (iptal)' : ''}</td><td class="it">${items}</td><td class="r">${tl(s.total)}</td></tr>`;
    }).join('');
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      @page { size: A4; margin: 12mm; }
      body { font: 10.5pt/1.35 "Segoe UI", Arial, sans-serif; color: #111; margin: 0; }
      h1 { font-size: 17pt; margin: 0; } .sub { color: #555; margin: 2px 0 12px; }
      .cards { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; margin-bottom: 14px; }
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
        <div class="card">Kredi kartı<b>${tl(d.card)} ₺</b></div><div class="card">Veresiye<b>${tl(d.credit || 0)} ₺</b></div><div class="card">Satış adedi<b>${d.count}</b></div>
        <div class="card">İptal<b>${d.cancelled} · ${tl(d.cancelledTotal)} ₺</b></div></div>
      <h2>Günlük özet</h2>
      <table><thead><tr><th>Gün</th><th class="r">Satış</th><th class="r">Nakit</th><th class="r">Kart</th><th class="r">Veresiye</th><th class="r">Toplam</th></tr></thead><tbody>
      ${[...days].map(([k, x]) => `<tr><td>${k}</td><td class="r">${x.n}</td><td class="r">${tl(x.cash)}</td><td class="r">${tl(x.card)}</td><td class="r">${tl(x.credit)}</td><td class="r">${tl(x.cash + x.card + x.credit)}</td></tr>`).join('')}
      </tbody><tfoot><tr><td>Toplam</td><td class="r">${d.count}</td><td class="r">${tl(d.cash)}</td><td class="r">${tl(d.card)}</td><td class="r">${tl(d.credit || 0)}</td><td class="r">${tl(d.total)}</td></tr></tfoot></table>
      <h2>Tüm satışlar</h2>
      <table><thead><tr><th>Tarih</th><th>Saat</th><th>Fiş</th><th>Ödeme</th><th>Ürünler</th><th class="r">Tutar</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="foot">Bu rapor bilgi amaçlıdır. Hızlı Kasa · ${esc(d.month)}</div>
    </body></html>`;
  }

  return { sale, dayReport, monthA4, test, collect, statement, payOf, payLabel, PAY_LABEL };
})();
