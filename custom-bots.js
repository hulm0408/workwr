// ===== 🎓 CUSTOM BOT TRAINING — owner apna OTP/SMS bot "train" kare =====
//
// Owner ka naya rule:
//   "kisi bot ko add karna ho and uski training karni ho ki ye message
//    bhejna hai then tujhe ye response mile to ye likh kar bhejna hai
//    agar ye response mile to is bot par jana hai refresh button dabana hai
//    ya find number dabana hai — jo bhi trained hai uska BUTTON chahiye"
//
// Model: har custom bot ki DO routines hoti hain —
//   • claim   → number kaise lena hai (START → buttons → card)
//   • refresh → OTP check kaise karna hai (REFRESH / VIEW MESSAGES…)
//
// Har routine STEPS ki list hai (max 12). Har step ka ek `when` condition
// ho sakta hai ("agar latest response me ye text ho TABHI ye step chale")
// — wahi "agar ye response mile to…" wala hissa hai.
//
// YE FILE PURE HAI (network nahi) — sirf db.json (data/customBots ke andar)
// me persist karti hai. Asli MTProto run custom-bot-runner.js karta hai.
// Tests isi file ko network ke baghair exercise karte hain.

import crypto from 'node:crypto';
import { getDb, saveDb } from './store.js';
import { registerOtpBotProfileProvider } from './otp-bot-profiles.js';

export const CUSTOM_BOTS_KEY = 'customBots';
export const MAX_CUSTOM_BOTS = 30;
export const MAX_STEPS_PER_ROUTINE = 12;
export const MAX_TEXT_LEN = 300;
export const MAX_MATCH_LEN = 80;
export const MAX_NAME_LEN = 40;

const CUSTOM_ID_RE = /^custom_[a-z0-9]{6,24}$/;
const USERNAME_RE = /^[A-Za-z0-9_]{5,32}$/;

export const ROUTINES = ['claim', 'refresh'];
export const ROUTINE_META = {
  claim:   { icon: '📋', label: 'Claim training',   desc: 'Number kaise lena hai (START → buttons → number card)' },
  refresh: { icon: '🔄', label: 'Refresh training', desc: 'OTP kaise check karna hai (REFRESH / VIEW MESSAGES / text)' },
};

// Har cheez ka BUTTON — step kinds (UI inhi se banti hai).
export const STEP_KINDS = {
  send_text:     { icon: '✉️', label: 'Message bhejo',       hint: 'Bot ko text bhejo (/start, FIND NUMBER…)',        paramIcon: '✉️', paramLabel: 'Message text',     placeholder: '/start' },
  click_button:  { icon: '🖱', label: 'Button dabao',        hint: 'Button click (na mile to type fallback)',          paramIcon: '🔘', paramLabel: 'Button ka text',  placeholder: 'NEW NUMBER' },
  wait:          { icon: '⏳', label: 'Wait karo',           hint: 'Utne milliseconds intezaar (100–30000)',           paramIcon: '⏱',  paramLabel: 'Milliseconds',   placeholder: '2000' },
  switch_bot:    { icon: '🤖', label: 'Doosre bot par jao',  hint: 'Is step ke baad us bot se baat hogi',              paramIcon: '🤖', paramLabel: 'Bot ka username', placeholder: 'SomeOtherBot' },
  expect_number: { icon: '📱', label: 'Number card pehchano', hint: 'Card parse karo — claim yahin puri hoti hai',      paramIcon: '',    paramLabel: '',                placeholder: '' },
  expect_otp:    { icon: '🔢', label: 'OTP pehchano',        hint: 'Latest message se 6-digit OTP pehchano',           paramIcon: '',    paramLabel: '',                placeholder: '' },
};

export const STEP_KIND_IDS = Object.keys(STEP_KINDS);

// ---------------------------------------------------------------------------
// Persistence helpers — db.customBots = { [id]: bot }
// ---------------------------------------------------------------------------
function loadBotsRaw() {
  const db = getDb();
  const raw = db?.[CUSTOM_BOTS_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw;
}
function persistBots(bots) {
  const db = getDb();
  db[CUSTOM_BOTS_KEY] = bots;
  saveDb(db);
}
const clone = (value) => JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------------------
// Normalizers / validators
// ---------------------------------------------------------------------------
export function normalizeCustomUsername(raw = '') {
  const handle = String(raw || '').trim().replace(/^@+/, '');
  if (!handle) return '';
  return USERNAME_RE.test(handle) ? handle : '';
}

export function isCustomOtpBotId(value = '') {
  return CUSTOM_ID_RE.test(String(value || '').trim().toLowerCase());
}

export function normalizeCustomBotId(value = '') {
  const id = String(value || '').trim().toLowerCase();
  return isCustomOtpBotId(id) ? id : '';
}

function newStepId() {
  return `st_${crypto.randomBytes(5).toString('hex')}`;
}

function clampText(value, max) {
  return String(value ?? '').replace(/\s+$/g, '').trim().slice(0, max);
}

export function normalizeWhen(when) {
  const match = clampText(when?.match ?? when ?? '', MAX_MATCH_LEN);
  if (!match) return null;
  return { match };
}

// Ek step ko valid/clean karo. Invalid ho to null.
export function normalizeStep(raw = {}) {
  const kind = String(raw?.kind || '').trim();
  if (!STEP_KINDS[kind]) return null;
  const step = {
    id: typeof raw?.id === 'string' && raw.id ? raw.id : newStepId(),
    kind,
    when: normalizeWhen(raw?.when),
    onFail: raw?.onFail === 'continue' ? 'continue' : 'stop',
  };
  if (kind === 'send_text') {
    const text = clampText(raw?.text, MAX_TEXT_LEN);
    if (!text) return null;
    step.text = text;
  } else if (kind === 'click_button') {
    const match = clampText(raw?.match, MAX_MATCH_LEN);
    if (!match) return null;
    step.match = match;
    step.typeIfMissing = raw?.typeIfMissing !== false; // default: click-then-type (world bot jaisa)
    step.typeText = clampText(raw?.typeText || match, MAX_MATCH_LEN) || match;
  } else if (kind === 'wait') {
    const ms = Math.round(Number(raw?.ms));
    if (!Number.isFinite(ms)) return null;
    step.ms = Math.max(100, Math.min(30_000, ms));
  } else if (kind === 'switch_bot') {
    const username = normalizeCustomUsername(raw?.username);
    if (!username) return null;
    step.username = username;
  }
  // expect_number / expect_otp — koi param nahi
  return step;
}

export function normalizeSteps(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const out = [];
  for (const raw of list) {
    const step = normalizeStep(raw);
    if (step) out.push(step);
    if (out.length >= MAX_STEPS_PER_ROUTINE) break;
  }
  return out;
}

function normalizeBotRecord(raw = {}) {
  const id = normalizeCustomBotId(raw?.id);
  const username = normalizeCustomUsername(raw?.username);
  if (!id || !username) return null;
  const name = clampText(raw?.name, MAX_NAME_LEN) || `@${username}`;
  const routines = {};
  for (const routine of ROUTINES) {
    routines[routine] = normalizeSteps(raw?.routines?.[routine]);
  }
  const emoji = clampText(raw?.emoji || '🤖', 8) || '🤖';
  return {
    id,
    name,
    username,
    emoji,
    hint: clampText(raw?.hint, 120),
    createdAt: Number(raw?.createdAt) || Date.now(),
    updatedAt: Number(raw?.updatedAt) || Date.now(),
    routines,
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------
export function listCustomBots() {
  const bots = loadBotsRaw();
  return Object.values(bots)
    .map((raw) => normalizeBotRecord(raw))
    .filter(Boolean)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

export function getCustomBot(id = '') {
  const key = normalizeCustomBotId(id);
  if (!key) return null;
  const bots = loadBotsRaw();
  return normalizeBotRecord(bots[key]);
}

export function createCustomBot({ name = '', username = '', emoji = '🤖' } = {}) {
  const handle = normalizeCustomUsername(username);
  if (!handle) {
    return { ok: false, error: 'Bot ka username sahi nahi hai (@ ke bina, 5–32 letters/digits/underscore). Jaise: MyOtpBot123' };
  }
  const cleanName = clampText(name, MAX_NAME_LEN) || `@${handle}`;
  const cleanEmoji = clampText(emoji, 8) || '🤖';
  const bots = loadBotsRaw();
  const duplicate = Object.values(bots).find((raw) => String(raw?.username || '').toLowerCase() === handle.toLowerCase());
  if (duplicate) return { ok: false, error: `@${handle} pehle se add hai ("${duplicate.name || handle}").` };
  if (Object.keys(bots).length >= MAX_CUSTOM_BOTS) {
    return { ok: false, error: `Custom bot limit (${MAX_CUSTOM_BOTS}) full hai — pehle purana delete karo.` };
  }
  // Id: custom_ + 12 hex — callback_data (64B) me fit rehta hai.
  const id = `custom_${crypto.randomBytes(6).toString('hex')}`;
  const bot = {
    id,
    name: cleanName,
    username: handle,
    emoji: cleanEmoji,
    hint: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    routines: { claim: [], refresh: [] },
  };
  bots[id] = bot;
  persistBots(bots);
  return { ok: true, bot: clone(bot) };
}

export function updateCustomBot(id = '', patch = {}) {
  const key = normalizeCustomBotId(id);
  const bots = loadBotsRaw();
  const current = normalizeBotRecord(bots[key]);
  if (!current) return { ok: false, error: 'Custom bot nahi mila (shayad delete ho gaya).' };
  if (patch.username !== undefined) {
    const handle = normalizeCustomUsername(patch.username);
    if (!handle) return { ok: false, error: 'Username sahi nahi hai (@ ke bina, 5–32 chars).' };
    const dup = Object.values(bots).find((raw) => raw !== bots[key]
      && String(raw?.username || '').toLowerCase() === handle.toLowerCase());
    if (dup) return { ok: false, error: `@${handle} kisi aur custom bot me use ho raha hai.` };
    current.username = handle;
  }
  if (patch.name !== undefined) current.name = clampText(patch.name, MAX_NAME_LEN) || current.name;
  if (patch.emoji !== undefined) current.emoji = clampText(patch.emoji, 8) || current.emoji || '🤖';
  if (patch.hint !== undefined) current.hint = clampText(patch.hint, 120);
  current.updatedAt = Date.now();
  bots[key] = current;
  persistBots(bots);
  return { ok: true, bot: clone(current) };
}

export function deleteCustomBot(id = '') {
  const key = normalizeCustomBotId(id);
  const bots = loadBotsRaw();
  if (!bots[key]) return { ok: false, error: 'Custom bot nahi mila.' };
  delete bots[key];
  persistBots(bots);
  return { ok: true };
}

function mutateRoutine(id, routine, mutator) {
  const key = normalizeCustomBotId(id);
  if (!ROUTINES.includes(routine)) return { ok: false, error: 'Routine galat hai (claim/refresh).' };
  const bots = loadBotsRaw();
  const bot = normalizeBotRecord(bots[key]);
  if (!bot) return { ok: false, error: 'Custom bot nahi mila.' };
  const steps = mutator(clone(bot.routines[routine] || []));
  if (!steps) return { ok: false, error: 'Step invalid tha — kuch save nahi hua.' };
  bot.routines[routine] = normalizeSteps(steps);
  bot.updatedAt = Date.now();
  bots[key] = bot;
  persistBots(bots);
  return { ok: true, bot: clone(bot), routine: bot.routines[routine] };
}

export function addStep(id, routine, rawStep, index = null) {
  const step = normalizeStep(rawStep);
  if (!step) return { ok: false, error: 'Step invalid hai — pehle sahi details bhejo.' };
  return mutateRoutine(id, routine, (steps) => {
    if (steps.length >= MAX_STEPS_PER_ROUTINE) return steps; // silent cap — UI pehle hi rokta hai
    const at = index === null || index === undefined ? steps.length : Math.max(0, Math.min(steps.length, Number(index) || 0));
    steps.splice(at, 0, step);
    return steps;
  });
}

export function updateStep(id, routine, stepId, patch = {}) {
  return mutateRoutine(id, routine, (steps) => steps.map((step) => {
    if (step.id !== stepId) return step;
    const merged = { ...step, ...patch, id: step.id, kind: step.kind };
    return normalizeStep(merged) || step;
  }));
}

export function removeStep(id, routine, stepId) {
  return mutateRoutine(id, routine, (steps) => steps.filter((step) => step.id !== stepId));
}

export function moveStep(id, routine, stepId, direction = 1) {
  return mutateRoutine(id, routine, (steps) => {
    const idx = steps.findIndex((step) => step.id === stepId);
    if (idx < 0) return steps;
    const to = Math.max(0, Math.min(steps.length - 1, idx + (direction < 0 ? -1 : 1)));
    if (to === idx) return steps;
    const [step] = steps.splice(idx, 1);
    steps.splice(to, 0, step);
    return steps;
  });
}

export function clearRoutine(id, routine) {
  return mutateRoutine(id, routine, () => []);
}

export function setRoutineSteps(id, routine, rawSteps = []) {
  return mutateRoutine(id, routine, () => normalizeSteps(rawSteps));
}

export function routineSteps(id, routine) {
  const bot = getCustomBot(id);
  return bot ? (bot.routines[routine] || []) : [];
}

// ---------------------------------------------------------------------------
// Built-in (ab tak coding kiya hua) training — buttons ke roop me copyable.
// Hermes/Hathi/HardXotp ka HAR coded behaviour step template ban sakta hai,
// taaki owner usi se shuru karke apne hisaab se badle.
// ---------------------------------------------------------------------------
export const BUILTIN_TEMPLATES = ['hermes', 'hathi', 'chauhan'];
export const BUILTIN_TEMPLATE_META = {
  hermes:  { claim: '📋 Hermes claim (NEW → FIND → card)',   refresh: '🔄 Hermes refresh (REFRESH click/type)' },
  hathi:   { claim: '📋 Hathi claim (NEW → FIND → card)',    refresh: '🔄 Hathi refresh (REFRESH click/type)' },
  chauhan: { claim: '📋 HardXotp claim (NEW → GET NUMBERS)', refresh: '🔄 HardXotp refresh (VIEW MESSAGES click/type)' },
};

export function builtinTemplateSteps(routine, template = 'hermes') {
  const t = String(template || 'hermes').toLowerCase();
  if (routine === 'claim') {
    if (t === 'chauhan') {
      return normalizeSteps([
        { kind: 'click_button', match: 'NEW NUMBER', typeIfMissing: false, onFail: 'continue' },
        { kind: 'click_button', match: 'GET NUMBERS', typeIfMissing: false, onFail: 'continue' },
        { kind: 'expect_number' },
      ]);
    }
    // Hermes / Hathi — owner ka pakka rule: latest screen par NEW ho to NEW, warna FIND.
    // Claim steps best-effort hain — asal success = number card ka aana.
    return normalizeSteps([
      { kind: 'click_button', match: 'NEW NUMBER', typeIfMissing: false, onFail: 'continue' },
      { kind: 'click_button', match: 'FIND NUMBER', typeIfMissing: false, onFail: 'continue' },
      { kind: 'expect_number' },
    ]);
  }
  if (routine === 'refresh') {
    if (t === 'chauhan') {
      // VIEW MESSAGES hi refresh hai — button na mile/click na chale to text type hota hai.
      return normalizeSteps([
        { kind: 'click_button', match: 'VIEW MESSAGES', typeIfMissing: true, typeText: 'View Messages', onFail: 'stop' },
      ]);
    }
    return normalizeSteps([
      { kind: 'click_button', match: 'REFRESH', typeIfMissing: true, typeText: 'Refresh', onFail: 'stop' },
    ]);
  }
  return [];
}

export function applyBuiltinTemplate(id, routine, template = 'hermes') {
  const steps = builtinTemplateSteps(routine, template);
  if (!steps.length) return { ok: false, error: 'Template nahi mila.' };
  return setRoutineSteps(id, routine, steps);
}

// ---------------------------------------------------------------------------
// OTP-profile shape — otp-bot-profiles.js ka provider yahi consume karta hai.
// ---------------------------------------------------------------------------
export function customBotToProfile(bot) {
  const clean = normalizeBotRecord(bot);
  if (!clean) return null;
  const refreshClick = (clean.routines.refresh || []).find((s) => s.kind === 'click_button');
  const refreshLabel = String(refreshClick?.match || 'REFRESH').toUpperCase().slice(0, 32) || 'REFRESH';
  const name = clean.name || `@${clean.username}`;
  return {
    id: clean.id,
    label: name,
    uiLabel: `${clean.emoji || '🤖'} ${name}`,
    emoji: clean.emoji || '🤖',
    username: clean.username,
    // Built-in claim preference — custom bots par training chalti hai, ye
    // fields sirf fallback/display ke liye rehti hain.
    claimPreference: ['new', 'find'],
    refreshRoles: ['refresh'],
    refreshLabel,
    refreshText: refreshClick?.typeText || refreshClick?.match || 'Refresh',
    ignoreRolePatterns: [],
    extraRoleMatchers: [],
    startCommand: '/start',
    hint: clean.hint || `Custom trained bot — claim ${(clean.routines.claim || []).length} steps · refresh ${(clean.routines.refresh || []).length} steps`,
    custom: true,
    botId: clean.id,
  };
}

export function listCustomOtpProfiles() {
  try {
    return listCustomBots()
      .map((bot) => customBotToProfile(bot))
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Shortcut: kya ye id kisi saved custom bot ka hai? (settings validation)
export function customBotExists(id = '') {
  return Boolean(getCustomBot(id));
}

// Step ka one-line human description (UI + test output).
export function describeStep(step = {}) {
  const kind = STEP_KINDS[step?.kind];
  if (!kind) return '❓ Unknown step';
  let main = kind.icon;
  if (step.kind === 'send_text') main += ` "${step.text}" bhejo`;
  else if (step.kind === 'click_button') {
    main += ` "${step.match}" button dabao`;
    if (step.typeIfMissing) main += ` (na mile to "${step.typeText || step.match}" type karo)`;
  } else if (step.kind === 'wait') main += ` ${step.ms}ms wait`;
  else if (step.kind === 'switch_bot') main += ` @${step.username} par jao`;
  else if (step.kind === 'expect_number') main += ' Number card pehchano';
  else if (step.kind === 'expect_otp') main += ' OTP pehchano';
  if (step.when?.match) main += ` — jab response me "${step.when.match}" ho`;
  if (step.onFail === 'continue') main += ' · fail pe aage badho';
  return main;
}

export function describeRoutine(bot, routine) {
  const steps = bot?.routines?.[routine] || [];
  if (!steps.length) return '— khali — (steps add karo)';
  return steps.map((step, i) => `${i + 1}. ${describeStep(step)}`).join('\n');
}

// Provider register — otp-bot-profiles.js ke static profiles ke saath
// custom profiles bhi resolve hone lagte hain (list/get/isId/normalize).
registerOtpBotProfileProvider(() => listCustomOtpProfiles());
