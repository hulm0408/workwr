// ============================================================================
// telegram-account-health.js — Telegram ke asli error ko saaf wajah me badlo
// ============================================================================
// Pehle har MTProto error ek hi generic line ban jata tha
// ("Hermes connection error"), isliye pata hi nahi chalta tha ki:
//   • account bot ko message bhej hi nahi sakta (PEER_FLOOD)
//   • rate-limit chal raha hai aur kitni der (FLOOD_WAIT_X)
//   • session mar gaya (AUTH_KEY_*, SESSION_REVOKED)
//   • ya sirf network ka jhatka hai (retry se theek)
//
// Ye module pure hai (koi network nahi) — unit tested.

const NETWORK_RE = /(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket|not connected|Connection closed|disconnected|timed?\s*out|timeout|network|fetch failed)/i;

// Telegram error strings me code "PEER_FLOOD" ya "FLOOD_WAIT_123" jaisa hota
// hai — message ke andar ya error_code ke saath.
export function telegramErrorCode(error) {
  const msg = String(error?.message ?? error ?? '');
  const explicit = String(error?.errorMessage || error?.code || '').trim();
  const pool = `${explicit} ${msg}`;
  const direct = pool.match(/\b(PEER_FLOOD|FLOOD_WAIT(?:_\d+)?|AUTH_KEY_UNREGISTERED|AUTH_KEY_DUPLICATED|AUTH_KEY_INVALID|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED_BAN|USER_DEACTIVATED|CHAT_WRITE_FORBIDDEN|CHAT_ADMIN_REQUIRED|USER_BANNED_IN_CHANNEL|PHONE_NUMBER_BANNED|PHONE_CODE_EXPIRED|PHONE_CODE_INVALID|BOT_METHOD_INVALID|MESSAGE_ID_INVALID|BUTTON_INVALID|BUTTON_NOT_FOUND|DATA_INVALID|RPC_CALL_FAIL|TIMEOUT|CONNECTION_NOT_INITED)\b/i);
  if (direct) return direct[1].toUpperCase();
  if (/not a valid string|invalid string session|invalid session|bad session|session string/i.test(msg)) {
    return 'SESSION_INVALID';
  }
  if (NETWORK_RE.test(msg)) return 'NETWORK';
  return 'UNKNOWN';
}

export function floodWaitSeconds(code, error) {
  const msg = String(error?.message ?? error ?? '');
  const direct = /FLOOD_WAIT_(\d+)/i.exec(code || '') || /FLOOD_WAIT_(\d+)/i.exec(msg);
  if (direct) return Math.max(1, Number(direct[1]) || 1);
  const seconds = Number(error?.seconds);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 0;
}

const NOUN = {
  flood: 'Rate-limit',
  'peer-flood': 'Bot ko message bhejna block',
  dead: 'Session mar gaya',
  blocked: 'Bot ne block kiya',
  network: 'Network jhatka',
  unknown: 'Anjaan error',
};

// kind: account ko kitni der side par rakhna hai + user ko kya karna hai.
export function classifyTelegramError(error) {
  const code = telegramErrorCode(error);
  const base = { code, raw: String(error?.message ?? error ?? '').slice(0, 220), seconds: 0 };

  if (code === 'PEER_FLOOD') {
    return {
      ...base,
      kind: 'peer-flood',
      fatal: true,
      cooldownMs: 6 * 60 * 60_000,
      label: 'PEER_FLOOD — ye account Telegram bots ko message nahi bhej sakta',
      hint: 'Spare account naya hai ya bahut messages bhej chuka hai. 6-24 ghante warm-up karo, ya koi doosra spare account lagao. (Number/OTP ka koi dosh nahi.)',
    };
  }
  if (code === 'FLOOD_WAIT' || code.startsWith('FLOOD_WAIT_')) {
    const seconds = floodWaitSeconds(code, error);
    return {
      ...base,
      seconds,
      kind: 'flood',
      fatal: false,
      cooldownMs: Math.max(60_000, seconds * 1000),
      label: seconds ? `FLOOD_WAIT ${Math.ceil(seconds / 60)} min` : 'FLOOD_WAIT',
      hint: seconds
        ? `Telegram ne is account par ${Math.ceil(seconds / 60)} min ka rate-limit lagaya hai. Usi der ke liye dusra spare account use karo — rukna nahi padta.`
        : 'Telegram ne is account par thodi der ka rate-limit lagaya hai — dusra account use karo.',
    };
  }
  if (code === 'AUTH_KEY_DUPLICATED') {
    return {
      ...base,
      kind: 'dead',
      fatal: true,
      cooldownMs: 24 * 60 * 60_000,
      label: 'AUTH_KEY_DUPLICATED — yahi session do jagah chalu hai',
      hint: 'Ek hi TELEGRAM_SESSION do bots me hai (ya do jagah chal rahi hai). Har bot ka apna account/session rakho, warna Telegram dono ko reject karta rahega.',
    };
  }
  if (code === 'AUTH_KEY_UNREGISTERED' || code === 'SESSION_REVOKED' || code === 'SESSION_EXPIRED' || code === 'AUTH_KEY_INVALID') {
    return {
      ...base,
      kind: 'dead',
      fatal: true,
      cooldownMs: 24 * 60 * 60_000,
      label: `${code} — session revoke/expire ho gaya`,
      hint: 'Settings → Add Telegram Account se isi account ko dobara login karo (ya naya session env me daalo). Baaki accounts isse alag chalte rahenge.',
    };
  }
  if (code === 'USER_DEACTIVATED_BAN' || code === 'USER_DEACTIVATED' || code === 'PHONE_NUMBER_BANNED') {
    return {
      ...base,
      kind: 'dead',
      fatal: true,
      cooldownMs: 24 * 60 * 60_000,
      label: `${code} — account Telegram par ban/deactivate hai`,
      hint: 'Ye account ab kabhi kaam nahi karega. Naya spare account lo (free SIM/eSIM) aur uski session daalo.',
    };
  }
  if (code === 'CHAT_WRITE_FORBIDDEN' || code === 'USER_BANNED_IN_CHANNEL' || code === 'CHAT_ADMIN_REQUIRED') {
    return {
      ...base,
      kind: 'blocked',
      fatal: true,
      cooldownMs: 24 * 60 * 60_000,
      label: `${code} — OTP bot ne is account se likhna band kar diya`,
      hint: 'Us OTP bot ne is account ko restrict/block kiya hai. Doosra spare account use karo (ya doosra OTP bot profile chuno).',
    };
  }
  if (code === 'SESSION_INVALID') {
    return {
      ...base,
      kind: 'dead',
      fatal: true,
      cooldownMs: 24 * 60 * 60_000,
      label: 'Session string adhuri/galat hai',
      hint: 'TELEGRAM_SESSION ki value poori copy nahi hui (ya beech me space/newline aa gaya). my.telegram.org / login se poora string dobara paste karo — aadha string kabhi connect nahi hoga.',
    };
  }
  if (code === 'NETWORK') {
    return {
      ...base,
      kind: 'network',
      fatal: false,
      cooldownMs: 15_000,
      label: 'Network/timeout — Telegram se baat nahi hui',
      hint: 'Ye account ka dosh nahi; 15s baad wahi account dobara try hoga. Render free par restart/neend ki wajah se bhi aata hai.',
    };
  }
  if (code === 'MESSAGE_ID_INVALID' || code === 'BUTTON_INVALID' || code === 'BUTTON_NOT_FOUND' || code === 'DATA_INVALID' || code === 'RPC_CALL_FAIL') {
    return {
      ...base,
      kind: 'unknown',
      fatal: false,
      cooldownMs: 0,
      label: `${code} — OTP bot ka button/screen badal gaya`,
      hint: 'Screen ka purana message ya button expire ho gaya. Agli claim par naya screen padha jayega; bar-bar aaye to /diag ke Last buttons bhejo.',
    };
  }
  return {
    ...base,
    kind: 'unknown',
    fatal: false,
    cooldownMs: 0,
    label: 'Anjaan error',
    hint: 'Poora message /diag me Last error me dikhta hai — wahi bhejo, phir exact wajah batata hoon.',
  };
}

// Account state ka ek line — /diag aur audit dono isi se print karte hain.
export function accountStateLine(state = {}, now = Date.now()) {
  const status = String(state.status || 'ready');
  const tag = String(state.tag || '').slice(0, 10) || '—';
  const leftMs = Math.max(0, Number(state.until || 0) - now);
  const left = leftMs > 0
    ? (leftMs >= 3_600_000 ? `${Math.ceil(leftMs / 3_600_000)}h` : `${Math.max(1, Math.ceil(leftMs / 60_000))}m`)
    : '';
  const icon = status === 'ready' ? '✅' : status === 'cooldown' ? '⏳' : '⛔';
  const detail = state.code ? ` · ${state.code}` : '';
  const wait = left ? ` · ${left} baaki` : '';
  const name = state.label ? ` (${state.label})` : '';
  return `${icon} account ${Number.isInteger(state.slot) ? state.slot + 1 : '?'} · ${tag}${detail}${wait}${name}`;
}

export const _TELEGRAM_ERROR_LABELS = NOUN;
