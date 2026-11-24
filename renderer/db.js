// Yerel veritabanı (IndexedDB) - internet olmadan tüm veriler burada tutulur
const DB = (() => {
  const NAME = 'hizli-kasa', VERSION = 1;
  let db = null;

  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const done = tx => new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error('İşlem iptal edildi'));
  });

  function open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(NAME, VERSION);
      r.onupgradeneeded = () => {
        const d = r.result;
        const p = d.createObjectStore('products', { keyPath: 'id' });
        p.createIndex('barcode', 'barcode', { unique: false });
        const s = d.createObjectStore('sales', { keyPath: 'id' });
        s.createIndex('created_at', 'created_at', { unique: false });
        const m = d.createObjectStore('stock_moves', { keyPath: 'id' });
        m.createIndex('product_id', 'product_id', { unique: false });
        d.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
        d.createObjectStore('meta', { keyPath: 'key' });
      };
      r.onsuccess = () => { db = r.result; res(db); };
      r.onerror = () => rej(r.error);
    });
  }

  async function get(store, key) { return req(db.transaction(store).objectStore(store).get(key)); }
  async function all(store) { return req(db.transaction(store).objectStore(store).getAll()); }
  async function count(store) { return req(db.transaction(store).objectStore(store).count()); }
  async function range(store, index, lo, hi) {
    return req(db.transaction(store).objectStore(store).index(index).getAll(IDBKeyRange.bound(lo, hi)));
  }
  async function outboxBatch(limit) {
    const tx = db.transaction('outbox');
    const st = tx.objectStore('outbox');
    const [keys, vals] = await Promise.all([req(st.getAllKeys(null, limit)), req(st.getAll(null, limit))]);
    return vals.map((v, i) => ({ ...v, seq: keys[i] }));
  }
  async function outboxDelete(seqs) {
    const tx = db.transaction('outbox', 'readwrite');
    const st = tx.objectStore('outbox');
    seqs.forEach(s => st.delete(s));
    return done(tx);
  }

  /**
   * Atomik yazma. ops: [{store, value}] kaydedilir, [{store, del: anahtar}] silinir.
   * sync: [{table, row, op?}] buluta gönderilmek üzere kuyruğa eklenir (aynı işlemde). op: 'upsert' | 'delete'
   */
  async function write(ops = [], sync = []) {
    const stores = new Set(ops.map(o => o.store));
    if (sync.length) stores.add('outbox');
    if (!stores.size) return;
    const tx = db.transaction([...stores], 'readwrite');
    ops.forEach(o => (o.del !== undefined ? tx.objectStore(o.store).delete(o.del) : tx.objectStore(o.store).put(o.value)));
    const now = new Date().toISOString();
    sync.forEach(s => tx.objectStore('outbox').add({ table: s.table, row: s.row, op: s.op || 'upsert', created_at: now }));
    return done(tx);
  }

  async function getMeta(key, def = null) {
    const r = await get('meta', key);
    return r === undefined ? def : r.value;
  }
  async function setMeta(key, value) { return write([{ store: 'meta', value: { key, value } }]); }

  return { open, get, all, count, range, outboxBatch, outboxDelete, write, getMeta, setMeta };
})();
