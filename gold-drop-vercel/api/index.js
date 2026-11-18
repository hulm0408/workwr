// 🟡 Gold Drop + 📱 Live Spare Telegram OTP Card — VERCEL split-screen dashboard.
// Left side: exact live Telegram OTP bot card (click buttons, auto-refresh, extract phone + OTP).
// Right side: exact Gold Drop fetch, live field-fill & verify (NoCaptchaAI Turnstile auto-solve).
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

// ─── LOGIN + ENCRYPTED STATELESS SESSION COOKIES ───
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
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = v;
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

// ─── In-memory run state (single-user app — Vercel par same instance reuse) ───
const state = {
  status: 'idle', // idle | need_number | working | need_otp | done
  message: '',
  target: 1,
  count: 0,
  mobile: '',
  lastEmailUsed: '',
  securitySolved: false,
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
  state.securitySolved = false;
  const d = state.details;
  const email = emailForMobile(d.email, mobile);
  state.lastEmailUsed = email;
  logLine(`📱 ${mobile} — register ho raha hai (${email})…`);
  try {
    const res = await registerGoldDrop({
      name: d.name, mobile, email, pincode: d.pincode, code: d.code,
      imageBase64: d.photo, nocapApiKey: d.nocapKey,
    });
    state.session = res.session;
    state.securitySolved = Boolean(res.securitySolved);
    if (res.securitySolved) logLine('🛡️ Security check aaya tha — NoCaptchaAI ne solve kar diya ✅');
    logLine(`✅ Register ho gaya — ${res.message}. OTP ka wait…`);
    state.status = 'need_otp';
    state.message = 'OTP bot me aaya 6-digit code yahan daalo';
    return {
      ok: true,
      status: state.status,
      message: state.message,
      session: res.session,
      mobile,
      emailUsed: email,
      securitySolved: Boolean(res.securitySolved),
    };
  } catch (error) {
    const message = String(error?.message || error).slice(0, 200);
    logLine(`❌ ${mobile} — ${message}`);
    const result = { mobile, ok: false, message, emailUsed: email };
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
    return { ok: true, status: state.status, message: state.message, session: null, result, emailUsed: email };
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
    result = { mobile, ok: true, message: `${res.message}${rewardText}`, reward: res.reward || null };
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
<title>🟡 Gold Drop + 📱 Live Telegram OTP</title>
<style>
:root{
  --bg:#0b0e19; --card:#141829; --card2:#1a2038; --border:#273052;
  --text:#edf0fb; --muted:#8f97b8; --gold:#f7b500; --tg:#2ea6ff; --green:#2dd4bf; --red:#ff6b6b;
}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:16px}
.topbar{max-width:1340px;margin:0 auto 14px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:12px 16px;background:var(--card);border:1px solid var(--border);border-radius:14px}
.topbar h1{font-size:18px;margin:0;display:flex;align-items:center;gap:8px}
.topbar .sub{color:var(--muted);font-size:12px}
.grid{max-width:1340px;margin:0 auto;display:grid;grid-template-columns:minmax(330px,1fr) minmax(350px,1.08fr);gap:16px;align-items:start}
@media(max-width:900px){.grid{grid-template-columns:1fr}}
.panel{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:16px;box-shadow:0 12px 32px rgba(0,0,0,.28)}
.panel-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--border)}
.panel-title{font-size:16px;font-weight:700;display:flex;align-items:center;gap:8px}
.pill{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:99px;font-size:11px;font-weight:600;background:#1d2542;color:#b8c0de;border:1px solid var(--border)}
.pill.ok{background:rgba(45,212,191,.12);color:#5eead4;border-color:rgba(45,212,191,.35)}
.pill.tg{background:rgba(46,166,255,.13);color:#7cc4ff;border-color:rgba(46,166,255,.35)}
.pill.gold{background:rgba(247,181,0,.14);color:#ffd24c;border-color:rgba(247,181,0,.35)}
.pill.err{background:rgba(255,107,107,.14);color:#ff9494;border-color:rgba(255,107,107,.35)}
label{display:block;font-size:11.5px;color:#9aa2c2;margin:8px 0 4px}
input,select,button{font-family:inherit}
input,select{width:100%;padding:9px 11px;border-radius:9px;border:1px solid var(--border);background:#0c1020;color:var(--text);font-size:14px;outline:none}
input:focus,select:focus{border-color:var(--tg)}
button{padding:9px 12px;border-radius:9px;border:1px solid var(--border);background:#222947;color:var(--text);font-size:13px;font-weight:600;cursor:pointer;transition:.15s ease}
button:hover:not(:disabled){filter:brightness(1.1)}
button:disabled{opacity:.5;cursor:not-allowed}
button.gold{background:var(--gold);color:#191200;border-color:transparent;font-weight:700}
button.tg{background:var(--tg);color:#031524;border-color:transparent;font-weight:700}
button.green{background:#10b981;color:#021c14;border-color:transparent;font-weight:700}
button.danger{background:#3a1d27;color:#ff9aa6;border-color:#5d2b3b}
button.sm{padding:6px 10px;font-size:12px;border-radius:8px}
.row{display:flex;gap:8px;align-items:center}.row>*{flex:1}
.btn-strip{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
/* Exact Telegram Chat Card Mirror */
.tg-chat{background:#0e1621;border:1px solid #1f2e42;border-radius:14px;padding:12px;margin-top:10px}
.tg-chat-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;font-size:12px;color:#7da3c9}
.tg-bubble{background:#182533;border:1px solid #26394e;border-radius:12px 12px 12px 4px;padding:12px 13px;font-size:13.5px;line-height:1.48;white-space:pre-wrap;word-break:break-word;color:#eaf2fb;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}
.tg-meta{display:flex;justify-content:space-between;font-size:11px;color:#6f8ca8;margin-top:6px}
.tg-kb{margin-top:8px;display:flex;flex-direction:column;gap:6px}
.tg-kb-row{display:flex;gap:6px}
.tg-kb-btn{flex:1;background:#243548;border:1px solid #324963;color:#e9f2fc;border-radius:8px;padding:8px 10px;font-size:12.5px;font-weight:600;text-align:center}
.tg-kb-btn:hover:not(:disabled){background:#2d435c}
.tg-toast{margin-top:8px;padding:7px 10px;border-radius:8px;background:rgba(46,166,255,.12);border:1px solid rgba(46,166,255,.32);color:#9ad0ff;font-size:12px}
.extract-bar{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
@media(max-width:520px){.extract-bar{grid-template-columns:1fr}}
.extract-box{background:#0d1424;border:1px solid var(--border);border-radius:10px;padding:10px}
.extract-box .k{font-size:11px;color:var(--muted)}
.extract-box .v{font-size:17px;font-weight:700;font-family:ui-monospace,monospace;letter-spacing:.5px;margin:4px 0 6px;color:#fff}
.recent-list{margin-top:10px;display:flex;flex-direction:column;gap:6px;max-height:190px;overflow:auto}
.recent-item{background:#0d1322;border:1px solid #1f2944;border-radius:8px;padding:8px 10px;font-size:12px;white-space:pre-wrap;color:#b8c4de}
.recent-item.has-otp{border-color:rgba(45,212,191,.5);background:rgba(16,185,129,.08)}
/* Gold Drop Live Fill Mirror */
.fill-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
@media(max-width:520px){.fill-grid{grid-template-columns:1fr}}
.fill-field{background:#0c1020;border:1px solid var(--border);border-radius:10px;padding:8px 10px;transition:.2s ease}
.fill-field.active{border-color:var(--gold);box-shadow:0 0 0 1px rgba(247,181,0,.3)}
.fill-field.filled{border-color:rgba(45,212,191,.45)}
.fill-field .fk{font-size:11px;color:var(--muted);display:flex;justify-content:space-between}
.fill-field .fv{font-size:13.5px;font-weight:600;font-family:ui-monospace,monospace;margin-top:3px;word-break:break-all;color:#eef2ff}
.status-box{background:#0e1326;border:1px solid var(--border);border-radius:11px;padding:11px 12px;margin-top:10px;font-size:13px}
.log{background:#080b15;border:1px solid #1c223b;border-radius:10px;padding:10px;font:11.5px/1.5 ui-monospace,monospace;color:#8b94b8;max-height:210px;overflow:auto;margin-top:10px;white-space:pre-wrap}
.switch-row{display:flex;align-items:center;justify-content:space-between;gap:10px;background:#0e1326;border:1px solid var(--border);border-radius:10px;padding:8px 11px;margin-top:8px;font-size:12.5px}
.muted{color:var(--muted);font-size:12px}
a{color:var(--gold);text-decoration:none}
</style></head><body>

<div class="topbar">
  <div>
    <h1>🟡 Gold Drop × 📱 Live Telegram OTP</h1>
    <div class="sub">Left: aapke spare Telegram account ka exact OTP bot card · Right: Gold Drop live fetch, auto-fill & verify</div>
  </div>
  <div class="btn-strip">
    <span class="pill" id="topSyncPill">⚡ Auto-Fetch: ON</span>
    <a class="pill" href="/health" target="_blank">🩺 Bot Health</a>
    <a class="pill" href="/logout">🚪 Logout</a>
  </div>
</div>

<div class="grid">
  <!-- LEFT PANEL: EXACT SPARE TELEGRAM OTP CARD -->
  <div class="panel">
    <div class="panel-head">
      <div class="panel-title">📱 Telegram Spare OTP Card <span class="pill" id="tgConnPill">Checking…</span></div>
      <div class="btn-strip">
        <select id="tgBotProfile" style="width:auto;padding:5px 9px;font-size:12px">
          <option value="hermes">@Hermezotprobot (Hermes)</option>
          <option value="chauhan">@Chauhan_OTPbot (Chauhan)</option>
          <option value="hathi">@HathiOTP_bot (Hathi)</option>
        </select>
        <button class="sm" id="tgLogoutBtn" style="display:none">🔌 Switch TG</button>
      </div>
    </div>

    <!-- Step A: Telegram Spare Account Login -->
    <div id="tgLoginBox" style="display:none">
      <div class="status-box" style="margin-top:0">
        <b>Apna Spare Telegram Account Connect Karein</b>
        <div class="muted" style="margin-top:4px">Seedha yahin se login karo — exact OTP bot card live screen par dikhega aur Gold Drop me auto-fill hoga.</div>
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
      </div>

      <div id="tgCodeBox" style="display:none;margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">
        <label>Telegram Login OTP Code</label>
        <input id="tgLoginCode" inputmode="numeric" placeholder="12345">
        <div id="tg2faWrap" style="display:none">
          <label>2FA Password (agar account par laga hai)</label>
          <input id="tg2faPass" type="password" placeholder="Telegram 2FA password">
        </div>
        <button class="green" id="tgVerifyCodeBtn" style="width:100%;margin-top:8px">✅ Verify & Open Live OTP Card</button>
      </div>
      <div class="muted" id="tgLoginMsg" style="margin-top:8px"></div>
    </div>

    <!-- Step B: Exact Telegram OTP Bot Card Mirror -->
    <div id="tgLiveBox" style="display:none">
      <div class="btn-strip">
        <button class="tg sm" id="tgRefreshBtn">🔄 Refresh Card</button>
        <button class="sm" id="tgSendStartBtn">▶ /start</button>
        <button class="sm" id="tgAutoPollBtn">⏱ Live Poll: ON (2.5s)</button>
      </div>

      <div class="tg-chat">
        <div class="tg-chat-bar">
          <span id="tgBotTitle">@Hermezotprobot</span>
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
          <div class="k">📱 Card se nikla Number</div>
          <div class="v" id="tgFoundPhone">—</div>
          <button class="gold sm" id="fillPhoneBtn" style="width:100%" disabled>➡ Gold Drop me Fill & Register</button>
        </div>
        <div class="extract-box">
          <div class="k">🔐 Card se nikla OTP</div>
          <div class="v" id="tgFoundOtp">—</div>
          <button class="green sm" id="fillOtpBtn" style="width:100%" disabled>➡ Gold Drop me Fill & Verify</button>
        </div>
      </div>

      <label style="margin-top:12px">Latest Bot Messages (auto-scan)</label>
      <div class="recent-list" id="tgRecentList"></div>
    </div>
  </div>

  <!-- RIGHT PANEL: GOLD DROP LIVE FETCH & FILL -->
  <div class="panel">
    <div class="panel-head">
      <div class="panel-title">🟡 Gold Drop Fetch & Fill <span class="pill gold" id="gdStatusPill">idle</span></div>
      <div class="btn-strip">
        <span class="pill" id="gdProgPill">0 / 5</span>
      </div>
    </div>

    <div id="setup">
      <div class="row">
        <div><label>Naam</label><input id="name" value="Rahul Kumar"></div>
        <div><label>Target Count</label><input id="target" type="number" value="5" min="1" max="100"></div>
      </div>
      <label>Email (Gmail — har number par +suffix apne aap)</label><input id="email" value="itsnoob012@gmail.com">
      <div class="row">
        <div><label>PIN code</label><input id="pincode" value="509412"></div>
        <div><label>Batch code</label><input id="code" value="KKD2LS01261026"></div>
      </div>
      <label>NoCaptchaAI API key (security check auto-solve)</label><input id="nocapKey" value="${NOCAP_KEY_DEFAULT}">
      <div class="muted" id="nocapbal" style="margin-top:4px">NoCaptchaAI balance check ho raha hai…</div>
      <label>Pack photo (optional — blank chhodo to default pack photo use hogi)</label><input id="photo" type="file" accept="image/*">
      <div class="switch-row">
        <span>⚡ <b>Full Auto-Fetch & Fill</b> (Telegram se number + OTP khud utha kar Gold Drop bhare)</span>
        <input type="checkbox" id="autoSyncChk" checked style="width:auto;transform:scale(1.2)">
      </div>
      <button class="gold" id="start" style="width:100%;margin-top:12px;padding:11px">▶ START LIVE RUN</button>
    </div>

    <div id="run" style="display:none">
      <div class="status-box">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <span><span class="pill gold" id="st">…</span> <b id="prog" style="margin-left:6px"></b></span>
          <button class="sm" id="toggleAutoSyncRun">⚡ Auto-Sync: ON</button>
        </div>
        <div id="msg" style="margin-top:7px;color:#dbe4ff"></div>
      </div>

      <!-- Exact Live Gold Drop Form Fill Mirror -->
      <div class="fill-grid">
        <div class="fill-field" id="ffName"><div class="fk"><span>👤 Name</span><span>auto</span></div><div class="fv" id="fvName">—</div></div>
        <div class="fill-field" id="ffEmail"><div class="fk"><span>📧 Email (+suffix)</span><span id="fsEmail">wait</span></div><div class="fv" id="fvEmail">—</div></div>
        <div class="fill-field" id="ffMobile"><div class="fk"><span>📱 Mobile (from TG)</span><span id="fsMobile">wait</span></div><div class="fv" id="fvMobile">—</div></div>
        <div class="fill-field" id="ffPin"><div class="fk"><span>📍 PIN & Code</span><span>ready</span></div><div class="fv" id="fvPin">—</div></div>
        <div class="fill-field" id="ffCaptcha"><div class="fk"><span>🛡️ Security Check</span><span id="fsCaptcha">auto</span></div><div class="fv" id="fvCaptcha">waiting…</div></div>
        <div class="fill-field" id="ffOtp"><div class="fk"><span>🔐 OTP (from TG)</span><span id="fsOtp">wait</span></div><div class="fv" id="fvOtp">—</div></div>
      </div>

      <div id="askNumber" style="display:none;margin-top:10px">
        <label>Mobile number (auto-fill hota hai ya manually daalo)</label>
        <div class="row">
          <input id="mobile" inputmode="numeric" maxlength="10" placeholder="9876543210">
          <button class="gold" id="sendNumber" style="flex:0 0 auto">📤 Register</button>
        </div>
      </div>

      <div id="askOtp" style="display:none;margin-top:10px">
        <label>OTP (Telegram card se auto-fill hota hai ya manually daalo)</label>
        <div class="row">
          <input id="otp" inputmode="numeric" maxlength="6" placeholder="123456">
          <button class="green" id="sendOtp" style="flex:0 0 auto">✅ Verify OTP</button>
        </div>
      </div>

      <div class="btn-strip" style="margin-top:12px">
        <button class="danger" id="reset" style="flex:1">■ Stop / Reset</button>
      </div>
    </div>

    <div class="log" id="log" style="display:none"></div>
    <div id="results" class="log" style="display:none;color:#a7f3d0"></div>
  </div>
</div>

<script>
var tgState = {
  connected: false,
  loginToken: '',
  autoPoll: true,
  pollTimer: null,
  busy: false,
  lastScreen: null,
  lastConsumedPhone: '',
  lastConsumedOtpKey: '',
};
var gdPollTimer = null;
var localRun = { active: false, status: 'idle', message: '', target: 1, count: 0, mobile: '', emailUsed: '', securitySolved: false, otpFilled: '', details: null, session: null, results: [], log: [] };
var autoSync = true;

function $(id){ return document.getElementById(id); }
function show(id, on){ $(id).style.display = on ? 'block' : 'none'; }
function post(url, body){
  return fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body||{}) }).then(function(r){ return r.json(); });
}
function fmtTime(ms){
  if (!ms) return '—';
  try { return new Date(ms).toLocaleTimeString(); } catch { return '—'; }
}

// ─── LEFT: TELEGRAM OTP CARD ───
function updateAutoSyncUI(){
  $('topSyncPill').textContent = '⚡ Auto-Fetch: ' + (autoSync ? 'ON' : 'OFF');
  $('topSyncPill').className = 'pill ' + (autoSync ? 'ok' : '');
  if ($('toggleAutoSyncRun')) $('toggleAutoSyncRun').textContent = '⚡ Auto-Sync: ' + (autoSync ? 'ON' : 'OFF');
  if ($('autoSyncChk')) $('autoSyncChk').checked = autoSync;
}

function renderTgScreen(s){
  if (!s || !s.ok) return;
  tgState.lastScreen = s;
  $('tgBotTitle').textContent = '@' + (s.botUsername || 'Hermezotprobot');
  $('tgUpdatedAt').textContent = 'updated ' + fmtTime(s.fetchedAt);
  $('tgMeLabel').textContent = s.me ? ('spare: ' + s.me) : 'spare: connected';
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
    div.textContent = '[#' + m.messageId + (tags.length ? ' · ' + tags.join(' · ') : '') + ']\\n' + (m.text || '').slice(0, 320);
    rec.appendChild(div);
  });

  maybeAutoFillFromTelegram(s);
}

function refreshTgCard(opts){
  if (!tgState.connected || tgState.busy) return Promise.resolve();
  tgState.busy = true;
  $('tgRefreshBtn').disabled = true;
  return post('/api/tg/card', {
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
  if (!tgState.connected || tgState.busy) return Promise.resolve();
  tgState.busy = true;
  $('tgRefreshBtn').disabled = true;
  return post('/api/tg/click', Object.assign({ botProfile: $('tgBotProfile').value }, payload || {})).then(function(r){
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

function checkTgStatus(){
  return fetch('/api/tg/status').then(function(r){ return r.json(); }).then(function(s){
    tgState.connected = Boolean(s.connected);
    if (s.hasEnvApi) $('tgToggleApiBtn').textContent = '⚙️ Custom API (optional)';
    if (s.connected) {
      $('tgConnPill').textContent = '🟢 ' + (s.me || s.phone || 'Connected');
      $('tgConnPill').className = 'pill ok';
      show('tgLoginBox', false);
      show('tgLiveBox', true);
      show('tgLogoutBtn', true);
      refreshTgCard({ sendStartIfEmpty: true });
    } else {
      $('tgConnPill').textContent = 'Not linked';
      $('tgConnPill').className = 'pill';
      show('tgLoginBox', true);
      show('tgLiveBox', false);
      show('tgLogoutBtn', false);
    }
  }).catch(function(){});
}

$('tgToggleApiBtn').onclick = function(){
  show('tgCustomApiWrap', $('tgCustomApiWrap').style.display === 'none');
};

$('tgSendCodeBtn').onclick = function(){
  var phone = $('tgPhone').value.trim();
  if (!phone) { alert('Phone number daalo'); return; }
  $('tgSendCodeBtn').disabled = true;
  $('tgLoginMsg').textContent = 'Telegram ko login code request bhej raha hoon…';
  post('/api/tg/login/start', {
    phoneNumber: phone,
    apiId: $('tgApiId').value.trim() || undefined,
    apiHash: $('tgApiHash').value.trim() || undefined,
  }).then(function(r){
    $('tgSendCodeBtn').disabled = false;
    if (!r.ok) { $('tgLoginMsg').textContent = '❌ ' + (r.message || 'Send code fail'); return; }
    tgState.loginToken = r.loginToken;
    show('tgCodeBox', true);
    $('tgLoginMsg').textContent = '📩 Telegram par code gaya (' + r.phoneNumber + ') — code daalo.';
  }).catch(function(){
    $('tgSendCodeBtn').disabled = false;
    $('tgLoginMsg').textContent = '❌ Network error';
  });
};

$('tgVerifyCodeBtn').onclick = function(){
  var code = $('tgLoginCode').value.trim();
  if (!code) { alert('Login code daalo'); return; }
  $('tgVerifyCodeBtn').disabled = true;
  $('tgLoginMsg').textContent = 'Verify ho raha hai…';
  post('/api/tg/login/complete', {
    loginToken: tgState.loginToken,
    code: code,
    password: $('tg2faPass').value || '',
  }).then(function(r){
    $('tgVerifyCodeBtn').disabled = false;
    if (!r.ok && r.need2fa) {
      show('tg2faWrap', true);
      $('tgLoginMsg').textContent = '🔐 2FA password laga hai — neeche password daal kar dobara Verify dabao.';
      return;
    }
    if (!r.ok) { $('tgLoginMsg').textContent = '❌ ' + (r.message || 'Verify fail'); return; }
    $('tgLoginCode').value = '';
    $('tg2faPass').value = '';
    show('tgCodeBox', false);
    $('tgLoginMsg').textContent = '';
    checkTgStatus();
  }).catch(function(){
    $('tgVerifyCodeBtn').disabled = false;
    $('tgLoginMsg').textContent = '❌ Network error';
  });
};

$('tgLogoutBtn').onclick = function(){
  post('/api/tg/logout').then(function(){
    tgState.connected = false;
    tgState.lastScreen = null;
    checkTgStatus();
  });
};
$('tgRefreshBtn').onclick = function(){ refreshTgCard(); };
$('tgSendStartBtn').onclick = function(){ clickTgButton({ action: 'start' }); };
$('tgBotProfile').onchange = function(){ if (tgState.connected) refreshTgCard({ sendStartIfEmpty: true }); };
$('tgAutoPollBtn').onclick = function(){
  tgState.autoPoll = !tgState.autoPoll;
  $('tgAutoPollBtn').textContent = '⏱ Live Poll: ' + (tgState.autoPoll ? 'ON (2.5s)' : 'OFF');
};

// ─── RIGHT: GOLD DROP LIVE FILL & SYNC ───
function paint(s){
  $('st').textContent = s.status;
  $('gdStatusPill').textContent = s.status;
  $('prog').textContent = s.count + ' / ' + s.target + ' done';
  $('gdProgPill').textContent = s.count + ' / ' + s.target;
  $('msg').textContent = s.message || '';
  show('askNumber', s.status === 'need_number');
  show('askOtp', s.status === 'need_otp');
  show('log', s.log.length > 0);
  $('log').textContent = s.log.slice(-40).join('\\n');

  var d = s.details || localRun.details;
  if (d) {
    $('fvName').textContent = d.name || '—';
    $('fvPin').textContent = (d.pincode || '—') + ' · ' + (d.code || '—');
  }
  $('fvEmail').textContent = localRun.emailUsed || (d ? d.email : '—');
  $('fsEmail').textContent = localRun.emailUsed ? 'generated ✅' : 'wait';
  $('fvMobile').textContent = localRun.mobile || s.mobile || 'waiting from TG…';
  $('fsMobile').textContent = (localRun.mobile || s.mobile) ? 'filled ✅' : 'fetching…';
  $('fvOtp').textContent = localRun.otpFilled || 'waiting from TG…';
  $('fsOtp').textContent = localRun.otpFilled ? 'filled ✅' : (s.status === 'need_otp' ? 'watching…' : 'wait');
  $('fvCaptcha').textContent = localRun.securitySolved ? 'NoCaptchaAI solved ✅' : (s.status === 'working' ? 'checking…' : 'auto');

  $('ffMobile').className = 'fill-field ' + (s.status === 'need_number' ? 'active' : ((localRun.mobile || s.mobile) ? 'filled' : ''));
  $('ffOtp').className = 'fill-field ' + (s.status === 'need_otp' ? 'active' : (localRun.otpFilled ? 'filled' : ''));
  $('ffEmail').className = 'fill-field ' + (localRun.emailUsed ? 'filled' : '');

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
  localRun.otpFilled = '';
  localRun.securitySolved = false;
  localRun.message = '📱 ' + m + ' Gold Drop me register ho raha hai (NoCaptchaAI check ho to 15-45s)…';
  paint(localRun);
  post('/number', { mobile: m, details: localRun.details, target: localRun.target }).then(function(r){
    $('sendNumber').disabled = false;
    if (!r.ok) { alert(r.message || 'Error'); localRun.status = 'need_number'; paint(localRun); return; }
    localRun.session = r.session || null;
    localRun.status = r.status;
    localRun.message = r.message;
    if (r.emailUsed) localRun.emailUsed = r.emailUsed;
    if (r.securitySolved) localRun.securitySolved = true;
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
  localRun.otpFilled = o;
  localRun.status = 'working';
  localRun.message = '🔐 OTP ' + o + ' verify ho raha hai…';
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
    if (autoSync && localRun.status === 'need_number' && tgState.connected) {
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
$('autoSyncChk').onchange = function(){ autoSync = $('autoSyncChk').checked; updateAutoSyncUI(); };
$('toggleAutoSyncRun').onclick = function(){ autoSync = !autoSync; updateAutoSyncUI(); };

$('start').onclick = function(){
  autoSync = $('autoSyncChk').checked;
  updateAutoSyncUI();
  var file = $('photo').files[0];
  var body = { name:$('name').value.trim(), email:$('email').value, pincode:$('pincode').value, code:$('code').value, target:Number($('target').value)||1, nocapKey:$('nocapKey').value.trim() };
  var go = function(){
    post('/start', body).then(function(r){
      if(!r.ok){ alert(r.message||'Error'); return; }
      tgState.lastConsumedPhone = '';
      tgState.lastConsumedOtpKey = '';
      localRun = { active:true, status:'need_number', message:'Telegram card se number fetch ho raha hai…', target:body.target, count:0, mobile:'', emailUsed:'', securitySolved:false, otpFilled:'', details:body, session:null, results:[], log:['▶ START — target '+body.target+' numbers'] };
      show('setup', false); show('run', true); paint(localRun);
      if (tgState.connected && tgState.lastScreen) {
        if (autoSync && !tgState.lastScreen.currentPhone) {
          clickTgButton({ action: 'find' });
        } else {
          maybeAutoFillFromTelegram(tgState.lastScreen);
        }
      }
    });
  };
  if (file){
    var rd = new FileReader();
    rd.onload = function(){ body.photo = String(rd.result).split(',')[1]; go(); };
    rd.readAsDataURL(file);
  } else go();
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
      if (s.lastEmailUsed) localRun.emailUsed = s.lastEmailUsed;
      if (s.securitySolved) localRun.securitySolved = true;
    }
    paint(localRun.active ? localRun : s);
  }).catch(function(){});
}

setInterval(function(){
  if (!tgState.connected || !tgState.autoPoll || tgState.busy) return;
  if (localRun.active && localRun.status === 'need_otp' && autoSync) {
    clickTgButton({ action: 'refresh' });
  } else {
    refreshTgCard();
  }
}, 2500);

gdPollTimer = setInterval(pollGd, 2500);
pollGd();
checkTgStatus();
updateAutoSyncUI();
post('/nocap-balance', { key: $('nocapKey').value.trim() }).then(function(r){ $('nocapbal').textContent = r.message || ''; }).catch(function(){ $('nocapbal').textContent = ''; });
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
    // Login routes — bina auth ke accessible
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
    // Baaki sab — login zaroori
    if (!isAuthed(req)) {
      if (req.method === 'GET') {
        res.writeHead(302, { 'Location': '/login' });
        res.end();
      } else {
        sendJson(res, 401, { ok: false, message: 'Login karo pehle' });
      }
      return;
    }

    // ─── Telegram Live Spare OTP Card APIs ───
    if (req.method === 'GET' && url.pathname === '/api/tg/status') {
      const tgSess = getTgCookieSession(req);
      const hasEnvApi = Boolean(Number(process.env.TELEGRAM_API_ID) > 0 && String(process.env.TELEGRAM_API_HASH || '').trim());
      sendJson(res, 200, {
        ok: true,
        connected: Boolean(tgSess),
        me: tgSess?.me || '',
        phone: tgSess?.phone || '',
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
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/tg/login/complete') {
      const body = await readBody(req);
      const stateTok = unsealJson(String(body.loginToken || ''));
      if (!stateTok || !stateTok.tempSession || !stateTok.phoneCodeHash) {
        sendJson(res, 400, { ok: false, message: 'Login session expire ho gaya — Send Login OTP dobara dabao.' });
        return;
      }
      const tg = await loadTgMod();
      const resLogin = await tg.completeStatelessTelegramLogin({
        apiId: stateTok.apiId,
        apiHash: stateTok.apiHash,
        phoneNumber: stateTok.phoneNumber,
        phoneCodeHash: stateTok.phoneCodeHash,
        tempSession: stateTok.tempSession,
        code: String(body.code || '').trim(),
        password: String(body.password || ''),
      });
      if (!resLogin.ok && resLogin.need2fa) {
        sendJson(res, 200, { ok: false, need2fa: true, message: resLogin.error || '2FA password required' });
        return;
      }
      if (!resLogin.ok || !resLogin.session) {
        sendJson(res, 400, { ok: false, message: resLogin.error || 'Login verify fail' });
        return;
      }
      const sealedCookie = sealJson({
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
        { ok: true, me: resLogin.me || '', phone: stateTok.phoneNumber },
        { 'Set-Cookie': tgCookieHeader(sealedCookie) }
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/tg/logout') {
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': tgCookieHeader('', 0) });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/tg/card') {
      const tgSess = getTgCookieSession(req);
      if (!tgSess) {
        sendJson(res, 401, { ok: false, message: 'Spare Telegram account connect nahi hai.' });
        return;
      }
      const body = await readBody(req);
      const tg = await loadTgMod();
      const screen = await tg.withTelegramAccountContext({
        userId: 'web',
        apiId: tgSess.apiId,
        apiHash: tgSess.apiHash,
        session: tgSess.session,
        botProfile: String(body.botProfile || 'hermes'),
        requireOwnAccount: true,
      }, () => tg.readTelegramOtpScreen({ limit: 10, sendStartIfEmpty: Boolean(body.sendStartIfEmpty) }));
      sendJson(res, 200, screen);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/tg/click') {
      const tgSess = getTgCookieSession(req);
      if (!tgSess) {
        sendJson(res, 401, { ok: false, message: 'Spare Telegram account connect nahi hai.' });
        return;
      }
      const body = await readBody(req);
      const tg = await loadTgMod();
      const screen = await tg.withTelegramAccountContext({
        userId: 'web',
        apiId: tgSess.apiId,
        apiHash: tgSess.apiHash,
        session: tgSess.session,
        botProfile: String(body.botProfile || 'hermes'),
        requireOwnAccount: true,
      }, () => tg.interactTelegramOtpScreen({
        action: String(body.action || 'button'),
        buttonText: String(body.buttonText || ''),
        row: Number.isInteger(body.row) ? body.row : -1,
        col: Number.isInteger(body.col) ? body.col : -1,
        messageId: Number(body.messageId) || 0,
        sendText: String(body.sendText || ''),
      }));
      sendJson(res, 200, screen);
      return;
    }

    // ─── Gold Drop Web UI & APIs ───
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE_HTML);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/state') {
      sendJson(res, 200, {
        ...state,
        session: undefined,
        details: state.details ? { name: state.details.name, pincode: state.details.pincode, code: state.details.code, email: state.details.email } : null,
      });
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
      state.lastEmailUsed = '';
      state.securitySolved = false;
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
      state.lastEmailUsed = ''; state.securitySolved = false;
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

// Local test ke liye: `node api/index.js` bhi chal sakta hai
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 3737);
  http.createServer(handler).listen(port, () => console.log(`🟡 Gold Drop + 📱 Telegram Live Card local par: http://localhost:${port}`));
}
