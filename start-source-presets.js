// ===== 🚀 START SOURCE PRESETS — owner ke buttons =====
//
// Owner ka naya rule (2026-11-09):
//   "otp bot + chromium" aur "otp bot + swiggy world" — do saaf options.
//   Wajah: agar Swiggy World Bot kaam na kare to kam se kam Chromium wala
//   rasta to chale (number + OTP dono tab bhi OTP bot se hi aate hain).
//
// Matlab: number + OTP kahan se, aur Swiggy account kaun banayega.
//   • otp_chromium → number+OTP OTP bot (Hermes/Hathi) se, Swiggy ka kaam is
//                    bot ke apne bridge se (Chromium + proxy/WAF solver).
//   • otp_world    → number+OTP OTP bot se, Swiggy ka kaam
//                    @SwiggyByworldBot ke buttons se.
//   • hathi        → Hathi OTP bot chun kar + Swiggy World (same as otp_world
//                    par uska profile fix).
//   • world        → number+OTP Firebase pool se, Swiggy ka kaam World Bot se.
//   • hermes_world → purana id (legacy alias of otp_world) — purane buttons ka
//                    callback_data kaam karta rahe.
//
// YE FILE PURE HAI (koi network/session nahi) — isliye test karna aasan hai.

import { OTP_BOT_PROFILE_IDS } from './otp-bot-profiles.js';

// Pickers par ye buttons dikhte hain (order yahi rehta hai).
export const START_SOURCE_PRESET_IDS = ['toing_pro', 'otp_chromium', 'otp_world', 'hathi', 'world'];
// Purane id bhi valid rehte hain (chat me pada purana button dab jaye to).
export const LEGACY_START_SOURCE_PRESET_IDS = ['hermes_world', 'toing_hermes', 'toing_hathi'];

export const START_SOURCE_PRESETS = {
  // 0) 🌐 TOING PRO WEB SIGNUP — storelex.store/toing_web API flow
  toing_pro: {
    id: 'toing_pro',
    label: '🌐 TOING PRO WEB SIGNUP',
    shortLabel: 'Toing Pro Web',
    sourceMode: 'telegram',
    otpBotProfile: null,          // user can choose Hermes or Hathi
    telegramOtpMode: true,
    accountEngine: 'toing_pro',
    lines: [
      '🌐 Flow: <b>Toing Pro Web</b> (storelex.store API)',
      '📨 Number + OTP: <b>Hathi 🐘 ya Hermes 📨 bot</b>',
      '⚡ Auto new / old detection, OTP verify & session export',
    ],
  },
  toing_hermes: {
    id: 'toing_hermes',
    label: '🌐 TOING PRO + HERMES',
    shortLabel: 'Toing + Hermes',
    sourceMode: 'telegram',
    otpBotProfile: 'hermes',
    telegramOtpMode: true,
    accountEngine: 'toing_pro',
    lines: [
      '🌐 Flow: <b>Toing Pro Web</b> (storelex.store API)',
      '📨 Number + OTP: <b>@HermeshuOTPROBOT</b>',
    ],
  },
  toing_hathi: {
    id: 'toing_hathi',
    label: '🌐 TOING PRO + HATHI',
    shortLabel: 'Toing + Hathi',
    sourceMode: 'telegram',
    otpBotProfile: 'hathi',
    telegramOtpMode: true,
    accountEngine: 'toing_pro',
    lines: [
      '🌐 Flow: <b>Toing Pro Web</b> (storelex.store API)',
      '🐘 Number + OTP: <b>@Hathi_otp_bot</b>',
    ],
  },
  // 1) 🧩 OTP bot + CHROMIUM — number/OTP OTP bot se, account is bot ke apne
  //    Swiggy bridge (Chromium) se. Yehi fallback hai: World Bot na chale to
  //    batch isi se chalta rahega.
  otp_chromium: {
    id: 'otp_chromium',
    label: '🧩 OTP BOT + CHROMIUM',
    shortLabel: 'OTP bot + Chromium',
    sourceMode: 'telegram',
    otpBotProfile: null,          // jo OTP bot abhi chuna hai wahi rehta hai
    telegramOtpMode: true,
    accountEngine: 'direct',
    lines: [
      '📨 Number + OTP: <b>aapka OTP bot</b> (Hermes / Hathi)',
      '🧩 Swiggy login/create: <b>Chromium</b> — is bot ka apna bridge',
    ],
  },
  // 2) 🌍 OTP bot + SWIGGY WORLD — number/OTP OTP bot se, account
  //    @SwiggyByworldBot ke buttons se.
  otp_world: {
    id: 'otp_world',
    label: '🌍 OTP BOT + SWIGGY WORLD',
    shortLabel: 'OTP bot + World',
    sourceMode: 'telegram',
    otpBotProfile: null,          // jo OTP bot abhi chuna hai wahi rehta hai
    telegramOtpMode: true,
    accountEngine: 'worldbot',
    lines: [
      '📨 Number + OTP: <b>aapka OTP bot</b> (Hermes / Hathi)',
      '🌍 Swiggy login/delete: <b>@SwiggyByworldBot</b> (buttons click)',
    ],
  },
  // 3) Legacy alias — purane "HERMESHU + SWIGGYBYWORLD" button ka id.
  hermes_world: {
    id: 'hermes_world',
    label: '🤝 HERMESHU + SWIGGYBYWORLD',
    shortLabel: 'Hermes + World',
    sourceMode: 'telegram',
    otpBotProfile: 'hermes',
    telegramOtpMode: true,
    accountEngine: 'worldbot',
    lines: [
      '📨 Number + OTP: <b>@HermeshuOTPROBOT</b>',
      '🌍 Swiggy login/delete: <b>@SwiggyByworldBot</b> (buttons click)',
    ],
  },
  // 2) Hathi number/OTP + World Bot account (owner: "HATHI WALA BOT BHI
  //    SWIGGY BY WORLD KE SAATH HOGA")
  hathi: {
    id: 'hathi',
    label: '🐘 HATHI WALA BOT',
    shortLabel: 'Hathi + World',
    sourceMode: 'telegram',
    otpBotProfile: 'hathi',
    telegramOtpMode: true,
    accountEngine: 'worldbot',
    lines: [
      '🐘 Number + OTP: <b>@Hathi_otp_bot</b>',
      '🌍 Swiggy login/delete: <b>@SwiggyByworldBot</b> (buttons click, no proxy)',
    ],
  },
  // 3) Firebase number/OTP + World Bot account
  world: {
    id: 'world',
    label: '🌍 SWIGGY BY WORLD',
    shortLabel: 'Swiggy by World',
    sourceMode: 'firebase',
    otpBotProfile: null,
    telegramOtpMode: false,
    accountEngine: 'worldbot',
    lines: [
      '🔥 Number + OTP: <b>Firebase pool</b> (device scan + SMS inbox)',
      '🌍 Swiggy login/delete: <b>@SwiggyByworldBot</b> (buttons click, no proxy)',
    ],
  },
};

export function isStartSourcePresetId(value = '') {
  const id = String(value || '').trim().toLowerCase();
  return START_SOURCE_PRESET_IDS.includes(id) || LEGACY_START_SOURCE_PRESET_IDS.includes(id);
}

// Purana id → naya id (purane button dabne par bhi sahi option chale).
export function canonicalStartSourcePresetId(value = '') {
  const id = String(value || '').trim().toLowerCase();
  if (id === 'hermes_world') return 'otp_world';
  return id;
}

export function listStartSourcePresets() {
  return START_SOURCE_PRESET_IDS.map((id) => START_SOURCE_PRESETS[id]).filter(Boolean);
}

export function getStartSourcePreset(value = '') {
  const id = String(value || '').trim().toLowerCase();
  if (START_SOURCE_PRESETS[id]) return START_SOURCE_PRESETS[id];
  return null;
}

// Preset → settings patch (bs.setSetting ko jo dena hai).
export function startSourcePresetSettings(preset = null) {
  if (!preset) return null;
  const engine = preset.accountEngine === 'worldbot'
    ? 'worldbot'
    : (preset.accountEngine === 'toing_pro' ? 'toing_pro' : 'direct');
  const patch = {
    telegramOtpMode: preset.telegramOtpMode === true,
    accountEngine: engine,
  };
  if (preset.otpBotProfile && OTP_BOT_PROFILE_IDS.includes(preset.otpBotProfile)) {
    patch.otpBotProfile = preset.otpBotProfile;
  }
  return patch;
}

// Callback data / log ke liye chhota naam.
export function startSourcePresetLine(preset = null) {
  if (!preset) return '';
  return `${preset.label} → number/OTP ${preset.sourceMode === 'telegram' ? preset.otpBotProfile : 'firebase'} · engine ${preset.accountEngine}`;
}
