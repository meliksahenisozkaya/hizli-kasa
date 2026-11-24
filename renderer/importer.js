// Excel / CSV ürün listesi çözümleyici.
// Muhasebe programlarının "Stok Kartları Listesi" çıktısını (Kodu, Stok Ürün Adı, Özel Kod, Gurubu,
// Birimi, Barkodu, Açılış, Mevcut ...) ve basit CSV'yi (Barkod;Ad;Fiyat;Stok;KDV) tanır.
const Importer = (() => {
  // Eski Excel dosyalarında Türkçe harfler yanlış kod sayfasıyla gelir (Ý, Þ, Ð, ý, þ, ð)
  const TR_FIX = { 'Ý': 'İ', 'Þ': 'Ş', 'Ð': 'Ğ', 'ý': 'ı', 'þ': 'ş', 'ð': 'ğ' };
  const fixTr = s => String(s).replace(/[ÝÞÐýþð]/g, c => TR_FIX[c]);

  const norm = s => fixTr(s ?? '').toLocaleLowerCase('tr-TR')
    .replace(/[ıi̇]/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g').replace(/ü/g, 'u')
    .replace(/ö/g, 'o').replace(/ç/g, 'c').replace(/\s+/g, ' ').trim();

  const text = v => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
    return fixTr(v).replace(/\s+/g, ' ').trim();
  };

  function num(v) {
    if (v === null || v === undefined || v === '') return NaN;
    if (typeof v === 'number') return v;
    let s = String(v).trim().replace(/\s|₺|TL/gi, '');
    if (s.includes('.') && s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(',', '.');
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  }

  const UNIT_MAP = { kg: 'kg', kilo: 'kg', gr: 'gr', g: 'gr', brm: 'adet', adet: 'adet', ad: 'adet', ade: 'adet', adt: 'adet', tnk: 'teneke', teneke: 'teneke', ltr: 'lt',
    pkt: 'paket', paket: 'paket', koli: 'koli', kl: 'koli', lt: 'lt', litre: 'lt', kavanoz: 'kavanoz', kvn: 'kavanoz' };
  const unitOf = v => { const n = norm(v); return n ? (UNIT_MAP[n] || n) : ''; };

  // Başlık hücresi → alan
  function fieldOf(h) {
    const n = norm(h);
    if (!n) return null;
    if (n.includes('barkod')) return 'barcode';
    if (n.includes('ozel kod')) return 'extra';
    if (n === 'kodu' || n === 'kod' || n === 'stok kodu' || n === 'urun kodu') return 'code';
    if (n.includes('urun adi') || n.includes('stok adi') || n === 'adi' || n === 'urun' || n === 'aciklama') return 'name';
    if (n === 'urun id' || n === 'id' || n === 'kayit id') return 'id';
    if (n.includes('alt grup') || n.includes('alt kategori')) return 'subgroup';
    if (n.includes('kategori')) return 'category';
    if (n.includes('gurub') || n.includes('grub') || n === 'grup') return 'group';
    if (n.includes('birim') && !n.includes('fiyat')) return 'unit';
    if (n === 'mevcut' || n.includes('mevcut') || n === 'stok' || n === 'miktar' || n === 'stok miktari' || n === 'kalan') return 'stock';
    if (n.includes('kdv') && n.includes('dahil')) return 'vatIncl';
    if (n.includes('fiyat') || n.includes('satis')) return 'price';
    if (n.includes('kdv')) return 'vat';
    return null;
  }

  function findHeader(rows) {
    for (let i = 0; i < Math.min(rows.length, 40); i++) {
      const map = {};
      (rows[i] || []).forEach((c, j) => {
        const f = fieldOf(c);
        if (f && map[f] === undefined) map[f] = j;
      });
      if (map.name !== undefined && (map.barcode !== undefined || map.code !== undefined)) return { index: i, map };
    }
    return null;
  }

  const isFooter = s => /sayfa\s*\d+\s*\/\s*\d+|liste sonu|rapor suzgeci|liste tarihi/.test(norm(s));

  function parse(rows) {
    rows = rows.map(r => Array.isArray(r) ? r : []);
    const header = findHeader(rows);
    const items = [];
    let skipped = 0;
    if (header) {
      const m = header.map;
      const headKey = norm(rows[header.index][m.name]);
      const get = (r, f) => (m[f] === undefined ? undefined : r[m[f]]);
      for (let i = header.index + 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r.some(c => text(c))) continue;
        const name = text(get(r, 'name'));
        const code = text(get(r, 'code'));
        if (!name || norm(name) === headKey || isFooter(name) || isFooter(code)) { skipped++; continue; }
        const barcode = text(get(r, 'barcode')).replace(/\s/g, '');
        const extra = text(get(r, 'extra'));
        items.push({
          id: text(get(r, 'id')), category: text(get(r, 'category')), subgroup: text(get(r, 'subgroup')),
          code, barcode,
          name: extra && !norm(name).includes(norm(extra)) ? `${name} (${extra})` : name,
          unit: unitOf(get(r, 'unit')),
          group: text(get(r, 'group')),
          stock: num(get(r, 'stock')),
          price: num(get(r, 'price')),
          vat: num(get(r, 'vat')),
          vatIncl: (() => { const v = norm(get(r, 'vatIncl')); return v ? !/^(hayir|h|no|0|haric)$/.test(v) : null; })()
        });
      }
      return { format: 'liste', columns: Object.keys(m), items, skipped };
    }
    // Basit sıralı biçim: Barkod ; Ürün adı ; Fiyat ; Stok ; KDV
    for (const r of rows) {
      const [b, n, p, s, v] = r;
      const name = text(n), price = num(p);
      if (!name || !Number.isFinite(price)) { if (r.some(c => text(c))) skipped++; continue; }
      items.push({ code: '', barcode: text(b).replace(/\s/g, ''), name, unit: '', group: '', stock: num(s), price, vat: num(v), vatIncl: null });
    }
    return { format: 'basit', columns: ['barcode', 'name', 'price', 'stock', 'vat'], items, skipped };
  }

  // CSV metnini satır/sütun dizisine çevirir
  function csvRows(textIn) {
    const lines = textIn.replace(/^﻿/, '').split(/\r?\n/);
    const first = lines.find(l => l.trim()) || '';
    const d = [';', '\t', ','].find(c => first.includes(c)) || ';';
    return lines.map(l => l.split(d).map(x => x.trim().replace(/^"|"$/g, '')));
  }

  // Ürün adından kategori tahmini (Halis Fındık ürün yapısına göre). Yönetici panelinden değiştirilebilir.
  const CATEGORIES = ['Kabuklu & Çıtlama', 'Natürel İç', 'Kavrulmuş İç', 'Kıyılmış & Un', 'Krokan & Çikolata', 'Fındık Ezmesi', 'Diğer'];
  function guessCategory(name) {
    const n = norm(name);
    if (/bedel|ucret|aidat|vergi|belge|beyanname|fonu|teminat|tescil|navlun|gumrukle|kira|motorin|lpg|tahsilat|fark|sortex|islemi|tasdik|yansitma|tevkifat|klise|mailorder|ilan |sistem kullanim|kapsul|makina|arac|kargo|nakliye|pudra seker|toz seker|tuz$|karincabas|kavanoz|havlu/.test(n)) return 'Diğer';
    if (/etiket|kolisi|koli\b|kutusu|kutu\b|poset|torba|kapak|naylon|canta|bandi|bobin|cuval|palet|kova|callebaut|kuvertur|malzeme/.test(n)) return 'Diğer';
    if (/yaglik|ozurlu|zari\b|kabuk$/.test(n)) return 'Diğer';
    if (/ezme|pure|krema/.test(n)) return 'Fındık Ezmesi';
    if (/krokan|cikolata|finci|kurabiye/.test(n)) return 'Krokan & Çikolata';
    if (/kiyilmis|unu\b|un findik|dilinmis|kirik/.test(n)) return 'Kıyılmış & Un';
    if (/kabuklu|citla|tombul|tombu\b/.test(n)) return 'Kabuklu & Çıtlama';
    if (/naturel/.test(n)) return 'Natürel İç';
    if (/ic findik|kav\.?|kavrulmus|pikola|beyazla|zarli|tuzlu|cikinti|findik \d/.test(n)) return 'Kavrulmuş İç';
    return 'Diğer';
  }

  // Satış ekranında ana gruptan sonra gösterilen alt gruplar (sıra = ekrandaki sıra)
  const SUBGROUPS = {
    'Fındık Ezmesi': [['Şekerli Ezme', null], ['Şekersiz Ezme', /sekersiz/], ['Fındık Püresi', /pure/], ['Kremalar', /krema/]],
    'Krokan & Çikolata': [['Krokan', null], ['Çikolatalı Krokan', /krokan.*cikolata|cikolata.*krokan/], ['Çikolata', /cikolata|finci|special/]],
    'Kıyılmış & Un': [['Kıyılmış', null], ['Fındık Unu', /\bun\b|unu\b/]],
    'Kavrulmuş İç': [['Çifte Kavrulmuş', null], ['Pikola', /pikola/], ['Beyazlatma', /beyaz/], ['Tuzlu', /tuzlu|zarli/]],
    'Kabuklu & Çıtlama': [['Kabuklu', null], ['Çıtlama', /citlama/]]
  };
  function guessSubgroup(name, cat) {
    const rules = SUBGROUPS[cat]; if (!rules) return '';
    const n = norm(name);
    // özel kurallar sırayla denenir, hiçbiri tutmazsa varsayılan (null) alt grup
    for (const [g, re] of rules) if (re && re.test(n)) return g;
    return rules.find(r => !r[1])[0];
  }
  const subgroupOrder = cat => (SUBGROUPS[cat] || []).map(r => r[0]);

  return { parse, csvRows, fixTr, norm, guessCategory, guessSubgroup, subgroupOrder, CATEGORIES };
})();
if (typeof module !== 'undefined') module.exports = Importer;
