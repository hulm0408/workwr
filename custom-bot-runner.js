// ===== 🎓 CUSTOM BOT RUNNER — trained steps ko chalata hai =====
//
// custom-bots.js  → WHAT to do (steps + routines, db me save)
// ye file        → HOW chalegi (MTProto message/button/OTP/card)
//
// Design: `executeRoutine(steps, io, ctx)` PURE-ish hai — network `io` ke
// through hoti hai. Production me `buildTelegramIo(client)` teleproto io
// banata hai; unit tests apni fake io bhejte hain (koi network nahi).
//
// Isliye telegram-otp-source.js me sirf 2 hooks + 2 exports add hote hain.

import {
  getCustomBot,
  normalizeCustomUsername,
} from './custom-bots.js';
import {
  parseTelegramNumberCard,
  parseTelegramOtpMessage,
  telegramMessageId,
  telegramMessageText,
  withTelegramUserClient,
} from './telegram-otp-source.js';
import { otpBotNormalizeText, otpBotSearchText } from './otp-bot-profiles.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

// ---------------------------------------------------------------------------
// Text matching — `re:` prefix = regex (raw text par, case-insensitive),
// warna small-caps/emoji-insensitive SUBSTRING match (owner kaise bhi likhe).
// ---------------------------------------------------------------------------
export function matchCustomText(text = '', pattern = '') {
  const pat = String(pattern ?? '').trim();
  if (!pat) return false;
  const raw = String(text ?? '').slice(0, 4000);
  if (/^re:/i.test(pat)) {
    try {
      return new RegExp(pat.slice(3), 'i').test(otpBotNormalizeText(raw));
    } catch { return false; }
  }
  const hay = otpBotSearchText(raw);
  const needle = otpBotSearchText(pat);
  return Boolean(needle) && hay.includes(needle);
}

function buttonTextOf(button) {
  try { return String(button?.text || button?.button?.text || ''); } catch { return ''; }
}

async function readButtonsOf(message) {
  let rows;
  try { rows = message?.buttons; } catch {}
  if (!rows) {
    try {
      rows = typeof message?.getButtons === 'function' ? await message.getButtons() : null;
    } catch {}
  }
  if (!rows) rows = message?._buttons || (message?._buttonsFlat ? [message._buttonsFlat] : []);
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => (Array.isArray(row) ? row : [row])).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Fresh card/OTP scan — sirf routine shuru HONE KE BAAD aayi cheezein count
// hoti hain (baselineMaxId), warana purana card "naya" ban jata tha.
// ---------------------------------------------------------------------------
export function findFreshCard(messages = [], { baselineMaxId = 0, excludePhones = new Set() } = {}) {
  for (const message of Array.isArray(messages) ? messages : []) {
    const id = telegramMessageId(message);
    if (baselineMaxId > 0 && id > 0 && id <= baselineMaxId) continue;
    const card = parseTelegramNumberCard(telegramMessageText(message));
    if (!card?.phone) continue;
    if (excludePhones?.has?.(card.phone)) continue;
    return { card, message };
  }
  return null;
}

export function findFreshOtp(messages = [], { baselineMaxId = 0, phone = '' } = {}) {
  const wanted = String(phone || '').replace(/\D/g, '').slice(-10);
  for (const message of Array.isArray(messages) ? messages : []) {
    const id = telegramMessageId(message);
    if (baselineMaxId > 0 && id > 0 && id <= baselineMaxId) continue;
    const parsed = parseTelegramOtpMessage(wanted, message);
    if (!parsed?.code) continue;
    if (wanted && parsed.phone && parsed.phone !== wanted) continue;
    return { code: parsed.code, message, parsed };
  }
  return null;
}

// ---------------------------------------------------------------------------
// executeRoutine — steps ko order me chalata hai.
//   ctx: { bot, phone, excludePhones, baselineMaxId, timeoutMs, shouldAbort, wantCard }
//   return: { ok, steps:[log], card?, message?, code?, switchedTo?, error? }
// ---------------------------------------------------------------------------
export async function executeRoutine(steps, io, ctx = {}) {
  const bot = ctx.bot || {};
  const starterBot = String(bot.username || '').replace(/^@+/, '');
  const wantedPhone = String(ctx.phone || '').replace(/\D/g, '').slice(-10);
  const exclude = ctx.excludePhones instanceof Set
    ? ctx.excludePhones
    : new Set([...(ctx.excludePhones || [])].map((p) => String(p || '').replace(/\D/g, '').slice(-10)).filter(Boolean));
  const timeoutMs = Math.max(1_000, Number(ctx.timeoutMs) || 20_000);
  const deadline = Date.now() + timeoutMs;
  const shouldAbort = typeof ctx.shouldAbort === 'function' ? ctx.shouldAbort : () => false;
  const baselineMaxId = Math.max(0, Number(ctx.baselineMaxId) || 0);
  const log = [];
  const push = (index, step, status, detail = '') => {
    log.push({
      index: index + 1,
      kind: step?.kind || '?',
      status,           // 'ok' | 'skip' | 'fail'
      detail: String(detail || '').slice(0, 220),
    });
  };

  const fail = (error, extra = {}) => ({ ok: false, error: String(error || 'unknown error'), steps: log, ...extra });
  let currentBot = starterBot;
  const remaining = () => Math.max(0, deadline - Date.now());
  const list = Array.isArray(steps) ? steps : [];

  for (let index = 0; index < list.length; index += 1) {
    if (remaining() <= 0) return fail('Time budget khatam ho gaya — steps pura nahi ho paya.');
    if (shouldAbort()) return fail('Batch stop ho gaya.');
    const step = list[index];

    // ⏱ `when` — agar latest response me ye text NAHI hai to step SKIP.
    if (step.when?.match) {
      let matched = false;
      try {
        const screen = await io.latestScreen(currentBot);
        matched = matchCustomText(screen?.text || '', step.when.match)
          || (screen?.buttons || []).some((b) => matchCustomText(buttonTextOf(b.button || b), step.when.match));
      } catch (error) {
        push(index, step, 'fail', `screen read fail: ${String(error?.message || error).slice(0, 80)}`);
        return fail(`Step ${index + 1} (${step.kind}): response read nahi ho paya — ${String(error?.message || error).slice(0, 80)}`);
      }
      if (!matched) {
        push(index, step, 'skip', `response me "${step.when.match}" nahi tha — step chhoda`);
        continue;
      }
    }

    try {
      switch (step.kind) {
        case 'send_text': {
          await io.sendText(currentBot, step.text);
          push(index, step, 'ok', `"${step.text}" bheja`);
          break;
        }
        case 'wait': {
          const ms = Math.max(100, Math.min(Math.min(30_000, remaining()), Number(step.ms) || 1000));
          await sleep(ms);
          push(index, step, 'ok', `${ms}ms wait`);
          break;
        }
        case 'switch_bot': {
          const next = normalizeCustomUsername(step.username);
          if (!next) throw new Error('switch_bot username invalid');
          await io.probe(next); // galat/ private bot ho to yahin throw
          currentBot = next;
          push(index, step, 'ok', `ab baat hogi @${next} se`);
          break;
        }
        case 'click_button': {
          const screen = await io.latestScreen(currentBot);
          const buttons = screen?.buttons || [];
          let chosen = null;
          for (const entry of buttons) {
            const text = buttonTextOf(entry.button || entry);
            if (matchCustomText(text, step.match)) { chosen = { ...entry, text }; break; }
          }
          let clicked = false;
          let clickError = '';
          if (chosen) {
            try {
              const answer = await io.clickButton(chosen.button || chosen);
              const callback = String(answer?.message || '').trim();
              clicked = true;
              push(index, step, 'ok', `"${chosen.text}" click kiya${callback ? ` — bot: ${callback.slice(0, 90)}` : ''}`);
            } catch (error) {
              clickError = String(error?.message || error).slice(0, 80);
            }
          }
          if (!clicked) {
            if (step.typeIfMissing) {
              // Click-then-type fallback (world bot wala rule) — typeText
              // explicitly set ho to wahi; warna match string.
              const typeText = String(step.typeText || step.match);
              await io.sendText(currentBot, typeText);
              push(index, step, 'ok', `"${typeText}" type kiya${chosen ? ` (click fail: ${clickError})` : ' (button nahi mila)'}`);
            } else {
              const reason = chosen ? `click fail: ${clickError}` : `button "${step.match}" nahi mila`;
              push(index, step, 'fail', reason);
              if (step.onFail === 'continue') break;
              return fail(`Step ${index + 1}: ${reason}`);
            }
          }
          break;
        }
        case 'expect_number': {
          // Bot ke jawab ka wait karo — sirf baseline ke BAAD ki card chalegi.
          const pollDeadline = Math.min(deadline, Date.now() + 15_000);
          let found = null;
          while (Date.now() < pollDeadline) {
            if (shouldAbort()) return fail('Batch stop ho gaya.');
            const messages = await io.fetchMessages(currentBot, 20);
            found = findFreshCard(messages, { baselineMaxId, excludePhones: exclude });
            if (found) break;
            await sleep(700);
          }
          if (!found) {
            push(index, step, 'fail', 'naya number card nahi aaya');
            if (step.onFail === 'continue') break;
            return fail('Number card nahi mila (training ke hisaab se).');
          }
          push(index, step, 'ok', `Number card mila: ${found.card.phone}`);
          return { ok: true, routine: 'claim', steps: log, card: found.card, message: found.message, switchedTo: currentBot !== starterBot ? currentBot : '' };
        }
        case 'expect_otp': {
          const pollDeadline = Math.min(deadline, Date.now() + 15_000);
          let found = null;
          while (Date.now() < pollDeadline) {
            if (shouldAbort()) return fail('Batch stop ho gaya.');
            const messages = await io.fetchMessages(currentBot, 20);
            found = findFreshOtp(messages, { baselineMaxId, phone: wantedPhone });
            if (found) break;
            await sleep(700);
          }
          if (!found) {
            push(index, step, 'fail', 'naya OTP message nahi aaya');
            if (step.onFail === 'continue') break;
            return fail('OTP nahi mila (training ke hisaab se).');
          }
          push(index, step, 'ok', `OTP mila (${found.code.length}-digit)`);
          return { ok: true, routine: 'refresh', steps: log, code: found.code, message: found.message, switchedTo: currentBot !== starterBot ? currentBot : '' };
        }
        default:
          push(index, step, 'skip', 'unknown step kind — chhoda');
      }
    } catch (error) {
      const message = String(error?.message || error).slice(0, 140);
      push(index, step, 'fail', message);
      if (step.onFail === 'continue') continue;
      return fail(`Step ${index + 1} (${step.kind}): ${message}`);
    }
  }

  // Routine khatam — agar claim me expect_number nahi tha, ek chhota
  // best-effort card scan (owner se ye expect kiya jata hai, par safety net).
  if (ctx.wantCard && !list.some((s) => s.kind === 'expect_number')) {
    const scanDeadline = Math.min(deadline, Date.now() + 4_000);
    while (Date.now() < scanDeadline) {
      const messages = await io.fetchMessages(currentBot, 20).catch(() => []);
      const found = findFreshCard(messages, { baselineMaxId, excludePhones: exclude });
      if (found) {
        log.push({ index: list.length, kind: 'expect_number', status: 'ok', detail: `auto-scan: card ${found.card.phone}` });
        return { ok: true, routine: 'claim', steps: log, card: found.card, message: found.message, switchedTo: currentBot !== starterBot ? currentBot : '' };
      }
      await sleep(700);
    }
    return fail('Claim steps hue, par number card nahi mila (expect_number step add karo).');
  }
  return { ok: true, routine: ctx.routine || '', steps: log, switchedTo: currentBot !== starterBot ? currentBot : '' };
}

// ---------------------------------------------------------------------------
// Production io — teleproto client se (spare Telegram account).
// ---------------------------------------------------------------------------
export function buildTelegramIo(client) {
  if (!client) throw new Error('Telegram client missing');
  const cache = new Map();
  const resolve = async (username) => {
    const key = String(username || '').replace(/^@+/, '').toLowerCase();
    if (!/^[a-z0-9_]{5,32}$/i.test(key)) throw new Error(`Bot username galat: ${key || '(khali)'}`);
    if (!cache.has(key)) cache.set(key, await client.getEntity(`@${key}`));
    return cache.get(key);
  };
  const fetchMessages = async (username, limit = 12) => {
    const entity = await resolve(username);
    const messages = await client.getMessages(entity, { limit: Math.max(1, Number(limit) || 12) });
    const arr = Array.isArray(messages) ? messages : [...(messages || [])];
    return arr.filter((m) => {
      if (!m || typeof m !== 'object') return false;
      if (typeof m.out === 'boolean') return !m.out;
      return true;
    });
  };
  const io = {
    probe: resolve,
    fetchMessages,
    maxIncomingId: async (username) => telegramMessageId((await fetchMessages(username, 1))[0]) || 0,
    latestText: async (username) => telegramMessageText((await fetchMessages(username, 1))[0]),
    // text/id/buttons — HAMESHA newest message se ONLY. Purane button-screen
    // kabhi click nahi hongi (owner ka pakka rule: stale NEW NUMBER = burned
    // number + claim-stuck). Newest message me buttons na hon to click steps
    // apna type-fallback chalate hain.
    latestScreen: async (username) => {
      const list = await fetchMessages(username, 6);
      const newest = list[0] || null;
      const rawButtons = newest ? await readButtonsOf(newest) : [];
      const buttons = rawButtons.map((button) => ({ button, text: buttonTextOf(button) })).filter((b) => b.text);
      return {
        message: newest,
        text: telegramMessageText(newest),
        id: telegramMessageId(newest),
        buttons,
      };
    },
    sendText: async (username, text) => {
      const entity = await resolve(username);
      await client.sendMessage(entity, { message: String(text) });
    },
    clickButton: async (button) => button?.click?.({}),
  };
  return io;
}

function baselineOf(io, username) {
  return io.maxIncomingId(username).catch(() => 0);
}

function botFor(botId) {
  const bot = getCustomBot(botId);
  if (!bot) throw new Error('Custom bot nahi mila (delete ho gaya?). Train Bots list se check karo.');
  return bot;
}

// ---------------------------------------------------------------------------
// Claim/Refresh — telegram-otp-source.js inhe inject hota; direct import
// nahi (cycle se bachne ke liye).
// ---------------------------------------------------------------------------
export async function runCustomClaim({ client = null, botId = '', timeoutMs = 20_000, excludePhones = new Set(), shouldAbort = null } = {}) {
  const bot = botFor(botId);
  const steps = bot.routines?.claim || [];
  if (!steps.length) return { ok: false, error: `"${bot.name}" ki CLAIM training khali hai — Settings → Train Custom Bot se steps add karo.` };
  const runner = async (activeClient) => {
    const io = buildTelegramIo(activeClient);
    const baselineMaxId = await baselineOf(io, bot.username);
    return executeRoutine(steps, io, {
      bot, phone: '', excludePhones, baselineMaxId, timeoutMs,
      shouldAbort, wantCard: true, routine: 'claim',
    });
  };
  if (client) return runner(client);
  return withTelegramUserClient(({ client: c }) => runner(c));
}

export async function runCustomRefresh({ client = null, botId = '', phone = '', attempt = 0, timeoutMs = 12_000, shouldAbort = null } = {}) {
  const bot = botFor(botId);
  const steps = bot.routines?.refresh || [];
  if (!steps.length) return { ok: false, error: `"${bot.name}" ki REFRESH training khali hai — Settings → Train Custom Bot se steps add karo.` };
  const runner = async (activeClient) => {
    const io = buildTelegramIo(activeClient);
    const baselineMaxId = await baselineOf(io, bot.username);
    return executeRoutine(steps, io, {
      bot, phone, excludePhones: new Set(), baselineMaxId, timeoutMs,
      shouldAbort, wantCard: false, routine: 'refresh',
    });
  };
  if (client) return runner(client);
  return withTelegramUserClient(({ client: c }) => runner(c));
}

// Owner ka "🧪 Test" — live spare account se routine chalao, har step ka
// result wapas do. (OTP code chat me dikhega — wahi test ka maksad hai.)
export async function testCustomBotRoutine({ botId = '', routine = 'claim', phone = '', timeoutMs = 25_000 } = {}) {
  const bot = botFor(botId);
  if (!['claim', 'refresh'].includes(routine)) return { ok: false, error: 'Routine galat hai.' };
  const steps = bot.routines?.[routine] || [];
  if (!steps.length) return { ok: false, error: `${routine === 'claim' ? 'CLAIM' : 'REFRESH'} training khali hai — pehle steps add karo.` };
  return withTelegramUserClient(async ({ client }) => {
    const io = buildTelegramIo(client);
    const baselineMaxId = await baselineOf(io, bot.username);
    const wantCard = routine === 'claim';
    return executeRoutine(steps, io, {
      bot, phone, excludePhones: new Set(), baselineMaxId, timeoutMs,
      shouldAbort: null, wantCard, routine,
    });
  });
}
