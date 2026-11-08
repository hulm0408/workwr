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
  importSessionJson,
  getSessionExportJson,
  syncCloudVaultNow,
  findAccountKeyByPhone,
  getNextAutoUserName,
} from './store.js';
import { queueShopStockJson } from './shop-bot-stock.js';
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
import { getOtpBotProfile } from './otp-bot-profiles.js';
import {
  snapshotTelegramOtpState,
  captureTelegramOtpWatermark,
  waitForTelegramOtpCode,
  discardCurrentTelegramNumber,
} from './telegram-otp-source.js';
import {
  worldBotLogin,
  worldBotDeleteAccount,
  worldBotPermanentLogout,
  worldBotConfig,
  normalizeWorldPhone,
  listWorldBotUsernames,
  currentWorldBotUsername,
  rotateWorldBot,
  shouldSwitchWorldBot,
} from './swiggy-world-bot.js';

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

// 📦 Har fresh session (Swiggy JSON) shop bot ke stock queue me jaata hai.
// 10 poore hone par wahi 10 JSON files @its_shop_bot ko documents ki tarah
// bhej di jaati hain (zip nahi). Koi bhi fail ho to run par asar nahi —
// queue safe rehti hai aur agle fresh par dobara try hota hai.
async function pushSessionToShopStock({ accountKey = '', phone = '', report = null } = {}) {
  if (!accountKey) return { ok: false, kind: 'no-account' };
  try {
    const json = getSessionExportJson(accountKey);
    if (!json) return { ok: false, kind: 'no-json' };
    return await queueShopStockJson({ accountKey, phone, json, report });
  } catch (e) {
    console.warn('[Pipeline] shop-stock queue:', e?.message || e);
    return { ok: false, kind: 'exception' };
  }
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
  // 🌍 Swiggy World Bot mode — Swiggy ka saara kaam @SwiggyByWorldBot karta
  // hai (koi proxy/WAF/bridge nahi). Alag chhota pipeline.
  if (String(otpCfg?.accountEngine || '').toLowerCase() === 'worldbot') {
    return processSingleNumberViaWorldBot({ userId, entry, report, otpCfg, shouldAbort, shouldSkip, markUsed });
  }
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
  const telegramRefreshLabel = getOtpBotProfile(entry?.otpBotProfile || '').refreshLabel || 'REFRESH';
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
      // 📦 Shop bot stock queue (10 poore hone par JSON files jayengi).
      await pushSessionToShopStock({ accountKey: loginAcc.accountKey, phone, report: say });
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
    await pushSessionToShopStock({ accountKey: freshAcc.accountKey, phone, report: say });
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

// ---------------------------------------------------------------------------
// 🌍 SWIGGY WORLD BOT PIPELINE — @SwiggyByWorldBot clicker
//
// Yahan Swiggy API / proxy / WAF solver kuch nahi. Flow:
//   1) World bot se OTP Login → bot khud Swiggy OTP bhejta hai
//   2) OTP Firebase inbox se aata hai (wahi device jisse number aaya)
//   3) Naam poochha gaya   → NAYA account → JSON file → bot DB me save
//      Naam nahi poochha   → PURANA account:
//        Order Hub → account → Delete Account → Delete OTP → deleted
//        → OTP Login dobara (ab naam poochhega) → fresh JSON
//   4) Best-effort: Switch Accounts → account → Permanently Logged Out
//   5) JSON owner ko .json file ke roop me jata hai (engine ka sendSession)
//
// Outcomes wahi hain jo engine samajhta hai: fresh_new / fresh_after_delete,
// one-shot OTP failures, skipped_delete_blocked, deferred_*.
// ---------------------------------------------------------------------------
export async function processSingleNumberViaWorldBot({
  userId = 'autopilot',
  entry,
  report = null,
  otpCfg = {},
  shouldAbort = null,
  shouldSkip = null,
  markUsed = true,
} = {}) {
  const phone = normalizeWorldPhone(entry?.phone);
  if (!phone) return { ok: false, kind: 'failed_bad_entry', phone: '', reason: 'Entry me phone nahi hai' };

  const deviceIds = entry?.deviceId ? [entry.deviceId] : null;
  // Numbers Hermes/Hathi/Firebase — teeno se aa sakte hain. OTP bhi wahin se.
  const telegramMode = isTelegramOtpEntry(entry, otpCfg);
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
    viaWorldBot: true,
  });

  if (markUsed) {
    const cooldown = getExtractedNumberCooldown(phone);
    if (cooldown.blocked) {
      return {
        ok: false,
        kind: 'deferred_number_cooldown',
        phone,
        reason: 'Ye number pehle extract/send ho chuka hai — 7-day cooldown chal raha hai',
        viaWorldBot: true,
      };
    }
  }

  const worldCfg = worldBotConfig();
  const waitMs = Number(otpCfg.waitMs ?? 3_000);
  // ⏱ Do ALAG budgets — owner ne saaf kaha: "number ki life 20 second nahi".
  //   • 20s  = bot ke screen par "OTP Sent" confirm hone ka budget
  //            (worldBotLogin → waitForOtpSent)
  //   • inbox = OTP SOURCE (Hermes/Firebase) me code aane ka intezaar — ye
  //            number ki jaan nahi, isliye 90s default (env se badla ja sakta).
  const worldOtpInboxMs = Math.min(
    180_000,
    Math.max(30_000, Number(
      otpCfg.worldOtpInboxTimeoutMs
      ?? process.env.SWIGGY_WORLD_OTP_INBOX_TIMEOUT_MS
      ?? 90_000
    ) || 90_000)
  );
  const timeoutMs = worldOtpInboxMs;
  const pollMs = Number(otpCfg.pollMs ?? 1_500);
  const acceptAnyAfterMs = Math.min(15_000, Math.floor(worldOtpInboxMs / 2));
  const telegramTimeoutMs = worldOtpInboxMs;
  // 🔄 Owner: "OTP Sent ke baad OTP bot me har second REFRESH dabao, 20s me
  // OTP aa jaye to copy karke world bot me do." Isliye world-bot flow me
  // refresh 1s par (purana 2.5s).
  const telegramRefreshMs = Math.max(
    800,
    Number(process.env.SWIGGY_OTP_REFRESH_MS ?? otpCfg.telegramOtpRefreshMs ?? 1_000) || 1_000
  );

  // Har OTP round ka apna baseline: purana SMS/OTP kabhi reuse na ho.
  // 🔖 Watermark = number/delete-trigger bhejne se THIK PEHLE ka OTP state.
  // Iske baad aaya ya edit hua code hi is number ka OTP hai — isliye jaldi
  // (2s me) aa gaya OTP bhi miss nahi hota.
  const makeOtpWatermark = () => async () => {
    if (telegramMode) {
      try { return await captureTelegramOtpWatermark(phone); } catch { return null; }
    }
    try { return await snapshotSeenOtpState(phone, { deviceIds }); } catch { return null; }
  };

  const makeOtpProvider = () => async (ctx = {}) => {
    if (aborted()) return { code: '', aborted: true };
    if (telegramMode) {
      // Pipeline ka diya watermark pehle; na ho to abhi ka state.
      let baseline = ctx?.watermark || null;
      if (!baseline) {
        try { baseline = await captureTelegramOtpWatermark(phone); } catch {
          try { baseline = await snapshotTelegramOtpState(phone); } catch {}
        }
      }
      const res = await waitForTelegramOtpCode(phone, {
        waitMs: 0,
        timeoutMs: telegramTimeoutMs,
        refreshMs: telegramRefreshMs,
        acceptAnyAfterMs,
        baseline,
        shouldAbort,
      });
      return res || { code: '' };
    }
    let seen = ctx?.watermark || null;
    if (!seen) {
      try { seen = await snapshotSeenOtpState(phone, { deviceIds }); } catch {}
    }
    const res = await waitForOtpCode(phone, {
      waitMs,
      timeoutMs,
      pollMs,
      acceptAnyAfterMs,
      excludeIds: seen || undefined,
      sinceTs: Date.now() - 30_000,
      deviceIds,
      shouldAbort,
    });
    return res || { code: '' };
  };

  const db = getDb();
  const existingKey = findAccountKeyByPhone(db.config?.accounts || {}, phone) || '';
  const existingName = existingKey ? (db.config.accounts[existingKey]?.name || existingKey) : '';

  const saveWorldSession = async (result, kind) => {
    const imported = importSessionJson(result.jsonText);
    if (!imported?.success) {
      return {
        ok: false,
        kind: 'failed_bad_entry',
        phone,
        reason: imported?.message || 'World Bot ka JSON parse nahi hua',
        viaWorldBot: true,
      };
    }
    syncCloudVaultNow(getDb()).catch(() => {});
    if (markUsed) {
      markLedger(phone, 'success', { accountKey: imported.key, kind: kind === 'new' ? 'new' : 'after-delete' });
      await markPoolStatus(entry, 'used');
    }
    await pushSessionToShopStock({ accountKey: imported.key, phone, report: say });
    return {
      ok: true,
      kind: kind === 'new' ? 'fresh_new' : 'fresh_after_delete',
      phone,
      accountKey: imported.key,
      account: imported.accountObj || getDb().config.accounts?.[imported.key] || null,
      viaWorldBot: true,
    };
  };

  const mapLoginFailure = (res, stage) => {
    const kind = String(res?.kind || '');
    if (kind === 'aborted') return abortResult(stage);
    // Setup problem (spare Telegram session missing/dead) = config issue, not
    // number issue. Engine ise alag handle karta hai (batch clear message ke
    // saath rukta hai, numbers jalte nahi).
    if (kind === 'worldbot_setup' || /session authorized nahi|setup missing|api_id|api_hash|login chal raha|telegram account|AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED/i.test(String(res?.reason || ''))) {
      return {
        ok: false,
        kind: 'worldbot_setup',
        phone,
        stage: 'worldbot_setup',
        reason: String(res.reason || 'Telegram session setup pending').slice(0, 220),
        viaWorldBot: true,
      };
    }
    const botTag = `@${res?.username || currentWorldBotUsername()}`;
    if (kind === 'failed_invalid_number') {
      return {
        ok: false, kind: 'failed_otp_send', phone, stage: 'worldbot_number',
        otpFailure: true, otpAttemptConsumed: true, otpAttempts: 1,
        reason: res.reason || 'World Bot ne number invalid bataya', viaWorldBot: true,
      };
    }
    // ⏱ 20s me OTP nahi aaya → number SKIP, bot wahi rahega (owner rule:
    // bina wajah bot switch bilkul nahi).
    if (kind === 'failed_otp_miss') {
      return {
        ok: false, kind: 'failed_otp_miss', phone, stage: 'otp_wait',
        otpFailure: true, otpAttemptConsumed: true, otpAttempts: 1,
        reason: res.reason || `${botTag}: OTP inbox me ${Math.round(worldOtpInboxMs / 1000)}s me code nahi aaya — number skip (bot wahi)`,
        viaWorldBot: true, switchBot: false,
      };
    }
    // OTP aa gaya par bot ne accept nahi kiya / bhejne me dikkat → number
    // aage, bot wahi.
    if (kind === 'failed_otp_verify') {
      return {
        ok: false, kind: 'failed_otp_verify', phone, stage: 'otp_verify',
        otpFailure: true, otpAttemptConsumed: true, otpAttempts: 1,
        reason: res.reason || `${botTag} ne OTP accept nahi kiya`,
        viaWorldBot: true, switchBot: false,
      };
    }
    // ❌ Swiggy ne khud OTP bhejne se mana kiya ("account suspended" /
    // "login attempts exceeded") → ye NUMBER ka faisla hai: retry nahi,
    // bot bhi nahi badalta.
    if (kind === 'number_blocked') {
      try {
        markLedger(phone, 'skipped', {
          reason: String(res?.reason || 'Swiggy ne OTP block kiya').slice(0, 160),
          kind: 'worldbot-blocked',
        });
      } catch {}
      return {
        ok: false, kind: 'failed_otp_send', phone, stage: 'worldbot_otp_send',
        otpFailure: true, otpAttemptConsumed: true, otpAttempts: 1,
        code: res?.code || 'WORLDBOT_BLOCKED',
        reason: res?.reason || `${botTag} ne OTP bhejne se mana kiya`,
        viaWorldBot: true, switchBot: false,
      };
    }
    // ✅ Sirf YAHAN bot badalta hai: bot OTP bhej hi na paye ya queue me
    // 20s se zyada atka reh jaye.
    if (kind === 'failed_otp_send' || kind === 'queued_timeout' || kind === 'bot_unreachable') {
      return {
        ok: false, kind: 'failed_otp_send', phone, stage: 'worldbot_otp_send',
        otpFailure: true, otpAttemptConsumed: true, otpAttempts: 1,
        code: kind === 'queued_timeout' ? 'WORLDBOT_QUEUE' : (res?.code || 'WORLDBOT_SEND'),
        reason: res.reason || `${botTag} OTP bhej nahi paya`,
        viaWorldBot: true, switchBot: true,
      };
    }
    // Baaki flow atka (button/JSON/naam) = number ka faisla, bot nahi badalta.
    return {
      ok: false,
      kind: 'deferred_swiggy_transient',
      phone,
      code: res?.code || 'WORLDBOT',
      reason: `WorldBot ${botTag}: ${res?.reason || 'flow fail'}`,
      viaWorldBot: true,
      switchBot: false,
    };
  };

  // Ek bot par poora flow (login → new/old → delete → fresh → logout).
  const runFlowOnBot = async (botUsername) => {
    const cfg = { ...worldCfg, username: botUsername };

    await say(section('🌍 World Bot — Login Shuru', [
      `📱 <b>Number:</b> <code>${esc(phone)}</code>`,
      `🤖 Bot: <code>@${esc(botUsername)}</code> · koi proxy/WAF nahi`,
      telegramMode
        ? '→ Number + OTP OTP-bot chat se · account Swiggy World Bot se banega'
        : '→ /start → Login → OTP Login → number → OTP (Firebase inbox se)',
      existingKey ? sub('Is number ka purana saved account hai — bot naam na poochhe to delete flow chalega.') : '',
    ].filter(Boolean).join('\n')));
    if (aborted()) return abortResult('before-login');

    // ---- Step 1: World bot se login (bot khud OTP bhejta hai) ----
    const first = await worldBotLogin({
      phone,
      otpProvider: makeOtpProvider(),
      otpWatermark: makeOtpWatermark(),
      nameProvider: async () => existingName || getNextAutoUserName(),
      report: say,
      shouldAbort,
      config: cfg,
    });
    if (!first.ok) return mapLoginFailure(first, 'worldbot_login');
    if (aborted()) return abortResult('after-login');

    // 🆕 Naya account — naam poochha gaya → seedha save + JSON file
    if (first.askedName) {
      await say(section('🆕 World Bot — Naya Account (naam poochha)', [
        `📱 <code>${esc(phone)}</code> · @${esc(botUsername)} · JSON aa gaya, save kar raha hoon…`,
      ].join('\n')));
      return saveWorldSession(first, 'new');
    }

    // ---- ♻️ Purana account — delete → phir fresh login ----
    await say(section('♻️ World Bot — Purana Account Mila', [
      `📱 <code>${esc(phone)}</code> · @${esc(botUsername)}`,
      '→ Bot ne naam <b>nahi</b> poochha = account purana hai.',
      '→ Order Hub → account → Delete Account → Delete OTP → phir fresh login.',
    ].join('\n')));
    if (aborted()) return abortResult('before-delete');

    const del = await worldBotDeleteAccount({
      phone,
      otpProvider: makeOtpProvider(),
      otpWatermark: makeOtpWatermark(),
      report: say,
      shouldAbort,
      config: cfg,
    });
    if (!del.ok) {
      if (del.kind === 'aborted') return abortResult('delete');
      if (del.kind === 'deferred_delete_otp_miss' || del.kind === 'delete_otp_rejected') {
        if (markUsed) markLedger(phone, 'deferred', { reason: del.reason || 'delete OTP miss', kind: 'worldbot-delete' });
        return {
          ok: false,
          kind: 'deferred_delete_otp_miss',
          phone,
          stage: 'delete_otp_wait',
          otpFailure: true,
          otpAttemptConsumed: true,
          otpAttempts: 1,
          reason: del.reason || 'Delete OTP nahi mila / accept nahi hua',
          viaWorldBot: true,
          switchBot: false,
        };
      }
      if (markUsed) {
        markLedger(phone, 'skipped', { reason: del.reason || 'worldbot delete blocked', kind: 'worldbot-delete' });
        await markPoolStatus(entry, 'skipped');
      }
      // Bot hi na mile to is number ko dobara try nahi karte, par agli baar
      // ke liye bot rotate kar dete hain (bot ki galti, number ki nahi).
      const rotateOnly = del.kind === 'bot_unreachable';
      return {
        ok: false,
        kind: del.kind === 'bot_unreachable' ? 'bot_unreachable' : 'skipped_delete_blocked',
        phone,
        reason: del.reason || `World Bot delete fail (${del.kind})`,
        viaWorldBot: true,
        switchBot: false,
        rotateOnly,
      };
    }

    // Bot side delete OK — apne DB/vault se bhi purana account hatao.
    if (existingKey) {
      try { deleteAccount(existingKey, { purgeVault: true }); } catch (e) { console.warn('[Pipeline] worldbot purge:', e?.message); }
      syncCloudVaultNow(getDb()).catch(() => {});
    }
    if (aborted()) return abortResult('after-delete');

    // ---- Fresh login (ab naam poochhna chahiye) ----
    await say(section('✅ World Bot — Delete Ho Gaya — Fresh Login', [
      `📱 <code>${esc(phone)}</code> · @${esc(botUsername)}`,
      '→ Main Menu → Login → OTP Login → wahi number → OTP → naam (is baar naya account banega).',
      '→ JSON aa gaya to seedha bhej denge — beech me kuch nahi.',
    ].join('\n')));
    const again = await worldBotLogin({
      phone,
      otpProvider: makeOtpProvider(),
      otpWatermark: makeOtpWatermark(),
      nameProvider: async () => existingName || getNextAutoUserName(),
      report: say,
      shouldAbort,
      config: cfg,
      fresh: true,
    });
    if (!again.ok) return mapLoginFailure(again, 'worldbot_fresh_login');
    if (!again.askedName) {
      if (markUsed) {
        markLedger(phone, 'skipped', { reason: 'delete ke baad bhi account purana lag raha hai', kind: 'worldbot' });
        await markPoolStatus(entry, 'skipped');
      }
      return {
        ok: false,
        kind: 'skipped_delete_blocked',
        phone,
        reason: 'Delete ke baad bhi World Bot ne naam nahi poochha — account abhi bhi purana hai',
        viaWorldBot: true,
      };
    }

    const saved = await saveWorldSession(again, 'after-delete');

    // Owner ka aakhri step: Switch Accounts → account → Permanently Logged Out.
    // Best-effort — fail ho to fresh session par koi asar nahi.
    if (saved.ok && cfg.logoutAfterDelete) {
      try {
        const out = await worldBotPermanentLogout({ phone, shouldAbort, config: cfg });
        if (!out?.ok) console.warn(`[Pipeline] worldbot permanent logout skip: ${out?.reason || out?.kind}`);
      } catch (e) {
        console.warn('[Pipeline] worldbot permanent logout:', e?.message);
      }
    }
    return saved;
  };

  // 🔁 BOT FAILOVER — owner ka final rule: ek hi bot par kaam. Bot SIRF tab
  // badalta hai jab wo OTP bhej hi na paye (ya queue 20s se zyada le jaye).
  // OTP 20s me nahi aaya / OTP galat / delete fail → number aage, bot wahi.
  // Ek number par max `min(pool, 3)` bots (poora pool ek number par nahi).
  const bots = listWorldBotUsernames();
  const maxTries = Math.max(1, Math.min(bots.length, 3));
  let lastResult = null;
  try {
    for (let round = 0; round < maxTries; round++) {
      if (aborted()) return abortResult('before-worldbot');
      const botUsername = currentWorldBotUsername();
      const result = await runFlowOnBot(botUsername);
      if (result?.ok) return result;
      lastResult = result;

      // rotateOnly = is number par retry nahi, bas agle number ke liye bot
      // badal do (jaise delete ke waqt bot hi na mile).
      if (result?.rotateOnly) {
        rotateWorldBot(`${result.kind}: ${result.reason || ''}`.slice(0, 140));
        return result;
      }
      const canSwitch = shouldSwitchWorldBot(result) && round + 1 < maxTries;
      if (!canSwitch) {
        // Owner rule: bina OTP-send fail / queue-timeout ke bot NAHI badalta.
        return result;
      }

      const nextBot = rotateWorldBot(`${result.kind}: ${result.reason || ''}`.slice(0, 140));
      await say(section('🔁 World Bot Switch', [
        `› <code>@${esc(botUsername)}</code> par error aaya — usi par atke nahi rehna.`,
        result.reason ? `<blockquote>${esc(String(result.reason).slice(0, 180))}</blockquote>` : '',
        `› Ab <code>@${esc(nextBot)}</code> par try (${round + 2}/${maxTries}) — sab bots same hain.`,
        sub('Bina error ke bot switch nahi hota; jo bot chal jaye wahi active rehta hai.'),
      ].filter(Boolean).join('\n')));
    }
    return lastResult;
  } catch (err) {
    if (aborted()) return abortResult('exception');
    console.error('[Pipeline/WorldBot]', err?.stack || err?.message);
    return {
      ok: false,
      kind: 'deferred_swiggy_transient',
      phone,
      code: 'WORLDBOT_EXCEPTION',
      reason: `WorldBot: ${String(err?.message || err).slice(0, 180)}`,
      viaWorldBot: true,
      switchBot: true,
    };
  }
}
