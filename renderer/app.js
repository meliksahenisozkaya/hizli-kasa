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
  const IS_WEB = !!(window.kasa && window.kasa.isWeb);
  if (IS_WEB) { Sync.isWeb = true; document.body.classList.add('web'); }
  const products = new Map();   // id -> ürün
  const byBarcode = new Map();  // barkod -> id
  let cart = [];
  let settings = {};
  let saleNo = 0;
  let deviceId = '';
  let lastSale = null;
  let currentTab = 'sale';
  let cashier = null;            // satış ekranına giriş yapan kasiyer {id, name, perms}
  let users = [];                // yöneticinin tanımladığı kasiyerler
  let cartDiscount = null;       // fiş indirimi {type: 'pct' | 'amt', value}
  const payOf = s => Receipt.payOf(s);
  const payLabel = s => Receipt.payLabel(s);

  const DEFAULT_SETTINGS = { storeName: '', storeAddress: '', storePhone: '', footer: 'Bizi tercih ettiğiniz için teşekkürler', printer: '', paper: '80', autoPrint: true, scaleOn: false, scalePrefix: '27, 28, 29', scaleMode: 'weight' };

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
    users = ((await DB.getMeta('users', null)) || {}).list || [];
    deviceId = await DB.getMeta('device_id', '');
    if (!deviceId) { deviceId = (IS_WEB ? 'WEB-' : 'KASA-') + uuid().slice(0, 8).toUpperCase(); await DB.setMeta('device_id', deviceId); }
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
  const subOf = p => p.subgroup || Importer.guessSubgroup(p.name, catOf(p)) || '';
  function subsOf(cat) {
    const set = new Set([...products.values()].filter(p => p.active && catOf(p) === cat).map(subOf));
    const order = Importer.subgroupOrder(cat);
    return [...set].sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b, 'tr');
    });
  }
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
  const ADMIN_TABS = ['approvals', 'products', 'analytics', 'settings', 'security'];
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

  // Kasiyer yetkileri
  const PERMS = [['price', 'Satışta fiyat değiştirme'], ['discount', 'İndirim yapma'], ['refund', 'İade alma'], ['cancel', 'Satış iptali'],
    ['credit', 'Veresiye satış ve tahsilat'], ['cash', 'Kasa giriş / çıkış ve sayım']];
  const DEFAULT_PERMS = { price: false, discount: false, refund: false, cancel: false, credit: true, cash: true };
  const can = p => role === 'admin' || !cashier || !!(cashier.perms && cashier.perms[p]);
  function need(p) {
    if (can(p)) return true;
    beep(false); toast('Bu işlem için yetkiniz yok: ' + ((PERMS.find(x => x[0] === p) || [])[1] || p), 'err');
    return false;
  }
  const actor = () => role === 'admin' ? { id: 'admin', name: 'Yönetici' } : (cashier ? { id: cashier.id, name: cashier.name } : null);

  function goHome() { role = null; mode = 'home'; cashier = null; showTab('home'); }
  function goSale() {
    if (users.length && !cashier) return cashierLogin();
    role = null; mode = 'sale'; showTab('sale');
  }
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
    const pend = (await DB.all('orders')).filter(o => o.status === 'pending').length;
    showTab(pend ? 'approvals' : 'products');
    if (pend) toast(`${pend} işlem onay bekliyor`, 'warn');
  });

  function renderHeader() {
    const full = currentTab === 'home' || currentTab === 'login' || currentTab === 'cloud';
    $('#topbar').classList.toggle('hidden', full);
    document.body.classList.toggle('no-top', full);
    document.body.classList.toggle('mode-admin', mode === 'admin');
    document.querySelectorAll('#navTabs button').forEach(b => {
      const m = b.dataset.mode;
      b.classList.toggle('hidden', !(m === 'both' || m === mode));
    });
    $('#btnHome').classList.toggle('hidden', mode !== 'sale');
    $('#btnCashier').classList.toggle('hidden', !(mode === 'sale' && cashier));
    if (cashier) $('#btnCashier').textContent = 'Kasiyer: ' + cashier.name;
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
    a.updated_at = nowIso();
    await DB.write([{ store: 'meta', value: { key: 'auth', value: a } }],
      [{ table: 'config', row: { id: 'auth', salt: a.salt, adminUser: a.adminUser, adminHash: a.adminHash, updated_at: a.updated_at } }]);
    Sync.run();
    ['#secAdminCur', '#secAdminNew', '#secAdminNew2'].forEach(x => $(x).value = '');
    toast('Yönetici bilgileri kaydedildi', 'ok');
  };

  function showTab(t) {
    if (!canSee(t)) return;
    currentTab = t;
    renderHeader();
    document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
    document.querySelectorAll('.tab').forEach(el => el.classList.toggle('active', el.id === 'tab-' + t));
    document.body.classList.toggle('on-sale', t === 'sale');
    if (t === 'sale') { renderChips(); renderTiles(); renderOrderStrip(); focusScan(); }
    if (t === 'approvals') renderApprovals();
    if (t === 'products') { renderProducts(); $('#prodSearch').focus(); }
    if (t === 'report') renderReport();
    if (t === 'credits') { renderCredits(); if (!TOUCH) $('#crSearch').focus(); }
    if (t === 'settings') renderSettings();
    if (t === 'security') { getAuth().then(a => { $('#secAdminName').value = a.adminUser; }); renderUsers(); }
    if (t === 'analytics') renderAnalytics();
    if (t === 'sale') renderHeld();
  }
  const TOUCH = matchMedia('(pointer: coarse)').matches;   // dokunmatik cihazda klavye sürekli açılmasın
  function focusScan() { if (currentTab === 'sale' && !modalOpen() && !TOUCH) $('#scanInput').focus(); }

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
    if (lockGuard()) return;
    if (!(qty > 0)) { toast('Geçersiz miktar', 'err'); beep(false); return; }
    if (!priceOk && !(p.price > 0)) { beep(false); return askPrice(p, qty); }
    let line = cart.find(l => l.product_id === p.id && !l.locked);
    const before = line ? line.qty : 0;
    if (line) { line.qty = r3(line.qty + qty); cart.splice(cart.indexOf(line), 1); cart.unshift(line); }
    else { line = { product_id: p.id, barcode: p.barcode, name: p.name, price: p.price, vat_rate: p.vat_rate, unit: p.unit, qty: r3(qty) }; cart.unshift(line); }
    beep(true);
    renderCart(true);
  }
  const lineTotal = l => r2(l.price * l.qty);
  const subTotal = () => r2(cart.reduce((s, l) => s + lineTotal(l), 0));
  const discAmount = () => {
    if (!cartDiscount || !cart.length) return 0;
    const sub = subTotal();
    return r2(Math.min(sub, cartDiscount.type === 'pct' ? sub * cartDiscount.value / 100 : cartDiscount.value));
  };
  const cartTotal = () => r2(subTotal() - discAmount());

  function renderCart(flashFirst = false) {
    $('#cartBody').innerHTML = cart.map((l, i) => {
      const p = products.get(l.product_id);
      const warn = '';
      if (l.locked) return `<div class="ci locked" data-i="${i}">
        <div class="nm">${esc(l.name)}<span class="lock">✓ onaylı</span></div><div class="lt">${money(lineTotal(l))}</div>
        <div class="row2"><span class="qty">${qtyFmt(l.qty)}</span>
          <span class="up">${esc(l.unit || '')} × <span class="pr">${money(l.price)}</span>${l.listPrice != null && l.listPrice !== l.price ? ` <s>${money(l.listPrice)}</s>` : ''}</span></div></div>`;
      return `<div class="ci ${i === 0 && flashFirst ? 'flash' : ''}" data-i="${i}">
        <div class="nm">${esc(l.name)}</div><div class="lt">${money(lineTotal(l))}</div>
        <div class="row2">
          <button class="qbtn minus" data-a="dec" title="Bir azalt">−</button>
          <span class="qty" data-a="edit" title="Miktarı değiştir">${qtyFmt(l.qty)}</span>
          <button class="qbtn" data-a="inc" title="Bir artır">+</button>
          <span class="up">${esc(l.unit || '')} × <span class="pr ${l.listPrice != null && l.listPrice !== l.price ? 'chg' : ''}" data-a="price" title="Bu satış için fiyatı değiştir">${money(l.price)} ✎</span>${l.listPrice != null && l.listPrice !== l.price ? ` <s>${money(l.listPrice)}</s>` : ''}${warn}</span>
          <button class="rm" data-a="rm" title="Sepetten çıkar">✕ Çıkar</button>
        </div></div>`;
    }).join('');
    $('#cartEmpty').classList.toggle('hidden', cart.length > 0);
    if (!cart.length) cartDiscount = null;
    const dEl = $('#cartDisc');
    dEl.classList.toggle('hidden', !cartDiscount);
    if (cartDiscount) dEl.innerHTML = `Ara toplam ${money(subTotal())} · İndirim${cartDiscount.type === 'pct' ? ' %' + qtyFmt(cartDiscount.value) : ''} <b>−${money(discAmount())}</b> <button type="button" id="discX" title="İndirimi kaldır">✕</button>`;
    const dx = $('#discX'); if (dx) dx.onclick = () => { cartDiscount = null; renderCart(); };
    $('#cartTotal').textContent = money(cartTotal());
    $('#cjTotal').textContent = money(cartTotal());
    $('#cjCount').textContent = cart.length ? `${cart.length} kalem` : 'Sepet boş';
    $('#cartJump').classList.toggle('has', cart.length > 0);
    if (!cart.length && !activeOrder) document.body.classList.remove('cart-open');
    const pieces = cart.reduce((a, l) => a + (['adet', 'paket', 'koli', 'kavanoz', 'teneke'].includes(l.unit) ? l.qty : 0), 0);
    $('#cartCount').textContent = `${cart.length} kalem${pieces ? ` · ${qtyFmt(pieces)} adet` : ''}`;
    if (flashFirst) $('#cartBody').parentElement.scrollTop = 0;
    renderTiles();
  }

  $('#cartBody').addEventListener('click', e => {
    const a = e.target.dataset.a; if (!a) return;
    const i = Number(e.target.closest('.ci').dataset.i);
    const l = cart[i]; if (!l) return;
    if (l.locked) return toast('Onaylı siparişin ürünleri değiştirilemez', 'warn');
    if (a === 'inc') l.qty = r3(l.qty + 1);
    if (a === 'dec') { l.qty = r3(l.qty - 1); if (l.qty <= 0) cart.splice(i, 1); }
    if (a === 'rm') cart.splice(i, 1);
    if (a === 'edit') return editQty(l);
    if (a === 'price') return need('price') && editLinePrice(l);
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

  // Fotoğrafı olmayan ürünlere halisfindik.com fotoğraflarını arka planda otomatik ekler
  const photoTried = new Set();
  let photoBusy = false;
  async function autoPhotos() {
    if (photoBusy || !navigator.onLine || !(window.kasa && window.kasa.fetchImage)) return;
    const list = [...products.values()].filter(p => !p.image && !p.noPhoto && !photoTried.has(p.id) && SiteImages.urlFor(p.name));
    if (!list.length) return;
    photoBusy = true;
    const cache = new Map(); const rows = []; let fail = 0; const ts = nowIso();
    for (const p of list) {
      photoTried.add(p.id);
      const u = SiteImages.urlFor(p.name);
      try { if (!cache.has(u)) cache.set(u, await fetchThumb(u)); rows.push({ ...p, image: cache.get(u), updated_at: ts }); }
      catch (e) { fail++; console.warn('Fotoğraf indirilemedi', u, e && e.message); }
    }
    try {
      for (let i = 0; i < rows.length; i += 100) {
        const part = rows.slice(i, i + 100);
        await DB.write(part.map(value => ({ store: 'products', value })), part.map(row => ({ table: 'products', row })));
      }
      rows.forEach(indexProduct);
      if (rows.length) { renderTiles(); if (currentTab === 'products') renderProducts(); Sync.run(); }
      if (fail && !rows.length) toast('Ürün fotoğrafları halisfindik.com\'dan indirilemedi', 'warn');
    } finally { photoBusy = false; }
  }

  let activeSub = '';
  function renderChips() {
    const cats = allCategories();
    if (activeGroup && activeGroup !== '*' && !cats.includes(activeGroup)) { activeGroup = ''; activeSub = ''; }
    const count = c => [...products.values()].filter(p => p.active && catOf(p) === c).length;
    const searching = !!$('#scanInput').value.trim();
    $('#groupChips').innerHTML = cats.map(g =>
      `<button data-g="${esc(g)}" class="${g === activeGroup && !searching ? 'on' : ''}"><span class="nm">${esc(g)}</span><span class="cnt">${count(g)}</span></button>`).join('')
      + (cats.length ? `<button data-g="*" class="all ${activeGroup === '*' && !searching ? 'on' : ''}"><span class="nm">Tüm ürünler</span><span class="cnt">${[...products.values()].filter(p => p.active).length}</span></button>` : '');
  }
  $('#groupChips').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    activeGroup = b.dataset.g; activeSub = '';
    if ($('#scanInput').value.trim()) $('#scanInput').value = '';
    renderChips(); renderTiles(); focusScan();
  });

  function tileHtml(p, inCart) {
    const c = inCart.get(p.id);
    return `<button class="tile ${c ? 'in' : ''}" data-id="${p.id}" title="${esc(p.name)}">
        <span class="ph">${p.image ? `<img src="${p.image}" alt="" loading="lazy">` : `<span class="ph-x">${esc(initials(p.name))}</span>`}</span>
        ${c ? `<span class="badge">${qtyFmt(c)} ${esc(p.unit)}</span>` : ''}
        <span class="n">${esc(p.name)}</span>
        <span class="f"><span class="p ${p.price > 0 ? '' : 'none'}">${p.price > 0 ? money(p.price) : 'Fiyat yok'}</span>
        <span class="s">${esc(p.unit)}</span></span></button>`;
  }

  function renderTiles() {
    const raw = $('#scanInput').value.trim().replace(/^\d+(?:[.,]\d+)?\s*[*xX]\s*/, '');
    const q = lower(raw);
    const inCart = new Map(cart.map(l => [l.product_id, l.qty]));
    const tiles = $('#tiles'), crumb = $('#crumb');
    const sortP = list => list.sort((a, b) => (popularity.get(b.id) || 0) - (popularity.get(a.id) || 0) || a.name.localeCompare(b.name, 'tr'));
    const active = [...products.values()].filter(p => p.active);
    tiles.classList.remove('subs');
    if (!products.size) { crumb.innerHTML = ''; tiles.innerHTML = '<div class="none">Henüz ürün yok — yönetici girişinden ürün ekleyin</div>'; return; }

    // Arama: tüm gruplarda
    if (q) {
      let list = sortP(active.filter(p => lower(p.name).includes(q) || (p.barcode || '').includes(raw) || (p.code || '') === raw));
      const total = list.length; list = list.slice(0, 240);
      crumb.innerHTML = `<span class="cur">Arama: “${esc(raw)}”</span><span class="cnt">${total} ürün</span>`;
      tiles.innerHTML = list.map(p => tileHtml(p, inCart)).join('') || '<div class="none">Eşleşen ürün yok</div>';
      return;
    }
    // Başlangıç: grup seçilmedi
    if (!activeGroup) {
      crumb.innerHTML = '';
      tiles.innerHTML = `<div class="pick-hint"><b>Bir grup seçin</b><span>veya barkod okutun / ürün adı yazın</span></div>`;
      return;
    }
    if (activeGroup === '*') {
      crumb.innerHTML = `<span class="cur">Tüm ürünler</span>`;
      tiles.innerHTML = sortP(active).slice(0, 400).map(p => tileHtml(p, inCart)).join('');
      return;
    }
    const inCat = active.filter(p => catOf(p) === activeGroup);
    const subs = subsOf(activeGroup);
    if (activeSub && !subs.includes(activeSub)) activeSub = '';
    // Alt grup seçimi (birden fazla alt grup varsa)
    if (subs.length > 1 && !activeSub) {
      crumb.innerHTML = `<span class="cur">${esc(activeGroup)}</span><span class="cnt">Alt grup seçin</span>`;
      tiles.classList.add('subs');
      tiles.innerHTML = subs.map(sg => {
        const list = sortP(inCat.filter(p => subOf(p) === sg));
        const withImg = list.find(p => p.image);
        const inC = list.reduce((a, p) => a + (inCart.has(p.id) ? 1 : 0), 0);
        return `<button class="sub-card ${inC ? 'in' : ''}" data-sub="${esc(sg)}">
          <span class="ph">${withImg ? `<img src="${withImg.image}" alt="">` : `<span class="ph-x">${esc(initials(sg))}</span>`}</span>
          <span class="t">${esc(sg || 'Diğer')}</span><span class="c">${list.length} ürün${inC ? ` · ${inC} sepette` : ''}</span></button>`;
      }).join('');
      return;
    }
    const list = sortP(inCat.filter(p => subs.length <= 1 || subOf(p) === activeSub));
    crumb.innerHTML = subs.length > 1
      ? `<button class="back" data-back="1">‹ Geri</button><span class="lnk" data-back="1">${esc(activeGroup)}</span><span class="sep">›</span><span class="cur">${esc(activeSub || 'Diğer')}</span><span class="cnt">${list.length} ürün</span>`
      : `<span class="cur">${esc(activeGroup)}</span><span class="cnt">${list.length} ürün</span>`;
    tiles.innerHTML = list.map(p => tileHtml(p, inCart)).join('') || '<div class="none">Bu grupta ürün yok</div>';
  }
  $('#crumb').addEventListener('click', e => {
    if (e.target.closest('[data-back]')) { activeSub = ''; renderTiles(); focusScan(); }
  });
  $('#tiles').addEventListener('click', e => {
    const sc = e.target.closest('.sub-card');
    if (sc) { activeSub = sc.dataset.sub; renderTiles(); focusScan(); return; }
    const t = e.target.closest('.tile'); if (!t) return;
    const p = products.get(t.dataset.id); if (!p) return;
    if (WEIGHED.includes(p.unit)) askQty(p); else { addToCart(p, 1); focusScan(); }
  });
  $('#scanInput').addEventListener('input', () => { renderChips(); renderTiles(); });

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

  function editLinePrice(l) {
    const list = l.listPrice != null ? l.listPrice : l.price;
    openModal(`<h2>Fiyatı değiştir</h2><div><b>${esc(l.name)}</b></div>
      <div class="hint">Yalnızca bu satış için geçerlidir; ürünün kayıtlı fiyatı (${money(list)}) değişmez.</div>
      <label>Birim fiyatı (KDV dahil ₺ / ${esc(l.unit || 'adet')})<input id="lpP" inputmode="decimal" value="${String(l.price).replace('.', ',')}" autofocus></label>
      <div class="quick pct">${[5, 10, 15, 20, 25].map(x => `<button type="button" data-p="${x}">%${x} indirim</button>`).join('')}</div>
      <div class="btns">${l.listPrice != null && l.listPrice !== l.price ? '<button class="ghost" id="lpR">Liste fiyatına dön</button>' : ''}<span class="grow"></span>
        <button class="ghost" id="lpC">Vazgeç</button><button class="primary" id="lpO">Uygula</button></div>`, m => {
      const ok = () => {
        const v = r2(parseNum(m.querySelector('#lpP').value));
        if (!(v >= 0)) return toast('Geçerli bir fiyat girin', 'err');
        if (l.listPrice == null) l.listPrice = l.price;
        l.price = v; closeModal(); renderCart();
      };
      m.querySelector('#lpO').onclick = ok;
      m.querySelector('#lpC').onclick = closeModal;
      const r = m.querySelector('#lpR'); if (r) r.onclick = () => { l.price = l.listPrice; closeModal(); renderCart(); };
      m.querySelectorAll('[data-p]').forEach(b => b.onclick = () => {
        m.querySelector('#lpP').value = String(r2(list * (1 - Number(b.dataset.p) / 100))).replace('.', ',');
        m.querySelector('#lpO').focus();
      });
      m.querySelector('#lpP').onkeydown = e => { if (e.key === 'Enter') ok(); };
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
    const sc = scaleParse(text);
    if (sc) {
      if (!sc.product) { beep(false); return toast(`Terazi barkodu okundu ama ${sc.code} kodlu ürün yok. Ürünün "Terazi kodu" alanını doldurun.`, 'err'); }
      if (!(sc.qty > 0)) { beep(false); return toast('Terazi barkodundaki miktar okunamadı', 'err'); }
      return addToCart(sc.product, sc.qty);
    }
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
    if (lockGuard()) return;
    if (!cart.length) return toast('Sepet boş', 'warn');
    const total = cartTotal();
    const notes = [...new Set([total, 50, 100, 200, 500, 1000].map(Number))].filter(n => n >= total).slice(0, 8);
    openModal(`${AWAIT}<h2>Nakit ödeme</h2><div class="big-total">${money(total)}</div>
      <label>Alınan para (boş bırakılırsa tam tutar)<input id="cg" inputmode="decimal" autofocus></label>
      <div class="quick">${notes.map(n => `<button data-v="${n}">${n === total ? 'Tam' : n.toLocaleString('tr-TR')}</button>`).join('')}</div>
      <div>Para üstü</div><div class="change-v" id="chg">0,00 ₺</div>
      <div class="split-hint hidden" id="cSplitBox">Alınan tutar eksik. <button type="button" class="ghost" id="cSplit">Kalanı kartla al (parçalı ödeme)</button></div>
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
        m.querySelector('#cSplitBox').classList.toggle('hidden', !(v > 0 && c < 0));
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
      m.querySelector('#cSplit').onclick = () => { const { v } = calc(); closeModal(); paySplit(r2(v)); };
      m.querySelectorAll('.quick button').forEach(b => b.onclick = () => { inp.value = String(b.dataset.v).replace('.', ','); calc(); m.querySelector('#co').focus(); });
      m.querySelector('#co').onclick = ok;
      m.querySelector('#cc').onclick = closeModal;
      m.onkeydown = e => { if (e.key === 'F8') { e.preventDefault(); e.stopPropagation(); ok(); } };
    });
  }

  function payCard() {
    if (lockGuard()) return;
    if (!cart.length) return toast('Sepet boş', 'warn');
    const total = cartTotal();
    openModal(`${AWAIT}<h2>Kart / POS ödemesi</h2>
      <div class="big-total">${money(total)}</div>
      <div class="pos-hint"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M8 6h8v4H8z"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01"/></svg>
        <span>Tutarı POS cihazından çekin. Ödeme onaylandıktan sonra aşağıdaki düğmeye basın.</span></div>
      <div class="split-hint"><button type="button" class="ghost" id="kSplit">Bir kısmı nakit (parçalı ödeme)</button></div>
      <div class="btns"><button class="ghost" id="kc">Vazgeç (Esc)</button><button class="primary confirm" id="ko">✓ Ödemeyi aldım, onaylıyorum <kbd>F9</kbd></button></div>`, m => {
      m.classList.add('pay-modal');
      modalClose = () => m.classList.remove('pay-modal');
      const ok = async () => { closeModal(); await completeSale('card', null, null); };
      m.querySelector('#ko').onclick = ok;
      m.querySelector('#kc').onclick = closeModal;
      m.querySelector('#kSplit').onclick = () => { closeModal(); paySplit(null); };
      m.tabIndex = -1;
      setTimeout(() => m.focus(), 40);          // Enter/barkod okuyucu yanlışlıkla onaylamasın
      m.onkeydown = e => { if (e.key === 'F9') { e.preventDefault(); e.stopPropagation(); ok(); } };
    });
  }

  let saving = false;
  async function completeSale(type, given, change, extra = {}) {
    if (saving || !cart.length) return;
    saving = true;
    try {
      const ts = nowIso();
      const no = saleNo + 1;
      const items = cart.slice().reverse().map(l => {
        const p = products.get(l.product_id);
        return {
          product_id: l.product_id, barcode: l.barcode, name: l.name, unit: l.unit,
          qty: l.qty, price: l.price, list_price: l.listPrice != null ? l.listPrice : l.price,
          vat_rate: l.vat_rate, total: lineTotal(l), cost: p && Number(p.cost) > 0 ? Number(p.cost) : null,
          category: p ? catOf(p) : null
        };
      });
      const total = cartTotal();
      const sale = {
        id: uuid(), sale_no: no, created_at: ts, kind: 'sale', items, subtotal: subTotal(), discount: discAmount(), total,
        payment_type: type, cash_given: given, change_amount: change,
        cash_amount: type === 'cash' ? total : type === 'mixed' ? extra.cash : 0,
        card_amount: type === 'card' ? total : type === 'mixed' ? r2(total - extra.cash) : 0,
        status: 'completed', cancelled_at: null, device: deviceId, cashier: actor()
      };
      const cariRow = null;
      if (type === 'credit') { sale.customer_name = extra.customer.name; sale.customer_phone = extra.customer.phone || ''; }
      const ord = activeOrder ? await DB.get('orders', activeOrder) : null;
      if (ord) { sale.order_no = ord.no; sale.order_note = ord.note || ''; }
      const ops = [{ store: 'sales', value: sale }, { store: 'meta', value: { key: 'sale_no', value: no } }];
      let ordRow = null;
      if (ord) { ordRow = { ...ord, status: 'done', done_at: ts, updated_at: ts, sale_id: sale.id, sale_no: no, payment_type: type }; ops.push({ store: 'orders', value: ordRow }); }
      const sync = [{ table: 'sales', row: sale }];
      if (ordRow) sync.push({ table: 'orders', row: ordRow });
      if (cariRow) { ops.push({ store: 'cari', value: cariRow }); sync.push({ table: 'cari', row: cariRow }); }
      const updated = [];
      await DB.write(ops, sync);
      saleNo = no;
      updated.forEach(indexProduct);
      lastSale = sale;
      items.forEach(i => popularity.set(i.product_id, (popularity.get(i.product_id) || 0) + 1));
      cart = []; activeOrder = null; cartDiscount = null;
      if (ts > (await DB.getMeta('max_ts', '') || '')) await DB.setMeta('max_ts', ts);
      saveState();
      renderCart(); renderLastSale(); renderOrderStrip();
      document.body.classList.remove('cart-open');
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
    $('#lastSale').innerHTML = `Son ${s.kind === 'refund' ? 'iade' : 'satış'} <b>#${s.sale_no}</b> · ${esc(payLabel(s))}${s.customer_name ? ' · ' + esc(s.customer_name) : ''}${s.customer_phone ? ' · ' + esc(s.customer_phone) : ''} · <b>${money(s.total)}</b>
      ${s.payment_type === 'cash' && s.change_amount > 0 ? `<div>Para üstü</div><div class="change">${money(s.change_amount)}</div>` : ''}
      <div style="margin-top:8px"><button class="ghost" id="reprint">Fişi yazdır</button></div>`;
    $('#reprint').onclick = () => printSale(s);
  }

  // ---------- ONAYA GÖNDER / ONAY BEKLEYEN İŞLEMLER ----------
  let activeOrder = null;     // sepete yüklenmiş onaylı siparişin id'si
  const tmShort = iso => new Date(iso).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const ordTotal = items => r2(items.reduce((a, i) => a + r2(i.price * i.qty), 0));

  async function saveOrder(o) {
    const row = { ...o, updated_at: nowIso() };
    const { notified, ...cloud } = row;          // bildirim durumu her cihazın kendine ait
    await DB.write([{ store: 'orders', value: row }], [{ table: 'orders', row: { ...cloud, notified: false } }]);
    Sync.run();
  }
  async function updateApprBadge() {
    const n = (await DB.all('orders')).filter(o => o.status === 'pending').length;
    const b = $('#apprBadge'); b.textContent = n; b.classList.toggle('hidden', !n);
  }

  function sendForApproval() {
    if (lockGuard()) return;
    if (!cart.length) return toast('Sepet boş', 'warn');
    if (activeOrder) return toast('Bu sipariş zaten onaylı — Nakit veya Kart ile tamamlayın', 'warn');
    const total = cartTotal();
    openModal(`<h2>Onaya gönder</h2>
      <div>${cart.length} kalem · <b>${money(total)}</b></div>
      <label>Not (yönetici görecek)<textarea id="oaNote" rows="4" autofocus placeholder="ör. Toptan alım, indirim istiyor / Müşteri: Ahmet Bey"></textarea></label>
      <div class="hint">Sepet onaya gönderilir ve temizlenir. Yönetici onayladığında satış ekranında bildirim olarak görünür.</div>
      <div class="btns"><button class="ghost" id="oaC">Vazgeç</button><button class="primary" id="oaO">Onaya gönder</button></div>`, m => {
      const ok = async () => {
        const note = m.querySelector('#oaNote').value.trim();
        const no = (await DB.getMeta('order_no', 0)) + 1;
        const items = cart.slice().reverse().map(l => {
          const p = products.get(l.product_id);
          return { product_id: l.product_id, barcode: l.barcode, name: l.name, unit: l.unit, vat_rate: l.vat_rate,
            qty: l.qty, req_price: l.price, list_price: p ? p.price : (l.listPrice ?? l.price), price: l.price };
        });
        const ts0 = nowIso();
        const order = { id: uuid(), no, created_at: ts0, updated_at: ts0, note, items, total: ordTotal(items), status: 'pending', device: deviceId };
        try { await DB.write([{ store: 'orders', value: order }, { store: 'meta', value: { key: 'order_no', value: no } }], [{ table: 'orders', row: order }]); Sync.run(); }
        catch (e) { return toast('Gönderilemedi: ' + e.message, 'err'); }
        closeModal();
        cart = []; renderCart(); renderOrderStrip(); updateApprBadge();
        document.body.classList.remove('cart-open');
        toast(`Sipariş #${no} onaya gönderildi`, 'ok');
      };
      m.querySelector('#oaO').onclick = ok;
      m.querySelector('#oaC').onclick = closeModal;
      m.querySelector('#oaNote').onkeydown = e => { if (e.key === 'Enter' && e.ctrlKey) ok(); };
    });
  }

  async function renderOrderStrip() {
    const all = await DB.all('orders');
    const appr = all.filter(o => o.status === 'approved').sort((a, b) => (a.approved_at || '').localeCompare(b.approved_at || ''));
    const pend = all.filter(o => o.status === 'pending').length;
    // Yeni onay / ret bildirimleri (bir kez)
    const fresh = all.filter(o => (o.status === 'approved' || o.status === 'rejected') && !o.notified);
    if (fresh.length && mode === 'sale') {
      fresh.forEach(o => toast(o.status === 'approved' ? `✓ Sipariş #${o.no} onaylandı — ${money(o.total)}` : `✕ Sipariş #${o.no} reddedildi`, o.status === 'approved' ? 'ok' : 'err'));
      beep(true);
      await DB.write(fresh.map(o => ({ store: 'orders', value: { ...o, notified: true } })));
    }
    const el = $('#orderStrip');
    el.classList.toggle('hidden', !appr.length && !pend);
    el.innerHTML = appr.map(o => `<button class="ord ${activeOrder === o.id ? 'active' : ''}" data-id="${o.id}">✓
        <span>Onaylanan sipariş <b>#${o.no}</b> · <b>${money(o.total)}</b>${o.note ? `<small>${esc(o.note)}</small>` : ''}</span></button>`).join('')
      + (pend ? `<span class="pend">Onay bekleyen: ${pend}</span>` : '');
    el.querySelectorAll('.ord').forEach(b => b.onclick = () => openApprovedOrder(appr.find(o => o.id === b.dataset.id)));
  }

  async function openApprovedOrder(o) {
    if (!o || lockGuard()) return;
    if (activeOrder !== o.id) {
      if (cart.length && !(await confirmBox('Onaylı siparişi aç', 'Sepetteki ürünler kaldırılıp onaylı sipariş yüklensin mi?', 'Evet, yükle'))) return;
      cart = o.items.slice().reverse().map(i => ({ product_id: i.product_id, barcode: i.barcode, name: i.name, price: i.price,
        vat_rate: i.vat_rate, unit: i.unit, qty: i.qty, listPrice: i.req_price, locked: true }));
      activeOrder = o.id;
      renderCart(); renderOrderStrip();
    }
    openModal(`<h2>Onaylanan sipariş #${o.no}</h2>
      ${o.note ? `<div class="appr-card" style="padding:0;border:0;background:none"><div class="note">${esc(o.note)}</div></div>` : ''}
      <div class="big-total">${money(o.total)}</div>
      <div class="hint">Onaylanmış güncel fiyatlarla sepete yüklendi. Ödeme türünü seçin.</div>
      <div class="order-choice">
        <button class="pay cash" id="ocC">NAKİT <kbd>F8</kbd></button>
        <button class="pay card" id="ocK">KART / POS <kbd>F9</kbd></button>
      </div>
      <div class="btns"><button class="ghost" id="ocX">Sonra (Esc)</button></div>`, m => {
      m.querySelector('#ocC').onclick = () => { closeModal(); payCash(); };
      m.querySelector('#ocK').onclick = () => { closeModal(); payCard(); };
      m.querySelector('#ocX').onclick = closeModal;
      m.onkeydown = e => {
        if (e.key === 'F8') { e.preventDefault(); e.stopPropagation(); closeModal(); payCash(); }
        if (e.key === 'F9') { e.preventDefault(); e.stopPropagation(); closeModal(); payCard(); }
      };
    });
  }

  async function renderApprovals() {
    const all = await DB.all('orders');
    const pend = all.filter(o => o.status === 'pending').sort((a, b) => a.created_at.localeCompare(b.created_at));
    const wait = all.filter(o => o.status === 'approved').sort((a, b) => a.created_at.localeCompare(b.created_at));
    updateApprBadge();
    const rows = (o, edit) => o.items.map((i, k) => `<tr>
        <td>${esc(i.name)}</td><td class="num">${qtyFmt(i.qty)} ${esc(i.unit || '')}</td>
        <td class="num">${edit ? `<input class="pi" data-k="${k}" inputmode="decimal" value="${String(i.price).replace('.', ',')}">` : money(i.price)}
          ${i.list_price != null && i.list_price !== i.price ? `<div class="old">Liste: ${money(i.list_price)}</div>` : ''}</td>
        <td class="num lt" data-k="${k}">${money(r2(i.price * i.qty))}</td></tr>`).join('');
    const card = (o, edit) => `<div class="appr-card ${edit ? '' : 'wait'}" data-id="${o.id}">
        <div class="hd"><b>Sipariş #${o.no}</b><span>${tmShort(o.created_at)}${o.approved_at ? ' · onay ' + tmShort(o.approved_at) : ''}</span></div>
        ${o.note ? `<div class="note">${esc(o.note)}</div>` : '<div class="hint">Not yok</div>'}
        <table><thead><tr><th>Ürün</th><th class="num">Miktar</th><th class="num">Birim fiyat (₺)</th><th class="num">Tutar</th></tr></thead><tbody>${rows(o, edit)}</tbody></table>
        <div class="tot"><span>TOPLAM</span><span class="tv">${money(o.total)}</span></div>
        <div class="act">${edit
          ? `<button class="danger" data-a="rej">Reddet</button><button class="ok" data-a="ok">✓ Fiyatları onayla</button>`
          : `<button class="ghost" data-a="back">Tekrar düzenle</button><button class="danger" data-a="del">Sil</button>`}</div></div>`;
    $('#apprList').innerHTML = pend.length ? pend.map(o => card(o, true)).join('') : '<div class="appr-empty">Onay bekleyen işlem yok.</div>';
    $('#apprWaiting').innerHTML = wait.length ? wait.map(o => card(o, false)).join('') : '<div class="appr-empty">Yok.</div>';

    document.querySelectorAll('#tab-approvals .appr-card').forEach(c => {
      const o = all.find(x => x.id === c.dataset.id);
      const read = () => o.items.map((i, k) => {
        const inp = c.querySelector(`input.pi[data-k="${k}"]`);
        return { ...i, price: inp ? r2(parseNum(inp.value)) : i.price };
      });
      c.querySelectorAll('input.pi').forEach(inp => {
        const k = Number(inp.dataset.k);
        const upd = () => {
          const items = read(), it = items[k];
          inp.classList.toggle('chg', it.price !== o.items[k].req_price);
          c.querySelector(`.lt[data-k="${k}"]`).textContent = Number.isFinite(it.price) ? money(r2(it.price * it.qty)) : '—';
          c.querySelector('.tv').textContent = money(ordTotal(items.map(i => ({ ...i, price: Number.isFinite(i.price) ? i.price : 0 }))));
        };
        inp.oninput = upd;
        inp.onfocus = () => inp.select();
        inp.onkeydown = e => { if (e.key === 'Enter') { const nx = c.querySelector(`input.pi[data-k="${k + 1}"]`); if (nx) nx.focus(); else c.querySelector('[data-a=ok]').focus(); } };
        upd();
      });
      c.querySelectorAll('[data-a]').forEach(b => b.onclick = async () => {
        const a = b.dataset.a;
        if (a === 'ok') {
          const items = read();
          if (items.some(i => !(i.price > 0))) return toast('Tüm ürünlere geçerli bir fiyat girin', 'err');
          await saveOrder({ ...o, items, total: ordTotal(items), status: 'approved', approved_at: nowIso(), notified: false });
          toast(`Sipariş #${o.no} onaylandı — satış ekranına gönderildi`, 'ok');
        }
        if (a === 'rej') {
          if (!(await confirmBox('Reddet', `Sipariş #${o.no} reddedilsin mi?`, 'Reddet', true))) return;
          await saveOrder({ ...o, status: 'rejected', rejected_at: nowIso(), notified: false });
          toast(`Sipariş #${o.no} reddedildi`, 'warn');
        }
        if (a === 'back') {
          if (activeOrder === o.id) { activeOrder = null; cart = []; renderCart(); }
          await saveOrder({ ...o, status: 'pending', approved_at: null, notified: true });
        }
        if (a === 'del') {
          if (!(await confirmBox('Sil', `Onaylı sipariş #${o.no} silinsin mi?`, 'Sil', true))) return;
          if (activeOrder === o.id) { activeOrder = null; cart = []; renderCart(); }
          await DB.write([{ store: 'orders', del: o.id }], [{ table: 'orders', row: { id: o.id }, op: 'delete' }]); Sync.run();
        }
        renderApprovals();
      });
    });
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
        <div class="img-acts"><button type="button" class="ghost" id="fImgFile">${v.image ? 'Fotoğrafı değiştir' : 'Bilgisayardan fotoğraf seç'}</button>
          <button type="button" class="ghost" id="fImgDel">Kaldır</button><input type="file" id="fImgInput" accept="image/*" hidden></div></div>
      <label>Barkod
        <input id="fBarcode" value="${esc(v.barcode)}" placeholder="Barkodu okutun veya yazın">
      </label>
      <label>Ürün adı<input id="fName" value="${esc(v.name)}" ${opts.barcode || !isNew ? 'autofocus' : ''}></label>
      <div class="two">
        <label>Stok kodu (isteğe bağlı)<input id="fCode" value="${esc(v.code || '')}"></label>
        <label>Kategori (satış ekranı)<input id="fCat" list="catList" value="${esc(v.category || (v.name ? Importer.guessCategory(v.name) : ''))}" placeholder="ör. Fındık Ezmesi"></label>
      </div>
      <label>Alt grup (boş bırakılırsa addan otomatik)<input id="fSub" list="subList" value="${esc(v.subgroup || '')}" placeholder="${esc(v.name ? Importer.guessSubgroup(v.name, v.category || Importer.guessCategory(v.name)) || 'ör. Şekersiz Ezme' : 'ör. Şekersiz Ezme')}">
        <datalist id="subList">${[...new Set([...products.values()].map(subOf).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'tr')).map(x => `<option value="${esc(x)}">`).join('')}</datalist></label>
      <div class="two">
        <label>Satış fiyatı (KDV dahil ₺)<input id="fPrice" inputmode="decimal" value="${v.price === '' ? '' : String(v.price).replace('.', ',')}"></label>
        <label>KDV %<select id="fVat">${[0, 1, 10, 20].map(r => `<option ${Number(v.vat_rate) === r ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
      </div>
      <div class="two">
        <label>Birim<select id="fUnit">${units.map(u => `<option ${v.unit === u ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
        <label>Terazi kodu (PLU, isteğe bağlı)<input id="fScale" inputmode="numeric" value="${esc(v.scale_code || '')}" placeholder="ör. 00123"></label>
      </div>
      <div class="two">
        <label>Alış fiyatı / maliyet (KDV dahil ₺, kâr raporu için)<input id="fCost" inputmode="decimal" value="${v.cost != null && v.cost !== '' ? String(v.cost).replace('.', ',') : ''}" placeholder="boş bırakılabilir"></label>

      </div>
      <div class="btns"><button class="ghost" id="fCancel">Vazgeç</button><button class="primary" id="fSave">Kaydet (Enter)</button></div>`, m => {
      let image = v.image || null;
      const showImg = () => { m.querySelector('#fImgPrev').innerHTML = image ? `<img src="${image}" alt="">` : '<span>Fotoğraf yok</span>'; };
      m.querySelector('#fImgFile').onclick = () => m.querySelector('#fImgInput').click();
      m.querySelector('#fImgInput').onchange = async e => {
        const f = e.target.files[0]; if (!f) return;
        try {
          const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(f); });
          image = await toThumb(url); showImg();
        } catch (_) { toast('Resim okunamadı', 'err'); }
        e.target.value = '';
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
          subgroup: m.querySelector('#fSub').value.trim() || null,
          scale_code: m.querySelector('#fScale').value.trim() || null,
          cost: (() => { const c = parseNum(m.querySelector('#fCost').value); return m.querySelector('#fCost').value.trim() && c >= 0 ? r2(c) : null; })(),
          image: image || null, noPhoto: !image && !!v.image ? true : (image ? false : !!v.noPhoto),
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
      <div class="hint"><b>Toplu fiyat değişikliği için:</b> "Güncel ürün listesini indir" ile mevcut ürünlerinizi Excel olarak alın, fiyatları Excel'de değiştirip aynı dosyayı buradan geri yükleyin.
      Satırlar stok kodu / barkod / ürün ID ile eşleşir, ürünler tekrar eklenmez.</div>
      <div class="btns"><button class="ghost" id="iS">⬇ Örnek Excel</button><button class="ghost" id="iL">⬇ Güncel ürün listesini indir</button><span class="grow"></span>
        <button class="ghost" id="iC">Vazgeç</button><button class="primary" id="iO">Dosya seç</button></div>`, m => {
      m.querySelector('#iC').onclick = closeModal;
      m.querySelector('#iO').onclick = () => { closeModal(); $('#importFile').value = ''; $('#importFile').click(); };
      m.querySelector('#iL').onclick = async () => {
        const list = [...products.values()].sort((a, b) => catOf(a).localeCompare(catOf(b), 'tr') || a.name.localeCompare(b.name, 'tr'));
        if (!list.length) return toast('Henüz ürün yok', 'warn');
        const rows = [
          ['GÜNCEL ÜRÜN LİSTESİ · ' + (settings.storeName || 'Hızlı Kasa') + ' · ' + new Date().toLocaleString('tr-TR')],
          ['Stok Kodu', 'Stok Adı', 'BARKOD', 'KDV %', 'PERAKENDE FİYATI', 'KDV dahil mi?', 'Birimi', 'Kategori', 'Alt Grup', 'Ürün ID', 'ALIŞ FİYATI'],
          ...list.map(p => [p.code || '', p.name, p.barcode || '', Number(p.vat_rate) || 0, Number(p.price) || 0, 'EVET', (p.unit || 'adet').toLocaleUpperCase('tr-TR'), catOf(p), p.subgroup || '', p.id, p.cost != null ? Number(p.cost) : ''])
        ];
        const name = 'urun-listesi-' + new Date().toISOString().slice(0, 10) + '.xlsx';
        try {
          if (window.kasa && window.kasa.saveExcel) {
            const r = await window.kasa.saveExcel(rows, name);
            if (r && r.saved) toast(`${list.length} ürün Excel'e aktarıldı: ` + r.path, 'ok');
          } else {
            const csv = rows.slice(1).map(r => r.map(v => String(v).replace(/;/g, ',')).join(';')).join('\r\n');
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv' }));
            a.download = name.replace('.xlsx', '.csv'); a.click();
          }
        } catch (err) { toast('Kaydedilemedi: ' + err.message, 'err'); }
      };
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
    const findOld = it => (it.id && products.get(it.id)) || (it.code && byCodeMap.get(it.code))
      || (it.barcode && byBarcode.has(it.barcode) && products.get(byBarcode.get(it.barcode))) || null;
    const newCount = items.filter(it => !findOld(it)).length;
    const hasStock = false;
    const hasPrice = items.some(it => Number.isFinite(it.price));
    const exclVat = items.some(it => it.vatIncl === false && Number.isFinite(it.price));
    const salePrice = (it, addVat) => !Number.isFinite(it.price) ? NaN
      : r2(addVat && it.vatIncl === false && it.vat > 0 ? it.price * (1 + it.vat / 100) : it.price);
    const COLS = { code: 'Stok kodu', name: 'Ürün adı', extra: 'Özel kod', group: 'Grup', unit: 'Birim', barcode: 'Barkod', stock: 'Stok', price: 'Fiyat', vat: 'KDV %', vatIncl: 'KDV dahil mi', category: 'Kategori', subgroup: 'Alt grup', id: 'Ürün ID', cost: 'Alış fiyatı' };
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
        code: it.code || old.code || null, group: it.group || old.group || null, category: it.category || old.category || null, subgroup: it.subgroup || old.subgroup || null,
        barcode: barcode || old.barcode || null, unit: it.unit || old.unit,
        price: Number.isFinite(it.price) ? r2(it.price) : old.price,
        cost: Number.isFinite(it.cost) ? r2(it.cost) : (old.cost ?? null),
        vat_rate: Number.isFinite(it.vat) ? it.vat : old.vat_rate,
        active: true, updated_at: ts
      } : {
        id: uuid(), code: it.code || null, barcode, name: it.name, group: it.group || null, category: it.category || Importer.guessCategory(it.name), subgroup: it.subgroup || null,
        price: Number.isFinite(it.price) ? r2(it.price) : 0, stock: 0, cost: Number.isFinite(it.cost) ? r2(it.cost) : null,
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
      setTimeout(autoPhotos, 500);
      toast(`${added} yeni ürün eklendi, ${rows.length - added} ürün güncellendi${dupBarcode ? ` (${dupBarcode} çakışan barkod korunarak atlandı)` : ''}`, 'ok');
      Sync.run();
    } catch (err) { toast('İçe aktarma başarısız: ' + err.message, 'err'); }
  }

  // ---------- AYLIK RAPOR, ARŞİV VE HATIRLATMA ----------
  const ymOf = d => { d = new Date(d); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };
  const ymLabel = ym => { const [y, m] = ym.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('tr-TR', { month: 'long', year: 'numeric' }); };
  const ymIndex = ym => { const [y, m] = ym.split('-').map(Number); return y * 12 + (m - 1); };
  const ymDeadline = ym => { const [y, m] = ym.split('-').map(Number); return new Date(y, m - 1 + 4, 0); };   // ay sonu + 3 ay
  let saleLocked = null;   // kilitliyse geciken ay

  async function monthlyStatus() {
    const cur = ymOf(new Date());
    const archived = new Set((await DB.all('archives')).map(a => a.month));
    const months = new Set((await DB.all('sales')).map(s => ymOf(s.created_at)));
    const pending = [...months].filter(m => m < cur && !archived.has(m)).sort();
    const overdue = pending.filter(m => ymIndex(cur) - ymIndex(m) > 3);
    return { cur, pending, overdue, archived };
  }

  async function checkMonthly() {
    if (IS_WEB) { saleLocked = null; return null; }    // aylık arşiv kasa bilgisayarında tutulur
    const st = await monthlyStatus();
    saleLocked = st.overdue[0] || null;
    const b = $('#monthBanner');
    if (!st.pending.length) { b.classList.add('hidden'); return st; }
    const first = st.pending[0];
    b.className = 'month-banner ' + (saleLocked ? 'lock' : 'warn');
    b.innerHTML = saleLocked
      ? `<b>Satış kilitli:</b> ${ymLabel(saleLocked)} aylık raporu 3 aydır alınmadı. Satışa devam etmek için raporu alın. <button id="mbGo">Aylık raporu al</button>`
      : `<b>Hatırlatma:</b> ${st.pending.map(ymLabel).join(', ')} aylık raporu alınmadı. Son gün: <b>${ymDeadline(first).toLocaleDateString('tr-TR')}</b> — bu tarihten sonra satış kilitlenir. <button id="mbGo">Şimdi al</button>`;
    $('#mbGo').onclick = () => openMonthly();
    return st;
  }
  function lockGuard() {
    if (!saleLocked) return false;
    beep(false);
    openModal(`<h2>Satış kilitli</h2><div><b>${ymLabel(saleLocked)}</b> ayının aylık satış raporu 3 aydır alınmadı.
      Aylık raporu A4 olarak yazdırıp arşivleyene kadar yeni satış yapılamaz.</div>
      <div class="btns"><button class="ghost" id="lgCx">Kapat</button><button class="primary" id="lgGo">Aylık raporu al</button></div>`, m => {
      m.querySelector('#lgCx').onclick = closeModal;
      m.querySelector('#lgGo').onclick = () => { closeModal(); openMonthly(); };
    });
    return true;
  }

  function monthData(ym, sales) {
    const ok = sales.filter(s => s.status === 'completed');
    const sum = arr => r2(arr.reduce((a, s) => a + s.total, 0));
    return {
      month: ym, label: ymLabel(ym), sales, count: ok.filter(s => s.kind !== 'refund').length, total: sum(ok),
      cash: r2(ok.reduce((a, s) => a + payOf(s).cash, 0)), card: r2(ok.reduce((a, s) => a + payOf(s).card, 0)),
      credit: r2(ok.reduce((a, s) => a + payOf(s).credit, 0)),
      cancelled: sales.length - ok.length, cancelledTotal: sum(sales.filter(s => s.status !== 'completed'))
    };
  }
  async function salesOfMonth(ym) {
    const [y, m] = ym.split('-').map(Number);
    return DB.range('sales', 'created_at', new Date(y, m - 1, 1).toISOString(), new Date(y, m, 0, 23, 59, 59, 999).toISOString());
  }
  async function gzipB64(obj) {
    const stream = new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream('gzip'));
    const buf = new Uint8Array(await new Response(stream).arrayBuffer());
    let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  async function gunzipB64(b64) {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }
  async function printA4(html) {
    if (window.kasa && window.kasa.printHtml) return window.kasa.printHtml(html, { a4: true });
    const w = window.open('', '_blank'); w.document.write(html); w.document.close(); w.print(); return { success: true };
  }

  async function archiveMonth(ym) {
    const sales = await salesOfMonth(ym);
    if (!sales.length) return toast('Bu ayda satış yok', 'warn');
    const d = monthData(ym, sales);
    const r = await printA4(Receipt.monthA4(d, settings));
    if (!r || !r.success) return toast('Yazdırma tamamlanmadı — arşivleme yapılmadı', 'warn');
    try {
      const gz = await gzipB64({ month: ym, created_at: nowIso(), store: settings.storeName, sales });
      let file = '';
      if (window.kasa && window.kasa.saveArchive) file = await window.kasa.saveArchive(`satis-arsivi-${ym}.json.gz`, gz);
      const rec = { month: ym, created_at: nowIso(), count: d.count, total: d.total, cash: d.cash, card: d.card,
        cancelled: d.cancelled, cancelledTotal: d.cancelledTotal, records: sales.length, size: gz.length, file, gz };
      // arşivi kaydet ve o ayın tek tek satış kayıtlarını bu bilgisayardan kaldır (bulutta yedek olarak kalır)
      await DB.write([{ store: 'archives', value: rec }, ...sales.map(x => ({ store: 'sales', del: x.id }))]);
      toast(`${ymLabel(ym)} arşivlendi (${sales.length} satış${file ? ' · dosya: ' + file : ''})`, 'ok');
    } catch (e) { toast('Arşivlenemedi: ' + e.message, 'err'); }
    await checkMonthly();
    if (currentTab === 'report') renderReport();
  }

  async function openMonthly() {
    const st = await monthlyStatus();
    const arch = (await DB.all('archives')).sort((a, b) => b.month.localeCompare(a.month));
    openModal(`<h2>Aylık rapor &amp; arşiv</h2>
      <div class="hint">Biten her ayın tüm satışları A4 olarak yazdırılır; yazdırma tamamlanınca o ayın verileri sıkıştırılıp arşive alınır ve dosya olarak da saklanır
      (Belgeler › Hizli Kasa Arsiv). Arşivlenen ayları aşağıdan açıp görebilirsiniz. ${role === 'admin' ? 'Yönetici devam eden ayın ara raporunu her zaman alabilir.' : 'Ay bitmeden rapor alınamaz.'}</div>
      <h3 class="mh">Raporu alınacak aylar</h3>
      <div class="mlist">
        ${st.pending.map(m => `<div class="mrow ${st.overdue.includes(m) ? 'late' : ''}"><div><b>${ymLabel(m)}</b><span>Son gün: ${ymDeadline(m).toLocaleDateString('tr-TR')}${st.overdue.includes(m) ? ' · GECİKTİ, satış kilitli' : ''}</span></div>
          <button class="primary" data-arch="${m}">🖨 A4 çıktı al ve arşivle</button></div>`).join('')}
        ${role === 'admin'
          ? `<div class="mrow"><div><b>${ymLabel(st.cur)}</b><span>Ay devam ediyor — yönetici ara rapor alabilir (arşivleme ay bitince yapılır)</span></div><button class="primary" data-cur="${st.cur}">🖨 A4 ara rapor al</button></div>`
          : `<div class="mrow off"><div><b>${ymLabel(st.cur)}</b><span>Ay devam ediyor — ay bitmeden çıktı alınamaz</span></div><button disabled>A4 çıktı al</button></div>`}
      </div>
      <h3 class="mh">Arşiv</h3>
      <div class="mlist">${arch.length ? arch.map(a => `<div class="mrow"><div><b>${ymLabel(a.month)}</b>
          <span>${a.count} satış · ${money(a.total)} (Nakit ${money(a.cash)} · Kart ${money(a.card)}) · ${(a.size * 0.75 / 1024).toFixed(1)} KB</span></div>
          <div class="row-btns"><button class="ghost" data-view="${a.month}">Görüntüle</button><button class="ghost" data-reprint="${a.month}">Tekrar yazdır</button></div></div>`).join('')
        : '<div class="hint">Henüz arşivlenmiş ay yok.</div>'}</div>
      <div class="btns"><button class="ghost" id="moC">Kapat</button></div>`, m => {
      m.classList.add('wide');
      modalClose = () => m.classList.remove('wide');
      m.querySelector('#moC').onclick = closeModal;
      m.querySelectorAll('[data-arch]').forEach(b => b.onclick = async () => {
        const ym = b.dataset.arch;
        if (!(await confirmBox('Aylık rapor', `${ymLabel(ym)} satışları A4 olarak yazdırılacak. Yazdırma tamamlanınca bu ayın verileri arşive alınacak ve günlük listeden kalkacak (arşivden görüntülenebilir, bulutta yedeği kalır).`, 'Yazdır ve arşivle'))) return;
        await archiveMonth(ym); openMonthly();
      });
      m.querySelectorAll('[data-view]').forEach(b => b.onclick = () => viewArchive(b.dataset.view));
      m.querySelectorAll('[data-cur]').forEach(b => b.onclick = async () => {
        if (role !== 'admin') return;
        const ym = b.dataset.cur;
        const sales = await salesOfMonth(ym);
        if (!sales.length) return toast('Bu ay henüz satış yok', 'warn');
        const d = monthData(ym, sales); d.label += ' (ara rapor — ' + new Date().toLocaleDateString('tr-TR') + ' itibarıyla)';
        await printA4(Receipt.monthA4(d, settings));
      });
      m.querySelectorAll('[data-reprint]').forEach(b => b.onclick = async () => {
        const a = await DB.get('archives', b.dataset.reprint);
        const data = await gunzipB64(a.gz);
        await printA4(Receipt.monthA4(monthData(a.month, data.sales), settings));
      });
    });
  }

  async function viewArchive(ym) {
    const a = await DB.get('archives', ym); if (!a) return;
    let data;
    try { data = await gunzipB64(a.gz); } catch (e) { return toast('Arşiv açılamadı: ' + e.message, 'err'); }
    const d = monthData(ym, data.sales);
    const top = new Map();
    data.sales.filter(s => s.status === 'completed').forEach(s => s.items.forEach(i => {
      const t = top.get(i.name) || { qty: 0, total: 0 }; t.qty = r3(t.qty + i.qty); t.total = r2(t.total + i.total); top.set(i.name, t);
    }));
    const list = data.sales.slice().sort((x, y) => y.created_at.localeCompare(x.created_at));
    openModal(`<h2>${ymLabel(ym)} — arşiv</h2>
      <div class="cards mini">${[['Toplam ciro', money(d.total)], ['Nakit', money(d.cash)], ['Kredi kartı', money(d.card)], ['Satış', d.count], ['İptal', d.cancelled]]
        .map(([l, v]) => `<div class="card-s"><div class="l">${l}</div><div class="v">${v}</div></div>`).join('')}</div>
      <div class="two-col">
        <div class="preview"><table class="grid"><thead><tr><th>Tarih</th><th>Fiş</th><th>Ödeme</th><th class="num">Tutar</th></tr></thead><tbody>
          ${list.map(s => `<tr class="${s.status !== 'completed' ? 'cancel' : ''}"><td>${new Date(s.created_at).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' })}</td><td>#${s.sale_no}</td>
            <td>${esc(payLabel(s))}</td><td class="num">${money(s.total)}</td></tr>`).join('')}</tbody></table></div>
        <div class="preview"><table class="grid"><thead><tr><th>Ürün</th><th class="num">Miktar</th><th class="num">Tutar</th></tr></thead><tbody>
          ${[...top].sort((x, y) => y[1].total - x[1].total).map(([n, t]) => `<tr><td>${esc(n)}</td><td class="num">${qtyFmt(t.qty)}</td><td class="num">${money(t.total)}</td></tr>`).join('')}</tbody></table></div>
      </div>
      <div class="btns"><button class="ghost" id="vaP">A4 yazdır</button><button class="primary" id="vaC">Kapat</button></div>`, m => {
      m.classList.add('wide');
      modalClose = () => m.classList.remove('wide');
      m.querySelector('#vaC').onclick = closeModal;
      m.querySelector('#vaP').onclick = () => printA4(Receipt.monthA4(d, settings));
    });
  }
  $('#repMonthly').onclick = openMonthly;

  // ---------- GÜN SONU ----------
  const pad = n => String(n).padStart(2, '0');
  const localDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  $('#repDate').value = localDate(new Date());
  $('#repDate').addEventListener('change', renderReport);
  $('#repToday').onclick = () => { $('#repDate').value = localDate(new Date()); renderReport(); };

  async function dayData() {
    const [y, m, d] = $('#repDate').value.split('-').map(Number);
    const start = new Date(y, m - 1, d, 0, 0, 0, 0), end = new Date(y, m - 1, d, 23, 59, 59, 999);
    const sIso = start.toISOString(), eIso = end.toISOString();
    const sales = (await DB.range('sales', 'created_at', sIso, eIso)).sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (sales.some(s => s.customer_id && !s.customer_phone)) {
      const cm = new Map((await DB.all('customers')).map(c => [c.id, c.phone || '']));
      sales.forEach(s => { if (s.customer_id && !s.customer_phone) s.customer_phone = cm.get(s.customer_id) || ''; });
    }
    const ok = sales.filter(s => s.status === 'completed');
    const real = ok.filter(s => s.kind !== 'refund'), refunds = ok.filter(s => s.kind === 'refund');
    const sum = arr => r2(arr.reduce((a, s) => a + s.total, 0));
    const topMap = new Map();
    ok.forEach(s => s.items.forEach(i => {
      const k = i.product_id || i.name;
      const t = topMap.get(k) || { name: i.name, qty: 0, total: 0 };
      t.qty = r3(t.qty + i.qty); t.total = r2(t.total + i.total); topMap.set(k, t);
    }));
    const tm = iso => new Date(iso).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    const pays = ok.map(payOf);
    const cash = r2(pays.reduce((a, p) => a + p.cash, 0)), card = r2(pays.reduce((a, p) => a + p.card, 0)), credit = r2(pays.reduce((a, p) => a + p.credit, 0));
    const discountTotal = r2(real.reduce((a, s) => a + (Number(s.discount) || 0)
      + s.items.reduce((b, i) => b + (i.list_price != null && i.list_price > i.price ? (i.list_price - i.price) * i.qty : 0), 0), 0));
    // Kasa hareketleri ve veresiye tahsilatları
    const moves = (await DB.range('cash_moves', 'created_at', sIso, eIso)).sort((a, b) => a.created_at.localeCompare(b.created_at));
    const collects = (await DB.range('cari', 'created_at', sIso, eIso)).filter(e => e.type === 'collect');
    const opens = moves.filter(x => x.type === 'open');
    const opening = opens.length ? Number(opens.at(-1).amount) : 0;
    const ins = moves.filter(x => x.type === 'in'), outs = moves.filter(x => x.type === 'out');
    const collectCash = r2(-collects.filter(e => e.method !== 'card').reduce((a, e) => a + e.amount, 0));
    const collectCard = r2(-collects.filter(e => e.method === 'card').reduce((a, e) => a + e.amount, 0));
    const expected = r2(opening + cash + ins.reduce((a, x) => a + x.amount, 0) - outs.reduce((a, x) => a + x.amount, 0) + collectCash);
    const counts = moves.filter(x => x.type === 'count');
    const byC = new Map();
    ok.forEach(s => {
      const n = (s.cashier && s.cashier.name) || '—';
      const c = byC.get(n) || { name: n, n: 0, total: 0 };
      if (s.kind !== 'refund') c.n++; c.total = r2(c.total + s.total); byC.set(n, c);
    });
    return {
      sales, dateLabel: start.toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
      count: real.length, total: sum(ok), cash, card, credit, discountTotal,
      refundTotal: r2(-sum(refunds)), refundCount: refunds.length,
      cancelled: sales.length - ok.length, cancelledTotal: sum(sales.filter(s => s.status !== 'completed')),
      firstSale: real.length ? tm(real.at(-1).created_at) : '', lastSale: real.length ? tm(real[0].created_at) : '',
      top: [...topMap.values()].filter(t => t.qty > 0).sort((a, b) => b.total - a.total),
      kasa: { opening, ins, outs, collectCash, collectCard, expected, count: counts.at(-1) || null, moves, collects },
      byCashier: [...byC.values()].sort((a, b) => b.total - a.total)
    };
  }

  let repCache = null;
  const MOVE_LABEL = { open: 'Açılış bakiyesi', in: 'Para girişi', out: 'Para çıkışı', count: 'Kasa sayımı' };
  async function renderReport() {
    const r = repCache = await dayData();
    const ymSel = $('#repDate').value.slice(0, 7);
    const arc = await DB.get('archives', ymSel);
    const note = $('#repArchivedNote');
    note.className = 'month-banner info' + (arc ? '' : ' hidden');
    if (arc) { note.innerHTML = `${ymLabel(ymSel)} arşivlendi. Bu ayın satışlarını görmek için <button id="rnGo">Arşivi aç</button>`; $('#rnGo').onclick = () => viewArchive(ymSel); }
    const k = r.kasa;
    $('#repCards').innerHTML = [
      ['Net ciro', money(r.total), 'main'], ['Nakit', money(r.cash)], ['Kredi kartı', money(r.card)], ['Veresiye', money(r.credit)],
      ['Satış adedi', r.count], ['İadeler', r.refundCount ? `${r.refundCount} · ${money(r.refundTotal)}` : '—'],
      ['İndirimler', r.discountTotal ? money(r.discountTotal) : '—'], ['Kasada olmalı', money(k.expected)]
    ].map(([l, v, c]) => `<div class="card-s ${c || ''}"><div class="l">${l}</div><div class="v">${v}</div></div>`).join('');
    const row = s => `<tr class="click ${s.status !== 'completed' ? 'cancel' : ''}" data-id="${s.id}">
      <td>${new Date(s.created_at).toLocaleTimeString('tr-TR')}</td><td>#${s.sale_no}</td><td class="num">${s.items.length}</td>
      <td>${esc(payLabel(s))}${s.customer_name ? ' · ' + esc(s.customer_name) : ''}${s.customer_phone ? ` <span class="phone">${esc(s.customer_phone)}</span>` : ''}${s.cashier && s.cashier.name && r.byCashier.length > 1 ? ` <small>(${esc(s.cashier.name)})</small>` : ''}${s.status !== 'completed' ? ' (iptal)' : ''}</td><td class="num">${money(s.total)}</td></tr>`;
    const section = (label, list, always) => {
      if (!list.length && !always) return '';
      const okList = list.filter(s => s.status === 'completed');
      return `<tr class="sec"><td colspan="4">${label} <span>${okList.length} kayıt</span></td><td class="num">${money(okList.reduce((a, s) => a + s.total, 0))}</td></tr>`
        + (list.map(row).join('') || '<tr><td colspan="5" style="color:var(--dim)">Satış yok</td></tr>');
    };
    const of = t => r.sales.filter(s => s.kind !== 'refund' && s.payment_type === t);
    $('#repSales').innerHTML = r.sales.length
      ? section('Nakit satışlar', of('cash'), true) + section('Kredi kartı satışları', of('card'), true)
        + section('Parçalı ödemeler', of('mixed')) + section('Veresiye satışlar', of('credit')) + section('İadeler', r.sales.filter(s => s.kind === 'refund'))
      : '<tr><td colspan="5" style="color:var(--muted)">Bu tarihte satış yok</td></tr>';
    $('#repTop').innerHTML = r.top.slice(0, 30).map(t => `<tr><td>${esc(t.name)}</td><td class="num">${qtyFmt(t.qty)}</td><td class="num">${money(t.total)}</td></tr>`).join('');
    // Kasa paneli
    const line = (l, v, cls = '') => `<div class="kl ${cls}"><span>${l}</span><b>${v}</b></div>`;
    $('#kasaSum').innerHTML = line('Açılış', money(k.opening)) + line('Nakit satış (net)', money(r.cash))
      + (k.collectCash ? line('Veresiye tahsilatı', money(k.collectCash)) : '')
      + line('Para girişi', money(k.ins.reduce((a, x) => a + x.amount, 0))) + line('Para çıkışı', (k.outs.length ? '−' : '') + money(k.outs.reduce((a, x) => a + x.amount, 0)))
      + line('Kasada olması gereken', money(k.expected), 'strong')
      + (k.count ? line(`Sayılan (${new Date(k.count.created_at).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })})`, money(k.count.amount))
        + line('Fark', (k.count.amount - k.expected >= 0 ? '+' : '') + money(k.count.amount - k.expected), Math.abs(k.count.amount - k.expected) < 0.01 ? 'good' : 'bad')
        : '<div class="hint">Henüz kasa sayımı yapılmadı.</div>');
    const mv = [...k.moves, ...k.collects.map(e => ({ ...e, type: 'collect' }))].sort((a, b) => b.created_at.localeCompare(a.created_at));
    $('#kasaMoves').innerHTML = mv.map(x => `<div class="mv"><span class="t">${new Date(x.created_at).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}</span>
      <span class="n">${x.type === 'collect' ? `Tahsilat · ${esc(x.customer_name || '')} (${x.method === 'card' ? 'kart' : 'nakit'})` : esc(MOVE_LABEL[x.type] || x.type)}${x.note ? ' · ' + esc(x.note) : ''}${x.cashier && x.cashier.name ? ` <small>${esc(x.cashier.name)}</small>` : ''}</span>
      <b>${x.type === 'out' ? '−' : ''}${money(Math.abs(x.amount))}</b>${role === 'admin' && x.type !== 'collect' ? `<button class="x" data-del="${x.id}" title="Sil">✕</button>` : ''}</div>`).join('');
    $('#kasaMoves').querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (role !== 'admin') return;
      if (!(await confirmBox('Kasa hareketini sil', 'Bu kasa hareketi kalıcı olarak silinsin mi?', 'Sil', true))) return;
      await DB.write([{ store: 'cash_moves', del: b.dataset.del }], [{ table: 'cash_moves', row: { id: b.dataset.del }, op: 'delete' }]);
      Sync.run(); renderReport();
    });
  }
  $('#repSales').addEventListener('click', e => {
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    const s = repCache.sales.find(x => x.id === tr.dataset.id); if (s) saleDetail(s);
  });
  $('#repPrint').onclick = async () => printHtml(Receipt.dayReport(await dayData(), settings));

  async function saleDetail(s) {
    const refunds = s.kind !== 'refund' ? (await DB.all('sales')).filter(x => x.ref_sale_id === s.id && x.status === 'completed') : [];
    const p = payOf(s);
    const canRefund = s.kind !== 'refund' && s.status === 'completed' && can('refund');
    const canCancel = s.status === 'completed' && can('cancel');
    openModal(`<h2>${s.kind === 'refund' ? 'İade' : 'Satış'} #${s.sale_no} ${s.status !== 'completed' ? '(İPTAL)' : ''}</h2>
      <div class="hint">${new Date(s.created_at).toLocaleString('tr-TR')} · ${esc(payLabel(s))}${s.payment_type === 'mixed' ? ` (Nakit ${money(p.cash)} · Kart ${money(p.card)})` : ''}
        ${s.customer_name ? ' · Müşteri: ' + esc(s.customer_name) : ''}${s.customer_phone ? ' · Tel: ' + esc(s.customer_phone) : ''}${s.cashier && s.cashier.name ? ' · ' + esc(s.cashier.name) : ''}
        ${s.kind === 'refund' && s.ref_sale_no ? ' · Satış fişi #' + s.ref_sale_no : ''}${s.note ? ' · ' + esc(s.note) : ''}</div>
      <table class="grid items"><tbody>${s.items.map(i => `<tr><td>${esc(i.name)}</td><td class="num">${qtyFmt(i.qty)} x ${money(i.price)}${i.list_price != null && i.list_price > i.price ? ` <s>${money(i.list_price)}</s>` : ''}</td><td class="num">${money(i.total)}</td></tr>`).join('')}
        ${Number(s.discount) > 0 ? `<tr><td colspan="2">Fiş indirimi</td><td class="num">−${money(s.discount)}</td></tr>` : ''}</tbody></table>
      <div class="big-total">${money(s.total)}</div>
      ${refunds.length ? `<div class="hint">Bu satıştan yapılan iadeler: ${refunds.map(r => `#${r.sale_no} (${money(r.total)})`).join(', ')}</div>` : ''}
      <div class="btns">${canRefund ? '<button class="ghost" id="dRefund">İade al</button>' : ''}${canCancel ? '<button class="danger" id="dCancel">Satışı iptal et</button>' : ''}${role === 'admin' ? '<button class="danger" id="dDelete">Kaydı sil</button>' : ''}<span class="grow"></span>
        <button class="ghost" id="dPrint">Fiş yazdır</button><button class="primary" id="dClose">Kapat</button></div>`, m => {
      m.querySelector('#dClose').onclick = closeModal;
      m.querySelector('#dPrint').onclick = () => printSale(s);
      const rf = m.querySelector('#dRefund'); if (rf) rf.onclick = () => openRefund(s);
      const del = m.querySelector('#dDelete');
      if (del) del.onclick = async () => {
        if (role !== 'admin') return;
        if (!(await confirmBox('Satış kaydını sil', `#${s.sale_no} numaralı ${money(s.total)} tutarlı kayıt bu bilgisayardan ve buluttan kalıcı olarak silinecek. Bu işlem geri alınamaz.`, 'Kalıcı olarak sil', true))) return;
        try {
          const linked = (await DB.all('cari')).filter(e => e.sale_id === s.id);
          await DB.write([{ store: 'sales', del: s.id }, ...linked.map(e => ({ store: 'cari', del: e.id }))],
            [{ table: 'sales', row: { id: s.id }, op: 'delete' }, ...linked.map(e => ({ table: 'cari', row: { id: e.id }, op: 'delete' }))]);
          if (lastSale && lastSale.id === s.id) { lastSale = null; renderLastSale(); }
          toast(`Kayıt #${s.sale_no} silindi`, 'ok'); renderReport(); Sync.run();
        } catch (e) { toast('Silinemedi: ' + e.message, 'err'); }
      };
      const c = m.querySelector('#dCancel');
      if (c) c.onclick = async () => {
        if (!need('cancel')) return;
        if (!(await confirmBox('İptal', `#${s.sale_no} numaralı ${money(s.total)} tutarlı kayıt iptal edilecek olarak işaretlenecek ve ciroya dahil edilmeyecek.`, 'İptal et', true))) return;
        await cancelSale(s);
      };
    });
  }

  async function cancelSale(s) {
    const ts = nowIso();
    const ns = { ...s, status: 'cancelled', cancelled_at: ts };
    const ops = [{ store: 'sales', value: ns }], sync = [{ table: 'sales', row: ns }], upd = [];
    if (s.payment_type === 'credit' && s.customer_id) {
      const e = { id: uuid(), customer_id: s.customer_id, customer_name: s.customer_name, created_at: ts, updated_at: ts, type: 'cancel',
        amount: r2(-s.total), sale_id: s.id, sale_no: s.sale_no, note: '', cashier: actor(), device: deviceId };
      ops.push({ store: 'cari', value: e }); sync.push({ table: 'cari', row: e });
    }
    upd.forEach(np => { ops.push({ store: 'products', value: np }); sync.push({ table: 'products', row: np }); });
    try {
      await DB.write(ops, sync);
      upd.forEach(indexProduct);
      if (lastSale && lastSale.id === s.id) { lastSale = ns; renderLastSale(); }
      toast(`Satış #${s.sale_no} iptal edildi`, 'ok');
      renderReport(); Sync.run();
    } catch (e) { toast('İptal edilemedi: ' + e.message, 'err'); }
  }

  // ======================================================================
  // ---------- KASİYERLER ----------
  function cashierLogin() {
    if (!users.length) { cashier = null; role = null; mode = 'sale'; return showTab('sale'); }
    let picked = null;
    openModal(`<h2>Kasiyer girişi</h2><div class="hint">Satışa başlamak için adınızı seçip PIN girin.</div>
      <div class="cashier-pick">${users.map(u => `<button type="button" data-u="${esc(u.id)}">${esc(u.name)}</button>`).join('')}</div>
      <label class="pin-row hidden" id="ciPinRow"><span id="ciWho"></span><input id="ciPin" type="password" inputmode="numeric" autocomplete="off" maxlength="8"></label>
      <div class="btns"><button class="ghost" id="ciC">Ana ekran</button><button class="primary" id="ciO" disabled>Giriş</button></div>`, m => {
      const pin = m.querySelector('#ciPin');
      modalClose = () => { if (!cashier) goHome(); };
      m.querySelectorAll('[data-u]').forEach(b => b.onclick = () => {
        picked = users.find(u => u.id === b.dataset.u);
        m.querySelectorAll('[data-u]').forEach(x => x.classList.toggle('on', x === b));
        m.querySelector('#ciPinRow').classList.remove('hidden');
        m.querySelector('#ciWho').textContent = picked.name + ' · PIN';
        m.querySelector('#ciO').disabled = false; pin.value = ''; pin.focus();
      });
      const ok = async () => {
        if (!picked) return;
        if (await sha(picked.salt + ':' + pin.value) !== picked.pinHash) { beep(false); pin.value = ''; pin.focus(); return toast('PIN hatalı', 'err'); }
        cashier = { id: picked.id, name: picked.name, perms: { ...DEFAULT_PERMS, ...(picked.perms || {}) } };
        role = null; mode = 'sale';
        closeModal(); showTab('sale');
        toast('Hoş geldin, ' + picked.name, 'ok');
      };
      m.querySelector('#ciO').onclick = ok;
      pin.onkeydown = e => { if (e.key === 'Enter') ok(); };
      m.querySelector('#ciC').onclick = closeModal;
      if (users.length === 1) m.querySelector('[data-u]').click();
    });
  }
  async function saveUsers(list) {
    const row = { id: 'users', list, updated_at: nowIso() };
    await DB.write([{ store: 'meta', value: { key: 'users', value: { list, updated_at: row.updated_at } } }], [{ table: 'config', row }]);
    users = list; Sync.run(); renderUsers();
  }
  function renderUsers() {
    const el = $('#userList'); if (!el) return;
    el.innerHTML = users.length ? users.map(u => `<div class="user-row"><div><b>${esc(u.name)}</b>
        <span>${PERMS.filter(([k]) => ({ ...DEFAULT_PERMS, ...(u.perms || {}) })[k]).map(([, l]) => l).join(' · ') || 'Yalnızca satış'}</span></div>
        <div class="row-btns"><button class="ghost" data-ue="${esc(u.id)}">Düzenle</button><button class="ghost" data-ud="${esc(u.id)}" style="color:#f87171">Sil</button></div></div>`).join('')
      : '<div class="hint">Henüz kasiyer yok. Satış ekranı şifresiz açılıyor.</div>';
    el.querySelectorAll('[data-ue]').forEach(b => b.onclick = () => userForm(users.find(u => u.id === b.dataset.ue)));
    el.querySelectorAll('[data-ud]').forEach(b => b.onclick = async () => {
      const u = users.find(x => x.id === b.dataset.ud);
      if (await confirmBox('Kasiyeri sil', `${u.name} silinsin mi? Geçmiş satışlardaki adı korunur.`, 'Sil', true)) saveUsers(users.filter(x => x.id !== u.id));
    });
  }
  function userForm(u) {
    if (role !== 'admin') return;
    const isNew = !u, perms = { ...DEFAULT_PERMS, ...((u && u.perms) || {}) };
    openModal(`<h2>${isNew ? 'Yeni kasiyer' : 'Kasiyeri düzenle'}</h2>
      <label>Ad<input id="uName" value="${esc(u ? u.name : '')}" autofocus></label>
      <label>PIN (4-8 rakam)${isNew ? '' : ' · değiştirmeyecekseniz boş bırakın'}<input id="uPin" type="password" inputmode="numeric" maxlength="8" autocomplete="new-password"></label>
      <div class="perm-list">${PERMS.map(([k, l]) => `<label class="chk"><input type="checkbox" data-perm="${k}" ${perms[k] ? 'checked' : ''}> ${l}</label>`).join('')}</div>
      <div class="btns"><button class="ghost" id="uC">Vazgeç</button><button class="primary" id="uO">Kaydet</button></div>`, m => {
      m.querySelector('#uC').onclick = closeModal;
      m.querySelector('#uO').onclick = async () => {
        const name = m.querySelector('#uName').value.trim(), pin = m.querySelector('#uPin').value.trim();
        if (!name) return toast('Ad gerekli', 'err');
        if (users.some(x => x.name.toLocaleLowerCase('tr-TR') === name.toLocaleLowerCase('tr-TR') && (!u || x.id !== u.id))) return toast('Bu adla bir kasiyer var', 'err');
        if ((isNew || pin) && !/^\d{4,8}$/.test(pin)) return toast('PIN 4-8 rakam olmalı', 'err');
        const np = {}; m.querySelectorAll('[data-perm]').forEach(c => { np[c.dataset.perm] = c.checked; });
        const row = { ...(u || {}), id: u ? u.id : uuid(), name, perms: np };
        if (pin) { row.salt = uuid(); row.pinHash = await sha(row.salt + ':' + pin); }
        await saveUsers(isNew ? [...users, row] : users.map(x => x.id === row.id ? row : x));
        closeModal(); toast('Kasiyer kaydedildi', 'ok');
      };
    });
  }
  $('#btnNewUser').onclick = () => userForm(null);

  // ---------- FİŞ İNDİRİMİ ----------
  function openDiscount() {
    if (lockGuard()) return;
    if (!cart.length) return toast('Sepet boş', 'warn');
    if (activeOrder) return toast('Onaylı siparişe ayrıca indirim yapılamaz', 'warn');
    if (!need('discount')) return;
    let type = (cartDiscount && cartDiscount.type) || 'pct';
    const sub = subTotal();
    openModal(`<h2>Fiş indirimi</h2><div>Ara toplam <b>${money(sub)}</b></div>
      <div class="seg"><button type="button" data-t="pct">Yüzde (%)</button><button type="button" data-t="amt">Tutar (₺)</button></div>
      <label><span id="dLbl"></span><input id="dVal" inputmode="decimal" autofocus value="${cartDiscount ? String(cartDiscount.value).replace('.', ',') : ''}"></label>
      <div class="quick" id="dQuick"></div>
      <div class="disc-prev">İndirim <b id="dAmt">0,00 ₺</b> · Ödenecek <b id="dNew">${money(sub)}</b></div>
      <div class="btns">${cartDiscount ? '<button class="ghost" id="dDel">İndirimi kaldır</button>' : ''}<span class="grow"></span><button class="ghost" id="dC">Vazgeç</button><button class="primary" id="dO">Uygula</button></div>`, m => {
      const inp = m.querySelector('#dVal');
      const calc = () => {
        const v = parseNum(inp.value);
        const amt = !(v > 0) ? 0 : r2(Math.min(sub, type === 'pct' ? sub * Math.min(v, 100) / 100 : v));
        m.querySelector('#dAmt').textContent = money(amt);
        m.querySelector('#dNew').textContent = money(sub - amt);
        return v;
      };
      const setType = t => {
        type = t;
        m.querySelectorAll('[data-t]').forEach(b => b.classList.toggle('on', b.dataset.t === t));
        m.querySelector('#dLbl').textContent = t === 'pct' ? 'İndirim yüzdesi' : 'İndirim tutarı (₺)';
        m.querySelector('#dQuick').innerHTML = (t === 'pct' ? [5, 10, 15, 20] : [5, 10, 20, 50]).map(x => `<button type="button" data-q="${x}">${t === 'pct' ? '%' + x : x + ' ₺'}</button>`).join('');
        m.querySelectorAll('[data-q]').forEach(b => b.onclick = () => { inp.value = b.dataset.q; calc(); m.querySelector('#dO').focus(); });
        calc();
      };
      m.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { setType(b.dataset.t); inp.focus(); });
      setType(type);
      inp.oninput = calc;
      const ok = () => {
        const v = calc();
        if (!(v > 0)) return toast('Geçerli bir indirim girin', 'err');
        if (type === 'pct' && v > 100) return toast('Yüzde 100\'den büyük olamaz', 'err');
        if (type === 'amt' && v > sub) return toast('İndirim ara toplamdan büyük olamaz', 'err');
        cartDiscount = { type, value: r2(v) }; closeModal(); renderCart();
      };
      inp.onkeydown = e => { if (e.key === 'Enter') ok(); };
      m.querySelector('#dO').onclick = ok;
      m.querySelector('#dC').onclick = closeModal;
      const d = m.querySelector('#dDel'); if (d) d.onclick = () => { cartDiscount = null; closeModal(); renderCart(); };
    });
  }

  // ---------- PARÇALI ÖDEME (NAKİT + KART) ----------
  function paySplit(cashPart) {
    if (lockGuard()) return;
    if (!cart.length) return toast('Sepet boş', 'warn');
    const total = cartTotal();
    openModal(`${AWAIT}<h2>Parçalı ödeme</h2><div class="big-total">${money(total)}</div>
      <div class="two"><label>Nakit alınan<input id="spC" inputmode="decimal" autofocus value="${cashPart ? String(cashPart).replace('.', ',') : ''}"></label>
        <label>Karttan çekilecek<input id="spK" readonly tabindex="-1"></label></div>
      <div class="hint">Önce nakdi alın, kalan tutarı POS cihazından çekin. İkisi de tamamlanınca onaylayın.</div>
      <div class="btns"><button class="ghost" id="spX">Vazgeç (Esc)</button><button class="primary confirm" id="spO">✓ Nakit ve kart ödemesini aldım</button></div>`, m => {
      m.classList.add('pay-modal');
      modalClose = () => m.classList.remove('pay-modal');
      const c = m.querySelector('#spC'), k = m.querySelector('#spK');
      const calc = () => { const v = parseNum(c.value); k.value = v > 0 && v < total ? money(r2(total - v)) : ''; return v; };
      calc(); c.oninput = calc;
      const ok = async () => {
        const v = r2(calc());
        if (!(v > 0 && v < total)) { beep(false); return toast('Nakit tutar 0 ile toplam tutar arasında olmalı', 'err'); }
        closeModal(); await completeSale('mixed', v, 0, { cash: v });
      };
      c.onkeydown = e => { if (e.key === 'Enter') ok(); };
      m.querySelector('#spO').onclick = ok;
      m.querySelector('#spX').onclick = closeModal;
    });
  }

  // ---------- VERESİYE / MÜŞTERİLER ----------
  async function balances() {
    const map = new Map();
    (await DB.all('cari')).forEach(e => map.set(e.customer_id, r2((map.get(e.customer_id) || 0) + (Number(e.amount) || 0))));
    return map;
  }
  async function balanceOf(id) { return (await balances()).get(id) || 0; }
  const CARI_LABEL = e => e.type === 'sale' ? `Satış #${e.sale_no}` : e.type === 'refund' ? `İade #${e.sale_no}` : e.type === 'cancel' ? `İptal #${e.sale_no}`
    : `Tahsilat (${e.method === 'card' ? 'kart' : 'nakit'})`;

  // Veresiye: yalnızca müşteri adı (zorunlu) ve telefon (isteğe bağlı) alınır
  async function payCredit() {
    if (lockGuard()) return;
    if (!cart.length) return toast('Sepet boş', 'warn');
    if (!need('credit')) return;
    const known = new Map();
    (await DB.all('sales')).filter(x => x.customer_name).sort((a, b) => a.created_at.localeCompare(b.created_at))
      .forEach(x => known.set(x.customer_name, x.customer_phone || known.get(x.customer_name) || ''));
    const total = cartTotal();
    openModal(`<h2>Veresiye satış</h2><div class="big-total">${money(total)}</div>
      <label>Müşteri adı<input id="vcN" list="vcList" autocomplete="off" autofocus placeholder="ör. Mehmet Koç"></label>
      <datalist id="vcList">${[...known.keys()].map(n => `<option value="${esc(n)}">`).join('')}</datalist>
      <label>Telefon (isteğe bağlı)<input id="vcP" inputmode="tel" autocomplete="off" placeholder="05xx xxx xx xx"></label>
      <div class="btns"><button class="ghost" id="vcC">Vazgeç</button><button class="primary confirm" id="vcO">Veresiye olarak kaydet</button></div>`, m => {
      const n = m.querySelector('#vcN'), ph = m.querySelector('#vcP');
      n.oninput = () => { const k = known.get(n.value.trim()); if (k && !ph.value) ph.value = k; };
      const ok = async () => {
        const name = n.value.trim().replace(/\s+/g, ' ');
        if (!name) { beep(false); return toast('Müşteri adını yazın', 'err'); }
        closeModal();
        await completeSale('credit', null, null, { customer: { name, phone: ph.value.trim() } });
      };
      n.onkeydown = e => { if (e.key === 'Enter') ph.focus(); };
      ph.onkeydown = e => { if (e.key === 'Enter') ok(); };
      m.querySelector('#vcO').onclick = ok;
      m.querySelector('#vcC').onclick = closeModal;
    });
  }


  // ---------- VERESİYELER ----------
  const ckey = n => String(n || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('tr-TR');
  async function creditAccounts() {
    const old = new Map((await DB.all('customers').catch(() => [])).map(c => [c.id, c]));
    const acc = new Map();
    const get = (name, phone) => {
      const k = ckey(name);
      if (!acc.has(k)) acc.set(k, { key: k, name: String(name).trim(), phone: '', sales: [], collects: [], debt: 0, paid: 0, last: '' });
      const a = acc.get(k); if (phone) a.phone = phone; return a;
    };
    const sales = (await DB.all('sales')).filter(s => s.status === 'completed').sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const s of sales) {
      const cr = payOf(s).credit; if (!cr) continue;
      const oc = s.customer_id ? old.get(s.customer_id) : null;
      const name = s.customer_name || (oc && oc.name); if (!name) continue;
      const a = get(name, s.customer_phone || (oc && oc.phone) || '');
      a.sales.push(s); a.debt = r2(a.debt + cr); if (s.created_at > a.last) a.last = s.created_at;
    }
    const cari = (await DB.all('cari')).filter(e => e.type === 'collect').sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const e of cari) {
      const oc = e.customer_id ? old.get(e.customer_id) : null;
      const name = e.customer_name || (oc && oc.name); if (!name) continue;
      const a = get(name, '');
      a.collects.push(e); a.paid = r2(a.paid - e.amount); if (e.created_at > a.last) a.last = e.created_at;
    }
    acc.forEach(a => { a.balance = r2(a.debt - a.paid); });
    return [...acc.values()];
  }
  const shortDate = iso => iso ? new Date(iso).toLocaleDateString('tr-TR') : '';
  async function renderCredits() {
    const all = await creditAccounts();
    const q = ckey($('#crSearch').value), showAll = $('#crAll').checked;
    const list = all.filter(a => (showAll || Math.abs(a.balance) > 0.004) && (!q || ckey(a.name).includes(q) || a.phone.replace(/\D/g, '').includes(q.replace(/\D/g, '') || '\u0000')))
      .sort((a, b) => b.balance - a.balance || b.last.localeCompare(a.last));
    const open = all.filter(a => a.balance > 0.004);
    $('#crCards').innerHTML = [['Toplam alacak', money(r2(open.reduce((x, a) => x + a.balance, 0))), 'main'], ['Borçlu müşteri', open.length], ['Toplam tahsilat', money(r2(all.reduce((x, a) => x + a.paid, 0)))]]
      .map(([l, v, c]) => `<div class="card-s ${c || ''}"><div class="l">${l}</div><div class="v">${v}</div></div>`).join('');
    $('#crList').innerHTML = list.length ? list.map(a => `<tr class="clickable" data-k="${esc(a.key)}">
      <td><b>${esc(a.name)}</b></td><td>${a.phone ? `<span class="phone">${esc(a.phone)}</span>` : '<span class="cr-dim">—</span>'}</td>
      <td class="num">${a.sales.length}</td><td>${shortDate(a.last)}</td><td class="num">${money(a.debt)}</td><td class="num">${money(a.paid)}</td>
      <td class="num"><b class="${a.balance > 0.004 ? 'neg' : 'pos'}">${money(a.balance)}</b></td></tr>`).join('')
      : `<tr><td colspan="7" class="cr-empty">${q ? 'Eşleşen veresiye yok' : 'Açık veresiye yok'}</td></tr>`;
    $('#crList').querySelectorAll('tr[data-k]').forEach(tr => tr.onclick = () => creditDetail(tr.dataset.k));
  }
  $('#crSearch').oninput = () => renderCredits();
  $('#crAll').onchange = () => renderCredits();

  async function creditDetail(k) {
    const a = (await creditAccounts()).find(x => x.key === k); if (!a) return;
    const rows = [...a.sales.map(s => ({ created_at: s.created_at, label: s.kind === 'refund' ? `İade #${s.sale_no}` : `Satış #${s.sale_no}`, amount: payOf(s).credit, sale: s })),
      ...a.collects.map(e => ({ created_at: e.created_at, label: `Tahsilat (${e.method === 'card' ? 'kart' : 'nakit'})${e.note ? ' · ' + e.note : ''}`, amount: e.amount, col: e }))]
      .sort((x, y) => x.created_at.localeCompare(y.created_at));
    openModal(`<h2>${esc(a.name)}</h2>
      <div class="hint">${a.phone ? 'Tel: ' + esc(a.phone) + ' · ' : ''}Veresiye ${money(a.debt)} · Ödenen ${money(a.paid)}</div>
      <div class="big-total">${money(a.balance)}</div>
      <div class="table-wrap cr-rows"><table class="grid"><thead><tr><th>Tarih</th><th>İşlem</th><th class="num">Tutar</th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr ${r.sale ? `class="clickable" data-i="${i}"` : ''}><td>${new Date(r.created_at).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</td><td>${esc(r.label)}</td><td class="num ${r.amount < 0 ? 'pos' : ''}">${r.amount < 0 ? '−' : ''}${money(Math.abs(r.amount))}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="btns"><button class="ghost" id="cdC">Kapat</button><button class="ghost" id="cdP">Ekstre yazdır</button>${a.balance > 0.004 ? '<button class="primary" id="cdT">Tahsilat al</button>' : ''}</div>`, m => {
      m.querySelectorAll('tr[data-i]').forEach(tr => tr.onclick = () => { const s = rows[+tr.dataset.i].sale; closeModal(); saleDetail(s); });
      m.querySelector('#cdC').onclick = closeModal;
      m.querySelector('#cdP').onclick = () => printHtml(Receipt.statement({ name: a.name + (a.phone ? ' · ' + a.phone : '') }, rows, a.balance, settings));
      const t = m.querySelector('#cdT'); if (t) t.onclick = () => collectCredit(a);
    });
  }

  function collectCredit(a) {
    if (!need('credit')) return;
    let method = 'cash';
    openModal(`<h2>Tahsilat · ${esc(a.name)}</h2><div class="hint">Kalan borç: <b>${money(a.balance)}</b></div>
      <label>Alınan tutar<input id="tcA" inputmode="decimal" autocomplete="off" value="${String(a.balance).replace('.', ',')}"></label>
      <div class="seg" id="tcM"><button type="button" class="on" data-m="cash">Nakit</button><button type="button" data-m="card">Kart</button></div>
      <label>Not (isteğe bağlı)<input id="tcN" autocomplete="off"></label>
      <div class="btns"><button class="ghost" id="tcC">Vazgeç</button><button class="primary confirm" id="tcO">Tahsil et</button></div>`, m => {
      const inp = m.querySelector('#tcA'); setTimeout(() => { inp.focus(); inp.select(); }, 30);
      m.querySelectorAll('#tcM button').forEach(b => b.onclick = () => { method = b.dataset.m; m.querySelectorAll('#tcM button').forEach(x => x.classList.toggle('on', x === b)); });
      const ok = async () => {
        const amt = r2(parseFloat(inp.value.replace(/\./g, '').replace(',', '.')) || 0);
        if (amt <= 0) { beep(false); return toast('Tutarı yazın', 'err'); }
        if (amt > a.balance + 0.004) { beep(false); return toast('Tutar kalan borçtan fazla', 'err'); }
        const ts = nowIso();
        const e = { id: uuid(), customer_id: null, customer_name: a.name, customer_phone: a.phone || '', created_at: ts, updated_at: ts, type: 'collect',
          amount: -amt, method, note: m.querySelector('#tcN').value.trim(), balance_after: r2(a.balance - amt), cashier: actor(), device: deviceId };
        try {
          await DB.write([{ store: 'cari', value: e }], [{ table: 'cari', row: e }]);
          closeModal(); Sync.run();
          toast(`${a.name}: ${money(amt)} tahsil edildi`, 'ok');
          printHtml(Receipt.collect(e, settings));
          renderCredits(); if (currentTab === 'report') renderReport();
        } catch (er) { toast('Kaydedilemedi: ' + er.message, 'err'); }
      };
      inp.onkeydown = ev => { if (ev.key === 'Enter') ok(); };
      m.querySelector('#tcO').onclick = ok;
      m.querySelector('#tcC').onclick = closeModal;
    });
  }

  // ---------- İADE ----------
  async function openRefund(s) {
    if (!need('refund')) return;
    const prev = (await DB.all('sales')).filter(x => x.ref_sale_id === s.id && x.status === 'completed');
    const done = new Map();
    prev.forEach(r => r.items.forEach(i => done.set(i.src_idx, r3((done.get(i.src_idx) || 0) - i.qty))));
    const factor = s.subtotal ? s.total / s.subtotal : 1;
    const rows = s.items.map((i, idx) => ({ i, idx, left: r3(i.qty - (done.get(idx) || 0)) }));
    if (rows.every(r => r.left <= 0)) return toast('Bu satışın tüm ürünleri zaten iade edilmiş', 'warn');
    const methods = s.payment_type === 'credit' ? ['credit'] : ['cash', 'card'];
    let method = s.payment_type === 'card' ? 'card' : methods[0];
    openModal(`<h2>İade · Satış #${s.sale_no}</h2>
      <div class="hint">İade edilecek miktarları girin. ${Number(s.discount) > 0 ? 'Fiş indirimi iade tutarına oranlanarak yansıtılır.' : ''}</div>
      <table class="grid items"><thead><tr><th>Ürün</th><th class="num">Satılan</th><th class="num">İade edilebilir</th><th class="num">İade miktarı</th></tr></thead><tbody>
        ${rows.map(r => `<tr><td>${esc(r.i.name)}<div class="hint">${money(r2(r.i.price * factor))} / ${esc(r.i.unit || 'adet')}</div></td><td class="num">${qtyFmt(r.i.qty)}</td><td class="num">${qtyFmt(Math.max(0, r.left))}</td>
          <td class="num">${r.left > 0 ? `<input class="rq" data-i="${r.idx}" inputmode="decimal" value="0">` : '—'}</td></tr>`).join('')}</tbody></table>
      <div class="btns" style="margin-top:0"><button class="ghost" id="rfAll">Tümünü iade et</button></div>
      ${methods.length > 1 ? `<div class="seg">${methods.map(x => `<button type="button" data-m="${x}" class="${x === method ? 'on' : ''}">${x === 'cash' ? 'Nakit iade' : 'Karta iade'}</button>`).join('')}</div>`
        : `<div class="hint">Veresiye satış (${esc(s.customer_name || '')}): iade, veresiye iadesi olarak kaydedilir.</div>`}
      <label>Açıklama (isteğe bağlı)<input id="rfNote" placeholder="ör. ürün bozuk çıktı"></label>
      <div class="big-total" id="rfTot">0,00 ₺</div>
      <div class="btns"><button class="ghost" id="rfC">Vazgeç</button><button class="primary confirm" id="rfO">İadeyi kaydet</button></div>`, m => {
      const calc = () => {
        let t = 0;
        m.querySelectorAll('.rq').forEach(inp => { const q = parseNum(inp.value); const r = rows[Number(inp.dataset.i)]; if (q > 0) t += r.i.price * Math.min(q, r.left) * factor; });
        m.querySelector('#rfTot').textContent = money(r2(t)); return r2(t);
      };
      m.querySelectorAll('.rq').forEach(i => { i.oninput = calc; i.onfocus = () => i.select(); });
      m.querySelector('#rfAll').onclick = () => { m.querySelectorAll('.rq').forEach(inp => { inp.value = String(rows[Number(inp.dataset.i)].left).replace('.', ','); }); calc(); };
      m.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { method = b.dataset.m; m.querySelectorAll('[data-m]').forEach(x => x.classList.toggle('on', x === b)); });
      m.querySelector('#rfC').onclick = closeModal;
      m.querySelector('#rfO').onclick = async () => {
        const items = [];
        for (const inp of m.querySelectorAll('.rq')) {
          const q = r3(parseNum(inp.value)), r = rows[Number(inp.dataset.i)];
          if (!(q > 0)) continue;
          if (q > r.left + 0.0005) return toast(`${r.i.name}: en fazla ${qtyFmt(r.left)} iade edilebilir`, 'err');
          items.push({ product_id: r.i.product_id, barcode: r.i.barcode, name: r.i.name, unit: r.i.unit, qty: -q, price: r2(r.i.price * factor),
            vat_rate: r.i.vat_rate, total: -r2(r.i.price * q * factor), cost: r.i.cost ?? null, category: r.i.category || null, src_idx: r.idx });
        }
        if (!items.length) return toast('İade miktarı girin', 'err');
        const T = r2(-items.reduce((a, i) => a + i.total, 0));
        const ts = nowIso(), no = saleNo + 1;
        const ref = {
          id: uuid(), sale_no: no, created_at: ts, kind: 'refund', ref_sale_id: s.id, ref_sale_no: s.sale_no, items, subtotal: -T, discount: 0, total: -T,
          payment_type: method, cash_amount: method === 'cash' ? -T : 0, card_amount: method === 'card' ? -T : 0, cash_given: null, change_amount: null,
          status: 'completed', cancelled_at: null, device: deviceId, cashier: actor(), note: m.querySelector('#rfNote').value.trim(),
          customer_id: s.customer_id || null, customer_name: s.customer_name || null
        };
        const ops = [{ store: 'sales', value: ref }, { store: 'meta', value: { key: 'sale_no', value: no } }], sync = [{ table: 'sales', row: ref }];
        ref.customer_phone = s.customer_phone || '';
        if (method === 'credit' && s.customer_id) {
          const e = { id: uuid(), customer_id: s.customer_id, customer_name: s.customer_name, created_at: ts, updated_at: ts, type: 'refund', amount: -T,
            sale_id: ref.id, sale_no: no, note: ref.note, cashier: actor(), device: deviceId };
          ops.push({ store: 'cari', value: e }); sync.push({ table: 'cari', row: e });
        }
        try {
          await DB.write(ops, sync);
          saleNo = no; lastSale = ref; renderLastSale();
          closeModal(); toast(`İade #${no} kaydedildi — ${money(T)}`, 'ok');
          if (settings.autoPrint) printSale(ref);
          Sync.run(); if (currentTab === 'report') renderReport();
        } catch (e) { toast('İade kaydedilemedi: ' + e.message, 'err'); }
      };
    });
  }

  // ---------- KASA: AÇILIŞ / GİRİŞ / ÇIKIŞ / SAYIM ----------
  async function cashMoveForm(type) {
    if (!need('cash')) return;
    const today = localDate(new Date());
    if ($('#repDate').value !== today) { $('#repDate').value = today; await renderReport(); }
    const exp = (await dayData()).kasa.expected;
    const notes = type === 'out' ? ['Masraf', 'Bankaya yatırılan', 'Tedarikçi ödemesi', 'Personel'] : type === 'in' ? ['Bozuk para', 'Kasaya eklenen'] : [];
    openModal(`<h2>${MOVE_LABEL[type]}</h2>
      ${type === 'count' ? `<div class="kasa-sum"><div class="kl strong"><span>Kasada olması gereken</span><b>${money(exp)}</b></div></div>` : ''}
      ${type === 'open' ? '<div class="hint">Gün başında çekmecede bulunan para (bozuk para dahil).</div>' : ''}
      <label>${type === 'count' ? 'Sayılan nakit' : 'Tutar'}<input id="cmA" inputmode="decimal" autofocus></label>
      ${type === 'count' ? '<div class="disc-prev">Fark <b id="cmD">—</b></div>' : ''}
      ${type === 'in' || type === 'out' ? `<label>Açıklama<input id="cmN" placeholder="ör. ${type === 'out' ? 'kargo ödemesi' : 'bozuk para'}"></label>
        <div class="quick">${notes.map(n => `<button type="button" data-n="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : ''}
      <div class="btns"><button class="ghost" id="cmC">Vazgeç</button><button class="primary" id="cmO">Kaydet</button></div>`, m => {
      const a = m.querySelector('#cmA');
      if (type === 'count') a.oninput = () => { const v = parseNum(a.value); const d = m.querySelector('#cmD'); d.textContent = v >= 0 ? (v - exp >= 0 ? '+' : '') + money(v - exp) : '—'; d.className = v >= 0 && Math.abs(v - exp) >= 0.01 ? 'bad' : 'good'; };
      m.querySelectorAll('[data-n]').forEach(b => b.onclick = () => { m.querySelector('#cmN').value = b.dataset.n; a.focus(); });
      m.querySelector('#cmC').onclick = closeModal;
      const ok = async () => {
        const v = r2(parseNum(a.value));
        if (!(v >= 0) || (type !== 'count' && type !== 'open' && !(v > 0))) return toast('Geçerli bir tutar girin', 'err');
        const nEl = m.querySelector('#cmN'), note = nEl ? nEl.value.trim() : '';
        if ((type === 'in' || type === 'out') && !note) return toast('Açıklama yazın', 'err');
        const ts = nowIso();
        const row = { id: uuid(), created_at: ts, updated_at: ts, type, amount: v, note, cashier: actor(), device: deviceId };
        if (type === 'count') { row.expected = exp; row.diff = r2(v - exp); }
        await DB.write([{ store: 'cash_moves', value: row }], [{ table: 'cash_moves', row }]);
        Sync.run(); closeModal(); renderReport();
        toast(type === 'count' ? `Kasa sayıldı · fark ${(row.diff >= 0 ? '+' : '') + money(row.diff)}` : `${MOVE_LABEL[type]} kaydedildi`, type === 'count' && Math.abs(row.diff) >= 0.01 ? 'warn' : 'ok');
      };
      a.onkeydown = e => { if (e.key === 'Enter') ok(); };
      m.querySelector('#cmO').onclick = ok;
    });
  }
  $('#kOpen').onclick = () => cashMoveForm('open');
  $('#kIn').onclick = () => cashMoveForm('in');
  $('#kOut').onclick = () => cashMoveForm('out');
  $('#kCount').onclick = () => cashMoveForm('count');

  // ---------- SEPETİ BEKLETME ----------
  const getHeld = async () => (await DB.getMeta('held', [])) || [];
  async function holdCart() {
    if (!cart.length) return toast('Bekletilecek sepet yok', 'warn');
    if (activeOrder) return toast('Onaylı sipariş bekletilemez; satışı tamamlayın veya sepeti temizleyin', 'warn');
    const held = await getHeld();
    held.push({ id: uuid(), at: nowIso(), cart, discount: cartDiscount, total: cartTotal(), n: cart.length, by: cashier ? cashier.name : '' });
    await DB.setMeta('held', held);
    cart = []; cartDiscount = null;
    renderCart(); renderHeld(); document.body.classList.remove('cart-open');
    toast('Sepet bekletmeye alındı. Sıradaki müşteriye geçebilirsiniz.', 'ok');
  }
  async function renderHeld() {
    const held = await getHeld(), el = $('#heldStrip');
    el.classList.toggle('hidden', !held.length);
    el.innerHTML = held.map((h, i) => `<button class="held" data-h="${h.id}"><span>Bekleyen sepet ${i + 1} · <b>${money(h.total)}</b></span>
      <small>${h.n} kalem · ${new Date(h.at).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}${h.by ? ' · ' + esc(h.by) : ''}</small></button>`).join('');
    el.querySelectorAll('[data-h]').forEach(b => b.onclick = () => restoreHeld(b.dataset.h));
  }
  async function restoreHeld(id) {
    if (lockGuard()) return;
    let held = await getHeld();
    const h = held.find(x => x.id === id); if (!h) return;
    held = held.filter(x => x.id !== id);
    if (cart.length) {
      if (activeOrder) return toast('Önce sepetteki onaylı siparişi tamamlayın', 'warn');
      held.push({ id: uuid(), at: nowIso(), cart, discount: cartDiscount, total: cartTotal(), n: cart.length, by: cashier ? cashier.name : '' });
      toast('Mevcut sepet bekletmeye alındı', 'warn');
    }
    await DB.setMeta('held', held);
    cart = h.cart; cartDiscount = h.discount || null;
    renderCart(true); renderHeld();
  }

  // ---------- TERAZİ BARKODU ----------
  // EAN-13: [ön ek 2][ürün kodu 5][ağırlık gram veya tutar kuruş 5][kontrol 1]
  function scaleParse(text) {
    if (!settings.scaleOn || !/^\d{13}$/.test(text)) return null;
    const prefixes = String(settings.scalePrefix || '').split(/[^\d]+/).filter(Boolean);
    const pre = prefixes.find(p => text.startsWith(p));
    if (!pre) return null;
    const strip = x => String(x || '').trim().replace(/^0+/, '');
    const code = strip(text.slice(pre.length, 7)) || '0';
    const val = Number(text.slice(7, 12));
    const product = [...products.values()].find(p => p.active && ((p.scale_code && strip(p.scale_code) === code) || (p.code && strip(p.code) === code)));
    const qty = settings.scaleMode === 'price' ? (product && product.price > 0 ? r3(val / 100 / product.price) : 0) : r3(val / 1000);
    return { code, product, qty };
  }

  // ---------- RAPORLAR: ÜRÜN / KATEGORİ / KÂR ----------
  function setRange(k) {
    const now = new Date(); let a = new Date(now), b = new Date(now);
    if (k === 'week') a.setDate(now.getDate() - 6);
    if (k === 'month') a = new Date(now.getFullYear(), now.getMonth(), 1);
    if (k === 'last') { a = new Date(now.getFullYear(), now.getMonth() - 1, 1); b = new Date(now.getFullYear(), now.getMonth(), 0); }
    $('#anFrom').value = localDate(a); $('#anTo').value = localDate(b);
  }
  setRange('month');
  document.querySelectorAll('[data-range]').forEach(b => b.onclick = () => { setRange(b.dataset.range); renderAnalytics(); });
  $('#anFrom').addEventListener('change', () => renderAnalytics());
  $('#anTo').addEventListener('change', () => renderAnalytics());
  async function rangeSales() {
    const [y1, m1, d1] = $('#anFrom').value.split('-').map(Number), [y2, m2, d2] = $('#anTo').value.split('-').map(Number);
    const a = new Date(y1, m1 - 1, d1, 0, 0, 0, 0), b = new Date(y2, m2 - 1, d2, 23, 59, 59, 999);
    return (await DB.range('sales', 'created_at', a.toISOString(), b.toISOString())).sort((x, y) => x.created_at.localeCompare(y.created_at));
  }
  async function renderAnalytics() {
    const sales = await rangeSales();
    const ok = sales.filter(s => s.status === 'completed'), real = ok.filter(s => s.kind !== 'refund');
    const prod = new Map(), cats = new Map(), hours = new Map();
    let rev = 0, cost = 0, revKnown = 0, missing = new Set(), disc = 0, refunds = 0;
    ok.forEach(s => {
      const f = s.kind !== 'refund' && s.subtotal ? s.total / s.subtotal : 1;
      if (s.kind === 'refund') refunds += -s.total;
      else disc += (Number(s.discount) || 0) + s.items.reduce((a, i) => a + (i.list_price != null && i.list_price > i.price ? (i.list_price - i.price) * i.qty : 0), 0);
      const h = new Date(s.created_at).getHours();
      const hx = hours.get(h) || { rev: 0, n: 0 }; hx.rev += s.total; if (s.kind !== 'refund') hx.n++; hours.set(h, hx);
      s.items.forEach(i => {
        const p = products.get(i.product_id);
        const k = i.product_id || i.name, r = i.total * f;
        const c = i.cost != null ? i.cost * i.qty : 0;
        const x = prod.get(k) || { name: i.name, qty: 0, rev: 0, cost: 0, known: true };
        x.qty = r3(x.qty + i.qty); x.rev += r;
        if (i.cost != null) { x.cost += c; revKnown += r; cost += c; } else { x.known = false; if (s.kind !== 'refund') missing.add(i.name); }
        prod.set(k, x);
        const cat = i.category || (p ? catOf(p) : 'Diğer');
        const cx = cats.get(cat) || { rev: 0, cost: 0, revKnown: 0 };
        cx.rev += r; if (i.cost != null) { cx.cost += c; cx.revKnown += r; }
        cats.set(cat, cx);
      });
      rev += s.total;
    });
    rev = r2(rev); cost = r2(cost);
    const profit = r2(revKnown - cost);
    const pct = (a, b) => b > 0.004 ? '%' + (a / b * 100).toLocaleString('tr-TR', { maximumFractionDigits: 1 }) : '—';
    $('#anCards').innerHTML = [
      ['Net ciro', money(rev), 'main'], ['Satış adedi', real.length], ['Ortalama sepet', money(real.length ? real.reduce((a, s) => a + s.total, 0) / real.length : 0)],
      ['Maliyet', cost ? money(cost) : '—'], ['Brüt kâr', revKnown ? money(profit) : '—'], ['Kâr marjı', pct(profit, revKnown)],
      ['İndirimler', money(r2(disc))], ['İadeler', money(r2(refunds))]
    ].map(([l, v, c]) => `<div class="card-s ${c || ''}"><div class="l">${l}</div><div class="v">${v}</div></div>`).join('');
    const notes = [];
    if (missing.size) notes.push(`${missing.size} ürünün alış fiyatı girilmemiş; bu ürünler kâr hesabına dahil edilmedi (Ürünler › Düzenle › Alış fiyatı veya Excel'deki "ALIŞ FİYATI" sütunu).`);
    if (!IS_WEB) {
      const arch = (await DB.all('archives')).map(a => a.month).filter(m => m >= $('#anFrom').value.slice(0, 7) && m <= $('#anTo').value.slice(0, 7));
      if (arch.length) notes.push(`${arch.map(ymLabel).join(', ')} arşivlendiği için bu rapora dahil değil.`);
    } else notes.push('Web sürümünde son 2 ayın satışları bulunur.');
    $('#anNote').classList.toggle('hidden', !notes.length); $('#anNote').innerHTML = notes.join('<br>');
    $('#anProducts').innerHTML = [...prod.values()].sort((a, b) => b.rev - a.rev).map(x => `<tr><td>${esc(x.name)}</td><td class="num">${qtyFmt(x.qty)}</td><td class="num">${money(x.rev)}</td>
      <td class="num">${x.known ? money(x.cost) : '—'}</td><td class="num">${x.known ? money(x.rev - x.cost) : '—'}</td><td class="num">${x.known ? pct(x.rev - x.cost, x.rev) : '—'}</td></tr>`).join('')
      || '<tr><td colspan="6" style="color:var(--muted)">Bu aralıkta satış yok</td></tr>';
    $('#anCats').innerHTML = [...cats].sort((a, b) => b[1].rev - a[1].rev).map(([n, x]) => `<tr><td>${esc(n)}</td><td class="num">${money(x.rev)}</td>
      <td class="num">${x.revKnown ? money(x.revKnown - x.cost) : '—'}</td><td class="num">${pct(x.rev, rev)}</td></tr>`).join('');
    const maxH = Math.max(1, ...[...hours.values()].map(x => x.rev));
    $('#anHours').innerHTML = [...hours].sort((a, b) => a[0] - b[0]).map(([h, x]) => `<div class="hr"><span>${String(h).padStart(2, '0')}:00</span>
      <i style="width:${Math.max(2, x.rev / maxH * 100)}%"></i><b>${money(x.rev)}</b><small>${x.n} satış</small></div>`).join('') || '<div class="hint">Satış yok</div>';
  }

  // ---------- SATIŞLARI EXCEL'E AKTARMA ----------
  $('#anExport').onclick = async () => {
    const sales = await rangeSales();
    if (!sales.length) return toast('Bu aralıkta satış yok', 'warn');
    const head = ['Tarih', 'Saat', 'Fiş No', 'Tür', 'Durum', 'Ödeme', 'Nakit', 'Kart', 'Veresiye', 'Müşteri', 'Telefon', 'Kasiyer', 'Ürün', 'Barkod', 'Kategori', 'Miktar', 'Birim',
      'Birim fiyat', 'Liste fiyatı', 'Satır tutarı', 'Fiş indirimi', 'Fiş toplamı', 'KDV %', 'Birim maliyet'];
    const rows = [head];
    sales.forEach(s => {
      const d = new Date(s.created_at), p = payOf(s);
      s.items.forEach((i, k) => rows.push([
        d.toLocaleDateString('tr-TR'), d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }), s.sale_no, s.kind === 'refund' ? 'İade' : 'Satış',
        s.status === 'completed' ? 'Tamamlandı' : 'İptal', Receipt.PAY_LABEL[s.payment_type] || s.payment_type,
        k ? '' : p.cash, k ? '' : p.card, k ? '' : p.credit, s.customer_name || '', s.customer_phone || '', (s.cashier && s.cashier.name) || '',
        i.name, i.barcode || '', i.category || '', i.qty, i.unit || '', i.price, i.list_price ?? i.price, i.total,
        k ? '' : (Number(s.discount) || 0), k ? '' : s.total, Number(i.vat_rate) || 0, i.cost ?? ''
      ]));
    });
    const name = `satislar-${$('#anFrom').value}_${$('#anTo').value}.xlsx`;
    try {
      if (window.kasa && window.kasa.saveExcel) {
        const r = await window.kasa.saveExcel(rows, name, { sheet: 'Satışlar', cols: [11, 7, 8, 7, 11, 13, 10, 10, 10, 20, 14, 12, 38, 15, 18, 8, 8, 11, 11, 11, 11, 11, 6, 11] });
        if (r && r.saved) toast('Kaydedildi: ' + r.path, 'ok');
      } else {
        const csv = rows.map(r => r.map(v => String(v).replace(/;/g, ',')).join(';')).join('\r\n');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' })); a.download = name.replace('.xlsx', '.csv'); a.click();
      }
    } catch (e) { toast('Excel kaydedilemedi: ' + e.message, 'err'); }
  };
  // ======================================================================

  // ---------- AYARLAR ----------
  async function renderSettings() {
    $('#setStoreName').value = settings.storeName;
    $('#setStoreAddress').value = settings.storeAddress;
    $('#setStorePhone').value = settings.storePhone;
    $('#setFooter').value = settings.footer;
    $('#setPaper').value = settings.paper;
    $('#setAutoPrint').checked = !!settings.autoPrint;
    $('#setScaleOn').checked = !!settings.scaleOn;
    $('#setScalePrefix').value = settings.scalePrefix || '';
    $('#setScaleMode').value = settings.scaleMode || 'weight';
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
      printer: $('#setPrinter').value, paper: $('#setPaper').value, autoPrint: $('#setAutoPrint').checked,
      scaleOn: $('#setScaleOn').checked, scalePrefix: $('#setScalePrefix').value.trim(), scaleMode: $('#setScaleMode').value
    };
    await DB.setMeta('settings', settings);
    const store = { storeName: settings.storeName, storeAddress: settings.storeAddress, storePhone: settings.storePhone, footer: settings.footer };
    const prev = await DB.getMeta('cfg_store', null);
    if (JSON.stringify(prev && prev.value) !== JSON.stringify(store)) {
      const row = { id: 'store', value: store, updated_at: nowIso() };
      await DB.write([{ store: 'meta', value: { key: 'cfg_store', value: row } }], [{ table: 'config', row }]);
      Sync.run();
    }
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

  // ---------- Diğer cihazlardan gelen değişiklikler ----------
  Sync.onPulled(async sum => {
    for (const c of sum.config || []) {
      if (c.id === 'store' && c.value) {
        const prev = await DB.getMeta('cfg_store', null);
        if (!prev || Date.parse(c.updated_at) > Date.parse(prev.updated_at)) {
          settings = { ...settings, ...c.value };
          await DB.write([{ store: 'meta', value: { key: 'settings', value: settings } }, { store: 'meta', value: { key: 'cfg_store', value: c } }]);
          $('#brand').textContent = settings.storeName || 'Hızlı Kasa';
        }
      }
      if (c.id === 'auth' && c.adminHash) {
        const a = await DB.getMeta('auth', null);
        if (!a || !a.updated_at || Date.parse(c.updated_at) > Date.parse(a.updated_at))
          await DB.setMeta('auth', { salt: c.salt, adminUser: c.adminUser, adminHash: c.adminHash, updated_at: c.updated_at });
      }
    }
    for (const c of sum.config || []) {
      if (c.id === 'users' && Array.isArray(c.list)) {
        const cur = await DB.getMeta('users', null);
        if (!cur || !cur.updated_at || Date.parse(c.updated_at) > Date.parse(cur.updated_at)) {
          await DB.setMeta('users', { list: c.list, updated_at: c.updated_at }); users = c.list;
          if (currentTab === 'security') renderUsers();
        }
      }
    }
    if (sum.products || sum.full) { await loadAll(); }
    saleNo = Math.max(saleNo, await DB.getMeta('sale_no', 0));
    updateApprBadge();
    if (currentTab === 'sale') { renderChips(); renderTiles(); renderOrderStrip(); }
    if (currentTab === 'products' && !modalOpen()) renderProducts();
    if (currentTab === 'report' && (sum.sales || sum.cash_moves || sum.cari)) renderReport();
    if (currentTab === 'credits' && (sum.sales || sum.cari)) renderCredits();
    if (currentTab === 'analytics' && sum.sales) renderAnalytics();
    if (currentTab === 'approvals' && sum.orders && !document.activeElement.matches('input.pi')) renderApprovals();
  });

  // ---------- Web: bulut hesabıyla giriş ----------
  function showCloudGate() {
    const cfg = window.WEB_CONFIG || {};
    showTab('cloud');
    $('#cgProject').closest('label').classList.toggle('hidden', !!cfg.projectId);
    $('#cgKey').closest('label').classList.toggle('hidden', !!cfg.apiKey);
    setTimeout(() => $('#cgEmail').focus(), 50);
  }
  $('#cloudForm').addEventListener('submit', async e => {
    e.preventDefault();
    const cfg = window.WEB_CONFIG || {};
    const project = cfg.projectId || $('#cgProject').value, key = cfg.apiKey || $('#cgKey').value;
    const email = $('#cgEmail').value, pass = $('#cgPass').value;
    if (!project || !key || !email || !pass) return toast('Tüm alanları doldurun', 'err');
    const btn = $('#cgGo'); btn.disabled = true; btn.textContent = 'Bağlanılıyor...';
    try {
      await Sync.login(project, key, email, pass);
      btn.textContent = 'Veriler indiriliyor...';
      const r = await Sync.restore();
      await loadAll(); await loadPopularity();
      toast(`${r.products} ürün ve ${r.sales} satış yüklendi`, 'ok');
      $('#cgPass').value = '';
      goHome();
    } catch (err) {
      toast(err instanceof TypeError ? 'Sunucuya ulaşılamadı, interneti kontrol edin' : err.message, 'err');
    } finally { btn.disabled = false; btn.textContent = 'Giriş yap'; }
  });

  // ---------- Kamera ile barkod okuma ----------
  let camStream = null, camTimer = null, zxReader = null;
  function stopCamera() {
    if (camTimer) { clearInterval(camTimer); camTimer = null; }
    if (zxReader) { try { zxReader.reset(); } catch (_) {} zxReader = null; }
    if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
  }
  async function openCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return toast('Bu cihazda kamera kullanılamıyor', 'err');
    let lastCode = '', lastAt = 0, count = 0;
    openModal(`<h2>Kamera ile barkod okut</h2>
      <div class="cam-box"><video id="camV" playsinline muted></video><div class="cam-line"></div></div>
      <div class="cam-msg" id="camMsg">Barkodu kırmızı çizginin üzerine getirin</div>
      <div class="btns"><button class="primary" id="camX">Bitti</button></div>`, async m => {
      m.classList.add('cam-modal');
      modalClose = () => { m.classList.remove('cam-modal'); stopCamera(); };
      m.querySelector('#camX').onclick = closeModal;
      const video = m.querySelector('#camV');
      const onCode = code => {
        code = String(code || '').trim(); if (!code) return;
        const now = Date.now();
        if (code === lastCode && now - lastAt < 2000) return;    // aynı barkodu art arda saymasın
        lastCode = code; lastAt = now;
        const id = byBarcode.get(code), p = id ? products.get(id) : null;
        const msg = m.querySelector('#camMsg');
        const say = (t, ok) => { if (msg) { msg.textContent = t; msg.className = 'cam-msg ' + (ok ? 'ok' : 'bad'); } };
        if (!p) { beep(false); say('Barkod bulunamadı: ' + code, false); if (navigator.vibrate) navigator.vibrate([40, 40, 40]); return; }
        if (!p.active) { beep(false); say(`"${p.name}" pasif durumda`, false); return; }
        if (!(p.price > 0)) { closeModal(); addToCart(p, 1); return; }   // fiyat sorulacak
        addToCart(p, 1);
        count++;
        say(`✓ ${p.name} eklendi · sepette ${cart.length} kalem`, true);
        if (navigator.vibrate) navigator.vibrate(60);
      };
      try {
        if ('BarcodeDetector' in window) {
          camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
          video.srcObject = camStream; await video.play();
          const fmts = await BarcodeDetector.getSupportedFormats().catch(() => []);
          const det = new BarcodeDetector({ formats: fmts.length ? fmts : ['ean_13', 'ean_8', 'code_128', 'upc_a'] });
          let busy = false;
          camTimer = setInterval(async () => {
            if (busy || video.readyState < 2) return; busy = true;
            try { const r = await det.detect(video); if (r[0]) onCode(r[0].rawValue); } catch (_) {}
            busy = false;
          }, 180);
        } else if (window.ZXing && ZXing.BrowserMultiFormatReader) {
          zxReader = new ZXing.BrowserMultiFormatReader();
          await zxReader.decodeFromConstraints({ video: { facingMode: { ideal: 'environment' } } }, video, (res) => { if (res) onCode(res.getText()); });
        } else throw new Error('Bu tarayıcı barkod okumayı desteklemiyor');
      } catch (err) {
        const msg = m.querySelector('#camMsg');
        if (msg) { msg.textContent = err.name === 'NotAllowedError' ? 'Kamera izni verilmedi. Tarayıcı ayarlarından kameraya izin verin.' : 'Kamera açılamadı: ' + err.message; msg.className = 'cam-msg bad'; }
      }
    });
  }
  // Telefonda sepet tam ekran panel olarak açılır
  const openSheet = () => { document.body.classList.add('cart-open'); window.scrollTo(0, 0); };
  const closeSheet = () => document.body.classList.remove('cart-open');
  $('#cartJump').onclick = openSheet;
  $('#sheetClose').onclick = closeSheet;
  $('#btnCam').onclick = () => { if (!lockGuard()) openCamera(); };

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
    const keys = mode === 'admin' ? { F2: 'products', F3: 'report', F4: 'settings', F5: 'security', F6: 'approvals', F10: 'credits' } : { F1: 'sale', F3: 'report', F10: 'credits' };
    if (keys[e.key]) { e.preventDefault(); showTab(keys[e.key]); return; }
    if (currentTab === 'sale') {
      if (e.key === 'F8') { e.preventDefault(); payCash(); }
      if (e.key === 'F9') { e.preventDefault(); payCard(); }
      if (e.key === 'F7') { e.preventDefault(); sendForApproval(); }
      if (e.key === 'F6') { e.preventDefault(); holdCart(); }
    }
  });
  document.querySelectorAll('#navTabs button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
  $('#btnCash').onclick = payCash;
  $('#btnCard').onclick = payCard;
  $('#btnSendAppr').onclick = sendForApproval;
  $('#btnDisc').onclick = openDiscount;
  $('#btnCredit').onclick = payCredit;
  $('#btnHold').onclick = holdCart;
  $('#btnCashier').onclick = () => { cashier = null; cashierLogin(); };
  $('#btnClear').onclick = async () => {
    if (cart.length && await confirmBox('Sepeti temizle', activeOrder ? 'Onaylı sipariş sepetten kaldırılsın mı? (Sipariş silinmez, listede bekler)' : 'Sepetteki tüm ürünler silinsin mi?', 'Temizle', true)) { cart = []; activeOrder = null; cartDiscount = null; renderCart(); renderOrderStrip(); }
  };
  $('#modalBack').addEventListener('mousedown', e => { if (e.target.id === 'modalBack') closeModal(); });

  setInterval(() => { $('#clock').textContent = new Date().toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'medium' }); }, 1000);

  // ---------- Yedek defterden kurtarma (masaüstü) ----------
  const STATE_KEYS = ['device_id', 'fb_project', 'fb_key', 'fb_session', 'settings', 'auth', 'sale_no', 'order_no', 'cfg_store', 'max_ts'];
  async function saveState() {
    if (!window.kasa || !window.kasa.stateSave) return;
    try {
      const meta = {};
      for (const k of STATE_KEYS) meta[k] = await DB.getMeta(k, null);
      if (meta.device_id) await window.kasa.stateSave({ saved_at: nowIso(), meta });
    } catch (e) { console.error('Durum yedeği yazılamadı', e); }
  }
  async function recoverFromDisk() {
    if (!window.kasa || !window.kasa.journalRead) return 0;
    // 1) Veritabanı sıfırlanmışsa ayarlar ve bulut bağlantısı yedekten döner
    if (!(await DB.getMeta('device_id', null))) {
      const st = await window.kasa.stateRead().catch(() => null);
      if (st && st.meta && st.meta.device_id) {
        await DB.write(Object.entries(st.meta).filter(([, v]) => v !== null && v !== undefined)
          .map(([key, value]) => ({ store: 'meta', value: { key, value } })));
        await DB.setMeta('pull_since', null);           // buluttan tam yükleme yapılsın
        console.warn('Ayarlar yedekten geri yüklendi');
      }
    }
    // 2) Buluta gönderilmemiş kayıtlar defterden geri eklenir
    const txt = await window.kasa.journalRead().catch(() => '');
    if (!txt.trim()) return 0;
    const latest = new Map();
    txt.split('\n').forEach(l => {
      if (!l.trim()) return;
      try { const e = JSON.parse(l); if (e.table && e.row && e.row.id) latest.set(e.table + '/' + e.row.id, e); } catch (_) {}
    });
    const ops = [], sync = [];
    let maxSale = 0, maxOrder = 0, n = 0;
    for (const e of latest.values()) {
      if (!['sales', 'products', 'orders', 'cash_moves', 'customers', 'cari'].includes(e.table)) continue;
      const local = await DB.get(e.table, e.row.id);
      if (e.op === 'delete') {
        if (local) { ops.push({ store: e.table, del: e.row.id }); sync.push({ table: e.table, row: { id: e.row.id }, op: 'delete' }); n++; }
        continue;
      }
      if (local) continue;                              // veritabanında zaten var
      ops.push({ store: e.table, value: e.row }); sync.push({ table: e.table, row: e.row }); n++;
      if (e.table === 'sales') maxSale = Math.max(maxSale, Number(e.row.sale_no) || 0);
      if (e.table === 'orders') maxOrder = Math.max(maxOrder, Number(e.row.no) || 0);
    }
    if (maxSale > (await DB.getMeta('sale_no', 0))) ops.push({ store: 'meta', value: { key: 'sale_no', value: maxSale } });
    if (maxOrder > (await DB.getMeta('order_no', 0))) ops.push({ store: 'meta', value: { key: 'order_no', value: maxOrder } });
    if (ops.length) await DB.write(ops, sync, { noJournal: true });
    return n;
  }

  // ---------- Saat kontrolü ----------
  // İnternet yokken bilgisayar saati yanlışsa satışlar yanlış güne yazılır; uyarı verilir.
  let clockBad = false;
  async function checkClock() {
    const maxTs = Date.parse(await DB.getMeta('max_ts', '') || '') || 0;
    const now = Date.now();
    const behind = maxTs && now < maxTs - 10 * 60 * 1000;
    const tooOld = new Date().getFullYear() < 2026;
    clockBad = !!(behind || tooOld);
    const b = $('#clockBanner');
    b.classList.toggle('hidden', !clockBad);
    if (clockBad) b.innerHTML = `<b>Bilgisayarın tarihi/saati yanlış görünüyor</b> (şu an: ${new Date().toLocaleString('tr-TR')}).
      Satışlar yanlış güne kaydedilebilir. Windows'ta saat ayarını düzeltin (Ayarlar › Saat ve dil › Saati otomatik ayarla).`;
    return clockBad;
  }

  // ---------- Başlat ----------
  (async () => {
    try {
      await DB.open();
      const recovered = await recoverFromDisk().catch(e => { console.error(e); return 0; });
      await loadAll();
      await loadPopularity();
      await getAuth();
      renderChips(); renderCart(); renderLastSale(); updateApprBadge();
      if (IS_WEB && !(await Sync.cfg()).session) showCloudGate(); else goHome();
      Sync.start();
      if (recovered) toast(`Yedekten ${recovered} kayıt geri yüklendi, buluta gönderilecek`, 'ok');
      if (IS_WEB && navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      checkClock(); setInterval(checkClock, 5 * 60 * 1000);
      saveState(); setInterval(saveState, 60 * 1000);
      checkMonthly();
      setInterval(checkMonthly, 30 * 60 * 1000);
      setTimeout(autoPhotos, 1500);
      window.addEventListener('online', () => setTimeout(autoPhotos, 2000));
      focusScan();
    } catch (e) {
      document.body.innerHTML = `<div style="padding:40px;font-size:18px">Veritabanı açılamadı: ${esc(e.message)}</div>`;
    }
  })();
})();
