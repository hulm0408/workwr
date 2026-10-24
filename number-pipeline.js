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
} from './swiggy-bridge.js';
import {
  snapshotSeenOtpState,
  waitForOtpCode,
  markPoolNumberStatus,
  fetchDeviceLastActivityMs,
  doubledWidenWindowMs,
} from './firebase-numbers.js';
import { esc, section, sub, field } from './rich-text.js';

// ---------------------------------------------------------------------------
// Ledger (db.json → premiumFlow.used) + fresh-selection helpers
// ---------------------------------------------------------------------------
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
    db.premiumFlow.used[phone] = { status, at: new Date().toISOString(), ...extra };
    saveDb(db);
  } catch (e) {
    console.warn('[Pipeline] ledger save failed:', e?.message);
  }
}

export async function markPoolStatus(entry, status) {
  try {
    await markPoolNumberStatus(entry, status);
  } catch (e) {
    console.warn('[Pipeline] Firebase pool status skipped:', e?.message);
  }
}

export function freshEntriesFrom(pool) {
  const used = getPremiumLedger();
  return (pool || []).filter(
    (n) => !used[n.phone] && !/^(used|skipped|deferred)$/i.test(String(n.status || '').trim())
  );
}

// Online devices pehle (unme hi OTP aayega), phir offline fallback.
export function preferOnline(entries) {
  const online = entries.filter((e) => e.online !== false);
  const offline = entries.filter((e) => e.online === false);
  const shuffle = (arr) => arr.slice().sort(() => Math.random() - 0.5);
  return [...shuffle(online), ...shuffle(offline)];
}

// ---------------------------------------------------------------------------
// OTP → verify (+ ek baar retry) ka shared round
// ---------------------------------------------------------------------------
async function grabAndVerifyRound({
  userId,
  phone,
  deviceIds,
  seen,
  waitCfg,
  report,
  waitText,
  retryText,
  shouldAbort,
}) {
  const aborted = () => Boolean(shouldAbort && shouldAbort());

  if (report && waitText) await report(waitText);

  const otp1 = await waitForOtpCode(phone, { ...waitCfg, excludeIds: seen, deviceIds, shouldAbort });
  if (!otp1?.code) {
    if (otp1?.aborted) return { status: 'aborted', stage: 'otp-wait' };
    return { status: 'miss', reason: otp1?.error || '' };
  }

  const verifyOnce = async (code) => {
    let v = await verifySwiggyOtpViaBridge(userId, code);
    if (!v?.success && (v?.isNewUser || v?.needsSignup)) {
      v = await signupSwiggyViaBridge(userId, getNextAutoUserName());
    }
    return v;
  };

  let v = await verifyOnce(otp1.code);

  // Retry: verify fail hua to ek baar aur naya OTP dhundo (galat service ka code
  // ya late-arriving Swiggy code dono isi se bachte hain).
  if (!v?.success && !v?.code && !aborted()) {
    if (report && retryText) await report(retryText);
    const seen2 = {
      ids: new Set([...(seen?.ids || []), otp1.idKey].filter(Boolean)),
      codes: new Set([...(seen?.codes || []), otp1.code].filter(Boolean)),
    };
    const otp2 = await waitForOtpCode(phone, {
      ...waitCfg,
      timeoutMs: Math.min(Number(waitCfg.timeoutMs ?? 90_000), 60_000),
      excludeIds: seen2,
      deviceIds,
      shouldAbort,
    });
    if (otp2?.aborted) return { status: 'aborted', stage: 'otp-retry-wait' };
    if (otp2?.code) {
      const v2 = await verifyOnce(otp2.code);
      v = v2?.success ? v2 : (v2 || v);
    }
  }

  if (v?.success) return { status: 'ok', account: v };
  if (v?.code === 'SWIGGY_WAF_COOLDOWN') return { status: 'waf_cooldown', reason: v?.message || '', cooldownMs: Number(v?.cooldownMs) || 60_000 };
  if (v?.code === 'SWIGGY_RATE_LIMIT') return { status: 'rate_limited', reason: v?.message || '' };
  if (v?.code === 'SWIGGY_SECURITY_CHALLENGE') return { status: 'security_challenge', reason: v?.message || '' };
  if (aborted()) return { status: 'aborted', stage: 'verify' };
  return { status: 'failed', reason: v?.message || '', swiggyText: v?.swiggyStatus || '' };
}

// OTP-send failures ko engine ke samajhne wali shakl do. Khaas taur par
// Swiggy/proxy ke temporary 5xx ya network errors number ki galti NAHI hain:
// pehle ye sab `failed_otp_send` ban kar processed+failed count ho jate the
// aur number retry queue me bhi nahi jata tha. Ab ye alag transient outcome
// hai — engine number ko safe rakh kar proxy rotate + isi run me retry karega.
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
    return { ...base, kind: 'deferred_swiggy_transient', retryable: true };
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
  markUsed = true,
}) {
  const phone = entry?.phone;
  if (!phone) return { ok: false, kind: 'failed_bad_entry', phone: '', reason: 'Entry me phone nahi hai' };

  const deviceIds = entry?.deviceId ? [entry.deviceId] : null;
  const say = async (text) => { if (report) { try { await report(text); } catch {} } };
  const aborted = () => Boolean(shouldAbort && shouldAbort());

  const waitCfg = {
    waitMs: Number(otpCfg.waitMs ?? 3_000),
    timeoutMs: Number(otpCfg.timeoutMs ?? 90_000),
    pollMs: Number(otpCfg.pollMs ?? 1_500),
    acceptAnyAfterMs: Number(otpCfg.acceptAnyAfterMs ?? 15_000),
  };

  const mapVerify = (r, failKind) => {
    if (r.status === 'waf_cooldown') return { ok: false, kind: 'waf_cooldown', phone, cooldownMs: r.cooldownMs, reason: r.reason };
    if (r.status === 'rate_limited') return { ok: false, kind: 'rate_limited', phone, reason: r.reason };
    if (r.status === 'security_challenge') return { ok: false, kind: 'security_challenge', phone, reason: r.reason };
    if (r.status === 'aborted') return { ok: false, kind: 'aborted', phone, stage: r.stage };
    if (r.status === 'miss') return { ok: false, kind: failKind, phone, reason: r.reason };
    return { ok: false, kind: 'failed_verify', phone, reason: r.reason, swiggyText: r.swiggyText };
  };

  try {
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
    const skipLastSeenGate = Boolean(otpCfg.skipLastSeenGate);
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

    // ---- Step 1: Swiggy OTP bhejo (purana/naya Swiggy khud detect karta hai) ----
    const seen1 = await snapshotSeenOtpState(phone, { deviceIds });

    const db = getDb();
    const existingKey = findAccountKeyByPhone(db.config?.accounts || {}, phone) || '';
    const existingName = existingKey ? (db.config.accounts[existingKey]?.name || existingKey) : null;

    const otpReq = await requestSwiggyOtpViaBridge(userId, phone, existingKey, existingName);
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
          sub('⏳ OTP bhej diya — Firebase inbox live poll kar raha hoon (jaise hi SMS forward hoga, code mil jayega).'),
        ].join('\n')
      )
    );
    if (aborted()) return { ok: false, kind: 'aborted', phone, stage: 'after-send' };

    // ---- Step 2: OTP lana + verify (new = yahin done; old = aage delete) ----
    const round1 = await grabAndVerifyRound({
      userId, phone, deviceIds, seen: seen1, waitCfg, report: say, shouldAbort,
      waitText: section('⏳ OTP Wait — Step 1/3', [
        `📱 <b>Number:</b> <code>${esc(phone)}</code>`,
        sub('Firebase SMS inbox live poll kar raha hoon…'),
      ].join('\n')),
      retryText: section('↻ Verify Retry', [
        `📱 <b>Number:</b> <code>${esc(phone)}</code>`,
        sub('Pehla OTP verify nahi hua — inbox me ek nayi entry ka wait (max 60s).'),
      ].join('\n')),
    });
    if (round1.status !== 'ok') return mapVerify(round1, 'failed_otp_miss');

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
    if (aborted()) return { ok: false, kind: 'aborted', phone, stage: 'before-delete-request' };

    const seen2 = await snapshotSeenOtpState(phone, { deviceIds });
    const delReq = await requestSwiggyDeleteOtpViaBridge(userId, phone, loginAcc.accountKey, loginAcc.name || null);
    if (!delReq?.success) {
      if (delReq?.code === 'SWIGGY_WAF_COOLDOWN') return { ok: false, kind: 'waf_cooldown', phone, cooldownMs: Number(delReq?.cooldownMs) || 60_000, reason: delReq?.message || '' };
      if (delReq?.code === 'SWIGGY_RATE_LIMIT') return { ok: false, kind: 'rate_limited', phone, reason: delReq?.message || '' };
      if (delReq?.code === 'SWIGGY_SECURITY_CHALLENGE') return { ok: false, kind: 'security_challenge', phone, reason: delReq?.message || '' };
      if (markUsed) {
        markLedger(phone, 'skipped', { reason: String(delReq?.message || ''), accountKey: loginAcc.accountKey });
        await markPoolStatus(entry, 'skipped');
      }
      return {
        ok: false, kind: 'skipped_delete_blocked', phone,
        reason: String(delReq?.message || 'Delete possible nahi'), accountKey: loginAcc.accountKey, account: loginAcc,
      };
    }

    const otpD = await waitForOtpCode(phone, { ...waitCfg, excludeIds: seen2, deviceIds, shouldAbort });
    if (!otpD?.code) {
      if (otpD?.aborted) return { ok: false, kind: 'aborted', phone, stage: 'delete-otp-wait' };
      if (markUsed) {
        markLedger(phone, 'deferred', { reason: 'delete OTP not received', accountKey: loginAcc.accountKey });
      }
      return {
        ok: false, kind: 'deferred_delete_otp_miss', phone,
        reason: otpD?.error || 'Delete OTP window me nahi mila', accountKey: loginAcc.accountKey, account: loginAcc,
      };
    }

    const delRes = await verifyAndDeleteSwiggyAccountViaBridge(userId, otpD.code, loginAcc.accountKey);
    if (!delRes?.success) {
      if (delRes?.code === 'SWIGGY_RATE_LIMIT') return { ok: false, kind: 'rate_limited', phone, reason: delRes?.message || '' };
      if (delRes?.code === 'SWIGGY_SECURITY_CHALLENGE') return { ok: false, kind: 'security_challenge', phone, reason: delRes?.message || '' };
      if (markUsed) {
        markLedger(phone, 'skipped', { reason: String(delRes?.message || ''), accountKey: loginAcc.accountKey });
        await markPoolStatus(entry, 'skipped');
      }
      return {
        ok: false, kind: 'skipped_delete_blocked', phone,
        reason: String(delRes?.message || 'Delete blocked'), accountKey: loginAcc.accountKey, account: loginAcc,
      };
    }

    // Swiggy se delete OK → bot DB + vault se purge (tabhi fresh login milega)
    deleteAccount(loginAcc.accountKey, { purgeVault: true });
    syncCloudVaultNow(getDb()).catch(() => {});
    if (aborted()) return { ok: false, kind: 'aborted', phone, stage: 'after-delete' };

    // ---- Step 3/3: usi number se FRESH registration ----
    await say(section('✅ Step 3/3 — Delete Ho Gaya — Fresh Registration', [
      `📱 <b>Number:</b> <code>${esc(phone)}</code>`,
      sub('Swiggy account delete + bot DB purge done — ab fresh OTP bhej raha hoon…'),
    ].join('\n')));

    const seen3 = await snapshotSeenOtpState(phone, { deviceIds });
    const otpReq2 = await requestSwiggyOtpViaBridge(userId, phone, '', null);
    if (!otpReq2?.success) {
      return _classifyOtpSendFailure(otpReq2, phone, {
        failKind: 'failed_fresh_otp_send',
        stage: 'fresh_otp_send',
      });
    }

    const round3 = await grabAndVerifyRound({
      userId, phone, deviceIds, seen: seen3, waitCfg, report: say, shouldAbort,
      waitText: section('⏳ Fresh OTP Wait — Step 3/3', [
        `📱 <b>Number:</b> <code>${esc(phone)}</code>`,
        sub('Fresh registration OTP — inbox live poll kar raha hoon…'),
      ].join('\n')),
      retryText: section('↻ Fresh Verify Retry', [
        `📱 <b>Number:</b> <code>${esc(phone)}</code>`,
        sub('Pehla verify nahi hua — ek aur naye OTP ka wait (max 60s).'),
      ].join('\n')),
    });
    if (round3.status !== 'ok') return mapVerify(round3, 'failed_fresh_otp_miss');

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
    console.error('[Pipeline]', err?.stack || err?.message);
    return { ok: false, kind: 'failed_exception', phone, reason: String(err?.message || err) };
  }
}
