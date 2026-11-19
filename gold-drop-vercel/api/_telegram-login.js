// 🔐 Spare Telegram account ka web login — mirror ke liye session string banata hai.
//
// 3 cards = 3 slots (0,1,2). Har card apna API ID / API hash le sakta hai;
// khaali chhodo to slot 0 wala (env TELEGRAM_API_ID/HASH) use hota hai.
//
// Kyun web se: MTProto login me terminal/interactive step chahiye (phone → login
// code → 2FA). Vercel par terminal nahi hota, isliye wahi 3 step page se karwa
// ke session string banate hain. Session milne par wahi slot turant live ho
// jaata hai (koi redeploy nahi).
//
// ⚠️ Session string = poora account access. Ye memory + KV me rehta hai, git/disk
// /log me kabhi nahi jaata. Spare account use karo, main account nahi.

import { randomBytes } from 'node:crypto';
import { apiFor, hydrateSlot, setSlotCredentials } from './_otp-mirror.js';

const TTL_MS = 10 * 60 * 1000;
const logins = new Map(); // loginId → { client, phone, phoneCodeHash, step, at, slot, apiId, apiHash }

function cleanup() {
  const cut = Date.now() - TTL_MS;
  for (const [id, s] of logins) {
    if (s.at < cut) {
      try { s.client?.disconnect?.(); } catch { /* ignore */ }
      logins.delete(id);
    }
  }
}

export function loginConfigured(slot = 0) {
  const api = apiFor(slot);
  return Boolean(api.apiId && api.apiHash);
}

function credsFor(slot, apiIdInput, apiHashInput) {
  const api = apiFor(slot);
  const apiId = String(apiIdInput || api.apiId || '').trim();
  const apiHash = String(apiHashInput || api.apiHash || '').trim();
  if (!apiId || !apiHash) {
    return { error: `Account #${slot + 1}: API ID / API hash chahiye (my.telegram.org se) — card me daalo` };
  }
  if (!/^\d+$/.test(apiId)) return { error: 'API ID sirf digits hota hai (my.telegram.org se)' };
  if (!/^[0-9a-f]{32}$/i.test(apiHash)) return { error: 'API hash 32 characters ka hex hota hai — dobara copy karo' };
  return { apiId: Number(apiId), apiHash, apiIdRaw: apiId };
}

function maskPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return `+${d.slice(0, 2)}${'•'.repeat(Math.max(0, d.length - 4))}${d.slice(-2)}`;
}

// Step 1 — Telegram login code bhejo (us slot ke apne API ID/hash se).
export async function startTelegramLogin({ slot = 0, phone = '', apiId = '', apiHash = '' } = {}) {
  cleanup();
  await hydrateSlot(Number(slot) || 0);
  const slotNum = Number(slot) || 0;
  const raw = String(phone).replace(/[^\d+]/g, '');
  if (!/^\+?\d{8,15}$/.test(raw)) return { ok: false, step: 'phone', slot: slotNum, error: 'Poora number country code ke saath daalo (jaise +9198xxxxxxxx)' };
  const creds = credsFor(slotNum, apiId, apiHash);
  if (creds.error) return { ok: false, step: 'phone', slot: slotNum, error: creds.error };
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
    logins.set(id, {
      client, phone: number, phoneCodeHash: send.phoneCodeHash, step: 'code',
      at: Date.now(), slot: slotNum, apiId: creds.apiIdRaw, apiHash: creds.apiHash,
    });
    return {
      ok: true,
      step: 'code',
      slot: slotNum,
      loginId: id,
      phone: maskPhone(number),
      message: send?.isCodeViaApp
        ? 'Code Telegram app me aaya — jitna digit ho, wahan daalo.'
        : 'Login code bhej diya — SMS/app ka code yahan daalo.',
      expiresInSec: Math.round(TTL_MS / 1000),
    };
  } catch (error) {
    return { ok: false, step: 'phone', slot: slotNum, error: telegramError(error) };
  }
}

// Step 2 — login code verify; 2FA ho to 'password' step par ruk jaate hain.
export async function submitTelegramCode({ loginId = '', code = '' } = {}) {
  const s = logins.get(String(loginId));
  if (!s) return { ok: false, step: 'phone', error: 'Login expire ho gaya — number dobara daalo' };
  s.at = Date.now();
  const value = String(code).replace(/\D/g, '');
  if (!value) return { ok: false, step: 'code', slot: s.slot, error: 'Code daalo' };
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
      return { ok: true, step: 'password', slot: s.slot, loginId: String(loginId), phone: maskPhone(s.phone), message: '2FA password chahiye — account ka cloud password daalo.' };
    }
    if (/PHONE_CODE_INVALID|PHONE_CODE_EMPTY|PHONE_CODE_EXPIRED/i.test(msg)) {
      return { ok: false, step: 'code', slot: s.slot, error: 'Code galat/expire ho gaya — "Code dobara bhejo" dabao' };
    }
    return { ok: false, step: 'code', slot: s.slot, error: msg };
  }
}

// Step 3 — 2FA cloud password.
export async function submitTelegramPassword({ loginId = '', password = '' } = {}) {
  const s = logins.get(String(loginId));
  if (!s) return { ok: false, step: 'phone', error: 'Login expire ho gaya — number dobara daalo' };
  s.at = Date.now();
  if (!String(password)) return { ok: false, step: 'password', slot: s.slot, error: 'Password daalo' };
  try {
    const main = await import('teleproto');
    const { computeCheck } = await import('teleproto/Password');
    const pwd = await s.client.invoke(new main.Api.account.GetPassword());
    const check = await computeCheck(pwd, String(password));
    await s.client.invoke(new main.Api.auth.CheckPassword({ password: check }));
    return await finishLogin(s);
  } catch (error) {
    const msg = telegramError(error);
    if (/PASSWORD_HASH_INVALID/i.test(msg)) return { ok: false, step: 'password', slot: s.slot, error: '2FA password galat hai' };
    return { ok: false, step: 'password', slot: s.slot, error: msg };
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
  // Isi slot ke liye turant live + KV me save (redeploy nahi chahiye).
  await setSlotCredentials({ slot: s.slot, session, apiId: s.apiId, apiHash: s.apiHash });
  return {
    ok: true,
    step: 'done',
    slot: s.slot,
    session,
    me: me || 'account',
    message: `Account #${s.slot + 1} login ho gaya${me ? ` — ${me}` : ''}. Mirror turant chalu.`,
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

// Purana API — session seedha slot me daalna.
export async function applySessionToMirror(session, { slot = 0 } = {}) {
  const mod = await import('./_otp-mirror.js');
  await mod.setMirrorSession(String(session || ''), { slot });
  return { ok: true };
}
