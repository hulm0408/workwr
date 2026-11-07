// ===== Number pipeline — EK number ka poora lifecycle (single + batch dono ke liye) =====
//
// processSingleNumber() in sab scenarios ko handle karta hai:
//   🆕 naya number  → OTP → verify/register → session save          → fresh_new
//   ♻️ purana number → login → Delete OTP → verify delete →
//        • charges/order/wallet/other block                          → skipped_delete_blocked
//        • delete OTP hi nahi aaya (window me)                       → deferred_delete_otp_miss
//        • delete SUCCESS → purge → usi number se fresh registration → fresh_after_delete
//   ⚠️ infrastructure outcomes (engine alag tarah handle karta hai):
//        • Swiggy rate limit        → rate_limited      (backoff)
//        • Swiggy security check    → security_challenge (engine auto-recover: defer + IP cool-down)
//        • Swiggy/proxy 5xx/network → deferred_swiggy_transient (number safe, proxy rotate + retry)
//        • OTP send/miss/verify fail→ failed_*           (agla number)
//        • STOP dabane par           → aborted            (number untouched/retryable)
//
// Har outcome ka ledger + Firebase pool marking yahin hota hai.

import {
  getDb,
  saveDb,
  deleteAccount,
  syncCloudVaultNow,
  findAccountKeyByPhone,
  getNextAutoUserName,
} from './store.js';
import {
  requestSwiggyOtpViaBridge,
  requestSwiggyDeleteOtpViaBridge,
  verifySwiggyOtpViaBridge,
  verifyAndDeleteSwiggyAccountViaBridge,
  signupSwiggyViaBridge,
  setSwiggyBridgeSessionProgressReporter,
  setSwiggyBridgeSessionAbortChecker,
} from './swiggy-bridge.js';
import {
  snapshotSeenOtpState,
  waitForOtpCode,
  markPoolNumberStatus,
  fetchDeviceLastActivityMs,
  doubledWidenWindowMs,
} from './firebase-numbers.js';
import { esc, section, sub, field } from './rich-text.js';
import { normalizeIndianMobileNumber } from './phone-utils.js';
import {
  snapshotTelegramOtpState,
  waitForTelegramOtpCode,
  discardCurrentTelegramNumber,
} from './telegram-otp-source.js';

// ---------------------------------------------------------------------------
// Ledger (db.json → premiumFlow.used) + fresh-selection helpers
// ---------------------------------------------------------------------------
// Boss ka hard rule: jis number ka fresh session ek baar extract/send ho
// gaya, woh number 7 din se pehle dobara process NAHI hoga. Ledger local
// db ke saath cloud vault me bhi sync hota hai (store.js snapshot), warna
// Render restart/deploy par sirf accounts wapas aate aur used-list ud jati.
export const EXTRACTED_NUMBER_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1e12) return value;
    if (value > 1e9) return value * 1000;
    return 0;
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function ledgerTimestampMs(entry) {
  return timestampMs(
    entry?.extractedAt || entry?.sentAt || entry?.at || entry?.updatedAt || entry?.createdAt || ''
  );
}

function isExtractedLedgerStatus(status) {
  return /^(success|extracted|sent)$/i.test(String(status || '').trim());
}

function savedSessionTimestampsByPhone(db) {
  const out = new Map();
  const add = (rawPhone, value) => {
    const phone = normalizeIndianMobileNumber(rawPhone);
    if (!phone || !value || typeof value !== 'object') return;
    const ts = timestampMs(value.savedAt || value.updatedAt || value.createdAt || value.at || '');
    if (ts && ts > (out.get(phone) || 0)) out.set(phone, ts);
  };

  for (const [key, acc] of Object.entries(db?.config?.accounts || {})) {
    if (!acc || acc.isLoggedIn === false || acc.isLoggedOut || acc.sessionExpired) continue;
    if (!(acc.cookies || acc.tid || acc.token || acc._session_tid || acc.isLoggedIn)) continue;
    add(acc.phone || acc.mobile || String(key).replace(/^acc_/, ''), acc);
  }
  for (const [key, value] of Object.entries(db?.sessionVault || {})) {
    add(value?.phone || value?.mobile || value?.account || String(key).replace(/^acc_/, ''), value);
  }
  return out;
}

function extractedCooldownFromMaps(phone, { now = Date.now(), used = {}, savedSessions = new Map() } = {}) {
  const cleanPhone = normalizeIndianMobileNumber(phone) || String(phone || '');
  const entry = used?.[cleanPhone] || used?.[phone] || null;
  let extractedAtMs = 0;
  let source = '';

  if (entry && isExtractedLedgerStatus(entry.status)) {
    extractedAtMs = ledgerTimestampMs(entry);
    source = 'ledger';
    if (!extractedAtMs) {
      // Purani/malformed success entry ka time hi na mile to andazay se
      // number ko release mat karo — boss ka 7-day rule fail-closed hai.
      return {
        blocked: true,
        extractedAtMs: 0,
        cooldownUntilMs: null,
        remainingMs: null,
        source,
      };
    }
  } else if (!entry) {
    // Ledger kisi restart/deploy me reh gaya ho to saved account/session
    // ka savedAt hi pichhle extraction ka saboot hai. Ledger maujood ho
    // to wahi authoritative hai; account baad me use honay se savedAt
    // badal bhi sakta hai, isliye use ledger ke upar nahi lagate.
    extractedAtMs = Number(savedSessions?.get(cleanPhone) || 0);
    source = extractedAtMs ? 'saved-session' : '';
  }

  if (!extractedAtMs) {
    return { blocked: false, extractedAtMs: 0, cooldownUntilMs: 0, remainingMs: 0, source: '' };
  }
  const cooldownUntilMs = extractedAtMs + EXTRACTED_NUMBER_COOLDOWN_MS;
  return {
    blocked: now < cooldownUntilMs,
    extractedAtMs,
    cooldownUntilMs,
    remainingMs: Math.max(0, cooldownUntilMs - now),
    source,
  };
}

function premiumSelectionMaps(opts = {}) {
  let used = opts.ledger || null;
  let savedSessions = opts.savedSessions || null;
  if (!used || !savedSessions) {
    try {
      const db = opts.db || getDb();
      if (!used) used = db?.premiumFlow?.used || {};
      if (!savedSessions) savedSessions = savedSessionTimestampsByPhone(db);
    } catch {
      if (!used) used = {};
      if (!savedSessions) savedSessions = new Map();
    }
  }
  return { used, savedSessions };
}

export function getExtractedNumberCooldown(phone, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const { used, savedSessions } = premiumSelectionMaps(opts);
  return extractedCooldownFromMaps(phone, { now, used, savedSessions });
}

export function isPhoneBlockedByPremiumLedger(phone, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const { used, savedSessions } = premiumSelectionMaps(opts);
  const cleanPhone = normalizeIndianMobileNumber(phone) || String(phone || '');
  const entry = used?.[cleanPhone] || used?.[phone] || null;
  if (entry && !isExtractedLedgerStatus(entry.status)) return true;
  return extractedCooldownFromMaps(phone, { now, used, savedSessions }).blocked;
}

export function getPremiumLedger() {
  try {
    const db = getDb();
    if (!db.premiumFlow) db.premiumFlow = {};
    if (!db.premiumFlow.used) db.premiumFlow.used = {};
    return db.premiumFlow.used;
  } catch {
    return {};
  }
}

export function markLedger(phone, status, extra = {}) {
  try {
    const db = getDb();
    if (!db.premiumFlow) db.premiumFlow = {};
    if (!db.premiumFlow.used) db.premiumFlow.used = {};
    const at = new Date().toISOString();
    const record = { status, at, ...extra };
    if (isExtractedLedgerStatus(status) && !record.extractedAt) record.extractedAt = at;
    db.premiumFlow.used[phone] = record;
    saveDb(db);
    // Ledger ko bhi cloud vault snapshot ke saath bhej do. Warna account
    // to restart ke baad wapas aa jata tha, magar "ye number nikal chuka
    // hai" wali list local disk ke saath ghayab ho jati thi.
    void syncCloudVaultNow(getDb()).catch(() => {});
  } catch (e) {
    console.warn('[Pipeline] ledger save failed:', e?.message);
  }
}

export async function markPoolStatus(entry, status) {
  if (entry?.noPatch || entry?.source === 'telegram' || entry?.otpProvider === 'telegram') return;
  try {
    await markPoolNumberStatus(entry, status);
  } catch (e) {
    console.warn('[Pipeline] Firebase pool status skipped:', e?.message);
  }
}

export function freshEntriesFrom(pool, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const { used, savedSessions } = premiumSelectionMaps(opts);
  return (pool || []).filter((n) => {
    if (/^(used|skipped|deferred)$/i.test(String(n.status || '').trim())) return false;
    const entry = used?.[n.phone] || null;
    if (entry && !isExtractedLedgerStatus(entry.status)) return false;
    return !extractedCooldownFromMaps(n.phone, { now, used, savedSessions }).blocked;
  });
}

// Pakke ONLINE devices pehle, phir jinke status ka pata nahi, aur aakhir
// me pakke offline. Pehle unknown bhi online wale hi bucket me ghul jata
// tha; ab asal ONLINE saboot wale devices ko pehli tarjeeh milti hai.
export function preferOnline(entries) {
  const online = entries.filter((e) => e.online === true);
  const unknown = entries.filter((e) => e.online !== true && e.online !== false);
  const offline = entries.filter((e) => e.online === false);
  const shuffle = (arr) => arr.slice().sort(() => Math.random() - 0.5);
  return [...shuffle(online), ...shuffle(unknown), ...shuffle(offline)];
}

export function isTelegramOtpEntry(entry = null, otpCfg = {}) {
  const entrySource = String(entry?.otpProvider || entry?.source || '').trim().toLowerCase();
  if (['telegram', 'hermes', 'hermeshu', 'telegram-hermes'].includes(entrySource)) return true;
  if (entry?.telegramBotUsername || String(entry?.deviceId || '').startsWith('hermes:')) return true;
  const cfgSource = String(otpCfg?.numberSource || otpCfg?.source || '').trim().toLowerCase();
  if (['telegram', 'hermes', 'hermeshu', 'telegram-hermes'].includes(cfgSource)) return true;
  return otpCfg?.telegramOtpMode === true;
}

// ---------------------------------------------------------------------------
// OTP → verify ka ONE-SHOT shared round
// ---------------------------------------------------------------------------
// Latest owner rule: ek number par OTP miss/verify failure ek baar ho jaye
// to dusra code, dusra verify ya same-number retry bilkul nahi. Engine
// route recovery karke seedha NEW NUMBER lega. Signup completion isi ek
// OTP ke saath wala registration step hai — ye dusra OTP try nahi hai.
async function grabAndVerifyRound({
  userId,
  phone,
  deviceIds,
  seen,
  waitCfg,
  report,
  waitText,
  shouldAbort,
  shouldSkip = null,
  waitOtp = null,
  sourceLabel = 'Firebase SMS inbox',
}) {
  const skipRequested = () => {
    try { return Boolean(shouldSkip?.()); } catch { return false; }
  };
  const aborted = () => Boolean(skipRequested() || (shouldAbort && shouldAbort()));
  const abortStatus = (stage) => ({
    status: skipRequested() ? 'manual_skip' : 'aborted',
    stage,
    manualSkip: skipRequested(),
  });
  const waitOtpCode = typeof waitOtp === 'function' ? waitOtp : waitForOtpCode;

  if (aborted()) return abortStatus('otp-wait');
  if (report && waitText) await report(waitText);
  if (aborted()) return abortStatus('otp-wait');

  const otp1 = await waitOtpCode(phone, { ...waitCfg, excludeIds: seen, deviceIds, shouldAbort: aborted });
  if (!otp1?.code) {
    if (otp1?.aborted || aborted()) return abortStatus('otp-wait');
    // Khali reason = card/console par "failed_otp_miss |" ke baad kuch nahi
    // dikhta tha. waitForOtpCode ka error nahi to bhi window ka bata do.
    return {
      status: 'miss',
      stage: 'otp_wait',
      otpFailure: true,
      otpAttemptConsumed: true,
      otpAttempts: 1,
      reason: otp1?.error
        || `OTP ${Math.max(1, Math.round((Number(waitCfg.timeoutMs) || 90_000) / 1000))}s window me ${sourceLabel} me nahi mila (SMS abhi tak show/forward nahi hua)`,
    };
  }

  if (aborted()) return abortStatus('before-verify');
  const verifyOnce = async (code) => {
    let v = await verifySwiggyOtpViaBridge(userId, code);
    if (!v?.success && !v?.aborted && (v?.isNewUser || v?.needsSignup)) {
      v = await signupSwiggyViaBridge(userId, getNextAutoUserName());
    }
    return v;
  };

  const v = await verifyOnce(otp1.code);
  if (skipRequested() || v?.aborted || v?.code === 'ABORTED') return abortStatus('verify');
  if (v?.success) return { status: 'ok', account: v, otpAttempts: 1 };

  const failure = {
    stage: 'otp_verify',
    otpFailure: true,
    otpAttemptConsumed: true,
    otpAttempts: 1,
  };
  if (v?.code === 'SWIGGY_WAF_COOLDOWN') return { ...failure, status: 'waf_cooldown', reason: v?.message || '', cooldownMs: Number(v?.cooldownMs) || 60_000 };
  if (v?.code === 'SWIGGY_RATE_LIMIT') return { ...failure, status: 'rate_limited', reason: v?.message || '' };
  if (v?.code === 'SWIGGY_SECURITY_CHALLENGE') return { ...failure, status: 'security_challenge', reason: v?.message || '' };
  if (aborted()) return abortStatus('verify');
  return { ...failure, status: 'failed', reason: v?.message || '', swiggyText: v?.swiggyStatus || '' };
}

// OTP-send failures ko engine ke samajhne wali shakl do. Route/WAF/5xx
// ki recovery engine karega, lekin latest one-shot rule ke tehat ye
// number isi run me dobara nahi uthega — recovery sirf agle NEW number
// ke liye hai. Isi liye har send failure `otpFailure` consumed hai.
export function _classifyOtpSendFailure(otpReq, phone, {
  failKind = 'failed_otp_send',
  stage = 'otp_send',
} = {}) {
  if (!otpReq || otpReq.success) return null;
  const code = String(otpReq.code || '');
  const httpStatus = Number(otpReq.httpStatus ?? otpReq.status) || 0;
  const reason = otpReq.message || 'Swiggy OTP send fail';
  const base = {
    ok: false,
    phone,
    code: code || undefined,
    httpStatus: httpStatus || undefined,
    stage,
    reason,
    otpFailure: true,
    otpAttemptConsumed: true,
    otpAttempts: 1,
  };

  if (code === 'SWIGGY_WAF_COOLDOWN') {
    return { ...base, kind: 'waf_cooldown', cooldownMs: Number(otpReq.cooldownMs) || 60_000 };
  }
  if (code === 'SWIGGY_RATE_LIMIT') return { ...base, kind: 'rate_limited' };
  if (code === 'SWIGGY_SECURITY_CHALLENGE') return { ...base, kind: 'security_challenge' };

  const isTransient =
    code === 'SWIGGY_SERVER_ERROR' ||
    code === 'SYSTEM_ERROR' ||
    code === 'NO_RESPONSE' ||
    (otpReq.retryable === true && httpStatus >= 500);
  if (isTransient) {
    return { ...base, kind: 'deferred_swiggy_transient', retryable: false, routeRetryable: true };
  }

  return { ...base, kind: failKind };
}

// ---------------------------------------------------------------------------
// Main: ek number ko shuru se end tak
// ---------------------------------------------------------------------------
export async function processSingleNumber({
  userId,
  entry,
  report = null,            // async (text) => {} — stage cards (caller buttons lagata hai)
  otpCfg = {},
  shouldAbort = null,
  shouldSkip = null,
  markUsed = true,
}) {
  const phone = entry?.phone;
  if (!phone) return { ok: false, kind: 'failed_bad_entry', phone: '', reason: 'Entry me phone nahi hai' };
  const telegramMode = isTelegramOtpEntry(entry, otpCfg);

  // 7-day extracted-number cooldown — selection ke ilawa yahan bhi hard
  // gate hai. Pehle retry-later queue ki purani entry ledger check bypass
  // karke wohi number dobara utha sakti thi jo thodi der pehle extract /
  // send ho chuka tha. Ab kisi bhi rasty se aaye, OTP se pehle ruk jayega.
  if (markUsed) {
    const cooldown = getExtractedNumberCooldown(phone);
    if (cooldown.blocked) {
      const until = cooldown.cooldownUntilMs
        ? new Date(cooldown.cooldownUntilMs).toISOString()
        : 'unknown (purani success entry me timestamp nahi)';
      if (telegramMode) discardCurrentTelegramNumber(phone);
      return {
        ok: false,
        kind: 'deferred_number_cooldown',
        phone,
        extractedAtMs: cooldown.extractedAtMs || null,
        cooldownUntilMs: cooldown.cooldownUntilMs,
        remainingMs: cooldown.remainingMs,
        reason: `Ye number pehle extract/send ho chuka hai — 7-day cooldown ${until} tak hai, OTP nahi bheja`,
      };
    }
  }

  const deviceIds = !telegramMode && entry?.deviceId ? [entry.deviceId] : null;
  const say = async (text) => { if (report) { try { await report(text); } catch {} } };
  const skipRequested = () => {
    try { return Boolean(shouldSkip?.()); } catch { return false; }
  };
  const aborted = () => Boolean(skipRequested() || (shouldAbort && shouldAbort()));
  const abortResult = (stage) => ({
    ok: false,
    kind: skipRequested() ? 'manual_skip' : 'aborted',
    phone,
    stage,
    manualSkip: skipRequested(),
    reason: skipRequested() ? 'Owner ne current number SKIP kar diya' : '',
  });
  const registerBridgeSessionHooks = () => {
    try { setSwiggyBridgeSessionProgressReporter(userId, say); } catch {}
    try { setSwiggyBridgeSessionAbortChecker(userId, skipRequested); } catch {}
  };
  const telegramBotLabel = `@${String(entry?.telegramBotUsername || 'HermeshuOTPROBOT').replace(/^@+/, '')}`;
  // HardXotp me REFRESH button nahi hota — wahan "VIEW MESSAGES" hi naya SMS
  // dekhta hai. UI wahi naam bole jo asal me click hoga.
  const telegramRefreshLabel = String(entry?.otpBotProfile || '') === 'chauhan' ? 'VIEW MESSAGES' : 'REFRESH';
  const sourceLabel = telegramMode ? telegramBotLabel : 'Firebase SMS inbox';

  const telegramTimeoutMs = Number(otpCfg.telegramOtpTimeoutMs ?? otpCfg.hermesOtpTimeoutMs ?? 20_000);
  const telegramRefreshMs = Number(otpCfg.telegramOtpRefreshMs ?? otpCfg.hermesOtpRefreshMs ?? 2_500);
  // Telegram mode me Hermes-specific values hi authoritative hain.
  // Autopilot ka generic Firebase config (90s timeout, 3s wait, 1.5s poll)
  // agar saath aa jaye to bhi Hermes flow 20s / 0s / Refresh interval se
  // hi chalega — warna "20 second me New Number" wala rule toot jata hai.
  const resolvedTimeoutMs = Number(telegramMode ? telegramTimeoutMs : (otpCfg.timeoutMs ?? 90_000));
  const waitCfg = {
    waitMs: Number(telegramMode ? (otpCfg.telegramWaitMs ?? otpCfg.hermesWaitMs ?? 0) : (otpCfg.waitMs ?? 3_000)),
    timeoutMs: resolvedTimeoutMs,
    pollMs: Number(telegramMode ? telegramRefreshMs : (otpCfg.pollMs ?? 1_500)),
    refreshMs: telegramRefreshMs,
    acceptAnyAfterMs: Number(
      telegramMode
        ? (otpCfg.telegramAcceptAnyAfterMs ?? otpCfg.hermesAcceptAnyAfterMs ?? Math.min(15_000, Math.floor((resolvedTimeoutMs || 20_000) * 0.75)))
        : (otpCfg.acceptAnyAfterMs ?? 15_000)
    ),
  };
  const snapshotOtp = () => telegramMode
    ? snapshotTelegramOtpState(phone)
    : snapshotSeenOtpState(phone, { deviceIds });
  const waitOtp = (targetPhone, cfg = {}) => {
    // Engine aksar STOP+SKIP combined callback bhejta hai, lekin pipeline
    // khud bhi dono ko hamesha combine rakhegi — warna shouldSkip akela
    // dene par delete-OTP wait SKIP ke bawjood poori window jala sakti thi.
    const callerAbort = cfg.shouldAbort;
    const combinedCfg = {
      ...cfg,
      shouldAbort: () => {
        try { return Boolean(aborted() || callerAbort?.()); } catch { return aborted(); }
      },
    };
    return telegramMode
      ? waitForTelegramOtpCode(targetPhone, combinedCfg)
      : waitForOtpCode(targetPhone, combinedCfg);
  };
  const otpWaitSeconds = Math.max(1, Math.round((waitCfg.timeoutMs || 0) / 1000));
  const waitLine = telegramMode
    ? `⏳ OTP bhej diya — <b>${esc(telegramBotLabel)}</b> me ${telegramRefreshLabel} dabate hue ${otpWaitSeconds}s tak naya OTP check kar raha hoon.`
    : '⏳ OTP bhej diya — Firebase inbox live poll kar raha hoon (jaise hi SMS forward hoga, code mil jayega).';
  const pollLine = telegramMode
    ? `${telegramRefreshLabel} par naya OTP check kar raha hoon (${otpWaitSeconds}s)…`
    : 'Firebase SMS inbox live poll kar raha hoon…';

  const mapVerify = (r, failKind) => {
    if (r.status === 'manual_skip' || skipRequested()) return abortResult(r.stage || 'otp_verify');
    const failure = {
      ok: false,
      phone,
      stage: r.stage || 'otp_verify',
      reason: r.reason || '',
      otpFailure: true,
      otpAttemptConsumed: true,
      otpAttempts: 1,
    };
    if (r.status === 'waf_cooldown') return { ...failure, kind: 'waf_cooldown', cooldownMs: r.cooldownMs };
    if (r.status === 'rate_limited') return { ...failure, kind: 'rate_limited' };
    if (r.status === 'security_challenge') return { ...failure, kind: 'security_challenge' };
    if (r.status === 'aborted') return abortResult(r.stage || 'otp_verify');
    if (r.status === 'miss') return { ...failure, kind: failKind };
    return { ...failure, kind: 'failed_verify', swiggyText: r.swiggyText };
  };

  try {
    if (aborted()) return abortResult('before-process');

    // ---- Step 0: DEVICE LAST-SEEN GATE ----
    // Andhere me random number try karne ka koi faida nahi — OTP sirf usi
    // device ko jayega jiski last activity (taaza forwarded message) window
    // ke andar hai. Stale device = OTP bheje baghair turant skip (na 100s
    // wait, na Swiggy rate-limit burn, na fail count). Window:
    // PREMIUM_DEVICE_ACTIVE_WINDOW_MS (default 60s; 0 = gate off).
    const activeWindowRaw = Number(otpCfg.activeWindowMs ?? process.env.PREMIUM_DEVICE_ACTIVE_WINDOW_MS ?? 60_000);
    const activeWindowMs = Number.isFinite(activeWindowRaw) && activeWindowRaw > 0 ? activeWindowRaw : 0;
    // Scanner ne agar device ko Firebase clients ke ONLINE status par
    // explicitly chuna hai, to use last incoming SMS ki age par dobara
    // mat roko. SMS na aana device ke band honay ka saboot nahi hai.
    const skipLastSeenGate = telegramMode || Boolean(otpCfg.skipLastSeenGate);
    if (deviceIds?.length && activeWindowMs > 0 && !skipLastSeenGate) {
      let lastActivityMs = null;
      // Engine ka parallel scan pehle hi ye device probe kar chuka hai to
      // wahin ka fresh result use karo (dobara Firebase GET = fuzool time).
      // Lekin 10s jaise sakht window me queue me baithe-baithe activity
      // purani ho sakti hai — aur beech me device par NAYI activity bhi aa
      // sakti hai. Isliye prechecked activity ab window se bahar ho to
      // number ko seedha stale kehne se pehle EK live refetch lazmi hai.
      const preTs = Number(otpCfg.precheckedLastActivityMs || 0) || null;
      const preAt = Number(otpCfg.precheckedAt || 0);
      const precheckNow = Date.now();
      const precheckStillFresh = Boolean(
        preTs && preAt &&
        (precheckNow - preAt) < 45_000 &&
        (precheckNow - preTs) <= activeWindowMs
      );
      if (precheckStillFresh) {
        lastActivityMs = preTs;
      } else {
        for (const devId of deviceIds) {
          const t = await fetchDeviceLastActivityMs(devId).catch(() => null);
          if (t && (!lastActivityMs || t > lastActivityMs)) lastActivityMs = t;
        }
      }
      const ageMs = lastActivityMs ? Date.now() - lastActivityMs : Infinity;
      // Autopilot ladder mode me scanner ne is device ko sabse taaza
      // available samajh kar chuna hota hai. Scan/queue/WAF warm-up ke
      // beech woh chuni hui limit se chand second bahar ho jaye to use
      // stale keh kar poora scan dobara ghumana pagalpan hai — wahin
      // window ko double karke aage badho (10s→20s→40s→…), jab tak asal
      // activity age andar na aa jaye. Sirf bilkul timestamp na hona stale hai.
      const allowDoubling = Boolean(otpCfg.widenLastSeenByDoubling);
      const effectiveWindowMs = allowDoubling && Number.isFinite(ageMs)
        ? doubledWidenWindowMs(activeWindowMs, ageMs)
        : activeWindowMs;
      if (!(ageMs <= effectiveWindowMs)) {
        return {
          ok: false, kind: 'deferred_device_stale', phone,
          lastActivityMs, ageMs: ageMs === Infinity ? null : ageMs, activeWindowMs: effectiveWindowMs,
          reason: lastActivityMs
            ? `Device ki last activity ${Math.round(ageMs / 1000)}s purani hai (limit ${Math.round(effectiveWindowMs / 1000)}s) — OTP nahi bheja`
            : 'Device ki koi recent activity mili hi nahi — OTP nahi bheja',
        };
      }
    }

    if (aborted()) return abortResult('before-otp-send');

    // ---- Step 1: Swiggy OTP bhejo (purana/naya Swiggy khud detect karta hai) ----
    const seen1 = await snapshotOtp();
    if (aborted()) return abortResult('before-otp-send');

    const db = getDb();
    const existingKey = findAccountKeyByPhone(db.config?.accounts || {}, phone) || '';
    const existingName = existingKey ? (db.config.accounts[existingKey]?.name || existingKey) : null;

    const otpReq = await requestSwiggyOtpViaBridge(userId, phone, existingKey, existingName);
    registerBridgeSessionHooks();
    if (aborted()) return abortResult('otp_send');
    if (!otpReq?.success) {
      return _classifyOtpSendFailure(otpReq, phone, {
        failKind: 'failed_otp_send',
        stage: 'otp_send',
      });
    }
    const isNew = Boolean(otpReq.isNewUser);
    await say(
      section(
        isNew ? '🆕 Naya Number — Fresh Registration' : '♻️ Purana Number — Delete + Fresh Login',
        [
          `📱 <b>Number:</b> <code>${esc(phone)}</code>`,
          isNew
            ? '→ Number Swiggy par pehle se nahi hai — seedha naya account banega.'
            : '→ Purana account mila: login → Settings → Delete Account → phir fresh registration.',
          '',
          sub(waitLine),
        ].join('\n')
      )
    );
    if (aborted()) return abortResult('after-send');

    // ---- Step 2: OTP lana + verify (new = yahin done; old = aage delete) ----
    const round1 = await grabAndVerifyRound({
      userId, phone, deviceIds, seen: seen1, waitCfg, report: say, shouldAbort, shouldSkip,
      waitOtp, sourceLabel,
      waitText: section('⏳ OTP Wait — Step 1/3', [
        `📱 <b>Number:</b> <code>${esc(phone)}</code>`,
        sub(pollLine),
      ].join('\n')),
    });
    if (round1.status !== 'ok') return mapVerify(round1, 'failed_otp_miss');

    if (aborted()) return abortResult('after-verify');
    const loginAcc = round1.account;
    syncCloudVaultNow(getDb()).catch(() => {});

    // 🆕 NAYA NUMBER — done!
    if (isNew) {
      if (markUsed) {
        markLedger(phone, 'success', { accountKey: loginAcc.accountKey, kind: 'new' });
        await markPoolStatus(entry, 'used');
      }
      return {
        ok: true, kind: 'fresh_new', phone,
        accountKey: loginAcc.accountKey, account: loginAcc,
      };
    }

    // ---- ♻️ PURANA NUMBER: Step 2/3 — Delete Account ----
    await say(section('♻️ Step 2/3 — Delete Account', [
      `📱 <b>Number:</b> <code>${esc(phone)}</code>`,
      sub('Login ho gaya — ab Settings → Delete Account ka OTP bhej raha hoon…'),
    ].join('\n')));
    if (aborted()) return abortResult('before-delete-request');

    const seen2 = await snapshotOtp();
    if (aborted()) return abortResult('before-delete-request');
    const delReq = await requestSwiggyDeleteOtpViaBridge(userId, phone, loginAcc.accountKey, loginAcc.name || null);
    if (aborted()) return abortResult('delete_otp_send');
    if (!delReq?.success) {
      const otpFlags = { stage: 'delete_otp_send', otpFailure: true, otpAttemptConsumed: true, otpAttempts: 1 };
      if (delReq?.code === 'SWIGGY_WAF_COOLDOWN') return { ok: false, kind: 'waf_cooldown', phone, cooldownMs: Number(delReq?.cooldownMs) || 60_000, reason: delReq?.message || '', ...otpFlags };
      if (delReq?.code === 'SWIGGY_RATE_LIMIT') return { ok: false, kind: 'rate_limited', phone, reason: delReq?.message || '', ...otpFlags };
      if (delReq?.code === 'SWIGGY_SECURITY_CHALLENGE') return { ok: false, kind: 'security_challenge', phone, reason: delReq?.message || '', ...otpFlags };
      if (markUsed) {
        markLedger(phone, 'skipped', { reason: String(delReq?.message || ''), accountKey: loginAcc.accountKey });
        await markPoolStatus(entry, 'skipped');
      }
      return {
        ok: false, kind: 'skipped_delete_blocked', phone,
        reason: String(delReq?.message || 'Delete possible nahi'), accountKey: loginAcc.accountKey, account: loginAcc,
        ...otpFlags,
      };
    }

    const otpD = await waitOtp(phone, { ...waitCfg, excludeIds: seen2, deviceIds, shouldAbort });
    if (!otpD?.code) {
      if (otpD?.aborted || aborted()) return abortResult('delete_otp_wait');
      if (markUsed) {
        markLedger(phone, 'deferred', { reason: 'delete OTP not received', accountKey: loginAcc.accountKey });
      }
      return {
        ok: false, kind: 'deferred_delete_otp_miss', phone,
        stage: 'delete_otp_wait', otpFailure: true, otpAttemptConsumed: true, otpAttempts: 1,
        reason: otpD?.error || 'Delete OTP window me nahi mila', accountKey: loginAcc.accountKey, account: loginAcc,
      };
    }
    if (aborted()) return abortResult('before-delete-verify');

    const delRes = await verifyAndDeleteSwiggyAccountViaBridge(userId, otpD.code, loginAcc.accountKey);
    if (aborted()) return abortResult('delete_otp_verify');
    if (!delRes?.success) {
      const otpFlags = { stage: 'delete_otp_verify', otpFailure: true, otpAttemptConsumed: true, otpAttempts: 1 };
      if (delRes?.code === 'SWIGGY_RATE_LIMIT') return { ok: false, kind: 'rate_limited', phone, reason: delRes?.message || '', ...otpFlags };
      if (delRes?.code === 'SWIGGY_SECURITY_CHALLENGE') return { ok: false, kind: 'security_challenge', phone, reason: delRes?.message || '', ...otpFlags };
      if (markUsed) {
        markLedger(phone, 'skipped', { reason: String(delRes?.message || ''), accountKey: loginAcc.accountKey });
        await markPoolStatus(entry, 'skipped');
      }
      return {
        ok: false, kind: 'skipped_delete_blocked', phone,
        reason: String(delRes?.message || 'Delete blocked'), accountKey: loginAcc.accountKey, account: loginAcc,
        ...otpFlags,
      };
    }

    // Swiggy se delete OK → bot DB + vault se purge (tabhi fresh login milega)
    deleteAccount(loginAcc.accountKey, { purgeVault: true });
    syncCloudVaultNow(getDb()).catch(() => {});
    if (aborted()) return abortResult('after-delete');

    // ---- Step 3/3: usi number se FRESH registration ----
    await say(section('✅ Step 3/3 — Delete Ho Gaya — Fresh Registration', [
      `📱 <b>Number:</b> <code>${esc(phone)}</code>`,
      sub('Swiggy account delete + bot DB purge done — ab fresh OTP bhej raha hoon…'),
    ].join('\n')));

    if (aborted()) return abortResult('before-fresh-otp-send');
    const seen3 = await snapshotOtp();
    if (aborted()) return abortResult('before-fresh-otp-send');
    const otpReq2 = await requestSwiggyOtpViaBridge(userId, phone, '', null);
    registerBridgeSessionHooks();
    if (aborted()) return abortResult('fresh_otp_send');
    if (!otpReq2?.success) {
      return _classifyOtpSendFailure(otpReq2, phone, {
        failKind: 'failed_fresh_otp_send',
        stage: 'fresh_otp_send',
      });
    }

    const round3 = await grabAndVerifyRound({
      userId, phone, deviceIds, seen: seen3, waitCfg, report: say, shouldAbort, shouldSkip,
      waitOtp, sourceLabel,
      waitText: section('⏳ Fresh OTP Wait — Step 3/3', [
        `📱 <b>Number:</b> <code>${esc(phone)}</code>`,
        sub(telegramMode
          ? `Fresh registration OTP — Hermes card par Refresh dabate hue naya OTP check kar raha hoon (${otpWaitSeconds}s)…`
          : 'Fresh registration OTP — inbox live poll kar raha hoon…'),
      ].join('\n')),
    });
    if (round3.status !== 'ok') return mapVerify(round3, 'failed_fresh_otp_miss');

    if (aborted()) return abortResult('after-fresh-verify');
    const freshAcc = round3.account;
    syncCloudVaultNow(getDb()).catch(() => {});
    if (markUsed) {
      markLedger(phone, 'success', { accountKey: freshAcc.accountKey, kind: 'after-delete' });
      await markPoolStatus(entry, 'used');
    }
    return {
      ok: true, kind: 'fresh_after_delete', phone,
      accountKey: freshAcc.accountKey, account: freshAcc,
    };
  } catch (err) {
    if (aborted()) return abortResult('exception');
    console.error('[Pipeline]', err?.stack || err?.message);
    return { ok: false, kind: 'failed_exception', phone, reason: String(err?.message || err) };
  } finally {
    if (telegramMode) discardCurrentTelegramNumber(phone);
  }
}
