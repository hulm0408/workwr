// 📱 OTP bot ka live mirror — spare Telegram account se OTP bot ke messages.
//
// Sirf READ karta hai (koi message bhejta nahi, koi credential log nahi karta).
// Env: TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION (spare account).
// Bot: OTP_BOT_USERNAME (ya request se aaya username).

let clients = new Map(); // slot → Promise<client>
// Web-login se aaya session (env ke bina bhi mirror chale) — sirf memory me.
let runtimeSessions = new Map(); // slot → session string

function firstEnv(names = []) {
  for (const name of names) {
    const value = process.env[name];
    if (value && String(value).trim()) return String(value).trim();
  }
  return '';
}

export function sessionFor(slot = 0) {
  const fromMemory = runtimeSessions.get(slot);
  if (fromMemory) return fromMemory;
  return slot === 0
    ? firstEnv(['TELEGRAM_SESSION'])
    : firstEnv([`TELEGRAM_SESSION_${slot + 1}`]);
}

export function telegramConfigured() {
  return Boolean(firstEnv(['TELEGRAM_API_ID']) && firstEnv(['TELEGRAM_API_HASH']) && sessionFor(0));
}

// Web login ke baad session ko turant live karo (naya deploy nahi chahiye).
// Purana client band, cache clear — agli mirror call naye session se.
export async function setMirrorSession(session, { slot = 0 } = {}) {
  const clean = String(session || '').trim();
  if (!clean) throw new Error('Session khali hai');
  runtimeSessions.set(slot, clean);
  await dropClient(slot);
  clients.delete(slot); // naya client naye session se bane
  for (const k of [...clients.keys()]) if (k === slot) clients.delete(k);
  return { slot, configured: telegramConfigured() };
}

async function dropClient(slot = 0) {
  const pending = clients.get(slot);
  clients.delete(slot);
  if (pending) {
    try { const c = await pending; await c.disconnect(); } catch { /* ignore */ }
  }
  cache = { at: 0, key: '', data: null };
  lastGood = { at: 0, key: '', data: null };
}

async function getClient(slot = 0) {
  const apiId = firstEnv(['TELEGRAM_API_ID']);
  const apiHash = firstEnv(['TELEGRAM_API_HASH']);
  const session = sessionFor(slot);
  if (!apiId || !apiHash || !session) {
    throw new Error(`Spare #${slot + 1} configured nahi hai (TELEGRAM_API_ID/HASH/SESSION)`);
  }
  if (!clients.has(slot)) {
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
    })().catch((error) => { clients.delete(slot); throw error; });
    clients.set(slot, promise);
  }
  return clients.get(slot);
}

// "NUMBER: +91 85820 21057 / OTP: 5469 / code 123456" — sab shapes handle.
export function parseMirrorMessage(text = '') {
  const flat = String(text).replace(/\s+/g, ' ');
  let phone = '';
  const compact = flat.replace(/[\s-]/g, '');
  const p = compact.match(/(?:\+?91)?([6-9]\d{9})(?!\d)/);
  if (p) phone = p[1];
  const otp = (flat.match(/(?:otp|code)[^0-9]{0,12}(\d{4,8})/i)
    || flat.match(/(?:^|\D)(\d{6})(?:\D|$)/)
    || [])[1] || '';
  return { phone, otp };
}

let cache = { at: 0, key: '', data: null };
let lastGood = { at: 0, key: '', data: null };
const CACHE_MS = 10000;

export async function readOtpBotMirror({ slot = 0, botUsername = '', limit = 6 } = {}) {
  // Default Hathi (user ka main OTP bot) — env se override ho sakta hai.
  const bot = String(botUsername || firstEnv(['OTP_BOT_USERNAME', 'OTP_BOT']) || 'Hathi_otp_bot').replace(/^@/, '');
  const out = { ok: false, bot, slot, messages: [], number: '', otp: '', at: new Date().toISOString(), error: '' };
  if (!bot) { out.error = 'OTP bot username set nahi hai (OTP_BOT_USERNAME)'; return out; }
  const key = `${slot}:${bot}:${limit}`;
  if (cache.data && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.data;
  try {
    const client = await getClient(slot);
    const msgs = await client.getMessages(bot, { limit });
    const list = [];
    for (const msg of msgs || []) {
      const text = String(msg?.message || '').trim();
      if (text) {
        list.push({
          id: msg?.id ?? null,
          text: text.slice(0, 600),
          at: msg?.date ? new Date(Number(msg.date) * 1000).toISOString() : '',
        });
      }
    }
    out.ok = true;
    out.messages = list;
    const latest = list[0] || {};
    const parsed = parseMirrorMessage(latest.text || '');
    out.number = parsed.phone;
    out.otp = parsed.otp;
    out.latestAt = latest.at || '';
    if (list.length) lastGood = { at: Date.now(), key, data: out };
    cache = { at: Date.now(), key, data: out };
  } catch (error) {
    out.error = String(error?.message || error).slice(0, 160);
    // Ek temporary galti par pane khali na ho — aakhri successful mirror dikhao
    // (banner me batao ki data thoda purana hai).
    if (lastGood.data && lastGood.key === key) {
      out.messages = lastGood.data.messages;
      out.number = lastGood.data.number;
      out.otp = lastGood.data.otp;
      out.latestAt = lastGood.data.latestAt;
      out.stale = true;
    }
  }
  return out;
}

export async function disconnectMirror() {
  for (const [, promise] of clients) {
    try { const c = await promise; await c.disconnect(); } catch { /* ignore */ }
  }
  clients = new Map();
  cache = { at: 0, key: '', data: null };
  lastGood = { at: 0, key: '', data: null };
}
