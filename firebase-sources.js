// ===== 🔥 FIREBASE SOURCES — dynamic, bot UI se manage =====
//
// User ka rule: ek saath multiple Firebase databases add karo, aur jo
// bhi source list me hai woh HAMESHA ACTIVE rahega — disable/switch-off
// ka koi scene nahi. Source sirf Delete karne par hatega.
//
// Storage: data/db.json → db.firebaseSources = { activeId, list: [...] }
//   source = { id, name, url, auth?, clientsPath?, messagesPath?,
//              numbersPath?, smsPath?, otpPath?, enabled, addedAt }
//
// `enabled` field purani DB compatibility ke liye rakha hai, lekin ab
// hamesha true normalize hota hai. `activeId` bhi sirf internal
// first-try/reader order ke liye hai — iska matlab ye nahi ke baaki
// sources inactive hain; listRunSources() har saved source ko batch ke
// ACTIVE pool me rakhta hai.
//
// Default: agar list khali hai to env FIREBASE_DB_URL (ya vuvhbjbi default)
// se ek "Default" source seed hota hai — pehla run bina setup ke chalta hai.
//
// PERMANENT (2026-11-07): owner ki poori ROLEX VIP list ab code me hai
// (firebase-seed-urls.js) aur env `FIREBASE_DB_URLS` se bhi feed ho sakti
// hai. Free Render par data/db.json restart me mit jata hai, isliye:
//   • boot par hi list seed hoti hai (env/file dono se independent), aur
//   • sources + settings cloud vault me bhi jaate hain (store.js).
// Ek baar kisi source ko Delete kiya to wo `state.deleted` me yaad rehta
// hai aur seeding use dobara wapas nahi laati.
//
// applyActiveSource() — first-try source ko reader (firebase-numbers.js)
// par set karta hai; batch/start se PEHLE aur ADD ke baad call hota hai.

import crypto from 'crypto';
import { getDb, saveDb } from './store.js';
import * as storeVault from './store.js';
import {
  setFirebaseSource,
  setFirebaseDisabled,
  isFirebaseDisabled,
  _firebaseErrorMessage,
} from './firebase-numbers.js';
import { OWNER_FIREBASE_URLS } from './firebase-seed-urls.js';

const DEFAULT_URL = 'https://vuvhbjbi-default-rtdb.firebaseio.com/';
// Ek message me itni URLs add ho sakti hain. Pehle 200 thi — owner ki list
// 400+ ki hai, isliye 1000. Dedupe phir bhi hota hai.
export const MAX_BULK_FIREBASE_SOURCES = 1000;

// Owner ke diye hue Firebase DBs — pehli baar is seed-version ke saath bot
// chalne par ye sab Settings → Firebase Sources me auto-add ho jate hain.
// seedVersion save rehta hai, isliye baad me koi source delete karne par
// woh restart par zabardasti wapas nahi aata.
// v3 (2026-11-07): ROLEX VIP list add — purane installs par bhi ek baar seed.
const BUILTIN_SEED_VERSION = 3;
const LEGACY_BUILTIN_FIREBASE_URLS = [
  'https://admin143-dab82-default-rtdb.firebaseio.com',
  'https://albart-new-feed-default-rtdb.firebaseio.com',
  'https://allahmohammad-5f389-default-rtdb.firebaseio.com',
  'https://amar-47591-default-rtdb.firebaseio.com',
  'https://asry-84be8-default-rtdb.firebaseio.com',
  'https://bewafa-f42d3-default-rtdb.firebaseio.com',
  'https://bhoto-f503f-default-rtdb.firebaseio.com',
  'https://boka-d0c13-default-rtdb.firebaseio.com',
  'https://chod-patti-default-rtdb.firebaseio.com',
  'https://choduu00111-default-rtdb.firebaseio.com',
  'https://cufutfutg-default-rtdb.firebaseio.com',
  'https://devilpanel-c8e3e-default-rtdb.firebaseio.com',
  'https://faizybro-default-rtdb.firebaseio.com',
  'https://fdfmnb-91c13-default-rtdb.firebaseio.com',
  'https://master80221-753fb-default-rtdb.firebaseio.com',
  'https://mr-ansari-f8e1e-default-rtdb.asia-southeast1.firebasedatabase.app',
  'https://myypppp-default-rtdb.asia-southeast1.firebasedatabase.app',
  'https://noidaa-dda60-default-rtdb.firebaseio.com',
  'https://odabu-91972-default-rtdb.firebaseio.com',
  'https://pablo-57b21-default-rtdb.firebaseio.com',
  'https://panel-4aa3d-default-rtdb.firebaseio.com',
  'https://penal-a93a8-default-rtdb.firebaseio.com',
  'https://pmyojana-7621e-default-rtdb.firebaseio.com',
  'https://robin-60398-default-rtdb.firebaseio.com',
  'https://rohitxpro-767b2-default-rtdb.firebaseio.com',
  'https://romdas-903d3-default-rtdb.firebaseio.com',
  'https://ronaak-admin-panel-default-rtdb.firebaseio.com',
  'https://roy11-3bc9e-default-rtdb.firebaseio.com',
  'https://roya-admin-default-rtdb.firebaseio.com',
  'https://rupesh-6c5e5-default-rtdb.firebaseio.com',
  'https://sale5-e588d-default-rtdb.firebaseio.com',
  'https://sallu-9934f-default-rtdb.firebaseio.com',
  'https://saluu-dcb00-default-rtdb.firebaseio.com',
  'https://samsan-d4bda-default-rtdb.firebaseio.com',
  'https://sanj-683c4-default-rtdb.firebaseio.com',
  'https://sbi-card-c24ef-default-rtdb.firebaseio.com',
  'https://taaaar-f97b6-default-rtdb.firebaseio.com',
  'https://tabuna-4e962-default-rtdb.firebaseio.com',
  'https://taniya-setup-panel-default-rtdb.firebaseio.com',
  'https://terimaakichut-ce92d-default-rtdb.firebaseio.com',
  'https://tinku-152d3-default-rtdb.firebaseio.com',
  'https://unknown-5b51e-default-rtdb.firebaseio.com',
  'https://ttitj-fe9b5-default-rtdb.firebaseio.com',
  'https://vfxhj-9accf-default-rtdb.firebaseio.com',
  'https://vault-29e76-default-rtdb.firebaseio.com',
  'https://vhjhfhjgjy-default-rtdb.firebaseio.com',
  'https://vikashhhh-default-rtdb.firebaseio.com',
  'https://vivov-df9bb-default-rtdb.firebaseio.com',
  'https://vishnu-cha-1-default-rtdb.firebaseio.com',
  'https://westsidestory-1334f-default-rtdb.firebaseio.com',
  'https://webfund3-default-rtdb.firebaseio.com',
  'https://dhoni-ji-default-rtdb.firebaseio.com',
  'https://dk-panel-default-rtdb.firebaseio.com',
  'https://do-admin-v13-default-rtdb.firebaseio.com',
  'https://do-admin-v21-default-rtdb.firebaseio.com',
];

// Purani 55 owner URLs + nayi ROLEX VIP list — duplicate hata kar, order
// preserve karke. Isi list se `ensureSeeded()` boot par sources banata hai.
export const BUILTIN_FIREBASE_SOURCE_URLS = (() => {
  const out = [];
  const seen = new Set();
  for (const raw of [...LEGACY_BUILTIN_FIREBASE_URLS, ...OWNER_FIREBASE_URLS]) {
    const url = String(raw || '').trim().replace(/\/+$/, '');
    const key = url.toLowerCase();
    if (!url || seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
})();

function normalizeSourceUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '').toLowerCase();
}

// ---- Env se poori list (Render restart-proof) -----------------------------
// FIREBASE_DB_URLS me newline/comma separated jitni chaho URLs daal do;
// boot par jo missing hongi woh auto-add ho jayengi. Aliases bhi chalte hain
// taaki purane env naam kaam karte rahein.
export const FIREBASE_ENV_URL_KEYS = ['FIREBASE_DB_URLS', 'FIREBASE_URLS', 'FIREBASE_DB_URL_LIST'];

let _envSeedCache = { raw: '', urls: [] };
export function envSeedUrls(env = process.env) {
  const raw = FIREBASE_ENV_URL_KEYS.map((k) => String(env?.[k] || '').trim()).filter(Boolean).join('\n');
  if (raw === _envSeedCache.raw) return _envSeedCache.urls.slice();
  const urls = raw
    ? parseFirebaseSourceBulkInput(raw).entries.map((e) => e.url)
    : [];
  _envSeedCache = { raw, urls };
  return urls.slice();
}

// ---- Source health (400+ DBs me se zinda wale pehle) ----------------------
// Har DB ka result yaad rakhte hain taaki har batch/rotation dead URL par
// 10s barbaad na kare. 2 lagatar failure par source 30 min quarantine me
// chala jata hai, phir apne aap wapas try hota hai. Koi source kabhi
// delete/disable nahi hota — sirf try-order badalta hai.
export const SOURCE_HEALTH_FAIL_THRESHOLD = 2;
export const SOURCE_HEALTH_QUARANTINE_MS = 30 * 60 * 1000;

function loadHealth(state) {
  if (!state.health || typeof state.health !== 'object') state.health = {};
  return state.health;
}

export function getSourceHealth(id, state = null) {
  const st = state || loadState();
  const h = loadHealth(st)[id];
  if (!h || typeof h !== 'object') {
    return { id, failStreak: 0, emptyStreak: 0, okCount: 0, failCount: 0, lastOkAt: 0, lastFailAt: 0, lastError: '', latencyMs: 0, quarantinedUntil: 0 };
  }
  return { id, ...h };
}

export function isSourceQuarantined(srcOrId, now = Date.now()) {
  const id = typeof srcOrId === 'string' ? srcOrId : srcOrId?.id;
  if (!id) return false;
  const h = getSourceHealth(id);
  return Number(h.quarantinedUntil) > now;
}

// ok=true → streak reset. ok=false → streak++, threshold par quarantine.
// `empty` = DB reachable hai magar usme usable number nahi (aisa DB bhi
// 30 min ke liye peeche chala jata hai, warna 400+ sources ka scan bekaar
// hota rehta hai).
export function recordSourceResult(id, { ok = false, error = '', ms = 0, empty = false } = {}) {
  if (!id) return null;
  // getDb() disk se padhta hai — isliye ek hi db object ko mutate karke
  // saveDb karo, warna saveDb naya (bina health wala) snapshot likh dega.
  const db = getDb();
  if (!db.firebaseSources || typeof db.firebaseSources !== 'object') {
    db.firebaseSources = { activeId: '', list: [] };
  }
  const state = db.firebaseSources;
  const health = loadHealth(state);
  const now = Date.now();
  const prev = health[id] && typeof health[id] === 'object' ? health[id] : {};
  const next = {
    failStreak: Number(prev.failStreak) || 0,
    emptyStreak: Number(prev.emptyStreak) || 0,
    okCount: Number(prev.okCount) || 0,
    failCount: Number(prev.failCount) || 0,
    lastOkAt: Number(prev.lastOkAt) || 0,
    lastFailAt: Number(prev.lastFailAt) || 0,
    lastError: String(prev.lastError || ''),
    latencyMs: Number(prev.latencyMs) || 0,
    quarantinedUntil: Number(prev.quarantinedUntil) || 0,
  };
  if (ok) {
    next.okCount += 1;
    next.failStreak = 0;
    next.emptyStreak = 0;
    next.lastOkAt = now;
    next.lastError = '';
    if (Number(ms) > 0) next.latencyMs = Number(ms);
    next.quarantinedUntil = 0;
  } else {
    next.failCount += 1;
    next.lastFailAt = now;
    next.lastError = String(error || (empty ? 'khali pool' : 'fail')).slice(0, 160);
    if (empty) {
      next.emptyStreak += 1;
      next.failStreak = 0;
      if (next.emptyStreak >= SOURCE_HEALTH_FAIL_THRESHOLD) next.quarantinedUntil = now + SOURCE_HEALTH_QUARANTINE_MS;
    } else {
      next.failStreak += 1;
      next.emptyStreak = 0;
      if (next.failStreak >= SOURCE_HEALTH_FAIL_THRESHOLD) next.quarantinedUntil = now + SOURCE_HEALTH_QUARANTINE_MS;
    }
  }
  health[id] = next;
  saveDb(db);
  return { id, ...next };
}

export function resetSourceHealth(ids = null) {
  const db = getDb();
  if (!db.firebaseSources || typeof db.firebaseSources !== 'object') {
    db.firebaseSources = { activeId: '', list: [] };
  }
  const state = db.firebaseSources;
  if (!ids) {
    state.health = {};
  } else {
    const health = loadHealth(state);
    for (const id of [].concat(ids)) delete health[id];
  }
  saveDb(db);
  return true;
}

// UI ke liye chhota summary: kitne live, kitne quarantine me.
export function sourceHealthSummary(list = null) {
  const state = loadState();
  const sources = Array.isArray(list) ? list : state.list;
  const now = Date.now();
  let live = 0;
  let quarantined = 0;
  let neverTried = 0;
  let failed = 0;
  for (const s of sources) {
    const h = state.health?.[s.id];
    if (Number(h?.quarantinedUntil) > now) quarantined += 1;
    else if (Number(h?.failCount) > 0 && !Number(h?.okCount)) failed += 1;
    else if (!h) neverTried += 1;
    else live += 1;
  }
  return { total: sources.length, live, failed, quarantined, neverTried };
}

// Har saved source public roop me hamesha ACTIVE hai. `primary` sirf
// batch/reader ka first-try order batata hai; baaki sources bhi utne hi
// ACTIVE hote hain aur isi run ke fallback order me rehte hain.
function decorateSource(source, state = {}) {
  if (!source) return null;
  return {
    ...source,
    enabled: true,
    active: true,
    primary: source.id === state.activeId,
  };
}

function builtinSourceName(url) {
  try {
    return new URL(url).hostname
      .split('.')[0]
      .replace(/-default-rtdb$/i, '')
      .slice(0, 40) || 'Firebase';
  } catch {
    return 'Firebase';
  }
}

function newSourceId(state) {
  const used = new Set((state?.list || []).map((s) => s.id));
  let id = '';
  do { id = crypto.randomUUID().slice(0, 8); } while (used.has(id));
  return id;
}

function loadState() {
  const db = getDb();
  if (!db.firebaseSources || typeof db.firebaseSources !== 'object') {
    db.firebaseSources = { activeId: '', list: [] };
  }
  if (!Array.isArray(db.firebaseSources.list)) db.firebaseSources.list = [];
  return db.firebaseSources;
}

function persist(state) {
  const db = getDb();
  db.firebaseSources = state;
  saveDb(db);
  // Free Render ki disk ephemeral hai — list aur health cloud vault me bhi
  // bhejo taaki restart/redeploy ke baad seed+settings wapas mil jayein.
  try {
    const { scheduleCloudVaultSync, buildCloudVaultSnapshot } = storeVault;
    scheduleCloudVaultSync(() => buildCloudVaultSnapshot(getDb()));
  } catch {}
}

// Pehli baar list khali ho to env/default se seed + owner-ki built-in list
// ek dafa merge karo. Purani DB me koi source galti/purane UI se disabled
// save ho gaya ho to use yahin ACTIVE normalize kar do — ab source sirf
// Delete se hi hatega.
export function ensureSeeded() {
  const state = loadState();
  let changed = false;

  for (const source of state.list) {
    if (source.enabled !== true) {
      source.enabled = true;
      changed = true;
    }
  }

  if (!Array.isArray(state.deleted)) state.deleted = [];
  const deletedUrls = new Set((state.deleted || []).map(normalizeSourceUrl));

  if (!state.list.length && !state.cleared) {
    const url = String(process.env.FIREBASE_DB_URL || DEFAULT_URL).trim();
    const src = {
      id: newSourceId(state),
      name: 'Default (vuvhbjbi)',
      url: url.replace(/\/+$/, ''),
      auth: String(process.env.FIREBASE_DB_AUTH || '').trim(),
      clientsPath: String(process.env.FIREBASE_CLIENTS_PATH || 'clients').trim(),
      messagesPath: String(process.env.FIREBASE_MESSAGES_PATH || 'messages').trim(),
      numbersPath: '',
      smsPath: 'sms',
      otpPath: 'otp',
      enabled: true,
      addedAt: new Date().toISOString(),
    };
    if (!deletedUrls.has(normalizeSourceUrl(url))) {
      state.list.push(src);
      state.activeId = src.id;
    }
    changed = true;
  }

  // Seed sources do baar se aate hain:
  //   1) code wali built-in list (owner ki ROLEX VIP list) — seedVersion
  //      badalne par ek hi baar merge hoti hai, isliye Delete ki hui URL
  //      restart par wapas nahi aati.
  //   2) env FIREBASE_DB_URLS — har boot par missing URLs add hoti hain
  //      (Render env kabhi mitta nahi), deleted list inhe bhi rok deti hai.
  const knownUrls = new Set(state.list.map((s) => normalizeSourceUrl(s.url)));
  const seedOnce = (Number(state.seedVersion) || 0) < BUILTIN_SEED_VERSION;
  const envUrls = envSeedUrls();
  const pendingSeed = [
    ...(seedOnce ? BUILTIN_FIREBASE_SOURCE_URLS : []),
    ...envUrls,
  ];
  if (pendingSeed.length) {
    const addedAt = new Date().toISOString();
    for (const url of pendingSeed) {
      const key = normalizeSourceUrl(url);
      if (!key || knownUrls.has(key) || deletedUrls.has(key)) continue;
      state.list.push({
        id: newSourceId(state),
        name: builtinSourceName(url),
        url,
        auth: '',
        clientsPath: 'clients',
        messagesPath: 'messages',
        numbersPath: '',
        smsPath: 'sms',
        otpPath: 'otp',
        enabled: true,
        builtin: true,
        addedAt,
      });
      knownUrls.add(key);
      changed = true;
    }
  }
  if (seedOnce) {
    state.seedVersion = BUILTIN_SEED_VERSION;
    changed = true;
  }

  if (!state.activeId || !state.list.some((s) => s.id === state.activeId)) {
    const first = state.list.find((s) => s.enabled) || state.list[0];
    state.activeId = first?.id || '';
    changed = true;
  }

  if (changed) persist(state);
  return state;
}

export function listSources() {
  const state = ensureSeeded();
  return state.list.map((s) => decorateSource(s, state));
}

// Ye "akela active" nahi hai — saare sources ACTIVE hain. Ye helper sirf
// wo ek source deta hai jo reader/batch sabse pehle try karega.
export function getPrimarySource() {
  const state = ensureSeeded();
  const source = state.list.find((s) => s.id === state.activeId) || state.list[0] || null;
  return decorateSource(source, state);
}

// Backward-compatible alias: purane callers isi naam se first-try source
// lete aaye hain.
export function getActiveSource() {
  return getPrimarySource();
}

export function getSource(id) {
  const state = ensureSeeded();
  return decorateSource(state.list.find((s) => s.id === id) || null, state);
}

// Batch ke liye ACTIVE sources ka order: first-try source pehle, phir
// baaki saare saved sources list order me. Purani/stale `enabled:false`
// value kisi source ko bahar nahi karti — source sirf Delete se hatega.
// Ek source khali/error/exhaust ho to engine isi order se agla ACTIVE
// source try karta hai; duplicate URL par ek hi DB dobara load nahi hota.
export function orderSourcesForRun(sources = [], activeId = '', opts = {}) {
  const present = (Array.isArray(sources) ? sources : []).filter(
    (s) => s && String(s.url || '').trim()
  );
  const primary = present.find((s) => s.id === activeId)
    || present.find((s) => s.primary === true)
    || present.find((s) => s.active === true)
    || null;
  const ordered = primary
    ? [primary, ...present.filter((s) => s !== primary)]
    : present;

  // Health ranking: jo DB abhi fail/quarantine me hai wo pool ke aakhir me
  // jata hai, taaki 400+ sources waale pool me har run pehle zinda DBs try
  // kare (ek ID/minute ke liye zaroori). Koi source hatta nahi — sirf order
  // badalta hai.
  const healthMap = opts.health || (() => { try { return loadState().health || {}; } catch { return {}; } })();
  const now = Date.now();
  const rankOf = (s) => {
    const h = healthMap?.[s.id];
    if (!h || typeof h !== 'object') return 1; // never tried → beech me
    if (Number(h.quarantinedUntil) > now) return 2; // quarantine → sabse aakhir
    if (Number(h.lastOkAt) > 0) return 0; // proven live → sabse pehle
    return 1;
  };
  const ranked = ordered
    .map((s, i) => ({ s, i, rank: rankOf(s) }))
    .sort((a, b) => (a.rank - b.rank) || (a.i - b.i))
    .map((x) => x.s);

  const seenUrls = new Set();
  return ranked
    .filter((s) => {
      const key = normalizeSourceUrl(s.url);
      if (!key || seenUrls.has(key)) return false;
      seenUrls.add(key);
      return true;
    })
    .map((s, idx) => ({
      ...s,
      enabled: true,
      active: true,
      // `primary` sirf "is run me pehle try hoga" ka marker hai.
      primary: idx === 0,
    }));
}

export function listRunSources() {
  const state = ensureSeeded();
  return orderSourcesForRun(state.list, state.activeId);
}

function validateSourceInput({ name, url, auth, clientsPath, messagesPath, numbersPath, smsPath, otpPath }) {
  const cleanUrl = String(url || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9-]+\.firebaseio\.com$/i.test(cleanUrl) &&
      !/^https:\/\/[a-z0-9.-]+\.firebasedatabase\.app$/i.test(cleanUrl)) {
    return { ok: false, error: 'URL valid Firebase Realtime DB hona chahiye — jaise https://xxxx-default-rtdb.firebaseio.com/' };
  }
  return {
    ok: true,
    src: {
      name: String(name || '').trim().slice(0, 40) || cleanUrl.replace('https://', '').split('.')[0],
      url: cleanUrl,
      auth: String(auth || '').trim(),
      clientsPath: String(clientsPath || 'clients').trim(),
      messagesPath: String(messagesPath || 'messages').trim(),
      numbersPath: String(numbersPath || '').trim(),
      smsPath: String(smsPath || 'sms').trim(),
      otpPath: String(otpPath || 'otp').trim(),
    },
  };
}

// Ek hi Telegram message me multiple Firebase URLs qubool karo:
//   • har line me ek URL
//   • comma / semicolon / space se alag kai URLs
//   • bare hostname (https:// khud lag jayega)
//   • har URL ke saath optional auth: <url> | <DB_AUTH_secret>
// Bullet/index/labels tolerate hote hain; jo tukda Firebase URL hi na
// ho woh invalid me report hota hai taaki user ko saaf count mile.
export function parseFirebaseSourceBulkInput(text = '') {
  const hostRe = () => /(?:https?:\/\/)?(?:[a-z0-9-]+\.)+(?:firebaseio\.com|firebasedatabase\.app)(?=$|[\s\/|,;\)\]\}>"'\?#!]|\.(?=$|[\s,;\)\]\}>"']))/gi;
  const segments = [];

  for (const chunk of String(text || '').split(/[\r\n,;]+/)) {
    if (!chunk.trim()) continue;
    const matches = [...chunk.matchAll(hostRe())];
    if (matches.length <= 1) {
      segments.push(chunk);
      continue;
    }
    matches.forEach((match, i) => {
      segments.push(chunk.slice(match.index, matches[i + 1]?.index ?? chunk.length));
    });
  }

  const entries = [];
  const invalid = [];
  for (const rawSegment of segments) {
    const segment = String(rawSegment || '').trim();
    if (!segment) continue;
    const match = hostRe().exec(segment);
    if (!match) {
      // Invalid tukde ki report me pipe ke baad wala hissa kabhi mat rakho —
      // woh DB auth secret ho sakta hai.
      invalid.push({ input: segment.split('|')[0].trim().slice(0, 100), error: 'valid Firebase Realtime DB URL nahi mila' });
      continue;
    }

    const rawUrl = match[0];
    const url = (/^https?:\/\//i.test(rawUrl)
      ? rawUrl.replace(/^http:\/\//i, 'https://')
      : `https://${rawUrl}`).replace(/\/+$/, '');
    const remainder = segment.slice(match.index + rawUrl.length);
    const pipeIdx = remainder.indexOf('|');
    let auth = '';
    if (pipeIdx !== -1) {
      auth = remainder.slice(pipeIdx + 1).trim()
        .replace(/^auth\s*[:=]\s*/i, '')
        .replace(/^["']|["']$/g, '')
        .trim();
    } else {
      const queryAuth = remainder.match(/[?&]auth=([^&\s,;]+)/i);
      if (queryAuth) {
        try { auth = decodeURIComponent(queryAuth[1]); } catch { auth = queryAuth[1]; }
      }
    }
    entries.push({ url, auth });
  }

  return { entries, invalid };
}

// Multiple sources ek hi baar me ACTIVE add karo. Existing/input
// duplicates dobara nahi bante; invalid tukde report hote hain. Reader ka
// first-try source tabhi badalta hai jab caller setFirstAsPrimary bole —
// is se baaki sources inactive nahi hote, sab waisay hi ACTIVE rehte hain.
export function addSourcesBulk(input, {
  setFirstAsPrimary = false,
  applyReader = true,
} = {}) {
  let parsed = { entries: [], invalid: [] };
  if (typeof input === 'string') {
    parsed = parseFirebaseSourceBulkInput(input);
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') {
        const one = parseFirebaseSourceBulkInput(item);
        parsed.entries.push(...one.entries);
        parsed.invalid.push(...one.invalid);
      } else if (item && typeof item === 'object') {
        parsed.entries.push(item);
      } else if (String(item || '').trim()) {
        parsed.invalid.push({ input: String(item).slice(0, 100), error: 'valid Firebase source nahi hai' });
      }
    }
  } else if (input && Array.isArray(input.entries)) {
    parsed = {
      entries: [...input.entries],
      invalid: Array.isArray(input.invalid) ? [...input.invalid] : [],
    };
  } else if (String(input || '').trim()) {
    parsed.invalid.push({ input: String(input).slice(0, 100), error: 'valid Firebase source nahi hai' });
  }

  const requested = parsed.entries.length + parsed.invalid.length;
  const invalid = [...parsed.invalid];
  const candidates = parsed.entries.slice(0, MAX_BULK_FIREBASE_SOURCES);
  for (const extra of parsed.entries.slice(MAX_BULK_FIREBASE_SOURCES)) {
    invalid.push({
      input: String(extra?.url || '').slice(0, 100),
      error: `ek baar me max ${MAX_BULK_FIREBASE_SOURCES} Firebase add ho sakte hain`,
    });
  }

  const state = ensureSeeded();
  const byUrl = new Map(state.list.map((s) => [normalizeSourceUrl(s.url), s]));
  const addedRefs = [];
  const duplicateRefs = [];
  const addedAt = new Date().toISOString();

  for (const candidate of candidates) {
    const v = validateSourceInput(candidate || {});
    if (!v.ok) {
      invalid.push({ input: String(candidate?.url || '').slice(0, 100), error: v.error });
      continue;
    }
    const key = normalizeSourceUrl(v.src.url);
    const existing = byUrl.get(key);
    if (existing) {
      duplicateRefs.push(existing);
      continue;
    }
    const src = {
      id: newSourceId(state),
      ...v.src,
      enabled: true,
      addedAt,
    };
    state.list.push(src);
    byUrl.set(key, src);
    addedRefs.push(src);
    // Manual re-add → delete-memory se hata do taaki seeding bhi isse
    // dobara na roke.
    if (Array.isArray(state.deleted)) {
      const di = state.deleted.indexOf(key);
      if (di !== -1) state.deleted.splice(di, 1);
    }
  }

  if (addedRefs.length) state.cleared = false;
  if (addedRefs.length && (setFirstAsPrimary || !state.list.some((s) => s.id === state.activeId))) {
    state.activeId = addedRefs[0].id;
  }
  if (addedRefs.length) {
    persist(state);
    setFirebaseDisabled(false);
  }
  if (addedRefs.length && applyReader) applyActiveSource();

  const finalState = ensureSeeded();
  const byId = new Map(finalState.list.map((s) => [s.id, s]));
  return {
    ok: addedRefs.length > 0,
    added: addedRefs.map((s) => decorateSource(byId.get(s.id) || s, finalState)),
    duplicates: duplicateRefs.map((s) => decorateSource(byId.get(s.id) || s, finalState)),
    invalid,
    requested,
    total: finalState.list.length,
  };
}

export function addSource(input, { activate = true } = {}) {
  const v = validateSourceInput(input);
  if (!v.ok) return v;
  const state = ensureSeeded();
  if (state.list.some((s) => normalizeSourceUrl(s.url) === normalizeSourceUrl(v.src.url))) {
    return { ok: false, error: 'Ye URL pehle se added hai.' };
  }
  const src = {
    id: newSourceId(state),
    ...v.src,
    enabled: true,
    addedAt: new Date().toISOString(),
  };
  state.list.push(src);
  if (Array.isArray(state.deleted)) {
    const di = state.deleted.indexOf(normalizeSourceUrl(src.url));
    if (di !== -1) state.deleted.splice(di, 1);
  }
  state.cleared = false;
  setFirebaseDisabled(false);
  // Legacy `activate` ka ab matlab sirf first-try banana hai; naya source
  // har haal me ACTIVE add hota hai aur purane sources bhi ACTIVE rehte hain.
  if (activate || !getActiveSource()) state.activeId = src.id;
  persist(state);
  if (src.id === state.activeId) applyActiveSource(); // reader par turant apply
  return { ok: true, source: decorateSource(src, state) };
}

export function removeSource(id) {
  const state = ensureSeeded();
  const idx = state.list.findIndex((s) => s.id === id);
  if (idx === -1) return { ok: false, error: 'Source nahi mila.' };
  if (state.list.length === 1) return { ok: false, error: 'Aakhri source delete nahi ho sakta — pehle naya add karein.' };
  const [removed] = state.list.splice(idx, 1);
  // Delete ki hui URL ko yaad rakho — warna boot seeding (built-in/env)
  // usko dobara add kar deti hai aur user ka Delete bekaar jata hai.
  if (removed?.url) {
    if (!Array.isArray(state.deleted)) state.deleted = [];
    const key = normalizeSourceUrl(removed.url);
    if (key && !state.deleted.includes(key)) state.deleted.push(key);
  }
  if (state.health && removed?.id) delete state.health[removed.id];
  if (state.activeId === id) {
    const next = state.list.find((s) => s.enabled) || state.list[0];
    state.activeId = next ? next.id : '';
  }
  persist(state);
  applyActiveSource();
  return { ok: true };
}

// Legacy naam barqarar hai, lekin ab ye kisi ek ko "akela active" nahi
// banata — sirf batch/reader ke first-try order me use aage rakhta hai.
// Saare saved Firebase pehle se ACTIVE hain.
export function setActiveSource(id) {
  const state = ensureSeeded();
  const src = state.list.find((s) => s.id === id);
  if (!src) return { ok: false, error: 'Source nahi mila.' };
  src.enabled = true;
  state.activeId = id;
  persist(state);
  applyActiveSource();
  return { ok: true, source: decorateSource(src, state) };
}

// Backward compatibility ke liye export rehne diya hai, lekin user ke
// rule ke mutabiq ye kabhi disable nahi karega. Source hatana ho to
// sirf removeSource()/Delete hi rasta hai.
export function toggleSource(id) {
  const state = ensureSeeded();
  const src = state.list.find((s) => s.id === id);
  if (!src) return { ok: false, error: 'Source nahi mila.' };
  src.enabled = true;
  persist(state);
  return {
    ok: true,
    enabled: true,
    active: true,
    alwaysActive: true,
    source: decorateSource(src, state),
  };
}

// Saare sources ACTIVE hain; reader par ek waqt me sirf first-try/current
// source lag sakta hai. Ye usi first-try ko apply karta hai (boot/ADD par).
export function applyActiveSource() {
  const src = getActiveSource();
  // list khali + owner ne delete-all kiya tha → env fallback bhi band.
  const cleared = !src && isFirebaseSourceListCleared();
  setFirebaseDisabled(cleared);
  setFirebaseSource(src); // null = env fallback
  return cleared ? null : src;
}

// Delete All ka permanent nishaan. Naya source add karte hi ye khud hat
// jata hai, isliye "delete all" ke baad user phir se list bana sakta hai.
export function isFirebaseSourceListCleared() {
  const state = loadState();
  return Boolean(state.cleared) && !(Array.isArray(state.list) && state.list.length);
}

// Owner ka "Delete All Firebase": poori list saaf + Delete-memory me saari
// built-in/env URLs — taaki restart/redeploy par seeding wapas na le aaye.
// Firebase tab tak OFF rehta hai jab tak naya source add na ho.
export function removeAllSources() {
  const state = ensureSeeded();
  const urls = new Set();
  for (const src of state.list) urls.add(normalizeSourceUrl(src.url));
  for (const url of BUILTIN_FIREBASE_SOURCE_URLS) urls.add(normalizeSourceUrl(url));
  for (const url of envSeedUrls()) urls.add(normalizeSourceUrl(url));
  urls.add(normalizeSourceUrl(DEFAULT_URL));
  urls.add(normalizeSourceUrl(String(process.env.FIREBASE_DB_URL || '')));
  urls.delete('');

  const removed = state.list.length;
  state.list = [];
  state.health = {};
  state.activeId = '';
  state.deleted = [...new Set([...(Array.isArray(state.deleted) ? state.deleted : []), ...urls])];
  state.cleared = true;
  state.seedVersion = BUILTIN_SEED_VERSION;
  persist(state);
  setFirebaseDisabled(true);
  setFirebaseSource(null);
  return { ok: true, removed, remembered: urls.size };
}

// Batch ke andar agle ACTIVE source ko reader par lagao — saved first-try
// setting nahi badalti aur koi source inactive nahi hota. Run khatam hone
// par engine applyActiveSource() se first-try choice restore kar deta hai.
export function applySourceForRun(src) {
  setFirebaseSource(src || null);
  return src || null;
}

// Naya source add karte hi turant test — user ko feedback mile
export async function verifySource(id) {
  const src = getSource(id);
  if (!src) return { ok: false, error: 'Source nahi mila.' };
  const url = `${src.url}/.json?shallow=true${src.auth ? `&auth=${encodeURIComponent(src.auth)}` : ''}`;
  try {
    const t0 = Date.now();
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const ms = Date.now() - t0;
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      const err = `HTTP ${res.status} ${txt.slice(0, 100)}`;
      recordSourceResult(id, { ok: false, error: err });
      return { ok: false, error: err };
    }
    const json = await res.json().catch(() => null);
    const firebaseError = _firebaseErrorMessage(json);
    if (firebaseError) {
      recordSourceResult(id, { ok: false, error: firebaseError });
      return { ok: false, error: firebaseError.slice(0, 160) };
    }
    const topKeys = json && typeof json === 'object' ? Object.keys(json).slice(0, 8) : [];
    recordSourceResult(id, { ok: true, ms });
    return { ok: true, ms, topKeys };
  } catch (e) {
    recordSourceResult(id, { ok: false, error: e?.message || 'network error' });
    return { ok: false, error: e?.message || 'network error' };
  }
}
