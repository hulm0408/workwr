// 🟡 Gold Drop — VERCEL (direct API method, drop.py jaisa — koi browser nahi).
// Number apne OTP bot se laao, yahan daalo → register → OTP daalo → verify.
// Security check aaye to NoCaptchaAI se auto-solve. Sab Vercel par chalta hai.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { registerGoldDrop, verifyGoldDropOtp, goldDropCaptchaDiagnose, goldDropDeadEnd, resetGoldDropDeadEnd, goldDropProxyCheck, proxyInfo } from './_gold-drop.js';
import { goldDropBrowserAvailable, findStealthWorker } from './_gold-drop-browser.js';
import { readOtpBotMirror, telegramConfigured, setMirrorSession, readSlotCard, slotReady, apiFor } from './_otp-mirror.js';
import { startTelegramLogin, submitTelegramCode, submitTelegramPassword, loginConfigured } from './_telegram-login.js';
import { startClaimRun, getClaimRun, latestClaimRun, pushClaimNumber, pushClaimOtp } from './_claim.js';
import { storeConfigured, storeMasked } from './_kv.js';

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
.card{max-width:1080px;margin:0 auto;background:#181c2e;border:1px solid #2a3050;border-radius:14px;padding:20px}
h1{font-size:20px;margin:0 0 4px} .sub{color:#8a90ad;font-size:13px;margin-bottom:16px}
label{display:block;font-size:12px;color:#9aa1bd;margin:10px 0 4px}
input,button{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:9px;border:1px solid #2a3050;background:#0f1220;color:#e8eaf2;font-size:15px}
button{background:#f7b500;color:#191300;font-weight:700;border:none;cursor:pointer;margin-top:14px}
button.secondary{background:#232845;color:#e8eaf2}
.status{background:#10142a;border:1px solid #2a3050;border-radius:10px;padding:12px;margin-top:16px;font-size:14px;white-space:pre-wrap}
.log{background:#0a0c18;border-radius:10px;padding:10px;font:12px/1.5 monospace;color:#7d84a8;max-height:220px;overflow:auto;margin-top:12px;white-space:pre-wrap}
.row{display:flex;gap:10px}.row>div{flex:1}
.badge{display:inline-block;padding:2px 10px;border-radius:99px;background:#232845;font-size:12px}
.split{display:grid;grid-template-columns:minmax(300px,1fr) minmax(320px,1fr);gap:14px;align-items:start}
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

/* ─── 3+3 cards ─── */
.cards{display:grid;gap:10px}
.cardbox{background:#10142a;border:1px solid #232845;border-radius:12px;padding:10px}
.cardbox.live{border-color:#1f6b3a}
.cardbox .top{display:flex;align-items:center;justify-content:space-between;font-size:12.5px;font-weight:700;margin-bottom:6px}
.cardbox .mini{font-size:11.5px;color:#8a90ad;margin:2px 0}
.cardbox input{padding:7px 9px;font-size:13px;border-radius:7px;margin:3px 0}
.cardbox button{padding:7px 10px;font-size:12.5px;margin-top:6px;border-radius:8px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.chat{max-height:190px;overflow:auto;display:flex;flex-direction:column;gap:6px;margin-top:8px}
.chat .b{background:#161c33;border:1px solid #232845;border-radius:9px 9px 9px 3px;padding:6px 8px;font-size:11.5px;line-height:1.45;white-space:pre-wrap;word-break:break-word}
.chat .b.me{background:#1d2a1f;border-color:#2c5236;border-radius:9px 9px 3px 9px}
.chat .b small{display:block;color:#6f769a;font-size:10px;margin-top:3px}
.chat .empty{color:#6f769a;font-size:11.5px;text-align:center;padding:10px}
.pill{padding:1px 8px;border-radius:99px;background:#232845;font-size:10.5px;font-weight:600;color:#9aa1bd}
.pill.ok{background:#0d3b22;color:#7ee2a8}
.pill.bad{background:#3b1414;color:#ff9c9c}
.sec h2{font-size:13px;margin:0 0 8px;color:#f7b500;letter-spacing:.3px}
</style></head><body><div class="card">
<h1>🟡 Gold Drop + Claim</h1>
<div class="sub">3 Telegram account · 3 claim bot — sab ka mirror ek hi page par. <a href="/logout" style="color:#f7b500">Logout</a></div>
<div class="sub" id="browsermode" style="border:1px solid #2a3050;border-radius:9px;padding:10px;background:#10142a">Browser mode check ho raha hai…</div>
<div class="split">
<div class="sec">
  <h2>📱 Telegram accounts (session + bot mirror)</h2>
  <div class="cards" id="tgCards"></div>
</div>
<div class="sec">
  <h2>🎯 Claim bots — /start → Manual Claim → number → OTP ×3</h2>
  <div class="cards" id="claimCards"></div>
</div>
</div>
<div id="gdBox" style="display:none"></div>
<div id="setup">
  <div id="summary" style="font-size:12.5px;color:#8a90ad;line-height:1.6;margin:14px 0 10px">
    <b style="color:#e8eaf2">Gold Drop (alag flow)</b> — naam/email/PIN/batch/key sab pehle se set hain; bas ▶ START.
  </div>
  <button id="start">▶ START</button>
  <button class="secondary" id="advToggle" style="margin-top:8px">⚙️ Details badalni hain (optional)</button>
  <div id="adv" style="display:none;margin-top:10px">
    <label>Naam</label><input id="name" value="Rahul Kumar">
    <label>Email (Gmail — har number par +suffix apne aap)</label><input id="email" value="itsnoob012@gmail.com">
    <div class="row"><div><label>PIN code</label><input id="pincode" value="509412"></div>
    <div><label>Batch code</label><input id="code" value="KKD2LS01261026"></div></div>
    <label>NoCaptchaAI API key (security check auto-solve)</label><input id="nocapKey" value="${NOCAP_KEY_DEFAULT}">
    <div class="sub" id="nocapbal">NoCaptchaAI balance check ho raha hai…</div>
    <label>Pack photo (optional — na do to default use hogi)</label><input id="photo" type="file" accept="image/*">
    <label>Kitne numbers process karne hain?</label><input id="target" type="number" value="5" min="1" max="100">
    <button class="secondary" id="captchaTest">🛡️ Captcha test (key + proxy + sitekey)</button>
    <div class="sub" id="captchaOut"></div>
  </div>
</div>
<div id="run" style="display:none">
<div class="status"><span class="badge" id="st">…</span> <b id="prog"></b><div id="msg" style="margin-top:6px"></div></div>
<div id="askNumber" style="display:none"><label>Mobile number</label>
<input id="mobile" inputmode="numeric" maxlength="10" placeholder="9876543210"><button id="sendNumber">Number bhejo → Register karo</button></div>
<div id="askOtp" style="display:none"><label>OTP</label>
<input id="otp" inputmode="numeric" maxlength="6" placeholder="123456"><button id="sendOtp">OTP verify karo</button></div>
<button class="secondary" id="reset" style="margin-top:18px">■ Stop / Reset</button>
<div class="log" id="log"></div>
</div>
<div id="results" class="log" style="display:none"></div>
</div>
<script>
var pollTimer = null;
function $(id){return document.getElementById(id)}
function esc(t){ return String(t==null?'':t).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c] }) }
function post(url, body){return fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})}).then(function(r){return r.json()})}
function get(url){return fetch(url).then(function(r){return r.json()})}
function show(id,on){var e=$(id); if(e) e.style.display=on?'block':'none'}
function fmtTime(iso){ if(!iso) return ''; var d=new Date(iso); if(isNaN(d)) return ''; return d.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',second:'2-digit'}) }
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
function poll(){ get('/state').then(paint).catch(function(){}) }

// ═══ 3+3 cards ═══
var TC = {};   // slot → card state
var CR = {};   // slot → claim run state

function chatHtml(messages, me){
  if (!(messages||[]).length) return '<div class="empty">' + esc(me || 'abhi koi message nahi') + '</div>';
  return messages.map(function(x){
    var cls = 'b' + (x.kind === 'me' || x.kind === 'click' ? ' me' : '');
    return '<div class="' + cls + '">' + esc(x.text) + '<small>' + esc(x.kind || '') + ' · ' + fmtTime(x.at) + '</small></div>';
  }).join('');
}

function tgCardHtml(slot, c){
  c = c || {};
  var ready = !!c.ready, live = !!c.ok;
  var num = c.number || '', otp = c.otp || '';
  return '<div class="cardbox' + (live ? ' live' : '') + '" id="tgc' + slot + '">'
    + '<div class="top"><span><span class="dot' + (live ? ' live' : '') + '" style="display:inline-block;width:8px;height:8px;border-radius:99px;background:' + (live ? '#28c76f' : '#4a5070') + ';margin-right:6px"></span>Account #' + (slot+1) + '</span>'
    + '<span class="pill ' + (ready ? 'ok' : 'bad') + '">' + (ready ? 'ready' : 'adhoora') + '</span></div>'
    + '<div class="mini">API ID: <b>' + (c.apiIdSet ? (c.apiIdMasked || 'set') : '—') + '</b> · hash: <b>' + (c.apiHashSet ? 'set' : '—') + '</b> · session: <b>' + (c.sessionSet ? 'set' : '—') + '</b></div>'
    + '<div class="mini">Bot: <b>@' + esc(c.bot || 'Hathi_otp_bot') + '</b></div>'
    + '<div class="two"><input id="tgApi' + slot + '" placeholder="API ID (optional)" value="">'
    + '<input id="tgHash' + slot + '" placeholder="API hash (optional)"></div>'
    + '<input id="tgPhone' + slot + '" placeholder="+9198xxxxxxxx (spare account)">'
    + '<div class="two"><button class="secondary" id="tgCode' + slot + '">Code bhejo</button>'
    + '<button class="secondary" id="tgApply' + slot + '">Save session</button></div>'
    + '<input id="tgLogin' + slot + '" placeholder="Telegram login code">'
    + '<input id="tgOtp' + slot + '" placeholder="2FA password (agar ho)">'
    + '<div class="mini" id="tgOut' + slot + '"></div>'
    + '<div class="mini" id="tgNum' + slot + '">Number: <b>' + (num || '—') + '</b> · OTP: <b>' + (otp || '—') + '</b></div>'
    + '<div class="chat" id="tgChat' + slot + '">' + (live ? messagesHtml(c.messages) : '<div class="empty">' + esc(c.error || 'session chahiye — code bhejo') + '</div>') + '</div>'
    + '</div>';
}
function messagesHtml(msgs){
  if (!(msgs||[]).length) return '<div class="empty">bot me koi message nahi — NEW NUMBER dabao</div>';
  return msgs.map(function(x,i){
    var code = (String(x.text).match(/(?:^|\D)(\d{6})(?:\D|$)/)||[])[1];
    var body = esc(x.text);
    if (code) body = body.replace(code, '<span class="code" style="background:#0d3b22;color:#7ee2a8;border:1px solid #1f6b3a;border-radius:5px;padding:0 4px">'+code+'</span>');
    return '<div class="b">' + body + '<small>#' + (x.id||'') + ' · ' + fmtTime(x.at) + (i===0?' · latest':'') + '</small></div>';
  }).join('');
}

function claimCardHtml(slot, r){
  r = r || {};
  var running = !!r.running;
  return '<div class="cardbox' + (running ? ' live' : '') + '" id="clc' + slot + '">'
    + '<div class="top"><span>Claim bot #' + (slot+1) + '</span><span class="pill ' + (running ? 'ok' : '') + '">' + (r.phase || 'idle') + '</span></div>'
    + '<input id="clBot' + slot + '" placeholder="@rajafuckbot" value="' + esc(r.bot || 'rajafuckbot') + '">'
    + '<div class="two"><input id="clTarget' + slot + '" type="number" min="1" max="50" value="' + (r.target || 1) + '" placeholder="kitne claims">'
    + '<input id="clNumber' + slot + '" placeholder="number bhejo" inputmode="numeric"></div>'
    + '<div class="two"><input id="clOtp' + slot + '" placeholder="OTP bhejo" inputmode="numeric">'
    + '<button class="secondary" id="clStart' + slot + '">▶ START</button></div>'
    + '<div class="mini" id="clMsg' + slot + '">' + esc(r.message || 'START dabao — bot ko /start jayega, phir Manual Claim') + '</div>'
    + '<div class="mini" id="clCount' + slot + '">' + (r.done || 0) + '/' + (r.target || 1) + ' · step ' + (r.step || 0) + '/3</div>'
    + '<div class="chat" id="clChat' + slot + '">' + chatHtml(r.transcript, 'kuch nahi hua abhi') + '</div>'
    + '</div>';
}

function renderTg(){
  $('tgCards').innerHTML = [0,1,2].map(function(slot){ return tgCardHtml(slot, TC[slot]) }).join('');
  [0,1,2].forEach(bindTg);
}
function renderClaim(){
  $('claimCards').innerHTML = [0,1,2].map(function(slot){ return claimCardHtml(slot, CR[slot]) }).join('');
  [0,1,2].forEach(bindClaim);
}

function bindTg(slot){
  var codeBtn = $('tgCode' + slot);
  if (codeBtn) codeBtn.onclick = function(){
    $('tgOut' + slot).textContent = 'code bhej raha hoon…';
    post('/tg/code', { slot: slot, phone: $('tgPhone'+slot).value.trim(), apiId: $('tgApi'+slot).value.trim(), apiHash: $('tgHash'+slot).value.trim() })
      .then(function(r){
        if (r.ok) { $('tgOut'+slot).textContent = '✅ ' + (r.message||'code bhej diya') + (r.loginId ? ' (loginId ' + r.loginId.slice(0,6) + '…)' : ''); TC['login'+slot] = r.loginId; }
        else $('tgOut'+slot).textContent = '❌ ' + (r.error || 'fail');
      });
  };
  var applyBtn = $('tgApply' + slot);
  if (applyBtn) applyBtn.onclick = function(){
    var loginId = TC['login'+slot];
    var code = $('tgLogin'+slot).value.replace(/\D/g,'');
    var pass = $('tgOtp'+slot).value;
    var flow = code
      ? post('/tg/signin', { loginId: loginId, code: code, password: pass || undefined })
      : Promise.resolve({ ok: false, error: 'Login code daalo' });
    flow.then(function(r){
      if (r.ok && r.session) { $('tgOut'+slot).textContent = '✅ ' + (r.message || 'session set'); refreshCards(); }
      else if (r.ok && r.step === 'password') { $('tgOut'+slot).textContent = '🔐 ' + (r.message || '2FA password chahiye'); }
      else $('tgOut'+slot).textContent = '❌ ' + (r.error || r.message || 'fail');
    });
  };
}

function bindClaim(slot){
  var btn = $('clStart' + slot);
  if (!btn) return;
  btn.onclick = function(){
    var bot = $('clBot'+slot).value.trim().replace(/^@/,'');
    var target = Number($('clTarget'+slot).value) || 1;
    $('clMsg'+slot).textContent = 'START ho raha hai…';
    post('/claim/start', { slot: slot, bot: bot, target: target, useAccount: slot }).then(function(r){
      if (!r.ok) { $('clMsg'+slot).textContent = '❌ ' + (r.error || 'start fail'); return }
      CR[slot] = r.run; CR['id'+slot] = r.run.id; renderClaim();
    });
  };
  var numIn = $('clNumber' + slot);
  if (numIn) numIn.onkeydown = function(ev){ if (ev.key === 'Enter') sendNum(slot) };
  var numBtn = $('clNumber' + slot + 'Btn');
  var otpIn = $('clOtp' + slot);
  if (otpIn) otpIn.onkeydown = function(ev){ if (ev.key === 'Enter') sendOtp(slot) };
  function sendNum(s){
    var v = $('clNumber'+s).value.trim(); if (!v) return;
    post('/claim/number', { runId: CR['id'+s], number: v }).then(function(r){
      if (r.ok) { $('clNumber'+s).value = ''; $('clMsg'+s).textContent = '✅ number queue me: ' + r.queued }
      else $('clMsg'+s).textContent = '❌ ' + (r.error||'fail');
    });
  }
  function sendOtp(s){
    var v = $('clOtp'+s).value.trim(); if (!v) return;
    post('/claim/otp', { runId: CR['id'+s], otp: v }).then(function(r){
      if (r.ok) { $('clOtp'+s).value = ''; $('clMsg'+s).textContent = '✅ OTP queue me: ' + r.queued }
      else $('clMsg'+s).textContent = '❌ ' + (r.error||'fail');
    });
  }
  // number/otp input ke Enter handlers + chhote "bhejo" buttons
  var wrap = document.getElementById('clc'+slot);
  if (wrap && !wrap.dataset.bound){
    wrap.dataset.bound = '1';
    wrap.addEventListener('keydown', function(ev){
      if (ev.key !== 'Enter') return;
      if (ev.target.id === 'clNumber'+slot) { ev.preventDefault(); sendNum(slot); }
      if (ev.target.id === 'clOtp'+slot) { ev.preventDefault(); sendOtp(slot); }
    });
    var sendN = document.createElement('button');
    sendN.className = 'secondary'; sendN.textContent = '📱 number bhejo';
    sendN.onclick = function(){ sendNum(slot) };
    var sendO = document.createElement('button');
    sendO.className = 'secondary'; sendO.textContent = '🔑 OTP bhejo';
    sendO.onclick = function(){ sendOtp(slot) };
    var chatEl = document.getElementById('clChat'+slot);
    if (chatEl && chatEl.parentNode){
      var bar = document.createElement('div');
      bar.className = 'two'; bar.style.marginTop = '6px';
      bar.appendChild(sendN); bar.appendChild(sendO);
      chatEl.parentNode.insertBefore(bar, chatEl);
    }
  }
}

function refreshCards(){
  return get('/cards').then(function(d){
    (d.accounts||[]).forEach(function(a){ TC[a.slot] = a });
    (d.claims||[]).forEach(function(r){ if (r) { CR[r.slot] = r; CR['id'+r.slot] = r.id } });
    renderTg(); renderClaim();
  }).catch(function(){});
}

// Gold Drop START
$('advToggle').onclick = function(){
  var adv = $('adv');
  var open = adv.style.display !== 'none';
  adv.style.display = open ? 'none' : 'block';
  $('advToggle').textContent = open ? '⚙️ Details badalni hain (optional)' : '⚙️ Details chhupao';
};
$('start').onclick = function(){
  var file = $('photo').files[0];
  var body = { name:$('name').value.trim(), email:$('email').value, pincode:$('pincode').value, code:$('code').value, target:Number($('target').value)||1, nocapKey:$('nocapKey').value.trim() };
  var go = function(){
    post('/start', body).then(function(r){
      if(!r.ok){ alert(r.message||r.error||'Error'); return }
      show('setup',false); show('run',true); poll();
    });
  };
  if (file){
    var rd = new FileReader();
    rd.onload = function(){ body.photo = String(rd.result).split(',')[1]; go() };
    rd.readAsDataURL(file);
  } else go();
};
$('sendNumber').onclick = function(){ var m=$('mobile').value.replace(/\D/g,'').slice(-10); if(m.length!==10){alert('10-digit mobile daalo');return} $('mobile').value=''; post('/number',{mobile:m}).then(poll) };
$('sendOtp').onclick = function(){ var o=$('otp').value.replace(/\D/g,''); if(o.length!==6){alert('6-digit OTP daalo');return} $('otp').value=''; post('/otp',{otp:o}).then(poll) };
$('reset').onclick = function(){ post('/reset').then(function(){ location.reload() }) };
pollTimer = setInterval(poll, 1500);
poll(); refreshCards(); setInterval(refreshCards, 5000);

fetch('/browser-mode').then(function(r){return r.json()}).then(function(b){
  var el = $('browsermode');
  el.innerHTML = (b.available
    ? '✅ <b>Browser mode ON</b> — Gold Drop ka security check browser khud clear karega.'
    : '⚠️ <b>Browser mode OFF</b> — ' + esc(b.reason || 'Chrome/Python nahi mila'))
    + ' <span id="proxyLine"></span>';
}).catch(function(){});
post('/proxy-status', {}).then(function(p){
  var el = $('proxyLine'); if (!el || !p) return;
  el.innerHTML = p.on
    ? ' · 🌐 Proxy: <b>' + esc(p.ip || p.label || 'on') + '</b>' + (p.ok ? ' ✅' : ' ⚠️ ' + esc(p.message||''))
    : ' · <span style="color:#ffd479">⚠️ Proxy OFF — Vercel IP par Turnstile token reject hota hai; env GOLD_DROP_PROXY daalo</span>';
}).catch(function(){});

function captchaTest(){
  var btn = $('captchaTest');
  btn.disabled = true; var old = btn.textContent; btn.textContent = '🛡️ Test chal raha hai…';
  post('/captcha-test',{key:$('nocapKey').value.trim()}).then(function(r){
    btn.disabled = false; btn.textContent = old;
    var out = $('captchaOut');
    out.innerHTML = (r.ok?'✅ ':'❌ ') + esc(r.message||'');
    if (r.proxyMessage) out.innerHTML += '<br>🌐 ' + esc(r.proxyMessage);
    if (r.sitekeys && r.sitekeys.length) out.innerHTML += '<br>sitekeys: <code>' + r.sitekeys.join('</code>, <code>') + '</code>';
    $('nocapbal').textContent = r.keyMasked ? ('key: ' + r.keyMasked) : '';
  }).catch(function(){ btn.disabled = false; btn.textContent = old; });
}
$('captchaTest').onclick = captchaTest;
post('/nocap-balance',{key:$('nocapKey').value.trim()}).then(function(r){
  $('nocapbal').textContent = r.message || '';
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
    // ── 3+3 cards: accounts + claim bots ──
    if (req.method === 'GET' && url.pathname === '/cards') {
      const accounts = [];
      for (let slot = 0; slot < 3; slot += 1) {
        // eslint-disable-next-line no-await-in-loop
        accounts.push(await readSlotCard({ slot }));
      }
      const claims = [0, 1, 2].map(slot => latestClaimRun(slot));
      sendJson(res, 200, { ok: true, accounts, claims, storeReady: storeConfigured() });
      return;
    }
    // purana endpoint — ab slot support ke saath (compat)
    if (req.method === 'GET' && url.pathname === '/otp-mirror') {
      const slot = Number(url.searchParams.get('slot'));
      const mirror = await readOtpBotMirror({
        slot: Number.isInteger(slot) && slot >= 0 ? slot : 0,
        botUsername: url.searchParams.get('bot') || '',
      });
      sendJson(res, 200, mirror);
      return;
    }
    // Step 1 — login code us card ke apne API ID/hash se
    if (req.method === 'POST' && url.pathname === '/tg/code') {
      const body = await readBody(req);
      sendJson(res, 200, await startTelegramLogin({ slot: Number(body.slot) || 0, phone: body.phone, apiId: body.apiId, apiHash: body.apiHash }));
      return;
    }
    // Step 2 — code (+ 2FA) → session usi slot me live
    if (req.method === 'POST' && url.pathname === '/tg/signin') {
      const body = await readBody(req);
      let res1 = await submitTelegramCode({ loginId: body.loginId, code: body.code });
      if (res1.ok && res1.step === 'password' && body.password) {
        res1 = await submitTelegramPassword({ loginId: body.loginId, password: body.password });
      }
      sendJson(res, 200, res1);
      return;
    }
    // Fields se seedha save (session paste karne ka raasta)
    if (req.method === 'POST' && url.pathname === '/tg/save') {
      const body = await readBody(req);
      const slot = Number(body.slot) || 0;
      if (!body.session && !body.apiId && !body.apiHash) { sendJson(res, 400, { ok: false, error: 'Kuch bhi nahi mila — session ya API ID/hash daalo' }); return; }
      try {
        const { setSlotCredentials } = await import('./_otp-mirror.js');
        await setSlotCredentials({ slot, session: body.session || '', apiId: body.apiId || '', apiHash: body.apiHash || '' });
        sendJson(res, 200, { ok: true, slot, ready: slotReady(slot), stored: storeConfigured() });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message || error).slice(0, 200) });
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/tg/status') {
      sendJson(res, 200, {
        ok: true,
        slots: [0, 1, 2].map(slot => ({ slot, ready: slotReady(slot), api: apiFor(slot).source })),
        configured: telegramConfigured(),
        storeReady: storeConfigured(),
      });
      return;
    }
    // purane routes (compat)
    if (req.method === 'GET' && url.pathname === '/tg-login/status') {
      sendJson(res, 200, {
        ok: true,
        apiReady: loginConfigured(),
        configured: telegramConfigured(),
        slots: [0, 1, 2].map(slot => ({ slot, ready: slotReady(slot) })),
        proxyOn: proxyInfo().on,
        proxyLabel: proxyInfo().label,
        storeReady: storeConfigured(),
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/tg-login/start') {
      const body = await readBody(req);
      sendJson(res, 200, await startTelegramLogin({ slot: Number(body.slot) || 0, phone: body.phone }));
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
        await setMirrorSession(String(body.session), { slot: Number(body.slot) || 0 });
        sendJson(res, 200, { ok: true, stored: storeConfigured(), store: storeMasked(), message: 'Session lag gaya ✅' });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message || error) });
      }
      return;
    }
    // ── Claim bot (rajafuckbot): /start → Manual Claim → number → OTP ×3 ──
    if (req.method === 'POST' && url.pathname === '/claim/start') {
      const body = await readBody(req);
      const slot = Math.max(0, Math.min(2, Number(body.slot) || 0));
      const run = await startClaimRun({
        slot,
        bot: String(body.bot || 'rajafuckbot'),
        target: Number(body.target) || 1,
      });
      sendJson(res, 200, { ok: true, run });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/claim/state') {
      const id = url.searchParams.get('runId');
      sendJson(res, 200, { ok: true, run: id ? getClaimRun(id) : latestClaimRun(Number(url.searchParams.get('slot')) || 0) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/claim/number') {
      const body = await readBody(req);
      sendJson(res, 200, pushClaimNumber(body.runId, body.number));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/claim/otp') {
      const body = await readBody(req);
      sendJson(res, 200, pushClaimOtp(body.runId, body.otp));
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
