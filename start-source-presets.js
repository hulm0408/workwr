// ===== 🚀 START SOURCE PRESETS — owner ke 3 buttons =====
//
// Owner ka exact rule (11 screenshots ke baad):
//   START dabane par teen source buttons dikhein:
//     1) HERMESHU + SWIGGYBYWORLD  (combined)
//     2) HATHI WALA BOT
//     3) SWIGGY BY WORLD
//
// Matlab: number + OTP kahan se aayega, aur Swiggy account kaun banayega.
//   • hermes_world → number+OTP @HermeshuOTPROBOT se, Swiggy ka kaam
//                    @SwiggyByworldBot ke buttons se (world bot engine).
//   • hathi        → number+OTP @Hathi_otp_bot se, Swiggy ka kaam bhi
//                    @SwiggyByworldBot ke buttons se (same world bot engine).
//   • world        → number+OTP Firebase pool se, Swiggy ka kaam
//                    @SwiggyByworldBot se.
//
// YE FILE PURE HAI (koi network/session nahi) — isliye test karna aasan hai.

import { OTP_BOT_PROFILE_IDS } from './otp-bot-profiles.js';

export const START_SOURCE_PRESET_IDS = ['hermes_world', 'hathi', 'world'];

export const START_SOURCE_PRESETS = {
  // 1) Hermes number/OTP + World Bot account
  hermes_world: {
    id: 'hermes_world',
    label: '🤝 HERMESHU + SWIGGYBYWORLD',
    shortLabel: 'Hermes + World',
    // Ye source engine ko jata hai: 'telegram' (OTP bot se claim)
    sourceMode: 'telegram',
    otpBotProfile: 'hermes',
    telegramOtpMode: true,
    accountEngine: 'worldbot',
    lines: [
      '📨 Number + OTP: <b>@HermeshuOTPROBOT</b>',
      '🌍 Swiggy login/delete: <b>@SwiggyByworldBot</b> (buttons click, no proxy)',
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
  return START_SOURCE_PRESET_IDS.includes(String(value || '').trim().toLowerCase());
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
  const patch = {
    telegramOtpMode: preset.telegramOtpMode === true,
    accountEngine: preset.accountEngine === 'worldbot' ? 'worldbot' : 'direct',
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
