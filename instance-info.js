// ============================================================================
// instance-info.js — EK codebase, KAI bot deployments
// ============================================================================
// Same repo do (ya zyada) jagah deploy karne par dono bots bilkul ek jaise
// dikhte hain — galti se doosre bot ka number/OTP samajh liya jaye to bada
// confusion. Isliye har deployment ko ek chhota label dete hain:
//
//   INSTANCE_LABEL=bot2        → title me "· bot2" dikhega
//   INSTANCE_LABEL khali       → kuch extra nahi (purana behaviour, main bot)
//
// Label sirf UI/log ke liye hai — koi behaviour isse nahi badalta.

export const DEFAULT_INSTANCE_LABEL = 'main';
export const INSTANCE_LABEL_MAX = 20;

// Sirf safe characters — Telegram HTML/`<code>` ke andar tootne wala kuch
// nahi, aur newline/emoji spam bhi nahi.
export function normalizeInstanceLabel(raw = '') {
  return String(raw ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[<>]/g, '')
    .trim()
    .replace(/\s{2,}/g, ' ')
    .slice(0, INSTANCE_LABEL_MAX);
}

export function getInstanceLabel(env = process.env) {
  return normalizeInstanceLabel(env?.INSTANCE_LABEL) || DEFAULT_INSTANCE_LABEL;
}

// Secondary = koi bhi label jo `main` nahi hai. UI sirf tab badge lagata hai,
// taaki purane deployment ka look exactly waisa hi rahe.
export function isSecondaryInstance(env = process.env) {
  return getInstanceLabel(env) !== DEFAULT_INSTANCE_LABEL;
}

// Plain-text suffix (caller khud escape/mono kare). Main instance par ''.
export function instanceSuffix(env = process.env) {
  const label = getInstanceLabel(env);
  return label === DEFAULT_INSTANCE_LABEL ? '' : ` · ${label}`;
}

// START card ka title.
export function instanceTitle(baseTitle, env = process.env) {
  return `${String(baseTitle || '').trim()}${instanceSuffix(env)}`;
}
