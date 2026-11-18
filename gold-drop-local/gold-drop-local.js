// 🟡 Gold Drop LOCAL — poora system tumhare PC par.
// START dabao → details bharo → tumhara Chrome LIVE khul kar registration karega.
// Number tum apne OTP bot se laao, OTP tum type karo — browser tumhare saamne chalta hai.
//
// Chalane ka tareeqa:
//   1. Node.js 20+ install hona chahiye (https://nodejs.org)
//   2. is folder me:  npm install
//   3. phir:          npm start     (ya Windows par start-windows.bat double-click)
//   4. browser me kholo: http://localhost:3737
//
// Security check (Cloudflare Turnstile) ab NoCaptchaAI API se AUTO-SOLVE hota hai —
// tumhari apni key. Key UI me prefilled hai; NOCAP_API_KEY env se override kar
// sakte ho; khali kar doge to purana tareeqa (asli Chrome + ghar ka IP se
// passive pass / manual checkbox).
import http from 'node:http';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.GOLD_DROP_LOCAL_PORT || 3737);
const SITE_URL = process.env.GOLD_DROP_SITE_URL || 'https://golddropgolddhamaka.com/register';
const MOCK = process.env.GOLD_DROP_LOCAL_NO_BROWSER === '1'; // sirf testing

// ─── NoCaptchaAI (Cloudflare Turnstile solver API) ───
const NOCAP_API = 'https://api.nocaptchaai.com';
const NOCAP_KEY_DEFAULT = process.env.NOCAP_API_KEY || '';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ─── Chrome dhoondhna (Windows / macOS / Linux) ───
function findChrome() {
  const candidates = [
    process.env.GOLD_DROP_CHROME,
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { if (existsSync(candidate)) return candidate; } catch {}
  }
  return '';
}

// ─── Gmail plus addressing: har number ke 6 random digits email me ───
function emailForMobile(email, mobile) {
  const match = /^([^@+]+)@(gmail\.com)$/i.exec(String(email || ''));
  if (!match) return String(email || '');
  const digits = String(mobile).split('');
  let suffix = '';
  for (let i = 0; i < 6 && digits.length; i++) suffix += digits.splice(Math.floor(Math.random() * digits.length), 1)[0];
  return `${match[1]}+${suffix}@${match[2]}`;
}

// ─── NoCaptchaAI client + Turnstile solver ───
async function nocapPost(pathname, apiKey, body, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${NOCAP_API}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: apiKey, ...body }),
      signal: controller.signal,
    });
    return await res.json().catch(() => ({}));
  } finally {
    clearTimeout(timer);
  }
}

// /solve sync + createTask → getTaskResult poll → token (NoCaptchaAI v2)
async function nocapSolveTurnstile(apiKey, sitekey, pageUrl) {
  let lastError = '';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const syncRes = await fetch(`${NOCAP_API}/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: apiKey },
      body: JSON.stringify({ sitekey, url: pageUrl, type: 'turnstile' }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    const syncJson = await syncRes.json().catch(() => ({}));
    const tok = syncJson?.token || syncJson?.solution?.token || '';
    if (tok) return { token: tok };
    if (syncJson?.error || syncJson?.errorDescription || syncJson?.errorCode) {
      lastError = String(syncJson.errorDescription || syncJson.errorCode || syncJson.error).slice(0, 140);
    }
  } catch {}

  for (const type of ['AntiTurnstileTask', 'AntiTurnstileTaskProxyLess', 'CloudflareTurnstileTaskProxyLess', 'TurnstileTaskProxyLess']) {
    let created;
    try {
      created = await nocapPost('/createTask', apiKey, { task: { type, websiteURL: pageUrl, websiteKey: sitekey } });
    } catch (error) { lastError = String(error?.message || error).slice(0, 120); continue; }
    if ((created.errorId ?? 0) !== 0 || !created.taskId) {
      lastError = String(created.errorDescription || created.errorCode || created.error || created.msg || 'createTask fail').slice(0, 140);
      continue;
    }
    const deadline = Date.now() + 50000;
    while (Date.now() < deadline) {
      await sleep(2000);
      let result;
      try { result = await nocapPost('/getTaskResult', apiKey, { taskId: created.taskId }); } catch { continue; }
      const status = String(result.status || '').toLowerCase();
      if (status === 'ready') {
        const token = result.solution?.token || '';
        return token ? { token } : { error: 'ready par token khali mila' };
      }
      if (status === 'failed') return { error: String(result.errorDescription || result.errorCode || 'failed').slice(0, 120) };
    }
    return { error: `task ${created.taskId} 50s me ready nahi hua` };
  }
  return { error: lastError || 'unknown' };
}

async function nocapBalanceText(apiKey) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(`${NOCAP_API}/balance?apiKey=${encodeURIComponent(apiKey)}`, { signal: controller.signal }).finally(() => clearTimeout(timer));
    const r = await res.json().catch(() => ({}));
    if (String(r.status || '').toLowerCase() !== 'ok') return `⚠️ NoCaptchaAI balance check fail: ${r.error || r.msg || `HTTP ${res.status}`} — key sahi hai? (security check auto-solve nahi chalega)`;
    const plan = r.plan || {};
    const extra = plan.dailyLimit ? ` · aaj ${plan.dailyLimitUsed}/${plan.dailyLimit} used` : '';
    return `NoCaptchaAI key OK — balance $${r.balance}${extra}`;
  } catch (error) {
    return `⚠️ NoCaptchaAI tak pahunch nahi paya: ${String(error?.message || error).slice(0, 120)} (internet check karo)`;
  }
}

// Page load se pehle turnstile hook laga do — site jo bhi callback/getResponse
// use kare, humara solved token wahin se milega.
async function installTurnstileHook(pg) {
  await pg.evaluateOnNewDocument(() => {
    const store = { renders: [], callback: null, token: '' };
    window.__nocapStore = store;
    const hook = () => {
      const t = window.turnstile;
      if (!t) { setTimeout(hook, 250); return; }
      if (t.__nocapHooked) return;
      t.__nocapHooked = true;
      const origRender = t.render && t.render.bind(t);
      if (origRender) {
        t.render = (el, params) => {
          try {
            store.renders.push({ sitekey: (params && params.sitekey) || '', action: (params && params.action) || '', cdata: (params && params.cdata) || '' });
            if (params && typeof params.callback === 'function') store.callback = params.callback;
          } catch (e) {}
          return origRender(el, params);
        };
      }
      const origGet = t.getResponse && t.getResponse.bind(t);
      t.getResponse = (...args) => (store.token || (origGet ? origGet(...args) : ''));
    };
    hook();
  }).catch(() => {});
}

// Page par Turnstile widget dikhe to NoCaptchaAI se token laakar inject karo.
// true = solve ho gaya; false = widget nahi tha ya solve nahi hua (manual fallback).
async function solveTurnstileIfPresent(pg) {
  const apiKey = (state.details && state.details.nocapKey) || NOCAP_KEY_DEFAULT;
  if (!apiKey || !pg || pg.__nocapSolved) return false;
  const info = await pg.evaluate(() => {
    const el = document.querySelector('.cf-turnstile[data-sitekey], [data-sitekey]');
    const store = window.__nocapStore || { renders: [] };
    const last = store.renders[store.renders.length - 1] || {};
    return {
      sitekey: (el && el.getAttribute('data-sitekey')) || last.sitekey || '',
      action: (el && el.getAttribute('data-action')) || last.action || '',
      cdata: (el && el.getAttribute('data-cdata')) || last.cdata || '',
      widget: !!(el || document.querySelector('iframe[src*="challenges.cloudflare.com"]') || store.renders.length),
    };
  }).catch(() => null);
  if (!info || !info.widget) return false;
  if (!info.sitekey) {
    logLine('Turnstile widget mila par sitekey nahi mili — agar checkbox aaye to khud click karna.');
    return false;
  }
  const u = new URL(pg.url());
  let pageUrl = u.origin + u.pathname;
  if (!pageUrl.endsWith('/')) pageUrl += '/';
  logLine(`🛡️ Security check (Turnstile) mila — NoCaptchaAI se solve ho raha hai… (sitekey ${info.sitekey.slice(0, 12)}…)`);
  let solved;
  try {
    solved = await nocapSolveTurnstile(apiKey, info.sitekey, pageUrl);
  } catch (error) {
    logLine(`⚠️ NoCaptchaAI solve fail (network): ${String(error?.message || error).slice(0, 150)} — manual checkbox fallback.`);
    return false;
  }
  if (!solved.token) {
    logLine(`⚠️ NoCaptchaAI solve fail: ${solved.error || 'unknown'} — manual checkbox fallback.`);
    return false;
  }
  const token = solved.token;
  await pg.evaluate(tok => {
    const store = window.__nocapStore;
    if (store) store.token = tok;
    document.querySelectorAll('input[name="cf-turnstile-response"]').forEach(input => {
      input.value = tok;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    if (store && typeof store.callback === 'function') { try { store.callback(tok); } catch (e) {} }
  }, token).catch(() => {});
  pg.__nocapSolved = true;
  logLine('✅ Security check SOLVED (NoCaptchaAI) — token inject ho gaya, aage badh rahe hain.');
  return true;
}

// ─── Page helpers (browser ke andar evaluate hote hain) ───
const FIELD_SELECTORS = {
  email: ["input[type='email']", "input[name*='email' i]", "input[id*='email' i]", "input[placeholder*='email' i]"],
  pincode: ["input[name*='pin' i]", "input[id*='pin' i]", "input[placeholder*='pin' i]", "input[name*='zip' i]", "input[name*='postal' i]"],
  mobile: ["input[type='tel']", "input[name*='mobile' i]", "input[id*='mobile' i]", "input[placeholder*='mobile' i]",
    "input[name*='phone' i]", "input[placeholder*='phone' i]", "input[name*='number' i]", "input[placeholder*='number' i]", "input[name*='whatsapp' i]"],
  code: ["input[name*='batch' i]", "input[id*='batch' i]", "input[placeholder*='batch' i]", "input[name*='coupon' i]", "input[name*='voucher' i]",
    "input[name*='code' i]", "input[id*='code' i]", "input[placeholder*='code' i]"],
  name: ["input[name*='name' i]", "input[id*='name' i]", "input[placeholder*='name' i]"],
};
const CTA_TEXTS = ['get started', 'send otp', 'get otp', 'register', 'submit', 'verify', 'confirm', 'continue', 'next', 'proceed', 'participate', 'start'];
const OTP_SELECTORS = ['input[autocomplete="one-time-code"]', 'input[name*="otp" i]', 'input[id*="otp" i]', 'input[placeholder*="otp" i]'];

async function fillField(page, field, value) {
  const found = await page.evaluate(selectors => {
    const visible = el => !!(el.getClientRects().length && !el.disabled && !el.readOnly);
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (visible(el) && !el.dataset.gdlFilled) {
          el.dataset.gdlFilled = '1';
          el.setAttribute('data-gdl-target', '1');
          return true;
        }
      }
    }
    return false;
  }, FIELD_SELECTORS[field]);
  if (!found) return false;
  try {
    const el = await page.$('[data-gdl-target="1"]');
    if (el) {
      await el.click({ clickCount: 3 }).catch(() => {});
      await el.type(String(value), { delay: 15 });
    }
  } catch {} finally {
    await page.evaluate(() => document.querySelectorAll('[data-gdl-target]').forEach(e => e.removeAttribute('data-gdl-target'))).catch(() => {});
  }
  return true;
}

async function clickButton(page) {
  return page.evaluate(texts => {
    const visible = el => !!(el.getClientRects().length && !el.disabled);
    const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const all = [...document.querySelectorAll('button, input[type="submit"], a, [role="button"]')];
    const submit = all.find(el => visible(el) && (el.type === 'submit'));
    if (submit) { submit.click(); return norm(submit.innerText || submit.value || 'submit'); }
    for (const text of texts) {
      const el = all.find(e => visible(e) && norm(e.innerText || e.value).includes(text));
      if (el) { el.click(); return norm(el.innerText || el.value || text); }
    }
    const formButton = [...document.querySelectorAll('form button')].find(visible);
    if (formButton) { formButton.click(); return norm(formButton.innerText || 'form button'); }
    return '';
  }, CTA_TEXTS);
}

async function readOutcome(page) {
  return page.evaluate(() => {
    const visible = el => !!(el.getClientRects().length && !el.disabled);
    const errors = [...document.querySelectorAll('.sp_error, [role="alert"], .alert-danger, .error, .text-danger, .invalid-feedback')]
      .map(el => (el.innerText || '').trim()).filter(Boolean);
    const otpSingle = [...document.querySelectorAll('input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[placeholder*="otp" i]')].some(visible);
    const otpBoxes = [...document.querySelectorAll('input[maxlength="1"]')].filter(visible).length;
    const unfilled = [...document.querySelectorAll('input:not([type]), input[type="text"], input[type="tel"], input[type="email"], input[type="number"]')]
      .some(el => visible(el) && !el.dataset.gdlFilled && !el.value && !el.readOnly);
    const body = document.body?.innerText || '';
    const challenge = /just a moment|attention required|checking your browser|verify you are|one more step/i.test(document.title || '')
      || !!document.querySelector('#challenge-form, #challenge-stage, #cf-challenge-running, .cf-browser-verification');
    return { errors, otp: otpSingle || (otpBoxes >= 4 && otpBoxes <= 8), unfilled, success: /success|verified|congrat|registered|thank\s*you/i.test(body), challenge };
  });
}

async function waitOutcome(page, timeoutS) {
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    const outcome = await readOutcome(page);
    if (outcome.errors.length) return { type: 'error', message: outcome.errors.join(' | ').slice(0, 300) };
    if (outcome.otp) return { type: 'otp', message: 'Site ne OTP step dikhaya.' };
    if (outcome.success && !outcome.challenge) return { type: 'done', message: 'Site ne success dikhaya.' };
    if (outcome.unfilled) return { type: 'next', message: '' };
    await sleep(1000);
  }
  return { type: 'unclear', message: '' };
}

async function fillOtp(page, otp) {
  const mode = await page.evaluate(selectors => {
    const visible = el => !!(el.getClientRects().length && !el.disabled);
    const single = selectors.map(s => [...document.querySelectorAll(s)]).flat().find(visible);
    if (single) { single.setAttribute('data-gdl-target', '1'); return 'single'; }
    const boxes = [...document.querySelectorAll('input[maxlength="1"]')].filter(visible);
    if (boxes.length >= 4 && boxes.length <= 8) { boxes.forEach((b, i) => b.setAttribute('data-gdl-box', String(i))); return 'split'; }
    return '';
  }, OTP_SELECTORS);
  try {
    if (mode === 'single') {
      const el = await page.$('[data-gdl-target="1"]');
      if (el) await el.type(String(otp), { delay: 25 });
      return !!el;
    }
    if (mode === 'split') {
      const digits = String(otp).split('');
      for (let i = 0; i < digits.length; i++) {
        const box = await page.$(`[data-gdl-box="${i}"]`);
        if (box) await box.type(digits[i], { delay: 25 });
      }
      return true;
    }
    return false;
  } finally {
    await page.evaluate(() => {
      document.querySelectorAll('[data-gdl-target]').forEach(e => e.removeAttribute('data-gdl-target'));
      document.querySelectorAll('[data-gdl-box]').forEach(e => e.removeAttribute('data-gdl-box'));
    }).catch(() => {});
  }
}

async function fillDetailsAndSubmit(page, details, photoPath, photoState) {
  for (const [field, value] of [['name', details.name], ['mobile', details.mobile], ['email', details.email], ['pincode', details.pincode], ['code', details.code]]) {
    if (value) await fillField(page, field, value);
  }
  if (photoPath && !photoState.uploaded) {
    const fileInput = await page.$('input[type="file"]');
    if (fileInput) { try { await fileInput.uploadFile(photoPath); photoState.uploaded = true; } catch {} }
  }
  await page.evaluate(() => {
    document.querySelectorAll('input[type="checkbox"]').forEach(box => {
      if (box.getClientRects().length && !box.checked) box.click();
    });
  }).catch(() => {});
  await solveTurnstileIfPresent(page); // submit se pehle security check solve
  return clickButton(page);
}

async function browserRegister(page, details, photoPath) {
  await page.goto(SITE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (!(await readOutcome(page)).challenge) break;
    await sleep(1000);
  }
  if ((await readOutcome(page)).challenge) {
    return { ok: false, message: 'Site ka security challenge clear nahi hua — page khud dekho aur 1 min baad dobara try karo.' };
  }
  await sleep(1500);
  await solveTurnstileIfPresent(page);
  const photoState = { uploaded: false };
  let clickedAny = false;
  let securityRetry = false;
  for (let step = 0; step < 4; step++) {
    const clicked = await fillDetailsAndSubmit(page, details, photoPath, photoState);
    if (!clicked) {
      if (!clickedAny) return { ok: false, message: 'Form ya Get Started/Submit button nahi mila.' };
      break;
    }
    clickedAny = true;
    logLine(`Button click: ${clicked}`);
    const outcome = await waitOutcome(page, 15);
    if (outcome.type === 'error') {
      if (!securityRetry && /security|captcha|turnstile|verification|invalid token/i.test(outcome.message)) {
        securityRetry = true;
        page.__nocapSolved = false; // Turnstile token single-use hota hai — naya solve
        logLine('Security-check error mila — NoCaptchaAI se naya token lekar 1 baar dobara try…');
        continue;
      }
      return { ok: false, message: outcome.message };
    }
    if (outcome.type === 'otp' || outcome.type === 'done') return { ok: true, stage: outcome.type, message: outcome.message };
    if (outcome.type === 'unclear') break;
  }
  return { ok: false, message: 'Submit ke baad site ka response clear nahi hua.' };
}

async function browserVerify(page, otp, details, photoPath) {
  if (!(await fillOtp(page, otp))) return { ok: false, message: 'OTP input nahi mila.' };
  await solveTurnstileIfPresent(page);
  const clicked = await clickButton(page);
  if (!clicked) return { ok: false, message: 'Verify button nahi mila.' };
  logLine(`Button click: ${clicked}`);
  const photoState = { uploaded: false };
  for (let step = 0; step < 3; step++) {
    const outcome = await waitOutcome(page, 20);
    if (outcome.type === 'error') return { ok: false, message: outcome.message };
    if (outcome.type === 'done') return { ok: true, message: outcome.message };
    if (outcome.type === 'next') {
      // Mobile-first flow: details form OTP ke BAAD aaya.
      const again = await fillDetailsAndSubmit(page, details, photoPath, photoState);
      if (!again) return { ok: false, message: 'Details step ka submit button nahi mila.' };
      logLine(`Button click: ${again}`);
      continue;
    }
    return { ok: true, message: 'Verify response unclear — reward SMS se confirm karna.' };
  }
  return { ok: true, message: 'Verify response unclear — reward SMS se confirm karna.' };
}

// ─── Run state ───
const state = {
  status: 'idle', // idle | need_number | working | need_otp | done
  message: '',
  target: 1,
  count: 0,
  mobile: '',
  details: null,
  photoPath: '',
  results: [],
  log: [],
};
let browser = null;
let page = null;

function logLine(message) {
  state.log.push(`[${new Date().toLocaleTimeString()}] ${message}`);
  if (state.log.length > 200) state.log.shift();
}

async function ensureBrowser() {
  if (browser) return;
  const chromePath = findChrome();
  if (!chromePath) throw new Error('Google Chrome nahi mila — Chrome install karo, ya GOLD_DROP_CHROME env me chrome.exe ka full path do.');
  const { connect } = await import('puppeteer-real-browser');
  const conn = await connect({
    headless: false, // LIVE visible browser — tumhare saamne chalega
    turnstile: false, // challenge solve/click nahi karte (repo policy)
    customConfig: { chromePath },
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
  });
  browser = conn.browser;
  browser.on('disconnected', () => { browser = null; page = null; });
  logLine(`Chrome khula: ${chromePath}`);
}

async function freshPage() {
  if (page) { await page.close().catch(() => {}); page = null; }
  page = await browser.newPage();
  await installTurnstileHook(page);
  return page;
}

async function processNumber(mobile) {
  state.status = 'working';
  state.mobile = mobile;
  try {
    if (MOCK) {
      await sleep(400);
      state.status = 'need_otp';
      state.message = `${mobile} par OTP gaya (MOCK) — OTP type karo`;
      return;
    }
    await ensureBrowser();
    const pg = await freshPage();
    state.message = `${mobile}: browser me form bhar raha hai…`;
    logLine(`Registration start: ${mobile}`);
    const email = emailForMobile(state.details.email, mobile);
    const result = await browserRegister(pg, { ...state.details, mobile, email }, state.photoPath);
    if (!result.ok) {
      state.results.push({ mobile, ok: false, message: result.message });
      state.status = 'need_number';
      state.message = `❌ ${mobile}: ${result.message}`;
      return;
    }
    if (result.stage === 'done') {
      state.count++;
      state.results.push({ mobile, ok: true, message: result.message });
      state.status = state.count >= state.target ? 'done' : 'need_number';
      state.message = `✅ ${mobile}: ${result.message}`;
      return;
    }
    state.status = 'need_otp';
    state.message = `${mobile} par OTP bhej diya — apne OTP bot me dekho aur yahan type karo`;
  } catch (error) {
    state.results.push({ mobile, ok: false, message: String(error?.message || error).slice(0, 200) });
    state.status = 'need_number';
    state.message = `❌ ${mobile}: ${String(error?.message || error).slice(0, 200)}`;
  }
}

async function processOtp(otp) {
  state.status = 'working';
  state.message = 'OTP verify ho raha hai…';
  const mobile = state.mobile;
  try {
    if (MOCK) {
      await sleep(400);
      state.count++;
      state.results.push({ mobile, ok: true, message: 'MOCK verified' });
      state.status = state.count >= state.target ? 'done' : 'need_number';
      state.message = `✅ ${mobile}: MOCK verified`;
      return;
    }
    if (!page) throw new Error('Browser page nahi mila — number dobara bhejo.');
    const result = await browserVerify(page, otp, { ...state.details, mobile }, state.photoPath);
    if (result.ok) {
      state.count++;
      state.results.push({ mobile, ok: true, message: result.message });
      state.message = `✅ ${mobile}: ${result.message}`;
    } else {
      state.results.push({ mobile, ok: false, message: result.message });
      state.message = `❌ ${mobile}: ${result.message}`;
    }
    state.status = state.count >= state.target ? 'done' : 'need_number';
  } catch (error) {
    state.results.push({ mobile, ok: false, message: String(error?.message || error).slice(0, 200) });
    state.status = 'need_number';
    state.message = `❌ ${mobile}: ${String(error?.message || error).slice(0, 200)}`;
  }
}

// ─── HTML page ───
const PAGE_HTML = `<!doctype html>
<html lang="hi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gold Drop Local</title>
<style>
body{background:#0f1220;color:#e8eaf2;font-family:system-ui,Segoe UI,Roboto,sans-serif;margin:0;padding:24px}
.card{max-width:560px;margin:0 auto;background:#181c2e;border:1px solid #2a3050;border-radius:14px;padding:20px}
h1{font-size:20px;margin:0 0 4px} .sub{color:#8a90ad;font-size:13px;margin-bottom:16px}
label{display:block;font-size:12px;color:#9aa1bd;margin:10px 0 4px}
input,button{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:9px;border:1px solid #2a3050;background:#0f1220;color:#e8eaf2;font-size:15px}
button{background:#f7b500;color:#191300;font-weight:700;border:none;cursor:pointer;margin-top:14px}
button.secondary{background:#232845;color:#e8eaf2}
.status{background:#10142a;border:1px solid #2a3050;border-radius:10px;padding:12px;margin-top:16px;font-size:14px;white-space:pre-wrap}
.log{background:#0a0c18;border-radius:10px;padding:10px;font:12px/1.5 monospace;color:#7d84a8;max-height:220px;overflow:auto;margin-top:12px;white-space:pre-wrap}
.row{display:flex;gap:10px}.row>div{flex:1}
.badge{display:inline-block;padding:2px 10px;border-radius:99px;background:#232845;font-size:12px}
</style></head><body><div class="card">
<h1>🟡 Gold Drop — Local</h1>
<div class="sub">Sab kuch isi PC par chalega. Browser tumhare saamne khulega (LIVE).</div>
<div id="setup">
<label>Naam</label><input id="name" value="Rahul Kumar">
<label>Email (Gmail — har number par +suffix apne aap)</label><input id="email" value="itsnoob012@gmail.com">
<div class="row"><div><label>PIN code</label><input id="pincode" value="509412"></div>
<div><label>Batch code</label><input id="code" value="KKD2LS01261026"></div></div>
<label>NoCaptchaAI API key (security check auto-solve — bot jaisa)</label><input id="nocapKey" value="${NOCAP_KEY_DEFAULT}">
<div class="sub" id="nocapbal">NoCaptchaAI balance check ho raha hai…</div>
<label>Pack photo (optional — na do to default use hogi)</label><input id="photo" type="file" accept="image/*">
<label>Kitne numbers process karne hain?</label><input id="target" type="number" value="5" min="1" max="100">
<button id="start">▶ START</button>
</div>
<div id="run" style="display:none">
<div class="status"><span class="badge" id="st">…</span> <b id="prog"></b><div id="msg" style="margin-top:6px"></div></div>
<div id="askNumber" style="display:none"><label>Mobile number (apne OTP bot se naya number lo aur yahan daalo)</label>
<input id="mobile" inputmode="numeric" maxlength="10" placeholder="9876543210"><button id="sendNumber">Number bhejo → Register karo</button></div>
<div id="askOtp" style="display:none"><label>OTP (jo OTP bot me aaya)</label>
<input id="otp" inputmode="numeric" maxlength="6" placeholder="123456"><button id="sendOtp">OTP verify karo</button></div>
<button class="secondary" id="reset" style="margin-top:18px">■ Stop / Reset</button>
<div class="log" id="log"></div>
</div>
<div id="results" class="log" style="display:none"></div>
</div>
<script>
var pollTimer = null;
function $(id){return document.getElementById(id)}
function post(url, body){return fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})}).then(function(r){return r.json()})}
function show(id,on){$(id).style.display=on?'block':'none'}
function paint(s){
  $('st').textContent = s.status;
  $('prog').textContent = s.count + ' / ' + s.target + ' done';
  $('msg').textContent = s.message || '';
  show('askNumber', s.status==='need_number');
  show('askOtp', s.status==='need_otp');
  show('log', s.log.length>0);
  $('log').textContent = s.log.slice(-40).join('\\n');
  var r = $('results');
  if (s.results.length){ r.style.display='block'; r.textContent = s.results.map(function(x){return (x.ok?'✅':'❌')+' '+x.mobile+' — '+x.message}).join('\\n'); }
}
function poll(){ fetch('/state').then(function(r){return r.json()}).then(paint).catch(function(){}) }
$('start').onclick = function(){
  var file = $('photo').files[0];
  var body = { name:$('name').value.trim(), email:$('email').value, pincode:$('pincode').value, code:$('code').value, target:Number($('target').value)||1, nocapKey:$('nocapKey').value.trim() };
  var go = function(){
    post('/start', body).then(function(r){
      if(!r.ok){ alert(r.message||'Error'); return }
      show('setup',false); show('run',true); poll();
    });
  };
  if (file){
    var rd = new FileReader();
    rd.onload = function(){ body.photo = String(rd.result).split(',')[1]; go() };
    rd.readAsDataURL(file);
  } else go();
};
$('sendNumber').onclick = function(){ var m=$('mobile').value.replace(/\\D/g,'').slice(-10); if(m.length!==10){alert('10-digit mobile daalo');return} $('mobile').value=''; post('/number',{mobile:m}).then(poll) };
$('sendOtp').onclick = function(){ var o=$('otp').value.replace(/\\D/g,''); if(o.length!==6){alert('6-digit OTP daalo');return} $('otp').value=''; post('/otp',{otp:o}).then(poll) };
$('reset').onclick = function(){ post('/reset').then(function(){ location.reload() }) };
pollTimer = setInterval(poll, 1200); poll();
post('/nocap-balance',{key:$('nocapKey').value.trim()}).then(function(r){ $('nocapbal').textContent = r.message || ''; }).catch(function(){ $('nocapbal').textContent=''; });
</script></body></html>`;

// ─── HTTP server ───
function sendJson(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE_HTML);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/state') {
      sendJson(res, 200, { status: state.status, message: state.message, count: state.count, target: state.target, results: state.results.slice(-50), log: state.log.slice(-60) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/start') {
      if (state.status !== 'idle' && state.status !== 'done') return sendJson(res, 409, { ok: false, message: 'Pehle se chal raha hai — Stop/Reset dabao.' });
      const body = await readBody(req);
      if (!body.name || !body.email || !/^\d{6}$/.test(body.pincode || '') || !body.code) {
        return sendJson(res, 400, { ok: false, message: 'Naam, email, 6-digit PIN code aur batch code — sab bharna zaroori hai.' });
      }
      const nocapKey = String(body.nocapKey || '').trim() || NOCAP_KEY_DEFAULT;
      state.details = { name: body.name, email: body.email, pincode: body.pincode, code: body.code, nocapKey };
      nocapBalanceText(nocapKey).then(text => logLine(text));
      state.target = Math.min(100, Math.max(1, Number(body.target) || 1));
      state.count = 0; state.results = []; state.log = []; state.mobile = '';
      mkdirSync(path.join(ROOT, 'data'), { recursive: true });
      state.photoPath = '';
      if (body.photo) {
        state.photoPath = path.join(ROOT, 'data', 'pack-upload.jpg');
        writeFileSync(state.photoPath, Buffer.from(String(body.photo), 'base64'));
      } else {
        const bundled = path.join(ROOT, 'assets', 'gold-drop-pack.jpg');
        if (existsSync(bundled)) state.photoPath = bundled;
      }
      state.status = 'need_number';
      state.message = 'Pehla mobile number daalo (apne OTP bot se naya number lo).';
      logLine(`START — target ${state.target}, details saved${state.photoPath ? ', photo ready' : ''}`);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/number') {
      if (state.status !== 'need_number') return sendJson(res, 409, { ok: false, message: 'Abhi number ki zaroorat nahi.' });
      const body = await readBody(req);
      const mobile = String(body.mobile || '').replace(/\D/g, '').slice(-10);
      if (!/^[6789]\d{9}$/.test(mobile)) return sendJson(res, 400, { ok: false, message: 'Valid 10-digit Indian mobile daalo (6/7/8/9 se shuru).' });
      processNumber(mobile); // background me — UI poll karti rahegi
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/otp') {
      if (state.status !== 'need_otp') return sendJson(res, 409, { ok: false, message: 'Abhi OTP ki zaroorat nahi.' });
      const body = await readBody(req);
      const otp = String(body.otp || '').replace(/\D/g, '');
      if (!/^\d{6}$/.test(otp)) return sendJson(res, 400, { ok: false, message: '6-digit OTP daalo.' });
      processOtp(otp);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/reset') {
      state.status = 'idle'; state.message = ''; state.count = 0; state.mobile = '';
      if (browser) { const b = browser; browser = null; page = null; b.close().catch(() => {}); }
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/nocap-balance') {
      const body = await readBody(req);
      const key = String(body.key || '').trim() || NOCAP_KEY_DEFAULT;
      return sendJson(res, 200, { ok: true, message: await nocapBalanceText(key) });
    }
    sendJson(res, 404, { ok: false, message: 'Not found' });
  } catch (error) {
    sendJson(res, 500, { ok: false, message: String(error?.message || error).slice(0, 200) });
  }
});

server.listen(PORT, () => {
  console.log(`\\n🟡 Gold Drop Local chal raha hai — kholo: http://localhost:${PORT}\\n`);
});
