// 🟡 Gold Drop — VERCEL serverless backend (drop.py direct-API method).
// Koi browser nahi: POST /api/users {} → HMAC signed token → multipart
// register (data+img) → verify-otp. Security check aaye to NoCaptchaAI se
// Turnstile solve → cf-turnstile-response ke saath 1 retry.
import { randomBytes, randomInt, createHmac } from 'node:crypto';

const BASE = 'https://golddropgolddhamaka.com/api';
const GOLD_DROP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const NOCAP_API = 'https://api.nocaptchaai.com';
const NOCAP_KEY_DEFAULT = process.env.NOCAP_API_KEY || '';
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const b64 = value => Buffer.from(value, 'utf8').toString('base64');

// ─── Signing (gold-drop-client.js / drop.py exact signer) ───
function signPayload(payload, dataKey, userKey, t) {
  const ts = b64(String(t));
  const json = JSON.stringify({ ...payload, userKey: String(userKey), t: String(t) });
  const digest = b64(createHmac('sha256', String(dataKey).slice(4, 18)).update(`${ts}.${b64(json)}`).digest('hex'));
  const p = randomInt(1, 7); // 1..6
  const m = randomInt(2, 9); // 2..8
  let nonce = '';
  for (let i = 0; i < m; i++) nonce += ALPHABET[randomInt(ALPHABET.length)];
  return `${ts}.${b64(json)}.${m}${p}${digest.slice(0, p)}${nonce}${digest.slice(p)}`;
}

function mergeCookies(setCookies = [], userKey = '') {
  const map = new Map();
  for (const raw of Array.isArray(setCookies) ? setCookies : []) {
    const first = String(raw || '').split(';')[0];
    const idx = first.indexOf('=');
    if (idx <= 0) continue;
    const name = first.slice(0, idx).trim();
    const val = first.slice(idx + 1).trim();
    if (name) map.set(name, val);
  }
  if (userKey) map.set('gold-drop-id', String(userKey));
  return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

function unwrapResponse(data) {
  if (data && typeof data.resp === 'string') {
    try { return JSON.parse(Buffer.from(data.resp, 'base64').toString('utf8')); } catch { return data; }
  }
  return data;
}

// ─── Captcha Solver (NoCaptchaAI / CapSolver / 2Captcha / Anti-Captcha) ───
function detectCaptchaProvider(rawKey = '') {
  const k = String(rawKey || '').trim();
  if (!k) return { provider: 'none', key: '' };
  if (/^cap-/i.test(k)) return { provider: 'capsolver', key: k, base: 'https://api.capsolver.com' };
  if (/^2captcha:/i.test(k)) return { provider: '2captcha', key: k.slice(9).trim(), base: 'https://api.2captcha.com' };
  if (/^anticaptcha:/i.test(k)) return { provider: 'anticaptcha', key: k.slice(12).trim(), base: 'https://api.anti-captcha.com' };
  if (/^[a-f0-9]{32}$/i.test(k)) return { provider: '2captcha', key: k, base: 'https://api.2captcha.com' };
  return { provider: 'nocaptchaai', key: k, base: NOCAP_API };
}

export function isFatalCaptchaKeyError(msg = '') {
  return /(ERROR_KEY_DOES_NOT_EXIST|ERROR_ZERO_BALANCE|ERROR_WRONG_USER_KEY|ERROR_IP_NOT_ALLOWED|Invalid API key|key missing|key expire|key error|valid .* key daalo|Captcha key OFF|NoCaptchaAI key)/i.test(String(msg || ''));
}

async function solverPost(baseUrl, pathname, apiKey, body) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: apiKey },
    body: JSON.stringify({ clientKey: apiKey, ...body }),
    signal: AbortSignal.timeout(30000),
  });
  return res.json().catch(() => ({}));
}

export async function checkCaptchaKeyBalance(rawKey = '') {
  const { provider, key, base } = detectCaptchaProvider(rawKey);
  if (!key || ['off', '0', 'none'].includes(key.toLowerCase())) {
    return { ok: false, message: '⚠️ Captcha solver key empty/OFF hai — security check aane par solve nahi hoga.' };
  }
  if (provider === 'nocaptchaai') {
    let r = await fetch(`${NOCAP_API}/balance?apiKey=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(15000) }).then(x => x.json()).catch(() => ({}));
    if (String(r.status || '').toLowerCase() !== 'ok' && r.balance === undefined && r.Balance === undefined) {
      const r2 = await solverPost(NOCAP_API, '/getBalance', key, {}).catch(() => ({}));
      if ((r2.errorId ?? 1) === 0 && r2.balance !== undefined) r = { status: 'ok', balance: r2.balance };
      else if (r2.errorCode || r2.errorDescription) r = { status: 'error', error: r2.errorDescription || r2.errorCode };
    }
    if (String(r.status || '').toLowerCase() !== 'ok' && r.balance === undefined && r.Balance === undefined) {
      const errTxt = r.error || r.errorCode || r.msg || 'unknown';
      return { ok: false, message: `⚠️ NoCaptchaAI key error: ${errTxt} — valid key daalo (nocaptchaai.com)` };
    }
    const bal = r.Balance ?? r.balance ?? 0;
    return { ok: true, message: `💰 NoCaptchaAI balance: $${bal} (${r.Subscription === 'active' ? 'active' : r.Subscription || 'ready'})` };
  }
  const r = await solverPost(base, '/getBalance', key, {});
  if ((r.errorId ?? 0) !== 0 || r.balance === undefined) {
    const errTxt = r.errorDescription || r.errorCode || r.error || 'unknown';
    return { ok: false, message: `⚠️ ${provider} key error: ${errTxt}` };
  }
  return { ok: true, message: `💰 ${provider} balance: $${r.balance}` };
}

async function nocapSolveTurnstile(apiKey, sitekey, pageUrl) {
  const { provider, key, base } = detectCaptchaProvider(apiKey);
  if (!key) throw new Error('Captcha key missing hai — NoCaptchaAI / CapSolver / 2Captcha key daalo.');
  const taskTypes = provider === 'capsolver'
    ? ['AntiTurnstileTaskProxyLess']
    : provider === '2captcha' || provider === 'anticaptcha'
      ? ['TurnstileTaskProxyless', 'TurnstileTaskProxyLess']
      : ['AntiTurnstileTask', 'AntiTurnstileTaskProxyLess', 'CloudflareTurnstileTaskProxyLess', 'TurnstileTaskProxyLess'];

  let lastError = '';
  if (provider === 'nocaptchaai') {
    try {
      const syncRes = await fetch(`${NOCAP_API}/solve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', apikey: key },
        body: JSON.stringify({ sitekey, url: pageUrl, type: 'turnstile' }),
        signal: AbortSignal.timeout(30000),
      }).then(x => x.json()).catch(() => ({}));
      const syncToken = syncRes?.token || syncRes?.solution?.token || '';
      if (syncToken) return syncToken;
      const syncErr = String(syncRes?.errorDescription || syncRes?.errorCode || syncRes?.error || syncRes?.message || syncRes?.msg || '').slice(0, 140);
      if (syncErr && isFatalCaptchaKeyError(syncErr)) {
        throw new Error(`nocaptchaai key error: ${syncErr}`);
      }
      if (syncErr) lastError = syncErr;
    } catch (error) {
      if (isFatalCaptchaKeyError(error?.message)) throw error;
    }
  }
  for (const type of taskTypes) {
    let created;
    try {
      created = await solverPost(base, '/createTask', key, { task: { type, websiteURL: pageUrl, websiteKey: sitekey } });
    } catch (error) { lastError = String(error?.message || error).slice(0, 120); continue; }
    if ((created.errorId ?? 0) !== 0 || !created.taskId) {
      lastError = String(created.errorDescription || created.errorCode || created.error || created.msg || JSON.stringify(created) || 'createTask fail').slice(0, 140);
      if (isFatalCaptchaKeyError(lastError)) {
        throw new Error(`${provider} key error: ${lastError}`);
      }
      continue;
    }
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
      let result;
      try { result = await solverPost(base, '/getTaskResult', key, { taskId: created.taskId }); } catch { continue; }
      const status = String(result.status || '').toLowerCase();
      if (status === 'ready') {
        const token = result.solution?.token || '';
        if (token) return token;
        throw new Error(`${provider} ne ready par khali token diya`);
      }
      if (status === 'failed' || (result.errorId ?? 0) !== 0) {
        throw new Error(`${provider}: ${String(result.errorDescription || result.errorCode || result.error || 'failed').slice(0, 140)}`);
      }
    }
    throw new Error(`${provider} task 45s me ready nahi hua`);
  }
  throw new Error(`${provider} createTask fail: ${lastError || 'unknown'}`);
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
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    'origin': 'https://golddropgolddhamaka.com',
    'referer': referer,
    'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
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
  const cookies = mergeCookies(boot.setCookie, userKey);

  const doRegister = async captchaToken => {
    const t = String(Date.now());
    const signed = signPayload({ name, mobile, email, pincode, code, terms_accepted: '1' }, dataKey, userKey, t);
    const boundary = `----GoldDrop${randomBytes(16).toString('hex')}`;
    const captchaPart = captchaToken
      ? `\r\n--${boundary}\r\nContent-Disposition: form-data; name="cf-turnstile-response"\r\n\r\n${captchaToken}`
      : '';
    const chunks = [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="data"\r\n\r\n${signed}${captchaPart}\r\n--${boundary}\r\nContent-Disposition: form-data; name="img"; filename="sample.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), image, Buffer.from(`\r\n--${boundary}--\r\n`)];
    const reg = await gdRequest(`/users/register/${encodeURIComponent(userKey)}?t=${t}`, Buffer.concat(chunks), `multipart/form-data; boundary=${boundary}`, cookies);
    const result = reg.data;
    if (result?.statusCode !== 200) throw new Error(String(result?.message || 'Registration failed'));
    return { result, setCookie: reg.setCookie };
  };

  let registerOut;
  let securitySolved = false;
  try {
    registerOut = await doRegister('');
  } catch (error) {
    if (!isSecurityCheck(error)) throw error;
    const key = String(nocapApiKey || '').trim();
    if (['off', '0', 'none'].includes(key.toLowerCase())) throw new Error('Security check maanga par Captcha key OFF hai.');
    const effectiveKey = key || NOCAP_KEY_DEFAULT;
    if (!effectiveKey) throw new Error('Gold Drop ne Security Check (Turnstile) maanga hai — valid NoCaptchaAI / CapSolver / 2Captcha key daalo.');
    const sitekey = await fetchSitekey().catch(() => '');
    if (!sitekey) throw new Error('Site par Turnstile sitekey nahi mili — site ka structure badla hai.');
    const token = await nocapSolveTurnstile(effectiveKey, sitekey, 'https://golddropgolddhamaka.com/register');
    registerOut = await doRegister(token);
    securitySolved = true;
  }

  const mergedSessionCookies = mergeCookies([...(boot.setCookie || []), ...(registerOut.setCookie || [])], userKey);
  return {
    ok: true,
    securitySolved,
    message: String(registerOut.result?.message || 'OTP sent'),
    session: { userKey, dataKey, cookies: mergedSessionCookies },
  };
}

export async function verifyGoldDropOtp({ session, otp }) {
  const userKey = String(session?.userKey || '');
  const dataKey = String(session?.dataKey || '');
  const cookies = String(session?.cookies || `gold-drop-id=${userKey}`);
  if (!userKey || !dataKey) throw new Error('Session expire ho gaya — number dobara bhejo');
  if (!/^\d{6}$/.test(String(otp))) throw new Error('OTP 6 digits ka hota hai');
  const t = String(Date.now());
  const data = signPayload({ otp: String(otp) }, dataKey, userKey, t);
  const { data: result } = await gdRequest(
    `/users/verify-otp/${encodeURIComponent(userKey)}?t=${t}`,
    JSON.stringify({ data }),
    'application/json',
    cookies,
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
