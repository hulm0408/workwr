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
  // bot badlo. 👀 Owner ke asli run me queue message ke ~40-60s baad OTP Sent
  // aata hai, isliye 20s bahut kam pad raha tha (bot bekaar rotate hota tha
  // aur pending OTP chhoot jata tha) → default 45s.
  queueWaitMs: 45_000,
  // OTP send confirm na ho (aur bot ne Cancel bhi na bheja ho) to number SKIP
  // nahi hota — wahi number itni baar dobara issue hota hai (Login → 2 → number).
  numberRetries: 1,
  // ⏱ Telegram flood wait ke baad bot ka jawab late padha jata hai. Step ka
  // budget khatam hone par turant "fail" na karo — itni der dheemi scan
  // chalti hai (delete/login result ke liye). Warna delete ho chuka account
  // bhi "delete fail" gina jata tha aur number bekaar naya le liya jata tha.
  lateReplyGraceMs: 90_000,
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
  if (kind === 'worldbot_offline') return false;      // Telegram disconnect
  // ❌ Swiggy ka number-level block ("login attempts exceeded" / "suspended")
  // aur late reply — ye number ka faisla hai, bot wahi rehta hai.
  if (kind === 'number_blocked' || kind === 'login_result_timeout' || kind === 'login_cancelled') return false;
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
    // OTP inbox (Hermes/Firebase) me code aane ka intezaar — 20s se alag.
    otpInboxTimeoutMs: Math.max(30_000, Math.min(180_000,
      num('SWIGGY_WORLD_OTP_INBOX_TIMEOUT_MS', 90_000, 30_000))),
    // Same number ko kitni baar dobara issue karna hai (0-2) — OTP send fail par
    // number skip karne se pehle. Pipeline ko sirf final failure milti hai.
    numberRetries: Math.max(0, Math.min(2, Math.trunc(num('SWIGGY_WORLD_NUMBER_RETRIES', WORLD_BOT_DEFAULTS.numberRetries, 0)))),
    // Delete ke baad "Switch Accounts → Permanently Logged Out" (best-effort).
    logoutAfterDelete: String(env?.SWIGGY_WORLD_LOGOUT_AFTER_DELETE ?? '1') !== '0',
    // Flood wait ke baad ka aakhri scan (0 = band).
    lateReplyGraceMs: Math.max(0, Math.min(180_000,
      num('SWIGGY_WORLD_LATE_REPLY_GRACE_MS', WORLD_BOT_DEFAULTS.lateReplyGraceMs, 0))),
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
  // 📇 Owner ke transcript ka apna step: Main Menu → "Swiggy Accounts" → woh
  // number → "🗑 Permanent Logout". Pehle is button ka koi role hi nahi tha,
  // isliye logout sirf Order Hub/Switch Account se try hota tha aur transcript
  // wala rasta chhoot jata tha.
  if (/\b(swiggy\s*accounts?|my\s*accounts?|saved\s*accounts?)\b/.test(n)) return 'swiggyAccounts';
  if (/\bpermanent\w*\b/.test(n) && /\blog|out\b/.test(n)) return 'permanentLogout';
  if (/\b(log\s*out|logout|sign\s*out)\b/.test(n)) return 'permanentLogout';
  if (/\b(permanent\w*\s*log\s*out|log\s*out\s*permanent\w*)\b/.test(n)) return 'permanentLogout';
  // 🏠 "Main Menu" / "Back to Menu" — delete ke baad owner ka step: pehle
  // Main Menu dabao, phir Login (na /start, na seedha Login).
  if (/\b(main\s*menu|back\s*to\s*menu|home|start\s*over)\b/.test(n)) return 'mainMenu';
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
  const label = (b) => String(b?.text || b || '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase();
  // "Haan 💜", "✅ Yes", "Yes", "Confirm", "Remove" — Cancel/No kabhi nahi.
  const reject = (b) => /\b(no|nahi|nah|cancel|back)\b/.test(label(b));
  const exact = list.find((b) => /^(haan|han|yes|yep|ok|okay|confirm|remove|hata)\b/.test(label(b)) && !reject(b));
  if (exact) return exact;
  return list.find((b) => /\b(haan|han|yes|confirm|remove|hata)\b/.test(label(b)) && !reject(b)) || null;
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

// ⛔ Delete nahi ho sakta — owner ka case: "this account can't be deleted
// because user charges are present". Aise number par fresh account banana
// possible nahi, isliye: Main Menu → Switch Account → woh ID → Permanently
// Log Out → naya number.
export function worldBotDeleteBlockedInfo(text = '') {
  const raw = String(text || '').trim();
  const n = norm(raw);
  if (!n) return null;
  const cannotDelete = /\b(can\s*t|can\s*not|cannot|could\s*not|couldn\s*t|unable\s*to|not\s+possible)\b.{0,60}\bdelet/.test(n)
    || /\bdelet\w*\b.{0,40}\b(not\s+possible|not\s+allowed|failed)\b/.test(n);
  const chargeWords = /\b(user\s+charges?|charges?|dues?|pending\s+(amount|payment|order|bill|dues)|wallet\s*balance|outstanding|balance\s+amount)\b/.test(n);
  if (!cannotDelete && !(chargeWords && /\bdelet/.test(n))) return null;
  return {
    kind: 'deleteBlocked',
    reason: `Account delete nahi ho sakta${chargeWords ? ' (charges/dues pending)' : ''}: ${raw.replace(/\s+/g, ' ').slice(0, 160)}`,
    text: raw.replace(/\s+/g, ' ').slice(0, 200),
  };
}

// Bot ke latest message se pata karo kis step par hai.
// 🔤 Naam ka prompt pehchano — jab bot ka wording naya ho ("What should we call
// you?" / "Apna naam likho"). Owner ke logs me naam step par flow atak raha tha
// kyunki prompt ka wording match nahi hota tha aur hum 45s+90s wait karke
// login dobara shuru kar dete the (naya OTP = "login attempts exceeded").
export function worldBotLooksLikeNamePrompt(text = '', buttons = []) {
  const raw = String(text || '');
  const n = norm(raw);
  if (!n) return false;
  if (Array.isArray(buttons) && buttons.length) return false;   // button wali screen = menu/confirm
  if (/\b(invalid|error|fail|failed|could not|cannot|suspended|expired|cancel|blocked|charge|due)\b/.test(n)) return false;
  if (/\b(otp|code|json|tid|token|cookie|session|order|menu|wallet|logout|login)\b/.test(n)) return false;
  if (/\d{4,}/.test(n)) return false;                           // number/OTP/ID wala text nahi
  if (/\b(name|naam)\b/.test(n) || /\?/.test(raw) || /\b(your good name|call you|apna naam)\b/.test(n)) return true;
  // "🆕 New Account Detected!" jaisa chhota plain message bhi naam ka step hai.
  const words = n.split(' ').filter(Boolean).length;
  return words >= 1 && words <= 25;
}

// Per-message kind check — messages ko JOD kar classify karna galat tha:
// "🔐 Swiggy Login …" + "📱 OTP Login … number bhejo" jodne par kind
// `loginScreen` ban jata tha aur number ka prompt pehchana hi nahi jata tha
// (owner ke logs me isi wajah se 45s ka late scan chalta tha).
export function worldBotHasPromptKind(messages = [], kind = '') {
  const want = String(kind || '');
  if (!want) return false;
  return (Array.isArray(messages) ? messages : []).some((m) => worldBotPromptKind(String(m?.text ?? m ?? '')) === want);
}

export function worldBotPromptKind(text = '') {
  const n = norm(text);
  if (!n) return '';
  // ⛔ "can't be deleted … charges" me "deleted" bhi hai — isliye pehle ye.
  if (worldBotDeleteBlockedInfo(text)) return 'deleteBlocked';
  // ⚠️ Owner ke transcript (24.10.2026) ki asli line:
  //   "✅ Delete OTP Sent … the account will be permanently deleted."
  // Isme "deleted" shabd hai — pehle `deleted` check pehle chalta tha, isliye
  // DELETE OTP ki request hi "Account Deleted Successfully" maan li jaati thi
  // aur flow Main Menu → Login chala jata tha (account zinda rehta tha).
  // Ab delete ka OTP pehle, delete-success baad me.
  if (/\b(delete otp|otp sent.{0,40}delete|delete.{0,30}otp)\b/.test(n)) return 'deleteSent';
  if (/\b(deleted successfully|account deleted|successfully archived|deleted)\b/.test(n)) return 'deleted';
  if (/\b(otp was not accepted|invalid otp|otp galat|wrong otp|otp expired)\b/.test(n)) return 'otpFail';
  if (/\b(invalid mobile|invalid number|number galat)\b/.test(n)) return 'invalidNumber';
  // 🗑 Permanent logout ka apna jawab (transcript: "🗑 Permanent Logout Successful").
  if (/\b(permanent logout successful|logged out successfully|logout successful)\b/.test(n)) return 'logoutOk';
  // ❌ Login cancel — transcript: "❌ Login Cancelled / No account was logged in."
  if (/\b(login cancelled|login canceled|no account was logged in)\b/.test(n)) return 'cancelled';
  // 🔐 Login method screen — "Swiggy Login / Select a login method: JSON | OTP".
  if (/\b(swiggy login|select a login method)\b/.test(n)) return 'loginScreen';
  // ✅ Login ho gaya — "Login Successful … 🆔 Customer ID: …".
  if (/\b(login successful)\b/.test(n)) return 'loginOk';
  // 🧾 JSON wala screen — "Login JSON / Tap Copy on the code block below".
  if (/\b(login json|tap copy)\b/.test(n) || /(tid|access[_\s-]?token|cookies?)/i.test(n) && /\{/.test(String(text || ''))) return 'loginJson';
  // ⏳ Swiggy rate limit / account creation queue — flow rukta nahi, wait.
  if (/\b(rate limit|rate-limit)\b/.test(n) && /\b(queue|que me|queued|create|creation|ban)\b/.test(n)) return 'queued';
  // 🏠 Main Menu — "Main Menu / Pick a feature".
  if (/\b(main menu|pick a feature)\b/.test(n)) return 'menu';
  // ❌ Bot ne khud OTP bhejne se mana kar diya — "Could not send OTP.
  // Swiggy response: Your account is suspended" ya "login attempts exceeded".
  // Ye number ka faisla hai, 20s wait/retry ka koi matlab nahi.
  if (/\b(could not|cannot|can t|cant|unable to)\s+(send|sending)\b.*\botp\b|\botp\b.*\b(could not|cannot)\s+be\s+sent\b/.test(n)) {
    if (/\bsuspend/.test(n)) return 'otpSuspended';
    if (/\b(attempts?\s+exceeded|too many|retry after|try after)/.test(n)) return 'otpAttempts';
    return 'otpSendFailed';
  }
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
  // ❌ Naam reject ho gaya — bot ka jawab: "❌ Invalid name", "Name must be
  // 3-20 letters", "Naam galat hai, dobara bhejo". Isse pehle hum ise miss kar
  // dete the aur 90s tak JSON ka intezaar karke /start bhej dete the (owner:
  // "naam enter nahi ho raha aur baad me /start chala jata hai").
  if (/\b(invalid|galat|wrong|not accepted|reject\w*)\b.{0,20}\b(name|naam)\b/.test(n)
    || /\b(name|naam)\b.{0,25}\b(invalid|galat|wrong|not valid|letters? only|alphabets? only|3\s*(?:-|to|se)\s*20|reject\w*)\b/.test(n)
    || /\b(try (a )?(different|another)|dobara|phir se)\b.{0,20}\b(name|naam)\b/.test(n)
    || /\bname\b.{0,20}\b(already (taken|exists)|must be|should be|should contain)\b/.test(n)) return 'nameFail';
  // Naam ka sawaal — "What is your name?", "Send your name", "apna naam batao".
  // Asli bot lamba likhta hai: "🆕 New Account Detected! Tell us the name to
  // set on your Swiggy account." — pehle 12-word limit ki wajah se ye miss ho
  // jata tha aur bot naam ka intezaar karta reh jata tha.
  // Bot har baar "name" shabd nahi likhta — kuch screens par sirf poochhta hai
  // "What should we call you?" / "Apna naam likho". Ye bhi naam ka step hai.
  const asksName = /\b(name|naam)\b/.test(n)
    || /\b(what should (we|i) call you|call you|your good name|apna naam|naam likh|naam bhej|naam daal|naam batao|your name please)\b/.test(n);
  if (asksName
    && !/\b(otp|code|10\s?-?digit|mobile\s*number|send your 10|main menu|login successful)\b/.test(n)
    && !/\b(rate limit|queue|suspended|attempts exceeded)\b/.test(n)
    && n.split(' ').filter(Boolean).length <= 30) return 'askName';
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
  // "2️⃣ OTP Login" → "OTP Login": asli bot numbered/keycap buttons ko plain
  // naam se hi samajhta hai (owner ke ideal log me "OTP Login" chala).
  const clean = noEmoji.replace(/^[0-9]+[️⃣.)\-]*\s+/u, '').trim();
  // ⚠️ Lowercase variant jaan-boojh kar nahi bhejte: "otp login" bhejne par bot
  // use NUMBER samajh kar "❌ Invalid Mobile Number" deta tha (owner ka log).
  const out = [...new Set([raw, clean, noEmoji].filter(Boolean))];
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
// Bot ne OTP bhejne se mana kiya — kaunsa case aur kya karna hai.
//   suspended  → number dead (skip, bot na badlo)
//   attempts   → "retry after 2 hours" (number cooldown, bot na badlo)
//   sendFailed → generic send error (number aage, bot rotate ho sakta hai)
export function worldBotOtpBlockInfo(text = '') {
  const kind = worldBotPromptKind(text);
  if (kind === 'otpSuspended') {
    return { kind: 'number_blocked', code: 'SWIGGY_SUSPENDED', reason: 'Swiggy: account suspended — ye number dead hai' };
  }
  if (kind === 'otpAttempts') {
    return { kind: 'number_blocked', code: 'SWIGGY_ATTEMPTS', reason: 'Swiggy: login attempts exceeded — ye number 2 ghante ke liye blocked' };
  }
  if (kind === 'otpSendFailed') {
    return { kind: 'failed_otp_send', code: 'SWIGGY_SEND_FAIL', reason: 'Swiggy ne OTP bhejne se mana kiya' };
  }
  return null;
}

// Bot abhi kya maang raha hai (latest screen se): 'otp' | 'number' | 'name' | ''.
// Isi se tay hota hai ki button ka TEXT bhejna safe hai ya nahi — warna wo text
// hi OTP/number ban kar "❌ Invalid OTP / Invalid Mobile Number" deta tha.
// Flow "saaf ho gaya" batane wale messages — inse upar wala purana OTP prompt
// bhool jao, warna "Cancel" ke baad bhi bot ko OTP par khada samajh liya jata
// tha aur dobara /cancel chala jata tha.
const WORLD_TERMINAL_SCREEN = /\b(login cancelled|no account was logged in|pick a feature|main menu|login successful|account deleted successfully|join verified|how to use this bot)\b/;

export function worldBotAwaitingKind(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  // Apna bheja text (number/OTP/naam) "bot ka sawaal" nahi hai.
  const inbound = list.filter((m) => !m?.out);
  const pool = inbound.length >= 2 ? inbound.slice(0, 2) : list.slice(0, 2);
  for (const message of pool) {
    const text = String(message?.text ?? message ?? '');
    if (WORLD_TERMINAL_SCREEN.test(text.toLowerCase())) return '';
    const kind = worldBotPromptKind(text);
    if (kind === 'otpSent' || kind === 'deleteSent' || kind === 'otpFail') return 'otp';
    if (kind === 'askNumber') return 'number';
    if (kind === 'askName') return 'name';
  }
  return '';
}

// OTP send confirm na hua ho (aur bot ne Cancel bhi na bheja) to number skip
// nahi karte — pehle WAHI number dobara issue hota hai. Sirf in cases me retry:
//   failed_otp_send / no-login-button / no-otp-login / no-button / flow stuck
// Retry NAHI: aborted, invalid number, queued_timeout (bot load → switch),
// OTP miss/verify (wahan 20s rule lagta hai), bot_unreachable, setup, network.
export function shouldReissueWorldOtp(kind = '') {
  const k = String(kind || '').trim().toLowerCase();
  if (!k) return false;
  if (/^(aborted|queued_timeout|failed_otp_miss|failed_otp_verify|invalidnumber|failed_invalid_number|number_blocked|bot_unreachable|worldbot_setup|worldbot_offline|flood_wait|network)$/.test(k)) {
    return false;
  }
  // `login_cancelled` = bot ne khud flow cancel kiya (OTP send hi nahi hua).
  // Owner rule: aise me naya number nahi — pehle WAHI number dobara.
  return /otp_send|login_cancelled|no_login|no-login|no-otp-login|no_otp_login|no_button|no-button|no_prompt|number_prompt|timeout|failed_world_bot|send_number|otp-send/.test(k);
}

export function classifyWorldBotError(error = {}) {
  const raw = String(error?.message ?? error ?? '');
  const code = String(error?.code || '').toUpperCase();
  if (code === 'WORLDBOT_ABORTED' || /owner ne stop|aborted|stop\/skip/i.test(raw)) return 'aborted';
  if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED|AUTH_KEY_DUPLICATED|SESSION_PASSWORD_NEEDED/i.test(raw)) {
    return 'worldbot_setup';
  }
  // 🔌 Telegram socket mar gaya ("Cannot send requests while disconnected") —
  // ye number/session ki galti nahi hai. Pehle ye `network` ban kar number
  // jala deta tha; ab alag category (batch rukta hai, number bachta hai).
  if (/cannot send requests while disconnected|telegram client disconnect|client (is )?not connected|not connected to telegram|connection closed/i.test(raw)) {
    return 'worldbot_offline';
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

// 🧪 Test hook: poore login/delete/logout flow ko fake Telegram client par
// chalane ke liye (asli session ke bina). Production me ye kabhi set nahi hota.
let worldBotTestClient = null;
export function _setWorldBotClientOverrideForTests(client = null) {
  worldBotTestClient = client || null;
  return true;
}

async function withWorldBotClient(fn) {
  if (worldBotTestClient) return fn({ client: worldBotTestClient, config: {} });
  return withTelegramUserClient(fn);
}

// ---------------------------------------------------------------------------
// 🔌 CONNECTION GUARD
// Owner ka production log (2026-11-09, Render):
//   `help.getConfig … Cannot send requests while disconnected` har 60s,
//   `GetHistory` 11-13s flood, aur screens `(no text)`.
// Matlab: poore 90s ke flow ke beech Teleproto ka socket mar chuka tha aur
// `withTelegramUserClient` ne sirf flow ke SHURU me check kiya tha. Murda
// socket par har read khali/adhoora aata hai → "45s me jawab nahi aaya" →
// number jal jata tha (bot kuch galat nahi kar raha tha).
// Ab har read/send se pehle connection dekha jata hai aur reconnect hota hai.
const worldConnectState = { at: 0, attempts: 0, lastOkAt: 0, offlineReads: 0 };

function worldBotClientConnected(client) {
  if (!client) return false;
  try {
    if (typeof client.connected === 'boolean') return client.connected;
    if (typeof client._connected === 'boolean') return client._connected;
    if (typeof client.isConnected === 'function') return Boolean(client.isConnected());
  } catch {}
  return true; // pata na chale to maan lo theek hai
}

export function worldBotConnectionInfo() {
  return {
    reconnectAttempts: worldConnectState.attempts,
    lastOkAt: worldConnectState.lastOkAt,
    offlineReads: worldConnectState.offlineReads || 0,
  };
}

async function ensureWorldBotOnline(client, { reason = '', force = false } = {}) {
  if (!client) return false;
  if (!force && worldBotClientConnected(client)) {
    worldConnectState.lastOkAt = Date.now();
    return true;
  }
  // Ek hi reconnect ki jid nahi — 8s me ek koshish.
  if (Date.now() - worldConnectState.at < 8_000) return worldBotClientConnected(client);
  worldConnectState.at = Date.now();
  worldConnectState.attempts += 1;
  console.warn(`[WorldBot] 🔌 Telegram disconnect tha${reason ? ` (${reason})` : ''} — reconnect koshish ${worldConnectState.attempts}`);
  try {
    if (typeof client.connect === 'function') {
      await Promise.race([
        client.connect(),
        sleep(15_000).then(() => { throw new Error('connect 15s me nahi hua'); }),
      ]);
    }
  } catch (e) {
    console.warn(`[WorldBot] 🔌 reconnect fail: ${String(e?.message || e).slice(0, 90)}`);
  }
  const ok = worldBotClientConnected(client);
  if (ok) worldConnectState.lastOkAt = Date.now();
  console.log(`[WorldBot] 🔌 reconnect ${ok ? 'ho gaya — reads phir chalenge' : 'fail — agla step phir try karega'}`);
  return ok;
}

function isDisconnectError(error) {
  return /cannot send requests while disconnected|telegram client disconnect|client (is )?not connected|not connected to telegram|connection closed/i
    .test(String(error?.message ?? error ?? ''));
}

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
  // Bot kabhi text ke bajaye photo/caption bhejta hai — pehle sirf text padha
  // jata tha, isliye "OTP Sent" wala reply "(no text)" ban jata tha.
  //
  // ⚠️ Owner ke log (2026-11-09) me bot ke puraane screens `(no text)` aate the
  // aur flow 45s tak "jawab nahi aaya" par khada reh jata tha. Wajah: saare
  // candidates EK hi try/catch me the — `message.text` (teleproto getter jo
  // entities unparse karta hai) ek hi message par throw kar de to poora
  // function '' lautata tha, chahe `message.message` me asli text maujood ho.
  // Ab har candidate apne try/catch me hai + raw/API fallback bhi.
  const raw = message?.raw;
  const candidates = [
    () => message?.text,
    () => message?.message,
    () => message?.rawText,
    () => raw?.message,
    () => message?.caption,
    () => message?.media?.caption,
    () => raw?.media?.caption,
    () => message?.media?.document?.attributes?.find?.((a) => a?.fileName)?.fileName,
  ];
  for (const get of candidates) {
    let value = '';
    try { value = get(); } catch { continue; }
    const text = plain(value || '');
    if (text) return text;
  }
  return '';
}

// Photo/sticker/voice/media message — text khali ho to bhi bot ne kuch bheja hai.
function messageHasMedia(message) {
  try {
    if (messageHasDocument(message)) return true;
    if (message?.photo || message?.media?.photo) return true;
    if (message?.sticker || message?.media?.sticker) return true;
    const cls = String(message?.media?.className || '');
    if (/photo|sticker|animation|video|webpage/i.test(cls)) return true;
    if (message?.media && typeof message.media === 'object') return true;
  } catch {}
  return false;
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

// 🧠 READ CACHE — owner ke logs ka asli dushman: "Sleeping for 4s / 16s on
// flood wait (GetHistory)". Hum har 500ms-1.5s me chat padhte the, Telegram
// throttle kar deta tha, read 16s ke liye so jata tha — aur usi beech bot ka
// delete/login jawab aaya hota tha par hum use dekh hi nahi paate the, isliye
// step "45s me jawab nahi aaya" keh kar number jala deta tha.
//
// Ab:
//   • single-flight — ek hi waqt me EK GetHistory (10 parallel readers bhi ho
//     to bhi ek call),
//   • adaptive TTL — read ne X ms liya to agla read X*2 tak cache se (flood
//     apne aap kam hota hai, kyunki hum throttle ko aur nahi chhidte),
//   • khali/fail read par purana (aakhri accha) screen wapas — screen kabhi
//     "blank" nahi hoti, isliye button/role ka faisla aankh band karke nahi
//     hota.
const worldReadCache = {
  at: 0,
  limit: 0,
  messages: [],
  inflight: null,
  ttlMs: 400,
  lastReadMs: 0,
  lastFloodMs: 0,
  floodUntil: 0,
  emptyReads: 0,
};

// Screen read me "kha Liya gaya" waqt (flood wait) — step deadlines isse
// badhayi jaati hain, warna flood hi step ka budget kha jata hai.
export function worldBotBlockedMs() {
  return Math.max(0, Number(worldReadCache.lastFloodMs) || 0);
}

// 🧪 Tests ke liye — cache reset + asli read/wait functions (fake client par).
export function _resetWorldBotReadCacheForTests() {
  worldReadCache.at = 0;
  worldReadCache.limit = 0;
  worldReadCache.messages = [];
  worldReadCache.inflight = null;
  worldReadCache.ttlMs = 400;
  worldReadCache.lastReadMs = 0;
  worldReadCache.lastFloodMs = 0;
  worldReadCache.floodUntil = 0;
  worldReadCache.emptyReads = 0;
}

export const _readWorldMessagesForTests = (client, entity, limit) => readWorldMessages(client, entity, limit);
export const _parseScreenMessagesForTests = (client, entity, limit, readOpts) => parseScreenMessages(client, entity, limit, readOpts);
export const _messageTextOfForTests = (message) => messageTextOf(message);
export const _waitForReplyForTests = (opts) => waitForReply(opts);

export function worldBotReadInfo() {
  return {
    ttlMs: worldReadCache.ttlMs,
    lastReadMs: worldReadCache.lastReadMs,
    lastFloodMs: worldReadCache.lastFloodMs,
    emptyReads: worldReadCache.emptyReads,
    cached: Boolean(worldReadCache.messages.length),
  };
}

async function readWorldMessages(client, entity, limit = WORLD_BOT_DEFAULTS.readLimit, { fresh = false } = {}) {
  const take = Math.max(1, Number(limit) || 10);
  // Poll loops ("jawab aaya kya") ko fresh data chahiye — cache unke liye
  // sirf parallel duplicate reads rokta hai (single-flight), purana screen
  // serve nahi karta. Warna flood ke baad aaya jawab cache me chhup jata tha.
  if (!fresh && worldReadCache.messages.length && Date.now() - worldReadCache.at < worldReadCache.ttlMs) {
    return worldReadCache.limit === take
      ? worldReadCache.messages
      : worldReadCache.messages.slice(0, take);
  }
  // Single-flight: jo read chal raha hai wahi share karo.
  if (worldReadCache.inflight) {
    try { return await worldReadCache.inflight; } catch {}
    return worldReadCache.messages;
  }

  worldReadCache.inflight = (async () => {
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      // 🔌 Murda socket par read = khali/adhoora screen. Pehle reconnect.
      if (isDisconnectError(lastError) || attempt === 1) {
        await ensureWorldBotOnline(client, { reason: `read (try ${attempt})` });
      }
      const startedAt = Date.now();
      try {
        const messages = await client.getMessages(entity, { limit: take });
        const readMs = Date.now() - startedAt;
        worldReadCache.lastReadMs = readMs;
        const list = Array.isArray(messages) ? messages : [...(messages || [])];
        if (readMs > 800) {
          // Telegram ne andar hi sula diya (flood wait) — agla read door rakho.
          worldReadCache.lastFloodMs = readMs;
          worldReadCache.floodUntil = Date.now() + Math.min(30_000, readMs);
          worldReadCache.ttlMs = Math.min(8_000, Math.max(600, readMs * 2));
          console.warn(`[WorldBot] 🐢 chat read ${readMs}ms (Telegram flood wait) — agla read ${Math.round(worldReadCache.ttlMs)}ms cache se`);
        } else {
          worldReadCache.lastFloodMs = 0;
          worldReadCache.ttlMs = Math.min(1_500, Math.max(400, readMs * 3));
        }
        if (list.length) {
          worldReadCache.at = Date.now();
          worldReadCache.limit = take;
          worldReadCache.messages = list;
          worldReadCache.emptyReads = 0;
          return list;
        }
        // 🤐 Khali jawab = flood wait / read fail. Purana screen wapas do —
        // "blank screen" se button dhoondhna band.
        worldReadCache.emptyReads += 1;
        lastError = new WorldBotError('empty-screen', 'Bot ki chat khali aayi (Telegram flood wait / read fail)');
      } catch (error) {
        worldReadCache.lastReadMs = Date.now() - startedAt;
        lastError = error;
        if (isDisconnectError(error)) {
          worldReadCache.offlineReads = (worldReadCache.offlineReads || 0) + 1;
          console.warn('[WorldBot] 🔌 read fail — Telegram client disconnect ("Cannot send requests while disconnected")');
        }
      }
      if (attempt < 2) {
        console.warn(`[WorldBot] ⏳ chat read khali/fail (try ${attempt}/2) — ${String(lastError?.message || lastError).slice(0, 80)}`);
        await sleep(1_200);
      }
    }
    // Aakhri accha screen (stale) — blank se behtar.
    if (worldReadCache.messages.length) return worldReadCache.messages;
    return [];
  })();

  try {
    return await worldReadCache.inflight;
  } finally {
    worldReadCache.inflight = null;
  }
}

async function parseScreenMessages(client, entity, limit, readOpts = {}) {
  const messages = await readWorldMessages(client, entity, limit, readOpts);
  const parsed = [];
  for (const message of messages) {
    const buttons = await messageButtons(message);
    parsed.push({
      id: messageIdOf(message),
      text: messageTextOf(message),
      dateMs: messageDateMs(message),
      out: Boolean(message?.out),
      hasDocument: messageHasDocument(message),
      hasMedia: messageHasMedia(message),
      buttons: buttons.map((button) => ({
        button,
        text: buttonTextOf(button),
        role: worldBotButtonRole(buttonTextOf(button)),
      })),
      raw: message,
    });
  }
  state.lastChatAt = Date.now();
  // Latest = bot ka message (apna bheja "/start"/number/OTP nahi) — warna
  // owner ko card me `📺 start: /start · [no buttons]` jaisa blank screen
  // dikhta tha aur buttons ka faisla bhi galat jagah se hota tha.
  //
  // ⚠️ Aur jis message me text/button/media KUCH bhi na ho use "screen" mat
  // maano: Telegram aise service/khali messages (pin, reaction, blank edit)
  // bhej deta hai. Pehle wahi sabse upar baith kar `(no text)` screen banta
  // tha, isliye bot ka asli "OTP Login"/"Main Menu" screen chhup jata tha aur
  // step 45s baad "jawab nahi aaya" keh kar number jala deta tha.
  const inbound = parsed.filter((m) => !m.out);
  const hasContent = (m) => Boolean(m.text || m.buttons.length || m.hasMedia || m.hasDocument);
  const latest = inbound.find(hasContent)
    || inbound[0]
    || parsed.find(hasContent)
    || parsed[0]
    || null;
  if (latest) {
    // Ek baar (30s me max) owner ke log ke liye: screen par text hi nahi aaya.
    if (!hasContent(latest) && Date.now() - (state.lastBlankScreenLogAt || 0) > 30_000) {
      state.lastBlankScreenLogAt = Date.now();
      let keys = '';
      try { keys = Object.keys(latest.raw || {}).slice(0, 14).join(','); } catch {}
      console.warn(`[WorldBot] 📭 screen par kuch nahi (id ${latest.id}, out=${latest.out}) — keys: ${keys || 'n/a'}`);
    }
    state.lastScreenText = String(latest.text || '').slice(0, 400);
    state.lastScreenButtons = latest.buttons.map((b) => b.text);
    // Owner ko pata chale bot exactly kya keh raha hai — /world isi se bharta
    // hai. Sirf text/buttons yaad rakhte hain (koi JSON/session nahi).
    const entry = {
      at: Date.now(),
      phase: state.phase,
      text: String(latest.text || '').replace(/\s+/g, ' ').slice(0, 240),
      media: Boolean(latest.hasMedia),
      out: Boolean(latest.out),
      buttons: latest.buttons.map((b) => b.text).slice(0, 10),
    };
    const last = state.recentScreens[0];
    if (!last || last.text !== entry.text || last.buttons.join('|') !== entry.buttons.join('|')
      || Boolean(last.media) !== entry.media) {
      state.recentScreens = [entry, ...state.recentScreens].slice(0, 8);
      const shown = entry.text || (entry.media ? '(media, no text)' : '(no text)');
      console.log(`[WorldBot] 📺 ${state.phase}: ${shown} · [${entry.buttons.join(' | ') || 'no buttons'}]`);
    }
  }
  return parsed;
}

function screenSignature(messages = []) {
  const map = new Map();
  for (const m of messages) {
    map.set(m.id, `${m.text}|${m.buttons.map((b) => b.text).join('|')}|${m.hasDocument ? 'doc' : ''}${m.hasMedia ? 'media' : ''}${m.out ? 'out' : ''}`);
  }
  return map;
}

function freshMessages(messages, baseline) {
  return messages.filter((m) => {
    const sig = `${m.text}|${m.buttons.map((b) => b.text).join('|')}|${m.hasDocument ? 'doc' : ''}${m.hasMedia ? 'media' : ''}${m.out ? 'out' : ''}`;
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

// Ek read me flood wait ne kitna waqt kha liya — itna hi step ka budget
// badhao. Iske bina 16s ka flood 45s ke step me se 16s kha jata tha aur bot
// ka aaya hua jawab bhi "nahi aaya" gin liya jata tha.
function readBlockMs(readMs = 0) {
  const ms = Number(readMs) || 0;
  // 0.8s se slow read = Telegram ne andar hi roka (normal read 200-400ms).
  if (ms <= 800) return 0;
  return Math.min(60_000, ms - 300);
}

// ⏳ Aakhri mauka: timeout hone par turant fail na karo — dheere-dheere
// (3s gap) ek aur scan, kyunki flood wait ke baad bot ka jawab aksar thodi
// der se padha jata hai. Yahan mil gaya to step PASS.
async function scanForLateReply({
  client, entity, predicate, baseline, graceMs = 0, shouldAbort, what = 'reply',
}) {
  const total = Math.max(0, Number(graceMs) || 0);
  if (!total) return null;
  const deadline = Date.now() + total;
  console.log(`[WorldBot] 🕰 "${what}" ke liye aakhri scan ${Math.round(total / 1000)}s (dheere, flood ke baad ka jawab bhi mile)`);
  while (Date.now() < deadline) {
    if (typeof shouldAbort === 'function' && shouldAbort()) return null;
    const all = await parseScreenMessages(client, entity, undefined, { fresh: true });
    const fresh = baseline ? freshMessages(all, baseline) : all;
    const hit = predicate(fresh, all);
    if (hit) {
      console.log(`[WorldBot] 🕰 late reply mil gaya — "${what}" PASS`);
      return hit;
    }
    await sleep(3_000);
  }
  return null;
}

// Naya jawab aane tak poll karo. predicate(fresh, all) truthy de to wahi
// return ho jata hai; timeout par WorldBotError('worldbot-timeout').
async function waitForReply({
  client, entity, predicate, baseline, timeoutMs, shouldAbort, what = 'reply', pollMs, graceMs,
}) {
  const budget = Math.max(1_000, Number(timeoutMs) || WORLD_BOT_DEFAULTS.stepTimeoutMs);
  // ⏱ Flood wait se kha Liya gaya waqt deadline me wapas jata hai (max 3x).
  let deadline = Date.now() + budget;
  let extraMs = 0;
  const maxExtra = Math.max(30_000, Math.min(180_000, budget * 3));
  const every = Math.max(300, Number(pollMs) || WORLD_BOT_DEFAULTS.pollMs);
  let lastAll = [];
  while (Date.now() < deadline) {
    if (typeof shouldAbort === 'function' && shouldAbort()) {
      throw new WorldBotError('aborted', 'Owner ne STOP/SKIP kiya');
    }
    const readStartedAt = Date.now();
    const all = await parseScreenMessages(client, entity, undefined, { fresh: true });
    const readMs = Date.now() - readStartedAt;
    const add = readBlockMs(readMs);
    if (add > 0 && extraMs + add <= maxExtra) {
      extraMs += add;
      deadline += add;
      console.log(`[WorldBot] 🐢 read ne ${Math.round(readMs / 1000)}s liye (flood) — "${what}" ka budget +${Math.round(add / 1000)}s`);
    }
    lastAll = all;
    const fresh = baseline ? freshMessages(all, baseline) : all;
    const hit = predicate(fresh, all);
    if (hit) return hit;
    await sleep(every);
  }
  // Deadline khatam — par flood ke baad jawab late aata hai, isliye ek
  // aakhri dheemi scan (default 45s).
  const grace = graceMs === undefined ? 45_000 : Number(graceMs) || 0;
  const late = await scanForLateReply({
    client, entity, predicate, baseline, graceMs: grace, shouldAbort, what,
  }).catch(() => null);
  if (late) return late;
  // 🔎 Timeout ka reason OWNER ke liye kaam ka hona chahiye. Pehle yahan
  // apna hi bheja hua message (OTP "230713") chhap jata tha — log me
  // "last: 230713" dikhta tha aur bot ka asli jawab
  // ("❌ Could not send OTP … login attempts exceeded") chhup jata tha.
  // Ab: bot ka screen pehle, apna message alag label se, aur button list bhi.
  const flat = (m) => String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 90);
  const inboundTail = lastAll.filter((m) => !m.out).map(flat).filter(Boolean).slice(0, 3).join(' || ');
  const ownTail = lastAll.filter((m) => m.out).map(flat).filter(Boolean).slice(0, 1).map((t) => `apna bheja: ${t}`).join('');
  const buttonsTail = (lastAll.find((m) => m.buttons && m.buttons.length)?.buttons || [])
    .map((b) => b.text).filter(Boolean).slice(0, 6).join(' | ');
  const tail = [inboundTail || '(bot ka text nahi aaya)', ownTail, buttonsTail ? `buttons: ${buttonsTail}` : 'buttons: none']
    .filter(Boolean).join(' · ');
  throw new WorldBotError(
    'worldbot-timeout',
    `${what} ka jawab ${Math.round(budget / 1000)}s (+${Math.round(extraMs / 1000)}s flood) me nahi aaya — ${tail}`
  );
}

// 🧘 Bot ka jawab poora aane ka intezaar: jab tak latest message ka id na
// badle, agla command mat bhejo. Owner ki shikayat: "bot response aane se
// pehle hi 3-4 command de deta hai".
async function settledScreen(client, entity, cfg = {}, { quietMs = 1_500, maxMs = 10_000 } = {}) {
  const every = Math.max(250, Number(cfg?.pollMs) || 1_200);
  const quiet = Math.max(400, Number(quietMs) || 1_500);
  let deadline = Date.now() + Math.max(quiet, Number(maxMs) || 9_000);
  let lastId = -1;
  let lastChange = Date.now();
  for (;;) {
    const readStartedAt = Date.now();
    const all = await parseScreenMessages(client, entity, 6, { fresh: true });
    // Flood wait ne waqt khaya → deadline bhi badhao (warna adhoori screen
    // par "settle" maan kar agla command chala jata tha).
    const add = readBlockMs(Date.now() - readStartedAt);
    if (add > 0) deadline += Math.min(30_000, add);
    const id = Number(all[0]?.id) || 0;
    if (id !== lastId) {
      lastId = id;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= quiet) {
      return all;
    }
    if (Date.now() >= deadline) return all;
    await sleep(every);
  }
}

// Kisi action ke baad "screen badli kya?" ka intezaar (quiet-based settle
// slow bot par jaldi laut jata hai aur hum duplicate command bhej dete hain).
async function waitForScreenChange(client, entity, cfg = {}, { fromId = 0, timeoutMs = 5_000 } = {}) {
  const every = Math.max(250, Number(cfg?.pollMs) || 1_200);
  let deadline = Date.now() + Math.max(1_000, Number(timeoutMs) || 5_000);
  for (;;) {
    const readStartedAt = Date.now();
    const all = await parseScreenMessages(client, entity, 6, { fresh: true });
    const add = readBlockMs(Date.now() - readStartedAt);
    if (add > 0) deadline += Math.min(30_000, add);
    // Latest message ka id badla = bot ne jawab diya (message count/limit se
    // compare karna galat tha — 6 vs 15 messages par signature hamesha alag).
    if ((Number(all[0]?.id) || 0) !== fromId) return all;
    if (Date.now() >= deadline) return all;
    await sleep(every);
  }
}

// Button role sirf LATEST 1-2 messages me dhoondho. Poori chat history dekhne
// se purane menu ka button "maujood" maan liya jata tha aur bot galat command
// bhej deta tha ("otp login" → ❌ Invalid Mobile Number).
function roleOnLatest(messages = [], role = '') {
  const list = Array.isArray(messages) ? messages : [];
  // 📵 Apne bheje hue message (jaise "/start", number, OTP) ke paas button
  // nahi hota. Pehle wahi "latest screen" banti thi — owner ke logs me
  // `📺 start: /start · [no buttons]` — aur Login/OTP button "nahi mila"
  // ho jata tha. Ab latest = bot ka (incoming) message.
  const inbound = list.filter((m) => !m?.out);
  const pool = (inbound.length ? inbound : list).slice(0, 3);
  return findRoleOnScreens(pool, role) || findRoleOnScreens(list.slice(0, 2), role);
}

async function sendWorldText(client, entity, text) {
  const payload = String(text);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      // 🔌 Send se pehle bhi connection — "Cannot send requests while
      // disconnected" par command chup-chaap gayab ho jati thi aur flow
      // phir "jawab nahi aaya" par atak jata tha.
      await ensureWorldBotOnline(client, { reason: 'send' });
      await client.sendMessage(entity, { message: payload });
      state.lastAction = `send:${payload.slice(0, 24)}`;
      state.lastChatAt = Date.now();
      return true;
    } catch (error) {
      // 🔌 Disconnect par ek reconnect + wahi message dobara (number/OTP
      // chup-chaap gum na ho).
      if (isDisconnectError(error) && attempt === 1) {
        await ensureWorldBotOnline(client, { reason: 'send retry' });
        continue;
      }
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
  // entry kabhi wrapper `{ button, text, role }` hota hai, kabhi seedha button
  // object — dono chalein (naam confirm wale raste me raw button bhi aata hai).
  const button = entry?.button || (typeof entry?.click === 'function' ? entry : null);
  if (!button) throw new WorldBotError('no-button', 'Button nahi mila');
  state.lastAction = `click:${entry?.text || button?.text || ''}`;
  setPhase(`click-${entry?.role || 'button'}`);
  const answer = await button.click({});
  const callback = String(answer?.message || '').trim().slice(0, 180);
  const label = String(entry?.text || button?.text || 'button');
  console.log(`[WorldBot] click: ${label}${callback ? ` — callback: ${callback}` : ''}`);
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
  otpWatermark = null,
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
    return await withWorldBotClient(async ({ client }) => {
      const entity = await getWorldEntity(client, cfg.username);

      // 1) Main menu — delete ke baad owner ka flow: Main Menu → Login → OTP
      // Login → number. `/start` sirf tab jab Main Menu/Login kuch na mile.
      setPhase('start');
      if (fresh) console.log('[WorldBot] 🔁 fresh login — Main Menu se Login → OTP Login → number');
      // worldResetToMenu khud /start bhej kar menu ka intezaar karta hai —
      // yahan dobara /start bhejne se duplicate command jati thi.
      const menuReady = await worldResetToMenu(client, entity, cfg);
      if (!menuReady) console.warn('[WorldBot] menu saaf nahi hua — Login button ka intezaar');
      let before = screenSignature(await settledScreen(client, entity, cfg));
      await waitForReply({
        client, entity, baseline: before, timeoutMs: cfg.startTimeoutMs, shouldAbort,
        what: 'main menu',
        predicate: (freshList, all) => roleOnLatest(freshList, 'login') || roleOnLatest(all, 'login'),
        pollMs: cfg.pollMs,
      }).catch(async () => {
        // /start ka jawab na aaya ho to latest screen par Login dhoondho.
        const hit = roleOnLatest(await parseScreenMessages(client, entity), 'login');
        if (!hit) throw new WorldBotError('no-login-button', '/start ke baad Login button nahi mila');
        return hit;
      });

      // Ek number ke liye poora OTP-issue sequence: Login → OTP Login (2) → number.
      // Owner rule: kai baar OTP bhejne ki screen hi nahi aati aur bot Cancel bhi
      // nahi bhejta — tab agla number nahi, WAHI number dobara issue hota hai.
      let otpWatermarkForRound = null;
      const issueNumberOtp = async ({ attempt = 1 } = {}) => {
        if (attempt > 1) {
          // adhoora screen saaf karo, typed-text guard reset, phir /start se menu.
          state.lastTypedText = '';
          state.lastTypedAt = 0;
          await worldResetToMenu(client, entity, cfg).catch(() => {});
        }

        // 2) 🔐 Login → method picker
        setPhase('login-menu');
        let loginScreen = await settledScreen(client, entity, cfg);
        let issueBaseline = screenSignature(loginScreen);
        let loginHit = roleOnLatest(loginScreen, 'login');
        if (!loginHit) {
          // Telegram "flood wait" / khali read me bot ka screen hi nahi milta.
          // Pehle ise bot ki galti maan kar bot switch ho jata tha — ab ek baar
          // menu reset karke dobara dekhte hain.
          console.warn('[WorldBot] ↻ Login button nahi mila — menu reset karke ek aur koshish');
          await worldResetToMenu(client, entity, cfg).catch(() => {});
          loginScreen = await settledScreen(client, entity, cfg);
          issueBaseline = screenSignature(loginScreen);
          loginHit = roleOnLatest(loginScreen, 'login');
        }
        if (!loginHit) throw new WorldBotError('no-login-button', `Login button nahi mila — screen: ${(state.lastScreenButtons || []).join(' | ') || 'none'}`);
        await clickOrType({
          client, entity, entry: loginHit.button, cfg, shouldAbort, baseline: issueBaseline,
          what: 'login method screen',
          predicate: (freshList, all) => roleOnLatest(freshList, 'otpLogin') || roleOnLatest(all, 'otpLogin'),
        });

        // 3) 📲 OTP Login → number maango
        setPhase('otp-login');
        let otpScreen = await settledScreen(client, entity, cfg);
        let otpBtn = roleOnLatest(otpScreen, 'otpLogin');
        if (!otpBtn && worldBotAwaitingKind(otpScreen) !== 'number') {
          // Screen late aayi ho / read choke ho — ek chhoti wait ke baad dobara.
          await sleep(1_200);
          otpScreen = await settledScreen(client, entity, cfg);
          otpBtn = roleOnLatest(otpScreen, 'otpLogin');
        }
        issueBaseline = screenSignature(otpScreen);
        // Button na mile par bot pehle se number maang raha ho → wahi sahi jagah hai.
        if (!otpBtn) {
          if (worldBotAwaitingKind(otpScreen) === 'number') return 'askNumber';
          throw new WorldBotError('no-otp-login', 'OTP Login button nahi mila');
        }

        // 4) number prompt (click na chale to "OTP Login" text type hoga)
        setPhase('send-number');
        let promptError = null;
        await clickOrType({
          client, entity, entry: otpBtn.button, cfg, shouldAbort, baseline: issueBaseline,
          what: 'number prompt',
          timeoutMs: Math.min(20_000, cfg.stepTimeoutMs),
          predicate: (freshList, all) => {
            // Har message ALAG dekho (jodne se "Swiggy Login" wala purana screen
            // naye number-prompt ko chhupa deta tha → 45s ka late scan).
            const pool = [...freshList, ...all.slice(0, 3)];
            return worldBotHasPromptKind(pool, 'askNumber') ? true : null;
          },
        }).then(() => true).catch((e) => { promptError = e; return true; }); // prompt na mile to bhi number bhej do

        // 🛑 Par agar bot ne isi beech OTP bhejne se MANA kar diya / login
        // cancel kar diya, to number bhejna bekaar hai (aur Swiggy
        // "login attempts exceeded" de deta hai). Turant wahi faisla lo.
        if (promptError) {
          const blocked = worldBotOtpBlockInfo(String(promptError?.message || ''));
          if (blocked) {
            console.warn(`[WorldBot] ❌ number prompt ke bajaye ${blocked.code} — number bhejna band`);
            return { ok: false, kind: blocked.kind, code: blocked.code, reason: blocked.reason };
          }
          const nowScreen = await parseScreenMessages(client, entity, 6, { fresh: true }).catch(() => []);
          const nowText = nowScreen.slice(0, 4).map((m) => m.text).join('\n');
          const screenBlocked = worldBotOtpBlockInfo(nowText);
          if (screenBlocked) {
            console.warn(`[WorldBot] ❌ screen par ${screenBlocked.code} — number bhejna band`);
            return { ok: false, kind: screenBlocked.kind, code: screenBlocked.code, reason: screenBlocked.reason };
          }
          if (worldBotPromptKind(nowText) === 'cancelled') {
            return {
              ok: false,
              kind: 'login_cancelled',
              code: 'WORLDBOT_LOGIN_CANCELLED',
              reason: 'Bot ne number maangne ke bajaye login cancel kar diya — wahi number dobara (naya number nahi)',
            };
          }
        }

        await reportCard(report, [
          '🌍 <b>Swiggy World Bot — OTP Login</b>',
          `📱 <b>Number:</b> <code>${cleanPhone}</code>`,
          attempt > 1
            ? `↻ Wahi number dobara bhej raha hoon (try ${attempt}) — /start → Login → OTP Login`
            : '→ /start → Login → OTP Login ho gaya, ab number bhej raha hoon…',
        ].join('\n'));

        // Number bhejne se pehle bot ka jawab poora aane do (burst nahi).
        issueBaseline = screenSignature(await settledScreen(client, entity, cfg));
        // 🔖 OTP bot ka watermark number bhejne se THIK PEHLE — iske baad
        // aaya/edited code hi is number ka naya OTP hai. (Pehle baseline "OTP
        // Sent" ke baad liya jata tha, isliye jaldi aaya OTP purana gina jata
        // tha aur 90s tak type hi nahi hota tha.)
        otpWatermarkForRound = null;
        if (typeof otpWatermark === 'function') {
          try {
            otpWatermarkForRound = await otpWatermark();
            console.log(`[WorldBot] 🔖 OTP watermark set (${cleanPhone}) — ab iske baad ka code hi naya`);
          } catch (error) {
            console.warn(`[WorldBot] ⚠️ OTP watermark fail: ${String(error?.message || error).slice(0, 90)}`);
          }
        }
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
      let usedAttempts = 0;
      for (let attempt = 1; attempt <= issueTries; attempt += 1) {
        usedAttempts = attempt;
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
          attempts: usedAttempts,
          reason: `${numberResult?.reason || 'OTP send confirm nahi hua'}${usedAttempts > 1 ? ` · ${usedAttempts} try ke baad bhi` : ''}`,
        };
      }

      // 5) OTP lao (Firebase inbox se — pipeline deta hai) aur bhejo
      setPhase('otp-wait');
      await reportCard(report, [
        '🌍 <b>World Bot — OTP Sent</b>',
        `📱 <code>${cleanPhone}</code> · ab OTP inbox se code ka intezaar (20s confirm ho gaya, inbox apna alag budget)`,
      ].join('\n'));
      if (typeof otpProvider !== 'function') throw new WorldBotError('no-otp-provider', 'OTP provider missing');
      // 🔭 Watchdog: OTP fetch kabhi chup-chaap atka na rahe (pehle lock ke
      // deadlock me poora flow yahin freeze ho jata tha — koi log bhi nahi).
      const inboxMs = Math.max(20_000, Number(cfg.otpInboxTimeoutMs) || 90_000);
      const fetchStartedAt = Date.now();
      console.log(`[WorldBot] 🔎 OTP fetch shuru — ${cleanPhone} · budget ${Math.round(inboxMs / 1000)}s`);
      const otp = await Promise.race([
        otpProvider({ watermark: otpWatermarkForRound, phone: cleanPhone }),
        new Promise((resolve) => setTimeout(() => resolve({
          code: '',
          code2: 'OTP_FETCH_HANG',
          error: `OTP fetch ${Math.round((Date.now() - fetchStartedAt) / 1000)}s me wapas nahi aaya (Telegram lock/hang) — number skip`,
        }), inboxMs + 15_000).unref?.()),
      ]);
      console.log(`[WorldBot] 🔎 OTP fetch khatam (${Date.now() - fetchStartedAt}ms) — ${otp?.code ? 'code mila' : 'code nahi mila'}`);
      if (!otp?.code) {
        await safeCancel(client, entity, cfg).catch(() => {});
        if (otp?.aborted) return { ok: false, kind: 'aborted', phone: cleanPhone, reason: 'OTP wait abort' };
        // 👀 Owner ko saaf pata chale ki OTP SOURCE me code hi nahi aaya
        // (bot ne type nahi kiya isliye nahi — code hi nahi mila tha).
        console.warn(`[WorldBot] OTP inbox me code nahi aaya (${cleanPhone}) — ${otp?.error || 'source empty'}`);
        return {
          ok: false,
          kind: 'failed_otp_miss',
          phone: cleanPhone,
          code: 'OTP_SOURCE_EMPTY',
          reason: otp?.error || 'OTP source (Hermes/Firebase) me is number ka code hi nahi aaya — bot ne type nahi kiya kyunki code hi nahi tha',
        };
      }
      console.log(`[WorldBot] OTP mila (${cleanPhone}) — bot ko type kar raha hoon`);

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
      const typed = await sendWorldCode(client, entity, otpCode, cfg);
      if (!typed.ok) {
        await safeCancel(client, entity, cfg).catch(() => {});
        if (typed.reason === 'bot-login-cancelled' || String(typed.reason || '').startsWith('bot-SWIGGY_')) {
          return {
            ok: false,
            kind: 'login_cancelled',
            code: 'WORLDBOT_LOGIN_CANCELLED',
            phone: cleanPhone,
            reason: `Bot ne login cancel/block kar diya — OTP type nahi kiya (${typed.reason})`,
          };
        }
        return {
          ok: false,
          kind: 'failed_otp_verify',
          phone: cleanPhone,
          code: typed.reason,
          reason: `OTP aa gaya (${otpCode.length} digit) par bot ne nahi liya [${typed.reason}] — bot nahi badla, number aage badha`,
        };
      }

      // 6) Outcome: naam ka sawaal = naya account; seedha JSON = purana.
      const outcome = await waitForReply({
        client, entity, baseline: before, timeoutMs: cfg.stepTimeoutMs, shouldAbort,
        what: 'login result',
        graceMs: Number(cfg.lateReplyGraceMs) || 90_000,
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
            // 🔤 Bot ka wording naya ho ("What should we call you?") to bhi naam
            // ka step hi hai — warna yahan 45s+90s wait karke dobara login
            // (naya OTP) hota tha aur account atka reh jata tha.
            if (!kind && !message.out && worldBotLooksLikeNamePrompt(message.text, message.buttons)) {
              console.log(`[WorldBot] 🔤 naam ka prompt (guess): ${String(message.text || '').replace(/\s+/g, ' ').slice(0, 80)}`);
              return { kind: 'askName', message, guessed: true };
            }
          }
          return null;
        },
        pollMs: cfg.pollMs,
      });

      let askedName = false;
      let final = outcome;

      if (outcome.kind === 'askName') {
        askedName = true;
        // 🔤 Naam step apne helper me: khali/invalid naam reject hone par agla
        // naam, confirm maange to Yes, aur JSON miss ho to recovery — /start
        // ya naya number kabhi nahi (owner ka rule).
        const nameRes = await submitWorldBotName({
          client, entity, cfg, shouldAbort, nameProvider, phone: cleanPhone,
        });
        if (!nameRes.ok) {
          if (nameRes.kind === 'otpFail') {
            await safeCancel(client, entity, cfg).catch(() => {});
            return { ok: false, kind: 'failed_otp_verify', phone: cleanPhone, reason: 'World Bot ne OTP accept nahi kiya' };
          }
          setPhase('name-failed');
          console.warn(`[WorldBot] ❌ naam step fail (${nameRes.kind}): ${nameRes.reason}`);
          return {
            ok: false,
            kind: nameRes.kind === 'name_rejected' ? 'name_rejected' : 'no-json',
            phone: cleanPhone,
            askedName: true,
            code: nameRes.kind === 'name_rejected' ? 'WORLDBOT_NAME_REJECTED' : 'WORLDBOT_JSON_MISSING',
            reason: `${nameRes.reason || 'naam step fail'} — account ban gaya hai, naya number ya /start nahi (wahi number se JSON le sakte hain)`,
          };
        }
        console.log(`[WorldBot] ✅ naam accept hua: ${nameRes.name}`);
        final = nameRes.final;
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
        // 🔎 JSON recovery: Copy button → aakhri 15 messages → 12s ka wait.
        // (Kabhi JSON agle message me ya edit hokar aata hai; pehle seedha
        // `no-json` ho kar flow /start par chala jata tha.)
        const recovered = await recoverWorldBotJson({ client, entity, cfg, shouldAbort }).catch(() => null);
        if (recovered?.jsonText) {
          jsonText = recovered.jsonText;
          console.log(`[WorldBot] 🔎 JSON recovery mil gaya (${recovered.via})`);
        }
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
    // ❌ Timeout wale error ke message me bot ka asli jawab chipka hota hai
    // ("… last: ❌ Could not send OTP. Swiggy response: login attempts
    // exceeded"). Pehle wo `failed_world_bot` → `failed_otp_send` ban kar bot
    // SWITCH kar deta tha (owner: galat). Ab seedha number ka faisla.
    const blockedInText = category === 'aborted' ? null : worldBotOtpBlockInfo(String(error?.message ?? ''));
    if (blockedInText) {
      console.warn(`[WorldBot] ❌ error text me ${blockedInText.code} — bot switch/retry nahi (number ka faisla)`);
      return {
        ok: false,
        kind: blockedInText.kind,
        code: blockedInText.code,
        phone: cleanPhone,
        reason: blockedInText.reason,
        errorCategory: 'number_blocked',
      };
    }
    const kind = category === 'aborted'
      ? 'aborted'
      : category === 'worldbot_setup'
        ? 'worldbot_setup'
        : category === 'worldbot_offline'
          // 🔌 Telegram socket mara hua tha — na number ki galti, na bot ki.
          ? 'worldbot_offline'
          : category === 'bot_unreachable'
            ? 'bot_unreachable'
            // ⏱ Bot ka jawab window ke andar nahi aaya — ye bot/number ka
            // "fail" nahi, sirf late hai. Pipeline ise wahi number par dobara
            // try karti hai (number jalana galat hoga).
            : error?.code === 'worldbot-timeout'
              ? 'login_result_timeout'
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
  // 🤖 Bot ka reply kabhi bilkul khali / photo hota hai (text hi nahi). Owner ke
  // logs me yahi ho raha tha: number jata tha, bot ek blank/media message
  // bhejta tha, hum use "OTP Sent confirm nahi hua" maan kar Cancel + wahi
  // number dobara bhejte the → Swiggy "login attempts exceeded" → number jalta
  // tha aur OTP kabhi type hi nahi hota tha. Ab aisa reply = OTP Sent.
  let blankReplyAt = 0;
  let blankReplyMedia = false;
  // 🐢 Flood wait se kha Liya gaya waqt 20s ke budget me se nahi jayega —
  // warna bot ka "OTP Sent" aane se pehle hi hum Cancel + dobara number
  // bhej dete the (Swiggy: login attempts exceeded).
  let floodExtraMs = 0;

  while (true) {
    const limit = (queueFirstAt ? queueFirstAt + queueBudget : startedAt + sendBudget) + floodExtraMs;
    if (Date.now() >= limit) break;
    if (typeof shouldAbort === 'function' && shouldAbort()) {
      throw new WorldBotError('aborted', 'Owner ne STOP/SKIP kiya');
    }
    const readStartedAt = Date.now();
    const all = await parseScreenMessages(client, entity, undefined, { fresh: true });
    const add = readBlockMs(Date.now() - readStartedAt);
    if (add > 0) floodExtraMs = Math.min(60_000, floodExtraMs + add);
    lastAll = all;
    const fresh = baseline ? freshMessages(all, baseline) : all;
    for (const message of fresh) {
      // ❌ "Could not send OTP … suspended / attempts exceeded" — yahan 20s
      // wait ya retry ka koi matlab nahi, number ka faisla turant.
      const blocked = worldBotOtpBlockInfo(message.text);
      if (blocked) return { ok: false, kind: blocked.kind, code: blocked.code, reason: blocked.reason, message };
      const kind = worldBotPromptKind(message.text);
      if (kind === 'otpSent') return { ok: true, kind: 'otpSent', message };
      if (kind === 'invalidNumber') return { ok: false, kind: 'invalidNumber', message };
      // Bot ka jawab aaya par text nahi (photo/blank) — ise turant "OTP Sent"
      // mat maano. Owner ke log me yahi hua: blank reply ke 3s baad hum OTP
      // bot par chale gaye, jabki usi chat me "❌ Could not send OTP. Swiggy
      // response: login attempts exceeded" likha tha → 20 refresh, code hi
      // nahi → `failed_otp_miss` aur number jal gaya.
      // Ab pehle poora screen padh kar dekhte hain; text mila to wahi sach hai.
      if (!message.out && !String(message.text || '').trim()) {
        if (!blankReplyAt) {
          blankReplyAt = Date.now();
          blankReplyMedia = Boolean(message.hasMedia);
          console.log(`[WorldBot] 🤔 bot ka jawab aaya par text nahi (${blankReplyMedia ? 'media' : 'blank'}) — screen dobara padhta hoon`);
        }
        continue;
      }
      if (worldBotQueueKind(message.text)) {
        if (!queueFirstAt) {
          queueFirstAt = Date.now();
          sawQueueText = String(message.text || '').replace(/\s+/g, ' ').slice(0, 120);
          setPhase('otp-queue-wait');
          console.log(`[WorldBot] ⏳ bot ne queue bataya — ${Math.round(queueBudget / 1000)}s tak wait: ${sawQueueText}`);
        }
      }
    }
    // Blank/media reply ke baad thoda intezaar — ho sakta hai asli text agle
    // message me aaye. 3s tak kuch na aaye to poora screen dobara padho:
    // agar `Could not send OTP` / `suspended` / `attempts exceeded` wahan hai
    // to wahi jeetta hai (blank reply ka matlab OTP Sent NAHI).
    if (blankReplyAt && Date.now() - blankReplyAt >= 3_000) {
      const screen = await parseScreenMessages(client, entity, 8, { fresh: true }).catch(() => []);
      const recent = screen.slice(0, 6);
      // Message-wise dekho (jodne par ek purana "Main Menu" naye "OTP Sent"
      // ko chhupa deta tha).
      const blocked = recent.map((m) => worldBotOtpBlockInfo(m.text)).find(Boolean);
      if (blocked) {
        console.warn(`[WorldBot] ❌ blank reply ke peeche ${blocked.code}: ${blocked.reason} — OTP Sent nahi maan raha`);
        return { ok: false, kind: blocked.kind, code: blocked.code, reason: blocked.reason };
      }
      if (worldBotHasPromptKind(recent, 'otpSent')) {
        console.log('[WorldBot] ✅ OTP Sent confirm (blank reply + screen text)');
        return { ok: true, kind: 'otpSent', confirmedBy: 'blank-reply+screen' };
      }
      if (worldBotHasPromptKind(recent, 'cancelled')) {
        return { ok: false, kind: 'login_cancelled', code: 'WORLDBOT_LOGIN_CANCELLED', reason: 'Bot ne login cancel kar diya (screen: Login Cancelled)' };
      }
      console.log('[WorldBot] ✅ OTP Sent confirm (blank/media reply, screen khali) — ab OTP bot se code');
      return { ok: true, kind: 'otpSent', confirmedBy: blankReplyMedia ? 'media-reply' : 'blank-reply' };
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

// OTP code bot ko bhejo. Owner ki shikayat: "bot to OTP type hi nahi kar
// raha" — isliye yahan OTP bhejna kabhi skip nahi hota. Sirf ek hi soorat me
// nahi bhejte: bot saaf-saaf NUMBER ya NAAM maang raha ho (tab 6 digit jane
// ka matlab nahi).
//   return { ok, reason }
async function sendWorldCode(client, entity, code, cfg = {}) {
  const text = String(code || '').trim();
  const pollMs = Math.max(300, Number(cfg?.pollMs) || 1_500);
  if (!text) return { ok: false, reason: 'otp-empty' };

  // "OTP Sent" message parse hone me kabhi 1-2s lag jate hain — 4s tak dekho.
  let awaiting = '';
  let lookScreen = [];
  const lookUntil = Date.now() + 4_000;
  for (;;) {
    lookScreen = await parseScreenMessages(client, entity);
    awaiting = worldBotAwaitingKind(lookScreen);
    if (awaiting === 'otp' || awaiting === 'number' || awaiting === 'name') break;
    if (Date.now() >= lookUntil) break;
    await sleep(pollMs);
  }
  // 🛑 Bot ne login hi cancel kar diya / OTP bhejne se mana kar diya — OTP
  // type karna bekar hai (owner ke log: "📺 otp-type: ❌ Login Cancelled" ke
  // baad bhi OTP chala jata tha aur bot usko number samajh leta tha).
  const lookText = lookScreen.slice(0, 4).map((m) => m.text).join('\n');
  const lookBlocked = worldBotOtpBlockInfo(lookText);
  if (lookBlocked) {
    console.warn(`[WorldBot] OTP type nahi kiya — screen par ${lookBlocked.code}: ${lookBlocked.reason}`);
    return { ok: false, reason: `bot-${lookBlocked.code}` };
  }
  if (worldBotHasPromptKind(lookScreen.slice(0, 4), 'cancelled')) {
    console.warn('[WorldBot] OTP type nahi kiya — bot ne login cancel kar diya (Login Cancelled screen)');
    return { ok: false, reason: 'bot-login-cancelled' };
  }
  if (awaiting === 'number' || awaiting === 'name') {
    console.warn(`[WorldBot] OTP type nahi kiya — bot abhi ${awaiting} maang raha hai`);
    return { ok: false, reason: `bot-${awaiting}-maang-raha-hai` };
  }
  if (awaiting !== 'otp') {
    // Screen saaf/mixed hai — phir bhi OTP bhejte hain (ye hi asli kaam hai).
    console.warn('[WorldBot] OTP screen saaf nahi mili — phir bhi OTP bhej raha hoon');
  }

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      setPhase('otp-type');
      await sendWorldText(client, entity, text);
      console.log(`[WorldBot] ⌨️ OTP type kiya (try ${attempt})`);
    } catch (e) {
      console.warn(`[WorldBot] OTP send fail (try ${attempt}): ${e?.message || e}`);
      await sleep(1_200);
      continue;
    }
    // Bot ne OTP accept kiya? SIRF latest screen dekho — purana "OTP Sent"
    // message neeche pada rehta hai, usse "abhi bhi OTP maang raha hai" galat
    // samajh kar OTP do baar chala jata tha.
    const verifyUntil = Date.now() + 6_000;
    while (Date.now() < verifyUntil) {
      const recent = await parseScreenMessages(client, entity, 4);
      const kinds = recent.slice(0, 2).map((m) => worldBotPromptKind(m.text));
      if (kinds.includes('otpFail')) {
        console.warn('[WorldBot] bot ne OTP reject kiya — dobara try');
        break;
      }
      if (worldBotPromptKind(recent[0]?.text) !== 'otpSent') return { ok: true, reason: 'typed' };
      await sleep(pollMs);
    }
    if (attempt === 2) break;
  }
  return { ok: false, reason: 'otp-not-accepted' };
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
// 🔤 NAAM STEP (owner: "new account detected ke baad naam enter nahi hota aur
// uske baad /start chala jata hai")
//   • naam khali/invalid nikle to bot use accept hi nahi karta — pehle hum
//     seedha bhej dete the (kabhi khali string) aur 90s baad /start.
//   • bot naam reject kare ("Invalid name" / "Name must be 3-20 letters" /
//     "already taken") to agla naam try hota hai, /start nahi.
//   • naam confirm maange (Yes/Cancel) to Yes dabta hai.
// ---------------------------------------------------------------------------
export function worldBotNameCandidates(primary = '', phone = '') {
  const clean = (v) => String(v || '').replace(/[^A-Za-z]/g, '').slice(0, 20);
  const out = [];
  const push = (v) => {
    const c = clean(v);
    if (c.length >= 3 && c.length <= 20 && !out.includes(c)) out.push(c);
  };
  // 1) jo bhi pipeline ne diya (phone ke pehle 5 digit → a-i, 0 → x)
  push(primary);
  const digits = String(phone || '').replace(/\D/g, '').slice(-10);
  const map = { 0: 'x', 1: 'a', 2: 'b', 3: 'c', 4: 'd', 5: 'e', 6: 'f', 7: 'g', 8: 'h', 9: 'i' };
  const letters = (from, to) => [...digits.slice(from, to)].map((d) => map[d] || '').join('');
  if (digits.length >= 10) {
    push(letters(0, 5));
    push(letters(5, 10));
    push(letters(2, 7));
  }
  push(`${clean(primary)}a`);
  push('abcde');
  return out.slice(0, 4);
}

export const _worldBotNameCandidatesForTests = (primary, phone) => worldBotNameCandidates(primary, phone);

// Naam ke baad bot ka jawab: JSON / document / Copy button / naam reject /
// naam confirm (Yes) — sab yahan handle hote hain.
function nameStepPredicate(freshList) {
  for (const message of freshList) {
    if (message.hasDocument) return { kind: 'document', message };
    const json = extractWorldBotJson(message.text);
    if (json) return { kind: 'json', message, json };
    const kind = worldBotPromptKind(message.text);
    if (kind === 'otpFail') return { kind: 'otpFail', message };
    // ⚠️ Confirm button pehle: bot "Naam confirm karo? ✅ Yes / ❌ Cancel"
    // poochhta hai — is text me "naam" hai, isliye pehle askAgain maan liya jata
    // tha aur Yes kabhi nahi dabta tha.
    const yes = pickWorldBotConfirmButton(message.buttons || []);
    if (yes) return { kind: 'confirm', entry: { button: yes?.button || yes, text: String(yes?.text || yes?.button?.text || 'Yes') }, message };
    if (kind === 'nameFail') return { kind: 'nameFail', message };
    if (kind === 'askName') return { kind: 'askAgain', message };
    if (pickWorldBotButton(message.buttons, 'copyCode')) return { kind: 'copy', message };
  }
  return null;
}

// 🔎 JSON recovery — naam/login ke baad JSON ka message miss ho jaye (flood /
// blank read) to yahan se nikalta hai: Copy button, phir aakhri 15 messages,
// phir 12s ka intezaar. Pehle seedha `no-json`/timeout ho kar /start chala jata tha.
async function recoverWorldBotJson({ client, entity, cfg = {}, shouldAbort = null }) {
  const copied = await clickCopyCode({ client, entity, cfg, shouldAbort }).catch(() => null);
  const fromCopy = copied?.json?.text
    || (copied?.message ? await downloadJsonFromMessage(client, copied.message).catch(() => '') : '');
  if (fromCopy && isValidWorldSessionJson(fromCopy)) return { jsonText: fromCopy, via: 'copy-code' };

  const screen = await parseScreenMessages(client, entity, 15, { fresh: true }).catch(() => []);
  for (const message of screen) {
    const json = extractWorldBotJson(message.text);
    if (json && isValidWorldSessionJson(json.text)) return { jsonText: json.text, via: 'screen' };
    if (message.hasDocument) {
      const body = await downloadJsonFromMessage(client, message).catch(() => '');
      if (body && isValidWorldSessionJson(body)) return { jsonText: body, via: 'document' };
    }
  }

  const baseline = screenSignature(screen);
  const late = await waitForReply({
    client, entity, baseline, timeoutMs: 12_000, shouldAbort, what: 'JSON (recovery)', graceMs: 0,
    predicate: (freshList) => {
      for (const message of freshList) {
        const json = extractWorldBotJson(message.text);
        if (json) return json;
      }
      return null;
    },
    pollMs: cfg?.pollMs,
  }).catch(() => null);
  if (late?.text && isValidWorldSessionJson(late.text)) return { jsonText: late.text, via: 'late' };
  return { jsonText: '', via: '' };
}

// Naam bhejo + bot ka jawab sambhalo. Return: { ok, name, final } ya
// { ok:false, kind, reason }.
async function submitWorldBotName({ client, entity, cfg = {}, shouldAbort = null, nameProvider = null, phone = '' }) {
  let primary = '';
  try {
    primary = String((await nameProvider?.()) || '');
  } catch (e) {
    console.warn(`[WorldBot] ⚠️ nameProvider fail: ${String(e?.message || e).slice(0, 90)}`);
  }
  const names = worldBotNameCandidates(primary, phone || state.phone);
  if (!names.length) {
    return { ok: false, kind: 'name_rejected', reason: 'Naam ban hi nahi paya (nameProvider khali/invalid)' };
  }
  let baseline = screenSignature(await parseScreenMessages(client, entity).catch(() => []));
  for (let i = 0; i < names.length; i += 1) {
    const name = names[i];
    setPhase('send-name');
    try {
      await sendWorldText(client, entity, name);
    } catch (e) {
      console.warn(`[WorldBot] naam send fail (${name}): ${String(e?.message || e).slice(0, 90)}`);
      await sleep(1_200);
      continue;
    }
    state.lastTypedText = name;
    state.lastTypedAt = Date.now();
    console.log(`[WorldBot] ⌨️ naam type kiya (try ${i + 1}/${names.length}): ${name}`);
    const res = await waitForReply({
      client, entity, baseline, timeoutMs: cfg.stepTimeoutMs, shouldAbort,
      what: `JSON (naam ${name} ke baad)`,
      graceMs: Number(cfg.lateReplyGraceMs) || 60_000,
      predicate: nameStepPredicate,
      pollMs: cfg.pollMs,
    }).catch((e) => {
      if (e?.code === 'aborted') throw e;
      console.warn(`[WorldBot] naam ke baad jawab nahi (${name}): ${String(e?.message || e).slice(0, 140)}`);
      return { kind: 'timeout' };
    });

    if (res?.kind === 'json' || res?.kind === 'document' || res?.kind === 'copy') return { ok: true, name, final: res };
    if (res?.kind === 'otpFail') return { ok: false, kind: 'otpFail', name, final: res };

    if (res?.kind === 'confirm') {
      setPhase('name-confirm');
      console.log(`[WorldBot] 🖱 naam confirm: "${res.entry.text}"`);
      baseline = screenSignature(await parseScreenMessages(client, entity).catch(() => []));
      await clickWorldButton(res.entry).catch((e) => console.warn(`[WorldBot] naam confirm click: ${String(e?.message || e).slice(0, 80)}`));
      const after = await waitForReply({
        client, entity, baseline, timeoutMs: cfg.stepTimeoutMs, shouldAbort,
        what: 'JSON (naam confirm ke baad)', graceMs: Number(cfg.lateReplyGraceMs) || 60_000,
        predicate: nameStepPredicate, pollMs: cfg.pollMs,
      }).catch(() => ({ kind: 'timeout' }));
      if (['json', 'document', 'copy'].includes(after?.kind)) return { ok: true, name, final: after };
      if (after?.kind === 'otpFail') return { ok: false, kind: 'otpFail', name, final: after };
      const recovered = await recoverWorldBotJson({ client, entity, cfg, shouldAbort }).catch(() => null);
      if (recovered?.jsonText) return { ok: true, name, final: { kind: 'json', json: { text: recovered.jsonText } } };
      return { ok: false, kind: 'no-json', name, reason: 'Naam confirm ke baad bhi JSON nahi aaya' };
    }

    if (res?.kind === 'askAgain' || res?.kind === 'nameFail') {
      console.warn(`[WorldBot] ❌ bot ne naam accept nahi kiya ("${name}", ${res.kind}) — agla naam try (naya number ya /start nahi)`);
      baseline = screenSignature(await parseScreenMessages(client, entity).catch(() => []));
      continue;
    }

    // timeout — naam shayad chala gaya par JSON late/miss hua: recovery try.
    const recovered = await recoverWorldBotJson({ client, entity, cfg, shouldAbort }).catch(() => null);
    if (recovered?.jsonText) return { ok: true, name, final: { kind: 'json', json: { text: recovered.jsonText } } };
    const nowScreen = await parseScreenMessages(client, entity, 4, { fresh: true }).catch(() => []);
    const asksAgain = worldBotHasPromptKind(nowScreen, 'askName') || worldBotHasPromptKind(nowScreen, 'nameFail');
    const latestInbound = nowScreen.find((m) => !m.out) || null;
    const guessName = latestInbound
      && worldBotLooksLikeNamePrompt(latestInbound.text, latestInbound.buttons);
    if (asksAgain || guessName) {
      if (!asksAgain) console.warn('[WorldBot] 🔤 naam dobara maanga lag raha hai (guess) — agla naam bhej raha hoon');
      baseline = screenSignature(nowScreen);
      continue;
    }
    return { ok: false, kind: 'no-json', name, reason: 'Naam type kar diya par bot ka JSON nahi aaya' };
  }
  return { ok: false, kind: 'name_rejected', reason: `Naam accept nahi hua (tries: ${names.join(', ')})` };
}

export const _submitWorldBotNameForTests = (opts) => submitWorldBotName(opts);

// ---------------------------------------------------------------------------
// BUTTON TRIGGER — pehle click; screen na badle to USI button ka POORA TEXT
// likh kar bhej do (owner ka rule). Do-guna trigger se bachne ke liye typing se
// pehle screen dobara padhi jati hai.
// ---------------------------------------------------------------------------
async function clickOrType({
  client, entity, entry, cfg, shouldAbort, what,
  predicate, baseline = null, timeoutMs = null, maxTypedTries = 3, settle = true,
  // lateReplyGraceMs: click ka jawab late aane ka intezaar. Chhote/optional
  // steps (jaise purana account dobara chunna) me 45s ka late scan waste hai —
  // wahan 0 de dete hain (owner: "faltu 45s mat baitho").
  graceMs,
}) {
  const total = Math.max(5_000, Number(timeoutMs) || Number(cfg?.stepTimeoutMs) || WORLD_BOT_DEFAULTS.stepTimeoutMs);
  const grace = Math.min(total, Math.max(3_000, Number(cfg?.clickGraceMs) || 4_000));
  // 🧘 Action se pehle bot ka pichla jawab poora aane do — warna command burst.
  // (settle:false = owner ka "turant dabao" case, jaise delete-success ke baad
  // Main Menu — wahan 1.5s quiet wait hi "late" ban raha tha.)
  const before = baseline || screenSignature(
    settle ? await settledScreen(client, entity, cfg) : await parseScreenMessages(client, entity)
  );
  const label = String(entry?.text || '').trim();
  // 🖱 Click ka callback (bot ka apna jawab) — callback aa gaya matlab bot ne
  // button process kar liya. Tab wahi text DOBARA likhna galat tha (owner ke
  // logs me "OTP Login" click + text dono jate the aur Swiggy
  // "login attempts exceeded" deta tha).
  let clickCallback = '';

  if (cfg?.trigger !== 'type') {
    try {
      clickCallback = (await clickWorldButton(entry)) || '';
      const hit = await waitForReply({
        client, entity, baseline: before, timeoutMs: grace, shouldAbort,
        what: `${what} (click)`, predicate, pollMs: cfg?.pollMs,
        graceMs: graceMs === undefined ? undefined : Number(graceMs) || 0,
      });
      state.lastTrigger = 'click';
      return hit;
    } catch (e) {
      if (e?.code === 'aborted') throw e;
      // 👀 Click ne screen badal di (bas predicate match nahi hua)? To TEXT
      // bilkul mat bhejo — warna "OTP Login" do baar chala jata hai.
      try {
        const afterClick = await parseScreenMessages(client, entity);
        if (screenSignature(afterClick) !== before) {
          console.log(`[WorldBot] click ne screen badal di ("${label || what}") — text trigger skip`);
          state.lastTrigger = 'click';
          const late = predicate ? predicate(freshMessages(afterClick, before), afterClick) : null;
          if (late) return late;
          return { clicked: true, screen: afterClick };
        }
      } catch {}
      if (clickCallback) {
        console.log(`[WorldBot] ✅ click ka callback aaya ("${clickCallback.slice(0, 60)}") — text trigger skip`);
        state.lastTrigger = 'click-callback';
        return { clicked: true, callback: clickCallback };
      }
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

  // 🛑 Owner ka log: bot pichle number ke OTP ka intezaar kar raha tha aur humne
  // "Login" / "OTP Login" text bhej diya → bot ne usi ko OTP/number samajh kar
  // "❌ Invalid OTP" / "❌ Invalid Mobile Number" diya. Isliye jis waqt bot
  // OTP/number/naam maang raha ho, button ka text bilkul nahi bhejte.
  try {
    const awaiting = worldBotAwaitingKind(await parseScreenMessages(client, entity));
    if (awaiting === 'otp') throw new WorldBotError('awaiting-otp', 'Bot OTP ka intezaar kar raha hai — button text nahi bhejunga (Invalid OTP se bachaav)');
    if (awaiting === 'number') throw new WorldBotError('awaiting-number', 'Bot number maang raha hai — button text nahi bhejunga');
    if (awaiting === 'name') throw new WorldBotError('awaiting-name', 'Bot naam maang raha hai — button text nahi bhejunga');
  } catch (e) {
    if (['awaiting-otp', 'awaiting-number', 'awaiting-name'].includes(String(e?.code || ''))) throw e;
  }

  // 📝 Type sirf jab click se screen na badli ho. Text: plain (bina emoji)
  // wala pehle — asli bot plain naam hi samajhta hai.
  const allVariants = worldButtonTypeVariants(label);
  const ordered = [allVariants[1], allVariants[0], ...allVariants.slice(2)].filter(Boolean);
  const variants = [...new Set(ordered)].slice(0, Math.max(1, Math.min(2, maxTypedTries + 0)) );
  let lastError = null;
  await settledScreen(client, entity, cfg).catch(() => {});
  for (const variant of variants) {
    // 🔁 Har variant se PEHLE dobara dekho: pehla variant kaam kar gaya ho to
    // agla text bot ke number/OTP field me chala jata tha ("Invalid Mobile
    // Number"). Predicate sach ho gaya ho to wahi return karo.
    try {
      const now = await parseScreenMessages(client, entity);
      const done = predicate ? predicate(freshMessages(now, before), now) : null;
      if (done) { state.lastTrigger = 'type-late'; return done; }
      const awaitingNow = worldBotAwaitingKind(now);
      if (awaitingNow === 'otp' || awaitingNow === 'number' || awaitingNow === 'name') {
        throw new WorldBotError(`awaiting-${awaitingNow}`, `Bot ab ${awaitingNow} par hai — "${variant}" bhejna khatarnak hai`);
      }
    } catch (e) {
      if (['awaiting-otp', 'awaiting-number', 'awaiting-name'].includes(String(e?.code || ''))) throw e;
    }
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
        client, entity, baseline: before,
        // Har variant ka apna chhota budget — 3 variant x 25s = 75s waste nahi.
        timeoutMs: Math.min(total, Math.max(5_000, grace)), shouldAbort,
        what: `${what} (typed "${variant}")`, predicate, pollMs: cfg?.pollMs,
      });
      state.lastTrigger = 'type';
      return hit;
    } catch (e) {
      if (e?.code === 'aborted') throw e;
      lastError = e;
      // Is variant ne screen badal di? Phir doosra variant mat bhejo.
      try {
        const afterType = await parseScreenMessages(client, entity);
        if (screenSignature(afterType) !== before) {
          const late = predicate ? predicate(freshMessages(afterType, before), afterType) : null;
          if (late) return late;
          return { typed: true, screen: afterType };
        }
      } catch {}
    }
  }
  throw lastError || new WorldBotError('no-button', `"${label || what}" ko click ya type se trigger nahi kar paya`);
}

async function safeCancel(client, entity, cfg = {}) {
  const waitMs = Math.min(1_800, Math.max(600, Number(cfg?.pollMs) || 1_500));
  const screens = await parseScreenMessages(client, entity);
  const cancelFromId = Number(screens[0]?.id) || 0;
  const awaiting = worldBotAwaitingKind(screens);
  const hit = findRoleOnScreens(screens, 'cancel');
  let did = false;
  if (hit) {
    try {
      await clickWorldButton(hit.button);
      did = true;
    } catch {
      // Click fail → "Cancel" text type karke bhi try (owner rule).
      await sendWorldText(client, entity, String(hit.button?.text || 'Cancel').trim()).catch(() => {});
      did = true;
    }
  } else if (awaiting === 'otp') {
    // Bot khud kehta hai: "Send /cancel to cancel." Pehle wahi shabd.
    await sendWorldText(client, entity, 'Cancel').catch(() => {});
    did = true;
  } else if (awaiting === 'number' || awaiting === 'name') {
    await sendWorldText(client, entity, '/cancel').catch(() => {});
    did = true;
  }
  // Bot ka jawab poora aane do ("Cancel" ka reply der se aata hai) — warna
  // turant /cancel bhi chala jata hai (command burst).
  await waitForScreenChange(client, entity, cfg, { fromId: cancelFromId, timeoutMs: 5_000 }).catch(() => {});
  await sleep(Math.min(waitMs, 400));
  // OTP prompt abhi bhi khada hai to bot ka bataya hua command bhejo.
  if (worldBotAwaitingKind(await parseScreenMessages(client, entity)) === 'otp') {
    await sendWorldText(client, entity, '/cancel').catch(() => {});
    await sleep(waitMs);
    did = true;
  }
  return did;
}

// Login shuru karne se pehle bot ko saaf menu par lao. Owner ke log me bot
// pichle number ke OTP par khada tha aur naya /start + Login usi me ghus kar
// "❌ Invalid OTP" de raha tha (aur number waste ho raha tha).
async function worldResetToMenu(client, entity, cfg = {}) {
  const screen = await settledScreen(client, entity, cfg).catch(() => parseScreenMessages(client, entity));
  const pending = worldBotAwaitingKind(screen);
  if (pending) {
    setPhase('reset-menu');
    console.log(`[WorldBot] 🧹 adhoora flow (${pending}) mila — pehle Cancel, phir Main Menu`);
    await safeCancel(client, entity, cfg).catch(() => {});
  }
  // 🏠 Owner ka rule: delete/question screen par "Main Menu" button ho to WAHI
  // dabao — `/start` nahi, seedha Login bhi nahi.
  let settled = await settledScreen(client, entity, cfg).catch(() => parseScreenMessages(client, entity));
  const menuHit = findRoleOnScreens(settled, 'mainMenu');
  if (menuHit && !roleOnLatest(settled, 'login')) {
    setPhase('main-menu');
    console.log(`[WorldBot] 🏠 "${menuHit.button.text}" dabaya — Main Menu par ja raha hoon`);
    await clickOrType({
      client, entity, entry: menuHit.button, cfg,
      what: 'Main Menu',
      timeoutMs: Math.min(20_000, Number(cfg?.stepTimeoutMs) || 20_000),
      predicate: (freshList, all) => roleOnLatest(freshList, 'login') || (all && roleOnLatest(all, 'login')) || null,
    }).catch((e) => console.warn(`[WorldBot] Main Menu click: ${e?.message || e}`));
    settled = await settledScreen(client, entity, cfg).catch(() => parseScreenMessages(client, entity));
  }
  // Bot pehle se saaf menu par hai to /start dobara mat bhejo (command burst).
  if (!worldBotAwaitingKind(settled) && roleOnLatest(settled, 'login')) {
    console.log('[WorldBot] ✅ menu pehle se saaf hai — /start skip');
    return true;
  }
  // ⛔ OWNER RULE: login/OTP/naam ke beech me /start BILKUL nahi — wo World Bot
  // ko reset karke `Invalid OTP` / `Invalid Mobile Number` deta hai. Owner ki
  // shikayat bhi yahi thi: "naam enter nahi hota aur baad me /start chala jata
  // hai". Ab /start sirf tab jab screen par koi button hi na ho aur bot kuch
  // maang bhi na raha ho (asli blank screen), ya `resetMode: 'menu-only'`.
  const pendingNow = worldBotAwaitingKind(settled);
  // Flow "chalu" hai agar bot kuch maang raha hai (naam/OTP/number) ya screen
  // par Cancel/Yes jaisa step-button hai. Aise me /start = reset = galat.
  const hasFlowButton = settled.some((m) => (m.buttons || [])
    .some((b) => String(b?.role || '') === 'cancel'));
  if (String(cfg?.resetMode || '') === 'menu-only' || pendingNow || hasFlowButton) {
    console.warn(`[WorldBot] ⛔ /start nahi bhej raha (${pendingNow ? `bot ${pendingNow} maang raha hai` : hasFlowButton ? 'screen par Cancel button hai (flow chalu)' : 'resetMode=menu-only'}) — Cancel/button se kaam karenge`);
    return false;
  }
  await sendWorldText(client, entity, '/start').catch(() => {});
  const after = await settledScreen(client, entity, cfg).catch(() => parseScreenMessages(client, entity));
  const left = worldBotAwaitingKind(after);
  if (left) console.warn(`[WorldBot] ⚠️ /start ke baad bhi bot ${left} par khada hai`);
  return !left;
}

// ---------------------------------------------------------------------------
// Delete purana account: Order Hub → account → Delete Account → account → OTP
// ---------------------------------------------------------------------------
export async function worldBotDeleteAccount({
  phone,
  otpProvider = null,
  otpWatermark = null,
  report = null,
  shouldAbort = null,
  config = worldBotConfig(),
} = {}) {
  const cfg = { ...worldBotConfig(), ...(config || {}) };
  const cleanPhone = normalizeWorldPhone(phone);
  resetWorldBotRunState();
  setPhase('delete-start');
  try {
    return await withWorldBotClient(async ({ client }) => {
      const entity = await getWorldEntity(client, cfg.username);

      // 0) 🏠 Transcript: login/JSON ke baad pehle Main Menu, phir Order Hub.
      // (Direct Order Hub dabane se JSON screen par wo button hi nahi hota
      // tha aur flow /start par chala jata tha.)
      setPhase('delete-main-menu');
      const menuForDelete = await worldResetToMenu(client, entity, cfg).catch(() => false);
      if (!menuForDelete) console.warn('[WorldBot] delete: Main Menu saaf nahi hua — Order Hub seedha try karunga');

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
      // 🔖 Delete OTP ka watermark delete trigger se thik pehle.
      let deleteWatermark = null;
      if (typeof otpWatermark === 'function') {
        try {
          deleteWatermark = await otpWatermark();
          console.log(`[WorldBot] 🔖 delete OTP watermark set (${cleanPhone})`);
        } catch (error) {
          console.warn(`[WorldBot] ⚠️ delete watermark fail: ${String(error?.message || error).slice(0, 90)}`);
        }
      }
      screen = await parseScreenMessages(client, entity);
      const deleteHit = findRoleOnScreens(screen, 'deleteAccount');
      if (!deleteHit) {
        return { ok: false, kind: 'delete_button_missing', phone: cleanPhone, reason: 'Delete Account button nahi mila — screen: ' + (state.lastScreenButtons.join(' | ') || 'none') };
      }
      before = screenSignature(screen);
      const deletePredicate = (freshList) => {
        for (const message of freshList) {
          const kind = worldBotPromptKind(message.text);
          // ⛔ "ye account delete nahi ho sakta (user charges present)" — 45s
          // wait ka koi matlab nahi, turant owner ka fallback flow.
          if (kind === 'deleteBlocked') return { kind: 'blocked', message };
          if (kind === 'deleteSent' || kind === 'askNumber' || kind === 'otpSent') return kind;
        }
        return null;
      };

      // ⛔ Delete blocked (charges/dues) → owner ka flow:
      //   Main Menu → Switch Account → woh ID → Permanently Log Out → naya number.
      const handleDeleteBlocked = async (message) => {
        const info = worldBotDeleteBlockedInfo(message?.text || '');
        console.warn(`[WorldBot] ⛔ delete blocked — ${info?.reason || 'charges/dues pending'}`);
        await reportCard(report, [
          '🌍 <b>World Bot — Delete Nahi Ho Sakta</b>',
          `📱 <code>${cleanPhone}</code>`,
          `⚠️ ${plain(info?.reason || 'Account delete nahi ho sakta').replace(/[<>&]/g, '')}`,
          '→ Main Menu → Switch Account → woh ID → Permanently Log Out, phir naya number.',
        ].join('\n'));
        setPhase('delete-blocked-cleanup');
        // 1) Main Menu (button ho to wahi; /start nahi)
        await worldResetToMenu(client, entity, cfg).catch(() => {});
        // 2) Switch Account → woh number → Permanently Log Out
        const out = await logoutAccountUnlocked(client, entity, cfg, cleanPhone, { shouldAbort })
          .catch((error) => ({ ok: false, reason: String(error?.message || error).slice(0, 120) }));
        console.log(`[WorldBot] 🔓 blocked account logout: ${out?.ok ? 'ho gaya' : `fail (${out?.reason || out?.kind})`}`);
        return {
          ok: false,
          kind: 'delete_blocked_charges',
          phone: cleanPhone,
          loggedOut: Boolean(out?.ok),
          code: 'DELETE_CHARGES',
          reason: `${info?.reason || 'Account delete nahi ho sakta (charges/dues)'}${out?.ok ? ' · bot se permanently log out kar diya' : ''}`,
          viaWorldBot: true,
        };
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
      if (deleteAck?.kind === 'blocked') return await handleDeleteBlocked(deleteAck.message);

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
          if (deleteAck?.kind === 'blocked') return await handleDeleteBlocked(deleteAck.message);
        }
      }

      // 4) Delete ka number/account dobara chuno — PAR sirf tab jab bot sach me
      // account list par ho. Pehle purane (window me pade) account button par bhi
      // click ho jata tha: bot ne delete OTP maang rakha hota tha aur hum usi
      // stale button ko dabate the → 45s ka late scan + galat click.
      setPhase('delete-confirm');
      screen = await parseScreenMessages(client, entity);
      const awaitingDeleteOtp = worldBotAwaitingKind(screen) === 'otp'
        || worldBotHasPromptKind(screen.slice(0, 2), 'deleteSent');
      const latestScreenMsg = screen.find((m) => !m.out) || null;
      const againBtn = awaitingDeleteOtp || !latestScreenMsg
        ? null
        : findWorldBotAccountButton(latestScreenMsg.buttons, cleanPhone);
      if (againBtn) {
        before = screenSignature(screen);
        const againAck = await clickOrType({
          client, entity, entry: againBtn, cfg, shouldAbort, baseline: before, timeoutMs: 12_000, graceMs: 3_000,
          what: 'delete account dobara chuno', predicate: deletePredicate,
        }).catch(() => null);
        if (againAck?.kind === 'blocked') return await handleDeleteBlocked(againAck.message);
        const blockedScreen = (await parseScreenMessages(client, entity).catch(() => []))
          .find((m) => worldBotDeleteBlockedInfo(m.text));
        if (blockedScreen) return await handleDeleteBlocked(blockedScreen);
      }

      // 5) Delete OTP
      setPhase('delete-otp-wait');
      await reportCard(report, [
        '🌍 <b>World Bot — Delete OTP Sent</b>',
        `📱 <code>${cleanPhone}</code> · OTP Firebase inbox se aa raha hai…`,
      ].join('\n'));
      if (typeof otpProvider !== 'function') throw new WorldBotError('no-otp-provider', 'Delete OTP provider missing');
      const otp = await otpProvider({ watermark: deleteWatermark, phone: cleanPhone });
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
            if (kind === 'deleteBlocked') return { kind: 'blocked', message };
            if (kind === 'deleted') return { kind: 'deleted', message };
            if (kind === 'otpFail') return { kind: 'otpFail', message };
          }
          return null;
        },
        // ⚡ Owner: "successful jaise hi ho delete ... turant Main Menu" —
        // isliye delete result ka poll tez (500ms), 1.5s ka gap nahi.
        pollMs: Math.min(500, Number(cfg.pollMs) || 500),
        // 🐢 Flood wait ke baad jawab late aata hai — timeout par ek dheemi
        // scan (90s) taaki delete ka asli jawab miss na ho.
        graceMs: Number(cfg.lateReplyGraceMs) || 90_000,
      });

      if (result.kind === 'blocked') return await handleDeleteBlocked(result.message);
      if (result.kind === 'otpFail') {
        return { ok: false, kind: 'delete_otp_rejected', phone: cleanPhone, reason: 'World Bot ne delete OTP accept nahi kiya' };
      }

      // 🏠 Owner: "successful jaise hi ho delete and bot response kare, usko
      // Main Menu bhejna hai" — koi settle-wait nahi. Jo screen delete-success
      // ke saath aayi hai usi ke button par TURANT click hota hai.
      //  1) usi screen par "🏠 Main Menu" ho → seedha wahi
      //  2) warna "Haan 💜" (bot se remove) confirm → phir Main Menu
      setPhase('delete-main-menu');
      let atMenu = Boolean(roleOnLatest([result.message], 'login'));
      let menuHit = findRoleOnScreens([result.message], 'mainMenu');

      if (!menuHit) {
        const confirm = pickWorldBotConfirmButton(result.message?.buttons || []);
        if (confirm) {
          setPhase('delete-remove-confirm');
          console.log(`[WorldBot] 🖱 delete success → "${confirm.text}" (bot se remove)`);
          await clickOrType({
            client, entity, entry: confirm, cfg, shouldAbort, timeoutMs: 12_000, settle: false,
            what: 'delete remove confirm',
            predicate: (fresh) => (fresh && fresh.length ? true : null),
          }).catch(() => {});
          const afterConfirm = await parseScreenMessages(client, entity).catch(() => []);
          menuHit = findRoleOnScreens(afterConfirm, 'mainMenu');
          atMenu = Boolean(roleOnLatest(afterConfirm, 'login'));
        }
      }

      if (menuHit) {
        console.log(`[WorldBot] 🏠 delete success → "${menuHit.button.text}" dabaya — Main Menu`);
        const ack = await clickOrType({
          client, entity, entry: menuHit.button, cfg, shouldAbort, settle: false,
          what: 'Main Menu (delete ke baad)',
          timeoutMs: Math.min(15_000, Number(cfg?.stepTimeoutMs) || 15_000),
          predicate: (freshList, all) => roleOnLatest(freshList, 'login') || roleOnLatest(all, 'login') || null,
        }).catch((e) => {
          console.warn(`[WorldBot] Main Menu click: ${e?.message || e}`);
          return null;
        });
        if (ack) atMenu = true;
        if (!atMenu) {
          atMenu = Boolean(roleOnLatest(await parseScreenMessages(client, entity).catch(() => []), 'login'));
        }
      } else if (!atMenu) {
        console.log('[WorldBot] ℹ️ delete screen par Main Menu button nahi mila — Login button ka intezaar');
      }

      state.lastOkAt = Date.now();
      setPhase('delete-done');
      console.log(`[WorldBot] 🗑 Account deleted: ${cleanPhone}${atMenu ? ' · Main Menu ready' : ''}`);
      return { ok: true, kind: 'deleted', phone: cleanPhone, atMenu, viaWorldBot: true };
    });
  } catch (error) {
    setError(error);
    const category = classifyWorldBotError(error);
    console.warn(`[WorldBot] delete fail (${cleanPhone}) [${category}]: ${error?.message || error}`);
    const kind = category === 'aborted'
      ? 'aborted'
      : category === 'worldbot_setup'
        ? 'worldbot_setup'
        : category === 'worldbot_offline'
          ? 'worldbot_offline'
          : category === 'bot_unreachable'
            ? 'bot_unreachable'
            // ⏱ Delete ka jawab window me nahi aaya (flood wait) — iska matlab
            // "delete blocked" NAHI. Pipeline wahi number se state check karke
            // aage badhti hai; number skip nahi hota.
            : error?.code === 'worldbot-timeout'
              ? 'delete_result_timeout'
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
// Switch Accounts → woh number → Permanently Logged Out.
// Owner ka rule: purge screen par pehle **Main Menu**, phir Switch Account →
// woh ID → Permanently Log Out. Har step sirf LATEST screen se padha jata hai
// (purane account-menu ke stale buttons click karne se flow bhatak jata tha),
// aur har click ke baad bot ke naye jawab ka intezaar hota hai.
async function logoutAccountUnlocked(client, entity, cfg, cleanPhone, { shouldAbort = null } = {}) {
  const step = Math.max(600, Number(cfg?.pollMs) || 1_200);
  const latest = async (n = 3) => (await parseScreenMessages(client, entity).catch(() => [])).slice(0, n);
  const accountBtn = (msgs = []) => {
    // Sirf naye screens — window me pada purana account button dobara dabana
    // galat step par le jata tha (owner: "wahi menu dobara mat dabao").
    const latest = (msgs || []).find((m) => !m.out) || null;
    const fromLatest = latest ? findWorldBotAccountButton(latest.buttons, cleanPhone) : null;
    if (fromLatest) return fromLatest;
    for (const message of (msgs || []).slice(0, 2)) {
      if (message.out) continue;
      const btn = findWorldBotAccountButton(message.buttons, cleanPhone);
      if (btn) return btn;
    }
    return null;
  };
  const waitFor = async (finder, timeoutMs = 15_000) => {
    const deadline = Date.now() + Math.max(1_000, Number(timeoutMs) || 15_000);
    for (;;) {
      if (typeof shouldAbort === 'function' && shouldAbort()) return null;
      const hit = finder(await latest());
      if (hit) return hit;
      if (Date.now() >= deadline) return null;
      await sleep(step);
    }
  };
  const clickBtn = async (entry, predicate, what, timeoutMs = 15_000) => {
    const before = screenSignature(await parseScreenMessages(client, entity).catch(() => []));
    return clickOrType({ client, entity, entry, cfg, shouldAbort, baseline: before, what, predicate, timeoutMs })
      .catch((error) => {
        console.warn(`[WorldBot] ${what}: ${String(error?.message || error).slice(0, 80)}`);
        return null;
      });
  };

  setPhase('logout-start');

  // 🏠 Owner: "then click switch account …" — Switch Accounts sirf Main Menu
  // par hota hai. Login ke turant baad bot JSON screen par khada hota hai,
  // isliye pehle menu par aao (button se; /start sirf khali screen par).
  await worldResetToMenu(client, entity, cfg).catch(() => {});

  // 🏠 Owner: "main menu bhejega then switch account and select that id and
  // permanently log out". Menu par hi Switch Accounts ho to seedha wahi.
  let switched = false;
  const switchAndPick = async (entry, label) => {
    if (!entry) return;
    const beforeId = Number((await latest(1))[0]?.id) || 0;
    await clickBtn(entry.button || entry, (fresh, all) => accountBtn(fresh) || accountBtn(all) || null, label);
    // ⚠️ Sirf NAYE screen ka account button — purane Order Hub wala stale
    // button click karne se bot wapas account menu par chala jata tha.
    const inList = await waitFor((msgs) => accountBtn(msgs.filter((m) => Number(m.id) > beforeId)), 12_000);
    if (inList) await clickBtn(inList, (fresh) => roleOnLatest(fresh, 'permanentLogout'), 'logout: switch list me account');
    switched = true;
  };

  // ① Owner ka naya flow sabse pehle: Main Menu → "Switch Account" → wahi
  // logged-in account → Permanent Logout → Yes.
  const menuSwitch = await waitFor((msgs) => roleOnLatest(msgs, 'switchAccounts'), 1_500);
  if (menuSwitch) await switchAndPick(menuSwitch, 'logout: Switch Accounts (Main Menu)');

  // ② Transcript wala doosra rasta: Main Menu → Swiggy Accounts → number →
  // account menu (wahan Permanent Logout hota hai).
  const accountsTab = switched ? null : await waitFor((msgs) => roleOnLatest(msgs, 'swiggyAccounts'), 1_500);
  if (accountsTab) {
    const beforeId = Number((await latest(1))[0]?.id) || 0;
    await clickBtn(accountsTab.button, (fresh, all) => accountBtn(fresh) || accountBtn(all) || null, 'logout: Swiggy Accounts');
    const listed = await waitFor((msgs) => accountBtn(msgs.filter((m) => Number(m.id) > beforeId))
      || accountBtn(msgs), 12_000);
    if (listed) {
      await clickBtn(listed, (fresh) => roleOnLatest(fresh, 'permanentLogout')
        || roleOnLatest(fresh, 'switchAccounts') || roleOnLatest(fresh, 'deleteAccount'),
      'logout: Swiggy Accounts me account');
      switched = true;
    }
  }

  // 1) Account list — Order Hub se (menu par "Switch Accounts" nahi hota).
  let acct = switched ? null : await waitFor((msgs) => accountBtn(msgs), 2_000);
  if (!acct && !switched) {
    await clickRole(client, entity, 'orderHub', { cfg, shouldAbort, what: 'Order Hub (logout)' }).catch(() => {});
    acct = await waitFor((msgs) => accountBtn(msgs), 18_000);
  }
  if (!acct && !switched) {
    return { ok: false, kind: 'logout_account_not_listed', phone: cleanPhone, reason: 'Account list me number nahi mila' };
  }

  // 2) Woh account → account menu
  if (acct) {
    await clickBtn(acct, (fresh) => roleOnLatest(fresh, 'switchAccounts')
      || roleOnLatest(fresh, 'deleteAccount') || roleOnLatest(fresh, 'permanentLogout'), 'logout: account chuno');
  }

  // 3) Switch Accounts (account menu par) → phir list me wahi number
  if (!switched) {
    const switchHit = await waitFor((msgs) => roleOnLatest(msgs, 'switchAccounts'), 4_000);
    if (switchHit) await switchAndPick(switchHit, 'logout: Switch Accounts');
  }

  // 4) Permanently Logged Out
  const logoutHit = await waitFor((msgs) => roleOnLatest(msgs, 'permanentLogout'), 15_000);
  if (!logoutHit) return { ok: false, kind: 'logout_button_missing', phone: cleanPhone, reason: 'Permanently Logged Out button nahi mila' };

  const logoutClickId = Number((await latest(1))[0]?.id) || 0;
  await clickBtn(logoutHit.button, (fresh) => (fresh && fresh.length ? true : null), 'Permanently Logged Out');

  // ✅ Owner: logout par bot DO confirmation maangta hai —
  //   1) "konsa account" (account button)
  //   2) "Yes / Cancel"  →  YES dabana hai (Cancel kabhi nahi).
  const loggedOutRe = /(logged\s*out|log\s*out\s*(success|ho)|successfully\s*log)/i;
  let confirms = 0;
  let sawLoggedOut = false;
  for (let round = 1; round <= 4; round += 1) {
    const prompt = await waitFor((msgs) => {
      const fresh = msgs.filter((m) => Number(m.id) > logoutClickId);
      for (const message of fresh) {
        if (loggedOutRe.test(String(message.text || ''))) { sawLoggedOut = true; return null; }
      }
      for (const message of fresh) {
        const yes = pickWorldBotConfirmButton(message.buttons || []);
        if (yes) return { kind: 'yes', entry: yes, message };
        const acct = findWorldBotAccountButton(message.buttons || [], cleanPhone);
        if (acct) return { kind: 'account', entry: acct, message };
      }
      if (sawLoggedOut) return null;
      return null;
    }, round === 1 ? 12_000 : 6_000);
    if (sawLoggedOut || !prompt) break;
    confirms += 1;
    setPhase(`logout-confirm-${confirms}`);
    console.log(`[WorldBot] ✅ logout confirmation ${confirms}${prompt.kind === 'account' ? ' (account)' : ''}: "${prompt.entry.text}" dabaya`);
    await clickBtn(prompt.entry, (fresh) => (fresh && fresh.length ? true : null), `logout confirm ${confirms}`, 12_000);
    await sleep(step);
  }

  state.lastOkAt = Date.now();
  setPhase('logout-done');
  const okOut = sawLoggedOut || confirms >= 2;
  console.log(`[WorldBot] 🚪 ${cleanPhone} — Permanently Logged Out${confirms ? ` (${confirms} confirmation)` : ''}${okOut ? '' : ' ⚠️ confirm nahi mila'}`);
  return {
    ok: okOut,
    kind: okOut ? 'logged_out' : 'logout_not_confirmed',
    phone: cleanPhone,
    confirms,
    reason: okOut ? '' : 'logout confirmation (Yes) nahi aaya — account shayad abhi bhi logged-in hai',
  };
}

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
    return await withWorldBotClient(async ({ client }) => {
      const entity = await getWorldEntity(client, cfg.username);
      return await logoutAccountUnlocked(client, entity, cfg, cleanPhone, { shouldAbort });
    });
  } catch (error) {
    setError(error);
    const category = classifyWorldBotError(error);
    return {
      ok: false,
      kind: category === 'aborted'
        ? 'aborted'
        : category === 'bot_unreachable'
          ? 'bot_unreachable'
          : category === 'worldbot_offline'
            ? 'worldbot_offline'
            : 'logout_failed',
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
    return await withWorldBotClient(async ({ client }) => {
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
