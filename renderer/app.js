// Hızlı Kasa - arayüz ve iş mantığı
(() => {
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const r3 = n => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
  const money = n => Number(n || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₺';
  const qtyFmt = n => Number(n || 0).toLocaleString('tr-TR', { maximumFractionDigits: 3 });
  const uuid = () => crypto.randomUUID();
  const nowIso = () => new Date().toISOString();
  const lower = s => String(s || '').toLocaleLowerCase('tr-TR');
  function parseNum(v) {
    let s = String(v ?? '').trim().replace(/\s|₺/g, '');
    if (s.includes('.') && s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(',', '.');
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  }

  // ---------- Durum ----------
  const products = new Map();   // id -> ürün
  const byBarcode = new Map();  // barkod -> id
  let cart = [];
  let settings = {};
  let saleNo = 0;
  let deviceId = '';
  let lastSale = null;
  let currentTab = 'sale';

  const DEFAULT_SETTINGS = { storeName: '', storeAddress: '', storePhone: '', footer: 'Bizi tercih ettiğiniz için teşekkürler', printer: '', paper: '80', autoPrint: true };

  function indexProduct(p) {
    const old = products.get(p.id);
    if (old && old.barcode && old.barcode !== p.barcode && byBarcode.get(old.barcode) === p.id) byBarcode.delete(old.barcode);
    products.set(p.id, p);
    if (p.barcode) byBarcode.set(p.barcode, p.id);
  }

  async function loadAll() {
    products.clear(); byBarcode.clear();
    (await DB.all('products')).forEach(indexProduct);
    settings = { ...DEFAULT_SETTINGS, ...(await DB.getMeta('settings', {})) };
    saleNo = await DB.getMeta('sale_no', 0);
    deviceId = await DB.getMeta('device_id', '');
    if (!deviceId) { deviceId = 'KASA-' + uuid().slice(0, 8).toUpperCase(); await DB.setMeta('device_id', deviceId); }
    $('#brand').textContent = settings.storeName || 'Hızlı Kasa';
    // Kategorisi olmayan ürünlere addan tahmini kategori ata (bir kez)
    const missing = [...products.values()].filter(p => !p.category);
    if (missing.length) {
      const ts = nowIso();
      const rows = missing.map(p => ({ ...p, category: Importer.guessCategory(p.name), updated_at: ts }));
      for (let i = 0; i < rows.length; i += 300) {
        const part = rows.slice(i, i + 300);
        await DB.write(part.map(value => ({ store: 'products', value })), part.map(row => ({ table: 'products', row })));
      }
      rows.forEach(indexProduct);
    }
  }
  const catOf = p => p.category || Importer.guessCategory(p.name);
  function allCategories() {
    const set = new Set([...products.values()].filter(p => p.active).map(catOf));
    const known = Importer.CATEGORIES.filter(c => set.has(c));
    const extra = [...set].filter(c => !Importer.CATEGORIES.includes(c)).sort((a, b) => a.localeCompare(b, 'tr'));
    const order = [...known.filter(c => c !== 'Diğer'), ...extra, ...known.filter(c => c === 'Diğer')];
    return order;
  }

  // ---------- Bildirim & modal ----------
  function toast(msg, type = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), type === 'err' ? 4500 : 2600);
  }
  function beep(ok = true) {
    try {
      const ctx = beep.ctx || (beep.ctx = new AudioContext());
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = ok ? 1400 : 300; g.gain.value = 0.08;
      o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + (ok ? 0.07 : 0.25));
    } catch (_) {}
  }

  let modalClose = null;
  function openModal(html, onMount) {
    $('#modal').innerHTML = html;
    $('#modalBack').classList.remove('hidden');
    modalClose = null;
    if (onMount) onMount($('#modal'));
    const f = $('#modal [autofocus]') || $('#modal input, #modal select, #modal button');
    if (f) setTimeout(() => { f.focus(); if (f.select) f.select(); }, 30);
  }
  function closeModal() {
    $('#modalBack').classList.add('hidden');
    $('#modal').innerHTML = '';
    const cb = modalClose; modalClose = null;
    if (cb) cb();
    focusScan();
  }
  const modalOpen = () => !$('#modalBack').classList.contains('hidden');
  function confirmBox(title, text, okLabel = 'Evet', danger = false) {
    return new Promise(res => {
      let answered = false;
      openModal(`<h2>${esc(title)}</h2><div>${esc(text)}</div>
        <div class="btns"><button class="ghost" data-a="no">Vazgeç</button><button class="${danger ? 'danger' : 'primary'}" data-a="yes" autofocus>${esc(okLabel)}</button></div>`, m => {
        m.querySelector('[data-a=no]').onclick = () => { answered = true; closeModal(); res(false); };
        m.querySelector('[data-a=yes]').onclick = () => { answered = true; closeModal(); res(true); };
        modalClose = () => { if (!answered) res(false); };
      });
    });
  }

  // ---------- Sekmeler ----------
  // ---------- Açılış / yönetici girişi ----------
  let role = null;            // 'admin' iken yönetici sekmeleri açık
  let mode = 'home';          // 'home' | 'sale' | 'admin'
  const ADMIN_TABS = ['products', 'settings', 'security'];
  const canSee = t => !ADMIN_TABS.includes(t) || role === 'admin';

  async function sha(text) {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  const hashPass = (salt, pass) => sha(salt + ':' + pass);
  async function getAuth() {
    let a = await DB.getMeta('auth', null);
    if (!a) {
      const salt = uuid();
      a = { salt, adminUser: 'admin', adminHash: await hashPass(salt, '1234') };
      await DB.setMeta('auth', a);
    }
    return a;
  }

  function goHome() { role = null; mode = 'home'; showTab('home'); }
  function goSale() { role = null; mode = 'sale'; showTab('sale'); }
  function goLogin() { mode = 'home'; showTab('login'); $('#lgU').value = ''; $('#lgP').value = ''; setTimeout(() => $('#lgU').focus(), 30); }
  $('#goSale').onclick = goSale;
  $('#goAdmin').onclick = goLogin;
  $('#lgBack').onclick = goHome;
  $('#btnHome').onclick = goHome;
  $('#btnAdminExit').onclick = goHome;
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const a = await getAuth();
    const ok = $('#lgU').value.trim().toLocaleLowerCase('tr-TR') === a.adminUser.toLocaleLowerCase('tr-TR')
      && await hashPass(a.salt, $('#lgP').value) === a.adminHash;
    if (!ok) {
      beep(false);
      const f = $('#loginForm'); f.classList.remove('shake'); void f.offsetWidth; f.classList.add('shake');
      $('#lgP').value = ''; $('#lgP').focus();
      return toast('Kullanıcı adı veya şifre hatalı', 'err');
    }
    role = 'admin'; mode = 'admin';
    showTab('products');
  });

  function renderHeader() {
    const full = currentTab === 'home' || currentTab === 'login';
    $('#topbar').classList.toggle('hidden', full);
    document.body.classList.toggle('no-top', full);
    document.body.classList.toggle('mode-admin', mode === 'admin');
    document.querySelectorAll('#navTabs button').forEach(b => {
      const m = b.dataset.mode;
      b.classList.toggle('hidden', !(m === 'both' || m === mode));
    });
    $('#btnHome').classList.toggle('hidden', mode !== 'sale');
    $('#btnAdminExit').classList.toggle('hidden', mode !== 'admin');
    if (currentTab === 'home') {
      $('#homeStore').textContent = settings.storeName || 'SATIŞ SİSTEMİ';
      $('#homeFoot').textContent = window.kasa ? '' : '';
    }
  }

  $('#btnSecAdmin').onclick = async () => {
    if (role !== 'admin') return;
    const a = await getAuth();
    if (await hashPass(a.salt, $('#secAdminCur').value) !== a.adminHash) return toast('Mevcut şifre hatalı', 'err');
    const name = $('#secAdminName').value.trim(), p1 = $('#secAdminNew').value, p2 = $('#secAdminNew2').value;
    if (!name) return toast('Kullanıcı adı boş olamaz', 'err');
    if (p1 || p2) {
      if (p1.length < 4) return toast('Şifre en az 4 karakter olmalı', 'err');
      if (p1 !== p2) return toast('Şifreler aynı değil', 'err');
      a.adminHash = await hashPass(a.salt, p1);
    }
    a.adminUser = name;
    await DB.setMeta('auth', a);
    ['#secAdminCur', '#secAdminNew', '#secAdminNew2'].forEach(x => $(x).value = '');
    toast('Yönetici bilgileri kaydedildi', 'ok');
  };

  function showTab(t) {
    if (!canSee(t)) return;
    currentTab = t;
    renderHeader();
    document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
    document.querySelectorAll('.tab').forEach(el => el.classList.toggle('active', el.id === 'tab-' + t));
    if (t === 'sale') { renderChips(); renderTiles(); focusScan(); }
    if (t === 'products') { renderProducts(); $('#prodSearch').focus(); }
    if (t === 'report') renderReport();
    if (t === 'settings') renderSettings();
    if (t === 'security') getAuth().then(a => { $('#secAdminName').value = a.adminUser; });
  }
  function focusScan() { if (currentTab === 'sale' && !modalOpen()) $('#scanInput').focus(); }

  // ---------- SATIŞ ----------
  function askPrice(p, qty) {
    openModal(`<h2>Fiyat girin</h2><div><b>${esc(p.name)}</b> ürününün satış fiyatı kayıtlı değil.</div>
      <label>Birim fiyatı (KDV dahil ₺ / ${esc(p.unit)})<input id="apP" inputmode="decimal" autofocus></label>
      <label class="chk" style="flex-direction:row"><input type="checkbox" id="apSave" checked> Bu fiyatı ürüne kaydet</label>
      <div class="btns"><button class="ghost" id="apC">Vazgeç</button><button class="primary" id="apO">Sepete ekle</button></div>`, m => {
      const ok = async () => {
        const price = r2(parseNum(m.querySelector('#apP').value));
        if (!(price > 0)) return toast('Geçerli bir fiyat girin', 'err');
        let np = { ...p, price };
        if (m.querySelector('#apSave').checked) {
          np.updated_at = nowIso();
          try { await DB.write([{ store: 'products', value: np }], [{ table: 'products', row: np }]); indexProduct(np); Sync.run(); }
          catch (e) { return toast('Kaydedilemedi: ' + e.message, 'err'); }
        }
        closeModal();
        addToCart(np, qty, true);
      };
      m.querySelector('#apO').onclick = ok;
      m.querySelector('#apC').onclick = closeModal;
      m.querySelector('#apP').onkeydown = e => { if (e.key === 'Enter') ok(); };
    });
  }

  function addToCart(p, qty = 1, priceOk = false) {
    if (!(qty > 0)) { toast('Geçersiz miktar', 'err'); beep(false); return; }
    if (!priceOk && !(p.price > 0)) { beep(false); return askPrice(p, qty); }
    let line = cart.find(l => l.product_id === p.id);
    const before = line ? line.qty : 0;
    if (line) { line.qty = r3(line.qty + qty); cart.splice(cart.indexOf(line), 1); cart.unshift(line); }
    else { line = { product_id: p.id, barcode: p.barcode, name: p.name, price: p.price, vat_rate: p.vat_rate, unit: p.unit, qty: r3(qty) }; cart.unshift(line); }
    beep(true);
    renderCart(true);
  }
  const lineTotal = l => r2(l.price * l.qty);
  const cartTotal = () => r2(cart.reduce((s, l) => s + lineTotal(l), 0));

  function renderCart(flashFirst = false) {
    $('#cartBody').innerHTML = cart.map((l, i) => {
      const p = products.get(l.product_id);
      const warn = '';
      return `<div class="ci ${i === 0 && flashFirst ? 'flash' : ''}" data-i="${i}">
        <div class="nm">${esc(l.name)}</div><div class="lt">${money(lineTotal(l))}</div>
        <div class="row2">
          <button class="qbtn minus" data-a="dec" title="Bir azalt">−</button>
          <span class="qty" data-a="edit" title="Miktarı değiştir">${qtyFmt(l.qty)}</span>
          <button class="qbtn" data-a="inc" title="Bir artır">+</button>
          <span class="up">${esc(l.unit || '')} × ${money(l.price)}${warn}</span>
          <button class="rm" data-a="rm" title="Sepetten çıkar">✕ Çıkar</button>
        </div></div>`;
    }).join('');
    $('#cartEmpty').classList.toggle('hidden', cart.length > 0);
    $('#cartTotal').textContent = money(cartTotal());
    const pieces = cart.reduce((a, l) => a + (['adet', 'paket', 'koli', 'kavanoz', 'teneke'].includes(l.unit) ? l.qty : 0), 0);
    $('#cartCount').textContent = `${cart.length} kalem${pieces ? ` · ${qtyFmt(pieces)} adet` : ''}`;
    if (flashFirst) $('#cartBody').parentElement.scrollTop = 0;
    renderTiles();
  }

  $('#cartBody').addEventListener('click', e => {
    const a = e.target.dataset.a; if (!a) return;
    const i = Number(e.target.closest('.ci').dataset.i);
    const l = cart[i]; if (!l) return;
    if (a === 'inc') l.qty = r3(l.qty + 1);
    if (a === 'dec') { l.qty = r3(l.qty - 1); if (l.qty <= 0) cart.splice(i, 1); }
    if (a === 'rm') cart.splice(i, 1);
    if (a === 'edit') return editQty(l);
    renderCart(); focusScan();
  });

  // ---------- Ürün kutuları ----------
  const WEIGHED = ['kg', 'gr', 'lt'];
  let popularity = new Map();
  let activeGroup = '';

  async function loadPopularity() {
    const since = new Date(Date.now() - 60 * 864e5).toISOString();
    const sales = await DB.range('sales', 'created_at', since, '9999');
    popularity = new Map();
    sales.filter(x => x.status === 'completed').forEach(x => x.items.forEach(i =>
      popularity.set(i.product_id, (popularity.get(i.product_id) || 0) + 1)));
  }

  const initials = name => String(name || '').replace(/[^\p{L}\s]/gu, ' ').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toLocaleUpperCase('tr-TR');

  // Fotoğrafı küçük bir resme çevirir (ürünle birlikte saklanır, internetsiz de görünür)
  async function toThumb(src, size = 220) {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const k = Math.min(size / img.naturalWidth, size / img.naturalHeight);
    const w = img.naturalWidth * k, h = img.naturalHeight * k;
    c.getContext('2d').drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    return c.toDataURL('image/webp', 0.82);
  }
  const fetchThumb = async url => toThumb(window.kasa && window.kasa.fetchImage ? await window.kasa.fetchImage(url) : url);

  function renderChips() {
    const cats = allCategories();
    if (activeGroup && !cats.includes(activeGroup)) activeGroup = '';
    const count = c => [...products.values()].filter(p => p.active && catOf(p) === c).length;
    $('#groupChips').innerHTML = cats.length ? ['', ...cats].map(g =>
      `<button data-g="${esc(g)}" class="${g === activeGroup ? 'on' : ''}">${g ? `${esc(g)} <span class="cnt">${count(g)}</span>` : 'Tümü'}</button>`).join('') : '';
  }
  $('#groupChips').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    activeGroup = b.dataset.g; renderChips(); renderTiles(); focusScan();
  });

  function renderTiles() {
    const raw = $('#scanInput').value.trim().replace(/^\d+(?:[.,]\d+)?\s*[*xX]\s*/, '');
    const q = lower(raw);
    const inCart = new Map(cart.map(l => [l.product_id, l.qty]));
    let list = [...products.values()].filter(p => p.active && (!activeGroup || catOf(p) === activeGroup))
      .filter(p => !q || lower(p.name).includes(q) || (p.barcode || '').includes(raw) || (p.code || '') === raw);
    list.sort((a, b) => (popularity.get(b.id) || 0) - (popularity.get(a.id) || 0) || a.name.localeCompare(b.name, 'tr'));
    const total = list.length;
    list = list.slice(0, 240);
    $('#tiles').innerHTML = list.map(p => {
      const c = inCart.get(p.id);
      return `<button class="tile ${c ? 'in' : ''}" data-id="${p.id}" title="${esc(p.name)}">
        <span class="ph">${p.image ? `<img src="${p.image}" alt="" loading="lazy">` : `<span class="ph-x">${esc(initials(p.name))}</span>`}</span>
        ${c ? `<span class="badge">${qtyFmt(c)} ${esc(p.unit)}</span>` : ''}
        <span class="n">${esc(p.name)}</span>
        <span class="f"><span class="p ${p.price > 0 ? '' : 'none'}">${p.price > 0 ? money(p.price) : 'Fiyat yok'}</span>
        <span class="s">${esc(p.unit)}</span></span></button>`;
    }).join('') + (total > 240 ? `<div class="none">${total - 240} ürün daha var — aramayı daraltın</div>` : '')
      || `<div class="none">${products.size ? 'Eşleşen ürün yok' : 'Henüz ürün yok — Ürünler (F2) ekranından ekleyin'}</div>`;
  }
  $('#tiles').addEventListener('click', e => {
    const t = e.target.closest('.tile'); if (!t) return;
    const p = products.get(t.dataset.id); if (!p) return;
    if (WEIGHED.includes(p.unit)) askQty(p); else { addToCart(p, 1); focusScan(); }
  });
  $('#scanInput').addEventListener('input', () => renderTiles());

  function askQty(p) {
    openModal(`<h2>${esc(p.name)}</h2>
      <label>Miktar (${esc(p.unit)})<input id="aq" inputmode="decimal" autofocus placeholder="ör. 0,5"></label>
      <div class="btns"><button class="ghost" id="aqC">Vazgeç</button><button class="primary" id="aqO">Sepete ekle</button></div>`, m => {
      const ok = () => {
        const q = parseNum(m.querySelector('#aq').value);
        if (!(q > 0)) return toast('Geçerli bir miktar girin', 'err');
        closeModal(); addToCart(p, r3(q));
      };
      m.querySelector('#aqO').onclick = ok;
      m.querySelector('#aqC').onclick = closeModal;
      m.querySelector('#aq').onkeydown = e => { if (e.key === 'Enter') ok(); };
    });
  }

  function editQty(l) {
    openModal(`<h2>${esc(l.name)}</h2><label>Miktar (${esc(l.unit)})<input id="mq" value="${String(l.qty).replace('.', ',')}" autofocus></label>
      <div class="btns"><button class="ghost" id="mc">Vazgeç</button><button class="primary" id="mo">Tamam</button></div>`, m => {
      const ok = () => {
        const q = parseNum(m.querySelector('#mq').value);
        if (!(q >= 0)) return toast('Geçersiz miktar', 'err');
        if (q === 0) cart.splice(cart.indexOf(l), 1); else l.qty = r3(q);
        closeModal(); renderCart();
      };
      m.querySelector('#mo').onclick = ok;
      m.querySelector('#mc').onclick = closeModal;
      m.querySelector('#mq').onkeydown = e => { if (e.key === 'Enter') ok(); };
    });
  }

  function handleScan(raw) {
    let text = raw.trim(); if (!text) return;
    let qty = 1;
    const mq = text.match(/^(\d+(?:[.,]\d+)?)\s*[*xX]\s*(.+)$/);
    if (mq) { qty = parseNum(mq[1]); text = mq[2].trim(); }
    const id = byBarcode.get(text);
    if (id) {
      const p = products.get(id);
      if (!p.active) { beep(false); return toast(`"${p.name}" pasif durumda. Ürünler ekranından aktif edin.`, 'err'); }
      return addToCart(p, qty);
    }
    const byCode = [...products.values()].find(p => p.active && p.code && p.code === text);
    if (byCode) return addToCart(byCode, qty);
    const q = lower(text);
    const found = [...products.values()].filter(p => p.active && (lower(p.name).includes(q) || (p.barcode || '').includes(text)));
    if (found.length === 1) return addToCart(found[0], qty);
    if (found.length > 1) return pickProduct(found.slice(0, 50), qty);
    beep(false);
    if (/^\d{3,}$/.test(text)) return productForm(null, { barcode: text, afterSave: p => addToCart(p, qty) });
    toast('Ürün bulunamadı: ' + text, 'err');
  }

  function pickProduct(list, qty) {
    let sel = 0;
    openModal(`<h2>Ürün seçin</h2><div class="pick">${list.map((p, i) =>
      `<button data-i="${i}" class="${i === 0 ? 'sel' : ''}"><span>${esc(p.name)}</span><span>${money(p.price)}</span></button>`).join('')}</div>
      <div class="hint">↑ ↓ ile seçip Enter'a basın</div>`, m => {
      const btns = [...m.querySelectorAll('.pick button')];
      btns.forEach(b => b.onclick = () => { closeModal(); addToCart(list[Number(b.dataset.i)], qty); });
      m.onkeydown = e => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length;
          btns.forEach((b, i) => b.classList.toggle('sel', i === sel)); btns[sel].focus();
        }
      };
    });
  }

  $('#scanInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') { const v = e.target.value; e.target.value = ''; renderTiles(); handleScan(v); }
    else if (e.key === 'Escape') { e.target.value = ''; renderTiles(); }
    else if (e.key === 'Delete' && !e.target.value && cart.length) { cart.shift(); renderCart(); }
  });
  document.addEventListener('click', e => {
    if (currentTab === 'sale' && !modalOpen() && !e.target.closest('input,button,select,textarea')) focusScan();
  });

  const AWAIT = `<div class="await-pill"><span class="dot"></span>Ödeme onayı bekleniyor</div>`;

  function payCash() {
    if (!cart.length) return toast('Sepet boş', 'warn');
    const total = cartTotal();
    const notes = [...new Set([total, 50, 100, 200, 500, 1000].map(Number))].filter(n => n >= total).slice(0, 8);
    openModal(`${AWAIT}<h2>Nakit ödeme</h2><div class="big-total">${money(total)}</div>
      <label>Alınan para (boş bırakılırsa tam tutar)<input id="cg" inputmode="decimal" autofocus></label>
      <div class="quick">${notes.map(n => `<button data-v="${n}">${n === total ? 'Tam' : n.toLocaleString('tr-TR')}</button>`).join('')}</div>
      <div>Para üstü</div><div class="change-v" id="chg">0,00 ₺</div>
      <div class="hint">Parayı müşteriden aldıktan sonra onaylayın.</div>
      <div class="btns"><button class="ghost" id="cc">Vazgeç (Esc)</button><button class="primary confirm" id="co">✓ Ödemeyi aldım, onaylıyorum</button></div>`, m => {
      m.classList.add('pay-modal');
      modalClose = () => m.classList.remove('pay-modal');
      const inp = m.querySelector('#cg');
      const calc = () => {
        const v = inp.value.trim() === '' ? total : parseNum(inp.value);
        const c = r2(v - total);
        const el = m.querySelector('#chg');
        el.textContent = Number.isFinite(c) ? money(c) : '—';
        el.classList.toggle('bad', !(c >= 0));
        return { v, c };
      };
      const ok = async () => {
        const { v, c } = calc();
        if (!(c >= 0)) { beep(false); return toast('Alınan tutar toplamdan az', 'err'); }
        closeModal();
        await completeSale('cash', r2(v), c);
      };
      inp.oninput = calc;
      inp.onkeydown = e => { if (e.key === 'Enter') ok(); };
      m.querySelectorAll('.quick button').forEach(b => b.onclick = () => { inp.value = String(b.dataset.v).replace('.', ','); calc(); m.querySelector('#co').focus(); });
      m.querySelector('#co').onclick = ok;
      m.querySelector('#cc').onclick = closeModal;
      m.onkeydown = e => { if (e.key === 'F8') { e.preventDefault(); e.stopPropagation(); ok(); } };
    });
  }

  function payCard() {
    if (!cart.length) return toast('Sepet boş', 'warn');
    const total = cartTotal();
    openModal(`${AWAIT}<h2>Kart / POS ödemesi</h2>
      <div class="big-total">${money(total)}</div>
      <div class="pos-hint"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M8 6h8v4H8z"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01"/></svg>
        <span>Tutarı POS cihazından çekin. Ödeme onaylandıktan sonra aşağıdaki düğmeye basın.</span></div>
      <div class="btns"><button class="ghost" id="kc">Vazgeç (Esc)</button><button class="primary confirm" id="ko">✓ Ödemeyi aldım, onaylıyorum <kbd>F9</kbd></button></div>`, m => {
      m.classList.add('pay-modal');
      modalClose = () => m.classList.remove('pay-modal');
      const ok = async () => { closeModal(); await completeSale('card', null, null); };
      m.querySelector('#ko').onclick = ok;
      m.querySelector('#kc').onclick = closeModal;
      m.tabIndex = -1;
      setTimeout(() => m.focus(), 40);          // Enter/barkod okuyucu yanlışlıkla onaylamasın
      m.onkeydown = e => { if (e.key === 'F9') { e.preventDefault(); e.stopPropagation(); ok(); } };
    });
  }

  let saving = false;
  async function completeSale(type, given, change) {
    if (saving || !cart.length) return;
    saving = true;
    try {
      const ts = nowIso();
      const no = saleNo + 1;
      const items = cart.slice().reverse().map(l => ({
        product_id: l.product_id, barcode: l.barcode, name: l.name, unit: l.unit,
        qty: l.qty, price: l.price, vat_rate: l.vat_rate, total: lineTotal(l)
      }));
      const sale = {
        id: uuid(), sale_no: no, created_at: ts, items, total: cartTotal(),
        payment_type: type, cash_given: given, change_amount: change,
        status: 'completed', cancelled_at: null, device: deviceId
      };
      const ops = [{ store: 'sales', value: sale }, { store: 'meta', value: { key: 'sale_no', value: no } }];
      const sync = [{ table: 'sales', row: sale }];
      const updated = [];
      await DB.write(ops, sync);
      saleNo = no;
      updated.forEach(indexProduct);
      lastSale = sale;
      items.forEach(i => popularity.set(i.product_id, (popularity.get(i.product_id) || 0) + 1));
      cart = [];
      renderCart(); renderLastSale();
      toast(`Satış #${no} kaydedildi — ${money(sale.total)}`, 'ok');
      if (settings.autoPrint) printSale(sale);
      Sync.run();
    } catch (e) {
      console.error(e);
      toast('Satış kaydedilemedi: ' + e.message, 'err');
    } finally { saving = false; focusScan(); }
  }

  function renderLastSale() {
    const s = lastSale;
    if (!s) { $('#lastSale').innerHTML = ''; return; }
    $('#lastSale').innerHTML = `Son satış <b>#${s.sale_no}</b> · ${s.payment_type === 'cash' ? 'Nakit' : 'Kart'} · <b>${money(s.total)}</b>
      ${s.payment_type === 'cash' && s.change_amount > 0 ? `<div>Para üstü</div><div class="change">${money(s.change_amount)}</div>` : ''}
      <div style="margin-top:8px"><button class="ghost" id="reprint">Fişi yazdır</button></div>`;
    $('#reprint').onclick = () => printSale(s);
  }

  // ---------- Yazdırma ----------
  async function printHtml(html) {
    try {
      if (window.kasa) {
        const r = await window.kasa.printHtml(html, { deviceName: settings.printer });
        if (!r.success && r.reason && r.reason !== 'cancelled') toast('Yazdırılamadı: ' + r.reason, 'err');
      } else {
        const w = window.open('', '_blank'); w.document.write(html); w.document.close(); w.print();
      }
    } catch (e) { toast('Yazdırma hatası: ' + e.message, 'err'); }
  }
  const printSale = s => printHtml(Receipt.sale(s, settings));

  // ---------- ÜRÜNLER ----------
  function ean13Internal() {
    // Mağaza içi barkod: 2 ile başlar, 13 hane, kontrol haneli
    for (;;) {
      let s = '2' + String(Date.now()).slice(-7) + String(Math.floor(Math.random() * 10000)).padStart(4, '0');
      s = s.slice(0, 12);
      const sum = [...s].reduce((a, d, i) => a + Number(d) * (i % 2 ? 3 : 1), 0);
      const code = s + ((10 - (sum % 10)) % 10);
      if (!byBarcode.has(code)) return code;
    }
  }

  function productForm(p, opts = {}) {
    const isNew = !p;
    const v = p || { barcode: opts.barcode || '', name: '', price: '', vat_rate: 10, unit: 'adet', stock: 0, min_stock: 0, code: '', group: '' };
    const units = [...new Set(['adet', 'kg', 'gr', 'paket', 'kavanoz', 'koli', 'lt', 'teneke', v.unit].filter(Boolean))];
    openModal(`<h2>${isNew ? 'Yeni ürün' : 'Ürünü düzenle'}</h2>
      <div class="img-row"><div class="img-prev" id="fImgPrev">${v.image ? `<img src="${v.image}" alt="">` : '<span>Fotoğraf yok</span>'}</div>
        <div class="img-acts"><button type="button" class="ghost" id="fImgFile">Bilgisayardan seç</button>
          <button type="button" class="ghost" id="fImgSite">halisfindik.com'dan bul</button>
          <button type="button" class="ghost" id="fImgDel">Kaldır</button><input type="file" id="fImgInput" accept="image/*" hidden></div></div>
      <label>Barkod
        <div style="display:flex;gap:6px"><input id="fBarcode" style="flex:1" value="${esc(v.barcode)}"><button class="ghost" id="fGen" type="button">Barkod üret</button></div>
      </label>
      <label>Ürün adı<input id="fName" value="${esc(v.name)}" ${opts.barcode || !isNew ? 'autofocus' : ''}></label>
      <div class="two">
        <label>Stok kodu (isteğe bağlı)<input id="fCode" value="${esc(v.code || '')}"></label>
        <label>Kategori (satış ekranı)<input id="fCat" list="catList" value="${esc(v.category || (v.name ? Importer.guessCategory(v.name) : ''))}" placeholder="ör. Fındık Ezmesi"></label>
      </div>
      <div class="two">
        <label>Satış fiyatı (KDV dahil ₺)<input id="fPrice" inputmode="decimal" value="${v.price === '' ? '' : String(v.price).replace('.', ',')}"></label>
        <label>KDV %<select id="fVat">${[0, 1, 10, 20].map(r => `<option ${Number(v.vat_rate) === r ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
      </div>
      <div class="two">
        <label>Birim<select id="fUnit">${units.map(u => `<option ${v.unit === u ? 'selected' : ''}>${u}</option>`).join('')}</select></label>

      </div>
      <div class="btns"><button class="ghost" id="fCancel">Vazgeç</button><button class="primary" id="fSave">Kaydet (Enter)</button></div>`, m => {
      m.querySelector('#fGen').onclick = () => { m.querySelector('#fBarcode').value = ean13Internal(); };
      let image = v.image || null;
      const showImg = () => { m.querySelector('#fImgPrev').innerHTML = image ? `<img src="${image}" alt="">` : '<span>Fotoğraf yok</span>'; };
      m.querySelector('#fImgFile').onclick = () => m.querySelector('#fImgInput').click();
      m.querySelector('#fImgInput').onchange = async e => {
        const f = e.target.files[0]; if (!f) return;
        const url = URL.createObjectURL(f);
        try { image = await toThumb(url); showImg(); } catch (_) { toast('Resim okunamadı', 'err'); } finally { URL.revokeObjectURL(url); }
      };
      m.querySelector('#fImgSite').onclick = async () => {
        const u = SiteImages.urlFor(m.querySelector('#fName').value);
        if (!u) return toast('Bu ürün adı için halisfindik.com fotoğrafı bulunamadı', 'warn');
        try { image = await fetchThumb(u); showImg(); } catch (e) { toast('İndirilemedi (internet bağlantısını kontrol edin)', 'err'); }
      };
      m.querySelector('#fImgDel').onclick = () => { image = null; showImg(); };
      m.querySelector('#fCancel').onclick = closeModal;
      const save = async () => {
        const barcode = m.querySelector('#fBarcode').value.trim();
        const name = m.querySelector('#fName').value.trim();
        const price = parseNum(m.querySelector('#fPrice').value);
        const min = Number(v.min_stock) || 0;
        const stock = Number(v.stock) || 0;
        if (!name) return toast('Ürün adı gerekli', 'err');
        if (!(price >= 0)) return toast('Geçerli bir fiyat girin', 'err');
        if (!Number.isFinite(stock) || !Number.isFinite(min)) return toast('Stok değerlerini kontrol edin', 'err');
        if (barcode && byBarcode.has(barcode) && byBarcode.get(barcode) !== (p && p.id)) {
          return toast('Bu barkod başka bir ürüne kayıtlı: ' + products.get(byBarcode.get(barcode)).name, 'err');
        }
        const ts = nowIso();
        const code = m.querySelector('#fCode').value.trim();
        if (code && [...products.values()].some(x => x.code === code && x.id !== (p && p.id))) return toast('Bu stok kodu başka bir üründe kullanılıyor', 'err');
        const row = {
          ...(p || {}),
          id: p ? p.id : uuid(), barcode: barcode || null, name, price: r2(price),
          code: code || null, group: v.group || null,
          category: m.querySelector('#fCat').value.trim() || Importer.guessCategory(name),
          image: image || null,
          stock: r3(stock), vat_rate: Number(m.querySelector('#fVat').value), unit: m.querySelector('#fUnit').value,
          min_stock: r3(min), active: p ? p.active : true, updated_at: ts
        };
        const ops = [{ store: 'products', value: row }], sync = [{ table: 'products', row }];
        if (false) {
          const mv = { id: uuid(), product_id: row.id, qty: row.stock, reason: 'Açılış stoğu', ref_id: null, created_at: ts };
          ops.push({ store: 'stock_moves', value: mv }); sync.push({ table: 'stock_moves', row: mv });
        }
        try {
          await DB.write(ops, sync);
          indexProduct(row);
          cart.forEach(l => { if (l.product_id === row.id) Object.assign(l, { name: row.name, price: row.price, vat_rate: row.vat_rate, unit: row.unit, barcode: row.barcode }); });
          closeModal();
          toast('Ürün kaydedildi', 'ok');
          if (currentTab === 'products') renderProducts();
          renderCart();
          if (opts.afterSave) opts.afterSave(row);
          Sync.run();
        } catch (e) { toast('Kaydedilemedi: ' + e.message, 'err'); }
      };
      m.querySelector('#fSave').onclick = save;
      m.querySelectorAll('input').forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter' && i.id !== 'fBarcode') save(); }));
      m.querySelector('#fBarcode').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); m.querySelector('#fName').focus(); } });
    });
  }

  function stockForm(p) {
    openModal(`<h2>Stok hareketi</h2><div><b>${esc(p.name)}</b><br>Mevcut stok: <b>${qtyFmt(p.stock)} ${esc(p.unit)}</b></div>
      <label>İşlem<select id="sType"><option value="in">Mal girişi (+)</option><option value="set">Sayım: stoğu şu değere eşitle</option><option value="out">Fire / çıkış (−)</option></select></label>
      <label>Miktar<input id="sQty" inputmode="decimal" autofocus></label>
      <label>Açıklama (isteğe bağlı)<input id="sNote"></label>
      <div class="btns"><button class="ghost" id="sC">Vazgeç</button><button class="primary" id="sO">Kaydet</button></div>`, m => {
      m.querySelector('#sC').onclick = closeModal;
      const ok = async () => {
        const t = m.querySelector('#sType').value;
        const q = parseNum(m.querySelector('#sQty').value);
        if (!Number.isFinite(q) || (t !== 'set' && q <= 0)) return toast('Geçerli bir miktar girin', 'err');
        const delta = r3(t === 'in' ? q : t === 'out' ? -q : q - p.stock);
        if (delta === 0) { closeModal(); return; }
        const note = m.querySelector('#sNote').value.trim();
        const reason = ({ in: 'Mal girişi', out: 'Fire/çıkış', set: 'Sayım düzeltme' })[t] + (note ? ' - ' + note : '');
        const ts = nowIso();
        const np = { ...p, stock: r3(p.stock + delta), updated_at: ts };
        const mv = { id: uuid(), product_id: p.id, qty: delta, reason, ref_id: null, created_at: ts };
        try {
          await DB.write([{ store: 'products', value: np }, { store: 'stock_moves', value: mv }],
            [{ table: 'products', row: np }, { table: 'stock_moves', row: mv }]);
          indexProduct(np); closeModal(); renderProducts(); toast('Stok güncellendi', 'ok'); Sync.run();
        } catch (e) { toast('Kaydedilemedi: ' + e.message, 'err'); }
      };
      m.querySelector('#sO').onclick = ok;
      m.querySelector('#sQty').onkeydown = e => { if (e.key === 'Enter') ok(); };
    });
  }

  async function toggleActive(p) {
    const np = { ...p, active: !p.active, updated_at: nowIso() };
    await DB.write([{ store: 'products', value: np }], [{ table: 'products', row: np }]);
    indexProduct(np); renderProducts(); Sync.run();
  }

  const isLow = p => p.active && (p.stock <= 0 || (p.min_stock > 0 && p.stock <= p.min_stock));

  const selected = new Set();
  let listed = [];

  function renderProducts() {
    const q = lower($('#prodSearch').value.trim());
    const showPassive = $('#showPassive').checked, onlyNoPrice = $('#onlyNoPrice').checked;
    listed = [...products.values()]
      .filter(p => (showPassive || p.active) && (!onlyNoPrice || !(p.price > 0)))
      .filter(p => !q || lower(p.name).includes(q) || (p.barcode || '').includes(q) || lower(p.code).includes(q) || lower(p.group).includes(q) || lower(catOf(p)).includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, 'tr'));
    for (const id of [...selected]) if (!products.has(id)) selected.delete(id);
    const shown = listed.slice(0, 500);
    $('#prodBody').innerHTML = shown.map(p => `<tr class="${p.active ? '' : 'passive'} ${selected.has(p.id) ? 'sel' : ''}" data-id="${p.id}">
      <td class="cb"><input type="checkbox" data-a="sel" ${selected.has(p.id) ? 'checked' : ''}></td>
      <td>${esc(p.code || '')}</td><td>${esc(p.barcode || '—')}</td><td><span class="pname">${p.image ? `<img src="${p.image}" alt="">` : '<i></i>'}${esc(p.name)}</span></td><td><span class="cat-tag">${esc(catOf(p))}</span></td>
      <td class="num ${p.price > 0 ? '' : 'noprice'}">${p.price > 0 ? money(p.price) : 'Fiyat yok'}</td><td class="num">%${p.vat_rate}</td>
<td>${esc(p.unit)}</td>
      <td><div class="acts"><button data-a="edit">Düzenle</button>
        <button data-a="toggle" class="ghost">${p.active ? 'Pasif yap' : 'Aktif yap'}</button>
        <button data-a="del" class="ghost" title="Sil" style="color:#f87171">Sil</button></div></td></tr>`).join('');
    const all = [...products.values()];
    const noPrice = all.filter(p => p.active && !(p.price > 0)).length;
    $('#prodFoot').textContent = `${listed.length} ürün listelendi${listed.length > 500 ? ' (ilk 500 gösteriliyor, aramayı daraltın)' : ''} · Toplam ${products.size} ürün · Fiyatsız ${noPrice}`;
    $('#selAll').checked = listed.length > 0 && listed.every(p => selected.has(p.id));
    $('#btnDeleteSel').classList.toggle('hidden', selected.size === 0);
    $('#btnCatSel').classList.toggle('hidden', selected.size === 0);
    $('#btnCatSel').textContent = `Kategori ata (${selected.size})`;
    $('#catList').innerHTML = [...new Set([...Importer.CATEGORIES, ...allCategories()])].map(c => `<option value="${esc(c)}">`).join('');
    $('#btnDeleteSel').textContent = `Seçilenleri sil (${selected.size})`;
  }
  $('#prodBody').addEventListener('click', e => {
    const a = e.target.dataset.a; if (!a) return;
    const p = products.get(e.target.closest('tr').dataset.id); if (!p) return;
    if (a === 'sel') { e.target.checked ? selected.add(p.id) : selected.delete(p.id); return renderProducts(); }
    if (a === 'edit') productForm(p);
    if (a === 'toggle') toggleActive(p);
    if (a === 'del') deleteProducts([p.id]);
  });
  $('#selAll').addEventListener('change', e => {
    listed.forEach(p => e.target.checked ? selected.add(p.id) : selected.delete(p.id));
    renderProducts();
  });
  $('#btnDeleteSel').onclick = () => deleteProducts([...selected]);
  $('#btnPhotos').onclick = () => {
    const all = [...products.values()].filter(p => p.active);
    const matchable = all.filter(p => SiteImages.urlFor(p.name));
    const missing = matchable.filter(p => !p.image);
    openModal(`<h2>halisfindik.com fotoğrafları</h2>
      <div class="hint">Ürün adlarına göre sitedeki fotoğraflar eşleştirilir, küçültülüp ürünle birlikte kaydedilir (internet olmadan da görünür).
      Fotoğrafı sitede olmayan ürünler (çikolatalı, krema, püre vb.) atlanır; bunlara Düzenle'den kendiniz fotoğraf ekleyebilirsiniz.</div>
      <div><b>${matchable.length}</b> ürün eşleşti · <b>${missing.length}</b> tanesinin fotoğrafı yok.</div>
      <label class="chk" style="flex-direction:row"><input type="checkbox" id="phAll"> Fotoğrafı olan ürünleri de yenile</label>
      <div class="hint" id="phProg"></div>
      <div class="btns"><button class="ghost" id="phC">Kapat</button><button class="primary" id="phO">Fotoğrafları indir</button></div>`, m => {
      m.querySelector('#phC').onclick = closeModal;
      m.querySelector('#phO').onclick = async () => {
        const list = m.querySelector('#phAll').checked ? matchable : missing;
        if (!list.length) return toast('İndirilecek fotoğraf yok', 'warn');
        const btn = m.querySelector('#phO'); btn.disabled = true;
        const prog = m.querySelector('#phProg');
        const cache = new Map(); const ts = nowIso(); const rows = []; let fail = 0;
        for (const p of list) {
          const u = SiteImages.urlFor(p.name);
          prog.textContent = `İndiriliyor… ${rows.length + fail + 1} / ${list.length}`;
          try {
            if (!cache.has(u)) cache.set(u, await fetchThumb(u));
            rows.push({ ...p, image: cache.get(u), updated_at: ts });
          } catch (_) { fail++; }
        }
        try {
          for (let i = 0; i < rows.length; i += 100) {
            const part = rows.slice(i, i + 100);
            await DB.write(part.map(value => ({ store: 'products', value })), part.map(row => ({ table: 'products', row })));
          }
          rows.forEach(indexProduct);
          closeModal(); renderProducts();
          toast(`${rows.length} ürüne fotoğraf eklendi${fail ? `, ${fail} tanesi indirilemedi (internet?)` : ''}`, fail ? 'warn' : 'ok');
          Sync.run();
        } catch (e) { toast('Kaydedilemedi: ' + e.message, 'err'); btn.disabled = false; }
      };
    });
  };
  $('#btnCatSel').onclick = () => {
    const ids = [...selected].filter(id => products.has(id));
    if (!ids.length) return;
    const cats = [...new Set([...Importer.CATEGORIES, ...allCategories()])];
    openModal(`<h2>Kategori ata</h2><div class="hint">${ids.length} ürünün satış ekranındaki kategorisi değişecek.</div>
      <div class="cat-pick">${cats.map(c => `<button data-c="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      <label>veya yeni kategori adı<input id="newCat" placeholder="ör. Hediyelik"></label>
      <div class="btns"><button class="ghost" id="ncC">Vazgeç</button><button class="primary" id="ncO">Yeni kategoriyle kaydet</button></div>`, m => {
      const apply = async cat => {
        cat = String(cat || '').trim(); if (!cat) return toast('Kategori adı girin', 'err');
        const ts = nowIso();
        const rows = ids.map(id => ({ ...products.get(id), category: cat, updated_at: ts }));
        try {
          for (let i = 0; i < rows.length; i += 300) {
            const part = rows.slice(i, i + 300);
            await DB.write(part.map(value => ({ store: 'products', value })), part.map(row => ({ table: 'products', row })));
          }
          rows.forEach(indexProduct); selected.clear(); closeModal(); renderProducts();
          toast(`${rows.length} ürün "${cat}" kategorisine alındı`, 'ok'); Sync.run();
        } catch (e) { toast('Kaydedilemedi: ' + e.message, 'err'); }
      };
      m.querySelectorAll('.cat-pick button').forEach(b => b.onclick = () => apply(b.dataset.c));
      m.querySelector('#ncO').onclick = () => apply(m.querySelector('#newCat').value);
      m.querySelector('#ncC').onclick = closeModal;
    });
  };
  ['#prodSearch', '#showPassive', '#onlyNoPrice'].forEach(s => $(s).addEventListener('input', renderProducts));
  $('#btnNewProduct').onclick = () => productForm(null);

  async function deleteProducts(ids) {
    ids = ids.filter(id => products.has(id));
    if (!ids.length) return;
    const label = ids.length === 1 ? `"${products.get(ids[0]).name}" ürünü` : `${ids.length} ürün`;
    if (!(await confirmBox('Ürün silme', `${label} bu bilgisayardan ve buluttan kalıcı olarak silinecek. Geçmiş satış kayıtları etkilenmez.`, 'Sil', true))) return;
    try {
      for (let i = 0; i < ids.length; i += 400) {
        const part = ids.slice(i, i + 400);
        await DB.write(part.map(id => ({ store: 'products', del: id })),
          part.map(id => ({ table: 'products', row: { id }, op: 'delete' })));
      }
      ids.forEach(id => {
        const p = products.get(id);
        if (p && p.barcode && byBarcode.get(p.barcode) === id) byBarcode.delete(p.barcode);
        products.delete(id); selected.delete(id);
      });
      cart = cart.filter(l => products.has(l.product_id));
      renderCart(); renderProducts();
      toast(`${ids.length} ürün silindi`, 'ok');
      Sync.run();
    } catch (e) { toast('Silinemedi: ' + e.message, 'err'); }
  }

  // ---------- İçe aktarma (Excel .xls/.xlsx veya CSV) ----------
  const SAMPLE_ROWS = [
    ['FİYAT LİSTESİ : PERAKENDE SATIŞ FİYATLARI'],
    ['Stok Kodu', 'Stok Adı', 'BARKOD', 'KDV %', 'PERAKENDE FİYATI', 'KDV dahil mi?', 'Birimi', 'Gurubu'],
    [1, 'KAV. İÇ FINDIK', '8698985640285', 1, 1100, 'HAYIR', 'KG', 'İÇ FINDIK'],
    [2, 'PİKOLA FINDIK', '8698985640315', 1, 1120, 'HAYIR', 'KG', 'İÇ FINDIK'],
    [3, 'KROKAN', '', 1, 800, 'HAYIR', 'KG', 'KROKAN'],
    [27, 'FINDIK KROKAN 100G', '8698985640520', 1, 85, 'HAYIR', 'ADET', 'MARKET'],
    [174, 'FINDIK EZMESİ 500 G', '8698985641734', 1, 340, 'HAYIR', 'ADET', 'MARKET']
  ];

  $('#btnImport').onclick = () => {
    openModal(`<h2>Excel / CSV içe aktar</h2>
      <div class="hint">Muhasebe programınızın <b>Fiyat Listesi (Perakende Satış Fiyatları)</b> Excel raporunu doğrudan seçebilirsiniz.
      Sütunlar başlıklarından tanınır:<br>
      <b>Stok Kodu · Stok Adı · BARKOD · KDV % · PERAKENDE FİYATI · KDV dahil mi?</b><br>
      İsteğe bağlı: <b>Birimi · Gurubu</b>. Stok Kartları Listesi raporu da okunur.<br><br>
      "KDV dahil mi?" <b>HAYIR</b> ise satış fiyatına KDV eklenir (ör. 1.100 + %1 = 1.111 ₺).<br>
      Aynı stok kodu ya da barkoda sahip ürünler güncellenir, yeniler eklenir. Yüklemeden önce önizleme gösterilir.</div>
      <div class="btns"><button class="ghost" id="iS">⬇ Örnek Excel indir</button><span class="grow"></span>
        <button class="ghost" id="iC">Vazgeç</button><button class="primary" id="iO">Dosya seç</button></div>`, m => {
      m.querySelector('#iC').onclick = closeModal;
      m.querySelector('#iO').onclick = () => { closeModal(); $('#importFile').value = ''; $('#importFile').click(); };
      m.querySelector('#iS').onclick = async () => {
        try {
          if (window.kasa && window.kasa.saveExcel) {
            const r = await window.kasa.saveExcel(SAMPLE_ROWS, 'ornek-urun-listesi.xlsx');
            if (r && r.saved) toast('Örnek Excel kaydedildi: ' + r.path, 'ok');
          } else {
            const csv = SAMPLE_ROWS.slice(1).map(r => r.join(';')).join('\r\n');
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
            a.download = 'ornek-urun-listesi.csv'; a.click();
          }
        } catch (err) { toast('Kaydedilemedi: ' + err.message, 'err'); }
      };
    });
  };

  async function fileRows(f) {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    const buf = new Uint8Array(await f.arrayBuffer());
    if (ext === 'xls' || ext === 'xlsx' || (buf[0] === 0xD0 && buf[1] === 0xCF) || (buf[0] === 0x50 && buf[1] === 0x4B)) {
      if (!window.kasa || !window.kasa.readExcel) throw new Error('Excel okuma bu sürümde kullanılamıyor');
      return window.kasa.readExcel(buf);
    }
    if (buf.slice(0, 2000).includes(0)) throw new Error('Dosya metin (CSV) değil. Excel dosyasını .xls/.xlsx uzantısıyla seçin.');
    let text = new TextDecoder('utf-8').decode(buf);
    if (text.includes('�')) text = new TextDecoder('windows-1254').decode(buf);
    return Importer.csvRows(text);
  }

  $('#importFile').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    let parsed;
    try { parsed = Importer.parse(await fileRows(f)); }
    catch (err) { return toast('Dosya okunamadı: ' + err.message, 'err'); }
    const items = parsed.items;
    if (!items.length) return toast('Dosyada ürün bulunamadı. Başlık satırında "Ürün Adı" ve "Barkod" ya da "Kodu" olmalı.', 'err');
    const byCodeMap = new Map([...products.values()].filter(p => p.code).map(p => [p.code, p]));
    const findOld = it => (it.code && byCodeMap.get(it.code))
      || (it.barcode && byBarcode.has(it.barcode) && products.get(byBarcode.get(it.barcode))) || null;
    const newCount = items.filter(it => !findOld(it)).length;
    const hasStock = false;
    const hasPrice = items.some(it => Number.isFinite(it.price));
    const exclVat = items.some(it => it.vatIncl === false && Number.isFinite(it.price));
    const salePrice = (it, addVat) => !Number.isFinite(it.price) ? NaN
      : r2(addVat && it.vatIncl === false && it.vat > 0 ? it.price * (1 + it.vat / 100) : it.price);
    const COLS = { code: 'Stok kodu', name: 'Ürün adı', extra: 'Özel kod', group: 'Grup', unit: 'Birim', barcode: 'Barkod', stock: 'Stok', price: 'Fiyat', vat: 'KDV %', vatIncl: 'KDV dahil mi' };
    const previewRows = addVat => items.slice(0, 60).map(it => {
      const old = findOld(it);
      return `<tr><td>${old ? '<span style="color:var(--muted)">güncelle</span>' : '<span style="color:var(--accent2)">yeni</span>'}</td>
        <td>${esc(it.code)}</td><td>${esc(it.barcode || '—')}</td><td>${esc(it.name)}</td>
        <td class="num">${Number.isFinite(it.vat) ? '%' + it.vat : ''}</td>
        <td class="num">${Number.isFinite(it.price) ? money(it.price) : ''}</td>
        <td class="num"><b>${Number.isFinite(it.price) ? money(salePrice(it, addVat)) : ''}</b></td>
</tr>`;
    }).join('');
    openModal(`<h2>İçe aktarma önizlemesi</h2>
      <div><b>${esc(f.name)}</b> — ${items.length} ürün bulundu: <b>${newCount}</b> yeni, <b>${items.length - newCount}</b> güncellenecek${parsed.skipped ? `, ${parsed.skipped} başlık/boş satır atlandı` : ''}.</div>
      <div class="hint">Tanınan sütunlar: ${parsed.columns.filter(c => c !== 'stock').map(c => COLS[c] || c).join(', ')}${hasPrice ? '' : ' — <b style="color:#f87171">dosyada fiyat yok</b>; fiyatı olmayan ürünlerin fiyatı ilk satışta sorulur.'}</div>
      <div class="preview"><table class="grid"><thead><tr><th></th><th>Kod</th><th>Barkod</th><th>Ürün adı</th><th class="num">KDV</th><th class="num">Liste fiyatı</th><th class="num">Satış fiyatı</th></tr></thead>
      <tbody id="pvBody">${previewRows(true)}</tbody></table></div>
      ${items.length > 60 ? `<div class="hint">İlk 60 satır gösteriliyor.</div>` : ''}
      ${exclVat ? `<label class="chk" style="flex-direction:row"><input type="checkbox" id="impVat" checked> Fiyatlar KDV hariç — satış fiyatına KDV'yi ekle</label>` : ''}
      ${hasStock ? `<label class="chk" style="flex-direction:row"><input type="checkbox" id="impStock" checked> Stok miktarlarını dosyadaki değere eşitle</label>` : ''}
      <label class="chk" style="flex-direction:row"><input type="checkbox" id="impKeepName"> Mevcut ürünlerin adını değiştirme</label>
      <div class="btns"><button class="ghost" id="pC">Vazgeç</button><button class="primary" id="pO">${items.length} ürünü içe aktar</button></div>`, m => {
      m.classList.add('wide');
      modalClose = () => m.classList.remove('wide');
      const vatBox = m.querySelector('#impVat');
      if (vatBox) vatBox.onchange = () => { m.querySelector('#pvBody').innerHTML = previewRows(vatBox.checked); };
      m.querySelector('#pC').onclick = closeModal;
      m.querySelector('#pO').onclick = async () => {
        const setStock = hasStock && m.querySelector('#impStock').checked;
        const keepName = m.querySelector('#impKeepName').checked;
        const addVat = !!(vatBox && vatBox.checked);
        const ready = items.map(it => ({ ...it, price: salePrice(it, addVat) }));
        closeModal();
        await runImport(ready, findOld, setStock, keepName);
      };
    });
  });

  async function runImport(items, findOld, setStock, keepName) {
    const ts = nowIso();
    const touched = new Map();
    const moves = [];
    let added = 0, dupBarcode = 0;
    const seenBarcode = new Map();
    for (const it of items) {
      let old = findOld(it);
      if (old && touched.has(old.id)) old = touched.get(old.id);
      if (!old && it.barcode && seenBarcode.has(it.barcode)) old = touched.get(seenBarcode.get(it.barcode));
      let barcode = it.barcode || null;
      if (barcode && byBarcode.has(barcode) && old && byBarcode.get(barcode) !== old.id) { barcode = old.barcode; dupBarcode++; }
      const row = old ? {
        ...old,
        name: keepName ? old.name : it.name,
        code: it.code || old.code || null, group: it.group || old.group || null,
        barcode: barcode || old.barcode || null, unit: it.unit || old.unit,
        price: Number.isFinite(it.price) ? r2(it.price) : old.price,
        vat_rate: Number.isFinite(it.vat) ? it.vat : old.vat_rate,
        active: true, updated_at: ts
      } : {
        id: uuid(), code: it.code || null, barcode, name: it.name, group: it.group || null, category: Importer.guessCategory(it.name),
        price: Number.isFinite(it.price) ? r2(it.price) : 0, stock: 0,
        vat_rate: Number.isFinite(it.vat) ? it.vat : 10, unit: it.unit || 'adet', min_stock: 0, active: true, updated_at: ts
      };
      if (!old) added++;
      if (setStock && Number.isFinite(it.stock) && r3(it.stock) !== r3(row.stock)) {
        moves.push({ id: uuid(), product_id: row.id, qty: r3(it.stock - row.stock), reason: 'Excel içe aktarma', ref_id: null, created_at: ts });
        row.stock = r3(it.stock);
      }
      touched.set(row.id, row);
      if (row.barcode) seenBarcode.set(row.barcode, row.id);
    }
    const rows = [...touched.values()];
    try {
      for (let i = 0; i < rows.length; i += 300) {
        const part = rows.slice(i, i + 300);
        await DB.write(part.map(value => ({ store: 'products', value })), part.map(row => ({ table: 'products', row })));
      }
      for (let i = 0; i < moves.length; i += 300) {
        const part = moves.slice(i, i + 300);
        await DB.write(part.map(value => ({ store: 'stock_moves', value })), part.map(row => ({ table: 'stock_moves', row })));
      }
      rows.forEach(indexProduct);
      renderProducts();
      toast(`${added} yeni ürün eklendi, ${rows.length - added} ürün güncellendi${dupBarcode ? ` (${dupBarcode} çakışan barkod korunarak atlandı)` : ''}`, 'ok');
      Sync.run();
    } catch (err) { toast('İçe aktarma başarısız: ' + err.message, 'err'); }
  }

  // ---------- GÜN SONU ----------
  const pad = n => String(n).padStart(2, '0');
  const localDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  $('#repDate').value = localDate(new Date());
  $('#repDate').addEventListener('change', renderReport);
  $('#repToday').onclick = () => { $('#repDate').value = localDate(new Date()); renderReport(); };

  async function dayData() {
    const [y, m, d] = $('#repDate').value.split('-').map(Number);
    const start = new Date(y, m - 1, d, 0, 0, 0, 0), end = new Date(y, m - 1, d, 23, 59, 59, 999);
    const sales = (await DB.range('sales', 'created_at', start.toISOString(), end.toISOString()))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    const ok = sales.filter(s => s.status === 'completed');
    const sum = arr => r2(arr.reduce((a, s) => a + s.total, 0));
    const topMap = new Map();
    ok.forEach(s => s.items.forEach(i => {
      const k = i.product_id || i.name;
      const t = topMap.get(k) || { name: i.name, qty: 0, total: 0 };
      t.qty = r3(t.qty + i.qty); t.total = r2(t.total + i.total); topMap.set(k, t);
    }));
    const tm = iso => new Date(iso).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    return {
      sales, dateLabel: start.toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
      count: ok.length, total: sum(ok),
      cash: sum(ok.filter(s => s.payment_type === 'cash')), card: sum(ok.filter(s => s.payment_type === 'card')),
      cancelled: sales.length - ok.length, cancelledTotal: sum(sales.filter(s => s.status !== 'completed')),
      firstSale: ok.length ? tm(ok[ok.length - 1].created_at) : '', lastSale: ok.length ? tm(ok[0].created_at) : '',
      top: [...topMap.values()].sort((a, b) => b.total - a.total)
    };
  }

  let repCache = null;
  async function renderReport() {
    const r = repCache = await dayData();
    $('#repCards').innerHTML = [
      ['Toplam ciro', money(r.total)], ['Nakit', money(r.cash)], ['Kredi kartı', money(r.card)],
      ['Satış adedi', r.count], ['Ortalama sepet', money(r.count ? r.total / r.count : 0)]
    ].map(([l, v]) => `<div class="card-s"><div class="l">${l}</div><div class="v">${v}</div></div>`).join('');
    const row = s => `<tr class="click ${s.status !== 'completed' ? 'cancel' : ''}" data-id="${s.id}">
      <td>${new Date(s.created_at).toLocaleTimeString('tr-TR')}</td><td>#${s.sale_no}</td><td class="num">${s.items.length}</td>
      <td>${s.payment_type === 'cash' ? 'Nakit' : 'Kart'}${s.status !== 'completed' ? ' (iptal)' : ''}</td><td class="num">${money(s.total)}</td></tr>`;
    const section = (label, type, sum) => {
      const list = r.sales.filter(s => s.payment_type === type);
      return `<tr class="sec"><td colspan="4">${label} <span>${list.filter(s => s.status === 'completed').length} satış</span></td><td class="num">${money(sum)}</td></tr>`
        + (list.map(row).join('') || '<tr><td colspan="5" style="color:var(--dim)">Satış yok</td></tr>');
    };
    $('#repSales').innerHTML = r.sales.length
      ? section('Nakit satışlar', 'cash', r.cash) + section('Kredi kartı satışları', 'card', r.card)
      : '<tr><td colspan="5" style="color:var(--muted)">Bu tarihte satış yok</td></tr>';
    $('#repTop').innerHTML = r.top.slice(0, 30).map(t => `<tr><td>${esc(t.name)}</td><td class="num">${qtyFmt(t.qty)}</td><td class="num">${money(t.total)}</td></tr>`).join('');
  }
  $('#repSales').addEventListener('click', e => {
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    const s = repCache.sales.find(x => x.id === tr.dataset.id); if (s) saleDetail(s);
  });
  $('#repPrint').onclick = async () => printHtml(Receipt.dayReport(await dayData(), settings));

  function saleDetail(s) {
    openModal(`<h2>Satış #${s.sale_no} ${s.status !== 'completed' ? '(İPTAL)' : ''}</h2>
      <div class="hint">${new Date(s.created_at).toLocaleString('tr-TR')} · ${s.payment_type === 'cash' ? 'Nakit' : 'Kart'}</div>
      <table class="grid items"><tbody>${s.items.map(i => `<tr><td>${esc(i.name)}</td><td class="num">${qtyFmt(i.qty)} x ${money(i.price)}</td><td class="num">${money(i.total)}</td></tr>`).join('')}</tbody></table>
      <div class="big-total">${money(s.total)}</div>
      <div class="btns">${s.status === 'completed' ? '<button class="danger" id="dCancel">Satışı iptal et</button>' : ''}${role === 'admin' ? '<button class="danger" id="dDelete">Kaydı sil</button>' : ''}<span class="grow"></span>
        <button class="ghost" id="dPrint">Fiş yazdır</button><button class="primary" id="dClose">Kapat</button></div>`, m => {
      m.querySelector('#dClose').onclick = closeModal;
      m.querySelector('#dPrint').onclick = () => printSale(s);
      const del = m.querySelector('#dDelete');
      if (del) del.onclick = async () => {
        if (role !== 'admin') return;
        if (!(await confirmBox('Satış kaydını sil', `#${s.sale_no} numaralı ${money(s.total)} tutarlı satış kaydı bu bilgisayardan ve buluttan kalıcı olarak silinecek. Bu işlem geri alınamaz.`, 'Kalıcı olarak sil', true))) return;
        try {
          await DB.write([{ store: 'sales', del: s.id }], [{ table: 'sales', row: { id: s.id }, op: 'delete' }]);
          if (lastSale && lastSale.id === s.id) { lastSale = null; renderLastSale(); }
          toast(`Satış #${s.sale_no} silindi`, 'ok'); renderReport(); Sync.run();
        } catch (e) { toast('Silinemedi: ' + e.message, 'err'); }
      };
      const c = m.querySelector('#dCancel');
      if (c) c.onclick = async () => {
        if (!(await confirmBox('Satış iptali', `#${s.sale_no} numaralı ${money(s.total)} tutarlı satış iptal edilecek olarak işaretlenecek ve ciroya dahil edilmeyecek.`, 'İptal et', true))) return;
        await cancelSale(s);
      };
    });
  }

  async function cancelSale(s) {
    const ts = nowIso();
    const ns = { ...s, status: 'cancelled', cancelled_at: ts };
    const ops = [{ store: 'sales', value: ns }], sync = [{ table: 'sales', row: ns }], upd = [];
    upd.forEach(np => { ops.push({ store: 'products', value: np }); sync.push({ table: 'products', row: np }); });
    try {
      await DB.write(ops, sync);
      upd.forEach(indexProduct);
      if (lastSale && lastSale.id === s.id) { lastSale = ns; renderLastSale(); }
      toast(`Satış #${s.sale_no} iptal edildi`, 'ok');
      renderReport(); Sync.run();
    } catch (e) { toast('İptal edilemedi: ' + e.message, 'err'); }
  }

  // ---------- AYARLAR ----------
  async function renderSettings() {
    $('#setStoreName').value = settings.storeName;
    $('#setStoreAddress').value = settings.storeAddress;
    $('#setStorePhone').value = settings.storePhone;
    $('#setFooter').value = settings.footer;
    $('#setPaper').value = settings.paper;
    $('#setAutoPrint').checked = !!settings.autoPrint;
    const sel = $('#setPrinter');
    try {
      const list = window.kasa ? await window.kasa.listPrinters() : [];
      sel.innerHTML = '<option value="">(Her seferinde sor)</option>' +
        list.map(p => `<option value="${esc(p.name)}">${esc(p.displayName)}${p.isDefault ? ' (varsayılan)' : ''}</option>`).join('');
      if (settings.printer && !list.some(p => p.name === settings.printer)) sel.innerHTML += `<option value="${esc(settings.printer)}">${esc(settings.printer)} (bulunamadı)</option>`;
    } catch (_) {}
    sel.value = settings.printer;
    const c = await Sync.cfg();
    $('#sbUrl').value = c.url; $('#sbKey').value = c.key;
    $('#sbEmail').value = (c.session && c.session.email) || '';
    if (window.kasa) $('#appVersion').textContent = 'Sürüm ' + (await window.kasa.version()) + ' · Cihaz: ' + deviceId;
  }
  async function saveSettings() {
    settings = {
      storeName: $('#setStoreName').value.trim(), storeAddress: $('#setStoreAddress').value.trim(),
      storePhone: $('#setStorePhone').value.trim(), footer: $('#setFooter').value.trim(),
      printer: $('#setPrinter').value, paper: $('#setPaper').value, autoPrint: $('#setAutoPrint').checked
    };
    await DB.setMeta('settings', settings);
    $('#brand').textContent = settings.storeName || 'Hızlı Kasa';
  }
  $('#btnSaveSettings').onclick = async () => { await saveSettings(); toast('Ayarlar kaydedildi', 'ok'); };
  $('#btnTestPrint').onclick = async () => { await saveSettings(); printHtml(Receipt.test(settings)); };

  $('#btnLogin').onclick = async () => {
    const url = $('#sbUrl').value, key = $('#sbKey').value, email = $('#sbEmail').value, pass = $('#sbPass').value;
    if (!url || !key || !email || !pass) return toast('Tüm bulut alanlarını doldurun', 'err');
    try {
      $('#btnLogin').disabled = true;
      await Sync.login(url, key, email, pass);
      $('#sbPass').value = '';
      toast('Buluta bağlanıldı', 'ok');
    } catch (e) { toast(e instanceof TypeError ? 'Sunucuya ulaşılamadı. İnterneti ve Proje ID\'yi kontrol edin.' : 'Bağlanılamadı: ' + e.message, 'err'); }
    finally { $('#btnLogin').disabled = false; }
  };
  $('#btnLogout').onclick = async () => {
    if (await confirmBox('Bağlantıyı kes', 'Senkronizasyon durur. Veriler bilgisayarda kalmaya devam eder.')) { await Sync.logout(); toast('Bağlantı kesildi'); }
  };
  $('#btnSyncNow').onclick = () => Sync.run();
  $('#btnRestore').onclick = async () => {
    if (!(await confirmBox('Buluttan geri yükle', 'Buluttaki ürünler ve satışlar bu bilgisayara indirilecek. Yerelde daha yeni olan kayıtlar korunur.', 'Geri yükle'))) return;
    try {
      toast('İndiriliyor...');
      const r = await Sync.restore();
      await loadAll();
      renderSettings();
      toast(`${r.products} ürün ve ${r.sales} satış buluttan alındı`, 'ok');
    } catch (e) { toast('Geri yükleme başarısız: ' + e.message, 'err'); }
  };
  $('#btnBackup').onclick = async () => {
    const data = {
      created_at: nowIso(), device: deviceId,
      products: await DB.all('products'), sales: await DB.all('sales'), stock_moves: await DB.all('stock_moves'), settings
    };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    a.download = `kasa-yedek-${localDate(new Date())}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  // ---------- Senkron göstergesi ----------
  Sync.onChange(s => {
    const el = $('#syncStatus');
    const map = {
      kapali: ['dis', '● Bulut kapalı'], cevrimdisi: ['off', '● Çevrimdışı'],
      gonderiliyor: ['off', '● Gönderiliyor...'], tamam: ['ok', '● Senkronize'], hata: ['err', '● Senkron hatası']
    };
    const [cls, label] = map[s.status] || map.kapali;
    el.className = 'status ' + cls;
    el.textContent = label + (s.pending ? ` (${s.pending} bekliyor)` : '');
    el.title = s.lastError || (s.lastSync ? 'Son senkron: ' + s.lastSync.toLocaleTimeString('tr-TR') : '');
    const info = $('#syncInfo');
    if (info) info.textContent = `Durum: ${label.replace('● ', '')}\nGönderilmeyi bekleyen kayıt: ${s.pending}` +
      (s.lastSync ? `\nSon senkron: ${s.lastSync.toLocaleString('tr-TR')}` : '') + (s.lastError ? `\nHata: ${s.lastError}` : '');
  });

  // ---------- Otomatik güncelleme ----------
  if (window.kasa && window.kasa.onUpdate) {
    const btn = $('#updateBtn');
    window.kasa.onUpdate(u => {
      btn.classList.remove('hidden');
      if (u.state === 'downloading') {
        btn.className = 'update busy'; btn.disabled = true;
        btn.textContent = `Yeni sürüm ${u.version} indiriliyor...`;
      } else if (u.state === 'ready') {
        btn.className = 'update'; btn.disabled = false;
        btn.textContent = `⟳ Sürüm ${u.version} hazır — yeniden başlat`;
        btn.title = 'Tıklamazsanız program kapatıldığında otomatik kurulur.';
        toast(`Yeni sürüm ${u.version} indirildi. Uygun bir anda üstteki yeşil düğmeye basın.`, 'ok');
        btn.onclick = async () => {
          if (cart.length && !(await confirmBox('Güncelleme', 'Sepette ürün var. Yeniden başlatılırsa sepet boşalır. Devam edilsin mi?', 'Yeniden başlat', true))) return;
          btn.textContent = 'Kuruluyor...'; btn.disabled = true;
          window.kasa.installUpdate();
        };
      }
    });
  }

  // ---------- Klavye kısayolları ----------
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modalOpen()) { e.preventDefault(); closeModal(); return; }
    if (modalOpen()) return;
    if (currentTab === 'home') {
      if (e.key === '1') { e.preventDefault(); goSale(); }
      if (e.key === '2') { e.preventDefault(); goLogin(); }
      return;
    }
    if (currentTab === 'login') return;
    const keys = mode === 'admin' ? { F2: 'products', F3: 'report', F4: 'settings', F5: 'security' } : { F1: 'sale', F3: 'report' };
    if (keys[e.key]) { e.preventDefault(); showTab(keys[e.key]); return; }
    if (currentTab === 'sale') {
      if (e.key === 'F8') { e.preventDefault(); payCash(); }
      if (e.key === 'F9') { e.preventDefault(); payCard(); }
    }
  });
  document.querySelectorAll('#navTabs button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
  $('#btnCash').onclick = payCash;
  $('#btnCard').onclick = payCard;
  $('#btnClear').onclick = async () => {
    if (cart.length && await confirmBox('Sepeti temizle', 'Sepetteki tüm ürünler silinsin mi?', 'Temizle', true)) { cart = []; renderCart(); }
  };
  $('#modalBack').addEventListener('mousedown', e => { if (e.target.id === 'modalBack') closeModal(); });

  setInterval(() => { $('#clock').textContent = new Date().toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'medium' }); }, 1000);

  // ---------- Başlat ----------
  (async () => {
    try {
      await DB.open();
      await loadAll();
      await loadPopularity();
      await getAuth();
      renderChips(); renderCart(); renderLastSale(); goHome();
      Sync.start();
      focusScan();
    } catch (e) {
      document.body.innerHTML = `<div style="padding:40px;font-size:18px">Veritabanı açılamadı: ${esc(e.message)}</div>`;
    }
  })();
})();
