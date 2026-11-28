// Bulut senkronizasyonu (Google Firebase - Cloud Firestore).
// Kuyruktaki değişiklikler internet gelince gönderilir. Ücretsiz plan (Spark) süresiz, duraklatma yok.
const localMonth = iso => { const d = new Date(iso); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };
const Sync = (() => {
  const state = { status: 'kapali', pending: 0, lastSync: null, lastError: '' };
  let running = false;
  const listeners = [];

  const emit = () => listeners.forEach(fn => { try { fn({ ...state }); } catch (_) {} });
  const onChange = fn => { listeners.push(fn); fn({ ...state }); };

  // url = Firebase proje ID'si, key = Web API anahtarı
  async function cfg() {
    return {
      url: (await DB.getMeta('fb_project', '') || '').trim(),
      key: (await DB.getMeta('fb_key', '') || '').trim(),
      session: await DB.getMeta('fb_session', null)
    };
  }

  const AUTH_MSG = {
    INVALID_LOGIN_CREDENTIALS: 'E-posta veya şifre hatalı',
    INVALID_PASSWORD: 'E-posta veya şifre hatalı',
    EMAIL_NOT_FOUND: 'E-posta veya şifre hatalı',
    USER_DISABLED: 'Bu kullanıcı devre dışı bırakılmış',
    TOO_MANY_ATTEMPTS_TRY_LATER: 'Çok fazla deneme yapıldı, biraz sonra tekrar deneyin',
    TOKEN_EXPIRED: 'Oturum süresi doldu, yeniden giriş yapın',
    INVALID_REFRESH_TOKEN: 'Oturum geçersiz, yeniden giriş yapın',
    OPERATION_NOT_ALLOWED: 'Firebase panelinde E-posta/Şifre girişi açılmamış'
  };
  function authError(j, status) {
    const code = (j && j.error && (j.error.message || j.error)) || ('HTTP ' + status);
    const key = String(code).split(' ')[0].split(':')[0];
    const msg = AUTH_MSG[key] || (String(code).includes('API key') ? 'Web API anahtarı geçersiz' : 'Giriş hatası: ' + code);
    const e = new Error(msg); e.auth = true; return e;
  }

  async function saveSession(idToken, refreshToken, expiresIn, email) {
    const session = {
      access_token: idToken, refresh_token: refreshToken,
      expires_at: Math.floor(Date.now() / 1000) + Number(expiresIn || 3600), email
    };
    await DB.setMeta('fb_session', session);
    return session;
  }

  async function login(projectId, key, email, password) {
    projectId = projectId.trim(); key = key.trim();
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(key)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), password, returnSecureToken: true })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw authError(j, r.status);
    const s = await saveSession(j.idToken, j.refreshToken, j.expiresIn, j.email);
    await DB.setMeta('fb_project', projectId);
    await DB.setMeta('fb_key', key);
    state.lastError = '';
    run();
    return s;
  }

  async function logout() {
    await DB.setMeta('fb_session', null);
    state.status = 'kapali';
    emit();
  }

  async function token(force = false) {
    const c = await cfg();
    if (!c.url || !c.key || !c.session) { const e = new Error('Bulut bağlantısı kurulmadı'); e.auth = true; throw e; }
    const now = Math.floor(Date.now() / 1000);
    if (!force && c.session.expires_at - 120 > now) return { ...c, token: c.session.access_token };
    const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(c.key)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(c.session.refresh_token)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw authError(j, r.status);
    const s = await saveSession(j.id_token, j.refresh_token, j.expires_in, c.session.email);
    return { ...c, session: s, token: s.access_token };
  }

  // ---- Firestore değer dönüştürme ----
  function enc(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === 'boolean') return { booleanValue: v };
    if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (typeof v === 'string') return { stringValue: v };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
    if (typeof v === 'object') return { mapValue: { fields: encFields(v) } };
    return { stringValue: String(v) };
  }
  function encFields(o) { const f = {}; for (const k of Object.keys(o)) f[k] = enc(o[k]); return f; }
  function dec(x) {
    if (!x || 'nullValue' in x) return null;
    if ('booleanValue' in x) return x.booleanValue;
    if ('integerValue' in x) return Number(x.integerValue);
    if ('doubleValue' in x) return Number(x.doubleValue);
    if ('stringValue' in x) return x.stringValue;
    if ('timestampValue' in x) return x.timestampValue;
    if ('arrayValue' in x) return (x.arrayValue.values || []).map(dec);
    if ('mapValue' in x) return decFields(x.mapValue.fields || {});
    return null;
  }
  function decFields(f) { const o = {}; for (const k of Object.keys(f)) o[k] = dec(f[k]); return o; }

  async function api(method, path, body, retried = false) {
    const c = await token();
    const base = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(c.url)}/databases/(default)/documents`;
    const r = await fetch(base + path, {
      method,
      headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (r.status === 401 && !retried) { await token(true); return api(method, path, body, true); }
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      const m = (j.error && j.error.message) || ('HTTP ' + r.status);
      if (r.status === 403) throw new Error('Erişim reddedildi — Firestore kurallarını ve kasa e-postasını kontrol edin. (' + m + ')');
      if (r.status === 429) throw new Error('Firebase günlük ücretsiz kotası doldu, yarın otomatik devam eder. (' + m + ')');
      if (r.status === 404) throw new Error('Firestore veritabanı bulunamadı — Proje ID doğru mu, Firestore oluşturuldu mu? (' + m + ')');
      throw new Error('Sunucu hatası ' + r.status + ': ' + m);
    }
    return r.json();
  }

  let trimmedOnce = false;
  async function push() {
    const c = await cfg();
    const prefix = `projects/${c.url}/databases/(default)/documents/`;
    const TS = [{ fieldPath: '_ts', setToServerValue: 'REQUEST_TIME' }];   // sunucu saati: cihaz saatleri farklı olsa da sıralama doğru kalır
    let checkAt = '', pushed = false;
    for (;;) {
      checkAt = new Date().toISOString();
      const batch = await DB.outboxBatch(200);
      if (!batch.length) break;
      // Aynı kaydın yalnızca son hali gönderilir
      const latest = new Map();
      for (const item of batch) latest.set(item.table + '/' + item.row.id, item);
      const writes = [];
      for (const [path, item] of latest) {
        if (item.op === 'delete') {
          writes.push({ delete: prefix + path });
          // Silinen kaydı diğer cihazlara bildirmek için iz bırakılır
          const tid = item.table + '__' + item.row.id;
          writes.push({ update: { name: prefix + 'tombstones/' + tid, fields: encFields({ id: tid, table: item.table, ref: item.row.id }) }, updateTransforms: TS });
        } else {
          const row = { ...item.row }; delete row._ts;
          writes.push({ update: { name: prefix + path, fields: encFields(row) }, updateTransforms: TS });
        }
      }
      await api('POST', ':commit', { writes });   // tek seferde, ya hepsi ya hiçbiri
      await DB.outboxDelete(batch.map(b => b.seq));
      pushed = true;
      state.pending = await DB.count('outbox');
      emit();
    }
    // Kuyruk boşaldı: buluta ulaşan kayıtlar yedek defterden çıkarılır
    if ((pushed || !trimmedOnce) && window.kasa && window.kasa.journalTrim) { trimmedOnce = true; try { await window.kasa.journalTrim(checkAt); } catch (_) {} }
  }

  async function fetchAll(collection) {
    const out = [];
    let pageToken = '';
    do {
      const j = await api('GET', `/${collection}?pageSize=300${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`);
      (j.documents || []).forEach(d => {
        const o = decFields(d.fields || {});
        if (!o.id) o.id = d.name.split('/').pop();
        out.push(o);
      });
      pageToken = j.nextPageToken || '';
    } while (pageToken);
    return out;
  }

  // ---- Buluttan çekme (diğer cihazlardaki değişiklikler) ----
  async function query(collection, field, op, value, limit = 1000) {
    const j = await api('POST', ':runQuery', { structuredQuery: {
      from: [{ collectionId: collection }],
      where: { fieldFilter: { field: { fieldPath: field }, op, value } }, limit } });
    const arr = Array.isArray(j) ? j : [];
    const readTime = (arr.find(x => x.readTime) || {}).readTime || null;
    const rows = arr.filter(x => x.document).map(x => {
      const o = decFields(x.document.fields || {});
      if (!o.id) o.id = x.document.name.split('/').pop();
      return o;
    });
    return { rows, readTime };
  }
  const ms = v => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : 0; };
  const stamp = r => Math.max(ms(r.updated_at), ms(r.created_at), ms(r.cancelled_at), ms(r.approved_at), ms(r.rejected_at), ms(r.done_at));
  const iso = v => new Date(v || 0).toISOString();
  const NORM = {
    products: p => ({ ...p, price: Number(p.price || 0), stock: Number(p.stock || 0), vat_rate: Number(p.vat_rate || 0),
      min_stock: Number(p.min_stock || 0), active: p.active !== false, updated_at: iso(p.updated_at) }),
    sales: s => ({ ...s, created_at: iso(s.created_at), items: s.items || [], sale_no: Number(s.sale_no || 0), total: Number(s.total || 0) }),
    orders: o => ({ ...o, created_at: iso(o.created_at), items: o.items || [], no: Number(o.no || 0), total: Number(o.total || 0) }),
    cash_moves: m => ({ ...m, created_at: iso(m.created_at), amount: Number(m.amount || 0) }),
    customers: c => ({ ...c, created_at: iso(c.created_at) }),
    cari: e => ({ ...e, created_at: iso(e.created_at), amount: Number(e.amount || 0) })
  };

  // Uzak kayıtları yerel veritabanına uygular; daha yeni olan kazanır
  async function apply(table, rows, sum) {
    if (!rows.length) return;
    const archived = table === 'sales' ? new Set((await DB.all('archives')).map(a => a.month)) : null;
    const ops = [];
    let maxNo = 0;
    for (const r of rows) {
      const row = NORM[table](r); delete row._ts;
      if (table === 'sales') {
        if (archived.has(localMonth(row.created_at))) continue;
        maxNo = Math.max(maxNo, row.sale_no);
      }
      if (table === 'orders') maxNo = Math.max(maxNo, row.no);
      const local = await DB.get(table, row.id);
      if (local && stamp(row) <= stamp(local)) continue;
      if (table === 'orders' && local && local.status === row.status) row.notified = local.notified;
      ops.push({ store: table, value: row });
    }
    const key = table === 'sales' ? 'sale_no' : table === 'orders' ? 'order_no' : null;
    if (key && maxNo > (await DB.getMeta(key, 0))) ops.push({ store: 'meta', value: { key, value: maxNo } });
    if (ops.length) await DB.write(ops);
    sum[table] = (sum[table] || 0) + ops.filter(o => o.store === table).length;
  }
  async function applyTombstones(rows, sum) {
    const ops = [];
    for (const t of rows) {
      if (!['products', 'sales', 'orders', 'cash_moves', 'customers', 'cari'].includes(t.table) || !t.ref) continue;
      if (await DB.get(t.table, t.ref)) { ops.push({ store: t.table, del: t.ref }); sum[t.table] = (sum[t.table] || 0) + 1; }
    }
    if (ops.length) await DB.write(ops);
  }

  // İlk bağlantıda: tüm ürünler, siparişler, ayarlar ve son 2 ayın satışları
  async function fullLoad() {
    const sum = { config: [] };
    const d = new Date(); const from = new Date(d.getFullYear(), d.getMonth() - 1, 1).toISOString();
    const sq = await query('sales', 'created_at', 'GREATER_THAN_OR_EQUAL', { stringValue: from }, 5000);
    await apply('products', await fetchAll('products'), sum);
    await apply('sales', sq.rows, sum);
    await apply('orders', await fetchAll('orders'), sum);
    await apply('customers', await fetchAll('customers'), sum);
    await apply('cari', await fetchAll('cari'), sum);
    await apply('cash_moves', (await query('cash_moves', 'created_at', 'GREATER_THAN_OR_EQUAL', { stringValue: from }, 5000)).rows, sum);
    sum.config = await fetchAll('config');
    const since = sq.readTime || new Date().toISOString();
    const pull = {}; Object.keys(PULL_EVERY).forEach(c => { pull[c] = since; });
    await DB.setMeta('pull_since', pull);
    sum.full = true;
    return sum;
  }

  // Sık değişen tablolar daha sık kontrol edilir (ücretsiz okuma kotası için)
  const PULL_EVERY = { orders: 8000, sales: 30000, cari: 60000, cash_moves: 60000, customers: 120000, products: 120000, tombstones: 120000, config: 120000 };
  const lastPull = {};
  async function pull(force = false) {
    let since = await DB.getMeta('pull_since', null);
    if (!since) return fullLoad();
    const sum = { config: [] };
    const now = Date.now();
    for (const c of Object.keys(PULL_EVERY)) {
      if (!force && lastPull[c] && now - lastPull[c] < PULL_EVERY[c]) continue;
      const from = new Date(ms(since[c]) - 5000).toISOString();    // küçük örtüşme: kaçırma olmasın
      const q = await query(c, '_ts', 'GREATER_THAN', { timestampValue: from });
      lastPull[c] = now;
      if (c === 'tombstones') await applyTombstones(q.rows, sum);
      else if (c === 'config') sum.config = q.rows;
      else await apply(c, q.rows, sum);
      if (q.readTime) since = { ...since, [c]: q.readTime };
    }
    await DB.setMeta('pull_since', since);
    return sum;
  }
  const pullListeners = [];
  const onPulled = fn => pullListeners.push(fn);
  const notifyPulled = sum => {
    if (sum && (sum.full || sum.products || sum.sales || sum.orders || sum.cash_moves || sum.customers || sum.cari || (sum.config && sum.config.length)))
      pullListeners.forEach(fn => { try { fn(sum); } catch (e) { console.error(e); } });
  };

  // Elle "Buluttan geri yükle": tam yükleme
  async function restore() {
    await DB.setMeta('pull_since', null);
    const sum = await fullLoad();
    notifyPulled(sum);
    return { products: sum.products || 0, sales: sum.sales || 0 };
  }

  let forcePull = false;
  async function run(force = false) {
    if (force) forcePull = true;
    if (running) return;
    running = true;
    try {
      state.pending = await DB.count('outbox');
      const c = await cfg();
      if (!c.url || !c.session) { state.status = 'kapali'; return; }
      if (!navigator.onLine) { state.status = 'cevrimdisi'; return; }
      state.status = 'gonderiliyor'; emit();
      await push();
      if (!(document.hidden && Sync.isWeb)) notifyPulled(await pull(forcePull));
      forcePull = false;
      state.status = 'tamam';
      state.lastSync = new Date();
      state.lastError = '';
    } catch (e) {
      if (e instanceof TypeError) state.status = 'cevrimdisi';      // ağ yok / sunucuya ulaşılamıyor
      else { state.status = 'hata'; state.lastError = e.message; }
      if (e.auth) state.lastError = e.message + ' — Ayarlar > Bulut bölümünden yeniden giriş yapın.';
    } finally {
      state.pending = await DB.count('outbox');
      running = false;
      emit();
    }
  }

  function start() {
    run();
    setInterval(run, 10000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) run(true); });
    window.addEventListener('online', () => setTimeout(run, 1000));
    window.addEventListener('offline', () => { state.status = 'cevrimdisi'; emit(); });
  }

  const Sync = { start, run, login, logout, restore, onChange, onPulled, state, cfg, isWeb: false };
  return Sync;
})();
