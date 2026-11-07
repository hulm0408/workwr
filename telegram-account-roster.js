// ============================================================================
// telegram-account-roster.js — kai spare accounts, ek-ek karke use
// ============================================================================
// Aaj: ek bot = ek TELEGRAM_SESSION. Us account par kuch bhi ho jaye
// (flood, session revoke, bot block) to poora bot chup ho jata hai — "ek
// Hathi bot par saare accounts nahi chal rahe" wahi scene hai.
//
// Ab: kai accounts, aur har account ki apni sehat:
//   TELEGRAM_SESSION    = account #1
//   TELEGRAM_SESSION_2  = account #2
//   TELEGRAM_SESSION_3  = account #3
//   TELEGRAM_SESSION_4  = account #4
//
// Claim ke waqt sirf **healthy** account chuna jata hai. Jo account flood /
// dead / blocked nikalta hai, wo cooldown me chala jata hai aur baaki accounts
// kaam karte rehte hain. Cooldown khatam hone par wo khud wapas aa jata hai.
//
// Purana behaviour: sirf TELEGRAM_SESSION ho to roster single-slot hai aur
// sab kuch bilkul pehle jaisa chalta hai.

import { classifyTelegramError, accountStateLine } from './telegram-account-health.js';

export const MAX_ROSTER_ACCOUNTS = 8;

function firstEnvValue(env, keys) {
  for (const key of keys) {
    const value = String(env?.[key] ?? '').trim();
    if (value) return value;
  }
  return '';
}

function shortTag(session = '') {
  const text = String(session || '').trim();
  if (!text) return '';
  // Chhota, non-reversible fingerprint — poora session kabhi print nahi hota.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').slice(0, 8);
}

// Slot 0 → TELEGRAM_SESSION · slot 1 → TELEGRAM_SESSION_2 · ...
export function sessionEnvKeys(slot = 0) {
  const n = Number(slot) || 0;
  const suffix = n === 0 ? '' : `_${n + 1}`;
  return {
    session: [`TELEGRAM_SESSION${suffix}`, `TG_SESSION${suffix}`],
    apiId: [`TELEGRAM_API_ID${suffix}`, `TG_API_ID${suffix}`],
    apiHash: [`TELEGRAM_API_HASH${suffix}`, `TG_API_HASH${suffix}`],
  };
}

// Sirf env se roster — koi I/O nahi (tests ke liye pure).
export function buildRoster(env = process.env, { fallbackSession = '', fallbackApiId = 0, fallbackApiHash = '' } = {}) {
  const accounts = [];
  for (let slot = 0; slot < MAX_ROSTER_ACCOUNTS; slot++) {
    const keys = sessionEnvKeys(slot);
    let session = firstEnvValue(env, keys.session);
    if (!session && slot === 0) session = String(fallbackSession || '').trim();
    if (!session && slot > 0) {
      // Slot 0 ke baad khaali slot mila to ruk jao (middle gaps allowed nahi).
      if (!firstEnvValue(env, sessionEnvKeys(slot + 1).session)) break;
      continue;
    }
    if (!session) break;
    const apiIdRaw = firstEnvValue(env, keys.apiId) || String(fallbackApiId || '');
    const apiHash = firstEnvValue(env, keys.apiHash) || String(fallbackApiHash || '');
    const entry = {
      slot,
      tag: shortTag(session),
      apiId: /^\d+$/.test(apiIdRaw) ? Number(apiIdRaw) : 0,
      apiHash,
      envKey: keys.session[0],
    };
    // Session value non-enumerable — JSON.stringify / console.log me galti se
    // bhi kabhi na chhape (ye poora account access hai).
    Object.defineProperty(entry, 'session', { value: session, enumerable: false, writable: true });
    accounts.push(entry);
  }
  return accounts;
}

// ---- runtime state (per process) -------------------------------------------
const stateBySlot = new Map(); // slot → { status, until, code, label, since, note }
let pinnedSlot = -1;           // active number ki account — flow ke beech na badle
let lastRotatedAt = 0;

export function _resetRosterStateForTests() {
  stateBySlot.clear();
  pinnedSlot = -1;
  lastRotatedAt = 0;
}

function ensureState(slot) {
  if (!stateBySlot.has(slot)) {
    stateBySlot.set(slot, { status: 'ready', until: 0, code: '', label: '', since: Date.now(), note: '' });
  }
  return stateBySlot.get(slot);
}

export function accountState(slot, now = Date.now()) {
  const state = ensureState(Number(slot) || 0);
  // Cooldown khatam → khud ready.
  if (state.status === 'cooldown' && Number(state.until) <= now) {
    return { ...state, status: 'ready', until: 0, code: '', label: '' };
  }
  return { ...state };
}

export function isHealthy(slot, now = Date.now()) {
  const state = accountState(slot, now);
  return state.status === 'ready';
}

// Error ko account ki sehat me daalo. Dead = us run me wapas nahi.
export function markAccountFailure(slot, error, now = Date.now()) {
  const classified = classifyTelegramError(error);
  const state = ensureState(Number(slot) || 0);
  const until = now + Math.max(0, Number(classified.cooldownMs) || 0);
  state.status = classified.kind === 'dead' || classified.kind === 'blocked' || classified.kind === 'peer-flood'
    ? 'dead'
    : (classified.cooldownMs > 0 ? 'cooldown' : 'ready');
  state.until = state.status === 'ready' ? 0 : until;
  state.code = classified.code;
  state.label = classified.label;
  state.note = classified.hint;
  state.since = now;
  return classified;
}

export function markAccountHealthy(slot, { me = '' } = {}) {
  const state = ensureState(Number(slot) || 0);
  state.status = 'ready';
  state.until = 0;
  state.code = '';
  state.label = '';
  state.note = '';
  state.since = Date.now();
  if (me) state.me = me;
  return state;
}

export function pinSlot(slot) {
  pinnedSlot = Number.isInteger(Number(slot)) ? Number(slot) : -1;
  return pinnedSlot;
}

export function pinnedAccountSlot() {
  return pinnedSlot;
}

export function unpinSlot() {
  pinnedSlot = -1;
}

// Aglaaccount: pinned se shuru, phir round-robin healthy accounts.
export function nextHealthySlot(accounts = [], { now = Date.now(), skipPinned = false } = {}) {
  if (!accounts.length) return -1;
  const start = skipPinned || pinnedSlot < 0 ? 0 : pinnedSlot;
  for (let offset = 0; offset < accounts.length; offset++) {
    const candidate = accounts[(start + offset) % accounts.length];
    if (isHealthy(candidate.slot, now)) return candidate.slot;
  }
  // Sab cooldown me hain — sabse jaldi wapas aane wala chuno.
  const soonest = accounts
    .map((a) => ({ slot: a.slot, until: accountState(a.slot, now).until || Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.until - b.until)[0];
  if (soonest && soonest.until !== Number.MAX_SAFE_INTEGER) return soonest.slot;
  return -1;
}

export function rotateFrom(slot, accounts = [], { now = Date.now() } = {}) {
  lastRotatedAt = now;
  const healthy = nextHealthySlot(accounts, { now, skipPinned: true });
  if (healthy < 0 || healthy === slot) return -1;
  pinSlot(healthy);
  return healthy;
}

export function lastRotationAt() {
  return lastRotatedAt;
}

// /diag + /health ke liye snapshot — session value kabhi nahi.
export function rosterSummary(accounts = [], now = Date.now()) {
  const list = accounts.map((account) => {
    const state = accountState(account.slot, now);
    return {
      slot: account.slot,
      tag: account.tag,
      envKey: account.envKey,
      status: state.status,
      code: state.code,
      label: state.label,
      until: state.until,
      me: state.me || '',
      line: accountStateLine({ ...state, slot: account.slot, tag: account.tag }, now),
    };
  });
  return {
    count: list.length,
    healthy: list.filter((a) => a.status === 'ready').length,
    pinned: pinnedSlot,
    accounts: list,
  };
}

export { classifyTelegramError };
