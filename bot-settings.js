// ===== ⚙️ BOT SETTINGS — batch knobs bot UI se (env nahi chhedni padti) =====
//
// Storage: data/db.json → db.freshSettings = { target, maxMinutes, gapMs, ... }
// Missing knobs env (ya default) se fall back hote hain — backward compatible.
//
// Har set pehle validation + clamp — user galat value na daal paye.

import { getDb, saveDb } from './store.js';

const SPECS = {
  target:            { min: 1,    max: 5000, dflt: 100,    label: '🎯 Target (fresh sessions)' },
  concurrency:       { min: 1,    max: 10,   dflt: 10,     label: '⚡ Parallel lanes (numbers ek saath)' },
  maxMinutes:        { min: 5,    max: 1440, dflt: 120,    label: '⏱ Max time (minutes)' },
  gapMs:             { min: 0,    max: 300000, dflt: 6000, label: 'Gap between numbers (ms)' },
  backoffMs:         { min: 30000, max: 7200000, dflt: 900000, label: 'Rate-limit backoff (ms)' },
  otpWaitMs:         { min: 0,    max: 60000, dflt: 3000, label: 'OTP poll shuru karne se pehle wait (ms)' },
  otpTimeoutMs:      { min: 5000, max: 300000, dflt: 90000, label: 'OTP poll budget (ms)' },
  allowOffline:      { bool: true, dflt: false, label: 'Offline devices bhi try karein' },
  // 🔁 NEVER-STOP — owner ka pakka rule: "batch na ruke yaar".
  // ON: time-cap / fail-streak / rate-limit / WAF / 403 storm / pool khali
  //     par batch khatam NAHI hota — cool-off, route recovery, pool rescan
  //     karke khud aage badhta hai. Sirf TARGET ya manual STOP end karte hain.
  // OFF: purana behaviour (safety stop cards wapas).
  autoContinue:      { bool: true, dflt: true, label: '🔁 Never-stop mode (batch khud na ruke)' },
  telegramOtpMode:   { bool: true, dflt: false, label: '📨 Telegram Hermes mode (number + OTP Telegram bot se)' },
  telegramOtpTimeoutMs: { min: 5000, max: 180000, dflt: 20000, label: 'Hermes OTP Refresh budget (ms)' },
  telegramOtpRefreshMs: { min: 1000, max: 15000, dflt: 2500, label: 'Hermes Refresh interval (ms)' },
  // Kaunsa OTP bot — 'hermes' (@HermeshuOTPROBOT), 'hathi' (@Hathi_otp_bot)
  // ya 'chauhan' (@HardXotp_Bot). START par owner jo chunta hai wahi yahan
  // save ho jata hai.
  otpBotProfile:     { dflt: 'hermes', label: '📨 OTP bot (hermes = @HermeshuOTPROBOT, hathi = @Hathi_otp_bot, chauhan = @HardXotp_Bot)',
                       enum: ['hermes', 'hathi', 'chauhan'] },
};

const ENV_MAP = {
  target: 'PREMIUM_BATCH_TARGET',
  concurrency: 'PREMIUM_BATCH_CONCURRENCY',
  maxMinutes: 'PREMIUM_BATCH_MAX_MINUTES',
  gapMs: 'PREMIUM_BATCH_GAP_MS',
  backoffMs: 'PREMIUM_RATE_LIMIT_BACKOFF_MS',
  otpWaitMs: 'PREMIUM_OTP_WAIT_MS',
  otpTimeoutMs: 'PREMIUM_OTP_TIMEOUT_MS',
  allowOffline: 'PREMIUM_ALLOW_OFFLINE_DEVICES',
  autoContinue: 'PREMIUM_NEVER_STOP',
  telegramOtpMode: 'PREMIUM_TELEGRAM_OTP_MODE',
  telegramOtpTimeoutMs: 'TELEGRAM_OTP_TIMEOUT_MS',
  telegramOtpRefreshMs: 'TELEGRAM_OTP_REFRESH_MS',
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
    const envVal = String(process.env[ENV_MAP[key]] || '').trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(envVal)) return true;
    if (['0', 'false', 'no', 'off'].includes(envVal)) return false;
    return spec.dflt;
  }
  if (spec.enum) {
    const local = String(s[key] || '').trim().toLowerCase();
    if (spec.enum.includes(local)) return local;
    const envVal = String(process.env[ENV_MAP[key]] || '').trim().toLowerCase();
    if (spec.enum.includes(envVal)) return envVal;
    return spec.dflt;
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
  } else if (spec.enum) {
    const v = String(value || '').trim().toLowerCase();
    if (!spec.enum.includes(v)) return { ok: false, error: `${spec.label}: ${spec.enum.join(' / ')} me se chuno.` };
    s[key] = v;
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
  if (key === 'allowOffline' || key === 'telegramOtpMode' || key === 'autoContinue') return v ? 'ON' : 'OFF';
  if (key === 'otpBotProfile') return { hermes: 'Hermes', hathi: 'Hathi', chauhan: 'HardXotp' }[v] || 'Hermes';
  if (key === 'gapMs' || key === 'backoffMs' || key === 'otpWaitMs' || key === 'otpTimeoutMs' || key === 'telegramOtpTimeoutMs' || key === 'telegramOtpRefreshMs') {
    return v >= 60000 ? `${Math.round(v / 60000)} min` : `${Math.round(v / 1000)}s`;
  }
  return String(v);
}

// ---------------------------------------------------------------------------
// 🔁 AUTO-RESUME — process restart / deploy / GitHub-Actions runner badalne par
// batch khud wapas chale. Render free restart aur Actions ke ~6-ghante wale
// runner gap me batch yahin "ruk" jata tha; ab wanted flag db (aur cloud
// vault) me rehta hai aur boot par engine khud batch dobara shuru karta hai.
// Keys freshSettings ke andar hi rehti hain taaki vault sync (store.js) inhe
// bina kisi extra plumbing ke copy kare; SPECS me na hone se getSetting()
// inhe ignore karta hai.
// ---------------------------------------------------------------------------
const RESUME_KEY = '_autopilotResume';

export function setAutopilotResume(patch = {}) {
  const s = load();
  const cur = (s[RESUME_KEY] && typeof s[RESUME_KEY] === 'object') ? s[RESUME_KEY] : {};
  s[RESUME_KEY] = { ...cur, ...patch, savedAt: Date.now() };
  const db = getDb();
  db.freshSettings = s;
  saveDb(db);
  return s[RESUME_KEY];
}

export function getAutopilotResume() {
  const s = load();
  const cur = s[RESUME_KEY];
  return (cur && typeof cur === 'object') ? { ...cur } : null;
}

export function clearAutopilotResume() {
  const s = load();
  if (!s[RESUME_KEY]) return { ok: true, already: true };
  delete s[RESUME_KEY];
  const db = getDb();
  db.freshSettings = s;
  saveDb(db);
  return { ok: true, already: false };
}
