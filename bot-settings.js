// ===== ⚙️ BOT SETTINGS — batch knobs bot UI se (env nahi chhedni padti) =====
//
// Storage: data/db.json → db.freshSettings = { target, maxMinutes, gapMs, ... }
// Missing knobs env (ya default) se fall back hote hain — backward compatible.
//
// Har set pehle validation + clamp — user galat value na daal paye.

import { getDb, saveDb } from './store.js';

const SPECS = {
  target:            { min: 1,    max: 5000, dflt: 100,    label: '🎯 Target (fresh sessions)' },
  maxMinutes:        { min: 5,    max: 1440, dflt: 120,    label: '⏱ Max time (minutes)' },
  gapMs:             { min: 0,    max: 300000, dflt: 15000, label: 'Gap between numbers (ms)' },
  backoffMs:         { min: 30000, max: 7200000, dflt: 900000, label: 'Rate-limit backoff (ms)' },
  otpWaitMs:         { min: 0,    max: 60000, dflt: 10000, label: 'OTP se pehle wait (ms)' },
  otpTimeoutMs:      { min: 5000, max: 300000, dflt: 90000, label: 'OTP poll budget (ms)' },
  allowOffline:      { bool: true, dflt: false, label: 'Offline devices bhi try karein' },
};

const ENV_MAP = {
  target: 'PREMIUM_BATCH_TARGET',
  maxMinutes: 'PREMIUM_BATCH_MAX_MINUTES',
  gapMs: 'PREMIUM_BATCH_GAP_MS',
  backoffMs: 'PREMIUM_RATE_LIMIT_BACKOFF_MS',
  otpWaitMs: 'PREMIUM_OTP_WAIT_MS',
  otpTimeoutMs: 'PREMIUM_OTP_TIMEOUT_MS',
  allowOffline: 'PREMIUM_ALLOW_OFFLINE_DEVICES',
};

function load() {
  const db = getDb();
  if (!db.freshSettings || typeof db.freshSettings !== 'object') db.freshSettings = {};
  return db.freshSettings;
}

// Final value: user setting > env > spec default
export function getSetting(key) {
  const spec = SPECS[key];
  if (!spec) return undefined;
  const s = load();
  if (spec.bool) {
    if (typeof s[key] === 'boolean') return s[key];
    const envVal = String(process.env[ENV_MAP[key]] || '').trim();
    return envVal === '1' ? true : spec.dflt;
  }
  if (Number.isFinite(s[key])) return s[key];
  const envVal = Number(process.env[ENV_MAP[key]]);
  return Number.isFinite(envVal) && envVal >= 0 ? envVal : spec.dflt;
}

export function getAllSettings() {
  const out = {};
  for (const key of Object.keys(SPECS)) out[key] = getSetting(key);
  return out;
}

export function setSetting(key, value) {
  const spec = SPECS[key];
  if (!spec) return { ok: false, error: `Unknown setting: ${key}` };
  const s = load();
  if (spec.bool) {
    s[key] = value === true || value === 'true' || value === 1 || value === '1';
  } else {
    const n = Number(value);
    if (!Number.isFinite(n)) return { ok: false, error: 'Number daalo.' };
    if (n < spec.min || n > spec.max) {
      return { ok: false, error: `${spec.label}: ${spec.min}–${spec.max} ke beech.` };
    }
    s[key] = Math.round(n);
  }
  const db = getDb();
  db.freshSettings = s;
  saveDb(db);
  return { ok: true, value: s[key] };
}

export function resetSettings() {
  const db = getDb();
  db.freshSettings = {};
  saveDb(db);
  return { ok: true };
}

// Engine ko dene ke liye — knobs + spec metadata (UI labels ke liye)
export function settingsSpecs() {
  return Object.fromEntries(Object.entries(SPECS).map(([k, v]) => [k, { ...v, value: getSetting(k) }]));
}

export function fmtSetting(key) {
  const v = getSetting(key);
  if (key === 'allowOffline') return v ? 'ON' : 'OFF';
  if (key === 'gapMs' || key === 'backoffMs' || key === 'otpWaitMs' || key === 'otpTimeoutMs') {
    return v >= 60000 ? `${Math.round(v / 60000)} min` : `${Math.round(v / 1000)}s`;
  }
  return String(v);
}
