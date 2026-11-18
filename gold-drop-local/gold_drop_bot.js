// Gold Drop Playwright Runner (headless: false, real Chrome/Chromium).
// Usage:
//   cd gold-drop-local && npm install && npx playwright install chromium
//   node gold_drop_bot.js
// Optional env vars:
//   NOCAPTCHA_KEY=nocap_...  (or NOCAP_API_KEY; omit for real-browser manual/passive Turnstile)
//   GOLD_DROP_NAME="Rahul Kumar" GOLD_DROP_EMAIL="itsnoob012@gmail.com"
//   GOLD_DROP_PINCODE="509412" GOLD_DROP_BATCH="KKD2LS01261026"
//   GOLD_DROP_MOBILES="9876543210,9876543211"
//   GOLD_DROP_PHOTO="./assets/gold-drop-pack.jpg"
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REGISTRATION_URL = process.env.GOLD_DROP_SITE_URL || 'https://golddropgolddhamaka.com/register';
const BATCH_CODE = process.env.GOLD_DROP_BATCH || 'KKD2LS01261026';
const DEFAULT_PINCODE = process.env.GOLD_DROP_PINCODE || '509412';
const DEFAULT_NAME = process.env.GOLD_DROP_NAME || 'Rahul Kumar';
const DEFAULT_EMAIL = process.env.GOLD_DROP_EMAIL || 'itsnoob012@gmail.com';
const DEFAULT_PHOTO = process.env.GOLD_DROP_PHOTO || path.join(ROOT, 'assets', 'gold-drop-pack.jpg');
const NOCAP_API = 'https://api.nocaptchaai.com';

function emailForMobile(email, mobile) {
  const m = /^([^@+]+)@(gmail\.com)$/i.exec(String(email || ''));
  if (!m) return String(email || '');
  const d = String(mobile).split('');
  let s = '';
  for (let i = 0; i < 6 && d.length; i++) s += d.splice(Math.floor(Math.random() * d.length), 1)[0];
  return `${m[1]}+${s}@${m[2]}`;
}

export async function solveTurnstile(sitekey, pageUrl = REGISTRATION_URL) {
  const key = String(process.env.NOCAPTCHA_KEY || process.env.NOCAP_API_KEY || '').trim();
  if (!key || !sitekey) return '';

  // 1) Sync /solve endpoint
  try {
    const syncRes = await fetch(`${NOCAP_API}/solve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: key },
      body: JSON.stringify({ sitekey, url: pageUrl, type: 'turnstile' }),
      signal: AbortSignal.timeout(30000),
    }).then(r => r.json());
    const tok = syncRes?.token || syncRes?.solution?.token || '';
    if (tok) return tok;
  } catch {}

  // 2) Async /createTask -> /getTaskResult (v2)
  for (const type of ['AntiTurnstileTask', 'AntiTurnstileTaskProxyLess', 'CloudflareTurnstileTaskProxyLess', 'TurnstileTaskProxyLess']) {
    try {
      const created = await fetch(`${NOCAP_API}/createTask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', apikey: key },
        body: JSON.stringify({ clientKey: key, task: { type, websiteURL: pageUrl, websiteKey: sitekey } }),
        signal: AbortSignal.timeout(25000),
      }).then(r => r.json());
      if ((created.errorId ?? 0) !== 0 || !created.taskId) continue;
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000));
        const res = await fetch(`${NOCAP_API}/getTaskResult`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', apikey: key },
          body: JSON.stringify({ clientKey: key, taskId: created.taskId }),
          signal: AbortSignal.timeout(20000),
        }).then(r => r.json()).catch(() => ({}));
        if (String(res.status || '').toLowerCase() === 'ready' && res.solution?.token) {
          return res.solution.token;
        }
        if (String(res.status || '').toLowerCase() === 'failed') break;
      }
    } catch {}
  }
  return '';
}

async function fillFirstVisible(page, selectors, value) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      await loc.fill(String(value));
      return true;
    }
  }
  return false;
}

async function runAutomation() {
  const { chromium } = await import('playwright');
  if (!existsSync(DEFAULT_PHOTO)) throw new Error(`Photo nahi mili: ${DEFAULT_PHOTO}`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const envMobiles = String(process.env.GOLD_DROP_MOBILES || '')
    .split(/[\s,]+/)
    .map(s => s.replace(/\D/g, '').slice(-10))
    .filter(s => /^[6789]\d{9}$/.test(s));

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Capture Turnstile render callback & sitekey before page scripts execute
  await page.addInitScript(() => {
    const store = { sitekey: '', callback: null, token: '' };
    window.__gdTurnstile = store;
    const hook = () => {
      const t = window.turnstile;
      if (!t) { setTimeout(hook, 200); return; }
      if (t.__gdHooked) return;
      t.__gdHooked = true;
      const origRender = t.render && t.render.bind(t);
      if (origRender) {
        t.render = (el, params) => {
          if (params?.sitekey) store.sitekey = params.sitekey;
          if (typeof params?.callback === 'function') store.callback = params.callback;
          return origRender(el, params);
        };
      }
      const origGet = t.getResponse && t.getResponse.bind(t);
      t.getResponse = (...a) => store.token || (origGet ? origGet(...a) : '');
    };
    hook();
  });

  try {
    let idx = 0;
    while (true) {
      let mobile = envMobiles[idx];
      if (envMobiles.length && !mobile) break;
      if (!mobile) {
        const ans = await rl.question('\n📱 10-digit mobile daalo (ya quit): ');
        if (/^(q|quit|exit)$/i.test(ans.trim())) break;
        mobile = ans.replace(/\D/g, '').slice(-10);
        if (!/^[6789]\d{9}$/.test(mobile)) {
          console.log('❌ Valid 10-digit Indian mobile chahiye.');
          continue;
        }
      }
      idx++;

      const email = emailForMobile(DEFAULT_EMAIL, mobile);
      console.log(`[+] Submitting ${mobile} (${email}) with Pincode ${DEFAULT_PINCODE}, Batch ${BATCH_CODE}`);
      await page.goto(REGISTRATION_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);

      await fillFirstVisible(page, ["input[name*='name' i]", "input[id*='name' i]", "input[placeholder*='name' i]"], DEFAULT_NAME);
      await fillFirstVisible(page, ["input[type='tel']", "input[name*='mobile' i]", "input[id*='mobile' i]", "input[placeholder*='mobile' i]", "input[name*='phone' i]"], mobile);
      await fillFirstVisible(page, ["input[type='email']", "input[name*='email' i]", "input[id*='email' i]"], email);
      await fillFirstVisible(page, ["input[name*='pin' i]", "input[id*='pin' i]", "input[placeholder*='pin' i]"], DEFAULT_PINCODE);
      await fillFirstVisible(page, ["#batch_code", "input[name*='batch' i]", "input[id*='batch' i]", "input[name*='code' i]", "input[id*='code' i]"], BATCH_CODE);

      const fileInput = page.locator("input[type='file']").first();
      if (await fileInput.count()) await fileInput.setInputFiles(DEFAULT_PHOTO);

      // Check terms checkbox if present
      const terms = page.locator("input[type='checkbox']").first();
      if (await terms.isVisible().catch(() => false)) {
        if (!(await terms.isChecked().catch(() => false))) await terms.check().catch(() => {});
      }

      const sitekey = await page.evaluate(() => {
        const el = document.querySelector('.cf-turnstile[data-sitekey], [data-sitekey]');
        return (el && el.getAttribute('data-sitekey')) || (window.__gdTurnstile && window.__gdTurnstile.sitekey) || '';
      });
      if (sitekey) {
        const token = await solveTurnstile(sitekey, page.url());
        if (token) {
          await page.evaluate((t) => {
            if (window.__gdTurnstile) window.__gdTurnstile.token = t;
            document.querySelectorAll('[name="cf-turnstile-response"]').forEach((input) => { input.value = t; });
            if (window.__gdTurnstile && typeof window.__gdTurnstile.callback === 'function') {
              try { window.__gdTurnstile.callback(t); } catch {}
            }
          }, token);
          console.log('✅ Turnstile token injected');
        } else {
          console.log('⚠️ Turnstile key missing/failed — browser window me checkbox khud tick karein (ya passive pass ka wait karein).');
          await page.waitForFunction(() => {
            const el = document.querySelector('[name="cf-turnstile-response"]');
            return Boolean(el && el.value && el.value.length > 20);
          }, null, { timeout: 60000 }).catch(() => {});
        }
      }

      const submitBtn = page.locator("#submit_btn, button[type='submit'], button:has-text('Submit'), button:has-text('Register'), button:has-text('Send OTP')").first();
      if (await submitBtn.isVisible().catch(() => false)) await submitBtn.click();
      await page.waitForTimeout(2500);

      const otpRaw = await rl.question(`🔐 ${mobile} par aaya 6-digit OTP daalo (ya skip): `);
      const otp = otpRaw.replace(/\D/g, '');
      if (/^\d{6}$/.test(otp)) {
        await fillFirstVisible(page, ["input[autocomplete='one-time-code']", "input[name*='otp' i]", "input[id*='otp' i]", "input[placeholder*='otp' i]"], otp);
        const verifyBtn = page.locator("button:has-text('Verify'), button:has-text('Submit'), button[type='submit']").first();
        if (await verifyBtn.isVisible().catch(() => false)) await verifyBtn.click();
        await page.waitForTimeout(3000);
        console.log(`✅ ${mobile} OTP submitted.`);
      }
    }
  } finally {
    rl.close();
    await browser.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runAutomation().catch((err) => {
    console.error('❌ Gold Drop bot error:', err?.message || err);
    process.exitCode = 1;
  });
}
