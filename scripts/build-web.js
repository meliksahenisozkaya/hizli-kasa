// Web sürümünü oluşturur: renderer/ + web/ -> web-dist/  (Vercel bu klasörü yayınlar)
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const out = path.join(root, 'web-dist');
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, 'renderer'), out, { recursive: true });
fs.mkdirSync(path.join(out, 'vendor'), { recursive: true });

const pick = list => list.map(p => path.join(root, 'node_modules', p)).find(p => fs.existsSync(p));
const vendors = [];
const xlsx = pick(['xlsx/dist/xlsx.full.min.js']);
if (xlsx) { fs.copyFileSync(xlsx, path.join(out, 'vendor/xlsx.full.min.js')); vendors.push('vendor/xlsx.full.min.js'); }
else console.warn('UYARI: xlsx bulunamadı — web sürümünde Excel çalışmaz');
const zx = pick(['@zxing/library/umd/index.min.js', '@zxing/library/umd/index.js']);
if (zx) { fs.copyFileSync(zx, path.join(out, 'vendor/zxing.min.js')); vendors.push('vendor/zxing.min.js'); }
else console.warn('UYARI: @zxing/library bulunamadı — kamera yalnızca BarcodeDetector destekli tarayıcılarda çalışır');

for (const f of ['web-shim.js', 'web-config.js', 'manifest.webmanifest', 'icon.svg']) {
  const src = path.join(root, 'web', f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(out, f));
}

let html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
const tags = ['web-config.js', 'web-shim.js', ...vendors].map(s => `  <script src="${s}"></script>`).join('\n');
html = html.replace('  <script src="db.js"></script>', tags + '\n  <script src="db.js"></script>');
html = html.replace('<title>Hızlı Kasa</title>', '<title>Hızlı Kasa</title>\n  <link rel="manifest" href="manifest.webmanifest">\n  <link rel="icon" href="icon.svg">\n  <link rel="apple-touch-icon" href="icon.svg">\n  <meta name="apple-mobile-web-app-capable" content="yes">');
// Tarayıcıda kamera görüntüsü için media-src gerekir
html = html.replace("img-src 'self' data:;", "img-src 'self' data: blob:; media-src 'self' blob: mediastream:;");
fs.writeFileSync(path.join(out, 'index.html'), html);
console.log('web-dist hazır:', fs.readdirSync(out).join(', '));
