// 📱 OTP bot ka live mirror — spare Telegram account se OTP bot ke messages.
//
// 3 slots (cards UI me "Telegram account #1/#2/#3"):
//   slot 0 → TELEGRAM_SESSION      (API ID/HASH: TELEGRAM_API_ID / _HASH)
//   slot 1 → TELEGRAM_SESSION_2    (API ID/HASH: TELEGRAM_API_ID_2 / _HASH_2)
//   slot 2 → TELEGRAM_SESSION_3    (API ID/HASH: TELEGRAM_API_ID_3 / _HASH_3)
//
// Har slot ka apna api id/hash ho sakta hai; na ho to slot 0 wala use hota hai.
// Web se daali gayi values memory + KV (_kv.js) me — env/redeploy ki zaroorat
// nahi. Sirf READ karta hai (message bhejna _claim.js karta hai, alag file).

let clients = new Map(); // slot → Promise<client>
let runtimeSessions = new Map(); // slot → session string
let runtimeApi = new Map(); // slot → { apiId, apiHash }

function firstEnv(names = []) {
  for (const name of names) {
    const value = process.env[name];
    if (value && String(value).trim()) return String(value).trim();
  }
  return '';
}

function envApi(slot = 0) {
  const suffix = slot === 0 ? '' : `_${slot + 1}`;
  const apiId = firstEnv([`TELEGRAM_API_ID${suffix}`, 'TELEGRAM_API_ID']);
  const apiHash = firstEnv([`TELEGRAM_API_HASH${suffix}`, 'TELEGRAM_API_HASH']);
  return { apiId, apiHash };
}

export function apiFor(slot = 0) {
  const runtime = runtimeApi.get(slot) || {};
  const env = envApi(slot);
  return {
    apiId: String(runtime.apiId || env.apiId || ''),
    apiHash: String(runtime.apiHash || env.apiHash || ''),
    source: runtime.apiId ? 'saved' : (env.apiId ? 'env' : ''),
  };
}

export function sessionFor(slot = 0) {
  const fromMemory = runtimeSessions.get(slot);
  if (fromMemory) return fromMemory;
  return slot === 0 ? firstEnv(['TELEGRAM_SESSION']) : firstEnv([`TELEGRAM_SESSION_${slot + 1}`]);
}

export function slotReady(slot = 0) {
  const api = apiFor(slot);
  return Boolean(api.apiId && api.apiHash && sessionFor(slot));
}

export function telegramConfigured() {
  return slotReady(0);
}

// ─── KV: reload ke baad bhi web se daali values bachi rahein ───
const storeLoaded = new Map(); // slot → true

export async function hydrateSlot(slot = 0) {
  if (storeLoaded.get(slot)) return;
  storeLoaded.set(slot, true);
  try {
    const { kvGet, storeConfigured } = await import('./_kv.js');
    if (!storeConfigured()) return;
    const [session, apiId, apiHash] = await Promise.all([
      kvGet(`tg:session:${slot}`),
      kvGet(`tg:apiId:${slot}`),
      kvGet(`tg:apiHash:${slot}`),
    ]);
    if (session && !runtimeSessions.get(slot)) runtimeSessions.set(slot, session);
    const next = { ...(runtimeApi.get(slot) || {}) };
    if (apiId) next.apiId = apiId;
    if (apiHash) next.apiHash = apiHash;
    if (next.apiId || next.apiHash) runtimeApi.set(slot, next);
  } catch { /* ignore */ }
}

// Purane naam ka alias (baaki code isi ko call karta hai).
export const hydrateSession = hydrateSlot;

async function persist(key, value) {
  try {
    const { kvSet, storeConfigured } = await import('./_kv.js');
    if (storeConfigured()) await kvSet(key, value);
  } catch { /* memory fallback */ }
}

// Web login / form se aayi values ko turant live karo (naya deploy nahi chahiye).
export async function setSlotCredentials({ slot = 0, session = '', apiId = '', apiHash = '', persistValues = true } = {}) {
  // session: '' = clear (tests/logout), undefined = chhedo mat
  if (session !== undefined) {
    const clean = String(session).trim();
    if (clean) runtimeSessions.set(slot, clean);
    else runtimeSessions.delete(slot);
    if (persistValues) await persist(`tg:session:${slot}`, clean || '');
  }
  if (apiId || apiHash) {
    const next = { ...(runtimeApi.get(slot) || {}) };
    if (apiId) next.apiId = String(apiId).trim();
    if (apiHash) next.apiHash = String(apiHash).trim();
    runtimeApi.set(slot, next);
    if (persistValues && next.apiId) await persist(`tg:apiId:${slot}`, next.apiId);
    if (persistValues && next.apiHash) await persist(`tg:apiHash:${slot}`, next.apiHash);
  }
  await dropClient(slot);
  return { slot, ready: slotReady(slot) };
}

// Purana naam — session-only.
export async function setMirrorSession(session, { slot = 0, persist: doPersist = true } = {}) {
  return setSlotCredentials({ slot, session, persistValues: doPersist });
}

async function dropClient(slot = 0) {
  const pending = clients.get(slot);
  clients.delete(slot);
  if (pending) {
    try { const c = await pending; await c.disconnect(); } catch { /* ignore */ }
  }
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${slot}:`)) cache.delete(key);
  }
  for (const key of [...lastGood.keys()]) {
    if (key.startsWith(`${slot}:`)) lastGood.delete(key);
  }
}

export async function getClient(slot = 0) {
  const { apiId, apiHash } = apiFor(slot);
  const session = sessionFor(slot);
  if (!apiId || !apiHash || !session) {
    throw new Error(`Spare #${slot + 1} configured nahi hai (API ID / API hash / session)`);
  }
  if (!clients.has(slot)) {
    const promise = (async () => {
      const main = await import('teleproto');
      const sessions = await import('teleproto/sessions');
      let stringSession;
      try {
        stringSession = new sessions.StringSession(String(session));
      } catch {
        throw new Error(`Account #${slot + 1} ka session galat/adhoora hai — card me code bhejo aur dobara login karo`);
      }
      const client = new main.TelegramClient(
        stringSession,
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

const cache = new Map(); // key → { at, data }
const lastGood = new Map(); // key → { at, data }
const CACHE_MS = 10000;

export async function readOtpBotMirror({ slot = 0, botUsername = '', limit = 6 } = {}) {
  await hydrateSlot(slot);
  // Default Hathi (user ka main OTP bot) — env se override ho sakta hai.
  const bot = String(botUsername || firstEnv(['OTP_BOT_USERNAME', 'OTP_BOT']) || 'Hathi_otp_bot').replace(/^@/, '');
  const out = { ok: false, bot, slot, messages: [], number: '', otp: '', at: new Date().toISOString(), error: '' };
  if (!bot) { out.error = 'OTP bot username set nahi hai (OTP_BOT_USERNAME)'; return out; }
  const key = `${slot}:${bot}:${limit}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
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
    if (list.length) lastGood.set(key, { at: Date.now(), data: out });
    cache.set(key, { at: Date.now(), data: out });
  } catch (error) {
    out.error = String(error?.message || error).slice(0, 160);
    // Ek temporary galti par pane khali na ho — aakhri successful mirror dikhao.
    const good = lastGood.get(key);
    if (good) {
      out.messages = good.data.messages;
      out.number = good.data.number;
      out.otp = good.data.otp;
      out.latestAt = good.data.latestAt;
      out.stale = true;
    }
  }
  return out;
}

// Card ke liye ek hi call: account ready? + bot chat + parsed number/OTP.
export async function readSlotCard({ slot = 0, botUsername = '', limit = 4 } = {}) {
  await hydrateSlot(slot);
  const api = apiFor(slot);
  const mirror = await readOtpBotMirror({ slot, botUsername, limit });
  return {
    slot,
    label: `Account #${slot + 1}`,
    apiIdSet: Boolean(api.apiId),
    apiHashSet: Boolean(api.apiHash),
    apiIdMasked: api.apiId ? `${String(api.apiId).slice(0, 3)}…` : '',
    sessionSet: Boolean(sessionFor(slot)),
    ready: Boolean(api.apiId && api.apiHash && sessionFor(slot)),
    bot: mirror.bot,
    ok: mirror.ok,
    number: mirror.number,
    otp: mirror.otp,
    messages: mirror.messages,
    latestAt: mirror.latestAt || '',
    stale: Boolean(mirror.stale),
    error: mirror.error,
  };
}

export async function disconnectMirror() {
  for (const [, promise] of clients) {
    try { const c = await promise; await c.disconnect(); } catch { /* ignore */ }
  }
  clients = new Map();
  cache.clear();
  lastGood.clear();
}
