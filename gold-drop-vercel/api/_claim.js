// 🎯 Claim bot runner — @rajafuckbot (ya koi bhi bot) se "Manual Claim" flow.
//
// User ka bataya flow, bilkul wahi:
//   1. bot ko /start
//   2. "Manual Claim" button dabao (bot khud bhejta hai, ya inline button)
//   3. bot number maange → OTP bot se liya number bhejo
//   4. bot 3 baar OTP maangta hai → yahi OTP (OTP bot ka) 3 baar bhejo
//   5. hone par "Manual Claim" dobara aaye to wahi cycle naye number se dohrao
//
// Har step DOM-less nahi hai — yahan button clicks + messages asli MTProto se
// jaate hain. Poora transcript (bot ka reply, button dabaya, error) card ke
// mirror me dikhta hai, isliye "kya hua" chhup nahi sakta.

import { getClient, hydrateSlot, sessionFor, apiFor, parseMirrorMessage } from './_otp-mirror.js';

const CLAIM_TTL_MS = 10 * 60 * 1000;
const runs = new Map(); // runId → run

// Bot ke button labels — screenshots ke hisaab se: "🎯 MANUAL CLAIM (3x)".
// Dhyaan: sirf "claim" par match nahi karte, warna galat button dab sakta hai.
const MANUAL_CLAIM_RE = /manual\s*claim|manual\s*claim\s*\(\d+x\)|manual\b/i;
const OTP_RE = /(?:otp|code|verification|verify)/i;

function newRun(slot, bot, target, details) {
  return {
    id: Math.random().toString(36).slice(2, 10),
    slot, bot, target: Math.max(1, Number(target) || 1),
    done: 0, phase: 'starting', step: 0, message: '', numbers: [],
    transcript: [], results: [], startedAt: Date.now(), updatedAt: Date.now(), error: '',
    ...details,
  };
}

function note(run, text, kind = 'log') {
  run.transcript.push({ at: new Date().toISOString(), kind, text: String(text).slice(0, 400) });
  if (run.transcript.length > 60) run.transcript.splice(0, run.transcript.length - 60);
  run.updatedAt = Date.now();
}

function publicRun(run) {
  if (!run) return null;
  return {
    id: run.id, slot: run.slot, bot: run.bot, target: run.target, done: run.done,
    phase: run.phase, step: run.step, message: run.message,
    numbers: run.numbers.slice(-10), transcript: run.transcript.slice(-25),
    results: run.results, error: run.error,
    running: run.running, startedAt: run.startedAt, updatedAt: run.updatedAt,
  };
}

export function getClaimRun(id) {
  return publicRun(runs.get(String(id)));
}

export function latestClaimRun(slot) {
  let latest = null;
  for (const run of runs.values()) {
    if (slot !== undefined && run.slot !== Number(slot)) continue;
    if (!latest || run.startedAt > latest.startedAt) latest = run;
  }
  return publicRun(latest);
}

function cleanup() {
  const cut = Date.now() - CLAIM_TTL_MS;
  for (const [id, run] of runs) if (run.updatedAt < cut) runs.delete(id);
}

// ─── bot chat helpers ───
async function botMessages(client, bot, limit = 6) {
  try {
    const msgs = await client.getMessages(bot, { limit });
    return (msgs || []).filter(m => String(m?.message || '').trim() || m?.replyMarkup);
  } catch {
    return [];
  }
}

function lastBotMessage(msgs = []) {
  // Bot ke messages (out = humne bheja), latest pehle.
  return msgs.find(m => !m.out) || msgs[0] || null;
}

function buttonsOf(message) {
  const rows = message?.replyMarkup?.rows || message?.buttons || [];
  const flat = [];
  for (const row of rows) {
    const rowButtons = row?.buttons || (Array.isArray(row) ? row : []);
    for (const btn of rowButtons) flat.push(btn);
  }
  return flat;
}

function buttonText(btn) {
  if (!btn) return '';
  if (typeof btn === 'string') return btn;
  try { return String(btn.text ?? btn.button?.text ?? ''); } catch { return ''; }
}

async function clickButton(client, btn, label) {
  try {
    if (typeof btn?.click === 'function') return await btn.click();
    const found = btn?.button || btn;
    if (typeof found?.click === 'function') return await found.click();
  } catch (error) {
    throw new Error(`Button "${label}" dabaya par error: ${String(error?.message || error).slice(0, 120)}`);
  }
  throw new Error(`Button "${label}" click nahi hua (teleproto ka click support nahi)`);
}

// "🎯 MANUAL CLAIM (3x)" jaisa button dhoondo — latest messages me, purane par atko nahi.
// Zyada se zyada 8 messages peeche tak dekhte hain (bot ka menu + cancel card).
function matchManualClaim(msgs = []) {
  for (const msg of msgs) {
    if (msg?.out) continue;
    const buttons = buttonsOf(msg);
    const btn = buttons.find(b => MANUAL_CLAIM_RE.test(buttonText(b)));
    if (btn) return { msg, btn, label: buttonText(btn) };
  }
  return null;
}

// Naya message aane ka intezaar — naya id ya naya text.
async function waitForBot(client, bot, { afterId = 0, afterText = '', timeoutMs = 25000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1500);
    const msgs = await botMessages(client, bot, 5);
    const latest = msgs.find(m => !m.out) || null;
    if (!latest) continue;
    const id = Number(latest.id || 0);
    const text = String(latest.message || '');
    if ((afterId && id > afterId) || (text && text !== afterText)) return latest;
  }
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function sendText(client, bot, text) {
  await client.sendMessage(bot, { message: String(text) });
}

// ─── main flow ───
// details: { apiId, apiHash, session } — card me bhare hue; env fallback.
export async function startClaimRun({ slot = 0, bot = 'rajafuckbot', target = 1, details = {} } = {}) {
  cleanup();
  const botName = String(bot || 'rajafuckbot').replace(/^@/, '');
  const run = newRun(slot, botName, target, details);
  runs.set(run.id, run);

  (async () => {
    run.running = true;
    try {
      await hydrateSlot(slot);
      if (details.session || details.apiId || details.apiHash) {
        const { setSlotCredentials } = await import('./_otp-mirror.js');
        await setSlotCredentials({ slot, session: details.session, apiId: details.apiId, apiHash: details.apiHash });
      }
      let useSlot = slot;
      if (!apiFor(slot).apiId || !apiFor(slot).apiHash || !sessionFor(slot)) {
        // Is card ka account adhoora — koi bhi ready account use kar lo.
        const ready = [0, 1, 2].find(s => apiFor(s).apiId && apiFor(s).apiHash && sessionFor(s));
        if (ready === undefined) {
          throw new Error('Koi bhi Telegram account ready nahi — pehle left card me API ID, hash aur OTP se session bharo');
        }
        useSlot = ready;
        note(run, `Account #${slot + 1} adhoora hai — Account #${ready + 1} se chalaya ja raha hai`, 'warn');
      }
      run.accountSlot = useSlot;
      const client = await getClient(useSlot);
      note(run, `Account #${useSlot + 1} jud gaya — @${botName} ko /start bhej raha hoon`, 'ok');
      run.phase = 'start';

      // Purane messages ki id yaad rakho — /start ka NAYA jawab hi dekhna hai.
      const beforeStart = await botMessages(client, botName, 8);
      const newestBefore = Math.max(0, ...beforeStart.map(m => Number(m?.id || 0)));
      await sendText(client, botName, '/start');
      let latest = await waitForBot(client, botName, { afterId: newestBefore, timeoutMs: 30000 });
      if (!latest) {
        const any = await botMessages(client, botName, 5);
        latest = any.find(m => !m.out) || null;
      }
      if (!latest) throw new Error(`@${botName} ne /start par jawab nahi diya (bot block/username galat ho sakta hai)`);
      note(run, `Bot: ${String(latest.message || '(buttons)').slice(0, 200)}`, 'bot');

      let started = false;
      while (run.done < run.target) {
        run.phase = 'manual_claim';
        // "🎯 MANUAL CLAIM (3x)" button — sabhi recent bot messages me dhoondo.
        let hit = null;
        let last = latest;
        for (let attempt = 0; attempt < 3 && !hit; attempt += 1) {
          const all = await botMessages(client, botName, 8);
          hit = matchManualClaim(all);
          if (hit) { last = hit.msg; break; }
          // /start ka menu hi nahi mila to ek hi baar /start dobara — bar-bar nahi
          // (har /start claim cancel karta hai, screenshots me wahi dikha).
          if (attempt === 0 && !started) {
            const snap = Math.max(0, ...all.map(m => Number(m?.id || 0)));
            await sendText(client, botName, '/start');
            note(run, '/start dobara bheja — menu ka intezaar', 'click');
            const fresh = await waitForBot(client, botName, { afterId: snap, timeoutMs: 25000 });
            if (fresh) { latest = fresh; last = fresh; }
            continue;
          }
          await sleep(2500);
        }
        if (!hit) {
          if (run.done >= 1) break;   // target poora — agla claim nahi chahiye
          const seen = (await botMessages(client, botName, 5))
            .filter(m => !m.out)
            .map(m => `• ${String(m.message || '(buttons)').slice(0, 60)} [${buttonsOf(m).map(buttonText).filter(Boolean).slice(0, 4).join(' | ') || 'koi button nahi'}]`)
            .join('\n');
          throw new Error(`Bot me "Manual Claim" button nahi mila. Bot ke aakhri messages:\n${seen || '(kuch nahi)'}`);
        }
        started = true;
        {
          const beforeId = Number(hit.msg.id || 0);
          await clickButton(client, hit.btn, hit.label);
          note(run, `Button dabaya: ${hit.label}`, 'click');
          latest = await waitForBot(client, botName, { afterId: beforeId, timeoutMs: 30000 }) || latest;
          note(run, `Bot: ${String(latest.message || '(buttons)').slice(0, 200)}`, 'bot');
        }

        // Number maango
        run.phase = 'number';
        const number = await waitForNumber(run);
        if (!number) throw new Error('Number nahi mila — OTP bot me naya number dabao, phir "Number bhejo" dabao');
        run.numbers.push(number);
        note(run, `Number bheja: ${number}`, 'ok');
        const beforeId = Number(latest.id || 0);
        await sendText(client, botName, number);
        latest = await waitForBot(client, botName, { afterId: beforeId, timeoutMs: 25000 }) || latest;
        note(run, `Bot: ${String(latest.message || '(buttons)').slice(0, 200)}`, 'bot');

        // 3 baar OTP
        run.phase = 'otp';
        const otps = [];
        for (let i = 0; i < 3; i += 1) {
          run.step = i + 1;
          run.message = `OTP ${i + 1}/3 ka wait (OTP bot se)…`;
          const code = await waitForOtp(run, i, {
            baseId: Number(latest.id || 0),
            // Bot ne hamare bhejne ke baad phir kuch bheja = wahi OTP dobara maang raha hai.
            botAskedAgain: async () => {
              const msgs = await botMessages(client, botName, 4);
              const lastBot = msgs.find(m => !m.out);
              return Number(lastBot?.id || 0) > Number(latest.id || 0);
            },
          });
          if (!code) {
            note(run, `OTP ${i + 1}/3 nahi mila — agla number`, 'warn');
            break;
          }
          const prevId = Number(latest.id || 0);
          await sendText(client, botName, code);
          otps.push(code);
          note(run, `OTP ${i + 1}/3 bheja: ${code}`, 'ok');
          latest = await waitForBot(client, botName, { afterId: prevId, timeoutMs: 25000 }) || latest;
          note(run, `Bot: ${String(latest.message || '(buttons)').slice(0, 200)}`, 'bot');
        }

        run.done += 1;
        run.results.push({ number, otps, botReply: String(latest.message || '').slice(0, 200), at: new Date().toISOString() });
        run.message = `${run.done}/${run.target} claim ho gaya`;
        note(run, `✅ ${number} claim — ${run.done}/${run.target}`, 'ok');
        run.step = 0;
        if (run.done >= run.target) break;
        run.phase = 'next_number';
        run.message = 'Agla number bhejo (Manual Claim dobara aaye to wahi karo)';
        if (!(MANUAL_CLAIM_RE.test(String(latest.message || '')) || buttonsOf(latest).some(b => MANUAL_CLAIM_RE.test(buttonText(b))))) {
          run.phase = 'manual_claim';
        }
      }
      run.phase = 'done';
      run.message = `${run.done} claim poore hue`;
      note(run, `🎯 Poore ${run.done}/${run.target} claims`, 'ok');
    } catch (error) {
      run.error = String(error?.message || error).slice(0, 240);
      run.phase = 'error';
      run.message = run.error;
      note(run, `❌ ${run.error}`, 'error');
    } finally {
      run.running = false;
      run.updatedAt = Date.now();
    }
  })();

  return publicRun(run);
}

// ─── user input queue (number / otp) ───
const inputs = new Map(); // runId → { numbers: [], otps: [], numberWaiters: [], otpWaiters: [] }

function queueFor(id) {
  if (!inputs.has(id)) inputs.set(id, { numbers: [], otps: [] });
  return inputs.get(id);
}

export function pushClaimNumber(runId, number) {
  const run = runs.get(String(runId));
  if (!run) return { ok: false, error: 'Run nahi mila — pehle START karo' };
  const clean = String(number).replace(/\D/g, '').slice(-10);
  if (!/^[6-9]\d{9}$/.test(clean)) return { ok: false, error: 'Valid 10-digit number daalo' };
  const q = queueFor(run.id);
  q.numbers.push(clean);
  return { ok: true, queued: clean };
}

export function pushClaimOtp(runId, otp) {
  const run = runs.get(String(runId));
  if (!run) return { ok: false, error: 'Run nahi mila — pehle START karo' };
  const clean = String(otp).replace(/\D/g, '');
  if (!/^\d{4,8}$/.test(clean)) return { ok: false, error: 'OTP 4-8 digit ka hota hai' };
  const q = queueFor(run.id);
  q.otps.push(clean);
  return { ok: true, queued: clean };
}

// OTP bot ke mirror se value — user ne jo bheja wo pehle, warna mirror se auto.
async function mirrorValue(run, key) {
  try {
    const { readOtpBotMirror } = await import('./_otp-mirror.js');
    const mirror = await readOtpBotMirror({ slot: run.accountSlot ?? run.slot, limit: 3 });
    const parsed = parseMirrorMessage(mirror?.messages?.[0]?.text || '');
    return parsed[key] || '';
  } catch {
    return '';
  }
}

async function waitForNumber(run) {
  const q = queueFor(run.id);
  const deadline = Date.now() + 120000; // 2 min — user OTP bot se number laata hai
  const seen = new Set(run.numbers);
  while (Date.now() < deadline) {
    if (q.numbers.length) return q.numbers.shift();
    // Mirror me naya number aaya? Khud utha lo (mirror ka faayda).
    const auto = await mirrorValue(run, 'phone');
    if (auto && !seen.has(auto)) {
      note(run, `Number mirror se mila: ${auto}`, 'ok');
      return auto;
    }
    run.message = 'Number ka wait… (OTP bot me NEW NUMBER dabao — mirror se khud aa jayega)';
    run.updatedAt = Date.now();
    await sleep(2000);
  }
  return '';
}

async function waitForOtp(run, index, { botAskedAgain } = {}) {
  const q = queueFor(run.id);
  const deadline = Date.now() + 120000;
  let lastAuto = '';
  let reused = 0;
  while (Date.now() < deadline) {
    if (q.otps.length) return q.otps.shift();
    // OTP bot ka code mirror me hai. Wahi code 3 baar maanga jaata hai — isliye
    // agar bot ne hamare bhejne ke baad phir maanga hai to same OTP phir bhejo.
    const auto = await mirrorValue(run, 'otp');
    const sent = run.sentOtps || [];
    const fresh = auto && !sent.includes(auto);
    const sameButAskedAgain = auto && !fresh && reused < 2 && typeof botAskedAgain === 'function'
      && (await botAskedAgain().catch(() => false));
    if (auto && (fresh || (auto !== lastAuto && sameButAskedAgain))) {
      lastAuto = auto;
      if (fresh) run.sentOtps = [...sent, auto];
      else { reused += 1; note(run, `Wahi OTP dobara maanga gaya — ${auto} phir bheja`, 'warn'); }
      note(run, `OTP mirror se mila: ${auto}`, 'ok');
      return auto;
    }
    run.message = `OTP ${index + 1}/3 ka wait… (OTP bot ka code — mirror se khud aa jayega)`;
    run.updatedAt = Date.now();
    await sleep(2000);
  }
  return '';
}

// OTP bot ke mirror se aaya latest code seedha queue me daal do (auto-fill).
export function autoFeedFromMirror(runId, mirror) {
  const run = runs.get(String(runId));
  if (!run || !mirror?.ok) return false;
  const parsed = parseMirrorMessage((mirror.messages?.[0]?.text) || '');
  if (parsed.otp) pushClaimOtp(run.id, parsed.otp);
  return true;
}
