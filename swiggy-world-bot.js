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

// Har step ka default budget. Bot slow ho to Settings/env se badhaya ja sakta
// hai (SWIGGY_WORLD_STEP_TIMEOUT_MS) — batch isi ke andar recover karta hai.
export const WORLD_BOT_DEFAULTS = {
  stepTimeoutMs: 45_000,
  pollMs: 1_500,
  startTimeoutMs: 25_000,
  readLimit: 15,
  otpTimeoutMs: 90_000,
};

const state = {
  phase: 'idle',
  lastAction: '',
  lastError: '',
  lastScreenText: '',
  lastScreenButtons: [],
  lastChatAt: 0,
  lastOkAt: 0,
  step: 0,
  username: '',
  phone: '',
};

export function getWorldBotStatus() {
  return {
    ...state,
    lastScreenButtons: [...(state.lastScreenButtons || [])],
  };
}

function setPhase(phase, extra = {}) {
  state.phase = phase;
  state.lastChatAt = Date.now();
  Object.assign(state, extra);
}

function setError(error) {
  state.lastError = String(error?.message || error || '').slice(0, 240);
}

export function worldBotUsername(env = process.env) {
  const raw = String(
    env?.SWIGGY_WORLD_BOT_USERNAME
    || env?.SWIGGY_WORLD_BOT
    || env?.WORLD_BOT_USERNAME
    || WORLD_BOT_USERNAME_DEFAULT
  ).trim().replace(/^@+/, '');
  return raw || WORLD_BOT_USERNAME_DEFAULT;
}

export function worldBotConfig(env = process.env) {
  const num = (key, dflt, min = 250) => {
    const n = Number(env?.[key]);
    return Number.isFinite(n) && n >= min ? n : dflt;
  };
  return {
    username: worldBotUsername(env),
    stepTimeoutMs: num('SWIGGY_WORLD_STEP_TIMEOUT_MS', WORLD_BOT_DEFAULTS.stepTimeoutMs),
    pollMs: num('SWIGGY_WORLD_POLL_MS', WORLD_BOT_DEFAULTS.pollMs, 300),
    otpTimeoutMs: num('SWIGGY_WORLD_OTP_TIMEOUT_MS', WORLD_BOT_DEFAULTS.otpTimeoutMs, 5_000),
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
  if (/\b(json|tid)\b/.test(n)) return 'jsonLogin';
  if (/\botp\b/.test(n) && /\blogin\b/.test(n)) return 'otpLogin';
  if (/\b(order\s*hub|orders?)\b/.test(n) && !/\bmy\s*orders\b/.test(n)) return 'orderHub';
  if (/\bdelete\b/.test(n) && /\baccount\b/.test(n)) return 'deleteAccount';
  if (/\bswitch\s*accounts?\b/.test(n)) return 'switchAccounts';
  if (/\bpermanent\w*\b/.test(n) && /\blog|out\b/.test(n)) return 'permanentLogout';
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
  if (/\b(otp was not accepted|invalid otp|otp galat|wrong otp)\b/.test(n)) return 'otpFail';
  if (/\b(invalid mobile|invalid number|number galat)\b/.test(n)) return 'invalidNumber';
  if (/\b(otp sent|otp bhej|send the 6 digit otp)\b/.test(n)) return 'otpSent';
  if (/\b(send|enter|type)\b/.test(n) && /\b(name|naam)\b/.test(n)) return 'askName';
  if (/\b(send|enter|type)\b/.test(n) && /\b(10 digit|10-digit|mobile|number)\b/.test(n)) return 'askNumber';
  if (/\b(account deleted)\b/.test(n)) return 'deleted';
  return '';
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
  const messages = await client.getMessages(entity, { limit: Math.max(1, Number(limit) || 10) });
  const arr = Array.isArray(messages) ? messages : [...(messages || [])];
  return arr;
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
  await client.sendMessage(entity, { message: String(text) });
  state.lastAction = `send:${String(text).slice(0, 24)}`;
  state.lastChatAt = Date.now();
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

async function clickRole(client, entity, role, { cfg, shouldAbort, what } = {}) {
  const hit = await ensureWorldScreen(client, entity, role, { cfg, shouldAbort, what });
  if (!hit) throw new WorldBotError('no-button', `"${role}" button nahi mila — screen: ${state.lastScreenButtons.join(' | ') || 'none'}`);
  await clickWorldButton(hit.button);
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

      // 2) 🔐 Login → method picker
      setPhase('login-menu');
      before = screenSignature(await parseScreenMessages(client, entity));
      const loginHit = findRoleOnScreens(await parseScreenMessages(client, entity), 'login');
      if (!loginHit) throw new WorldBotError('no-login-button', `Login button nahi mila — screen: ${(state.lastScreenButtons || []).join(' | ') || 'none'}`);
      await clickWorldButton(loginHit.button);
      await waitForReply({
        client, entity, baseline: before, timeoutMs: cfg.stepTimeoutMs, shouldAbort,
        what: 'login method screen',
        predicate: (freshList, all) => findRoleOnScreens([...freshList, ...all], 'otpLogin'),
        pollMs: cfg.pollMs,
      });

      // 3) 📲 OTP Login → number maango
      setPhase('otp-login');
      before = screenSignature(await parseScreenMessages(client, entity));
      const otpBtn = findRoleOnScreens(await parseScreenMessages(client, entity), 'otpLogin');
      if (!otpBtn) throw new WorldBotError('no-otp-login', 'OTP Login button nahi mila');
      await clickWorldButton(otpBtn.button);

      // 4) number bhejo
      setPhase('send-number');
      const numberPrompt = await waitForReply({
        client, entity, baseline: before, timeoutMs: cfg.stepTimeoutMs, shouldAbort,
        what: 'number prompt',
        predicate: (freshList, all) => {
          const allText = [...freshList, ...all].map((m) => m.text).join('\n');
          return worldBotPromptKind(allText) === 'askNumber' ? true : null;
        },
        pollMs: cfg.pollMs,
      }).then(() => true).catch(() => true); // prompt na mile to bhi number bhej do

      await reportCard(report, [
        '🌍 <b>Swiggy World Bot — OTP Login</b>',
        `📱 <b>Number:</b> <code>${cleanPhone}</code>`,
        '→ /start → Login → OTP Login ho gaya, ab number bhej raha hoon…',
      ].join('\n'));
      void numberPrompt;

      before = screenSignature(await parseScreenMessages(client, entity));
      await sendWorldText(client, entity, cleanPhone);

      const numberResult = await waitForReply({
        client, entity, baseline: before, timeoutMs: cfg.stepTimeoutMs, shouldAbort,
        what: 'OTP sent confirmation',
        predicate: (freshList) => {
          for (const message of freshList) {
            const kind = worldBotPromptKind(message.text);
            if (kind === 'otpSent') return { kind: 'otpSent', message };
            if (kind === 'invalidNumber') return { kind: 'invalidNumber', message };
          }
          return null;
        },
        pollMs: cfg.pollMs,
      });
      if (numberResult.kind === 'invalidNumber') {
        await safeCancel(client, entity, cfg).catch(() => {});
        return { ok: false, kind: 'failed_invalid_number', phone: cleanPhone, reason: 'Swiggy World Bot ne number invalid bataya' };
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

      setPhase('otp-verify');
      before = screenSignature(await parseScreenMessages(client, entity));
      await sendWorldText(client, entity, String(otp.code).trim());

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
      if (!jsonText) throw new WorldBotError('no-json', 'Login ho gaya par JSON na mila (neither file nor code block)');

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
    console.warn(`[WorldBot] login fail (${cleanPhone}): ${error?.message || error}`);
    return {
      ok: false,
      kind: error?.code === 'aborted' ? 'aborted' : 'failed_world_bot',
      phone: cleanPhone,
      reason: String(error?.message || error).slice(0, 220),
      code: error?.code || 'worldbot-error',
    };
  }
}

async function safeCancel(client, entity, cfg = {}) {
  const hit = findRoleOnScreens(await parseScreenMessages(client, entity), 'cancel');
  if (!hit) return false;
  await clickWorldButton(hit.button);
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
        return { ok: false, kind: 'delete_account_not_listed', phone: cleanPhone, reason: 'Order Hub me ye number listed nahi mila' };
      }
      before = screenSignature(screen);
      await clickWorldButton(accountBtn);
      await waitForReply({
        client, entity, baseline: before, timeoutMs: cfg.stepTimeoutMs, shouldAbort,
        what: 'account menu (Delete Account)',
        predicate: (freshList, all) => findRoleOnScreens([...freshList, ...all], 'deleteAccount'),
        pollMs: cfg.pollMs,
      }).catch(() => {});

      // 3) Delete Account
      setPhase('delete-click');
      screen = await parseScreenMessages(client, entity);
      const deleteHit = findRoleOnScreens(screen, 'deleteAccount');
      if (!deleteHit) {
        return { ok: false, kind: 'delete_button_missing', phone: cleanPhone, reason: 'Delete Account button nahi mila — screen: ' + (state.lastScreenButtons.join(' | ') || 'none') };
      }
      before = screenSignature(screen);
      await clickWorldButton(deleteHit.button);
      await waitForReply({
        client, entity, baseline: before, timeoutMs: cfg.stepTimeoutMs, shouldAbort,
        what: 'Delete OTP Sent',
        predicate: (freshList) => {
          for (const message of freshList) {
            const kind = worldBotPromptKind(message.text);
            if (kind === 'deleteSent' || kind === 'askNumber' || kind === 'otpSent') return kind;
          }
          return null;
        },
        pollMs: cfg.pollMs,
      }).catch(() => {});

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
        await clickWorldButton(againBtn);
        await sleep(Math.min(2_000, cfg.pollMs * 2));
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
      before = screenSignature(await parseScreenMessages(client, entity));
      await sendWorldText(client, entity, String(otp.code).trim());

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
          await clickWorldButton(confirm);
          await sleep(Math.min(1_500, cfg.pollMs));
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
    console.warn(`[WorldBot] delete fail (${cleanPhone}): ${error?.message || error}`);
    return {
      ok: false,
      kind: error?.code === 'aborted' ? 'aborted' : 'delete_failed',
      phone: cleanPhone,
      reason: String(error?.message || error).slice(0, 220),
      code: error?.code || 'worldbot-error',
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
        await clickWorldButton(switchHit.button);
      }
      await waitForReply({
        client, entity, baseline: before, timeoutMs: Math.min(20_000, cfg.stepTimeoutMs), shouldAbort,
        what: 'account switcher',
        predicate: (freshList, all) => [...freshList, ...all].some((m) => findWorldBotAccountButton(m.buttons, cleanPhone)) ? true : null,
        pollMs: cfg.pollMs,
      }).catch(() => {});

      let screen = await parseScreenMessages(client, entity);
      let accountBtn = null;
      for (const message of screen) {
        const btn = findWorldBotAccountButton(message.buttons, cleanPhone);
        if (btn) { accountBtn = btn; break; }
      }
      if (!accountBtn) return { ok: false, kind: 'logout_account_not_listed', phone: cleanPhone, reason: 'Switch Accounts me number nahi mila' };
      await clickWorldButton(accountBtn);
      await sleep(cfg.pollMs);

      screen = await parseScreenMessages(client, entity);
      const logoutHit = findRoleOnScreens(screen, 'permanentLogout');
      if (!logoutHit) return { ok: false, kind: 'logout_button_missing', phone: cleanPhone, reason: 'Permanently Logged Out button nahi mila' };
      await clickWorldButton(logoutHit.button);
      state.lastOkAt = Date.now();
      setPhase('logout-done');
      return { ok: true, kind: 'logged_out', phone: cleanPhone };
    });
  } catch (error) {
    setError(error);
    return { ok: false, kind: 'logout_failed', phone: cleanPhone, reason: String(error?.message || error).slice(0, 200) };
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
