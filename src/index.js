require('dotenv').config();
var express = require('express');
var cors = require('cors');
var jwt = require('jsonwebtoken');
var bcrypt = require('bcryptjs');
var Database = require('better-sqlite3');
var https = require('https');
var http = require('http');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var insecureAgent = new https.Agent({ rejectUnauthorized: false });

var app = express();
var PORT = process.env.PORT || 3001;
var JWT_SECRET = process.env.JWT_SECRET || 'shopfind_secret_2025';

var DB_PATH = process.env.DB_PATH || './data/v4.db';
var dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

var db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, created_at TEXT)');
db.exec('CREATE TABLE IF NOT EXISTS stores (id TEXT PRIMARY KEY, domain TEXT UNIQUE NOT NULL, name TEXT, product_count INTEGER DEFAULT 0, country TEXT, currency TEXT, language TEXT, majestic_rank INTEGER DEFAULT 999999999, scraped_at TEXT)');
db.exec('CREATE TABLE IF NOT EXISTS scrape_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT UNIQUE NOT NULL, status TEXT, majestic_rank INTEGER DEFAULT 999999999, added_at TEXT)');

app.set('trust proxy', 1);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// ─── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────
function auth(req, res, next) {
  var h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Token gerekli' });
  try { req.user = jwt.verify(h.slice(7), JWT_SECRET); next(); }
  catch (e) { res.status(401).json({ error: 'Gecersiz token' }); }
}

// ─── AUTH ROUTES ───────────────────────────────────────────────────────────────
app.post('/api/auth/register', function(req, res) {
  var email = req.body.email, password = req.body.password;
  if (!email || !password) return res.status(400).json({ error: 'Email ve sifre gerekli' });
  if (password.length < 6) return res.status(400).json({ error: 'Sifre en az 6 karakter olmali' });
  try {
    var hash = bcrypt.hashSync(password, 10);
    var id = crypto.randomUUID();
    db.prepare('INSERT INTO users (id, email, password, created_at) VALUES (?, ?, ?, ?)').run(id, email, hash, new Date().toISOString());
    var token = jwt.sign({ id: id, email: email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token: token, user: { id: id, email: email } });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Bu email zaten kayitli' });
    res.status(500).json({ error: 'Sunucu hatasi' });
  }
});

app.post('/api/auth/login', function(req, res) {
  var email = req.body.email, password = req.body.password;
  if (!email || !password) return res.status(400).json({ error: 'Email ve sifre gerekli' });
  var user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Email veya sifre yanlis' });
  var token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token: token, user: { id: user.id, email: user.email } });
});

// ─── STORE ROUTES ──────────────────────────────────────────────────────────────
app.get('/api/stores', auth, function(req, res) {
  var page = parseInt(req.query.page) || 1;
  var offset = (page - 1) * 50;
  var stores = db.prepare('SELECT * FROM stores ORDER BY majestic_rank ASC LIMIT 50 OFFSET ?').all(offset);
  var total = db.prepare('SELECT COUNT(*) as n FROM stores').get().n;
  res.json({ stores: stores, total: total, totalAll: total, page: page });
});

app.get('/api/stats', auth, function(req, res) {
  var total = db.prepare('SELECT COUNT(*) as n FROM stores').get().n;
  var pending = db.prepare("SELECT COUNT(*) as n FROM scrape_queue WHERE status='pending'").get().n;
  var done = db.prepare("SELECT COUNT(*) as n FROM scrape_queue WHERE status='done'").get().n;
  var notShopify = db.prepare("SELECT COUNT(*) as n FROM scrape_queue WHERE status='not_shopify'").get().n;
  res.json({ total: total, withDate: total, pending: pending, done: done, notShopify: notShopify });
});

// ─── FETCH UTILITY ────────────────────────────────────────────────────────────
function fetchUrl(url, timeout) {
  return new Promise(function(resolve, reject) {
    try {
      var u = new URL(url);
      var lib = u.protocol === 'https:' ? https : http;
      var req = lib.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        agent: u.protocol === 'https:' ? insecureAgent : undefined,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        timeout: timeout || 10000
      }, function(response) {
        if ([301,302,303,307,308].includes(response.statusCode) && response.headers.location) {
          try {
            var loc = response.headers.location;
            var redir = loc.startsWith('http') ? loc : u.protocol + '//' + u.hostname + loc;
            fetchUrl(redir, timeout).then(resolve).catch(reject);
            return;
          } catch(e) {}
        }
        var data = '';
        response.on('data', function(c) { data += c; });
        response.on('end', function() { resolve({ status: response.statusCode, body: data, headers: response.headers }); });
      });
      req.on('error', reject);
      req.on('timeout', function() { req.destroy(); reject(new Error('timeout')); });
      req.end();
    } catch(e) { reject(e); }
  });
}

// ─── SCRAPE SHOPIFY ───────────────────────────────────────────────────────────
async function scrapeShopify(domain, rank) {
  var result = { domain: domain, name: domain.split('.')[0], product_count: 0, majestic_rank: rank || 999999999 };
  try {
    var pr = await fetchUrl('https://' + domain + '/products.json?limit=10', 10000);
    if (pr.status !== 200) return null;
    try {
      var pj = JSON.parse(pr.body);
      if (!pj.products) return null;
      result.product_count = pj.products.length;
    } catch(e) { return null; }
    var hr = await fetchUrl('https://' + domain, 10000);
    if (hr.status !== 200 || !hr.body) return null;
    if (!hr.body.includes('cdn.shopify') && !hr.body.includes('Shopify.theme') && !hr.body.includes('shopify')) return null;
    var b = hr.body;
    var titleM = b.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleM) result.name = titleM[1].split(/[|\-\u2013]/)[0].trim().substring(0, 100);
    var curM = b.match(/"currency"\s*:\s*"([A-Z]{3})"/);
    if (curM) result.currency = curM[1];
    var langM = b.match(/<html[^>]+lang="([^"]+)"/i);
    if (langM) result.language = langM[1].split('-')[0];
    var countryM = b.match(/"country_code"\s*:\s*"([A-Z]{2})"/);
    if (countryM) result.country = countryM[1];
  } catch(e) { return null; }
  return result;
}

// ─── SAVE STORE ───────────────────────────────────────────────────────────────
function saveStore(s) {
  if (!s) return;
  try {
    var existing = db.prepare('SELECT id FROM stores WHERE domain = ?').get(s.domain);
    if (existing) {
      db.prepare('UPDATE stores SET name=?, product_count=?, country=?, currency=?, language=?, majestic_rank=?, scraped_at=? WHERE domain=?')
        .run(s.name, s.product_count, s.country||null, s.currency||null, s.language||null, s.majestic_rank, new Date().toISOString(), s.domain);
    } else {
      db.prepare('INSERT INTO stores (id, domain, name, product_count, country, currency, language, majestic_rank, scraped_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(crypto.randomUUID(), s.domain, s.name, s.product_count, s.country||null, s.currency||null, s.language||null, s.majestic_rank, new Date().toISOString());
    }
  } catch(e) { console.error('saveStore:', e.message); }
}

// ─── ADD TO QUEUE ─────────────────────────────────────────────────────────────
var SKIP_DOMAINS = ['google','youtube','facebook','instagram','twitter','wikipedia','amazon','ebay','microsoft','bing','apple','reddit','linkedin','tiktok','pinterest','snapchat','shopify.com','cdn.shopify','myshopify.com','cloudflare','googleapis','gstatic','jquery','bootstrapcdn','fontawesome','w3.org'];

function addToQueue(domain, rank) {
  try {
    if (!domain || domain.length > 100) return;
    if (SKIP_DOMAINS.some(function(w) { return domain.includes(w); })) return;
    if (domain.split('.').length < 2) return;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9\-\.]+\.[a-zA-Z]{2,}$/.test(domain)) return;
    db.prepare('INSERT OR IGNORE INTO scrape_queue (domain, status, majestic_rank, added_at) VALUES (?, ?, ?, ?)').run(domain, 'pending', rank || 999999999, new Date().toISOString());
  } catch(e) {}
}

// ─── DISCOVERY 1: SHOPIFY ID CRAWL ───────────────────────────────────────────
var shopifyId = 1;
async function discoverFromShopifyId() {
  try {
    for (var i = 0; i < 10; i++) {
      try {
        var r = await fetchUrl('https://checkout.shopify.com/' + shopifyId + '/sandbox/google_analytics_iframe', 8000);
        if (r.status === 200 && r.body) {
          var domainPattern = /([a-zA-Z0-9\-]+\.(?:com|net|org|io|co|shop|store|me|info|biz|co\.uk|com\.au))/;
          var domainM = r.body.match(domainPattern);
          if (domainM) addToQueue(domainM[1].toLowerCase(), 500000);
        }
      } catch(e) {}
      shopifyId++;
    }
    console.log('[ShopifyID] id:' + shopifyId);
  } catch(e) { console.error('[ShopifyID]', e.message); }
}

// ─── DISCOVERY 2: MYIP.MS ─────────────────────────────────────────────────────
var myipPage = 1;
async function discoverFromMyip() {
  try {
    var ips = ['23.227.38.32','23.227.38.33','23.227.38.34','23.227.38.35','23.227.38.36'];
    var ip = ips[Math.floor(Math.random() * ips.length)];
    var r = await fetchUrl('https://myip.ms/' + ip + '#ipinfo', 15000);
    if (r.status !== 200 || !r.body) { console.log('[myip.ms] status:' + r.status); return; }
    var hrefPattern = new RegExp('href=["\']https?://(?:www\\.)?([a-zA-Z0-9][a-zA-Z0-9\\-]*\\.[a-zA-Z]{2,})', 'g');
    var matches = r.body.matchAll(hrefPattern);
    var added = 0;
    for (var m of matches) {
      var domain = m[1].toLowerCase();
      if (domain && !db.prepare('SELECT 1 FROM scrape_queue WHERE domain=?').get(domain)) {
        addToQueue(domain, 300000);
        added++;
      }
    }
    myipPage++;
    console.log('[myip.ms] ekledi:' + added);
  } catch(e) { console.error('[myip.ms]', e.message); }
}

// ─── DISCOVERY 3: SHOPIFY APP STORE ──────────────────────────────────────────
var appsPage = 1;
async function discoverFromAppsShopify() {
  try {
    var r = await fetchUrl('https://apps.shopify.com/browse/recommended', 15000);
    if (r.status !== 200 || !r.body) { console.log('[AppsShopify] status:' + r.status); return; }
    var hrefPattern = new RegExp('href=["\']https?://(?:www\\.)?([a-zA-Z0-9][a-zA-Z0-9\\-]*\\.[a-zA-Z]{2,})(?:/|["\'])', 'g');
    var matches = r.body.matchAll(hrefPattern);
    var added = 0;
    for (var m of matches) {
      var domain = m[1].toLowerCase();
      if (domain && !domain.includes('shopify') && !db.prepare('SELECT 1 FROM scrape_queue WHERE domain=?').get(domain)) {
        addToQueue(domain, 200000);
        added++;
      }
    }
    appsPage++;
    if (appsPage > 100) appsPage = 1;
    console.log('[AppsShopify] ekledi:' + added);
  } catch(e) { console.error('[AppsShopify]', e.message); }
}

// ─── DISCOVERY 4: SHOPIFY APP REVIEWS ────────────────────────────────────────
var reviewsPage = 1;
async function discoverFromAppReviews() {
  try {
    var apps = ['printful', 'klaviyo', 'yotpo', 'recharge', 'judge-me'];
    var appName = apps[reviewsPage % apps.length];
    var r = await fetchUrl('https://apps.shopify.com/' + appName, 15000);
    if (r.status !== 200 || !r.body) { console.log('[Reviews] status:' + r.status); return; }
    var shopPattern = new RegExp('([a-zA-Z0-9][a-zA-Z0-9\\-]*\\.myshopify\\.com)', 'g');
    var matches = r.body.matchAll(shopPattern);
    var added = 0;
    for (var m of matches) {
      var shopDomain = m[1].toLowerCase();
      if (shopDomain && !db.prepare('SELECT 1 FROM scrape_queue WHERE domain=?').get(shopDomain)) {
        addToQueue(shopDomain, 400000);
        added++;
      }
    }
    reviewsPage++;
    console.log('[Reviews] ekledi:' + added);
  } catch(e) { console.error('[Reviews]', e.message); }
}

// ─── DISCOVERY 5: COMMON CRAWL (ÜCRETSİZ - EN BÜYÜK KAYNAK) ─────────────────
// Common Crawl her ay milyarlarca URL indeksliyor, Shopify domainleri filtreleyebiliriz
var commonCrawlIndex = 0;
var COMMON_CRAWL_IDS = [
  'CC-MAIN-2024-51', 'CC-MAIN-2024-46', 'CC-MAIN-2024-42',
  'CC-MAIN-2024-38', 'CC-MAIN-2024-33', 'CC-MAIN-2024-26'
];

async function discoverFromCommonCrawl() {
  try {
    var crawlId = COMMON_CRAWL_IDS[commonCrawlIndex % COMMON_CRAWL_IDS.length];
    // Common Crawl CDX API - cdn.shopify.com içeren URL'leri sorgula
    var cdxUrl = 'https://index.commoncrawl.org/' + crawlId + '-index?url=*.myshopify.com&output=json&limit=100&fl=url';
    var r = await fetchUrl(cdxUrl, 30000);
    if (r.status !== 200 || !r.body) {
      console.log('[CommonCrawl] status:' + r.status);
      return;
    }
    var lines = r.body.trim().split('\n');
    var added = 0;
    for (var line of lines) {
      try {
        var obj = JSON.parse(line);
        if (obj.url) {
          var urlMatch = obj.url.match(/https?:\/\/([a-zA-Z0-9\-]+\.myshopify\.com)/);
          if (urlMatch) {
            var domain = urlMatch[1].toLowerCase();
            addToQueue(domain, 600000);
            added++;
          }
        }
      } catch(e) {}
    }
    commonCrawlIndex++;
    console.log('[CommonCrawl] crawl:' + crawlId + ' ekledi:' + added);
  } catch(e) { console.error('[CommonCrawl]', e.message); }
}

// ─── DISCOVERY 6: COMMON CRAWL - CUSTOM DOMAIN SHOPIFY ───────────────────────
// cdn.shopify.com referans veren custom domain'leri bul
async function discoverFromCommonCrawlCustom() {
  try {
    var crawlId = COMMON_CRAWL_IDS[commonCrawlIndex % COMMON_CRAWL_IDS.length];
    // cdn.shopify.com'u link veren sayfalar = Shopify custom domain'leri
    var cdxUrl = 'https://index.commoncrawl.org/' + crawlId + '-index?url=cdn.shopify.com*&output=json&limit=200&fl=url';
    var r = await fetchUrl(cdxUrl, 30000);
    if (r.status !== 200 || !r.body) return;
    var lines = r.body.trim().split('\n');
    var added = 0;
    for (var line of lines) {
      try {
        var obj = JSON.parse(line);
        // referrer domain'i al
        if (obj.url) {
          var urlM = obj.url.match(/https?:\/\/([a-zA-Z0-9\-\.]+)/);
          if (urlM) {
            var domain = urlM[1].toLowerCase();
            if (!domain.includes('shopify') && !domain.includes('cdn')) {
              addToQueue(domain, 550000);
              added++;
            }
          }
        }
      } catch(e) {}
    }
    console.log('[CommonCrawl-Custom] ekledi:' + added);
  } catch(e) { console.error('[CommonCrawl-Custom]', e.message); }
}

// ─── DISCOVERY 7: HACKERTARGET - ÜCRETSİZ IP/HOST LOOKUP ────────────────────
// Shopify IP bloklarında host edilen domainleri bul
var shopifyIPs = [
  '23.227.38.32', '23.227.38.33', '23.227.38.34', '23.227.38.35',
  '23.227.38.36', '23.227.38.37', '23.227.38.38', '23.227.38.39',
  '23.227.38.40', '23.227.38.41', '23.227.38.42', '23.227.38.43',
  '23.227.38.44', '23.227.38.45', '23.227.38.46', '23.227.38.47',
  '23.227.38.48', '23.227.38.49', '23.227.38.50', '23.227.38.51',
  '23.227.38.52', '23.227.38.53', '23.227.38.54', '23.227.38.55',
  '23.227.38.56', '23.227.38.57', '23.227.38.58', '23.227.38.59',
  '23.227.38.60', '23.227.38.61', '23.227.38.62', '23.227.38.63'
];
var hackerTargetIPIndex = 0;

async function discoverFromHackerTarget() {
  try {
    var ip = shopifyIPs[hackerTargetIPIndex % shopifyIPs.length];
    // HackerTarget ücretsiz reverse IP lookup (günde 100 istek ücretsiz)
    var r = await fetchUrl('https://api.hackertarget.com/reverseiplookup/?q=' + ip, 15000);
    if (r.status !== 200 || !r.body || r.body.includes('error') || r.body.includes('API count exceeded')) {
      console.log('[HackerTarget] limit veya hata:' + r.body.substring(0, 50));
      return;
    }
    var domains = r.body.trim().split('\n');
    var added = 0;
    for (var domain of domains) {
      domain = domain.trim().toLowerCase();
      if (domain && domain.includes('.') && !domain.includes('shopify')) {
        addToQueue(domain, 400000);
        added++;
      }
    }
    hackerTargetIPIndex++;
    console.log('[HackerTarget] ip:' + ip + ' ekledi:' + added);
  } catch(e) { console.error('[HackerTarget]', e.message); }
}

// ─── DISCOVERY 8: GITHUB SEARCH - SHOPIFY THEME DOSYALARI ───────────────────
// GitHub'da config.yml içinde shop_url olan Shopify projelerini bul
// NOT: GITHUB_TOKEN env variable gerekli (ücretsiz, rate limit yüksek)
var githubPage = 1;
async function discoverFromGitHub() {
  try {
    var token = process.env.GITHUB_TOKEN;
    if (!token) { console.log('[GitHub] GITHUB_TOKEN yok, atlanıyor'); return; }

    var searchUrl = 'https://api.github.com/search/code?q=cdn.shopify.com+in:file&per_page=30&page=' + githubPage;
    var r = await fetchUrl(searchUrl + '&t=' + Date.now(), 15000);
    
    // GitHub API auth header eklemek için özel fetch gerekiyor
    // Bu yüzden node https ile manual header ekliyoruz
    var result = await new Promise(function(resolve, reject) {
      var u = new URL(searchUrl);
      var req = https.request({
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          'User-Agent': 'ShopFind-Bot',
          'Authorization': 'token ' + token,
          'Accept': 'application/vnd.github.v3+json'
        },
        agent: insecureAgent,
        timeout: 15000
      }, function(response) {
        var data = '';
        response.on('data', function(c) { data += c; });
        response.on('end', function() { resolve({ status: response.statusCode, body: data }); });
      });
      req.on('error', reject);
      req.on('timeout', function() { req.destroy(); reject(new Error('timeout')); });
      req.end();
    });

    if (result.status !== 200) {
      console.log('[GitHub] status:' + result.status);
      return;
    }

    var json = JSON.parse(result.body);
    var added = 0;
    if (json.items) {
      for (var item of json.items) {
        // repo description veya homepage'den domain çıkar
        if (item.repository && item.repository.homepage) {
          var homeM = item.repository.homepage.match(/https?:\/\/([a-zA-Z0-9\-\.]+)/);
          if (homeM) {
            var domain = homeM[1].toLowerCase();
            if (!domain.includes('github') && !domain.includes('shopify')) {
              addToQueue(domain, 250000);
              added++;
            }
          }
        }
        // dosya içeriğindeki URL'leri bul
        if (item.html_url) {
          var rawUrl = item.html_url
            .replace('github.com', 'raw.githubusercontent.com')
            .replace('/blob/', '/');
          try {
            var fileR = await fetchUrl(rawUrl, 8000);
            if (fileR.status === 200 && fileR.body) {
              var shopPattern = new RegExp('([a-zA-Z0-9\\-]+\\.myshopify\\.com)', 'g');
              var fileMatches = fileR.body.matchAll(shopPattern);
              for (var fm of fileMatches) {
                addToQueue(fm[1].toLowerCase(), 300000);
                added++;
              }
            }
          } catch(e) {}
        }
      }
    }
    githubPage++;
    if (githubPage > 34) githubPage = 1; // GitHub max 1000 sonuç = 34 sayfa
    console.log('[GitHub] sayfa:' + githubPage + ' ekledi:' + added);
  } catch(e) { console.error('[GitHub]', e.message); }
}

// ─── DISCOVERY 9: URLSCAN.IO - ÜCRETSİZ ─────────────────────────────────────
// urlscan.io Shopify sitelerini tarıyor, ücretsiz API var
var urlscanPage = 0;
async function discoverFromUrlScan() {
  try {
    var searchAfter = urlscanPage > 0 ? '&search_after=' + urlscanPage : '';
    var r = await fetchUrl('https://urlscan.io/api/v1/search/?q=page.domain:myshopify.com&size=100' + searchAfter, 20000);
    if (r.status !== 200 || !r.body) {
      console.log('[UrlScan] status:' + r.status);
      return;
    }
    var json = JSON.parse(r.body);
    var added = 0;
    if (json.results) {
      for (var result of json.results) {
        if (result.page && result.page.domain) {
          var domain = result.page.domain.toLowerCase();
          addToQueue(domain, 350000);
          added++;
        }
        // custom domain kontrolü
        if (result.page && result.page.ptr) {
          var ptrDomain = result.page.ptr.toLowerCase();
          if (!ptrDomain.includes('shopify') && !ptrDomain.includes('amazonaws')) {
            addToQueue(ptrDomain, 350000);
            added++;
          }
        }
      }
      // sonraki sayfa için cursor
      if (json.results.length > 0) {
        urlscanPage = Date.now(); // basit pagination
      }
    }
    console.log('[UrlScan] ekledi:' + added);
  } catch(e) { console.error('[UrlScan]', e.message); }
}

// ─── DISCOVERY 10: CERTSPOTTER / CRTSH - SSL SERTİFİKA LOGları ──────────────
// crt.sh ücretsiz SSL sertifika loglarından Shopify domain'leri bul
async function discoverFromCrtSh() {
  try {
    // myshopify.com alt domainlerini sertifika loglarından çek
    var r = await fetchUrl('https://crt.sh/?q=%.myshopify.com&output=json', 30000);
    if (r.status !== 200 || !r.body) {
      console.log('[crt.sh] status:' + r.status);
      return;
    }
    var json = JSON.parse(r.body);
    var added = 0;
    var seen = new Set();
    for (var cert of json) {
      if (cert.name_value) {
        var domains = cert.name_value.split('\n');
        for (var domain of domains) {
          domain = domain.trim().toLowerCase().replace('*.', '');
          if (domain.includes('myshopify.com') && !seen.has(domain)) {
            seen.add(domain);
            addToQueue(domain, 450000);
            added++;
          }
        }
      }
    }
    console.log('[crt.sh] ekledi:' + added);
  } catch(e) { console.error('[crt.sh]', e.message); }
}

// ─── DISCOVERY 11: SITEHUNT / PUBLICWWW ALTERNATİFİ - COMMONCRAWL WAT ───────
// Common Crawl WAT dosyaları link grafiği içeriyor
var watFileIndex = 0;
async function discoverFromCommonCrawlWAT() {
  try {
    // WAT dosya listesini çek
    var crawlId = COMMON_CRAWL_IDS[0];
    var watListUrl = 'https://data.commoncrawl.org/crawl-data/' + crawlId + '/wat.paths.gz';
    // WAT dosyaları çok büyük, bunun yerine CDX API kullan
    var cdxUrl = 'https://index.commoncrawl.org/' + crawlId + '-index?url=*.com&output=json&limit=500&fl=url,mime&filter=mime:text/html&filter=url:*shopify*';
    var r = await fetchUrl(cdxUrl, 30000);
    if (r.status !== 200 || !r.body) return;
    var lines = r.body.trim().split('\n');
    var added = 0;
    for (var line of lines) {
      try {
        var obj = JSON.parse(line);
        if (obj.url) {
          var urlM = obj.url.match(/https?:\/\/([a-zA-Z0-9\-\.]+)/);
          if (urlM) {
            var domain = urlM[1].toLowerCase();
            if (!domain.includes('cdn') && !domain.startsWith('www.shopify')) {
              addToQueue(domain, 500000);
              added++;
            }
          }
        }
      } catch(e) {}
    }
    watFileIndex++;
    console.log('[CommonCrawl-WAT] ekledi:' + added);
  } catch(e) { console.error('[CommonCrawl-WAT]', e.message); }
}

// ─── QUEUE PROCESSOR ─────────────────────────────────────────────────────────
var isScraping = false;
async function processQueue() {
  if (isScraping) return;
  isScraping = true;
  try {
    var item = db.prepare("SELECT * FROM scrape_queue WHERE status='pending' ORDER BY majestic_rank ASC LIMIT 1").get();
    if (item) {
      db.prepare("UPDATE scrape_queue SET status='processing' WHERE id=?").run(item.id);
      var data = await scrapeShopify(item.domain, item.majestic_rank);
      if (data) {
        saveStore(data);
        db.prepare("UPDATE scrape_queue SET status='done' WHERE id=?").run(item.id);
        console.log('[Queue] OK:' + item.domain);
      } else {
        db.prepare("UPDATE scrape_queue SET status='not_shopify' WHERE id=?").run(item.id);
      }
    }
  } catch(e) { console.error('[Queue]', e.message); }
  isScraping = false;
}

// ─── SEEDS ────────────────────────────────────────────────────────────────────
var SEEDS = [
  'gymshark.com','fashionnova.com','allbirds.com','bombas.com','glossier.com',
  'colourpop.com','ruggable.com','brooklinen.com','casper.com','ritual.com',
  'mvmt.com','warbyparker.com','away.com','nativecos.com','puravidabracelets.com',
  'meundies.com','tuftandneedle.com','leesa.com','hexclad.com','ourplace.com',
  'caraway.com','barkbox.com','ugmonk.com','diff.com','quay.com',
  'kyliecosmetics.com','morphe.com','princesspolly.com','cider.com','adore-me.com',
  'peak-design.com','drinkag1.com','hims.com','athletic-greens.com','parachutehome.com',
  'boohoo.com','prettylittlething.com','revolve.com','fentybeauty.com','chewy.com',
  'taylorstitch.com','cotopaxi.com','vuori.com','rothys.com','kotn.com',
  'outerknown.com','everlane.com','tentree.com','skims.com','fenty.com'
];

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/health', function(req, res) {
  var total = db.prepare('SELECT COUNT(*) as n FROM stores').get().n;
  var pending = db.prepare("SELECT COUNT(*) as n FROM scrape_queue WHERE status='pending'").get().n;
  var done = db.prepare("SELECT COUNT(*) as n FROM scrape_queue WHERE status='done'").get().n;
  res.json({ status: 'ok', stores: total, pending: pending, done: done, shopifyId: shopifyId });
});

// ─── MANUAL TRIGGER ROUTES ────────────────────────────────────────────────────
app.post('/api/discover/commoncrawl', auth, async function(req, res) {
  discoverFromCommonCrawl();
  discoverFromCommonCrawlCustom();
  res.json({ message: 'Common Crawl discovery başlatıldı' });
});

app.post('/api/discover/crtsh', auth, async function(req, res) {
  discoverFromCrtSh();
  res.json({ message: 'crt.sh discovery başlatıldı' });
});

app.post('/api/discover/urlscan', auth, async function(req, res) {
  discoverFromUrlScan();
  res.json({ message: 'urlscan.io discovery başlatıldı' });
});

app.post('/api/discover/hackertarget', auth, async function(req, res) {
  discoverFromHackerTarget();
  res.json({ message: 'HackerTarget discovery başlatıldı' });
});

// ─── SERVER START ─────────────────────────────────────────────────────────────
app.listen(PORT, function() {
  console.log('ShopFind API port ' + PORT + ' üzerinde çalışıyor');

  // Seed'leri yükle
  setTimeout(function() {
    var stmt = db.prepare('INSERT OR IGNORE INTO scrape_queue (domain, status, majestic_rank, added_at) VALUES (?, ?, ?, ?)');
    for (var d of SEEDS) stmt.run(d, 'pending', 999999999, new Date().toISOString());
    console.log('Seed kuyruğa eklendi');
  }, 1000);

  // ── Queue processor: her 3sn ──
  setInterval(processQueue, 3000);

  // ── Eski discovery'ler ──
  setInterval(discoverFromShopifyId, 30000);
  setTimeout(discoverFromShopifyId, 10000);
  setInterval(discoverFromMyip, 45000);
  setTimeout(discoverFromMyip, 15000);
  setInterval(discoverFromAppsShopify, 60000);
  setTimeout(discoverFromAppsShopify, 20000);
  setInterval(discoverFromAppReviews, 50000);
  setTimeout(discoverFromAppReviews, 25000);

  // ── YENİ: Common Crawl (her 10dk, büyük veri kaynağı) ──
  setTimeout(discoverFromCommonCrawl, 5000);
  setInterval(discoverFromCommonCrawl, 600000);
  setTimeout(discoverFromCommonCrawlCustom, 8000);
  setInterval(discoverFromCommonCrawlCustom, 600000);

  // ── YENİ: crt.sh SSL sertifika logları (her 30dk) ──
  setTimeout(discoverFromCrtSh, 12000);
  setInterval(discoverFromCrtSh, 1800000);

  // ── YENİ: urlscan.io (her 20dk) ──
  setTimeout(discoverFromUrlScan, 18000);
  setInterval(discoverFromUrlScan, 1200000);

  // ── YENİ: HackerTarget reverse IP (her 15dk, günlük limit var) ──
  setTimeout(discoverFromHackerTarget, 22000);
  setInterval(discoverFromHackerTarget, 900000);

  // ── YENİ: GitHub (GITHUB_TOKEN varsa aktif olur, her 30dk) ──
  setTimeout(discoverFromGitHub, 30000);
  setInterval(discoverFromGitHub, 1800000);

  // ── YENİ: Common Crawl WAT (her 15dk) ──
  setTimeout(discoverFromCommonCrawlWAT, 35000);
  setInterval(discoverFromCommonCrawlWAT, 900000);
});

module.exports = app;
