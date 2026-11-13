// ===== 🌐 TOING PRO WEB SIGNUP ENGINE =====
//
// Replicates exact Toing Pro Web flow (storelex.store/toing_web):
// 1. check_mobile -> POST /api/auth/check_mobile
//    - if registered === true: existing account -> is_new: false
//    - if registered === false: fresh account -> is_new: true
// 2. send_otp -> POST /api/auth/send_otp { mobile }
//    - returns { success: true, sid, tid, device_id, mobile }
// 3. Poll OTP from Telegram OTP Bot (Hathi / Hermes)
//    - waitForTelegramOtpCode(phone, { timeoutMs: 20000, refreshMs: 2500, shouldAbort })
// 4. verify_otp -> POST /api/auth/verify_otp { mobile, otp, sid, tid, device_id, is_new }
//    - with header x-user-key: <TOING_ACCESS_KEY>
// 5. export session -> POST /api/accounts/{mobile}/export
//    - returns { success: true, export: { mobile, token, sid, tid, deviceId, ... } }
// 6. importSessionJson & deliver via sendSession & save to session file

import {
  waitForTelegramOtpCode,
  discardCurrentTelegramNumber,
  captureTelegramOtpWatermark,
} from './telegram-otp-source.js';
import {
  importSessionJson,
  getDb,
  syncCloudVaultNow,
} from './store.js';
import {
  sessionFileText,
  writeSessionFile,
} from './session-file.js';
import {
  getExtractedNumberCooldown,
  markLedger,
  markPoolStatus,
} from './number-pipeline.js';
import { getSetting } from './bot-settings.js';

export const DEFAULT_TOING_BASE_URL = 'https://storelex.store/toing_web';
export const DEFAULT_TOING_ACCESS_KEY = 'TNG-M923-VR10-8SQF';

export function getToingConfig(env = process.env) {
  const baseUrl = (env.TOING_PRO_BASE_URL || getSetting('toingBaseUrl') || DEFAULT_TOING_BASE_URL).replace(/\/+$/, '');
  const accessKey = env.TOING_ACCESS_KEY || getSetting('toingAccessKey') || DEFAULT_TOING_ACCESS_KEY;
  return { baseUrl, accessKey };
}

function normalizePhone(val = '') {
  const digits = String(val || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

export async function processSingleNumberViaToingPro({
  userId = 'autopilot',
  entry,
  report = null,
  otpCfg = {},
  shouldAbort = null,
  shouldSkip = null,
  markUsed = true,
  sendSession = null,
} = {}) {
  const phone = normalizePhone(entry?.phone);
  if (!phone) {
    return { ok: false, kind: 'failed_bad_entry', phone: '', reason: 'Entry me valid 10-digit phone nahi hai' };
  }

  const say = async (text) => {
    if (report) {
      try { await report(text); } catch {}
    }
  };

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
    reason: skipRequested() ? 'Owner ne current number SKIP kar diya' : 'Operation aborted',
  });

  if (aborted()) return abortResult('init');

  // Cooldown check
  if (markUsed) {
    const cooldown = getExtractedNumberCooldown(phone);
    if (cooldown.blocked) {
      const until = cooldown.cooldownUntilMs
        ? new Date(cooldown.cooldownUntilMs).toISOString()
        : 'unknown';
      discardCurrentTelegramNumber(phone);
      return {
        ok: false,
        kind: 'deferred_number_cooldown',
        phone,
        reason: `Ye number pehle extract ho chuka hai — 7-day cooldown ${until} tak hai`,
      };
    }
  }

  const { baseUrl, accessKey } = getToingConfig();
  const botProfile = String(otpCfg?.otpBotProfile || getSetting('otpBotProfile') || 'hermes').toLowerCase();
  const botLabel = botProfile === 'hathi' ? '@Hathi_otp_bot (Elephant 🐘)' : '@HermeshuOTPROBOT (Hermes 📨)';

  await say([
    `🌐 <b>TOING PRO WEB SIGNUP</b>`,
    `📱 Mobile: <code>${phone}</code>`,
    `🤖 OTP Bot: <b>${botLabel}</b>`,
    `⏳ Checking number status on Toing Pro Web…`,
  ].join('\n'));

  // 1. Check mobile registration status (optional / quick check for is_new flag)
  let isNew = false;
  try {
    const checkRes = await fetch(`${baseUrl}/api/auth/check_mobile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-key': accessKey,
      },
      body: JSON.stringify({ mobile: phone }),
    });
    if (checkRes.ok) {
      const checkData = await checkRes.json();
      if (checkData && typeof checkData.registered === 'boolean') {
        isNew = !checkData.registered;
      }
    }
    console.log(`[ToingPro] check_mobile for ${phone} -> isNew=${isNew}`);
  } catch (err) {
    console.log(`[ToingPro] check_mobile non-fatal error: ${err.message}, defaulting isNew=false`);
  }

  if (aborted()) return abortResult('after_check');

  await say([
    `🌐 <b>TOING PRO WEB SIGNUP</b>`,
    `📱 Mobile: <code>${phone}</code>`,
    `🚀 Sending OTP via Swiggy gateway…`,
  ].join('\n'));

  // 2. Send OTP
  let otpState = null;
  try {
    const sendRes = await fetch(`${baseUrl}/api/auth/send_otp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-key': accessKey,
      },
      body: JSON.stringify({ mobile: phone }),
    });
    const sendData = await sendRes.json();
    if (!sendData.success || !sendData.sid || !sendData.tid) {
      return {
        ok: false,
        kind: 'toing_send_otp_fail',
        phone,
        reason: sendData.error || sendData.detail || 'Toing Pro send_otp failed',
      };
    }
    otpState = {
      sid: sendData.sid,
      tid: sendData.tid,
      deviceId: sendData.device_id || '',
      mobile: phone,
      isNew,
    };
    console.log(`[ToingPro] send_otp success for ${phone}, sid=${otpState.sid.slice(0, 10)}...`);
  } catch (err) {
    return { ok: false, kind: 'toing_send_otp_error', phone, reason: `Toing send_otp error: ${err.message}` };
  }

  if (aborted()) return abortResult('after_send_otp');

  // 3. Poll OTP from Telegram Bot
  const otpTimeoutMs = Number(otpCfg?.telegramOtpTimeoutMs || getSetting('telegramOtpTimeoutMs') || 35000);
  const otpRefreshMs = Number(otpCfg?.telegramOtpRefreshMs || getSetting('telegramOtpRefreshMs') || 3500);

  await say([
    `🌐 <b>TOING PRO WEB SIGNUP</b>`,
    `📱 Mobile: <code>${phone}</code>`,
    `⏳ OTP bhej diya gaya hai!`,
    `🤖 <b>${botLabel}</b> se OTP lene ka intezar kar raha hoon (${Math.round(otpTimeoutMs / 1000)}s budget)…`,
  ].join('\n'));

  let otpCode = '';
  try {
    const baseline = await captureTelegramOtpWatermark(phone).catch(() => null);
    const otpRes = await waitForTelegramOtpCode(phone, {
      timeoutMs: otpTimeoutMs,
      refreshMs: otpRefreshMs,
      baseline,
      shouldAbort: () => aborted(),
    });
    otpCode = String(otpRes?.code || '').trim();
  } catch (err) {
    console.warn(`[ToingPro] OTP polling error for ${phone}:`, err.message);
  }

  if (aborted()) return abortResult('after_otp_poll');

  if (!otpCode || !/^\d{6}$/.test(otpCode)) {
    discardCurrentTelegramNumber(phone);
    return {
      ok: false,
      kind: 'failed_otp_timeout',
      phone,
      reason: `OTP nahi aaya (${Math.round(otpTimeoutMs / 1000)}s timeout ho gaya)`,
    };
  }

  await say([
    `🌐 <b>TOING PRO WEB SIGNUP</b>`,
    `📱 Mobile: <code>${phone}</code>`,
    `🔑 OTP Mil Gaya: <code>${otpCode}</code>`,
    `⚡ Toing Pro Web par verify kar raha hoon…`,
  ].join('\n'));

  // 4. Verify OTP on Toing Pro
  try {
    const verifyRes = await fetch(`${baseUrl}/api/auth/verify_otp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-key': accessKey,
      },
      body: JSON.stringify({
        mobile: phone,
        otp: otpCode,
        sid: otpState.sid,
        tid: otpState.tid,
        device_id: otpState.deviceId,
        is_new: otpState.isNew,
      }),
    });
    const verifyData = await verifyRes.json();
    if (!verifyData.success) {
      return {
        ok: false,
        kind: 'toing_verify_fail',
        phone,
        reason: verifyData.error || verifyData.detail || 'OTP verification failed on Toing Pro',
      };
    }
    console.log(`[ToingPro] verify_otp success for ${phone}`);
  } catch (err) {
    return { ok: false, kind: 'toing_verify_error', phone, reason: `Toing verify_otp network error: ${err.message}` };
  }

  if (aborted()) return abortResult('after_verify');

  await say([
    `🌐 <b>TOING PRO WEB SIGNUP</b>`,
    `📱 Mobile: <code>${phone}</code>`,
    `✅ OTP Verified!`,
    `📥 Session export kar raha hoon…`,
  ].join('\n'));

  // 5. Clean session export (Mobile, Name, Token, SID, TID, Device ID, Customer ID)
  let cleanExport = null;
  try {
    const exportRes = await fetch(`${baseUrl}/api/accounts/${phone}/export`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-key': accessKey,
      },
    });
    const resJson = await exportRes.json();
    if (resJson.success && resJson.export) {
      const raw = resJson.export;
      cleanExport = {
        mobile: String(raw.mobile || raw.phone || phone).replace(/\D/g, '').slice(-10),
        name: String(raw.name || raw.customer_name || raw.userName || '').trim(),
        token: String(raw.token || raw.user_token || raw.access_token || '').trim(),
        sid: String(raw.sid || raw.session_id || otpState.sid || '').trim(),
        tid: String(raw.tid || raw.transaction_id || otpState.tid || '').trim(),
        deviceId: String(raw.deviceId || raw.device_id || otpState.deviceId || '').trim(),
        customerId: String(raw.customerId || raw.customer_id || raw.userId || raw.user_id || '').trim(),
      };
    } else {
      console.warn(`[ToingPro] Export failed for ${phone}:`, resJson);
    }
  } catch (err) {
    console.warn(`[ToingPro] Export network error for ${phone}:`, err.message);
  }

  // Fallback to minimal session if export endpoint had lag
  if (!cleanExport) {
    cleanExport = {
      mobile: phone,
      name: '',
      token: '',
      sid: otpState.sid || '',
      tid: otpState.tid || '',
      deviceId: otpState.deviceId || '',
      customerId: '',
    };
  }

  const sessionJsonStr = JSON.stringify(cleanExport, null, 2);
  const imported = importSessionJson(sessionJsonStr);

  if (!imported?.success) {
    return {
      ok: false,
      kind: 'failed_bad_entry',
      phone,
      reason: imported?.message || 'Session JSON import failed',
    };
  }

  // 6. Write session file (single clean file)
  const fileText = sessionJsonStr;
  const file = fileText
    ? writeSessionFile({
        phone,
        accountKey: imported.key,
        text: fileText,
        name: `toing-${phone}.json`,
      })
    : { ok: false, kind: 'no-json' };

  if (file.ok) {
    console.log(`[ToingPro] 🗂 Session file written: ${file.name} (${file.bytes} bytes) -> ${file.path}`);
  }

  // 7. Deliver session via sendSession callback
  let sessionSent = false;
  if (fileText && typeof sendSession === 'function') {
    try {
      const out = await sendSession({
        phone,
        accountKey: imported.key,
        kind: isNew ? 'fresh_new' : 'fresh_existing',
        account: imported.accountObj || getDb().config.accounts?.[imported.key] || null,
        jsonText: fileText,
        fileName: file.ok ? file.name : `toing-${phone}.json`,
        source: 'toing-pro-web',
        bytes: file.ok ? file.bytes : Buffer.byteLength(fileText, 'utf8'),
      });
      sessionSent = out !== false;
    } catch (e) {
      console.warn('[ToingPro] sendSession error:', e.message);
    }
  }

  if (markUsed) {
    markLedger(phone, 'success', { accountKey: imported.key, kind: isNew ? 'new' : 'existing' });
    await markPoolStatus(entry, 'used');
  }

  syncCloudVaultNow(getDb()).catch(() => {});

  await say([
    `🎉 <b>TOING PRO SIGNUP COMPLETE!</b>`,
    `📱 Mobile: <code>${phone}</code>`,
    `👤 Type: <b>${isNew ? 'Fresh / New Account' : 'Existing Account'}</b>`,
    `📦 Session: <code>${imported.key}</code>`,
    sessionSent ? `📤 File deliver ho gayi hai!` : `💾 File local store ho gayi hai!`,
  ].join('\n'));

  return {
    ok: true,
    phone,
    kind: isNew ? 'fresh_new' : 'fresh_existing',
    accountKey: imported.key,
    viaToingPro: true,
    sessionSent: true,
  };
}
