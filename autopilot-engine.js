// ===== 👑 AUTOPILOT ENGINE — ek START, apne aap poora batch =====
//
// Boss START dabata hai → engine pool se number uthata, processSingleNumber chalata,
// gap + backoff manage karta, STOP/time/target pe ruk jata hai — aur har stage ka
// status LIVE card par edit karta rehta hai. Boss60 minute baad aakar summary dekhta hai.
//
// Env knobs:
//   PREMIUM_BATCH_TARGET            — kitne fresh sessions (default 100)
//   PREMIUM_BATCH_CONCURRENCY       — ek saath kitne numbers/IP lanes (default 10, max 10)
//   PREMIUM_BATCH_MAX_MINUTES       — max run time (default 120)
//   PREMIUM_BATCH_GAP_MS            — do numbers ke beech gap (default 6000)
//   PREMIUM_RATE_LIMIT_BACKOFF_MS   — Swiggy rate-limit par ruk (default 15 min)
//   PREMIUM_ALLOW_OFFLINE_DEVICES   — '1' = offline devices bhi try karo
//   PREMIUM_OTP_WAIT_MS             — poll shuru karne se pehle wait (default 3000)
//   PREMIUM_OTP_TIMEOUT_MS          — inbox poll budget (default 90000)
//   PREMIUM_DEVICE_ACTIVE_WINDOW_MS — last-seen base window (default 60000, 0=off)
//   PREMIUM_DEVICE_SCAN_BUDGET_MS   — quick scan/refill ka hard budget (default 12000)
//
// Engine process-singleton hai: dono bots (main + autopilot) isi state ko dekhte hain.

import { isFirebaseConfigured, firebaseSetupHintLines, listPoolNumbers, scanFreshDevices } from './firebase-numbers.js';
import { applyActiveSource } from './firebase-sources.js';
import { getSetting } from './bot-settings.js';
import {
  processSingleNumber,
  freshEntriesFrom,
  preferOnline,
  isPhoneBlockedByPremiumLedger,
} from './number-pipeline.js';
import { getLiveSwiggyWafToken, runWithBridgeProxy, setBridgeProxy, getBridgeProxy, getChromeStatus } from './swiggy-bridge.js';
import * as wafPool from './waf-pool.js';
import * as proxyPool from './proxy-pool.js';
import { esc, section, sub, field } from './rich-text.js';

const envInt = (key, dflt) => {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
};

// Bridge ke active proxy ka id (rotate karne ke liye)
const getBridgeProxyId = () => getBridgeProxy()?.id || '';

export const MAX_AUTOPILOT_LANES = 10;

export function normalizeBatchConcurrency(value, fallback = MAX_AUTOPILOT_LANES) {
  const n = Number(value);
  const base = Number.isFinite(n) ? n : Number(fallback);
  if (!Number.isFinite(base)) return 1;
  return Math.min(MAX_AUTOPILOT_LANES, Math.max(1, Math.round(base)));
}

// Lane count asal distinct routes se zyada nahi ho sakta: proxy mode me
// enabled proxies + 1 direct route, aur direct-only mode me sirf 1.
// Cooling routes bhi count hoti hain kyunki run ke dauran free ho sakti
// hain; allocator unhe tab tak kisi lane ko nahi dega.
export function availableParallelLanes({
  requested = MAX_AUTOPILOT_LANES,
  proxyEnabled = false,
  enabledProxyCount = 0,
} = {}) {
  const want = normalizeBatchConcurrency(requested);
  if (!proxyEnabled) return 1;
  const routes = Math.max(1, (Number(enabledProxyCount) || 0) + 1);
  return Math.min(want, routes);
}

export function parallelWorkerUserId(baseUserId, laneId) {
  return `${String(baseUserId || 'autopilot')}:lane${Number(laneId) || 1}`;
}

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
  concurrency: 1,
  requestedConcurrency: 1,
  activeWorkers: 0,
  maxMinutes: 0,
  gapMs: 0,
  backoffMs: 0,
  processed: 0,
  fresh: 0,
  freshNew: 0,
  freshAfterDelete: 0,
  skipped: 0,
  deferred: 0,
  cooldownSkips: 0,       // 7-day extracted-number cooldown par roke gaye numbers
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
  current: null,          // backward-compat: pehli active lane ka { phone, startedAt }
  activeNumbers: [],      // parallel lanes: [{ phone, startedAt, laneId, proxyLabel }]
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
  scanBestActivityMs: 0,  // probed sample ki sabse taazi SMS activity (diagnostic)
  scanBestActivityAgeMs: 0, // scan ke waqt ki best SMS age (baad me khud na barhti rahe)
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
    concurrency: state.concurrency || 1,
    requestedConcurrency: state.requestedConcurrency || state.concurrency || 1,
    activeWorkers: state.activeWorkers || 0,
    maxMinutes: state.maxMinutes,
    processed: state.processed,
    fresh: state.fresh,
    freshNew: state.freshNew,
    freshAfterDelete: state.freshAfterDelete,
    skipped: state.skipped,
    deferred: state.deferred,
    cooldownSkips: state.cooldownSkips || 0,
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
    currentProxy: state.activeNumbers?.length
      ? state.activeNumbers.map((n) => n.proxyLabel || 'direct').join(', ')
      : (getBridgeProxy()?.label || ''),
    current: state.current ? { ...state.current } : null,
    activeNumbers: (state.activeNumbers || []).map((n) => ({ ...n })),
    poolTotal: state.poolTotal,
    poolFresh: state.poolFresh,
    scanning: Boolean(state.scanning),
    scanChecked: state.scanChecked || 0,
    scanTotalProbes: state.scanTotalProbes || state.scanChecked || 0,
    scanUniqueChecked: state.scanUniqueChecked || 0,
    scanTotalDevices: state.scanTotalDevices || 0,
    scanPass: state.scanPass || 1,
    scanWindowMs: state.scanWindowMs || 0,
    scanBestActivityMs: state.scanBestActivityMs || 0,
    scanBestActivityAgeMs: state.scanBestActivityAgeMs || 0,
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

// Ek security outcome asal me kis route par hua? Sirf outcome ke baad
// current bridge proxy dekhna kabhi-kabhi gumrah kar deta tha (bridge andar
// recovery me route badal sakta hai), phir proxy challenges 3 tak gine hi
// nahi jate thay aur card par 4th challenge par bhi "proxy rotate" aata
// rehta tha. Process shuru honay wali route episode ko authoritative rakho:
// direct-fallback episode hi direct hai; baqi proxy-enabled episode proxy.
export function securityChallengeRouteKind({
  proxyEnabled = false,
  routeModeAtStart = 'direct',
  proxyIdAtStart = '',
  finalProxyId = '',
} = {}) {
  if (!proxyEnabled) return 'direct';
  if (routeModeAtStart === 'direct-fallback' && !proxyIdAtStart && !finalProxyId) return 'direct';
  return 'proxy';
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
    field('⚠️ Skipped', `${state.skipped} · deferred: ${state.deferred} · ⏳ 7-day cooldown: ${state.cooldownSkips || 0} · 📴 stale devices: ${state.staleSkips || 0}`),
    field('× Failed', `${state.failed} · aborted: ${state.aborted} · rate-limit: ${state.rateStrikes}`),
    (state.wafCooldowns || state.wafStrikes || state.proxyRotations)
      ? field('🛡 WAF', `${state.wafCooldowns} cooldown · challenges: ${state.wafStrikes} · rotations: ${state.proxyRotations} · token-ready: ${pSummary?.tokenReadyCount || 0} · solve-cooling: ${pSummary?.solveCoolingCount || 0}`)
      : '',
    state.serverErrors
      ? field('↻ Swiggy 5xx', `${state.serverErrors} temporary · numbers failed nahi, retry queue me`)
      : '',
    field('⚡ Parallel lanes', `${state.activeWorkers || 0}/${state.concurrency || 1} active${state.requestedConcurrency > state.concurrency ? ` (maangi ${state.requestedConcurrency}, distinct IPs sirf ${state.concurrency})` : ''}`),
    pSummary?.enabled
      ? field('🔀 Proxy', state.routeMode === 'direct-fallback' && (state.concurrency || 1) <= 1
          ? `DIRECT fallback (Render IP)  ·  ${pSummary.usableCount ?? pSummary.enabledCount}/${pSummary.enabledCount} free usable · lanes me ${pSummary.reservedCount || 0} · cooling ${pSummary.wafCoolingCount || 0}  ·  rotates: ${state.proxyRotations}`
          : (state.concurrency || 1) > 1
            ? `Har lane alag IP par  ·  ${pSummary.usableCount ?? pSummary.enabledCount}/${pSummary.enabledCount} free usable · lanes me ${pSummary.reservedCount || 0} · cooling ${pSummary.wafCoolingCount || 0}  ·  rotates: ${state.proxyRotations}`
            : `${state.activeNumbers?.[0]?.proxyLabel || getBridgeProxy()?.label || '—'}  ·  ${pSummary.usableCount ?? pSummary.enabledCount}/${pSummary.enabledCount} free usable · lanes me ${pSummary.reservedCount || 0} · cooling ${pSummary.wafCoolingCount || 0}  ·  rotates: ${state.proxyRotations}`)
      : field('🔀 Proxy', 'OFF (ek hi IP — ⚙️ Settings me add karo)'),
    field('Pool', state.poolTotal
      ? `${state.poolFresh} fresh / ${state.poolTotal} numbers`
      : 'load ho raha hai…'),
    (state.scanning || state.scanChecked)
      ? field('🔎 Device scan', `pass ${state.scanPass || 1}: ${state.scanUniqueChecked || 0}/${state.scanTotalDevices || 0} unique check · total probes ${state.scanTotalProbes || state.scanChecked || 0} · window ≤${fmtDuration(state.scanWindowMs || 0)} · ${state.scanBestActivityMs ? `scan ke waqt best SMS ~${fmtDuration(state.scanBestActivityAgeMs || Math.max(0, Date.now() - state.scanBestActivityMs))} purani · ` : ''}${state.scanFresh || 0} fresh ready${state.scanning ? ' · scanning…' : ''}`)
      : '',
    state.activeNumbers?.length
      ? `📍 <b>Abhi ${state.activeNumbers.length} lane(s):</b>\n${state.activeNumbers.slice(0, 10).map((n) => `• <code>${esc(n.phone)}</code> · lane ${n.laneId || '?'} · ${esc(n.proxyLabel || 'direct')} (${fmtDuration(Date.now() - n.startedAt)})`).join('\n')}`
      : state.current
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
        `2️⃣ <b>Parallel lanes</b> — alag numbers, alag IPs par Swiggy OTP → live inbox poll`,
        `3️⃣ 🆕 naya = register · ♻️ purana = delete → fresh login`,
        `4️⃣ charges/order/wallet block = <b>skip</b> · rate-limit = <b>backoff</b>`,
        ``,
        field('Target', `${state.target || envInt('PREMIUM_BATCH_TARGET', 100)} fresh sessions`),
        field('Parallel', `${state.concurrency || envInt('PREMIUM_BATCH_CONCURRENCY', 10)} lanes tak`),
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
    security_challenge: '🛡 Bahut lagatar security challenges — routes abhi Swiggy ke liye flagged lag rahe hain. Kuch der baad, ya behtar proxies ke saath, dobara start karein.',
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

// Parallel lanes ek hi Telegram message ko edit karti hain. Saari stage
// reports ko serialize + coalesce karo: sab se latest card hi jayegi,
// process OTP flow Telegram network ka wait nahi karega, aur flood-limit
// bhi nahi lagegi. Final summary force=true ke saath pakka flush hoti hai.
const UI_PUSH_MIN_INTERVAL_MS = 1_200;
let uiPushInFlight = false;
let pendingUiPush = null;
let uiPushTimer = null;
let lastUiPushAt = 0;

async function flushUiPush() {
  if (uiPushInFlight || !pendingUiPush || !ui || typeof ui.update !== 'function') return;
  if (uiPushTimer) { clearTimeout(uiPushTimer); uiPushTimer = null; }
  const item = pendingUiPush;
  pendingUiPush = null;
  uiPushInFlight = true;
  try {
    await ui.update(item.text, kb(item.rows));
  } catch (e) {
    console.warn('[Autopilot] ui:', e?.message);
  } finally {
    uiPushInFlight = false;
    lastUiPushAt = Date.now();
    if (pendingUiPush) scheduleUiPush(UI_PUSH_MIN_INTERVAL_MS);
  }
}

function scheduleUiPush(delayMs = 0) {
  if (uiPushTimer || uiPushInFlight) return;
  uiPushTimer = setTimeout(() => {
    uiPushTimer = null;
    void flushUiPush();
  }, Math.max(0, delayMs));
  if (typeof uiPushTimer.unref === 'function') uiPushTimer.unref();
}

async function push(text, rows, { force = false } = {}) {
  if (!ui || typeof ui.update !== 'function') return;
  pendingUiPush = { text, rows };
  if (force) {
    if (uiPushTimer) { clearTimeout(uiPushTimer); uiPushTimer = null; }
    while (uiPushInFlight) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await flushUiPush();
    return;
  }
  const waitMs = UI_PUSH_MIN_INTERVAL_MS - (Date.now() - lastUiPushAt);
  if (waitMs <= 0) void flushUiPush();
  else scheduleUiPush(waitMs);
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
  const requestedConcurrency = normalizeBatchConcurrency(
    opts.concurrency ?? s('concurrency', envInt('PREMIUM_BATCH_CONCURRENCY', MAX_AUTOPILOT_LANES))
  );
  const maxMinutes = Number(opts.maxMinutes || s('maxMinutes', envInt('PREMIUM_BATCH_MAX_MINUTES', 120)));
  const gapMs = Number.isFinite(Number(opts.gapMs)) && Number(opts.gapMs) >= 0
    ? Number(opts.gapMs)
    : s('gapMs', envInt('PREMIUM_BATCH_GAP_MS', 6_000));
  const backoffMs = s('backoffMs', envInt('PREMIUM_RATE_LIMIT_BACKOFF_MS', 15 * 60_000));
  const allowOffline = s('allowOffline', String(process.env.PREMIUM_ALLOW_OFFLINE_DEVICES || '') === '1') === true;
  // Ek refill me device scan ka hard time budget. Iske baad full pool ka
  // intezaar nahi: probed sample ka sabse taaza SMS device, warna Firebase
  // clients me ONLINE device process hoga. 0 = purana unbounded scan.
  const deviceScanBudgetMs = envInt('PREMIUM_DEVICE_SCAN_BUDGET_MS', 12_000);
  const otpCfg = {
    waitMs: s('otpWaitMs', envInt('PREMIUM_OTP_WAIT_MS', 3_000)),
    timeoutMs: s('otpTimeoutMs', envInt('PREMIUM_OTP_TIMEOUT_MS', 90_000)),
    pollMs: 1_500,
    acceptAnyAfterMs: 15_000,
    // Device last-seen gate ki BASE window. Default 60s; Render env me
    // PREMIUM_DEVICE_ACTIVE_WINDOW_MS=10000 ho to pehle 10s try hoga.
    // Scanner/pipeline ladder use double karke aage badhta hai jab tak
    // sabse taaza available device andar na aa jaye (0 = gate off).
    activeWindowMs: envInt('PREMIUM_DEVICE_ACTIVE_WINDOW_MS', 60_000),
    widenLastSeenByDoubling: true,
  };

  ui = opts.ui && typeof opts.ui.update === 'function' ? opts.ui : ui;

  // Reset state (snapshot purana summary ke liye reh sakta hai — naya run naya object)
  Object.assign(state, {
    running: true, stopRequested: false, stopReason: '',
    startedAt: Date.now(), finishedAt: 0,
    target, maxMinutes, gapMs, backoffMs,
    concurrency: requestedConcurrency, requestedConcurrency, activeWorkers: 0,
    processed: 0, fresh: 0, freshNew: 0, freshAfterDelete: 0,
    skipped: 0, deferred: 0, cooldownSkips: 0, staleSkips: 0, failed: 0, aborted: 0,
    rateStrikes: 0, wafStrikes: 0, wafCooldowns: 0, serverErrors: 0, transientStrikes: 0,
    consecutiveFails: 0, proxyRotations: 0,
    routeMode: 'direct', proxyChallenges: 0, directChallenges: 0, deferredQueue: 0,
    current: null, activeNumbers: [], history: [], freshAccounts: [], lastError: '',
    poolTotal: 0, poolFresh: 0,
    scanning: false, scanChecked: 0, scanTotalProbes: 0,
    scanUniqueChecked: 0, scanTotalDevices: 0, scanPass: 1,
    scanWindowMs: Number(otpCfg.activeWindowMs) || 0, scanBestActivityMs: 0, scanBestActivityAgeMs: 0, scanFresh: 0,
  });
  // Pichhli run kisi fatal par ruki ho to stale lane reservations nayi
  // run ki saari IPs ko block na kar dein.
  try { proxyPool._clearProxyReservations(); } catch {}

  const userId = opts.userId || 'autopilot';
  let endReason = 'target';

  const tally = (res) => {
    // WAF cooldown = number bilkul untouched (sirf wait hui) — count me mat lo,
    // warna summary jhootha dikhega.
    if (res.kind === 'waf_cooldown') return 'waf_cooldown';

    // 7-day extracted-number cooldown — number pehle hi extract/send ho
    // chuka hai. OTP gaya hi nahi, isliye processed/failed me mat gino.
    if (res.kind === 'deferred_number_cooldown') {
      state.cooldownSkips = (state.cooldownSkips || 0) + 1;
      return 'number_cooldown';
    }

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
      `⚡ Parallel lanes: ${requestedConcurrency} tak — har lane alag number + alag IP legi.`,
      '📋 Saath hi pool load + zinda devices ki parallel scan chal rahi hai…',
      sub('Sab ready hote hi lanes ke pehle OTP fresh devices par jayenge.'),
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
        const r = await proxyPool.ensureFreeProxies({ min: requestedConcurrency, want: Math.max(10, requestedConcurrency) });
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
      state.deferredQueue = retryLater.length;
      console.log(`[Autopilot] Deferred (${why}): ${entry.phone} — will retry in this run.`);
    };
    const removeRetryLaterPhone = (phone) => {
      if (!phone) return;
      for (let i = retryLater.length - 1; i >= 0; i--) {
        if (retryLater[i]?.entry?.phone === phone) retryLater.splice(i, 1);
      }
      state.deferredQueue = retryLater.length;
    };

    // Parallel claim coordination. Selection ek mutex ke andar hogi aur
    // picked phone + deviceId foran active locks me aa jayega — warna do
    // lanes ek hi number, ya ek hi device ki do SIMs, ek saath utha kar
    // ek hi inbox par OTP ambiguity bana sakti hain.
    const activePhones = new Set();
    const activeDeviceIds = new Set();
    const activeByLane = new Map(); // laneId -> activeNumbers item
    const isEntryActive = (entry) => Boolean(
      entry?.phone && (activePhones.has(entry.phone) || (entry.deviceId && activeDeviceIds.has(entry.deviceId)))
    );
    const claimPickedEntry = (entry) => {
      if (!entry?.phone || isEntryActive(entry)) return false;
      activePhones.add(entry.phone);
      if (entry.deviceId) activeDeviceIds.add(entry.deviceId);
      return true;
    };
    const releaseClaimedEntry = (entry) => {
      if (!entry?.phone) return;
      activePhones.delete(entry.phone);
      if (entry.deviceId) activeDeviceIds.delete(entry.deviceId);
    };
    const syncActiveNumbers = () => {
      state.activeNumbers = [...activeByLane.values()].sort((a, b) => (a.laneId || 0) - (b.laneId || 0));
      state.activeWorkers = state.activeNumbers.length;
      state.current = state.activeNumbers[0] ? { ...state.activeNumbers[0] } : null;
    };
    let claimTail = Promise.resolve();
    const withClaimLock = async (fn) => {
      const previous = claimTail.catch(() => {});
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      claimTail = previous.then(() => gate);
      await previous;
      try { return await fn(); } finally { release(); }
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
    // Is run me extract/send ho chuke numbers — ledger ke ilawa in-memory
    // hard stop, taaki koi purani hot/retry queue entry inhe dobara na uthaye.
    const extractedThisRun = new Set();
    // WAF/security/rate-limit/transient jaise infra outcomes par bhi ek hi
    // number ko is run me max 2 attempts. Pehle har category ka alag (ya
    // bilkul nahi) cap tha, isliye ek number WAF storm me baar-baar ghoom
    // sakta tha aur throughput usi par jal jati thi.
    const infraAttemptsThisRun = new Map(); // phone → count
    const infraCappedThisRun = new Set();
    const underInfraCap = (e) => !infraCappedThisRun.has(e.phone);
    const recordInfraAttempt = (phone) => {
      if (!phone) return { attempt: 0, willRetry: false };
      const attempt = (infraAttemptsThisRun.get(phone) || 0) + 1;
      infraAttemptsThisRun.set(phone, attempt);
      const willRetry = attempt < 2;
      if (!willRetry) {
        infraCappedThisRun.add(phone);
        removeRetryLaterPhone(phone);
      }
      return { attempt, willRetry };
    };
    // Isi run me jo devices last-seen gate par stale nikle — dobara-dobara
    // unhi ko probe na karo. "Fresh device ka wait" round me clear hota hai
    // (device beech me zinda ho sakta hai).
    const staleThisRun = new Set(); // phone
    let freshWaitRounds = 0;
    const pickFreshList = () => {
      let list = preferOnline(freshEntriesFrom(pool))
        .filter(underFailCap)
        .filter(underTransientCap)
        .filter(underInfraCap)
        .filter((e) => !extractedThisRun.has(e.phone))
        .filter((e) => !staleThisRun.has(e.phone))
        .filter((e) => !isEntryActive(e));
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
      for (let i = 0; i < hotQueue.length;) {
        const h = hotQueue[i];
        const entry = h?.entry;
        if (!entry?.phone) { hotQueue.splice(i, 1); continue; }
        // Dusri lane isi phone/device par hai — entry queue me rehne do,
        // taaki us device ki doosri SIM baad me safely try ho sake.
        if (isEntryActive(entry)) { i++; continue; }
        if (
          staleThisRun.has(entry.phone) ||
          extractedThisRun.has(entry.phone) ||
          !underFailCap(entry) ||
          !underTransientCap(entry) ||
          !underInfraCap(entry)
        ) { hotQueue.splice(i, 1); continue; }
        // Sirf "ledger me entry hai" kafi nahi: success 7 din baad eligible
        // hai, aur 7 din ke andar saved-session fallback bhi block karta hai.
        if (isPhoneBlockedByPremiumLedger(entry.phone)) { hotQueue.splice(i, 1); continue; }
        hotQueue.splice(i, 1);
        state.scanFresh = hotQueue.length;
        return h;
      }
      state.scanFresh = hotQueue.length;
      return null;
    };
    const purgeQueuedPhone = (phone) => {
      if (!phone) return;
      removeRetryLaterPhone(phone);
      for (let i = hotQueue.length - 1; i >= 0; i--) {
        if (hotQueue[i]?.entry?.phone === phone) hotQueue.splice(i, 1);
      }
      state.scanFresh = hotQueue.length;
    };
    // Retry queue se direct shift karna purana repeat-bug tha: ek number
    // pehle WAF par defer hua, phir hot queue se process hokar JSON ban
    // gaya, aur baad me uski purani retry entry use dobara utha leti thi.
    // Ab retry pick par wohi saare gates dobara check hotay hain.
    const takeRetryLater = () => {
      for (let i = 0; i < retryLater.length;) {
        const r = retryLater[i];
        const entry = r?.entry;
        if (!entry?.phone) { retryLater.splice(i, 1); continue; }
        if (isEntryActive(entry)) { i++; continue; }
        if (
          staleThisRun.has(entry.phone) ||
          extractedThisRun.has(entry.phone) ||
          !underFailCap(entry) ||
          !underTransientCap(entry) ||
          !underInfraCap(entry) ||
          isPhoneBlockedByPremiumLedger(entry.phone)
        ) { retryLater.splice(i, 1); continue; }
        retryLater.splice(i, 1);
        state.deferredQueue = retryLater.length;
        return { entry, lastActivityMs: 0, windowMs: Number(otpCfg.activeWindowMs) || 0 };
      }
      state.deferredQueue = retryLater.length;
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
      state.scanBestActivityMs = 0;
      state.scanBestActivityAgeMs = 0;
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
          want: Math.max(Number(otpCfg.activeWindowMs) <= 15_000 ? 1 : 3, requestedConcurrency),
          // Ek hi device par poora pass zaya na karo. Sabse taaza ranked
          // backups bhi queue me rakho — pehla stale/fail ho to agla cached
          // device turant milega, naya Firebase pass nahi ghumega. Parallel
          // lanes ko khilane ke liye kam az kam do guna lane-count backups.
          backupCount: Math.max(12, requestedConcurrency * 2),
          // Full pass ke khatam hone ka intezaar hi purani susti thi. Har
          // 4s scan ke baad agli ladder window probed-so-far devices par
          // khul jati hai (≤20s, phir ≤40s, ≤80s...). 12s ka hard budget
          // khatam ho to probed sample ka sabse taaza device, aur SMS
          // timestamp hi na ho to clients ONLINE device, process hoga.
          earlyWidenStepMs: 4_000,
          maxScanMs: deviceScanBudgetMs,
          onlineFallback: true,
          chunkSize: 80, maxProbe: Math.max(800, candidates.length), concurrency: 48,
          shouldAbort: () => state.stopRequested,
          onProgress: ({ checked, freshCount, allowedWindowMs, bestLastActivityMs }) => {
            state.scanUniqueChecked = Math.min(
              passDeviceIds.size,
              baseUniqueChecked + checked
            );
            state.scanTotalProbes = baseTotalProbes + checked;
            state.scanChecked = state.scanTotalProbes;
            state.scanWindowMs = Number(allowedWindowMs) || Number(otpCfg.activeWindowMs) || 0;
            state.scanBestActivityMs = Number(bestLastActivityMs) || 0;
            state.scanFresh = hotQueue.length + freshCount;
            const now = Date.now();
            state.scanBestActivityAgeMs = state.scanBestActivityMs
              ? Math.max(0, now - state.scanBestActivityMs)
              : 0;
            if (now - lastPushAt >= 4000) {
              lastPushAt = now;
              const bestLine = state.scanBestActivityMs
                ? `› Ab tak sabse taazi SMS activity: ~${fmtDuration(now - state.scanBestActivityMs)} purani.`
                : '› Ab tak kisi probed device ki SMS activity timestamp nahi mili.';
              const budgetLine = deviceScanBudgetMs > 0
                ? `Quick scan max ${fmtDuration(deviceScanBudgetMs)} chalegi. Taaza SMS na mili to full ${state.scanTotalDevices} devices ka wait nahi hoga — probed sample ke sabse taaza / Firebase ONLINE device ko process karunga.`
                : 'Candidate milte hi scan ruk kar number process hoga; 12 ranked backups bhi queue me rahenge.';
              void push(progressCard(section('🔎 Zinda Devices Dhoondh Raha Hoon', [
                `› Pass ${state.scanPass || 1}: <b>${state.scanUniqueChecked}/${state.scanTotalDevices}</b> unique devices check hue — base window me <b>${freshCount}</b> fresh; current ladder ≤${fmtDuration(state.scanWindowMs)}.`,
                bestLine,
                `› Total probes: ${state.scanTotalProbes} (repeated passes sameet — ye unique devices ki ginti nahi hai).`,
                sub(budgetLine),
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
            onlineFallback: Boolean(f.onlineFallback),
            selectionSource: f.selectionSource || '',
            checkedAt: at,
          });
        }
        state.scanTotalProbes = baseTotalProbes + (r.checked || 0);
        state.scanChecked = state.scanTotalProbes;
        state.scanUniqueChecked = [...probedDevices].filter((id) => passDeviceIds.has(id)).length;
        state.scanWindowMs = Number(r.fresh?.[0]?.windowMs) || Number(r.widestWindowMs) || Number(otpCfg.activeWindowMs) || 0;
        state.scanBestActivityMs = Number(r.bestLastActivityMs) || Number(r.fresh?.[0]?.lastActivityMs) || 0;
        state.scanBestActivityAgeMs = state.scanBestActivityMs
          ? Math.max(0, at - state.scanBestActivityMs)
          : 0;
        state.scanFresh = hotQueue.length;
        if (r.onlineFallback && r.fresh.length) {
          console.log(`[Autopilot] Scan: quick-scan me usable taaza SMS timestamp nahi mila — Firebase clients ONLINE device process hoga (checked ${r.checked}/${passDeviceIds.size}, timedOut=${Boolean(r.scanTimedOut)}).`);
        } else if (r.widened && r.fresh.length) {
          const ageMs = Math.max(0, at - (Number(r.fresh[0].lastActivityMs) || at));
          console.log(`[Autopilot] Scan: base window ≤${fmtDuration(otpCfg.activeWindowMs)} me koi nahi — ${r.scanTimedOut ? 'quick-scan sample' : 'isi cached pass'} se sabse taaza device liya (activity ~${fmtDuration(ageMs)} purani, ladder ≤${fmtDuration(state.scanWindowMs)}, checked ${r.checked}/${passDeviceIds.size}).`);
        }
        return r;
      } finally {
        state.scanning = false;
        state.scanFresh = hotQueue.length;
      }
    };

    // ---- ⚡ Parallel lanes: route allocator + claim coordination ----
    let lanes = [];
    let laneCount = 1;
    let runEndRequested = false;
    const activeRouteKeys = new Set();
    const routeChangeWaiters = new Set();
    const notifyRouteChanged = () => {
      for (const resolve of [...routeChangeWaiters]) resolve();
      routeChangeWaiters.clear();
    };
    const waitForRouteChange = async (ms = 1_000) => {
      if (state.stopRequested) return;
      let resolveRouteChange;
      const routeChanged = new Promise((resolve) => { resolveRouteChange = resolve; });
      routeChangeWaiters.add(resolveRouteChange);
      try {
        await Promise.race([routeChanged, sleep(ms, () => state.stopRequested)]);
      } finally {
        routeChangeWaiters.delete(resolveRouteChange);
      }
    };
    const requestRunEnd = (reason) => {
      if (!runEndRequested) {
        runEndRequested = true;
        endReason = reason;
      }
      state.stopRequested = true;
      if (!state.stopReason) state.stopReason = endReason;
      notifyRouteChanged();
    };
    const syncRouteSummaryState = () => {
      const modes = lanes.map((lane) => lane.routeMode).filter((m) => m && m !== 'unassigned');
      if (!modes.length) return;
      const hasProxy = modes.includes('proxy');
      const hasDirect = modes.some((m) => m === 'direct' || m === 'direct-fallback');
      state.routeMode = hasProxy && hasDirect
        ? 'parallel'
        : hasProxy
          ? 'proxy'
          : (ps.enabled ? 'direct-fallback' : 'direct');
    };
    const laneProxyUsable = (lane) => {
      if (!lane?.proxy?.id) return false;
      try {
        const info = proxyPool.getProxy(lane.proxy.id);
        if (!info?.enabled) return false;
        const route = proxyPool.getProxyRouteState(lane.proxy.id);
        return (route.cooldownLeftMs || 0) <= 5_000 && (route.consecutiveErrors || 0) < 3;
      } catch { return false; }
    };
    const releaseLaneRoute = (lane) => {
      if (!lane) return;
      if (lane.routeKey) activeRouteKeys.delete(lane.routeKey);
      if (lane.owner) {
        try { proxyPool.releaseProxyReservationsForOwner(lane.owner); } catch {}
      }
      lane.proxy = null;
      lane.routeKey = '';
      lane.routeMode = 'unassigned';
      syncRouteSummaryState();
      notifyRouteChanged();
    };
    const setLaneProxy = (lane, proxy) => {
      if (!proxy?.id) return false;
      if (lane.routeKey && lane.routeKey !== `proxy:${proxy.id}`) activeRouteKeys.delete(lane.routeKey);
      if (lane.proxy?.id && lane.proxy.id !== proxy.id) {
        try { proxyPool.releaseProxyReservation(lane.proxy.id, lane.owner); } catch {}
      }
      lane.proxy = proxy;
      lane.routeKey = `proxy:${proxy.id}`;
      lane.routeMode = 'proxy';
      activeRouteKeys.add(lane.routeKey);
      syncRouteSummaryState();
      return true;
    };
    const claimLaneDirect = (lane) => {
      if (lane.routeKey === 'direct') return true;
      if (activeRouteKeys.has('direct')) return false;
      if (lane.routeKey) activeRouteKeys.delete(lane.routeKey);
      if (lane.proxy?.id) {
        try { proxyPool.releaseProxyReservation(lane.proxy.id, lane.owner); } catch {}
      }
      lane.proxy = null;
      lane.routeKey = 'direct';
      lane.routeMode = ps.enabled ? 'direct-fallback' : 'direct';
      activeRouteKeys.add('direct');
      syncRouteSummaryState();
      return true;
    };
    const rotateLaneProxy = (lane, excludeId = '', { countRotation = false } = {}) => {
      if (!proxyPool.isEnabled()) return null;
      const beforeId = lane.proxy?.id || '';
      const exclusions = [beforeId, excludeId].filter(Boolean);
      const next = proxyPool.pickProxy({
        ...(exclusions.length ? { excludeIds: [...new Set(exclusions)] } : {}),
        reserveFor: lane.owner,
      });
      if (!next) return null;
      setLaneProxy(lane, next);
      if (countRotation && beforeId && next.id !== beforeId) {
        state.proxyRotations = (state.proxyRotations || 0) + 1;
      }
      console.log(`[Autopilot] Lane ${lane.id} proxy → ${next.label}`);
      notifyRouteChanged();
      return next;
    };
    const ensureLaneRoute = (lane) => {
      if (lane.routeKey === 'direct') return true;
      if (lane.proxy?.id) {
        if (laneProxyUsable(lane)) {
          lane.routeKey = `proxy:${lane.proxy.id}`;
          lane.routeMode = 'proxy';
          activeRouteKeys.add(lane.routeKey);
          return true;
        }
        releaseLaneRoute(lane);
      }
      if (proxyPool.isEnabled()) {
        const next = proxyPool.pickProxy({ reserveFor: lane.owner });
        if (next) {
          setLaneProxy(lane, next);
          console.log(`[Autopilot] Lane ${lane.id} route → ${next.label}`);
          return true;
        }
      }
      return claimLaneDirect(lane);
    };
    const syncLaneRouteAfterProcess = (lane, finalProxy) => {
      const oldKey = lane.routeKey;
      if (oldKey) activeRouteKeys.delete(oldKey);
      if (finalProxy?.id) {
        lane.proxy = finalProxy;
        lane.routeKey = `proxy:${finalProxy.id}`;
        lane.routeMode = 'proxy';
        activeRouteKeys.add(lane.routeKey);
        try { proxyPool.reserveProxy(finalProxy.id, lane.owner); } catch {}
      } else if (!activeRouteKeys.has('direct') || oldKey === 'direct') {
        lane.proxy = null;
        lane.routeKey = 'direct';
        lane.routeMode = ps.enabled ? 'direct-fallback' : 'direct';
        activeRouteKeys.add('direct');
      } else {
        lane.proxy = null;
        lane.routeKey = '';
        lane.routeMode = 'unassigned';
      }
      syncRouteSummaryState();
    };
    const setLaneCurrent = (lane, entry) => {
      if (entry) {
        activeByLane.set(lane.id, {
          phone: entry.phone,
          startedAt: Date.now(),
          laneId: lane.id,
          proxyLabel: lane.proxy?.label || (lane.routeKey === 'direct' ? 'direct' : '—'),
          proxyId: lane.proxy?.id || '',
          routeMode: lane.routeMode || 'direct',
        });
      } else {
        activeByLane.delete(lane.id);
      }
      syncActiveNumbers();
    };
    const solveLaneToken = async (lane, force = false) => {
      try {
        return await runWithBridgeProxy(
          lane.proxy || null,
          () => getLiveSwiggyWafToken(force, { solveBudgetMs: 25_000 }),
          { owner: lane.owner, releaseOnExit: false }
        );
      } catch { return ''; }
    };

    let freshWaitUntil = 0;
    const claimNextPick = () => withClaimLock(async () => {
      if (state.stopRequested) return { status: 'stopped' };
      if (state.fresh >= target) return { status: 'target' };
      if (state.fresh + activePhones.size >= target) return { status: 'waiting', waitMs: 500 };
      state.poolFresh = freshEntriesFrom(pool).length;
      let picked = takeFromHotQueue();

      if (!picked && gateOn && Date.now() < freshWaitUntil) {
        picked = takeRetryLater();
        if (!picked) return { status: 'waiting', waitMs: Math.max(250, freshWaitUntil - Date.now()) };
      }

      if (!picked && gateOn) {
        while (!picked) {
          const scan = await refillHotQueue();
          picked = takeFromHotQueue();
          if (picked || state.stopRequested || scan?.exhausted || !(Number(scan?.checked) > 0)) break;
        }
        if (state.stopRequested) return { status: 'stopped' };
        if (!picked) picked = takeRetryLater();
        if (!picked) {
          if (activePhones.size) return { status: 'waiting', waitMs: 1_000 };
          await refreshIfStale();
          state.poolFresh = freshEntriesFrom(pool).length;
          if (state.poolFresh > 0 && freshWaitRounds < 40) {
            const now = Date.now();
            if (now < freshWaitUntil) return { status: 'waiting', waitMs: Math.max(250, freshWaitUntil - now) };
            freshWaitRounds++;
            await push(progressCard(section('🕐 Fresh Device Ka Wait', [
              `› Pass ${state.scanPass || 1} ke <b>${state.scanUniqueChecked || 0}/${state.scanTotalDevices || 0}</b> unique devices me koi usable last-activity timestamp hi nahi mila.`,
              `› Total probes: ${state.scanTotalProbes || state.scanChecked || 0} (repeated passes sameet). 15s ruk kar naya pass karunga (round ${freshWaitRounds}/40).`,
              sub('Timestamp wala device hota to isi pass par window double karke use le liya jata — dobara scan sirf nayi activity ke intezaar ke liye hai.'),
            ].join('\n'))), stopRows());
            probedDevices.clear();
            staleThisRun.clear();
            state.scanPass = (state.scanPass || 1) + 1;
            state.scanUniqueChecked = 0;
            state.scanWindowMs = Number(otpCfg.activeWindowMs) || 0;
            state.scanBestActivityMs = 0;
            state.scanBestActivityAgeMs = 0;
            freshWaitUntil = now + 15_000;
            return { status: 'waiting', waitMs: 15_000 };
          }
          return { status: 'exhausted' };
        }
      }

      if (!picked && !gateOn) {
        let fresh = pickFreshList();
        if (!fresh.length) {
          const retryPick = takeRetryLater();
          if (retryPick) {
            picked = retryPick;
          } else {
            if (activePhones.size) return { status: 'waiting', waitMs: 1_000 };
            await refreshIfStale();
            fresh = pickFreshList();
            if (!fresh.length) return { status: 'exhausted' };
            picked = { entry: fresh[0] };
          }
        } else {
          picked = { entry: fresh[0] };
        }
      }

      if (!picked?.entry) {
        return activePhones.size ? { status: 'waiting', waitMs: 1_000 } : { status: 'exhausted' };
      }
      if (picked.lastActivityMs || picked.onlineFallback) {
        freshWaitRounds = 0;
        freshWaitUntil = 0;
      }
      if (state.fresh + activePhones.size >= target) {
        if (gateOn) {
          hotQueue.unshift(picked);
          state.scanFresh = hotQueue.length;
        }
        return { status: 'waiting', waitMs: 500 };
      }
      if (!claimPickedEntry(picked.entry)) {
        if (gateOn) {
          hotQueue.unshift(picked);
          state.scanFresh = hotQueue.length;
        }
        return { status: 'waiting', waitMs: 250 };
      }
      removeRetryLaterPhone(picked.entry.phone);
      return { status: 'picked', picked };
    });

    // Pehla scan yahin — WAF warm-up ke parallel me hi (ensureWarm pehle
    // OTP se pehle token confirm karega).
    if (gateOn) await refillHotQueue();

    // Distinct routes tay hone ke baad asal lane count final karo. Free
    // auto-fetch pool/scan ke parallel chal raha tha; uske baghair lanes
    // ko pata hi nahi chalta kitni alag IPs asal me available hain.
    await freePromise;
    ps = proxyPool.proxySummary();
    laneCount = availableParallelLanes({
      requested: requestedConcurrency,
      proxyEnabled: Boolean(ps.enabled),
      enabledProxyCount: ps.enabledCount || 0,
    });
    state.concurrency = laneCount;
    state.requestedConcurrency = requestedConcurrency;
    lanes = Array.from({ length: laneCount }, (_, i) => ({
      id: i + 1,
      owner: `autopilot-${state.startedAt}-lane${i + 1}`,
      userId: parallelWorkerUserId(userId, i + 1),
      proxy: null,
      routeKey: '',
      routeMode: 'unassigned',
      proxyChallenges: 0,
      directChallenges: 0,
      consecutiveFails: 0,
      currentEntry: null,
    }));
    for (const lane of lanes) ensureLaneRoute(lane);
    syncRouteSummaryState();
    const securityStormLimit = Math.max(12, laneCount * 3);
    const rotationLimit = 25 * laneCount;
    const wafCooldownLimit = 60 * laneCount;
    console.log(`[Autopilot] ⚡ Parallel lanes ready: ${laneCount}/${requestedConcurrency} (proxy routes ${ps.enabledCount || 0} + direct 1).`);
    await push(progressCard(section('⚡ Parallel Lanes Ready', [
      `› <b>${laneCount} lane(s)</b> ek saath chalengi — har lane ka alag number, alag device aur alag IP route hoga.`,
      laneCount < requestedConcurrency
        ? `› ${requestedConcurrency} lanes maangi gayi thi, lekin distinct routes sirf ${laneCount} hain (${ps.enabledCount || 0} proxies + 1 direct). Zyada proxies hongi to lanes bhi badhengi.`
        : `› Saari ${requestedConcurrency} requested lanes ko distinct routes mil sakte hain.`,
      `› Jo lane pehle free hogi wahi agla number uthayegi — slow lane baaki lanes ko nahi rokegi.`,
      sub('Chromium WAF solver memory safety ke liye ek waqt me ek hi chalega; HTTP/OTP waits parallel rahenge.'),
    ].join('\n'))), stopRows());

    const runWorker = async (lane) => {
      try {
        for (;;) {
          if (state.stopRequested) {
            if (!runEndRequested) endReason = state.stopReason || 'manual';
            break;
          }
          if (Date.now() - state.startedAt > maxMinutes * 60_000) { requestRunEnd('time'); break; }
          if (state.fresh >= target) { requestRunEnd('target'); break; }
          // Target ke aakhir me extra numbers start karke overshoot na karo:
          // jitne in-flight hain unke potential fresh count kar lo.
          if (state.fresh + activePhones.size >= target) {
            await sleep(500, () => state.stopRequested);
            continue;
          }
          const failLimit = (ps.enabled ? 10 : 6) * laneCount;
          if (state.consecutiveFails >= failLimit) { requestRunEnd('circuit_breaker'); break; }

          if (!ensureLaneRoute(lane)) {
            await waitForRouteChange(1_000);
            continue;
          }
          const claim = await claimNextPick();
          if (claim.status === 'target') { requestRunEnd('target'); break; }
          if (claim.status === 'stopped') break;
          if (claim.status === 'waiting') {
            await sleep(claim.waitMs || 1_000, () => state.stopRequested);
            continue;
          }
          if (claim.status !== 'picked' || !claim.picked?.entry) {
            requestRunEnd('pool-exhausted');
            break;
          }
          const picked = claim.picked;
          lane.currentEntry = picked.entry;
          try {
      const entry = picked.entry;
      // Kisi bhi rasty se pick ho, isi phone ki purani retry entry saaf —
      // warna success ke baad wahi stale retry number ko dobara utha sakti thi.
      removeRetryLaterPhone(entry.phone);
      setLaneCurrent(lane, entry);

      // Card par foran saaf dikhao ke scan ruk chuka hai aur asal number
      // process ho raha hai. Warna WAF warm-up / OTP wait ke dauran purana
      // scan card dekh kar bot atka hua lagta tha.
      if (picked.lastActivityMs || picked.onlineFallback) {
        const pickedAgeMs = picked.lastActivityMs
          ? Math.max(0, Date.now() - Number(picked.lastActivityMs))
          : null;
        await push(progressCard(section('📟 Device Mil Gaya — Number Process Shuru', [
          `📱 <b>Number:</b> <code>${esc(entry.phone)}</code> · lane ${lane.id} · ${esc(lane.proxy?.label || 'direct')}`,
          picked.onlineFallback
            ? '› Quick scan me taaza SMS activity nahi mili — Firebase <b>clients me ONLINE</b> dikh raha device liya hai. Full pool scan ka wait nahi kiya.'
            : `› Device ki last SMS activity ~${fmtDuration(pickedAgeMs || 0)} purani · ladder ≤${fmtDuration(Math.max(Number(otpCfg.activeWindowMs) || 0, Number(picked.windowMs) || 0))} · queue me ${hotQueue.length} backup(s).`,
          sub('Is lane par ab WAF/OTP flow chalega; baaki lanes apna kaam jaari rakhengi. Processed count result aate hi badhega.'),
        ].join('\n'))), stopRows());
      }

      // WAF warm-up background me chal raha tha — pehla OTP iske baghair na jaye
      await ensureWarm();

      // Scan se aaye number ka prechecked last-seen pipeline ko dedo — wahi
      // device dobara fetch nahi hoga. Agar ye device base window miss ke
      // baad doubling ladder se mila hai to pipeline ko USI ladder window
      // ke hisaab se judge karo, warna scanner ka chuna hua device gate par
      // foran stale ho jayega. ONLINE fallback par SMS-age gate skip hai —
      // incoming SMS ka na aana device band honay ka saboot nahi.
      const numCfg = picked.onlineFallback
        ? { ...otpCfg, skipLastSeenGate: true }
        : picked.lastActivityMs
          ? {
              ...otpCfg,
              precheckedLastActivityMs: picked.lastActivityMs,
              precheckedAt: picked.checkedAt || Date.now(),
              activeWindowMs: Math.max(Number(otpCfg.activeWindowMs) || 0, Number(picked.windowMs) || 0),
            }
          : otpCfg;

      // Security outcome ki route classification ke liye process shuru
      // honay wali asal route episode yaad rakho (bridge andar recovery
      // me IP badal sakta hai; sirf final proxy dekhna kaafi nahi).
      const routeAtProcessStart = {
        mode: lane.routeMode || 'direct',
        proxyId: lane.proxy?.id || '',
      };
      let finalProxy = lane.proxy || null;
      const res = await runWithBridgeProxy(lane.proxy || null, async () => {
        try {
          return await processSingleNumber({
            userId: lane.userId,
            entry,
            otpCfg: numCfg,
            shouldAbort: () => state.stopRequested,
            report: async (text) => { await push(progressCard(text), stopRows()); },
          });
        } finally {
          finalProxy = getBridgeProxy();
        }
      }, {
        owner: lane.owner,
        releaseOnExit: false,
        wafTokenMode: laneCount > 1 && lane.proxy?.id ? 'defer-until-challenge' : '',
      });
      syncLaneRouteAfterProcess(lane, finalProxy);
      const finalProxyId = finalProxy?.id || '';

      setLaneCurrent(lane, null);
      const outcome = tally(res);
      if (['ok', 'skipped', 'deferred', 'aborted', 'rate_limited', 'failed'].includes(outcome)) {
        lane.proxyChallenges = 0;
        lane.directChallenges = 0;
      }
      if (outcome === 'failed') lane.consecutiveFails = (lane.consecutiveFails || 0) + 1;
      else if (['ok', 'skipped', 'deferred'].includes(outcome)) lane.consecutiveFails = 0;
      if (res.ok && res.phone) {
        extractedThisRun.add(res.phone);
        purgeQueuedPhone(res.phone);
      }
      if (outcome === 'failed' && res.phone) {
        failedAttemptsThisRun.set(res.phone, (failedAttemptsThisRun.get(res.phone) || 0) + 1);
      }
      // Console visibility — exact failure reason (Telegram card ke alawa),
      // taaki WAF/rate-limit/verify/OTP-miss ka farq turant dikhe logs me.
      if (!res.ok) {
        console.log(`[Autopilot] lane ${lane.id} | ${outcome} | ${res.kind} | ${res.phone} | ${lane.proxy?.label || 'direct'} | ${String(res.reason || '').replace(/\s+/g, ' ').slice(0, 160)}`);
      }
      // Stale devices rapid-fire skip hote hain — har ek par card edit karne
      // se Telegram flood hoga. Unka count stats me dikhta hai, card nahi.
      if (outcome !== 'device_stale' && outcome !== 'number_cooldown') {
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
            `📱 <b>Number:</b> <code>${esc(res.phone)}</code> · lane ${lane.id} · ${esc(lane.proxy?.label || 'direct')}`,
            `› <b>Outcome:</b> <code>${esc(res.kind)}</code>`,
            res.reason ? `<blockquote>${esc(String(res.reason).slice(0, 300))}</blockquote>` : '',
          ].filter(Boolean).join('\n'))
        ), stopRows());
      }

      // Engine-level reactions — "rukna hi na pare":
      //   rate-limit/WAF → TURANT proxy badal (nayi IP) + number defer kar
      //   (baad me isi run me dobara). Sirf tab ruk jab saare proxies side par.

      // 7-day cooldown — ye number pehle extract/send ho chuka hai. Queue
      // ki iski har copy saaf karke bina gap agla number lo.
      if (outcome === 'number_cooldown') {
        if (res.phone) {
          extractedThisRun.add(res.phone);
          purgeQueuedPhone(res.phone);
        }
        continue;
      }

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
        const infra = recordInfraAttempt(res.phone);
        const willRetry = Boolean(res.phone && attempt < 2 && infra.willRetry);
        if (willRetry) deferNumber(entry, 'swiggy_transient');

        let next = null;
        if (ps.enabled) {
          next = rotateLaneProxy(lane, finalProxyId, { countRotation: true });
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
            ? `› Lagatar ${state.transientStrikes} temporary errors — sirf lane ${lane.id} ${Math.round(waitMs / 1000)}s cool-off legi, baaki lanes chalti rahengi.`
            : `› Nayi IP par turant agla number — batch nahi rukega.`,
        ].join('\n'))), stopRows());

        if (waitMs) {
          await sleep(waitMs, () => state.stopRequested);
          if (state.stopRequested) { endReason = state.stopReason || 'manual'; break; }
        }
        if (next && laneCount === 1) {
          await solveLaneToken(lane, false);
        }
        state.consecutiveFails = 0;
        lane.consecutiveFails = 0;
        continue;
      }

      if (outcome === 'rate_limited') {
        // NOTE: rateStrikes tally() me already badhta hai — yahan dobara ++
        // karne se 3-strike wali limit 2 hits par hi band ho jati thi.
        // Number defer — isi run me aakhir me dobara try hoga (is run ke
        // combined infra attempts max 2; us ke baad ye phone side par).
        const rateInfra = recordInfraAttempt(res.phone);
        if (res.phone && rateInfra.willRetry) deferNumber(entry, 'rate_limited');

        if (ps.enabled) {
          const before = finalProxyId;
          const next = rotateLaneProxy(lane, before, { countRotation: true });
          if (next) {
            await push(progressCard(section('🔀 Rate Limit — Proxy Rotate (zero wait)', [
              `› IP ko limit lagi — nayi IP (proxy) le liya: <code>${esc(next.label)}</code>`,
              rateInfra.willRetry
                ? `› Number defer kiya — baad me isi run me ek aur mauqa milega.`
                : `› Is number ke is run ke 2 infra attempts ho gaye — ab ye is run me dobara nahi uthega.`,
              `› Strike ${state.rateStrikes} — lane ${lane.id} nayi IP par, baaki lanes unaffected.`,
            ].join('\n'))), stopRows());
            state.consecutiveFails = 0;
            lane.consecutiveFails = 0;
            continue; // turant agla number — ZERO wait
          }
        }

        // Direct mode (koi proxy nahi) — thoda ruk kar aage, warna poora IP
        // hi flagged ho jayega. 2 strikes se zyada = band.
        if (state.rateStrikes >= 3) { requestRunEnd('rate_limited'); break; }
        const backoff = Math.min(backoffMs, 5 * 60_000); // max 5 min (pehle 15)
        await push(progressCard(section('🚦 Swiggy Rate Limit — Short Backoff', [
          `› Sirf lane ${lane.id} ${Math.round(backoff / 60000)} min rukegi (strike ${state.rateStrikes}/3); baaki lanes chalti rahengi.`,
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
        if (state.wafCooldowns > wafCooldownLimit) { requestRunEnd('waf_stuck'); break; }
        const wafInfra = recordInfraAttempt(res.phone);
        if (res.phone && wafInfra.willRetry) deferNumber(entry, 'waf_cooldown');

        // Pool ke cooldown ka ahtaram karo lekin ek saath max 5 min — uske
        // baad token naya solve karke phir dekho (IP beech me thandi hogi).
        const cdMs = Math.min(Number(res.cooldownMs) || 120_000, 5 * 60_000);
        await push(progressCard(section('🛡 WAF Cooling — Short Wait', [
          `› Swiggy ki WAF abhi lane ${lane.id} ki IP ko thanda hone de rahi hai — ~${Math.max(1, Math.round(cdMs / 60000))} min ruk kar aage badhunga; baaki lanes chalti rahengi.`,
          wafInfra.willRetry
            ? `› Number defer ho chuka hai (isi run me ek aur mauqa milega). Batch zinda hai.`
            : `› Is number ke is run ke 2 infra attempts ho gaye — ab ye is run me dobara nahi uthega. Batch zinda hai.`,
          sub('Proxies add karoge to ye wait ghat kar seconds me aa jayegi (nayi IP = turant aage).'),
        ].join('\n'))), stopRows());
        await sleep(cdMs, () => state.stopRequested);
        if (state.stopRequested) { endReason = state.stopReason || 'manual'; break; }
        const rotated = rotateLaneProxy(lane, '', { countRotation: true }); // is lane ke liye jo bhi free hua, use le lo
        if (!rotated) {
          // Koi proxy free nahi bachi (free wali jaldi marti hain) — background
          // me nayi free proxies le aao, batch ko roke baghair.
          void proxyPool.refreshFreeProxies({ want: 10 }).then((r) => {
            if (r?.added) { ps = proxyPool.proxySummary(); console.log(`[Autopilot] 🌐 ${r.added} free proxies aa gayin (clean ${r.keptClean || 0}, WAF-ready ${r.keptChallenged || 0}).`); }
          }).catch(() => {});
        }
        state.consecutiveFails = 0;
        lane.consecutiveFails = 0;
        continue;
      }

      // Security challenge (403) — batch NAHI marta. Number defer, IP ko
      // thanda hone do, naya token lo aur aage badho. Ek success par strikes
      // reset (tally me) — isliye milawat wali run kabhi is par nahi rukti.
      // Sirf bahut lagatar (bina ek bhi processed outcome ke) challenges
      // par roko. Parallel lanes me limit lane-count ke hisaab se scale
      // hoti hai taaki pehli 10-lane wave hi batch ko premature na mare.
      // (Pehle: 4 par seedha batch band — boss ki sab se bari dikkat yahi thi.)
      if (outcome === 'security_challenge') {
        state.wafStrikes++;
        state.lastError = `security challenge ×${state.wafStrikes}`;
        const securityInfra = recordInfraAttempt(res.phone);
        if (res.phone && securityInfra.willRetry) deferNumber(entry, 'security_challenge');
        const numberRetryLine = securityInfra.willRetry
          ? 'Number defer hai — isi run me ek aur mauqa milega, failed mark nahi hua.'
          : 'Is number ke is run ke 2 infra attempts ho gaye — failed mark nahi hua, lekin ab ye is run me dobara nahi uthega.';
        if (state.wafStrikes >= securityStormLimit) { requestRunEnd('security_challenge'); break; }

        const routeKind = securityChallengeRouteKind({
          proxyEnabled: Boolean(ps.enabled),
          routeModeAtStart: routeAtProcessStart.mode,
          proxyIdAtStart: routeAtProcessStart.proxyId,
          finalProxyId,
        });
        const currentId = finalProxyId || (routeKind === 'proxy' ? routeAtProcessStart.proxyId : '');
        syncRouteSummaryState();
        if (routeKind === 'proxy') {
          state.proxyChallenges = (state.proxyChallenges || 0) + 1;
          lane.proxyChallenges = (lane.proxyChallenges || 0) + 1;
          // Final challenged route ki quarantine guarantee (bridge ke kuch
          // paths pehle ye miss kar dete the). Bridge ne already cooldown
          // laga diya ho to double-count na karo.
          if (currentId) {
            try {
              const info = proxyPool.listProxies().find((p) => p.id === currentId);
              if (!info || !info.cooldownLeftMs) proxyPool.markProxyWafHit(currentId, 10 * 60_000);
            } catch {}
          }
        } else {
          state.directChallenges = (state.directChallenges || 0) + 1;
          lane.directChallenges = (lane.directChallenges || 0) + 1;
        }

        const action = securityRouteAction({
          proxyEnabled: Boolean(ps.enabled),
          usingDirectFallback: routeKind === 'direct' && Boolean(ps.enabled),
          proxyChallenges: lane.proxyChallenges || 0,
          directChallenges: lane.directChallenges || 0,
        });

        const enterDirectFallback = async (reasonLine) => {
          if (!claimLaneDirect(lane)) return false;
          lane.directChallenges = 0;
          state.directChallenges = 0;
          state.proxyRotations = (state.proxyRotations || 0) + 1; // asal IP switch hua hai
          // Direct try hota rahe, peeche nayi free proxies bhi parkh lo.
          void proxyPool.refreshFreeProxies({ want: Math.max(10, requestedConcurrency) }).then((r) => {
            if (r?.added) {
              ps = proxyPool.proxySummary();
              console.log(`[Autopilot] 🌐 Direct fallback ke peeche ${r.added} free proxies refresh.`);
            }
          }).catch(() => {});
          await push(progressCard(section('🌐 Proxies Garam — Direct IP Try', [
            `› Lane ${lane.id} ko challenge mila (global lagatar ${state.wafStrikes}). ${reasonLine}`,
            `› Sirf ye lane Render ki <b>direct IP</b> + fresh WAF token try karegi (route switch #${state.proxyRotations}); baaki lanes apni IPs par rahengi.`,
            `› ${numberRetryLine} Direct par response milte hi challenge storm reset ho jayegi.`,
            sub('Peeche nayi free proxies bhi parkh raha hoon.'),
          ].join('\n'))), stopRows());
          await solveLaneToken(lane, false);
          return true;
        };

        if (action === 'direct_fallback') {
          const enteredDirect = await enterDirectFallback(`Is lane par ${lane.proxyChallenges} proxy routes challenge de chuke hain — kharab free pool me aur nahi ghumunga.`);
          if (!enteredDirect) {
            // Direct route kisi aur lane ke paas hai. Is lane ko doosri
            // proxy do; wo bhi na mile to route release karke allocator
            // ke wait par chhod do (garam IP par phansna nahi).
            const next = rotateLaneProxy(lane, currentId, { countRotation: true });
            if (!next) releaseLaneRoute(lane);
          }
          state.consecutiveFails = 0;
          lane.consecutiveFails = 0;
          continue;
        }

        if (action === 'restore_proxy') {
          const next = rotateLaneProxy(lane, '', { countRotation: true });
          if (next) {
            state.proxyRotations = (state.proxyRotations || 0) + 1; // direct → proxy switch
            state.proxyChallenges = 0;
            lane.proxyChallenges = 0;
            await push(progressCard(section('🔀 Direct Bhi Garam — Best Proxy Wapas', [
              `› Lane ${lane.id}: direct IP par 2 challenges aaye — best available proxy le liya: <code>${esc(next.label)}</code>`,
              `› Picker ab fresh-token/Indian/clean route ko pehle rakhta hai (rotation #${state.proxyRotations}).`,
              `› ${numberRetryLine}`,
            ].join('\n'))), stopRows());
            await solveLaneToken(lane, false);
            state.consecutiveFails = 0;
            lane.consecutiveFails = 0;
            continue;
          }
          // Proxy bhi free nahi mili — neeche direct cooldown ladder chalega.
        } else if (action === 'rotate_proxy') {
          const next = rotateLaneProxy(lane, currentId, { countRotation: true });
          if (next) {
            await push(progressCard(section('🔀 Security Challenge — Proxy Rotate', [
              `› Lane ${lane.id} ko challenge mila — sirf is lane ki nayi IP: <code>${esc(next.label)}</code> (rotation #${state.proxyRotations})`,
              `› ${numberRetryLine} Nayi IP + naye token ke saath aage badh raha hoon.`,
              sub('Baaki lanes apni IPs par chalti rahengi. Is lane par 3 proxy challenges ke baad direct fallback try hoga.'),
            ].join('\n'))), stopRows());
            await solveLaneToken(lane, false);
            state.consecutiveFails = 0;
            lane.consecutiveFails = 0;
            continue; // agla number nayi IP par (ye wala baad me dobara)
          }

          // Pehle yahan purani garam proxy hi chipki rehti thi aur code
          // "direct mode" samajh kar usi par token solve karta rehta tha.
          const enteredDirect = await enterDirectFallback('Doosri usable proxy abhi free nahi hai.');
          if (!enteredDirect) releaseLaneRoute(lane);
          state.consecutiveFails = 0;
          lane.consecutiveFails = 0;
          continue;
        }

        // Direct mode / direct fallback — pehle IP ko THANDA hone do
        // (ladder + pool cooldown), phir naya token banao. Garam IP par
        // token banana bekar hota hai: solver visit bhi challenge kha sakti hai.
        const poolCd = (() => { try { return wafPool.cooldownRemainingMs?.() || 0; } catch { return 0; } })();
        const waitMs = wafChallengeWaitMs(state.wafStrikes, poolCd);
        await push(progressCard(section('🛡 Swiggy Security Check — IP Cool-Down', [
          `› Lane ${lane.id} ko challenge mila — direct IP abhi garam hai.`,
          `› Sirf ye lane ~${Math.max(1, Math.round(waitMs / 60000))} min ruk kar naya WAF token banayegi; baaki lanes chalti rahengi. ${numberRetryLine}`,
          sub(ps.enabled
            ? 'Ek aur direct challenge par best proxy route dobara try hogi.'
            : 'Batch nahi rukega. Ek success milte hi ye ginti reset ho jati hai.'),
        ].join('\n'))), stopRows());
        await sleep(waitMs, () => state.stopRequested);
        if (state.stopRequested) { endReason = state.stopReason || 'manual'; break; }
        await solveLaneToken(lane, true);
        state.consecutiveFails = 0;
        lane.consecutiveFails = 0;
        continue; // thandi IP + fresh token → agla number
      }

      // Generic failure streak — pehle proxy badal kar dekho (IP issue ho
      // sakti hai), warna hi band. Pehle ye 6 par seedha band ho jata tha.
      if (outcome === 'failed' && (lane.consecutiveFails || 0) >= 4 && ps.enabled) {
        const laneFailStreak = lane.consecutiveFails || 0;
        const next = rotateLaneProxy(lane, finalProxyId, { countRotation: true });
        if (next) {
          state.consecutiveFails = 0;
          lane.consecutiveFails = 0;
          if (state.proxyRotations > rotationLimit) { requestRunEnd('circuit_breaker'); break; }
          await push(progressCard(section('🔀 Fail Streak — Proxy Rotate', [
            `› Lane ${lane.id} par ${laneFailStreak} lagatar failures — IP issue lag raha hai.`,
            `› Sirf is lane ki nayi IP: <code>${esc(next.label)}</code> (rotation #${state.proxyRotations}/${rotationLimit})`,
            sub('Baaki lanes apni IPs par chalti rahengi.'),
          ].join('\n'))), stopRows());
          continue;
        }
      }

      // Gap between numbers — ab per-lane/per-IP hai, global nahi. Ek lane
      // ke gap ke dauran baaki 9 lanes OTP/process jaari rakhengi.
      if (state.fresh < target && !state.stopRequested) {
        const jitter = Math.floor(Math.random() * 3_000);
        await sleep(gapMs + jitter, () => state.stopRequested);
      }
          } finally {
            setLaneCurrent(lane, null);
            if (lane.currentEntry) releaseClaimedEntry(lane.currentEntry);
            lane.currentEntry = null;
            notifyRouteChanged();
          }
        }
      } catch (err) {
        console.error(`[Autopilot] Lane ${lane.id}:`, err?.stack || err?.message);
        state.lastError = String(err?.message || err);
        requestRunEnd('firebase');
      } finally {
        if (lane.currentEntry) releaseClaimedEntry(lane.currentEntry);
        lane.currentEntry = null;
        setLaneCurrent(lane, null);
        releaseLaneRoute(lane);
      }
    };

    await Promise.all(lanes.map((lane) => runWorker(lane)));
    for (const lane of lanes) releaseLaneRoute(lane);
    activePhones.clear();
    activeDeviceIds.clear();
    activeByLane.clear();
    syncActiveNumbers();
    if (!runEndRequested && state.stopRequested) {
      endReason = state.stopReason || 'manual';
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
    try { proxyPool._clearProxyReservations(); } catch {}
    state.activeWorkers = 0;
    state.activeNumbers = [];
    state.current = null;
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
    await push(summaryCard(), doneRows(), { force: true });
  } catch {}

  return { ok: true, reason: endReason, snapshot: getAutopilotSnapshot() };
}
