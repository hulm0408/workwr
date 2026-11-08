import { createHash } from 'node:crypto';
// ===== 📨 TELEGRAM OTP BOT NUMBER + OTP SOURCE =====
//
// Hamara normal Telegraf/Bot API bot kisi doosre Telegram bot ko message
// ya callback-click nahi bhej sakta. Isliye OTP bots (@HermeshuOTPROBOT,
// @Hathi_otp_bot, @HardXotp_Bot — profiles: otp-bot-profiles.js) ko
// automate karne ke liye ek SPARE Telegram user account ko MTProto
// (Teleproto) se connect karna padta hai:
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
import * as roster from './telegram-account-roster.js';
import { classifyTelegramError, accountStateLine } from './telegram-account-health.js';
import {
  DEFAULT_OTP_BOT_PROFILE_ID,
  OTP_BOT_PROFILES,
  getOtpBotProfile,
  normalizeOtpBotProfileId,
  otpBotButtonRole,
  otpBotProfileForUsername,
  selectOtpBotScreenAction,
} from './otp-bot-profiles.js';

export const DEFAULT_TELEGRAM_OTP_BOT_USERNAME = OTP_BOT_PROFILES[DEFAULT_OTP_BOT_PROFILE_ID].username;

// ---------------------------------------------------------------------------
// Kaunsa OTP bot — Hermes (@HermeshuOTPROBOT) ya HardXotp (@HardXotp_Bot).
// START par owner source chunta hai; us waqt yahan explicit profile set hoti
// hai. Boot par default Hermes rehta hai (ya env ka custom bot).
// ---------------------------------------------------------------------------
let activeOtpBotProfileId = '';
let activeOtpBotExplicit = false;

export function setActiveOtpBotProfile(profileOrId = '') {
  const raw = String(profileOrId || '').trim();
  if (!raw) {
    activeOtpBotProfileId = '';
    activeOtpBotExplicit = false;
    return getOtpBotProfile('');
  }
  activeOtpBotProfileId = normalizeOtpBotProfileId(raw);
  activeOtpBotExplicit = true;
  entityRef = null;
  entityCacheKey = '';
  return getOtpBotProfile(activeOtpBotProfileId);
}

export function getActiveOtpBotProfile() {
  if (activeOtpBotProfileId) return getOtpBotProfile(activeOtpBotProfileId);
  const envBot = firstEnv(process.env, ['TELEGRAM_OTP_BOT_USERNAME', 'TELEGRAM_OTP_BOT', 'HERMES_BOT_USERNAME']);
  const known = otpBotProfileForUsername(envBot);
  if (known) return known;
  return getOtpBotProfile(DEFAULT_OTP_BOT_PROFILE_ID);
}

export function resetActiveOtpBotProfile() {
  activeOtpBotProfileId = '';
  activeOtpBotExplicit = false;
}

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

// Session ka chhota fingerprint (kabhi poora session nahi). Multi-instance me
// isi se pata chalta hai ki do bots ek hi spare account par chal rahe hain —
// wahi cheez OTP races, FLOOD_WAIT aur session revoke ki wajah banti hai.
export function telegramSessionTag(env = process.env) {
  try {
    const cfg = getTelegramOtpConfig(env);
    const material = String(cfg?.session || '').trim();
    if (!material) return '';
    return createHash('sha1').update(material).digest('hex').slice(0, 10);
  } catch {
    return '';
  }
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

  // Bot ka faisla: owner ka START selection > env ka custom bot > Hermes.
  // `activeOtpBotExplicit` sirf START/UI selection par true hota hai, isliye
  // operator ka env override tab tak chalta hai jab tak owner khud koi
  // source na chune (uske baad UI ka choice hi final hai).
  const envBotUsername = firstEnv(env, [
    'TELEGRAM_OTP_BOT_USERNAME',
    'TELEGRAM_OTP_BOT',
    'HERMES_BOT_USERNAME',
    'Hermeshu_BOT_USERNAME',
  ]).replace(/^@+/, '').trim();
  const live = env === process.env;
  const knownEnvProfile = otpBotProfileForUsername(envBotUsername);
  // Owner ne UI se koi bot chuna (explicit) → wahi final. Warna env ka bot:
  // agar woh Hermes/HardXotp hai to uski profile, warna custom-bot mode me
  // selected profile ke buttons + env ka username.
  const profile = (activeOtpBotExplicit && live)
    ? getOtpBotProfile(activeOtpBotProfileId)
    : (knownEnvProfile || getActiveOtpBotProfile());
  const botUsername = ((activeOtpBotExplicit && live) || !envBotUsername
    ? profile.username
    : envBotUsername).replace(/^@+/, '').trim();

  // Multi-account: TELEGRAM_SESSION_2.._8 ho to healthy account chuno.
  // Ek hi session ho to roster single-slot hai — behaviour bilkul purana.
  const accounts = roster.buildRoster(env, {
    fallbackSession: session,
    fallbackApiId: apiId,
    fallbackApiHash: apiHash,
  });
  let accountSlot = 0;
  let accountTag = accounts[0]?.tag || '';
  let accountCount = accounts.length;
  if (accounts.length > 1) {
    const picked = roster.pinnedAccountSlot() >= 0 && roster.isHealthy(roster.pinnedAccountSlot())
      ? roster.pinnedAccountSlot()
      : roster.nextHealthySlot(accounts);
    accountSlot = picked >= 0 ? picked : accounts[0].slot;
    const chosen = accounts.find((a) => a.slot === accountSlot) || accounts[0];
    if (chosen?.session) {
      session = chosen.session;
      sessionSource = 'roster';
      accountTag = chosen.tag;
    }
  }

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
    otpBotProfile: profile.id,
    otpBotProfileLabel: profile.label,
    otpBotTitle: profile.uiLabel,
    otpBotHint: profile.hint,
    otpBotExplicit: activeOtpBotExplicit && env === process.env,
    findButtonText: firstEnv(env, ['TELEGRAM_FIND_BUTTON_TEXT', 'Hermeshu_FIND_BUTTON_TEXT']),
    refreshButtonText: firstEnv(env, ['TELEGRAM_REFRESH_BUTTON_TEXT', 'Hermeshu_REFRESH_BUTTON_TEXT']),
    newButtonText: firstEnv(env, ['TELEGRAM_NEW_BUTTON_TEXT', 'Hermeshu_NEW_BUTTON_TEXT']),
    configured: missing.length === 0,
    missing,
    accountSlot,
    accountTag,
    accountCount,
    accounts,
  };
}

export function isTelegramOtpConfigured(env = process.env) {
  return getTelegramOtpConfig(env).configured;
}

export function resolveNumberSourceMode({ env = process.env, telegramSetting = false } = {}) {
  // Bot ke andar Hermes ON hai to wahi final hai. Render par purana
  // NUMBER_SOURCE=firebase bacha reh jaye tab bhi Hermes wale run me
  // Firebase pool/OTP galti se try nahi hona chahiye.
  if (telegramSetting) return 'telegram';
  const raw = firstEnv(env, ['NUMBER_SOURCE', 'PREMIUM_NUMBER_SOURCE', 'OTP_SOURCE']).toLowerCase();
  if (['telegram', 'hermes', 'hermeshu', 'hermeshu-bot', 'Hermeshu'].includes(raw)) return 'telegram';
  if (['firebase', 'firebase-pool', 'pool'].includes(raw)) return 'firebase';
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

export function telegramButtonRole(text = '', profileOrId = null) {
  const profile = profileOrId || getActiveOtpBotProfile();
  return otpBotButtonRole(text, profile);
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
  // Poori text wale fallback me bhi ID wali lines hata do. Screenshot wale
  // welcome card par `ID: 7458637854` khud valid 10-digit mobile jaisa hai;
  // use Hermes number samajhna claim ko galat phone par le ja sakta tha.
  const withoutIdLines = lines
    .filter((line) => !/^\s*(?:telegram\s*)?id\b/i.test(searchText(line)))
    .join('\n');
  return extractPhoneFromSegment(withoutIdLines);
}

function extractTelegramCardPhone(text = '') {
  const lines = normalizeTelegramFancyText(text).split(/\r?\n/);
  for (const line of lines) {
    const normalizedLine = searchText(line);
    if (!/\b(number|mobile|phone)\b/.test(normalizedLine)) continue;
    if (/\b(find|search|active numbers|live indian numbers)\b/.test(normalizedLine)) continue;
    const afterLabel = line.includes(':') ? line.slice(line.indexOf(':') + 1) : line;
    const phone = extractPhoneFromSegment(afterLabel) || extractPhoneFromSegment(line);
    if (phone) return phone;
  }
  return null;
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
  // Number card ke liye sirf explicit NUMBER/MOBILE/PHONE label wala phone
  // chalega. Welcome card ki Telegram ID ya koi aur 10-digit number ko
  // Hermes ka current number nahi mana jayega.
  const phone = extractTelegramCardPhone(text);
  if (!phone) return null;
  const signature = parsed.code
    ? [parsed.sender, parsed.code, parsed.smsTimeMs || parsed.rawTime, phone].join('|')
    : '';
  return {
    ...parsed,
    phone,
    signature,
    lastSms: parsed.lastSms ? { ...parsed.lastSms, signature } : null,
  };
}

export function parseTelegramOtpText(text = '') {
  const parsed = parseHermesText(text);
  return parsed.code ? parsed : null;
}

export function extractTelegramOtpFromText(text = '') {
  return parseHermesText(text).code || '';
}

// Hermes ki sirf SABSE LATEST button-screen hi asal current screen hai.
// Purani number-card par chipka NEW NUMBER ya purani welcome par chipka
// FIND NUMBER stale hai — use click karna hi 4-minute wale claim-stuck ki
// ek asal wajah thi. Is selector ka rule bilkul owner ke instruction jaisa
// hai: latest screen par NEW ho to NEW, warna FIND. Latest screen par koi
// claim button na ho to purani screens me bilkul nahi ghusenge.
export function _selectHermesLatestScreenAction(screens = [], {
  mode = 'claim',
  phone = '',
  profileId = null,
} = {}) {
  // Dono OTP bots (Hermes / HardXotp) ke liye ek hi strict rule: sirf
  // sabse latest button-screen dekho — NEW ho to NEW, warna FIND
  // (HardXotp me GET NUMBERS). Purani screens ke stale buttons kabhi
  // click nahi hote.
  return selectOtpBotScreenAction(screens, {
    mode,
    phone,
    profileId: profileId || getActiveOtpBotProfile().id,
    cardPhoneOf: (text) => parseTelegramNumberCard(text)?.phone || '',
  });
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
  lastScreenButtons: [],
  lastClickedButton: '',
  lastClickedRole: '',
  lastCallbackMessage: '',
  claimPhase: '',
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
  const classified = classifyTelegramError(error);
  const raw = String(error?.message || error || '').slice(0, 190);
  providerState.lastErrorCode = classified.code;
  providerState.lastErrorHint = classified.hint;
  providerState.lastErrorLabel = classified.label;
  providerState.lastError = classified.code && classified.code !== 'UNKNOWN'
    ? `${classified.label} — ${raw}`
    : raw.slice(0, 220);
}

// ---------------------------------------------------------------------------
// Generic spare-account session hook — OTP bot ke ilawa doosre Telegram bots
// (jaise @SwiggyByWorldBot) ko bhi ISI client/lock par chalane ke liye.
// Ek hi session par do client = FLOOD_WAIT/session revoke, isliye lock shared.
// ---------------------------------------------------------------------------
export function withTelegramUserClient(fn) {
  return withTelegramLock(async () => {
    const { client, config } = await ensureClientUnlocked();
    return fn({ client, config });
  });
}

export async function telegramUserClientStatus() {
  try {
    const config = getTelegramOtpConfig();
    return {
      configured: Boolean(config.configured),
      missing: [...(config.missing || [])],
      connected: Boolean(providerState.connected),
      authorized: Boolean(providerState.authorized),
      me: providerState.meLabel || '',
      loginInProgress: Boolean(providerState.loginInProgress),
      lastError: providerState.lastError || '',
    };
  } catch (e) {
    return { configured: false, missing: [], connected: false, authorized: false, me: '', loginInProgress: false, lastError: String(e?.message || e) };
  }
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

export function _isTelegramClientConnectionError(error) {
  const msg = String(error?.message || error || '');
  return /(AUTH_KEY|SESSION_REVOKED|USER_DEACTIVATED|not connected|disconnected|Connection closed|ECONNRESET|EPIPE|socket|timed?\s*out|timeout|network)/i.test(msg);
}

function invalidateClient(error) {
  if (!_isTelegramClientConnectionError(error)) return;
  clientRef = null;
  clientPromise = null;
  entityRef = null;
  entityCacheKey = '';
  providerState.connected = false;
  providerState.authorized = false;
}

function telegramClientLooksConnected(client) {
  if (!client) return false;
  try {
    if (typeof client.connected === 'boolean') return client.connected;
    if (typeof client._connected === 'boolean') return client._connected;
    if (typeof client.isConnected === 'function') return Boolean(client.isConnected());
  } catch {}
  return true;
}

export { telegramClientLooksConnected as _telegramClientLooksConnected };

async function ensureClientUnlocked() {
  if (providerState.loginInProgress) {
    throw new Error('Telegram account login chal raha hai — pehle Add Telegram Account complete ya cancel karo.');
  }
  const config = getTelegramOtpConfig();
  if (!config.configured) {
    throw new Error(`Telegram Hermes setup missing hai: ${config.missing.join(', ')}`);
  }
  if (clientRef && providerState.connected && telegramClientLooksConnected(clientRef)) return { client: clientRef, config };
  if (clientRef && !telegramClientLooksConnected(clientRef)) {
    // Render/network jhatke ke baad Teleproto socket mar sakta hai lekin
    // providerState purana connected=true dikhata rehta tha — phir har
    // claim wahi murda client use karke batch ko exhausted bana deta tha.
    clientRef = null;
    clientPromise = null;
    entityRef = null;
    entityCacheKey = '';
    providerState.connected = false;
    providerState.authorized = false;
  }
  if (clientPromise) return clientPromise;

  clientPromise = (async () => {
    const client = await createTelegramUserClient(config.session, config);
    await client.connect();
    const authorized = await client.checkAuthorization();
    if (!authorized) {
      // Auth fail = ye account (session) mara hua hai — roster me mark karo
      // taaki agli claim doosra spare account uthaye, batch na ruke.
      roster.markAccountFailure(config.accountSlot, new Error('AUTH_KEY_UNREGISTERED session authorized nahi'));
      throw new Error('Telegram session authorized nahi hai — Settings → Add Telegram Account se spare account dobara login karo (ya local fallback: npm run telegram:login)');
    }
    let meLabel = '';
    try {
      const me = await client.getMe();
      meLabel = me?.username ? `@${me.username}` : [me?.firstName, me?.lastName].filter(Boolean).join(' ');
    } catch {}
    clientRef = client;
    roster.markAccountHealthy(config.accountSlot, { me: meLabel });
    Object.assign(providerState, {
      connected: true,
      authorized: true,
      meLabel,
      accountSlot: config.accountSlot,
      accountTag: config.accountTag,
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

// FIND / NEW ke baad sirf SABSE LATEST number-card hi try hogi.
// Purana wait saari history scan karke pehla aisa card utha sakta tha jo
// baseline (sirf 6 messages) me nahi tha — yani click se PEHLA wala number
// galti se "naya" ban jata tha. Ab pehli parseable latest card par hi
// faisla hoga: woh baseline/click se pehle ki hai to wait chalega, excluded
// hai to wahi latest excluded mani jayegi; usse peeche wale purane cards
// kabhi fallback ke roop me try nahi honge.
export function _selectLatestFreshHermesNumberCard(messages = [], {
  baselineSignatures = new Set(),
  excludePhones = new Set(),
  afterMessageId = 0,
  afterSignature = '',
  afterPhone = '',
} = {}) {
  const excluded = new Set(
    [...(excludePhones || [])]
      .map((phone) => String(phone || '').replace(/\D/g, '').slice(-10))
      .filter(Boolean)
  );
  const cursorId = Number(afterMessageId) || 0;
  const cursorPhone = String(afterPhone || '').replace(/\D/g, '').slice(-10);

  for (const message of Array.isArray(messages) ? messages : []) {
    const card = parseTelegramNumberCard(messageText(message));
    if (!card?.phone) continue;

    const signature = messageSignature(message);
    const result = { message, card, signature };
    if (baselineSignatures?.has?.(signature)) {
      return { status: 'baseline-latest', result };
    }

    const currentId = messageId(message);
    if (cursorId > 0 && currentId > 0) {
      if (currentId < cursorId) {
        return { status: 'before-click-latest', result };
      }
      if (currentId === cursorId) {
        // Clicked screen khud edit hokar naya card ban sakti hai. Wahi
        // purana phone/signature ho to ye click ka naya jawab nahi hai.
        if (!afterSignature || signature === afterSignature) {
          return { status: 'baseline-latest', result };
        }
        if (cursorPhone && card.phone === cursorPhone) {
          return { status: 'baseline-latest', result };
        }
      }
    }

    if (excluded.has(card.phone)) {
      return { status: 'excluded-latest', result };
    }
    return { status: 'fresh', result };
  }

  return { status: 'none', result: null };
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
  // Teleproto ke sync `buttons` getter se pehle dekho. Har purani message
  // par async getButtons()/reload ghumana claim ko bekaar slow karta tha;
  // asal action bhi sirf latest screen par hi lena hai.
  try { rows = message?.buttons; } catch {}
  if (!rows) {
    try {
      rows = typeof message?.getButtons === 'function'
        ? await message.getButtons()
        : null;
    } catch {}
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
  const profileId = config?.otpBotProfile || null;
  // 'view' HardXotp ka messages button hai; Hermes profile me ye role kabhi
  // nahi milta, isliye purana behaviour safe rehta hai.
  return telegramButtonRole(text, profileId) === role;
}

function roleForHermesButton(button, config) {
  // Kisi bhi profile me claim/find/new/refresh/view ho sakta hai (HardXotp
  // me "VIEW MESSAGES" hi refresh ka kaam karta hai).
  for (const role of ['refresh', 'view', 'new', 'find']) {
    if (buttonMatchesRole(button, role, config)) return role;
  }
  return '';
}

async function latestHermesScreenUnlocked(limit = 6) {
  const { config } = await ensureClientUnlocked();
  const messages = await fetchIncomingUnlocked(limit);
  for (const message of messages) {
    const buttons = await getMessageButtons(message);
    const entries = buttons
      .map((button) => ({
        button,
        text: buttonText(button),
        role: roleForHermesButton(button, config),
      }))
      .filter((entry) => entry.text);
    if (!entries.length) continue;

    const text = messageText(message);
    const screen = {
      message,
      text,
      entries,
      buttons: entries.map((entry) => entry.text),
      buttonRoles: entries.map((entry) => entry.role),
      card: parseTelegramNumberCard(text),
    };
    providerState.lastScreenButtons = [...screen.buttons];
    return screen;
  }
  providerState.lastScreenButtons = [];
  return null;
}

async function clickLatestHermesButtonUnlocked({ mode = 'claim', phone = '' } = {}) {
  const screen = await latestHermesScreenUnlocked(6);
  if (!screen) {
    providerState.claimPhase = 'no-latest-screen';
    return { ok: false, reason: 'no-latest-screen', screenButtons: [] };
  }

  const action = _selectHermesLatestScreenAction([screen], { mode, phone });
  providerState.claimPhase = action?.role
    ? `click-${action.role}`
    : (action?.reason || 'no-button-on-latest-screen');
  if (!action?.role || action.buttonIndex < 0) {
    console.log(`[Hermes] Latest screen par ${mode} button nahi mila. Buttons: ${screen.buttons.join(' | ') || 'none'}`);
    return {
      ok: false,
      reason: action?.reason || 'no-button-on-latest-screen',
      messageId: messageId(screen.message),
      screenButtons: [...screen.buttons],
      cardPhone: screen.card?.phone || '',
    };
  }

  const entry = screen.entries[action.buttonIndex];
  const answer = await entry.button.click({});
  const callbackMessage = String(answer?.message || '').trim().slice(0, 180);
  providerState.lastActionAt = Date.now();
  providerState.lastError = '';
  providerState.lastClickedButton = entry.text;
  providerState.lastClickedRole = action.role;
  providerState.lastCallbackMessage = callbackMessage;
  providerState.claimPhase = `clicked-${action.role}`;
  console.log(
    `[Hermes] Latest screen button click: ${entry.text} (${action.role})` +
    `${callbackMessage ? ` — callback: ${callbackMessage}` : ''}`
  );
  return {
    ok: true,
    role: action.role,
    messageId: messageId(screen.message),
    screenSignature: messageSignature(screen.message),
    buttonText: entry.text,
    screenButtons: [...screen.buttons],
    cardPhone: screen.card?.phone || '',
    callbackMessage,
    callbackAlert: Boolean(answer?.alert),
  };
}

async function clickButtonUnlocked(role, { phone = '' } = {}) {
  return clickLatestHermesButtonUnlocked({
    mode: role === 'refresh' ? 'refresh' : 'claim',
    phone,
  });
}

async function sendStartUnlocked() {
  const { client, config } = await ensureClientUnlocked();
  const entity = await ensureEntityUnlocked(client, config);
  await client.sendMessage(entity, { message: '/start' });
  providerState.lastActionAt = Date.now();
}

async function latestNumberCardUnlocked(excludePhones = new Set()) {
  const messages = await fetchIncomingUnlocked(20);
  // "Latest" ka matlab sach-much sabse nayi card hai. Woh excluded ho to
  // usse peeche wali purani card ko chup-chaap try nahi karenge.
  const selection = _selectLatestFreshHermesNumberCard(messages, { excludePhones });
  return selection.status === 'fresh' ? selection.result : null;
}

async function waitForNumberCardUnlocked({
  baselineSignatures = new Set(),
  excludePhones = new Set(),
  timeoutMs = 20_000,
  shouldAbort = null,
  afterMessageId = 0,
  afterSignature = '',
  afterPhone = '',
} = {}) {
  const deadline = Date.now() + Math.max(1_000, Number(timeoutMs) || 20_000);
  while (Date.now() < deadline) {
    if (typeof shouldAbort === 'function' && shouldAbort()) return null;
    const messages = await fetchIncomingUnlocked(20);
    const selection = _selectLatestFreshHermesNumberCard(messages, {
      baselineSignatures,
      excludePhones,
      afterMessageId,
      afterSignature,
      afterPhone,
    });
    if (selection.status === 'fresh') return selection.result;
    // Latest jawab aa chuka hai lekin consumed/excluded hai — poori wait
    // jalane ke bajaye obtain ko turant usi latest card par NEW chalane do.
    if (selection.status === 'excluded-latest') return null;
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
  const totalMs = Math.max(3_000, Number(timeoutMs) || 20_000);
  const deadline = Date.now() + totalMs;
  const remainingMs = () => Math.max(0, deadline - Date.now());
  const currentSignatures = async () => new Set(
    (await fetchIncomingUnlocked(20)).map(messageSignature)
  );

  if (!forceNew) {
    const existing = await latestNumberCardUnlocked(excludePhones);
    if (existing) return existing;
  }

  let baselineSignatures = await currentSignatures();
  let lastClaimCursor = { afterMessageId: 0, afterSignature: '', afterPhone: '' };
  const freshSinceBaseline = async () => {
    const messages = await fetchIncomingUnlocked(20);
    const selection = _selectLatestFreshHermesNumberCard(messages, {
      baselineSignatures,
      excludePhones,
      ...lastClaimCursor,
    });
    return selection.status === 'fresh' ? selection.result : null;
  };
  let sentStart = false;

  // Ek hi claim ke andar max 3 action cycles. Pehli click ka jawab 5s me
  // na aaye to poora 20s andhere me nahi jalega: latest screen dobara
  // padhkar sahi button, ya ek baar /start se welcome reset karke FIND.
  for (let cycle = 0; cycle < 3 && remainingMs() > 500; cycle++) {
    if (typeof shouldAbort === 'function' && shouldAbort()) return null;
    providerState.claimPhase = `latest-screen-cycle-${cycle + 1}`;
    const clicked = await clickLatestHermesButtonUnlocked({ mode: 'claim' });

    if (!clicked.ok) {
      if (sentStart || remainingMs() <= 1_500) break;
      sentStart = true;
      providerState.claimPhase = 'send-start';
      await sendStartUnlocked();
      await sleepInterruptibly(Math.min(900, remainingMs()), shouldAbort);
      const lateFresh = await freshSinceBaseline();
      if (lateFresh) return lateFresh;
      baselineSignatures = await currentSignatures();
      continue;
    }

    lastClaimCursor = {
      afterMessageId: Number(clicked.messageId) || 0,
      afterSignature: clicked.screenSignature || '',
      afterPhone: clicked.cardPhone || '',
    };

    const waitMs = cycle === 2
      ? remainingMs()
      : Math.min(5_000, remainingMs());
    const fresh = await waitForNumberCardUnlocked({
      baselineSignatures,
      excludePhones,
      timeoutMs: waitMs,
      shouldAbort,
      ...lastClaimCursor,
    });
    if (fresh) return fresh;
    if ((typeof shouldAbort === 'function' && shouldAbort()) || remainingMs() <= 500) return null;

    // Hermes ka jawab 5s wali pehli wait ke thik baad bhi aa sakta hai.
    // Baseline reset ya /start se pehle use pakdo, warna asal card chhup
    // jayega aur bot use NEW karke bekaar me agla number le lega.
    const lateFresh = await freshSinceBaseline();
    if (lateFresh) return lateFresh;

    baselineSignatures = await currentSignatures();
    const latestAny = await latestNumberCardUnlocked(new Set());
    if (latestAny?.card?.phone && excludePhones.has(latestAny.card.phone)) {
      // Hermes ne consumed/rejected number hi dikhaya hai — agle cycle me
      // usi latest card ka NEW NUMBER turant chalega, timeout nahi jalega.
      providerState.claimPhase = 'excluded-card-new-number';
      continue;
    }

    if (!sentStart && cycle === 0 && remainingMs() > 2_000) {
      sentStart = true;
      providerState.claimPhase = 'no-response-send-start';
      await sendStartUnlocked();
      await sleepInterruptibly(Math.min(900, remainingMs()), shouldAbort);
      const lateFreshAfterStart = await freshSinceBaseline();
      if (lateFreshAfterStart) return lateFreshAfterStart;
      baselineSignatures = await currentSignatures();
    }
  }

  if (!forceNew) return latestNumberCardUnlocked(excludePhones);
  return null;
}

function entryFromCard(result, config) {
  const { card, message } = result;
  const profile = getOtpBotProfile(config?.otpBotProfile || '');
  return {
    phone: card.phone,
    deviceId: `${profile.id}:${card.device || card.phone}`,
    telegramDevice: card.device || '',
    online: /^(ACTIVE|ONLINE)$/i.test(card.status || '') ? true : undefined,
    label: card.device ? `${profile.label} ${card.device}` : `${profile.label} Telegram`,
    joined: '',
    status: '',
    childKey: `telegram:${messageId(message)}`,
    noPatch: true,
    source: 'telegram',
    otpProvider: 'telegram',
    otpBotProfile: profile.id,
    otpBotLabel: profile.label,
    telegramBotUsername: config.botUsername,
    telegramMessageId: messageId(message),
  };
}

// Account badalne ke liye client band karo (ek hi waqt par ek account).
async function resetClientForSlotSwitch(reason = 'account-rotate') {
  try { await clientRef?.disconnect?.(); } catch {}
  clientRef = null;
  clientPromise = null;
  entityRef = null;
  entityCacheKey = '';
  providerState.connected = false;
  providerState.authorized = false;
  providerState.lastActionAt = Date.now();
  providerState.lastScreenButtons = [];
  providerState.claimPhase = reason;
}

// Ek account ke saath number claim — account pin ho jata hai taaki us number
// ka OTP/REFRESH bhi usi account se ho (doosre account ke chat me wo number
// hota hi nahi).
async function claimNumberWithActiveAccount(opts = {}) {
    const { config } = await ensureClientUnlocked();
    roster.pinSlot(Number(config.accountSlot) || 0);
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
        const screenButtons = providerState.lastScreenButtons?.length
          ? providerState.lastScreenButtons.join(' | ')
          : 'none';
        const clicked = providerState.lastClickedButton
          ? `last click ${providerState.lastClickedButton}`
          : 'koi click nahi ho paya';
        const callback = providerState.lastCallbackMessage
          ? `; callback: ${providerState.lastCallbackMessage}`
          : '';
        throw new Error(`@${config.botUsername} se number card nahi mila (latest screen: ${screenButtons}; ${clicked}${callback})`);
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
}

// Multi-account claim: agar active account PEER_FLOOD / FLOOD_WAIT / session
// dead nikle to us account ko side par rakh kar doosra spare account try karo.
// (Sirf claim par rotate — number mil jane ke baad account badalna galat hai,
// kyunki OTP usi account ke chat me aata hai.)
export async function getNextTelegramNumber(opts = {}) {
  return withTelegramLock(async () => {
    let lastAccountError = null;
    for (let accountAttempt = 0; accountAttempt < 2; accountAttempt++) {
      try {
        return await claimNumberWithActiveAccount(opts);
      } catch (error) {
        const classified = classifyTelegramError(error);
        const actionable = classified.fatal || classified.kind === 'flood' || classified.cooldownMs > 0;
        if (!actionable) throw error;
        const config = getTelegramOtpConfig();
        const slot = Number(config.accountSlot) || 0;
        roster.markAccountFailure(slot, error);
        lastAccountError = classified;
        const next = Number(config.accountCount) > 1
          ? roster.nextHealthySlot(config.accounts || [], { skipPinned: true })
          : -1;
        if (accountAttempt === 1 || next < 0 || next === slot) {
          throw new Error(`${classified.label}. ${classified.hint}`);
        }
        roster.pinSlot(next);
        await resetClientForSlotSwitch(`rotate-from-slot-${slot}`);
      }
    }
    throw new Error(`${lastAccountError?.label || 'Telegram account error'}. ${lastAccountError?.hint || ''}`.trim());
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

      const classified = lastError ? classifyTelegramError(lastError) : null;
      if (classified && (classified.fatal || classified.kind === 'flood')) {
        // Account hi block/flood hai — roster me mark karo taaki agli claim
        // doosra spare account uthaye.
        try { roster.markAccountFailure(getTelegramOtpConfig().accountSlot, lastError); } catch {}
      }
      return lastError
        ? {
          code: '',
          error: classified && classified.code !== 'UNKNOWN'
            ? `${classified.label} — ${String(lastError?.message || lastError).slice(0, 150)}`
            : `Telegram OTP wait fail: ${String(lastError?.message || lastError).slice(0, 180)}`,
          errorCode: classified?.code || '',
          hint: classified?.hint || '',
        }
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
    otpBotProfile: config.otpBotProfile || '',
    otpBotProfileLabel: config.otpBotProfileLabel || '',
    otpBotTitle: config.otpBotTitle || '',
    sessionFile: config.sessionFile,
    sessionSource: config.sessionSource,
    connected: providerState.connected,
    authorized: providerState.authorized,
    loginInProgress: Boolean(providerState.loginInProgress),
    me: providerState.meLabel,
    currentPhone: providerState.currentPhone,
    lastError: providerState.lastError,
    lastErrorCode: providerState.lastErrorCode || '',
    lastErrorLabel: providerState.lastErrorLabel || '',
    lastErrorHint: providerState.lastErrorHint || '',
    accountSlot: Number.isInteger(providerState.accountSlot) ? providerState.accountSlot : (config.accountSlot || 0),
    accountTag: config.accountTag || '',
    accounts: roster.rosterSummary(config.accounts || []),
    accountLines: roster.rosterSummary(config.accounts || []).accounts.map((a) => a.line),
    lastActionAt: providerState.lastActionAt,
    lastCheckedAt: providerState.lastCheckedAt,
    lastScreenButtons: [...(providerState.lastScreenButtons || [])],
    lastClickedButton: providerState.lastClickedButton || '',
    lastClickedRole: providerState.lastClickedRole || '',
    lastCallbackMessage: providerState.lastCallbackMessage || '',
    claimPhase: providerState.claimPhase || '',
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
      accountSlot: config.accountSlot,
      accountTag: config.accountTag,
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

// ---------------------------------------------------------------------------
// 🔍 Account audit — har spare account ko alag-alag test karo.
//   npm run telegram:audit
// Ye batata hai kaun sa account (a) connect hota hai, (b) authorized hai,
// (c) OTP bot ka chat khol pata hai, (d) kaun se buttons dikh rahe hain.
// Yhi "kaun sa account kharab hai" ka seedha jawab hai.
// ---------------------------------------------------------------------------
export async function auditTelegramAccounts() {
  const base = getTelegramOtpConfig();
  const accounts = base.accounts || [];
  const results = [];
  if (!accounts.length) {
    return [{ slot: 0, tag: '', ok: false, stage: 'config', error: 'Koi TELEGRAM_SESSION set nahi hai' }];
  }
  for (const account of accounts) {
    roster.pinSlot(account.slot);
    await resetClientForSlotSwitch(`audit-slot-${account.slot}`);
    const row = {
      slot: account.slot,
      label: `account ${account.slot + 1}`,
      envKey: account.envKey,
      tag: account.tag,
      ok: false,
      stage: 'connect',
      me: '',
      currentPhone: '',
      buttons: [],
      error: '',
      code: '',
      hint: '',
    };
    try {
      const status = await verifyTelegramOtpConnection({ skipDisconnect: true });
      row.ok = true;
      row.stage = 'ready';
      row.me = status?.me || '';
      row.currentPhone = status?.currentPhone || '';
      row.buttons = Array.isArray(status?.buttons) ? status.buttons : [];
      roster.markAccountHealthy(account.slot, { me: row.me });
    } catch (error) {
      const classified = classifyTelegramError(error);
      row.error = String(error?.message || error || '').slice(0, 200);
      row.code = classified.code;
      row.hint = classified.hint;
      row.stage = classified.kind === 'dead' || classified.kind === 'blocked' ? 'dead' : classified.kind;
      roster.markAccountFailure(account.slot, error);
    } finally {
      await resetClientForSlotSwitch(`audit-end-${account.slot}`);
    }
    results.push(row);
  }
  roster.unpinSlot();
  return results;
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
    lastScreenButtons: [],
    lastClickedButton: '',
    lastClickedRole: '',
    lastCallbackMessage: '',
    claimPhase: '',
  });
}
