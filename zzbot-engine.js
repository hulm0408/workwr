// ===== 🌐 ZZBOT (ZEPTO PRO) WEB SIGNUP ENGINE =====
//
// Toing Pro engine (toing-pro-engine.js) ka mirror — bas API Zepto Pro (zzbot)
// ki hai. Flow exactly same rehta hai:
//
// 1. send_otp   -> POST /api/login/otp { mobile }        (header x-user-key)
//    - zzbot par alag check_mobile endpoint nahi hai; naya/purana account
//      OTP verify ke jawab se pata chalta hai.
// 2. Poll OTP from Telegram OTP Bot (Hathi / Hermes)
//    - waitForTelegramOtpCode(phone, { timeoutMs, refreshMs, shouldAbort })
// 3. verify_otp -> POST /api/login/verify { otp }        (header x-user-key)
// 4. export session -> POST /api/accounts/{mobile}/export (header x-user-key)
//    - returns { success: true, export: { ... } } — Zepto session JSON
// 5. session JSON ko validate karke file likhta hai & deliver karta hai
//    (importSessionJson Swiggy ka parser hai, isliye Zepto JSON yahan
//     sirf validate + file + deliver hota hai, bot ke Swiggy DB me nahi)
//
// ⚠️ Zepto export = live credential. File 0600 par likhti hai aur git me
// kabhi nahi jaati (data/session-files/ ignored hai).

import {
  waitForTelegramOtpCode,
  discardCurrentTelegramNumber,
  captureTelegramOtpWatermark,
} from './telegram-otp-source.js';
import { sessionJsonBody, writeSessionFile } from './session-file.js';
import {
  getExtractedNumberCooldown,
  extractedNumberCooldownDays,
  markLedger,
  markPoolStatus,
} from './number-pipeline.js';
import { getSetting } from './bot-settings.js';

export const DEFAULT_ZZBOT_BASE_URL = 'https://storelex.store/zzbot';
export const DEFAULT_ZZBOT_ACCESS_KEY = 'ZPT-BW9Z-PLMB-1H1W-9HSD';

export function getZzbotConfig(env = process.env) {
  const baseUrl = (env.ZZBOT_BASE_URL || getSetting('zzbotBaseUrl') || DEFAULT_ZZBOT_BASE_URL).replace(/\/+$/, '');
  const accessKey = env.ZZBOT_ACCESS_KEY || getSetting('zzbotAccessKey') || DEFAULT_ZZBOT_ACCESS_KEY;
  return { baseUrl, accessKey };
}

function normalizePhone(val = '') {
  const digits = String(val || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

// zzbot har call par x-user-key maangta hai. 401/403 aaye to message saaf ho.
function zzHeaders(accessKey) {
  return {
    'Content-Type': 'application/json',
    'x-user-key': accessKey,
  };
}

function trimmedJson(text = '') {
  try { return JSON.parse(text); } catch { return null; }
}

// Ek API call — error body (FastAPI detail) ko readable bana deta hai.
async function zzPost(url, accessKey, body = null, timeoutMs = 30000) {
  const res = await fetch(url, {
    method: 'POST',
    headers: zzHeaders(accessKey),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  const data = trimmedJson(text);
  return { ok: res.ok, status: res.status, data };
}

function errorText(data = null, status = 0) {
  if (!data) return `HTTP ${status}`;
  const detail = data.detail ?? data.error ?? data.message ?? data.reason ?? '';
  if (typeof detail === 'string' && detail.trim()) return detail.trim();
  if (Array.isArray(detail) && detail.length) {
    return detail.map(d => (typeof d === 'string' ? d : d?.msg || '')).filter(Boolean).join(', ') || `HTTP ${status}`;
  }
  return `HTTP ${status}`;
}

// Export payload me se wahi fields nikaalna jo asli session hain — Toing
// engine ke cleanExport jaisa, bas Zepto ke keys ke saath.
export function cleanZeptoExport(raw = null, fallback = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const pick = (...keys) => {
    for (const key of keys) {
      const v = src[key];
      if (v !== undefined && v !== null && String(v).trim() !== '') return v;
    }
    return '';
  };
  return {
    mobile: String(pick('mobile', 'phone', 'number') || fallback.mobile || '').replace(/\D/g, '').slice(-10),
    name: String(pick('name', 'customer_name', 'userName', 'user_name') || '').trim(),
    token: String(pick('token', 'user_token', 'access_token', 'jwt') || '').trim(),
    sid: String(pick('sid', 'session_id') || fallback.sid || '').trim(),
    tid: String(pick('tid', 'transaction_id') || '').trim(),
    deviceId: String(pick('deviceId', 'device_id') || fallback.deviceId || '').trim(),
    customerId: String(pick('customerId', 'customer_id', 'userId', 'user_id') || '').trim(),
  };
}

export async function processSingleNumberViaZzbot({
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

  // Cooldown check — Toing engine jaisa hi.
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
        reason: `Ye number pehle extract ho chuka hai — ${extractedNumberCooldownDays()}-day cooldown ${until} tak hai`,
      };
    }
  }

  const { baseUrl, accessKey } = getZzbotConfig();
  const botProfile = String(otpCfg?.otpBotProfile || getSetting('otpBotProfile') || 'hermes').toLowerCase();
  const botLabel = botProfile === 'hathi' ? '@Hathi_otp_bot (Elephant 🐘)' : '@HermeshuOTPROBOT (Hermes 📨)';

  await say([
    `🌐 <b>ZZBOT (ZEPTO) SIGNUP</b>`,
    `📱 Mobile: <code>${phone}</code>`,
    `🤖 OTP Bot: <b>${botLabel}</b>`,
    `⏳ Zepto Pro par OTP bhej raha hoon…`,
  ].join('\n'));

  // 1. Send OTP — zzbot: POST /api/login/otp { mobile }
  let otpState = null;
  try {
    const sendRes = await zzPost(`${baseUrl}/api/login/otp`, accessKey, { mobile: phone });
    const sendData = sendRes.data || {};
    const sendOk = sendRes.ok && sendData.success !== false && !sendData.detail;
    if (!sendOk) {
      return {
        ok: false,
        kind: 'zzbot_send_otp_fail',
        phone,
        reason: errorText(sendData, sendRes.status),
      };
    }
    otpState = {
      sid: String(sendData.sid || sendData.session_id || '').trim(),
      tid: String(sendData.tid || sendData.transaction_id || '').trim(),
      deviceId: String(sendData.device_id || sendData.deviceId || '').trim(),
      mobile: phone,
      isNew: sendData.existing === false || sendData.is_new === true || sendData.registered === false,
    };
    console.log(`[Zzbot] login/otp sent for ${phone} (isNew=${otpState.isNew})`);
  } catch (err) {
    return { ok: false, kind: 'zzbot_send_otp_error', phone, reason: `Zzbot send OTP error: ${err.message}` };
  }

  if (aborted()) return abortResult('after_send_otp');

  // 2. Poll OTP from Telegram bot — Toing jaisa hi budget/refresh.
  const otpTimeoutMs = Number(otpCfg?.telegramOtpTimeoutMs || getSetting('telegramOtpTimeoutMs') || 35000);
  const otpRefreshMs = Number(otpCfg?.telegramOtpRefreshMs || getSetting('telegramOtpRefreshMs') || 3500);

  await say([
    `🌐 <b>ZZBOT (ZEPTO) SIGNUP</b>`,
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
    console.warn(`[Zzbot] OTP polling error for ${phone}:`, err.message);
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
    `🌐 <b>ZZBOT (ZEPTO) SIGNUP</b>`,
    `📱 Mobile: <code>${phone}</code>`,
    `🔑 OTP Mil Gaya: <code>${otpCode}</code>`,
    `⚡ Zepto Pro par verify kar raha hoon…`,
  ].join('\n'));

  // 3. Verify OTP — zzbot: POST /api/login/verify { otp }
  try {
    const verifyRes = await zzPost(`${baseUrl}/api/login/verify`, accessKey, { otp: otpCode });
    const verifyData = verifyRes.data || {};
    const verifyOk = verifyRes.ok && verifyData.success !== false && !verifyData.detail;
    if (!verifyOk) {
      discardCurrentTelegramNumber(phone);
      return {
        ok: false,
        kind: 'zzbot_verify_fail',
        phone,
        reason: errorText(verifyData, verifyRes.status),
      };
    }
    console.log(`[Zzbot] login/verify success for ${phone}`);
  } catch (err) {
    return { ok: false, kind: 'zzbot_verify_error', phone, reason: `Zzbot verify network error: ${err.message}` };
  }

  if (aborted()) return abortResult('after_verify');

  await say([
    `🌐 <b>ZZBOT (ZEPTO) SIGNUP</b>`,
    `📱 Mobile: <code>${phone}</code>`,
    `✅ OTP Verified!`,
    `📥 Session export kar raha hoon…`,
  ].join('\n'));

  // 4. Export — zzbot: POST /api/accounts/{mobile}/export
  let cleanExport = null;
  let rawExportJson = '';
  try {
    const exportRes = await zzPost(`${baseUrl}/api/accounts/${encodeURIComponent(phone)}/export`, accessKey);
    const resJson = exportRes.data || {};
    const raw = resJson.export || resJson.session || (resJson.success === false ? null : resJson);
    if (exportRes.ok && raw && typeof raw === 'object' && Object.keys(raw).length) {
      cleanExport = cleanZeptoExport(raw, otpState);
      rawExportJson = JSON.stringify(raw, null, 2);
    } else {
      console.warn(`[Zzbot] Export failed for ${phone}:`, errorText(resJson, exportRes.status));
    }
  } catch (err) {
    console.warn(`[Zzbot] Export network error for ${phone}:`, err.message);
  }

  if (aborted()) return abortResult('after_export');

  // Export na mile to adhoora JSON mat bhejo — Toing engine bhi export fail
  // par khaali token bhej deta tha, par Zepto par khaali token bekaar hai.
  if (!rawExportJson) {
    return {
      ok: false,
      kind: 'zzbot_export_fail',
      phone,
      reason: 'Zepto session export nahi mila (OTP verify ho gaya, par export endpoint khaali aaya)',
    };
  }

  const fileText = sessionJsonBody(rawExportJson) || rawExportJson;
  const fileName = `zzbot-${phone}.json`;
  const accountKey = `zz_${phone}`;

  const file = writeSessionFile({
    phone,
    accountKey,
    text: fileText,
    name: fileName,
  });

  if (file.ok) {
    console.log(`[Zzbot] 🗂 Session file written: ${file.name} (${file.bytes} bytes) -> ${file.path}`);
  }

  // 5. Deliver session (Telegram file) — Toing jaisa sendSession callback.
  let sessionSent = false;
  if (typeof sendSession === 'function') {
    try {
      const out = await sendSession({
        phone,
        accountKey,
        kind: otpState?.isNew ? 'fresh_new' : 'fresh_existing',
        account: cleanExport,
        jsonText: fileText,
        fileName: file.ok ? file.name : fileName,
        source: 'zzbot-zepto',
        bytes: file.ok ? file.bytes : Buffer.byteLength(fileText, 'utf8'),
      });
      sessionSent = out !== false;
    } catch (e) {
      console.warn('[Zzbot] sendSession error:', e.message);
    }
  }

  if (markUsed) {
    markLedger(phone, 'success', { accountKey, kind: otpState?.isNew ? 'new' : 'existing' });
    await markPoolStatus(entry, 'used');
  }

  await say([
    `🎉 <b>ZZBOT (ZEPTO) SIGNUP COMPLETE!</b>`,
    `📱 Mobile: <code>${phone}</code>`,
    cleanExport?.name ? `👤 Name: <b>${cleanExport.name}</b>` : `👤 Type: <b>${otpState?.isNew ? 'Fresh / New Account' : 'Existing Account'}</b>`,
    `📦 Session: <code>${accountKey}</code>`,
    sessionSent ? `📤 File deliver ho gayi hai!` : `💾 File local store ho gayi hai!`,
  ].join('\n'));

  return {
    ok: true,
    phone,
    kind: otpState?.isNew ? 'fresh_new' : 'fresh_existing',
    accountKey,
    viaZzbot: true,
    sessionSent,
  };
}
