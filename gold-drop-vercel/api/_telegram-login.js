// 🔐 Spare Telegram account ka web login — mirror ke liye session string banata hai.
//
// Kyun web se: MTProto login me terminal/interactive step chahiye (phone → login
// code → 2FA). Vercel par terminal nahi hota, isliye wahi 3 step page se karwa
// ke session string banate hain. Session string milne par mirror turant chalta
// hai (koi redeploy nahi); permanently rakhna ho to TELEGRAM_SESSION env me daalo.
//
// ⚠️ Session string = poora account access. Ye sirf isi process ki memory me
// rehta hai (10 min TTL), kabhi disk/git/log me nahi jaata. Spare account use
// karo, main account nahi.

import { createHash, randomBytes } from 'node:crypto';

const TTL_MS = 10 * 60 * 1000; // ek login 10 min me poora hona chahiye
const logins = new Map(); // id → { client, phone, phoneCodeHash, step, at }

function cleanup() {
  const cut = Date.now() - TTL_MS;
  for (const [id, s] of logins) {
    if (s.at < cut) {
      try { s.client?.disconnect?.(); } catch { /* ignore */ }
      logins.delete(id);
    }
  }
}

export function loginConfigured() {
  return Boolean(String(process.env.TELEGRAM_API_ID || '').trim() && String(process.env.TELEGRAM_API_HASH || '').trim());
}

function apiCreds() {
  const apiId = String(process.env.TELEGRAM_API_ID || '').trim();
  const apiHash = String(process.env.TELEGRAM_API_HASH || '').trim();
  if (!apiId || !apiHash) return { error: 'TELEGRAM_API_ID / TELEGRAM_API_HASH env set nahi hai (my.telegram.org se)' };
  return { apiId: Number(apiId), apiHash };
}

function maskPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return `+${d.slice(0, 2)}${'•'.repeat(Math.max(0, d.length - 4))}${d.slice(-2)}`;
}

// Step 1 — Telegram login code bhejo.
export async function startTelegramLogin({ phone = '' } = {}) {
  cleanup();
  const raw = String(phone).replace(/[^\d+]/g, '');
  if (!/^\+?\d{8,15}$/.test(raw)) return { ok: false, step: 'phone', error: 'Poora number country code ke saath daalo (jaise +9198xxxxxxxx)' };
  const creds = apiCreds();
  if (creds.error) return { ok: false, step: 'phone', error: creds.error };
  const number = raw.startsWith('+') ? raw : `+${raw}`;
  try {
    const main = await import('teleproto');
    const sessionsMod = await import('teleproto/sessions');
    const client = new main.TelegramClient(new sessionsMod.StringSession(''), creds.apiId, creds.apiHash, { connectionRetries: 3 });
    await client.connect();
    const send = await client.invoke(new main.Api.auth.SendCode({
      phoneNumber: number,
      apiId: creds.apiId,
      apiHash: creds.apiHash,
      settings: new main.Api.CodeSettings({}),
    }));
    const id = randomBytes(12).toString('hex');
    logins.set(id, { client, phone: number, phoneCodeHash: send.phoneCodeHash, step: 'code', at: Date.now() });
    return {
      ok: true,
      step: 'code',
      loginId: id,
      phone: maskPhone(number),
      message: send?.isCodeViaApp
        ? 'Code Telegram app me aaya — jitna digit ho, wahan daalo.'
        : 'Login code bhej diya — SMS/app ka code yahan daalo.',
      expiresInSec: Math.round(TTL_MS / 1000),
    };
  } catch (error) {
    return { ok: false, step: 'phone', error: telegramError(error) };
  }
}

// Step 2 — login code verify; 2FA ho to 'password' step par ruk jaate hain.
export async function submitTelegramCode({ loginId = '', code = '' } = {}) {
  const s = logins.get(String(loginId));
  if (!s) return { ok: false, step: 'phone', error: 'Login expire ho gaya — number dobara daalo' };
  s.at = Date.now();
  const value = String(code).replace(/\D/g, '');
  if (!value) return { ok: false, step: 'code', error: 'Code daalo' };
  try {
    const main = await import('teleproto');
    await s.client.invoke(new main.Api.auth.SignIn({
      phoneNumber: s.phone,
      phoneCodeHash: s.phoneCodeHash,
      phoneCode: value,
    }));
    return await finishLogin(s);
  } catch (error) {
    const msg = telegramError(error);
    if (/SESSION_PASSWORD_NEEDED/i.test(msg)) {
      s.step = 'password';
      return { ok: true, step: 'password', loginId: String(loginId), phone: maskPhone(s.phone), message: '2FA password chahiye — account ka cloud password daalo.' };
    }
    if (/PHONE_CODE_INVALID|PHONE_CODE_EMPTY|PHONE_CODE_EXPIRED/i.test(msg)) {
      return { ok: false, step: 'code', error: 'Code galat/expire ho gaya — "Code dobara bhejo" dabao' };
    }
    return { ok: false, step: 'code', error: msg };
  }
}

// Step 3 — 2FA cloud password.
export async function submitTelegramPassword({ loginId = '', password = '' } = {}) {
  const s = logins.get(String(loginId));
  if (!s) return { ok: false, step: 'phone', error: 'Login expire ho gaya — number dobara daalo' };
  s.at = Date.now();
  if (!String(password)) return { ok: false, step: 'password', error: 'Password daalo' };
  try {
    const main = await import('teleproto');
    const { computeCheck } = await import('teleproto/Password');
    const pwd = await s.client.invoke(new main.Api.account.GetPassword());
    const check = await computeCheck(pwd, String(password));
    await s.client.invoke(new main.Api.auth.CheckPassword({ password: check }));
    return await finishLogin(s);
  } catch (error) {
    const msg = telegramError(error);
    if (/PASSWORD_HASH_INVALID/i.test(msg)) return { ok: false, step: 'password', error: '2FA password galat hai' };
    return { ok: false, step: 'password', error: msg };
  }
}

async function finishLogin(s) {
  const session = String(s.client.session.save() || '').trim();
  if (!session) throw new Error('Session khali mili — dobara try karo');
  let me = '';
  try {
    const user = await s.client.getMe();
    me = user?.username ? `@${user.username}` : [user?.firstName, user?.lastName].filter(Boolean).join(' ');
  } catch { /* ignore */ }
  try { await s.client.disconnect(); } catch { /* ignore */ }
  for (const [id, v] of logins) if (v === s) logins.delete(id);
  return {
    ok: true,
    step: 'done',
    session,
    me: me || 'account',
    message: `Login ho gaya${me ? ` — ${me}` : ''}. "Mirror me lagao" dabao — mirror turant chalu, redeploy ki zaroorat nahi.`,
  };
}

function telegramError(error) {
  const msg = String(error?.errorMessage || error?.message || error);
  const flood = msg.match(/FLOOD_WAIT_(\d+)/i);
  if (flood) return `Telegram ne ${flood[1]}s ka wait bola hai — thodi der baad try karo`;
  if (/API_ID_INVALID|API_ID_PUBLISHED_FLOOD/i.test(msg)) return 'API ID invalid — my.telegram.org se sahi API ID daalo';
  if (/PHONE_NUMBER_INVALID/i.test(msg)) return 'Number invalid — country code ke saath dobara daalo';
  if (/PHONE_NUMBER_BANNED/i.test(msg)) return 'Ye number Telegram par banned hai';
  return msg.slice(0, 180);
}

// Login ke turant baad session mirror ke client me daalo (memory) — env/redeploy
// ka wait nahi. Process restart par memory jaati hai, isliye env me daalna
// permanent fix hai; page dono baat bolta hai.
export async function applySessionToMirror(session, { slot = 0 } = {}) {
  const mod = await import('./_otp-mirror.js');
  mod.setMirrorSession(String(session || ''), { slot });
  return { ok: true };
}
