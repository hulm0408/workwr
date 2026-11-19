// ===== 🌐 ZZBOT (ZEPTO PRO) — VERCEL WEB SIGNUP =====
//
// Gold Drop (gold-drop-vercel) ka bhai — par account Zepto Pro (zzbot) ka
// banta hai. Flow Toing Pro engine jaisa hi:
//
//   1. POST /api/login/otp    { mobile }        (header x-user-key)
//   2. OTP — do raste:
//        a) AUTO  : Telegram OTP bot (MTProto) se khud code uthta hai
//        b) MANUAL: owner OTP bot me dekh kar page par paste karta hai
//   3. POST /api/login/verify { otp }           (header x-user-key)
//   4. POST /api/accounts/{mobile}/export → session JSON
//   5. Session JSON download + (auto mode me) Telegram par bhi file
//
// Env (sab optional — page par bhi daal sakte ho):
//   ZZBOT_ACCESS_KEY   default ZPT-BW9Z-PLMB-1H1W-9HSD
//   ZZBOT_BASE_URL     default https://storelex.store/zzbot
//   APP_PASSWORD       page ka login password (default rahul@123)
//   TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION  → auto-OTP
//   OTP_BOT_USERNAME   default @HermeshuOTPROBOT
//   TG_DELIVER_CHAT_ID auto mode me session file yahan bhejo (optional)
//
// State per warm instance memory me (Gold Drop jaisa) — same instance reuse
// Vercel ka default hai.

import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ZZ_BASE = (process.env.ZZBOT_BASE_URL || 'https://storelex.store/zzbot').replace(/\/+$/, '');
const ZZ_KEY = process.env.ZZBOT_ACCESS_KEY || 'ZPT-BW9Z-PLMB-1H1W-9HSD';

// ─── LOGIN (public Vercel URL hai — password ke bina koi use na kar paye) ───
const APP_PASSWORD = process.env.APP_PASSWORD || 'rahul@123';
const AUTH_COOKIE = `zz_auth=${createHash('sha256').update(`zzbot:${APP_PASSWORD}`).digest('hex')}`;

function isAuthed(req) {
  const cookie = String(req.headers.cookie || '');
  return cookie.split(';').map(x => x.trim()).includes(AUTH_COOKIE);
}

// ─── In-memory run state (single-user app) ───
const state = {
  status: 'idle',   // idle | need_number | working | need_otp | done
  message: '',
  mobile: '',
  count: 0,
  target: 1,
  otpMode: 'manual', // manual | auto
  session: null,     // { mobile, name, token, ... } — screen par dikhane ke liye
  sessionJson: '',   // poora export JSON
  results: [],
  log: [],
};

function logLine(message) {
  state.log.push(`[${new Date().toLocaleTimeString()}] ${message}`);
  if (state.log.length > 200) state.log.shift();
}

// ─── zzbot API ───
function zzHeaders() {
  return { 'Content-Type': 'application/json', 'x-user-key': ZZ_KEY };
}

async function zzPost(apiPath, body = null, timeoutMs = 30000) {
  const res = await fetch(`${ZZ_BASE}${apiPath}`, {
    method: 'POST',
    headers: zzHeaders(),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
  return { ok: res.ok, status: res.status, data };
}

function errorText(data, status) {
  if (!data) return `HTTP ${status}`;
  const detail = data.detail ?? data.error ?? data.message ?? data.raw ?? '';
  if (typeof detail === 'string' && detail.trim()) return detail.trim();
  if (Array.isArray(detail)) return detail.map(d => d?.msg || '').filter(Boolean).join(', ') || `HTTP ${status}`;
  return `HTTP ${status}`;
}

// Export payload se saaf session — Toing engine ka cleanExport jaisa.
function cleanExport(raw = {}, mobile = '') {
  const pick = (...keys) => {
    for (const k of keys) {
      const v = raw?.[k];
      if (v !== undefined && v !== null && String(v).trim() !== '') return v;
    }
    return '';
  };
  return {
    mobile: String(pick('mobile', 'phone', 'number') || mobile).replace(/\D/g, '').slice(-10),
    name: String(pick('name', 'customer_name', 'userName', 'user_name') || '').trim(),
    token: String(pick('token', 'user_token', 'access_token', 'jwt') || '').trim(),
    sid: String(pick('sid', 'session_id') || '').trim(),
    tid: String(pick('tid', 'transaction_id') || '').trim(),
    deviceId: String(pick('deviceId', 'device_id') || '').trim(),
    customerId: String(pick('customerId', 'customer_id', 'userId', 'user_id') || '').trim(),
  };
}

// ─── Telethon/MTProto — sirf auto mode me load hota hai (optional dependency) ───
let tgClientPromise = null;

function telegramConfigured() {
  return Boolean(
    process.env.TELEGRAM_API_ID
    && process.env.TELEGRAM_API_HASH
    && (process.env.TELEGRAM_SESSION || process.env.TELEGRAM_STRING_SESSION)
  );
}

async function getTelegramClient() {
  if (!telegramConfigured()) throw new Error('Telegram auto-OTP not configured (TELEGRAM_* env missing)');
  if (!tgClientPromise) {
    tgClientPromise = (async () => {
      const main = await import('teleproto');
      const sessions = await import('teleproto/sessions');
      const client = new main.TelegramClient(
        new sessions.StringSession(String(process.env.TELEGRAM_SESSION || process.env.TELEGRAM_STRING_SESSION || '')),
        Number(process.env.TELEGRAM_API_ID),
        String(process.env.TELEGRAM_API_HASH),
        { connectionRetries: 3 },
      );
      await client.connect();
      return client;
    })().catch((error) => { tgClientPromise = null; throw error; });
  }
  return tgClientPromise;
}

// OTP bot ki latest messages me se is number ka 6-digit code dhoondho.
async function pollTelegramOtp(mobile, timeoutMs = 45000, refreshMs = 2500) {
  const botUsername = String(process.env.OTP_BOT_USERNAME || 'HermeshuOTPROBOT').replace(/^@/, '');
  const client = await getTelegramClient();
  const deadline = Date.now() + timeoutMs;
  const last10 = String(mobile).slice(-10);
  while (Date.now() < deadline) {
    try {
      const msgs = await client.getMessages(botUsername, { limit: 8 });
      for (const msg of msgs || []) {
        const text = String(msg?.message || '');
        if (!text) continue;
        const digits = text.replace(/\D/g, '');
        if (!digits.includes(last10)) continue;
        const code = (text.match(/(?:^|\D)(\d{6})(?:\D|$)/) || [])[1];
        if (code) return code;
      }
    } catch (error) {
      logLine(`⚠️ Telegram poll: ${String(error?.message || error).slice(0, 80)}`);
    }
    await new Promise(r => setTimeout(r, refreshMs));
  }
  return '';
}

async function sendTelegramFile(jsonText, fileName) {
  const chatId = process.env.TG_DELIVER_CHAT_ID;
  if (!chatId) return false;
  try {
    const client = await getTelegramClient();
    const { CustomFile } = await import('teleproto/client/uploads.js').catch(() => ({}));
    const buffer = Buffer.from(jsonText, 'utf8');
    const file = CustomFile
      ? new CustomFile(fileName, buffer.length, '', buffer)
      : buffer;
    await client.sendFile(chatId, { file, caption: `🌐 ZZBOT session — ${fileName}` });
    return true;
  } catch (error) {
    logLine(`⚠️ Telegram deliver fail: ${String(error?.message || error).slice(0, 80)}`);
    return false;
  }
}

// ─── Core flow ───
async function processNumber(mobile, otpMode) {
  state.status = 'working';
  state.mobile = mobile;
  state.session = null;
  state.sessionJson = '';
  logLine(`📱 ${mobile} — Zepto Pro par OTP bhej raha hoon…`);
  try {
    const send = await zzPost('/api/login/otp', { mobile });
    const ok = send.ok && send.data?.success !== false && !send.data?.detail;
    if (!ok) throw new Error(errorText(send.data, send.status));
    logLine(`✅ OTP bheja gaya — apne OTP bot (${process.env.OTP_BOT_USERNAME || '@HermeshuOTPROBOT'}) me dekho`);

    if (otpMode === 'auto') {
      if (!telegramConfigured()) {
        logLine('⚠️ Auto-OTP configured nahi hai — manual mode me OTP daalo');
        state.status = 'need_otp';
        state.message = 'Auto-OTP setup nahi hai — OTP bot se 6-digit code yahan daalo';
        return;
      }
      state.message = 'Telegram OTP bot se code ka wait…';
      logLine('🤖 Telegram OTP bot se code dhoondh raha hoon…');
      const code = await pollTelegramOtp(mobile);
      if (!code) {
        state.status = 'need_otp';
        state.message = 'Auto-OTP me code nahi mila — OTP bot se khud daal do';
        logLine('⚠️ Auto-OTP timeout — manual entry par');
        return;
      }
      logLine(`🔑 OTP mil gaya: ${code}`);
      await verifyAndExport(code);
      return;
    }

    state.status = 'need_otp';
    state.message = 'OTP bot me aaya 6-digit code yahan daalo';
  } catch (error) {
    const message = String(error?.message || error).slice(0, 200);
    logLine(`❌ ${mobile} — ${message}`);
    state.results.push({ mobile, ok: false, message });
    nextOrDone('need_number', 'Agla number daalo');
  }
}

async function verifyAndExport(otp) {
  state.status = 'working';
  state.message = 'OTP verify ho raha hai…';
  const mobile = state.mobile;
  logLine(`🔐 ${mobile} — OTP verify…`);
  try {
    const verify = await zzPost('/api/login/verify', { otp: String(otp) });
    const ok = verify.ok && verify.data?.success !== false && !verify.data?.detail;
    if (!ok) throw new Error(errorText(verify.data, verify.status));
    logLine('✅ OTP verified — session export kar raha hoon…');

    const exp = await zzPost(`/api/accounts/${encodeURIComponent(mobile)}/export`);
    const raw = exp.data?.export || exp.data?.session || (exp.data?.success === false ? null : exp.data);
    if (!exp.ok || !raw || typeof raw !== 'object' || !Object.keys(raw).length) {
      throw new Error(`Export fail: ${errorText(exp.data, exp.status)}`);
    }

    state.session = cleanExport(raw, mobile);
    state.sessionJson = JSON.stringify(raw, null, 2);
    state.results.push({ mobile, ok: true, message: `Session export ho gaya (${state.session.name || 'no name'})` });
    logLine(`🎉 ${mobile} — Zepto session ready (${state.sessionJson.length} bytes)`);

    if (state.otpMode === 'auto') {
      const sent = await sendTelegramFile(state.sessionJson, `zzbot-${mobile}.json`);
      if (sent) logLine('📤 Session file Telegram par bhej di');
    }
  } catch (error) {
    const message = String(error?.message || error).slice(0, 200);
    logLine(`❌ ${mobile} — ${message}`);
    state.results.push({ mobile, ok: false, message });
  }
  state.mobile = '';
  nextOrDone('need_number', 'Agla number daalo');
}

function nextOrDone(status, message) {
  if (state.results.length >= state.target) {
    state.status = 'done';
    state.message = `${state.target} numbers process ho gaye — results neeche`;
  } else {
    state.status = status;
    state.message = message;
  }
}

// ─── UI ───
const LOGIN_HTML = `<!doctype html>
<html lang="hi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZZBOT (Zepto) — Login</title>
<style>
body{background:#0f1220;color:#e8eaf2;font-family:system-ui,Segoe UI,Roboto,sans-serif;margin:0;padding:24px;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{width:100%;max-width:360px;background:#181c2e;border:1px solid #2a3050;border-radius:14px;padding:24px}
h1{font-size:20px;margin:0 0 4px} .sub{color:#8a90ad;font-size:13px;margin-bottom:16px}
input,button{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:9px;border:1px solid #2a3050;background:#0f1220;color:#e8eaf2;font-size:15px}
button{background:#7c5cff;color:#fff;font-weight:700;border:none;cursor:pointer;margin-top:14px}
.err{color:#ff6b6b;font-size:13px;margin-top:10px;display:none}
</style></head><body><div class="card">
<h1>🌐 ZZBOT (Zepto)</h1>
<div class="sub">Login karo — sirf apne log.</div>
<form method="POST" action="/login">
<input name="password" type="password" placeholder="Password" autofocus>
<button type="submit">🔓 Login</button>
<div class="err" id="err">Galat password</div>
</form>
</div>
<script>if(location.search.indexOf('wrong')>-1)document.getElementById('err').style.display='block';</script>
</body></html>`;

const PAGE_HTML = `<!doctype html>
<html lang="hi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZZBOT (Zepto Pro)</title>
<style>
body{background:#0f1220;color:#e8eaf2;font-family:system-ui,Segoe UI,Roboto,sans-serif;margin:0;padding:24px}
.card{max-width:560px;margin:0 auto;background:#181c2e;border:1px solid #2a3050;border-radius:14px;padding:20px}
h1{font-size:20px;margin:0 0 4px} .sub{color:#8a90ad;font-size:13px;margin-bottom:16px}
label{display:block;font-size:12px;color:#9aa1bd;margin:10px 0 4px}
input,button,select{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:9px;border:1px solid #2a3050;background:#0f1220;color:#e8eaf2;font-size:15px}
button{background:#7c5cff;color:#fff;font-weight:700;border:none;cursor:pointer;margin-top:14px}
button.secondary{background:#232845;color:#e8eaf2}
.status{background:#10142a;border:1px solid #2a3050;border-radius:10px;padding:12px;margin-top:16px;font-size:14px;white-space:pre-wrap}
.log{background:#0a0c18;border-radius:10px;padding:10px;font:12px/1.5 monospace;color:#7d84a8;max-height:220px;overflow:auto;margin-top:12px;white-space:pre-wrap}
.badge{display:inline-block;padding:2px 10px;border-radius:99px;background:#232845;font-size:12px}
pre.json{background:#0a0c18;border-radius:10px;padding:10px;font:11px/1.5 monospace;color:#9fe3b0;max-height:240px;overflow:auto;white-space:pre-wrap}
a.dl{display:block;text-align:center;margin-top:10px;padding:10px;border-radius:9px;background:#1f8a4c;color:#fff;text-decoration:none;font-weight:700}
</style></head><body><div class="card">
<h1>🌐 ZZBOT (Zepto Pro)</h1>
<div class="sub">Toing jaisa hi flow — OTP bhejo, verify karo, Zepto session JSON lo. <a href="/logout" style="color:#7c5cff">Logout</a></div>
<div id="setup">
<label>Kitne numbers process karne hain?</label><input id="target" type="number" value="1" min="1" max="50">
<label>OTP kaise aayega?</label>
<select id="otpMode">
<option value="manual">Manual — OTP bot me dekho, yahan paste karo</option>
<option value="auto">Auto — Telegram OTP bot se khud uthega</option>
</select>
<button id="start">▶ START</button>
</div>
<div id="run" style="display:none">
<div class="status"><span class="badge" id="st">…</span> <b id="prog"></b><div id="msg" style="margin-top:6px"></div></div>
<div id="askNumber" style="display:none"><label>Mobile number (apne OTP bot se naya number lo)</label>
<input id="mobile" inputmode="numeric" maxlength="10" placeholder="9876543210"><button id="sendNumber">Number bhejo → OTP</button></div>
<div id="askOtp" style="display:none"><label>OTP (jo OTP bot me aaya)</label>
<input id="otp" inputmode="numeric" maxlength="6" placeholder="123456"><button id="sendOtp">OTP verify karo</button></div>
<button class="secondary" id="reset" style="margin-top:18px">■ Stop / Reset</button>
<div class="log" id="log"></div>
</div>
<div id="out" style="display:none">
<label style="margin-top:16px">Session JSON</label>
<pre class="json" id="json"></pre>
<a class="dl" id="dl" href="#" download>⬇️ Session JSON download</a>
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
  if (s.sessionJson){
    show('out', true);
    $('json').textContent = s.sessionJson;
    var blob = 'data:application/json;charset=utf-8,' + encodeURIComponent(s.sessionJson);
    var a = $('dl'); a.href = blob; a.download = 'zzbot-' + (s.session && s.session.mobile ? s.session.mobile : 'session') + '.json';
  }
}
function poll(){ fetch('/state').then(function(r){return r.json()}).then(paint).catch(function(){}) }
$('start').onclick = function(){
  var body = { target: Number($('target').value)||1, otpMode: $('otpMode').value };
  post('/start', body).then(function(r){
    if(!r.ok){ alert(r.message||'Error'); return }
    show('setup',false); show('run',true); poll();
  });
};
$('sendNumber').onclick = function(){ var m=$('mobile').value.replace(/\\D/g,'').slice(-10); if(m.length!==10){alert('10-digit mobile daalo');return} $('mobile').value=''; post('/number',{mobile:m}).then(poll) };
$('sendOtp').onclick = function(){ var o=$('otp').value.replace(/\\D/g,''); if(o.length!==6){alert('6-digit OTP daalo');return} $('otp').value=''; post('/otp',{otp:o}).then(poll) };
$('reset').onclick = function(){ post('/reset').then(function(){ location.reload() }) };
pollTimer = setInterval(poll, 1200); poll();
</script></body></html>`;

// ─── HTTP helpers ───
function sendJson(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; if (raw.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  try {
    // Login routes — bina auth ke
    if (url.pathname === '/login') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(LOGIN_HTML);
        return;
      }
      if (req.method === 'POST') {
        let raw = '';
        await new Promise((resolve) => { req.on('data', (c) => { raw += c; }); req.on('end', resolve); });
        const params = new URLSearchParams(raw);
        if (params.get('password') === APP_PASSWORD) {
          res.writeHead(302, { 'Set-Cookie': `${AUTH_COOKIE}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`, Location: '/' });
        } else {
          res.writeHead(302, { Location: '/login?wrong=1' });
        }
        res.end();
        return;
      }
    }
    if (url.pathname === '/logout') {
      res.writeHead(302, { 'Set-Cookie': 'zz_auth=; Path=/; HttpOnly; Max-Age=0', Location: '/login' });
      res.end();
      return;
    }

    // Baaki sab — login zaroori
    if (!isAuthed(req)) {
      if (req.method === 'GET') {
        res.writeHead(302, { Location: '/login' });
        res.end();
      } else {
        sendJson(res, 401, { ok: false, message: 'Login karo pehle' });
      }
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE_HTML);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/state') {
      sendJson(res, 200, {
        status: state.status,
        message: state.message,
        mobile: state.mobile,
        count: state.results.length,
        target: state.target,
        otpMode: state.otpMode,
        session: state.session,
        sessionJson: state.sessionJson,
        results: state.results,
        log: state.log,
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        base: ZZ_BASE,
        telegramAutoOtp: telegramConfigured(),
        deliverToTelegram: Boolean(process.env.TG_DELIVER_CHAT_ID),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/start') {
      const body = await readBody(req);
      if (state.status !== 'idle' && state.status !== 'done') {
        sendJson(res, 400, { ok: false, message: 'Pehle run chal raha hai — Stop/Reset karo' });
        return;
      }
      state.target = Math.max(1, Math.min(50, Number(body.target) || 1));
      state.otpMode = body.otpMode === 'auto' ? 'auto' : 'manual';
      state.results = [];
      state.log = [];
      state.session = null;
      state.sessionJson = '';
      state.mobile = '';
      state.status = 'need_number';
      state.message = 'Pehla mobile number daalo';
      logLine(`▶ START — target ${state.target} · OTP ${state.otpMode === 'auto' ? 'AUTO (Telegram bot)' : 'MANUAL'}`);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/number') {
      const body = await readBody(req);
      if (state.status !== 'need_number') { sendJson(res, 400, { ok: false, message: 'Abhi number nahi chahiye' }); return; }
      const mobile = String(body.mobile || '').replace(/\D/g, '').slice(-10);
      if (!/^[6789]\d{9}$/.test(mobile)) { sendJson(res, 400, { ok: false, message: 'Valid 10-digit Indian mobile daalo' }); return; }
      sendJson(res, 200, { ok: true });
      processNumber(mobile, state.otpMode); // background — UI /state poll karta hai
      return;
    }

    if (req.method === 'POST' && url.pathname === '/otp') {
      const body = await readBody(req);
      if (state.status !== 'need_otp') { sendJson(res, 400, { ok: false, message: 'Abhi OTP nahi chahiye' }); return; }
      const otp = String(body.otp || '').replace(/\D/g, '');
      if (!/^\d{6}$/.test(otp)) { sendJson(res, 400, { ok: false, message: '6-digit OTP daalo' }); return; }
      sendJson(res, 200, { ok: true });
      verifyAndExport(otp); // background
      return;
    }

    if (req.method === 'POST' && url.pathname === '/reset') {
      state.status = 'idle';
      state.message = '';
      state.mobile = '';
      state.session = null;
      state.sessionJson = '';
      state.results = [];
      state.log = [];
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { ok: false, message: 'Not found' });
  } catch (error) {
    sendJson(res, 500, { ok: false, message: String(error?.message || error).slice(0, 200) });
  }
}

// Local test: `node api/index.js` → http://localhost:3739
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 3739);
  http.createServer(handler).listen(port, '0.0.0.0', () => console.log(`🌐 ZZBOT web (local): http://localhost:${port}`));
}
