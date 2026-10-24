// ===== 🔀 PROXY POOL — "rukna hi na pare" ka asli tod (IP rotation) =====
//
// Asli problem: Swiggy ka WAF / rate-limit IP ko block karta hai, number ko
// nahi. Ek IP par lagatar request = flagged IP = 403 challenge = wait.
//
// tod: multiple proxies (nayi-nayi IPs). Ek proxy blocked → TURANT doosri
// proxy (ZERO wait). Batch sirf STOP / target / time par rukta hai.
//
// Storage: data/db.json → db.proxyPool = { enabled, list: [...] }
//   proxy = { id, label, url, enabled, hits, lastUsedAt, lastErrorAt }
//
// Supported formats:
//   http://host:port
//   http://user:pass@host:port
//   socks5://host:port        (undici ProxyAgent HTTP tunnel ke through chalega)
//   host:port                 (auto http:// prefix)
//
// PROXIES env fallback (comma se alag) — UI add na ho to wahi chalta hai.
//
// IMPORTANT: `aws-waf-token` IP-bound hota hai — har proxy ka apna token +
// apna cooldown state. (swiggy-bridge.js per-proxy token cache rakhta hai.)

import crypto from 'crypto';
import { getDb, saveDb } from './store.js';

// In-memory runtime state (persist NAHI hota — sirf session ke liye)
// id → { token, tokenAt, cooldownUntil, consecutiveErrors, wafHits,
//        lastWafHitAt, wafSolveFailedUntil, wafSolveFailures }
const runtime = new Map();
const PROXY_TOKEN_TTL_MS = 7 * 60_000;

// Parallel autopilot lanes ke liye route reservations: ek proxy ek waqt
// me sirf EK lane ke paas hogi. Ye sirf in-memory coordination hai; proxy
// ki health/token state upar wale runtime map me hi rehti hai.
const proxyReservations = new Map(); // proxyId -> owner

export function reserveProxy(id, owner) {
  const proxyId = String(id || '');
  const ownerId = String(owner || '');
  if (!proxyId || !ownerId) return false;
  const currentOwner = proxyReservations.get(proxyId);
  if (currentOwner && currentOwner !== ownerId) return false;
  proxyReservations.set(proxyId, ownerId);
  return true;
}

export function releaseProxyReservation(id, owner = '') {
  const proxyId = String(id || '');
  if (!proxyId) return false;
  const ownerId = String(owner || '');
  if (ownerId && proxyReservations.get(proxyId) !== ownerId) return false;
  return proxyReservations.delete(proxyId);
}

export function releaseProxyReservationsForOwner(owner) {
  const ownerId = String(owner || '');
  if (!ownerId) return 0;
  let released = 0;
  for (const [proxyId, currentOwner] of [...proxyReservations.entries()]) {
    if (currentOwner === ownerId) {
      proxyReservations.delete(proxyId);
      released++;
    }
  }
  return released;
}

export function getProxyReservationOwner(id) {
  return proxyReservations.get(String(id || '')) || '';
}

export function _clearProxyReservations() {
  proxyReservations.clear();
}

function runtimeFor(id) {
  const rt = runtime.get(id) || {};
  runtime.set(id, rt);
  return rt;
}

function hasFreshProxyToken(rt) {
  return Boolean(rt?.token && (Date.now() - (Number(rt.tokenAt) || 0) <= PROXY_TOKEN_TTL_MS));
}

function loadState() {
  const db = getDb();
  if (!db.proxyPool || typeof db.proxyPool !== 'object') {
    db.proxyPool = { enabled: false, list: [] };
  }
  if (!Array.isArray(db.proxyPool.list)) db.proxyPool.list = [];
  return db.proxyPool;
}

function persist(state) {
  const db = getDb();
  db.proxyPool = state;
  saveDb(db);
}

// ---------------------------------------------------------------------------
// Parse / validate
// ---------------------------------------------------------------------------
export function parseProxyUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    if (!u.hostname) return null;
    if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(u.protocol)) return null;
    if (!Number.isFinite(Number(u.port)) || Number(u.port) <= 0) return null;
    return {
      url: u.toString().replace(/\/$/, ''),
      host: u.hostname,
      port: Number(u.port),
      auth: u.username ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password || '')}` : '',
      label: `${u.hostname}:${u.port}`,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CRUD (firebase-sources.js jaisa pattern)
// ---------------------------------------------------------------------------
function ensureSeeded() {
  const state = loadState();
  if (state.list.length) return state;

  // PROXIES env fallback — comma separated
  const envList = String(process.env.PROXIES || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  for (const raw of envList) {
    const p = parseProxyUrl(raw);
    if (p) {
      state.list.push({
        id: crypto.randomUUID().slice(0, 8),
        label: p.label,
        url: p.url,
        enabled: true,
        hits: 0,
        addedAt: new Date().toISOString(),
      });
    }
  }
  if (state.list.length) persist(state);
  return state;
}

export function isEnabled() {
  const state = ensureSeeded();
  return Boolean(state.enabled && state.list.some((p) => p.enabled));
}

export function listProxies() {
  const state = ensureSeeded();
  const now = Date.now();
  return state.list.map((p) => {
    const rt = runtime.get(p.id) || {};
    const cdUntil = Number(rt.cooldownUntil) || 0;
    const solveFailedUntil = Number(rt.wafSolveFailedUntil) || 0;
    return {
      ...p,
      active: p.enabled,
      tokenReady: hasFreshProxyToken(rt),
      cooldownLeftMs: Math.max(0, cdUntil - now),
      wafSolveCooldownLeftMs: Math.max(0, solveFailedUntil - now),
      wafHits: Number(rt.wafHits) || 0,
      lastWafHitAt: rt.lastWafHitAt || '',
      wafSolveFailures: Number(rt.wafSolveFailures) || 0,
      consecutiveErrors: Number(rt.consecutiveErrors) || 0,
      reservedBy: proxyReservations.get(p.id) || '',
    };
  });
}

export function addProxy(raw, { label = '' } = {}) {
  const p = parseProxyUrl(raw);
  if (!p) return { ok: false, error: 'Proxy format galat hai. Sahi: host:port ya http://user:pass@host:port' };
  const state = ensureSeeded();
  if (state.list.some((x) => x.url === p.url)) return { ok: false, error: 'Ye proxy pehle se added hai.' };
  const entry = {
    id: crypto.randomUUID().slice(0, 8),
    label: String(label || '').trim() || p.label,
    url: p.url,
    enabled: true,
    hits: 0,
    addedAt: new Date().toISOString(),
  };
  state.list.push(entry);
  state.enabled = true; // proxy add karte hi pool ON
  persist(state);
  return { ok: true, proxy: entry };
}

export function removeProxy(id) {
  const state = ensureSeeded();
  const idx = state.list.findIndex((p) => p.id === id);
  if (idx === -1) return { ok: false, error: 'Proxy nahi mila.' };
  state.list.splice(idx, 1);
  runtime.delete(id);
  proxyReservations.delete(id);
  persist(state);
  return { ok: true };
}

export function toggleProxy(id) {
  const state = ensureSeeded();
  const p = state.list.find((x) => x.id === id);
  if (!p) return { ok: false, error: 'Proxy nahi mila.' };
  p.enabled = !p.enabled;
  persist(state);
  return { ok: true, enabled: p.enabled };
}

export function setPoolEnabled(on) {
  const state = ensureSeeded();
  state.enabled = Boolean(on);
  persist(state);
  return { ok: true, enabled: state.enabled };
}

// ---------------------------------------------------------------------------
// Assignment — sabse kam use hui enabled proxy (round-robin-ish)
// ---------------------------------------------------------------------------
let lastAssignedId = '';

export function pickProxy({ excludeIds = [], requireToken = false, reserveFor = '' } = {}) {
  const state = ensureSeeded();
  if (!state.enabled) return null;
  const now = Date.now();
  const reserveOwner = String(reserveFor || '');
  const baseCandidates = state.list.filter(
    (p) => p.enabled && !excludeIds.includes(p.id) &&
      (!proxyReservations.has(p.id) || proxyReservations.get(p.id) === reserveOwner) &&
      !((Number(runtime.get(p.id)?.cooldownUntil) || 0) > now) &&
      (Number(runtime.get(p.id)?.consecutiveErrors) || 0) < 3 &&
      (!requireToken || hasFreshProxyToken(runtime.get(p.id) || {}))
  );
  if (!baseCandidates.length) return null;

  // Jis proxy par WAF token solve abhi-abhi fail hua hai, use turant dobara
  // route bana kar full Chromium solver phir se chalana minutes zaya karta
  // hai. Doosre candidates hon to use side par rakho; koi aur na ho tabhi lo.
  const solveReady = baseCandidates.filter(
    (p) => !((Number(runtime.get(p.id)?.wafSolveFailedUntil) || 0) > now)
  );
  const candidates = solveReady.length ? solveReady : baseCandidates;

  // Route quality — sirf round-robin kafi nahi. Pehle wo route jo asal me
  // OTP bhej sakne ke sab se qareeb hai:
  //   clean/manual → fresh per-proxy WAF token → Indian IP → kam WAF hits
  //   → kam latency → phir purani tokenAt/least-hits rotation.
  const qualityRank = (p) => (p?.quality === 'challenged' ? 1 : 0);
  const tokenRank = (p) => (hasFreshProxyToken(runtime.get(p.id) || {}) ? 0 : 1);
  const countryRank = (p) => (String(p?.country || '').toUpperCase() === 'IN' ? 0 : 1);
  candidates.sort((a, b) => {
    const ra = runtime.get(a.id) || {};
    const rb = runtime.get(b.id) || {};
    return qualityRank(a) - qualityRank(b) ||
      tokenRank(a) - tokenRank(b) ||
      countryRank(a) - countryRank(b) ||
      (Number(ra.wafHits) || 0) - (Number(rb.wafHits) || 0) ||
      (Number(ra.wafSolveFailures) || 0) - (Number(rb.wafSolveFailures) || 0) ||
      (Number(a.latencyMs) || 99999) - (Number(b.latencyMs) || 99999) ||
      (Number(ra.tokenAt) || 0) - (Number(rb.tokenAt) || 0) ||
      (a.hits || 0) - (b.hits || 0);
  });
  const pick = candidates[0];
  if (reserveOwner && !reserveProxy(pick.id, reserveOwner)) return null;
  lastAssignedId = pick.id;
  pick.hits = (pick.hits || 0) + 1;
  pick.lastUsedAt = new Date().toISOString();
  persist(state);
  const parsed = parseProxyUrl(pick.url);
  return { ...pick, ...parsed, reservedFor: reserveOwner };
}

export function getProxy(id) {
  const state = ensureSeeded();
  const p = state.list.find((x) => x.id === id);
  if (!p) return null;
  return { ...p, ...parseProxyUrl(p.url) };
}

// ---------------------------------------------------------------------------
// Per-proxy WAF token + cooldown (aws-waf-token IP-bound hota hai)
// ---------------------------------------------------------------------------
export function getProxyToken(id) {
  const rt = runtime.get(id);
  if (!hasFreshProxyToken(rt)) return '';
  return rt.token;
}

export function setProxyToken(id, token) {
  if (!token) return;
  const rt = runtimeFor(id);
  rt.token = String(token);
  rt.tokenAt = Date.now();
  rt.wafSolveFailedUntil = 0;
  rt.wafSolveFailures = 0;
  rt.lastWafSolveAt = new Date().toISOString();
}

export function invalidateProxyToken(id) {
  const rt = runtime.get(id);
  if (rt) {
    delete rt.token;
    rt.tokenAt = 0;
  }
}

export function markProxyWafHit(id, cooldownMs = 60_000) {
  if (!id) return;
  const rt = runtimeFor(id);
  rt.cooldownUntil = Date.now() + (Number(cooldownMs) || 0);
  rt.wafHits = (Number(rt.wafHits) || 0) + 1;
  rt.lastWafHitAt = new Date().toISOString();
  delete rt.token; // purana token IP ke saath reject hua
  rt.tokenAt = 0;
}

// Chromium is proxy par aws-waf-token nahi bana paya — kuch der is route ko
// solver ke liye side par rakho. Warna har rotate/OTP par wahi 30-90s ka
// full solver chal kar batch ko sust kar deta hai.
export function markProxyWafSolveFailure(id, cooldownMs = 10 * 60_000) {
  if (!id) return;
  const rt = runtimeFor(id);
  rt.wafSolveFailedUntil = Date.now() + (Number(cooldownMs) || 0);
  rt.wafSolveFailures = (Number(rt.wafSolveFailures) || 0) + 1;
  rt.lastWafSolveAt = new Date().toISOString();
  delete rt.token;
  rt.tokenAt = 0;
}

export function proxyWafSolveCooldownLeftMs(id) {
  const until = Number(runtime.get(id)?.wafSolveFailedUntil) || 0;
  return Math.max(0, until - Date.now());
}

export function getProxyRouteState(id) {
  const rt = runtime.get(id) || {};
  const now = Date.now();
  return {
    tokenReady: hasFreshProxyToken(rt),
    cooldownLeftMs: Math.max(0, (Number(rt.cooldownUntil) || 0) - now),
    wafSolveCooldownLeftMs: Math.max(0, (Number(rt.wafSolveFailedUntil) || 0) - now),
    wafHits: Number(rt.wafHits) || 0,
    wafSolveFailures: Number(rt.wafSolveFailures) || 0,
    consecutiveErrors: Number(rt.consecutiveErrors) || 0,
  };
}

export function markProxyError(id) {
  const rt = runtime.get(id) || {};
  rt.consecutiveErrors = (Number(rt.consecutiveErrors) || 0) + 1;
  rt.lastErrorAt = new Date().toISOString();
  runtime.set(id, rt);
}

export function markProxySuccess(id) {
  const rt = runtime.get(id) || {};
  rt.consecutiveErrors = 0;
  runtime.set(id, rt);
}

// ---------------------------------------------------------------------------
// Fetch wrapper — Swiggy ka traffic active proxy se guzarta hai.
// Proxy OFF/na-setup ho to plain fetch (backward compatible).
// ---------------------------------------------------------------------------
let _dispatcherCache = new Map(); // proxyUrl → undici agent
let _undiciPromise = null;

async function getUndici() {
  if (!_undiciPromise) _undiciPromise = import('undici');
  return _undiciPromise;
}

// ⚠️ ROOT-CAUSE FIX (free proxies 0 bug): npm `undici@8` ke agents Node ke
// global fetch (andar bundled purani undici) ke saath compatible NAHI hain —
// global fetch har proxied request ko network se pehle hi
// "UND_ERR_INVALID_ARG: invalid onRequestStart method" se gira deta tha.
// Isi liye har proxy health-check dead count hua aur pool 0 raha. Dispatcher
// hamesha usi package ke `undici.fetch` ke saath use karo.
async function fetchWithDispatcher(url, opts = {}, dispatcher) {
  const undici = await getUndici();
  if (typeof undici.fetch !== 'function') {
    throw new Error('undici.fetch available nahi — proxy request nahi ho sakti');
  }
  return undici.fetch(url, { ...opts, dispatcher });
}

// Kaunsa undici agent lagega — protocol par nirbhar hai:
//   http/https → ProxyAgent · socks5 → Socks5ProxyAgent · socks4 → unsupported
// PEHLA BUG: socks5 proxy ko bhi HTTP ProxyAgent de diya jata tha, jo
// request-time par fail hota — user ko lagta "proxy add kiya phir bhi bot
// work nahi kar raha".
export function dispatcherKind(rawUrl) {
  let proto = '';
  try { proto = new URL(String(rawUrl || '')).protocol; } catch { return 'unsupported'; }
  if (proto === 'http:' || proto === 'https:') return 'http';
  if (proto === 'socks5:' || proto === 'socks5h:') return 'socks5';
  return 'unsupported';
}

async function getDispatcherFor(proxy) {
  if (!proxy?.url) return null;
  const existing = _dispatcherCache.get(proxy.url);
  if (existing) return existing;
  const kind = dispatcherKind(proxy.url);
  if (kind === 'unsupported') {
    throw new Error(`Proxy protocol supported nahi (${proxy.url.split(':')[0]}:) — http:// ya socks5:// proxy use karo.`);
  }
  const undici = await getUndici();
  let agent;
  if (kind === 'socks5') {
    agent = new undici.Socks5ProxyAgent(proxy.url);
  } else {
    agent = new undici.ProxyAgent({
      uri: proxy.url,
      ...(proxy.auth ? { token: `Basic ${Buffer.from(proxy.auth).toString('base64')}` } : {}),
    });
  }
  _dispatcherCache.set(proxy.url, agent);
  return agent;
}

/**
 * fetchSwiggy(url, opts, proxy)
 *   proxy = pickProxy() ka return (ya null)
 *   → undici ProxyAgent se swiggy.com request
 *
 * ⚠️ STICKY ROUTE: network error par yahan chup-chaap doosri proxy se retry
 * NAHI hota. Pehle hota tha — lekin session cookies/CSRF/WAF token pehli IP
 * ke liye bante the aur asal request doosri IP se ja kar mismatch/challenge
 * khaati thi; POST ka outcome bhi ambiguous ho jata tha. Rotation ab sirf
 * bridge/engine ki explicit recovery karegi, jahan naya token/session route
 * ke hisaab se banta hai.
 */
export async function fetchSwiggy(url, opts = {}, proxy = null) {
  if (!proxy?.url) return fetch(url, opts);
  try {
    const dispatcher = await getDispatcherFor(proxy);
    const res = await fetchWithDispatcher(url, opts, dispatcher);
    markProxySuccess(proxy.id);
    return res;
  } catch (e) {
    markProxyError(proxy.id);
    throw e;
  }
}

// Puppeteer ke liye --proxy-server arg string
export function puppeteerProxyArgs(proxy) {
  if (!proxy?.url) return [];
  const u = new URL(proxy.url);
  return [`--proxy-server=${u.protocol}//${u.hostname}:${u.port}`];
}

export function puppeteerProxyAuth(page, proxy) {
  if (!proxy?.auth) return Promise.resolve();
  const [user, pass] = proxy.auth.split(':');
  return page.authenticate({ username: user || '', password: pass || '' }).catch(() => {});
}

// ---------------------------------------------------------------------------
// 🌐 FREE PROXIES AUTO-FETCH — "proxy kahan se laoon?" ka tod
//
// Boss ke paas paid proxies/card nahi hai. Isliye bot khud kai public free
// proxy lists se candidates laata hai, har ek ko pehle generic HTTPS phir
// seedha swiggy.com par TEST karta hai. Clean proxies pehle; Swiggy tak
// pohanchne wali lekin WAF-challenged proxies fallback tier me rehti hain
// kyunki browser usi IP ka token solve kar sakta hai.
//
// Sach ye hai ke free proxies zyadatar dead/slow hoti hain — isliye
// health-check hi is feature ki jaaaan hai. Jo pass ho jaye wo WAF/rate-limit
// par rotation de deti hai (ek garam IP = turant doosri IP, zero wait).
// Manual (boss ki add ki hui) proxies ko kabhi haath nahi lagta — auto
// entries `auto:true` tag se alag rehti hain, refresh par wahin replace
// hoti hain jo ab zinda nahi.
//
// Knobs:
//   PREMIUM_AUTO_FREE_PROXIES=0  → auto-fetch OFF (default ON)
//   PREMIUM_PROXY_SOURCES=<url>[,<url>] → apni list URLs defaults ke saath merge hongi
//     (JSON {proxies:[{proxy,...}]}/array ya text lines "proto://ip:port")
// ---------------------------------------------------------------------------

// Free public sources — bina signup/key. Ek hi source par bharosa nahi:
// ProxyScrape API kabhi shared hosting IPs ko rate-limit kar sakta hai, is liye
// uske GitHub/CDN shards + doosri maintained public lists bhi parallel fetch
// karke candidates MERGE hote hain. `PREMIUM_PROXY_SOURCES` wale custom URLs
// in sab se pehle rehte hain.
const PROXYSCRAPE_JSON =
  'https://api.proxyscrape.com/v4/free-proxy-list/get?request=displayproxies&proxy_format=protocolipport&format=json&ssl=yes&protocol=http,socks5&timeout=5000&anonymity=elite,anonymous&limit=400';
const PROXYSCRAPE_JSON_IN =
  'https://api.proxyscrape.com/v4/free-proxy-list/get?request=displayproxies&proxy_format=protocolipport&format=json&ssl=yes&protocol=http,socks5&country=in&timeout=10000&limit=100';
const FREE_PROXY_SOURCES_DEFAULT = [
  PROXYSCRAPE_JSON,
  PROXYSCRAPE_JSON_IN,
  // ProxyScrape ke static GitHub shards (API rate-limit ka fallback).
  'https://cdn.jsdelivr.net/gh/proxyscrape/free-proxy-list@main/proxies/countries/in/data.json',
  'https://cdn.jsdelivr.net/gh/proxyscrape/free-proxy-list@main/proxies/protocols/https/data.json',
  'https://cdn.jsdelivr.net/gh/proxyscrape/free-proxy-list@main/proxies/protocols/http/data.json',
  // maintained bare ip:port lists — protocol source path se infer hota hai.
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt',
  'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt',
  'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-socks5.txt',
  // Proxifly ka SIRF India subset (poori all-list bahut badi hai).
  'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/countries/IN/data.json',
];

export function freeProxiesEnabled() {
  if (String(process.env.PREMIUM_AUTO_FREE_PROXIES || '') === '0') return false;
  try { return loadState().autoFree !== false; } catch { return true; }
}

export function setAutoFree(on) {
  const state = ensureSeeded();
  state.autoFree = Boolean(on);
  persist(state);
  return { ok: true, autoFree: state.autoFree };
}

export function freeProxySourceUrls() {
  const extra = String(process.env.PREMIUM_PROXY_SOURCES || '')
    .split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  return [...extra, ...FREE_PROXY_SOURCES_DEFAULT];
}

// Har mashhoor free-list JSON shape → saleeqe ke candidates:
//   • ProxyScrape API: { proxies:[{ proxy, ip_data{countryCode,hosting}, uptime, average_timeout, anonymity, ssl }] }
//   • ProxyScrape GitHub shards: [{ protocol, ip, port, country_code, uptime_percent, latency_ms, anonymity, ssl }]
//   • Proxifly: [{ proxy, protocol, geolocation{country}, score, https, anonymity }]
// Sirf wahi protocol jo hamare dispatcher chala sakte hain (http/https/socks5
// — socks4 unsupported hai).
export function _parseFreeProxyListJson(json) {
  const arr = Array.isArray(json?.proxies) ? json.proxies : (Array.isArray(json) ? json : []);
  const out = [];
  for (const raw of arr) {
    const p = typeof raw === 'string' ? { proxy: raw } : raw;
    const url = String(p?.proxy || (p?.ip && p?.port ? `${p.protocol || 'http'}://${p.ip}:${p.port}` : '')).trim();
    const parsed = parseProxyUrl(url);
    if (!parsed) continue;
    if (dispatcherKind(parsed.url) === 'unsupported') continue; // socks4 waghera bahar
    if (p?.alive === false) continue;
    const timeoutMs = Number(
      p?.average_timeout ?? p?.latency_ms ?? p?.timeout ?? p?.latency
    ) || 99999;
    out.push({
      url: parsed.url,
      country: String(
        p?.ip_data?.countryCode || p?.country_code || p?.countryCode ||
        p?.geolocation?.country || p?.country || ''
      ).toUpperCase().slice(0, 2),
      hosting: p?.ip_data?.hosting === true,
      uptime: Number(p?.uptime ?? p?.uptime_percent) || 0,
      avgTimeoutMs: timeoutMs,
      anonymity: String(p?.anonymity || '').toLowerCase(),
      ssl: typeof p?.ssl === 'boolean' ? p.ssl : (typeof p?.https === 'boolean' ? p.https : null),
      score: Number(p?.score) || 0,
    });
  }
  return out;
}

// Text list fallback — har line "proto://ip:port" (ya bare ip:port).
// Kuch lists (monosans/jetkai) sirf bare ip:port deti hain aur protocol
// file ke naam me hota hai (`socks5.txt`) — caller `defaultProtocol` dega,
// warna har socks5 galti se http ban jayegi aur health-check fail hoga.
export function _parseFreeProxyListText(text, { defaultProtocol = 'http', country = '' } = {}) {
  const out = [];
  const proto = String(defaultProtocol || 'http').toLowerCase().replace(/:.*$/, '');
  for (const line of String(text || '').split(/\r?\n/)) {
    let raw = line.trim();
    if (!raw || raw.startsWith('#')) continue;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `${proto}://${raw}`;
    const parsed = parseProxyUrl(raw);
    if (!parsed) continue;
    if (dispatcherKind(parsed.url) === 'unsupported') continue;
    out.push({
      url: parsed.url,
      country: String(country || '').toUpperCase().slice(0, 2),
      hosting: false,
      uptime: 0,
      avgTimeoutMs: 99999,
      anonymity: '',
      ssl: null,
      score: 0,
    });
  }
  return out;
}

// Ranking — pehle wo jo Swiggy par sab se zyada kaam ke hone ki umeed hai.
// Score: Indian IP + SSL/CONNECT support + elite anonymity + uptime +
// non-hosting ko bonus; hosting/transparent/high-latency ko penalty.
// Ek hi proxy kai sources me mile to metadata merge + corroboration bonus.
// Last me per-IP diversity: ek hi host ke 40 ports upar ghus kar probe
// budget zaya na karein — pehle har IP ka best candidate, phir doosra, ...
function _freeCandidateScore(c) {
  let score = 0;
  if (c.country === 'IN') score += 35;
  if (c.ssl === true) score += 12;
  if (c.ssl === false && /^https?:\/\//i.test(c.url)) score -= 8;
  if (c.anonymity === 'elite') score += 14;
  else if (c.anonymity === 'anonymous') score += 8;
  else if (c.anonymity === 'transparent') score -= 10;
  score += Math.min(45, Math.max(0, Number(c.uptime) || 0) * 0.45);
  score += Math.min(8, Math.max(0, Number(c.score) || 0));
  score += Math.min(10, Math.max(0, (Number(c.sourceCount) || 1) - 1) * 5);
  if (c.hosting) score -= 12;
  const t = Number(c.avgTimeoutMs) || 99999;
  if (t < 99999) score -= Math.min(18, t / 500); // 0ms→0, 9s→-18
  return score;
}

export function _rankFreeCandidates(cands = []) {
  const byUrl = new Map();
  for (const c of cands || []) {
    if (!c?.url) continue;
    const prev = byUrl.get(c.url);
    if (!prev) {
      byUrl.set(c.url, { ...c, sourceCount: Math.max(1, Number(c.sourceCount) || 1) });
      continue;
    }
    prev.sourceCount = (Number(prev.sourceCount) || 1) + Math.max(1, Number(c.sourceCount) || 1);
    if (!prev.country && c.country) prev.country = c.country;
    if (!prev.anonymity && c.anonymity) prev.anonymity = c.anonymity;
    if (prev.ssl !== true && typeof c.ssl === 'boolean') prev.ssl = c.ssl;
    prev.uptime = Math.max(Number(prev.uptime) || 0, Number(c.uptime) || 0);
    prev.score = Math.max(Number(prev.score) || 0, Number(c.score) || 0);
    prev.avgTimeoutMs = Math.min(Number(prev.avgTimeoutMs) || 99999, Number(c.avgTimeoutMs) || 99999);
    prev.hosting = Boolean(prev.hosting || c.hosting);
  }
  const sorted = [...byUrl.values()].sort((a, b) =>
    (_freeCandidateScore(b) - _freeCandidateScore(a)) ||
    ((b.uptime || 0) - (a.uptime || 0)) ||
    ((a.avgTimeoutMs || 99999) - (b.avgTimeoutMs || 99999))
  );
  // Per-host round-robin diversity (best port per IP pehle).
  const hostOf = (url) => { try { return new URL(url).hostname; } catch { return url; } };
  const out = [];
  const placed = new Set();
  for (let cap = 1; out.length < sorted.length && cap <= 4; cap++) {
    const hostCounts = new Map();
    for (const c of sorted) {
      if (placed.has(c.url)) continue;
      const h = hostOf(c.url);
      const n = hostCounts.get(h) || 0;
      if (n >= cap) continue;
      hostCounts.set(h, n + 1);
      placed.add(c.url);
      out.push(c);
    }
  }
  for (const c of sorted) if (!placed.has(c.url)) out.push(c);
  return out;
}

// Ek proxy ko do marhala me parkho (temp dispatcher, kaam ke baad band):
//   1) generic HTTPS target (gstatic 204) — proxy asal me zinda + CONNECT /
//      SOCKS tunnel kaam karta hai ya proxy-generated nakli jawab hai?
//   2) seedha swiggy.com — Swiggy tak pohanchta hai ya nahi?
// Quality tiers:
//   • clean      → Swiggy normal jawab (no challenge) — first choice
//   • challenged → Swiggy WAF challenge de raha hai LEKIN IP pohanch raha
//                  hai; browser aws-waf-token solve karke yahi IP aksar kaam
//                  kar jati hai, is liye fallback tier me rakhenge — pehle
//                  wali galti yehi thi ke in sab ko "dead" phenk dete the.
//   • dead       → generic/Swiggy dono par network fail, 407 auth, ya 5xx.
export async function checkProxyOnce(url, {
  timeoutMs = 8000,
  target = 'https://www.swiggy.com/',
  genericTarget = 'https://www.gstatic.com/generate_204',
} = {}) {
  const started = Date.now();
  let agent = null;
  const ua = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' };
  const reasonOf = (e) => String(e?.cause?.code || e?.cause?.message || e?.message || e).slice(0, 80);
  try {
    const kind = dispatcherKind(url);
    if (kind === 'unsupported') return { ok: false, quality: 'dead', reachable: false, latencyMs: 0, reason: 'unsupported' };
    const undici = await getUndici();
    agent = kind === 'socks5' ? new undici.Socks5ProxyAgent(url) : new undici.ProxyAgent({ uri: url });

    // Marhala 1 — generic zinda test (chhota timeout, dead jaldi bahar).
    let genericStatus = 0;
    if (genericTarget) {
      try {
        const g = await undici.fetch(genericTarget, {
          dispatcher: agent,
          headers: ua,
          signal: AbortSignal.timeout(Math.min(5000, Math.max(1500, Number(timeoutMs) || 8000))),
        });
        genericStatus = g.status;
        try { await g.body?.cancel?.(); } catch {}
        if (genericStatus === 407 || genericStatus >= 500) {
          return { ok: false, quality: 'dead', reachable: false, latencyMs: Date.now() - started, genericStatus, reason: `generic HTTP ${genericStatus}` };
        }
      } catch (e) {
        return { ok: false, quality: 'dead', reachable: false, latencyMs: Date.now() - started, genericStatus, reason: reasonOf(e) };
      }
    }

    // Marhala 2 — asal Swiggy test.
    const swiggyStarted = Date.now();
    const res = await undici.fetch(target, {
      dispatcher: agent,
      headers: ua,
      signal: AbortSignal.timeout(Number(timeoutMs) || 8000),
    });
    const latencyMs = Date.now() - swiggyStarted;
    const wafHeader = typeof res.headers?.get === 'function' ? (res.headers.get('x-amzn-waf-action') || '') : '';
    let challenged = Boolean(wafHeader);
    if (!challenged && res.status === 403) {
      const sample = (await res.text().catch(() => '')).slice(0, 4000).toLowerCase();
      challenged = /awswaf|captcha|challenge|verify you are human|automated traffic/.test(sample);
    } else {
      // Homepage ki poori body download karna zaya hai — headers kaafi hain.
      try { await res.body?.cancel?.(); } catch {}
    }
    if (res.status === 407 || res.status >= 500) {
      return {
        ok: false, quality: 'dead', reachable: false, latencyMs,
        status: res.status, genericStatus, challenged,
        reason: `Swiggy HTTP ${res.status}`,
      };
    }
    const quality = challenged ? 'challenged' : 'clean';
    return { ok: true, quality, reachable: true, latencyMs, status: res.status, genericStatus, challenged };
  } catch (e) {
    return { ok: false, quality: 'dead', reachable: false, latencyMs: Date.now() - started, reason: reasonOf(e) };
  } finally {
    try { await agent?.close?.(); } catch {}
    try { agent?.destroy?.(); } catch {}
  }
}

// Candidates ko parallel parkho. Clean proxies ka target `want` pura hote
// hi naye probe band; challenged wali side par jama hoti rehti hain aur
// clean kam padne par unhi se quota bharte hain (clean hamesha pehle).
// Ek overall deadline bhi hai taaki manual refresh hamesha ke liye na latke.
// Returns { good, checked, cleanCount, challengedCount, stats, elapsedMs }
export async function probeFreeCandidates(cands = [], {
  want = 8, concurrency = 24, timeoutMs = 8000, maxProbe = 320,
  deadlineMs = 75_000, check = null, onProgress = null,
} = {}) {
  const startedAt = Date.now();
  const deadline = deadlineMs > 0 ? startedAt + Number(deadlineMs) : Infinity;
  const list = (cands || []).slice(0, Math.max(1, maxProbe));
  const clean = [];
  const challenged = [];
  const reasons = new Map();
  let checked = 0;
  let i = 0;
  const fn = typeof check === 'function' ? check : (c) => checkProxyOnce(c.url, { timeoutMs });
  const emit = () => {
    if (!onProgress) return;
    try {
      onProgress({
        checked,
        good: Math.min(want, clean.length + challenged.length),
        clean: clean.length,
        challenged: challenged.length,
        total: list.length,
      });
    } catch {}
  };
  const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, list.length || 1));
  const workers = Array.from({ length: workerCount }, async () => {
    while (i < list.length && clean.length < want && Date.now() < deadline) {
      const cand = list[i++];
      const r = await fn(cand).catch((e) => ({ ok: false, reason: String(e?.message || e) }));
      checked++;
      const quality = r?.quality || (r?.ok ? (r?.challenged ? 'challenged' : 'clean') : 'dead');
      if (r?.ok && quality === 'clean') {
        clean.push({ ...cand, latencyMs: Number(r.latencyMs) || 0, status: r.status, quality: 'clean' });
      } else if (r?.ok && quality === 'challenged') {
        challenged.push({ ...cand, latencyMs: Number(r.latencyMs) || 0, status: r.status, quality: 'challenged' });
      } else {
        const reason = String(r?.reason || (r?.status ? `HTTP ${r.status}` : 'dead')).slice(0, 60) || 'dead';
        reasons.set(reason, (reasons.get(reason) || 0) + 1);
      }
      emit();
    }
  });
  await Promise.all(workers);
  const byLatency = (a, b) => (a.latencyMs || 99999) - (b.latencyMs || 99999);
  clean.sort(byLatency);
  challenged.sort(byLatency);
  const orderedReasons = [...reasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({ reason, count }));
  return {
    good: [...clean, ...challenged].slice(0, Math.max(1, want)),
    checked,
    cleanCount: clean.length,
    challengedCount: challenged.length,
    stats: {
      checked,
      clean: clean.length,
      challenged: challenged.length,
      dead: Math.max(0, checked - clean.length - challenged.length),
      reasons: orderedReasons,
    },
    elapsedMs: Date.now() - startedAt,
  };
}

function _freeSourceHints(src) {
  const s = String(src || '').toLowerCase();
  let defaultProtocol = 'http';
  if (/socks5/.test(s)) defaultProtocol = 'socks5';
  const countryMatch = s.match(/\/countries\/([a-z]{2})(?:\/|[?&#]|$)/);
  return {
    defaultProtocol,
    country: countryMatch ? countryMatch[1].toUpperCase() : '',
  };
}

async function fetchFreeProxyCandidates({ fetchImpl = null } = {}) {
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  const sources = freeProxySourceUrls();
  // Sab sources PARALLEL — pehle nonempty par rukna purani kamzori thi:
  // ek source ne 200 murda candidates de diye to behtar sources kabhi try
  // hi nahi hote the. Ab sab merge + dedupe/rank hote hain.
  const settled = await Promise.allSettled(sources.map(async (src) => {
    const res = await doFetch(src, { signal: AbortSignal.timeout(15_000) });
    if (!res?.ok) throw new Error(`HTTP ${res?.status || '?'}`);
    const body = await res.text();
    if (!body || body.length > 10_000_000) throw new Error(body ? 'source bahut bada' : 'empty body');
    const hints = _freeSourceHints(src);
    let cands = [];
    const trimmed = body.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { cands = _parseFreeProxyListJson(JSON.parse(body)); } catch { cands = []; }
    }
    if (!cands.length) cands = _parseFreeProxyListText(body, hints);
    for (const c of cands) {
      if (!c.country && hints.country) c.country = hints.country;
      c.sourceUrl = src;
    }
    return { src, cands };
  }));

  const all = [];
  const sourceStats = [];
  for (let idx = 0; idx < settled.length; idx++) {
    const src = sources[idx];
    const item = settled[idx];
    if (item.status === 'fulfilled') {
      all.push(...item.value.cands);
      sourceStats.push({ source: src, count: item.value.cands.length, ok: item.value.cands.length > 0 });
    } else {
      sourceStats.push({
        source: src,
        count: 0,
        ok: false,
        error: String(item.reason?.cause?.code || item.reason?.message || item.reason).slice(0, 80),
      });
    }
  }
  const firstGood = sourceStats.find((s) => s.count > 0);
  return {
    cands: all,
    source: firstGood?.source || '',
    sources: sourceStats,
    sourcesOk: sourceStats.filter((s) => s.count > 0).length,
    sourcesTotal: sourceStats.length,
  };
}

let _freeRefreshPromise = null;

// Pool ki auto entries ko taazi verified free proxies se badal do.
// Purani auto entries pehle re-verify hongi (zinda hain to wahi id/token
// continuity ke saath reh jayengi). Manual proxies untouched.
export async function refreshFreeProxies({
  want = 8, concurrency = 24, timeoutMs = 8000, maxProbe = 320,
  deadlineMs = 75_000,
  fetchImpl = null, check = null, onProgress = null,
} = {}) {
  if (_freeRefreshPromise) return _freeRefreshPromise;
  _freeRefreshPromise = (async () => {
    try {
      const state = ensureSeeded();
      const existingAuto = state.list.filter((p) => p.auto);
      const existingByUrl = new Map(existingAuto.map((p) => [p.url, p]));

      const fetched = await fetchFreeProxyCandidates({ fetchImpl });
      const { cands, source } = fetched;
      // Purani zinda autos sab se pehle parkho (unke paas WAF token bhi ho sakta hai)
      const oldFirst = existingAuto.map((p) => ({
        url: p.url,
        country: p.country || '',
        hosting: false,
        uptime: 100,
        avgTimeoutMs: 1,
        ssl: true,
        anonymity: 'elite',
        sourceCount: 3,
      }));
      const ranked = _rankFreeCandidates([...oldFirst, ...cands]);
      console.log(
        `[ProxyPool] 🌐 Free proxy sources: ${fetched.sourcesOk}/${fetched.sourcesTotal} se ` +
        `${cands.length} raw / ${ranked.length} unique candidates mile — probing shuru...`
      );
      const probe = await probeFreeCandidates(ranked, {
        want, concurrency, timeoutMs, maxProbe, deadlineMs, check, onProgress,
      });
      const { good, checked } = probe;

      const keptEntries = good.map((g) => {
        const prev = existingByUrl.get(g.url);
        if (prev) {
          return {
            ...prev,
            latencyMs: g.latencyMs,
            quality: g.quality || prev.quality || 'clean',
            lastStatus: g.status || prev.lastStatus || 0,
            lastOkAt: new Date().toISOString(),
          };
        }
        const parsed = parseProxyUrl(g.url);
        return {
          id: crypto.randomUUID().slice(0, 8),
          label: `🌐 ${parsed?.label || g.url}${g.country ? ` (${g.country})` : ''}`,
          url: g.url,
          enabled: true,
          auto: true,
          country: g.country || '',
          latencyMs: g.latencyMs,
          quality: g.quality || 'clean',
          lastStatus: g.status || 0,
          sourceCount: g.sourceCount || 1,
          hits: 0,
          addedAt: new Date().toISOString(),
          lastOkAt: new Date().toISOString(),
        };
      });

      const keptIds = new Set(keptEntries.map((e) => e.id));
      for (const old of existingAuto) {
        if (!keptIds.has(old.id)) runtime.delete(old.id); // mari hui auto ka runtime saaf
      }
      state.list = [...state.list.filter((p) => !p.auto), ...keptEntries];
      if (keptEntries.length) state.enabled = true;
      state.autoFreeAt = new Date().toISOString();
      persist(state);
      const keptClean = keptEntries.filter((e) => e.quality !== 'challenged').length;
      const keptChallenged = keptEntries.length - keptClean;
      const topReasons = (probe.stats?.reasons || []).slice(0, 3)
        .map((r) => `${r.reason}×${r.count}`).join(', ');
      console.log(
        `[ProxyPool] 🌐 Free proxies: ${checked} parkhin → ${keptEntries.length} rakhin ` +
        `(clean ${keptClean}, WAF-challenged ${keptChallenged}); ` +
        `dead ${probe.stats?.dead || 0}${topReasons ? ` [${topReasons}]` : ''}.`
      );
      return {
        ok: keptEntries.length > 0,
        added: keptEntries.length,
        checked,
        source,
        candidates: ranked.length,
        rawCandidates: cands.length,
        sourcesOk: fetched.sourcesOk,
        sourcesTotal: fetched.sourcesTotal,
        sources: fetched.sources,
        clean: probe.cleanCount || 0,
        challenged: probe.challengedCount || 0,
        keptClean,
        keptChallenged,
        stats: probe.stats,
        elapsedMs: probe.elapsedMs,
      };
    } finally {
      _freeRefreshPromise = null;
    }
  })();
  return _freeRefreshPromise;
}

// Batch shuru hone se pehle: enabled proxies kam hon to free wali khud le aao.
// Kabhi throw nahi karta — fail ho to purana direct-mode hi chalega.
export async function ensureFreeProxies({ min = 1, want = 8 } = {}) {
  try {
    const state = ensureSeeded();
    const enabledCount = state.list.filter((p) => p.enabled).length;
    if (!freeProxiesEnabled()) return { skipped: true, reason: 'disabled', count: enabledCount };
    if (enabledCount >= min && state.enabled) return { skipped: true, reason: 'enough', count: enabledCount };
    // 1-2 proxies hain aur refresh abhi taza hai to har batch par dobara
    // lambi probing karke OTP window zaya na karo.
    const lastRefreshMs = state.autoFreeAt ? Date.parse(state.autoFreeAt) : 0;
    if (enabledCount > 0 && state.enabled && lastRefreshMs && Date.now() - lastRefreshMs < 30 * 60_000) {
      return { skipped: true, reason: 'recent', count: enabledCount };
    }
    const r = await refreshFreeProxies({ want });
    const now = ensureSeeded().list.filter((p) => p.enabled).length;
    return {
      skipped: false,
      added: r.added || 0,
      checked: r.checked || 0,
      clean: r.clean || 0,
      challenged: r.challenged || 0,
      candidates: r.candidates || 0,
      count: now,
    };
  } catch (e) {
    console.warn('[ProxyPool] ensureFreeProxies:', e?.message);
    return { skipped: true, reason: 'error', count: 0 };
  }
}

// ---------------------------------------------------------------------------
// Summary (bot UI + engine ke liye)
// ---------------------------------------------------------------------------
export function proxySummary() {
  const state = ensureSeeded();
  const enabled = state.list.filter((p) => p.enabled).length;
  const autoCount = state.list.filter((p) => p.auto && p.enabled).length;
  const autoChallenged = state.list.filter((p) => p.auto && p.enabled && p.quality === 'challenged').length;
  const now = Date.now();
  const tokenReadyCount = state.list.filter((p) => p.enabled && hasFreshProxyToken(runtime.get(p.id) || {})).length;
  const wafCoolingCount = state.list.filter((p) => {
    const rt = runtime.get(p.id) || {};
    return p.enabled && ((Number(rt.cooldownUntil) || 0) > now || (Number(rt.wafSolveFailedUntil) || 0) > now);
  }).length;
  const solveCoolingCount = state.list.filter((p) => {
    const rt = runtime.get(p.id) || {};
    return p.enabled && (Number(rt.wafSolveFailedUntil) || 0) > now;
  }).length;
  // "ON" hona aur asal me pick honay ke qabil hona alag baatein hain.
  // Card pehle 10 ON dikha deta tha jab unme se aksar WAF/solve cooldown
  // me hotay thay — usableCount picker ke base filter se match karta hai.
  const usableCount = state.list.filter((p) => {
    const rt = runtime.get(p.id) || {};
    return p.enabled &&
      !proxyReservations.has(p.id) &&
      !((Number(rt.cooldownUntil) || 0) > now) &&
      (Number(rt.consecutiveErrors) || 0) < 3;
  }).length;
  const reservedCount = state.list.filter((p) => proxyReservations.has(p.id)).length;
  return {
    enabled: Boolean(state.enabled),
    total: state.list.length,
    enabledCount: enabled,
    usableCount,
    reservedCount,
    autoCount,
    autoClean: autoCount - autoChallenged,
    autoChallenged,
    tokenReadyCount,
    wafCoolingCount,
    solveCoolingCount,
    autoFree: freeProxiesEnabled(),
    rotation: state.enabled && enabled > 1 ? 'ON (IP rotation — zero-wait recovery)' : 'OFF (ek hi IP)',
  };
}
