// Gold Drop API protocol based on the supplied PHP example. No automatic retries:
// register/verify can create an entry and must not be repeated on a timeout.
import { createHmac, randomInt, randomBytes } from 'node:crypto';
import { GoldDropCookieJar } from './gold-drop-cookies.js';

const BASE = 'https://golddropgolddhamaka.com/api';
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const b64 = value => Buffer.from(value, 'utf8').toString('base64');
// drop.py method: har request par fixed desktop-Chrome UA + browser jaise
// accept headers jaate hain — isi shape par site bina captcha ke accept karti hai.
const GOLD_DROP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ─── NoCaptchaAI — security check (Cloudflare Turnstile) solver ───
// Register par "Please complete the security check" aaye tabhi use hota hai.
// NOCAP_API_KEY env / bot Settings se override; 'off' = disabled.
const NOCAP_API = (process.env.NOCAP_API_BASE || 'https://api.nocaptchaai.com').replace(/\/+$/, '');
const NOCAP_KEY_DEFAULT = 'nocap_eVBzrYeejjgKLoikEErH6lbP';

async function nocapPost(pathname, apiKey, body, fetchImpl) {
  const res = await fetchImpl(`${NOCAP_API}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientKey: apiKey, ...body }),
    signal: AbortSignal.timeout(30000),
  });
  return res.json().catch(() => ({}));
}

// NoCaptchaAI ke error codes ko seedha-wajah wale message me badlo.
// (docs: errorId/errorCode 0 = ok; balance/wallet alag hai subscription se)
export function nocapExplain(result) {
  const code = String(result?.errorCode ?? result?.errorId ?? '');
  const desc = String(result?.errorDescription || result?.msg || '').trim();
  const text = `${code} ${desc}`.toUpperCase();
  if (/ZERO_BALANCE|INSUFFICIENT|NO_FUNDS/.test(text)) {
    return 'NoCaptchaAI wallet khaali hai — Turnstile alag pay-as-you-go hai ($0.0005/solve), subscription plan ise cover NAHI karta. nocaptchaai.com/manage/billing se wallet me $ top-up karo.';
  }
  if (/BAD_KEY|WRONG_USER_KEY|KEY_DOES_NOT_EXIST|AUTH/.test(text)) {
    return 'NoCaptchaAI key galat/invalid hai — nocaptchaai.com dashboard se key dobara copy karo.';
  }
  if (/INSUFFICIENT|BALANCE/.test(text)) return 'NoCaptchaAI balance khatam ho gaya.';
  if (/NO_SLOT|TOO_MUCH_REQUESTS|RATE|BUSY/.test(text)) return 'NoCaptchaAI busy hai (slot nahi mila) — thodi der baad retry.';
  if (code === '0') return desc;
  return desc || (code ? `NoCaptchaAI error ${code}` : '');
}

// createTask → getTaskResult poll → token. Loud error on failure.
export const NOCAP_TIMEOUT_MS = Number(process.env.NOCAP_TIMEOUT_MS) || 120000;

export async function nocapSolveTurnstile(apiKey, sitekey, pageUrl, { fetchImpl = fetch, timeoutMs = NOCAP_TIMEOUT_MS, sleepFn = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const errors = [];
  // Turnstile ke do type naam docs me chalte hain — jo pehle chale wahi use karo.
  for (const type of ['TurnstileTaskProxyLess', 'CloudflareTurnstileTaskProxyLess']) {
    let created;
    try {
      created = await nocapPost('/createTask', apiKey, { task: { type, websiteURL: pageUrl, websiteKey: sitekey } }, fetchImpl);
    } catch (error) { errors.push(`${type}: ${String(error?.message || error).slice(0, 120)}`); continue; }
    if ((created.errorId ?? 0) !== 0 || !created.taskId) {
      errors.push(`${type}: ${nocapExplain(created) || 'createTask fail'}`);
      continue; // key/balance ka error agle type par bhi aayega, reason list me rahega
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleepFn(2000);
      let result;
      try { result = await nocapPost('/getTaskResult', apiKey, { taskId: created.taskId }, fetchImpl); } catch { continue; }
      const status = String(result.status || '').toLowerCase();
      if (status === 'ready') {
        const token = result.solution?.token || '';
        if (token) return token;
        throw new Error('NoCaptchaAI ne ready par khali token diya — dobara try karo.');
      }
      if (status === 'failed') {
        throw new Error(`NoCaptchaAI solve fail: ${nocapExplain(result) || 'unknown'}`);
      }
    }
    throw new Error(`NoCaptchaAI ne ${Math.round(timeoutMs / 1000)}s me solve nahi kiya — thodi der baad dobara try karo (turnstile kabhi kabhi slow hota hai).`);
  }
  throw new Error(`NoCaptchaAI createTask fail: ${errors.filter(Boolean).join(' | ') || 'unknown'}`);
}

// Key + wallet live check — solve fail hone par exact reason batata hai.
export async function nocapCheckKey(apiKey, { fetchImpl = fetch } = {}) {
  let created;
  try {
    created = await nocapPost('/createTask', apiKey, { task: { type: 'TurnstileTaskProxyLess', websiteURL: 'https://golddropgolddhamaka.com/register', websiteKey: '0x4AAAAAAAdiagnosticProbe000000000000' } }, fetchImpl);
  } catch (error) {
    return { ok: false, taskId: '', message: `NoCaptchaAI tak nahi pahucha: ${String(error?.message || error).slice(0, 120)}` };
  }
  if ((created.errorId ?? 0) === 0 && created.taskId) {
    return { ok: true, taskId: created.taskId, message: `Key chal rahi hai ✅ (test task bana: ${created.taskId})` };
  }
  return { ok: false, taskId: '', message: nocapExplain(created) || 'Key check fail' };
}

const GOLD_DROP_REGISTER_URL = 'https://golddropgolddhamaka.com/register';

export function maskSitekey(key = '') {
  const value = String(key || '');
  return value.length > 14 ? `${value.slice(0, 10)}…${value.slice(-4)}` : value;
}

// Sitekeys runtime par site ke HTML/JS bundle se nikalo (kabhi guess nahi).
// SPA par page me aksar 1 se zyada Turnstile key hoti hain (widget, ads,
// dusra campaign) — pehla match galat ho sakta hai, isliye poori list.
// Order: data-sitekey attribute → HTML ke saare 0x4… → JS bundles.
export async function fetchTurnstileSitekeys(fetchImpl = fetch, pageUrl = GOLD_DROP_REGISTER_URL) {
  const read = async url => {
    const res = await fetchImpl(url, { headers: { 'user-agent': GOLD_DROP_UA, 'accept-language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(20000) });
    return res.text();
  };
  const keys = [];
  const add = key => { if (key && !keys.includes(key)) keys.push(key); };
  const html = await read(pageUrl).catch(error => {
    throw new Error(`Gold Drop page nahi khula: ${String(error?.message || error).slice(0, 120)}`);
  });
  // Cloudflare challenge page aaya to asli HTML hi nahi hai
  if (/Just a moment|cf-challenge|Attention Required/i.test(html) && !/0x4[0-9A-Za-z_-]{21,}/.test(html)) {
    throw new Error('Gold Drop ne HTML ki jagah Cloudflare challenge bheja — sitekey nahi mil sakti');
  }
  for (const m of html.matchAll(/data-sitekey=["'](0x4[0-9A-Za-z_-]{21,})["']/gi)) add(m[1]);
  for (const m of html.matchAll(/0x4[0-9A-Za-z_-]{21,}/g)) add(m[0]);
  if (!keys.length) {
    const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(x => x[1]);
    for (const src of scripts.slice(0, 8)) {
      try {
        const js = await read(new URL(src, pageUrl).href);
        for (const m of js.matchAll(/0x4[0-9A-Za-z_-]{21,}/g)) add(m[0]);
      } catch { /* agla bundle */ }
      if (keys.length) break;
    }
  }
  return keys.slice(0, 6);
}

// Back-compat: pehli sitekey.
export async function fetchTurnstileSitekey(fetchImpl = fetch, pageUrl = GOLD_DROP_REGISTER_URL) {
  const [first = ''] = await fetchTurnstileSitekeys(fetchImpl, pageUrl);
  return first;
}

// Ek hi jagah se "captcha kyun nahi hal hua" ka poora diagnosis.
export async function goldDropCaptchaPreflight(nocapApiKey, { fetchImpl = fetch, pageUrl = 'https://golddropgolddhamaka.com/register', skipKeyTest = false } = {}) {
  const key = String(nocapApiKey || '').trim();
  const out = { key: key ? `${key.slice(0, 10)}…${key.slice(-4)}` : '(none)', sitekey: '', sitekeyError: '', keyOk: null, keyMessage: '', pageOk: false, pageError: '' };
  if (!key || ['off', '0', 'none'].includes(key.toLowerCase())) {
    out.keyMessage = 'NoCaptchaAI key OFF hai — apni nocap_… key set karo.';
    out.keyOk = false;
  } else if (!skipKeyTest) {
    const check = await nocapCheckKey(key, { fetchImpl });
    out.keyOk = check.ok;
    out.keyMessage = check.message;
    out.probeTaskId = check.taskId || '';
  }
  try {
    out.sitekey = await fetchTurnstileSitekey(fetchImpl, pageUrl);
    out.pageOk = Boolean(out.sitekey);
    if (!out.sitekey) out.sitekeyError = 'Sitekey nahi mili (site ka HTML badal gaya)';
  } catch (error) {
    out.sitekeyError = String(error?.message || error).slice(0, 160);
  }
  return out;
}

// Gmail plus addressing keeps delivery in the original inbox while using six
// randomly selected digits from the current mobile number for each entry.
export function goldDropEmailForMobile(email, mobile, randomIndex = randomInt) {
  const match = /^([^@+]+)@(gmail\.com)$/i.exec(String(email));
  if (!match || !/^[6789]\d{9}$/.test(String(mobile))) throw new Error('Invalid Gold Drop email or mobile');
  const digits = [...String(mobile)];
  let suffix = '';
  for (let i = 0; i < 6; i++) {
    const index = randomIndex(digits.length);
    if (!Number.isInteger(index) || index < 0 || index >= digits.length) throw new Error('Invalid random index');
    suffix += digits.splice(index, 1)[0];
  }
  return `${match[1]}+${suffix}@${match[2]}`;
}

// Only known upstream OTP rejections should advance to another number.
// Unknown rate limits and transport failures must not trigger a retry loop.
function goldDropErrorMessage(error) {
  return String(error?.message || '').replace(/^Gold Drop HTTP \d+:\s*/i, '').trim()
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, '').trim();
}

export function isGoldDropDailyOtpLimit(error) {
  const message = goldDropErrorMessage(error);
  return /^(?:Your OTP limit for today is exhausted\.\s*)?Please try again tomorrow(?: using the same number)?[.!]?$/i.test(message);
}

export function isGoldDropInvalidOtp(error) {
  return /^Invalid OTP(?:\s*[,.:!-]\s*Please enter OTP)?[.!]?$/i.test(goldDropErrorMessage(error));
}

export function isGoldDropSecurityCheck(error) {
  return /^Please complete the security check to continue[.!]?$/i.test(goldDropErrorMessage(error));
}

// A security rejection may be temporary, but waiting does not solve a challenge.
// Retry only this explicit rejection, never timeouts/unknown errors, and stop
// after a bounded number of retries instead of repeatedly consuming numbers.
export async function retryGoldDropSecurity(operation, {
  maxRetries = 3, delayMs = 60000, shouldStop = () => false, onWait = async () => {},
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  for (let retries = 0; ; retries++) {
    if (shouldStop()) throw new Error('Gold Drop stopped');
    try { return await operation(); } catch (error) {
      if (!isGoldDropSecurityCheck(error) || retries >= maxRetries || shouldStop()) throw error;
      await onWait(retries + 1, maxRetries);
      let remaining = delayMs;
      while (remaining > 0 && !shouldStop()) {
        const ms = Math.min(1000, remaining);
        await sleep(ms);
        remaining -= ms;
      }
      if (shouldStop()) throw new Error('Gold Drop stopped');
    }
  }
}

export function signGoldDropPayload(fields, dataKey, userKey, timestamp = String(Date.now())) {
  const t = String(timestamp);
  const payload = b64(JSON.stringify({ ...fields, userKey: String(userKey), t }));
  const ts = b64(t);
  const digest = b64(createHmac('sha256', String(dataKey).slice(4, 18)).update(`${ts}.${payload}`).digest('hex'));
  const p = randomInt(1, 7);
  const m = randomInt(2, 9);
  let nonce = '';
  for (let i = 0; i < m; i++) nonce += ALPHABET[randomInt(ALPHABET.length)];
  return `${ts}.${payload}.${m}${p}${digest.slice(0, p)}${nonce}${digest.slice(p)}`;
}

export function unwrapGoldDropResponse(value) {
  if (typeof value?.resp === 'string') {
    try { return JSON.parse(Buffer.from(value.resp, 'base64').toString('utf8')); } catch { /* return original */ }
  }
  return value;
}

export class GoldDropClient {
  constructor({ fetchImpl = fetch, base = BASE, nocapApiKey = '', onStatus = null, nocapTimeoutMs = NOCAP_TIMEOUT_MS } = {}) {
    this.fetch = fetchImpl;
    this.base = base.replace(/\/$/, '');
    this.cookieJar = new GoldDropCookieJar(this.base);
    this.userKey = '';
    this.dataKey = '';
    const key = String(nocapApiKey || '').trim();
    this.nocapApiKey = ['off', '0', 'none'].includes(key.toLowerCase()) ? '' : (key || NOCAP_KEY_DEFAULT);
    this.onStatus = typeof onStatus === 'function' ? onStatus : () => {};
    this.nocapTimeoutMs = Number(nocapTimeoutMs) > 0 ? Number(nocapTimeoutMs) : NOCAP_TIMEOUT_MS;
    this._sitekeysCache = [];
  }

  async request(path, body, contentType, referer = 'https://golddropgolddhamaka.com/register') {
    const headers = {
      'accept': '*/*',
      'accept-language': 'en-US,en;q=0.9',
      'origin': 'https://golddropgolddhamaka.com',
      'referer': referer,
      'user-agent': GOLD_DROP_UA,
    };
    if (contentType) headers['content-type'] = contentType;
    const url = `${this.base}${path}`;
    const cookie = this.cookieJar.header(url, this.userKey);
    if (cookie) headers.Cookie = cookie;
    const response = await this.fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(45000) });
    this.cookieJar.store(response.headers, url);
    const raw = await response.text();
    let data;
    try { data = unwrapGoldDropResponse(JSON.parse(raw)); } catch { data = { raw }; }
    if (!response.ok) throw new Error(`Gold Drop HTTP ${response.status}: ${String(data?.message || 'request failed').slice(0, 200)}`);
    return data;
  }

  // drop.py init_session: sirf POST /api/users {} → userKey + dataKey.
  // Koi get-start call nahi, koi browser/warmup nahi.
  async bootstrap() {
    const body = await this.request('/users', JSON.stringify({}), 'application/json');
    if (!body?.userKey || !body?.dataKey) throw new Error(String(body?.message || 'Gold Drop bootstrap did not return session keys'));
    this.userKey = String(body.userKey);
    this.dataKey = String(body.dataKey);
  }

  async register({ name, mobile, email, pincode, code, image }) {
    if (!this.userKey || !this.dataKey) throw new Error('Bootstrap required');
    if (!/^[6789]\d{9}$/.test(mobile) || !/^\d{6}$/.test(pincode) || !name || !email || !code || !image?.length) throw new Error('Invalid registration details');
    const payload = { name, mobile, email, pincode, code, image };
    // Attempt 1: drop.py exact (bina captcha token). Sirf "security check"
    // rejection par NoCaptchaAI se Turnstile solve karke retry.
    try {
      return await this._registerOnce(payload, '');
    } catch (error) {
      if (!isGoldDropSecurityCheck(error)) throw error;
      // Key OFF ho to sitekey dhoondhne se pehle hi saaf jawab do.
      if (!this.nocapApiKey) {
        throw new Error('Security check maanga par NoCaptchaAI key OFF hai — Settings → 🛡️ NoCaptchaAI me key daalo.');
      }
      const sitekeys = await this._sitekeys();
      const tried = [];
      for (const sitekey of sitekeys) {
        const token = await this._solveSecurityToken(sitekey);
        try {
          return await this._registerOnce(payload, token);
        } catch (retryError) {
          // Site ne token ke bawajood wahi rejection diya → agla sitekey.
          if (!isGoldDropSecurityCheck(retryError)) throw retryError;
          tried.push(maskSitekey(sitekey));
          this.onStatus(`Sitekey ${maskSitekey(sitekey)} ka token site ne reject kiya`);
        }
      }
      throw new Error(
        `Security check site par hi clear nahi hua — ${tried.join(', ') || 'koi sitekey nahi'} ka solved token bhi site ne reject kiya. `
        + 'Site ko asli browser ki zaroorat hai (raw API par ye check clear nahi hota) — GOLD_DROP_BROWSER_REG=1 chalao.',
      );
    }
  }

  async _registerOnce({ name, mobile, email, pincode, code, image }, captchaToken) {
    const t = String(Date.now());
    const signed = signGoldDropPayload({ name, mobile, email, pincode, code, terms_accepted: '1' }, this.dataKey, this.userKey, t);
    const boundary = `----GoldDrop${randomBytes(16).toString('hex')}`;
    const captchaPart = captchaToken
      ? `\r\n--${boundary}\r\nContent-Disposition: form-data; name="cf-turnstile-response"\r\n\r\n${captchaToken}`
      : '';
    const chunks = [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="data"\r\n\r\n${signed}${captchaPart}\r\n--${boundary}\r\nContent-Disposition: form-data; name="img"; filename="sample.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), Buffer.from(image), Buffer.from(`\r\n--${boundary}--\r\n`)];
    const result = await this.request(`/users/register/${encodeURIComponent(this.userKey)}?t=${t}`, Buffer.concat(chunks), `multipart/form-data; boundary=${boundary}`);
    if (result?.statusCode !== 200) throw new Error(String(result?.message || 'Registration failed'));
    return result;
  }

  // Site par mili saari Turnstile sitekeys (cached) — pehli galat ho sakti hai.
  async _sitekeys() {
    if (!this._sitekeysCache?.length) {
      try {
        this._sitekeysCache = await fetchTurnstileSitekeys(this.fetch, GOLD_DROP_REGISTER_URL);
      } catch (error) {
        throw new Error(`Captcha solve nahi ho sakta — ${String(error?.message || error).slice(0, 160)}`);
      }
      if (!this._sitekeysCache.length) throw new Error('Captcha solve nahi ho sakta — site par Turnstile sitekey nahi mili (site ka HTML badla hai).');
      this.onStatus(`Site par ${this._sitekeysCache.length} sitekey mili: ${this._sitekeysCache.map(maskSitekey).join(', ')}`);
    }
    return this._sitekeysCache;
  }

  // Security check aaya → sitekeys site se → NoCaptchaAI se token.
  async _solveSecurityToken(sitekey) {
    if (!this.nocapApiKey) {
      throw new Error('Security check maanga par NoCaptchaAI key OFF hai — Settings → 🛡️ NoCaptchaAI me key daalo.');
    }
    const keyToUse = sitekey || (await this._sitekeys())[0];
    this.onStatus(`Security check aaya — NoCaptchaAI se solve ho raha hai (${maskSitekey(keyToUse)})…`);
    const token = await nocapSolveTurnstile(this.nocapApiKey, keyToUse, GOLD_DROP_REGISTER_URL, { fetchImpl: this.fetch, timeoutMs: this.nocapTimeoutMs });
    this.onStatus(`Security check solved ✅ (${maskSitekey(keyToUse)}) — register dobara bhej rahe hain`);
    return token;
  }

  async verifyOtp(otp) {
    if (!this.userKey || !this.dataKey) throw new Error('Bootstrap required');
    if (!/^\d{6}$/.test(otp)) throw new Error('OTP must be six digits');
    const t = String(Date.now());
    const data = signGoldDropPayload({ otp }, this.dataKey, this.userKey, t);
    const result = await this.request(`/users/verify-otp/${encodeURIComponent(this.userKey)}?t=${t}`, JSON.stringify({ data }), 'application/json', 'https://golddropgolddhamaka.com/otp');
    if (result?.statusCode !== 200) throw new Error(String(result?.message || 'OTP verification failed'));
    return result;
  }
}
