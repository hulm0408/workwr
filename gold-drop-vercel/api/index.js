// 🟡 Gold Drop — VERCEL (direct API method, drop.py jaisa — koi browser nahi).
// Number apne OTP bot se laao, yahan daalo → register → OTP daalo → verify.
// Security check aaye to NoCaptchaAI se auto-solve. Sab Vercel par chalta hai.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { registerGoldDrop, verifyGoldDropOtp } from './_gold-drop.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const NOCAP_API = 'https://api.nocaptchaai.com';
const NOCAP_KEY_DEFAULT = process.env.NOCAP_API_KEY || 'nocap_eVBzrYeejjgKLoikEErH6lbP';
const DEFAULT_PHOTO_URL = 'https://raw.githubusercontent.com/hulm0408/workwr/main/gold-drop-vercel/api/gold-drop-pack.jpg';
let cachedDefaultPhoto = '';

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

// ─── LOGIN (public Vercel URL hai — password ke bina koi use na kar paye) ───
const APP_PASSWORD = process.env.APP_PASSWORD || 'rahul@123';
const AUTH_COOKIE = `gd_auth=${createHash('sha256').update(`golddrop:${APP_PASSWORD}`).digest('hex')}`;

function isAuthed(req) {
  const cookie = String(req.headers.cookie || '');
  return cookie.split(';').map(x => x.trim()).includes(AUTH_COOKIE);
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
  logLine(`🔐 ${mobile} — OTP verify…`);
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

// ─── UI ───
const PAGE_HTML = `<!doctype html>
<html lang="hi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gold Drop</title>
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
<h1>🟡 Gold Drop</h1>
<div class="sub">Direct API method — koi browser nahi, sab cloud par chalta hai. Number apne OTP bot se laao. <a href="/logout" style="color:#f7b500">Logout</a></div>
<div id="setup">
<label>Naam</label><input id="name" value="Rahul Kumar">
<label>Email (Gmail — har number par +suffix apne aap)</label><input id="email" value="itsnoob012@gmail.com">
<div class="row"><div><label>PIN code</label><input id="pincode" value="509412"></div>
<div><label>Batch code</label><input id="code" value="KKD2LS01261026"></div></div>
<label>NoCaptchaAI API key (security check auto-solve)</label><input id="nocapKey" value="${NOCAP_KEY_DEFAULT}">
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
var localRun = { active: false, status: 'idle', message: '', target: 1, count: 0, mobile: '', details: null, session: null, results: [], log: [] };
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
function poll(){
  fetch('/state').then(function(r){return r.json()}).then(function(s){
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
  }).catch(function(){})
}
$('start').onclick = function(){
  var file = $('photo').files[0];
  var body = { name:$('name').value.trim(), email:$('email').value, pincode:$('pincode').value, code:$('code').value, target:Number($('target').value)||1, nocapKey:$('nocapKey').value.trim() };
  var go = function(){
    post('/start', body).then(function(r){
      if(!r.ok){ alert(r.message||'Error'); return }
      localRun = { active:true, status:'need_number', message:'Pehla mobile number daalo', target:body.target, count:0, mobile:'', details:body, session:null, results:[], log:['▶ START — target '+body.target+' numbers'] };
      show('setup',false); show('run',true); paint(localRun);
    });
  };
  if (file){
    var rd = new FileReader();
    rd.onload = function(){ body.photo = String(rd.result).split(',')[1]; go() };
    rd.readAsDataURL(file);
  } else go();
};
$('sendNumber').onclick = function(){
  var m=$('mobile').value.replace(/\\D/g,'').slice(-10);
  if(m.length!==10){alert('10-digit mobile daalo');return}
  $('mobile').value='';
  $('sendNumber').disabled = true;
  localRun.status = 'working';
  localRun.mobile = m;
  localRun.message = 'Register ho raha hai (NoCaptchaAI check ke saath 15-45s lag sakta hai)…';
  paint(localRun);
  post('/number',{mobile:m, details:localRun.details, target:localRun.target}).then(function(r){
    $('sendNumber').disabled = false;
    if(!r.ok){ alert(r.message||'Error'); localRun.status='need_number'; paint(localRun); return; }
    localRun.session = r.session || null;
    localRun.status = r.status;
    localRun.message = r.message;
    if (r.result){ localRun.results.push(r.result); localRun.count = localRun.results.length; }
    if (r.log && r.log.length) localRun.log = r.log;
    paint(localRun);
  }).catch(function(){ $('sendNumber').disabled = false; localRun.status='need_number'; paint(localRun); });
};
$('sendOtp').onclick = function(){
  var o=$('otp').value.replace(/\\D/g,'');
  if(o.length!==6){alert('6-digit OTP daalo');return}
  $('otp').value='';
  $('sendOtp').disabled = true;
  localRun.status = 'working';
  localRun.message = 'OTP verify ho raha hai…';
  paint(localRun);
  post('/otp',{otp:o, session:localRun.session, mobile:localRun.mobile, target:localRun.target}).then(function(r){
    $('sendOtp').disabled = false;
    if(!r.ok){ alert(r.message||'Error'); localRun.status='need_otp'; paint(localRun); return; }
    localRun.session = null;
    localRun.mobile = '';
    localRun.status = r.status;
    localRun.message = r.message;
    if (r.result){ localRun.results.push(r.result); localRun.count = localRun.results.length; }
    if (r.log && r.log.length) localRun.log = r.log;
    paint(localRun);
  }).catch(function(){ $('sendOtp').disabled = false; localRun.status='need_otp'; paint(localRun); });
};
$('reset').onclick = function(){ localRun.active = false; post('/reset').then(function(){ location.reload() }) };
pollTimer = setInterval(poll, 3000); poll();
post('/nocap-balance',{key:$('nocapKey').value.trim()}).then(function(r){ $('nocapbal').textContent = r.message || ''; }).catch(function(){ $('nocapbal').textContent=''; });
</script></body></html>`;

// ─── HTTP helpers ───
function sendJson(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
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

// Local test ke liye: `node api/index.js` bhi chal sakta hai
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 3737);
  http.createServer(handler).listen(port, () => console.log(`🟡 Gold Drop (Vercel build) local par: http://localhost:${port}`));
}
