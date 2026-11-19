// ===== 🌐 SERVICE HUB — pehle card, phir spare account, phir bot, phir START =====
//
// User ka rule:
//   "Web kholu kahin bhi, mujhse pehle CARD show kare ki kis service ke liye
//    website kholi hai — Gold wala, Toing, aise jitne bhi hain. Phir spare
//    account choose, phir bot, phir START the process."
//
// Ek hi page, teen kadam ke baad process:
//   1. SERVICE  → 🟡 Gold Drop / 🌐 Toing Pro / 🌐 ZZBOT (Zepto) / 🧩 Custom
//   2. SPARE    → kaun OTP uthayega (Telegram spare account slots)
//   3. BOT      → kaunsa OTP bot (Hermes / Hathi / HardXotp / custom)
//   4. START    → number daalo → OTP → session / reward
//
// Sab kuch ek memory state me (Gold Drop jaisa warm-instance model).
//
// Env:
//   APP_PASSWORD        page password (default rahul@123)
//   TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION(_2.._8)
//   OTP_BOT_USERNAME    jab koi spare configured na ho tab fallback bot
//   ZZBOT_ACCESS_KEY / ZZBOT_BASE_URL
//   NOCAP_API_KEY       Gold Drop security check (optional)
//
// Banner files (optional, public/ me daal do to dikh jayenge):
//   gold-drop.jpg · toing.jpg · zzbot.jpg
// Na ho to CSS fallback banner (gradient + emoji) use hota hai.

import http from 'node:http';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { registerGoldDrop, verifyGoldDropOtp, goldDropCaptchaDiagnose } from './_gold-drop-core.js';
import { getSharedBrowser, goldDropBrowserAvailable, browserRegister, browserVerifyOtp } from './_gold-drop-browser.js';
import { readSlotCard, setSlotCredentials } from './_otp-mirror.js';
import { startClaimRun, getClaimRun, latestClaimRun, pushClaimNumber, pushClaimOtp } from './_claim.js';
import { startTelegramLogin, submitTelegramCode, submitTelegramPassword } from './_telegram-login.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(path.dirname(ROOT), 'public');

const ZZ_BASE = (process.env.ZZBOT_BASE_URL || 'https://storelex.store/zzbot').replace(/\/+$/, '');
const ZZ_KEY = process.env.ZZBOT_ACCESS_KEY || 'ZPT-BW9Z-PLMB-1H1W-9HSD';
const TOING_BASE = (process.env.TOING_PRO_BASE_URL || 'https://storelex.store/toing_web').replace(/\/+$/, '');
const TOING_KEY = process.env.TOING_ACCESS_KEY || 'TNG-M923-VR10-8SQF';
const NOCAP_KEY = process.env.NOCAP_API_KEY || 'nocap_eVBzrYeejjgKLoikEErH6lbP';

const DEFAULT_GOLD_PHOTO = (() => {
  try { return readFileSync(path.join(ROOT, 'gold-drop-pack.jpg')).toString('base64'); } catch { return ''; }
})();

// ─── LOGIN ───
const APP_PASSWORD = process.env.APP_PASSWORD || 'rahul@123';
const AUTH_COOKIE = `hub_auth=${createHash('sha256').update(`hub:${APP_PASSWORD}`).digest('hex')}`;
function isAuthed(req) {
  return String(req.headers.cookie || '').split(';').map(x => x.trim()).includes(AUTH_COOKIE);
}

// ─── Services (cards) ───
const SERVICES = {
  gold: {
    id: 'gold',
    emoji: '🟡',
    label: 'Gold Drop',
    tagline: 'Gold Drop register → OTP → reward',
    banner: '/banner/gold',
    gradient: 'linear-gradient(135deg,#f7b500,#ff8a00)',
    needsBot: true,
    needsPhone: true,
    form: [
      { id: 'name', label: 'Naam', value: 'Rahul Kumar' },
      { id: 'email', label: 'Email (Gmail — +suffix auto)', value: 'itsnoob012@gmail.com' },
      { id: 'pincode', label: 'PIN code', value: '509412' },
      { id: 'code', label: 'Batch code', value: 'KKD2LS01261026' },
      { id: 'nocapKey', label: 'NoCaptchaAI key', value: NOCAP_KEY },
    ],
    steps: ['Number daalo', 'Register + security solve', 'OTP daalo', 'Reward'],
  },
  toing: {
    id: 'toing',
    emoji: '🌐',
    label: 'Toing Pro',
    tagline: 'Toing Pro Web — Swiggy session JSON',
    banner: '/banner/toing',
    gradient: 'linear-gradient(135deg,#2b6cff,#5b2bd6)',
    needsBot: true,
    needsPhone: true,
    form: [],
    steps: ['Number daalo', 'OTP bhejo (send_otp)', 'OTP verify', 'Session JSON'],
  },
  zzbot: {
    id: 'zzbot',
    emoji: '🟣',
    label: 'ZZBOT (Zepto)',
    tagline: 'Zepto Pro — session JSON',
    banner: '/banner/zzbot',
    gradient: 'linear-gradient(135deg,#7c5cff,#c02bff)',
    needsBot: true,
    needsPhone: true,
    form: [],
    steps: ['Number daalo', 'OTP bhejo (login/otp)', 'OTP verify', 'Session JSON'],
  },
  custom: {
    id: 'custom',
    emoji: '🧩',
    label: 'Custom',
    tagline: 'Apni site — apne endpoints',
    banner: '/banner/custom',
    gradient: 'linear-gradient(135deg,#2b2f4a,#4a5170)',
    needsBot: true,
    needsPhone: true,
    form: [],
    steps: ['Endpoint do', 'Number daalo', 'OTP', 'Result'],
  },
};

// ─── Spare (Telegram spare accounts) — slots env se ───
function firstEnv(keys) {
  for (const k of keys) {
    const v = String(process.env[k] || '').trim();
    if (v) return v;
  }
  return '';
}

function spareSlots() {
  const slots = [];
  const apiId = firstEnv(['TELEGRAM_API_ID']);
  const apiHash = firstEnv(['TELEGRAM_API_HASH']);
  for (let slot = 0; slot <= 8; slot++) {
    const keys = slot === 0
      ? ['TELEGRAM_SESSION']
      : [`TELEGRAM_SESSION_${slot + 1}`];
    const session = firstEnv(keys);
    if (!session) {
      if (slot === 0) slots.push({ slot, label: 'Spare #1', configured: false });
      continue;
    }
    slots.push({
      slot,
      label: `Spare #${slot + 1}`,
      configured: Boolean(apiId && apiHash),
      masked: `${session.slice(0, 6)}…${session.slice(-4)}`,
    });
  }
  return slots;
}

// ─── Bots (OTP bots) ───
const BOTS = [
  { id: 'hermes', emoji: '📨', label: 'Hermes', username: 'HermeshuOTPROBOT' },
  { id: 'hathi', emoji: '🐘', label: 'Hathi', username: 'Hathi_otp_bot' },
  { id: 'chauhan', emoji: '🔐', label: 'HardXotp', username: 'HardXotp_Bot' },
  { id: 'custom', emoji: '🎓', label: 'Custom bot', username: firstEnv(['OTP_BOT_USERNAME']) || '' },
];

function botById(id) {
  return BOTS.find(b => b.id === id) || BOTS[0];
}

function telegramConfigured() {
  return Boolean(firstEnv(['TELEGRAM_API_ID']) && firstEnv(['TELEGRAM_API_HASH']) && firstEnv(['TELEGRAM_SESSION']));
}

// ─── Run state ───
const state = {
  step: 'service',     // service | spare | bot | start | working | need_phone | need_otp | done
  service: '',
  spareSlot: -1,
  botId: '',
  target: 1,
  message: '',
  phone: '',
  secret: null,        // service ka internal session (gold: userKey/dataKey, toing/zzbot: sid/tid)
  result: null,
  results: [],
  log: [],
};

function logLine(message) {
  state.log.push(`[${new Date().toLocaleTimeString()}] ${message}`);
  if (state.log.length > 250) state.log.shift();
}

function publicState() {
  return {
    step: state.step,
    service: state.service,
    serviceLabel: SERVICES[state.service]?.label || '',
    spareSlot: state.spareSlot,
    botId: state.botId,
    botLabel: state.botId ? `${botById(state.botId).emoji} ${botById(state.botId).label}` : '',
    target: state.target,
    count: state.results.length,
    message: state.message,
    phone: state.phone,
    result: state.result,
    results: state.results,
    log: state.log,
    telegramReady: telegramConfigured(),
  };
}

// ─── Telegram (MTProto) — spare account se OTP bot padho ───
let tgClients = new Map(); // slot → Promise<client>

// Slot ka apna API ID/hash ho sakta hai (TELEGRAM_API_ID_2/_HASH_2 ...),
// warna slot 0 wala fallback — 3 cards ek hi page par.
function slotApi(slot = 0) {
  const suffix = slot === 0 ? '' : `_${slot + 1}`;
  return {
    apiId: firstEnv([`TELEGRAM_API_ID${suffix}`, 'TELEGRAM_API_ID']),
    apiHash: firstEnv([`TELEGRAM_API_HASH${suffix}`, 'TELEGRAM_API_HASH']),
  };
}
function slotSession(slot = 0) {
  return slot === 0 ? firstEnv(['TELEGRAM_SESSION']) : firstEnv([`TELEGRAM_SESSION_${slot + 1}`]);
}
export function slotReady(slot = 0) {
  const api = slotApi(slot);
  return Boolean(api.apiId && api.apiHash && slotSession(slot));
}

async function getTelegramClient(slot = 0) {
  const { apiId, apiHash } = slotApi(slot);
  const session = slotSession(slot);
  if (!apiId || !apiHash || !session) {
    throw new Error(`Spare #${slot + 1} configured nahi hai (TELEGRAM_* env)`);
  }
  if (!tgClients.has(slot)) {
    const promise = (async () => {
      const main = await import('teleproto');
      const sessions = await import('teleproto/sessions');
      const client = new main.TelegramClient(
        new sessions.StringSession(String(session)),
        Number(apiId),
        String(apiHash),
        { connectionRetries: 3 },
      );
      await client.connect();
      return client;
    })().catch((error) => { tgClients.delete(slot); throw error; });
    tgClients.set(slot, promise);
  }
  return tgClients.get(slot);
}

async function disconnectAllTelegram() {
  for (const [, p] of tgClients) {
    try { const c = await p; await c.disconnect(); } catch {}
  }
  tgClients = new Map();
}

// ─── OTP bot ka LIVE mirror (page ke left pane ke liye) ───
// Last message + usme se nikla number/code, dono alag-alag. Sirf read karta
// hai — koi message bhejta nahi, koi token/credential log nahi karta.
function parseMirrorMessage(text = '') {
  const flat = String(text).replace(/\s+/g, ' ');
  // Phone: +91 85820 21057 / 8582021057 / 85820-21057 — pehle space/hyphen
  // hatao, phir 10-digit (6-9 se shuru) dhoondho.
  let phone = '';
  const compact = flat.replace(/[\s-]/g, '');
  const p = compact.match(/(?:\+?91)?([6-9]\d{9})(?!\d)/);
  if (p) phone = p[1];
  // OTP: "OTP: 5469" / "code 123456" / akele 6-digit number.
  const otp = (flat.match(/(?:otp|code)[^0-9]{0,12}(\d{4,8})/i)
    || flat.match(/(?:^|\D)(\d{6})(?:\D|$)/)
    || [])[1] || '';
  return { phone, otp };
}

let mirrorCache = { at: 0, slot: -1, data: null };
async function readOtpBotMirror({ slot = 0, botUsername = '', limit = 6 } = {}) {
  const bot = String(botUsername || firstEnv(['OTP_BOT_USERNAME']) || '').replace(/^@/, '');
  const out = { ok: false, bot, slot, messages: [], number: '', otp: '', at: new Date().toISOString(), error: '' };
  if (!bot) { out.error = 'OTP bot username set nahi hai (OTP_BOT_USERNAME)'; return out; }
  // 10s cache — page har 2s poll karta hai, Telegram ko satana nahi hai.
  if (mirrorCache.data && mirrorCache.slot === slot && Date.now() - mirrorCache.at < 10000
      && mirrorCache.data.bot === bot) return mirrorCache.data;
  try {
    const client = await getTelegramClient(slot);
    const msgs = await client.getMessages(bot, { limit });
    const list = [];
    for (const msg of msgs || []) {
      const text = String(msg?.message || '').trim();
      if (text) list.push({ id: msg?.id ?? null, text: text.slice(0, 600), at: msg?.date ? new Date(Number(msg.date) * 1000).toISOString() : '' });
    }
    out.ok = true;
    out.messages = list;
    const latest = list[0] || {};
    const parsed = parseMirrorMessage(latest.text || '');
    out.number = parsed.phone;
    out.otp = parsed.otp;
    out.latestAt = latest.at || '';
    mirrorCache = { at: Date.now(), slot, data: out };
  } catch (error) {
    out.error = String(error?.message || error).slice(0, 160);
  }
  return out;
}

// OTP bot se is number ka latest 6-digit code.
async function pollTelegramOtp({ mobile, botUsername, slot, timeoutMs = 45000, refreshMs = 2500 }) {
  const client = await getTelegramClient(slot);
  const deadline = Date.now() + timeoutMs;
  const last10 = String(mobile).slice(-10);
  while (Date.now() < deadline) {
    try {
      const msgs = await client.getMessages(botUsername, { limit: 8 });
      for (const msg of msgs || []) {
        const text = String(msg?.message || '');
        if (!text || !text.replace(/\D/g, '').includes(last10)) continue;
        const code = (text.match(/(?:^|\D)(\d{6})(?:\D|$)/) || [])[1];
        if (code) return code;
      }
    } catch (error) {
      logLine(`⚠️ OTP bot read: ${String(error?.message || error).slice(0, 90)}`);
    }
    await new Promise(r => setTimeout(r, refreshMs));
  }
  return '';
}

// ─── Service adapters ───
async function apiCall(url, { method = 'POST', headers = {}, body = null, timeoutMs = 45000 } = {}) {
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
  return { ok: res.ok, status: res.status, data };
}

function detailText(data, status) {
  if (!data) return `HTTP ${status}`;
  const d = data.detail ?? data.error ?? data.message ?? data.raw ?? '';
  if (typeof d === 'string' && d.trim()) return d.trim();
  if (Array.isArray(d)) return d.map(x => x?.msg || '').filter(Boolean).join(', ') || `HTTP ${status}`;
  return `HTTP ${status}`;
}

// 1) Gold Drop — register (number + OTP)
async function goldStart({ mobile, form }) {
  const email = String(form?.email || '');
  const plusEmail = /^([^@+]+)@(gmail\.com)$/i.test(email)
    ? (() => {
      const [user, domain] = email.split('@');
      const digits = String(mobile).split('');
      let suffix = '';
      for (let i = 0; i < 6 && digits.length; i++) suffix += digits.splice(Math.floor(Math.random() * digits.length), 1)[0];
      return `${user}+${suffix}@${domain}`;
    })()
    : email;
  logLine(`🟡 ${mobile} — register ho raha hai (${plusEmail})…`);
  // PEHLA RASTA: asli browser (site ka security check raw API par clear
  // nahi hota — solved token ke baad bhi wahi rejection). Browser na chale
  // tabhi direct API + NoCaptchaAI.
  if (goldDropBrowserAvailable()) {
    try {
      logLine('🌐 Asli browser (stealth) se form bhar raha hoon…');
      const browser = await getSharedBrowser({ nocapApiKey: form?.nocapKey || NOCAP_KEY });
      const out = await browserRegister(browser, {
        name: form?.name || 'Rahul Kumar',
        mobile,
        email: plusEmail,
        pincode: form?.pincode || '509412',
        code: form?.code || 'KKD2LS01261026',
        imageBase64: DEFAULT_GOLD_PHOTO,
      });
      if (!out?.ok) throw new Error(String(out?.message || 'Browser registration fail').slice(0, 220));
      state.goldBrowser = { name: form?.name || 'Rahul Kumar', email: plusEmail, pincode: form?.pincode || '509412', code: form?.code || 'KKD2LS01261026', mobile };
      logLine(`✅ Browser se register ho gaya — ${out.message || out.stage}. OTP ka wait…`);
      return { stage: 'need_otp', message: 'OTP bot me aaya 6-digit code yahan daalo' };
    } catch (error) {
      logLine(`⚠️ Browser fail: ${String(error?.message || error).slice(0, 140)}`);
      state.goldBrowser = null;
    }
  }
  const res = await registerGoldDrop({
    name: form?.name || 'Rahul Kumar',
    mobile,
    email: plusEmail,
    pincode: form?.pincode || '',
    code: form?.code || '',
    imageBase64: DEFAULT_GOLD_PHOTO,
    nocapApiKey: form?.nocapKey || NOCAP_KEY,
  });
  if (res.securitySolved) logLine('🛡️ Security check aaya tha — NoCaptchaAI ne solve kiya ✅');
  else if (goldDropBrowserAvailable()) logLine('ℹ️ Direct API raasta — security check yahan clear nahi hota, browser mode chalao');
  logLine(`✅ Register ho gaya — ${res.message}. OTP ka wait…`);
  state.goldBrowser = null;
  return { stage: 'need_otp', message: 'OTP bot me aaya 6-digit code yahan daalo', secret: { type: 'gold', session: res.session } };
}

async function goldOtp({ otp }) {
  logLine(`🔐 Gold Drop OTP verify…`);
  // Browser se register hua tha to OTP bhi usi asli page par daalna hoga.
  if (state.goldBrowser) {
    const browser = await getSharedBrowser({ nocapApiKey: NOCAP_KEY });
    const out = await browserVerifyOtp(browser, otp, {
      ...state.goldBrowser,
      image: DEFAULT_GOLD_PHOTO,
    });
    if (!out?.ok) throw new Error(String(out?.message || 'OTP verify fail').slice(0, 220));
    logLine(`✅ ${state.phone} verified (browser) — ${out.message || 'done'}`);
    state.results.push({ phone: state.phone, ok: true, message: String(out.message || 'Verified') });
    state.result = { kind: 'gold', message: String(out.message || 'Verified'), reward: null };
    state.goldBrowser = null;
    state.secret = null;
    finishOrNext();
    return;
  }
  const res = await verifyGoldDropOtp({ session: state.secret?.session, otp });
  const reward = res.reward?.name ? ` 🎁 ${res.reward.name} (${res.reward.faceValue})` : '';
  logLine(`✅ ${state.phone} verified — ${res.message}${reward}`);
  state.results.push({ phone: state.phone, ok: true, message: `${res.message}${reward}` });
  const result = { kind: 'gold', message: `${res.message}${reward}`, reward: res.reward || null };
  state.result = result;
  state.secret = null;
  finishOrNext();
  return result;
}

// 2) Toing Pro — send_otp → verify → export
async function toingStart({ mobile }) {
  logLine(`🌐 ${mobile} — Toing Pro send_otp…`);
  const send = await apiCall(`${TOING_BASE}/api/auth/send_otp`, {
    headers: { 'Content-Type': 'application/json', 'x-user-key': TOING_KEY },
    body: { mobile },
  });
  const d = send.data || {};
  if (!send.ok || !d.success || !d.sid) throw new Error(d.error || d.detail || 'send_otp failed');
  state.secret = {
    type: 'toing',
    sid: d.sid,
    tid: d.tid,
    deviceId: d.device_id || '',
    isNew: d.registered === false || d.is_new === true,
  };
  state.phone = mobile;
  logLine('✅ OTP bheja gaya — OTP bot me dekho');
  state.step = 'need_otp';
  state.message = 'OTP bot me aaya 6-digit code yahan daalo';
}

async function toingOtp({ otp }) {
  const s = state.secret || {};
  logLine('🔐 Toing Pro verify_otp…');
  const verify = await apiCall(`${TOING_BASE}/api/auth/verify_otp`, {
    headers: { 'Content-Type': 'application/json', 'x-user-key': TOING_KEY },
    body: {
      mobile: state.phone,
      otp,
      sid: s.sid,
      tid: s.tid,
      device_id: s.deviceId,
      is_new: Boolean(s.isNew),
    },
  });
  const v = verify.data || {};
  if (!verify.ok || !v.success) throw new Error(v.error || v.detail || 'verify_otp failed');
  logLine('✅ OTP verified — export…');
  const exp = await apiCall(`${TOING_BASE}/api/accounts/${encodeURIComponent(state.phone)}/export`, {
    headers: { 'Content-Type': 'application/json', 'x-user-key': TOING_KEY },
  });
  const raw = exp.data?.export || exp.data?.session || (exp.data?.success === false ? null : exp.data);
  if (!exp.ok || !raw || typeof raw !== 'object' || !Object.keys(raw).length) {
    throw new Error(`Export fail: ${detailText(exp.data, exp.status)}`);
  }
  const json = JSON.stringify(raw, null, 2);
  logLine(`🎉 ${state.phone} — Toing session ready (${json.length} bytes)`);
  state.results.push({ phone: state.phone, ok: true, message: 'Toing session export ho gaya' });
  state.result = { kind: 'session', fileName: `toing-${state.phone}.json`, json, preview: { mobile: state.phone } };
  state.secret = null;
  finishOrNext();
}

// 3) ZZBOT (Zepto) — login/otp → login/verify → export
async function zzbotStart({ mobile }) {
  logLine(`🟣 ${mobile} — Zepto login/otp…`);
  const send = await apiCall(`${ZZ_BASE}/api/login/otp`, {
    headers: { 'Content-Type': 'application/json', 'x-user-key': ZZ_KEY },
    body: { mobile },
  });
  const d = send.data || {};
  if (!send.ok || d.success === false || d.detail) throw new Error(detailText(d, send.status));
  state.secret = { type: 'zzbot', sid: d.sid || '', tid: d.tid || '' };
  state.phone = mobile;
  logLine('✅ OTP bheja gaya — OTP bot me dekho');
  state.step = 'need_otp';
  state.message = 'OTP bot me aaya 6-digit code yahan daalo';
}

async function zzbotOtp({ otp }) {
  logLine('🔐 Zepto login/verify…');
  const verify = await apiCall(`${ZZ_BASE}/api/login/verify`, {
    headers: { 'Content-Type': 'application/json', 'x-user-key': ZZ_KEY },
    body: { otp },
  });
  const v = verify.data || {};
  if (!verify.ok || v.success === false || v.detail) throw new Error(detailText(v, verify.status));
  logLine('✅ OTP verified — export…');
  const exp = await apiCall(`${ZZ_BASE}/api/accounts/${encodeURIComponent(state.phone)}/export`, {
    headers: { 'Content-Type': 'application/json', 'x-user-key': ZZ_KEY },
  });
  const raw = exp.data?.export || exp.data?.session || (exp.data?.success === false ? null : exp.data);
  if (!exp.ok || !raw || typeof raw !== 'object' || !Object.keys(raw).length) {
    throw new Error(`Export fail: ${detailText(exp.data, exp.status)}`);
  }
  const json = JSON.stringify(raw, null, 2);
  logLine(`🎉 ${state.phone} — Zepto session ready (${json.length} bytes)`);
  state.results.push({ phone: state.phone, ok: true, message: 'Zepto session export ho gaya' });
  state.result = { kind: 'session', fileName: `zzbot-${state.phone}.json`, json, preview: { mobile: state.phone } };
  state.secret = null;
  finishOrNext();
}

// 4) Custom — owner ke apne 3 endpoints
async function customStart({ mobile, form }) {
  const base = String(form?.baseUrl || '').replace(/\/+$/, '');
  const sendPath = String(form?.sendPath || '').trim();
  if (!base || !sendPath) throw new Error('Base URL aur send-OTP path do');
  logLine(`🧩 ${mobile} — custom send OTP (${sendPath})…`);
  const send = await apiCall(`${base}${sendPath.startsWith('/') ? sendPath : `/${sendPath}`}`, {
    headers: { 'Content-Type': 'application/json', ...(form?.userKey ? { 'x-user-key': form.userKey } : {}) },
    body: { mobile },
  });
  if (!send.ok) throw new Error(detailText(send.data, send.status));
  state.secret = { type: 'custom', form, sendData: send.data };
  state.phone = mobile;
  logLine('✅ Send OK — OTP bot me dekho');
  state.step = 'need_otp';
  state.message = 'OTP bot me aaya 6-digit code yahan daalo';
}

async function customOtp({ otp }) {
  const s = state.secret || {};
  const form = s.form || {};
  const base = String(form.baseUrl || '').replace(/\/+$/, '');
  const path = String(form.verifyPath || '').trim();
  if (!base || !path) throw new Error('Verify path do');
  logLine('🔐 Custom verify…');
  const verify = await apiCall(`${base}${path.startsWith('/') ? path : `/${path}`}`, {
    headers: { 'Content-Type': 'application/json', ...(form.userKey ? { 'x-user-key': form.userKey } : {}) },
    body: { otp, mobile: state.phone, ...(form.exportPath ? {} : {}) },
  });
  if (!verify.ok) throw new Error(detailText(verify.data, verify.status));
  const json = JSON.stringify(verify.data, null, 2);
  logLine(`🎉 ${state.phone} — custom result ready (${json.length} bytes)`);
  state.results.push({ phone: state.phone, ok: true, message: 'Custom result mil gaya' });
  state.result = { kind: 'session', fileName: `custom-${state.phone}.json`, json, preview: { mobile: state.phone } };
  state.secret = null;
  finishOrNext();
}

const ADAPTERS = {
  gold: { start: goldStart, otp: goldOtp },
  toing: { start: toingStart, otp: toingOtp },
  zzbot: { start: zzbotStart, otp: zzbotOtp },
  custom: { start: customStart, otp: customOtp },
};

function finishOrNext() {
  state.result = state.result || null;
  if (state.results.length >= state.target) {
    state.step = 'done';
    state.message = `${state.target} numbers process ho gaye — result neeche`;
  } else {
    state.step = 'need_phone';
    state.message = 'Agla number daalo';
  }
}

// ─── START the process (step 4) ───
async function beginRun({ form = {} } = {}) {
  const adapter = ADAPTERS[state.service];
  if (!adapter) throw new Error('Pehle service chuno');
  if (!state.botId) throw new Error('OTP bot chuno');
  if (state.service !== 'custom' && state.spareSlot < 0) throw new Error('Spare account chuno');
  // Custom service: endpoints pehle hi check kar lo (warna number ke baad pata chalta tha)
  if (state.service === 'custom') {
    const base = String(form?.baseUrl || '').trim();
    if (!/^https?:\/\//i.test(base)) throw new Error('Custom: base URL https:// se shuru hona chahiye');
    if (!String(form?.sendPath || '').trim()) throw new Error('Custom: send-OTP path daalo');
    if (!String(form?.verifyPath || '').trim()) throw new Error('Custom: verify path daalo');
  }
  state.form = form;
  state.step = 'need_phone';
  state.message = 'Pehla mobile number daalo';
  logLine(`▶ START — ${SERVICES[state.service].label} · ${botById(state.botId).emoji} ${botById(state.botId).label}`
    + `${state.spareSlot >= 0 ? ` · spare #${state.spareSlot + 1}` : ''} · target ${state.target}`);
}

async function handlePhone(mobile) {
  const adapter = ADAPTERS[state.service];
  try {
    const out = await adapter.start({ mobile, form: state.form || {} }) || {};
    if (out.stage) state.step = out.stage;
    if (out.message) state.message = out.message;
    if (out.secret !== undefined) state.secret = out.secret;
    if (!state.phone) state.phone = mobile;
  } catch (error) {
    const message = String(error?.message || error).slice(0, 200);
    logLine(`❌ ${mobile} — ${message}`);
    state.results.push({ phone: mobile, ok: false, message });
    finishOrNext();
  }
}

async function handleOtp(otp) {
  const adapter = ADAPTERS[state.service];
  try {
    await adapter.otp({ otp });
  } catch (error) {
    const message = String(error?.message || error).slice(0, 200);
    logLine(`❌ ${state.phone} — ${message}`);
    state.results.push({ phone: state.phone, ok: false, message });
    state.secret = null;
    state.phone = '';
    finishOrNext();
  }
}

// ─── UI ───
const css = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{background:#0d0f1a;color:#e9ecf5;font-family:system-ui,Segoe UI,Roboto,sans-serif;margin:0;padding:20px}
.wrap{max-width:720px;margin:0 auto}
h1{font-size:20px;margin:0 0 2px}
.sub{color:#8b92b0;font-size:13px;margin-bottom:16px}
.crumbs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px;font-size:12px;color:#8b92b0}
.crumbs b{color:#cdd3ea}
.card{background:#161a2b;border:1px solid #272c44;border-radius:14px;padding:16px;margin-bottom:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}
.svc{position:relative;border-radius:12px;padding:0;overflow:hidden;border:1px solid #272c44;background:#12162a;cursor:pointer;text-align:left;color:inherit}
.svc .banner{height:74px;background-size:cover;background-position:center;display:flex;align-items:center;justify-content:center;font-size:28px}
.svc .body{padding:10px 12px}
.svc .name{font-weight:700;font-size:15px}
.svc .tag{color:#8b92b0;font-size:12px;margin-top:2px}
.svc.on{border-color:#7c5cff;box-shadow:0 0 0 1px #7c5cff inset}
.svc .tick{position:absolute;top:8px;right:8px;background:#7c5cff;border-radius:99px;width:20px;height:20px;display:none;align-items:center;justify-content:center;font-size:12px}
.svc.on .tick{display:flex}
label{display:block;font-size:12px;color:#9aa1bd;margin:10px 0 4px}
input,select,button,textarea{width:100%;padding:10px 12px;border-radius:9px;border:1px solid #2a3050;background:#0d1122;color:#e9ecf5;font-size:15px}
button{cursor:pointer;font-weight:700;border:none;background:#7c5cff;color:#fff;margin-top:10px}
button.ghost{background:#232845;color:#e9ecf5}
button.ok{background:#1f8a4c}
button:disabled{opacity:.45;cursor:not-allowed}
.row{display:flex;gap:10px}.row>*{flex:1}
.chip{display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border-radius:99px;background:#12162a;border:1px solid #272c44;cursor:pointer;font-size:13px;margin:4px 6px 0 0}
.chip.on{background:#221b45;border-color:#7c5cff;color:#fff}
.status{background:#10142a;border:1px solid #2a3050;border-radius:10px;padding:12px;font-size:14px;white-space:pre-wrap}
.log{background:#080a12;border-radius:10px;padding:10px;font:12px/1.5 ui-monospace,monospace;color:#7d84a8;max-height:220px;overflow:auto;white-space:pre-wrap}
pre.json{background:#080a12;border-radius:10px;padding:10px;font:11px/1.5 ui-monospace,monospace;color:#9fe3b0;max-height:240px;overflow:auto;white-space:pre-wrap}
a.dl{display:block;text-align:center;margin-top:10px;padding:10px;border-radius:9px;background:#1f8a4c;color:#fff;text-decoration:none;font-weight:700}
.badge{display:inline-block;padding:2px 10px;border-radius:99px;background:#232845;font-size:12px}
.err{color:#ff6b6b;font-size:13px;margin-top:10px;display:none}
.steps{display:flex;gap:6px;font-size:11px;color:#8b92b0;flex-wrap:wrap;margin-top:8px}
.steps span{background:#12162a;border:1px solid #272c44;padding:3px 8px;border-radius:99px}
.hint{color:#8b92b0;font-size:12px;margin-top:8px}
/* ── do-pane layout: left = OTP bot mirror, right = process ── */
.split{display:grid;grid-template-columns:minmax(280px,1fr) minmax(320px,1.15fr);gap:14px;align-items:start}
@media(max-width:860px){.split{grid-template-columns:1fr}}
.pane{position:sticky;top:12px}
@media(max-width:860px){.pane{position:static}}
.mirror{background:#0b0e18;border:1px solid #272c44;border-radius:14px;overflow:hidden}
.mirror .head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;background:#12162a;border-bottom:1px solid #272c44;font-size:13px;font-weight:700}
.mirror .head .dot{width:8px;height:8px;border-radius:99px;background:#4a5070;display:inline-block;margin-right:6px}
.mirror .head .dot.live{background:#28c76f;box-shadow:0 0 6px #28c76f}
.mirror .chat{padding:10px;max-height:340px;overflow:auto;display:flex;flex-direction:column;gap:8px}
.mirror .bubble{background:#1a2036;border:1px solid #2a3050;border-radius:10px 10px 10px 3px;padding:8px 10px;font-size:12.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.mirror .bubble small{display:block;color:#6f769a;font-size:10.5px;margin-top:4px}
.mirror .bubble .code{display:inline-block;margin-top:4px;background:#0d3b22;color:#7ee2a8;border:1px solid #1f6b3a;border-radius:6px;padding:1px 7px;font:600 12px ui-monospace,monospace}
.mirror .empty{color:#6f769a;font-size:12px;padding:12px;text-align:center}
.mirror .foot{padding:10px 12px;border-top:1px solid #272c44;display:flex;flex-direction:column;gap:8px}
.mirror .kv{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:#8b92b0}
.mirror .kv b{color:#e9ecf5;font:600 12.5px ui-monospace,monospace}
.mirror button{margin-top:0}
`;

const LOGIN_HTML = `<!doctype html><html lang="hi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Service Hub — Login</title>
<style>${css}
body{display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{width:100%;max-width:360px}
</style></head><body><div class="card">
<h1>🌐 Service Hub</h1>
<div class="sub">Login karo — sirf apne log.</div>
<form method="POST" action="/login">
<input name="password" type="password" placeholder="Password" autofocus>
<button type="submit">🔓 Login</button>
<div class="err" id="err">Galat password</div>
</form></div>
<script>if(location.search.indexOf('wrong')>-1)document.getElementById('err').style.display='block';</script>
</body></html>`;

const PAGE_HTML = `<!doctype html><html lang="hi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Service Hub</title>
<style>${css}</style></head><body><div class="wrap">
<h1>🌐 Service Hub</h1>
<div class="sub">Pehle service chuno → spare account → bot → START. <a href="/logout" style="color:#7c5cff">Logout</a></div>
<div class="crumbs" id="crumbs"></div>
<div class="split">
<!-- ⬅️ LEFT: OTP bot ka live mirror -->
<div class="pane">
  <div class="mirror">
    <div class="head"><span><span class="dot" id="mDot"></span>OTP bot mirror</span><span class="badge" id="mBot">—</span></div>
    <div class="chat" id="mChat"><div class="empty">Spare + bot chuno…</div></div>
    <div class="foot">
      <div class="kv"><span>Number</span><b id="mNumber">—</b></div>
      <div class="kv"><span>OTP</span><b id="mOtp">—</b></div>
      <button class="ghost" id="mRefresh">🔄 Refresh mirror</button>
      <button id="mNext">📱 Naya number lo</button>
      <div class="hint" id="mHint" style="margin-top:0"></div>
    </div>
  </div>
  <!-- 3 Telegram account cards -->
  <div style="margin-top:12px;font:700 12.5px/1.4 system-ui;color:#f7b500">📱 Telegram accounts (3)</div>
  <div id="tgCards" style="display:grid;gap:8px;margin-top:6px"></div>
  <!-- 3 claim bot cards -->
  <div style="margin-top:12px;font:700 12.5px/1.4 system-ui;color:#f7b500">🎯 Claim bots (3) — /start → Manual Claim → number → OTP ×3</div>
  <div id="claimCards" style="display:grid;gap:8px;margin-top:6px"></div>
</div>
<!-- ➡️ RIGHT: process -->
<div class="pane" id="rightPane">

<div class="card" id="c-service">
  <div style="font-weight:700;margin-bottom:10px">1️⃣ Kis service ke liye?</div>
  <div class="grid" id="svcGrid"></div>
  <div class="hint" id="svcHint"></div>
</div>

<div class="card" id="c-spare" style="display:none">
  <div style="font-weight:700;margin-bottom:2px">2️⃣ Spare account</div>
  <div class="hint">Kaun OTP bot padhega — spare Telegram account.</div>
  <div id="spareList" style="margin-top:8px"></div>
  <button class="ghost" id="toBot">Aage → OTP bot</button>
</div>

<div class="card" id="c-bot" style="display:none">
  <div style="font-weight:700;margin-bottom:2px">3️⃣ OTP bot</div>
  <div class="hint">Number aur OTP kahan se aayega.</div>
  <div id="botList" style="margin-top:8px"></div>
  <button class="ghost" id="toStart">Aage → Setup</button>
</div>

<div class="card" id="c-start" style="display:none">
  <div style="font-weight:700;margin-bottom:2px">4️⃣ Setup &amp; START</div>
  <div id="svcForm"></div>
  <label>Kitne numbers?</label><input id="target" type="number" value="1" min="1" max="50">
  <button id="start">▶ START the process</button>
  <button class="ghost" id="testCaptcha">🛡️ Captcha test (key + sitekey)</button>
  <div class="hint" id="captchaOut"></div>
  <button class="ghost" id="backBot">↩️ Bot badlo</button>
</div>

<div class="card" id="c-run" style="display:none">
  <div class="status"><span class="badge" id="st">…</span> <b id="prog"></b><div id="msg" style="margin-top:6px"></div></div>
  <div id="askPhone" style="display:none">
    <label>Mobile number (apne OTP bot se naya number lo)</label>
    <input id="phone" inputmode="numeric" maxlength="10" placeholder="9876543210">
    <button id="sendPhone">Number bhejo → OTP</button>
    <div class="hint" id="otpHint"></div>
  </div>
  <div id="askOtp" style="display:none">
    <label>OTP</label>
    <input id="otp" inputmode="numeric" maxlength="6" placeholder="123456">
    <button id="sendOtp">OTP verify karo</button>
    <button class="ghost" id="autoOtp">🤖 Auto — bot se khud uthao</button>
  </div>
  <button class="ghost" id="reset" style="margin-top:14px">■ Stop / Reset</button>
  <div id="out" style="display:none">
    <label>Result</label>
    <pre class="json" id="json"></pre>
    <a class="dl" id="dl" href="#" download>⬇️ Download</a>
  </div>
  <div class="log" id="log" style="margin-top:12px"></div>
  <div class="log" id="results" style="display:none"></div>
</div>
</div><!-- /right pane -->
</div><!-- /split -->
</div>
<script>
var S = { config: null, state: null, timer: null };

function $(id){ return document.getElementById(id) }
function show(id,on){ $(id).style.display = on ? 'block' : 'none' }
function post(url, body){ return fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})}).then(function(r){return r.json()}) }

function paintCrumbs(){
  var s = S.state || {};
  var c = S.config || {};
  var svc = (c.services||[]).filter(function(x){return x.id===s.service})[0];
  var bot = (c.bots||[]).filter(function(x){return x.id===s.botId})[0];
  var parts = ['<span>Service: <b>'+(svc?svc.emoji+' '+svc.label:'—')+'</b></span>'];
  if (s.spareSlot>=0) parts.push('<span>Spare: <b>#'+(s.spareSlot+1)+'</b></span>');
  if (bot) parts.push('<span>Bot: <b>'+bot.emoji+' '+bot.label+'</b></span>');
  $('crumbs').innerHTML = parts.join('');
}

function paintServices(){
  if (!$('svcGrid').children.length){
    (S.config.services||[]).forEach(function(sv){
      var b = document.createElement('button');
      b.className = 'svc'; b.dataset.id = sv.id;
      b.innerHTML = '<div class="banner">'+sv.emoji+'</div>'
        + '<div class="body"><div class="name">'+sv.emoji+' '+sv.label+'</div><div class="tag">'+sv.tagline+'</div></div>'
        + '<div class="tick">✓</div>';
      b.onclick = function(){ post('/pick',{service:sv.id}).then(paint) };
      $('svcGrid').appendChild(b);
    });
    // Banner: pehle gradient (hamesha dikhega), uske upar image — file na ho to
    // sirf gradient + emoji rehta hai (koi broken image nahi).
    (S.config.services||[]).forEach(function(sv){
      var el = $('svcGrid').querySelector('[data-id="'+sv.id+'"] .banner');
      if (!el) return;
      el.style.background = sv.gradient;
      fetch(sv.banner, { method: 'HEAD' }).then(function(r){
        if (r.ok) el.style.background = 'linear-gradient(135deg,rgba(0,0,0,.35),rgba(0,0,0,.6)), url('+sv.banner+') center/cover';
      }).catch(function(){});
    });
  }
  var cur = (S.state||{}).service;
  Array.prototype.forEach.call($('svcGrid').children, function(el){
    el.classList.toggle('on', el.dataset.id === cur);
  });
  var svc = (S.config.services||[]).filter(function(x){return x.id===cur})[0];
  $('svcHint').innerHTML = svc
    ? 'Chuna: <b>'+svc.emoji+' '+svc.label+'</b> — '+svc.steps.join(' → ')
    : '';
}

function paintSpares(){
  var s = S.state || {};
  $('spareList').innerHTML = '';
  (S.config.spares||[]).forEach(function(sp){
    var chip = document.createElement('span');
    chip.className = 'chip' + (s.spareSlot===sp.slot?' on':'');
    chip.textContent = (sp.configured? '✅ ' : '⚙️ ') + sp.label + (sp.configured && sp.masked ? ' · '+sp.masked : ' (env set nahi)');
    chip.onclick = function(){ post('/pick',{spareSlot:sp.slot}).then(paint) };
    $('spareList').appendChild(chip);
  });
}

function paintBots(){
  var s = S.state || {};
  $('botList').innerHTML = '';
  (S.config.bots||[]).forEach(function(b){
    var chip = document.createElement('span');
    chip.className = 'chip' + (s.botId===b.id?' on':'');
    chip.textContent = b.emoji + ' ' + b.label + (b.username? ' (@'+b.username+')' : '');
    chip.onclick = function(){ post('/pick',{botId:b.id}).then(paint) };
    $('botList').appendChild(chip);
  });
}

function paintForm(){
  var s = S.state || {};
  var svc = (S.config.services||[]).filter(function(x){return x.id===s.service})[0];
  if (!svc) return;
  var html = '';
  (svc.form||[]).forEach(function(f){
    html += '<label>'+f.label+'</label><input id="f_'+f.id+'" value="'+(f.value||'').replace(/"/g,'&quot;')+'">';
  });
  if (svc.id==='custom'){
    html += '<label>Base URL</label><input id="f_baseUrl" placeholder="https://mysite.com/api">';
    html += '<label>Send OTP path</label><input id="f_sendPath" placeholder="/login/otp">';
    html += '<label>Verify path</label><input id="f_verifyPath" placeholder="/login/verify">';
    html += '<label>Access key (optional, x-user-key)</label><input id="f_userKey">';
  }
  $('svcForm').innerHTML = html;
}

function collectForm(){
  var out = {};
  Array.prototype.forEach.call($('svcForm').querySelectorAll('input'), function(inp){
    out[inp.id.replace(/^f_/,'')] = inp.value.trim();
  });
  return out;
}

function paint(s){
  S.state = s;
  var st = s.step;
  var chosen = Boolean(s.service);
  show('c-spare', chosen && s.service!=='custom');
  show('c-bot', chosen && (s.service!=='custom' || s.botId));
  show('c-start', chosen && Boolean(s.botId));
  show('c-run', st==='need_phone'||st==='need_otp'||st==='working'||st==='done');
  // Form sirf ek baar (service badalne par) render hota hai — warna har
  // 1.2s poll typed values uda deta tha.
  if (chosen && s.botId && S.formFor !== s.service) { paintForm(); S.formFor = s.service; }
  if (!chosen) S.formFor = null;

  if (st==='service'){ show('c-spare',false); show('c-bot',false); show('c-start',false); show('c-run',false); }
  paintCrumbs(); paintServices(); paintSpares(); paintBots();

  $('st').textContent = st;
  $('prog').textContent = s.count + ' / ' + s.target + ' done';
  $('msg').textContent = s.message || '';
  show('askPhone', st==='need_phone');
  show('askOtp', st==='need_otp');
  if (st==='need_phone'){
    $('otpHint').textContent = s.telegramReady
      ? 'Auto-OTP ready hai — "🤖 Auto" dabao, ya OTP bot se code khud daalo.'
      : 'Auto-OTP env set nahi — OTP bot me dekho aur yahan daalo (manual).';
  }
  $('log').textContent = (s.log||[]).slice(-40).join('\\n');
  var r = $('results');
  if ((s.results||[]).length){
    r.style.display='block';
    r.textContent = s.results.map(function(x){return (x.ok?'✅':'❌')+' '+x.phone+' — '+x.message}).join('\\n');
  }
  if (s.result && s.result.kind==='session'){
    show('out', true);
    $('json').textContent = s.result.json;
    $('dl').href = 'data:application/json;charset=utf-8,' + encodeURIComponent(s.result.json);
    $('dl').download = s.result.fileName;
  } else if (s.result && s.result.kind==='gold'){
    show('out', true);
    $('json').textContent = s.result.message;
    $('dl').style.display='none';
  } else { show('out', false); }
}

function poll(){
  fetch('/state').then(function(r){return r.json()}).then(function(s){
    if ((s.log||[]).length && S.state && s.log.length < (S.state.log||[]).length) { /* keep */ }
    paint(s);
  }).catch(function(){});
}

function boot(){
  fetch('/config').then(function(r){return r.json()}).then(function(cfg){
    S.config = cfg;
    (cfg.services||[]).forEach(function(sv){
      // banner image na ho to gradient hi rahe
      var img = new Image(); img.onerror = function(){};
      img.src = sv.banner;
    });
    poll();
    S.timer = setInterval(poll, 1200);
    loadMirror();
    M.timer = setInterval(loadMirror, 5000);
    refreshCards();
    setInterval(refreshCards, 5000);
  });
}

// ═══ 3 Telegram account + 3 claim bot cards ═══
var TC = {}, CR = {};
function esc2(t){ return String(t==null?'':t).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c] }) }
function tstr(iso){ if(!iso) return ''; var d=new Date(iso); return isNaN(d)?'':d.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',second:'2-digit'}) }
function chatOf(list, empty){
  if (!(list||[]).length) return '<div class="hint">' + esc2(empty) + '</div>';
  return list.map(function(x){
    return '<div style="background:#161c33;border:1px solid #232845;border-radius:9px;padding:6px 8px;font-size:11.5px;line-height:1.45;white-space:pre-wrap;word-break:break-word">'
      + esc2(x.text) + '<div style="color:#6f769a;font-size:10px;margin-top:3px">' + esc2(x.kind||'') + ' · ' + tstr(x.at) + '</div></div>';
  }).join('');
}
function tgCard(slot, c){
  c = c || {};
  return '<div style="background:#10142a;border:1px solid ' + (c.ok?'#1f6b3a':'#232845') + ';border-radius:12px;padding:10px">'
    + '<div style="display:flex;justify-content:space-between;font:700 12.5px system-ui">Account #' + (slot+1)
    + '<span class="badge">' + (c.ready?'ready':'adhoora') + '</span></div>'
    + '<div class="hint" style="margin:2px 0">API ID <b>' + (c.apiIdSet?(c.apiIdMasked||'set'):'—') + '</b> · hash <b>' + (c.apiHashSet?'set':'—') + '</b> · session <b>' + (c.sessionSet?'set':'—') + '</b></div>'
    + '<input id="tgApi'+slot+'" placeholder="API ID (optional)">'
    + '<input id="tgHash'+slot+'" placeholder="API hash (optional)">'
    + '<input id="tgPhone'+slot+'" placeholder="+9198xxxxxxxx">'
    + '<button class="ghost" id="tgCode'+slot+'">Code bhejo</button>'
    + '<input id="tgLogin'+slot+'" placeholder="login code">'
    + '<input id="tgOtp'+slot+'" placeholder="2FA password (agar ho)">'
    + '<button id="tgApply'+slot+'">Login / save</button>'
    + '<div class="hint" id="tgOut'+slot+'"></div>'
    + '<div class="hint">Number <b>' + (c.number||'—') + '</b> · OTP <b>' + (c.otp||'—') + '</b></div>'
    + '<div style="display:grid;gap:6px;max-height:150px;overflow:auto;margin-top:6px">' + chatOf(c.messages, c.error||'session chahiye') + '</div>'
    + '</div>';
}
function claimCard(slot, r){
  r = r || {};
  return '<div style="background:#10142a;border:1px solid ' + (r.running?'#1f6b3a':'#232845') + ';border-radius:12px;padding:10px">'
    + '<div style="display:flex;justify-content:space-between;font:700 12.5px system-ui">Claim #' + (slot+1)
    + '<span class="badge">' + esc2(r.phase||'idle') + '</span></div>'
    + '<input id="clBot'+slot+'" value="' + esc2(r.bot||'rajafuckbot') + '">'
    + '<input id="clTarget'+slot+'" type="number" min="1" max="50" value="' + (r.target||1) + '">'
    + '<button id="clStart'+slot+'">▶ START</button>'
    + '<input id="clNumber'+slot+'" placeholder="number bhejo" inputmode="numeric">'
    + '<button class="ghost" id="clNumBtn'+slot+'">📱 number bhejo</button>'
    + '<input id="clOtp'+slot+'" placeholder="OTP bhejo" inputmode="numeric">'
    + '<button class="ghost" id="clOtpBtn'+slot+'">🔑 OTP bhejo</button>'
    + '<div class="hint" id="clMsg'+slot+'">' + esc2(r.message||'START dabao — /start → Manual Claim → number → OTP ×3') + '</div>'
    + '<div class="hint">' + (r.done||0) + '/' + (r.target||1) + ' · step ' + (r.step||0) + '/3</div>'
    + '<div style="display:grid;gap:6px;max-height:150px;overflow:auto;margin-top:6px">' + chatOf(r.transcript, 'kuch nahi hua abhi') + '</div>'
    + '</div>';
}
function renderCards(){
  $('tgCards').innerHTML = [0,1,2].map(function(s){ return tgCard(s, TC[s]) }).join('');
  $('claimCards').innerHTML = [0,1,2].map(function(s){ return claimCard(s, CR[s]) }).join('');
  [0,1,2].forEach(function(s){
    var cb = $('tgCode'+s); if (cb) cb.onclick = function(){
      $('tgOut'+s).textContent = 'code bhej raha hoon…';
      post('/tg/code',{slot:s, phone:$('tgPhone'+s).value.trim(), apiId:$('tgApi'+s).value.trim(), apiHash:$('tgHash'+s).value.trim()}).then(function(r){
        if (r.ok){ TC['login'+s] = r.loginId; $('tgOut'+s).textContent = '✅ ' + (r.message||'code bheja'); }
        else $('tgOut'+s).textContent = '❌ ' + (r.error||'fail');
      });
    };
    var ab = $('tgApply'+s); if (ab) ab.onclick = function(){
      post('/tg/signin',{loginId:TC['login'+s], code:$('tgLogin'+s).value.replace(/\D/g,''), password:$('tgOtp'+s).value||undefined}).then(function(r){
        if (r.ok && r.session){ $('tgOut'+s).textContent = '✅ ' + (r.message||'session set'); refreshCards(); }
        else if (r.ok && r.step==='password'){ $('tgOut'+s).textContent = '🔐 ' + (r.message||'2FA password chahiye'); }
        else $('tgOut'+s).textContent = '❌ ' + (r.error||r.message||'fail');
      });
    };
    var sb = $('clStart'+s); if (sb) sb.onclick = function(){
      $('clMsg'+s).textContent = 'START ho raha hai…';
      post('/claim/start',{slot:s, bot:$('clBot'+s).value.trim().replace(/^@/,''), target:Number($('clTarget'+s).value)||1}).then(function(r){
        if (!r.ok){ $('clMsg'+s).textContent = '❌ ' + (r.error||'fail'); return }
        CR[s] = r.run; CR['id'+s] = r.run.id; renderCards();
      });
    };
    var nb = $('clNumBtn'+s); if (nb) nb.onclick = function(){
      var v = $('clNumber'+s).value.trim(); if (!v) return;
      post('/claim/number',{runId:CR['id'+s], number:v}).then(function(r){
        $('clMsg'+s).textContent = r.ok ? ('✅ number queue me: ' + r.queued) : ('❌ ' + (r.error||'fail'));
        if (r.ok) $('clNumber'+s).value = '';
      });
    };
    var ob = $('clOtpBtn'+s); if (ob) ob.onclick = function(){
      var v = $('clOtp'+s).value.trim(); if (!v) return;
      post('/claim/otp',{runId:CR['id'+s], otp:v}).then(function(r){
        $('clMsg'+s).textContent = r.ok ? ('✅ OTP queue me: ' + r.queued) : ('❌ ' + (r.error||'fail'));
        if (r.ok) $('clOtp'+s).value = '';
      });
    };
  });
}
function refreshCards(){
  return fetch('/cards').then(function(r){return r.json()}).then(function(d){
    (d.accounts||[]).forEach(function(a){ TC[a.slot] = a });
    (d.claims||[]).forEach(function(r){ if (r){ CR[r.slot] = r; CR['id'+r.slot] = r.id } });
    renderCards();
  }).catch(function(){});
}

$('toBot').onclick = function(){ post('/step',{step:'bot'}).then(paint) };
$('backBot').onclick = function(){ post('/step',{step:'bot'}).then(paint) };
$('toStart').onclick = function(){ post('/step',{step:'start'}).then(paint) };
$('start').onclick = function(){
  var body = { target: Number($('target').value)||1, form: collectForm() };
  post('/start', body).then(function(r){
    if (!r.ok){ alert(r.message||'Error'); return }
    post('/step',{step:'run'}).then(paint);
  });
};
$('sendPhone').onclick = function(){
  var m = $('phone').value.replace(/\\D/g,'').slice(-10);
  if (m.length!==10){ alert('10-digit mobile daalo'); return }
  $('phone').value = '';
  post('/phone',{mobile:m}).then(paint);
};
$('sendOtp').onclick = function(){
  var o = $('otp').value.replace(/\\D/g,'');
  if (o.length!==6){ alert('6-digit OTP daalo'); return }
  $('otp').value = '';
  post('/otp',{otp:o}).then(paint);
};
$('autoOtp').onclick = function(){
  var btn = $('autoOtp');
  btn.disabled = true; btn.textContent = '🤖 OTP dhoondh raha hoon…';
  fetch('/auto-otp').then(function(r){return r.json()}).then(function(res){
    btn.disabled = false; btn.textContent = '🤖 Auto — bot se khud uthao';
    if (!res.ok) alert(res.message || 'Auto-OTP fail — manual daalo');
    poll();
  }).catch(function(){ btn.disabled = false; btn.textContent = '🤖 Auto — bot se khud uthao' });
};
$('testCaptcha').onclick = function(){
  var btn = $('testCaptcha');
  btn.disabled = true; btn.textContent = '🛡️ Test chal raha hai…';
  var form = collectForm();
  post('/captcha-test', { nocapKey: form.nocapKey || '' }).then(function(res){
    btn.disabled = false; btn.textContent = '🛡️ Captcha test (key + sitekey)';
    var out = $('captchaOut');
    out.innerHTML = (res.ok ? '✅ ' : '❌ ') + (res.message || '')
      + (res.sitekeys && res.sitekeys.length ? '<br>sitekeys: <code>' + res.sitekeys.join('</code>, <code>') + '</code>' : '')
      + (res.sitekeyError ? '<br>⚠️ ' + res.sitekeyError : '');
  }).catch(function(){
    btn.disabled = false; btn.textContent = '🛡️ Captcha test (key + sitekey)';
  });
};
// ─── OTP bot mirror (left pane) ───
var M = { timer: null, last: null, lastOtp: '' };
function esc(t){ return String(t==null?'':t).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c] }) }
function fmtTime(iso){
  if (!iso) return '';
  var d = new Date(iso); if (isNaN(d)) return '';
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function paintMirror(m){
  var s = S.state || {};
  var bots = (S.config && S.config.bots) || [];
  var bot = bots.filter(function(x){ return x.id===s.botId })[0];
  $('mBot').textContent = m.bot ? ('@' + m.bot) : (bot ? bot.label : '—');
  var dot = $('mDot');
  dot.className = 'dot' + (m.ok ? ' live' : '');
  var chat = $('mChat');
  if (!m.ok){
    chat.innerHTML = '<div class="empty">' + esc(m.error || 'Mirror band hai') + '</div>';
  } else if (!(m.messages||[]).length){
    chat.innerHTML = '<div class="empty">Bot me abhi koi message nahi — NEW NUMBER dabao</div>';
  } else {
    chat.innerHTML = (m.messages||[]).map(function(x, i){
      var code = (String(x.text).match(/(?:^|\D)(\d{6})(?:\D|$)/)||[])[1];
      var body = esc(x.text);
      if (code) body = body.replace(code, '<span class="code">'+code+'</span>');
      return '<div class="bubble">' + body + '<small>#' + (x.id||'') + ' · ' + fmtTime(x.at) + (i===0?' · latest':'') + '</small></div>';
    }).join('');
  }
  $('mNumber').textContent = m.number || '—';
  $('mOtp').textContent = m.otp || '—';
  M.last = m;
  // OTP aaya aur field khali hai to auto-fill (user ko type nahi karna padta).
  if (m.otp && m.otp !== M.lastOtp){
    M.lastOtp = m.otp;
    var f = $('otp');
    if (f && !f.value) { f.value = m.otp; $('mHint').textContent = 'OTP mirror se bhar diya — verify dabao'; }
  }
  var s2 = S.state || {};
  $('mHint').textContent = m.ok
    ? (m.messages||[]).length + ' messages · ' + (s2.spareSlot>=0 ? 'spare #'+(s2.spareSlot+1) : 'spare chuno')
    : '';
}
function loadMirror(){
  var s = S.state || {};
  var bot = '';
  try {
    var cfg = S.config || {};
    var b = (cfg.bots||[]).filter(function(x){ return x.id === s.botId })[0];
    bot = (b && b.username) || '';
  } catch(e){}
  var q = '/otp-mirror?slot=' + (s.spareSlot>=0 ? s.spareSlot : 0) + (bot ? ('&bot=' + encodeURIComponent(bot)) : '');
  fetch(q).then(function(r){ return r.json() }).then(paintMirror).catch(function(){});
}
$('mRefresh').onclick = loadMirror;
$('mNext').onclick = function(){
  loadMirror();
  // Mirror se fresh number uthao; na mile to "NEW NUMBER" ka message bhejne ko bolo
  setTimeout(function(){
    var n = (M.last && M.last.number) || '';
    if (n && /^[6-9]\d{9}$/.test(n)) {
      $('phone').value = n;
      $('phone').focus();
      $('mHint').textContent = 'Number mirror se bhar diya — "Number bhejo" dabao';
    } else {
      $('mHint').textContent = 'Bot me naya number nahi mila — OTP bot me NEW NUMBER dabao, phir Refresh';
    }
  }, 400);
};
$('reset').onclick = function(){ post('/reset').then(function(){ location.reload() }) };
boot();
</script></body></html>`;

// ─── HTTP helpers ───
function sendJson(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function sendBanner(res, id) {
  const file = path.join(PUBLIC_DIR, `${id}.jpg`);
  if (!existsSync(file)) { res.writeHead(204); res.end(); return; }
  try {
    const buf = readFileSync(file);
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
    res.end(buf);
  } catch { res.writeHead(204); res.end(); }
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  try {
    // login
    if (url.pathname === '/login') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(LOGIN_HTML);
        return;
      }
      if (req.method === 'POST') {
        let raw = '';
        await new Promise((r) => { req.on('data', (c) => { raw += c; }); req.on('end', r); });
        const pwd = new URLSearchParams(raw).get('password');
        res.writeHead(302, pwd === APP_PASSWORD
          ? { 'Set-Cookie': `${AUTH_COOKIE}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`, Location: '/' }
          : { Location: '/login?wrong=1' });
        res.end();
        return;
      }
    }
    if (url.pathname === '/logout') {
      res.writeHead(302, { 'Set-Cookie': 'hub_auth=; Path=/; HttpOnly; Max-Age=0', Location: '/login' });
      res.end();
      return;
    }

    // banners — public (login page par bhi chalega, credential nahi)
    if (url.pathname.startsWith('/banner/')) {
      sendBanner(res, url.pathname.replace('/banner/', '').replace(/[^a-z-]/g, ''));
      return;
    }

    if (!isAuthed(req)) {
      if (req.method === 'GET') { res.writeHead(302, { Location: '/login' }); res.end(); }
      else sendJson(res, 401, { ok: false, message: 'Login karo pehle' });
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE_HTML);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/config') {
      sendJson(res, 200, {
        services: Object.values(SERVICES).map(s => ({
          id: s.id, emoji: s.emoji, label: s.label, tagline: s.tagline,
          banner: s.banner, gradient: s.gradient, steps: s.steps, form: s.form,
          needsBot: s.needsBot,
        })),
        spares: spareSlots(),
        bots: BOTS.map(b => ({ id: b.id, emoji: b.emoji, label: b.label, username: b.username })),
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/state') {
      sendJson(res, 200, publicState());
      return;
    }

    if (req.method === 'POST' && url.pathname === '/captcha-test') {
      // Gold Drop ka captcha diagnose: key live test + site key fetch.
      const body = await readBody(req);
      const diag = await goldDropCaptchaDiagnose(String(body.nocapKey || '').trim() || NOCAP_KEY);
      sendJson(res, 200, {
        ok: Boolean(diag.keyOk && diag.sitekey),
        keyMasked: diag.keyMasked,
        keyOk: diag.keyOk,
        keyMessage: diag.keyMessage,
        sitekey: diag.sitekey ? `${diag.sitekey.slice(0, 12)}…` : '',
        sitekeys: (diag.sitekeys || []).map(k => `${k.slice(0, 12)}…`),
        sitekeyError: diag.sitekeyError,
        message: diag.sitekey
          ? `${diag.keyMessage} · sitekey mil gayi ✅`
          : `${diag.keyMessage} · ${diag.sitekeyError || 'sitekey nahi mili'}`,
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/otp-mirror') {
      const slot = Number(url.searchParams.get('slot'));
      const mirror = await readOtpBotMirror({
        slot: Number.isInteger(slot) && slot >= 0 ? slot : Math.max(0, state.spareSlot),
        botUsername: url.searchParams.get('bot') || '',
      });
      sendJson(res, 200, mirror);
      return;
    }

    // ── 3+3 cards (gold-drop page ke saath same contract) ──
    if (req.method === 'GET' && url.pathname === '/cards') {
      const accounts = [];
      for (let slot = 0; slot < 3; slot += 1) {
        // eslint-disable-next-line no-await-in-loop
        accounts.push(await readSlotCard({ slot }));
      }
      sendJson(res, 200, { ok: true, accounts, claims: [0, 1, 2].map(slot => latestClaimRun(slot)) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/tg/code') {
      const body = await readBody(req);
      sendJson(res, 200, await startTelegramLogin({ slot: Number(body.slot) || 0, phone: body.phone, apiId: body.apiId, apiHash: body.apiHash }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/tg/signin') {
      const body = await readBody(req);
      let out = await submitTelegramCode({ loginId: body.loginId, code: body.code });
      if (out.ok && out.step === 'password' && body.password) {
        out = await submitTelegramPassword({ loginId: body.loginId, password: body.password });
      }
      sendJson(res, 200, out);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/tg/save') {
      const body = await readBody(req);
      try {
        await setSlotCredentials({ slot: Number(body.slot) || 0, session: body.session || '', apiId: body.apiId || '', apiHash: body.apiHash || '' });
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message || error).slice(0, 200) });
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/claim/start') {
      const body = await readBody(req);
      const slot = Math.max(0, Math.min(2, Number(body.slot) || 0));
      const run = await startClaimRun({ slot, bot: String(body.bot || 'rajafuckbot'), target: Number(body.target) || 1 });
      sendJson(res, 200, { ok: true, run });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/claim/state') {
      const id = url.searchParams.get('runId');
      sendJson(res, 200, { ok: true, run: id ? getClaimRun(id) : latestClaimRun(Number(url.searchParams.get('slot')) || 0) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/claim/number') {
      const body = await readBody(req);
      sendJson(res, 200, pushClaimNumber(body.runId, body.number));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/claim/otp') {
      const body = await readBody(req);
      sendJson(res, 200, pushClaimOtp(body.runId, body.otp));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/auto-otp') {
      // OTP auto-read (spare + bot se). Manual entry ka alternative.
      const s = publicState();
      if (s.step !== 'need_otp' || !state.phone) { sendJson(res, 400, { ok: false, message: 'Abhi OTP ka wait nahi hai' }); return; }
      const bot = botById(state.botId);
      if (!bot.username) { sendJson(res, 400, { ok: false, message: 'Bot ka username nahi hai' }); return; }
      const slot = state.spareSlot >= 0 ? state.spareSlot : 0;
      const sessionStr = slot === 0
        ? firstEnv(['TELEGRAM_SESSION'])
        : firstEnv([`TELEGRAM_SESSION_${slot + 1}`]);
      if (!telegramConfigured() || !sessionStr) {
        sendJson(res, 200, { ok: false, message: `Spare #${slot + 1} configured nahi (TELEGRAM_* env) — OTP manual daalo` });
        return;
      }
      if (sessionStr.length < 40) {
        sendJson(res, 200, { ok: false, message: `Spare #${slot + 1} ka session string valid nahi lagta — OTP manual daalo` });
        return;
      }
      try {
        const code = await pollTelegramOtp({ mobile: state.phone, botUsername: bot.username, slot, timeoutMs: 45000 });
        if (!code) { sendJson(res, 200, { ok: false, message: 'OTP 45s me nahi mila — manual daalo' }); return; }
        logLine(`🔑 Auto-OTP mil gaya: ${code}`);
        state.step = 'working';
        state.message = 'OTP verify ho raha hai…';
        handleOtp(code);
        sendJson(res, 200, { ok: true, code });
      } catch (error) {
        const msg = String(error?.message || error).slice(0, 150);
        logLine(`⚠️ Auto-OTP: ${msg}`);
        sendJson(res, 200, { ok: false, message: `Auto-OTP fail: ${msg} — manual daalo` });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/pick') {
      const body = await readBody(req);
      if (state.step === 'need_phone' || state.step === 'need_otp' || state.step === 'working') {
        sendJson(res, 400, { ok: false, message: 'Run chal raha hai — Reset karo' });
        return;
      }
      if (body.service) {
        if (!SERVICES[body.service]) { sendJson(res, 400, { ok: false, message: 'Unknown service' }); return; }
        state.service = body.service;
        state.step = 'spare';
        state.message = 'Spare account chuno';
        state.secret = null; state.phone = ''; state.result = null; state.results = [];
      }
      if (body.spareSlot !== undefined) {
        const slot = Number(body.spareSlot);
        if (!Number.isInteger(slot) || slot < 0 || slot > 8) { sendJson(res, 400, { ok: false, message: 'Bad slot' }); return; }
        state.spareSlot = slot;
        state.step = 'bot';
        state.message = 'OTP bot chuno';
      }
      if (body.botId) {
        if (!BOTS.some(b => b.id === body.botId)) { sendJson(res, 400, { ok: false, message: 'Unknown bot' }); return; }
        state.botId = body.botId;
        state.step = 'start';
        state.message = 'Setup karke START dabao';
      }
      sendJson(res, 200, { ok: true, state: publicState() });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/step') {
      const body = await readBody(req);
      const wanted = String(body.step || '');
      if (['service', 'spare', 'bot', 'start', 'run'].includes(wanted)) {
        state.step = wanted;
        sendJson(res, 200, { ok: true, state: publicState() });
        return;
      }
      sendJson(res, 400, { ok: false, message: 'Unknown step' });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/start') {
      const body = await readBody(req);
      if (state.step === 'need_phone' || state.step === 'need_otp' || state.step === 'working') {
        sendJson(res, 400, { ok: false, message: 'Pehle run chal raha hai — Reset karo' });
        return;
      }
      state.target = Math.max(1, Math.min(50, Number(body.target) || 1));
      state.results = [];
      state.log = [];
      state.result = null;
      state.secret = null;
      state.phone = '';
      try {
        await beginRun({ form: body.form || {} });
        sendJson(res, 200, { ok: true, state: publicState() });
      } catch (error) {
        sendJson(res, 400, { ok: false, message: String(error?.message || error).slice(0, 200) });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/phone') {
      const body = await readBody(req);
      if (state.step !== 'need_phone') { sendJson(res, 400, { ok: false, message: 'Abhi number nahi chahiye' }); return; }
      const mobile = String(body.mobile || '').replace(/\D/g, '').slice(-10);
      if (!/^[6789]\d{9}$/.test(mobile)) { sendJson(res, 400, { ok: false, message: 'Valid 10-digit Indian mobile daalo' }); return; }
      state.step = 'working';
      state.message = 'OTP bheja ja raha hai…';
      sendJson(res, 200, { ok: true });
      handlePhone(mobile); // background
      return;
    }

    if (req.method === 'POST' && url.pathname === '/otp') {
      const body = await readBody(req);
      if (state.step !== 'need_otp') { sendJson(res, 400, { ok: false, message: 'Abhi OTP nahi chahiye' }); return; }
      const otp = String(body.otp || '').replace(/\D/g, '');
      if (!/^\d{6}$/.test(otp)) { sendJson(res, 400, { ok: false, message: '6-digit OTP daalo' }); return; }
      state.step = 'working';
      state.message = 'OTP verify ho raha hai…';
      sendJson(res, 200, { ok: true });
      handleOtp(otp); // background
      return;
    }

    if (req.method === 'POST' && url.pathname === '/reset') {
      await disconnectAllTelegram().catch(() => {});
      Object.assign(state, {
        step: 'service', service: '', spareSlot: -1, botId: '', target: 1,
        message: '', phone: '', secret: null, result: null, results: [], log: [], form: {},
      });
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { ok: false, message: 'Not found' });
  } catch (error) {
    sendJson(res, 500, { ok: false, message: String(error?.message || error).slice(0, 200) });
  }
}

// Local test: `node api/index.js` → http://localhost:3741
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 3741);
  http.createServer(handler).listen(port, '0.0.0.0', () => console.log(`🌐 Service Hub (local): http://localhost:${port}`));
}
