import { useState, useEffect, useCallback } from "react";

const API = import.meta.env.VITE_API_URL || "http://localhost:3001";

function getToken() { return localStorage.getItem("sf_token"); }
function setToken(t) { localStorage.setItem("sf_token", t); }
function clearToken() { localStorage.removeItem("sf_token"); }

async function apiFetch(path, options) {
  var res = await fetch(API + path, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + getToken(), ...(options && options.headers) },
  });
  return res.json();
}

function useWhopProtection() {
  const [allowed] = useState(true);
  return allowed;
}

function AuthScreen({ onAuth }) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit() {
    setError(""); setLoading(true);
    try {
      var data = await fetch(API + "/api/auth/" + mode, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      }).then(r => r.json());
      if (data.token) { setToken(data.token); onAuth(data.user); }
      else setError(data.error || "Bir hata oluştu");
    } catch(e) { setError("Sunucuya bağlanılamadı"); }
    setLoading(false);
  }

  return (
    <div className="auth-page">
      <div className="auth-noise" />
      <div className="auth-card">
        <div className="auth-header">
          <div className="logo-mark">◈</div>
          <div className="logo-text">SHOPFIND</div>
        </div>
        <p className="auth-sub">Shopify Store Intelligence</p>
        <div className="auth-tabs">
          {["login","register"].map(m => (
            <button key={m} className={"auth-tab" + (mode===m?" active":"")} onClick={() => setMode(m)}>
              {m === "login" ? "Sign In" : "Register"}
            </button>
          ))}
        </div>
        <input className="auth-input" type="email" placeholder="Email address"
          value={email} onChange={e => setEmail(e.target.value)}
          onKeyDown={e => e.key==="Enter" && handleSubmit()} />
        <input className="auth-input" type="password" placeholder="Password"
          value={password} onChange={e => setPassword(e.target.value)}
          onKeyDown={e => e.key==="Enter" && handleSubmit()} />
        {error && <div className="auth-error">{error}</div>}
        <button className="auth-btn" onClick={handleSubmit} disabled={loading}>
          {loading ? "—" : mode === "login" ? "Enter System" : "Create Account"}
        </button>
      </div>
    </div>
  );
}

function StoreRow({ store, index }) {
  const tld = "." + store.domain.split(".").pop();
  return (
    <a href={"https://" + store.domain} target="_blank" rel="noopener noreferrer" className="store-row">
      <div className="row-index">{String(index + 1).padStart(2, "0")}</div>
      <img src={"https://www.google.com/s2/favicons?domain=" + store.domain + "&sz=32"}
        alt="" className="row-favicon" onError={e => e.target.style.opacity="0"} />
      <div className="row-info">
        <div className="row-name">{store.name || store.domain}</div>
        <div className="row-domain">{store.domain}</div>
        <div className="row-badges">
          {store.country && <span className="badge badge-geo">{store.country}</span>}
          {store.currency && <span className="badge badge-cur">{store.currency}</span>}
          {store.language && <span className="badge badge-lang">{store.language.toUpperCase().substring(0,2)}</span>}
          {store.product_count > 0 && <span className="badge badge-prod">{store.product_count} items</span>}
          {store.theme_name && <span className="badge badge-theme">{store.theme_name}</span>}
        </div>
      </div>
      <div className="row-meta">
        <div className="row-year">{store.founded_year || "—"}</div>
        <div className="row-tld">{tld}</div>
      </div>
    </a>
  );
}

function FilterPanel({ filters, setFilters, onApply, onClear, countries, tlds, currencies, languages, hasActive }) {
  const [local, setLocal] = useState(filters);
  useEffect(() => { setLocal(filters); }, [filters]);
  function update(key, val) { setLocal(prev => ({...prev, [key]: val})); }
  function apply() { setFilters(local); onApply(); }
  function clear() {
    const empty = { theme:'', country:'', tld:'', currency:'', language:'', search:'', minProducts:'', maxProducts:'', yearFrom:'', yearTo:'' };
    setLocal(empty); setFilters(empty); onClear();
  }

  return (
    <div className="filter-panel">
      <div className="filter-section">
        <label className="filter-label">Search</label>
        <input className="filter-input" type="text" placeholder="Store name or domain..."
          value={local.search} onChange={e => update('search', e.target.value)}
          onKeyDown={e => e.key === 'Enter' && apply()} />
      </div>
      <div className="filter-grid">
        <div className="filter-section">
          <label className="filter-label">Theme</label>
          <input className="filter-input" type="text" placeholder="e.g. shrine, dawn..."
            value={local.theme} onChange={e => update('theme', e.target.value)}
            onKeyDown={e => e.key === 'Enter' && apply()} />
        </div>
        <div className="filter-section">
          <label className="filter-label">Country</label>
          <select className="filter-select" value={local.country} onChange={e => update('country', e.target.value)}>
            <option value="">All countries</option>
            {countries.map(c => <option key={c.country} value={c.country}>{c.country} ({c.count})</option>)}
          </select>
        </div>
        <div className="filter-section">
          <label className="filter-label">Extension</label>
          <select className="filter-select" value={local.tld} onChange={e => update('tld', e.target.value)}>
            <option value="">All extensions</option>
            {tlds.map(t => <option key={t.tld} value={t.tld}>.{t.tld} ({t.count})</option>)}
          </select>
        </div>
        <div className="filter-section">
          <label className="filter-label">Currency</label>
          <select className="filter-select" value={local.currency} onChange={e => update('currency', e.target.value)}>
            <option value="">All currencies</option>
            {currencies.map(c => <option key={c.currency} value={c.currency}>{c.currency} ({c.count})</option>)}
          </select>
        </div>
        <div className="filter-section">
          <label className="filter-label">Language</label>
          <select className="filter-select" value={local.language} onChange={e => update('language', e.target.value)}>
            <option value="">All languages</option>
            {languages.map(l => <option key={l.language} value={l.language}>{l.language} ({l.count})</option>)}
          </select>
        </div>
        <div className="filter-section">
          <label className="filter-label">Products</label>
          <div className="filter-range">
            <input className="filter-input filter-small" type="number" placeholder="Min" min="0"
              value={local.minProducts} onChange={e => update('minProducts', e.target.value)} />
            <span className="range-sep">—</span>
            <input className="filter-input filter-small" type="number" placeholder="Max"
              value={local.maxProducts} onChange={e => update('maxProducts', e.target.value)} />
          </div>
        </div>
        <div className="filter-section">
          <label className="filter-label">Founded Year</label>
          <div className="filter-range">
            <input className="filter-input filter-small" type="number" placeholder="From" min="2000" max="2025"
              value={local.yearFrom} onChange={e => update('yearFrom', e.target.value)} />
            <span className="range-sep">—</span>
            <input className="filter-input filter-small" type="number" placeholder="To" min="2000" max="2025"
              value={local.yearTo} onChange={e => update('yearTo', e.target.value)} />
          </div>
        </div>
      </div>
      <div className="filter-actions">
        <button className="btn-apply" onClick={apply}>Apply Filters</button>
        {hasActive && <button className="btn-clear" onClick={clear}>Clear All</button>}
      </div>
    </div>
  );
}

function Dashboard({ user, onLogout }) {
  const [stores, setStores] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalAll, setTotalAll] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sortEnabled, setSortEnabled] = useState(false);
  const [sort, setSort] = useState("majestic_rank");
  const [order, setOrder] = useState("asc");
  const [countries, setCountries] = useState([]);
  const [tlds, setTlds] = useState([]);
  const [currencies, setCurrencies] = useState([]);
  const [languages, setLanguages] = useState([]);

  const emptyFilters = { theme:'', country:'', tld:'', currency:'', language:'', search:'', minProducts:'', maxProducts:'', yearFrom:'', yearTo:'' };
  const [filters, setFilters] = useState(emptyFilters);
  const [appliedFilters, setAppliedFilters] = useState(emptyFilters);

  const hasFilterActive = Object.values(appliedFilters).some(v => v !== '');
  const hasActive = hasFilterActive || (sortEnabled && sort !== 'majestic_rank');

  function buildUrl(p, f, s, o, sortOn) {
    var url = "/api/stores?page=" + p;
    if (f.theme) url += "&theme=" + encodeURIComponent(f.theme);
    if (f.country) url += "&country=" + encodeURIComponent(f.country);
    if (f.tld) url += "&tld=" + encodeURIComponent(f.tld);
    if (f.currency) url += "&currency=" + encodeURIComponent(f.currency);
    if (f.language) url += "&language=" + encodeURIComponent(f.language);
    if (f.search) url += "&search=" + encodeURIComponent(f.search);
    if (f.minProducts) url += "&min_products=" + f.minProducts;
    if (f.maxProducts) url += "&max_products=" + f.maxProducts;
    if (f.yearFrom) url += "&year_from=" + f.yearFrom;
    if (f.yearTo) url += "&year_to=" + f.yearTo;
    if (sortOn && s && s !== "majestic_rank") url += "&sort=" + s;
    if (sortOn && o && o !== "asc") url += "&order=" + o;
    return url;
  }

  // ─── silent=true ise liste kaybolmaz, arka planda güncellenir ────────────
  const loadStores = useCallback(async (p, f, s, o, sortOn, silent) => {
    if (!silent) setLoading(true);
    var d = await apiFetch(buildUrl(p, f, s, o, sortOn));
    if (d.stores) { setStores(d.stores); setTotal(d.total||0); setTotalAll(d.totalAll||0); }
    if (!silent) setLoading(false);
  }, []);

  const loadStats = useCallback(async () => {
    var d = await apiFetch("/api/stats");
    if (d.total !== undefined) setStats(d);
  }, []);

  const loadDropdowns = useCallback(async () => {
    var [c, t, cu, l] = await Promise.all([
      apiFetch("/api/countries"), apiFetch("/api/tlds"),
      apiFetch("/api/currencies"), apiFetch("/api/languages"),
    ]);
    if (c.countries) setCountries(c.countries);
    if (t.tlds) setTlds(t.tlds);
    if (cu.currencies) setCurrencies(cu.currencies);
    if (l.languages) setLanguages(l.languages);
  }, []);

  useEffect(() => { loadStores(page, appliedFilters, sort, order, sortEnabled, false); }, [page, appliedFilters, sort, order, sortEnabled]);
  useEffect(() => { loadStats(); loadDropdowns(); var iv = setInterval(loadStats, 10000); return () => clearInterval(iv); }, []);

  // ─── Arka planda sessiz yenileme - liste kaybolmaz ───────────────────────
  useEffect(() => {
    var iv = setInterval(() => loadStores(page, appliedFilters, sort, order, sortEnabled, true), 15000);
    return () => clearInterval(iv);
  }, [page, appliedFilters, sort, order, sortEnabled]);

  function handleSort(col) {
    if (!sortEnabled) { setSortEnabled(true); setSort(col); setOrder("asc"); setPage(1); return; }
    if (sort === col) { setOrder(o => o === "asc" ? "desc" : "asc"); }
    else { setSort(col); setOrder("asc"); }
    setPage(1);
  }

  function toggleSort() {
    if (sortEnabled) { setSortEnabled(false); setSort("majestic_rank"); setOrder("asc"); setPage(1); }
    else { setSortEnabled(true); setPage(1); }
  }

  function applyFilters() { setAppliedFilters({...filters}); setPage(1); setFiltersOpen(false); }
  function clearFilters() { setAppliedFilters(emptyFilters); setFilters(emptyFilters); setSortEnabled(false); setSort("majestic_rank"); setOrder("asc"); setPage(1); }

  const totalPages = Math.ceil(total / 50);
  const pending = stats ? stats.pending : 0;

  const activeTags = [];
  if (appliedFilters.search) activeTags.push('Search: ' + appliedFilters.search);
  if (appliedFilters.theme) activeTags.push('Theme: ' + appliedFilters.theme);
  if (appliedFilters.country) activeTags.push('Country: ' + appliedFilters.country);
  if (appliedFilters.tld) activeTags.push('Ext: .' + appliedFilters.tld);
  if (appliedFilters.currency) activeTags.push('Currency: ' + appliedFilters.currency);
  if (appliedFilters.language) activeTags.push('Lang: ' + appliedFilters.language);
  if (appliedFilters.minProducts || appliedFilters.maxProducts) activeTags.push('Products: ' + (appliedFilters.minProducts||'0') + '–' + (appliedFilters.maxProducts||'∞'));
  if (appliedFilters.yearFrom || appliedFilters.yearTo) activeTags.push('Year: ' + (appliedFilters.yearFrom||'—') + '–' + (appliedFilters.yearTo||'—'));
  if (sortEnabled && sort !== 'majestic_rank') activeTags.push('Sort: ' + sort + ' ' + (order === 'asc' ? '↑' : '↓'));

  return (
    <div className="dash">
      <div className="dash-noise" />

      <header className="header">
        <div className="header-brand">
          <span className="header-mark">◈</span>
          <span className="header-name">SHOPFIND</span>
        </div>
        <div className="header-stats">
          {stats && (
            <>
              <div className="stat-chip">
                <span className="stat-dot dot-green" />
                <span className="stat-val">{stats.total.toLocaleString()}</span>
                <span className="stat-lbl">stores</span>
              </div>
              <div className="stat-chip">
                <span className="stat-dot dot-amber" />
                <span className="stat-val">{pending.toLocaleString()}</span>
                <span className="stat-lbl">queued</span>
              </div>
            </>
          )}
        </div>
        <button className="btn-logout" onClick={onLogout}>Exit</button>
      </header>

      <div className="hero">
        <div className="hero-eyebrow">Real-time Discovery Engine</div>
        <h1 className="hero-title">Shopify<br/><span className="hero-accent">Store</span></h1>
        <p className="hero-sub">
          {hasActive
            ? <><strong>{total.toLocaleString()}</strong> results found</>
            : <><strong>{totalAll.toLocaleString()}</strong> stores indexed · {pending.toLocaleString()} scanning</>
          }
        </p>
      </div>

      <div className="filter-bar">
        <button className={"btn-filter" + (filtersOpen ? " active" : "")} onClick={() => setFiltersOpen(o => !o)}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M1 3h12M3 7h8M5 11h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          Filters
          {hasFilterActive && <span className="filter-count">{activeTags.filter(t => !t.startsWith('Sort')).length}</span>}
        </button>

        <button className={"btn-sort-toggle" + (sortEnabled ? " active" : "")} onClick={toggleSort}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 3h8M3.5 6h5M5 9h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          Sort
          {sortEnabled && <span className="sort-toggle-dot" />}
        </button>

        {sortEnabled && (
          <div className="sort-group">
            {[
              { key: 'majestic_rank', label: 'Default' },
              { key: 'founded', label: 'Founded' },
              { key: 'products', label: 'Products' },
              { key: 'name', label: 'Name' },
            ].map(s => (
              <button key={s.key}
                className={"btn-sort" + (sort===s.key ? " active" : "")}
                onClick={() => handleSort(s.key)}>
                {s.label}
                {sort === s.key && <span className="sort-arrow">{order === 'asc' ? '↑' : '↓'}</span>}
              </button>
            ))}
          </div>
        )}

        {hasActive && <button className="btn-reset" onClick={clearFilters}>✕ Reset</button>}
      </div>

      {activeTags.length > 0 && (
        <div className="active-tags">
          {activeTags.map((tag, i) => <span key={i} className="active-tag">{tag}</span>)}
        </div>
      )}

      {filtersOpen && (
        <FilterPanel
          filters={filters} setFilters={setFilters}
          onApply={applyFilters} onClear={clearFilters}
          countries={countries} tlds={tlds}
          currencies={currencies} languages={languages}
          hasActive={hasActive}
        />
      )}

      <div className="table-head">
        <span className="th-num">#</span>
        <span className="th-store">Store</span>
        <span className="th-right">Founded</span>
      </div>

      <div className="store-list">
        {loading ? (
          <div className="state-center"><div className="spinner" /></div>
        ) : stores.length === 0 ? (
          <div className="state-center">
            <div className="state-empty">
              <div className="empty-icon">◈</div>
              <div className="empty-text">{hasActive ? "No stores match your filters" : "Scanning for stores..."}</div>
            </div>
          </div>
        ) : stores.map((st, i) => (
          <StoreRow key={st.id} store={st} index={(page-1)*50+i} />
        ))}
      </div>

      {totalPages > 1 && (
        <div className="pagination">
          <button className="btn-page" onClick={() => setPage(p => Math.max(1,p-1))} disabled={page===1}>←</button>
          <span className="page-info"><strong>{page}</strong> / {totalPages}</span>
          <button className="btn-page" onClick={() => setPage(p => Math.min(totalPages,p+1))} disabled={page===totalPages}>→</button>
        </div>
      )}

      <div className="footer">
        <span>◈ SHOPFIND</span>
        <span>Real-time Shopify Discovery</span>
      </div>
    </div>
  );
}

export default function App() {
  const allowed = useWhopProtection();
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (getToken()) {
      apiFetch("/api/auth/me").then(d => {
        if (d.user) setUser(d.user); else clearToken();
        setChecking(false);
      }).catch(() => setChecking(false));
    } else setChecking(false);
  }, []);

  if (allowed === null) return null;

  if (checking) return (
    <div style={{minHeight:"100vh",background:"#0a0a0a",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div className="spinner" />
    </div>
  );

  if (!user) return <AuthScreen onAuth={u => setUser(u)} />;
  return <Dashboard user={user} onLogout={() => { clearToken(); setUser(null); }} />;
}

const css = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Mono:ital,wght@0,300;0,400;0,500;1,300&family=DM+Sans:wght@300;400;500;600&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0a0a0a; color: #e8e8e8; font-family: 'DM Sans', sans-serif; -webkit-font-smoothing: antialiased; }
  a { text-decoration: none; color: inherit; -webkit-tap-highlight-color: transparent; }
  select { appearance: none; -webkit-appearance: none; }
  button { cursor: pointer; font-family: inherit; }
  input::placeholder { color: #3a3a3a; }

  :root {
    --red: #e63946;
    --red-dim: rgba(230,57,70,0.12);
    --red-border: rgba(230,57,70,0.25);
    --surface: #111111;
    --surface2: #181818;
    --border: #222222;
    --border2: #2a2a2a;
    --text: #e8e8e8;
    --text2: #888888;
    --text3: #444444;
  }

  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }

  .auth-page {
    min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px;
    background: radial-gradient(ellipse at 30% 40%, rgba(230,57,70,0.06) 0%, transparent 55%),
                radial-gradient(ellipse at 70% 70%, rgba(230,57,70,0.04) 0%, transparent 50%), #0a0a0a;
  }
  .auth-noise { position: fixed; inset: 0; pointer-events: none; opacity: 0.03; background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E"); }
  .auth-card { background: var(--surface); border: 1px solid var(--border2); border-top-color: #333; border-radius: 4px; padding: 40px 32px; width: 100%; max-width: 380px; display: flex; flex-direction: column; gap: 14px; animation: fadeIn 0.4s ease; }
  .auth-header { display: flex; align-items: center; gap: 10px; margin-bottom: 2px; }
  .logo-mark { font-size: 24px; color: var(--red); filter: drop-shadow(0 0 12px rgba(230,57,70,0.5)); }
  .logo-text { font-family: 'DM Mono', monospace; font-size: 16px; font-weight: 500; letter-spacing: 5px; color: white; }
  .auth-sub { font-size: 11px; color: var(--text3); letter-spacing: 1px; margin-bottom: 4px; font-family: 'DM Mono', monospace; }
  .auth-tabs { display: flex; background: #0d0d0d; border-radius: 3px; padding: 3px; border: 1px solid var(--border); }
  .auth-tab { flex: 1; padding: 9px; background: transparent; border: none; color: var(--text3); font-size: 12px; letter-spacing: 1px; transition: all 0.15s; border-radius: 2px; font-family: 'DM Mono', monospace; }
  .auth-tab.active { background: var(--red); color: white; }
  .auth-input { background: #0d0d0d; border: 1px solid var(--border); border-radius: 3px; padding: 12px 14px; color: var(--text); font-size: 13px; font-family: 'DM Mono', monospace; outline: none; transition: border-color 0.15s; letter-spacing: 0.5px; }
  .auth-input:focus { border-color: var(--border2); }
  .auth-error { color: var(--red); font-size: 11px; text-align: center; padding: 8px; background: var(--red-dim); border: 1px solid var(--red-border); border-radius: 3px; font-family: 'DM Mono', monospace; }
  .auth-btn { background: transparent; border: 1px solid var(--red); border-radius: 3px; padding: 13px; color: var(--red); font-size: 11px; font-weight: 500; letter-spacing: 3px; font-family: 'DM Mono', monospace; transition: all 0.15s; }
  .auth-btn:hover { background: var(--red); color: white; }
  .auth-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .dash { min-height: 100vh; position: relative; }
  .dash-noise { position: fixed; inset: 0; pointer-events: none; z-index: 0; opacity: 0.02; background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E"); }

  .header { position: sticky; top: 0; z-index: 100; display: flex; align-items: center; gap: 12px; padding: 0 20px; height: 52px; background: rgba(10,10,10,0.92); border-bottom: 1px solid var(--border); backdrop-filter: blur(20px); }
  .header-brand { display: flex; align-items: center; gap: 8px; }
  .header-mark { font-size: 16px; color: var(--red); filter: drop-shadow(0 0 8px rgba(230,57,70,0.6)); }
  .header-name { font-family: 'DM Mono', monospace; font-size: 12px; font-weight: 500; letter-spacing: 4px; color: white; }
  .header-stats { display: flex; gap: 6px; flex: 1; justify-content: center; }
  .stat-chip { display: flex; align-items: center; gap: 5px; background: var(--surface); border: 1px solid var(--border); border-radius: 20px; padding: 4px 10px; }
  .stat-dot { width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; }
  .dot-green { background: #22c55e; box-shadow: 0 0 6px rgba(34,197,94,0.5); }
  .dot-amber { background: #f59e0b; box-shadow: 0 0 6px rgba(245,158,11,0.5); }
  .stat-val { font-family: 'DM Mono', monospace; font-size: 11px; color: white; font-weight: 500; }
  .stat-lbl { font-size: 10px; color: var(--text3); letter-spacing: 0.5px; }
  .btn-logout { background: transparent; border: 1px solid var(--border); border-radius: 3px; padding: 6px 12px; color: var(--text3); font-size: 11px; letter-spacing: 1px; font-family: 'DM Mono', monospace; transition: all 0.15s; }
  .btn-logout:hover { border-color: var(--border2); color: var(--text2); }

  .hero { padding: 36px 20px 24px; position: relative; z-index: 1; }
  .hero-eyebrow { font-family: 'DM Mono', monospace; font-size: 10px; color: var(--red); letter-spacing: 3px; margin-bottom: 10px; }
  .hero-title { font-size: clamp(36px, 8vw, 60px); font-weight: 300; line-height: 1.05; letter-spacing: -1px; color: white; margin-bottom: 10px; }
  .hero-accent { color: var(--red); font-weight: 600; }
  .hero-sub { font-size: 13px; color: var(--text3); letter-spacing: 0.5px; font-family: 'DM Mono', monospace; }
  .hero-sub strong { color: var(--red); }

  .filter-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 20px; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); background: var(--surface); position: relative; z-index: 10; }

  .btn-filter { display: flex; align-items: center; gap: 6px; background: transparent; border: 1px solid var(--border2); border-radius: 3px; padding: 7px 12px; color: var(--text2); font-size: 12px; letter-spacing: 0.5px; font-family: 'DM Mono', monospace; transition: all 0.15s; }
  .btn-filter:hover, .btn-filter.active { border-color: var(--red); color: var(--red); }
  .filter-count { background: var(--red); color: white; border-radius: 10px; padding: 1px 6px; font-size: 10px; margin-left: 2px; }

  .btn-sort-toggle { display: flex; align-items: center; gap: 6px; background: transparent; border: 1px solid var(--border2); border-radius: 3px; padding: 7px 12px; color: var(--text2); font-size: 12px; letter-spacing: 0.5px; font-family: 'DM Mono', monospace; transition: all 0.15s; }
  .btn-sort-toggle:hover { border-color: var(--border2); color: var(--text2); }
  .btn-sort-toggle.active { border-color: var(--red); color: var(--red); background: var(--red-dim); }
  .sort-toggle-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--red); margin-left: 2px; box-shadow: 0 0 6px rgba(230,57,70,0.6); }

  .sort-group { display: flex; gap: 4px; flex-wrap: wrap; animation: fadeIn 0.15s ease; }
  .btn-sort { background: transparent; border: 1px solid var(--border); border-radius: 3px; padding: 6px 10px; color: var(--text3); font-size: 11px; letter-spacing: 0.5px; font-family: 'DM Mono', monospace; transition: all 0.15s; display: flex; align-items: center; gap: 4px; }
  .btn-sort:hover { border-color: var(--border2); color: var(--text2); }
  .btn-sort.active { border-color: var(--red); color: var(--red); background: var(--red-dim); }
  .sort-arrow { font-size: 10px; }

  .btn-reset { background: transparent; border: 1px solid var(--red-border); border-radius: 3px; padding: 6px 10px; color: var(--red); font-size: 11px; letter-spacing: 0.5px; font-family: 'DM Mono', monospace; transition: all 0.15s; margin-left: auto; }
  .btn-reset:hover { background: var(--red-dim); }

  .active-tags { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 20px; background: #0d0d0d; border-bottom: 1px solid var(--border); }
  .active-tag { background: var(--red-dim); border: 1px solid var(--red-border); color: var(--red); border-radius: 3px; padding: 3px 8px; font-size: 10px; letter-spacing: 0.5px; font-family: 'DM Mono', monospace; }

  .filter-panel { background: var(--surface); border-bottom: 1px solid var(--border); padding: 20px; animation: fadeIn 0.2s ease; position: relative; z-index: 9; }
  .filter-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 14px; margin-bottom: 16px; }
  .filter-section { display: flex; flex-direction: column; gap: 6px; }
  .filter-label { font-family: 'DM Mono', monospace; font-size: 9px; color: var(--text3); letter-spacing: 2px; text-transform: uppercase; }
  .filter-input { background: #0d0d0d; border: 1px solid var(--border); border-radius: 3px; padding: 9px 11px; color: var(--text); font-size: 12px; font-family: 'DM Mono', monospace; outline: none; transition: border-color 0.15s; width: 100%; }
  .filter-input:focus { border-color: var(--border2); }
  .filter-select { background: #0d0d0d; border: 1px solid var(--border); border-radius: 3px; padding: 9px 11px; color: var(--text); font-size: 12px; font-family: 'DM Mono', monospace; outline: none; width: 100%; cursor: pointer; }
  .filter-range { display: flex; align-items: center; gap: 6px; }
  .filter-small { width: calc(50% - 12px); }
  .range-sep { color: var(--text3); font-size: 12px; flex-shrink: 0; }
  .filter-actions { display: flex; gap: 8px; padding-top: 4px; }
  .btn-apply { background: var(--red); border: none; border-radius: 3px; padding: 10px 20px; color: white; font-size: 11px; letter-spacing: 2px; font-family: 'DM Mono', monospace; transition: opacity 0.15s; }
  .btn-apply:hover { opacity: 0.85; }
  .btn-clear { background: transparent; border: 1px solid var(--border2); border-radius: 3px; padding: 10px 16px; color: var(--text2); font-size: 11px; letter-spacing: 1px; font-family: 'DM Mono', monospace; transition: all 0.15s; }
  .btn-clear:hover { border-color: var(--red-border); color: var(--red); }

  .table-head { display: flex; align-items: center; padding: 8px 20px; background: var(--surface); border-bottom: 1px solid var(--border); gap: 10px; position: sticky; top: 52px; z-index: 8; }
  .th-num { width: 32px; flex-shrink: 0; font-family: 'DM Mono', monospace; font-size: 9px; color: var(--text3); letter-spacing: 1px; }
  .th-store { flex: 1; font-family: 'DM Mono', monospace; font-size: 9px; color: var(--text3); letter-spacing: 1px; }
  .th-right { width: 70px; text-align: right; font-family: 'DM Mono', monospace; font-size: 9px; color: var(--text3); letter-spacing: 1px; flex-shrink: 0; }

  .store-list { position: relative; z-index: 1; }
  .store-row { display: flex; align-items: center; gap: 10px; padding: 11px 20px; border-bottom: 1px solid var(--border); transition: background 0.1s; cursor: pointer; }
  .store-row:hover { background: var(--surface); }
  .store-row:hover .row-name { color: white; }
  .row-index { width: 32px; flex-shrink: 0; font-family: 'DM Mono', monospace; font-size: 10px; color: var(--text3); text-align: right; }
  .row-favicon { width: 24px; height: 24px; border-radius: 4px; flex-shrink: 0; border: 1px solid var(--border); background: var(--surface2); }
  .row-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .row-name { font-size: 13px; font-weight: 500; color: #d0d0d0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: color 0.1s; }
  .row-domain { font-family: 'DM Mono', monospace; font-size: 10px; color: var(--text3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row-badges { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 2px; }
  .badge { border-radius: 2px; padding: 2px 5px; font-family: 'DM Mono', monospace; font-size: 9px; letter-spacing: 0.5px; white-space: nowrap; }
  .badge-geo { background: #1a1a2e; color: #6366f1; border: 1px solid #2a2a4a; }
  .badge-cur { background: #1a2a1a; color: #22c55e; border: 1px solid #2a3a2a; }
  .badge-lang { background: #2a1a1a; color: #f59e0b; border: 1px solid #3a2a2a; }
  .badge-prod { background: var(--surface2); color: var(--text2); border: 1px solid var(--border2); }
  .badge-theme { background: var(--red-dim); color: var(--red); border: 1px solid var(--red-border); }
  .row-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex-shrink: 0; width: 60px; }
  .row-year { font-family: 'DM Mono', monospace; font-size: 15px; font-weight: 500; color: var(--red); }
  .row-tld { font-family: 'DM Mono', monospace; font-size: 9px; color: var(--text3); background: var(--surface2); border: 1px solid var(--border); border-radius: 2px; padding: 1px 5px; }

  .state-center { display: flex; align-items: center; justify-content: center; padding: 80px 20px; }
  .state-empty { display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .empty-icon { font-size: 28px; color: var(--text3); }
  .empty-text { font-family: 'DM Mono', monospace; font-size: 11px; color: var(--text3); letter-spacing: 1px; }
  .spinner { width: 28px; height: 28px; border: 1.5px solid var(--border2); border-top-color: var(--red); border-radius: 50%; animation: spin 0.8s linear infinite; }

  .pagination { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 24px 20px; border-top: 1px solid var(--border); }
  .btn-page { background: var(--surface); border: 1px solid var(--border2); border-radius: 3px; padding: 8px 16px; color: var(--text2); font-family: 'DM Mono', monospace; font-size: 12px; transition: all 0.15s; }
  .btn-page:hover:not(:disabled) { border-color: var(--red); color: var(--red); }
  .btn-page:disabled { opacity: 0.25; cursor: not-allowed; }
  .page-info { font-family: 'DM Mono', monospace; font-size: 12px; color: var(--text3); }
  .page-info strong { color: var(--red); }

  .footer { display: flex; justify-content: space-between; padding: 16px 20px; border-top: 1px solid var(--border); font-family: 'DM Mono', monospace; font-size: 9px; color: var(--text3); letter-spacing: 1px; }

  @media (max-width: 600px) {
    .auth-card { padding: 28px 20px; }
    .hero { padding: 24px 16px 16px; }
    .hero-title { font-size: 36px; }
    .filter-bar { padding: 8px 16px; gap: 6px; }
    .filter-panel { padding: 16px; }
    .filter-grid { grid-template-columns: 1fr 1fr; gap: 10px; }
    .table-head, .store-row { padding: 8px 16px; }
    .header { padding: 0 14px; }
    .stat-lbl { display: none; }
    .active-tags { padding: 6px 16px; }
    .sort-group { gap: 3px; }
    .btn-sort { padding: 5px 8px; font-size: 10px; }
    .pagination { padding: 16px; }
    .footer { padding: 12px 16px; flex-direction: column; gap: 4px; }
  }

  @media (max-width: 400px) {
    .filter-grid { grid-template-columns: 1fr; }
    .hero-title { font-size: 30px; }
  }
`;

const styleEl = document.createElement("style");
styleEl.textContent = css;
document.head.appendChild(styleEl);
