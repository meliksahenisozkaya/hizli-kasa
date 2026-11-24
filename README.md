# Hızlı Kasa — Barkodlu Satış Programı (Windows)

Barkod okut → Nakit (F8) / Kart (F9) → fiş. İnternet yokken de çalışır; tüm satışlar bilgisayarda saklanır, internet gelince Firebase (Google) bulutuna otomatik gönderilir.

## Özellikler
- Barkodla hızlı satış, ad ile arama, `3*barkod` ile çoklu miktar, `0,5*barkod` ile kg satış
- Kayıtlı olmayan barkod okutulunca anında ürün ekleme ekranı açılır
- Nakit ödemede para üstü hesabı (hızlı banknot butonları)
- Stok takibi: satışta stok düşer, mal girişi / sayım / fire, kritik stok uyarısı
- Excel (.xls / .xlsx) veya CSV ile toplu ürün yükleme — muhasebe programının "Fiyat Listesi (Perakende Satış Fiyatları)" ve "Stok Kartları Listesi" raporları doğrudan okunur; KDV hariç fiyatlara KDV eklenir; önizleme gösterilir; içe aktarma penceresinden örnek Excel indirilebilir
- Ürün silme (tek tek veya seçerek toplu), buluttan da silinir
- Fiyatı olmayan ürün okutulunca fiyat sorulur, istenirse ürüne kaydedilir
- Stok kodu ile satış (barkodsuz ürünler için kodu yazıp Enter)
- Gün sonu raporu: nakit / kart / toplam, en çok satanlar, satış listesi, yazdırma
- Yanlış satışı iptal etme (stok geri eklenir)
- 58 / 80 mm termal yazıcıdan fiş (yazıcı seçilirse soru sormadan basar)
- Çevrimdışı çalışma + otomatik bulut senkronu + buluttan geri yükleme + JSON yedek

## Kısayollar
| Tuş | İşlev |
|---|---|
| F1 / F2 / F3 / F4 | Satış / Ürünler / Gün sonu / Ayarlar |
| F8 | Nakit ödeme |
| F9 | Kart ödeme |
| Enter | Barkod ekle / onayla |
| Delete (boş kutuda) | Son eklenen ürünü sil |
| Esc | Pencereyi kapat |
| F11 | Tam ekran |

---

## 1) Firebase kurulumu (bir kere, ~10 dakika, kredi kartı gerekmez)
1. https://console.firebase.google.com → Google hesabınızla girin → **Proje oluştur** (ör. `sirketim-kasa`). Google Analytics'i kapatabilirsiniz. Plan **Spark (ücretsiz)** olarak kalsın.
2. Sol menü **Build → Firestore Database → Veritabanı oluştur** → *Standard* sürüm, konum **europe-west3 (Frankfurt)** → *Production mode*.
3. Firestore'un **Rules (Kurallar)** sekmesine `firebase/firestore.rules` dosyasının içeriğini yapıştırın, içindeki `kasa@sirketiniz.com` adresini kendi kasa e-postanızla değiştirip **Yayınla**'ya basın.
4. **Build → Authentication → Başlayın → Sign-in method → E-posta/Şifre**'yi etkinleştirin.
5. **Authentication → Users → Kullanıcı ekle**: 3. adımdaki e-posta ve bir şifre girin.
6. **Authentication → Settings → User actions** bölümünde **Enable create (sign-up)** işaretini kaldırın (başkası hesap açamasın).
7. **Proje ayarları (dişli simgesi) → Genel**: *Proje kimliği* ve *Web API anahtarı* değerlerini kopyalayın. (Web API anahtarı görünmüyorsa aynı sayfada "Web uygulaması ekle" (`</>`) ile bir web uygulaması kaydedin.)
8. Programda **Ayarlar (F4) → Bulut** bölümüne Proje ID, Web API anahtarı, e-posta ve şifreyi girip **Bağlan**'a basın.

Verileri Firebase panelinde **Firestore Database → Data** sekmesinden görebilirsiniz (`products`, `sales`, `stock_moves`).

## 2) EXE oluşturma

### Yol A — GitHub ile (bilgisayara bir şey kurmadan)
1. Bu klasörü yeni bir GitHub deposuna yükleyin (`main` dalı).
2. **Actions** sekmesinde "Windows EXE olustur" iş akışı otomatik çalışır (~5 dk).
3. Bitince çalıştırmanın sayfasında **Artifacts → HizliKasa-Kurulum** dosyasını indirin, içindeki `Hizli Kasa Setup 1.0.0.exe` ile kurun.

### Yol B — Kendi bilgisayarınızda
1. https://nodejs.org adresinden Node.js 20 LTS kurun.
2. Bu klasörde komut satırı açıp:
   ```
   npm install
   npm start          (denemek için)
   npm run dist       (EXE üretir → dist\Hizli Kasa Setup 1.0.0.exe)
   ```

## 3) İlk kullanım
1. Ayarlar → işletme adı, adres, yazıcı, kağıt genişliği → Kaydet → **Test fişi yazdır**.
2. Ürünler (F2) → **Yeni ürün** veya **Excel / CSV içe aktar** (muhasebe programının stok listesi Excel'i ya da `ornek-urunler.csv` düzeni).
3. Satış (F1) → barkod okutun.

## Önemli notlar
- Basılan fiş **bilgi fişidir**, mali değeri yoktur. Yasal satış belgesi için ÖKC (yazarkasa POS) veya e-Arşiv fatura kullanmaya devam edin.
- Yerel veriler `%APPDATA%\Hizli Kasa` klasöründe tutulur; program kaldırılsa bile silinmez.
- Yeni bilgisayara geçişte: programı kurun → Ayarlar'dan buluta bağlanın → **Buluttan geri yükle**.
- Firebase ücretsiz (Spark) planında süre sınırı ve kullanılmama duraklatması yoktur; aylarca satış olmasa da veriler yerinde kalır.
  Limitler: 1 GB veri (≈ 1 milyon satış), günde 20.000 yazma, 50.000 okuma. 3 kalemli bir satış ~7 yazma tutar, yani günde ~2.800 satışa kadar ücretsizdir.
  Limit dolarsa program çevrimdışı gibi çalışmaya devam eder, kalanlar ertesi gün otomatik gönderilir.
- Çok büyük arşivi "Buluttan geri yükle" ile indirirken günlük 50.000 okuma sınırına takılırsanız ertesi gün tekrar basmanız yeterli.
