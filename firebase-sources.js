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

// Pehli baar list khali ho to env/default se seed
export function ensureSeeded() {
  const state = loadState();
  if (state.list.length) return state;
  const url = String(process.env.FIREBASE_DB_URL || DEFAULT_URL).trim();
  const src = {
    id: crypto.randomUUID().slice(0, 8),
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
  persist(state);
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
  return state.list.find((s) => s.id === id) || null;
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
  if (state.list.some((s) => s.url === v.src.url)) {
    return { ok: false, error: 'Ye URL pehle se added hai.' };
  }
  const src = {
    id: crypto.randomUUID().slice(0, 8),
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
