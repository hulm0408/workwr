// 🟡 Gold Drop — VERCEL (direct API method, drop.py jaisa — koi browser nahi).
// Number apne OTP bot se laao, yahan daalo → register → OTP daalo → verify.
// Security check aaye to NoCaptchaAI se auto-solve. Sab Vercel par chalta hai.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { registerGoldDrop, verifyGoldDropOtp, goldDropCaptchaDiagnose, goldDropDeadEnd, resetGoldDropDeadEnd } from './_gold-drop.js';
import { goldDropBrowserAvailable, findStealthWorker } from './_gold-drop-browser.js';
import { readOtpBotMirror, telegramConfigured, setMirrorSession } from './_otp-mirror.js';
import { startTelegramLogin, submitTelegramCode, submitTelegramPassword, loginConfigured } from './_telegram-login.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const NOCAP_API = 'https://api.nocaptchaai.com';
const NOCAP_KEY_DEFAULT = process.env.NOCAP_API_KEY || 'nocap_eVBzrYeejjgKLoikEErH6lbP';
// Pack photo: file ho to wahi, warna ek chhota embedded JPEG — taaki app
// kisi bhi build environment me (Docker image me file na ho tab bhi) chale.
const EMBEDDED_PHOTO = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDs0NDT/wAALCAABAAEBAREA/8QAFAABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AmAA/9k=';
const DEFAULT_PHOTO = (() => {
  try { return readFileSync(path.join(ROOT, 'gold-drop-pack.jpg')).toString('base64'); }
  catch { return EMBEDDED_PHOTO; }
})();

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
  } catch (error) {
    const message = String(error?.message || error).slice(0, 200);
    logLine(`❌ ${mobile} — ${message}`);
    state.results.push({ mobile, ok: false, message });
    state.session = null;
    if (state.results.length >= state.target) {
      state.status = 'done';
      state.message = `${state.target} numbers process ho gaye — results neeche`;
    } else {
      state.status = 'need_number';
      state.message = 'Agla number daalo';
    }
  }
}

async function processOtp(otp) {
  state.status = 'working';
  state.message = 'OTP verify ho raha hai…';
  logLine(`🔐 ${state.mobile} — OTP verify…`);
  try {
    const res = await verifyGoldDropOtp({ session: state.session, otp });
    const rewardText = res.reward?.name ? ` 🎁 ${res.reward.name} (${res.reward.faceValue})` : '';
    logLine(`✅ ${state.mobile} verified — ${res.message}${rewardText}. Reward SMS ab phone par aayega.`);
    state.results.push({ mobile: state.mobile, ok: true, message: `${res.message}${rewardText}` });
  } catch (error) {
    const message = String(error?.message || error).slice(0, 200);
    logLine(`❌ ${state.mobile} — ${message}`);
    state.results.push({ mobile: state.mobile, ok: false, message });
  }
  state.session = null;
  state.mobile = '';
  if (state.results.length >= state.target) {
    state.status = 'done';
    state.message = `${state.target} numbers process ho gaye — results neeche`;
  } else {
    state.status = 'need_number';
    state.message = 'Agla number daalo';
  }
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
.split{display:grid;grid-template-columns:minmax(270px,1fr) minmax(320px,1.1fr);gap:14px;align-items:start}
@media(max-width:880px){.split{grid-template-columns:1fr}}
.mirror{background:#0b0e18;border:1px solid #2a3050;border-radius:14px;overflow:hidden}
.mirror .head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#12162a;border-bottom:1px solid #2a3050;font-size:13px;font-weight:700}
.mirror .dot{width:8px;height:8px;border-radius:99px;background:#4a5070;display:inline-block;margin-right:6px}
.mirror .dot.live{background:#28c76f;box-shadow:0 0 6px #28c76f}
.mirror .chat{padding:10px;max-height:360px;overflow:auto;display:flex;flex-direction:column;gap:8px}
.mirror .bubble{background:#1a2036;border:1px solid #2a3050;border-radius:10px 10px 10px 3px;padding:8px 10px;font-size:12.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.mirror .bubble small{display:block;color:#6f769a;font-size:10.5px;margin-top:4px}
.mirror .code{display:inline-block;margin-top:4px;background:#0d3b22;color:#7ee2a8;border:1px solid #1f6b3a;border-radius:6px;padding:1px 7px;font:600 12px ui-monospace,monospace}
.mirror .empty{color:#6f769a;font-size:12px;padding:12px;text-align:center}
.mirror .foot{padding:10px 12px;border-top:1px solid #2a3050}
.mirror .kv{display:flex;justify-content:space-between;font-size:12px;color:#8a90ad;margin-bottom:4px}
.mirror .kv b{color:#e8eaf2;font:600 12.5px ui-monospace,monospace}
</style></head><body><div class="card">
<h1>🟡 Gold Drop</h1>
<div class="sub">Direct API method — koi browser nahi, sab cloud par chalta hai. Number apne OTP bot se laao. <a href="/logout" style="color:#f7b500">Logout</a></div>
<div class="sub" id="browsermode" style="border:1px solid #2a3050;border-radius:9px;padding:10px;background:#10142a">Browser mode check ho raha hai…</div>
<div class="split">
<div><!-- OTP bot mirror -->
  <div class="mirror">
    <div class="head"><span><span class="dot" id="mDot"></span>OTP bot mirror</span><span class="badge" id="mBot">—</span></div>
    <div class="chat" id="mChat"><div class="empty">Mirror load ho raha hai…</div></div>
    <div class="foot">
      <div class="kv"><span>Number</span><b id="mNumber">—</b></div>
      <div class="kv"><span>OTP</span><b id="mOtp">—</b></div>
      <button class="secondary" id="mRefresh" style="margin-top:8px">🔄 Refresh mirror</button>
      <button class="secondary" id="mNext" style="margin-top:6px">📱 Naya number lo</button>
      <div class="sub" id="mHint" style="margin:6px 0 0"></div>
      <!-- Spare account login (sirf tab dikhta hai jab session nahi hai) -->
      <div id="tgLogin" style="display:none;margin-top:12px;border-top:1px solid #2a3050;padding-top:10px">
        <div style="font-size:12.5px;font-weight:700;margin-bottom:6px">🔐 Spare account se mirror jodo</div>
        <div class="sub" id="tgNote" style="margin:0 0 6px"></div>
        <div id="tgPhoneRow">
          <input id="tgPhone" placeholder="+9198xxxxxxxx" inputmode="tel">
          <button class="secondary" id="tgSendCode" style="margin-top:6px">Code bhejo</button>
        </div>
        <div id="tgCodeRow" style="display:none">
          <input id="tgCode" placeholder="Telegram login code" inputmode="numeric">
          <button class="secondary" id="tgSignIn" style="margin-top:6px">Sign in</button>
          <button class="secondary" id="tgResend" style="margin-top:6px">Code dobara bhejo</button>
        </div>
        <div id="tgPassRow" style="display:none">
          <input id="tgPass" type="password" placeholder="2FA password">
          <button class="secondary" id="tgPassOk" style="margin-top:6px">Unlock</button>
        </div>
        <div id="tgApplyRow" style="display:none">
          <button class="secondary" id="tgApply" style="margin-top:6px">✅ Mirror me lagao</button>
        </div>
        <div class="sub" id="tgOut" style="margin:6px 0 0"></div>
      </div>
    </div>
  </div>
</div>
<div><!-- process -->
<div id="setup">
<label>Naam</label><input id="name" value="Rahul Kumar">
<label>Email (Gmail — har number par +suffix apne aap)</label><input id="email" value="itsnoob012@gmail.com">
<div class="row"><div><label>PIN code</label><input id="pincode" value="509412"></div>
<div><label>Batch code</label><input id="code" value="KKD2LS01261026"></div></div>
<label>NoCaptchaAI API key (security check auto-solve)</label><input id="nocapKey" value="${NOCAP_KEY_DEFAULT}">
<div class="sub" id="nocapbal">NoCaptchaAI balance check ho raha hai…</div>
<label>Pack photo (optional — na do to default use hogi)</label><input id="photo" type="file" accept="image/*">
<label>Kitne numbers process karne hain?</label><input id="target" type="number" value="5" min="1" max="100">
<button class="secondary" id="captchaTest">🛡️ Captcha test (key + sitekeys)</button>
<div class="sub" id="captchaOut"></div>
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
</div><!-- /process -->
</div><!-- /split -->
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
// ─── OTP bot mirror (left pane) ───
var M = { timer: null, last: null, lastOtp: '' };
function esc(t){ return String(t==null?'':t).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c] }) }
function fmtTime(iso){
  if (!iso) return '';
  var d = new Date(iso); if (isNaN(d)) return '';
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function paintMirror(m){
  $('mBot').textContent = m.bot ? ('@' + m.bot) : '—';
  $('mDot').className = 'dot' + (m.ok ? ' live' : '');
  var chat = $('mChat');
  if (!m.ok && !(m.messages||[]).length){
    // Load error — mirror se link nahi bana. Error ke saath seedha fix batao.
    chat.innerHTML = '<div class="empty">' + esc(m.error || 'Mirror band hai')
      + '<br><br>Fix: Vercel → Settings → Environment Variables me TELEGRAM_SESSION daalo'
      + ' (TELEGRAM_API_ID/HASH pehle se hain), phir Redeploy.</div>';
  } else if (!(m.messages||[]).length){
    chat.innerHTML = '<div class="empty">Bot me abhi koi message nahi — NEW NUMBER dabao</div>';
  } else {
    chat.innerHTML = (m.messages||[]).map(function(x, i){
      var code = (String(x.text).match(/(?:^|\D)(\d{6})(?:\D|$)/)||[])[1];
      var body = esc(x.text);
      if (code) body = body.replace(code, '<span class="code">'+code+'</span>');
      return '<div class="bubble">' + body + '<small>#' + (x.id||'') + ' · ' + fmtTime(x.at) + (i===0?' · latest':'') + '</small></div>';
    }).join('');
  }
  $('mNumber').textContent = m.number || '—';
  $('mOtp').textContent = m.otp || '—';
  M.last = m;
  if (m.otp && m.otp !== M.lastOtp){
    M.lastOtp = m.otp;
    var f = $('otp');
    if (f && !f.value){ f.value = m.otp; $('mHint').textContent = 'OTP mirror se bhar diya — verify dabao'; }
  }
  $('mHint').textContent = (m.messages||[]).length + ' messages'
    + (!m.ok ? ' · purana data (' + (m.error || '') + ')' : '');
}
var TG = { loginId: '', step: 'phone', session: '' };
function tgShow(step, out){
  $('tgPhoneRow').style.display = step === 'phone' ? 'block' : 'none';
  $('tgCodeRow').style.display = step === 'code' ? 'block' : 'none';
  $('tgPassRow').style.display = step === 'password' ? 'block' : 'none';
  $('tgApplyRow').style.display = step === 'done' ? 'block' : 'none';
  if (out) $('tgOut').textContent = out;
  TG.step = step;
}
function tgPaint(res){
  if (!res) return;
  if (res.loginId) TG.loginId = res.loginId;
  if (res.session) TG.session = res.session;
  tgShow(res.step || TG.step, (res.ok ? '✅ ' : '❌ ') + (res.message || res.error || ''));
  if (res.step === 'done') loadMirror();
}
function tgPost(url, body){
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    .then(function(r){ return r.json() }).then(function(res){ tgPaint(res); return res; })
    .catch(function(e){ $('tgOut').textContent = '❌ ' + e; });
}
$('tgSendCode').onclick = function(){ tgPost('/tg-login/start', { phone: $('tgPhone').value.trim() }); };
$('tgSignIn').onclick = function(){ tgPost('/tg-login/code', { loginId: TG.loginId, code: $('tgCode').value.trim() }); };
$('tgResend').onclick = function(){ TG.loginId = ''; tgPost('/tg-login/start', { phone: $('tgPhone').value.trim() }); };
$('tgPassOk').onclick = function(){ tgPost('/tg-login/password', { loginId: TG.loginId, password: $('tgPass').value }); };
$('tgApply').onclick = function(){
  tgPost('/tg-login/apply', { loginId: TG.loginId, session: TG.session }).then(function(res){
    if (res && res.ok){ $('tgLogin').style.display = 'none'; loadMirror(); }
  });
};
function loadMirror(){
  fetch('/otp-mirror?slot=0').then(function(r){ return r.json() }).then(function(m){
    paintMirror(m);
    // Mirror ne session nahi maanga? Login panel dikhao, warna chhupao.
    var need = !m.ok && /configured nahi|SESSION/i.test(m.error || '');
    $('tgLogin').style.display = need ? 'block' : 'none';
    $('tgNote').textContent = need ? '' : '';
  }).catch(function(){});
}
fetch('/tg-login/status').then(function(r){ return r.json() }).then(function(st){
  $('tgNote').textContent = st.configured
    ? ''
    : (st.apiReady ? 'API ID/HASH mil gaya — spare account ka number daalo.' : 'TELEGRAM_API_ID/HASH env missing hai — login nahi ho payega.');
}).catch(function(){});
$('mRefresh').onclick = loadMirror;
$('mNext').onclick = function(){
  loadMirror();
  setTimeout(function(){
    var n = (M.last && M.last.number) || '';
    if (n && /^[6-9]\d{9}$/.test(n)) {
      var inp = $('mobile');
      if (inp) { inp.value = n; inp.focus(); }
      $('mHint').textContent = 'Number mirror se bhar diya — "Number bhejo" dabao';
    } else {
      $('mHint').textContent = 'Bot me naya number nahi mila — OTP bot me NEW NUMBER dabao, phir Refresh';
    }
  }, 400);
};
function captchaTest(){
  var btn = $('captchaTest');
  btn.disabled = true; var old = btn.textContent; btn.textContent = '🛡️ Test chal raha hai…';
  post('/captcha-test',{key:$('nocapKey').value.trim()}).then(function(r){
    btn.disabled = false; btn.textContent = old;
    var out = $('captchaOut');
    out.innerHTML = (r.ok?'✅ ':'❌ ') + (r.message||'');
    if (r.sitekeys && r.sitekeys.length) out.innerHTML += '<br>sitekeys: <code>' + r.sitekeys.join('</code>, <code>') + '</code>';
    $('nocapbal').textContent = r.keyMasked ? ('key: ' + r.keyMasked) : '';
  }).catch(function(){ btn.disabled = false; btn.textContent = old; });
}
$('captchaTest').onclick = captchaTest;
// Mirror boot — sab function/var define hone ke BAAD hi chalta hai.
loadMirror(); M.timer = setInterval(loadMirror, 5000);
fetch('/browser-mode').then(function(r){return r.json()}).then(function(b){
  var el = $('browsermode');
  if (b.available) {
    el.style.borderColor = '#1f6b3a'; el.style.background = '#0f2418'; el.style.color = '#7ee2a8';
    el.innerHTML = '✅ <b>Asli browser mode ON</b> — Gold Drop ka security check browser khud clear karega (register + OTP dono usi page par).';
  } else {
    el.style.borderColor = '#6b4b00'; el.style.background = '#241c00'; el.style.color = '#ffd479';
    el.innerHTML = '⚠️ <b>Browser mode OFF</b> — ' + (b.reason || 'Chrome/Python nahi mila')
      + '. Iske bina Gold Drop ka security check clear nahi hoga; phone numbers bachao aur 🛡️ Captcha test chalao.';
  }
}).catch(function(){ $('browsermode').style.display='none'; });
post('/nocap-balance',{key:$('nocapKey').value.trim()}).then(function(r){
  $('nocapbal').textContent = r.message || '';
  $('captchaOut').textContent = (r.ok?'✅ ':'❌ ') + (r.message||'') + (r.sitekeys&&r.sitekeys.length ? ' · sitekeys: ' + r.sitekeys.join(', ') : '');
}).catch(function(){ $('nocapbal').textContent=''; });
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
      state.details = { name: body.name, email: body.email, pincode: body.pincode, code: body.code, photo: body.photo || DEFAULT_PHOTO, nocapKey: body.nocapKey };
      state.target = Math.max(1, Math.min(100, Number(body.target) || 1));
      state.count = 0;
      state.results = [];
      state.log = [];
      state.session = null;
      state.mobile = '';
      state.status = 'need_number';
      state.message = 'Pehla mobile number daalo';
      logLine(`▶ START — target ${state.target} numbers (direct API, koi browser nahi)`);
      // Guard: is instance par pehle hi sab kuch fail ho chuka hai to naye
      // numbers jalaane ka koi matlab nahi — pehle Captcha test chalao.
      const dead = goldDropDeadEnd();
      if (dead) {
        state.status = 'blocked';
        state.message = 'Ruk gaya — pehle 🛡️ Captcha test chalao (security check ka kaaran pata chalega)';
        logLine('⛔ Security check pichhle run me site par hi reject hua tha — numbers bachaye gaye');
        sendJson(res, 200, { ok: true, blocked: true, deadEnd: dead.message });
        return;
      }
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/number') {
      const body = await readBody(req);
      if (state.status !== 'need_number') { sendJson(res, 400, { ok: false, message: 'Abhi number nahi chahiye' }); return; }
      const mobile = String(body.mobile || '').replace(/\D/g, '').slice(-10);
      if (!/^[6789]\d{9}$/.test(mobile)) { sendJson(res, 400, { ok: false, message: 'Valid 10-digit Indian mobile daalo' }); return; }
      sendJson(res, 200, { ok: true });
      processNumber(mobile); // background — UI /state se poll karta hai
      return;
    }
    if (req.method === 'POST' && url.pathname === '/otp') {
      const body = await readBody(req);
      if (state.status !== 'need_otp' || !state.session) { sendJson(res, 400, { ok: false, message: 'Abhi OTP nahi chahiye' }); return; }
      const otp = String(body.otp || '').replace(/\D/g, '');
      if (!/^\d{6}$/.test(otp)) { sendJson(res, 400, { ok: false, message: '6-digit OTP daalo' }); return; }
      sendJson(res, 200, { ok: true });
      processOtp(otp); // background
      return;
    }
    if (req.method === 'POST' && url.pathname === '/reset') {
      state.status = 'idle'; state.message = ''; state.session = null; state.mobile = '';
      state.details = null; state.results = []; state.log = []; state.count = 0;
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/otp-mirror') {
      const slot = Number(url.searchParams.get('slot'));
      const mirror = await readOtpBotMirror({
        slot: Number.isInteger(slot) && slot >= 0 ? slot : 0,
        botUsername: url.searchParams.get('bot') || '',
      });
      sendJson(res, 200, mirror);
      return;
    }
    // ── Spare Telegram account login (mirror ke liye session) ──
    if (req.method === 'GET' && url.pathname === '/tg-login/status') {
      sendJson(res, 200, {
        ok: true,
        apiReady: loginConfigured(),
        configured: telegramConfigured(),
        mirrorReady: telegramConfigured(),
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/tg-login/start') {
      const body = await readBody(req);
      sendJson(res, 200, await startTelegramLogin({ phone: body.phone }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/tg-login/code') {
      const body = await readBody(req);
      sendJson(res, 200, await submitTelegramCode({ loginId: body.loginId, code: body.code }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/tg-login/password') {
      const body = await readBody(req);
      sendJson(res, 200, await submitTelegramPassword({ loginId: body.loginId, password: body.password }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/tg-login/apply') {
      const body = await readBody(req);
      if (!body.session) { sendJson(res, 400, { ok: false, error: 'Session nahi mila — pehle login poora karo' }); return; }
      try {
        await setMirrorSession(String(body.session), { slot: 0 });
        sendJson(res, 200, {
          ok: true,
          message: 'Mirror chalu — permanent rakhne ke liye ye session Vercel env TELEGRAM_SESSION me daal do.',
        });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message || error) });
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/browser-mode') {
      const available = goldDropBrowserAvailable();
      sendJson(res, 200, {
        available,
        worker: findStealthWorker() ? 'mil gaya' : 'nahi mila',
        reason: available
          ? ''
          : (findStealthWorker()
            ? 'worker mila par Python deps/Chrome missing (seleniumbase, playwright)'
            : 'gold_drop_stealth.py nahi mila — Docker image me hona chahiye'),
      });
      return;
    }
    if (req.method === 'POST' && (url.pathname === '/nocap-balance' || url.pathname === '/captcha-test')) {
      // NoCaptchaAI v2 me balance endpoint nahi hai — key ko asli turnstile
      // task se test karte hain (asli address: $0.0005/solve wallet se).
      const body = await readBody(req);
      const diag = await goldDropCaptchaDiagnose(String(body.key || body.nocapKey || NOCAP_KEY_DEFAULT).trim());
      resetGoldDropDeadEnd();
      const count = (diag.sitekeys || []).length;
      sendJson(res, 200, {
        ok: Boolean(diag.keyOk && diag.sitekey),
        keyMasked: diag.keyMasked,
        keyOk: diag.keyOk,
        sitekey: diag.sitekey ? `${diag.sitekey.slice(0, 12)}…` : '',
        sitekeys: (diag.sitekeys || []).map(k => `${k.slice(0, 12)}…`),
        sitekeyError: diag.sitekeyError,
        message: `${diag.keyMessage}`
          + (count ? ` · ${count} sitekey mili (sab try hongi)` : ` · ${diag.sitekeyError || 'sitekey nahi mili'}`)
          + ' · guard reset — ab START kar sakte ho',
      });
      return;
    }
    sendJson(res, 404, { ok: false, message: 'Not found' });
  } catch (error) {
    sendJson(res, 500, { ok: false, message: String(error?.message || error).slice(0, 200) });
  }
}

// Local test / container (Docker CMD) ke liye: `node api/index.js`
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 3737);
  // 0.0.0.0 — container/preview proxy ke liye zaroori
  http.createServer(handler).listen(port, '0.0.0.0', () => console.log(`🟡 Gold Drop (Vercel build) local par: http://localhost:${port}`));
}
