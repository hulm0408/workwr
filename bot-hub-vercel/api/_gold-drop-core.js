// 🟡 Gold Drop — hub ke andar reuse (gold-drop-vercel/api/_gold-drop.js ka copy).
// VERCEL serverless backend (drop.py direct-API method).
// Koi browser nahi: POST /api/users {} → HMAC signed token → multipart
// register (data+img) → verify-otp. Security check aaye to NoCaptchaAI se
// Turnstile solve → cf-turnstile-response ke saath 1 retry.
import { randomBytes, createHmac } from 'node:crypto';

const BASE = 'https://golddropgolddhamaka.com/api';
const GOLD_DROP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const NOCAP_API = 'https://api.nocaptchaai.com';
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

async function nocapSolveTurnstile(apiKey, sitekey, pageUrl) {
  let lastError = '';
  for (const type of ['CloudflareTurnstileTaskProxyLess', 'TurnstileTaskProxyLess']) {
    let created;
    try {
      created = await nocapPost('/createTask', apiKey, { task: { type, websiteURL: pageUrl, websiteKey: sitekey } });
    } catch (error) { lastError = String(error?.message || error).slice(0, 120); continue; }
    if ((created.errorId ?? 0) !== 0 || !created.taskId) {
      lastError = String(created.errorDescription || created.msg || 'createTask fail').slice(0, 120);
      continue;
    }
    const deadline = Date.now() + 45000;
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
      if (status === 'failed') throw new Error(`NoCaptchaAI: ${String(result.errorDescription || result.errorCode || 'failed').slice(0, 120)}`);
    }
    throw new Error(`NoCaptchaAI task 45s me ready nahi hua`);
  }
  throw new Error(`NoCaptchaAI createTask fail: ${lastError || 'unknown'}`);
}

// Sitekey runtime par site ke HTML/JS bundle se nikalo — kabhi guess nahi.
async function fetchSitekey() {
  const read = async url => {
    const res = await fetch(url, { headers: { 'user-agent': GOLD_DROP_UA }, signal: AbortSignal.timeout(20000) });
    return res.text();
  };
  const pageUrl = 'https://golddropgolddhamaka.com/register';
  const html = await read(pageUrl);
  let match = /0x4[0-9A-Za-z_-]{21,}/.exec(html);
  if (match) return match[0];
  const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(x => x[1]);
  for (const src of scripts.slice(0, 6)) {
    try {
      const js = await read(new URL(src, pageUrl).href);
      match = /0x4[0-9A-Za-z_-]{21,}/.exec(js);
      if (match) return match[0];
    } catch { /* agla bundle */ }
  }
  return '';
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
    const captchaPart = captchaToken
      ? `\r\n--${boundary}\r\nContent-Disposition: form-data; name="cf-turnstile-response"\r\n\r\n${captchaToken}`
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
    const sitekey = await fetchSitekey().catch(() => '');
    if (!sitekey) throw new Error('Site par Turnstile sitekey nahi mili — site ka structure badla hai.');
    const token = await nocapSolveTurnstile(key || NOCAP_KEY_DEFAULT, sitekey, 'https://golddropgolddhamaka.com/register');
    registerResult = await doRegister(token);
    securitySolved = true;
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
