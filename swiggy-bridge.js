import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-core';
import { updateAccount, getNextAutoUserName, cleanEssentialSwiggyCookies } from './store.js';
import { normalizeIndianMobileNumber } from './phone-utils.js';
import * as wafPool from './waf-pool.js';
import * as proxyPool from './proxy-pool.js';
import { section } from './rich-text.js';

// ---------------------------------------------------------------------------
// 🔀 ACTIVE PROXY — Swiggy ka saara traffic isi proxy (nayi IP) se jaata hai.
//   Engine batch ke dauraan proxy rotate karta hai; WAF token bhi per-proxy
//   hota hai (aws-waf-token IP-bound hai).
//   Jab tak koi proxy set na ho — seedha direct (backward compatible).
// ---------------------------------------------------------------------------
let currentProxy = null;
const bridgeProxyContext = new AsyncLocalStorage();

// Parallel autopilot ke liye lane-local route context. Har lane apni proxy
// reservation ke saath chalegi; ek lane ka rotate dusri lane ki IP, WAF
// token route ya OTP session ko touch nahi karega. Context ke baghair
// purana global route hi use hota hai (manual/sequential flows).
export async function runWithBridgeProxy(proxy, fn, {
  owner = '',
  releaseOnExit = true,
  wafTokenMode = '',
} = {}) {
  const ctx = {
    proxy: proxy || null,
    owner: String(owner || ''),
    wafTokenMode: String(wafTokenMode || ''),
  };
  if (ctx.proxy?.id && ctx.owner && !proxyPool.reserveProxy(ctx.proxy.id, ctx.owner)) {
    throw new Error(`Proxy route pehle se kisi aur lane ke paas reserved hai: ${ctx.proxy.id}`);
  }
  try {
    return await bridgeProxyContext.run(ctx, fn);
  } finally {
    if (releaseOnExit && ctx.owner) {
      proxyPool.releaseProxyReservationsForOwner(ctx.owner);
    }
  }
}

export function getBridgeProxyContextOwner() {
  return bridgeProxyContext.getStore()?.owner || '';
}

export function setBridgeProxy(proxy) {
  const nextProxy = proxy || null;
  const ctx = bridgeProxyContext.getStore();
  if (!ctx) {
    currentProxy = nextProxy;
    return currentProxy;
  }
  const previousProxy = ctx.proxy || null;
  if (ctx.owner) {
    if (previousProxy?.id && previousProxy.id !== nextProxy?.id) {
      proxyPool.releaseProxyReservation(previousProxy.id, ctx.owner);
    }
    if (nextProxy?.id) proxyPool.reserveProxy(nextProxy.id, ctx.owner);
  }
  ctx.proxy = nextProxy;
  return ctx.proxy;
}

export function getBridgeProxy() {
  const ctx = bridgeProxyContext.getStore();
  return ctx ? (ctx.proxy || null) : currentProxy;
}

function shouldDeferWafSolveUntilChallenge() {
  return bridgeProxyContext.getStore()?.wafTokenMode === 'defer-until-challenge';
}

// Saare swiggy.com fetch isi se guzarte hain — proxy ON ho to ProxyAgent,
// warna normal fetch.
async function fetchSwiggy(url, opts = {}) {
  return proxyPool.fetchSwiggy(url, opts, getBridgeProxy());
}

// ---------------------------------------------------------------------------
// Chrome/Chromium discovery — puppeteer-core ke paas APNA browser nahi hota,
// isliye system par installed Chrome/Chromium/Edge dhoondhna zaroori hai.
//
// PEHLA BUG (bot "work nahi kar raha" ki sabse badi wajah): pehle Windows par
// sirf `C:\Program Files\...\chrome.exe` hard-coded tha (exist check bhi
// nahi!). Jiski Chrome per-user install (LocalAppData), Program Files (x86)
// ya sirf Edge ho — uske yahan WAF solver har baar chup-chaap fail hota,
// token kabhi banta hi nahi, har OTP request 403 aur batch band.
//
// Ab: env override → saare common install paths (Win/mac/Linux) →
// puppeteer/playwright cache folders. Na mile to '' (jhootha path nahi) —
// taaki canUseStealthBrowser() sahi `false` de aur user ko saaf warning mile.
// Custom path: .env me  PUPPETEER_EXECUTABLE_PATH=C:\path\to\chrome.exe
// ---------------------------------------------------------------------------
const _exists = (p) => { try { return Boolean(p && fs.existsSync(p)); } catch { return false; } };
let _badEnvChromeWarned = false;

export function findChromePath() {
  // 1) Explicit override (sabse pehle) — lekin galat path ho to warn karke
  //    auto-detect par gir jao, warna bot bina wajah atka rahega.
  for (const key of ['PUPPETEER_EXECUTABLE_PATH', 'CHROME_BIN', 'CHROME_PATH']) {
    const v = String(process.env[key] || '').trim();
    if (!v) continue;
    if (_exists(v)) return v;
    if (!_badEnvChromeWarned) {
      _badEnvChromeWarned = true;
      console.warn(`[SwiggyBridge] ${key} set hai lekin file nahi mili: ${v} — auto-detect try kar raha hoon.`);
    }
  }

  const candidates = [];
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    for (const root of [pf, pf86, local]) {
      candidates.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(root, 'Chromium', 'Application', 'chrome.exe'));
    }
    // Edge (Chromium-based) puppeteer-core ke saath chal jata hai — Chrome na
    // ho to ye aakhri bharosa hai, har Windows par pehle se hota hai.
    for (const root of [pf, pf86, local]) {
      candidates.push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
    candidates.push(path.join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'));
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
      '/usr/bin/brave-browser',
      '/snap/bin/chromium',
      '/usr/local/bin/chromium',
      '/usr/local/bin/google-chrome',
    );
  }
  for (const p of candidates) if (_exists(p)) return p;

  // 2) Puppeteer / Playwright download caches (Linux servers par aksar yahi
  //    ekmatra browser hota hai) — 2 level deep scan.
  const cacheRoots = [
    process.env.PUPPETEER_CACHE_DIR,
    path.join(os.homedir(), '.cache', 'puppeteer'),
    '/root/.cache/puppeteer',
    '/opt/playwright/browsers',
    path.join(os.homedir(), '.cache', 'ms-playwright'),
    '/ms-playwright',
  ].filter(Boolean);
  const binNames = process.platform === 'win32'
    ? ['chrome.exe']
    : ['chrome', 'chrome-headless-shell', 'headless_shell', 'chromium'];
  const scan = (dir, depth) => {
    if (depth < 0 || !_exists(dir)) return '';
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return ''; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (!e.isDirectory() && binNames.includes(e.name)) return full;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const hit = scan(path.join(dir, e.name), depth - 1);
      if (hit) return hit;
    }
    return '';
  };
  for (const root of cacheRoots) {
    const hit = scan(root, 3);
    if (hit) return hit;
  }

  return ''; // nahi mila — jhootha default path mat do
}

const CHROME_PATH = findChromePath();
const IS_LINUX = process.platform === 'linux';

// puppeteer-core v25 me headless sirf `boolean | 'shell'` hai — purana 'new'
// invalid hai (galti se chal jata tha). HEADLESS=1/true → har jagah headless,
// HEADLESS=0/false → window ke saath (debug ke liye).
function resolveHeadless() {
  const v = String(process.env.HEADLESS || '').trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(v)) return true;
  if (['0', 'false', 'no'].includes(v)) return false;
  return Boolean(IS_LINUX || process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.CI);
}
const HEADLESS_MODE = resolveHeadless();

// Bot startup + /diag ke liye — Chrome mila ya nahi, saaf-saaf.
export function getChromeStatus() {
  return {
    found: Boolean(CHROME_PATH && _exists(CHROME_PATH)),
    path: CHROME_PATH || '',
    headless: HEADLESS_MODE,
    platform: process.platform,
  };
}

// swiggy-cart.js is standalone repo me NAHI hai (purane bade bot ka module
// tha) — pehle iska dynamic import har call par fail hota aur catch{} me
// chup jata tha. Ab: file ho tabhi import, warna ek baar warn karke skip.
let _cartBootstrap = undefined; // undefined = try nahi kiya, null = unavailable
async function loadAndroidBootstrap() {
  if (_cartBootstrap !== undefined) return _cartBootstrap;
  try {
    const cartFile = fileURLToPath(new URL('./swiggy-cart.js', import.meta.url));
    if (!_exists(cartFile)) {
      console.warn('[SwiggyBridge] swiggy-cart.js repo me nahi hai — Android-token → web-session bootstrap skip (sirf imported Android accounts par asar).');
      _cartBootstrap = null;
      return null;
    }
    const mod = await import('./swiggy-cart.js');
    _cartBootstrap = typeof mod.bootstrapSwiggyWebSessionFromAndroidTokens === 'function'
      ? mod.bootstrapSwiggyWebSessionFromAndroidTokens
      : null;
  } catch (e) {
    console.warn('[SwiggyBridge] swiggy-cart.js load fail:', e?.message);
    _cartBootstrap = null;
  }
  return _cartBootstrap;
}

// Active login sessions keyed by userId:
// { [userId]: { browser, page, phone, otp, targetAcc, targetAccName, signupEmail, isNewUser, safetyTimer } }
const activeSessions = {};
// Pipeline live card ko finalization ke andar wale asal Add Address step
// ka signal dene ke liye optional reporter. Reporter na ho to purana
// behavior hi rahega; reporter fail ho to address flow nahi rukega.
export function setSwiggyBridgeSessionProgressReporter(userId, reporter) {
  const session = activeSessions[userId];
  if (!session) return false;
  session.progressReporter = typeof reporter === 'function' ? reporter : null;
  return true;
}

// Owner ka ⏭ SKIP current number ke liye cooperative abort checker.
// Ye sirf manual SKIP se judta hai (poora batch wala STOP nahi): finalization
// ke lambay Add Address step ko safe checkpoint par rok kar engine ko
// `manual_skip` ka mauqa deta hai, baghair aadhi request ko zabardasti
// kaate hue.
export function setSwiggyBridgeSessionAbortChecker(userId, checker) {
  const session = activeSessions[userId];
  if (!session) return false;
  session.abortChecker = typeof checker === 'function' ? checker : null;
  return true;
}

export function _swiggyBridgeSessionAbortRequested(session) {
  try { return Boolean(session?.abortChecker?.()); } catch { return false; }
}
// Dedicated in-memory session map for Swiggy account deletions (strictly isolated from login)
const activeDeleteSessions = {};
let deleteOtpRequestCount = 0;
let deleteVerifyRequestCount = 0;

// Pre-warmed browser pool for instantaneous (<1s) OTP dispatch
let prewarmedBrowser = null;
let prewarmedPage = null;
let isPrewarming = false;
let prewarmedAt = 0;
let latestSharedWafToken = '';
let latestSharedWafAt = 0;
let directWafSolveFailedUntil = 0;
// Route-keyed solver locks. PEHLA BUG: ek hi global promise tha — proxy B
// ke liye token maangne wala proxy A par chal raha solver join karke A ka
// IP-bound token B par chipka deta tha, phir challenge pakka tha.
const wafSolvePromises = new Map(); // routeKey → Promise<string>
let wafSolveTail = Promise.resolve(''); // ek waqt me ek hi Chromium solver
const WAF_CACHE_TTL_MS = 8 * 60 * 1000; // 8 minutes

// Browser escalation solver wali hi FIFO tail use karti hai — parallel
// lanes me solver aur escalation ke do Chromium ek saath launch nahi honge.
async function withBrowserEscalationSlot(fn) {
  const previous = wafSolveTail.catch(() => '');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  wafSolveTail = previous.then(() => gate);
  await previous;
  try {
    return await fn();
  } finally {
    release('');
  }
}

export function _wafSolveRouteKey(proxy = null) {
  return proxy?.id ? `proxy:${proxy.id}` : 'direct';
}

function routeLabel(proxy = null) {
  return proxy?.label || proxy?.url || 'direct';
}

const SWIGGY_WAF_COOKIE_WAIT_MS = 15000;
const SWIGGY_WAF_COOKIE_POLL_MS = 250;
const AUTH_PAGE_EVALUATE_TIMEOUT_MS = 9000;

// WAF solver ke do budget hain:
//   FAST (15s)     — chalti hui request ke beech ki recovery; number ko
//                    minutes tak latkaya nahi jata.
//   RELIABLE (45s) — number claim karne se pehle route tayyar karna.
// Chromium launch + slow free-proxy navigation + 15s cookie wait ko ek
// hi 15s total cap me band karna token banna lagbhag impossible bana deta
// tha. Isi liye reliable budget alag hai; token jaldi aa jaye to solver
// waise hi turant return kar deta hai (budget = upar ki had, fixed wait nahi).
export const WAF_SOLVE_FAST_BUDGET_MS = 15_000;
export const WAF_SOLVE_RELIABLE_BUDGET_MS = 45_000;
export const WAF_SOLVE_MAX_BUDGET_MS = 60_000;
export const DIRECT_WAF_SOLVE_FAILURE_COOLDOWN_MS = 60_000;

export function _directWafSolveCooldownLeftMs(now = Date.now()) {
  return Math.max(0, directWafSolveFailedUntil - now);
}

export function normalizeWafSolveBudgetMs(value, fallbackMs = WAF_SOLVE_RELIABLE_BUDGET_MS) {
  const base = Number(value);
  const fallback = Number(fallbackMs);
  const requested = Number.isFinite(base) && base > 0
    ? base
    : (Number.isFinite(fallback) && fallback > 0 ? fallback : WAF_SOLVE_RELIABLE_BUDGET_MS);
  return Math.min(WAF_SOLVE_MAX_BUDGET_MS, Math.max(8_000, requested));
}

async function waitForSwiggyWafCookie(page, timeoutMs = SWIGGY_WAF_COOKIE_WAIT_MS) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (Date.now() < deadline) {
    const cookies = await page.cookies().catch(() => []);
    const wafCookie = cookies.find(cookie => cookie.name === 'aws-waf-token' && String(cookie.value || '').length > 50);
    if (wafCookie) return wafCookie.value;
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await new Promise(resolve => setTimeout(resolve, Math.min(SWIGGY_WAF_COOKIE_POLL_MS, remainingMs)));
    }
  }
  return '';
}

async function waitForSwiggyLoginCookies(page, timeoutMs = 800) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  let cookies = [];
  do {
    cookies = await page.cookies().catch(() => []);
    if (checkLoggedInFromCookies(cookies)) return cookies;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(100, remainingMs)));
  } while (Date.now() < deadline);
  return cookies;
}

export function stripStaleWafCookie(cookieStr = '') {
  if (!cookieStr || typeof cookieStr !== 'string') return '';
  return cookieStr
    .split(';')
    .map(s => s.trim())
    .filter(s => s && !s.startsWith('aws-waf-token='))
    .join('; ');
}

function mergeSetCookiesIntoJar(existingCookieStr = '', setCookieHeaders = []) {
  const map = new Map();
  for (const part of stripStaleWafCookie(existingCookieStr).split(';')) {
    const trimmed = part.trim();
    if (!trimmed || !trimmed.includes('=')) continue;
    const idx = trimmed.indexOf('=');
    map.set(trimmed.slice(0, idx).trim(), trimmed.slice(idx + 1).trim());
  }
  for (const raw of (setCookieHeaders || [])) {
    const first = String(raw || '').split(';')[0].trim();
    if (!first || !first.includes('=')) continue;
    const idx = first.indexOf('=');
    const k = first.slice(0, idx).trim();
    const v = first.slice(idx + 1).trim();
    if (k && v && k !== '_guest_tid' && k !== 'aws-waf-token') {
      map.set(k, v);
    }
  }
  return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

// Helper to decode JWT payload safely
export function decodeJwtPayload(jwtToken) {
  if (!jwtToken || typeof jwtToken !== 'string') return null;
  try {
    const parts = jwtToken.split('.');
    if (parts.length < 2) return null;
    const jsonStr = Buffer.from(parts[1], 'base64').toString('utf-8');
    return JSON.parse(jsonStr);
  } catch (e) {
    return null;
  }
}

// Web/DAPI OTP login aksar short-life JWT `tid` deta hai — isiliye exported
// JSON 2–3 ghante me purana lagne lagta hai aur dusra tool dobara JSON
// maangta hai. Android `chkout` wahi authenticated token ko rotate karke
// aam taur par lambi-life wala JWT deta hai. Is block ka kaam hai:
//   1) JWT ki asal bachi hui life pehchano;
//   2) export/save se pehle short JWT ko rotate karne ki koshish karo;
//   3) saved JSON ko bina naya OTP liye refresh karo jab tak Swiggy ke
//      paas purana token/_session_tid zinda hai.
// Guest JWT, dusre customer ka JWT, ya pehle-se-expired JWT kabhi accept
// nahi hoga — galat token chipka kar "long session" ka jhootha daava nahi.
export const SWIGGY_LONG_SESSION_MIN_MS = 7 * 24 * 60 * 60 * 1000;

export function getSwiggyJwtSessionInfo(tid, nowMs = Date.now()) {
  const token = String(tid || '').trim();
  const isJwt = token.includes('.');
  const claims = isJwt ? decodeJwtPayload(token) : null;
  const customerRaw = String(
    claims?.user_id ?? claims?.userId ?? claims?.customer_id ?? claims?.customerId ?? claims?.sub ?? ''
  ).trim();
  const customerId = /^\d+$/.test(customerRaw) && customerRaw !== '0' ? customerRaw : '';
  const issuedAtMs = Number(claims?.iat) > 0 ? Number(claims.iat) * 1000 : null;
  const expiresAtMs = Number(claims?.exp) > 0 ? Number(claims.exp) * 1000 : null;
  const remainingMs = expiresAtMs ? expiresAtMs - (Number(nowMs) || Date.now()) : null;
  const lifetimeMs = issuedAtMs && expiresAtMs ? expiresAtMs - issuedAtMs : null;
  return {
    tid: isJwt ? token : '',
    claims,
    customerId,
    isGuest: Boolean(isJwt && !customerId),
    issuedAtMs,
    expiresAtMs,
    remainingMs,
    lifetimeMs,
    isExpired: Boolean(remainingMs !== null && remainingMs <= 0),
    isShortLived: Boolean(remainingMs !== null && remainingMs < SWIGGY_LONG_SESSION_MIN_MS),
    isLongLived: Boolean(remainingMs !== null && remainingMs >= SWIGGY_LONG_SESSION_MIN_MS),
  };
}

function swiggyJwtCandidate(tid, source, { nowMs = Date.now(), expectedCustomerId = '' } = {}) {
  const info = getSwiggyJwtSessionInfo(tid, nowMs);
  if (!info.tid) return null;
  const expected = /^\d+$/.test(String(expectedCustomerId || '')) ? String(expectedCustomerId) : '';
  return {
    tid: info.tid,
    source,
    info,
    customerId: info.customerId,
    expiresAtMs: info.expiresAtMs,
    remainingMs: info.remainingMs,
    valid: Boolean(
      info.customerId
      && !info.isGuest
      && !info.isExpired
      && (!expected || info.customerId === expected)
    ),
  };
}

function chooseBestSwiggyJwtCandidate(candidates = []) {
  return (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => candidate?.valid)
    .sort((a, b) => (Number(b.expiresAtMs) || -1) - (Number(a.expiresAtMs) || -1))[0] || null;
}

function swiggyCookieMapFromCredentials(input = {}) {
  if (input?.cookieMap instanceof Map) {
    return new Map([...input.cookieMap.entries()].map(([k, v]) => [String(k), String(v)]));
  }
  const map = new Map();
  const raw = typeof input === 'string'
    ? input
    : (input?.cookies ?? input?.cookie ?? input?.cookieString ?? input?.headers?.cookie ?? input?.headers?.Cookie ?? '');
  if (Array.isArray(raw)) {
    for (const cookie of raw) {
      const name = String(cookie?.name || cookie?.key || '').trim();
      const value = String(cookie?.value ?? '').trim();
      if (name && value) map.set(name, value);
    }
  } else if (raw && typeof raw === 'object') {
    for (const [name, value] of Object.entries(raw)) {
      if (name && value !== undefined && value !== null && String(value) !== '') map.set(String(name), String(value));
    }
  } else {
    for (const part of String(raw || '').split(';')) {
      const trimmed = part.trim();
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const name = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (name && value) map.set(name, value);
    }
  }
  return map;
}

function normalizeSwiggySessionCredentials(input = {}, { nowMs = Date.now() } = {}) {
  const source = typeof input === 'string'
    ? { cookies: input }
    : (input && typeof input === 'object' ? input : {});
  const cookieMap = swiggyCookieMapFromCredentials(source);
  const getCookie = (name) => String(cookieMap.get(name) || '').trim();
  const explicitCustomerRaw = String(
    source.customerId || source.customerid || source.customer_id || source.userId || source.user_id || ''
  ).trim();
  const explicitCustomerId = /^\d+$/.test(explicitCustomerRaw) && explicitCustomerRaw !== '0'
    ? explicitCustomerRaw
    : '';

  const jwtValues = [...new Set([
    source.jwtTid,
    source.jwt_tid,
    source.tid,
    getCookie('tid'),
  ].map((value) => String(value || '').trim()).filter((value) => value.includes('.')))];
  const bestJwt = chooseBestSwiggyJwtCandidate(
    jwtValues.map((value) => swiggyJwtCandidate(value, 'saved', { nowMs, expectedCustomerId: explicitCustomerId }))
  );
  const tid = bestJwt?.tid || jwtValues[0] || '';
  const jwtInfo = getSwiggyJwtSessionInfo(tid, nowMs);
  const customerId = explicitCustomerId || jwtInfo.customerId || '';

  let sessionTid = String(
    source._session_tid || source.session_tid || source.sessionTid || getCookie('_session_tid') || ''
  ).trim();
  if (!sessionTid && source.tid && !String(source.tid).includes('.')) sessionTid = String(source.tid).trim();

  const token = String(
    source.token || source.auth_token || source.authToken || source.access_token || source.accessToken || getCookie('token') || ''
  ).trim();
  const sid = String(source.sid || source._sid || getCookie('_sid') || getCookie('sid') || '').trim();
  const deviceId = String(
    source.deviceId || source.device_id || source._device_id || source.swuid || source._swuid
    || getCookie('_device_id') || getCookie('_swuid') || source.deviceProfile?.deviceId || ''
  ).trim();
  const phone = normalizeIndianMobileNumber(source.phone || source.mobile || '') || '';

  if (sessionTid) cookieMap.set('_session_tid', sessionTid);
  if (tid) cookieMap.set('tid', tid);
  if (token) cookieMap.set('token', token);
  if (sid) cookieMap.set('_sid', sid);
  if (deviceId) {
    cookieMap.set('_device_id', deviceId);
    if (!cookieMap.has('swuid')) cookieMap.set('swuid', deviceId);
  }
  if (sessionTid || tid || token) cookieMap.set('_is_logged_in', '1');

  return {
    phone,
    customerId,
    tid,
    jwtTid: tid,
    _session_tid: sessionTid,
    token,
    sid,
    deviceId,
    cookieMap,
    cookies: serializeCookieMap(cookieMap),
    deviceProfile: source.deviceProfile || null,
  };
}

export function getSwiggyAccountJwtSessionInfo(account = {}, nowMs = Date.now()) {
  const credentials = normalizeSwiggySessionCredentials(account, { nowMs });
  return {
    ...getSwiggyJwtSessionInfo(credentials.tid, nowMs),
    _session_tid: credentials._session_tid,
    hasSessionTid: Boolean(credentials._session_tid),
    hasToken: Boolean(credentials.token),
  };
}

async function readSwiggyJsonResponse(res) {
  if (!res) return { json: null, rawText: '' };
  if (typeof res.text === 'function') {
    const rawText = await res.text().catch(() => '');
    if (rawText) {
      try { return { json: JSON.parse(rawText), rawText }; } catch { return { json: null, rawText }; }
    }
  }
  if (typeof res.json === 'function') {
    return { json: await res.json().catch(() => null), rawText: '' };
  }
  return { json: null, rawText: '' };
}

async function requestSwiggyAndroidChkoutTid(credentials, {
  fetchImpl,
  timeoutMs = 5_000,
  nowMs = Date.now(),
} = {}) {
  if (!credentials?.tid && !credentials?.token) {
    return { ok: false, source: 'android-chkout', reason: 'tid/token missing' };
  }
  try {
    const res = await fetchImpl('https://chkout.swiggy.com/api/v2/cart/client', {
      method: 'GET',
      headers: {
        'User-Agent': 'Swiggy-Android',
        'app-version': '4.67.0',
        'version-code': '1365',
        'os-version': String(credentials.deviceProfile?.osVersion || '14'),
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'platform': 'swiggy-android',
        'agent-type': 'Swiggy-Android',
        'analyticsPlatform': 'an',
        ...(credentials.tid ? { tid: credentials.tid } : {}),
        ...(credentials.token ? { token: credentials.token } : {}),
        ...(credentials.sid ? { sid: credentials.sid } : {}),
        ...(credentials.deviceId ? { deviceId: credentials.deviceId, swuid: credentials.deviceId } : {}),
        ...(credentials.customerId ? {
          userid: credentials.customerId,
          'user-id': credentials.customerId,
          customer_id: credentials.customerId,
        } : {}),
      },
      signal: AbortSignal.timeout(Math.max(1_000, Number(timeoutMs) || 5_000)),
    });
    const { json } = await readSwiggyJsonResponse(res);
    const statusCode = json?.statusCode !== undefined && json?.statusCode !== null
      ? Number(json.statusCode)
      : null;
    const candidate = swiggyJwtCandidate(json?.tid, 'android-chkout', {
      nowMs,
      expectedCustomerId: credentials.customerId,
    });
    const ok = Boolean(candidate?.valid && (statusCode === 0 || statusCode === null));
    return {
      ok,
      source: 'android-chkout',
      candidate: ok ? candidate : null,
      httpStatus: Number(res?.status) || 0,
      statusCode,
      statusMessage: String(json?.statusMessage || json?.message || ''),
      sid: json?.sid ? String(json.sid) : '',
      deviceId: json?.deviceId ? String(json.deviceId) : '',
      authRejected: statusCode === 999 || statusCode === 401 || Number(res?.status) === 401,
    };
  } catch (error) {
    return {
      ok: false,
      source: 'android-chkout',
      reason: String(error?.message || error).slice(0, 160),
    };
  }
}

async function requestSwiggyDapiSessionRefresh(credentials, {
  fetchImpl,
  timeoutMs = 5_000,
  nowMs = Date.now(),
} = {}) {
  const cookieMap = new Map(credentials?.cookieMap || []);
  if (credentials?._session_tid) cookieMap.set('_session_tid', credentials._session_tid);
  if (credentials?.tid) cookieMap.set('tid', credentials.tid);
  if (credentials?.token) cookieMap.set('token', credentials.token);
  if (credentials?.sid) cookieMap.set('_sid', credentials.sid);
  if (credentials?.deviceId) cookieMap.set('_device_id', credentials.deviceId);

  const updated = { ...credentials, cookieMap };
  const sessionLike = {
    phone: credentials?.phone || '',
    cookieMap,
    deviceProfile: credentials?.deviceProfile || buildAntiBotDeviceProfile(credentials?.phone || ''),
    csrfToken: cookieMap.get('_csrf') || '',
    transportMode: 'android',
  };

  let authRejected = false;
  let last = {};
  for (const endpoint of ['profile/info', 'order/all']) {
    try {
      const res = await fetchImpl(`https://www.swiggy.com/dapi/${endpoint}`, {
        method: 'GET',
        headers: buildAuthRequestHeaders(sessionLike, {
          referer: 'https://www.swiggy.com/my-account',
          useAndroidUa: true,
          extra: {
            ...(updated.token ? { token: updated.token } : {}),
            ...(updated.deviceId ? { deviceId: updated.deviceId, swuid: updated.deviceId } : {}),
          },
        }),
        signal: AbortSignal.timeout(Math.max(1_000, Number(timeoutMs) || 5_000)),
      });
      applySetCookiesToMap(cookieMap, getResponseSetCookies(res));
      const { json } = await readSwiggyJsonResponse(res);
      const statusCode = json?.statusCode !== undefined && json?.statusCode !== null
        ? Number(json.statusCode)
        : null;
      last = {
        source: `dapi-${endpoint}`,
        httpStatus: Number(res?.status) || 0,
        statusCode,
        statusMessage: String(json?.statusMessage || json?.message || ''),
      };
      if (statusCode === 1 || statusCode === 999 || Number(res?.status) === 401) authRejected = true;
      if (statusCode !== 0) continue;

      const data = json?.data && typeof json.data === 'object' ? json.data : {};
      const responseCustomerRaw = String(data.customer_id || data.customerId || data.user_id || data.id || '').trim();
      const responseCustomerId = /^\d+$/.test(responseCustomerRaw) && responseCustomerRaw !== '0'
        ? responseCustomerRaw
        : '';
      if (updated.customerId && responseCustomerId && updated.customerId !== responseCustomerId) continue;

      const candidate = swiggyJwtCandidate(json?.tid, `dapi-${endpoint}`, {
        nowMs,
        expectedCustomerId: updated.customerId || responseCustomerId,
      });
      if (responseCustomerId) updated.customerId = responseCustomerId;
      if (candidate?.valid) {
        updated.tid = candidate.tid;
        updated.jwtTid = candidate.tid;
        cookieMap.set('tid', candidate.tid);
        if (!updated.customerId) updated.customerId = candidate.customerId;
      }
      if (data.token) {
        updated.token = String(data.token);
        cookieMap.set('token', updated.token);
      }
      if (json?.sid) {
        updated.sid = String(json.sid);
        cookieMap.set('_sid', updated.sid);
      }
      if (json?.deviceId) {
        updated.deviceId = String(json.deviceId);
        cookieMap.set('_device_id', updated.deviceId);
      }
      updated._session_tid = String(cookieMap.get('_session_tid') || updated._session_tid || '');
      updated.cookies = serializeCookieMap(cookieMap);
      return {
        ok: true,
        authenticated: true,
        source: `dapi-${endpoint}`,
        candidate: candidate?.valid ? candidate : null,
        credentials: updated,
        ...last,
      };
    } catch (error) {
      last = { source: `dapi-${endpoint}`, reason: String(error?.message || error).slice(0, 160) };
    }
  }

  updated.cookies = serializeCookieMap(cookieMap);
  return {
    ok: false,
    authenticated: false,
    authRejected,
    credentials: updated,
    ...last,
  };
}

export async function refreshSwiggySessionCredentials(input = {}, {
  fetchImpl = null,
  timeoutMs = 5_000,
  force = false,
  allowDapiFallback = true,
  minRemainingMs = SWIGGY_LONG_SESSION_MIN_MS,
  nowMs = Date.now(),
} = {}) {
  const doFetch = fetchImpl || fetchSwiggy;
  const original = normalizeSwiggySessionCredentials(input, { nowMs });
  let working = { ...original, cookieMap: new Map(original.cookieMap) };
  const originalInfo = getSwiggyJwtSessionInfo(original.tid, nowMs);
  const minRemaining = Math.max(0, Number(minRemainingMs) || SWIGGY_LONG_SESSION_MIN_MS);
  const baseResult = () => {
    const info = getSwiggyJwtSessionInfo(working.tid, nowMs);
    working.cookies = cleanEssentialSwiggyCookies(serializeCookieMap(working.cookieMap), working);
    return {
      tid: working.tid || '',
      jwtTid: working.tid || '',
      _session_tid: working._session_tid || '',
      token: working.token || '',
      sid: working.sid || '',
      deviceId: working.deviceId || '',
      customerId: working.customerId || info.customerId || '',
      cookies: working.cookies,
      cookieMap: working.cookieMap,
      expiresAtMs: info.expiresAtMs,
      remainingMs: info.remainingMs,
      longLived: Boolean(info.remainingMs !== null && info.remainingMs >= minRemaining),
      info,
    };
  };

  if (!force && originalInfo.remainingMs !== null && originalInfo.remainingMs >= minRemaining && originalInfo.customerId) {
    return { ok: true, refreshed: false, attempts: [], ...baseResult() };
  }
  if (!original.tid && !original.token && !original._session_tid && !original.cookies) {
    return { ok: false, refreshed: false, attempts: [], reason: 'session credentials missing', ...baseResult() };
  }

  const attempts = [];
  const candidates = [];
  const originalCandidate = swiggyJwtCandidate(original.tid, 'saved', {
    nowMs,
    expectedCustomerId: original.customerId,
  });
  if (originalCandidate) candidates.push(originalCandidate);
  let authenticated = Boolean(originalCandidate?.valid);
  let authRejected = false;

  const runChkout = async () => {
    const chkout = await requestSwiggyAndroidChkoutTid(working, { fetchImpl: doFetch, timeoutMs, nowMs });
    attempts.push({
      source: chkout.source,
      ok: Boolean(chkout.ok),
      httpStatus: chkout.httpStatus || 0,
      statusCode: chkout.statusCode ?? null,
    });
    if (chkout.authRejected) authRejected = true;
    if (chkout.candidate) {
      candidates.push(chkout.candidate);
      authenticated = true;
      if (!working.customerId) working.customerId = chkout.candidate.customerId;
    }
    if (chkout.sid) {
      working.sid = chkout.sid;
      working.cookieMap.set('_sid', chkout.sid);
    }
    if (chkout.deviceId) {
      working.deviceId = chkout.deviceId;
      working.cookieMap.set('_device_id', chkout.deviceId);
    }
    return chkout;
  };

  if (working.tid || working.token) await runChkout();

  // Chkout se valid JWT mil gaya ho to DAPI par extra round-trip nahi.
  // DAPI fallback sirf tab hai jab JWT expire/invalid ho lekin web
  // `_session_tid` abhi zinda ho — wahi purane saved JSON ko bina OTP ke
  // dobara zinda kar sakta hai.
  if (allowDapiFallback && !chooseBestSwiggyJwtCandidate(candidates) && (working._session_tid || working.cookies)) {
    const dapi = await requestSwiggyDapiSessionRefresh(working, { fetchImpl: doFetch, timeoutMs, nowMs });
    attempts.push({
      source: dapi.source || 'dapi',
      ok: Boolean(dapi.ok),
      httpStatus: dapi.httpStatus || 0,
      statusCode: dapi.statusCode ?? null,
    });
    if (dapi.authRejected) authRejected = true;
    if (dapi.credentials) working = { ...working, ...dapi.credentials, cookieMap: dapi.credentials.cookieMap || working.cookieMap };
    if (dapi.candidate) candidates.push(dapi.candidate);
    if (dapi.authenticated) {
      authenticated = true;
      const bestAfterDapi = chooseBestSwiggyJwtCandidate(candidates);
      const seedChanged = Boolean(
        (working.tid && working.tid !== original.tid)
        || (working.token && working.token !== original.token)
      );
      if (seedChanged && (!bestAfterDapi || (bestAfterDapi.remainingMs !== null && bestAfterDapi.remainingMs < minRemaining))) {
        await runChkout();
      }
    }
  }

  const best = chooseBestSwiggyJwtCandidate(candidates);
  if (best?.tid) {
    working.tid = best.tid;
    working.jwtTid = best.tid;
    working.cookieMap.set('tid', best.tid);
    // Kuch exports me `token` alag credential nahi, sirf purane JWT ki
    // copy hoti hai. Rotation ke baad us copy ko short JWT par chhod diya
    // to dusra tool phir wahi 2–3 ghante wala token use karega.
    if (original.token && original.token === original.tid) working.token = best.tid;
    if (!working.customerId) working.customerId = best.customerId;
  }
  if (working._session_tid) working.cookieMap.set('_session_tid', working._session_tid);
  if (working.token) working.cookieMap.set('token', working.token);
  if (working.sid) working.cookieMap.set('_sid', working.sid);
  if (working.deviceId) working.cookieMap.set('_device_id', working.deviceId);

  const result = baseResult();
  const ok = Boolean(best?.valid || (authenticated && (working._session_tid || working.token)));
  const refreshed = Boolean(ok && (
    result.tid !== original.tid
    || result._session_tid !== original._session_tid
    || result.token !== original.token
    || result.sid !== original.sid
    || result.deviceId !== original.deviceId
  ));
  return {
    ok,
    refreshed,
    authRejected: Boolean(authRejected && !ok),
    attempts,
    reason: ok ? '' : (authRejected ? 'Swiggy session expired/revoked' : 'Swiggy session refresh nahi ho paya'),
    ...result,
  };
}

export async function refreshSavedSwiggySession(accountKey, opts = {}) {
  const key = String(accountKey || '').trim();
  if (!key) return { ok: false, refreshed: false, reason: 'account key missing' };
  try {
    const { getDb } = await import('./store.js');
    const db = getDb();
    const account = db.config?.accounts?.[key] || null;
    const phone = normalizeIndianMobileNumber(account?.phone || account?.mobile || key.replace(/^acc_/, '')) || '';
    const vault = (phone && db.sessionVault?.[phone]) || db.sessionVault?.[key] || null;
    const deleted = db.config?.deletedAccounts || {};
    if (deleted[key] || (phone && (deleted[`acc_${phone}`] || deleted[phone]))) {
      return { ok: false, refreshed: false, reason: 'account deleted hai' };
    }

    let source = account ? { ...(vault || {}), ...account } : (vault ? { ...vault } : null);
    if (account && vault?.cookies && !String(account.cookies || '').includes('_session_tid=') && String(vault.cookies).includes('_session_tid=')) {
      source = { ...source, cookies: vault.cookies };
    }
    if (!source) return { ok: false, refreshed: false, reason: 'saved session nahi mila' };
    if (source.isLoggedOut || source.isLoggedIn === false) {
      return { ok: false, refreshed: false, reason: 'saved session logged out hai' };
    }

    const result = await refreshSwiggySessionCredentials(source, opts);
    if (!result.ok) return { ...result, accountKey: key, account };

    const targetKey = account ? key : String(source.account || (phone ? `acc_${phone}` : key));
    const shouldPersist = Boolean(
      result.refreshed
      || !source.tidExpiresAt
      || String(source.jwtTid || '') !== String(result.tid || '')
      || String(source._session_tid || '') !== String(result._session_tid || '')
    );
    let persisted = account;
    if (shouldPersist) {
      persisted = updateAccount(targetKey, {
        ...(account ? {} : {
          name: source.name || targetKey,
          swiggyName: source.swiggyName || '',
          ...(source.email ? { email: source.email } : {}),
          ...(source.address ? { address: source.address } : {}),
          ...(source.addressDetails ? { addressDetails: source.addressDetails } : {}),
          ...(source.remoteAddressStatus ? { remoteAddressStatus: source.remoteAddressStatus } : {}),
          ...(source.remoteAddressId ? { remoteAddressId: source.remoteAddressId } : {}),
        }),
        phone: phone || source.phone || source.mobile || '',
        mobile: phone || source.mobile || source.phone || '',
        customerId: result.customerId || source.customerId || '',
        _session_tid: result._session_tid || source._session_tid || '',
        jwtTid: result.tid || '',
        tid: result.tid || source.tid || '',
        token: result.token || source.token || result.tid || '',
        sid: result.sid || source.sid || '',
        deviceId: result.deviceId || source.deviceId || '',
        cookies: result.cookies || source.cookies || '',
        tidExpiresAt: result.expiresAtMs ? new Date(result.expiresAtMs).toISOString() : (source.tidExpiresAt || ''),
        sessionLongLived: Boolean(result.longLived),
        sessionRefreshedAt: new Date().toISOString(),
        isLoggedIn: true,
        sessionExpired: false,
      });
    }
    return { ...result, accountKey: targetKey, account: persisted || account };
  } catch (error) {
    return {
      ok: false,
      refreshed: false,
      accountKey: key,
      reason: String(error?.message || error).slice(0, 180),
    };
  }
}

export function sanitizeSwiggyName(name) {
  if (!name) return 'Rahul Kumar';
  // Strip any previously appended "(User 1)" or "(6296591407)" tag first
  const withoutSlotTag = String(name).replace(/\([^)]*\)/g, ' ');
  const cleaned = withoutSlotTag.replace(/[^\p{L}\p{M}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
  if ([...cleaned].length < 2 || !/\p{L}/u.test(cleaned) || /^user\s*\d*$/i.test(cleaned)) {
    return 'Rahul Kumar';
  }
  return cleaned;
}

// User ka fresh-ID rule: number ke FIRST 5 digits + exact
// "Rahul@gmail.com". Example: 9876543210 → 98765Rahul@gmail.com.
// Country-code wala input mile to pehle uska 10-digit Indian mobile nikalo,
// taaki "+91" ke digits first-five me na aa jayein.
export function freshSwiggyEmailPhoneDigits(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length > 10) return digits.slice(-10);
  return digits;
}

export function generateFreshSwiggyEmail(phone, { attempt = 0 } = {}) {
  const mobile = freshSwiggyEmailPhoneDigits(phone) || '0000000000';
  const firstFive = mobile.padEnd(5, '0').slice(0, 5);
  const retry = Math.max(0, Math.floor(Number(attempt) || 0));
  // Primary attempt hamesha exact requested format hai. Swiggy agar wohi
  // email kisi purane account se duplicate bole, tabhi numbered fallback
  // use hoga — warna signup hamesha ek hi taken email par atka rahega.
  return `${firstFive}Rahul${retry > 0 ? String(retry) : ''}@gmail.com`;
}

function generateUniqueSwiggyEmail(phone, _name, attempt = 0) {
  return generateFreshSwiggyEmail(phone, { attempt });
}

// User ka rule: address owner ke Lucknow/UP ka nahi — Maharashtra ki kisi
// bhi city ka random address. Coordinates area ke aas-paas ke hain taaki
// Swiggy ka address-service use serviceable locality ke roop me pehchane.
const RANDOM_SWIGGY_ADDRESS_AREAS = [
  { area: 'Andheri West', city: 'Mumbai', state: 'Maharashtra', pincode: '400053', lat: 19.1363, lng: 72.8277, landmark: 'Near Azad Nagar Metro Station' },
  { area: 'Bandra West', city: 'Mumbai', state: 'Maharashtra', pincode: '400050', lat: 19.0600, lng: 72.8360, landmark: 'Near Linking Road' },
  { area: 'Powai', city: 'Mumbai', state: 'Maharashtra', pincode: '400076', lat: 19.1197, lng: 72.9051, landmark: 'Near Powai Lake' },
  { area: 'Koregaon Park', city: 'Pune', state: 'Maharashtra', pincode: '411001', lat: 18.5362, lng: 73.8939, landmark: 'Near German Bakery' },
  { area: 'Hinjewadi Phase 1', city: 'Pune', state: 'Maharashtra', pincode: '411057', lat: 18.5912, lng: 73.7389, landmark: 'Near Infosys Circle' },
  { area: 'Kothrud', city: 'Pune', state: 'Maharashtra', pincode: '411038', lat: 18.5074, lng: 73.8077, landmark: 'Near MIT College' },
  { area: 'Sitabuldi', city: 'Nagpur', state: 'Maharashtra', pincode: '440012', lat: 21.1425, lng: 79.0800, landmark: 'Near Variety Square' },
  { area: 'Dwarka', city: 'Nashik', state: 'Maharashtra', pincode: '422011', lat: 19.9975, lng: 73.7898, landmark: 'Near Dwarka Circle' },
  { area: 'Ghodbunder Road', city: 'Thane', state: 'Maharashtra', pincode: '400615', lat: 19.2597, lng: 72.9750, landmark: 'Near Kasarvadavali' },
  { area: 'CIDCO', city: 'Chhatrapati Sambhajinagar', state: 'Maharashtra', pincode: '431003', lat: 19.8738, lng: 75.3370, landmark: 'Near CIDCO Bus Stand' },
  { area: 'Shahupuri', city: 'Kolhapur', state: 'Maharashtra', pincode: '416001', lat: 16.7100, lng: 74.2430, landmark: 'Near Shahupuri Market' },
  { area: 'Hotgi Road', city: 'Solapur', state: 'Maharashtra', pincode: '413003', lat: 17.6480, lng: 75.9150, landmark: 'Near Solapur Railway Station' },
];

const RANDOM_SWIGGY_ADDRESS_STREETS = [
  'Main Road', 'Station Road', 'MG Road', 'Ring Road', 'Market Road',
  'College Road', 'Linking Road', 'FC Road', 'Baner Road', 'Nagar Road',
  'Central Avenue Road', 'Gangapur Road',
];

function pickRandomAddressItem(items, random) {
  const n = Number(random());
  const frac = Number.isFinite(n) ? Math.min(0.999999, Math.max(0, n)) : 0;
  return items[Math.floor(frac * items.length)];
}

export function formatSwiggyAddress(address) {
  if (!address) return '';
  if (typeof address === 'string') return address.trim();
  if (typeof address.address === 'string' && address.address.trim()) return address.address.trim();
  return [
    address.flatNo || address.houseNo || '',
    address.street || '',
    address.area || '',
    address.landmark || '',
    address.city || '',
    address.state || '',
    address.pincode ? `- ${address.pincode}` : '',
  ].filter(Boolean).join(', ').replace(/\s+-\s+/g, ' - ').trim();
}

// Fresh account ke liye Maharashtra ka complete random delivery address.
// Fields is tarah rakhe hain ke wahi object local export, Swiggy CAS
// (central-address-service) create payload aur official MCP create_address
// shape teeno me map ho jaye.
export function generateRandomSwiggyAddress(phone, name = 'Rahul Kumar', random = Math.random) {
  const where = pickRandomAddressItem(RANDOM_SWIGGY_ADDRESS_AREAS, random);
  const street = pickRandomAddressItem(RANDOM_SWIGGY_ADDRESS_STREETS, random);
  const houseNo = 11 + Math.floor(Math.min(0.999999, Math.max(0, Number(random()) || 0)) * 780);
  const block = String.fromCharCode(65 + Math.floor(Math.min(0.999999, Math.max(0, Number(random()) || 0)) * 12));
  const floor = 1 + Math.floor(Math.min(0.999999, Math.max(0, Number(random()) || 0)) * 12);
  const jitter = () => Number((((Number(random()) || 0) - 0.5) * 0.006).toFixed(6));
  const flatNo = `Flat ${block}-${houseNo}, Floor ${floor}`;
  const addressLine2 = `${street}, ${where.area}`;
  const mobile = freshSwiggyEmailPhoneDigits(phone);
  const address = `${flatNo}, ${addressLine2}, ${where.landmark}, ${where.city}, ${where.state} - ${where.pincode}`;
  const lat = Number((where.lat + jitter()).toFixed(6));
  const lng = Number((where.lng + jitter()).toFixed(6));
  return {
    name: sanitizeSwiggyName(name),
    mobile,
    phone: mobile,
    address,
    fullAddress: address,
    addressLine: flatNo,
    addressLine2,
    flatNo,
    houseNo: flatNo,
    street,
    landmark: where.landmark,
    area: where.area,
    locality: where.area,
    city: where.city,
    state: where.state,
    pincode: where.pincode,
    postalCode: where.pincode,
    annotation: 'Home',
    addressType: 'HOME',
    addressCategory: 'HOME',
    lat,
    lng,
    latitude: lat,
    longitude: lng,
    source: 'generated-maharashtra',
    remoteAddressStatus: 'pending',
  };
}

// Swiggy Android ke central-address-service ka CreateAddressRequest
// (proto-JSON shape): entityCtx = customer, requestCtx = Swiggy India +
// android-consumer-app, address = formattedAddress/addressLine/... .
export function buildSwiggyCreateAddressPayload(addressDetails = {}, { customerId = '' } = {}) {
  const a = addressDetails || {};
  const entityId = String(customerId || a.customerId || '').trim();
  if (!entityId) return null;
  const formattedAddress = formatSwiggyAddress(a);
  if (!formattedAddress) return null;
  const lat = Number(a.lat ?? a.latitude);
  const lng = Number(a.lng ?? a.longitude);
  return {
    entityCtx: { id: entityId, type: 'ENTITY_TYPE_CUSTOMER' },
    requestCtx: {
      marketPlaceId: 'MARKET_PLACE_ID_SWIGGY_IN',
      clientCtx: { clientId: 'android-consumer-app', source: 'PROFILE' },
    },
    address: {
      formattedAddress,
      addressLine: String(a.addressLine || a.flatNo || a.houseNo || '').trim(),
      addressLine2: String(a.addressLine2 || [a.street, a.area || a.locality].filter(Boolean).join(', ')).trim(),
      landmark: String(a.landmark || '').trim(),
      city: String(a.city || '').trim(),
      locality: String(a.locality || a.area || '').trim(),
      ...(Number.isFinite(lat) && Number.isFinite(lng) ? { location: { lat, lng } } : {}),
      instructions: '',
      contactName: sanitizeSwiggyName(a.name || 'Rahul Kumar'),
      phone: freshSwiggyEmailPhoneDigits(a.mobile || a.phone || ''),
      voiceDirectionsS3Uri: '',
      marketPlaceId: 'MARKET_PLACE_ID_SWIGGY_IN',
      addressCategory: ['ADDRESS_CATEGORY_HOME'],
      tags: ['Home'],
    },
  };
}

function findSwiggyAddressId(value, depth = 0) {
  if (!value || depth > 5) return '';
  if (typeof value === 'string' || typeof value === 'number') return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const id = findSwiggyAddressId(item, depth + 1);
      if (id) return id;
    }
    return '';
  }
  const direct = value.addressId ?? value.address_id ?? value.id;
  if (direct !== undefined && direct !== null && String(direct).trim() && String(direct).trim() !== '0') {
    return String(direct).trim();
  }
  for (const key of ['data', 'address', 'enrichedAddress', 'result', 'response']) {
    const id = findSwiggyAddressId(value[key], depth + 1);
    if (id) return id;
  }
  return '';
}

export function _isHtmlSwiggyResponseText(rawText = '') {
  const text = String(rawText || '').trimStart().toLowerCase();
  return text.startsWith('<!doctype html')
    || text.startsWith('<html')
    || text.startsWith('<head')
    || text.startsWith('<body')
    || (text.startsWith('<') && /<meta\b|<title\b|<script\b/.test(text.slice(0, 500)));
}

// Live run me CAS ka raw `<!doctype html>...` user ke card/export me chala
// gaya tha. Failure reason hamesha chhoti, insaan ke padhne layak hogi:
// HTML/WAF page ko naam se classify karo, markup kabhi wapas mat bhejo.
export function sanitizeSwiggyAddressFailureMessage(message = '', fallback = 'Swiggy address request fail ho gayi') {
  const raw = String(message ?? '').trim();
  if (!raw) return fallback;
  if (_isHtmlSwiggyResponseText(raw)) {
    return 'Swiggy ne HTML/WAF page diya (JSON address response nahi)';
  }
  const withoutTags = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
  const clean = withoutTags || fallback;
  if (/<!doctype|<html\b/i.test(clean)) {
    return 'Swiggy ne HTML/WAF page diya (JSON address response nahi)';
  }
  return clean.length > 220 ? `${clean.slice(0, 217).trim()}…` : clean;
}

export function parseSwiggyCreateAddressResponse(status, data = null, rawText = '') {
  const httpOk = Number(status) >= 200 && Number(status) < 300;
  const rpcError = data?.error?.message || data?.error?.status || (typeof data?.error === 'string' ? data.error : '');
  const swiggyCode = data?.statusCode;
  const swiggyOk = swiggyCode === undefined || swiggyCode === null || Number(swiggyCode) === 0;
  const addressId = findSwiggyAddressId(data);
  const responseKind = _isHtmlSwiggyResponseText(rawText)
    ? 'html'
    : (data ? 'json' : (String(rawText || '').trim() ? 'text' : 'empty'));
  const ok = Boolean(httpOk && swiggyOk && !rpcError && addressId && responseKind === 'json');
  return {
    ok,
    addressId,
    status: Number(status) || 0,
    responseKind,
    message: sanitizeSwiggyAddressFailureMessage(
      rpcError || data?.statusMessage || data?.message ||
      (ok
        ? 'Address added in Swiggy account'
        : responseKind === 'html'
          ? '<!doctype html>'
          : responseKind === 'text'
            ? String(rawText || '').slice(0, 220)
            : (httpOk ? 'Swiggy address response me addressId nahi mila' : `Swiggy address request HTTP ${Number(status) || 0} par fail ho gayi`))
    ),
  };
}

export const SWIGGY_ADDRESS_CREATE_URLS = [
  'https://www.swiggy.com/mapi/addresses/v1',
  'https://www.swiggy.com/dapi/addresses/v1',
];

// Fresh account banne ke baad address ko ASAL Swiggy account me add karne
// ki koshish. Endpoint Android central-address-service ka `addresses/v1`
// hai; success sirf tab mana jata hai jab response me addressId aaye.
// Fail ho to fresh session ko fail nahi karte — address local record me
// rahega aur status `remoteAddressStatus` me saaf dikhega.
export async function addSwiggyAddressViaBridgeSession(session, addressDetails, {
  customerId = '',
  timeoutMs = 8_000,
  fetchImpl = null,
  urls = null,
} = {}) {
  if (!session?.cookieMap || typeof session.cookieMap.get !== 'function') {
    return { ok: false, addressId: '', status: 0, message: 'Swiggy session missing hai — remote address add skip' };
  }
  const payload = buildSwiggyCreateAddressPayload(addressDetails, { customerId });
  if (!payload) {
    return { ok: false, addressId: '', status: 0, message: 'customerId/address missing hai — remote address add skip' };
  }

  const tokenVal = session.cookieMap.get('token') || '';
  const tidVal = session.cookieMap.get('tid') || '';
  const sidVal = session.cookieMap.get('_sid') || '';
  const doFetch = fetchImpl || fetchSwiggy;
  const candidates = Array.isArray(urls) && urls.length
    ? urls
    : (String(process.env.SWIGGY_ADDRESS_CREATE_URL || '').trim()
      ? [String(process.env.SWIGGY_ADDRESS_CREATE_URL).trim()]
      : SWIGGY_ADDRESS_CREATE_URLS);

  let last = { ok: false, addressId: '', status: 0, message: 'address endpoint se jawab nahi aaya' };
  for (const url of candidates) {
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: buildAuthRequestHeaders(session, {
          referer: 'https://www.swiggy.com/my-account',
          useAndroidUa: true,
          extra: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'x-client-id': 'android-consumer-app',
            ...(tokenVal ? { token: tokenVal } : {}),
            ...(tidVal ? { tid: tidVal } : {}),
            ...(sidVal ? { sid: sidVal } : {}),
          },
        }),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(Math.max(2_000, Number(timeoutMs) || 8_000)),
      });
      try { applySetCookiesToMap(session.cookieMap, getResponseSetCookies(res)); } catch {}
      const rawText = typeof res?.text === 'function' ? await res.text().catch(() => '') : '';
      let data = null;
      try { data = rawText ? JSON.parse(rawText) : null; } catch {}
      if (!data && typeof res?.json === 'function' && !rawText) {
        data = await res.json().catch(() => null);
      }
      const parsed = parseSwiggyCreateAddressResponse(res?.status, data, rawText);
      last = { ...parsed, url };
      if (parsed.ok) return last;
      // Sirf route-missing par agli candidate try karo. Auth/validation/WAF
      // par dobara POST karna duplicate address bana sakta hai.
      if (![404, 405].includes(Number(res?.status))) break;
    } catch (e) {
      last = { ok: false, addressId: '', status: 0, url, message: String(e?.message || e).slice(0, 180) };
      break;
    }
  }
  return last;
}

function directSwiggyAddressId(raw = {}) {
  const value = raw?.addressId ?? raw?.address_id ?? raw?.id ?? raw?.addressID;
  const clean = String(value ?? '').trim();
  return clean && clean !== '0' ? clean : '';
}

export function extractSwiggySavedAddresses(data) {
  const out = [];
  const seenObjects = new Set();
  const seenIds = new Set();
  const visit = (value, depth = 0) => {
    if (!value || depth > 6) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== 'object' || seenObjects.has(value)) return;
    seenObjects.add(value);
    const id = directSwiggyAddressId(value);
    const hasAddressShape = Boolean(
      value.address || value.formattedAddress || value.completeAddress || value.display_address
      || value.flat_no || value.flatNo || value.addressLine || value.area || value.city
      || value.landmark || value.lat !== undefined || value.location
    );
    if (id && hasAddressShape && !seenIds.has(id)) {
      seenIds.add(id);
      out.push(value);
    }
    const preferred = ['addresses', 'addressList', 'data', 'result', 'items', 'list', 'response'];
    for (const key of preferred) if (value[key]) visit(value[key], depth + 1);
    for (const [key, child] of Object.entries(value)) {
      if (!preferred.includes(key) && child && typeof child === 'object') visit(child, depth + 1);
    }
  };
  visit(data);
  return out;
}

export function normalizeVerifiedSwiggyAddress(raw = {}, fallback = {}) {
  const id = directSwiggyAddressId(raw) || findSwiggyAddressId(raw);
  const lat = Number(raw.lat ?? raw.latitude ?? raw.location?.lat ?? raw.location?.latitude ?? fallback.lat ?? fallback.latitude);
  const lng = Number(raw.lng ?? raw.longitude ?? raw.location?.lng ?? raw.location?.longitude ?? fallback.lng ?? fallback.longitude);
  const mapped = {
    name: raw.name || raw.contactName || fallback.name || 'Rahul Kumar',
    mobile: freshSwiggyEmailPhoneDigits(raw.mobile || raw.phone || fallback.mobile || fallback.phone || ''),
    phone: freshSwiggyEmailPhoneDigits(raw.mobile || raw.phone || fallback.mobile || fallback.phone || ''),
    address: raw.address || raw.formattedAddress || raw.completeAddress || raw.display_address || fallback.address || '',
    addressLine: raw.addressLine || raw.flat_no || raw.flatNo || fallback.addressLine || fallback.flatNo || '',
    addressLine2: raw.addressLine2 || raw.address_line_2 || fallback.addressLine2 || '',
    flatNo: raw.flat_no || raw.flatNo || raw.addressLine || fallback.flatNo || '',
    landmark: raw.landmark || fallback.landmark || '',
    area: raw.area || raw.locality || fallback.area || fallback.locality || '',
    locality: raw.locality || raw.area || fallback.locality || fallback.area || '',
    city: raw.city || fallback.city || '',
    state: raw.state || fallback.state || 'Maharashtra',
    pincode: String(raw.pincode || raw.postalCode || fallback.pincode || fallback.postalCode || ''),
    annotation: raw.annotation || fallback.annotation || 'Home',
    addressType: raw.addressType || raw.annotation || fallback.addressType || 'HOME',
  };
  if (!mapped.address) mapped.address = formatSwiggyAddress({ ...fallback, ...mapped });
  return {
    ...fallback,
    ...Object.fromEntries(Object.entries(mapped).filter(([, v]) => v !== undefined && v !== null && v !== '')),
    fullAddress: mapped.address,
    postalCode: mapped.pincode || fallback.postalCode || fallback.pincode || '',
    ...(Number.isFinite(lat) ? { lat, latitude: lat } : {}),
    ...(Number.isFinite(lng) ? { lng, longitude: lng } : {}),
    source: 'swiggy-saved-address',
    remoteAddressStatus: 'added',
    remoteAddressId: id,
    addressId: id,
    remoteAddressMessage: 'Swiggy saved address verified',
    verifiedAt: new Date().toISOString(),
  };
}

function compactAddressText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function findMatchingSwiggySavedAddress(addresses = [], details = {}) {
  const targetLat = Number(details.lat ?? details.latitude);
  const targetLng = Number(details.lng ?? details.longitude);
  const targetPhone = freshSwiggyEmailPhoneDigits(details.mobile || details.phone || '');
  const flatText = compactAddressText(details.flatNo || details.addressLine || '');
  const houseToken = String(details.flatNo || '').match(/([a-z]\s*[- ]\s*\d+)/i)?.[1]?.toLowerCase().replace(/\s+/g, '') || '';
  let best = null;

  for (const raw of Array.isArray(addresses) ? addresses : []) {
    const id = directSwiggyAddressId(raw);
    if (!id) continue;
    const search = compactAddressText([
      raw.address, raw.formattedAddress, raw.completeAddress, raw.display_address,
      raw.flat_no, raw.flatNo, raw.addressLine, raw.addressLine2, raw.landmark,
      raw.area, raw.locality, raw.city, raw.pincode, raw.postalCode,
    ].filter(Boolean).join(' '));
    let score = 0;
    const rawLat = Number(raw.lat ?? raw.latitude ?? raw.location?.lat ?? raw.location?.latitude);
    const rawLng = Number(raw.lng ?? raw.longitude ?? raw.location?.lng ?? raw.location?.longitude);
    if (Number.isFinite(targetLat) && Number.isFinite(targetLng) && Number.isFinite(rawLat) && Number.isFinite(rawLng)) {
      const distance = Math.max(Math.abs(targetLat - rawLat), Math.abs(targetLng - rawLng));
      if (distance <= 0.002) score += 3;
      else if (distance <= 0.01) score += 2;
    }
    const rawPhone = freshSwiggyEmailPhoneDigits(raw.mobile || raw.phone || '');
    if (targetPhone && rawPhone && rawPhone === targetPhone) score += 2;
    const compactSearch = search.replace(/\s+/g, '');
    let strongTextMatch = false;
    if (houseToken && compactSearch.includes(houseToken)) { score += 4; strongTextMatch = true; }
    else if (flatText && search.includes(flatText)) { score += 3; strongTextMatch = true; }
    if (details.pincode && search.includes(String(details.pincode))) score += 2;
    if (details.area && search.includes(compactAddressText(details.area))) score += 1;
    if (details.city && search.includes(compactAddressText(details.city))) score += 1;
    const landmarkCore = compactAddressText(details.landmark || '').replace(/^near\s+/, '');
    if (landmarkCore && search.includes(landmarkCore)) score += 1;
    if (!best || score > best.score) best = { raw, score, strongTextMatch };
  }
  // Sirf phone + aas-paas ke coordinates kafi nahi: same building ka
  // purana dusra flat bhi galat "verified" ban sakta hai. Flat/house text
  // mile, ya baaki address evidence itna zyada ho ke shaq na rahe.
  return best && best.score >= 5 && (best.strongTextMatch || best.score >= 8) ? best.raw : null;
}

export async function fetchSwiggySavedAddressesViaBridgeSession(session, {
  fetchImpl = null,
  timeoutMs = 8_000,
} = {}) {
  if (!session?.cookieMap || typeof session.cookieMap.get !== 'function') {
    return { ok: false, status: 0, addresses: [], message: 'Swiggy session missing hai' };
  }
  try {
    if (!fetchImpl) await bootstrapSwiggyAuthJar(session);
    const doFetch = fetchImpl || fetchSwiggy;
    const res = await doFetch('https://www.swiggy.com/dapi/address/all', {
      method: 'POST',
      headers: buildAuthRequestHeaders(session, {
        referer: 'https://www.swiggy.com/my-account',
        useAndroidUa: session.transportMode === 'android',
        extra: { Accept: 'application/json', 'Content-Type': 'application/json' },
      }),
      body: JSON.stringify(session.csrfToken ? { _csrf: session.csrfToken } : {}),
      signal: AbortSignal.timeout(Math.max(2_000, Number(timeoutMs) || 8_000)),
    });
    try { applySetCookiesToMap(session.cookieMap, getResponseSetCookies(res)); } catch {}
    const rawText = typeof res?.text === 'function' ? await res.text().catch(() => '') : '';
    let data = null;
    try { data = rawText ? JSON.parse(rawText) : null; } catch {}
    if (!data && typeof res?.json === 'function' && !rawText) data = await res.json().catch(() => null);
    const statusCodeOk = data?.statusCode === undefined || data?.statusCode === null || Number(data.statusCode) === 0;
    const ok = Number(res?.status) >= 200 && Number(res?.status) < 300 && statusCodeOk && !data?.error;
    return {
      ok,
      status: Number(res?.status) || 0,
      addresses: ok ? extractSwiggySavedAddresses(data) : [],
      data,
      message: ok
        ? ''
        : sanitizeSwiggyAddressFailureMessage(
          data?.statusMessage || data?.message || data?.error?.message || rawText,
          `Saved address list HTTP ${Number(res?.status) || 0} par fail ho gayi`
        ),
    };
  } catch (e) {
    return { ok: false, status: 0, addresses: [], message: String(e?.message || e).slice(0, 180) };
  }
}

export function buildSwiggyWebAddressFormValues(addressDetails = {}) {
  const a = addressDetails || {};
  const address = [
    a.street,
    a.area || a.locality,
    a.city,
    a.state && a.pincode ? `${a.state} - ${a.pincode}` : (a.state || a.pincode),
  ].filter(Boolean).join(', ');
  return {
    address: address || formatSwiggyAddress(a),
    flatNo: String(a.flatNo || a.addressLine || a.houseNo || '').trim(),
    landmark: String(a.landmark || '').trim(),
    label: 'Home',
    lat: Number(a.lat ?? a.latitude),
    lng: Number(a.lng ?? a.longitude),
  };
}

// Browser se wapas aayi cookies ko HTTP-auth session par andha overwrite
// nahi karna. Solver/guest page ke `_is_logged_in=0` ya guest tid/token
// asal authenticated cookies ko downgrade kar dein to Add Address page
// login state me chala jata hai aur form kabhi render nahi hota.
export function _mergeSwiggyBrowserCookies(cookieMap, cookies = []) {
  if (!cookieMap || typeof cookieMap.get !== 'function' || typeof cookieMap.set !== 'function') return 0;
  const list = Array.isArray(cookies) ? cookies.filter((c) => c?.name && c?.value && c.name !== 'aws-waf-token') : [];
  const pageLoggedIn = checkLoggedInFromCookies(list);
  const critical = new Set(['tid', '_session_tid', 'token', '_sid', '_is_logged_in']);
  let merged = 0;
  for (const cookie of list) {
    const name = String(cookie.name);
    const value = String(cookie.value);
    const existing = cookieMap.get(name);
    if (name === '_is_logged_in' && existing === '1' && value !== '1') continue;
    if (critical.has(name) && existing && !pageLoggedIn) continue;
    cookieMap.set(name, value);
    merged++;
  }
  return merged;
}

function normalizeAddressPageText(value = '') {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Live page kis haalat me hai, ye pehle classify karo. Pehle wala code
// map/login/WAF/loading sab ko ek hi `fields=0` bol kar 35-45s ghumta
// rehta tha. Ab terminal states turant rukengi aur map-gate par asal
// Proceed/Confirm action try hoga.
export function classifySwiggyAddressPageState(snapshot = {}, savedList = {}) {
  const snap = snapshot || {};
  const url = String(snap.url || '');
  const title = normalizeAddressPageText(snap.title || '');
  const body = normalizeAddressPageText(snap.bodyText || snap.text || '');
  const fields = Array.isArray(snap.fields) ? snap.fields : [];
  const usableFields = fields.filter((field) => field && field.visible !== false && !field.disabled);
  const buttons = (Array.isArray(snap.buttons) ? snap.buttons : [])
    .map((button) => normalizeAddressPageText(typeof button === 'string' ? button : button?.text || ''))
    .filter(Boolean);
  const hasAddressLabels = /door flat|landmark|save address|delivery address/.test(body);
  const savedStatus = Number(savedList?.status) || 0;

  if (usableFields.length > 0 && (hasAddressLabels || buttons.some((text) => text.includes('save address')))) {
    return 'form-ready';
  }
  if (/security check|verify you are human|are you human|captcha|aws waf|unusual traffic|request blocked/.test(`${title} ${body}`)) {
    return 'security-challenge';
  }
  if (url && !url.includes('/web-cart-add-address') && !hasAddressLabels) {
    return 'redirected';
  }
  if ((savedStatus === 401 && !hasAddressLabels)
    || (/\b(log in|login|sign up|signup)\b/.test(body) && /account|existing account/.test(body) && !hasAddressLabels)) {
    return 'login-required';
  }
  if (/drag map|save delivery address|select delivery address|confirm location/.test(body)
    || buttons.some((text) => text === 'proceed' || text.includes('confirm location'))) {
    return 'map-gate';
  }
  if (snap.readyState && snap.readyState !== 'complete') return 'loading';
  if (body.length < 20) return 'loading';
  return usableFields.length > 0 ? 'form-ready' : 'form-not-found';
}

function swiggyAddressSnapshotInBrowser() {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const collect = (selector, root = document, out = [], seen = new Set()) => {
    if (!root || seen.has(root)) return out;
    seen.add(root);
    try { out.push(...root.querySelectorAll(selector)); } catch {}
    try {
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) collect(selector, el.shadowRoot, out, seen);
      }
    } catch {}
    return out;
  };
  const describe = (el) => {
    const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
    let style = null;
    try { style = window.getComputedStyle(el); } catch {}
    const visible = Boolean(
      rect && rect.width > 0 && rect.height > 0
      && style?.display !== 'none'
      && style?.visibility !== 'hidden'
      && Number(style?.opacity ?? 1) !== 0
    );
    let labelText = '';
    try {
      labelText = [...(el.labels || [])].map((label) => label.textContent || '').join(' ');
    } catch {}
    if (!labelText) {
      let node = el;
      for (let i = 0; i < 4 && node; i += 1) {
        const candidate = node.parentElement?.querySelector?.('label, [class*="label" i]');
        if (candidate?.textContent) { labelText = candidate.textContent; break; }
        node = node.parentElement;
      }
    }
    return {
      tag: String(el.tagName || '').toLowerCase(),
      type: String(el.getAttribute?.('type') || el.type || ''),
      name: String(el.getAttribute?.('name') || el.name || ''),
      id: String(el.id || ''),
      placeholder: String(el.getAttribute?.('placeholder') || el.placeholder || ''),
      ariaLabel: String(el.getAttribute?.('aria-label') || ''),
      label: norm(labelText).slice(0, 80),
      visible,
      disabled: Boolean(el.disabled || el.getAttribute?.('aria-disabled') === 'true'),
      readOnly: Boolean(el.readOnly),
      x: rect ? Math.round(rect.left + rect.width / 2) : 0,
      y: rect ? Math.round(rect.top + rect.height / 2) : 0,
      width: rect ? Math.round(rect.width) : 0,
      height: rect ? Math.round(rect.height) : 0,
    };
  };
  const fields = collect('input, textarea, [contenteditable="true"], [role="textbox"]')
    .filter((el) => !['hidden', 'checkbox', 'radio', 'button', 'submit', 'file'].includes(String(el.getAttribute?.('type') || el.type || '').toLowerCase()))
    .map(describe);
  const buttons = collect('button, a, [role="button"]')
    .map((el) => {
      const d = describe(el);
      return {
        text: norm(el.textContent || el.getAttribute?.('aria-label') || '').slice(0, 80),
        visible: d.visible,
        disabled: d.disabled,
        tag: d.tag,
        x: d.x,
        y: d.y,
        width: d.width,
        height: d.height,
      };
    })
    .filter((button) => button.text);
  return {
    url: location.href,
    title: document.title || '',
    readyState: document.readyState || '',
    bodyText: String(document.body?.innerText || document.body?.textContent || '').slice(0, 4000),
    fields,
    buttons,
  };
}

function swiggyAddressFillInBrowser(values) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const collect = (selector, root = document, out = [], seen = new Set()) => {
    if (!root || seen.has(root)) return out;
    seen.add(root);
    try { out.push(...root.querySelectorAll(selector)); } catch {}
    try {
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) collect(selector, el.shadowRoot, out, seen);
      }
    } catch {}
    return out;
  };
  const visible = (el) => {
    if (!el) return false;
    const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
    let style = null;
    try { style = window.getComputedStyle(el); } catch {}
    return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden' && Number(style?.opacity ?? 1) !== 0);
  };
  const labelFor = (el) => {
    let text = '';
    try { text = [...(el.labels || [])].map((label) => label.textContent || '').join(' '); } catch {}
    if (text) return norm(text);
    let node = el;
    for (let i = 0; i < 5 && node; i += 1) {
      const candidate = node.parentElement?.querySelector?.('label, [class*="label" i]');
      if (candidate?.textContent) return norm(candidate.textContent);
      node = node.parentElement;
    }
    return '';
  };
  const attrs = (el) => norm([
    el.getAttribute?.('name') || el.name,
    el.id,
    el.getAttribute?.('placeholder') || el.placeholder,
    el.getAttribute?.('aria-label'),
  ].filter(Boolean).join(' '));
  const editables = collect('input, textarea, [contenteditable="true"], [role="textbox"]')
    .filter((el) => visible(el) && !el.disabled && !el.readOnly
      && !['hidden', 'checkbox', 'radio', 'button', 'submit', 'file'].includes(String(el.getAttribute?.('type') || el.type || '').toLowerCase()));
  const score = (el, kind) => {
    const attr = attrs(el);
    const label = labelFor(el);
    const hay = `${attr} ${label}`;
    if (kind === 'flatNo') {
      if (/\b(building|house)\b/.test(attr)) return 100;
      if (/\b(flat|door)\b/.test(attr)) return 95;
      if (/door flat|flat no|door no|house no/.test(hay)) return 90;
      if (/\bflat\b|\bdoor\b/.test(label)) return 80;
    }
    if (kind === 'landmark') {
      if (/\blandmark\b/.test(attr)) return 100;
      if (/\blandmark\b/.test(label)) return 95;
    }
    if (kind === 'address') {
      if (/\b(address|street|completeaddress)\b/.test(attr) && !/\b(building|house|flat|door|landmark)\b/.test(attr)) return 100;
      if (label === 'address' || /complete address/.test(label)) return 90;
      if (/\baddress\b/.test(label) && !/door|flat|landmark/.test(label)) return 75;
    }
    return 0;
  };
  const used = new Set();
  const pick = (kind) => {
    const ranked = editables
      .filter((el) => !used.has(el))
      .map((el) => ({ el, value: score(el, kind) }))
      .filter((item) => item.value > 0)
      .sort((a, b) => b.value - a.value);
    const el = ranked[0]?.el || null;
    if (el) used.add(el);
    return el;
  };
  let flatEl = pick('flatNo');
  let landmarkEl = pick('landmark');
  let addressEl = pick('address');
  if (!flatEl || !landmarkEl || !addressEl) {
    const remaining = editables.filter((el) => !used.has(el));
    if (!flatEl && !landmarkEl && !addressEl) {
      if (editables.length >= 3) {
        [addressEl, flatEl, landmarkEl] = editables;
      } else if (editables.length === 2) {
        [flatEl, landmarkEl] = editables;
      } else if (editables.length === 1) {
        [flatEl] = editables;
      }
    } else {
      if (!flatEl && remaining.length) flatEl = remaining.shift();
      if (!landmarkEl && remaining.length) landmarkEl = remaining.shift();
      if (!addressEl && remaining.length >= 2) addressEl = remaining.shift();
    }
  }
  const setValue = (el, value) => {
    if (!el || !String(value || '')) return false;
    try {
      el.scrollIntoView?.({ block: 'center' });
      el.focus?.();
      el.click?.();
      if (el.isContentEditable || el.getAttribute?.('contenteditable') === 'true') {
        el.textContent = value;
      } else {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, value); else el.value = value;
      }
      try { el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })); }
      catch { el.dispatchEvent(new Event('input', { bubbles: true })); }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur?.();
      const current = el.isContentEditable ? el.textContent : el.value;
      return String(current || '') === String(value || '');
    } catch {
      return false;
    }
  };
  const filled = {
    address: setValue(addressEl, values.address),
    flatNo: setValue(flatEl, values.flatNo),
    landmark: setValue(landmarkEl, values.landmark),
  };
  const homeCandidates = collect('button, a, [role="button"], div, span')
    .filter((el) => visible(el) && norm(el.textContent) === 'home');
  const home = homeCandidates.find((el) => {
    let node = el;
    for (let i = 0; i < 6 && node; i += 1) {
      const group = norm(node.parentElement?.textContent || node.textContent);
      if (group.includes('work') && group.includes('other')) return true;
      node = node.parentElement;
    }
    return false;
  }) || homeCandidates.sort((a, b) => String(a.textContent).length - String(b.textContent).length)[0];
  try { (home?.closest?.('button, a, [role="button"]') || home)?.click(); } catch {}
  const save = collect('button, a, [role="button"], div, span')
    .filter((el) => visible(el) && norm(el.textContent).includes('save address'))
    .sort((a, b) => String(a.textContent).length - String(b.textContent).length)[0];
  const descriptor = (el) => el ? `${String(el.tagName || '').toLowerCase()}:${String(el.getAttribute?.('name') || el.name || el.id || el.getAttribute?.('placeholder') || '')}` : '';
  return {
    ok: Boolean(filled.flatNo && (filled.address || !addressEl)),
    filled,
    fields: editables.length,
    addressStatic: Boolean(!addressEl),
    selected: { address: descriptor(addressEl), flatNo: descriptor(flatEl), landmark: descriptor(landmarkEl) },
    saveDisabled: save ? Boolean(save.disabled || save.getAttribute?.('aria-disabled') === 'true') : null,
    url: location.href,
  };
}

function swiggyAddressClickTextInBrowser(patterns) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const collect = (selector, root = document, out = [], seen = new Set()) => {
    if (!root || seen.has(root)) return out;
    seen.add(root);
    try { out.push(...root.querySelectorAll(selector)); } catch {}
    try {
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) collect(selector, el.shadowRoot, out, seen);
      }
    } catch {}
    return out;
  };
  const visible = (el) => {
    const rect = typeof el?.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
    let style = null;
    try { style = window.getComputedStyle(el); } catch {}
    return Boolean(el && rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden');
  };
  const wanted = (Array.isArray(patterns) ? patterns : []).map(norm).filter(Boolean);
  const interactiveSelector = 'button, a, [role="button"], [tabindex]';
  const rectOf = (el) => {
    try { return el?.getBoundingClientRect?.() || null; } catch { return null; }
  };
  const styleOf = (el) => {
    try { return window.getComputedStyle(el); } catch { return null; }
  };
  const isDisabled = (el) => {
    if (!el) return true;
    const style = styleOf(el);
    const className = typeof el.className === 'string' ? el.className : String(el.getAttribute?.('class') || '');
    return Boolean(
      el.disabled
      || el.getAttribute?.('aria-disabled') === 'true'
      || style?.pointerEvents === 'none'
      || /(^|[\s_-])(disabled|inactive)([\s_-]|$)/i.test(className)
    );
  };
  const targetScore = (el) => {
    if (!el) return 9;
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'button' || tag === 'a' || el.getAttribute?.('role') === 'button') return 0;
    if (el.hasAttribute?.('tabindex') || styleOf(el)?.cursor === 'pointer') return 1;
    return 2;
  };
  const resolveTarget = (el) => {
    if (!el) return null;
    if ((el.matches?.(interactiveSelector) || styleOf(el)?.cursor === 'pointer') && visible(el) && !isDisabled(el)) return el;
    let descendants = [];
    try { descendants = [...el.querySelectorAll(interactiveSelector)]; } catch {}
    descendants = descendants
      .filter((child) => visible(child) && !isDisabled(child))
      .sort((a, b) => {
        const ar = rectOf(a); const br = rectOf(b);
        return ((ar?.width || 0) * (ar?.height || 0)) - ((br?.width || 0) * (br?.height || 0));
      });
    if (descendants[0]) return descendants[0];
    const ancestor = el.closest?.(interactiveSelector);
    if (ancestor && visible(ancestor) && !isDisabled(ancestor)) return ancestor;
    return isDisabled(el) ? null : el;
  };
  const candidates = collect('button, a, [role="button"], [tabindex], div, span')
    .map((el) => ({
      el,
      text: norm(el.textContent || el.getAttribute?.('aria-label') || ''),
    }))
    // Pehle sirf wanted text wale chand elements rakho; Google Map ke
    // saikdon divs par descendant-resolve chalana click ko slow kar dega.
    .filter(({ el, text }) => visible(el) && text && wanted.some((pattern) => text === pattern || text.includes(pattern)))
    .map(({ el, text }) => {
      const target = resolveTarget(el);
      const targetText = norm(target?.textContent || target?.getAttribute?.('aria-label') || text);
      const rect = rectOf(target);
      return { el, text, target, targetText, area: rect ? rect.width * rect.height : Number.MAX_SAFE_INTEGER };
    })
    .filter(({ target }) => Boolean(target))
    .sort((a, b) => {
      const aExact = wanted.some((pattern) => a.text === pattern) ? 0 : 1;
      const bExact = wanted.some((pattern) => b.text === pattern) ? 0 : 1;
      const patternRank = (text) => {
        const index = wanted.findIndex((pattern) => text === pattern || text.includes(pattern));
        return index >= 0 ? index : 99;
      };
      return (aExact - bExact)
        || (patternRank(a.text) - patternRank(b.text))
        || (targetScore(a.target) - targetScore(b.target))
        || (a.targetText.length - b.targetText.length)
        || (a.area - b.area)
        || (a.text.length - b.text.length);
    });
  const found = candidates[0];
  if (!found?.target) return { clicked: false, text: '' };
  const target = found.target;
  const rectBefore = rectOf(target);
  const point = {
    x: rectBefore ? Math.round(rectBefore.left + rectBefore.width / 2) : 0,
    y: rectBefore ? Math.round(rectBefore.top + rectBefore.height / 2) : 0,
    width: rectBefore ? Math.round(rectBefore.width) : 0,
    height: rectBefore ? Math.round(rectBefore.height) : 0,
  };
  try {
    target.scrollIntoView?.({ block: 'center' });
    target.focus?.({ preventScroll: true });
    const rectAfterScroll = rectOf(target);
    if (rectAfterScroll) {
      point.x = Math.round(rectAfterScroll.left + rectAfterScroll.width / 2);
      point.y = Math.round(rectAfterScroll.top + rectAfterScroll.height / 2);
      point.width = Math.round(rectAfterScroll.width);
      point.height = Math.round(rectAfterScroll.height);
    }
    // Exactly ONE activation. Synthetic pointer/mouse sequence + native
    // click pehle Proceed/SAVE ko do baar fire kar sakta tha; agar native
    // click kisi custom div par na ho to sirf ek MouseEvent bhejo.
    if (typeof target.click === 'function') target.click();
    else target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  } catch {
    return { clicked: false, text: found.text, tag: String(target.tagName || '').toLowerCase(), ...point };
  }
  return { clicked: true, text: found.text, tag: String(target.tagName || '').toLowerCase(), ...point };
}

async function fetchSavedAddressesInSwiggyPage(page) {
  const result = await page.evaluate(async () => {
    try {
      const csrf = (typeof window !== 'undefined' && window._csrf) ? window._csrf : '';
      const res = await fetch('/dapi/address/all', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(csrf ? { _csrf: csrf } : {}),
        credentials: 'include',
        signal: AbortSignal.timeout(5000),
      });
      const text = await res.text().catch(() => '');
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch {}
      return { status: res.status, data, rawText: text.slice(0, 500) };
    } catch (e) {
      return { status: 0, data: null, error: String(e?.message || e) };
    }
  }).catch((e) => ({ status: 0, data: null, error: String(e?.message || e) }));
  const ok = Number(result?.status) >= 200 && Number(result?.status) < 300
    && (result?.data?.statusCode === undefined || result?.data?.statusCode === null || Number(result.data.statusCode) === 0);
  return {
    ok,
    status: Number(result?.status) || 0,
    addresses: ok ? extractSwiggySavedAddresses(result.data) : [],
    message: ok
      ? ''
      : sanitizeSwiggyAddressFailureMessage(
        result?.error || result?.data?.statusMessage || result?.data?.message || result?.rawText,
        `Saved address list HTTP ${Number(result?.status) || 0} par fail ho gayi`
      ),
    responseKind: _isHtmlSwiggyResponseText(result?.rawText) ? 'html' : (result?.data ? 'json' : 'empty'),
  };
}

function summarizeSwiggyAddressSnapshot(snapshot = {}) {
  const fields = (Array.isArray(snapshot?.fields) ? snapshot.fields : []).slice(0, 6).map((field) => ({
    tag: String(field?.tag || ''),
    name: String(field?.name || ''),
    id: String(field?.id || ''),
    placeholder: String(field?.placeholder || '').slice(0, 40),
    label: String(field?.label || '').slice(0, 40),
    visible: field?.visible !== false,
  }));
  const buttons = (Array.isArray(snapshot?.buttons) ? snapshot.buttons : [])
    .map((button) => {
      const text = String(typeof button === 'string' ? button : button?.text || '').trim();
      return button && typeof button === 'object' && button.disabled && text ? `${text}(disabled)` : text;
    })
    .filter(Boolean)
    .slice(0, 6);
  let path = '';
  try { path = new URL(String(snapshot?.url || '')).pathname; } catch { path = String(snapshot?.url || '').slice(0, 80); }
  return { path, title: String(snapshot?.title || '').slice(0, 60), fields, buttons };
}

function swiggyAddressPageFailureMessage(state, snapshot = {}) {
  const summary = summarizeSwiggyAddressSnapshot(snapshot);
  const allFields = Array.isArray(snapshot?.fields) ? snapshot.fields : [];
  const fieldCount = allFields.filter((field) => field?.visible !== false && !field?.disabled).length;
  const fieldSummary = `${fieldCount}/${allFields.length}`;
  const buttons = summary.buttons.slice(0, 5).join('|') || 'none';
  if (state === 'login-required') return 'Add Address page par login session recognize nahi hua (state=login-required)';
  if (state === 'security-challenge') return 'Add Address page security check par atka hai (state=security-challenge)';
  if (state === 'redirected') return `Add Address page redirect ho gaya (state=redirected, path=${summary.path || 'unknown'})`;
  if (state === 'map-gate') return `Add Address map/Proceed gate se aage nahi badha (fields=${fieldSummary}, buttons=${buttons})`;
  if (state === 'loading') return `Add Address page time par load nahi hua (fields=${fieldSummary})`;
  return `Add Address form ready nahi hua (state=${state || 'unknown'}, fields=${fieldSummary}, buttons=${buttons})`;
}

// Asal Swiggy "Add Address" web page par jaakar form bharna. Desktop web
// pehle, mobile WebView uske baad; har frame/shadow-root me asal fields
// dhoondhe jayenge. Checkout ke proven input names `building`/`house`
// aur `landmark` ko pehli tarjeeh milegi; Address static map text ho to
// use zabardasti kisi galat input me nahi bhara jayega. Success tabhi
// mana jayega jab create response ya saved-address list se pakka
// addressId verify ho jaye.
export async function addSwiggyAddressViaWebUi(session, addressDetails, {
  timeoutMs = 32_000,
  pageFactory = null,
  shouldAbort = null,
} = {}) {
  const form = buildSwiggyWebAddressFormValues(addressDetails);
  if (!session?.cookieMap || !form.address || !form.flatNo || !Number.isFinite(form.lat) || !Number.isFinite(form.lng)) {
    return { ok: false, addressId: '', status: 0, method: 'web-add-address-ui', submitAttempted: false, pageState: 'invalid-input', message: 'Add Address form ke liye session/address/coordinates missing hain' };
  }
  if (!pageFactory && !(session.page && session.browser?.connected) && !canUseStealthBrowser()) {
    return { ok: false, addressId: '', status: 0, method: 'web-add-address-ui', submitAttempted: false, pageState: 'browser-missing', message: 'Chrome/Chromium nahi mila — asal Add Address page nahi khul paya' };
  }

  return withBrowserEscalationSlot(async () => {
    const startedAt = Date.now();
    const deadline = startedAt + Math.max(10_000, Number(timeoutMs) || 32_000);
    const remaining = () => Math.max(0, deadline - Date.now());
    const abortRequested = () => {
      try { return Boolean(shouldAbort?.() || _swiggyBridgeSessionAbortRequested(session)); } catch { return false; }
    };
    const waitInterruptibly = async (ms) => {
      const endAt = Date.now() + Math.max(0, Number(ms) || 0);
      while (Date.now() < endAt) {
        if (abortRequested()) return;
        await new Promise((resolve) => setTimeout(resolve, Math.min(120, Math.max(0, endAt - Date.now()))));
      }
    };
    let browser = null;
    let page = null;
    let ownedBrowser = false;
    let submitAttempted = false;
    const createResponses = [];
    let responseHandler = null;

    const syncCookiesBack = async () => {
      try {
        const cookies = await page.cookies('https://www.swiggy.com/').catch(() => []);
        _mergeSwiggyBrowserCookies(session.cookieMap, cookies || []);
      } catch {}
    };
    const abortedResult = (extra = {}) => ({
      ok: false,
      addressId: '',
      status: 0,
      method: 'web-add-address-ui',
      submitAttempted,
      uncertain: submitAttempted,
      aborted: true,
      pageState: 'aborted',
      message: 'Owner ne current number SKIP kar diya — Add Address step roka gaya',
      ...extra,
    });

    try {
      if (abortRequested()) return abortedResult();
      if (typeof pageFactory === 'function') {
        const launched = await pageFactory();
        browser = launched?.browser || null;
        page = launched?.page || null;
        ownedBrowser = Boolean(launched?.owned ?? browser);
      } else if (session.page && session.browser?.connected) {
        page = session.page;
        browser = session.browser;
      } else {
        const launched = await launchStealthSwiggyBrowser(getBridgeProxy());
        browser = launched.browser;
        page = launched.page;
        ownedBrowser = true;
      }
      if (!page) throw new Error('Add Address browser page nahi bana');

      try {
        const context = typeof page.browserContext === 'function'
          ? page.browserContext()
          : (typeof browser?.defaultBrowserContext === 'function' ? browser.defaultBrowserContext() : null);
        await context?.overridePermissions?.('https://www.swiggy.com', ['geolocation']);
      } catch {}
      try { await page.setGeolocation?.({ latitude: form.lat, longitude: form.lng, accuracy: 25 }); } catch {}

      const cookieMap = new Map(session.cookieMap);
      cookieMap.set('_is_logged_in', '1');
      cookieMap.set('userLocation', encodeURIComponent(JSON.stringify({
        lat: String(form.lat),
        lng: String(form.lng),
        address: form.address,
        area: addressDetails.area || addressDetails.locality || addressDetails.city || 'Maharashtra',
        id: '',
      })));
      if (session.wafToken) cookieMap.set('aws-waf-token', session.wafToken);

      // Reused solver page par guest cookies pehle se ho sakte hain. Same
      // naam wali purani cookie delete kiye baghair dusri host-only copy
      // ban jayegi aur server guest wali pehle padh sakta hai.
      try {
        const existingCookies = await page.cookies('https://www.swiggy.com/').catch(() => []);
        for (const cookie of existingCookies || []) {
          if (!cookie?.name || !cookieMap.has(cookie.name)) continue;
          try { await page.deleteCookie?.(cookie); } catch {}
        }
      } catch {}
      let cookiesAccepted = 0;
      for (const [name, value] of cookieMap.entries()) {
        if (!name || value === undefined || value === null || value === '') continue;
        const cookie = { name, value: String(value) };
        try {
          await page.setCookie({ ...cookie, domain: '.swiggy.com', path: '/', secure: true });
          cookiesAccepted++;
        } catch {
          try {
            await page.setCookie({ ...cookie, url: 'https://www.swiggy.com/', path: '/' });
            cookiesAccepted++;
          } catch {}
        }
        if (abortRequested()) return abortedResult();
      }
      if (cookieMap.size && !cookiesAccepted) {
        return { ok: false, addressId: '', status: 0, method: 'web-add-address-ui', submitAttempted: false, pageState: 'cookie-sync-failed', message: 'Browser me Swiggy login cookies set nahi ho payi' };
      }

      responseHandler = async (res) => {
        try {
          const req = typeof res.request === 'function' ? res.request() : null;
          const method = String(req?.method?.() || '').toUpperCase();
          const url = String(typeof res.url === 'function' ? res.url() : res.url || '');
          if (!['POST', 'PUT', 'PATCH'].includes(method) || !/address/i.test(url) || /\/address\/all(?:\?|$)/i.test(url)) return;
          const text = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
          let data = null;
          try { data = text ? JSON.parse(text) : null; } catch {}
          const status = Number(typeof res.status === 'function' ? res.status() : res.status) || 0;
          createResponses.push({ ...parseSwiggyCreateAddressResponse(status, data, text), url });
        } catch {}
      };
      try { page.on?.('response', responseHandler); } catch {}

      const targets = () => {
        try {
          const frames = typeof page.frames === 'function' ? page.frames() : [];
          const usable = (Array.isArray(frames) ? frames : []).filter((frame) => typeof frame?.evaluate === 'function');
          return usable.length ? usable : [page];
        } catch {
          return [page];
        }
      };
      const inspectTargets = async (savedList = {}) => {
        const out = [];
        const list = targets();
        for (let index = 0; index < list.length; index++) {
          const target = list[index];
          const snapshot = await target.evaluate(swiggyAddressSnapshotInBrowser)
            .catch((e) => ({ url: '', title: '', readyState: '', bodyText: '', fields: [], buttons: [], error: String(e?.message || e) }));
          const state = classifySwiggyAddressPageState(snapshot, savedList);
          const usableFields = (snapshot?.fields || []).filter((field) => field?.visible !== false && !field?.disabled).length;
          const score = (state === 'form-ready' ? 100 : state === 'map-gate' ? 50 : state === 'form-not-found' ? 20 : state === 'loading' ? 10 : 0) + usableFields;
          out.push({ target, index, snapshot, state, usableFields, score });
        }
        return out.sort((a, b) => b.score - a.score);
      };

      const addUrl = `https://www.swiggy.com/web-cart-add-address?lat=${encodeURIComponent(form.lat)}&lng=${encodeURIComponent(form.lng)}`;
      const phases = [
        { name: 'desktop', viewport: { width: 1280, height: 900 }, userAgent: '' },
        { name: 'mobile', viewport: { width: 430, height: 900, isMobile: true, hasTouch: true }, userAgent: session.deviceProfile?.ua || '' },
      ];
      let before = { ok: false, status: 0, addresses: [] };
      let fillResult = null;
      let fillTarget = page;
      let lastSnapshot = {};
      let lastState = 'loading';
      let lastPhase = phases[0].name;

      for (let phaseIndex = 0; phaseIndex < phases.length && !fillResult?.ok; phaseIndex++) {
        const phase = phases[phaseIndex];
        lastPhase = phase.name;
        if (phaseIndex > 0 && remaining() <= 9_000) break;
        try { await page.setViewport?.(phase.viewport); } catch {}
        if (phase.userAgent) {
          try { await page.setUserAgent?.(phase.userAgent); } catch {}
        }
        try {
          await page.goto(addUrl, {
            waitUntil: 'domcontentloaded',
            timeout: Math.min(15_000, Math.max(4_000, remaining())),
          });
        } catch (navError) {
          // DOMContentLoaded timeout par bhi SPA ka shell/form aksar ready
          // hota hai. Seedha fail karne ke bajaye snapshot se asal haalat lo.
          lastState = 'loading';
          lastSnapshot = { url: addUrl, bodyText: String(navError?.message || '') };
        }
        if (abortRequested()) return abortedResult();

        if (phaseIndex === 0) {
          before = await fetchSavedAddressesInSwiggyPage(page);
          const existing = findMatchingSwiggySavedAddress(before.addresses, addressDetails);
          if (existing) {
            const verifiedAddress = normalizeVerifiedSwiggyAddress(existing, addressDetails);
            await syncCookiesBack();
            return { ok: true, addressId: verifiedAddress.remoteAddressId, status: 200, method: 'web-add-address-ui-existing', submitAttempted: false, verifiedAddress, pageState: 'existing-saved', message: 'Address Swiggy account me pehle se saved verify ho gaya' };
          }
        }

        const phaseBudgetMs = phaseIndex === 0
          ? Math.min(9_000, Math.max(3_500, remaining() - 11_000))
          : Math.min(7_000, Math.max(3_000, remaining() - 8_000));
        const phaseDeadline = Date.now() + phaseBudgetMs;
        let gateClickAttempts = 0;
        let gateClickUnavailable = false;
        let mapGestureDone = false;
        let lastGatePoint = null;
        let terminalChecks = 0;

        while (Date.now() < phaseDeadline && remaining() > 6_500) {
          if (abortRequested()) return abortedResult();
          const inspected = await inspectTargets(before);
          const best = inspected[0] || { target: page, snapshot: {}, state: 'loading', usableFields: 0 };
          lastSnapshot = best.snapshot || {};
          lastState = best.state || 'unknown';
          fillTarget = best.target || page;

          if (['login-required', 'security-challenge', 'redirected'].includes(lastState)) {
            terminalChecks++;
            if (terminalChecks >= 2) break;
          } else {
            terminalChecks = 0;
          }

          if (best.usableFields > 0) {
            fillResult = await fillTarget.evaluate(swiggyAddressFillInBrowser, form)
              .catch((e) => ({ ok: false, fields: best.usableFields, error: String(e?.message || e) }));
            if (fillResult?.ok) break;
            // Fields hain lekin React abhi hydrate ho raha hai to ek-do
            // short retry kaafi hai; poora timeout yahin nahi jalega.
            await waitInterruptibly(500);
            continue;
          }

          if (gateClickAttempts < 4 && ['map-gate', 'form-not-found'].includes(lastState)) {
            const snapshotButton = (Array.isArray(lastSnapshot?.buttons) ? lastSnapshot.buttons : [])
              .find((button) => button?.visible !== false && !button?.disabled
                && /proceed|enter complete address|confirm location|save delivery address|use current location|add new address/i.test(String(button?.text || ''))
                && Number(button?.x) > 0 && Number(button?.y) > 0);
            if (snapshotButton && gateClickAttempts < 2) lastGatePoint = { x: Number(snapshotButton.x), y: Number(snapshotButton.y) };
            let mainFrame = null;
            try { mainFrame = typeof page.mainFrame === 'function' ? page.mainFrame() : null; } catch {}
            const targetIsMainPage = fillTarget === page || (mainFrame && fillTarget === mainFrame);
            let viewportForPoint = phase.viewport;
            try { viewportForPoint = typeof page.viewport === 'function' ? page.viewport() : viewportForPoint; } catch {}
            const pointInViewport = Boolean(
              lastGatePoint
              && lastGatePoint.x > 0 && lastGatePoint.y > 0
              && lastGatePoint.x < (Number(viewportForPoint?.width) || phase.viewport.width)
              && lastGatePoint.y < (Number(viewportForPoint?.height) || phase.viewport.height)
            );
            const usePhysicalClick = gateClickAttempts % 2 === 1 && targetIsMainPage && pointInViewport;
            if (usePhysicalClick) {
              let physicalClicked = false;
              try {
                if (typeof page.mouse?.click === 'function') {
                  await page.mouse.click(lastGatePoint.x, lastGatePoint.y, { delay: 40 });
                  physicalClicked = true;
                } else if (typeof page.touchscreen?.tap === 'function') {
                  await page.touchscreen.tap(lastGatePoint.x, lastGatePoint.y);
                  physicalClicked = true;
                }
              } catch {}
              if (physicalClicked) {
                gateClickAttempts++;
                await waitInterruptibly(900);
                continue;
              }
            }
            const gatePatterns = gateClickAttempts >= 2
              ? ['enter complete address', 'add new address', 'add new', 'save delivery address', 'delivery address', 'add address', 'confirm location', 'proceed', 'use current location']
              : ['confirm location', 'proceed', 'enter complete address', 'save delivery address', 'use current location', 'add new address', 'add new'];
            const gate = await fillTarget.evaluate(
              swiggyAddressClickTextInBrowser,
              gatePatterns
            ).catch(() => ({ clicked: false }));
            if (Number(gate?.x) > 0 && Number(gate?.y) > 0) lastGatePoint = { x: Number(gate.x), y: Number(gate.y) };
            if (gate?.clicked) {
              gateClickAttempts++;
              await waitInterruptibly(900);
              continue;
            }
            // Proceed disabled/missing ho to click counter 0 par atka rahega;
            // pehle map ko jagao, phir reverse-geocode ke baad click dobara do.
            gateClickUnavailable = true;
          }

          if (!mapGestureDone && (gateClickAttempts >= 2 || gateClickUnavailable) && lastState === 'map-gate') {
            mapGestureDone = true;
            gateClickUnavailable = false;
            try {
              const viewport = typeof page.viewport === 'function' ? page.viewport() : phase.viewport;
              const width = Number(viewport?.width) || phase.viewport.width;
              const height = Number(viewport?.height) || phase.viewport.height;
              const x = Math.round(width / 2);
              const y = Math.round(height * 0.42);
              // Map ka sirf center tap aksar koi state-change nahi karta.
              // Halka drag Google Map ko center_changed / reverse-geocode
              // ki taraf dhakelta hai; uske baad Proceed phir try hoga.
              if (typeof page.mouse?.move === 'function' && typeof page.mouse?.down === 'function' && typeof page.mouse?.up === 'function') {
                await page.mouse.move(x, y, { steps: 4 });
                await page.mouse.down();
                await page.mouse.move(Math.min(width - 8, x + 36), Math.min(height - 8, y + 24), { steps: 12 });
                await page.mouse.up();
              } else if (typeof page.touchscreen?.tap === 'function') {
                await page.touchscreen.tap(x, y);
              } else if (typeof page.mouse?.click === 'function') {
                await page.mouse.click(x, y);
              }
            } catch {}
            await waitInterruptibly(900);
            continue;
          }

          await waitInterruptibly(500);
        }

        if (['login-required', 'security-challenge', 'redirected'].includes(lastState)) break;
      }

      if (!fillResult?.ok) {
        await syncCookiesBack();
        return {
          ok: false,
          addressId: '',
          status: Number(before?.status) || 0,
          method: 'web-add-address-ui',
          submitAttempted: false,
          pageState: lastState,
          pagePhase: lastPhase,
          pageSnapshot: summarizeSwiggyAddressSnapshot(lastSnapshot),
          message: fillResult?.error
            ? sanitizeSwiggyAddressFailureMessage(fillResult.error, swiggyAddressPageFailureMessage(lastState, lastSnapshot))
            : swiggyAddressPageFailureMessage(lastState, lastSnapshot),
        };
      }

      if (abortRequested()) return abortedResult();
      const saveClick = await fillTarget.evaluate(
        swiggyAddressClickTextInBrowser,
        ['save address & proceed', 'save address and proceed', 'save address', 'save & proceed', 'save and proceed']
      ).catch(() => ({ clicked: false }));
      submitAttempted = Boolean(saveClick?.clicked);
      if (!submitAttempted) {
        await syncCookiesBack();
        return { ok: false, addressId: '', status: 0, method: 'web-add-address-ui', submitAttempted: false, pageState: 'save-button-missing', pageSnapshot: summarizeSwiggyAddressSnapshot(lastSnapshot), message: 'SAVE ADDRESS button nahi mila' };
      }

      let lastPageError = '';
      let failureChecks = 0;
      const verifyDeadline = Date.now() + Math.min(12_000, Math.max(0, remaining()));
      while (Date.now() < verifyDeadline && remaining() > 0) {
        if (abortRequested()) return abortedResult();
        const created = createResponses.find((r) => r.ok && r.addressId);
        if (created) {
          const verifiedAddress = normalizeVerifiedSwiggyAddress({ id: created.addressId }, addressDetails);
          await syncCookiesBack();
          return { ok: true, ...created, method: 'web-add-address-ui', submitAttempted: true, verifiedAddress, pageState: 'saved', message: 'Address asal Swiggy Add Address page se save ho gaya' };
        }
        const listed = await fetchSavedAddressesInSwiggyPage(page);
        const matched = findMatchingSwiggySavedAddress(listed.addresses, addressDetails);
        if (matched) {
          const verifiedAddress = normalizeVerifiedSwiggyAddress(matched, addressDetails);
          await syncCookiesBack();
          return { ok: true, addressId: verifiedAddress.remoteAddressId, status: 200, method: 'web-add-address-ui', submitAttempted: true, verifiedAddress, pageState: 'saved', message: 'Address asal Swiggy Add Address page se save + saved list me verify ho gaya' };
        }
        const failedCreate = createResponses.find((r) => r.status && !r.ok);
        if (failedCreate?.message) lastPageError = sanitizeSwiggyAddressFailureMessage(failedCreate.message);
        const inspected = await inspectTargets(listed).catch(() => []);
        const currentSnapshot = inspected[0]?.snapshot || {};
        lastSnapshot = currentSnapshot;
        lastState = inspected[0]?.state || lastState;
        const errorLine = String(currentSnapshot.bodyText || '').split(/\n+/).map((x) => x.trim())
          .find((x) => /please enter|required|not serviceable|serviceable|something went wrong|try again|invalid|error/i.test(x));
        if (errorLine) lastPageError = sanitizeSwiggyAddressFailureMessage(errorLine);
        if (failedCreate || errorLine) {
          failureChecks++;
          // Explicit validation/create failure ke baad saved list 2 dafa
          // check ho chuki hai to bachi hui poori timeout mat jalao.
          if (failureChecks >= 2) break;
        }
        if (remaining() <= 900 || Date.now() >= verifyDeadline - 900) break;
        await waitInterruptibly(800);
      }

      await syncCookiesBack();
      return {
        ok: false,
        addressId: '',
        status: createResponses.at(-1)?.status || 0,
        method: 'web-add-address-ui',
        submitAttempted: true,
        uncertain: true,
        pageState: lastState,
        pageSnapshot: summarizeSwiggyAddressSnapshot(lastSnapshot),
        message: sanitizeSwiggyAddressFailureMessage(lastPageError || 'Add Address SAVE ke baad saved address verify nahi ho paya'),
      };
    } catch (e) {
      try { await syncCookiesBack(); } catch {}
      if (abortRequested()) return abortedResult();
      return { ok: false, addressId: '', status: 0, method: 'web-add-address-ui', submitAttempted, uncertain: submitAttempted, pageState: 'browser-error', message: sanitizeSwiggyAddressFailureMessage(e?.message || e) };
    } finally {
      try {
        if (page && responseHandler) {
          if (typeof page.off === 'function') page.off('response', responseHandler);
          else if (typeof page.removeListener === 'function') page.removeListener('response', responseHandler);
        }
      } catch {}
      if (ownedBrowser && browser) {
        try { await browser.close(); } catch {}
      }
    }
  });
}

// Pehle asal Add Address page. CAS API sirf tab fallback hai jab caller
// ne explicit URL diya ho (ya SWIGGY_ADDRESS_CREATE_URL configure ho) —
// www wali guessed `/mapi`/`/dapi` paths live run me HTML de kar sirf
// time jalati rahi hain. UI SAVE click ho chuka ho lekin verification
// uncertain ho to dusra POST nahi hoga, warna duplicate ban sakta hai.
export async function addSwiggyAddressToAccount(session, addressDetails, {
  customerId = '',
  timeoutMs = 38_000,
  fetchImpl = null,
  urls = null,
  browserAddImpl = null,
  pageFactory = null,
  shouldAbort = null,
} = {}) {
  const before = await fetchSwiggySavedAddressesViaBridgeSession(session, {
    fetchImpl,
    timeoutMs: Math.min(5_000, Math.max(2_000, Number(timeoutMs) || 5_000)),
  }).catch(() => ({ ok: false, addresses: [] }));
  const existing = findMatchingSwiggySavedAddress(before.addresses, addressDetails);
  if (existing) {
    const verifiedAddress = normalizeVerifiedSwiggyAddress(existing, addressDetails);
    return { ok: true, addressId: verifiedAddress.remoteAddressId, status: 200, method: 'saved-address-list', verifiedAddress, message: 'Address Swiggy saved list me verify ho gaya' };
  }

  const uiFn = typeof browserAddImpl === 'function' ? browserAddImpl : addSwiggyAddressViaWebUi;
  let ui;
  try {
    ui = await uiFn(session, addressDetails, {
      timeoutMs: Math.max(10_000, Math.min(34_000, Number(timeoutMs) || 32_000)),
      pageFactory,
      shouldAbort,
    });
  } catch (e) {
    ui = { ok: false, submitAttempted: false, pageState: 'browser-error', message: sanitizeSwiggyAddressFailureMessage(e?.message || e) };
  }
  if (ui?.ok && ui.addressId) {
    const verifiedAddress = ui.verifiedAddress?.remoteAddressId
      ? ui.verifiedAddress
      : normalizeVerifiedSwiggyAddress({ id: ui.addressId }, addressDetails);
    return { ...ui, verifiedAddress };
  }
  if (ui?.submitAttempted || ui?.uncertain) {
    const afterUi = await fetchSwiggySavedAddressesViaBridgeSession(session, { fetchImpl, timeoutMs: 5_000 })
      .catch(() => ({ ok: false, addresses: [] }));
    const matched = findMatchingSwiggySavedAddress(afterUi.addresses, addressDetails);
    if (matched) {
      const verifiedAddress = normalizeVerifiedSwiggyAddress(matched, addressDetails);
      return { ok: true, addressId: verifiedAddress.remoteAddressId, status: 200, method: 'web-add-address-ui-verify', verifiedAddress, message: 'Address Add Address page ke baad saved list me verify ho gaya' };
    }
    return {
      ok: false,
      addressId: '',
      status: Number(ui?.status) || 0,
      method: 'web-add-address-ui',
      submitAttempted: true,
      aborted: Boolean(ui?.aborted),
      pageState: ui?.pageState || '',
      pageSnapshot: ui?.pageSnapshot || null,
      message: sanitizeSwiggyAddressFailureMessage(ui?.message || 'Add Address SAVE verify nahi ho paya'),
    };
  }

  const explicitCasUrls = Array.isArray(urls) && urls.length
    ? urls
    : (String(process.env.SWIGGY_ADDRESS_CREATE_URL || '').trim()
      ? [String(process.env.SWIGGY_ADDRESS_CREATE_URL).trim()]
      : []);
  const casBlockedStates = new Set([
    'login-required',
    'security-challenge',
    'redirected',
    'cookie-sync-failed',
    'aborted',
  ]);
  if (!explicitCasUrls.length || casBlockedStates.has(String(ui?.pageState || '')) || ui?.aborted) {
    return {
      ok: false,
      addressId: '',
      status: Number(ui?.status) || 0,
      method: 'web-add-address-ui',
      submitAttempted: Boolean(ui?.submitAttempted),
      aborted: Boolean(ui?.aborted),
      pageState: ui?.pageState || '',
      pageSnapshot: ui?.pageSnapshot || null,
      message: sanitizeSwiggyAddressFailureMessage(ui?.message || 'Add Address page se address save nahi ho paya'),
    };
  }

  const cas = await addSwiggyAddressViaBridgeSession(session, addressDetails, {
    customerId,
    timeoutMs: Math.min(8_000, Math.max(2_000, Number(timeoutMs) || 8_000)),
    fetchImpl,
    urls: explicitCasUrls,
  });
  if (cas.ok && cas.addressId) {
    const afterCas = await fetchSwiggySavedAddressesViaBridgeSession(session, { fetchImpl, timeoutMs: 5_000 })
      .catch(() => ({ ok: false, addresses: [] }));
    const matched = findMatchingSwiggySavedAddress(afterCas.addresses, addressDetails)
      || (afterCas.addresses || []).find((raw) => directSwiggyAddressId(raw) === cas.addressId);
    const verifiedAddress = normalizeVerifiedSwiggyAddress(matched || { id: cas.addressId }, addressDetails);
    return { ...cas, method: 'cas-address-api', verifiedAddress };
  }
  return {
    ok: false,
    addressId: '',
    status: Number(cas.status) || Number(ui?.status) || 0,
    method: 'web-add-address-ui+cas',
    submitAttempted: Boolean(ui?.submitAttempted),
    pageState: ui?.pageState || '',
    pageSnapshot: ui?.pageSnapshot || null,
    responseKind: cas.responseKind || '',
    message: sanitizeSwiggyAddressFailureMessage(
      `Add Address page: ${sanitizeSwiggyAddressFailureMessage(ui?.message || 'fail')} · CAS: ${sanitizeSwiggyAddressFailureMessage(cas.message || cas.status || 'fail')}`
    ),
  };
}

// Helper to check if cookies or account contain a verified logged-in user
export function checkLoggedInFromCookies(input) {
  if (!input) return false;
  let tidValue = '';
  let sessionTid = '';
  let tokenVal = '';
  let isLoggedFlag = '';

  if (typeof input === 'object' && !Array.isArray(input)) {
    if (input.isLoggedIn === false) return false;
    if (input.tid) tidValue = String(input.tid);
    if (input._session_tid || input.session_tid || input.sessionTid) {
      sessionTid = String(input._session_tid || input.session_tid || input.sessionTid);
    }
    if (!sessionTid && tidValue && !tidValue.includes('.')) {
      sessionTid = tidValue;
    }
    if (input.token || input.auth_token || input.access_token || input.authToken || input.accessToken) {
      tokenVal = String(input.token || input.auth_token || input.access_token || input.authToken || input.accessToken);
    }
    if (input.cookies) input = input.cookies;
    else if (!tidValue && !tokenVal && !sessionTid) return Boolean(input.isLoggedIn);
  }

  if (Array.isArray(input)) {
    const getC = (n) => input.find(c => c && c.name === n)?.value || '';
    tidValue = tidValue || getC('tid');
    sessionTid = sessionTid || getC('_session_tid');
    tokenVal = tokenVal || getC('token');
    isLoggedFlag = getC('_is_logged_in');
  } else if (typeof input === 'string') {
    const getS = (re) => {
      const m = input.match(re);
      return m ? decodeURIComponent(m[1]).trim() : '';
    };
    tidValue = tidValue || getS(/(?:^|;\s*)tid=([^;]+)/);
    sessionTid = sessionTid || getS(/(?:^|;\s*)_session_tid=([^;]+)/);
    tokenVal = tokenVal || getS(/(?:^|;\s*)token=([^;]+)/);
    isLoggedFlag = getS(/(?:^|;\s*)_is_logged_in=([^;]+)/);
    if (!tidValue && input.includes('.') && input.length > 50 && !input.includes(';')) {
      tidValue = input.trim();
    }
    if (!sessionTid && /^[0-9a-fA-F]{40,}$/.test(input.trim())) {
      sessionTid = input.trim();
    }
  }

  if (tidValue && tidValue.includes('.')) {
    const payload = decodeJwtPayload(tidValue);
    if (payload && payload.user_id && payload.user_id !== '0' && payload.user_id !== '-1') {
      return true;
    }
    // If `tid` is an explicit guest pre-OTP JWT (`user_id === "0"`) and there is NO real `_session_tid`, it is NOT logged in!
    if (payload && (payload.user_id === '0' || payload.user_id === '-1') && !sessionTid && (!tokenVal || tokenVal === tidValue)) {
      return false;
    }
  }

  if (isLoggedFlag === '1' && (sessionTid.length >= 16 || tokenVal.length >= 10)) {
    return true;
  }
  if (isLoggedFlag !== '0' && (sessionTid.length >= 32 || tokenVal.length >= 24 || (tokenVal.length >= 16 && tidValue.length >= 50))) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Auto-claim & 14-Day Advance Pre-Book Swiggy Event Offers:
// 1. Breakfast Morning (`book-your-offer` — voting before 05:00 IST, redeem 07:00–11:00 IST)
// 2. Late Night Offer (`pick-your-late-night-offer` — voting before 18:30 IST, redeem 21:00–06:00 IST)
// Locks in TODAY + ALL NEXT 14 UPCOMING DAYS in advance via `POST` + `PATCH` on `events.swiggy.com/api/notify`
// so Swiggy's daily batch cutoff (`18:30 IST` LN / `05:00 IST` BF) NEVER misses crediting Free Cash / Coupons!
// ---------------------------------------------------------------------------
export const EVENT_OFFER_OPTIONS = {
  1: { value: 1, shortLabel: '₹50 Free Cash (>₹199)', fullLabel: '₹ ₹50 Free Cash (MOV ₹199 • Stacks Over Coupons)' },
  2: { value: 2, shortLabel: '₹150 OFF Coupon (>₹249)', fullLabel: '# ₹150 OFF Coupon (MOV ₹249)' },
  3: { value: 3, shortLabel: '₹175 LN / ₹100 BF Coupon', fullLabel: '! ₹175 OFF LN (>₹399) / ₹100 OFF BF' },
  4: { value: 4, shortLabel: '₹100 OFF Coupon (>₹149)', fullLabel: '! ₹100 OFF Coupon (MOV ₹149)' }
};

const offerClaimCache = new Map(); // `${accSig}:${offerValue}` -> { result, ts }
const OFFER_CLAIM_TTL_MS = 30 * 60 * 1000;

let cachedEventCampaignMeta = null;
let cachedEventCampaignMetaAt = 0;
const EVENT_META_TTL_MS = 15 * 60 * 1000;

function decodeJwtExpSec(jwt) {
  if (!jwt || typeof jwt !== 'string' || !jwt.includes('.')) return 0;
  const payload = decodeJwtPayload(jwt);
  return Number(payload?.exp || 0);
}

async function getLiveEventCampaignMeta(forceRefresh = false) {
  if (!forceRefresh && cachedEventCampaignMeta && (Date.now() - cachedEventCampaignMetaAt < EVENT_META_TTL_MS)) {
    return cachedEventCampaignMeta;
  }
  const fallback = {
    bfPrefix: 'byo-bf-v10-',
    lnPrefix: 'byo-ln-v5-',
    bfBoundaries: [],
    lnBoundaries: []
  };
  try {
    const [bfRes, lnRes] = await Promise.all([
      fetch('https://events.swiggy.com/book-your-offer?utm_source=app&utm_medium=share', { signal: AbortSignal.timeout(5000) }),
      fetch('https://events.swiggy.com/pick-your-late-night-offer?utm_source=app&utm_medium=share', { signal: AbortSignal.timeout(5000) })
    ]);
    const [bfHtml, lnHtml] = await Promise.all([bfRes.text(), lnRes.text()]);
    const parseNexus = (html, defPrefix) => {
      const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (!m) return { prefix: defPrefix, boundaries: [] };
      try {
        const parsed = JSON.parse(m[1]);
        const nexus = parsed?.props?.pageProps?.nexusData || {};
        return {
          prefix: nexus.notifyCampaignIdPrefix || defPrefix,
          boundaries: Array.isArray(nexus.dayBoundaries) ? nexus.dayBoundaries : []
        };
      } catch {
        return { prefix: defPrefix, boundaries: [] };
      }
    };
    const bf = parseNexus(bfHtml, 'byo-bf-v10-');
    const ln = parseNexus(lnHtml, 'byo-ln-v5-');
    cachedEventCampaignMeta = {
      bfPrefix: bf.prefix,
      lnPrefix: ln.prefix,
      bfBoundaries: bf.boundaries,
      lnBoundaries: ln.boundaries
    };
    cachedEventCampaignMetaAt = Date.now();
    return cachedEventCampaignMeta;
  } catch (e) {
    console.warn('[EventsClaim] Dynamic campaign lookup fallback used:', e.message);
    return cachedEventCampaignMeta || fallback;
  }
}

function resolveCampaignWindowInfo(boundaries, prefix, defaultDay = 15, isLateNight = false, nowMs = Date.now()) {
  let matched = null;
  for (const d of (boundaries || [])) {
    const start = Date.parse(d.startTime);
    const end = Date.parse(d.endTime);
    if (nowMs >= start && nowMs < end) {
      matched = { ...d, startMs: start, endMs: end };
      break;
    }
  }
  if (!matched && Array.isArray(boundaries) && boundaries.length > 0) {
    const start1 = Date.parse(boundaries[0].startTime);
    const diff = Math.floor((nowMs - start1) / (24 * 3600 * 1000)) + 1;
    const clampedIdx = Math.max(0, Math.min(diff - 1, boundaries.length - 1));
    const b = boundaries[clampedIdx];
    matched = { ...b, startMs: Date.parse(b.startTime), endMs: Date.parse(b.endTime) };
  }
  const currentDay = matched?.day || defaultDay;
  const maxDay = (boundaries && boundaries.length > 0)
    ? Math.max(...boundaries.map(b => Number(b.day) || 0), currentDay + 14)
    : currentDay + 14;

  // Exact Swiggy cutoff timestamps from `pick-your-late-night-offer` module 17858 (`day` starts 11:00 IST):
  // - Late Night: voting closes at 18:30 IST (+7.5h from 11:00 startTime), active redeem slot 21:00–06:00 IST (+10h..+19h)
  // - Breakfast: voting closes at 05:00 IST (+18h from 11:00 startTime), active redeem slot 07:00–11:00 IST (+20h..+24h)
  let cutoffMs = null;
  let slotOpenMs = null;
  if (matched?.startMs) {
    cutoffMs = matched.startMs + (isLateNight ? 7.5 * 3600 * 1000 : 18 * 3600 * 1000);
    slotOpenMs = matched.startMs + (isLateNight ? 10 * 3600 * 1000 : 20 * 3600 * 1000);
  }

  return {
    currentDay,
    maxDay,
    todayCampaign: `${prefix}${currentDay}`,
    upcomingDays: Array.from(
      { length: Math.min(2, Math.max(1, maxDay - currentDay + 1)) },
      (_, idx) => `${prefix}${currentDay + idx}`
    ),
    cutoffMs,
    slotOpenMs,
    endMs: matched?.endMs || null
  };
}

export async function claimSwiggyBreakfastAndLateNightOffers(account, { force = false, offerValue = null, forcePatch = false, quickLockOnly = false } = {}) {
  if (!account) return { success: false, reason: 'No account provided' };
  const chosenVal = [1, 2, 3, 4].includes(Number(offerValue || account.preferredOfferValue))
    ? Number(offerValue || account.preferredOfferValue)
    : 1;
  const chosenMeta = EVENT_OFFER_OPTIONS[chosenVal] || EVENT_OFFER_OPTIONS[1];
  const accSig = `${String(account.id || account.phone || account.customerId || account.token || (account.cookies || '').slice(0, 60))}:v${chosenVal}`;
  if (!force && !forcePatch && accSig && offerClaimCache.has(accSig)) {
    const prev = offerClaimCache.get(accSig);
    if (Date.now() - prev.ts < OFFER_CLAIM_TTL_MS) return prev.result;
  }

  let token = account.token || '';
  let jwtTid = account.tid || '';
  let cookieStr = stripStaleWafCookie(account.cookies || '');

  if (cookieStr) {
    const tidCookie = cookieStr.split(';').map(s => s.trim()).find(s => s.startsWith('tid='));
    if (tidCookie && tidCookie.slice(4).includes('.')) {
      jwtTid = tidCookie.slice(4);
    }
    if (!token) {
      const tokCookie = cookieStr.split(';').map(s => s.trim()).find(s => s.startsWith('token='));
      if (tokCookie) {
        token = tokCookie.slice(6);
      }
    }
  }

  // Refresh live 30-day `jwtTid` via zero-WAF Android `chkout` first (fast ~180ms), fallback to `/dapi/order/all`!
  let liveSessionDead = false;
  const nowSec = Math.floor(Date.now() / 1000);
  if ((!jwtTid || decodeJwtExpSec(jwtTid) < nowSec + 120) && (token || jwtTid || cookieStr)) {
    try {
      const chkRes = await fetchSwiggy('https://chkout.swiggy.com/api/v2/cart/client', {
        headers: {
          'User-Agent': 'Swiggy-Android',
          'app-version': '4.67.0',
          'version-code': '1365',
          'os-version': '13',
          'Accept': 'application/json',
          ...(jwtTid ? { tid: jwtTid } : {}),
          ...(token ? { token } : {}),
          ...(account.sid ? { sid: account.sid } : {}),
          ...(account.deviceId ? { deviceId: account.deviceId, swuid: account.deviceId } : {})
        },
        signal: AbortSignal.timeout(5000)
      });
      const chkJson = await chkRes.json().catch(() => null);
      if (chkJson?.statusCode === 0 && chkJson?.tid && String(chkJson.tid).includes('.')) {
        jwtTid = chkJson.tid;
        account.jwtTid = jwtTid;
        if (!account.tid || String(account.tid).includes('.')) account.tid = jwtTid;
      } else if (chkJson?.statusCode === 999) {
        liveSessionDead = true;
      }
    } catch {}
  }

  if ((!jwtTid || decodeJwtExpSec(jwtTid) < nowSec + 120) && cookieStr) {
    try {
      const authRes = await fetchSwiggy('https://www.swiggy.com/dapi/order/all', {
        headers: {
          'Cookie': cookieStr,
          'User-Agent': 'Swiggy-Android',
          'Accept': 'application/json',
          'Referer': 'https://www.swiggy.com/my-account'
        },
        signal: AbortSignal.timeout(5000)
      });
      const authJson = await authRes.json().catch(() => null);
      if (authRes.status === 200 && authJson?.statusCode === 0 && authJson?.tid) {
        jwtTid = authJson.tid;
        account.jwtTid = jwtTid;
        if (!account.tid || String(account.tid).includes('.')) account.tid = jwtTid;
        const setCookies = typeof authRes.headers.getSetCookie === 'function' ? authRes.headers.getSetCookie() : [];
        if (setCookies.length > 0) {
          cookieStr = mergeSetCookiesIntoJar(cookieStr, setCookies);
        }
      } else if (authJson?.statusCode === 1) {
        liveSessionDead = true;
      }
    } catch {}
  }

  if (!token && jwtTid) {
    token = jwtTid;
  }

  if (!jwtTid && !token) {
    return { success: false, sessionExpired: true, reason: 'Session Logged Out — Re-login required' };
  }

  if (!cookieStr && jwtTid) {
    cookieStr = `tid=${jwtTid}` + (account.sid ? `; _sid=${account.sid}` : '') + (account.deviceId ? `; _device_id=${account.deviceId}` : '');
  }

  const nowMs = Date.now();
  const meta = await getLiveEventCampaignMeta(false);
  const bfWin = resolveCampaignWindowInfo(meta.bfBoundaries, meta.bfPrefix, 15, false, nowMs);
  const lnWin = resolveCampaignWindowInfo(meta.lnBoundaries, meta.lnPrefix, 15, true, nowMs);

  // CRITICAL: `events.swiggy.com/api/notify` authenticates strictly via `{ token, tid }` headers!
  // Sending `Cookie:` triggers CloudFront WAF `403 Forbidden` on accounts with multi-domain web cookies!
  const baseHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'token': token || jwtTid,
    'tid': jwtTid,
    'Origin': 'https://events.swiggy.com',
    'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
  };

  try {
    // CloudFront WAF-safe (`<40 req/10s/IP`) 48-Hour Rolling Pre-Book (`Today + Tomorrow` = `4` campaigns total!):
    // 1) `GET /api/notify?campaign=<id>` checks real live state (`shouldNotify`, `value`, `timestamp`).
    // 2) If already `shouldNotify === true` AND `Number(value) === chosenVal` -> `0` extra mutations needed!
    // 3) If unsubscribed -> single `POST`; if subscribed with a different `value` -> single `PATCH` (never redundant `POST + PATCH`)!
    // 4) If CloudFront burst limit (`403`/`429`) triggers, waits `5.5s` for window reset and retries cleanly!
    const prevLockedMap = (account.offers && typeof account.offers.lockedMap === 'object' && account.offers.lockedMap)
      ? { ...account.offers.lockedMap }
      : {};

    const syncSingleCampaign = async (campaignId, referer) => {
      for (let tryIdx = 0; tryIdx < 2; tryIdx++) {
        if (tryIdx > 0) await new Promise(r => setTimeout(r, 5500));

        const statusRes = await fetchSwiggy(`https://events.swiggy.com/api/notify?campaign=${encodeURIComponent(campaignId)}`, {
          headers: baseHeaders,
          signal: AbortSignal.timeout(5500)
        });
        if ((statusRes.status === 403 || statusRes.status === 429) && tryIdx === 0) continue;
        const statusJson = await statusRes.json().catch(() => ({}));

        const isSubscribed = Boolean(statusJson?.shouldNotify);
        const curVal = Number(statusJson?.value || 0);

        // Already locked on Swiggy's server with the exact desired reward value!
        if (statusRes.ok && isSubscribed && curVal === chosenVal) {
          prevLockedMap[campaignId] = chosenVal;
          return { res: statusRes, json: { ...statusJson, message: 'Already active' }, statusJson };
        }

        // Need either `POST` (first time subscribing) or `PATCH` (switching reward option 1..4)!
        const writeMethod = isSubscribed ? 'PATCH' : 'POST';
        const writeRes = await fetchSwiggy('https://events.swiggy.com/api/notify', {
          method: writeMethod,
          headers: { ...baseHeaders, 'Referer': referer },
          body: JSON.stringify({ campaign: campaignId, value: chosenVal }),
          signal: AbortSignal.timeout(6500)
        });
        if ((writeRes.status === 403 || writeRes.status === 429) && tryIdx === 0) continue;
        const writeJson = await writeRes.json().catch(() => ({}));

        // If `POST` says already subscribed with a different value, do a single `PATCH` to update `value`:
        const alreadyMsg = String(writeJson?.message || '').toLowerCase().includes('already');
        if (writeMethod === 'POST' && alreadyMsg && Number(writeJson?.value || 0) !== chosenVal) {
          const patchRes = await fetchSwiggy('https://events.swiggy.com/api/notify', {
            method: 'PATCH',
            headers: { ...baseHeaders, 'Referer': referer },
            body: JSON.stringify({ campaign: campaignId, value: chosenVal }),
            signal: AbortSignal.timeout(6500)
          });
          if ((patchRes.status === 403 || patchRes.status === 429) && tryIdx === 0) continue;
          const patchJson = await patchRes.json().catch(() => ({}));
          if (patchRes.ok) prevLockedMap[campaignId] = chosenVal;
          return { res: patchRes, json: patchJson, statusJson: { ...statusJson, shouldNotify: true, value: chosenVal } };
        }

        if (writeRes.ok || alreadyMsg) {
          prevLockedMap[campaignId] = chosenVal;
        }
        return {
          res: writeRes,
          json: writeJson,
          statusJson: {
            ...statusJson,
            shouldNotify: Boolean(writeRes.ok || alreadyMsg || isSubscribed),
            value: chosenVal,
            timestamp: statusJson?.timestamp || writeJson?.currentTime || new Date().toISOString()
          }
        };
      }
      return { res: { ok: false, status: 403, statusText: 'Rate Limited' }, json: {}, statusJson: {} };
    };

    const maxLen = Math.max(bfWin.upcomingDays.length, lnWin.upcomingDays.length);
    const immediateLen = quickLockOnly ? Math.min(2, maxLen) : maxLen;
    const bfSlots = new Array(immediateLen).fill(null);
    const lnSlots = new Array(immediateLen).fill(null);

    const BATCH_CONCURRENCY = 5;
    for (let start = 0; start < immediateLen; start += BATCH_CONCURRENCY) {
      const indices = [];
      for (let idx = start; idx < Math.min(immediateLen, start + BATCH_CONCURRENCY); idx++) {
        indices.push(idx);
      }
      await Promise.all(indices.map(async (i) => {
        const [bItem, lItem] = await Promise.all([
          bfWin.upcomingDays[i]
            ? syncSingleCampaign(bfWin.upcomingDays[i], 'https://events.swiggy.com/book-your-offer')
            : Promise.resolve(null),
          lnWin.upcomingDays[i]
            ? syncSingleCampaign(lnWin.upcomingDays[i], 'https://events.swiggy.com/pick-your-late-night-offer')
            : Promise.resolve(null)
        ]);
        bfSlots[i] = bItem;
        lnSlots[i] = lItem;
      }));
    }

    const bfAll = bfSlots.filter(Boolean);
    const lnAll = lnSlots.filter(Boolean);

    // If `quickLockOnly` locked Today + Tomorrow for sub-second login latency, finish pre-locking days 2..14 in background!
    if (quickLockOnly && maxLen > immediateLen && (bfAll[0]?.res?.ok || lnAll[0]?.res?.ok)) {
      Promise.resolve().then(async () => {
        for (let start = immediateLen; start < maxLen; start += BATCH_CONCURRENCY) {
          const indices = [];
          for (let idx = start; idx < Math.min(maxLen, start + BATCH_CONCURRENCY); idx++) indices.push(idx);
          await Promise.allSettled(indices.map((i) => Promise.all([
            bfWin.upcomingDays[i]
              ? syncSingleCampaign(bfWin.upcomingDays[i], 'https://events.swiggy.com/book-your-offer')
              : Promise.resolve(null),
            lnWin.upcomingDays[i]
              ? syncSingleCampaign(lnWin.upcomingDays[i], 'https://events.swiggy.com/pick-your-late-night-offer')
              : Promise.resolve(null)
          ])));
        }
      }).catch(() => {});
    }

    if (!bfAll.length) bfAll.push({ res: { ok: false, status: 500, statusText: 'Empty' }, json: {}, statusJson: {} });
    if (!lnAll.length) lnAll.push({ res: { ok: false, status: 500, statusText: 'Empty' }, json: {}, statusJson: {} });

    const bfStatusNow = bfAll[0]?.statusJson || {};
    const lnStatusNow = lnAll[0]?.statusJson || {};

    const { res: resBf, json: bfJson } = bfAll[0];
    const { res: resLn, json: lnJson } = lnAll[0];

    const bfLockedCount = bfAll.filter(x => x.res.ok || String(x.json?.message || '').toLowerCase().includes('already')).length;
    const lnLockedCount = lnAll.filter(x => x.res.ok || String(x.json?.message || '').toLowerCase().includes('already')).length;

    const bfOk = bfLockedCount > 0;
    const lnOk = lnLockedCount > 0;

    const describeSlotState = (ok, res, json, statusNow, win, isLn) => {
      if (!ok) {
        if (res.status === 401 || liveSessionDead) return { state: 'EXPIRED', msg: 'Session Expired — Re-login required' };
        if (res.status === 403) return { state: 'FORBIDDEN', msg: 'HTTP 403 Forbidden (WAF Blocked)' };
        return { state: 'FAILED', msg: `HTTP ${res.status} (${json.message || res.statusText || 'Error'})` };
      }
      const bookedAtMs = statusNow?.timestamp ? Date.parse(statusNow.timestamp) : nowMs;
      const bookedBeforeCutoff = !win.cutoffMs || bookedAtMs <= win.cutoffMs;
      const inRedeemSlotNow = Boolean(win.slotOpenMs && win.endMs && nowMs >= win.slotOpenMs && nowMs < win.endMs);
      const valTag = (EVENT_OFFER_OPTIONS[statusNow?.value || chosenVal] || chosenMeta).shortLabel;
      const daysTag = `+${Math.max(0, (isLn ? lnLockedCount : bfLockedCount) - 1)} next days pre-locked`;

      if (bookedBeforeCutoff && inRedeemSlotNow) {
        return { state: 'ACTIVE_NOW', msg: `● LIVE IN CART NOW (${valTag} • ${daysTag})` };
      }
      if (bookedBeforeCutoff) {
        return {
          state: 'LOCKED_FOR_TODAY',
          msg: `✓ Booked Before Cutoff (${valTag} • activates ${isLn ? '9:00 PM' : '7:00 AM'} • ${daysTag})`
        };
      }
      return {
        state: 'CUTOFF_PASSED_LOCKED_NEXT_14D',
        msg: `◷ Today's ${isLn ? '6:30 PM' : '5:00 AM'} cutoff passed before login — Next 14 Days PRE-LOCKED (${valTag})!`
      };
    };

    const bfDesc = describeSlotState(bfOk, resBf, bfJson, bfStatusNow, bfWin, false);
    const lnDesc = describeSlotState(lnOk, resLn, lnJson, lnStatusNow, lnWin, true);

    console.log(`[EventsClaim] Account ${account.phone || account.name || 'User'} result:`, {
      offerValue: chosenVal,
      breakfast: { campaign: bfWin.todayCampaign, lockedDays: bfLockedCount, state: bfDesc.state },
      lateNight: { campaign: lnWin.todayCampaign, lockedDays: lnLockedCount, state: lnDesc.state }
    });

    const claimOut = {
      success: bfOk || lnOk,
      bothClaimed: bfOk && lnOk,
      offerValue: chosenVal,
      offerLabel: chosenMeta.shortLabel,
      lockedMap: prevLockedMap,
      sessionExpired: !bfOk && !lnOk && (resBf.status === 401 || resLn.status === 401 || liveSessionDead),
      breakfast: {
        name: 'Breakfast Morning (7AM–11AM)',
        campaign: bfWin.todayCampaign,
        lockedDaysCount: bfLockedCount,
        upcomingCampaigns: bfWin.upcomingDays,
        slotState: bfDesc.state,
        status: bfOk ? 'CLAIMED' : 'FAILED',
        statusCode: resBf.status,
        discount: chosenMeta.shortLabel,
        offerValue: Number(bfStatusNow?.value || chosenVal),
        rawMessage: bfJson.message || '',
        message: bfDesc.msg
      },
      lateNight: {
        name: 'Late Night (9PM–6AM)',
        campaign: lnWin.todayCampaign,
        lockedDaysCount: lnLockedCount,
        upcomingCampaigns: lnWin.upcomingDays,
        slotState: lnDesc.state,
        status: lnOk ? 'CLAIMED' : 'FAILED',
        statusCode: resLn.status,
        discount: chosenMeta.shortLabel,
        offerValue: Number(lnStatusNow?.value || chosenVal),
        rawMessage: lnJson.message || '',
        message: lnDesc.msg
      }
    };
    if (accSig) offerClaimCache.set(accSig, { result: claimOut, ts: Date.now() });
    return claimOut;
  } catch (err) {
    console.error('[EventsClaim] Request error:', err.message);
    return { success: false, error: err.message };
  }
}

async function launchStealthSwiggyBrowser(routeProxy = getBridgeProxy()) {
  if (!CHROME_PATH || !_exists(CHROME_PATH)) {
    throw new Error(
      'Chrome/Chromium nahi mila is machine par. Google Chrome install karo, ' +
      'ya .env me PUPPETEER_EXECUTABLE_PATH=<chrome.exe ka full path> set karo. ' +
      '(puppeteer-core ke saath browser bundled NAHI aata.)'
    );
  }
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: HEADLESS_MODE,
    protocolTimeout: 60000,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--window-size=1366,768',
      '--lang=en-IN,en-US,en',
      // 🔀 Browser bhi active proxy (nayi IP) se chale — warna WAF IP ko
      // proxy-wala aur browser-wala traffic alag-alag dekh lega.
      ...proxyPool.puppeteerProxyArgs(routeProxy)
    ]
  });

  const page = await browser.newPage();
  // Proxy auth (user:pass wale proxies) — page par pehle se authenticate
  await proxyPool.puppeteerProxyAuth(page, routeProxy);
  const cleanSyntheticEntityId = crypto.randomUUID();
  await page.setViewport({ width: 1366, height: 768 });
  await page.emulateTimezone('Asia/Kolkata').catch(() => {});
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

  // Intercept `fna.swiggy.com/api/fraudnabuse/*` so Headless Linux container never flags newly logged-in accounts into Promo-Restricted segment!
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (u.includes('fna.swiggy.com/api/fraudnabuse')) {
      return req.respond({
        status: 200,
        contentType: 'application/json',
        headers: {
          'Access-Control-Allow-Origin': 'https://www.swiggy.com',
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Allow-Headers': 'Content-Type, Accept'
        },
        body: JSON.stringify({ statusCode: 0, statusMessage: 'success', data: cleanSyntheticEntityId, successful: true })
      }).catch(() => {});
    }
    req.continue().catch(() => {});
  });

  await page.evaluateOnNewDocument(() => {
    try {
      delete Object.getPrototypeOf(navigator).webdriver;
    } catch (e) {}
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    if (!window.chrome) window.chrome = {};
    window.chrome.runtime = window.chrome.runtime || { connect: () => {}, sendMessage: () => {} };
    window.chrome.loadTimes = window.chrome.loadTimes || (() => ({}));
    window.chrome.csi = window.chrome.csi || (() => ({}));
    window.chrome.app = window.chrome.app || {};
    Object.defineProperty(navigator, 'languages', { get: () => ['en-IN', 'en-US', 'en'] });
    if (!navigator.plugins || navigator.plugins.length === 0) {
      Object.defineProperty(navigator, 'plugins', {
        get: () => [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' }
        ]
      });
    }
  });
  return { browser, page };
}

function canUseStealthBrowser() {
  try {
    return Boolean(CHROME_PATH && fs.existsSync(CHROME_PATH));
  } catch {
    return false;
  }
}

const MOBILE_DEVICE_PROFILES = [
  {
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/AP2A.240805.005) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.135 Mobile Safari/537.36',
    secChUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    model: 'Pixel 7',
    osVersion: '14'
  },
  {
    ua: 'Mozilla/5.0 (Linux; Android 14; SM-S911B Build/UP1A.231005.007) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.135 Mobile Safari/537.36',
    secChUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    model: 'SM-S911B',
    osVersion: '14'
  },
  {
    ua: 'Mozilla/5.0 (Linux; Android 13; CPH2447 Build/TP1A.220905.001) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.135 Mobile Safari/537.36',
    secChUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    model: 'CPH2447',
    osVersion: '13'
  },
  {
    ua: 'Mozilla/5.0 (Linux; Android 14; 23127PN0CG Build/UKQ1.230804.001) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.135 Mobile Safari/537.36',
    secChUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    model: '23127PN0CG',
    osVersion: '14'
  }
];

function buildAntiBotDeviceProfile(phone = '') {
  const daySalt = new Date().toISOString().slice(0, 10);
  const hashHex = crypto.createHash('sha256').update(`swiggy-auth-dev:${phone}:${daySalt}`).digest('hex');
  // Deterministic RFC-4122 UUIDv4 per (phone, day) so Swiggy FNA sees one consistent device across OTP -> Verify -> Signup
  const deviceId = [
    hashHex.slice(0, 8),
    hashHex.slice(8, 12),
    `4${hashHex.slice(13, 16)}`,
    `${['8', '9', 'a', 'b'][parseInt(hashHex[16], 16) % 4]}${hashHex.slice(17, 20)}`,
    hashHex.slice(20, 32)
  ].join('-');
  const idx = parseInt(hashHex.slice(32, 36), 16) % MOBILE_DEVICE_PROFILES.length;
  const profile = MOBILE_DEVICE_PROFILES[idx];
  return {
    deviceId,
    swuid: deviceId,
    ...profile
  };
}

function getResponseSetCookies(res) {
  if (!res || !res.headers) return [];
  if (typeof res.headers.getSetCookie === 'function') {
    const arr = res.headers.getSetCookie();
    if (Array.isArray(arr) && arr.length > 0) return arr;
  }
  const single = typeof res.headers.get === 'function' ? res.headers.get('set-cookie') : '';
  if (!single) return [];
  return String(single).split(/,(?=\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/g).map(s => s.trim()).filter(Boolean);
}

function applySetCookiesToMap(cookieMap, setCookieHeaders = []) {
  for (const raw of (setCookieHeaders || [])) {
    const parts = String(raw || '').split(';').map(s => s.trim()).filter(Boolean);
    if (!parts.length) continue;
    const eqIdx = parts[0].indexOf('=');
    if (eqIdx <= 0) continue;
    const name = parts[0].slice(0, eqIdx).trim();
    const val = parts[0].slice(eqIdx + 1).trim();
    if (!name || name === 'aws-waf-token') continue;

    const attrsLower = parts.slice(1).join('; ').toLowerCase();
    const expired = /max-age\s*=\s*0\b/.test(attrsLower) || val === '' || val === 'deleted';
    if (expired) {
      cookieMap.delete(name);
    } else {
      cookieMap.set(name, val);
    }
  }
}

function serializeCookieMap(cookieMap) {
  return Array.from(cookieMap.entries())
    .filter(([k, v]) => k && v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function createSwiggyHttpAuthSession(phone, targetAcc = '', targetAccName = null) {
  const deviceProfile = buildAntiBotDeviceProfile(phone);
  const cookieMap = new Map();
  cookieMap.set('_device_id', deviceProfile.deviceId);
  cookieMap.set('swuid', deviceProfile.swuid);
  cookieMap.set('_is_logged_in', '0');
  cookieMap.set('userLocation', encodeURIComponent(JSON.stringify({
    lat: '19.0760',
    lng: '72.8777',
    address: 'Mumbai, Maharashtra, India',
    area: 'Mumbai',
    id: ''
  })));
  return {
    mode: 'http',
    phone,
    otp: null,
    targetAcc: targetAcc || `acc_${phone}`,
    targetAccName: targetAccName || null,
    deviceProfile,
    cookieMap,
    csrfToken: '',
    wafToken: '',        // live aws-waf-token (pool se) — WAF challenge "aaye hi na" isliye
    transportMode: 'mweb',
    isNewUser: false,
    signupPreRegistered: false,
    signupName: '',
    signupEmail: '',
    browser: null,
    page: null,
    safetyTimer: null,
    createdAt: Date.now()
  };
}

// AWS WAF ke liye valid token (pool ya 8-min cached) — expired token GHALT hai,
// isliye dono jagah TTL check.
//
// 🔀 PROXY MODE: aws-waf-token IP-bound hota hai — jo token ek IP (proxy) ke
// liye valid hai, doosri IP par kaam NAHI karta. Isliye jab proxy active ho,
// sirf USI proxy ka token bhejo (warna WAF ko mismatch dikhega).
// Jala hua token har cache se saaf karo (bridge-local + shared pool) —
// challenge ke baad agli request fresh solve par majboor ho jaye.
// Proxy mode me pool shared nahi hota (per-proxy tokens proxy-pool rakhta
// hai, WAF hit par wo proxy waisay hi side par chali jati hai).
function burnSharedWafToken() {
  latestSharedWafToken = '';
  latestSharedWafAt = 0;
  try { wafPool.invalidateToken?.(); } catch {}
}

// Challenge ke baad SIRF wahi token jalao jo asal route par use hua tha.
// Pehle proxy mode me bhi sirf shared/direct cache saaf hota tha — per-proxy
// jala token cache me reh jata aur Android retry wahi dobara bhej deti thi.
export function burnCurrentWafToken(proxy = getBridgeProxy()) {
  if (proxy?.id) {
    try { proxyPool.invalidateProxyToken(proxy.id); } catch {}
    return;
  }
  burnSharedWafToken();
}

function freshWafTokenForRequests() {
  // Proxy active = per-proxy token
  if (getBridgeProxy()?.id) {
    return proxyPool.getProxyToken(getBridgeProxy().id) || '';
  }
  try {
    const pooled = wafPool.getTokenSync?.() || '';
    if (pooled) return pooled;
  } catch {}
  if (latestSharedWafToken && latestSharedWafToken.length > 50 &&
      (Date.now() - latestSharedWafAt) < WAF_CACHE_TTL_MS) {
    return latestSharedWafToken;
  }
  return '';
}

function buildAuthRequestHeaders(session, { referer = 'https://www.swiggy.com/auth', useAndroidUa = false, extra = {} } = {}) {
  // AWS WAF token — session ka apna (ya pool/cached live token). Header + Cookie
  // dono me bhejte hain (WAF dono accept karta hai); isliye "naked" 403 challenge
  // ki jagah normal browser traffic dikhta hai.
  const wafTok = session?.wafToken || freshWafTokenForRequests();
  const wafCookie = wafTok ? `aws-waf-token=${wafTok}; ` : '';
  const cookieHeader = `${wafCookie}${serializeCookieMap(session.cookieMap)}`;
  const dev = session.deviceProfile || buildAntiBotDeviceProfile(session.phone || '');
  if (useAndroidUa || session.transportMode === 'android') {
    const sidVal = session.cookieMap.get('_sid') || '';
    const tidVal = session.cookieMap.get('tid') || session.cookieMap.get('_guest_tid') || '';
    return {
      ...(cookieHeader ? { 'Cookie': cookieHeader } : {}),
      ...(wafTok ? { 'aws-waf-token': wafTok } : {}),
      'User-Agent': 'Swiggy-Android',
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'Accept-Language': 'en-IN,en-GB;q=0.9,en-US;q=0.8',
      'Origin': 'https://www.swiggy.com',
      'Referer': referer,
      'app-version': '4.67.0',
      'version-code': '1365',
      'os-version': dev.osVersion || '14',
      'deviceId': dev.deviceId,
      'swuid': dev.swuid,
      ...(sidVal ? { 'sid': sidVal } : {}),
      ...(tidVal ? { 'tid': tidVal } : {}),
      ...extra
    };
  }

  return {
    ...(cookieHeader ? { 'Cookie': cookieHeader } : {}),
    ...(wafTok ? { 'aws-waf-token': wafTok } : {}),
    'User-Agent': dev.ua,
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'Accept-Language': 'en-IN,en-GB;q=0.9,en-US;q=0.8,hi;q=0.7',
    'Origin': 'https://www.swiggy.com',
    'Referer': referer,
    '__fetch_req__': 'true',
    'platform': 'mweb',
    'Sec-Ch-Ua': dev.secChUa,
    'Sec-Ch-Ua-Mobile': '?1',
    'Sec-Ch-Ua-Platform': '"Android"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    ...extra
  };
}

function isAwsWafChallengeResponse(status, rawText = '', headers = null) {
  const wafHeader = headers && typeof headers.get === 'function' ? (headers.get('x-amzn-waf-action') || '') : '';
  if (wafHeader) return true;
  if (Number(status) === 202) return true;
  const lower = String(rawText || '').toLowerCase();
  if (Number(status) === 403 && /awswaf|captcha|challenge|verify you are human|bot verification|automated traffic|cloudfront/.test(lower)) {
    return true;
  }
  if (/awswafintegration|gokuprops|x-amzn-waf/.test(lower)) return true;
  return false;
}

function isCsrfMismatchResponse(status, rawText = '', data = null) {
  if (Number(status) !== 403 && Number(status) !== 400) return false;
  const combined = `${rawText || ''} ${data?.statusMessage || ''} ${data?.message || ''}`.toLowerCase();
  return /csrf|invalid token|forbidden/.test(combined) && !isAwsWafChallengeResponse(status, rawText);
}

// Fast (~200-350ms, 0MB RAM, zero-Chromium) Swiggy `_csrf` + `_guest_tid` + `_sid` bootstrap!
async function bootstrapSwiggyAuthJar(session, { forceFresh = false } = {}) {
  if (!forceFresh && session.csrfToken && (session.cookieMap.has('_csrf') || session.cookieMap.has('_sid') || session.cookieMap.has('_guest_tid'))) {
    return session.csrfToken;
  }
  if (forceFresh) {
    session.csrfToken = '';
    session.cookieMap.delete('_csrf');
  }

  // Probe 1: Fast WebView HTML route `/web-cart-add-address` (sets `_csrf` cookie + embeds `window._csrf` with zero WAF)
  try {
    const dev = session.deviceProfile || buildAntiBotDeviceProfile(session.phone || '');
    const bootWaf = session.wafToken || freshWafTokenForRequests();
    const res = await fetchSwiggy('https://www.swiggy.com/web-cart-add-address', {
      method: 'GET',
      headers: {
        'Cookie': `${bootWaf ? `aws-waf-token=${bootWaf}; ` : ''}${serializeCookieMap(session.cookieMap)}`,
        ...(bootWaf ? { 'aws-waf-token': bootWaf } : {}),
        'User-Agent': dev.ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-IN,en-GB;q=0.9,en-US;q=0.8',
        'X-Requested-With': 'in.swiggy.android'
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(3500)
    });
    applySetCookiesToMap(session.cookieMap, getResponseSetCookies(res));
    const html = await res.text().catch(() => '');
    let parsedJson = null;
    try { parsedJson = JSON.parse(html); } catch {}
    const csrfMatch = html.match(/window\._csrf\s*=\s*["']([^"']+)["']/) || html.match(/csrfToken["']?\s*:\s*["']([^"']+)["']/);
    const extracted = (csrfMatch && csrfMatch[1]) || parsedJson?.csrfToken || '';
    if (extracted) {
      session.csrfToken = extracted;
      return session.csrfToken;
    }
  } catch {}

  // Probe 2: Zero-WAF DAPI JSON `/dapi/order/all` or `/dapi/cart` with `Swiggy-Android` UA
  for (const probeUrl of ['https://www.swiggy.com/dapi/order/all', 'https://www.swiggy.com/dapi/cart']) {
    try {
      const res = await fetchSwiggy(probeUrl, {
        method: 'GET',
        headers: buildAuthRequestHeaders(session, { referer: 'https://www.swiggy.com/', useAndroidUa: true }),
        signal: AbortSignal.timeout(3500)
      });
      applySetCookiesToMap(session.cookieMap, getResponseSetCookies(res));
      const text = await res.text().catch(() => '');
      let json = null;
      try { json = JSON.parse(text); } catch {}
      if (json?.tid && !session.cookieMap.has('_guest_tid') && !session.cookieMap.has('tid')) {
        session.cookieMap.set('_guest_tid', String(json.tid));
      }
      if (json?.sid && !session.cookieMap.has('_sid')) {
        session.cookieMap.set('_sid', String(json.sid));
      }
      if (json?.csrfToken) {
        session.csrfToken = String(json.csrfToken);
        return session.csrfToken;
      }
    } catch {}
  }

  if (!session.csrfToken && session.cookieMap.get('_csrf')) {
    session.csrfToken = session.cookieMap.get('_csrf');
  }
  return session.csrfToken;
}

async function postSwiggyAuthJson(session, endpointUrl, payload = {}, { timeoutMs = 10_000, allowBrowserEscalation = true } = {}) {
  await bootstrapSwiggyAuthJar(session);

  // "Aaye hi na" — pehle send se pehle live WAF token arrange karo (pool > cached >
  // Chromium solver). Token 2h pool me rehta hai, toh batch ke aage ke requests
  // free me isi se protected.
  if (!session.wafToken) {
    session.wafToken = freshWafTokenForRequests();
    // Parallel lanes me cached token na ho to pehle HTTP attempt ko ek hi
    // Chromium solver ki FIFO queue me minutes tak mat roko. Pehla send
    // turant jayega; agar asal WAF challenge aaya tab neeche wali recovery
    // token solve/rotate/browser escalation karegi.
    if (!session.wafToken && !shouldDeferWafSolveUntilChallenge() && allowBrowserEscalation && canUseStealthBrowser()) {
      try { session.wafToken = await getLiveSwiggyWafToken(); } catch {}
    }
  }

  const sendOnce = async (useAndroidUa = false) => {
    const bodyObj = { ...payload };
    if (session.csrfToken && bodyObj._csrf === undefined) {
      bodyObj._csrf = session.csrfToken;
    }
    const res = await fetchSwiggy(endpointUrl, {
      method: 'POST',
      headers: buildAuthRequestHeaders(session, { referer: 'https://www.swiggy.com/auth', useAndroidUa }),
      body: JSON.stringify(bodyObj),
      signal: AbortSignal.timeout(timeoutMs)
    });
    applySetCookiesToMap(session.cookieMap, getResponseSetCookies(res));
    const rawText = await res.text().catch(() => '');
    let data = {};
    try { data = JSON.parse(rawText); } catch {}
    if (data?.csrfToken) session.csrfToken = String(data.csrfToken);
    if (data?.tid && !session.cookieMap.has('_session_tid')) {
      session.cookieMap.set('tid', String(data.tid));
    }
    if (data?.sid) {
      session.cookieMap.set('_sid', String(data.sid));
    }
    return { status: res.status, data, rawText, headers: res.headers };
  };

  let out = await sendOnce(session.transportMode === 'android');

  // Auto-recover 1: Stale or missing CSRF token (HTTP 403/400 `invalid csrf token`, NOT AWS WAF!)
  if (isCsrfMismatchResponse(out.status, out.rawText, out.data)) {
    await bootstrapSwiggyAuthJar(session, { forceFresh: true });
    out = await sendOnce(session.transportMode === 'android');
  }

  // Auto-recover 2: If mWeb transport hit an AWS WAF challenge, retry once over `Swiggy-Android` transport!
  // Challenge matlab maujooda token jala hua hai — use retry me dobara mat
  // chipkao (session + shared caches dono se saaf).
  if (isAwsWafChallengeResponse(out.status, out.rawText, out.headers) && session.transportMode !== 'android') {
    session.transportMode = 'android';
    session.wafToken = '';
    burnCurrentWafToken();
    await bootstrapSwiggyAuthJar(session, { forceFresh: true });
    out = await sendOnce(true);
  }

  // Auto-recover 2.5: WAF ne phir bhi challenge kiya.
  //
  // 🔀 PROXY MODE: block IP par lagta hai — isliye TURANT nayi IP (proxy)
  // lo aur usi number par retry. ZERO wait. (Global pool cooldown ki
  // zaroorat hi nahi — IP hi badal di.)
  //
  // Direct mode: naya live token lo aur EK baar dobara bhejo + circuit-breaker.
  if (allowBrowserEscalation && isAwsWafChallengeResponse(out.status, out.rawText, out.headers)) {
    if (getBridgeProxy()?.id) {
      // Is proxy ko "hot" mark karo (thodi der ke liye side par), phir
      // turant doosri proxy par retry.
      try { proxyPool.markProxyWafHit(getBridgeProxy().id, 60_000); } catch {}
      const nextProxy = proxyPool.pickProxy({ excludeIds: [getBridgeProxy().id] });
      if (nextProxy) {
        setBridgeProxy(nextProxy);
        session.wafToken = ''; // nayi IP = naya token chahiye
        try { session.wafToken = await getLiveSwiggyWafToken(false, { solveBudgetMs: WAF_SOLVE_FAST_BUDGET_MS }); } catch {}
        await bootstrapSwiggyAuthJar(session, { forceFresh: true });
        out = await sendOnce(session.transportMode === 'android');
      } else {
        // Sab proxies side par hain. Abhi garam hui isi IP par full solver
        // dobara chala kar 25-35s zaya na karo — neeche browser escalation
        // ko ek mauqa milega, warna engine direct fallback/rotate karega.
        session.wafToken = '';
      }
    } else {
      burnCurrentWafToken(); // bridge cache bhi saaf (pool markWafHit me saaf hoga)
      try { wafPool.markWafHit(); } catch {}
      const refreshed = await getLiveSwiggyWafToken(true).catch(() => '');
      if (refreshed && refreshed !== session.wafToken) {
        session.wafToken = refreshed;
        out = await sendOnce(session.transportMode === 'android');
      }
    }
  }

  // Auto-recover 3: Optional Stealth Browser escalation ONLY if still WAF-challenged AND local Chromium exists!
  if (allowBrowserEscalation && isAwsWafChallengeResponse(out.status, out.rawText, out.headers) && canUseStealthBrowser()) {
    const browserEscalationOut = await withBrowserEscalationSlot(async () => {
      if (!session.page || !session.browser?.connected) {
        const launched = await launchStealthSwiggyBrowser();
        session.browser = launched.browser;
        session.page = launched.page;
        session.mode = 'browser';
        await session.page.goto('https://www.swiggy.com/auth', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
        // Challenge aksar thodi insaan-jaisi harkat ke baad khud solve ho jata
        // hai — sirf khade khade cookie ka intezaar kamzor padta tha.
        try {
          await session.page.mouse.move(320 + Math.random() * 240, 240 + Math.random() * 160, { steps: 14 });
          await session.page.mouse.wheel({ deltaY: 600 });
        } catch {}
        await waitForSwiggyWafCookie(session.page, 8000);
      }
      const pageCookies = await session.page.cookies().catch(() => []);
      const wafToken = pageCookies.find(c => c.name === 'aws-waf-token')?.value || '';
      const relPath = endpointUrl.replace(/^https?:\/\/www\.swiggy\.com/i, '');
      const browserOut = await safeEvaluateAuthOnce(session.page, async (targetPath, bodyInput, waf) => {
        try {
          const csrf = (typeof window !== 'undefined' && window._csrf) ? window._csrf : '';
          const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
          if (waf) headers['aws-waf-token'] = waf;
          const finalPayload = { ...bodyInput, ...(csrf && bodyInput._csrf === undefined ? { _csrf: csrf } : {}) };
          const r = await fetch(targetPath, {
            method: 'POST',
            headers,
            body: JSON.stringify(finalPayload),
            credentials: 'include',
            signal: AbortSignal.timeout(7500)
          });
          const txt = await r.text().catch(() => '');
          let j = {};
          try { j = JSON.parse(txt); } catch {}
          return { status: r.status, data: j, rawText: txt };
        } catch (e) {
          return { status: 500, error: e.message };
        }
      }, relPath, payload, wafToken);
      const afterCookies = await session.page.cookies().catch(() => []);
      for (const c of afterCookies) {
        if (c?.name && c?.value && c.name !== 'aws-waf-token') session.cookieMap.set(c.name, c.value);
      }
      if (getBridgeProxy()?.id && isAwsWafChallengeResponse(browserOut?.status, browserOut?.rawText, browserOut?.headers)) {
        try { proxyPool.markProxyWafHit(getBridgeProxy().id, 120_000); } catch {}
      }
      return browserOut;
    }).catch(() => null);
    if (browserEscalationOut) return browserEscalationOut;
  }

  // Final response bhi challenge hai to FINAL route ko pakka quarantine karo.
  // Pehle sirf pehli challenged proxy mark hoti thi — recovery wali doosri
  // proxy agar phir challenge de to wo pool me "clean" reh kar dobara ghumti thi.
  if (getBridgeProxy()?.id && isAwsWafChallengeResponse(out?.status, out?.rawText, out?.headers)) {
    try { proxyPool.markProxyWafHit(getBridgeProxy().id, 120_000); } catch {}
  }

  return out;
}

export function isUnregisteredSwiggyAuthResponse(result) {
  if (!result || (result.status !== 200 && result.status !== 202)) return false;
  // ⚠️ BUG FIX (Render par har naya number `failed_otp_send` ho raha tha):
  // Negative checks AB SIRF human message (statusMessage/message) par lagenge,
  // poore raw JSON par NAHI. Pehle regex me akela `csrf` tha aur Swiggy ke
  // har normal response me `csrfToken` FIELD hota hai — to detector
  // "user not registered" wale response ko bhi pehle hi reject kar deta tha,
  // bot fresh-registration branch me kabhi jata hi nahi tha.
  const statusMsg = `${result.data?.statusMessage || ''} ${result.data?.message || ''}`.toLowerCase();
  if (/rate limit|too many|limit reached|maximum attempts|valid 10 digit|invalid mobile|invalid otp|incorrect otp|wrong otp|expired otp|something went wrong|internal server|invalid csrf|csrf.*(invalid|expire|mismatch)|blocked|suspended/.test(statusMsg)) {
    return false;
  }
  if (isAwsWafChallengeResponse(result.status, result.rawText, result.headers)) {
    return false;
  }
  // Positive check poori body par chal sakta hai (message kabhi nested bhi
  // aata hai) — field-naam isse galat trigger nahi karenge.
  const allText = `${statusMsg} ${String(result.rawText || '').toLowerCase()}`;
  if (/not\s*registered|user\s*not\s*found|does\s*not\s*exist|no\s*account|new\s*user|sign\s*up|signup|register\s*first|unregistered/.test(allText)) {
    return true;
  }
  if (result.data?.data?.registered === false) return true;
  return Number(result.data?.statusCode) === 999;
}

// Pre-warm browser in background (safe no-op on cloud runtimes without local Chromium)
export async function prewarmBrowser() {
  if (!canUseStealthBrowser()) return;
  if (isPrewarming || (prewarmedPage && prewarmedBrowser?.connected && (Date.now() - prewarmedAt < 180000))) return;
  isPrewarming = true;

  try {
    if (prewarmedBrowser) {
      await prewarmedBrowser.close().catch(() => {});
      prewarmedBrowser = null;
      prewarmedPage = null;
    }

    // Prewarm ka browser jis route se launch hua, token bhi usi route ko.
    // Proxy browser ka token shared/direct pool me seed karna IP mismatch tha.
    const routeProxy = getBridgeProxy() || null;
    const { browser, page } = await launchStealthSwiggyBrowser(routeProxy);
    await page.goto('https://www.swiggy.com/restaurants', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

    const wafToken = await waitForSwiggyWafCookie(page, 4000);
    if (!wafToken) {
      await browser.close().catch(() => {});
      return;
    }

    if (routeProxy?.id) {
      proxyPool.setProxyToken(routeProxy.id, wafToken);
      await browser.close().catch(() => {});
      return;
    }

    latestSharedWafToken = wafToken;
    latestSharedWafAt = Date.now();
    try { wafPool.seedToken(wafToken, { source: 'chromium' }); } catch {}

    prewarmedBrowser = browser;
    prewarmedPage = page;
    prewarmedAt = Date.now();
  } catch (err) {
    if (prewarmedBrowser) {
      await prewarmedBrowser.close().catch(() => {});
      prewarmedBrowser = null;
      prewarmedPage = null;
    }
  } finally {
    isPrewarming = false;
  }
}

// Universal cached / live AWS WAF token provider for both swiggy-bridge and swiggy-cart.
// Doosra argument solver ka time budget hai — proxy screening me full
// 80-90s solver har route par chalana batch ko maar deta tha.
export async function getLiveSwiggyWafToken(forceRefresh = false, { solveBudgetMs = WAF_SOLVE_RELIABLE_BUDGET_MS } = {}) {
  const now = Date.now();
  const routeProxy = getBridgeProxy() || null;

  // 🔀 PROXY MODE — token IP-bound hota hai, isliye per-proxy cache.
  if (routeProxy?.id) {
    const pid = routeProxy.id;
    if (!forceRefresh) {
      const cached = proxyPool.getProxyToken(pid);
      if (cached) return cached;
      // Isi proxy par solver abhi fail hua tha — dobara full Chromium
      // chalane ke bajaye caller ko turant khali token do taaki route
      // rotate/direct fallback foran ho.
      if (proxyPool.proxyWafSolveCooldownLeftMs(pid) > 0) return '';
    }

    const solved = await solveWafTokenOnce(forceRefresh, routeProxy, { solveBudgetMs });
    if (solved) {
      // Token hamesha USI proxy ke naam store hoga jiske browser se bana.
      proxyPool.setProxyToken(pid, solved);
      // Solver ke beech route badal gaya ho to purani IP ka token nayi IP
      // ke caller ko mat chipkao.
      return getBridgeProxy()?.id === pid ? solved : (proxyPool.getProxyToken(getBridgeProxy()?.id || '') || '');
    }
    // Chrome hi missing ho to ye proxy ki galti nahi — route ko quarantine
    // mat karo (Android/browser-less paths phir bhi chal sakte hain).
    if (canUseStealthBrowser()) proxyPool.markProxyWafSolveFailure(pid);
    return '';
  }

  // Check shared pool token first:
  const poolToken = wafPool.getTokenSync?.();
  if (!forceRefresh && poolToken) {
    latestSharedWafToken = poolToken;
    latestSharedWafAt = Date.now();
    return poolToken;
  }
  if (!forceRefresh && latestSharedWafToken && (now - latestSharedWafAt < WAF_CACHE_TTL_MS)) {
    return latestSharedWafToken;
  }

  // 1. Check if prewarmedPage is alive and has an active WAF cookie (<5ms check):
  if (!forceRefresh && prewarmedPage && prewarmedBrowser?.connected) {
    try {
      const cookies = await prewarmedPage.cookies('https://www.swiggy.com').catch(() => []);
      const waf = cookies.find(c => c.name === 'aws-waf-token' && String(c.value || '').length > 50);
      if (waf && waf.value) {
        latestSharedWafToken = waf.value;
        latestSharedWafAt = Date.now();
        try { wafPool.seedToken(waf.value, { source: 'chromium' }); } catch {}
        return latestSharedWafToken;
      }
    } catch {}
  }

  // Direct route par solver abhi fail hua ho to har claim se pehle wahi
  // 45s Chromium dobara mat chalao. Short cooldown me raw/Android recovery
  // aage badhegi; asal WAF challenge par force-refresh wali recovery is
  // cooldown ko bypass karke phir solve kar sakti hai.
  if (!forceRefresh && _directWafSolveCooldownLeftMs() > 0) return '';

  // 2. Coalesce concurrent requests — lekin SIRF usi route ke andar.
  const token = await solveWafTokenOnce(forceRefresh, null, { solveBudgetMs });
  const routeStillDirect = !getBridgeProxy()?.id;
  if (token && routeStillDirect) {
    directWafSolveFailedUntil = 0;
    latestSharedWafToken = token;
    latestSharedWafAt = Date.now();
    return token;
  }
  if (!token && routeStillDirect && canUseStealthBrowser()) {
    directWafSolveFailedUntil = Date.now() + DIRECT_WAF_SOLVE_FAILURE_COOLDOWN_MS;
  }
  return token && !routeStillDirect ? '' : (token || '');
}

// Chromium solver — ek valid `aws-waf-token` laata hai. Route snapshot
// shuru me pakad lo: browser hamesha usi proxy se chalega jiske liye solve
// maanga gaya tha, beech me active bridge route badal bhi jaye to token
// galat IP par nahi chipkega. Coalescing bhi per-route hai.
// Time budget hard cap hai — pehle ek fail solve 80-90s kha sakta tha.
async function solveWafTokenOnce(forceRefresh = false, routeProxy = getBridgeProxy(), { solveBudgetMs = WAF_SOLVE_RELIABLE_BUDGET_MS } = {}) {
  const routeKey = _wafSolveRouteKey(routeProxy);
  const existing = wafSolvePromises.get(routeKey);
  if (existing) return existing;

  // Route locks alag hain, lekin ek waqt me Chromium solver sirf EK hi
  // chalega (free Render par 2 browser = memory/time dono ka nuqsan).
  // Proper FIFO tail hai — har route sirf apne se pehle wali baari ka
  // intezaar karti hai, isliye cross-route deadlock bhi nahi ban sakta.
  const previousSolve = wafSolveTail;
  let releaseSolve;
  const solveGate = new Promise((resolve) => { releaseSolve = resolve; });
  wafSolveTail = previousSolve.catch(() => '').then(() => solveGate);

  const solvePromise = (async () => {
    await previousSolve.catch(() => '');
    const startedAt = Date.now();
    const budgetMs = normalizeWafSolveBudgetMs(solveBudgetMs);
    const deadline = startedAt + budgetMs;
    const remaining = () => Math.max(0, deadline - Date.now());
    let browser = null;
    try {
      const launched = await launchStealthSwiggyBrowser(routeProxy);
      browser = launched.browser;
      const page = launched.page;

      await page.goto('https://www.swiggy.com/', {
        waitUntil: 'domcontentloaded',
        timeout: Math.min(20_000, Math.max(3_000, remaining()))
      }).catch(() => {});

      let token = await waitForSwiggyWafCookie(page, Math.min(SWIGGY_WAF_COOKIE_WAIT_MS, remaining()));
      if (!token && remaining() > 5_000) {
        // Pehle pass me cookie nahi aayi — challenge page aksar harkat
        // (mouse/scroll) ke baad khud token de deta hai. Ek aur mauqa do,
        // phir doosra page try karo — lekin budget ke andar hi.
        try {
          await page.mouse.move(320 + Math.random() * 240, 240 + Math.random() * 160, { steps: 14 });
          await page.mouse.wheel({ deltaY: 700 });
          await new Promise((r) => setTimeout(r, Math.min(1200, Math.max(0, remaining() - 3_000))));
        } catch {}
        token = await waitForSwiggyWafCookie(page, Math.min(8_000, remaining()));
      }
      if (!token && remaining() > 8_000) {
        await page.goto('https://www.swiggy.com/restaurants', {
          waitUntil: 'domcontentloaded',
          timeout: Math.min(15_000, Math.max(3_000, remaining() - 2_000))
        }).catch(() => {});
        token = await waitForSwiggyWafCookie(page, Math.min(10_000, remaining()));
      }
      if (token) {
        // Direct route = shared pool; proxy route = caller per-proxy store karega.
        if (!routeProxy?.id) {
          latestSharedWafToken = token;
          latestSharedWafAt = Date.now();
          try { wafPool.seedToken(token, { source: 'chromium' }); } catch {}
        }
        await new Promise(r => setTimeout(r, Math.min(1500, remaining())));
      }
      console.log(`[SwiggyBridge] WAF solver ${token ? 'OK' : 'FAIL'} | route=${routeLabel(routeProxy)} | ${Date.now() - startedAt}ms`);
      await browser.close().catch(() => {});
      return token || '';
    } catch (err) {
      if (browser) await browser.close().catch(() => {});
      console.warn(`[SwiggyBridge] WAF solver error | route=${routeLabel(routeProxy)} | ${err.message}`);
      return '';
    } finally {
      wafSolvePromises.delete(routeKey);
    }
  })();

  wafSolvePromises.set(routeKey, solvePromise);
  solvePromise.then(() => releaseSolve(''), () => releaseSolve(''));
  return solvePromise;
}

export async function safeEvaluateAuthOnce(page, fn, ...args) {
  let timeoutId;
  try {
    // Auth POSTs must execute once only: retrying after a CDP timeout can send a duplicate OTP.
    return await Promise.race([
      page.evaluate(fn, ...args),
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`Auth browser request timed out after ${AUTH_PAGE_EVALUATE_TIMEOUT_MS}ms; no automatic retry was attempted.`)),
          AUTH_PAGE_EVALUATE_TIMEOUT_MS
        );
      })
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export function parseSwiggyOtpError(otpResult) {
  if (!otpResult) {
    return {
      code: 'NO_RESPONSE',
      retryable: true,
      message: 'Swiggy ne OTP request ka response nahi diya. Network check karke baad mein ek baar retry karein.',
      swiggyStatus: 'No Response',
      details: 'Empty response from Swiggy'
    };
  }

  const swiggyMsg = (otpResult.data?.statusMessage || otpResult.data?.message || '').trim();
  const rawLower = ((otpResult.rawText || '') + ' ' + swiggyMsg).toLowerCase();
  const status = Number(otpResult.status || 0);
  const swiggyCode = Number(otpResult.data?.statusCode);

  if (status === 429 || swiggyCode === 429 || /rate limit|too many|limit reached|maximum attempts/.test(rawLower)) {
    return {
      code: 'SWIGGY_RATE_LIMIT',
      retryable: false,
      message: 'Swiggy ne OTP requests par temporary limit lagayi hai. Abhi dobara request na bhejein; 15–30 minute rukkar official Swiggy app/site se try karein. Repeated attempts limit ko badha sakte hain.',
      swiggyStatus: swiggyMsg || 'Swiggy Rate Limit (429 Too Many Requests)',
      details: `HTTP ${status || 429} | Swiggy rate limit`
    };
  }

  if (isCsrfMismatchResponse(status, otpResult.rawText || '', otpResult.data)) {
    return {
      code: 'SWIGGY_CSRF_EXPIRED',
      retryable: true,
      message: 'Swiggy session token refresh ho gaya hai. Ek baar Retry OTP dabayein.',
      swiggyStatus: swiggyMsg || 'Session CSRF Refresh Needed',
      details: `HTTP ${status || 403} | CSRF token refresh required`
    };
  }

  if (
    status === 202 ||
    isAwsWafChallengeResponse(status, otpResult.rawText || '', otpResult.headers) ||
    (status === 403 && !/csrf/.test(rawLower)) ||
    /waf|captcha|challenge|security check|access denied|verify you are human|bot verification|automated traffic/.test(rawLower)
  ) {
    return {
      code: 'SWIGGY_SECURITY_CHALLENGE',
      retryable: false,
      message: 'Swiggy security verification stopped this OTP request. This bot will not retry or bypass that check. Complete any verification in the official Swiggy app/site, or use an existing session export; try again later only if Swiggy allows it.',
      swiggyStatus: swiggyMsg || 'Security challenge (HTTP 403)',
      details: `HTTP ${status || 403} | Swiggy security challenge; no automated retry attempted`
    };
  }

  if (status === 400 || status === 422 || /invalid mobile|valid 10 digit/.test(rawLower)) {
    return {
      code: 'INVALID_MOBILE',
      retryable: false,
      message: `Swiggy rejected the number (${swiggyMsg || 'invalid format'}). Send a standalone valid Indian mobile number: 10 digits, or 12 digits beginning with 91.`,
      swiggyStatus: swiggyMsg || 'Invalid Mobile Number',
      details: `HTTP ${status || 400}`
    };
  }

  // Error field wala 5xx aksar asal Swiggy response nahi hota — browser /
  // proxy / network exception ko synthetic status 500 de kar yahan bheja
  // jata hai. Use "Swiggy server error" kehna gumrah-kun tha (asli wajah
  // chhup jati thi), isliye pehle SYSTEM_ERROR classify karo.
  if (otpResult.error) {
    return {
      code: 'SYSTEM_ERROR',
      retryable: true,
      message: `Could not complete the OTP request: ${otpResult.error}`,
      swiggyStatus: otpResult.error,
      details: 'Network or session context error'
    };
  }

  if ([500, 502, 503, 504].includes(status)) {
    return {
      code: 'SWIGGY_SERVER_ERROR',
      retryable: true,
      message: `Swiggy returned a temporary server error (HTTP ${status}). Wait a minute or two before retrying.`,
      swiggyStatus: swiggyMsg || `Swiggy Server Error (${status})`,
      details: `HTTP ${status}`
    };
  }

  if (swiggyMsg) {
    return {
      code: 'SWIGGY_ERROR',
      retryable: true,
      message: `Swiggy rejected the OTP request: ${swiggyMsg} (HTTP ${status || 200}).`,
      swiggyStatus: swiggyMsg,
      details: `HTTP ${status || 200} | Swiggy Code: ${otpResult.data?.statusCode ?? 'none'}`
    };
  }

  return {
    code: 'SWIGGY_ERROR',
    retryable: true,
    message: `Swiggy did not confirm the OTP request (HTTP ${status || 'unknown'}). Check the official Swiggy app/site or try an existing session export.`,
    swiggyStatus: `HTTP ${status || 'unknown'} - OTP not confirmed`,
    details: `HTTP ${status || 'unknown'}`
  };
}

const otpInFlightByPhone = new Map();
const recentOtpDispatches = new Map();

function closeBridgeSessionCleanly(session) {
  if (!session) return;
  try {
    if (session.safetyTimer) clearTimeout(session.safetyTimer);
    if (session.browser) session.browser.close().catch(() => {});
  } catch {}
}

export async function requestSwiggyOtpViaBridge(userId, phone, targetAcc = '', targetAccName = null) {
  const cleanPhone = normalizeIndianMobileNumber(phone) || '';

  if (cleanPhone.length !== 10) {
    return { success: false, code: 'INVALID_MOBILE', message: 'Send a standalone 10-digit Indian mobile number or a 12-digit number beginning with 91.' };
  }

  const inflightKey = `${userId}:${cleanPhone}`;
  if (otpInFlightByPhone.has(inflightKey)) {
    return otpInFlightByPhone.get(inflightKey);
  }

  // Prevent accidental double-tap within 3.5s from firing 2 simultaneous SMS requests & burning Swiggy's rate limit!
  const recentHit = recentOtpDispatches.get(inflightKey);
  if (recentHit && (Date.now() - recentHit.ts < 3500) && activeSessions[userId]?.phone === cleanPhone) {
    if (targetAcc) activeSessions[userId].targetAcc = targetAcc;
    if (targetAccName) activeSessions[userId].targetAccName = targetAccName;
    return {
      success: true,
      phone: cleanPhone,
      isNewUser: Boolean(activeSessions[userId].isNewUser),
      deduplicated: true,
      message: 'OTP Sent',
      swiggyStatus: 'OTP Sent'
    };
  }

  const runPromise = (async () => {
    // 🔀 PROXY MODE: current proxy side par (cooldown) ho to TURANT doosri
    // proxy le lo — ZERO wait. Sab side par ho tabhi cooldown dikhao.
    if (getBridgeProxy()?.id) {
      const currentId = getBridgeProxy().id;
      const curInfo = proxyPool.listProxies().find((p) => p.id === currentId);
      const wafCooling = (curInfo?.cooldownLeftMs || 0) > 5000;
      const solveCooling = (curInfo?.wafSolveCooldownLeftMs || 0) > 5000 && !curInfo?.tokenReady;
      // Pehle har OTP par yunhi pickProxy() chal jata tha — rotation hue
      // baghair hi doosri proxy ke hits/last-used badh jate the. Ab sirf
      // asal garam/unsolvable route par alternative dhoondo.
      const nextProxy = (wafCooling || solveCooling)
        ? proxyPool.pickProxy({ excludeIds: [currentId] })
        : null;
      if ((wafCooling || solveCooling) && nextProxy) {
        setBridgeProxy(nextProxy);
        console.log(`[SwiggyBridge] Proxy rotated (${wafCooling ? 'cooldown' : 'solve-failed'}) → ${nextProxy.label}`);
      } else if (wafCooling && !nextProxy) {
        // Sab proxies side par — engine ko bolo thodi der ruk kar aage badhe
        const cd = curInfo?.cooldownLeftMs || 60_000;
        return {
          success: false,
          code: 'SWIGGY_WAF_COOLDOWN',
          retryable: true,
          cooldownMs: cd,
          message: `Saare ${proxyPool.listProxies().filter((p) => p.enabled).length} proxies WAF cooldown me hain (~${Math.ceil(cd / 60000)} min). Bot khud wait karke aage badhega.`,
          swiggyStatus: `All proxies cooling ${Math.ceil(cd / 60000)} min`,
          details: `All proxies on WAF cooldown | ${Math.round(cd / 1000)}s remaining`
        };
      }
    } else {
      // Direct mode (koi proxy nahi) — purana global circuit-breaker
      try {
        const cd = wafPool.cooldownRemainingMs?.() || 0;
        if (cd > 5000) {
          return {
            success: false,
            code: 'SWIGGY_WAF_COOLDOWN',
            retryable: true,
            cooldownMs: cd,
            message: `Swiggy WAF cooldown chal raha hai (~${Math.ceil(cd / 60000)} min). Bot khud wait karke aage badhega.`,
            swiggyStatus: `WAF cooldown ${Math.ceil(cd / 60000)} min`,
            details: `WAF circuit-breaker active | ${Math.round(cd / 1000)}s remaining`
          };
        }
      } catch {}
    }

    if (activeSessions[userId]) {
      closeBridgeSessionCleanly(activeSessions[userId]);
      delete activeSessions[userId];
    }

    const session = createSwiggyHttpAuthSession(cleanPhone, targetAcc || `acc_${cleanPhone}`, targetAccName || null);

    try {
      // Step 1: Dispatch primary SMS OTP with live `_csrf` + realistic mobile device cookies/headers (~350-600ms total!)
      let otpResult = await postSwiggyAuthJson(session, 'https://www.swiggy.com/dapi/auth/sms-otp', {
        mobile: cleanPhone
      });

      const msgLower = `${otpResult.data?.statusMessage || ''} ${otpResult.data?.message || ''} ${otpResult.rawText || ''}`.toLowerCase();
      const isRateOrInvalid =
        otpResult.status === 429 ||
        /rate limit|too many|limit reached|maximum|valid 10 digit|invalid mobile/.test(msgLower);
      const isSecurityBlocked = isAwsWafChallengeResponse(otpResult.status, otpResult.rawText, otpResult.headers) ||
        (otpResult.status === 403 && !isCsrfMismatchResponse(otpResult.status, otpResult.rawText, otpResult.data));

      // Fallback to `/dapi/auth/otp-generate` ONLY when `/dapi/auth/sms-otp` returned an unexpected non-200/non-unregistered status
      if (
        !isRateOrInvalid &&
        !isSecurityBlocked &&
        !isUnregisteredSwiggyAuthResponse(otpResult) &&
        (otpResult.status !== 200 || (otpResult.data?.statusCode && otpResult.data.statusCode !== 0 && otpResult.data.statusCode !== 1))
      ) {
        const altOut = await postSwiggyAuthJson(session, 'https://www.swiggy.com/dapi/auth/otp-generate', {
          mobile: cleanPhone
        }, { allowBrowserEscalation: false });
        if (altOut.status === 200 && (altOut.data?.statusCode === 0 || altOut.data?.statusCode === undefined)) {
          otpResult = altOut;
        }
      }

      // Check if number is unregistered / brand-new on Swiggy (including bare `statusCode: 1` verified via `signin-with-check` or explicit message)
      let isUnregistered = isUnregisteredSwiggyAuthResponse(otpResult);
      if (!isUnregistered && !isRateOrInvalid && !isSecurityBlocked && otpResult.status === 200 && otpResult.data?.statusCode === 1) {
        const bareMsg = String(otpResult.data?.statusMessage || otpResult.data?.message || '').trim().toLowerCase();
        if (!bareMsg) {
          const chkOut = await postSwiggyAuthJson(session, 'https://www.swiggy.com/dapi/auth/signin-with-check', {
            mobile: cleanPhone
          }, { allowBrowserEscalation: false }).catch(() => null);
          if (chkOut && (isUnregisteredSwiggyAuthResponse(chkOut) || chkOut.data?.data?.registered === false || chkOut.data?.type === 'register' || chkOut.data?.statusCode === 1)) {
            isUnregistered = true;
          }
        }
      }

      if (isUnregistered) {
        const signupName = sanitizeSwiggyName(targetAccName);
        let signupEmail = generateUniqueSwiggyEmail(cleanPhone, signupName);
        console.log(`[SwiggyBridge] Number ${cleanPhone} is new/unregistered on Swiggy. Dispatching signup flow as "${signupName}" (${signupEmail})...`);

        let signupInitResult = await postSwiggyAuthJson(session, 'https://www.swiggy.com/dapi/auth/signup', {
          mobile: cleanPhone,
          name: signupName,
          email: signupEmail,
          password: '',
          referral_code: ''
        });

        const initMsgLower = `${signupInitResult.data?.statusMessage || ''} ${signupInitResult.data?.message || ''} ${signupInitResult.rawText || ''}`.toLowerCase();
        // If generated email collided with an archived record, regenerate once and retry cleanly
        if (signupInitResult.status === 200 && signupInitResult.data?.statusCode !== 0 && /email.*exist|email.*already|duplicate.*email|invalid.*email/i.test(initMsgLower)) {
          signupEmail = generateFreshSwiggyEmail(cleanPhone, { attempt: 1 });
          signupInitResult = await postSwiggyAuthJson(session, 'https://www.swiggy.com/dapi/auth/signup', {
            mobile: cleanPhone,
            name: signupName,
            email: signupEmail,
            password: '',
            referral_code: ''
          }, { allowBrowserEscalation: false });
        }

        const finalInitLower = `${signupInitResult.data?.statusMessage || ''} ${signupInitResult.data?.message || ''} ${signupInitResult.rawText || ''}`.toLowerCase();
        const signupSecurityBlocked = isAwsWafChallengeResponse(signupInitResult.status, signupInitResult.rawText, signupInitResult.headers) ||
          signupInitResult.status === 429 ||
          /rate limit|too many|limit reached/.test(finalInitLower);

        let signupPreRegistered = false;
        let signupOtpDispatched = false;

        if (!signupSecurityBlocked && signupInitResult.status === 200 && (signupInitResult.data?.statusCode === 0 || signupInitResult.data?.statusCode === undefined)) {
          signupPreRegistered = true;
          signupOtpDispatched = true;
        } else if (!signupSecurityBlocked && signupInitResult.status === 200) {
          // Cluster requires `sms-otp` (with `type: 'register'`) first and `signup` WITH `otp` on verification!
          // (Pehle ye fallback sirf "otp required/invalid otp" wording par
          // chalta tha — Swiggy wording badle to number seedha fail ho jata
          // tha. Ab signup-init ka koi bhi non-success 200 aaye to register
          // OTP ek baar try hoga; wo bhi fail ho tab hi asli error.)
          console.log(`[SwiggyBridge] signup-init non-success (HTTP ${signupInitResult.status}, code=${signupInitResult.data?.statusCode}, msg="${signupInitResult.data?.statusMessage || signupInitResult.data?.message || ''}") — sms-otp type=register fallback try kar raha hoon.`);
          const regSms = await postSwiggyAuthJson(session, 'https://www.swiggy.com/dapi/auth/sms-otp', {
            mobile: cleanPhone,
            type: 'register'
          }, { allowBrowserEscalation: false });
          if (regSms.status === 200 && (regSms.data?.statusCode === 0 || regSms.data?.statusCode === undefined)) {
            signupOtpDispatched = true;
          } else {
            signupInitResult = regSms;
          }
        }

        if (signupOtpDispatched) {
          session.isNewUser = true;
          session.signupPreRegistered = signupPreRegistered;
          session.signupName = signupName;
          session.signupEmail = signupEmail;
          session.targetAccName = String(targetAccName || signupName).trim() || signupName;
          session.safetyTimer = setTimeout(() => {
            if (activeSessions[userId] === session) {
              closeBridgeSessionCleanly(session);
              delete activeSessions[userId];
            }
          }, 600_000);

          activeSessions[userId] = session;
          recentOtpDispatches.set(inflightKey, { ts: Date.now() });

          return {
            success: true,
            phone: cleanPhone,
            isNewUser: true,
            message: 'OTP Sent',
            swiggyStatus: 'OTP Sent'
          };
        }

        closeBridgeSessionCleanly(session);
        const parsedErr = parseSwiggyOtpError(signupInitResult);
        console.warn(`[SwiggyBridge] Signup OTP send failed | phone=******${cleanPhone.slice(-4)} | code=${parsedErr.code} | http=${signupInitResult.status || 0} | proxy=${getBridgeProxy()?.label || 'direct'} | ${parsedErr.message}`);
        return {
          success: false,
          code: parsedErr.code,
          retryable: parsedErr.retryable,
          httpStatus: Number(signupInitResult.status) || 0,
          message: parsedErr.message,
          swiggyStatus: parsedErr.swiggyStatus,
          details: parsedErr.details
        };
      }

      const isSent = !isRateOrInvalid && !isSecurityBlocked && otpResult.status === 200 && (
        otpResult.data?.statusCode === 0 || otpResult.data?.statusCode === undefined
      );

      if (isSent) {
        const defaultSignupName = sanitizeSwiggyName(targetAccName);
        session.isNewUser = false;
        session.signupName = defaultSignupName;
        session.signupEmail = generateUniqueSwiggyEmail(cleanPhone, defaultSignupName);
        session.safetyTimer = setTimeout(() => {
          if (activeSessions[userId] === session) {
            closeBridgeSessionCleanly(session);
            delete activeSessions[userId];
          }
        }, 600_000);

        activeSessions[userId] = session;
        recentOtpDispatches.set(inflightKey, { ts: Date.now() });

        return {
          success: true,
          phone: cleanPhone,
          message: 'OTP Sent',
          swiggyStatus: 'OTP Sent'
        };
      }

      closeBridgeSessionCleanly(session);
      const parsedErr = parseSwiggyOtpError(otpResult);
      console.warn(`[SwiggyBridge] OTP send failed | phone=******${cleanPhone.slice(-4)} | code=${parsedErr.code} | http=${otpResult.status || 0} | proxy=${getBridgeProxy()?.label || 'direct'} | ${parsedErr.message}`);
      return {
        success: false,
        code: parsedErr.code,
        retryable: parsedErr.retryable,
        httpStatus: Number(otpResult.status) || 0,
        message: parsedErr.message,
        swiggyStatus: parsedErr.swiggyStatus,
        details: parsedErr.details
      };
    } catch (err) {
      closeBridgeSessionCleanly(session);
      delete activeSessions[userId];
      const lower = String(err.message || '').toLowerCase();
      // Generic exception ko synthetic HTTP 500 mat banao — wo aksar proxy /
      // network fail hota hai, Swiggy server ka jawab nahi. Sirf rate-limit
      // aur WAF wording se status infer karo; baki SYSTEM_ERROR rahega.
      const inferredStatus = /429|rate limit|too many requests/.test(lower)
        ? 429
        : (/waf|captcha|challenge|verify you are human|bot verification|automated traffic/.test(lower) ? 403 : 0);
      const diagnostic = parseSwiggyOtpError({
        status: inferredStatus,
        error: err.message,
        data: { statusMessage: err.message }
      });
      console.warn(`[SwiggyBridge] OTP send exception | phone=******${cleanPhone.slice(-4)} | code=${diagnostic.code} | proxy=${getBridgeProxy()?.label || 'direct'} | ${err.message}`);
      return {
        success: false,
        code: diagnostic.code,
        retryable: diagnostic.retryable,
        httpStatus: inferredStatus,
        message: diagnostic.message,
        swiggyStatus: diagnostic.swiggyStatus,
        details: err.stack ? err.stack.split('\n')[0] : diagnostic.details
      };
    }
  })();

  otpInFlightByPhone.set(inflightKey, runPromise);
  try {
    return await runPromise;
  } finally {
    otpInFlightByPhone.delete(inflightKey);
  }
}

async function resolveDeleteCookieJarAndCsrf(acc, cleanPhone = '', targetAcc = '', db = null) {
  let effectiveAcc = acc ? { ...acc } : null;
  if (!effectiveAcc && db) {
    const vaultEntry = (cleanPhone && db.sessionVault?.[cleanPhone]) || (targetAcc && db.sessionVault?.[targetAcc]) || null;
    if (vaultEntry) effectiveAcc = { ...vaultEntry };
  }
  if (effectiveAcc && db && !String(effectiveAcc.cookies || '').includes('_session_tid=')) {
    const vaultEntry = (cleanPhone && db.sessionVault?.[cleanPhone]) || (targetAcc && db.sessionVault?.[targetAcc]) || null;
    if (vaultEntry?.cookies?.includes('_session_tid=')) {
      effectiveAcc.cookies = `${vaultEntry.cookies}; ${effectiveAcc.cookies || ''}`;
    }
  }

  let cookieString = stripStaleWafCookie(cleanEssentialSwiggyCookies(effectiveAcc?.cookies || '', effectiveAcc || {}));

  // Auto-mint `_session_tid` if account was imported with Android tokens (`tid` + `token`) without web `_session_tid`!
  if (!cookieString.includes('_session_tid=') && effectiveAcc && (effectiveAcc.tid || effectiveAcc.token)) {
    try {
      const bootstrap = await loadAndroidBootstrap();
      const minted = bootstrap ? await bootstrap(effectiveAcc, 3500) : null;
      if (minted) {
        cookieString = stripStaleWafCookie(minted);
      }
    } catch {}
  }

  const cookieMap = new Map();
  for (const part of cookieString.split(';')) {
    const trimmed = part.trim();
    if (!trimmed || !trimmed.includes('=')) continue;
    const eq = trimmed.indexOf('=');
    cookieMap.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return { effectiveAcc, cookieString, cookieMap };
}

async function ensureDeleteCsrfToken(cookieMap, currentCsrf = '', deviceProfile = null) {
  if (currentCsrf && cookieMap.has('_csrf')) return currentCsrf;
  const dev = deviceProfile || buildAntiBotDeviceProfile('');

  try {
    const res = await fetchSwiggy('https://www.swiggy.com/web-cart-add-address', {
      method: 'GET',
      headers: {
        'Cookie': serializeCookieMap(cookieMap),
        'User-Agent': dev.ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'X-Requested-With': 'in.swiggy.android'
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(3000)
    });
    applySetCookiesToMap(cookieMap, getResponseSetCookies(res));
    const html = await res.text().catch(() => '');
    const m = html.match(/window\._csrf\s*=\s*["']([^"']+)["']/) || html.match(/csrfToken["']?\s*:\s*["']([^"']+)["']/);
    if (m && m[1]) return m[1];
  } catch {}

  try {
    const res = await fetchSwiggy('https://www.swiggy.com/dapi/order/all', {
      method: 'GET',
      headers: {
        'Cookie': serializeCookieMap(cookieMap),
        'User-Agent': 'Swiggy-Android',
        'Accept': 'application/json',
        'Referer': 'https://www.swiggy.com/my-account'
      },
      signal: AbortSignal.timeout(3000)
    });
    applySetCookiesToMap(cookieMap, getResponseSetCookies(res));
    const j = await res.json().catch(() => null);
    if (j?.csrfToken) return String(j.csrfToken);
  } catch {}

  return currentCsrf || cookieMap.get('_csrf') || '';
}

export async function requestSwiggyDeleteOtpViaBridge(userId, phone, targetAcc = '', targetAccName = null) {
  const cleanPhone = normalizeIndianMobileNumber(phone) || '';
  if (!cleanPhone) {
    return { success: false, code: 'INVALID_MOBILE', message: 'Send a standalone 10-digit Indian mobile number or a 12-digit number beginning with 91.' };
  }

  delete activeDeleteSessions[userId];

  const { getDb } = await import('./store.js');
  const db = getDb();
  let acc = db.config?.accounts?.[targetAcc];

  if (!acc && cleanPhone) {
    for (const [k, a] of Object.entries(db.config?.accounts || {})) {
      const aPhone = normalizeIndianMobileNumber(a?.phone || a?.mobile || String(k).replace(/^acc_/, '')) || '';
      if (aPhone === cleanPhone && (a?.cookies || a?.tid || a?.token)) {
        acc = a;
        targetAcc = k;
        break;
      }
    }
  }

  const { effectiveAcc, cookieString, cookieMap } = await resolveDeleteCookieJarAndCsrf(acc, cleanPhone, targetAcc, db);

  if (!cookieString && !effectiveAcc?.tid && !effectiveAcc?.token) {
    return {
      success: false,
      isAuthError: true,
      message: 'Account session cookies not found. Please log in first or remove account from Bot DB.'
    };
  }

  const isAuth = checkLoggedInFromCookies(cookieString) || checkLoggedInFromCookies(effectiveAcc);
  if (!isAuth) {
    return {
      success: false,
      isAuthError: true,
      message: 'Selected account session is logged out or expired. Re-login or remove from Bot DB.'
    };
  }

  deleteOtpRequestCount++;
  const reqNum = deleteOtpRequestCount;
  const maskedPhone = cleanPhone.length >= 4 ? '******' + cleanPhone.slice(-4) : '***';
  const dev = buildAntiBotDeviceProfile(cleanPhone);
  console.log(`[SwiggyDelete] [Request #${reqNum}] Triggering Delete OTP: GET /mapi/auth/delete/userCheck | Target: ${targetAcc} | Phone: ${maskedPhone}`);

  try {
    const tidVal = effectiveAcc?.tid || cookieMap.get('tid') || '';
    const sidVal = effectiveAcc?.sid || cookieMap.get('_sid') || '';
    const tokVal = effectiveAcc?.token || cookieMap.get('token') || '';
    const devVal = effectiveAcc?.deviceId || cookieMap.get('_device_id') || dev.deviceId;
    let delWafTok = freshWafTokenForRequests();

    const callUserCheck = async (useAndroidUa = false) => {
      const r = await fetchSwiggy('https://www.swiggy.com/mapi/auth/delete/userCheck', {
        method: 'GET',
        headers: {
          'Cookie': `${delWafTok ? `aws-waf-token=${delWafTok}; ` : ''}${serializeCookieMap(cookieMap)}`,
          ...(delWafTok ? { 'aws-waf-token': delWafTok } : {}),
          'User-Agent': useAndroidUa ? 'Swiggy-Android' : dev.ua,
          'Accept': 'application/json',
          'Referer': 'https://www.swiggy.com/my-account/settings',
          'Origin': 'https://www.swiggy.com',
          ...(tidVal ? { 'tid': tidVal } : {}),
          ...(sidVal ? { 'sid': sidVal } : {}),
          ...(tokVal ? { 'token': tokVal } : {}),
          ...(devVal ? { 'deviceId': devVal, 'swuid': devVal } : {})
        },
        signal: AbortSignal.timeout(8000)
      });
      applySetCookiesToMap(cookieMap, getResponseSetCookies(r));
      const txt = await r.text().catch(() => '');
      let parsed = {};
      try { parsed = JSON.parse(txt); } catch {}
      return { status: r.status, rawText: txt, data: parsed, headers: r.headers };
    };

    let checkOut = await callUserCheck(false);
    if (isAwsWafChallengeResponse(checkOut.status, checkOut.rawText, checkOut.headers)) {
      checkOut = await callUserCheck(true);
    }
    // 🔀 WAF ne phir bhi roka. Proxy mode = TURANT nayi IP (zero wait);
    // Direct mode = circuit-breaker + naya token + EK clean retry.
    if (isAwsWafChallengeResponse(checkOut.status, checkOut.rawText, checkOut.headers)) {
      if (getBridgeProxy()?.id) {
        try { proxyPool.markProxyWafHit(getBridgeProxy().id, 60_000); } catch {}
        const nextProxy = proxyPool.pickProxy({ excludeIds: [getBridgeProxy().id] });
        if (nextProxy) {
          setBridgeProxy(nextProxy);
          delWafTok = await getLiveSwiggyWafToken().catch(() => delWafTok);
          checkOut = await callUserCheck(false);
        }
      } else {
        try { wafPool.markWafHit(); } catch {}
        const refreshed = await getLiveSwiggyWafToken(true).catch(() => '');
        if (refreshed && refreshed !== delWafTok) {
          delWafTok = refreshed;
          checkOut = await callUserCheck(false);
        }
      }
    }

    const { status, rawText, data, headers } = checkOut;
    const responseLower = `${rawText} ${data.statusMessage || data.message || data.error || ''}`.toLowerCase();

    if (isAwsWafChallengeResponse(status, rawText, headers)) {
      delete activeDeleteSessions[userId];
      return {
        success: false,
        code: 'SWIGGY_SECURITY_CHALLENGE',
        retryable: false,
        message: 'Swiggy security verification stopped the deletion OTP request. Complete any check in the official Swiggy app/site, or remove the account from this bot only.',
        swiggyStatus: `HTTP ${status} security challenge`,
        details: `HTTP ${status} | Swiggy security challenge`
      };
    }

    console.log(`[SwiggyDelete] [Request #${reqNum}] Response: HTTP ${status} | SwiggyCode: ${data.statusCode ?? 'none'} | Message: ${data.statusMessage || data.error || 'ok'}`);

    const isSent = status === 200 && (data.statusCode === 28 || data.statusCode === 0);

    if (!isSent) {
      if (status === 429 || /rate limit|too many|limit reached|maximum attempts/.test(responseLower)) {
        return {
          success: false,
          code: 'SWIGGY_RATE_LIMIT',
          retryable: false,
          message: 'Swiggy rate-limited the deletion OTP request. Wait 15–30 minutes and finish deletion through the official Swiggy app/site; do not retry repeatedly.',
          details: 'HTTP 429 | Swiggy rate limit'
        };
      }
      if (data.statusCode === 25) {
        return { success: false, message: 'You have pending cancellation charges on Swiggy. Please clear them first or remove from Bot DB only.' };
      }
      if (data.statusCode === 26) {
        return { success: false, message: 'An active order is in progress on this Swiggy account. Try again after delivery or remove from Bot DB only.' };
      }
      if (data.statusCode === 34) {
        return { success: false, message: 'Cannot delete on Swiggy while active Swiggy Money balance exists. Remove from Bot DB only if needed.' };
      }
      const isAuthError = status === 401 || data.statusCode === 1 || data.statusCode === 999 || /login|session expired|unauthorized/i.test(data.statusMessage || '');
      const errMsg = isAuthError
        ? 'Swiggy session has expired on Swiggy servers. Re-login or remove this account from Bot DB.'
        : (data.statusMessage || data.error || `Swiggy returned status ${status} (code ${data.statusCode ?? 'unknown'})`);
      return {
        success: false,
        isAuthError,
        message: errMsg,
        swiggyStatus: errMsg
      };
    }

    if (data.tid) cookieMap.set('tid', String(data.tid));
    if (data.sid) cookieMap.set('_sid', String(data.sid));
    let resolvedCsrf = data.csrfToken || data?.data?.csrfToken || '';
    if (!resolvedCsrf) {
      resolvedCsrf = await ensureDeleteCsrfToken(cookieMap, '', dev);
    }

    activeDeleteSessions[userId] = {
      accountKey: targetAcc,
      phone: cleanPhone,
      tid: data.tid || tidVal || '',
      token: tokVal || '',
      csrfToken: resolvedCsrf || '',
      sid: data.sid || sidVal || '',
      deviceId: data.deviceId || devVal || '',
      cookieMap,
      cookies: serializeCookieMap(cookieMap),
      deviceProfile: dev,
      createdAt: Date.now()
    };

    return {
      success: true,
      phone: cleanPhone,
      message: data.statusMessage || 'Archive OTP Sent',
      swiggyStatus: 'Swiggy Account Deletion OTP sent to ' + cleanPhone
    };
  } catch (err) {
    console.error(`[SwiggyDelete] [Request #${reqNum}] Exception calling /mapi/auth/delete/userCheck:`, err.message);
    return {
      success: false,
      message: 'Failed to contact Swiggy deletion endpoint: ' + err.message
    };
  }
}

export async function verifyAndDeleteSwiggyAccountViaBridge(userId, otp, accountKey) {
  const session = activeDeleteSessions[userId];
  const cleanOtp = String(otp).replace(/[^0-9]/g, '').trim();

  if (cleanOtp.length !== 6) {
    return { success: false, message: 'Please enter the exact 6-digit OTP.' };
  }

  const { getDb } = await import('./store.js');
  const db = getDb();
  const acc = db.config?.accounts?.[accountKey];
  const phone = normalizeIndianMobileNumber(session?.phone || acc?.phone || String(accountKey || '').replace(/^acc_/, '')) || (session?.phone || acc?.phone || '');
  const dev = session?.deviceProfile || buildAntiBotDeviceProfile(phone);

  let cookieMap = session?.cookieMap instanceof Map ? session.cookieMap : null;
  if (!cookieMap) {
    const resolved = await resolveDeleteCookieJarAndCsrf(acc, phone, accountKey, db);
    cookieMap = resolved.cookieMap;
  }

  if (cookieMap.size === 0) {
    return {
      success: false,
      message: 'Deletion session or cookies expired. Please tap Delete Account again to get a fresh OTP.'
    };
  }

  const tid = session?.tid || acc?.tid || cookieMap.get('tid') || '';
  const sid = session?.sid || acc?.sid || cookieMap.get('_sid') || '';
  const token = session?.token || acc?.token || cookieMap.get('token') || '';
  const deviceId = session?.deviceId || acc?.deviceId || cookieMap.get('_device_id') || dev.deviceId;
  if (tid && !cookieMap.has('tid')) cookieMap.set('tid', tid);
  if (sid && !cookieMap.has('_sid')) cookieMap.set('_sid', sid);

  let csrfToken = await ensureDeleteCsrfToken(cookieMap, session?.csrfToken || '', dev);

  deleteVerifyRequestCount++;
  const reqNum = deleteVerifyRequestCount;
  const maskedPhone = phone.length >= 4 ? '******' + phone.slice(-4) : '***';
  console.log(`[SwiggyDelete] [Verify #${reqNum}] Verifying Delete OTP: POST /mapi/auth/delete/user | Target: ${accountKey} | Phone: ${maskedPhone}`);

  try {
    const sendDeletePost = async (useAndroidUa = false) => {
      const r = await fetchSwiggy('https://www.swiggy.com/mapi/auth/delete/user', {
        method: 'POST',
        headers: {
          'Cookie': serializeCookieMap(cookieMap),
          'User-Agent': useAndroidUa ? 'Swiggy-Android' : dev.ua,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Origin': 'https://www.swiggy.com',
          'Referer': 'https://www.swiggy.com/my-account/settings',
          ...(tid ? { 'tid': tid } : {}),
          ...(sid ? { 'sid': sid } : {}),
          ...(token ? { 'token': token } : {}),
          ...(deviceId ? { 'deviceId': deviceId, 'swuid': deviceId } : {})
        },
        body: JSON.stringify({ otp: cleanOtp, ...(csrfToken ? { _csrf: csrfToken } : {}) }),
        signal: AbortSignal.timeout(8500)
      });
      applySetCookiesToMap(cookieMap, getResponseSetCookies(r));
      const txt = await r.text().catch(() => '');
      let j = {};
      try { j = JSON.parse(txt); } catch {}
      return { status: r.status, rawText: txt, data: j, headers: r.headers };
    };

    let delOut = await sendDeletePost(false);

    // Auto-refresh CSRF once if HTTP 403/400 was due to stale CSRF secret (NOT AWS WAF!)
    if (isCsrfMismatchResponse(delOut.status, delOut.rawText, delOut.data)) {
      cookieMap.delete('_csrf');
      csrfToken = await ensureDeleteCsrfToken(cookieMap, '', dev);
      if (session) session.csrfToken = csrfToken;
      delOut = await sendDeletePost(false);
    }

    if (isAwsWafChallengeResponse(delOut.status, delOut.rawText, delOut.headers)) {
      delOut = await sendDeletePost(true);
    }

    const { status, rawText, data: verifyResult, headers } = delOut;
    const responseLower = `${rawText} ${verifyResult?.statusMessage || verifyResult?.message || verifyResult?.error || ''}`.toLowerCase();

    if (isAwsWafChallengeResponse(status, rawText, headers)) {
      delete activeDeleteSessions[userId];
      return {
        success: false,
        code: 'SWIGGY_SECURITY_CHALLENGE',
        retryable: false,
        message: 'Swiggy security verification stopped the deletion request. Finish account deletion in the official Swiggy app/site.',
        details: `HTTP ${status} | Swiggy security challenge`
      };
    }

    console.log(`[SwiggyDelete] [Verify #${reqNum}] Response: HTTP ${status} | SwiggyCode: ${verifyResult?.statusCode ?? 'none'} | Message: ${verifyResult?.statusMessage || verifyResult?.error || 'ok'}`);

    if (status === 429 || /rate limit|too many|limit reached|maximum attempts/.test(responseLower)) {
      delete activeDeleteSessions[userId];
      return {
        success: false,
        code: 'SWIGGY_RATE_LIMIT',
        retryable: false,
        message: 'Swiggy rate-limited deletion verification. Wait 15–30 minutes and use the official Swiggy app/site; do not repeatedly resend the OTP.',
        details: 'HTTP 429 | Swiggy rate limit'
      };
    }

    if (!verifyResult || verifyResult.error) {
      return {
        success: false,
        message: verifyResult?.error || 'Failed to communicate with Swiggy servers. Please try again.'
      };
    }

    if (verifyResult.statusCode === 29 || /invalid otp|incorrect otp|wrong otp/i.test(verifyResult.statusMessage || '')) {
      return {
        success: false,
        message: verifyResult.statusMessage || 'Invalid OTP. Please check and re-enter.'
      };
    }

    if (verifyResult.statusCode === 25) {
      delete activeDeleteSessions[userId];
      return { success: false, message: 'You have pending cancellation charges. Please clear them first on Swiggy.' };
    }
    if (verifyResult.statusCode === 26) {
      delete activeDeleteSessions[userId];
      return { success: false, message: 'You have an ongoing order. Please try after delivery.' };
    }
    if (verifyResult.statusCode === 34) {
      delete activeDeleteSessions[userId];
      return { success: false, message: 'Cannot delete: active Swiggy Money wallet exists.' };
    }

    const isSuccess = status === 200 && (
      verifyResult.statusCode === 33 ||
      verifyResult.statusCode === 0 ||
      (verifyResult.statusCode === undefined && !isCsrfMismatchResponse(status, rawText, verifyResult))
    );

    if (isSuccess) {
      delete activeDeleteSessions[userId];
      return {
        success: true,
        phone,
        message: verifyResult.statusMessage || 'Account permanently deleted from Swiggy servers!'
      };
    }

    return {
      success: false,
      message: verifyResult.statusMessage || `Deletion blocked by Swiggy (Code ${verifyResult.statusCode ?? status})`
    };
  } catch (err) {
    console.error(`[SwiggyDelete] [Verify #${reqNum}] Error in delete OTP verification:`, err.message);
    return { success: false, message: err.message };
  }
}

// Hydrate verified session profile (`customerId`, JWT `tid`, `token`, `swiggyName`, `0-Order` badge) + fast offer pre-lock
async function finalizeAuthenticatedSwiggyAccount(userId, session, authResult, { wasNewSignup = false, explicitName = '' } = {}) {
  const { phone, targetAcc } = session;

  if (session.page && session.browser?.connected) {
    const pageCookies = await waitForSwiggyLoginCookies(session.page, 500);
    _mergeSwiggyBrowserCookies(session.cookieMap, pageCookies);
  }

  const resUserData = authResult?.data?.data || {};
  let tidVal = authResult?.data?.tid || session.cookieMap.get('tid') || '';
  let sidVal = authResult?.data?.sid || session.cookieMap.get('_sid') || '';
  let deviceIdVal = authResult?.data?.deviceId || session.cookieMap.get('_device_id') || session.deviceProfile?.deviceId || '';
  let tokenVal = resUserData.token || session.cookieMap.get('token') || '';
  let resolvedName = resUserData.name || '';
  let resolvedEmail = resUserData.email || session.signupEmail || '';
  let resolvedCustomerId = resUserData.customer_id || resUserData.user_id || resUserData.id || '';
  let totalOrdersCount = wasNewSignup ? 0 : undefined;

  if (tidVal) session.cookieMap.set('tid', String(tidVal));
  if (sidVal) session.cookieMap.set('_sid', String(sidVal));
  if (deviceIdVal) session.cookieMap.set('_device_id', String(deviceIdVal));
  if (tokenVal) session.cookieMap.set('token', String(tokenVal));
  session.cookieMap.set('_is_logged_in', '1');

  // Enrich real `customerId`, JWT `tid`, `token`, and `_session_tid` via fast ~160ms `/dapi/profile/info`
  try {
    const profRes = await fetchSwiggy('https://www.swiggy.com/dapi/profile/info', {
      method: 'GET',
      headers: buildAuthRequestHeaders(session, { referer: 'https://www.swiggy.com/my-account', useAndroidUa: true }),
      signal: AbortSignal.timeout(2500)
    });
    applySetCookiesToMap(session.cookieMap, getResponseSetCookies(profRes));
    const profJson = await profRes.json().catch(() => null);
    if (profJson && profJson.statusCode === 0) {
      if (profJson.tid && String(profJson.tid).includes('.')) {
        tidVal = String(profJson.tid);
        session.cookieMap.set('tid', tidVal);
      }
      if (profJson.sid) {
        sidVal = String(profJson.sid);
        session.cookieMap.set('_sid', sidVal);
      }
      if (profJson.deviceId) {
        deviceIdVal = String(profJson.deviceId);
        session.cookieMap.set('_device_id', deviceIdVal);
      }
      const d = profJson.data || {};
      if (d.customer_id) resolvedCustomerId = String(d.customer_id);
      if (d.token) {
        tokenVal = String(d.token);
        session.cookieMap.set('token', tokenVal);
      }
      if (d.name && !resolvedName) resolvedName = String(d.name);
      if (d.email && !resolvedEmail) resolvedEmail = String(d.email);
    }
  } catch {}

  const jwtClaims = tidVal ? decodeJwtPayload(tidVal) : null;
  if (!resolvedCustomerId && jwtClaims?.user_id && String(jwtClaims.user_id) !== '0' && String(jwtClaims.user_id) !== '-1') {
    resolvedCustomerId = String(jwtClaims.user_id);
  }
  const customerId = resolvedCustomerId ? String(resolvedCustomerId) : '';

  // For existing accounts, do a quick ~250ms order-history peek so Vault immediately tags `0-Order` vs `Used`
  if (totalOrdersCount === undefined && session.cookieMap.has('_session_tid')) {
    try {
      const ordRes = await fetchSwiggy('https://www.swiggy.com/dapi/order/all', {
        method: 'GET',
        headers: buildAuthRequestHeaders(session, { referer: 'https://www.swiggy.com/my-account', useAndroidUa: true }),
        signal: AbortSignal.timeout(2200)
      });
      applySetCookiesToMap(session.cookieMap, getResponseSetCookies(ordRes));
      const ordJson = await ordRes.json().catch(() => null);
      if (ordJson && ordJson.statusCode === 0) {
        if (!tidVal && ordJson.tid && String(ordJson.tid).includes('.')) {
          tidVal = String(ordJson.tid);
          session.cookieMap.set('tid', tidVal);
        }
        const ordersArr = Array.isArray(ordJson?.data?.orders) ? ordJson.data.orders : null;
        if (ordersArr) {
          totalOrdersCount = ordersArr.length;
        }
      }
    } catch {}
  }

  const requestedAccountLabel = String(explicitName || session.targetAccName || '').trim();
  const cleanActual = String(resolvedName || session.signupName || '').replace(/\([^)]*\)/g, '').trim();
  const accKey = targetAcc || `acc_${phone}`;

  // Fresh/new-signup record kabhi email ke bina save na ho. Existing login
  // par Swiggy/profile ka email mile to wahi rakho; fresh signup par
  // requested first-five email fallback bhi hamesha available hai.
  const finalEmail = String(resolvedEmail || '').trim()
    || (wasNewSignup ? generateFreshSwiggyEmail(phone) : '');
  session.signupEmail = finalEmail || session.signupEmail || '';
  const generatedAddressDetails = wasNewSignup
    ? (session.generatedAddressDetails?.state === 'Maharashtra'
      ? session.generatedAddressDetails
      : generateRandomSwiggyAddress(phone, cleanActual || session.signupName || 'Rahul Kumar'))
    : null;
  if (generatedAddressDetails) session.generatedAddressDetails = generatedAddressDetails;

  // User ka rule: generated address ko local JSON me likh dena kaafi nahi.
  // Pehle asal Swiggy Add Address page par jaakar SAVE karo; pakka
  // addressId verify ho tabhi woh address saved/export hoga. Fail ho to
  // fresh JSON me koi fake address nahi jayega — sirf FAILED status.
  // Ye await auto-label se PEHLE hai taaki parallel finalizes duplicate
  // "User N" na uthayein.
  let remoteAddressResult = null;
  let verifiedAddressDetails = null;
  if (generatedAddressDetails) {
    try {
      await session.progressReporter?.(section('🏠 Address Add Ho Raha Hai', 'Swiggy Add Address page par Maharashtra address save + verify ho raha hai'));
    } catch {}
    try {
      remoteAddressResult = await addSwiggyAddressToAccount(
        session,
        generatedAddressDetails,
        {
          customerId,
          timeoutMs: 38_000,
          shouldAbort: () => _swiggyBridgeSessionAbortRequested(session),
        }
      );
      generatedAddressDetails.remoteAddressStatus = remoteAddressResult.ok ? 'added' : 'failed';
      if (remoteAddressResult.addressId) generatedAddressDetails.remoteAddressId = remoteAddressResult.addressId;
      if (remoteAddressResult.message) generatedAddressDetails.remoteAddressMessage = sanitizeSwiggyAddressFailureMessage(remoteAddressResult.message);
      if (remoteAddressResult.ok && remoteAddressResult.addressId) {
        verifiedAddressDetails = remoteAddressResult.verifiedAddress?.remoteAddressId
          ? remoteAddressResult.verifiedAddress
          : normalizeVerifiedSwiggyAddress({ id: remoteAddressResult.addressId }, generatedAddressDetails);
      }
      console.log(`[SwiggyBridge] Fresh account Maharashtra address remote ${remoteAddressResult.ok ? `added (id ${remoteAddressResult.addressId}, ${remoteAddressResult.method || 'verified'})` : `failed: ${remoteAddressResult.message || remoteAddressResult.status}`}`);
    } catch (e) {
      generatedAddressDetails.remoteAddressStatus = 'failed';
      generatedAddressDetails.remoteAddressMessage = sanitizeSwiggyAddressFailureMessage(e?.message || e);
      remoteAddressResult = { ok: false, addressId: '', message: generatedAddressDetails.remoteAddressMessage };
      console.warn('[SwiggyBridge] Remote address add failed:', generatedAddressDetails.remoteAddressMessage);
    }
  }
  const verifiedAddress = verifiedAddressDetails ? formatSwiggyAddress(verifiedAddressDetails) : '';
  const remoteAddressStatus = generatedAddressDetails
    ? (verifiedAddressDetails ? 'added' : 'failed')
    : '';
  const remoteAddressMessage = generatedAddressDetails
    ? sanitizeSwiggyAddressFailureMessage(remoteAddressResult?.message || generatedAddressDetails.remoteAddressMessage || '', '')
    : '';

  // Owner ne isi number ko SKIP kar diya hai to account ko fresh count /
  // instant JSON ke liye persist mat karo. Remote account ban chuka ho
  // sakta hai, lekin is run ke liye ye number yahin khatam hai.
  if (_swiggyBridgeSessionAbortRequested(session) || remoteAddressResult?.aborted) {
    closeBridgeSessionCleanly(session);
    delete activeSessions[userId];
    return {
      success: false,
      code: 'ABORTED',
      aborted: true,
      manualSkip: true,
      message: 'Owner ne current number SKIP kar diya',
      swiggyStatus: 'manual_skip',
    };
  }

  // Exported JSON 2–3 ghante me dobara na maangna pade: web/DAPI login ka
  // short JWT save karne se pehle Android chkout se rotate karne ki koshish
  // karo. Sirf wahi candidate accept hoga jo isi customer ka, non-guest aur
  // current JWT se zyada life wala ho. Fail ho to asal authenticated
  // session phir bhi save hoga — fake long-life claim nahi banega.
  let sessionRefreshResult = null;
  try {
    const tidBeforeRotate = String(tidVal || '');
    sessionRefreshResult = await refreshSwiggySessionCredentials({
      phone,
      customerId,
      tid: tidVal,
      jwtTid: tidVal,
      token: tokenVal,
      sid: sidVal,
      deviceId: deviceIdVal,
      _session_tid: session.cookieMap.get('_session_tid') || '',
      cookieMap: session.cookieMap,
      deviceProfile: session.deviceProfile,
    }, {
      timeoutMs: 5_000,
      allowDapiFallback: false,
    });
    if (sessionRefreshResult?.ok) {
      if (sessionRefreshResult.tid) {
        tidVal = String(sessionRefreshResult.tid);
        session.cookieMap.set('tid', tidVal);
      }
      if (sessionRefreshResult._session_tid) {
        session.cookieMap.set('_session_tid', String(sessionRefreshResult._session_tid));
      }
      if (sessionRefreshResult.sid) {
        sidVal = String(sessionRefreshResult.sid);
        session.cookieMap.set('_sid', sidVal);
      }
      if (sessionRefreshResult.deviceId) {
        deviceIdVal = String(sessionRefreshResult.deviceId);
        session.cookieMap.set('_device_id', deviceIdVal);
      }
      if (sessionRefreshResult.token && (!tokenVal || tokenVal === tidBeforeRotate || sessionRefreshResult.token !== tokenVal)) {
        tokenVal = String(sessionRefreshResult.token);
        session.cookieMap.set('token', tokenVal);
      }
    }
  } catch {}

  // Cookies address attempt + JWT rotation ke BAAD serialize karo — Add
  // Address page / saved-list verification / chkout se nayi values aayein
  // to woh purani fullCookieStr me reh nahi jayengi.
  const serializeFinalCookies = () => cleanEssentialSwiggyCookies(serializeCookieMap(session.cookieMap), {
    tid: tidVal,
    sid: sidVal,
    deviceId: deviceIdVal,
    token: tokenVal,
    _session_tid: session.cookieMap.get('_session_tid') || '',
  });
  let fullCookieStr = serializeFinalCookies();

  // Fast sub-second Today+Tomorrow offer pre-lock (bounded at 2.4s max so OTP verification NEVER stalls!)
  let offersResult = { success: false, pendingBackgroundLock: true };
  const offerAccount = {
    id: accKey,
    phone,
    customerId,
    token: tokenVal || tidVal,
    tid: tidVal,
    jwtTid: String(tidVal || '').includes('.') ? tidVal : '',
    sid: sidVal,
    deviceId: deviceIdVal,
    cookies: fullCookieStr
  };
  try {
    offersResult = await Promise.race([
      claimSwiggyBreakfastAndLateNightOffers(offerAccount, { quickLockOnly: true }),
      new Promise(resolve => setTimeout(() => resolve({ success: false, pendingBackgroundLock: true }), 2400))
    ]);
  } catch {}

  // Offer pre-lock ke andar chkout/DAPI se aur lambi-life wala JWT mil
  // gaya ho to use bhi save/export me le lo. Pehle ye rotation sirf ek
  // throwaway object par hoti thi aur JSON purana short `tid` bhej deta tha.
  const offerRotatedTid = String(offerAccount.jwtTid || offerAccount.tid || '');
  if (offerRotatedTid && offerRotatedTid !== tidVal) {
    const currentInfo = getSwiggyJwtSessionInfo(tidVal);
    const offerInfo = getSwiggyJwtSessionInfo(offerRotatedTid);
    const sameCustomer = !customerId || !offerInfo.customerId || offerInfo.customerId === customerId;
    if (sameCustomer && offerInfo.customerId && !offerInfo.isExpired
      && (offerInfo.expiresAtMs || 0) > (currentInfo.expiresAtMs || 0)) {
      tidVal = offerRotatedTid;
      session.cookieMap.set('tid', tidVal);
      if (!tokenVal || tokenVal === currentInfo.tid) tokenVal = tidVal;
      fullCookieStr = serializeFinalCookies();
      sessionRefreshResult = {
        ...(sessionRefreshResult || {}),
        ok: true,
        refreshed: true,
        tid: tidVal,
        expiresAtMs: offerInfo.expiresAtMs,
        remainingMs: offerInfo.remainingMs,
        longLived: offerInfo.isLongLived,
      };
    }
  }

  // Offers wale chhote await ke dauran bhi SKIP aa sakta hai. DB save se
  // just pehle ye last check skipped account ko persist/export hone se
  // rokta hai.
  if (_swiggyBridgeSessionAbortRequested(session)) {
    closeBridgeSessionCleanly(session);
    delete activeSessions[userId];
    return {
      success: false,
      code: 'ABORTED',
      aborted: true,
      manualSkip: true,
      message: 'Owner ne current number SKIP kar diya',
      swiggyStatus: 'manual_skip',
    };
  }

  // Auto label saare awaits ke BAAD lo. Parallel lanes me do finalizes ek
  // saath aayein to dono await se pehle same "User N" nahi uthayengi;
  // yahan se updateAccount tak koi await nahi hai.
  const rawSlot = requestedAccountLabel && !/^user\s*\d+$/i.test(requestedAccountLabel)
    ? requestedAccountLabel
    : getNextAutoUserName();
  const finalName = rawSlot || cleanActual || getNextAutoUserName();
  const finalJwtInfo = getSwiggyJwtSessionInfo(tidVal);
  const sessionTidMatch = fullCookieStr.match(/(?:^|;\s*)_session_tid=([^;]+)/);
  const sessionTidVal = String(session.cookieMap.get('_session_tid') || sessionTidMatch?.[1] || '').trim();
  const jwtTidVal = finalJwtInfo.tid || '';
  const tidExpiresAt = finalJwtInfo.expiresAtMs ? new Date(finalJwtInfo.expiresAtMs).toISOString() : '';
  const sessionLongLived = Boolean(finalJwtInfo.isLongLived);
  const sessionRefreshedAt = new Date().toISOString();

  const savedData = {
    name: finalName,
    swiggyName: cleanActual || '',
    botTag: rawSlot,
    email: finalEmail,
    ...(generatedAddressDetails ? (verifiedAddressDetails ? {
      address: verifiedAddress,
      addressDetails: verifiedAddressDetails,
      deliveryAddress: verifiedAddressDetails,
      remoteAddressStatus,
      remoteAddressId: verifiedAddressDetails.remoteAddressId,
      ...(remoteAddressMessage ? { remoteAddressMessage } : {}),
    } : {
      // Purane account slot me koi stale/local address chipka ho to use bhi
      // saaf karo — unverified generated data dobara export nahi hoga.
      address: '',
      addressDetails: null,
      deliveryAddress: null,
      remoteAddressStatus,
      remoteAddressId: '',
      ...(remoteAddressMessage ? { remoteAddressMessage } : {}),
    }) : {}),
    phone,
    mobile: phone,
    customerId,
    ...(sessionTidVal ? { _session_tid: sessionTidVal } : {}),
    ...(jwtTidVal ? { jwtTid: jwtTidVal } : {}),
    tid: tidVal || '',
    sid: sidVal || '',
    deviceId: deviceIdVal || '',
    token: tokenVal || tidVal || '',
    ...(tidExpiresAt ? { tidExpiresAt } : {}),
    sessionLongLived,
    sessionRefreshedAt,
    ...(typeof totalOrdersCount === 'number' ? {
      totalOrdersCount,
      isZeroOrderAccount: totalOrdersCount === 0
    } : {}),
    isLoggedIn: true,
    cookies: fullCookieStr,
    offers: offersResult,
    savedAt: new Date().toISOString()
  };

  const persisted = updateAccount(accKey, savedData);
  const finalSavedKey = persisted?.id || accKey;

  closeBridgeSessionCleanly(session);
  delete activeSessions[userId];

  const exportJson = {
    account: finalSavedKey,
    name: finalName,
    swiggyName: cleanActual || '',
    botTag: rawSlot,
    email: finalEmail,
    ...(generatedAddressDetails ? {
      remoteAddressStatus,
      ...(remoteAddressMessage ? { remoteAddressMessage } : {}),
      ...(verifiedAddressDetails ? {
        address: verifiedAddress,
        addressDetails: verifiedAddressDetails,
        remoteAddressId: verifiedAddressDetails.remoteAddressId,
      } : {}),
    } : {}),
    mobile: phone,
    phone,
    customerId,
    ...(sessionTidVal ? { _session_tid: sessionTidVal } : {}),
    ...(jwtTidVal ? { jwtTid: jwtTidVal } : {}),
    token: savedData.token,
    tid: savedData.tid,
    sid: savedData.sid,
    deviceId: savedData.deviceId,
    ...(tidExpiresAt ? { tidExpiresAt } : {}),
    sessionLongLived,
    sessionRefreshedAt,
    cookies: fullCookieStr,
    savedAt: savedData.savedAt
  };

  return {
    success: true,
    isNewUser: false,
    wasNewSignup,
    name: finalName,
    swiggyName: cleanActual || '',
    botTag: rawSlot,
    email: finalEmail,
    ...(generatedAddressDetails ? {
      remoteAddressStatus,
      ...(remoteAddressMessage ? { remoteAddressMessage } : {}),
      ...(verifiedAddressDetails ? {
        address: verifiedAddress,
        addressDetails: verifiedAddressDetails,
        remoteAddressId: verifiedAddressDetails.remoteAddressId,
      } : {}),
    } : {}),
    accountKey: finalSavedKey,
    phone,
    customerId: customerId || 'Verified',
    ...(tidExpiresAt ? { tidExpiresAt } : {}),
    sessionLongLived,
    sessionRefreshed: Boolean(sessionRefreshResult?.refreshed),
    totalOrdersCount,
    isZeroOrderAccount: totalOrdersCount === 0,
    offers: offersResult,
    exportJson,
    message: authResult?.data?.statusMessage || (wasNewSignup ? 'Swiggy account created and logged in successfully!' : 'done successfully'),
    swiggyStatus: authResult?.data?.statusMessage || 'done successfully'
  };
}

export async function verifySwiggyOtpViaBridge(userId, otp) {
  const session = activeSessions[userId];
  if (!session) {
    return { success: false, message: 'Session expired. Please enter phone number again.' };
  }

  const cleanOtp = String(otp).replace(/[^0-9]/g, '').trim();
  if (cleanOtp.length !== 6) {
    return { success: false, message: 'Please enter the exact 6-digit OTP.' };
  }

  // Always persist `session.otp` immediately so follow-up `signupSwiggyViaBridge` NEVER fails with missing OTP!
  session.otp = cleanOtp;
  const { phone } = session;

  try {
    let verifyResult = null;
    let statusCode = null;
    let statusMsg = '';
    let isSuccess = false;
    let usedSignupCompletion = false;

    // Try standard `otp-verify` whenever existing user OR when `signup` pre-registered the mobile in Step 1!
    if (!session.isNewUser || session.signupPreRegistered) {
      verifyResult = await postSwiggyAuthJson(session, 'https://www.swiggy.com/dapi/auth/otp-verify', {
        mobile: phone,
        otp: cleanOtp
      });

      statusCode = verifyResult?.data?.statusCode;
      statusMsg = String(verifyResult?.data?.statusMessage || verifyResult?.data?.message || '').trim();
      isSuccess = (verifyResult?.status === 200 || verifyResult?.status === 202) && statusCode === 0;

      const verifyLower = `${verifyResult?.rawText || ''} ${statusMsg}`.toLowerCase();
      const verificationBlocked = isAwsWafChallengeResponse(verifyResult?.status, verifyResult?.rawText, verifyResult?.headers);
      const verificationRateLimited = verifyResult?.status === 429 || /rate limit|too many|limit reached|maximum attempts/.test(verifyLower);

      if (verificationBlocked || verificationRateLimited) {
        closeBridgeSessionCleanly(session);
        delete activeSessions[userId];
        const diagnostic = parseSwiggyOtpError(verifyResult);
        return {
          success: false,
          code: diagnostic.code,
          retryable: false,
          swiggyStatus: diagnostic.swiggyStatus,
          message: diagnostic.message
        };
      }
    }

    const msgLower = statusMsg.toLowerCase();
    const isExplicitWrongOtp = /invalid otp|incorrect otp|wrong otp|otp expired|expired otp|enter valid otp/.test(msgLower);
    const needsNewSignupCompletion = !isSuccess && !isExplicitWrongOtp && (
      session.isNewUser ||
      isUnregisteredSwiggyAuthResponse(verifyResult) ||
      msgLower.includes('invalid mobile number')
    );

    if (!isSuccess && statusCode === 1 && !needsNewSignupCompletion) {
      if (session.safetyTimer) clearTimeout(session.safetyTimer);
      session.safetyTimer = setTimeout(() => {
        if (activeSessions[userId] === session) {
          closeBridgeSessionCleanly(session);
          delete activeSessions[userId];
        }
      }, 300_000);

      return {
        success: false,
        swiggyStatus: statusMsg || 'Galat OTP (Invalid OTP)',
        message: statusMsg || 'Galat OTP enter kiya hai. Kripya check karke dubara daalein.'
      };
    }

    if (needsNewSignupCompletion) {
      const signupName = session.signupName || sanitizeSwiggyName(session.targetAccName);
      let signupEmail = session.signupEmail || generateUniqueSwiggyEmail(phone, signupName);
      session.signupName = signupName;
      session.signupEmail = signupEmail;
      console.log(`[SwiggyBridge] Completing fresh Swiggy signup for ${phone} as "${signupName}" (${signupEmail})...`);

      let signupResult = await postSwiggyAuthJson(session, 'https://www.swiggy.com/dapi/auth/signup', {
        mobile: phone,
        otp: cleanOtp,
        name: signupName,
        email: signupEmail,
        password: '',
        referral_code: ''
      });

      const sLower = `${signupResult?.data?.statusMessage || ''} ${signupResult?.data?.message || ''} ${signupResult?.rawText || ''}`.toLowerCase();
      if (signupResult?.status === 200 && signupResult?.data?.statusCode !== 0 && /email.*exist|email.*already|duplicate.*email/i.test(sLower)) {
        signupEmail = generateFreshSwiggyEmail(phone, { attempt: 1 });
        session.signupEmail = signupEmail;
        signupResult = await postSwiggyAuthJson(session, 'https://www.swiggy.com/dapi/auth/signup', {
          mobile: phone,
          otp: cleanOtp,
          name: signupName,
          email: signupEmail,
          password: '',
          referral_code: ''
        }, { allowBrowserEscalation: false });
      }

      if (signupResult?.status === 200 && (signupResult?.data?.statusCode === 0 || signupResult?.data?.statusCode === undefined)) {
        verifyResult = signupResult;
        statusCode = 0;
        statusMsg = signupResult?.data?.statusMessage || 'done successfully';
        isSuccess = true;
        usedSignupCompletion = true;
      } else {
        const errMessage = signupResult?.data?.statusMessage || signupResult?.error || 'Invalid or expired Signup OTP';
        const diagnostic = signupResult ? parseSwiggyOtpError(signupResult) : null;
        if (diagnostic && ['SWIGGY_SECURITY_CHALLENGE', 'SWIGGY_RATE_LIMIT'].includes(diagnostic.code)) {
          closeBridgeSessionCleanly(session);
          delete activeSessions[userId];
          return {
            success: false,
            code: diagnostic.code,
            retryable: false,
            swiggyStatus: diagnostic.swiggyStatus,
            message: diagnostic.message
          };
        }
        return {
          success: false,
          swiggyStatus: errMessage,
          message: errMessage
        };
      }
    }

    const cookieCheckStr = serializeCookieMap(session.cookieMap);
    const isReallyLoggedIn = checkLoggedInFromCookies(cookieCheckStr);

    if (!isSuccess && !isReallyLoggedIn) {
      if (session.safetyTimer) clearTimeout(session.safetyTimer);
      session.safetyTimer = setTimeout(() => {
        if (activeSessions[userId] === session) {
          closeBridgeSessionCleanly(session);
          delete activeSessions[userId];
        }
      }, 300_000);

      const errReason = statusMsg || verifyResult?.error || (verifyResult?.status === 429 ? 'Maximum OTP verification attempts exceeded' : 'Invalid or expired OTP');
      return {
        success: false,
        swiggyStatus: errReason,
        message: errReason
      };
    }

    return await finalizeAuthenticatedSwiggyAccount(userId, session, verifyResult, {
      wasNewSignup: Boolean(session.isNewUser || usedSignupCompletion)
    });
  } catch (err) {
    return {
      success: false,
      isNewUser: false,
      swiggyStatus: err.message,
      message: `System Error: ${err.message}`
    };
  }
}

export async function signupSwiggyViaBridge(userId, enteredName, enteredEmail = null) {
  const session = activeSessions[userId];
  if (!session || !session.otp) {
    return { success: false, message: 'Session expired. Please enter phone number again.' };
  }

  const { phone, otp } = session;
  const cleanName = sanitizeSwiggyName(enteredName || session.targetAccName);
  const accountLabel = String(session.targetAccName || enteredName || cleanName).trim() || cleanName;
  let signupEmail = (enteredEmail && String(enteredEmail).includes('@'))
    ? String(enteredEmail).trim()
    : (session.signupEmail || generateUniqueSwiggyEmail(phone, cleanName));

  try {
    let signupResult = await postSwiggyAuthJson(session, 'https://www.swiggy.com/dapi/auth/signup', {
      mobile: phone,
      otp,
      name: cleanName,
      email: signupEmail,
      password: '',
      referral_code: ''
    });

    const sLower = `${signupResult?.data?.statusMessage || ''} ${signupResult?.data?.message || ''} ${signupResult?.rawText || ''}`.toLowerCase();
    if (!enteredEmail && signupResult?.status === 200 && signupResult?.data?.statusCode !== 0 && /email.*exist|email.*already|duplicate.*email/i.test(sLower)) {
      signupEmail = generateFreshSwiggyEmail(phone, { attempt: 1 });
      session.signupEmail = signupEmail;
      signupResult = await postSwiggyAuthJson(session, 'https://www.swiggy.com/dapi/auth/signup', {
        mobile: phone,
        otp,
        name: cleanName,
        email: signupEmail,
        password: '',
        referral_code: ''
      }, { allowBrowserEscalation: false });
    }

    const isReallyLoggedIn = checkLoggedInFromCookies(serializeCookieMap(session.cookieMap));

    if (
      isReallyLoggedIn ||
      (signupResult?.status === 200 && (signupResult?.data?.statusCode === 0 || signupResult?.data?.statusCode === undefined))
    ) {
      session.signupEmail = signupEmail;
      session.signupName = cleanName;
      return await finalizeAuthenticatedSwiggyAccount(userId, session, signupResult, {
        wasNewSignup: true,
        explicitName: accountLabel
      });
    }

    const errorMsg =
      signupResult?.data?.statusMessage ||
      signupResult?.error ||
      'Failed to signup on Swiggy';
    const diagnostic = parseSwiggyOtpError(signupResult || {});
    if (['SWIGGY_SECURITY_CHALLENGE', 'SWIGGY_RATE_LIMIT'].includes(diagnostic.code)) {
      closeBridgeSessionCleanly(session);
      delete activeSessions[userId];
      return {
        success: false,
        code: diagnostic.code,
        retryable: false,
        message: diagnostic.message,
        swiggyStatus: diagnostic.swiggyStatus
      };
    }
    return { success: false, message: errorMsg };
  } catch (err) {
    const diagnostic = parseSwiggyOtpError({
      status: /429|rate limit|too many/i.test(err.message || '') ? 429 : (/waf|captcha|challenge/i.test(err.message || '') ? 403 : 500),
      error: err.message,
      data: { statusMessage: err.message }
    });
    if (['SWIGGY_SECURITY_CHALLENGE', 'SWIGGY_RATE_LIMIT'].includes(diagnostic.code)) {
      closeBridgeSessionCleanly(session);
      delete activeSessions[userId];
      return { success: false, code: diagnostic.code, retryable: false, message: diagnostic.message };
    }
    return { success: false, code: diagnostic.code, retryable: diagnostic.retryable, message: err.message };
  }
}

// Closes any open session for `targetAcc` cleanly without clobbering an unrelated in-flight login session!
export async function deactivateSwiggyAccountViaBridge(userId, targetAcc, revokeRemote = false) {
  const session = activeSessions[userId];
  if (session && (!targetAcc || session.targetAcc === targetAcc || `acc_${session.phone}` === targetAcc)) {
    closeBridgeSessionCleanly(session);
    delete activeSessions[userId];
  }
  const delSession = activeDeleteSessions[userId];
  if (delSession && (!targetAcc || delSession.accountKey === targetAcc || `acc_${delSession.phone}` === targetAcc)) {
    delete activeDeleteSessions[userId];
  }

  if (revokeRemote) {
    await logoutSwiggySessionRemote(targetAcc).catch(() => null);
  }

  return true;
}

/**
 * Real Swiggy logout. This is NOT a local tombstone: it revokes the session on
 * Swiggy's side, then verifies with an authenticated `order/all` call.
 *
 * Returns `{ ok, status, revoked, httpStatus, attempts, message }` where status is
 * one of:
 *   - `REVOKED`          Swiggy no longer accepts the session (or had none)
 *   - `STILL_LOGGED_IN`  Swiggy still returns an authenticated order list
 *   - `INCONCLUSIVE`     network/WAF failure — caller must not claim logout
 */
export async function logoutSwiggySessionRemote(accountOrKey) {
  let acc = null;
  let key = '';
  try {
    const { getDb } = await import('./store.js');
    const db = getDb();
    key = typeof accountOrKey === 'string' ? accountOrKey : '';
    acc = (accountOrKey && typeof accountOrKey === 'object')
      ? accountOrKey
      : (db.config?.accounts?.[key] || db.sessionVault?.[key] || null);
    if (!acc && key) {
      const phone = String(key).replace(/^acc_/, '').slice(-10);
      acc = db.sessionVault?.[phone] || null;
    }
  } catch {
    acc = (accountOrKey && typeof accountOrKey === 'object') ? accountOrKey : null;
  }

  const source = acc || {};
  const cleanCk = stripStaleWafCookie(source.cookies || '');
  const tid = String(source.tid || '').trim();
  const token = String(source.token || '').trim();
  const sid = String(source.sid || '').trim();
  const deviceId = String(source.deviceId || source._device_id || '').trim();

  if (!cleanCk && !tid && !token) {
    return { ok: true, status: 'REVOKED', revoked: true, httpStatus: 0, attempts: [], message: 'No remote session material to revoke' };
  }

  const cookieMap = new Map();
  if (cleanCk) {
    for (const part of cleanCk.split(';')) {
      const t = part.trim();
      const eq = t.indexOf('=');
      if (eq > 0) cookieMap.set(t.slice(0, eq).trim(), t.slice(eq + 1).trim());
    }
  }

  // `order/all` is a *web* endpoint: it authenticates with `_session_tid` cookies.
  // A token-only account (Android `tid`/`token` imported from another bot, no
  // cookies) gets a 401 there even while its Android token is perfectly alive.
  // Bootstrap a web session from those tokens first; if that is impossible the
  // verification is not trustworthy and we must fail closed instead of claiming
  // a revocation we cannot prove.
  let webSessionEstablished = Boolean(cookieMap.get('_session_tid'));
  if (!webSessionEstablished && (tid || token)) {
    try {
      const bootstrap = await loadAndroidBootstrap();
      const minted = bootstrap ? await bootstrap(source) : null;
      if (minted && /(?:^|;\s*)_session_tid=/.test(minted)) {
        for (const part of String(minted).split(';')) {
          const t = part.trim();
          const eq = t.indexOf('=');
          if (eq > 0) cookieMap.set(t.slice(0, eq).trim(), t.slice(eq + 1).trim());
        }
        webSessionEstablished = Boolean(cookieMap.get('_session_tid'));
      }
    } catch {}
  }

  const phone = String(source.phone || source.mobile || key.replace(/^acc_/, '') || '').replace(/[^0-9]/g, '').slice(-10);
  const deviceProfile = buildAntiBotDeviceProfile(phone);
  const baseHeaders = () => ({
    'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://www.swiggy.com',
    'Referer': 'https://www.swiggy.com/my-account',
    'Cookie': serializeCookieMap(cookieMap),
    ...(tid ? { tid } : {}),
    ...(sid ? { sid } : {}),
    ...(token ? { token } : {}),
    ...(deviceId ? { deviceId, swuid: deviceId } : {})
  });
 
  let csrf = '';
  try {
    csrf = await ensureDeleteCsrfToken(cookieMap, '', deviceProfile);
  } catch {}

  const attempts = [];
  const attemptLogout = async (transport = 'mweb') => {
    const androidUa = transport === 'android';
    const res = await fetchSwiggy('https://www.swiggy.com/dapi/auth/logout', {
      method: 'POST',
      headers: {
        ...baseHeaders(),
        'Content-Type': 'application/json',
        'User-Agent': androidUa ? 'Swiggy-Android' : deviceProfile.ua,
        ...(csrf ? { 'X-CSRF-Token': csrf } : {})
      },
      body: JSON.stringify(csrf ? { _csrf: csrf } : {}),
      signal: AbortSignal.timeout(8000)
    });
    applySetCookiesToMap(cookieMap, getResponseSetCookies(res));
    const rawText = await res.text().catch(() => '');
    let json = {};
    try { json = JSON.parse(rawText); } catch {}
    const statusCode = Number(json?.statusCode);
    const message = String(json?.statusMessage || json?.message || '');
    const revokedByResponse =
      res.status === 401 || res.status === 403 ||
      statusCode === 1 || statusCode === -1 ||
      /unauthor|not\s*logged|logged\s*out|session.*(?:expired|invalid)|invalid.*(?:token|session)/i.test(message);
    // Swiggy DAPI's own success shape. This is the only proof available when a
    // web session could not be established and order/all is unauthenticated.
    const explicitLogout = res.ok && statusCode === 0;
    attempts.push({ transport, httpStatus: res.status, statusCode: Number.isFinite(statusCode) ? statusCode : null, revokedByResponse, explicitLogout });
    return { res, json, rawText, statusCode, revokedByResponse, explicitLogout };
  };

  const verify = async () => {
    try {
      const res = await fetchSwiggy('https://www.swiggy.com/dapi/order/all', {
        method: 'GET',
        headers: {
          ...baseHeaders(),
          'User-Agent': deviceProfile.ua
        },
        signal: AbortSignal.timeout(8000)
      });
      const rawText = await res.text().catch(() => '');
      let json = {};
      try { json = JSON.parse(rawText); } catch {}
      const statusCode = Number(json?.statusCode);
      if (res.status === 401 || res.status === 403) return 'REVOKED';
      if (statusCode === 1 || statusCode === -1) return 'REVOKED';
      if (/unauthor|not\s*logged|logged\s*out|session.*(?:expired|invalid)|invalid.*(?:token|session)/i.test(String(json?.statusMessage || json?.message || ''))) {
        return 'REVOKED';
      }
      if (res.ok && statusCode === 0) return 'STILL_LOGGED_IN';
      return 'INCONCLUSIVE';
    } catch {
      return 'INCONCLUSIVE';
    }
  };

  let httpStatus = 0;
  let lastMessage = '';
  let explicitLogoutConfirmed = false;
  try {
    // Baseline: prove Swiggy actually accepts this session BEFORE revoking it.
    // Otherwise a 401 caused by missing/expired cookies is indistinguishable
    // from a successful revocation, and the account could be purged while its
    // Android token is still alive.
    const preStatus = await verify();

    const first = await attemptLogout('mweb');
    httpStatus = first.res.status;
    lastMessage = String(first.json?.statusMessage || first.json?.message || '');
    explicitLogoutConfirmed = Boolean(first.explicitLogout);
    let status = await verify();
    if (status === 'STILL_LOGGED_IN') {
      // Some sessions only accept the mobile transport. Retry once before failing.
      const second = await attemptLogout('android');
      httpStatus = second.res.status || httpStatus;
      lastMessage = String(second.json?.statusMessage || second.json?.message || lastMessage);
      explicitLogoutConfirmed = explicitLogoutConfirmed || Boolean(second.explicitLogout);
      status = await verify();
    }
    if (status === 'REVOKED') {
      // Verified only if the session was live before the POST (pre -> post
      // transition), or Swiggy explicitly acknowledged the logout on an
      // already-unauthenticated session.
      if (preStatus === 'STILL_LOGGED_IN' || (preStatus === 'REVOKED' && explicitLogoutConfirmed)) {
        return { ok: true, status, revoked: true, httpStatus, attempts, message: lastMessage || 'Session revoked by Swiggy' };
      }
      return {
        ok: false,
        status: 'INCONCLUSIVE',
        revoked: false,
        httpStatus,
        attempts,
        message: lastMessage || 'Session could not be verified as live before logout'
      };
    }
    if (status === 'STILL_LOGGED_IN') {
      return { ok: false, status, revoked: false, httpStatus, attempts, message: lastMessage || 'Swiggy still accepts the session' };
    }
    return { ok: false, status: 'INCONCLUSIVE', revoked: false, httpStatus, attempts, message: lastMessage || 'Could not verify remote logout' };
  } catch (e) {
    return { ok: false, status: 'INCONCLUSIVE', revoked: false, httpStatus, attempts, message: e?.message || 'Logout request failed' };
  }
}
