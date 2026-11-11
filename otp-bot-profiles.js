// ===== 📨 OTP BOT PROFILES — ek hi session, kai OTP bots =====
//
// Owner ke paas ye OTP bots hain:
//   1) @HermeshuOTPROBOT  — FIND NUMBER → number card → (NEW NUMBER) → REFRESH
//   2) @Hathi_otp_bot     — Hermes jaisa hi (FIND/NEW NUMBER card → REFRESH)
//   3) @HardXotp_Bot      — GET NUMBERS → "ASSIGNED NUMBER" card →
//                            VIEW MESSAGES / NEW NUMBER (SMS khud aata hai)
//
// Sabka mehnat ek hi hai (number lo → Swiggy OTP bhejo → 20s wait →
// OTP aaya to use karo, warna NEW NUMBER se agla lo), sirf button ke naam
// aur card ke labels badalte hain. Isliye yahan sirf woh cheezein rakhi
// hain: username, button → role mapping, aur UI labels. Baaki saara
// claim/OTP logic (telegram-otp-source.js) sabke liye same rehta hai.
//
// YE FILE PURE HAI (network/session nahi) — isliye test karna aasan hai.

export const OTP_BOT_PROFILE_IDS = ['hermes', 'hathi', 'chauhan'];

export const OTP_BOT_PROFILES = {
  hermes: {
    id: 'hermes',
    label: 'Hermes',
    uiLabel: '📨 Hermeshu',
    emoji: '📨',
    username: 'HermeshuOTPROBOT',
    // Claim par ye order: latest screen par NEW NUMBER ho to woh, warna
    // FIND NUMBER. Owner ka exact instruction.
    claimPreference: ['new', 'find'],
    // Refresh ke liye sirf REFRESH button (Hermes card sabse upar).
    refreshRoles: ['refresh'],
    refreshLabel: 'REFRESH',
    // Button na mile / click na chale to yahi text bhej kar refresh hota hai.
    refreshText: 'Refresh',
    // Welcome/card buttons jo kuch bhi karte hon unhe ignore karo.
    ignoreRolePatterns: [],
    startCommand: '/start',
    hint: 'FIND NUMBER → card → OTP SHOWN → REFRESH',
  },
  // @Hathi_otp_bot — Hermeshu wale bot jaisa hi card/buttons (owner ka
  // instruction: "same hermeshu wale bot ki tarah work kare"). Isliye isme
  // sirf username badla hai; claim/refresh ka behaviour bilkul same hai.
  hathi: {
    id: 'hathi',
    label: 'Hathi',
    uiLabel: '🐘 Hathi OTP',
    emoji: '🐘',
    username: 'Hathi_otp_bot',
    claimPreference: ['new', 'find'],
    refreshRoles: ['refresh'],
    refreshLabel: 'REFRESH',
    // Button na mile / click na chale to yahi text bhej kar refresh hota hai.
    refreshText: 'Refresh',
    ignoreRolePatterns: [],
    startCommand: '/start',
    hint: 'FIND NUMBER → card → OTP SHOWN → REFRESH',
  },
  chauhan: {
    id: 'chauhan',
    label: 'HardXotp',
    uiLabel: '🔐 HardXotp (Chauhan)',
    emoji: '🔐',
    username: 'HardXotp_Bot',
    claimPreference: ['new', 'find'],
    // Chauhan bot me alag REFRESH button nahi hota — "VIEW MESSAGES" hi
    // naya SMS dekhne/refresh karne ka rasta hai.
    refreshRoles: ['refresh', 'view'],
    refreshLabel: 'VIEW MESSAGES',
    refreshText: 'View Messages',
    // GET NUMBERS = naya number maango (FIND NUMBER jaisa hi).
    extraRoleMatchers: [
      { role: 'view', re: /\b(view|show|check)\s+(messages?|sms|inbox)\b|\bmessages?\b|\binbox\b/ },
    ],
    ignoreRolePatterns: [/\blive\s+stats\b/, /\bfind\s+device\b/, /\bback\b/],
    startCommand: '/start',
    hint: 'GET NUMBERS → ASSIGNED NUMBER → VIEW MESSAGES / NEW NUMBER',
  },
};

export const DEFAULT_OTP_BOT_PROFILE_ID = 'hermes';

// ---------------------------------------------------------------------------
// 🎓 CUSTOM BOT PROFILES — owner UI se add/train kiye gaye bots.
// custom-bots.js (jo store dekhta hai) boot par apna provider register karta
// hai; is file ko PURE rehne dene ke liye direct import nahi, DI use karte hain.
// Provider register na ho (unit tests) to list hamesha khali = purana behaviour.
// ---------------------------------------------------------------------------
let customProfileProvider = null;
export function registerOtpBotProfileProvider(provider) {
  customProfileProvider = typeof provider === 'function' ? provider : null;
}
function customProfiles() {
  try {
    const list = customProfileProvider ? customProfileProvider() : [];
    if (!Array.isArray(list)) return [];
    return list.filter((p) => p && p.id && p.username);
  } catch {
    return [];
  }
}
function customProfileById(id = '') {
  const key = String(id || '').trim().toLowerCase();
  if (!key) return null;
  return customProfiles().find((p) => String(p.id).toLowerCase() === key) || null;
}
function customProfileByUsername(handle = '') {
  const key = String(handle || '').trim().toLowerCase();
  if (!key) return null;
  return customProfiles().find((p) => String(p.username).toLowerCase() === key) || null;
}

export function normalizeOtpBotProfileId(value = '') {
  const key = String(value || '').trim().toLowerCase().replace(/^@+/, '');
  if (!key) return DEFAULT_OTP_BOT_PROFILE_ID;
  if (OTP_BOT_PROFILES[key]) return key;
  // Username/handle se bhi pehchaan lo (env me @HardXotp_Bot likha ho to bhi).
  for (const profile of Object.values(OTP_BOT_PROFILES)) {
    if (key === String(profile.username).toLowerCase()) return profile.id;
  }
  // Custom trained bots (id ya username se).
  const custom = customProfileById(key) || customProfileByUsername(key);
  if (custom) return String(custom.id).toLowerCase();
  if (/hard\s*x?\s*otp|chauhan/.test(key)) return 'chauhan';
  if (/hathi|haathi|elephant/.test(key)) return 'hathi';
  if (/hermes/.test(key)) return 'hermes';
  return DEFAULT_OTP_BOT_PROFILE_ID;
}

// UI ke liye ordered list — START picker aur Settings dono isi se bante hain,
// taaki naya bot add karne par dono jagah khud aa jaye.
export function listOtpBotProfiles() {
  return [...OTP_BOT_PROFILE_IDS.map((id) => OTP_BOT_PROFILES[id]).filter(Boolean), ...customProfiles()];
}

export function getOtpBotProfile(value = '') {
  const key = String(value || '').trim().toLowerCase().replace(/^@+/, '');
  if (OTP_BOT_PROFILES[key]) return OTP_BOT_PROFILES[key];
  const custom = customProfileById(key) || customProfileByUsername(key);
  if (custom) return custom;
  return OTP_BOT_PROFILES[normalizeOtpBotProfileId(key)] || OTP_BOT_PROFILES[DEFAULT_OTP_BOT_PROFILE_ID];
}

// Profile id/username hi valid choice hai (START picker ki whitelist).
export function isOtpBotProfileId(value = '') {
  const key = String(value || '').trim().toLowerCase();
  if (OTP_BOT_PROFILE_IDS.includes(key)) return true;
  return Boolean(customProfileById(key));
}

export function otpBotProfileForUsername(username = '') {
  const handle = String(username || '').trim().replace(/^@+/, '').toLowerCase();
  if (!handle) return null;
  for (const profile of Object.values(OTP_BOT_PROFILES)) {
    if (String(profile.username).toLowerCase() === handle) return profile;
  }
  return customProfileByUsername(handle);
}

// Fancy/small-caps text normalize (Hermes ka welcome card aisa hi hota hai).
const SMALL_CAPS_MAP = {
  'ᴀ': 'A', 'ʙ': 'B', 'ᴄ': 'C', 'ᴅ': 'D', 'ᴇ': 'E', 'ꜰ': 'F', 'ɢ': 'G',
  'ʜ': 'H', 'ɪ': 'I', 'ᴊ': 'J', 'ᴋ': 'K', 'ʟ': 'L', 'ᴍ': 'M', 'ɴ': 'N',
  'ᴏ': 'O', 'ᴘ': 'P', 'ʀ': 'R', 'ꜱ': 'S', 'ᴛ': 'T', 'ᴜ': 'U', 'ᴠ': 'V',
  'ᴡ': 'W', 'ʏ': 'Y', 'ᴢ': 'Z',
};

export function otpBotNormalizeText(text = '') {
  const decomposed = String(text ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
  return [...decomposed].map((ch) => SMALL_CAPS_MAP[ch] || ch).join('');
}

export function otpBotSearchText(text = '') {
  return otpBotNormalizeText(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Base (dono bots ke liye common) button → role mapping.
function baseButtonRole(normalized = '') {
  const n = normalized;
  if (!n) return '';
  if (/\b(refresh|reload|check otp|get otp|update)\b/.test(n)) return 'refresh';
  if (/\b(new|change|another|next)\b.*\bnumber\b/.test(n)) return 'new';
  // GET NUMBERS (Chauhan) bhi naya number maangna hi hai; plural allow.
  // SEARCH NUMBER / ACTIVE NUMBERS / FIND DEVICE ko FIND nahi maanna —
  // isliye verb lazmi hai.
  if (/\b(find|get|show|my|your)\s+numbers?\b/.test(n)) return 'find';
  return '';
}

// Kisi bhi OTP bot ke button ka role: 'new' | 'find' | 'refresh' | 'view' | ''
export function otpBotButtonRole(text = '', profileOrId = DEFAULT_OTP_BOT_PROFILE_ID) {
  const profile = typeof profileOrId === 'object' && profileOrId
    ? profileOrId
    : getOtpBotProfile(profileOrId);
  const n = otpBotSearchText(text);
  if (!n) return '';

  for (const re of profile.ignoreRolePatterns || []) {
    if (re.test(n)) return '';
  }
  for (const matcher of profile.extraRoleMatchers || []) {
    if (matcher.re.test(n)) return matcher.role;
  }
  const base = baseButtonRole(n);
  if (base) return base;
  return '';
}

// Latest screen par kya click karna hai. Latest = sabse nayi button-screen;
// purani screens par chipke buttons stale hain (owner ka rule).
export function selectOtpBotScreenAction(screens = [], {
  mode = 'claim',
  phone = '',
  profileId = DEFAULT_OTP_BOT_PROFILE_ID,
  cardPhoneOf = null,
} = {}) {
  const profile = getOtpBotProfile(profileId);
  const wantedPhone = String(phone || '').replace(/\D/g, '').slice(-10);
  const list = Array.isArray(screens) ? screens : [];

  for (let screenIndex = 0; screenIndex < list.length; screenIndex++) {
    const screen = list[screenIndex] || {};
    const rawButtons = Array.isArray(screen.buttons) ? screen.buttons : [];
    const buttons = rawButtons.map((button) => String(
      typeof button === 'string' ? button : button?.text || button?.button?.text || ''
    )).filter(Boolean);
    if (!buttons.length) continue;

    const roles = buttons.map((text, index) => String(
      screen.buttonRoles?.[index] || otpBotButtonRole(text, profile) || ''
    ));
    const cardPhone = typeof cardPhoneOf === 'function'
      ? (cardPhoneOf(screen.text || screen.message || '') || '')
      : '';
    const base = {
      screenIndex,
      buttons,
      roles,
      cardPhone,
      role: '',
      buttonIndex: -1,
      buttonText: '',
      reason: 'no-matching-button-on-latest-screen',
      profileId: profile.id,
    };

    if (mode === 'refresh') {
      if (wantedPhone && cardPhone && cardPhone !== wantedPhone) {
        return { ...base, reason: 'latest-screen-different-number' };
      }
      const allowed = profile.refreshRoles || ['refresh'];
      const buttonIndex = roles.findIndex((role) => allowed.includes(role));
      return buttonIndex >= 0
        ? { ...base, role: roles[buttonIndex], buttonIndex, buttonText: buttons[buttonIndex], reason: 'latest-screen' }
        : base;
    }

    const order = profile.claimPreference || ['new', 'find'];
    for (const wanted of order) {
      const buttonIndex = roles.indexOf(wanted);
      if (buttonIndex >= 0) {
        return {
          ...base,
          role: wanted,
          buttonIndex,
          buttonText: buttons[buttonIndex],
          reason: wanted === 'new' ? 'latest-screen-new' : 'latest-screen-find',
        };
      }
    }
    return base;
  }
  return null;
}

// Card se device/finder-key nikalna (label bot ke hisaab se badalta hai).
export function otpBotCardLabels(profileId = DEFAULT_OTP_BOT_PROFILE_ID) {
  const profile = getOtpBotProfile(profileId);
  if (profile.id === 'chauhan') {
    return {
      phone: ['assigned number', 'number', 'mobile', 'phone'],
      device: ['finder key', 'device'],
      status: ['status'],
      lastSms: ['last sms received', 'last sms'],
    };
  }
  return {
    phone: ['number', 'mobile', 'phone'],
    device: ['device'],
    status: ['status'],
    lastSms: ['last sms'],
  };
}
