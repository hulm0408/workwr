// 🟡 Gold Drop — hub ke andar reuse (gold-drop-vercel/api/_gold-drop.js ka copy).
// VERCEL serverless backend (drop.py direct-API method).
// Koi browser nahi: POST /api/users {} → HMAC signed token → multipart
// register (data+img) → verify-otp. Security check aaye to NoCaptchaAI se
// Turnstile solve → cf-turnstile-response ke saath 1 retry.
import { randomBytes, createHmac } from 'node:crypto';

const BASE = (process.env.GOLD_DROP_API_BASE || 'https://golddropgolddhamaka.com/api').replace(/\/+$/, '');
const GOLD_DROP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const NOCAP_API = (process.env.NOCAP_API_BASE || 'https://api.nocaptchaai.com').replace(/\/+$/, '');
// Turnstile solve aksar 60-90s leta hai — default 120s (env se badal sakte ho).
const NOCAP_TIMEOUT_MS = Number(process.env.NOCAP_TIMEOUT_MS) || 120000;
const NOCAP_KEY_DEFAULT = process.env.NOCAP_API_KEY || 'nocap_eVBzrYeejjgKLoikEErH6lbP';
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const b64 = value => Buffer.from(value, 'utf8').toString('base64');

// ─── Signing (drop.py ke signer ke exactly same) ───
function signPayload(payload, dataKey, userKey, t) {
  const ts = b64(String(t));
  const json = JSON.stringify({ ...payload, userKey, t: String(t) });
  const digest = createHmac('sha256', String(dataKey).slice(4, 18)).update(`${ts}.${b64(json)}`).digest('hex');
  const p = 1 + (digest.length % 6); // 1..6
  const m = 2 + (digest.charCodeAt(0) % 7); // 2..8
  let nonce = '';
  for (let i = 0; i < m; i++) nonce += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return `${ts}.${b64(json)}.${m}${p}${digest.slice(0, p)}${nonce}${digest.slice(p)}`;
}

function unwrapResponse(data) {
  if (data && typeof data.resp === 'string') {
    try { return JSON.parse(Buffer.from(data.resp, 'base64').toString('utf8')); } catch { return data; }
  }
  return data;
}

// ─── NoCaptchaAI (security check / Turnstile solver) ───
async function nocapPost(pathname, apiKey, body) {
  const res = await fetch(`${NOCAP_API}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientKey: apiKey, ...body }),
    signal: AbortSignal.timeout(30000),
  });
  return res.json().catch(() => ({}));
}

// NoCaptchaAI ke error codes ko seedha-wajah wale message me badlo.
function nocapExplain(result) {
  const code = String(result?.errorCode ?? result?.errorId ?? '');
  const desc = String(result?.errorDescription || result?.msg || '').trim();
  const text = `${code} ${desc}`.toUpperCase();
  if (/ZERO_BALANCE|INSUFFICIENT|NO_FUNDS/.test(text)) {
    return 'NoCaptchaAI wallet khaali hai — Turnstile subscription plan me NAHI aata, alag $0.0005/solve wallet se katta hai. nocaptchaai.com/manage/billing se wallet top-up karo.';
  }
  if (/BAD_KEY|WRONG_USER_KEY|KEY_DOES_NOT_EXIST|AUTH/.test(text)) return 'NoCaptchaAI key invalid hai — dashboard se dobara copy karo.';
  if (/NO_SLOT|TOO_MUCH_REQUESTS|RATE|BUSY/.test(text)) return 'NoCaptchaAI busy hai — thodi der baad retry.';
  if (code === '0') return desc;
  return desc || (code ? `NoCaptchaAI error ${code}` : '');
}

async function nocapSolveTurnstile(apiKey, sitekey, pageUrl, timeoutMs = NOCAP_TIMEOUT_MS) {
  const errors = [];
  for (const type of ['TurnstileTaskProxyLess', 'CloudflareTurnstileTaskProxyLess']) {
    let created;
    try {
      created = await nocapPost('/createTask', apiKey, { task: { type, websiteURL: pageUrl, websiteKey: sitekey } });
    } catch (error) { errors.push(String(error?.message || error).slice(0, 120)); continue; }
    if ((created.errorId ?? 0) !== 0 || !created.taskId) {
      errors.push(nocapExplain(created) || 'createTask fail');
      continue;
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
      let result;
      try { result = await nocapPost('/getTaskResult', apiKey, { taskId: created.taskId }); } catch { continue; }
      const status = String(result.status || '').toLowerCase();
      if (status === 'ready') {
        const token = result.solution?.token || '';
        if (token) return token;
        throw new Error('NoCaptchaAI ne ready par khali token diya');
      }
      if (status === 'failed') throw new Error(`NoCaptchaAI solve fail: ${nocapExplain(result) || 'failed'}`);
    }
    throw new Error(`NoCaptchaAI ne ${Math.round(timeoutMs / 1000)}s me solve nahi kiya — dobara try karo`);
  }
  throw new Error(`NoCaptchaAI createTask fail: ${errors.filter(Boolean).join(' | ') || 'unknown'}`);
}

// Key + wallet ka live test (UI ke "Captcha test" button ke liye).
export async function nocapKeyCheck(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) return { ok: false, message: 'Key khaali hai' };
  try {
    const created = await nocapPost('/createTask', key, { task: { type: 'TurnstileTaskProxyLess', websiteURL: 'https://golddropgolddhamaka.com/register', websiteKey: '0x4AAAAAAAdiagnosticProbe000000000000' } });
    if ((created.errorId ?? 0) === 0 && created.taskId) return { ok: true, message: `Key chal rahi hai ✅ (wallet se kat raha hai, test task ${created.taskId})` };
    return { ok: false, message: nocapExplain(created) || 'Key test fail' };
  } catch (error) {
    return { ok: false, message: `NoCaptchaAI tak nahi pahucha: ${String(error?.message || error).slice(0, 140)}` };
  }
}

// Sitekey + page reachability — "captcha kyun nahi hal hua" ka poora diagnosis.
export async function goldDropCaptchaDiagnose(nocapApiKey, options = {}) {
  const out = { keyMasked: '', keyOk: null, keyMessage: '', sitekey: '', sitekeyError: '' };
  const key = String(nocapApiKey || '').trim();
  out.keyMasked = key.length > 16 ? `${key.slice(0, 10)}…${key.slice(-4)}` : (key || '(none)');
  if (!key || ['off', '0', 'none'].includes(key.toLowerCase())) {
    out.keyOk = false;
    out.keyMessage = 'Key OFF hai — apni nocap_… key daalo.';
  } else {
    const check = await nocapKeyCheck(key);
    out.keyOk = check.ok;
    out.keyMessage = check.message;
  }
  try {
    out.sitekey = await fetchSitekey(options);
    if (!out.sitekey) out.sitekeyError = 'Sitekey nahi mili — site ka HTML badla hai';
  } catch (error) {
    out.sitekeyError = String(error?.message || error).slice(0, 160);
  }
  return out;
}

// Sitekey runtime par site ke HTML/JS bundle se nikalo — kabhi guess nahi.
// SPA par page me 1 se zyada Turnstile key hoti hai (widget, ads, dusra
// campaign) — pehla match galat ho sakta hai, isliye poori list.
async function fetchSitekeys({ fetchImpl = fetch, pageUrl = 'https://golddropgolddhamaka.com/register' } = {}) {
  const read = async url => {
    const res = await fetchImpl(url, { headers: { 'user-agent': GOLD_DROP_UA }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`site ne HTTP ${res.status} diya`);
    return res.text();
  };
  const keys = [];
  const add = key => { if (key && !keys.includes(key)) keys.push(key); };
  let html;
  try { html = await read(pageUrl); }
  catch (error) { throw new Error(`Gold Drop site tak nahi pahucha (network): ${String(error?.message || error).slice(0, 90)}`); }
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

function maskSitekey(key = '') {
  const value = String(key || '');
  return value.length > 14 ? `${value.slice(0, 10)}…${value.slice(-4)}` : value;
}

function isSecurityCheck(error) {
  return /security check|captcha|turnstile|verify you are human/i.test(String(error?.message || error || ''));
}

// ─── Gold Drop API client (drop.py method, exact) ───
async function gdRequest(pathname, body, contentType, cookies = '', referer = 'https://golddropgolddhamaka.com/register') {
  const headers = {
    'accept': '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'origin': 'https://golddropgolddhamaka.com',
    'referer': referer,
    'user-agent': GOLD_DROP_UA,
  };
  if (contentType) headers['content-type'] = contentType;
  if (cookies) headers.Cookie = cookies;
  const response = await fetch(`${BASE}${pathname}`, { method: 'POST', headers, body, signal: AbortSignal.timeout(45000) });
  const raw = await response.text();
  let data;
  try { data = unwrapResponse(JSON.parse(raw)); } catch { data = { raw }; }
  if (!response.ok) throw new Error(`Gold Drop HTTP ${response.status}: ${String(data?.message || 'request failed').slice(0, 200)}`);
  return { data, setCookie: response.headers.getSetCookie?.() || [] };
}

export async function registerGoldDrop({ name, mobile, email, pincode, code, imageBase64, nocapApiKey }) {
  if (!/^[6789]\d{9}$/.test(mobile)) throw new Error('Valid 10-digit mobile chahiye');
  if (!/^\d{6}$/.test(String(pincode))) throw new Error('Valid 6-digit PIN code chahiye');
  if (!name || !email || !code || !imageBase64) throw new Error('Naam, email, batch code aur photo — sab chahiye');
  const image = Buffer.from(imageBase64, 'base64');
  if (!image.length) throw new Error('Photo decode nahi hui');

  // Session keys (drop.py init_session — sirf {} body)
  const boot = await gdRequest('/users', JSON.stringify({}), 'application/json');
  if (!boot.data?.userKey || !boot.data?.dataKey) throw new Error(String(boot.data?.message || 'Session keys nahi mile'));
  const userKey = String(boot.data.userKey);
  const dataKey = String(boot.data.dataKey);
  const cookies = `gold-drop-id=${userKey}`;

  const doRegister = async captchaToken => {
    const t = String(Date.now());
    const signed = signPayload({ name, mobile, email, pincode, code, terms_accepted: '1' }, dataKey, userKey, t);
    const boundary = `----GoldDrop${randomBytes(16).toString('hex')}`;
    // Site ka field naam alag ho sakta hai — token multiple names se bhejo.
    const captchaNames = (process.env.GOLD_DROP_CAPTCHA_FIELDS
      || 'cf-turnstile-response,turnstileToken,captchaToken,captcha')
      .split(',').map(x => x.trim()).filter(Boolean);
    const captchaPart = captchaToken
      ? captchaNames.map(name => `\r\n--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${captchaToken}`).join('')
      : '';
    const chunks = [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="data"\r\n\r\n${signed}${captchaPart}\r\n--${boundary}\r\nContent-Disposition: form-data; name="img"; filename="sample.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), image, Buffer.from(`\r\n--${boundary}--\r\n`)];
    const { data: result } = await gdRequest(`/users/register/${encodeURIComponent(userKey)}?t=${t}`, Buffer.concat(chunks), `multipart/form-data; boundary=${boundary}`, cookies);
    if (result?.statusCode !== 200) throw new Error(String(result?.message || 'Registration failed'));
    return result;
  };

  let registerResult;
  let securitySolved = false;
  try {
    registerResult = await doRegister('');
  } catch (error) {
    if (!isSecurityCheck(error)) throw error;
    const key = String(nocapApiKey || '').trim();
    if (['off', '0', 'none'].includes(key.toLowerCase())) throw new Error('Security check maanga par NoCaptchaAI key OFF hai.');
    const sitekeys = await fetchSitekeys().catch((error) => {
      throw new Error(`Captcha solve nahi ho sakta — ${String(error?.message || error).slice(0, 160)}`);
    });
    if (!sitekeys.length) throw new Error('Captcha solve nahi ho sakta — site par Turnstile sitekey nahi mili (HTML badla hai).');
    const tried = [];
    let rejection = null;
    for (const sitekey of sitekeys) {
      const token = await nocapSolveTurnstile(key || NOCAP_KEY_DEFAULT, sitekey, 'https://golddropgolddhamaka.com/register');
      try {
        registerResult = await doRegister(token);
        securitySolved = true;
        rejection = null;
        break;
      } catch (retryError) {
        // Token ke bawajood wahi "security check" → agla sitekey
        if (!isSecurityCheck(retryError)) throw retryError;
        rejection = retryError;
        tried.push(maskSitekey(sitekey));
      }
    }
    if (rejection) {
      throw new Error(
        `Security check site par hi clear nahi hua — ${tried.join(', ')} ka solved token bhi site ne reject kiya. `
        + 'Site ko asli browser chahiye (raw API par ye check clear nahi hota).',
      );
    }
  }

  // session verify ke liye wapas chahiye (stateless serverless)
  return {
    ok: true,
    securitySolved,
    message: String(registerResult?.message || 'OTP sent'),
    session: { userKey, dataKey },
  };
}

export async function verifyGoldDropOtp({ session, otp }) {
  const userKey = String(session?.userKey || '');
  const dataKey = String(session?.dataKey || '');
  if (!userKey || !dataKey) throw new Error('Session expire ho gaya — number dobara bhejo');
  if (!/^\d{6}$/.test(String(otp))) throw new Error('OTP 6 digits ka hota hai');
  const t = String(Date.now());
  const data = signPayload({ otp: String(otp) }, dataKey, userKey, t);
  const { data: result } = await gdRequest(
    `/users/verify-otp/${encodeURIComponent(userKey)}?t=${t}`,
    JSON.stringify({ data }),
    'application/json',
    `gold-drop-id=${userKey}`,
    'https://golddropgolddhamaka.com/otp',
  );
  if (result?.statusCode !== 200) throw new Error(String(result?.message || 'OTP verification failed'));
  return {
    ok: true,
    message: String(result?.message || 'Verified'),
    winType: result?.win_type || '',
    reward: result?.reward ? { name: result.reward.name || '', faceValue: result.reward.face_value || '' } : null,
  };
}
