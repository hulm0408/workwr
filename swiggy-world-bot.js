// ===== 🌍 SWIGGY WORLD BOT — @SwiggyByWorldBot ka clicker engine =====
//
// Owner ka flow (screenshots + voice note se):
//   /start → 🔐 Login → 📲 OTP Login → 10-digit number → "OTP Sent"
//   → 6-digit OTP → (naya account: naam poochha jata hai → naam bhejo)
//   → bot JSON file / "Copy Code" block deta hai → wahi JSON worker bot me
//   file ke roop me jata hai.
//
//   Purana account pehchan: OTP ke baad bot NAAM NAHI poochhta (seedha JSON).
//   Us case me: 🤵 Order Hub → woh account → 🗑 Delete Account → wohi account
//   → Delete OTP → "Account Deleted Successfully" → phir se OTP Login →
//   ab naam poochhega = fresh account. Aakhir me (best-effort) Switch
//   Accounts → woh account → "Permanently Logged Out".
//
// Yahan koi Swiggy API / proxy / WAF solver nahi lagta — Swiggy ka saara kaam
// ye Telegram bot khud karta hai. Bas uske buttons click karne hain, usi spare
// Telegram user session se jo OTP bots ke liye pehle se configured hai
// (Settings → Add Telegram Account / TELEGRAM_SESSION).
//
// Pure helpers (button role, JSON extract, prompt detect) network ke bina
// test kiye ja sakte hain — test_fresh_unit.mjs me cover hote hain.

import { withTelegramUserClient } from './telegram-otp-source.js';

export const WORLD_BOT_USERNAME_DEFAULT = 'SwiggyByWorldBot';

// Owner ke saare world bots — sab same hain. Pehle wale par kaam hota hai;
// SIRF Swiggy error (OTP send/flow fail) par next bot par switch hota hai,
// bina error ke switch allowed nahi (owner rule).
export const WORLD_BOT_POOL_DEFAULT = [
  'SwiggyByworldBot',
  'SwiggyByworld1Bot',
  'SwiggyByworld2Bot',
  'SwiggyByworld3Bot',
  'SwiggyByworld4Bot',
  'SwiggyByworld5Bot',
];

const normHandle = (value = '') => String(value || '').trim().replace(/^@+/, '');

// Ek hi OTP dobara bhejne ka koi matlab nahi (bot "invalid OTP" dega aur number
// waste hoga). Isliye phone+code ka record — sirf memory me.
const usedOtpCodes = new Set();

export function listWorldBotUsernames(env = process.env) {
  const multi = String(env?.SWIGGY_WORLD_BOT_USERNAMES || '').trim();
  if (multi) {
    const list = multi.split(/[,\s]+/).map(normHandle).filter(Boolean);
    if (list.length) return [...new Set(list)];
  }
  const single = normHandle(env?.SWIGGY_WORLD_BOT_USERNAME || env?.SWIGGY_WORLD_BOT || env?.WORLD_BOT_USERNAME || '');
  const pool = [...WORLD_BOT_POOL_DEFAULT];
  if (single && !pool.some((u) => u.toLowerCase() === single.toLowerCase())) pool.unshift(single);
  return pool;
}

// Har step ka default budget. Bot slow ho to Settings/env se badhaya ja sakta
// hai (SWIGGY_WORLD_STEP_TIMEOUT_MS) — batch isi ke andar recover karta hai.
export const WORLD_BOT_DEFAULTS = {
  stepTimeoutMs: 45_000,
  pollMs: 1_500,
  startTimeoutMs: 25_000,
  readLimit: 15,
  // Owner rule: OTP bhejne ke baad SIRF 20 second. Nahi aaya = number skip.
  otpTimeoutMs: 20_000,
  // "OTP Sent" confirmation (bot ki taraf se OTP send) ka budget.
  otpSendTimeoutMs: 20_000,
  // Bot "account creation queue me hai" bole to itna wait — isse zyada =
  // bot badlo.
  queueWaitMs: 20_000,
  // OTP send confirm na ho (aur bot ne Cancel bhi na bheja ho) to number SKIP
  // nahi hota — wahi number itni baar dobara issue hota hai (Login → 2 → number).
  numberRetries: 1,
};

const state = {
  phase: 'idle',
  lastAction: '',
  lastError: '',
  lastScreenText: '',
  lastScreenButtons: [],
  recentScreens: [],
  lastChatAt: 0,
  lastOkAt: 0,
  step: 0,
  username: '',
  phone: '',
};

export function getWorldBotStatus() {
  const pool = listWorldBotUsernames();
  return {
    ...state,
    pool,
    activeIndex: activeBotIndex,
    activeUsername: pool[activeBotIndex % Math.max(1, pool.length)] || '',
    lastScreenButtons: [...(state.lastScreenButtons || [])],
    recentScreens: [...(state.recentScreens || [])],
  };
}

function setPhase(phase, extra = {}) {
  state.phase = phase;
  state.lastChatAt = Date.now();
  Object.assign(state, extra);
}

// Har naye number/attempt par purana error/typed-text saaf — warna pichhle
// attempt ka "lastError" naye number par galat report ho jata tha.
export function resetWorldBotRunState() {
  state.lastError = '';
  state.lastTypedText = '';
  state.lastTypedAt = 0;
  state.lastTrigger = '';
  state.step = 0;
  return true;
}

function setError(error) {
  state.lastError = String(error?.message || error || '').slice(0, 240);
}

export function worldBotUsername(env = process.env) {
  return listWorldBotUsernames(env)[0] || WORLD_BOT_USERNAME_DEFAULT;
}

// Sticky index: jab tak koi error nahi, wahi bot use hota hai. Error par
// rotateWorldBot() next bot par le jata hai (wrap-around loop).
let activeBotIndex = 0;

export function currentWorldBotUsername(env = process.env) {
  const list = listWorldBotUsernames(env);
  if (!list.length) return WORLD_BOT_USERNAME_DEFAULT;
  return list[activeBotIndex % list.length];
}

export function worldBotPoolIndex() {
  return activeBotIndex;
}

export function resetWorldBotPool() {
  activeBotIndex = 0;
  return currentWorldBotUsername();
}

export function rotateWorldBot(reason = 'worldbot-error', env = process.env) {
  const list = listWorldBotUsernames(env);
  if (list.length <= 1) return currentWorldBotUsername(env);
  const from = currentWorldBotUsername(env);
  activeBotIndex = (activeBotIndex + 1) % list.length;
  const to = currentWorldBotUsername(env);
  state.lastRotateAt = Date.now();
  state.lastRotateFrom = from;
  state.lastRotateReason = String(reason || '').slice(0, 140);
  console.log(`[WorldBot] 🔁 Switch: @${from} → @${to} (${String(reason || 'error').slice(0, 90)})`);
  return to;
}

// Ye error world bot ki taraf se hai (number ki galti nahi) — isi par next
// bot try karna allowed hai. Owner rule: bina error ke switch nahi.
// Owner ka final rule (bilkul saaf):
//   Bot SIRF tab badlo jab —
//     • bot OTP bhej hi na paye (`failed_otp_send` / `queued_timeout`), ya
//     • bot hi na mile (`bot_unreachable`)
//   OTP 20s me nahi aaya → number skip, BOT NAHI badlega.
//   OTP galat / delete fail / flow atka → bot nahi badlega (number ka faisla).
export function shouldSwitchWorldBot(result = {}) {
  const kind = String(result?.kind || '');
  if (!kind || result?.ok) return false;
  if (kind === 'aborted' || kind === 'manual_skip') return false;
  if (kind === 'failed_invalid_number') return false; // number ki galti
  if (kind === 'worldbot_setup') return false;        // session/setup issue
  if (result?.switchBot === true) return true;
  return ['failed_otp_send', 'queued_timeout', 'bot_unreachable'].includes(kind);
}

// Bot ka "wait karo / account creation queue me hai" message — isme ghabrana
// nahi, 20s tak wait. Isse zyada ho jaye tab hi bot badla jata hai.
export function worldBotQueueKind(text = '') {
  const n = norm(text);
  if (!n) return false;
  if (/\b(otp sent|invalid (mobile|number|otp)|deleted successfully)\b/.test(n)) return false;
  return /\b(in\s*queue|queued|queue|que\s*me|wait|ruko|ruk\s*j?ao|thoda\s*waqt|processing|in\s*progress|account\s*creation|creating|ban\s*raha|line\s*me)\b/.test(n);
}

export function worldBotConfig(env = process.env) {
  const num = (key, dflt, min = 250) => {
    const n = Number(env?.[key]);
    return Number.isFinite(n) && n >= min ? n : dflt;
  };
  return {
    username: currentWorldBotUsername(env),
    usernames: listWorldBotUsernames(env),
    stepTimeoutMs: num('SWIGGY_WORLD_STEP_TIMEOUT_MS', WORLD_BOT_DEFAULTS.stepTimeoutMs),
    pollMs: num('SWIGGY_WORLD_POLL_MS', WORLD_BOT_DEFAULTS.pollMs, 300),
    otpTimeoutMs: num('SWIGGY_WORLD_OTP_TIMEOUT_MS', WORLD_BOT_DEFAULTS.otpTimeoutMs, 5_000),
    otpSendTimeoutMs: num('SWIGGY_WORLD_OTP_SEND_TIMEOUT_MS', WORLD_BOT_DEFAULTS.otpSendTimeoutMs, 5_000),
    queueWaitMs: num('SWIGGY_WORLD_QUEUE_WAIT_MS', WORLD_BOT_DEFAULTS.queueWaitMs, 5_000),
    // Button trigger: 'auto' = pehle click; screen na badle to button ka TEXT
    // type karke action trigger. 'type' = click bilkul nahi, seedha text.
    trigger: ['click', 'type', 'auto'].includes(String(env?.SWIGGY_WORLD_TRIGGER || '').trim().toLowerCase())
      ? String(env.SWIGGY_WORLD_TRIGGER).trim().toLowerCase()
      : 'auto',
    clickGraceMs: num('SWIGGY_WORLD_CLICK_GRACE_MS', 4_000, 1_000),
    // Same number ko kitni baar dobara issue karna hai (0-2) — OTP send fail par
    // number skip karne se pehle. Pipeline ko sirf final failure milti hai.
    numberRetries: Math.max(0, Math.min(2, Math.trunc(num('SWIGGY_WORLD_NUMBER_RETRIES', WORLD_BOT_DEFAULTS.numberRetries, 0)))),
    // Delete ke baad "Switch Accounts → Permanently Logged Out" (best-effort).
    logoutAfterDelete: String(env?.SWIGGY_WORLD_LOGOUT_AFTER_DELETE ?? '1') !== '0',
  };
}

// ---------------------------------------------------------------------------
// Pure helpers — network ke bina (tests inhe direct call karte hain)
// ---------------------------------------------------------------------------
const plain = (value = '') => String(value ?? '')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/\u00a0/g, ' ');

const norm = (value = '') => plain(value)
  .toLowerCase()
  .replace(/[^\p{L}\p{N}/]+/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// Button ka role — @SwiggyByWorldBot ke screens ke hisaab se.
//   login | otpLogin | jsonLogin | cancel | orderHub | deleteAccount |
//   switchAccounts | permanentLogout | name-skip | ''
export function worldBotButtonRole(text = '') {
  const n = norm(text);
  if (!n) return '';
  // "Copy Code" / "Copy JSON" — sabse pehle, kyunki isme "JSON" bhi hota hai.
  if (/\bcopy\b/.test(n)) return 'copyCode';
  if (/\b(json|tid)\b/.test(n)) return 'jsonLogin';
  if (/\botp\b/.test(n) && /\blogin\b/.test(n)) return 'otpLogin';
  if (/\b(order\s*hub|orders?)\b/.test(n) && !/\bmy\s*orders\b/.test(n)) return 'orderHub';
  if (/\bdelete\b/.test(n) && /\baccount\b/.test(n)) return 'deleteAccount';
  if (/\bswitch\s*accounts?\b/.test(n)) return 'switchAccounts';
  if (/\bpermanent\w*\b/.test(n) && /\blog|out\b/.test(n)) return 'permanentLogout';
  if (/\b(log\s*out|logout|sign\s*out)\b/.test(n)) return 'permanentLogout';
  if (/\b(permanent\w*\s*log\s*out|log\s*out\s*permanent\w*)\b/.test(n)) return 'permanentLogout';
  if (/\b(cancel|back)\b/.test(n)) return 'cancel';
  if (/\blogin\b/.test(n)) return 'login';
  return '';
}

export function pickWorldBotButton(buttons = [], role = '') {
  const list = Array.isArray(buttons) ? buttons : [];
  const wanted = String(role || '');
  if (!wanted) return null;
  // Pehle exact role match, phir login ke liye OTP/JSON wale button ko chhod do
  // (main menu ka "🔐 Login" simple login hai).
  const exact = list.find((b) => worldBotButtonRole(b?.text || b) === wanted);
  if (exact) return exact;
  if (wanted === 'login') {
    return list.find((b) => {
      const n = norm(b?.text || b);
      return /\blogin\b/.test(n) && !/\botp\b/.test(n) && !/\bjson\b|\btid\b/.test(n);
    }) || null;
  }
  return null;
}

// "Bot se remove: Haan 💜 (289291349)" wale confirm button ke liye.
export function pickWorldBotConfirmButton(buttons = []) {
  const list = Array.isArray(buttons) ? buttons : [];
  return list.find((b) => /^(haan|han|yes|ok|remove|haan\s*💜|haan\s*[^\p{L}\p{N}]*)$/iu.test(norm(b?.text || b)))
    || list.find((b) => /\b(remove|hata)\b/.test(norm(b?.text || b)))
    || null;
}

export function findWorldBotAccountButton(buttons = [], phone = '') {
  const digits = String(phone || '').replace(/\D/g, '');
  const last10 = digits.slice(-10);
  if (!last10) return null;
  const list = Array.isArray(buttons) ? buttons : [];
  return list.find((b) => String(b?.text || b || '').replace(/\D/g, '').includes(last10)) || null;
}

function looksLikeSessionJson(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (obj.cookies || obj._session_tid || obj.tid || obj.token) return true;
  const inner = obj.session || obj.data || obj.account || obj.auth;
  return Boolean(inner && typeof inner === 'object' && (inner.tid || inner.token || inner.cookies || inner._session_tid));
}

// Text/document se Swiggy session JSON nikalo. Bot kabhi code-block bhejta
// hai, kabhi .json/.txt file, kabhi plain text. Teeno handle hote hain.
export function extractWorldBotJson(text = '') {
  const raw = plain(text);
  if (!raw || raw.length < 10) return null;
  const candidates = [];
  for (const m of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(m[1]);
  // balanced-brace scan (message me extra lines ho sakti hain)
  let depth = 0;
  let start = -1;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(raw.slice(start, i + 1));
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  candidates.unshift(raw.trim());
  for (const candidate of candidates) {
    const body = String(candidate || '').trim();
    if (!body.startsWith('{')) continue;
    try {
      const obj = JSON.parse(body);
      if (looksLikeSessionJson(obj)) return { json: obj, text: JSON.stringify(obj) };
    } catch {}
  }
  return null;
}

// Bot ke latest message se pata karo kis step par hai.
export function worldBotPromptKind(text = '') {
  const n = norm(text);
  if (!n) return '';
  if (/\b(deleted successfully|account deleted|successfully archived|deleted)\b/.test(n)) return 'deleted';
  if (/\b(delete otp|otp sent.{0,40}delete|delete.{0,30}otp)\b/.test(n)) return 'deleteSent';
  if (/\b(otp was not accepted|invalid otp|otp galat|wrong otp|otp expired)\b/.test(n)) return 'otpFail';
  if (/\b(invalid mobile|invalid number|number galat)\b/.test(n)) return 'invalidNumber';
  // "OTP sent" ke kai tarah ke shabd: "OTP has been sent", "we sent a code",
  // "OTP bhej diya" — sab ek hi step hain.
  // ⚠️ "OTP bhejne ke liye 10 digit number bhejo" me bhi "OTP" + "bhej" hai —
  // ise OTP Sent maan lena galat tha (number maang raha hota hai). Pehle wahi
  // pakdo. Asli confirmation me "sent"/"bhej diya" hota hai, "bhejo" nahi.
  const asksForNumber = /\b(send|enter|type|provide|bhejo|bhej do|batao|daalo|daal do)\b/.test(n)
    && /\b(10\s?-?digit|mobile|number|namber)\b/.test(n);
  if (asksForNumber && !/\b(otp sent|otp has been sent|code sent|sent to|otp bhej diya|bhej diya)\b/.test(n)) {
    return 'askNumber';
  }
  if (/\b(otp sent|otp bhej|send the 6 digit otp)\b/.test(n)) return 'otpSent';
  if (/\b(otp|code)\b/.test(n) && /\b(sent|delivered|bhej\w*|gaya|chala gaya)\b/.test(n)) return 'otpSent';
  // Naam ka sawaal — "What is your name?", "Send your name", "apna naam batao".
  if (/\b(name|naam)\b/.test(n) && n.split(' ').filter(Boolean).length <= 12) return 'askName';
  if (/\b(send|enter|type|provide|bhejo|batao)\b/.test(n) && /\b(10 digit|10-digit|mobile|number)\b/.test(n)) return 'askNumber';
  return '';
}

// ---------------------------------------------------------------------------
// 🛡️ MISTAKE-PROOF HELPERS (pure — tests inhe seedha check karte hain)
// ---------------------------------------------------------------------------

// Button ka TEXT type karke action trigger karne ke variants.
// Owner: "instead of clicking button read all the text of button and type that
// text to trigger that" — pehle poora text, phir bina emoji, phir simple.
export function worldButtonTypeVariants(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const noEmoji = raw
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, ' ')
    .replace(/[\u2190-\u21FF\u2600-\u27BF]/g, ' ')
    .replace(/[^\p{L}\p{N}\s&/+.-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const lower = noEmoji.toLowerCase();
  const out = [...new Set([raw, noEmoji, lower].filter(Boolean))];
  return out;
}

// OTP kabhi "123 456", "+1 234", ya copy-paste me spaces ke saath aata hai.
// Sirf 4-8 digit hi valid OTP — warna bot ko galat text chala jata hai.
export function normalizeOtpCode(value = '') {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length < 4 || digits.length > 8) return '';
  return digits;
}

// JSON mila par adhoora (token/tid/cookies kuch bhi nahi) → uska koi kaam nahi.
export function isValidWorldSessionJson(value) {
  const obj = typeof value === 'string' ? (() => { try { return JSON.parse(value); } catch { return null; } })() : value;
  return Boolean(looksLikeSessionJson(obj));
}

// Kisi bhi error ko samajhne layak category me baanto — isse pata chalta hai
// bot badalna hai, session dobara login karna hai, ya sirf number defer karna.
// OTP send confirm na hua ho (aur bot ne Cancel bhi na bheja) to number skip
// nahi karte — pehle WAHI number dobara issue hota hai. Sirf in cases me retry:
//   failed_otp_send / no-login-button / no-otp-login / no-button / flow stuck
// Retry NAHI: aborted, invalid number, queued_timeout (bot load → switch),
// OTP miss/verify (wahan 20s rule lagta hai), bot_unreachable, setup, network.
export function shouldReissueWorldOtp(kind = '') {
  const k = String(kind || '').trim().toLowerCase();
  if (!k) return false;
  if (/^(aborted|queued_timeout|failed_otp_miss|failed_otp_verify|invalidnumber|failed_invalid_number|bot_unreachable|worldbot_setup|flood_wait|network)$/.test(k)) {
    return false;
  }
  return /otp_send|no_login|no-login|no-otp-login|no_otp_login|no_button|no-button|no_prompt|number_prompt|timeout|failed_world_bot|send_number|otp-send/.test(k);
}

export function classifyWorldBotError(error = {}) {
  const raw = String(error?.message ?? error ?? '');
  const code = String(error?.code || '').toUpperCase();
  if (code === 'WORLDBOT_ABORTED' || /owner ne stop|aborted|stop\/skip/i.test(raw)) return 'aborted';
  if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED|AUTH_KEY_DUPLICATED|SESSION_PASSWORD_NEEDED/i.test(raw)) {
    return 'worldbot_setup';
  }
  if (/FLOOD(_PREMIUM)?_WAIT/i.test(raw)) return 'flood_wait';
  if (/USERNAME_NOT_OCCUPIED|USERNAME_INVALID|no user has|could not find|cannot find any entity|CHANNEL_PRIVATE|PEER_ID_INVALID|USER_BANNED/i.test(raw)) {
    return 'bot_unreachable';
  }
  if (/ETIMEDOUT|ECONNRESET|ENOTFOUND|ECONNREFUSED|socket|network|connection/i.test(raw)) return 'network';
  return 'failed_world_bot';
}

export function normalizeWorldPhone(value = '') {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export function isWorldBotPhoneValid(value = '') {
  return /^[6-9]\d{9}$/.test(normalizeWorldPhone(value));
}

// ---------------------------------------------------------------------------
// Teleproto screen plumbing
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

let entityCache = { client: null, username: '', entity: null };

async function getWorldEntity(client, username) {
  const key = String(username || '').toLowerCase();
  if (entityCache.client === client && entityCache.username === key && entityCache.entity) {
    return entityCache.entity;
  }
  const entity = await client.getEntity(`@${username}`);
  entityCache = { client, username: key, entity };
  return entity;
}

function buttonTextOf(button) {
  try { return String(button?.text || button?.button?.text || ''); } catch { return ''; }
}

async function messageButtons(message) {
  let rows;
  try { rows = message?.buttons; } catch {}
  if (!rows) {
    try { rows = typeof message?.getButtons === 'function' ? await message.getButtons() : null; } catch {}
  }
  if (!rows) rows = message?._buttons || (message?._buttonsFlat ? [message._buttonsFlat] : []);
  if (!Array.isArray(rows)) return [];
  return rows
    .flatMap((row) => (Array.isArray(row) ? row : [row]))
    .filter((button) => button && buttonTextOf(button));
}

function messageIdOf(message) {
  const raw = message?.id;
  if (typeof raw === 'bigint') return Number(raw);
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function messageDateMs(message) {
  const raw = message?.date;
  if (raw instanceof Date) return raw.getTime() || 0;
  const n = typeof raw === 'bigint' ? Number(raw) : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1e12 ? n : n * 1000;
}

function messageTextOf(message) {
  try { return plain(message?.text || message?.message || message?.rawText || ''); } catch { return ''; }
}

function messageHasDocument(message) {
  try {
    if (message?.document) return true;
    if (message?.media?.document) return true;
    if (message?.media?.className && /document/i.test(String(message.media.className))) return true;
    if (message?.media?.classID) {
      // MessageMediaDocument = 0xd4c48794 (-725397492)
      return Number(message.media.classID) === -725397492;
    }
  } catch {}
  return false;
}

async function readWorldMessages(client, entity, limit = WORLD_BOT_DEFAULTS.readLimit) {
  const take = Math.max(1, Number(limit) || 10);
  let lastError = null;
  // Network/TIMEOUT par 2 koshish — ek hiccup se poora number na jaye.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const messages = await client.getMessages(entity, { limit: take });
      return Array.isArray(messages) ? messages : [...(messages || [])];
    } catch (error) {
      lastError = error;
      if (attempt === 1) await sleep(700);
    }
  }
  throw lastError;
}

async function parseScreenMessages(client, entity, limit) {
  const messages = await readWorldMessages(client, entity, limit);
  const parsed = [];
  for (const message of messages) {
    const buttons = await messageButtons(message);
    parsed.push({
      id: messageIdOf(message),
      text: messageTextOf(message),
      dateMs: messageDateMs(message),
      hasDocument: messageHasDocument(message),
      buttons: buttons.map((button) => ({
        button,
        text: buttonTextOf(button),
        role: worldBotButtonRole(buttonTextOf(button)),
      })),
      raw: message,
    });
  }
  state.lastChatAt = Date.now();
  const latest = parsed[0] || null;
  if (latest) {
    state.lastScreenText = String(latest.text || '').slice(0, 400);
    state.lastScreenButtons = latest.buttons.map((b) => b.text);
    // Owner ko pata chale bot exactly kya keh raha hai — /world isi se bharta
    // hai. Sirf text/buttons yaad rakhte hain (koi JSON/session nahi).
    const entry = {
      at: Date.now(),
      phase: state.phase,
      text: String(latest.text || '').replace(/\s+/g, ' ').slice(0, 240),
      buttons: latest.buttons.map((b) => b.text).slice(0, 10),
    };
    const last = state.recentScreens[0];
    if (!last || last.text !== entry.text || last.buttons.join('|') !== entry.buttons.join('|')) {
      state.recentScreens = [entry, ...state.recentScreens].slice(0, 8);
      console.log(`[WorldBot] 📺 ${state.phase}: ${entry.text || '(no text)'} · [${entry.buttons.join(' | ') || 'no buttons'}]`);
    }
  }
  return parsed;
}

function screenSignature(messages = []) {
  const map = new Map();
  for (const m of messages) {
    map.set(m.id, `${m.text}|${m.buttons.map((b) => b.text).join('|')}|${m.hasDocument ? 'doc' : ''}`);
  }
  return map;
}

function freshMessages(messages, baseline) {
  return messages.filter((m) => {
    const sig = `${m.text}|${m.buttons.map((b) => b.text).join('|')}|${m.hasDocument ? 'doc' : ''}`;
    if (!baseline.has(m.id)) return true;
    return baseline.get(m.id) !== sig;
  });
}

class WorldBotError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code || 'worldbot-error';
  }
}

// Naya jawab aane tak poll karo. predicate(fresh, all) truthy de to wahi
// return ho jata hai; timeout par WorldBotError('worldbot-timeout').
async function waitForReply({ client, entity, predicate, baseline, timeoutMs, shouldAbort, what = 'reply', pollMs }) {
  const deadline = Date.now() + Math.max(1_000, Number(timeoutMs) || WORLD_BOT_DEFAULTS.stepTimeoutMs);
  const every = Math.max(300, Number(pollMs) || WORLD_BOT_DEFAULTS.pollMs);
  let lastAll = [];
  while (Date.now() < deadline) {
    if (typeof shouldAbort === 'function' && shouldAbort()) {
      throw new WorldBotError('aborted', 'Owner ne STOP/SKIP kiya');
    }
    const all = await parseScreenMessages(client, entity);
    lastAll = all;
    const fresh = baseline ? freshMessages(all, baseline) : all;
    const hit = predicate(fresh, all);
    if (hit) return hit;
    await sleep(every);
  }
  const tail = lastAll.slice(0, 3).map((m) => String(m.text || '').replace(/\s+/g, ' ').slice(0, 90)).filter(Boolean).join(' || ');
  throw new WorldBotError(
    'worldbot-timeout',
    `${what} ka jawab ${Math.round((Number(timeoutMs) || WORLD_BOT_DEFAULTS.stepTimeoutMs) / 1000)}s me nahi aaya${tail ? ` — last: ${tail}` : ''}`
  );
}

async function sendWorldText(client, entity, text) {
  const payload = String(text);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await client.sendMessage(entity, { message: payload });
      state.lastAction = `send:${payload.slice(0, 24)}`;
      state.lastChatAt = Date.now();
      return true;
    } catch (error) {
      // Telegram "FLOOD_WAIT_34" = 34s ruk kar dobara bhejo (account ki limit).
      const flood = /FLOOD(?:_PREMIUM)?_WAIT_(\d+)/i.exec(String(error?.message || error));
      if (flood && attempt === 1) {
        const waitMs = Math.min(45_000, (Number(flood[1]) + 2) * 1_000);
        console.warn(`[WorldBot] ⏳ Telegram flood wait ${Math.round(waitMs / 1000)}s — phir dobara bhejunga`);
        await sleep(waitMs);
        continue;
      }
      throw error;
    }
  }
  return false;
}

async function clickWorldButton(entry) {
  if (!entry?.button) throw new WorldBotError('no-button', 'Button nahi mila');
  state.lastAction = `click:${entry.text}`;
  setPhase(`click-${entry.role || 'button'}`);
  const answer = await entry.button.click({});
  const callback = String(answer?.message || '').trim().slice(0, 180);
  console.log(`[WorldBot] click: ${entry.text}${callback ? ` — callback: ${callback}` : ''}`);
  state.lastChatAt = Date.now();
  return callback;
}

// Ek screen ka action: pehle baseline snapshot, phir click/send, phir wait.
async function actAndWait({ client, entity, action, predicate, timeoutMs, shouldAbort, what, pollMs }) {
  const before = screenSignature(await parseScreenMessages(client, entity));
  await action();
  return waitForReply({ client, entity, predicate, baseline: before, timeoutMs, shouldAbort, what, pollMs });
}

// Latest screen par diya gaya role dhoondo. Fresh replies me pehle, phir
// purani (lekin latest) screen me — kyunki kai screens edit hoti hain.
function findRoleOnScreens(messages, role) {
  for (const message of messages) {
    const button = pickWorldBotButton(message.buttons, role);
    if (button) return { message, button };
  }
  return null;
}

async function ensureWorldScreen(client, entity, role, { cfg, shouldAbort, what } = {}) {
  const hit = findRoleOnScreens(await parseScreenMessages(client, entity), role);
  if (hit) return hit;
  // Kuch nahi mila to /start bhej kar main menu maango.
  const before = screenSignature(await parseScreenMessages(client, entity));
  await sendWorldText(client, entity, '/start');
  const reply = await waitForReply({
    client,
    entity,
    baseline: before,
    timeoutMs: cfg?.startTimeoutMs || WORLD_BOT_DEFAULTS.startTimeoutMs,
    shouldAbort,
    what: what || '/start ka menu',
    predicate: (fresh, all) => findRoleOnScreens([...fresh, ...all], role),
  });
  return reply;
}

async function clickRole(client, entity, role, { cfg, shouldAbort, what, predicate = null, timeoutMs = null } = {}) {
  const hit = await ensureWorldScreen(client, entity, role, { cfg, shouldAbort, what });
  if (!hit) throw new WorldBotError('no-button', `"${role}" button nahi mila — screen: ${state.lastScreenButtons.join(' | ') || 'none'}`);
  // Click na chale to usi button ka text type karke trigger (owner rule).
  const pred = predicate || ((fresh) => (fresh && fresh.length ? true : null));
  await clickOrType({
    client, entity, entry: hit.button, cfg, shouldAbort,
    what: what || role, predicate: pred,
    timeoutMs: Math.min(Number(timeoutMs) || Number(cfg?.stepTimeoutMs) || 15_000, 15_000),
  }).catch((e) => {
    if (e?.code === 'aborted') throw e;
    console.warn(`[WorldBot] "${role}" trigger: ${e?.message || e}`);
  });
  return hit;
}

function reportCard(report, html) {
  if (typeof report !== 'function') return Promise.resolve();
  try { return Promise.resolve(report(html)).catch(() => {}); } catch { return Promise.resolve(); }
}

// ---------------------------------------------------------------------------
// Login: /start → Login → OTP Login → number → OTP → (name) → JSON
// ---------------------------------------------------------------------------
export async function worldBotLogin({
  phone,
  otpProvider = null,
  nameProvider = null,
  report = null,
  shouldAbort = null,
  config = worldBotConfig(),
  fresh = false,
} = {}) {
  const cfg = { ...worldBotConfig(), ...(config || {}) };
  const cleanPhone = normalizeWorldPhone(phone);
  if (!isWorldBotPhoneValid(cleanPhone)) {
    return { ok: false, kind: 'failed_invalid_number', phone: cleanPhone, reason: '10-digit Indian mobile chahiye (6-9 se shuru)' };
  }
  resetWorldBotRunState();
  state.phone = cleanPhone;
  state.username = cfg.username;
  setPhase('login-start', { lastError: '', step: 0 });

  try {
    return await withTelegramUserClient(async ({ client }) => {
      const entity = await getWorldEntity(client, cfg.username);

      // 1) /start → main menu
      setPhase('start');
      let before = screenSignature(await parseScreenMessages(client, entity));
      await sendWorldText(client, entity, '/start');
      await waitForReply({
        client, entity, baseline: before, timeoutMs: cfg.startTimeoutMs, shouldAbort,
        what: 'main menu',
        predicate: (freshList, all) => findRoleOnScreens([...freshList, ...all], 'login'),
        pollMs: cfg.pollMs,
      }).catch(async () => {
        // /start ka jawab na aaya ho to purani screen par Login dhoondho.
        const hit = findRoleOnScreens(await parseScreenMessages(client, entity), 'login');
        if (!hit) throw new WorldBotError('no-login-button', '/start ke baad Login button nahi mila');
        return hit;
      });

      // Ek number ke liye poora OTP-issue sequence: Login → OTP Login (2) → number.
      // Owner rule: kai baar OTP bhejne ki screen hi nahi aati aur bot Cancel bhi
      // nahi bhejta — tab agla number nahi, WAHI number dobara issue hota hai.
      const issueNumberOtp = async ({ attempt = 1 } = {}) => {
        if (attempt > 1) {
          // adhoora screen saaf karo, typed-text guard reset, phir /start se menu.
          await safeCancel(client, entity, cfg).catch(() => {});
          state.lastTypedText = '';
          state.lastTypedAt = 0;
          await sleep(Math.max(600, Math.min(2_000, Number(cfg.pollMs) || 1_500)));
          await sendWorldText(client, entity, '/start').catch(() => {});
          await sleep(Math.max(700, Math.min(2_500, Number(cfg.pollMs) || 1_500)));
        }

        // 2) 🔐 Login → method picker
        setPhase('login-menu');
        let issueBaseline = screenSignature(await parseScreenMessages(client, entity));
        const loginHit = findRoleOnScreens(await parseScreenMessages(client, entity), 'login');
        if (!loginHit) throw new WorldBotError('no-login-button', `Login button nahi mila — screen: ${(state.lastScreenButtons || []).join(' | ') || 'none'}`);
        await clickOrType({
          client, entity, entry: loginHit.button, cfg, shouldAbort, baseline: issueBaseline,
          what: 'login method screen',
          predicate: (freshList, all) => findRoleOnScreens([...freshList, ...all], 'otpLogin'),
        });

        // 3) 📲 OTP Login → number maango
        setPhase('otp-login');
        issueBaseline = screenSignature(await parseScreenMessages(client, entity));
        const otpBtn = findRoleOnScreens(await parseScreenMessages(client, entity), 'otpLogin');
        if (!otpBtn) throw new WorldBotError('no-otp-login', 'OTP Login button nahi mila');

        // 4) number prompt (click na chale to "OTP Login" text type hoga)
        setPhase('send-number');
        await clickOrType({
          client, entity, entry: otpBtn.button, cfg, shouldAbort, baseline: issueBaseline,
          what: 'number prompt',
          timeoutMs: Math.min(20_000, cfg.stepTimeoutMs),
          predicate: (freshList, all) => {
            const allText = [...freshList, ...all].map((m) => m.text).join('\n');
            return worldBotPromptKind(allText) === 'askNumber' ? true : null;
          },
        }).then(() => true).catch(() => true); // prompt na mile to bhi number bhej do

        await reportCard(report, [
          '🌍 <b>Swiggy World Bot — OTP Login</b>',
          `📱 <b>Number:</b> <code>${cleanPhone}</code>`,
          attempt > 1
            ? `↻ Wahi number dobara bhej raha hoon (try ${attempt}) — /start → Login → OTP Login`
            : '→ /start → Login → OTP Login ho gaya, ab number bhej raha hoon…',
        ].join('\n'));

        issueBaseline = screenSignature(await parseScreenMessages(client, entity));
        await sendWorldText(client, entity, cleanPhone);

        // ⏱ Owner rule: OTP send ka budget 20s (queue bola ho to +20s).
        return waitForOtpSent({ client, entity, baseline: issueBaseline, cfg, shouldAbort });
      };

      // ⏱ 20s me OTP Sent na aaye / screen hi na aaye to pehle WAHI number
      // dobara issue hota hai (Login → 2 → number). Tab bhi na ho to hi number
      // aage badta hai aur bot rotate hota hai.
      const issueTries = Math.max(1, Math.min(3, 1 + Math.max(0, Number(cfg.numberRetries ?? 1) || 0)));
      let numberResult = null;
      let lastIssueKind = '';
      for (let attempt = 1; attempt <= issueTries; attempt += 1) {
        try {
          numberResult = await issueNumberOtp({ attempt });
        } catch (e) {
          if (e?.code === 'aborted' || /owner ne stop/i.test(String(e?.message || ''))) throw e;
          const kind = classifyWorldBotError(e);
          numberResult = { ok: false, kind: kind === 'failed_world_bot' ? 'failed_otp_send' : kind, reason: e?.message || String(e) };
        }
        lastIssueKind = String(numberResult?.kind || '');
        if (numberResult?.ok || lastIssueKind === 'invalidNumber') break;
        if (!shouldReissueWorldOtp(lastIssueKind)) break;
        if (attempt >= issueTries) break;
        console.warn(`[WorldBot] ↻ "${lastIssueKind}" — ${cleanPhone} ko wahi number dobara issue kar raha hoon (try ${attempt + 1}/${issueTries})`);
        setPhase('reissue-number', { lastError: numberResult?.reason || '' });
        await reportCard(report, `↻ <b>Wahi number dobara</b> — OTP send confirm nahi hua, isliye number skip nahi kar raha.\n📱 <code>${cleanPhone}</code> · try ${attempt + 1}/${issueTries}`);
      }

      if (numberResult?.kind === 'invalidNumber') {
        await safeCancel(client, entity, cfg).catch(() => {});
        return { ok: false, kind: 'failed_invalid_number', phone: cleanPhone, reason: 'Swiggy World Bot ne number invalid bataya' };
      }
      if (!numberResult?.ok) {
        await safeCancel(client, entity, cfg).catch(() => {});
        return {
          ok: false,
          kind: numberResult?.kind || 'failed_otp_send',
          phone: cleanPhone,
          attempts: issueTries,
          reason: `${numberResult?.reason || 'OTP send confirm nahi hua'} · ${issueTries} try ke baad bhi`,
        };
      }

      // 5) OTP lao (Firebase inbox se — pipeline deta hai) aur bhejo
      setPhase('otp-wait');
      await reportCard(report, [
        '🌍 <b>World Bot — OTP Sent</b>',
        `📱 <code>${cleanPhone}</code> · OTP Firebase inbox se aa raha hai…`,
      ].join('\n'));
      if (typeof otpProvider !== 'function') throw new WorldBotError('no-otp-provider', 'OTP provider missing');
      const otp = await otpProvider();
      if (!otp?.code) {
        await safeCancel(client, entity, cfg).catch(() => {});
        if (otp?.aborted) return { ok: false, kind: 'aborted', phone: cleanPhone, reason: 'OTP wait abort' };
        return { ok: false, kind: 'failed_otp_miss', phone: cleanPhone, reason: otp?.error || 'OTP inbox me nahi mila' };
      }

      // 🛡️ OTP kabhi "123 456" / "+91 123456" jaisa aata hai — sirf digits.
      // Aur wahi purana code dobara bhejna = bot "invalid OTP" dega, number
      // waste. Isliye normalize + reuse guard.
      const otpCode = normalizeOtpCode(otp.code);
      if (!otpCode) {
        await safeCancel(client, entity, cfg).catch(() => {});
        return {
          ok: false,
          kind: 'failed_otp_miss',
          phone: cleanPhone,
          reason: `OTP galat shakl me aaya: "${String(otp.code).slice(0, 12)}" — number skip (bot wahi)`,
        };
      }
      if (usedOtpCodes.has(`${cleanPhone}:${otpCode}`)) {
        await safeCancel(client, entity, cfg).catch(() => {});
        return {
          ok: false,
          kind: 'failed_otp_miss',
          phone: cleanPhone,
          reason: 'Wahi purana OTP dobara mila — number skip (bot wahi)',
        };
      }
      usedOtpCodes.add(`${cleanPhone}:${otpCode}`);
      if (usedOtpCodes.size > 500) usedOtpCodes.clear();

      setPhase('otp-verify');
      before = screenSignature(await parseScreenMessages(client, entity));
      const codeDelivered = await sendWorldCode(client, entity, otpCode);
      if (!codeDelivered) {
        await safeCancel(client, entity, cfg).catch(() => {});
        return {
          ok: false,
          kind: 'failed_otp_verify',
          phone: cleanPhone,
          reason: `OTP aa gaya (${String(otp.code).trim().length} digit) par bot ko bhejne me dikkat — bot nahi badla, number aage badha`,
        };
      }

      // 6) Outcome: naam ka sawaal = naya account; seedha JSON = purana.
      const outcome = await waitForReply({
        client, entity, baseline: before, timeoutMs: cfg.stepTimeoutMs, shouldAbort,
        what: 'login result',
        predicate: (freshList) => {
          for (const message of freshList) {
            if (message.hasDocument) return { kind: 'document', message };
            const json = extractWorldBotJson(message.text);
            if (json) return { kind: 'json', message, json };
            const kind = worldBotPromptKind(message.text);
            if (kind === 'askName') return { kind: 'askName', message };
            if (kind === 'otpFail') return { kind: 'otpFail', message };
            // JSON code-block me ho aur uske saath "Copy Code" button ho.
            if (pickWorldBotButton(message.buttons, 'copyCode')) return { kind: 'copy', message };
          }
          return null;
        },
        pollMs: cfg.pollMs,
      });

      let askedName = false;
      let final = outcome;

      if (outcome.kind === 'askName') {
        askedName = true;
        setPhase('send-name');
        const displayName = typeof nameProvider === 'function'
          ? String((await nameProvider()) || '').slice(0, 40)
          : 'Rahul Kumar';
        before = screenSignature(await parseScreenMessages(client, entity));
        await sendWorldText(client, entity, displayName);
        final = await waitForReply({
          client, entity, baseline: before, timeoutMs: cfg.stepTimeoutMs, shouldAbort,
          what: 'JSON (name ke baad)',
          predicate: (freshList) => {
            for (const message of freshList) {
              if (message.hasDocument) return { kind: 'document', message };
              const json = extractWorldBotJson(message.text);
              if (json) return { kind: 'json', message, json };
              const kind = worldBotPromptKind(message.text);
              if (kind === 'otpFail') return { kind: 'otpFail', message };
              if (pickWorldBotButton(message.buttons, 'copyCode')) return { kind: 'copy', message };
            }
            return null;
          },
          pollMs: cfg.pollMs,
        });
      }

      if (final.kind === 'otpFail') {
        await safeCancel(client, entity, cfg).catch(() => {});
        return { ok: false, kind: 'failed_otp_verify', phone: cleanPhone, reason: 'World Bot ne OTP accept nahi kiya' };
      }

      // 7) JSON nikaalo (file ya text)
      setPhase('json');
      let jsonText = final.json?.text || '';
      if (!jsonText && final.message?.hasDocument) {
        const buffer = await client.downloadMedia(final.message.raw, {});
        if (buffer) {
          const body = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
          const found = extractWorldBotJson(body);
          if (found) jsonText = found.text;
          else {
            try { JSON.parse(body); jsonText = body.trim(); } catch {}
          }
        }
      }
      // "Copy Code" button ho to dabao — JSON usi se milta hai.
      if (!jsonText) {
        const copied = await clickCopyCode({ client, entity, cfg, shouldAbort }).catch(() => null);
        if (copied?.json?.text) jsonText = copied.json.text;
        else if (copied?.message) {
          jsonText = await downloadJsonFromMessage(client, copied.message).catch(() => '');
        }
      }
      if (!jsonText) {
        // Kabhi JSON agle message me aata hai (file ke baad caption), thoda wait.
        const late = await waitForReply({
          client, entity, baseline: screenSignature(await parseScreenMessages(client, entity)), timeoutMs: 12_000, shouldAbort,
          predicate: (freshList) => {
            for (const message of freshList) {
              const json = extractWorldBotJson(message.text);
              if (json) return json;
            }
            return null;
          },
          pollMs: cfg.pollMs,
        }).catch(() => null);
        if (late) jsonText = late.text;
      }
      if (!jsonText) throw new WorldBotError('no-json', 'Login ho gaya par JSON na mila (na file, na code block)');
      // 🛡️ JSON mila par adhoora (token/tid/cookies kuch nahi) → aage bhejne ka
      // koi matlab nahi. Ek baar Copy Code se dobara try, warna saaf message.
      if (!isValidWorldSessionJson(jsonText)) {
        const retried = await clickCopyCode({ client, entity, cfg, shouldAbort }).catch(() => null);
        const retriedText = retried?.json?.text || (retried?.message ? await downloadJsonFromMessage(client, retried.message).catch(() => '') : '');
        if (retriedText && isValidWorldSessionJson(retriedText)) {
          jsonText = retriedText;
        } else {
          throw new WorldBotError('bad-json', `JSON adhoora/parse fail (${jsonText.length} chars) — token/tid/cookies kuch nahi mila`);
        }
      }

      state.lastOkAt = Date.now();
      setPhase('done');
      console.log(`[WorldBot] ✅ Login ready: ${cleanPhone} · ${askedName ? 'NEW (name poochha)' : 'OLD (name nahi poochha)'} · JSON ${jsonText.length} chars`);
      return {
        ok: true,
        kind: askedName ? 'fresh_new' : 'existing_account',
        phone: cleanPhone,
        askedName,
        jsonText,
        viaWorldBot: true,
        username: cfg.username,
        screenButtons: [...(state.lastScreenButtons || [])],
      };
    });
  } catch (error) {
    setError(error);
    // 🛡️ Har error ek jaisa nahi hota — category se pata chalta hai ki bot
    // badalna hai (bot_unreachable), session dobara login karna hai
    // (worldbot_setup), ya sirf number defer karna hai (flood/network).
    const category = classifyWorldBotError(error);
    console.warn(`[WorldBot] login fail (${cleanPhone}) [${category}]: ${error?.message || error}`);
    const kind = category === 'aborted'
      ? 'aborted'
      : category === 'worldbot_setup'
        ? 'worldbot_setup'
        : category === 'bot_unreachable'
          ? 'bot_unreachable'
          : 'failed_world_bot';
    return {
      ok: false,
      kind,
      phone: cleanPhone,
      reason: String(error?.message || error).slice(0, 220),
      code: error?.code || category,
      errorCategory: category,
    };
  }
}

// ---------------------------------------------------------------------------
// Bot ki taraf se OTP send hone ka intezaar.
// Owner rule:
//   • 20s me "OTP Sent" nahi aaya            → failed_otp_send (bot badlo)
//   • bot "queue/wait" bole → 20s tak ruko    → phir queued_timeout (bot badlo)
// ---------------------------------------------------------------------------
async function waitForOtpSent({ client, entity, baseline, cfg, shouldAbort }) {
  const sendBudget = Math.max(5_000, Number(cfg?.otpSendTimeoutMs) || WORLD_BOT_DEFAULTS.otpSendTimeoutMs);
  const queueBudget = Math.max(5_000, Number(cfg?.queueWaitMs) || WORLD_BOT_DEFAULTS.queueWaitMs);
  const startedAt = Date.now();
  let queueFirstAt = 0;
  let sawQueueText = '';
  let lastAll = [];

  while (true) {
    const limit = queueFirstAt ? queueFirstAt + queueBudget : startedAt + sendBudget;
    if (Date.now() >= limit) break;
    if (typeof shouldAbort === 'function' && shouldAbort()) {
      throw new WorldBotError('aborted', 'Owner ne STOP/SKIP kiya');
    }
    const all = await parseScreenMessages(client, entity);
    lastAll = all;
    const fresh = baseline ? freshMessages(all, baseline) : all;
    for (const message of fresh) {
      const kind = worldBotPromptKind(message.text);
      if (kind === 'otpSent') return { ok: true, kind: 'otpSent', message };
      if (kind === 'invalidNumber') return { ok: false, kind: 'invalidNumber', message };
      if (worldBotQueueKind(message.text)) {
        if (!queueFirstAt) {
          queueFirstAt = Date.now();
          sawQueueText = String(message.text || '').replace(/\s+/g, ' ').slice(0, 120);
          setPhase('otp-queue-wait');
          console.log(`[WorldBot] ⏳ bot ne queue bataya — ${Math.round(queueBudget / 1000)}s tak wait: ${sawQueueText}`);
        }
      }
    }
    await sleep(Math.max(300, Number(cfg?.pollMs) || WORLD_BOT_DEFAULTS.pollMs));
  }

  const tail = lastAll.slice(0, 2).map((m) => String(m.text || '').replace(/\s+/g, ' ').slice(0, 90)).filter(Boolean).join(' || ');
  if (queueFirstAt) {
    return {
      ok: false,
      kind: 'queued_timeout',
      reason: `Bot ne ${Math.round(queueBudget / 1000)}s tak sirf queue/wait bataya — OTP send nahi hua${sawQueueText ? ` (${sawQueueText})` : ''}`,
    };
  }
  return {
    ok: false,
    kind: 'failed_otp_send',
    reason: `Bot ne ${Math.round(sendBudget / 1000)}s me OTP Sent confirm nahi kiya${tail ? ` — last: ${tail}` : ''}`,
  };
}

// OTP code bot ko bhejo aur confirm karo ki message sach me gaya. Owner ne
// dekha tha: "OTP aa raha hai par bot OTP enter nahi karta aur bot badal
// deta hai" — isliye send fail/confirm fail par retry, aur tab bhi na ho to
// bot NAHI badalta (sirf number aage badhta hai).
async function sendWorldCode(client, entity, code) {
  const text = String(code || '').trim();
  if (!text) return false;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await sendWorldText(client, entity, text);
      await sleep(1_000);
      const recent = await parseScreenMessages(client, entity, 4);
      if (recent.some((m) => String(m.text || '').includes(text))) return true;
      console.warn(`[WorldBot] OTP message confirm nahi hua (try ${attempt})`);
    } catch (e) {
      console.warn(`[WorldBot] OTP send fail (try ${attempt}): ${e?.message || e}`);
    }
    await sleep(1_200);
  }
  return false;
}

// Bot file (.json/.txt) bheje to wahi download karke JSON nikalo.
async function downloadJsonFromMessage(client, message) {
  if (!message?.hasDocument) return '';
  try {
    const buffer = await client.downloadMedia(message.raw || message, {});
    if (!buffer) return '';
    const body = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
    const found = extractWorldBotJson(body);
    if (found) return found.text;
    try {
      const parsed = JSON.parse(body);
      if (looksLikeSessionJson(parsed)) return JSON.stringify(parsed);
    } catch {}
  } catch (e) {
    console.warn('[WorldBot] document download fail:', e?.message || e);
  }
  return '';
}

// JSON text na mile par "Copy Code" button dabao — bot code-block/caption me
// JSON bhejta hai. Uske baad ke messages me JSON dhoondho.
async function clickCopyCode({ client, entity, cfg, shouldAbort }) {
  const screen = await parseScreenMessages(client, entity);
  const hit = findRoleOnScreens(screen, 'copyCode');
  if (!hit) return null;
  console.log(`[WorldBot] 🖱 Copy button: ${hit.button?.text || 'Copy'}`);
  setPhase('copy-code');
  // Click na chale to "Copy Code" text type karke bhi try.
  const found = await clickOrType({
    client, entity, entry: hit.button, cfg, shouldAbort,
    baseline: screenSignature(screen),
    what: 'JSON (Copy Code ke baad)',
    timeoutMs: Math.min(15_000, Number(cfg?.stepTimeoutMs) || 15_000),
    predicate: (fresh) => {
      for (const message of fresh) {
        if (message.hasDocument) return { kind: 'document', message };
        const json = extractWorldBotJson(message.text);
        if (json) return { kind: 'json', message, json };
      }
      return null;
    },
  }).catch(() => null);
  return found;
}

// ---------------------------------------------------------------------------
// BUTTON TRIGGER — pehle click; screen na badle to USI button ka POORA TEXT
// likh kar bhej do (owner ka rule). Do-guna trigger se bachne ke liye typing se
// pehle screen dobara padhi jati hai.
// ---------------------------------------------------------------------------
async function clickOrType({
  client, entity, entry, cfg, shouldAbort, what,
  predicate, baseline = null, timeoutMs = null, maxTypedTries = 2,
}) {
  const total = Math.max(5_000, Number(timeoutMs) || Number(cfg?.stepTimeoutMs) || WORLD_BOT_DEFAULTS.stepTimeoutMs);
  const grace = Math.min(total, Math.max(1_000, Number(cfg?.clickGraceMs) || 4_000));
  const before = baseline || screenSignature(await parseScreenMessages(client, entity));
  const label = String(entry?.text || '').trim();

  if (cfg?.trigger !== 'type') {
    try {
      await clickWorldButton(entry);
      const hit = await waitForReply({
        client, entity, baseline: before, timeoutMs: grace, shouldAbort,
        what: `${what} (click)`, predicate, pollMs: cfg?.pollMs,
      });
      state.lastTrigger = 'click';
      return hit;
    } catch (e) {
      if (e?.code === 'aborted') throw e;
      console.warn(`[WorldBot] click se "${label || what}" trigger nahi hua — text se try karunga`);
    }
  }

  // ⚠️ Typing se pehle screen DO baar aur dekho (turant + 1.2s baad): ho sakta
  // hai click ka jawab 4s ke baad aaya ho — tab type karna double action
  // (jaise delete 2 baar) kar deta hai. Isliye predicate dobara check hota hai.
  for (const waitMs of [0, 700, 1_200]) {
    if (waitMs) await sleep(waitMs);
    try {
      const now = await parseScreenMessages(client, entity);
      const late = predicate ? predicate(freshMessages(now, before), now) : null;
      if (late) {
        state.lastTrigger = 'click-late';
        console.log('[WorldBot] click ka jawab der se aaya — type skip (double action se bachaav)');
        return late;
      }
    } catch {}
  }

  const variants = worldButtonTypeVariants(label).slice(0, Math.max(1, maxTypedTries));
  let lastError = null;
  for (const variant of variants) {
    // Wahi text 8s ke andar dobara na bhejo (double trigger).
    if (state.lastTypedText === variant && Date.now() - (Number(state.lastTypedAt) || 0) < 8_000) {
      console.warn(`[WorldBot] "${variant}" abhi hi type kiya tha — skip`);
      continue;
    }
    try {
      setPhase(`type-${String(variant).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 18) || 'button'}`);
      await sendWorldText(client, entity, variant);
      state.lastTypedText = variant;
      state.lastTypedAt = Date.now();
      console.log(`[WorldBot] ⌨️ type trigger: "${variant}"`);
      const hit = await waitForReply({
        client, entity, baseline: before, timeoutMs: Math.min(total, 25_000), shouldAbort,
        what: `${what} (typed "${variant}")`, predicate, pollMs: cfg?.pollMs,
      });
      state.lastTrigger = 'type';
      return hit;
    } catch (e) {
      if (e?.code === 'aborted') throw e;
      lastError = e;
    }
  }
  throw lastError || new WorldBotError('no-button', `"${label || what}" ko click ya type se trigger nahi kar paya`);
}

async function safeCancel(client, entity, cfg = {}) {
  const hit = findRoleOnScreens(await parseScreenMessages(client, entity), 'cancel');
  if (!hit) return false;
  try {
    await clickWorldButton(hit.button);
  } catch (e) {
    // Click fail → "Cancel" text type karke bhi try (owner rule).
    await sendWorldText(client, entity, String(hit.button?.text || 'Cancel').trim()).catch(() => {});
  }
  await sleep(Math.min(1_500, cfg.pollMs || 1_500));
  return true;
}

// ---------------------------------------------------------------------------
// Delete purana account: Order Hub → account → Delete Account → account → OTP
// ---------------------------------------------------------------------------
export async function worldBotDeleteAccount({
  phone,
  otpProvider = null,
  report = null,
  shouldAbort = null,
  config = worldBotConfig(),
} = {}) {
  const cfg = { ...worldBotConfig(), ...(config || {}) };
  const cleanPhone = normalizeWorldPhone(phone);
  resetWorldBotRunState();
  setPhase('delete-start');
  try {
    return await withTelegramUserClient(async ({ client }) => {
      const entity = await getWorldEntity(client, cfg.username);

      // 1) Order Hub
      setPhase('delete-order-hub');
      let before = screenSignature(await parseScreenMessages(client, entity));
      await clickRole(client, entity, 'orderHub', { cfg, shouldAbort, what: 'Order Hub button' });
      // Order Hub ka jawab: account list (buttons me phone) ya account menu.
      await waitForReply({
        client, entity, baseline: before, timeoutMs: cfg.stepTimeoutMs, shouldAbort,
        what: 'Order Hub accounts',
        predicate: (freshList, all) => {
          const screens = [...freshList, ...all];
          return screens.some((m) => findWorldBotAccountButton(m.buttons, cleanPhone)) ? true : null;
        },
        pollMs: cfg.pollMs,
      }).catch(() => {}); // purana account list na dikhe to bhi aage try karo

      // 2) Woh account chuno
      setPhase('delete-pick-account');
      let screen = await parseScreenMessages(client, entity);
      let accountBtn = null;
      for (const message of screen) {
        const btn = findWorldBotAccountButton(message.buttons, cleanPhone);
        if (btn) { accountBtn = btn; break; }
      }
      if (!accountBtn) {
        // 🛡️ Kabhi Order Hub list khaali/late aati hai — /start se dobara
        // Order Hub khol kar ek baar aur dekho (number waste na ho).
        console.log(`[WorldBot] 🔁 account list me ${cleanPhone} nahi mila — /start se retry`);
        await sendWorldText(client, entity, '/start').catch(() => {});
        await sleep(Math.min(2_000, cfg.pollMs * 2));
        await clickRole(client, entity, 'orderHub', { cfg, shouldAbort, what: 'Order Hub (retry)' }).catch(() => {});
        await waitForReply({
          client, entity, baseline: screenSignature(await parseScreenMessages(client, entity)),
          timeoutMs: Math.min(15_000, cfg.stepTimeoutMs), shouldAbort,
          what: 'Order Hub accounts (retry)',
          predicate: (freshList, all) => [...freshList, ...all].some((m) => findWorldBotAccountButton(m.buttons, cleanPhone)) ? true : null,
          pollMs: cfg.pollMs,
        }).catch(() => {});
        screen = await parseScreenMessages(client, entity);
        for (const message of screen) {
          const btn = findWorldBotAccountButton(message.buttons, cleanPhone);
          if (btn) { accountBtn = btn; break; }
        }
      }
      if (!accountBtn) {
        return { ok: false, kind: 'delete_account_not_listed', phone: cleanPhone, reason: `Order Hub me ye number listed nahi mila (buttons: ${(state.lastScreenButtons || []).join(' | ').slice(0, 120) || 'none'})` };
      }
      before = screenSignature(screen);
      await clickOrType({
        client, entity, entry: accountBtn, cfg, shouldAbort, baseline: before,
        what: 'account menu (Delete Account)',
        predicate: (freshList, all) => findRoleOnScreens([...freshList, ...all], 'deleteAccount'),
      }).catch(() => {});

      // 3) Delete Account
      setPhase('delete-click');
      screen = await parseScreenMessages(client, entity);
      const deleteHit = findRoleOnScreens(screen, 'deleteAccount');
      if (!deleteHit) {
        return { ok: false, kind: 'delete_button_missing', phone: cleanPhone, reason: 'Delete Account button nahi mila — screen: ' + (state.lastScreenButtons.join(' | ') || 'none') };
      }
      before = screenSignature(screen);
      const deletePredicate = (freshList) => {
        for (const message of freshList) {
          const kind = worldBotPromptKind(message.text);
          if (kind === 'deleteSent' || kind === 'askNumber' || kind === 'otpSent') return kind;
        }
        return null;
      };
      const deleteWaiter = () => waitForReply({
        client, entity, baseline: before, timeoutMs: cfg.stepTimeoutMs, shouldAbort,
        what: 'Delete OTP Sent',
        predicate: deletePredicate,
        pollMs: cfg.pollMs,
      });
      // 🔘 Click; screen na badle to "Delete Account" text type karke trigger.
      let deleteAck = await clickOrType({
        client, entity, entry: deleteHit.button, cfg, shouldAbort, baseline: before,
        what: 'Delete OTP Sent', predicate: deletePredicate,
      }).catch(() => null);

      // Bot kabhi pehle confirm poochhta hai ("Haan 💜" / Yes) — tab wahi
      // dabana padta hai, warna flow wahin atak jata hai.
      if (!deleteAck) {
        const confirmScreen = await parseScreenMessages(client, entity);
        let confirmBtn = null;
        for (const message of confirmScreen) {
          const btn = pickWorldBotConfirmButton(message.buttons);
          if (btn) { confirmBtn = btn; break; }
        }
        if (confirmBtn) {
          setPhase('delete-confirm-click');
          console.log(`[WorldBot] 🖱 delete confirm: ${confirmBtn.text || 'Haan'}`);
          before = screenSignature(confirmScreen);
          deleteAck = await clickOrType({
            client, entity, entry: confirmBtn, cfg, shouldAbort, baseline: before,
            what: 'Delete OTP Sent (confirm ke baad)', predicate: deletePredicate,
          }).catch(() => null);
        }
      }

      // 4) Delete ka number/account dobara chuno (bot kabhi dubara maangta hai)
      setPhase('delete-confirm');
      screen = await parseScreenMessages(client, entity);
      const againBtn = (() => {
        for (const message of screen) {
          const btn = findWorldBotAccountButton(message.buttons, cleanPhone);
          if (btn) return btn;
        }
        return null;
      })();
      if (againBtn) {
        before = screenSignature(screen);
        await clickOrType({
          client, entity, entry: againBtn, cfg, shouldAbort, baseline: before, timeoutMs: 12_000,
          what: 'delete account dobara chuno', predicate: deletePredicate,
        }).catch(() => {});
      }

      // 5) Delete OTP
      setPhase('delete-otp-wait');
      await reportCard(report, [
        '🌍 <b>World Bot — Delete OTP Sent</b>',
        `📱 <code>${cleanPhone}</code> · OTP Firebase inbox se aa raha hai…`,
      ].join('\n'));
      if (typeof otpProvider !== 'function') throw new WorldBotError('no-otp-provider', 'Delete OTP provider missing');
      const otp = await otpProvider();
      if (!otp?.code) {
        return {
          ok: false,
          kind: otp?.aborted ? 'aborted' : 'deferred_delete_otp_miss',
          phone: cleanPhone,
          reason: otp?.error || 'Delete OTP inbox me nahi mila',
        };
      }
      const deleteCode = normalizeOtpCode(otp.code);
      if (!deleteCode) {
        return { ok: false, kind: 'deferred_delete_otp_miss', phone: cleanPhone, reason: `Delete OTP galat shakl me aaya: "${String(otp.code).slice(0, 12)}"` };
      }
      before = screenSignature(await parseScreenMessages(client, entity));
      await sendWorldText(client, entity, deleteCode);

      // 6) Result
      setPhase('delete-verify');
      const result = await waitForReply({
        client, entity, baseline: before, timeoutMs: cfg.stepTimeoutMs, shouldAbort,
        what: 'delete result',
        predicate: (freshList) => {
          for (const message of freshList) {
            const kind = worldBotPromptKind(message.text);
            if (kind === 'deleted') return { kind: 'deleted', message };
            if (kind === 'otpFail') return { kind: 'otpFail', message };
          }
          return null;
        },
        pollMs: cfg.pollMs,
      });

      if (result.kind === 'otpFail') {
        return { ok: false, kind: 'delete_otp_rejected', phone: cleanPhone, reason: 'World Bot ne delete OTP accept nahi kiya' };
      }

      // "Account Deleted Successfully" ke saath bot kabhi "Bot se remove: Haan"
      // confirm maangta hai (screenshot) — best-effort click.
      try {
        const confirm = pickWorldBotConfirmButton(result.message?.buttons || []);
        if (confirm) {
          setPhase('delete-remove-confirm');
          await clickOrType({
            client, entity, entry: confirm, cfg, shouldAbort, timeoutMs: 10_000,
            what: 'delete remove confirm',
            predicate: (fresh) => (fresh && fresh.length ? true : null),
          }).catch(() => {});
        }
      } catch (e) {
        console.warn('[WorldBot] delete remove-confirm:', e?.message);
      }

      state.lastOkAt = Date.now();
      setPhase('delete-done');
      console.log(`[WorldBot] 🗑 Account deleted: ${cleanPhone}`);
      return { ok: true, kind: 'deleted', phone: cleanPhone, viaWorldBot: true };
    });
  } catch (error) {
    setError(error);
    const category = classifyWorldBotError(error);
    console.warn(`[WorldBot] delete fail (${cleanPhone}) [${category}]: ${error?.message || error}`);
    const kind = category === 'aborted'
      ? 'aborted'
      : category === 'worldbot_setup'
        ? 'worldbot_setup'
        : category === 'bot_unreachable'
          ? 'bot_unreachable'
          : 'delete_failed';
    return {
      ok: false,
      kind,
      phone: cleanPhone,
      reason: String(error?.message || error).slice(0, 220),
      code: error?.code || category,
      errorCategory: category,
    };
  }
}

// ---------------------------------------------------------------------------
// Best-effort: Switch Accounts → account → Permanently Logged Out
// (owner ka step: delete + fresh ke baad purani entry clean ho jaye)
// ---------------------------------------------------------------------------
export async function worldBotPermanentLogout({
  phone,
  shouldAbort = null,
  config = worldBotConfig(),
} = {}) {
  const cfg = { ...worldBotConfig(), ...(config || {}) };
  const cleanPhone = normalizeWorldPhone(phone);
  resetWorldBotRunState();
  setPhase('logout-start');
  try {
    return await withTelegramUserClient(async ({ client }) => {
      const entity = await getWorldEntity(client, cfg.username);
      const before = screenSignature(await parseScreenMessages(client, entity));
      const switchHit = findRoleOnScreens(await parseScreenMessages(client, entity), 'switchAccounts');
      if (!switchHit) {
        // Screen par na ho to Order Hub se account list kholo.
        await clickRole(client, entity, 'orderHub', { cfg, shouldAbort, what: 'Order Hub' }).catch(() => {});
        await sleep(cfg.pollMs);
      } else {
        await clickOrType({
          client, entity, entry: switchHit.button, cfg, shouldAbort, baseline: before,
          what: 'account switcher',
          timeoutMs: Math.min(20_000, cfg.stepTimeoutMs),
          predicate: (freshList, all) => [...freshList, ...all].some((m) => findWorldBotAccountButton(m.buttons, cleanPhone)) ? true : null,
        }).catch(() => {});
      }

      let screen = await parseScreenMessages(client, entity);
      let accountBtn = null;
      for (const message of screen) {
        const btn = findWorldBotAccountButton(message.buttons, cleanPhone);
        if (btn) { accountBtn = btn; break; }
      }
      if (!accountBtn) return { ok: false, kind: 'logout_account_not_listed', phone: cleanPhone, reason: 'Switch Accounts me number nahi mila' };
      await clickOrType({
        client, entity, entry: accountBtn, cfg, shouldAbort,
        baseline: screenSignature(screen),
        what: 'logout ke liye account chuno', timeoutMs: 15_000,
        predicate: (freshList, all) => findRoleOnScreens([...freshList, ...all], 'permanentLogout'),
      }).catch(() => {});

      screen = await parseScreenMessages(client, entity);
      const logoutHit = findRoleOnScreens(screen, 'permanentLogout');
      if (!logoutHit) return { ok: false, kind: 'logout_button_missing', phone: cleanPhone, reason: 'Permanently Logged Out button nahi mila' };
      await clickOrType({
        client, entity, entry: logoutHit.button, cfg, shouldAbort,
        baseline: screenSignature(screen),
        what: 'Permanently Logged Out', timeoutMs: 15_000,
        predicate: (fresh) => (fresh && fresh.length ? true : null),
      }).catch(() => {});
      state.lastOkAt = Date.now();
      setPhase('logout-done');
      return { ok: true, kind: 'logged_out', phone: cleanPhone };
    });
  } catch (error) {
    setError(error);
    const category = classifyWorldBotError(error);
    return {
      ok: false,
      kind: category === 'aborted' ? 'aborted' : category === 'bot_unreachable' ? 'bot_unreachable' : 'logout_failed',
      phone: cleanPhone,
      reason: String(error?.message || error).slice(0, 200),
      errorCategory: category,
    };
  }
}

// ---------------------------------------------------------------------------
// Diagnose — /world command: bot ka latest screen + buttons dikhao
// ---------------------------------------------------------------------------
export async function probeWorldBot({ limit = 5, config = worldBotConfig() } = {}) {
  const cfg = { ...worldBotConfig(), ...(config || {}) };
  try {
    return await withTelegramUserClient(async ({ client }) => {
      const entity = await getWorldEntity(client, cfg.username);
      const messages = await parseScreenMessages(client, entity, Math.max(1, Number(limit) || 5));
      const screens = messages.map((m) => ({
        id: m.id,
        text: String(m.text || '').replace(/\s+/g, ' ').slice(0, 300),
        buttons: m.buttons.map((b) => b.text),
        hasDocument: m.hasDocument,
        at: m.dateMs ? new Date(m.dateMs).toISOString() : '',
      }));
      const latestWithButtons = screens.find((s) => s.buttons.length) || screens[0] || null;
      return {
        ok: true,
        username: cfg.username,
        screen: latestWithButtons,
        screens,
        client: true,
      };
    });
  } catch (error) {
    setError(error);
    return { ok: false, username: cfg.username, reason: String(error?.message || error).slice(0, 220), code: error?.code || 'worldbot-error' };
  }
}
