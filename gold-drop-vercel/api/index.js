// 🟡 Gold Drop + 📱 Live Spare Telegram OTP — VERCEL split-screen dashboard.
// Left side: up to 50 spare Telegram accounts + exact live OTP bot card (clickable inline buttons).
// Right side: normal Gold Drop card (pack photo pre-selected, auto-fill from Telegram card).
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { registerGoldDrop, verifyGoldDropOtp } from './_gold-drop.js';

if (!process.env.DATA_DIR && process.env.VERCEL) {
  process.env.DATA_DIR = '/tmp/workwr-data';
}

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const NOCAP_API = 'https://api.nocaptchaai.com';
const NOCAP_KEY_DEFAULT = process.env.NOCAP_API_KEY || 'nocap_eVBzrYeejjgKLoikEErH6lbP';
const DEFAULT_PHOTO_URL = 'https://raw.githubusercontent.com/hulm0408/workwr/main/gold-drop-vercel/api/gold-drop-pack.jpg';
const MAX_TG_ACCOUNTS = 50;
let cachedDefaultPhoto = '';
let _tgModPromise = null;

async function loadTgMod() {
  if (!process.env.DATA_DIR && process.env.VERCEL) {
    process.env.DATA_DIR = '/tmp/workwr-data';
  }
  if (!_tgModPromise) {
    _tgModPromise = import('../../telegram-otp-source.js').catch((err) => {
      _tgModPromise = null;
      throw err;
    });
  }
  return _tgModPromise;
}

async function getDefaultPhoto() {
  if (cachedDefaultPhoto) return cachedDefaultPhoto;
  try {
    cachedDefaultPhoto = readFileSync(path.join(ROOT, 'gold-drop-pack.jpg')).toString('base64');
    return cachedDefaultPhoto;
  } catch {
    const res = await fetch(DEFAULT_PHOTO_URL, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Default photo fetch failed: HTTP ${res.status}`);
    cachedDefaultPhoto = Buffer.from(await res.arrayBuffer()).toString('base64');
    return cachedDefaultPhoto;
  }
}

// ─── LOGIN + AES-256-GCM STATELESS SESSION TOKENS (supports up to 50 spare accounts) ───
const APP_PASSWORD = process.env.APP_PASSWORD || 'rahul@123';
const AUTH_COOKIE = `gd_auth=${createHash('sha256').update(`golddrop:${APP_PASSWORD}`).digest('hex')}`;
const TG_COOKIE_NAME = 'gd_tg_sess';

function sealSecretKey() {
  const material = `${APP_PASSWORD}:${process.env.TELEGRAM_API_HASH || ''}:${process.env.BOT_TOKEN || ''}:gd-tg-v1`;
  return createHash('sha256').update(material).digest();
}

function sealJson(obj) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealSecretKey(), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}

function unsealJson(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const iv = Buffer.from(parts[0], 'base64url');
    const tag = Buffer.from(parts[1], 'base64url');
    const enc = Buffer.from(parts[2], 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', sealSecretKey(), iv);
    decipher.setAuthTag(tag);
    const raw = Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const out = {};
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

function isAuthed(req) {
  const cookie = String(req.headers.cookie || '');
  return cookie.split(';').map(x => x.trim()).includes(AUTH_COOKIE);
}

function getTgCookieSession(req) {
  const cookies = parseCookies(req);
  const sealed = cookies[TG_COOKIE_NAME];
  if (!sealed) return null;
  const parsed = unsealJson(decodeURIComponent(sealed));
  if (!parsed || !parsed.session || !parsed.apiId || !parsed.apiHash) return null;
  return parsed;
}

function resolveTgSession(req, body = {}) {
  const token = String(body?.accountToken || '').trim();
  if (token) {
    const parsed = unsealJson(token);
    if (parsed && parsed.session && parsed.apiId && parsed.apiHash) return parsed;
  }
  return getTgCookieSession(req);
}

function tgCookieHeader(value, maxAge = 2592000) {
  const secure = process.env.VERCEL ? '; Secure' : '';
  return `${TG_COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

const LOGIN_HTML = `<!doctype html>
<html lang="hi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gold Drop — Login</title>
<style>
body{background:#0f1220;color:#e8eaf2;font-family:system-ui,Segoe UI,Roboto,sans-serif;margin:0;padding:24px;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{width:100%;max-width:360px;background:#181c2e;border:1px solid #2a3050;border-radius:14px;padding:24px}
h1{font-size:20px;margin:0 0 4px} .sub{color:#8a90ad;font-size:13px;margin-bottom:16px}
input,button{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:9px;border:1px solid #2a3050;background:#0f1220;color:#e8eaf2;font-size:15px}
button{background:#f7b500;color:#191300;font-weight:700;border:none;cursor:pointer;margin-top:14px}
.err{color:#ff6b6b;font-size:13px;margin-top:10px;display:none}
</style></head><body><div class="card">
<h1>🟡 Gold Drop</h1>
<div class="sub">Login karo — sirf apne log.</div>
<form method="POST" action="/login">
<input name="password" type="password" placeholder="Password" autofocus>
<button type="submit">🔓 Login</button>
<div class="err" id="err">Galat password</div>
</form>
</div>
<script>if(location.search.indexOf('wrong')>-1)document.getElementById('err').style.display='block';</script>
</body></html>`;

// ─── Gmail plus addressing: har number par +suffix ───
function emailForMobile(email, mobile) {
  const match = /^([^@+]+)@(gmail\.com)$/i.exec(String(email || ''));
  if (!match) return String(email || '');
  const digits = String(mobile).split('');
  let suffix = '';
  for (let i = 0; i < 6 && digits.length; i++) suffix += digits.splice(Math.floor(Math.random() * digits.length), 1)[0];
  return `${match[1]}+${suffix}@${match[2]}`;
}

// ─── In-memory Gold Drop run state ───
const state = {
  status: 'idle', // idle | need_number | working | need_otp | done
  message: '',
  target: 1,
  count: 0,
  mobile: '',
  details: null,
  session: null,
  results: [],
  log: [],
};

function logLine(message) {
  state.log.push(`[${new Date().toLocaleTimeString()}] ${message}`);
  if (state.log.length > 200) state.log.shift();
}

async function processNumber(mobile) {
  state.status = 'working';
  state.mobile = mobile;
  const d = state.details;
  const email = emailForMobile(d.email, mobile);
  logLine(`📱 ${mobile} — register ho raha hai (${email})…`);
  try {
    const res = await registerGoldDrop({
      name: d.name, mobile, email, pincode: d.pincode, code: d.code,
      imageBase64: d.photo, nocapApiKey: d.nocapKey,
    });
    state.session = res.session;
    if (res.securitySolved) logLine('🛡️ Security check aaya tha — NoCaptchaAI ne solve kar diya ✅');
    logLine(`✅ Register ho gaya — ${res.message}. OTP ka wait…`);
    state.status = 'need_otp';
    state.message = 'OTP bot me aaya 6-digit code yahan daalo';
    return { ok: true, status: state.status, message: state.message, session: res.session, mobile };
  } catch (error) {
    const message = String(error?.message || error).slice(0, 200);
    logLine(`❌ ${mobile} — ${message}`);
    const result = { mobile, ok: false, message };
    state.results.push(result);
    state.count = state.results.length;
    state.session = null;
    if (state.results.length >= state.target) {
      state.status = 'done';
      state.message = `${state.target} numbers process ho gaye — results neeche`;
    } else {
      state.status = 'need_number';
      state.message = 'Agla number daalo';
    }
    return { ok: true, status: state.status, message: state.message, session: null, result };
  }
}

async function processOtp(otp) {
  state.status = 'working';
  state.message = 'OTP verify ho raha hai…';
  const mobile = state.mobile;
  logLine(`🔐 ${mobile} — OTP ${otp} verify…`);
  let result;
  try {
    const res = await verifyGoldDropOtp({ session: state.session, otp });
    const rewardText = res.reward?.name ? ` 🎁 ${res.reward.name} (${res.reward.faceValue})` : '';
    logLine(`✅ ${mobile} verified — ${res.message}${rewardText}. Reward SMS ab phone par aayega.`);
    result = { mobile, ok: true, message: `${res.message}${rewardText}` };
    state.results.push(result);
  } catch (error) {
    const message = String(error?.message || error).slice(0, 200);
    logLine(`❌ ${mobile} — ${message}`);
    result = { mobile, ok: false, message };
    state.results.push(result);
  }
  state.session = null;
  state.mobile = '';
  state.count = state.results.length;
  if (state.results.length >= state.target) {
    state.status = 'done';
    state.message = `${state.target} numbers process ho gaye — results neeche`;
  } else {
    state.status = 'need_number';
    state.message = 'Agla number daalo';
  }
  return { ok: true, status: state.status, message: state.message, result };
}

// ─── SPLIT-SCREEN UI ───
const PAGE_HTML = `<!doctype html>
<html lang="hi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gold Drop × Live Telegram OTP</title>
<style>
:root{
  --bg:#0b0e19; --card:#15192b; --border:#273052;
  --text:#edf0fb; --muted:#8f97b8; --gold:#f7b500; --tg:#2ea6ff; --green:#10b981; --red:#ff6b6b;
}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:16px}
.topbar{max-width:1260px;margin:0 auto 14px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:10px 16px;background:var(--card);border:1px solid var(--border);border-radius:12px}
.topbar h1{font-size:17px;margin:0;display:flex;align-items:center;gap:8px}
.grid{max-width:1260px;margin:0 auto;display:grid;grid-template-columns:minmax(330px,1.02fr) minmax(330px,1fr);gap:16px;align-items:start}
@media(max-width:880px){.grid{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:18px}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--border)}
.card-title{font-size:17px;font-weight:700;display:flex;align-items:center;gap:8px}
.sub{color:var(--muted);font-size:12px}
.badge{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:99px;background:#202744;border:1px solid var(--border);font-size:11.5px;font-weight:600;color:#cbd5f5}
.badge.ok{background:rgba(16,185,129,.14);color:#6ee7b7;border-color:rgba(16,185,129,.4)}
.badge.gold{background:rgba(247,181,0,.15);color:#ffd24c;border-color:rgba(247,181,0,.4)}
.badge.tg{background:rgba(46,166,255,.15);color:#7cc4ff;border-color:rgba(46,166,255,.4)}
label{display:block;font-size:12px;color:#9aa2c2;margin:10px 0 4px}
input,select,button{font-family:inherit}
input,select{width:100%;padding:9px 11px;border-radius:9px;border:1px solid var(--border);background:#0d1122;color:var(--text);font-size:14px;outline:none}
input:focus,select:focus{border-color:var(--tg)}
button{padding:9px 12px;border-radius:9px;border:1px solid var(--border);background:#232946;color:var(--text);font-size:13.5px;font-weight:600;cursor:pointer}
button:hover:not(:disabled){filter:brightness(1.1)}
button:disabled{opacity:.5;cursor:not-allowed}
button.gold{background:var(--gold);color:#191200;border-color:transparent;font-weight:700}
button.tg{background:var(--tg);color:#031524;border-color:transparent;font-weight:700}
button.green{background:var(--green);color:#021c14;border-color:transparent;font-weight:700}
button.secondary{background:#232845;color:#e8eaf2}
button.danger{background:#3a1d27;color:#ff9aa6;border-color:#5d2b3b}
button.sm{padding:6px 10px;font-size:12px;border-radius:8px}
.row{display:flex;gap:10px;align-items:center}.row>*{flex:1}
.btn-strip{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
/* Spare accounts bar */
.acct-bar{background:#0f1426;border:1px solid var(--border);border-radius:10px;padding:9px 10px;margin-bottom:10px}
.acct-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
/* Exact Telegram Chat Card Mirror */
.tg-chat{background:#0e1621;border:1px solid #1f2e42;border-radius:13px;padding:12px;margin-top:10px}
.tg-chat-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;font-size:12px;color:#7da3c9}
.tg-bubble{background:#182533;border:1px solid #26394e;border-radius:12px 12px 12px 4px;padding:12px 13px;font-size:13.5px;line-height:1.48;white-space:pre-wrap;word-break:break-word;color:#eaf2fb}
.tg-meta{display:flex;justify-content:space-between;font-size:11px;color:#6f8ca8;margin-top:6px}
.tg-kb{margin-top:8px;display:flex;flex-direction:column;gap:6px}
.tg-kb-row{display:flex;gap:6px}
.tg-kb-btn{flex:1;background:#243548;border:1px solid #324963;color:#e9f2fc;border-radius:8px;padding:8px 10px;font-size:12.5px;font-weight:600;text-align:center}
.tg-toast{margin-top:8px;padding:7px 10px;border-radius:8px;background:rgba(46,166,255,.12);border:1px solid rgba(46,166,255,.32);color:#9ad0ff;font-size:12px}
.extract-bar{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
@media(max-width:520px){.extract-bar{grid-template-columns:1fr}}
.extract-box{background:#0d1424;border:1px solid var(--border);border-radius:10px;padding:9px 10px}
.extract-box .k{font-size:11px;color:var(--muted)}
.extract-box .v{font-size:16px;font-weight:700;font-family:ui-monospace,monospace;margin:3px 0 6px;color:#fff}
.recent-list{margin-top:8px;display:flex;flex-direction:column;gap:6px;max-height:170px;overflow:auto}
.recent-item{background:#0d1322;border:1px solid #1f2944;border-radius:8px;padding:7px 9px;font-size:11.5px;white-space:pre-wrap;color:#b8c4de}
.recent-item.has-otp{border-color:rgba(16,185,129,.55);background:rgba(16,185,129,.08)}
/* Gold Drop normal card helpers */
.photo-box{display:flex;align-items:center;gap:10px;background:#0d1122;border:1px solid rgba(16,185,129,.4);border-radius:10px;padding:8px 10px}
.photo-box img{width:46px;height:46px;object-fit:cover;border-radius:7px;border:1px solid var(--border);background:#1b2238}
.status{background:#10142a;border:1px solid var(--border);border-radius:10px;padding:12px;margin-top:12px;font-size:14px;white-space:pre-wrap}
.log{background:#0a0c18;border:1px solid #1d2440;border-radius:10px;padding:10px;font:12px/1.5 ui-monospace,monospace;color:#8b94b8;max-height:210px;overflow:auto;margin-top:12px;white-space:pre-wrap}
a{color:var(--gold);text-decoration:none}
</style></head><body>

<div class="topbar">
  <div>
    <h1>🟡 Gold Drop × 📱 Live Telegram OTP</h1>
    <div class="sub">Left: spare Telegram accounts (up to 50) & live OTP bot card · Right: Gold Drop card</div>
  </div>
  <div class="btn-strip">
    <a class="badge" href="/health" target="_blank">🩺 Bot Health</a>
    <a class="badge" href="/logout">🚪 Logout</a>
  </div>
</div>

<div class="grid">
  <!-- LEFT PANEL: UP TO 50 SPARE TELEGRAM ACCOUNTS + EXACT OTP CARD -->
  <div class="card">
    <div class="card-head">
      <div class="card-title">📱 Telegram OTP Card <span class="badge" id="tgConnPill">0 / 50</span></div>
      <div class="btn-strip">
        <select id="tgBotProfile" style="width:auto;padding:5px 8px;font-size:12px">
          <option value="hermes">@HermeshuOTPROBOT</option>
          <option value="hathi">@Hathi_otp_bot</option>
          <option value="chauhan">@HardXotp_Bot</option>
        </select>
      </div>
    </div>

    <!-- Multi-account switcher (up to 50 spare accounts) -->
    <div class="acct-bar" id="tgAcctBar" style="display:none">
      <div class="acct-row">
        <select id="tgAcctSelect" style="flex:1;padding:7px 9px;font-size:12.5px"></select>
        <button class="sm tg" id="tgAddAcctBtn" type="button">+ Add</button>
        <button class="sm" id="tgNextAcctBtn" type="button" title="Next Spare Account">⇄ Next</button>
        <button class="sm danger" id="tgDelAcctBtn" type="button" title="Remove Account">✕</button>
      </div>
      <div class="sub" id="tgAcctMeta" style="margin-top:5px"></div>
    </div>

    <!-- Step A: Telegram Spare Account Login / Add New Account -->
    <div id="tgLoginBox" style="display:none">
      <div class="status" style="margin-top:0">
        <b id="tgLoginTitle">Spare Telegram Account Connect Karein (max 50)</b>
        <div class="sub" style="margin-top:4px">Seedha yahin se login karo — har account saved rahega aur ek click me switch hoga.</div>
      </div>
      <label>Phone Number (country code ke saath)</label>
      <input id="tgPhone" placeholder="+8801322367848" value="+8801322367848">
      <div id="tgCustomApiWrap" style="display:none">
        <div class="row">
          <div><label>TELEGRAM_API_ID</label><input id="tgApiId" placeholder="36215289"></div>
          <div><label>TELEGRAM_API_HASH</label><input id="tgApiHash" placeholder="API hash"></div>
        </div>
      </div>
      <div class="btn-strip" style="margin-top:8px">
        <button class="tg" id="tgSendCodeBtn" style="flex:1">📨 Send Login OTP</button>
        <button class="sm" id="tgToggleApiBtn" type="button">⚙️ Custom API</button>
        <button class="sm secondary" id="tgCancelAddBtn" type="button" style="display:none">Back to Card</button>
      </div>

      <div id="tgCodeBox" style="display:none;margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">
        <label>Telegram Login OTP Code</label>
        <input id="tgLoginCode" inputmode="numeric" placeholder="12345">
        <div id="tg2faWrap" style="display:none">
          <label id="tg2faLabel">2FA Password (agar account par laga hai)</label>
          <input id="tg2faPass" type="password" placeholder="Telegram 2FA password">
        </div>
        <button class="green" id="tgVerifyCodeBtn" style="width:100%;margin-top:8px">✅ Verify & Save Account</button>
      </div>
      <div class="sub" id="tgLoginMsg" style="margin-top:8px;color:#ffd24c"></div>
    </div>

    <!-- Step B: Exact Telegram OTP Bot Card Mirror -->
    <div id="tgLiveBox" style="display:none">
      <div class="btn-strip">
        <button class="tg sm" id="tgRefreshBtn">🔄 Refresh Card</button>
        <button class="sm" id="tgSendStartBtn">▶ /start</button>
        <button class="sm" id="tgAutoPollBtn">⏱ Poll: ON</button>
      </div>

      <div class="tg-chat">
        <div class="tg-chat-bar">
          <span id="tgBotTitle">@HermeshuOTPROBOT</span>
          <span id="tgUpdatedAt">—</span>
        </div>
        <div class="tg-bubble" id="tgCardText">Card load ho raha hai…</div>
        <div class="tg-meta">
          <span id="tgCardMsgId">msg #—</span>
          <span id="tgMeLabel">account —</span>
        </div>
        <div class="tg-toast" id="tgToast" style="display:none"></div>
        <div class="tg-kb" id="tgButtons"></div>
      </div>

      <div class="extract-bar">
        <div class="extract-box">
          <div class="k">📱 Card Number</div>
          <div class="v" id="tgFoundPhone">—</div>
          <button class="gold sm" id="fillPhoneBtn" style="width:100%" disabled>➡ Fill Number</button>
        </div>
        <div class="extract-box">
          <div class="k">🔐 Card OTP</div>
          <div class="v" id="tgFoundOtp">—</div>
          <button class="green sm" id="fillOtpBtn" style="width:100%" disabled>➡ Fill OTP</button>
        </div>
      </div>

      <label style="margin-top:10px">Recent Messages</label>
      <div class="recent-list" id="tgRecentList"></div>
    </div>
  </div>

  <!-- RIGHT PANEL: NORMAL GOLD DROP CARD -->
  <div class="card">
    <div class="card-head">
      <div class="card-title">🟡 Gold Drop <span class="badge gold" id="gdStatusPill">idle</span></div>
      <div class="btn-strip">
        <button class="sm" id="autoFillBtn" type="button">⚡ Auto-Fill: ON</button>
      </div>
    </div>
    <div class="sub" style="margin-bottom:10px">Direct API method — koi browser nahi, sab cloud par chalta hai.</div>

    <div id="setup">
      <label>Naam</label>
      <input id="name" value="Rahul Kumar">
      <label>Email (Gmail — har number par +suffix apne aap)</label>
      <input id="email" value="itsnoob012@gmail.com">
      <div class="row">
        <div><label>PIN code</label><input id="pincode" value="509412"></div>
        <div><label>Batch code</label><input id="code" value="KKD2LS01261026"></div>
      </div>
      <label>NoCaptchaAI API key (security check auto-solve)</label>
      <input id="nocapKey" value="${NOCAP_KEY_DEFAULT}">
      <div class="sub" id="nocapbal" style="margin-top:4px">NoCaptchaAI balance check ho raha hai…</div>

      <label>Pack photo (already selected)</label>
      <div class="photo-box">
        <img id="photoPreview" src="/api/default-photo" alt="Gold Drop Pack">
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;color:#6ee7b7" id="photoStatus">✅ gold-drop-pack.jpg (Already Selected)</div>
          <div class="sub" id="photoSub">Default Gold Drop pack image ready hai</div>
        </div>
        <button class="sm secondary" id="changePhotoBtn" type="button">Change</button>
        <button class="sm secondary" id="resetPhotoBtn" type="button" style="display:none">Default</button>
        <input id="photo" type="file" accept="image/*" style="display:none">
      </div>

      <label>Kitne numbers process karne hain?</label>
      <input id="target" type="number" value="5" min="1" max="100">

      <button class="gold" id="start" style="width:100%;margin-top:14px;padding:11px">▶ START</button>
    </div>

    <div id="run" style="display:none">
      <div class="status">
        <span class="badge gold" id="st">…</span> <b id="prog" style="margin-left:6px"></b>
        <div id="msg" style="margin-top:6px"></div>
      </div>
      <div id="askNumber" style="display:none">
        <label>Mobile number (Telegram card se auto-fill ya manually daalo)</label>
        <div class="row">
          <input id="mobile" inputmode="numeric" maxlength="10" placeholder="9876543210">
          <button class="gold" id="sendNumber" style="flex:0 0 auto">Number bhejo → Register</button>
        </div>
      </div>
      <div id="askOtp" style="display:none">
        <label>OTP (Telegram card se auto-fill ya manually daalo)</label>
        <div class="row">
          <input id="otp" inputmode="numeric" maxlength="6" placeholder="123456">
          <button class="green" id="sendOtp" style="flex:0 0 auto">OTP verify karo</button>
        </div>
      </div>
      <button class="secondary" id="reset" style="width:100%;margin-top:14px">■ Stop / Reset</button>
    </div>

    <div class="log" id="log" style="display:none"></div>
    <div id="results" class="log" style="display:none;color:#a7f3d0"></div>
  </div>
</div>

<script>
var MAX_ACCOUNTS = ${MAX_TG_ACCOUNTS};
var LS_ACCOUNTS = 'gd_tg_accounts_v1';
var LS_ACTIVE = 'gd_tg_active_v1';
var LS_FORM = 'gd_form_v1';

var tgState = {
  accounts: [], // [{ id, phone, me, token }]
  activeId: '',
  addingNew: false,
  loginToken: '',
  autoPoll: true,
  busy: false,
  lastScreen: null,
  lastConsumedPhone: '',
  lastConsumedOtpKey: '',
};
var localRun = { active: false, status: 'idle', message: '', target: 1, count: 0, mobile: '', details: null, session: null, results: [], log: [] };
var autoSync = true;
var customPhotoBase64 = '';

function $(id){ return document.getElementById(id); }
function show(id, on){ $(id).style.display = on ? 'block' : 'none'; }
function post(url, body){
  return fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body||{}) }).then(function(r){ return r.json(); });
}
function fmtTime(ms){
  if (!ms) return '—';
  try { return new Date(ms).toLocaleTimeString(); } catch { return '—'; }
}

// ─── MULTI-ACCOUNT STORAGE (UP TO 50 SPARE ACCOUNTS) ───
function loadStoredAccounts(){
  try {
    var arr = JSON.parse(localStorage.getItem(LS_ACCOUNTS) || '[]');
    if (Array.isArray(arr)) {
      tgState.accounts = arr.filter(function(a){ return a && a.id && a.token; }).slice(0, MAX_ACCOUNTS);
    }
    tgState.activeId = localStorage.getItem(LS_ACTIVE) || (tgState.accounts[0] ? tgState.accounts[0].id : '');
    if (tgState.activeId && !getActiveAccount() && tgState.accounts[0]) {
      tgState.activeId = tgState.accounts[0].id;
    }
  } catch {}
}
function saveStoredAccounts(){
  try {
    localStorage.setItem(LS_ACCOUNTS, JSON.stringify(tgState.accounts.slice(0, MAX_ACCOUNTS)));
    localStorage.setItem(LS_ACTIVE, tgState.activeId || '');
  } catch {}
}
function getActiveAccount(){
  for (var i = 0; i < tgState.accounts.length; i++) {
    if (tgState.accounts[i].id === tgState.activeId) return tgState.accounts[i];
  }
  return null;
}

function renderAccountsUI(){
  var count = tgState.accounts.length;
  var active = getActiveAccount();
  var bar = $('tgAcctBar');
  var sel = $('tgAcctSelect');
  sel.innerHTML = '';

  if (count > 0) {
    bar.style.display = 'block';
    tgState.accounts.forEach(function(a, idx){
      var opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = '#' + (idx + 1) + ' · ' + (a.phone || 'Account') + (a.me ? (' — ' + a.me) : '');
      if (a.id === tgState.activeId) opt.selected = true;
      sel.appendChild(opt);
    });
    $('tgAcctMeta').textContent = count + ' / ' + MAX_ACCOUNTS + ' spare accounts saved' + (active ? (' · Active: ' + (active.me || active.phone)) : '');
    $('tgAddAcctBtn').disabled = count >= MAX_ACCOUNTS;
    $('tgAddAcctBtn').textContent = count >= MAX_ACCOUNTS ? 'Max 50' : '+ Add (' + count + '/50)';
    $('tgNextAcctBtn').disabled = count < 2;
  } else {
    bar.style.display = 'none';
  }

  if (active && !tgState.addingNew) {
    $('tgConnPill').textContent = '🟢 ' + count + '/' + MAX_ACCOUNTS + ' · ' + (active.me || active.phone);
    $('tgConnPill').className = 'badge ok';
    show('tgLoginBox', false);
    show('tgLiveBox', true);
  } else {
    $('tgConnPill').textContent = count > 0 ? (count + ' / ' + MAX_ACCOUNTS + ' · Adding') : '0 / ' + MAX_ACCOUNTS;
    $('tgConnPill').className = count > 0 ? 'badge tg' : 'badge';
    $('tgLoginTitle').textContent = count > 0
      ? ('New Spare Account Add Karein (' + (count + 1) + ' / ' + MAX_ACCOUNTS + ')')
      : 'Spare Telegram Account Connect Karein (max 50)';
    $('tgCancelAddBtn').style.display = count > 0 ? 'inline-block' : 'none';
    show('tgLoginBox', true);
    show('tgLiveBox', false);
  }
}

function activateAccount(id){
  tgState.activeId = id;
  tgState.addingNew = false;
  tgState.lastScreen = null;
  saveStoredAccounts();
  renderAccountsUI();
  var acct = getActiveAccount();
  if (acct) {
    post('/api/tg/activate', { accountToken: acct.token }).catch(function(){});
    refreshTgCard({ sendStartIfEmpty: true });
  }
}

$('tgAcctSelect').onchange = function(){ activateAccount($('tgAcctSelect').value); };
$('tgNextAcctBtn').onclick = function(){
  if (tgState.accounts.length < 2) return;
  var idx = -1;
  for (var i = 0; i < tgState.accounts.length; i++) {
    if (tgState.accounts[i].id === tgState.activeId) { idx = i; break; }
  }
  var next = tgState.accounts[(idx + 1) % tgState.accounts.length];
  if (next) activateAccount(next.id);
};
$('tgAddAcctBtn').onclick = function(){
  if (tgState.accounts.length >= MAX_ACCOUNTS) { alert('Maximum 50 spare accounts add ho chuke hain.'); return; }
  tgState.addingNew = true;
  tgState.loginToken = '';
  $('tgPhone').value = '';
  $('tgLoginCode').value = '';
  $('tg2faPass').value = '';
  $('tgLoginMsg').textContent = '';
  show('tgCodeBox', false);
  show('tg2faWrap', false);
  renderAccountsUI();
};
$('tgCancelAddBtn').onclick = function(){
  tgState.addingNew = false;
  renderAccountsUI();
};
$('tgDelAcctBtn').onclick = function(){
  var active = getActiveAccount();
  if (!active) return;
  tgState.accounts = tgState.accounts.filter(function(a){ return a.id !== active.id; });
  tgState.activeId = tgState.accounts[0] ? tgState.accounts[0].id : '';
  tgState.lastScreen = null;
  saveStoredAccounts();
  if (!tgState.accounts.length) post('/api/tg/logout').catch(function(){});
  else activateAccount(tgState.activeId);
  renderAccountsUI();
};

// ─── LEFT: TELEGRAM OTP CARD ───
function updateAutoSyncUI(){
  $('autoFillBtn').textContent = '⚡ Auto-Fill: ' + (autoSync ? 'ON' : 'OFF');
  $('autoFillBtn').className = 'sm ' + (autoSync ? 'green' : 'secondary');
}

function renderTgScreen(s){
  if (!s || !s.ok) return;
  tgState.lastScreen = s;
  $('tgBotTitle').textContent = '@' + (s.botUsername || 'HermeshuOTPROBOT');
  $('tgUpdatedAt').textContent = 'updated ' + fmtTime(s.fetchedAt);
  $('tgMeLabel').textContent = s.me ? ('spare: ' + s.me) : 'connected';
  if (s.primary) {
    $('tgCardText').textContent = s.primary.text || '(empty message)';
    $('tgCardMsgId').textContent = 'msg #' + (s.primary.messageId || '—');
  } else {
    $('tgCardText').textContent = 'Chat khali hai — ▶ /start dabao.';
    $('tgCardMsgId').textContent = 'msg #—';
  }
  if (s.callbackMessage) {
    $('tgToast').style.display = 'block';
    $('tgToast').textContent = '🔔 Bot callback: ' + s.callbackMessage;
  }
  var kbWrap = $('tgButtons');
  kbWrap.innerHTML = '';
  var rows = (s.primary && s.primary.buttonRows) || [];
  rows.forEach(function(row){
    var rowEl = document.createElement('div');
    rowEl.className = 'tg-kb-row';
    row.forEach(function(btn){
      var b = document.createElement('button');
      b.className = 'tg-kb-btn';
      b.textContent = btn.text;
      b.onclick = function(){ clickTgButton({ row: btn.row, col: btn.col, buttonText: btn.text, messageId: s.primary.messageId }); };
      rowEl.appendChild(b);
    });
    kbWrap.appendChild(rowEl);
  });

  var phone = s.currentPhone || '';
  var otp = s.currentOtp || '';
  $('tgFoundPhone').textContent = phone || '—';
  $('tgFoundOtp').textContent = otp || '—';
  $('fillPhoneBtn').disabled = !phone || !localRun.active || localRun.status !== 'need_number';
  $('fillOtpBtn').disabled = !otp || !localRun.active || localRun.status !== 'need_otp';

  var rec = $('tgRecentList');
  rec.innerHTML = '';
  (s.messages || []).forEach(function(m){
    var div = document.createElement('div');
    div.className = 'recent-item' + (m.parsedOtp ? ' has-otp' : '');
    var tags = [];
    if (m.parsedPhone) tags.push('📱 ' + m.parsedPhone);
    if (m.parsedOtp) tags.push('🔐 ' + m.parsedOtp);
    div.textContent = '[#' + m.messageId + (tags.length ? ' · ' + tags.join(' · ') : '') + ']\\n' + (m.text || '').slice(0, 280);
    rec.appendChild(div);
  });

  maybeAutoFillFromTelegram(s);
}

function refreshTgCard(opts){
  var active = getActiveAccount();
  if (!active || tgState.addingNew || tgState.busy) return Promise.resolve();
  tgState.busy = true;
  $('tgRefreshBtn').disabled = true;
  return post('/api/tg/card', {
    accountToken: active.token,
    botProfile: $('tgBotProfile').value,
    sendStartIfEmpty: Boolean(opts && opts.sendStartIfEmpty),
  }).then(function(r){
    tgState.busy = false;
    $('tgRefreshBtn').disabled = false;
    if (!r.ok) {
      $('tgToast').style.display = 'block';
      $('tgToast').textContent = '⚠️ ' + (r.message || 'Card load fail');
      return;
    }
    renderTgScreen(r);
  }).catch(function(e){
    tgState.busy = false;
    $('tgRefreshBtn').disabled = false;
    $('tgToast').style.display = 'block';
    $('tgToast').textContent = '⚠️ ' + (e && e.message ? e.message : 'Network error');
  });
}

function clickTgButton(payload){
  var active = getActiveAccount();
  if (!active || tgState.addingNew || tgState.busy) return Promise.resolve();
  tgState.busy = true;
  $('tgRefreshBtn').disabled = true;
  return post('/api/tg/click', Object.assign({
    accountToken: active.token,
    botProfile: $('tgBotProfile').value,
  }, payload || {})).then(function(r){
    tgState.busy = false;
    $('tgRefreshBtn').disabled = false;
    if (!r.ok) {
      $('tgToast').style.display = 'block';
      $('tgToast').textContent = '⚠️ ' + (r.message || 'Click fail');
      return;
    }
    renderTgScreen(r);
  }).catch(function(){
    tgState.busy = false;
    $('tgRefreshBtn').disabled = false;
  });
}

function initTgAccounts(){
  loadStoredAccounts();
  return fetch('/api/tg/status').then(function(r){ return r.json(); }).then(function(s){
    if (s.connected && s.accountToken && !tgState.accounts.length) {
      tgState.accounts.push({
        id: s.phone || ('tg-' + Date.now()),
        phone: s.phone || '',
        me: s.me || '',
        token: s.accountToken,
      });
      tgState.activeId = tgState.accounts[0].id;
      saveStoredAccounts();
    }
    renderAccountsUI();
    var active = getActiveAccount();
    if (active) {
      post('/api/tg/activate', { accountToken: active.token }).catch(function(){});
      refreshTgCard({ sendStartIfEmpty: true });
    }
  }).catch(function(){ renderAccountsUI(); });
}

$('tgToggleApiBtn').onclick = function(){
  show('tgCustomApiWrap', $('tgCustomApiWrap').style.display === 'none');
};

$('tgSendCodeBtn').onclick = function(){
  if (tgState.accounts.length >= MAX_ACCOUNTS) { alert('Maximum 50 spare accounts allowed'); return; }
  var phone = $('tgPhone').value.trim();
  if (!phone) { alert('Phone number daalo'); return; }
  $('tgSendCodeBtn').disabled = true;
  $('tgLoginMsg').textContent = 'Telegram ko login code bhej raha hoon…';
  post('/api/tg/login/start', {
    phoneNumber: phone,
    apiId: $('tgApiId').value.trim() || undefined,
    apiHash: $('tgApiHash').value.trim() || undefined,
  }).then(function(r){
    $('tgSendCodeBtn').disabled = false;
    if (!r.ok) { $('tgLoginMsg').textContent = '❌ ' + (r.message || 'Send code fail'); return; }
    tgState.loginToken = r.loginToken;
    show('tgCodeBox', true);
    show('tg2faWrap', false);
    $('tgLoginMsg').textContent = '📩 Telegram par code gaya (' + r.phoneNumber + ') — code daal kar Verify dabao.';
  }).catch(function(){
    $('tgSendCodeBtn').disabled = false;
    $('tgLoginMsg').textContent = '❌ Network error';
  });
};

$('tgVerifyCodeBtn').onclick = function(){
  var code = $('tgLoginCode').value.replace(/\\s+/g, '').trim();
  var pwd = $('tg2faPass').value || '';
  if (!code && !pwd) { $('tgLoginMsg').textContent = '❌ Telegram login code daalo'; return; }
  $('tgVerifyCodeBtn').disabled = true;
  $('tgLoginMsg').textContent = 'Verify ho raha hai…';
  post('/api/tg/login/complete', {
    loginToken: tgState.loginToken,
    code: code,
    password: pwd,
  }).then(function(r){
    $('tgVerifyCodeBtn').disabled = false;
    if (r.loginToken) tgState.loginToken = r.loginToken;
    if (!r.ok && r.need2fa) {
      show('tg2faWrap', true);
      $('tg2faLabel').textContent = r.hint ? ('2FA Password (Hint: ' + r.hint + ')') : '2FA Password (account par laga hai)';
      $('tgLoginMsg').textContent = '🔐 2FA password daal kar dobara Verify dabao.';
      return;
    }
    if (!r.ok) { $('tgLoginMsg').textContent = '❌ ' + (r.message || 'Verify fail'); return; }

    var acctId = r.phone || ('tg-' + Date.now());
    var newEntry = { id: acctId, phone: r.phone || '', me: r.me || '', token: r.accountToken };
    var idx = -1;
    for (var i = 0; i < tgState.accounts.length; i++) {
      if (tgState.accounts[i].id === acctId || (r.phone && tgState.accounts[i].phone === r.phone)) { idx = i; break; }
    }
    if (idx >= 0) tgState.accounts[idx] = newEntry;
    else if (tgState.accounts.length < MAX_ACCOUNTS) tgState.accounts.push(newEntry);

    tgState.activeId = newEntry.id;
    tgState.addingNew = false;
    tgState.loginToken = '';
    $('tgLoginCode').value = '';
    $('tg2faPass').value = '';
    show('tgCodeBox', false);
    show('tg2faWrap', false);
    $('tgLoginMsg').textContent = '';
    saveStoredAccounts();
    renderAccountsUI();
    refreshTgCard({ sendStartIfEmpty: true });
  }).catch(function(){
    $('tgVerifyCodeBtn').disabled = false;
    $('tgLoginMsg').textContent = '❌ Network error';
  });
};

$('tgRefreshBtn').onclick = function(){ refreshTgCard(); };
$('tgSendStartBtn').onclick = function(){ clickTgButton({ action: 'start' }); };
$('tgBotProfile').onchange = function(){ if (getActiveAccount()) refreshTgCard({ sendStartIfEmpty: true }); };
$('tgAutoPollBtn').onclick = function(){
  tgState.autoPoll = !tgState.autoPoll;
  $('tgAutoPollBtn').textContent = '⏱ Poll: ' + (tgState.autoPoll ? 'ON' : 'OFF');
};

// ─── RIGHT: NORMAL GOLD DROP CARD ───
function saveFormDefaults(){
  try {
    localStorage.setItem(LS_FORM, JSON.stringify({
      name: $('name').value, email: $('email').value, pincode: $('pincode').value,
      code: $('code').value, nocapKey: $('nocapKey').value, target: $('target').value
    }));
  } catch {}
}
function loadFormDefaults(){
  try {
    var f = JSON.parse(localStorage.getItem(LS_FORM) || 'null');
    if (!f) return;
    if (f.name) $('name').value = f.name;
    if (f.email) $('email').value = f.email;
    if (f.pincode) $('pincode').value = f.pincode;
    if (f.code) $('code').value = f.code;
    if (f.nocapKey) $('nocapKey').value = f.nocapKey;
    if (f.target) $('target').value = f.target;
  } catch {}
}

$('changePhotoBtn').onclick = function(){ $('photo').click(); };
$('photo').onchange = function(){
  var file = $('photo').files[0];
  if (!file) return;
  var rd = new FileReader();
  rd.onload = function(){
    var dataUrl = String(rd.result || '');
    customPhotoBase64 = dataUrl.split(',')[1] || '';
    $('photoPreview').src = dataUrl;
    $('photoStatus').textContent = '✅ ' + file.name + ' (Selected)';
    $('photoSub').textContent = 'Custom pack photo active';
    $('resetPhotoBtn').style.display = 'inline-block';
  };
  rd.readAsDataURL(file);
};
$('resetPhotoBtn').onclick = function(){
  customPhotoBase64 = '';
  $('photo').value = '';
  $('photoPreview').src = '/api/default-photo';
  $('photoStatus').textContent = '✅ gold-drop-pack.jpg (Already Selected)';
  $('photoSub').textContent = 'Default Gold Drop pack image ready hai';
  $('resetPhotoBtn').style.display = 'none';
};

function checkNocapBalance(){
  var key = $('nocapKey').value.trim();
  if (!key) { $('nocapbal').textContent = ''; return; }
  post('/nocap-balance', { key: key }).then(function(r){
    $('nocapbal').textContent = r.message || '';
  }).catch(function(){ $('nocapbal').textContent = ''; });
}
$('nocapKey').onchange = function(){ saveFormDefaults(); checkNocapBalance(); };

function paint(s){
  $('st').textContent = s.status;
  $('gdStatusPill').textContent = s.status;
  $('prog').textContent = s.count + ' / ' + s.target + ' done';
  $('msg').textContent = s.message || '';
  show('askNumber', s.status === 'need_number');
  show('askOtp', s.status === 'need_otp');
  show('log', s.log.length > 0);
  $('log').textContent = s.log.slice(-40).join('\\n');

  if (tgState.lastScreen) {
    $('fillPhoneBtn').disabled = !tgState.lastScreen.currentPhone || !localRun.active || s.status !== 'need_number';
    $('fillOtpBtn').disabled = !tgState.lastScreen.currentOtp || !localRun.active || s.status !== 'need_otp';
  }

  var r = $('results');
  if (s.results && s.results.length){
    r.style.display = 'block';
    r.textContent = s.results.map(function(x){ return (x.ok ? '✅' : '❌') + ' ' + x.mobile + ' — ' + x.message; }).join('\\n');
  }
}

function submitMobile(m){
  m = String(m || '').replace(/\\D/g, '').slice(-10);
  if (m.length !== 10) { alert('10-digit mobile daalo'); return; }
  $('mobile').value = '';
  $('sendNumber').disabled = true;
  tgState.lastConsumedPhone = m;
  localRun.status = 'working';
  localRun.mobile = m;
  localRun.message = 'Register ho raha hai (NoCaptchaAI check ho to 15-45s lag sakta hai)…';
  paint(localRun);
  post('/number', { mobile: m, details: localRun.details, target: localRun.target }).then(function(r){
    $('sendNumber').disabled = false;
    if (!r.ok) { alert(r.message || 'Error'); localRun.status = 'need_number'; paint(localRun); return; }
    localRun.session = r.session || null;
    localRun.status = r.status;
    localRun.message = r.message;
    if (r.result) { localRun.results.push(r.result); localRun.count = localRun.results.length; }
    if (r.log && r.log.length) localRun.log = r.log;
    paint(localRun);
  }).catch(function(){
    $('sendNumber').disabled = false;
    localRun.status = 'need_number';
    paint(localRun);
  });
}

function submitOtp(o){
  o = String(o || '').replace(/\\D/g, '');
  if (o.length !== 6) { alert('6-digit OTP daalo'); return; }
  $('otp').value = '';
  $('sendOtp').disabled = true;
  localRun.status = 'working';
  localRun.message = 'OTP verify ho raha hai…';
  paint(localRun);
  post('/otp', { otp: o, session: localRun.session, mobile: localRun.mobile, target: localRun.target }).then(function(r){
    $('sendOtp').disabled = false;
    if (!r.ok) { alert(r.message || 'Error'); localRun.status = 'need_otp'; paint(localRun); return; }
    localRun.session = null;
    localRun.mobile = '';
    localRun.status = r.status;
    localRun.message = r.message;
    if (r.result) { localRun.results.push(r.result); localRun.count = localRun.results.length; }
    if (r.log && r.log.length) localRun.log = r.log;
    paint(localRun);
    if (autoSync && localRun.status === 'need_number' && getActiveAccount()) {
      setTimeout(function(){ clickTgButton({ action: 'find' }); }, 900);
    }
  }).catch(function(){
    $('sendOtp').disabled = false;
    localRun.status = 'need_otp';
    paint(localRun);
  });
}

function maybeAutoFillFromTelegram(s){
  if (!autoSync || !localRun.active) return;
  if (localRun.status === 'need_number' && s.currentPhone && s.currentPhone !== tgState.lastConsumedPhone) {
    $('mobile').value = s.currentPhone;
    submitMobile(s.currentPhone);
    return;
  }
  if (localRun.status === 'need_otp' && s.currentOtp) {
    var otpKey = (localRun.mobile || s.currentPhone || '') + ':' + s.currentOtp + ':' + (s.currentOtpMessageId || '');
    if (otpKey !== tgState.lastConsumedOtpKey) {
      tgState.lastConsumedOtpKey = otpKey;
      $('otp').value = s.currentOtp;
      submitOtp(s.currentOtp);
    }
  }
}

$('fillPhoneBtn').onclick = function(){
  if (tgState.lastScreen && tgState.lastScreen.currentPhone) {
    $('mobile').value = tgState.lastScreen.currentPhone;
    submitMobile(tgState.lastScreen.currentPhone);
  }
};
$('fillOtpBtn').onclick = function(){
  if (tgState.lastScreen && tgState.lastScreen.currentOtp) {
    $('otp').value = tgState.lastScreen.currentOtp;
    submitOtp(tgState.lastScreen.currentOtp);
  }
};
$('autoFillBtn').onclick = function(){ autoSync = !autoSync; updateAutoSyncUI(); };

$('start').onclick = function(){
  saveFormDefaults();
  var body = {
    name: $('name').value.trim(),
    email: $('email').value,
    pincode: $('pincode').value,
    code: $('code').value,
    target: Number($('target').value) || 1,
    nocapKey: $('nocapKey').value.trim(),
  };
  if (customPhotoBase64) body.photo = customPhotoBase64;
  post('/start', body).then(function(r){
    if (!r.ok) { alert(r.message || 'Error'); return; }
    tgState.lastConsumedPhone = '';
    tgState.lastConsumedOtpKey = '';
    localRun = { active:true, status:'need_number', message:'Pehla mobile number daalo (ya Telegram card se fetch hoga)', target:body.target, count:0, mobile:'', details:body, session:null, results:[], log:['▶ START — target '+body.target+' numbers'] };
    show('setup', false); show('run', true); paint(localRun);
    if (autoSync && getActiveAccount()) {
      if (tgState.lastScreen && tgState.lastScreen.currentPhone) maybeAutoFillFromTelegram(tgState.lastScreen);
      else clickTgButton({ action: 'find' });
    }
  });
};

$('sendNumber').onclick = function(){ submitMobile($('mobile').value); };
$('sendOtp').onclick = function(){ submitOtp($('otp').value); };
$('reset').onclick = function(){ localRun.active = false; post('/reset').then(function(){ location.reload(); }); };

function pollGd(){
  fetch('/state').then(function(r){ return r.json(); }).then(function(s){
    if (localRun.active && s.status === 'idle') return;
    if (s.log && s.log.length >= localRun.log.length && s.results && s.results.length >= localRun.results.length) {
      localRun.status = s.status;
      localRun.message = s.message;
      localRun.count = s.count;
      localRun.target = s.target;
      localRun.results = s.results;
      localRun.log = s.log;
    }
    paint(localRun.active ? localRun : s);
  }).catch(function(){});
}

setInterval(function(){
  if (!getActiveAccount() || tgState.addingNew || !tgState.autoPoll || tgState.busy) return;
  if (localRun.active && localRun.status === 'need_otp' && autoSync) {
    clickTgButton({ action: 'refresh' });
  } else {
    refreshTgCard();
  }
}, 2500);

setInterval(pollGd, 2500);
loadFormDefaults();
pollGd();
initTgAccounts();
updateAutoSyncUI();
checkNocapBalance();
</script></body></html>`;

// ─── HTTP helpers ───
function sendJson(res, code, data, extraHeaders = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 15e6) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/login') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(LOGIN_HTML);
        return;
      }
      if (req.method === 'POST') {
        let raw = '';
        await new Promise(resolve => { req.on('data', c => { raw += c; }); req.on('end', resolve); });
        const params = new URLSearchParams(raw);
        if (params.get('password') === APP_PASSWORD) {
          res.writeHead(302, { 'Set-Cookie': `${AUTH_COOKIE}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`, 'Location': '/' });
          res.end();
        } else {
          res.writeHead(302, { 'Location': '/login?wrong=1' });
          res.end();
        }
        return;
      }
    }
    if (url.pathname === '/logout') {
      res.writeHead(302, { 'Set-Cookie': 'gd_auth=; Path=/; HttpOnly; Max-Age=0', 'Location': '/login' });
      res.end();
      return;
    }

    if (!isAuthed(req)) {
      if (req.method === 'GET') {
        res.writeHead(302, { 'Location': '/login' });
        res.end();
      } else {
        sendJson(res, 401, { ok: false, message: 'Login karo pehle' });
      }
      return;
    }

    // ─── Serve default Gold Drop pack image so preview is already selected ───
    if (req.method === 'GET' && url.pathname === '/api/default-photo') {
      const b64 = await getDefaultPhoto();
      const buf = Buffer.from(b64, 'base64');
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
        'Content-Length': buf.length,
      });
      res.end(buf);
      return;
    }

    // ─── Telegram Live Spare OTP Card APIs (supports up to 50 spare accounts) ───
    if (req.method === 'GET' && url.pathname === '/api/tg/status') {
      const tgSess = getTgCookieSession(req);
      const hasEnvApi = Boolean(Number(process.env.TELEGRAM_API_ID) > 0 && String(process.env.TELEGRAM_API_HASH || '').trim());
      sendJson(res, 200, {
        ok: true,
        connected: Boolean(tgSess),
        me: tgSess?.me || '',
        phone: tgSess?.phone || '',
        accountToken: tgSess ? sealJson(tgSess) : '',
        hasEnvApi,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/tg/login/start') {
      const body = await readBody(req);
      const apiId = Number(body.apiId || process.env.TELEGRAM_API_ID) || 0;
      const apiHash = String(body.apiHash || process.env.TELEGRAM_API_HASH || '').trim();
      const phoneNumber = String(body.phoneNumber || '').trim();
      if (!apiId || !apiHash) {
        sendJson(res, 400, { ok: false, message: 'TELEGRAM_API_ID / API_HASH missing hai — Custom API me daalo.' });
        return;
      }
      try {
        const tg = await loadTgMod();
        const started = await tg.startStatelessTelegramLogin({ apiId, apiHash, phoneNumber });
        const loginToken = sealJson({
          apiId,
          apiHash,
          phoneNumber: started.phoneNumber,
          phoneCodeHash: started.phoneCodeHash,
          tempSession: started.tempSession,
          createdAt: Date.now(),
        });
        sendJson(res, 200, { ok: true, loginToken, phoneNumber: started.phoneNumber });
      } catch (err) {
        sendJson(res, 400, { ok: false, message: String(err?.message || err).slice(0, 200) });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/tg/login/complete') {
      const body = await readBody(req);
      const stateTok = unsealJson(String(body.loginToken || ''));
      if (!stateTok || !stateTok.tempSession || !stateTok.phoneCodeHash) {
        sendJson(res, 400, { ok: false, message: 'Login session expire ho gaya — Send Login OTP dobara dabao.' });
        return;
      }
      const cleanCode = String(body.code ?? body.phoneCode ?? '').replace(/[\s-]+/g, '').trim();
      const password = String(body.password || '');
      if (!cleanCode && !password) {
        sendJson(res, 400, { ok: false, message: 'Telegram login code daalo.' });
        return;
      }
      try {
        const tg = await loadTgMod();
        const resLogin = await tg.completeStatelessTelegramLogin({
          apiId: stateTok.apiId,
          apiHash: stateTok.apiHash,
          phoneNumber: stateTok.phoneNumber,
          phoneCodeHash: stateTok.phoneCodeHash,
          tempSession: stateTok.tempSession,
          phoneCode: cleanCode,
          password,
        });
        if (!resLogin.ok && resLogin.needsPassword) {
          const refreshedToken = sealJson({
            ...stateTok,
            tempSession: resLogin.tempSession || stateTok.tempSession,
          });
          sendJson(res, 200, {
            ok: false,
            need2fa: true,
            hint: resLogin.hint || '',
            loginToken: refreshedToken,
            message: '2FA password required',
          });
          return;
        }
        if (!resLogin.ok || !resLogin.session) {
          sendJson(res, 400, { ok: false, message: resLogin.error || 'Login verify fail' });
          return;
        }
        const accountToken = sealJson({
          apiId: stateTok.apiId,
          apiHash: stateTok.apiHash,
          session: resLogin.session,
          me: resLogin.me || '',
          phone: stateTok.phoneNumber,
          savedAt: Date.now(),
        });
        sendJson(
          res,
          200,
          { ok: true, me: resLogin.me || '', phone: stateTok.phoneNumber, accountToken },
          { 'Set-Cookie': tgCookieHeader(accountToken) }
        );
      } catch (err) {
        sendJson(res, 400, { ok: false, message: String(err?.message || err).slice(0, 200) });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/tg/activate') {
      const body = await readBody(req);
      const token = String(body.accountToken || '').trim();
      const tgSess = unsealJson(token);
      if (!tgSess || !tgSess.session) {
        sendJson(res, 400, { ok: false, message: 'Invalid account token' });
        return;
      }
      sendJson(
        res,
        200,
        { ok: true, me: tgSess.me || '', phone: tgSess.phone || '' },
        { 'Set-Cookie': tgCookieHeader(token) }
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/tg/logout') {
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': tgCookieHeader('', 0) });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/tg/card') {
      const body = await readBody(req);
      const tgSess = resolveTgSession(req, body);
      if (!tgSess) {
        sendJson(res, 401, { ok: false, message: 'Spare Telegram account connect nahi hai.' });
        return;
      }
      try {
        const tg = await loadTgMod();
        const screen = await tg.withTelegramAccountContext({
          userId: tgSess.phone || 'web',
          apiId: tgSess.apiId,
          apiHash: tgSess.apiHash,
          session: tgSess.session,
          botProfile: String(body.botProfile || 'hermes'),
          requireOwnAccount: true,
        }, () => tg.readTelegramOtpScreen({ limit: 10, sendStartIfEmpty: Boolean(body.sendStartIfEmpty) }));
        sendJson(res, 200, screen);
      } catch (err) {
        sendJson(res, 400, { ok: false, message: String(err?.message || err).slice(0, 200) });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/tg/click') {
      const body = await readBody(req);
      const tgSess = resolveTgSession(req, body);
      if (!tgSess) {
        sendJson(res, 401, { ok: false, message: 'Spare Telegram account connect nahi hai.' });
        return;
      }
      try {
        const tg = await loadTgMod();
        const screen = await tg.withTelegramAccountContext({
          userId: tgSess.phone || 'web',
          apiId: tgSess.apiId,
          apiHash: tgSess.apiHash,
          session: tgSess.session,
          botProfile: String(body.botProfile || 'hermes'),
          requireOwnAccount: true,
        }, () => tg.interactTelegramOtpScreen({
          action: String(body.action || 'button'),
          buttonText: String(body.buttonText || ''),
          row: Number.isInteger(Number(body.row)) ? Number(body.row) : -1,
          col: Number.isInteger(Number(body.col)) ? Number(body.col) : -1,
          messageId: Number(body.messageId) || 0,
          sendText: String(body.sendText || ''),
        }));
        sendJson(res, 200, screen);
      } catch (err) {
        sendJson(res, 400, { ok: false, message: String(err?.message || err).slice(0, 200) });
      }
      return;
    }

    // ─── Gold Drop APIs ───
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE_HTML);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/state') {
      sendJson(res, 200, { ...state, session: undefined, details: state.details ? { name: state.details.name } : null });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/start') {
      const body = await readBody(req);
      if (state.status !== 'idle' && state.status !== 'done') { sendJson(res, 400, { ok: false, message: 'Pehle run chal raha hai — Stop/Reset karo' }); return; }
      const photo = body.photo || await getDefaultPhoto();
      state.details = { name: body.name, email: body.email, pincode: body.pincode, code: body.code, photo, nocapKey: body.nocapKey };
      state.target = Math.max(1, Math.min(100, Number(body.target) || 1));
      state.count = 0;
      state.results = [];
      state.log = [];
      state.session = null;
      state.mobile = '';
      state.status = 'need_number';
      state.message = 'Pehla mobile number daalo';
      logLine(`▶ START — target ${state.target} numbers (direct API, koi browser nahi)`);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/number') {
      const body = await readBody(req);
      if (body.details && (!state.details || state.status !== 'need_number')) {
        const photo = body.details.photo || await getDefaultPhoto();
        state.details = { ...body.details, photo };
        state.target = Math.max(1, Math.min(100, Number(body.target) || state.target || 1));
        state.status = 'need_number';
      }
      if (state.status !== 'need_number' || !state.details) { sendJson(res, 400, { ok: false, message: 'Abhi number nahi chahiye' }); return; }
      const mobile = String(body.mobile || '').replace(/\D/g, '').slice(-10);
      if (!/^[6789]\d{9}$/.test(mobile)) { sendJson(res, 400, { ok: false, message: 'Valid 10-digit Indian mobile daalo' }); return; }
      const out = await processNumber(mobile);
      sendJson(res, 200, { ...out, log: state.log.slice(-40) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/otp') {
      const body = await readBody(req);
      if (body.session) {
        state.session = body.session;
        state.mobile = String(body.mobile || state.mobile || '');
        state.target = Math.max(1, Math.min(100, Number(body.target) || state.target || 1));
        state.status = 'need_otp';
      }
      if (state.status !== 'need_otp' || !state.session) { sendJson(res, 400, { ok: false, message: 'Abhi OTP nahi chahiye' }); return; }
      const otp = String(body.otp || '').replace(/\D/g, '');
      if (!/^\d{6}$/.test(otp)) { sendJson(res, 400, { ok: false, message: '6-digit OTP daalo' }); return; }
      const out = await processOtp(otp);
      sendJson(res, 200, { ...out, log: state.log.slice(-40) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/reset') {
      state.status = 'idle'; state.message = ''; state.session = null; state.mobile = '';
      state.details = null; state.results = []; state.log = []; state.count = 0;
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/nocap-balance') {
      const body = await readBody(req);
      const key = String(body.key || NOCAP_KEY_DEFAULT);
      try {
        const r = await fetch(`${NOCAP_API}/balance?apiKey=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(15000) }).then(x => x.json());
        if (String(r.status || '').toLowerCase() !== 'ok') { sendJson(res, 200, { message: `⚠️ Balance check fail: ${r.error || r.msg || 'unknown'} — key sahi hai?` }); return; }
        sendJson(res, 200, { message: `💰 NoCaptchaAI balance: $${r.Balance ?? r.balance} (${r.Subscription === 'active' ? 'active' : r.Subscription || '—'})` });
      } catch (error) {
        sendJson(res, 200, { message: `⚠️ Balance check fail: ${String(error?.message || error).slice(0, 100)}` });
      }
      return;
    }
    sendJson(res, 404, { ok: false, message: 'Not found' });
  } catch (error) {
    sendJson(res, 500, { ok: false, message: String(error?.message || error).slice(0, 200) });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 3737);
  http.createServer(handler).listen(port, () => console.log(`🟡 Gold Drop (Vercel build) local par: http://localhost:${port}`));
}
