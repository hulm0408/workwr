// ===== 📨 TELEGRAM Hermes NUMBER + OTP SOURCE =====
//
// Hamara normal Telegraf/Bot API bot kisi doosre Telegram bot ko message
// ya callback-click nahi bhej sakta. Isliye @HermeshuOTPROBOT ko automate
// karne ke liye ek SPARE Telegram user account ko MTProto (Teleproto) se
// connect karna padta hai:
//
//   Find Number → number parse → Swiggy OTP send (pipeline) →
//   Refresh (default 20s) → OTP mile to wahi purana verify/register flow →
//   OTP na mile to agla claim New Number click karke doosra number lega.
//
// Session string poore Telegram account ka access hoti hai. Ye sirf
// Render env (TELEGRAM_SESSION) ya ignored local data/telegram.session me
// rakho — GitHub/chat me kabhi mat bhejo.

import { existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeIndianMobileNumber } from './phone-utils.js';
import { parseForwarderDateTime, _extractSixDigitCode } from './firebase-numbers.js';

export const DEFAULT_TELEGRAM_OTP_BOT_USERNAME = 'HermeshuOTPROBOT';

function firstEnv(env, keys) {
  for (const key of keys) {
    const value = String(env?.[key] ?? '').trim();
    if (value) return value;
  }
  return '';
}

export function getTelegramSessionFilePath(env = process.env) {
  const explicit = firstEnv(env, ['TELEGRAM_SESSION_FILE', 'TG_SESSION_FILE']);
  if (explicit) return explicit;
  const dataDir = String(env?.DATA_DIR || 'data').trim() || 'data';
  return `${dataDir.replace(/\/+$/, '')}/telegram.session`;
}

export function getTelegramApiCredentialsFilePath(env = process.env) {
  const explicit = firstEnv(env, ['TELEGRAM_API_CREDENTIALS_FILE', 'TG_API_CREDENTIALS_FILE']);
  if (explicit) return explicit;
  const dataDir = String(env?.DATA_DIR || 'data').trim() || 'data';
  return `${dataDir.replace(/\/+$/, '')}/telegram-api.json`;
}

function readStoredTelegramApiCredentials(filePath) {
  if (!filePath) return { apiId: 0, apiHash: '' };
  try {
    if (!existsSync(filePath)) return { apiId: 0, apiHash: '' };
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    const rawId = String(parsed?.apiId ?? parsed?.api_id ?? '').trim();
    return {
      apiId: /^\d+$/.test(rawId) ? Number(rawId) : 0,
      apiHash: String(parsed?.apiHash ?? parsed?.api_hash ?? '').trim(),
    };
  } catch {
    return { apiId: 0, apiHash: '' };
  }
}

function persistPrivateFile(filePath, content) {
  if (!filePath) return false;
  const dir = dirname(filePath);
  if (dir && dir !== '.') mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(filePath, 0o600); } catch {}
  return true;
}

export function saveTelegramApiCredentials(
  { apiId, apiHash } = {},
  { env = process.env, updateProcessEnv = true } = {}
) {
  const cleanId = /^\d+$/.test(String(apiId || '').trim()) ? Number(String(apiId).trim()) : 0;
  const cleanHash = String(apiHash || '').trim();
  if (!cleanId || !cleanHash) throw new Error('Valid Telegram API ID aur API hash chahiye.');
  const filePath = getTelegramApiCredentialsFilePath(env);
  persistPrivateFile(filePath, `${JSON.stringify({ apiId: cleanId, apiHash: cleanHash }, null, 2)}\n`);
  if (updateProcessEnv) {
    process.env.TELEGRAM_API_ID = String(cleanId);
    process.env.TELEGRAM_API_HASH = cleanHash;
  }
  return { ok: true, apiId: cleanId, apiHashPresent: true, apiCredentialsFile: filePath, apiCredentialsSource: 'file' };
}

export function saveTelegramSessionString(
  session,
  { env = process.env, persist = true, updateProcessEnv = true } = {}
) {
  const clean = String(session || '').trim();
  if (!clean) throw new Error('Telegram session string khali hai — login save nahi ho paya.');
  const filePath = getTelegramSessionFilePath(env);
  const persisted = persist ? persistPrivateFile(filePath, `${clean}\n`) : false;
  if (updateProcessEnv) process.env.TELEGRAM_SESSION = clean;
  return { ok: true, sessionFile: filePath, sessionSource: persisted ? 'file' : 'memory', persisted };
}

export function getTelegramOtpConfig(env = process.env) {
  const apiIdRaw = firstEnv(env, ['TELEGRAM_API_ID', 'TG_API_ID', 'TELEGRAM_APP_ID']);
  const envApiId = /^\d+$/.test(apiIdRaw) ? Number(apiIdRaw) : 0;
  const envApiHash = firstEnv(env, ['TELEGRAM_API_HASH', 'TG_API_HASH', 'TELEGRAM_APP_HASH']);
  const apiCredentialsFile = firstEnv(env, ['TELEGRAM_API_CREDENTIALS_FILE', 'TG_API_CREDENTIALS_FILE'])
    || (env === process.env ? getTelegramApiCredentialsFilePath(env) : '');
  const storedApi = readStoredTelegramApiCredentials(apiCredentialsFile);
  const apiId = envApiId || storedApi.apiId || 0;
  const apiHash = envApiHash || storedApi.apiHash || '';
  const apiCredentialsSource = (envApiId || envApiHash)
    ? ((storedApi.apiId || storedApi.apiHash) ? 'env+file' : 'env')
    : ((storedApi.apiId || storedApi.apiHash) ? 'file' : '');

  let session = firstEnv(env, ['TELEGRAM_SESSION', 'TELEGRAM_STRING_SESSION', 'TG_SESSION']);
  let sessionSource = session ? 'env' : '';
  const sessionFile = firstEnv(env, ['TELEGRAM_SESSION_FILE', 'TG_SESSION_FILE'])
    || (env === process.env ? getTelegramSessionFilePath(env) : '');
  if (!session && sessionFile) {
    try {
      if (existsSync(sessionFile)) {
        session = readFileSync(sessionFile, 'utf8').trim();
        if (session) sessionSource = 'file';
      }
    } catch {}
  }

  const botUsername = (firstEnv(env, [
    'TELEGRAM_OTP_BOT_USERNAME',
    'TELEGRAM_OTP_BOT',
    'HERMES_BOT_USERNAME',
    'Hermeshu_BOT_USERNAME',
  ]) || DEFAULT_TELEGRAM_OTP_BOT_USERNAME).replace(/^@+/, '').trim();

  const missing = [];
  if (!apiId) missing.push('TELEGRAM_API_ID');
  if (!apiHash) missing.push('TELEGRAM_API_HASH');
  if (!session) missing.push('TELEGRAM_SESSION');

  return {
    apiId,
    apiHash,
    apiCredentialsFile,
    apiCredentialsSource,
    apiIdPresent: apiId > 0,
    apiHashPresent: Boolean(apiHash),
    sessionPresent: Boolean(session),
    session,
    sessionFile,
    sessionSource,
    botUsername: botUsername || DEFAULT_TELEGRAM_OTP_BOT_USERNAME,
    findButtonText: firstEnv(env, ['TELEGRAM_FIND_BUTTON_TEXT', 'Hermeshu_FIND_BUTTON_TEXT']),
    refreshButtonText: firstEnv(env, ['TELEGRAM_REFRESH_BUTTON_TEXT', 'Hermeshu_REFRESH_BUTTON_TEXT']),
    newButtonText: firstEnv(env, ['TELEGRAM_NEW_BUTTON_TEXT', 'Hermeshu_NEW_BUTTON_TEXT']),
    configured: missing.length === 0,
    missing,
  };
}

export function isTelegramOtpConfigured(env = process.env) {
  return getTelegramOtpConfig(env).configured;
}

export function resolveNumberSourceMode({ env = process.env, telegramSetting = false } = {}) {
  const raw = firstEnv(env, ['NUMBER_SOURCE', 'PREMIUM_NUMBER_SOURCE', 'OTP_SOURCE']).toLowerCase();
  if (['telegram', 'hermes', 'hermeshu', 'hermeshu-bot', 'Hermeshu'].includes(raw)) return 'telegram';
  if (['firebase', 'firebase-pool', 'pool'].includes(raw)) return 'firebase';
  if (telegramSetting) return 'telegram';
  return isTelegramOtpConfigured(env) ? 'telegram' : 'firebase';
}

export function telegramOtpSetupHintLines(configOrEnv) {
  const config = configOrEnv && Array.isArray(configOrEnv.missing)
    ? configOrEnv
    : getTelegramOtpConfig(configOrEnv || process.env);
  const bot = config.botUsername || DEFAULT_TELEGRAM_OTP_BOT_USERNAME;
  return [
    `! <b>Telegram Hermes setup pending hai.</b>`,
    config.missing.length ? `› Missing: ${config.missing.map((k) => `<code>${k}</code>`).join(' · ')}` : '',
    ``,
    `› <b>Recommended:</b> is bot me <b>⚙️ Settings → Add Telegram Account</b> dabao aur spare/faltu account yahin login karo (bot default <code>@${bot}</code> hai).`,
    `› <b>1)</b> Agar Render env me API ID/hash nahi hai, <code>my.telegram.org</code> se spare-account API app ready rakho — bot private chat me sirf wohi maangega.`,
    `› <b>2)</b> Phir spare-account phone, Telegram login code aur agar 2FA ho to password lagega. Input messages delete karne ki koshish hogi; session chat me kabhi nahi dikhegi.`,
    `› <b>Safer fallback:</b> local PC par <code>npm run telegram:login</code>, phir session ko Render <code>TELEGRAM_SESSION</code> env me daalo.`,
    `› Render free disk restart/redeploy par mit sakti hai — long-term ke liye env session zyada durable hai.`,
    ``,
    `⚠️ Session string = poora Telegram account access. GitHub/chat me mat bhejo; spare account hi use karo, main account nahi.`,
  ].filter(Boolean);
}

// ---------------------------------------------------------------------------
// Hermeshu fancy/small-caps text + number-card parsing
// ---------------------------------------------------------------------------
const SMALL_CAPS_MAP = {
  'ᴀ': 'A', 'ʙ': 'B', 'ᴄ': 'C', 'ᴅ': 'D', 'ᴇ': 'E', 'ꜰ': 'F', 'ɢ': 'G',
  'ʜ': 'H', 'ɪ': 'I', 'ᴊ': 'J', 'ᴋ': 'K', 'ʟ': 'L', 'ᴍ': 'M', 'ɴ': 'N',
  'ᴏ': 'O', 'ᴘ': 'P', 'ʀ': 'R', 'ꜱ': 'S', 'ᴛ': 'T', 'ᴜ': 'U', 'ᴠ': 'V',
  'ᴡ': 'W', 'ʏ': 'Y', 'ᴢ': 'Z',
};

export function normalizeTelegramFancyText(text = '') {
  const decomposed = String(text ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
  return [...decomposed].map((ch) => SMALL_CAPS_MAP[ch] || ch).join('');
}

function searchText(text = '') {
  return normalizeTelegramFancyText(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function telegramButtonRole(text = '') {
  const n = searchText(text);
  if (!n) return '';
  if (/\b(refresh|reload|check otp|get otp|update)\b/.test(n)) return 'refresh';
  if (/\b(new|change|another|next)\b.*\bnumber\b/.test(n)) return 'new';
  // SEARCH NUMBER / ACTIVE NUMBERS ko FIND samajhna dangerous hai — FIND ke
  // liye find/get/show/my/your me se koi verb lazmi hona chahiye.
  if (/\b(find|get|show|my|your)\s+number\b/.test(n)) return 'find';
  return '';
}

function extractPhoneFromSegment(segment = '') {
  const normalized = normalizeTelegramFancyText(segment);
  const match = normalized.match(/(?:\+?91[\s-]*)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/);
  return match ? normalizeIndianMobileNumber(match[0]) : null;
}

function extractPhone(text = '') {
  const normalized = normalizeTelegramFancyText(text);
  const lines = normalized.split(/\r?\n/);
  for (const line of lines) {
    if (!/\bnumber\b/i.test(searchText(line))) continue;
    const afterLabel = line.includes(':') ? line.slice(line.indexOf(':') + 1) : line;
    const phone = extractPhoneFromSegment(afterLabel) || extractPhoneFromSegment(line);
    if (phone) return phone;
  }
  for (const line of lines) {
    const s = searchText(line);
    if (/\bid\b/.test(s)) continue; // welcome card ki Telegram ID mobile jaisi lag sakti hai
    const phone = extractPhoneFromSegment(line);
    if (phone) return phone;
  }
  return extractPhoneFromSegment(normalized);
}

function labelledValue(text, label) {
  const lines = normalizeTelegramFancyText(text).split(/\r?\n/);
  for (const line of lines) {
    if (!searchText(line).includes(label)) continue;
    if (!line.includes(':')) continue;
    return line.slice(line.indexOf(':') + 1).trim();
  }
  return '';
}

function parseHermesText(text = '') {
  const normalized = normalizeTelegramFancyText(text);
  const phone = extractPhone(normalized);

  const statusRaw = labelledValue(normalized, 'status');
  const status = (statusRaw.match(/[A-Za-z]+/) || [''])[0].toUpperCase();
  const deviceRaw = labelledValue(normalized, 'device');
  const device = (deviceRaw.match(/[A-Za-z0-9._-]+/) || [''])[0];

  const cleanSenderValue = (value = '') => String(value || '')
    .split(/\s*(?:\||→|=>|-{2,}|OTP\b)/i)[0]
    .trim()
    .replace(/^[{([<>\s]+|[\]})<>\s,;:]+$/g, '')
    .slice(0, 80);
  const senderMatch = normalized.match(/LAST\s+SMS\s*(?:[:\-]\s*)?[\[({\u003e]\s*([^\]\)}\n\u003c]+)\s*[\])}]/i)
    || normalized.match(/LAST\s+SMS\s*(?:FROM\s*)?[:\-]\s*([A-Za-z0-9][A-Za-z0-9 ._-]{1,79})/i)
    || normalized.match(/(?:^|\n)\s*(?:SENDER|FROM)\s*[:\-]\s*([A-Za-z0-9][A-Za-z0-9 ._-]{1,79})/i)
    || normalized.match(/[\[({\u003e]\s*([A-Z0-9._-]*(?:SWIGGY|SWI-GY)[A-Z0-9._-]*)\s*[\])}]/i);
  const sender = senderMatch ? cleanSenderValue(senderMatch[1]) : '';

  let code = '';
  for (const line of normalized.split(/\r?\n/)) {
    const m = line.match(/\bOTP\b\s*[:\-]?\s*(\d{6})(?!\d)/i);
    if (m) { code = m[1]; break; }
  }
  if (!code) code = _extractSixDigitCode(normalized);

  const rawTime = (normalized.match(/(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4}\s*\|\s*\d{1,2}:\d{2}\s*(?:AM|PM)?)/i) || [])[1] || '';
  const smsTimeMs = rawTime ? (parseForwarderDateTime(rawTime) || 0) : 0;
  const signature = code ? [sender, code, smsTimeMs || rawTime, phone || ''].join('|') : '';

  return {
    phone,
    status,
    device,
    sender,
    code,
    rawTime,
    smsTimeMs,
    signature,
    lastSms: code ? { sender, code, rawTime, smsTimeMs, signature } : null,
    normalizedText: normalized,
  };
}

export function parseTelegramNumberCard(text = '') {
  const parsed = parseHermesText(text);
  return parsed.phone ? parsed : null;
}

export function parseTelegramOtpText(text = '') {
  const parsed = parseHermesText(text);
  return parsed.code ? parsed : null;
}

export function extractTelegramOtpFromText(text = '') {
  return parseHermesText(text).code || '';
}

// ---------------------------------------------------------------------------
// Teleproto user-client singleton
// ---------------------------------------------------------------------------
let teleprotoPromise = null;
let clientPromise = null;
let clientRef = null;
let entityRef = null;
let entityCacheKey = '';
let lockTail = Promise.resolve();

const providerState = {
  connected: false,
  authorized: false,
  loginInProgress: false,
  meLabel: '',
  currentPhone: '',
  currentEntry: null,
  currentConsumed: false,
  currentMessageId: 0,
  lastError: '',
  lastActionAt: 0,
  lastCheckedAt: 0,
};

export function isTelegramLoginInProgress() {
  return Boolean(providerState.loginInProgress);
}

export function normalizeTelegramLoginPhone(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const hadPlus = raw.startsWith('+');
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';

  if (hadPlus) return digits.length >= 7 && digits.length <= 15 ? `+${digits}` : '';
  if (/^[6-9]\d{9}$/.test(digits)) return `+91${digits}`;
  if (/^0[6-9]\d{9}$/.test(digits)) return `+91${digits.slice(1)}`;
  if (/^91[6-9]\d{9}$/.test(digits)) return `+${digits}`;
  // Country code ke saath diye gaye non-Indian numbers bhi E.164 me rehne do.
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return '';
}

function setLastError(error) {
  providerState.lastError = String(error?.message || error || '').slice(0, 220);
}

async function withTelegramLock(fn) {
  const previous = lockTail.catch(() => {});
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  lockTail = previous.then(() => gate);
  await previous;
  try { return await fn(); } finally { release(); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

async function sleepInterruptibly(ms, shouldAbort) {
  const end = Date.now() + Math.max(0, Number(ms) || 0);
  while (Date.now() < end) {
    if (typeof shouldAbort === 'function' && shouldAbort()) return;
    await sleep(Math.min(250, end - Date.now()));
  }
}

async function loadTeleproto() {
  if (!teleprotoPromise) {
    teleprotoPromise = Promise.all([
      import('teleproto'),
      import('teleproto/sessions'),
    ]).then(([main, sessions]) => ({
      TelegramClient: main.TelegramClient,
      StringSession: sessions.StringSession,
    }));
  }
  return teleprotoPromise;
}

export async function createTelegramUserClient(sessionString = '', config = getTelegramOtpConfig()) {
  const cfg = config && (config.apiHash !== undefined || config.apiId !== undefined)
    ? config
    : getTelegramOtpConfig(config || process.env);
  if (!cfg.apiId || !cfg.apiHash) {
    throw new Error('TELEGRAM_API_ID / TELEGRAM_API_HASH missing hai (my.telegram.org se spare account ki API app banao)');
  }
  const { TelegramClient, StringSession } = await loadTeleproto();
  return new TelegramClient(new StringSession(String(sessionString || '')), cfg.apiId, cfg.apiHash, {
    connectionRetries: 3,
    requestRetries: 2,
    autoReconnect: true,
    reconnectRetries: 3,
    floodSleepThreshold: 20,
    deviceModel: 'Swiggy Fresh Hermes Client',
    systemVersion: process.version,
    appVersion: '1.0.0',
    langCode: 'en',
    systemLangCode: 'en',
  });
}

function invalidateClient(error) {
  const msg = String(error?.message || error || '');
  if (!/(AUTH_KEY|SESSION_REVOKED|USER_DEACTIVATED|not connected|disconnected|Connection closed)/i.test(msg)) return;
  clientRef = null;
  clientPromise = null;
  entityRef = null;
  entityCacheKey = '';
  providerState.connected = false;
  providerState.authorized = false;
}

async function ensureClientUnlocked() {
  if (providerState.loginInProgress) {
    throw new Error('Telegram account login chal raha hai — pehle Add Telegram Account complete ya cancel karo.');
  }
  const config = getTelegramOtpConfig();
  if (!config.configured) {
    throw new Error(`Telegram Hermes setup missing hai: ${config.missing.join(', ')}`);
  }
  if (clientRef && providerState.connected) return { client: clientRef, config };
  if (clientPromise) return clientPromise;

  clientPromise = (async () => {
    const client = await createTelegramUserClient(config.session, config);
    await client.connect();
    const authorized = await client.checkAuthorization();
    if (!authorized) {
      throw new Error('Telegram session authorized nahi hai — Settings → Add Telegram Account se spare account dobara login karo (ya local fallback: npm run telegram:login)');
    }
    let meLabel = '';
    try {
      const me = await client.getMe();
      meLabel = me?.username ? `@${me.username}` : [me?.firstName, me?.lastName].filter(Boolean).join(' ');
    } catch {}
    clientRef = client;
    Object.assign(providerState, {
      connected: true,
      authorized: true,
      meLabel,
      lastError: '',
      lastCheckedAt: Date.now(),
    });
    return { client, config };
  })().catch((error) => {
    clientPromise = null;
    clientRef = null;
    entityRef = null;
    entityCacheKey = '';
    providerState.connected = false;
    providerState.authorized = false;
    setLastError(error);
    throw error;
  });
  return clientPromise;
}

async function ensureEntityUnlocked(client, config) {
  const key = String(config.botUsername || '').toLowerCase();
  if (entityRef && entityCacheKey === key) return entityRef;
  entityRef = await client.getEntity(`@${config.botUsername}`);
  entityCacheKey = key;
  return entityRef;
}

function isIncomingMessage(message) {
  if (!message || typeof message !== 'object') return false;
  if (typeof message.out === 'boolean') return !message.out;
  return true;
}

function messageText(message) {
  try { return String(message?.text || message?.message || message?.rawText || ''); } catch { return ''; }
}

function messageId(message) {
  const raw = message?.id;
  if (typeof raw === 'bigint') return Number(raw);
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function telegramTsToMs(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime() || 0;
  const n = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1e12 ? n : n * 1000;
}

const messageDateMs = (message) => telegramTsToMs(message?.date);
const messageEditMs = (message) => telegramTsToMs(message?.editDate) || messageDateMs(message);

function messageSignature(message) {
  return `${messageId(message)}|${messageEditMs(message)}|${messageText(message)}`;
}

async function fetchIncomingUnlocked(limit = 10) {
  try {
    const { client, config } = await ensureClientUnlocked();
    const entity = await ensureEntityUnlocked(client, config);
    const messages = await client.getMessages(entity, { limit: Math.max(1, Number(limit) || 10) });
    const arr = Array.isArray(messages) ? messages : [...(messages || [])];
    providerState.lastCheckedAt = Date.now();
    return arr.filter(isIncomingMessage);
  } catch (error) {
    invalidateClient(error);
    setLastError(error);
    throw error;
  }
}

function buttonText(button) {
  try { return String(button?.text || button?.button?.text || ''); } catch { return ''; }
}

async function getMessageButtons(message) {
  let rows;
  try {
    rows = typeof message?.getButtons === 'function'
      ? await message.getButtons()
      : message?.buttons;
  } catch {
    try { rows = message?.buttons; } catch {}
  }
  if (!rows) rows = message?._buttons || (message?._buttonsFlat ? [message._buttonsFlat] : []);
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => (Array.isArray(row) ? row : [row])).filter(Boolean);
}

function buttonMatchesRole(button, role, config) {
  const text = buttonText(button);
  const custom = role === 'find'
    ? config.findButtonText
    : role === 'refresh'
      ? config.refreshButtonText
      : role === 'new'
        ? config.newButtonText
        : '';
  if (custom) {
    const a = searchText(text);
    const b = searchText(custom);
    if (a && b && (a.includes(b) || b.includes(a))) return true;
  }
  return telegramButtonRole(text) === role;
}

async function clickButtonUnlocked(role, { phone = '' } = {}) {
  const { config } = await ensureClientUnlocked();
  const messages = await fetchIncomingUnlocked(12);
  for (const message of messages) {
    const card = parseTelegramNumberCard(messageText(message));
    if (phone && card?.phone && card.phone !== phone) continue;
    const buttons = await getMessageButtons(message);
    const button = buttons.find((candidate) => buttonMatchesRole(candidate, role, config));
    if (!button) continue;
    await button.click({});
    providerState.lastActionAt = Date.now();
    providerState.lastError = '';
    return { ok: true, messageId: messageId(message), buttonText: buttonText(button) };
  }
  return { ok: false };
}

async function sendStartUnlocked() {
  const { client, config } = await ensureClientUnlocked();
  const entity = await ensureEntityUnlocked(client, config);
  await client.sendMessage(entity, { message: '/start' });
  providerState.lastActionAt = Date.now();
}

async function latestNumberCardUnlocked(excludePhones = new Set()) {
  const messages = await fetchIncomingUnlocked(12);
  for (const message of messages) {
    const card = parseTelegramNumberCard(messageText(message));
    if (!card?.phone || excludePhones.has(card.phone)) continue;
    return { message, card, signature: messageSignature(message) };
  }
  return null;
}

async function waitForNumberCardUnlocked({
  baselineSignatures = new Set(),
  excludePhones = new Set(),
  timeoutMs = 20_000,
  shouldAbort = null,
} = {}) {
  const deadline = Date.now() + Math.max(1_000, Number(timeoutMs) || 20_000);
  while (Date.now() < deadline) {
    if (typeof shouldAbort === 'function' && shouldAbort()) return null;
    const messages = await fetchIncomingUnlocked(12);
    for (const message of messages) {
      const card = parseTelegramNumberCard(messageText(message));
      if (!card?.phone || excludePhones.has(card.phone)) continue;
      const signature = messageSignature(message);
      if (baselineSignatures.has(signature)) continue;
      return { message, card, signature };
    }
    await sleepInterruptibly(Math.min(700, Math.max(0, deadline - Date.now())), shouldAbort);
  }
  return null;
}

async function obtainCardUnlocked({
  forceNew = false,
  excludePhones = new Set(),
  timeoutMs = 20_000,
  shouldAbort = null,
} = {}) {
  const before = await fetchIncomingUnlocked(12);
  const baselineSignatures = new Set(before.map(messageSignature));

  let clicked = await clickButtonUnlocked(forceNew ? 'new' : 'find');
  if (!clicked.ok && forceNew) clicked = await clickButtonUnlocked('find');
  if (!clicked.ok) {
    await sendStartUnlocked();
    await sleepInterruptibly(1_000, shouldAbort);
    clicked = await clickButtonUnlocked(forceNew ? 'new' : 'find');
    if (!clicked.ok && forceNew) clicked = await clickButtonUnlocked('find');
  }

  const fresh = await waitForNumberCardUnlocked({
    baselineSignatures,
    excludePhones,
    timeoutMs,
    shouldAbort,
  });
  if (fresh) return fresh;
  if (!forceNew) return latestNumberCardUnlocked(excludePhones);
  return null;
}

function entryFromCard(result, config) {
  const { card, message } = result;
  return {
    phone: card.phone,
    deviceId: `hermes:${card.device || card.phone}`,
    telegramDevice: card.device || '',
    online: /^(ACTIVE|ONLINE)$/i.test(card.status || '') ? true : undefined,
    label: card.device ? `Hermes ${card.device}` : 'Hermes Telegram',
    joined: '',
    status: '',
    childKey: `telegram:${messageId(message)}`,
    noPatch: true,
    source: 'telegram',
    otpProvider: 'telegram',
    telegramBotUsername: config.botUsername,
    telegramMessageId: messageId(message),
  };
}

export async function getNextTelegramNumber(opts = {}) {
  return withTelegramLock(async () => {
    const { config } = await ensureClientUnlocked();
    const excluded = new Set((Array.isArray(opts.excludePhones) ? opts.excludePhones : []).map(String));
    if (providerState.currentConsumed && providerState.currentPhone) excluded.add(providerState.currentPhone);
    let forceNew = Boolean(opts.forceNew || providerState.currentConsumed);
    const maxAttempts = Math.max(1, Math.min(10, Number(opts.maxAttempts) || 5));
    const shouldAbort = typeof opts.shouldAbort === 'function' ? opts.shouldAbort : null;
    let lastEntry = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (shouldAbort?.()) throw new Error('Telegram Hermes number claim aborted');
      const result = await obtainCardUnlocked({
        forceNew,
        excludePhones: excluded,
        timeoutMs: opts.timeoutMs ?? 20_000,
        shouldAbort,
      });
      if (!result) {
        throw new Error(`@${config.botUsername} se number card nahi mila (Find/New button ya bot response check karo)`);
      }
      const entry = entryFromCard(result, config);
      lastEntry = entry;

      let accepted = true;
      if (typeof opts.acceptEntry === 'function') {
        try { accepted = Boolean(await opts.acceptEntry(entry)); } catch { accepted = false; }
      }
      providerState.currentPhone = entry.phone;
      providerState.currentEntry = { ...entry };
      providerState.currentMessageId = entry.telegramMessageId || 0;
      providerState.currentConsumed = true;
      providerState.lastError = '';
      if (accepted) return entry;

      excluded.add(entry.phone);
      forceNew = true;
    }

    throw new Error(`Telegram Hermes se usable number nahi mila (${maxAttempts} tries${lastEntry ? `, last ${lastEntry.phone}` : ''})`);
  });
}

export function discardCurrentTelegramNumber(phoneOrReason = '') {
  const maybePhone = String(phoneOrReason || '').replace(/\D/g, '').slice(-10);
  if (!maybePhone || !providerState.currentPhone || maybePhone === providerState.currentPhone) {
    providerState.currentConsumed = true;
  }
}

function emptySnapshot(phone) {
  return {
    ids: new Set(),
    codes: new Set(),
    code: '',
    signature: '',
    smsTimeMs: 0,
    rawTime: '',
    sender: '',
    messageId: 0,
    editDateMs: 0,
    phone: phone || '',
  };
}

function snapshotFromParsed(phone, message, parsed) {
  const signature = parsed?.signature || '';
  const code = parsed?.code || '';
  const idKey = message ? `telegram:${messageId(message)}:${messageEditMs(message)}:${signature}` : '';
  return {
    ids: new Set(idKey ? [idKey] : []),
    codes: new Set(code ? [code] : []),
    code,
    signature,
    smsTimeMs: parsed?.smsTimeMs || 0,
    rawTime: parsed?.rawTime || '',
    sender: parsed?.sender || '',
    messageId: message ? messageId(message) : 0,
    editDateMs: message ? messageEditMs(message) : 0,
    phone: parsed?.phone || phone || '',
  };
}

export async function snapshotTelegramOtpState(phone, opts = {}) {
  return withTelegramLock(async () => {
    try {
      const messages = await fetchIncomingUnlocked(12);
      for (const message of messages) {
        const parsed = parseTelegramOtpText(messageText(message));
        if (!parsed?.code) continue;
        if (parsed.phone && parsed.phone !== phone) continue;
        if (!parsed.phone && providerState.currentPhone && providerState.currentPhone !== phone) continue;
        return snapshotFromParsed(phone, message, parsed);
      }
      return emptySnapshot(phone);
    } catch (error) {
      setLastError(error);
      return { ...emptySnapshot(phone), error: String(error?.message || error) };
    }
  });
}

function toStringSet(value) {
  if (!value) return new Set();
  if (value instanceof Set) return new Set([...value].map(String));
  if (Array.isArray(value)) return new Set(value.map(String));
  return new Set([String(value)]);
}

function normalizeBaseline(input) {
  const base = input && typeof input === 'object' ? input : {};
  const codes = toStringSet(base.codes);
  if (base.code) codes.add(String(base.code));
  const ids = toStringSet(base.ids);
  if (base.idKey) ids.add(String(base.idKey));
  return {
    signature: String(base.signature || ''),
    code: String(base.code || [...codes][0] || ''),
    codes,
    ids,
    smsTimeMs: Number(base.smsTimeMs || base.ts || 0) || 0,
    messageId: Number(base.messageId || 0) || 0,
    editDateMs: Number(base.editDateMs || 0) || 0,
  };
}

function candidateIsNew(candidate, baseline) {
  const { parsed, idKey } = candidate;
  if (!parsed?.code) return false;
  if (baseline.ids.has(idKey)) return false;
  if (baseline.signature && parsed.signature === baseline.signature) return false;
  if (baseline.smsTimeMs && parsed.smsTimeMs && parsed.smsTimeMs > baseline.smsTimeMs) return true;
  if (baseline.codes.has(parsed.code)) return false;
  if (baseline.signature && parsed.signature !== baseline.signature) return true;
  if (baseline.codes.size && !baseline.codes.has(parsed.code)) return true;
  if (!baseline.signature && !baseline.codes.size && !baseline.ids.size) return true;
  return false;
}

async function readOtpCandidatesUnlocked(phone) {
  const messages = await fetchIncomingUnlocked(12);
  const out = [];
  for (const message of messages) {
    const parsed = parseTelegramOtpText(messageText(message));
    if (!parsed?.code) continue;
    if (parsed.phone && parsed.phone !== phone) continue;
    if (!parsed.phone && providerState.currentPhone && providerState.currentPhone !== phone) continue;
    out.push({
      message,
      parsed,
      idKey: `telegram:${messageId(message)}:${messageEditMs(message)}:${parsed.signature}`,
    });
  }
  return out;
}

export async function waitForTelegramOtpCode(phone, opts = {}) {
  return withTelegramLock(async () => {
    const timeoutMs = Math.max(1_000, Number(opts.timeoutMs) || 20_000);
    const refreshMs = Math.max(800, Number(opts.refreshMs ?? opts.pollMs) || 2_500);
    const waitMs = Math.max(0, Number(opts.waitMs) || 0);
    const acceptAnyAfterMs = Math.max(
      0,
      Number(opts.acceptAnyAfterMs ?? Math.min(15_000, Math.floor(timeoutMs * 0.75))) || 0
    );
    const baseline = normalizeBaseline(opts.baseline ?? opts.excludeIds ?? opts.exclude);
    const shouldAbort = typeof opts.shouldAbort === 'function' ? opts.shouldAbort : null;
    const aborted = () => Boolean(shouldAbort?.());

    try {
      if (aborted()) return { code: '', aborted: true };
      if (waitMs) await sleepInterruptibly(waitMs, shouldAbort);
      if (aborted()) return { code: '', aborted: true };

      const startedAt = Date.now();
      const deadline = startedAt + timeoutMs;
      let lastRefreshAt = 0;
      let lastError = null;

      while (Date.now() < deadline) {
        if (aborted()) return { code: '', aborted: true };
        try {
          const candidates = await readOtpCandidatesUnlocked(phone);
          const accepted = candidates.filter((candidate) => candidateIsNew(candidate, baseline));
          const swiggy = accepted.find((candidate) => /swiggy/i.test(candidate.parsed.sender || ''));
          const chosen = swiggy || ((Date.now() - startedAt) >= acceptAnyAfterMs ? accepted[0] : null);
          if (chosen) {
            providerState.currentPhone = phone;
            providerState.currentMessageId = messageId(chosen.message);
            providerState.lastError = '';
            return {
              code: chosen.parsed.code,
              via: 'telegram-hermes',
              ts: chosen.parsed.smsTimeMs || messageDateMs(chosen.message) || null,
              idKey: chosen.idKey,
              sender: chosen.parsed.sender || '',
            };
          }
        } catch (error) {
          lastError = error;
          setLastError(error);
        }

        if (aborted()) return { code: '', aborted: true };
        const now = Date.now();
        if (now >= deadline) break;
        if (now - lastRefreshAt >= refreshMs) {
          lastRefreshAt = now;
          try { await clickButtonUnlocked('refresh', { phone }); } catch (error) { lastError = error; setLastError(error); }
        }
        await sleepInterruptibly(Math.min(700, Math.max(0, deadline - Date.now())), shouldAbort);
      }

      return lastError
        ? { code: '', error: `Telegram Hermes OTP wait fail: ${String(lastError?.message || lastError).slice(0, 180)}` }
        : { code: '' };
    } catch (error) {
      setLastError(error);
      return { code: '', error: `Telegram Hermes OTP wait fail: ${String(error?.message || error).slice(0, 180)}` };
    }
  });
}

export function getTelegramOtpStatus(env = process.env) {
  const config = getTelegramOtpConfig(env);
  return {
    configured: config.configured,
    missing: [...config.missing],
    apiIdPresent: Boolean(config.apiIdPresent),
    apiHashPresent: Boolean(config.apiHashPresent),
    apiCredentialsSource: config.apiCredentialsSource || '',
    apiCredentialsFile: config.apiCredentialsFile || '',
    sessionPresent: Boolean(config.sessionPresent),
    botUsername: config.botUsername,
    sessionFile: config.sessionFile,
    sessionSource: config.sessionSource,
    connected: providerState.connected,
    authorized: providerState.authorized,
    loginInProgress: Boolean(providerState.loginInProgress),
    me: providerState.meLabel,
    currentPhone: providerState.currentPhone,
    lastError: providerState.lastError,
    lastActionAt: providerState.lastActionAt,
    lastCheckedAt: providerState.lastCheckedAt,
  };
}

export async function verifyTelegramOtpConnection(opts = {}) {
  return withTelegramLock(async () => {
    const { config } = await ensureClientUnlocked();

    const collect = async (messages) => {
      let currentPhone = '';
      let buttons = [];
      for (const message of messages) {
        if (!currentPhone) {
          const card = parseTelegramNumberCard(messageText(message));
          if (card?.phone) currentPhone = card.phone;
        }
        if (!buttons.length) {
          buttons = (await getMessageButtons(message)).map(buttonText).filter(Boolean);
        }
        if (currentPhone && buttons.length) break;
      }
      return { currentPhone, buttons };
    };

    let messages = await fetchIncomingUnlocked(5);
    let found = await collect(messages);
    let sentStart = false;

    // Bilkul naya spare account Hermes chat pehle kabhi khola hi na ho to
    // welcome card laane ke liye ek /start bhejna padta hai. Existing chat
    // me koi number/button pehle se ho to dobara /start nahi bhejte.
    if (opts.sendStartIfEmpty && !messages.length && !found.buttons.length) {
      await sendStartUnlocked();
      sentStart = true;
      await sleep(1_000);
      messages = await fetchIncomingUnlocked(5);
      found = await collect(messages);
    }

    return {
      ok: true,
      configured: true,
      botUsername: config.botUsername,
      me: providerState.meLabel,
      currentPhone: found.currentPhone,
      buttons: found.buttons,
      sentStart,
    };
  });
}

function telegramLoginAbortError() {
  const error = new Error('Telegram account login cancel/timeout ho gaya.');
  error.code = 'TELEGRAM_LOGIN_ABORTED';
  return error;
}

function telegramAccountLabel(user) {
  if (!user || typeof user !== 'object') return '';
  if (user.username) return `@${String(user.username).replace(/^@+/, '')}`;
  return [user.firstName, user.lastName].map((v) => String(v || '').trim()).filter(Boolean).join(' ');
}

function normalizeTelegramFirstAndLastNames(value) {
  if (Array.isArray(value)) {
    return [String(value[0] || '').trim() || 'Telegram', String(value[1] || '').trim()];
  }
  if (value && typeof value === 'object') {
    return [
      String(value.firstName || value.first_name || value.first || '').trim() || 'Telegram',
      String(value.lastName || value.last_name || value.last || '').trim(),
    ];
  }
  const clean = String(value || '').trim();
  if (!clean) return ['Telegram', ''];
  const splitAt = clean.indexOf(' ');
  return splitAt > 0
    ? [clean.slice(0, splitAt).trim(), clean.slice(splitAt + 1).trim()]
    : [clean, ''];
}

export async function loginTelegramUserInteractive(callbacks = {}, opts = {}) {
  if (providerState.loginInProgress) {
    throw new Error('Telegram account login pehle se chal raha hai — pehle use complete ya cancel karo.');
  }
  if (typeof callbacks?.phoneNumber !== 'function' || typeof callbacks?.phoneCode !== 'function') {
    throw new Error('Telegram login ke liye phoneNumber aur phoneCode callbacks chahiye.');
  }

  providerState.loginInProgress = true;
  providerState.lastError = '';

  let loginClient = null;
  let result = null;
  const throwIfAborted = () => {
    if (typeof opts.shouldAbort === 'function' && opts.shouldAbort()) throw telegramLoginAbortError();
  };

  try {
    result = await withTelegramLock(async () => {
      await disconnectTelegramUserClient();
      throwIfAborted();

      const env = opts.env || process.env;
      let config = getTelegramOtpConfig(env);
      const providedApiId = opts.apiId !== undefined && opts.apiId !== null && String(opts.apiId).trim() !== '';
      const providedApiHash = opts.apiHash !== undefined && opts.apiHash !== null && String(opts.apiHash).trim() !== '';
      const apiId = providedApiId
        ? (/^\d+$/.test(String(opts.apiId).trim()) ? Number(String(opts.apiId).trim()) : 0)
        : config.apiId;
      const apiHash = providedApiHash ? String(opts.apiHash).trim() : config.apiHash;

      if ((providedApiId || providedApiHash) && opts.persistApiCredentials !== false) {
        saveTelegramApiCredentials(
          { apiId, apiHash },
          { env, updateProcessEnv: opts.updateProcessEnv !== false }
        );
        config = getTelegramOtpConfig(process.env);
      }

      config = {
        ...config,
        apiId: Number(apiId) || 0,
        apiHash: String(apiHash || ''),
        session: '',
        sessionPresent: false,
        configured: Boolean(apiId && apiHash),
      };
      if (!config.apiId || !config.apiHash) {
        throw new Error('TELEGRAM_API_ID / TELEGRAM_API_HASH missing hai. Add Telegram Account me my.telegram.org wali API app ki details chahiye hongi.');
      }

      loginClient = await createTelegramUserClient('', config);
      throwIfAborted();

      let loginPhone = '';
      await loginClient.start({
        phoneNumber: async () => {
          throwIfAborted();
          const value = await callbacks.phoneNumber();
          throwIfAborted();
          loginPhone = normalizeTelegramLoginPhone(value);
          if (!loginPhone) {
            throw new Error('Spare Telegram account ka valid phone number chahiye (Indian 10-digit ya country code ke saath).');
          }
          return loginPhone;
        },
        phoneCode: async (...args) => {
          throwIfAborted();
          const value = await callbacks.phoneCode(...args);
          throwIfAborted();
          const code = String(value ?? '').replace(/[\s-]+/g, '').trim();
          if (!code) throw new Error('Telegram login code khali hai.');
          return code;
        },
        password: async (hint) => {
          throwIfAborted();
          if (typeof callbacks.password !== 'function') {
            throw new Error('Is spare Telegram account par 2FA ON hai — login ke liye 2FA password chahiye.');
          }
          const value = await callbacks.password(hint);
          throwIfAborted();
          const password = String(value ?? '');
          if (!password) throw new Error('Telegram 2FA password khali hai.');
          return password;
        },
        firstAndLastNames: async (...args) => {
          throwIfAborted();
          const callback = typeof callbacks.firstAndLastNames === 'function'
            ? callbacks.firstAndLastNames
            : (typeof opts.firstAndLastNames === 'function' ? opts.firstAndLastNames : null);
          const value = callback ? await callback(...args) : null;
          throwIfAborted();
          return normalizeTelegramFirstAndLastNames(value);
        },
        onError: async (error) => {
          setLastError(error);
          if (typeof opts.shouldAbort === 'function' && opts.shouldAbort()) return true;
          if (typeof callbacks.onError !== 'function') return false;
          try {
            return await callbacks.onError(error);
          } catch {
            return true;
          }
        },
      });

      throwIfAborted();
      const session = String(loginClient.session?.save?.() || '').trim();
      if (!session) throw new Error('Login ke baad Telegram session khali mili — dobara try karo.');

      let me = '';
      try { me = telegramAccountLabel(await loginClient.getMe()); } catch {}
      throwIfAborted();

      const saved = saveTelegramSessionString(session, {
        env,
        persist: opts.persistSession !== false,
        updateProcessEnv: opts.updateProcessEnv !== false,
      });

      Object.assign(providerState, {
        connected: false,
        authorized: true,
        meLabel: me,
        currentPhone: '',
        currentEntry: null,
        currentConsumed: false,
        currentMessageId: 0,
        lastError: '',
        lastCheckedAt: Date.now(),
      });

      return {
        ok: true,
        me,
        accountLabel: me,
        phone: loginPhone,
        botUsername: config.botUsername,
        sessionFile: saved.sessionFile,
        sessionSource: saved.sessionSource,
        persisted: saved.persisted,
      };
    });

    return result;
  } catch (error) {
    setLastError(error);
    throw error;
  } finally {
    try { await loginClient?.disconnect?.(); } catch {}
    clientRef = null;
    clientPromise = null;
    entityRef = null;
    entityCacheKey = '';
    providerState.connected = false;
    providerState.loginInProgress = false;
    if (result) {
      providerState.authorized = true;
      providerState.meLabel = result.me || providerState.meLabel;
    } else {
      providerState.authorized = false;
    }
  }
}

export async function clearTelegramSessionString({
  env = process.env,
  deleteFile = true,
  clearProcessEnv = true,
} = {}) {
  if (providerState.loginInProgress) {
    throw new Error('Telegram account login chal raha hai — pehle use complete ya cancel karo.');
  }

  return withTelegramLock(async () => {
    const before = getTelegramOtpConfig(env);
    await disconnectTelegramUserClient();

    const sessionFile = before.sessionFile || getTelegramSessionFilePath(env);
    let removedFile = false;
    if (deleteFile && sessionFile) {
      removedFile = existsSync(sessionFile);
      try { rmSync(sessionFile, { force: true }); } catch { removedFile = false; }
      if (removedFile && existsSync(sessionFile)) removedFile = false;
    }

    const removedEnvKeys = [];
    if (clearProcessEnv) {
      for (const key of ['TELEGRAM_SESSION', 'TELEGRAM_STRING_SESSION', 'TG_SESSION']) {
        if (Object.prototype.hasOwnProperty.call(process.env, key)) {
          delete process.env[key];
          removedEnvKeys.push(key);
        }
        if (env && env !== process.env && Object.prototype.hasOwnProperty.call(env, key)) {
          delete env[key];
          if (!removedEnvKeys.includes(key)) removedEnvKeys.push(key);
        }
      }
    }

    Object.assign(providerState, {
      connected: false,
      authorized: false,
      meLabel: '',
      currentPhone: '',
      currentEntry: null,
      currentConsumed: false,
      currentMessageId: 0,
      lastError: '',
      lastCheckedAt: Date.now(),
    });

    return {
      ok: true,
      sessionFile,
      removedFile,
      removedEnv: removedEnvKeys.length > 0,
      removedEnvKeys,
      previousSessionSource: before.sessionSource || '',
      envSessionMayReturnAfterRestart: before.sessionSource === 'env',
    };
  });
}

export async function disconnectTelegramUserClient() {
  const client = clientRef;
  clientRef = null;
  clientPromise = null;
  entityRef = null;
  entityCacheKey = '';
  providerState.connected = false;
  providerState.authorized = false;
  try { await client?.disconnect?.(); } catch {}
}

export function _resetTelegramOtpSourceForTests() {
  clientRef = null;
  clientPromise = null;
  entityRef = null;
  entityCacheKey = '';
  Object.assign(providerState, {
    connected: false,
    authorized: false,
    loginInProgress: false,
    meLabel: '',
    currentPhone: '',
    currentEntry: null,
    currentConsumed: false,
    currentMessageId: 0,
    lastError: '',
    lastActionAt: 0,
    lastCheckedAt: 0,
  });
}
