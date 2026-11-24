// Bulut senkronizasyonu (Google Firebase - Cloud Firestore).
// Kuyruktaki değişiklikler internet gelince gönderilir. Ücretsiz plan (Spark) süresiz, duraklatma yok.
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

  async function push() {
    const c = await cfg();
    const prefix = `projects/${c.url}/databases/(default)/documents/`;
    for (;;) {
      const batch = await DB.outboxBatch(300);
      if (!batch.length) break;
      // Aynı kaydın yalnızca son hali gönderilir
      const latest = new Map();
      for (const item of batch) latest.set(item.table + '/' + item.row.id, item);
      const writes = [...latest].map(([path, item]) => item.op === 'delete'
        ? { delete: prefix + path }
        : { update: { name: prefix + path, fields: encFields(item.row) } });
      await api('POST', ':commit', { writes });   // tek seferde, ya hepsi ya hiçbiri
      await DB.outboxDelete(batch.map(b => b.seq));
      state.pending = await DB.count('outbox');
      emit();
    }
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

  // Buluttaki verileri yerel veritabanına indirir (yeni bilgisayar kurulumu / kurtarma)
  async function restore() {
    const products = await fetchAll('products');
    const sales = await fetchAll('sales');
    const ops = [];
    let maxNo = await DB.getMeta('sale_no', 0);
    for (const p of products) {
      const local = await DB.get('products', p.id);
      const row = {
        ...p,
        price: Number(p.price || 0), stock: Number(p.stock || 0), vat_rate: Number(p.vat_rate || 0),
        min_stock: Number(p.min_stock || 0), active: p.active !== false,
        updated_at: new Date(p.updated_at || 0).toISOString()
      };
      if (!local || Date.parse(row.updated_at) > Date.parse(local.updated_at)) ops.push({ store: 'products', value: row });
    }
    for (const s of sales) {
      const local = await DB.get('sales', s.id);
      if (!local) ops.push({ store: 'sales', value: { ...s, created_at: new Date(s.created_at).toISOString(), items: s.items || [] } });
      if (Number(s.sale_no) > maxNo) maxNo = Number(s.sale_no);
    }
    ops.push({ store: 'meta', value: { key: 'sale_no', value: maxNo } });
    await DB.write(ops);
    return { products: products.length, sales: sales.length };
  }

  async function run() {
    if (running) return;
    running = true;
    try {
      state.pending = await DB.count('outbox');
      const c = await cfg();
      if (!c.url || !c.session) { state.status = 'kapali'; return; }
      if (!navigator.onLine) { state.status = 'cevrimdisi'; return; }
      state.status = 'gonderiliyor'; emit();
      await push();
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
    setInterval(run, 20000);
    window.addEventListener('online', () => setTimeout(run, 1000));
    window.addEventListener('offline', () => { state.status = 'cevrimdisi'; emit(); });
  }

  return { start, run, login, logout, restore, onChange, state, cfg };
})();
