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
const runtime = new Map(); // id → { token, tokenAt, cooldownUntil, consecutiveErrors }

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
    return {
      ...p,
      active: p.enabled,
      tokenReady: Boolean(rt.token),
      cooldownLeftMs: Math.max(0, cdUntil - now),
      consecutiveErrors: Number(rt.consecutiveErrors) || 0,
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

export function pickProxy({ excludeIds = [] } = {}) {
  const state = ensureSeeded();
  if (!state.enabled) return null;
  const now = Date.now();
  const candidates = state.list.filter(
    (p) => p.enabled && !excludeIds.includes(p.id) &&
      !((Number(runtime.get(p.id)?.cooldownUntil) || 0) > now) &&
      (Number(runtime.get(p.id)?.consecutiveErrors) || 0) < 3
  );
  if (!candidates.length) return null;
  // Least-recently-used + least-hits
  candidates.sort((a, b) => {
    const ra = runtime.get(a.id) || {};
    const rb = runtime.get(b.id) || {};
    return (Number(ra.tokenAt) || 0) - (Number(rb.tokenAt) || 0) || (a.hits || 0) - (b.hits || 0);
  });
  const pick = candidates[0];
  lastAssignedId = pick.id;
  pick.hits = (pick.hits || 0) + 1;
  pick.lastUsedAt = new Date().toISOString();
  persist(state);
  const parsed = parseProxyUrl(pick.url);
  return { ...pick, ...parsed };
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
  if (!rt?.token) return '';
  // 7 min TTL — token fresh rakho (WAF token ~2h valid, hum 7 min me refresh)
  if (Date.now() - (Number(rt.tokenAt) || 0) > 7 * 60_000) return '';
  return rt.token;
}

export function setProxyToken(id, token) {
  if (!token) return;
  const rt = runtime.get(id) || {};
  rt.token = String(token);
  rt.tokenAt = Date.now();
  runtime.set(id, rt);
}

export function invalidateProxyToken(id) {
  const rt = runtime.get(id);
  if (rt) delete rt.token;
}

export function markProxyWafHit(id, cooldownMs = 60_000) {
  const rt = runtime.get(id) || {};
  rt.cooldownUntil = Date.now() + Number(cooldownMs) || 0;
  delete rt.token; // purana token IP ke saath reject hua
  runtime.set(id, rt);
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
let _dispatcherCache = new Map(); // proxyUrl → undici ProxyAgent

async function getDispatcherFor(proxy) {
  if (!proxy?.url) return null;
  const existing = _dispatcherCache.get(proxy.url);
  if (existing) return existing;
  const { ProxyAgent } = await import('undici');
  const agent = new ProxyAgent({
    uri: proxy.url,
    ...(proxy.auth ? { token: `Basic ${Buffer.from(proxy.auth).toString('base64')}` } : {}),
  });
  _dispatcherCache.set(proxy.url, agent);
  return agent;
}

/**
 * fetchSwiggy(url, opts, proxy)
 *   proxy = pickProxy() ka return (ya null)
 *   → undici ProxyAgent se swiggy.com request
 *   → error par markProxyError + doosri proxy se EK retry
 */
export async function fetchSwiggy(url, opts = {}, proxy = null) {
  if (!proxy?.url) return fetch(url, opts);
  try {
    const dispatcher = await getDispatcherFor(proxy);
    const res = await fetch(url, { ...opts, dispatcher });
    markProxySuccess(proxy.id);
    return res;
  } catch (e) {
    markProxyError(proxy.id);
    // network/proxy error → doosri proxy se ek retry (ZERO wait)
    const alt = pickProxy({ excludeIds: [proxy.id] });
    if (alt) {
      try {
        const dispatcher = await getDispatcherFor(alt);
        return await fetch(url, { ...opts, dispatcher });
      } catch (e2) {
        markProxyError(alt.id);
        throw e2;
      }
    }
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
// Summary (bot UI + engine ke liye)
// ---------------------------------------------------------------------------
export function proxySummary() {
  const state = ensureSeeded();
  const enabled = state.list.filter((p) => p.enabled).length;
  return {
    enabled: Boolean(state.enabled),
    total: state.list.length,
    enabledCount: enabled,
    rotation: state.enabled && enabled > 1 ? 'ON (IP rotation — zero-wait recovery)' : 'OFF (ek hi IP)',
  };
}
