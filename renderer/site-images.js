// halisfindik.com ürün fotoğrafları — ürün adına göre eşleştirme kuralları.
// Sıra önemlidir: ilk eşleşen kural kullanılır. Ad, Importer.norm ile sadeleştirilmiş haliyle sınanır.
const SiteImages = (() => {
  const BASE = 'https://halisfindik.com/image/cache/catalog/findik-gorselleri/';
  const F = {
    kabuklu: '1_Kabuklu_Fındık_katalog-250x250.png',
    citlama: '2_Çıtlatılmış_Kavrulmuş_Kabuklu_Fındık_katalog-250x250.png',
    citlamaTuzlu: '3_Tuzlu_Çıtlatılmış_Kavrulmuş_Kabuklu_Fındık_katalog-250x250.png',
    naturel: '4_Natürel_İç_Fındık_katalog-250x250.png',
    kavrulmus: '6_Kavrulmuş_İç_Fındık_katalog-250x250.png',
    pikola: '7_Kavrulmuş_Pikola_İç_Fındık_katalog-250x250.png',
    krokan: '10_Fındık_Krokanı_katalog-250x250.png',
    zarliTuzlu: 'ChatGPT Görseli 3 Kas 2026 12_32_32-250x250.png',
    kiyilmis: 'ChatGPT Görseli 3 Kas 2026 12_45_22-250x250.png',
    un: 'ChatGPT Görseli 3 Kas 2026 12_49_32-250x250.png',
    ezme180: 'ezme_180gr-250x250.jpg',
    ezme320: 'ezme_320gr-250x250.jpg',
    ezme640: 'ezme_640-250x250.jpg',
    sekersiz160: 'ezmesekersiz_160gr-250x250.jpg',
    sekersiz300: 'ezmesekersiz_300gr-250x250.jpg',
    sekersiz600: 'ezmesekersiz_600gr900gr-250x250.jpg'
  };
  const grams = n => { const m = n.match(/(\d+)\s*(g|gr|cc)\b/); return m ? Number(m[1]) : 0; };

  function match(rawName) {
    const n = Importer.norm(rawName);
    if (/etiket|koli|kutusu|kavanoz|kapak|poset|torba|bedel|ucret/.test(n)) return null;
    if (/cikolata|finci|krema|pure|kurabiye/.test(n)) return null;          // sitede fotoğrafı yok
    if (/ezme/.test(n)) {
      const g = grams(n);
      if (/sekersiz/.test(n)) return F[g && g <= 200 ? 'sekersiz160' : g && g <= 400 ? 'sekersiz300' : 'sekersiz600'];
      return F[g && g <= 200 ? 'ezme180' : g && g <= 400 ? 'ezme320' : 'ezme640'];
    }
    if (/krokan/.test(n)) return F.krokan;
    if (/kiyilmis|dilinmis/.test(n)) return F.kiyilmis;
    if (/unu\b|un findik/.test(n)) return F.un;
    if (/citla/.test(n)) return F[/tuzlu|\btz\b/.test(n) ? 'citlamaTuzlu' : 'citlama'];
    if (/kabuklu|tombul|tombu\b/.test(n)) return F.kabuklu;
    if (/zarli|tuzlu/.test(n)) return F.zarliTuzlu;
    if (/pikola/.test(n)) return F[/naturel/.test(n) ? 'naturel' : 'pikola'];
    if (/naturel/.test(n)) return F.naturel;
    if (/ic findik|kav\.?|kavrulmus|beyazla/.test(n)) return F.kavrulmus;
    return null;
  }
  const urlFor = name => { const f = match(name); return f ? BASE + encodeURIComponent(f).replace(/%2F/g, '/') : null; };
  return { urlFor };
})();
