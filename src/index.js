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

var DB_PATH = process.env.DB_PATH || '/data/v4.db';
var dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  try { fs.mkdirSync(dbDir, { recursive: true }); } catch(e) {}
}

var db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, created_at TEXT)');
db.exec('CREATE TABLE IF NOT EXISTS stores (id TEXT PRIMARY KEY, domain TEXT UNIQUE NOT NULL, name TEXT, product_count INTEGER DEFAULT 0, country TEXT, currency TEXT, language TEXT, majestic_rank INTEGER DEFAULT 999999999, theme_name TEXT, founded_year INTEGER, scraped_at TEXT)');
db.exec('CREATE TABLE IF NOT EXISTS scrape_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT UNIQUE NOT NULL, status TEXT, majestic_rank INTEGER DEFAULT 999999999, added_at TEXT)');
db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');

try { db.exec('ALTER TABLE stores ADD COLUMN theme_name TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE stores ADD COLUMN founded_year INTEGER'); } catch(e) {}

var shopifyIdRow = db.prepare("SELECT value FROM settings WHERE key='shopifyId'").get();
var shopifyId = shopifyIdRow ? parseInt(shopifyIdRow.value) : 1;
console.log('[ShopifyID] Kaldığı yerden devam: ' + shopifyId);

function saveShopifyId() {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('shopifyId', ?)").run(String(shopifyId));
}

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
app.get('/api/auth/me', auth, function(req, res) {
  res.json({ user: { id: req.user.id, email: req.user.email } });
});

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
  var theme = req.query.theme || null;
  var country = req.query.country || null;
  var tld = req.query.tld || null;
  var currency = req.query.currency || null;
  var language = req.query.language || null;
  var search = req.query.search || null;
  var minProducts = req.query.min_products ? parseInt(req.query.min_products) : null;
  var maxProducts = req.query.max_products ? parseInt(req.query.max_products) : null;
  var yearFrom = req.query.year_from ? parseInt(req.query.year_from) : null;
  var yearTo = req.query.year_to ? parseInt(req.query.year_to) : null;
  var sort = req.query.sort || 'majestic_rank';
  var order = req.query.order === 'desc' ? 'DESC' : 'ASC';

  var validSorts = { 'majestic_rank': 'majestic_rank', 'founded': 'founded_year', 'name': 'name', 'products': 'product_count' };
  var sortCol = validSorts[sort] || 'majestic_rank';
  var nullsLast = (sortCol === 'founded_year' || sortCol === 'product_count') ? ' NULLS LAST' : '';

  var conditions = [], params = [];

  if (theme) {
    var themes = theme.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t.length > 0; });
    if (themes.length === 1) {
      conditions.push('LOWER(theme_name) LIKE ?');
      params.push('%' + themes[0].toLowerCase() + '%');
    } else {
      var themeConds = themes.map(function() { return 'LOWER(theme_name) LIKE ?'; });
      conditions.push('(' + themeConds.join(' OR ') + ')');
      for (var ti = 0; ti < themes.length; ti++) { params.push('%' + themes[ti].toLowerCase() + '%'); }
    }
  }

  if (country) { conditions.push('UPPER(country) = ?'); params.push(country.toUpperCase()); }
  if (tld) { conditions.push("LOWER(domain) LIKE ?"); params.push('%.' + tld.replace(/^\./, '').toLowerCase()); }
  if (currency) { conditions.push('UPPER(currency) = ?'); params.push(currency.toUpperCase()); }
  if (language) { conditions.push('LOWER(language) LIKE ?'); params.push(language.toLowerCase() + '%'); }
  if (search) { conditions.push('(LOWER(name) LIKE ? OR LOWER(domain) LIKE ?)'); params.push('%' + search.toLowerCase() + '%'); params.push('%' + search.toLowerCase() + '%'); }
  if (minProducts !== null) { conditions.push('product_count >= ?'); params.push(minProducts); }
  if (maxProducts !== null) { conditions.push('product_count <= ?'); params.push(maxProducts); }
  if (yearFrom !== null) { conditions.push('founded_year >= ?'); params.push(yearFrom); }
  if (yearTo !== null) { conditions.push('founded_year <= ?'); params.push(yearTo); }

  var where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  var stores = db.prepare('SELECT * FROM stores ' + where + ' ORDER BY ' + sortCol + ' ' + order + nullsLast + ' LIMIT 50 OFFSET ?').all(...params, offset);
  var total = db.prepare('SELECT COUNT(*) as n FROM stores ' + where).get(...params).n;
  var totalAll = db.prepare('SELECT COUNT(*) as n FROM stores').get().n;
  res.json({ stores: stores, total: total, totalAll: totalAll, page: page });
});

app.get('/api/themes', auth, function(req, res) {
  var themes = db.prepare('SELECT theme_name, COUNT(*) as count FROM stores WHERE theme_name IS NOT NULL GROUP BY theme_name ORDER BY count DESC LIMIT 100').all();
  res.json({ themes: themes });
});

app.get('/api/countries', auth, function(req, res) {
  var countries = db.prepare('SELECT country, COUNT(*) as count FROM stores WHERE country IS NOT NULL GROUP BY country ORDER BY count DESC').all();
  res.json({ countries: countries });
});

app.get('/api/tlds', auth, function(req, res) {
  var stores = db.prepare('SELECT domain FROM stores').all();
  var tldMap = {};
  for (var s of stores) {
    var parts = s.domain.split('.');
    if (parts.length >= 2) {
      var tld = parts[parts.length - 1].toLowerCase();
      tldMap[tld] = (tldMap[tld] || 0) + 1;
    }
  }
  var tlds = Object.entries(tldMap).map(function(e) { return { tld: e[0], count: e[1] }; });
  tlds.sort(function(a, b) { return b.count - a.count; });
  res.json({ tlds: tlds });
});

app.get('/api/currencies', auth, function(req, res) {
  var currencies = db.prepare('SELECT currency, COUNT(*) as count FROM stores WHERE currency IS NOT NULL GROUP BY currency ORDER BY count DESC').all();
  res.json({ currencies: currencies });
});

app.get('/api/languages', auth, function(req, res) {
  var languages = db.prepare('SELECT language, COUNT(*) as count FROM stores WHERE language IS NOT NULL GROUP BY language ORDER BY count DESC LIMIT 50').all();
  res.json({ languages: languages });
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

function fetchWithHeaders(url, headers, timeout) {
  return new Promise(function(resolve, reject) {
    try {
      var u = new URL(url);
      var req = https.request({
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'GET',
        agent: insecureAgent,
        headers: headers || {},
        timeout: timeout || 15000
      }, function(response) {
        var data = '';
        response.on('data', function(c) { data += c; });
        response.on('end', function() { resolve({ status: response.statusCode, body: data }); });
      });
      req.on('error', reject);
      req.on('timeout', function() { req.destroy(); reject(new Error('timeout')); });
      req.end();
    } catch(e) { reject(e); }
  });
}

// ─── WAYBACK MACHINE ─────────────────────────────────────────────────────────
async function getFoundedYear(domain) {
  try {
    var r = await fetchUrl('https://archive.org/wayback/available?url=' + domain + '&timestamp=20050101', 10000);
    if (r.status !== 200 || !r.body) return null;
    var json = JSON.parse(r.body);
    if (json.archived_snapshots && json.archived_snapshots.closest && json.archived_snapshots.closest.timestamp) {
      return parseInt(json.archived_snapshots.closest.timestamp.substring(0, 4));
    }
    var r2 = await fetchUrl('https://archive.org/wayback/available?url=' + domain, 10000);
    if (r2.status !== 200 || !r2.body) return null;
    var json2 = JSON.parse(r2.body);
    if (json2.archived_snapshots && json2.archived_snapshots.closest && json2.archived_snapshots.closest.timestamp) {
      return parseInt(json2.archived_snapshots.closest.timestamp.substring(0, 4));
    }
    return null;
  } catch(e) { return null; }
}

// ─── ÜLKE TESPİT ─────────────────────────────────────────────────────────────
var TLD_COUNTRY_MAP = {
  'uk': 'GB', 'co.uk': 'GB', 'org.uk': 'GB', 'me.uk': 'GB',
  'de': 'DE', 'at': 'AT', 'ch': 'CH', 'fr': 'FR', 'be': 'BE', 'lu': 'LU',
  'nl': 'NL', 'es': 'ES', 'it': 'IT', 'pt': 'PT', 'pl': 'PL', 'cz': 'CZ',
  'sk': 'SK', 'hu': 'HU', 'ro': 'RO', 'bg': 'BG', 'hr': 'HR', 'si': 'SI',
  'dk': 'DK', 'se': 'SE', 'no': 'NO', 'fi': 'FI', 'gr': 'GR', 'ie': 'IE',
  'com.au': 'AU', 'net.au': 'AU', 'org.au': 'AU', 'co.nz': 'NZ', 'nz': 'NZ',
  'ca': 'CA', 'co.za': 'ZA', 'za': 'ZA', 'co.ke': 'KE', 'ke': 'KE',
  'co.ng': 'NG', 'ng': 'NG', 'co.in': 'IN', 'in': 'IN',
  'co.jp': 'JP', 'jp': 'JP', 'co.kr': 'KR', 'kr': 'KR',
  'com.sg': 'SG', 'sg': 'SG', 'com.hk': 'HK', 'hk': 'HK',
  'com.tw': 'TW', 'tw': 'TW', 'com.my': 'MY', 'my': 'MY',
  'co.id': 'ID', 'id': 'ID', 'com.ph': 'PH', 'ph': 'PH',
  'com.vn': 'VN', 'vn': 'VN', 'com.br': 'BR', 'net.br': 'BR',
  'com.mx': 'MX', 'mx': 'MX', 'com.ar': 'AR', 'ar': 'AR',
  'com.pe': 'PE', 'pe': 'PE', 'com.cl': 'CL', 'cl': 'CL',
  'ae': 'AE', 'com.ae': 'AE', 'sa': 'SA', 'com.sa': 'SA',
  'eg': 'EG', 'com.eg': 'EG', 'ma': 'MA', 'tn': 'TN', 'dz': 'DZ',
  'ru': 'RU', 'ua': 'UA', 'by': 'BY', 'kz': 'KZ', 'uz': 'UZ',
  'tr': 'TR', 'com.tr': 'TR', 'il': 'IL', 'co.il': 'IL',
  'pk': 'PK', 'com.pk': 'PK', 'lk': 'LK', 'bd': 'BD', 'cn': 'CN', 'com.cn': 'CN',
};

function getCountryFromDomain(domain) {
  var parts = domain.split('.');
  if (parts.length >= 3) { var two = parts[parts.length-2]+'.'+parts[parts.length-1]; if (TLD_COUNTRY_MAP[two]) return TLD_COUNTRY_MAP[two]; }
  var one = parts[parts.length-1]; if (TLD_COUNTRY_MAP[one]) return TLD_COUNTRY_MAP[one];
  return null;
}

var CURRENCY_COUNTRY_MAP = {
  'GBP':'GB','AUD':'AU','CAD':'CA','NZD':'NZ','SEK':'SE','NOK':'NO','DKK':'DK','CHF':'CH',
  'JPY':'JP','KRW':'KR','SGD':'SG','HKD':'HK','TWD':'TW','MYR':'MY','IDR':'ID','PHP':'PH',
  'THB':'TH','VND':'VN','INR':'IN','PKR':'PK','BRL':'BR','MXN':'MX','ARS':'AR','CLP':'CL',
  'COP':'CO','PEN':'PE','ZAR':'ZA','KES':'KE','NGN':'NG','EGP':'EG','MAD':'MA','AED':'AE',
  'SAR':'SA','ILS':'IL','TRY':'TR','RUB':'RU','UAH':'UA','PLN':'PL','CZK':'CZ','HUF':'HU',
  'RON':'RO','BGN':'BG','HRK':'HR','DZD':'DZ','BDT':'BD','LKR':'LK','CNY':'CN','KZT':'KZ',
};

function getCountryFromCurrency(currency) {
  if (!currency) return null;
  return CURRENCY_COUNTRY_MAP[currency.toUpperCase()] || null;
}

var LANG_COUNTRY_MAP = {
  'de':'DE','de-at':'AT','de-ch':'CH','fr':'FR','fr-be':'BE','nl':'NL','nl-be':'BE',
  'es':'ES','es-mx':'MX','es-ar':'AR','pt':'PT','pt-br':'BR','it':'IT','sv':'SE',
  'no':'NO','nb':'NO','da':'DK','fi':'FI','pl':'PL','cs':'CZ','sk':'SK','hu':'HU',
  'ro':'RO','el':'GR','ru':'RU','uk':'UA','tr':'TR','ar':'AE','ar-ae':'AE',
  'ar-sa':'SA','he':'IL','ja':'JP','ko':'KR','zh':'CN','zh-cn':'CN','zh-tw':'TW',
  'th':'TH','vi':'VN','id':'ID','ms':'MY',
};

function getCountryFromLanguage(lang) {
  if (!lang) return null;
  return LANG_COUNTRY_MAP[lang.toLowerCase()] || null;
}

async function getCountryFromIP(domain) {
  try {
    var r = await fetchUrl('https://ip-api.com/json/' + domain + '?fields=countryCode', 5000);
    if (r.status !== 200 || !r.body) return null;
    var json = JSON.parse(r.body);
    if (json.countryCode && json.countryCode.length === 2 && json.countryCode !== 'XX') return json.countryCode;
    return null;
  } catch(e) { return null; }
}

// ─── SCRAPE SHOPIFY ───────────────────────────────────────────────────────────
async function scrapeShopify(domain, rank) {
  var result = { domain:domain, name:domain.split('.')[0], product_count:0, majestic_rank:rank||999999999, theme_name:null, founded_year:null, country:null, currency:null, language:null };
  try {
    var pr = await fetchUrl('https://'+domain+'/products.json?limit=10', 10000);
    if (pr.status !== 200) return null;
    try { var pj = JSON.parse(pr.body); if (!pj.products) return null; result.product_count = pj.products.length; } catch(e) { return null; }
    var hr = await fetchUrl('https://'+domain, 10000);
    if (hr.status !== 200 || !hr.body) return null;
    if (!hr.body.includes('cdn.shopify') && !hr.body.includes('Shopify.theme') && !hr.body.includes('shopify')) return null;
    var b = hr.body;
    var titleM = b.match(/<title[^>]*>([^<]+)<\/title>/i); if (titleM) result.name = titleM[1].split(/[|\-\u2013]/)[0].trim().substring(0,100);
    var curM = b.match(/"currency"\s*:\s*"([A-Z]{3})"/); if (!curM) curM = b.match(/Shopify\.currency\s*=\s*['"]{0,1}([A-Z]{3})['"]{0,1}/); if (curM) result.currency = curM[1];
    var langM = b.match(/<html[^>]+lang="([^"]+)"/i); if (langM) result.language = langM[1].toLowerCase();
    var countryM = b.match(/"country_code"\s*:\s*"([A-Z]{2})"/); if (countryM) result.country = countryM[1];
    if (!result.country) { var m2 = b.match(/Shopify\.country\s*=\s*['"]([^'"]+)['"]/); if (m2) result.country = m2[1].toUpperCase().substring(0,2); }
    if (!result.country) { var m3 = b.match(/window\.Shopify\s*=\s*\{[^}]*["']country["']\s*:\s*["']([^"']{2})["']/i); if (m3) result.country = m3[1].toUpperCase(); }
    if (!result.country) { var m4 = b.match(/<meta[^>]+name=['"]country['"][^>]+content=['"]([^'"]+)['"]/i); if (m4) result.country = m4[1].toUpperCase().substring(0,2); }
    if (!result.country) { var m5 = b.match(/<meta[^>]+property=['"]og:locale['"][^>]+content=['"]([^'"]+)['"]/i); if (m5) { var lp = m5[1].split('_'); if (lp.length>=2) result.country = lp[1].toUpperCase().substring(0,2); } }
    if (!result.country) { var m6 = b.match(/hreflang=['"]([a-z]{2}-[A-Z]{2})['"]/); if (m6) { var hp = m6[1].split('-'); if (hp.length>=2) result.country = hp[1].toUpperCase(); } }
    if (!result.country) { var jldP = new RegExp('<script[^>]+type=[\'"]application\\/ld\\+json[\'"][^>]*>([\\s\\S]*?)<\\/script>','gi'); var jldM = b.matchAll(jldP); for (var jld of jldM) { try { var j = JSON.parse(jld[1]); if (j.address&&j.address.addressCountry) { result.country = j.address.addressCountry.toUpperCase().substring(0,2); break; } } catch(e) {} } }
    if (!result.country && hr.headers && hr.headers['cf-ipcountry']) { var cf = hr.headers['cf-ipcountry']; if (cf&&cf.length===2&&cf!=='XX') result.country = cf.toUpperCase(); }
    if (!result.country) result.country = getCountryFromDomain(domain);
    if (!result.country && result.currency) result.country = getCountryFromCurrency(result.currency);
    if (!result.country && result.language) result.country = getCountryFromLanguage(result.language);
    if (!result.country) result.country = await getCountryFromIP(domain);
    var themeM = b.match(/Shopify\.theme\s*=\s*\{[^}]*"name"\s*:\s*"([^"]+)"/); if (themeM) result.theme_name = themeM[1].trim();
    if (!result.theme_name) { var tm2 = b.match(/"theme_store_id"[\s\S]{0,100}"name"\s*:\s*"([^"]+)"/); if (tm2) result.theme_name = tm2[1].trim(); }
    if (!result.theme_name) { var tm3 = b.match(/cdn\.shopify\.com\/s\/files\/[^"']+\/assets\/([a-zA-Z0-9_\-]+)\.css/); if (tm3) result.theme_name = tm3[1].replace(/[-_]/g,' '); }
    if (!result.theme_name) { var tm4 = b.match(/window\.theme\s*=\s*\{[^}]*name\s*:\s*['"]([^'"]+)['"]/); if (tm4) result.theme_name = tm4[1].trim(); }
    if (result.theme_name) result.theme_name = result.theme_name.substring(0,100);
    result.founded_year = await getFoundedYear(domain);
  } catch(e) { return null; }
  return result;
}

// ─── SAVE STORE ───────────────────────────────────────────────────────────────
function saveStore(s) {
  if (!s) return;
  try {
    var existing = db.prepare('SELECT id FROM stores WHERE domain = ?').get(s.domain);
    if (existing) {
      db.prepare('UPDATE stores SET name=?, product_count=?, country=?, currency=?, language=?, majestic_rank=?, theme_name=?, founded_year=?, scraped_at=? WHERE domain=?')
        .run(s.name, s.product_count, s.country||null, s.currency||null, s.language||null, s.majestic_rank, s.theme_name||null, s.founded_year||null, new Date().toISOString(), s.domain);
    } else {
      db.prepare('INSERT INTO stores (id, domain, name, product_count, country, currency, language, majestic_rank, theme_name, founded_year, scraped_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(crypto.randomUUID(), s.domain, s.name, s.product_count, s.country||null, s.currency||null, s.language||null, s.majestic_rank, s.theme_name||null, s.founded_year||null, new Date().toISOString());
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

// ─── HIZLI ÜLKE ATAMA ────────────────────────────────────────────────────────
async function quickCountryFill() {
  try {
    var stores = db.prepare('SELECT domain, currency, language FROM stores WHERE country IS NULL').all();
    console.log('[QuickCountry] ' + stores.length + ' mağazaya hızlı ülke atanacak');
    var updated = 0;
    for (var store of stores) {
      var country = getCountryFromDomain(store.domain);
      if (!country && store.currency) country = getCountryFromCurrency(store.currency);
      if (!country && store.language) country = getCountryFromLanguage(store.language);
      if (country) { db.prepare('UPDATE stores SET country=? WHERE domain=?').run(country, store.domain); updated++; }
    }
    console.log('[QuickCountry] ' + updated + ' mağazaya ülke atandı');
  } catch(e) { console.error('[QuickCountry]', e.message); }
}

// ─── OTOMATIK RESCAN ─────────────────────────────────────────────────────────
var isRescanning = false;
async function rescanMissingData() {
  if (isRescanning) return;
  isRescanning = true;
  try {
    var stores = db.prepare('SELECT domain, majestic_rank, currency, language FROM stores WHERE theme_name IS NULL OR founded_year IS NULL OR country IS NULL').all();
    if (stores.length === 0) { console.log('[Rescan] Tüm mağazalar güncel'); isRescanning = false; return; }
    console.log('[Rescan] ' + stores.length + ' mağaza yeniden taranacak');
    for (var store of stores) {
      try {
        var row = db.prepare('SELECT theme_name, founded_year, country, currency, language FROM stores WHERE domain=?').get(store.domain);
        var quickCountry = null;
        if (!row.country) { quickCountry = getCountryFromDomain(store.domain); if (!quickCountry && row.currency) quickCountry = getCountryFromCurrency(row.currency); if (!quickCountry && row.language) quickCountry = getCountryFromLanguage(row.language); }
        if (quickCountry && row.theme_name && row.founded_year) { db.prepare('UPDATE stores SET country=? WHERE domain=?').run(quickCountry, store.domain); await new Promise(r => setTimeout(r, 100)); continue; }
        var data = await scrapeShopify(store.domain, store.majestic_rank);
        if (data) {
          var updates = [], vals = [];
          if (!row.theme_name && data.theme_name) { updates.push('theme_name=?'); vals.push(data.theme_name); }
          if (!row.founded_year && data.founded_year) { updates.push('founded_year=?'); vals.push(data.founded_year); }
          if (!row.country && data.country) { updates.push('country=?'); vals.push(data.country); }
          if (!row.currency && data.currency) { updates.push('currency=?'); vals.push(data.currency); }
          if (!row.language && data.language) { updates.push('language=?'); vals.push(data.language); }
          if (updates.length > 0) { vals.push(store.domain); db.prepare('UPDATE stores SET ' + updates.join(',') + ' WHERE domain=?').run(...vals); }
        }
      } catch(e) {}
      await new Promise(r => setTimeout(r, 800));
    }
    console.log('[Rescan] Tamamlandı');
  } catch(e) { console.error('[Rescan]', e.message); }
  isRescanning = false;
}

// ─── DISCOVERY 1: SHOPIFY ID ─────────────────────────────────────────────────
async function discoverFromShopifyId() {
  try {
    for (var i = 0; i < 10; i++) {
      try {
        var r = await fetchUrl('https://checkout.shopify.com/' + shopifyId + '/sandbox/google_analytics_iframe', 8000);
        if (r.status === 200 && r.body) { var domainM = r.body.match(/([a-zA-Z0-9\-]+\.(?:com|net|org|io|co|shop|store|me|info|biz|co\.uk|com\.au))/); if (domainM) addToQueue(domainM[1].toLowerCase(), 500000); }
      } catch(e) {}
      shopifyId++;
    }
    saveShopifyId();
    console.log('[ShopifyID] id:' + shopifyId);
  } catch(e) { console.error('[ShopifyID]', e.message); }
}

// ─── DISCOVERY 2: MYIP.MS ────────────────────────────────────────────────────
async function discoverFromMyip() {
  try {
    var ips = ['23.227.38.32','23.227.38.33','23.227.38.34','23.227.38.35','23.227.38.36'];
    var ip = ips[Math.floor(Math.random() * ips.length)];
    var r = await fetchUrl('https://myip.ms/' + ip + '#ipinfo', 15000);
    if (r.status !== 200 || !r.body) return;
    var hrefPattern = new RegExp('href=["\']https?://(?:www\\.)?([a-zA-Z0-9][a-zA-Z0-9\\-]*\\.[a-zA-Z]{2,})', 'g');
    var matches = r.body.matchAll(hrefPattern);
    var added = 0;
    for (var m of matches) { var domain = m[1].toLowerCase(); if (domain) { addToQueue(domain, 300000); added++; } }
    console.log('[myip.ms] ekledi:' + added);
  } catch(e) { console.error('[myip.ms]', e.message); }
}

// ─── DISCOVERY 3: SHOPIFY APP STORE ─────────────────────────────────────────
var appsPage = 1;
async function discoverFromAppsShopify() {
  try {
    var r = await fetchUrl('https://apps.shopify.com/browse/recommended', 15000);
    if (r.status !== 200 || !r.body) return;
    var hrefPattern = new RegExp('href=["\']https?://(?:www\\.)?([a-zA-Z0-9][a-zA-Z0-9\\-]*\\.[a-zA-Z]{2,})(?:/|["\'])', 'g');
    var matches = r.body.matchAll(hrefPattern);
    var added = 0;
    for (var m of matches) { var domain = m[1].toLowerCase(); if (domain && !domain.includes('shopify')) { addToQueue(domain, 200000); added++; } }
    appsPage++; if (appsPage > 100) appsPage = 1;
    console.log('[AppsShopify] ekledi:' + added);
  } catch(e) { console.error('[AppsShopify]', e.message); }
}

// ─── DISCOVERY 4: APP REVIEWS ────────────────────────────────────────────────
var reviewsPage = 1;
async function discoverFromAppReviews() {
  try {
    var apps = ['printful', 'klaviyo', 'yotpo', 'recharge', 'judge-me'];
    var appName = apps[reviewsPage % apps.length];
    var r = await fetchUrl('https://apps.shopify.com/' + appName, 15000);
    if (r.status !== 200 || !r.body) return;
    var shopPattern = new RegExp('([a-zA-Z0-9][a-zA-Z0-9\\-]*\\.myshopify\\.com)', 'g');
    var matches = r.body.matchAll(shopPattern);
    var added = 0;
    for (var m of matches) { var shopDomain = m[1].toLowerCase(); if (shopDomain) { addToQueue(shopDomain, 400000); added++; } }
    reviewsPage++;
    console.log('[Reviews] ekledi:' + added);
  } catch(e) { console.error('[Reviews]', e.message); }
}

// ─── DISCOVERY 5: COMMON CRAWL ───────────────────────────────────────────────
var commonCrawlIndex = 0;
var COMMON_CRAWL_IDS = ['CC-MAIN-2024-51','CC-MAIN-2024-46','CC-MAIN-2024-42','CC-MAIN-2024-38','CC-MAIN-2024-33','CC-MAIN-2024-26'];

async function discoverFromCommonCrawlCustom() {
  try {
    var crawlId = COMMON_CRAWL_IDS[commonCrawlIndex % COMMON_CRAWL_IDS.length];
    var r = await fetchUrl('https://index.commoncrawl.org/' + crawlId + '-index?url=cdn.shopify.com*&output=json&limit=1000&fl=url', 60000);
    if (r.status !== 200 || !r.body) return;
    var lines = r.body.trim().split('\n');
    var added = 0;
    for (var line of lines) {
      try { var obj = JSON.parse(line); if (obj.url) { var urlM = obj.url.match(/https?:\/\/([a-zA-Z0-9\-\.]+)/); if (urlM) { var domain = urlM[1].toLowerCase(); if (!domain.includes('shopify') && !domain.includes('cdn') && !domain.includes('amazonaws')) { addToQueue(domain, 550000); added++; } } } } catch(e) {}
    }
    commonCrawlIndex++;
    console.log('[CommonCrawl-Custom] ekledi:' + added);
  } catch(e) { console.error('[CommonCrawl-Custom]', e.message); }
}

// ─── DISCOVERY 6: HACKERTARGET ───────────────────────────────────────────────
var shopifyIPs = [
  '23.227.38.32','23.227.38.33','23.227.38.34','23.227.38.35','23.227.38.36','23.227.38.37','23.227.38.38','23.227.38.39',
  '23.227.38.40','23.227.38.41','23.227.38.42','23.227.38.43','23.227.38.44','23.227.38.45','23.227.38.46','23.227.38.47',
  '23.227.38.48','23.227.38.49','23.227.38.50','23.227.38.51','23.227.38.52','23.227.38.53','23.227.38.54','23.227.38.55',
  '23.227.38.56','23.227.38.57','23.227.38.58','23.227.38.59','23.227.38.60','23.227.38.61','23.227.38.62','23.227.38.63'
];
var hackerTargetIPIndex = 0;

async function discoverFromHackerTarget() {
  try {
    var ip = shopifyIPs[hackerTargetIPIndex % shopifyIPs.length];
    var r = await fetchUrl('https://api.hackertarget.com/reverseiplookup/?q=' + ip, 15000);
    if (r.status !== 200 || !r.body || r.body.includes('error') || r.body.includes('API count exceeded')) { console.log('[HackerTarget] limit:' + r.body.substring(0, 50)); return; }
    var domains = r.body.trim().split('\n');
    var added = 0;
    for (var domain of domains) { domain = domain.trim().toLowerCase(); if (domain && domain.includes('.') && !domain.includes('shopify')) { addToQueue(domain, 400000); added++; } }
    hackerTargetIPIndex++;
    console.log('[HackerTarget] ip:' + ip + ' ekledi:' + added);
  } catch(e) { console.error('[HackerTarget]', e.message); }
}

// ─── DISCOVERY 7: GITHUB ─────────────────────────────────────────────────────
var githubPage = 1;
async function discoverFromGitHub() {
  try {
    var token = process.env.GITHUB_TOKEN; if (!token) return;
    var result = await fetchWithHeaders('https://api.github.com/search/code?q=cdn.shopify.com+in:file&per_page=30&page=' + githubPage, { 'User-Agent': 'ShopFind-Bot', 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github.v3+json' }, 15000);
    if (result.status !== 200) return;
    var json = JSON.parse(result.body); var added = 0;
    if (json.items) { for (var item of json.items) { if (item.repository && item.repository.homepage) { var homeM = item.repository.homepage.match(/https?:\/\/([a-zA-Z0-9\-\.]+)/); if (homeM) { var domain = homeM[1].toLowerCase(); if (!domain.includes('github') && !domain.includes('shopify')) { addToQueue(domain, 250000); added++; } } } } }
    githubPage++; if (githubPage > 34) githubPage = 1;
    console.log('[GitHub] ekledi:' + added);
  } catch(e) { console.error('[GitHub]', e.message); }
}

// ─── DISCOVERY 8: GITHUB SHRINE ──────────────────────────────────────────────
var githubShrinePage = 1;
async function discoverFromGitHubShrine() {
  try {
    var token = process.env.GITHUB_TOKEN; if (!token) return;
    var queries = ['Shopify.theme.name+shrine+in:file', '"theme_name"+shrine+shopify+in:file', 'shrine+cdn.shopify.com+in:file'];
    var query = queries[githubShrinePage % queries.length];
    var result = await fetchWithHeaders('https://api.github.com/search/code?q=' + query + '&per_page=30&page=' + githubShrinePage, { 'User-Agent': 'ShopFind-Bot', 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github.v3+json' }, 15000);
    if (result.status !== 200) return;
    var json = JSON.parse(result.body); var added = 0;
    if (json.items) { for (var item of json.items) { if (item.repository && item.repository.homepage) { var homeM = item.repository.homepage.match(/https?:\/\/([a-zA-Z0-9\-\.]+)/); if (homeM) { var domain = homeM[1].toLowerCase(); if (!domain.includes('github') && !domain.includes('shopify')) { addToQueue(domain, 100000); added++; } } } } }
    githubShrinePage++; if (githubShrinePage > 34) githubShrinePage = 1;
    console.log('[GitHub-Shrine] ekledi:' + added);
  } catch(e) { console.error('[GitHub-Shrine]', e.message); }
}

// ─── DISCOVERY 9: URLSCAN ────────────────────────────────────────────────────
async function discoverFromUrlScan() {
  try {
    var r = await fetchUrl('https://urlscan.io/api/v1/search/?q=task.tags:shopify+AND+page.domain:shopify&size=100', 20000);
    if (r.status !== 200 || !r.body) return;
    var json = JSON.parse(r.body); var added = 0;
    if (json.results) { for (var result of json.results) { if (result.page && result.page.ptr && !result.page.ptr.includes('shopify')) { addToQueue(result.page.ptr.toLowerCase(), 350000); added++; } if (result.page && result.page.domain && !result.page.domain.includes('shopify')) { addToQueue(result.page.domain.toLowerCase(), 350000); added++; } } }
    console.log('[UrlScan] ekledi:' + added);
  } catch(e) { console.error('[UrlScan]', e.message); }
}

// ─── DISCOVERY 10: SHODAN ────────────────────────────────────────────────────
async function discoverFromShodan() {
  try {
    var apiKey = process.env.SHODAN_API_KEY; if (!apiKey) return;
    var r = await fetchUrl('https://api.shodan.io/shodan/host/search?key=' + apiKey + '&query=org:Shopify&facets=domain&page=1', 20000);
    if (r.status !== 200 || !r.body) return;
    var json = JSON.parse(r.body); var added = 0;
    if (json.matches) { for (var match of json.matches) { if (match.hostnames) { for (var hostname of match.hostnames) { var domain = hostname.toLowerCase(); if (!domain.includes('shopify') && !domain.includes('amazonaws') && domain.includes('.')) { addToQueue(domain, 200000); added++; } } } if (match.http && match.http.host) { var httpDomain = match.http.host.toLowerCase(); if (!httpDomain.includes('shopify') && httpDomain.includes('.')) { addToQueue(httpDomain, 200000); added++; } } } }
    console.log('[Shodan] ekledi:' + added);
  } catch(e) { console.error('[Shodan]', e.message); }
}

// ─── DISCOVERY 11: SHODAN SHRINE ─────────────────────────────────────────────
async function discoverFromShodanShrine() {
  try {
    var apiKey = process.env.SHODAN_API_KEY; if (!apiKey) return;
    var queries = ['http.title:shrine+org:Shopify', 'http.html:shrine+net:23.227.38.0/24'];
    var query = queries[Math.floor(Math.random() * queries.length)];
    var r = await fetchUrl('https://api.shodan.io/shodan/host/search?key=' + apiKey + '&query=' + encodeURIComponent(query) + '&page=1', 20000);
    if (r.status !== 200 || !r.body) return;
    var json = JSON.parse(r.body); var added = 0;
    if (json.matches) { for (var match of json.matches) { if (match.hostnames) { for (var hostname of match.hostnames) { if (!hostname.includes('shopify')) { addToQueue(hostname.toLowerCase(), 50000); added++; } } } } }
    console.log('[Shodan-Shrine] ekledi:' + added);
  } catch(e) { console.error('[Shodan-Shrine]', e.message); }
}

// ─── DISCOVERY 12: CENSYS ────────────────────────────────────────────────────
async function discoverFromCensys() {
  try {
    var token = process.env.CENSYS_TOKEN; if (!token) return;
    var body = JSON.stringify({ q: 'services.http.response.headers.server: shopify', per_page: 100 });
    var result = await new Promise(function(resolve, reject) {
      var req = https.request({ hostname: 'search.censys.io', path: '/api/v2/hosts/search', method: 'POST', agent: insecureAgent, headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 20000 }, function(response) { var data = ''; response.on('data', function(c) { data += c; }); response.on('end', function() { resolve({ status: response.statusCode, body: data }); }); });
      req.on('error', reject); req.on('timeout', function() { req.destroy(); reject(new Error('timeout')); });
      req.write(body); req.end();
    });
    if (result.status !== 200) return;
    var json = JSON.parse(result.body); var added = 0;
    if (json.result && json.result.hits) { for (var hit of json.result.hits) { if (hit.services) { for (var service of hit.services) { if (service.tls && service.tls.certificates && service.tls.certificates.leaf_data) { var cn = service.tls.certificates.leaf_data.subject && service.tls.certificates.leaf_data.subject.common_name; if (cn && !cn.includes('shopify') && !cn.includes('*') && cn.includes('.')) { addToQueue(cn.toLowerCase(), 150000); added++; } } } } } }
    console.log('[Censys] ekledi:' + added);
  } catch(e) { console.error('[Censys]', e.message); }
}

// ─── DISCOVERY 13: DNSDUMPSTER ───────────────────────────────────────────────
async function discoverFromDnsDumpster() {
  try {
    var r1 = await fetchUrl('https://dnsdumpster.com', 15000);
    if (r1.status !== 200 || !r1.body) return;
    var csrfM = r1.body.match(/csrfmiddlewaretoken['"]\s*value=['"]([\w]+)['"]/);
    if (!csrfM) {
      var added = 0;
      for (var ip of ['23.227.38.32','23.227.38.33','23.227.38.34','23.227.38.35']) {
        try { var r = await fetchUrl('https://api.hackertarget.com/reverseiplookup/?q=' + ip, 10000); if (r.status === 200 && r.body && !r.body.includes('error')) { var domains = r.body.trim().split('\n'); for (var domain of domains) { domain = domain.trim().toLowerCase(); if (domain && domain.includes('.') && !domain.includes('shopify')) { addToQueue(domain, 300000); added++; } } } } catch(e) {}
      }
      console.log('[DnsDumpster-HT] ekledi:' + added); return;
    }
    var cookies = '';
    var setCookie = r1.headers && r1.headers['set-cookie'];
    if (setCookie) { var cookieArr = Array.isArray(setCookie) ? setCookie : [setCookie]; cookies = cookieArr.map(function(c) { return c.split(';')[0]; }).join('; '); }
    var postBody = 'csrfmiddlewaretoken=' + csrfM[1] + '&targetip=23.227.38.0%2F24';
    var result = await new Promise(function(resolve, reject) {
      var req = https.request({ hostname: 'dnsdumpster.com', path: '/', method: 'POST', agent: insecureAgent, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookies, 'Referer': 'https://dnsdumpster.com', 'User-Agent': 'Mozilla/5.0', 'Content-Length': Buffer.byteLength(postBody) }, timeout: 20000 }, function(response) { var data = ''; response.on('data', function(c) { data += c; }); response.on('end', function() { resolve({ status: response.statusCode, body: data }); }); });
      req.on('error', reject); req.on('timeout', function() { req.destroy(); reject(new Error('timeout')); });
      req.write(postBody); req.end();
    });
    if (result.status !== 200 || !result.body) return;
    var domainPattern = new RegExp('([a-zA-Z0-9][a-zA-Z0-9\\-]*\\.[a-zA-Z]{2,})', 'g');
    var matches = result.body.matchAll(domainPattern); var added2 = 0;
    for (var m of matches) { var d = m[1].toLowerCase(); if (!d.includes('shopify') && !d.includes('dnsdumpster') && d.includes('.')) { addToQueue(d, 300000); added2++; } }
    console.log('[DnsDumpster] ekledi:' + added2);
  } catch(e) { console.error('[DnsDumpster]', e.message); }
}

// ─── DISCOVERY 14: SİTEMAP ───────────────────────────────────────────────────
async function discoverFromSitemaps() {
  try {
    var stores = db.prepare('SELECT domain FROM stores ORDER BY RANDOM() LIMIT 20').all();
    var added = 0;
    for (var store of stores) {
      try { var r = await fetchUrl('https://' + store.domain + '/sitemap.xml', 8000); if (r.status !== 200 || !r.body) continue; var urlPattern = new RegExp('<loc>https?://([a-zA-Z0-9][a-zA-Z0-9\\-\\.]+\\.[a-zA-Z]{2,})', 'g'); var matches = r.body.matchAll(urlPattern); for (var m of matches) { var domain = m[1].toLowerCase(); if (!domain.includes('shopify') && domain !== store.domain) { addToQueue(domain, 300000); added++; } } } catch(e) {}
      await new Promise(r => setTimeout(r, 200));
    }
    console.log('[Sitemap] ekledi:' + added);
  } catch(e) { console.error('[Sitemap]', e.message); }
}

// ─── DISCOVERY 15: ALİENVAULT ────────────────────────────────────────────────
async function discoverFromAlienVault() {
  try {
    var ips = ['23.227.38.32','23.227.38.33','23.227.38.34','23.227.38.35','23.227.38.36'];
    var ip = ips[Math.floor(Math.random() * ips.length)];
    var r = await fetchWithHeaders('https://otx.alienvault.com/api/v1/indicators/IPv4/' + ip + '/passive_dns', { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, 15000);
    if (r.status !== 200 || !r.body) return;
    var json = JSON.parse(r.body); var added = 0;
    if (json.passive_dns) { for (var entry of json.passive_dns) { if (entry.hostname) { var domain = entry.hostname.toLowerCase().replace(/^www\./, ''); if (!domain.includes('shopify') && domain.includes('.')) { addToQueue(domain, 250000); added++; } } } }
    console.log('[AlienVault] ekledi:' + added);
  } catch(e) { console.error('[AlienVault]', e.message); }
}

// ─── DISCOVERY 16: PUBLIC DNS ────────────────────────────────────────────────
async function discoverFromPublicDNS() {
  try {
    var shopifyIPRange = []; for (var i = 32; i <= 63; i++) shopifyIPRange.push('23.227.38.' + i);
    var ip = shopifyIPRange[Math.floor(Math.random() * shopifyIPRange.length)];
    var reversedIP = ip.split('.').reverse().join('.');
    var added = 0;
    var r = await fetchUrl('https://dns.cloudflare.com/dns-query?name=' + reversedIP + '.in-addr.arpa&type=PTR', 10000);
    if (r.status === 200 && r.body) { try { var json = JSON.parse(r.body); if (json.Answer) { for (var answer of json.Answer) { if (answer.data) { var domain = answer.data.toLowerCase().replace(/\.$/, ''); if (!domain.includes('shopify') && domain.includes('.')) { addToQueue(domain, 300000); added++; } } } } } catch(e) {} }
    var r2 = await fetchUrl('https://api.hackertarget.com/reverseiplookup/?q=' + ip, 10000);
    if (r2.status === 200 && r2.body && !r2.body.includes('error') && !r2.body.includes('API count')) { var domains = r2.body.trim().split('\n'); for (var domain of domains) { domain = domain.trim().toLowerCase(); if (domain && domain.includes('.') && !domain.includes('shopify')) { addToQueue(domain, 300000); added++; } } }
    console.log('[PublicDNS] ip:' + ip + ' ekledi:' + added);
  } catch(e) { console.error('[PublicDNS]', e.message); }
}

// ─── DISCOVERY 17: GOOGLE ────────────────────────────────────────────────────
var googleSearchPage = 1;
var googleSearchQueries = ['"powered by shopify" "shrine"', 'site:shopify "shrine theme"', '"cdn.shopify.com" "shrine"', '"Shopify.theme" "shrine"', '"shrine" "add to cart" shopify'];
async function discoverFromGoogleSearch() {
  try {
    var apiKey = process.env.GOOGLE_API_KEY; var cx = process.env.GOOGLE_CX; if (!apiKey || !cx) return;
    var query = googleSearchQueries[googleSearchPage % googleSearchQueries.length];
    var start = ((googleSearchPage % 10) * 10) + 1;
    var r = await fetchUrl('https://www.googleapis.com/customsearch/v1?key=' + apiKey + '&cx=' + cx + '&q=' + encodeURIComponent(query) + '&start=' + start + '&num=10', 15000);
    if (r.status !== 200 || !r.body) return;
    var json = JSON.parse(r.body); var added = 0;
    if (json.items) { for (var item of json.items) { if (item.link) { try { var u = new URL(item.link); var domain = u.hostname.toLowerCase().replace(/^www\./, ''); if (!domain.includes('shopify') && domain.includes('.')) { addToQueue(domain, 50000); added++; } } catch(e) {} } } }
    googleSearchPage++;
    console.log('[Google] ekledi:' + added);
  } catch(e) { console.error('[Google]', e.message); }
}

// ─── DISCOVERY 18: COMMONCRAWL SHRINE ────────────────────────────────────────
var shrineSearchIndex = 0;
async function discoverFromCommonCrawlShrine() {
  try {
    var crawlId = COMMON_CRAWL_IDS[shrineSearchIndex % COMMON_CRAWL_IDS.length];
    var r = await fetchUrl('https://index.commoncrawl.org/' + crawlId + '-index?url=*&output=json&limit=1000&fl=url&filter=mime:text/html&filter=url:*shrine*', 60000);
    if (r.status !== 200 || !r.body) return;
    var lines = r.body.trim().split('\n'); var added = 0;
    for (var line of lines) { try { var obj = JSON.parse(line); if (obj.url) { var urlM = obj.url.match(/https?:\/\/([a-zA-Z0-9\-\.]+)/); if (urlM) { var domain = urlM[1].toLowerCase(); if (!domain.includes('shopify') && !domain.includes('cdn') && domain.includes('.')) { addToQueue(domain, 80000); added++; } } } } catch(e) {} }
    shrineSearchIndex++;
    console.log('[CommonCrawl-Shrine] ekledi:' + added);
  } catch(e) { console.error('[CommonCrawl-Shrine]', e.message); }
}

// ─── DISCOVERY 19: WAYBACK SHRINE ────────────────────────────────────────────
var waybackPage = 0;
async function discoverFromWaybackShrine() {
  try {
    var offset = waybackPage * 1000;
    var r = await fetchUrl('https://web.archive.org/cdx/search/cdx?url=*&output=json&limit=1000&offset=' + offset + '&fl=original&filter=statuscode:200&filter=original:.*shrine.*&collapse=urlkey', 30000);
    if (r.status !== 200 || !r.body) return;
    var json = JSON.parse(r.body); var added = 0;
    for (var i = 1; i < json.length; i++) { try { var urlM = json[i][0].match(/https?:\/\/([a-zA-Z0-9\-\.]+)/); if (urlM) { var domain = urlM[1].toLowerCase(); if (!domain.includes('shopify') && !domain.includes('web.archive') && domain.includes('.')) { addToQueue(domain, 90000); added++; } } } catch(e) {} }
    waybackPage++;
    console.log('[Wayback-Shrine] ekledi:' + added);
  } catch(e) { console.error('[Wayback-Shrine]', e.message); }
}

// ─── DISCOVERY 20: BUILTWITH ─────────────────────────────────────────────────
var builtWithPage = 1;
async function discoverFromBuiltWith() {
  try {
    var r = await fetchUrl('https://trends.builtwith.com/shop/Shopify-Shrine/2?p=' + builtWithPage, 15000);
    if (r.status !== 200 || !r.body) return;
    var hrefPattern = new RegExp('href=["\']https?://(?:www\\.)?([a-zA-Z0-9][a-zA-Z0-9\\-]*\\.[a-zA-Z]{2,})(?:/|["\'])', 'g');
    var matches = r.body.matchAll(hrefPattern); var added = 0;
    for (var m of matches) { var domain = m[1].toLowerCase(); if (!domain.includes('builtwith') && !domain.includes('shopify') && domain.includes('.')) { addToQueue(domain, 30000); added++; } }
    builtWithPage++; if (builtWithPage > 50) builtWithPage = 1;
    console.log('[BuiltWith] ekledi:' + added);
  } catch(e) { console.error('[BuiltWith]', e.message); }
}

// ─── DISCOVERY 21: FOFA ──────────────────────────────────────────────────────
async function discoverFromFofa() {
  try {
    var query = Buffer.from('app="Shopify" && body="shrine"').toString('base64');
    var r = await fetchWithHeaders('https://fofa.info/api/v1/search/all?qbase64=' + query + '&fields=host&size=100&full=true', { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, 20000);
    if (r.status !== 200 || !r.body) return;
    var json = JSON.parse(r.body); var added = 0;
    if (json.results) { for (var result of json.results) { var domain = result[0].toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''); if (!domain.includes('shopify') && domain.includes('.')) { addToQueue(domain, 70000); added++; } } }
    console.log('[Fofa] ekledi:' + added);
  } catch(e) { console.error('[Fofa]', e.message); }
}

// ─── DISCOVERY 22: ZOOMEYE ───────────────────────────────────────────────────
var zoomeyePage = 1;
async function discoverFromZoomEye() {
  try {
    var r = await fetchWithHeaders('https://www.zoomeye.org/searchResult?q=app%3A%22Shopify%22+shrine&t=web&p=' + zoomeyePage, { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, 20000);
    if (r.status !== 200 || !r.body) return;
    var added = 0;
    try { var json = JSON.parse(r.body); if (json.matches) { for (var match of json.matches) { if (match.site) { var domain = match.site.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''); if (!domain.includes('shopify') && domain.includes('.')) { addToQueue(domain, 60000); added++; } } } } } catch(e) {}
    zoomeyePage++; if (zoomeyePage > 20) zoomeyePage = 1;
    console.log('[ZoomEye] ekledi:' + added);
  } catch(e) { console.error('[ZoomEye]', e.message); }
}

// ─── DISCOVERY 23: CRT.SH (YENİ) ─────────────────────────────────────────────
var crtShOffset = 0;
async function discoverFromCrtSh() {
  try {
    // Shopify'ın kullandığı ortak SSL sertifika kalıplarını ara
    var queries = [
      'https://crt.sh/?q=%25.myshopify.com&output=json',
      'https://crt.sh/?q=%25shopify%25&output=json&exclude=expired'
    ];
    var url = queries[crtShOffset % queries.length];
    var r = await fetchUrl(url, 30000);
    if (r.status !== 200 || !r.body) return;
    var json = JSON.parse(r.body);
    var added = 0;
    for (var cert of json) {
      if (!cert.name_value) continue;
      var names = cert.name_value.split('\n');
      for (var name of names) {
        name = name.trim().toLowerCase().replace(/^\*\./, '');
        if (!name || name.includes('shopify') || name.includes('*') || !name.includes('.')) continue;
        // Shopify custom domain olup olmadığını kontrol et - sonradan scrape edilecek
        addToQueue(name, 20000);
        added++;
      }
    }
    crtShOffset++;
    console.log('[crt.sh] ekledi:' + added);
  } catch(e) { console.error('[crt.sh]', e.message); }
}

// ─── DISCOVERY 24: ECOMM.DESIGN (YENİ) ───────────────────────────────────────
var ecommDesignPage = 1;
async function discoverFromEcommDesign() {
  try {
    var r = await fetchWithHeaders(
      'https://ecomm.design/shopify-stores/?page=' + ecommDesignPage,
      { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'text/html' },
      20000
    );
    if (r.status !== 200 || !r.body) return;
    var hrefPattern = new RegExp('href=["\']https?://(?:www\\.)?([a-zA-Z0-9][a-zA-Z0-9\\-]*\\.[a-zA-Z]{2,})(?:/|["\'])', 'g');
    var matches = r.body.matchAll(hrefPattern);
    var added = 0;
    for (var m of matches) {
      var domain = m[1].toLowerCase();
      if (!domain.includes('ecomm.design') && !domain.includes('shopify') && !domain.includes('wordpress') && !domain.includes('google') && domain.includes('.')) {
        addToQueue(domain, 25000); added++;
      }
    }
    ecommDesignPage++;
    if (ecommDesignPage > 100) ecommDesignPage = 1;
    console.log('[ecomm.design] ekledi:' + added);
  } catch(e) { console.error('[ecomm.design]', e.message); }
}

// ─── DISCOVERY 25: MERCHANTGENIUS (YENİ) ─────────────────────────────────────
var merchantGeniusPage = 1;
async function discoverFromMerchantGenius() {
  try {
    var r = await fetchWithHeaders(
      'https://merchantgenius.co/shopify-stores?page=' + merchantGeniusPage,
      { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'text/html' },
      20000
    );
    if (r.status !== 200 || !r.body) return;
    var hrefPattern = new RegExp('href=["\']https?://(?:www\\.)?([a-zA-Z0-9][a-zA-Z0-9\\-]*\\.[a-zA-Z]{2,})(?:/|["\'])', 'g');
    var matches = r.body.matchAll(hrefPattern);
    var added = 0;
    for (var m of matches) {
      var domain = m[1].toLowerCase();
      if (!domain.includes('merchantgenius') && !domain.includes('shopify') && !domain.includes('google') && domain.includes('.')) {
        addToQueue(domain, 20000); added++;
      }
    }
    merchantGeniusPage++;
    if (merchantGeniusPage > 200) merchantGeniusPage = 1;
    console.log('[MerchantGenius] ekledi:' + added);
  } catch(e) { console.error('[MerchantGenius]', e.message); }
}

// ─── DISCOVERY 26: REDDIT SCRAPING (YENİ) ────────────────────────────────────
var redditAfter = '';
var redditSubreddits = ['shopify', 'ecommerce', 'dropship', 'entrepreneur', 'startups'];
var redditSubIndex = 0;
async function discoverFromReddit() {
  try {
    var subreddit = redditSubreddits[redditSubIndex % redditSubreddits.length];
    var url = 'https://www.reddit.com/r/' + subreddit + '/new.json?limit=100&after=' + redditAfter;
    var r = await fetchWithHeaders(url, {
      'User-Agent': 'ShopFind-Bot/1.0',
      'Accept': 'application/json'
    }, 15000);
    if (r.status !== 200 || !r.body) return;
    var json = JSON.parse(r.body);
    var added = 0;
    if (json.data && json.data.children) {
      for (var post of json.data.children) {
        var text = (post.data.selftext || '') + ' ' + (post.data.url || '') + ' ' + (post.data.title || '');
        // Domainleri çıkar
        var domainPattern = /([a-zA-Z0-9][a-zA-Z0-9\-]*\.(?:com|net|org|io|co|shop|store|me|info|biz|co\.uk|com\.au))/g;
        var matches = text.matchAll(domainPattern);
        for (var m of matches) {
          var domain = m[1].toLowerCase();
          if (!domain.includes('reddit') && !domain.includes('shopify') && !domain.includes('imgur') && domain.includes('.')) {
            addToQueue(domain, 40000); added++;
          }
        }
      }
      redditAfter = json.data.after || '';
    }
    redditSubIndex++;
    console.log('[Reddit] r/' + subreddit + ' ekledi:' + added);
  } catch(e) { console.error('[Reddit]', e.message); }
}

// ─── DISCOVERY 27: SHOPIFY BLOG (YENİ) ───────────────────────────────────────
var shopifyBlogPage = 1;
async function discoverFromShopifyBlog() {
  try {
    var urls = [
      'https://www.shopify.com/blog/topics/success-stories',
      'https://www.shopify.com/blog/topics/merchant-stories',
      'https://www.shopify.com/blog'
    ];
    var url = urls[shopifyBlogPage % urls.length];
    var r = await fetchUrl(url, 15000);
    if (r.status !== 200 || !r.body) return;
    var hrefPattern = new RegExp('href=["\']https?://(?:www\\.)?([a-zA-Z0-9][a-zA-Z0-9\\-]*\\.[a-zA-Z]{2,})(?:/|["\'])', 'g');
    var matches = r.body.matchAll(hrefPattern);
    var added = 0;
    for (var m of matches) {
      var domain = m[1].toLowerCase();
      if (!domain.includes('shopify') && !domain.includes('google') && !domain.includes('apple') && !domain.includes('facebook') && domain.includes('.')) {
        addToQueue(domain, 15000); added++;
      }
    }
    shopifyBlogPage++;
    if (shopifyBlogPage > 10) shopifyBlogPage = 1;
    console.log('[ShopifyBlog] ekledi:' + added);
  } catch(e) { console.error('[ShopifyBlog]', e.message); }
}

// ─── DISCOVERY 28: DNS/WHOIS - WHOISXML (YENİ) ────────────────────────────────
var whoisPage = 1;
async function discoverFromWhoisXML() {
  try {
    // WhoisXML ücretsiz API - yeni kayıtlı domainler
    var r = await fetchWithHeaders(
      'https://newly-registered-domains.whoisxmlapi.com/api/v1?apiKey=at_free&sinceDate=' + new Date(Date.now() - 86400000).toISOString().split('T')[0] + '&page=' + whoisPage,
      { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      20000
    );
    if (r.status !== 200 || !r.body) {
      // Ücretsiz API çalışmazsa alternatif: freshly squatted domains listesi
      var r2 = await fetchUrl('https://raw.githubusercontent.com/nicowillis/newly-registered-domains/main/domains.txt', 10000);
      if (r2.status === 200 && r2.body) {
        var lines = r2.body.trim().split('\n');
        var added2 = 0;
        for (var line of lines.slice(0, 500)) {
          var domain = line.trim().toLowerCase();
          if (domain && domain.includes('.') && !domain.includes('shopify')) {
            addToQueue(domain, 60000); added2++;
          }
        }
        console.log('[WhoisXML-Alt] ekledi:' + added2);
      }
      return;
    }
    var json = JSON.parse(r.body);
    var added = 0;
    if (json.domainsList) {
      for (var domain of json.domainsList) {
        domain = domain.toLowerCase();
        if (!domain.includes('shopify') && domain.includes('.')) { addToQueue(domain, 60000); added++; }
      }
    }
    whoisPage++;
    console.log('[WhoisXML] ekledi:' + added);
  } catch(e) { console.error('[WhoisXML]', e.message); }
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
      if (data) { saveStore(data); db.prepare("UPDATE scrape_queue SET status='done' WHERE id=?").run(item.id); console.log('[Queue] OK:' + item.domain + ' ülke:' + (data.country||'-') + ' tema:' + (data.theme_name||'-') + ' yıl:' + (data.founded_year||'-')); }
      else { db.prepare("UPDATE scrape_queue SET status='not_shopify' WHERE id=?").run(item.id); }
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

// ─── MANUAL TRIGGERS ─────────────────────────────────────────────────────────
app.post('/api/discover/commoncrawl', auth, async function(req, res) { discoverFromCommonCrawlCustom(); res.json({ message: 'Common Crawl başlatıldı' }); });
app.post('/api/discover/hackertarget', auth, async function(req, res) { discoverFromHackerTarget(); res.json({ message: 'HackerTarget başlatıldı' }); });
app.post('/api/discover/shodan', auth, async function(req, res) { discoverFromShodan(); discoverFromShodanShrine(); res.json({ message: 'Shodan başlatıldı' }); });
app.post('/api/discover/censys', auth, async function(req, res) { discoverFromCensys(); res.json({ message: 'Censys başlatıldı' }); });
app.post('/api/discover/google', auth, async function(req, res) { discoverFromGoogleSearch(); res.json({ message: 'Google başlatıldı' }); });
app.post('/api/discover/builtwith', auth, async function(req, res) { discoverFromBuiltWith(); res.json({ message: 'BuiltWith başlatıldı' }); });
app.post('/api/discover/wayback', auth, async function(req, res) { discoverFromWaybackShrine(); res.json({ message: 'Wayback başlatıldı' }); });
app.post('/api/discover/crtsh', auth, async function(req, res) { discoverFromCrtSh(); res.json({ message: 'crt.sh başlatıldı' }); });
app.post('/api/discover/ecommdesign', auth, async function(req, res) { discoverFromEcommDesign(); res.json({ message: 'ecomm.design başlatıldı' }); });
app.post('/api/discover/merchantgenius', auth, async function(req, res) { discoverFromMerchantGenius(); res.json({ message: 'MerchantGenius başlatıldı' }); });
app.post('/api/discover/reddit', auth, async function(req, res) { discoverFromReddit(); res.json({ message: 'Reddit başlatıldı' }); });
app.post('/api/rescan-themes', auth, async function(req, res) { res.json({ message: 'Yeniden tarama başlatıldı' }); rescanMissingData(); });
app.post('/api/quickcountry', auth, async function(req, res) { res.json({ message: 'Hızlı ülke ataması başlatıldı' }); quickCountryFill(); });

// ─── SERVER START ─────────────────────────────────────────────────────────────
app.listen(PORT, function() {
  console.log('ShopFind API port ' + PORT + ' üzerinde çalışıyor');
  console.log('DB_PATH:', DB_PATH);
  console.log('ShopifyID kaldığı yer:', shopifyId);

  setTimeout(function() {
    var stmt = db.prepare('INSERT OR IGNORE INTO scrape_queue (domain, status, majestic_rank, added_at) VALUES (?, ?, ?, ?)');
    for (var d of SEEDS) stmt.run(d, 'pending', 999999999, new Date().toISOString());
    console.log('Seed kuyruğa eklendi');
  }, 1000);

  setTimeout(quickCountryFill, 5000);
  setTimeout(rescanMissingData, 120000);
  setInterval(rescanMissingData, 21600000);
  setInterval(processQueue, 3000);

  // Mevcut discovery'ler
  setInterval(discoverFromShopifyId, 30000);
  setTimeout(discoverFromShopifyId, 10000);
  setInterval(discoverFromMyip, 45000);
  setTimeout(discoverFromMyip, 15000);
  setInterval(discoverFromAppsShopify, 60000);
  setTimeout(discoverFromAppsShopify, 20000);
  setInterval(discoverFromAppReviews, 50000);
  setTimeout(discoverFromAppReviews, 25000);
  setTimeout(discoverFromCommonCrawlCustom, 30000);
  setInterval(discoverFromCommonCrawlCustom, 600000);
  setTimeout(discoverFromCommonCrawlShrine, 35000);
  setInterval(discoverFromCommonCrawlShrine, 900000);
  setTimeout(discoverFromHackerTarget, 40000);
  setInterval(discoverFromHackerTarget, 900000);
  setTimeout(discoverFromGitHub, 45000);
  setInterval(discoverFromGitHub, 1800000);
  setTimeout(discoverFromGitHubShrine, 50000);
  setInterval(discoverFromGitHubShrine, 1800000);
  setTimeout(discoverFromUrlScan, 55000);
  setInterval(discoverFromUrlScan, 1200000);
  setTimeout(discoverFromShodan, 60000);
  setInterval(discoverFromShodan, 1200000);
  setTimeout(discoverFromShodanShrine, 65000);
  setInterval(discoverFromShodanShrine, 1800000);
  setTimeout(discoverFromCensys, 70000);
  setInterval(discoverFromCensys, 1800000);
  setTimeout(discoverFromDnsDumpster, 75000);
  setInterval(discoverFromDnsDumpster, 1500000);
  setTimeout(discoverFromSitemaps, 80000);
  setInterval(discoverFromSitemaps, 1200000);
  setTimeout(discoverFromAlienVault, 85000);
  setInterval(discoverFromAlienVault, 1500000);
  setTimeout(discoverFromPublicDNS, 90000);
  setInterval(discoverFromPublicDNS, 600000);
  setTimeout(discoverFromGoogleSearch, 95000);
  setInterval(discoverFromGoogleSearch, 900000);
  setTimeout(discoverFromWaybackShrine, 100000);
  setInterval(discoverFromWaybackShrine, 1800000);
  setTimeout(discoverFromBuiltWith, 105000);
  setInterval(discoverFromBuiltWith, 2400000);
  setTimeout(discoverFromFofa, 110000);
  setInterval(discoverFromFofa, 1800000);
  setTimeout(discoverFromZoomEye, 115000);
  setInterval(discoverFromZoomEye, 1800000);

  // YENİ discovery'ler
  setTimeout(discoverFromCrtSh, 120000);
  setInterval(discoverFromCrtSh, 1800000);
  setTimeout(discoverFromEcommDesign, 125000);
  setInterval(discoverFromEcommDesign, 1200000);
  setTimeout(discoverFromMerchantGenius, 130000);
  setInterval(discoverFromMerchantGenius, 1200000);
  setTimeout(discoverFromReddit, 135000);
  setInterval(discoverFromReddit, 600000);
  setTimeout(discoverFromShopifyBlog, 140000);
  setInterval(discoverFromShopifyBlog, 3600000);
  setTimeout(discoverFromWhoisXML, 145000);
  setInterval(discoverFromWhoisXML, 3600000);
});

module.exports = app;
