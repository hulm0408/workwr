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

import { isFirebaseConfigured, firebaseSetupHintLines, listPoolNumbers, scanFreshDevices, _countDeviceOnlineStates } from './firebase-numbers.js';
import { applyActiveSource, applySourceForRun, listRunSources } from './firebase-sources.js';
import { getSetting } from './bot-settings.js';
import {
  processSingleNumber,
  freshEntriesFrom,
  preferOnline,
  isPhoneBlockedByPremiumLedger,
} from './number-pipeline.js';
import {
  getLiveSwiggyWafToken,
  runWithBridgeProxy,
  setBridgeProxy,
  getBridgeProxy,
  getChromeStatus,
  WAF_SOLVE_FAST_BUDGET_MS,
  WAF_SOLVE_RELIABLE_BUDGET_MS,
} from './swiggy-bridge.js';
import {
  resolveNumberSourceMode,
  getTelegramOtpConfig,
  getTelegramOtpStatus,
  getNextTelegramNumber,
  verifyTelegramOtpConnection,
  telegramOtpSetupHintLines,
} from './telegram-otp-source.js';
import * as wafPool from './waf-pool.js';
import * as proxyPool from './proxy-pool.js';
import { esc, section, sub, field, mono, progressBar, statusCard } from './rich-text.js';

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

// Number source ka final faisla: explicit start option > env NUMBER_SOURCE
// > bot setting > configured Telegram > Firebase. Telegram mode me koi
// Firebase fallback nahi hoga — user ne Telegram only choose kiya hai.
export function resolveAutopilotNumberSource(opts = {}) {
  const requested = String(opts.sourceMode || opts.numberSource || '').trim().toLowerCase();
  if (['telegram', 'hermes', 'hermeshu', 'hermeshu-bot', 'Hermeshu'].includes(requested)) return 'telegram';
  if (['firebase', 'firebase-pool', 'pool'].includes(requested)) return 'firebase';
  return resolveNumberSourceMode({
    env: opts.env || process.env,
    telegramSetting: Boolean(opts.telegramSetting ?? opts.telegramOtpMode),
  });
}

// Ek hi spare Telegram account/Hermes chat me ek waqt me sirf EK current
// number hota hai. 10 lanes chalana matlab 10 workers ek hi chat par
// Find/New/Refresh ghumayenge — isliye Telegram mode hamesha 1 lane hai,
// chahe proxy routes kitne hi kyun na hon.
export function effectiveAutopilotLanes({
  sourceMode = 'firebase',
  requested = MAX_AUTOPILOT_LANES,
  proxyEnabled = false,
  enabledProxyCount = 0,
} = {}) {
  if (sourceMode === 'telegram') return 1;
  return availableParallelLanes({ requested, proxyEnabled, enabledProxyCount });
}

export function _isTelegramAutopilotEntry(entry) {
  return Boolean(
    entry
    && (
      entry.source === 'telegram'
      || entry.otpProvider === 'telegram'
      || entry.provider === 'telegram'
      || entry.telegramMessageId !== undefined
    )
  );
}

export function formatTelegramSourceStatus(snapshot = {}) {
  const bot = String(snapshot.telegramBotUsername || 'HermeshuOTPROBOT').replace(/^@+/, '');
  if (snapshot.telegramLoginInProgress) return `@${bot} · Add Telegram Account login chal raha hai`;
  if (snapshot.telegramConnected) {
    const current = snapshot.telegramCurrentPhone || snapshot.current?.phone || '';
    return `@${bot} · connected${current ? ` · current ${current}` : ''}`;
  }
  if (snapshot.telegramAuthorized) return `@${bot} · account saved (connect pending)`;
  if (snapshot.telegramConfigured) return `@${bot} · configured (connect pending)`;
  const missing = Array.isArray(snapshot.telegramMissing) ? snapshot.telegramMissing.filter(Boolean) : [];
  return `@${bot} · setup pending${missing.length ? ` (${missing.join(', ')})` : ''}`;
}

export function formatNumberSourceStatus(snapshot = {}) {
  return snapshot.sourceMode === 'telegram'
    ? formatTelegramSourceStatus(snapshot)
    : formatFirebaseSourceStatus(snapshot);
}

export function firebaseSourceHost(url) {
  try { return new URL(String(url || '')).hostname; } catch { return ''; }
}

export function formatPoolStatus(snapshot = {}) {
  if (snapshot.sourceMode === 'telegram') {
    const runFinished = Number(snapshot.finishedAt) > 0;
    if (snapshot.poolLoaded === false && !runFinished) return 'Telegram Hermes connect ho raha hai…';
    const claimed = Number(snapshot.telegramClaimed) || 0;
    const current = snapshot.telegramCurrentPhone || snapshot.current?.phone || '';
    return current
      ? `Hermes current: ${current} · ${claimed} claimed`
      : `${claimed} claimed · agla number FIND/NEW NUMBER se aayega`;
  }
  const runFinished = Number(snapshot.finishedAt) > 0;
  if (snapshot.poolLoaded === false && !runFinished) return 'load ho raha hai…';
  const fresh = Number(snapshot.poolFresh) || 0;
  const total = Number(snapshot.poolTotal) || 0;
  return total > 0
    ? `${fresh} fresh / ${total} numbers`
    : '0 fresh / 0 numbers — is source me koi valid number nahi mila';
}

export function formatFirebaseSourceStatus(snapshot = {}) {
  const name = String(snapshot.poolSourceName || '').trim();
  const tried = Number(snapshot.poolSourcesTried) || 0;
  const total = Number(snapshot.poolSourcesTotal) || 0;
  if (!name) return 'source load ho raha hai…';
  const progress = total > 0 ? ` · source ${Math.min(Math.max(tried, 1), total)}/${total}` : '';
  const errors = Number(snapshot.poolSourceErrors) || 0;
  return `${name}${progress}${errors ? ` · ${errors} source error` : ''}`;
}

export function formatScanCandidateStates(snapshot = {}) {
  const online = Number(snapshot.scanCandidateOnline) || 0;
  const unknown = Number(snapshot.scanCandidateUnknown) || 0;
  const offline = Number(snapshot.scanCandidateOffline) || 0;
  if (!(online + unknown + offline)) return '';
  return `ONLINE ${online} · status-unknown ${unknown} · offline ${offline}`;
}

// Ek full pass me na SMS timestamp mile na pakka ONLINE fallback, to
// usi mare hue source par 40 passes ghumana sirf waqt aur Firebase probes
// jalata hai. Agla enabled source maujood ho to sirf ek 15s retry pass
// kaafi hai; uske baad source badlo. Aakhri/ekmatra source par purani
// lambi wait policy rehne do, kyunki wahan nayi device activity ka
// intezaar hi wahid rasta hai.
export function noEvidenceWaitPassLimit({ hasNextSource = false } = {}) {
  return hasNextSource ? 1 : 40;
}

export function poolExhaustedReasonText(snapshot = {}) {
  if (snapshot.sourceMode === 'telegram') {
    const bot = String(snapshot.telegramBotUsername || 'HermeshuOTPROBOT').replace(/^@+/, '');
    const claimed = Number(snapshot.telegramClaimed) || 0;
    const rejected = Number(snapshot.telegramRejected) || 0;
    if (!claimed && !rejected) {
      return `🕳 @${bot} se is run me koi usable number claim nahi ho paya — FIND NUMBER / NEW NUMBER response ya spare-account connection check karo.`;
    }
    return `🕳 Telegram Hermes par usable number nahi bacha — ${claimed} number claim hue${rejected ? `, ${rejected} cooldown/caps par reject hue` : ''}. Agla claim NEW NUMBER se hoga; Firebase fallback OFF hai.`;
  }
  const tried = Number(snapshot.poolSourcesTried) || 0;
  const total = Number(snapshot.poolSourcesTotal) || 0;
  const sourcePart = total > 0
    ? `${Math.min(Math.max(tried, 1), total)}/${total} ACTIVE Firebase sources check hue`
    : 'Firebase source check hua';
  if ((Number(snapshot.poolTotal) || 0) <= 0) {
    return `🕳 Kisi ACTIVE Firebase source se valid number nahi mila — ${sourcePart}. Ek source khali/error ho to baaki ACTIVE sources isi run me auto-try hote hain.`;
  }
  if ((Number(snapshot.processed) || 0) <= 0) {
    const candidateStates = formatScanCandidateStates(snapshot);
    const noLiveEvidence = (Number(snapshot.scanCandidateOnline) || 0) === 0 &&
      ((Number(snapshot.scanCandidateUnknown) || 0) + (Number(snapshot.scanCandidateOffline) || 0)) > 0;
    if (noLiveEvidence) {
      return `🕳 Pool me numbers mile, lekin kisi candidate device par SMS timestamp ya ONLINE saboot nahi mila — ${sourcePart}${candidateStates ? ` · aakhri source: ${candidateStates}` : ''}.`;
    }
    return `🕳 Pool me numbers mile, lekin koi fresh/usable candidate process ke liye nahi bacha — ${sourcePart} (cooldown/used/caps/device scan ke baad).`;
  }
  return `🕳 Saare ACTIVE Firebase sources ke usable fresh numbers khatam ho gaye — ${sourcePart}.`;
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
  manualSkips: 0,         // owner ke ⏭ SKIP se khatam hue current numbers
  manualSkipRequests: 0,  // SKIP button ki accepted requests (race me outcome se pehle)
  otpFailures: 0,         // one-shot OTP rule se isi run me consumed numbers
  skipRequestedPhone: '',
  skipRequestedLaneId: 0,
  skipRequestedAt: 0,
  lastSkippedPhone: '',
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
  sourceMode: 'firebase', // 'firebase' | 'telegram'
  telegramBotUsername: '',
  telegramOtpTimeoutMs: 20_000,
  telegramOtpRefreshMs: 2_500,
  telegramConfigured: false,
  telegramConnected: false,
  telegramAuthorized: false,
  telegramLoginInProgress: false,
  telegramMissing: [],
  telegramMe: '',
  telegramCurrentPhone: '',
  telegramClaimed: 0,
  telegramRejected: 0,
  telegramInfraRetries: 0,
  telegramClaimRetries: 0,
  workerRecoveries: 0,
  addressAdded: 0,
  addressFailed: 0,
  telegramLastCheckedAt: 0,
  activeNumbers: [],      // parallel lanes: [{ phone, startedAt, laneId, proxyLabel }]
  history: [],            // { phone, kind, reason? } (last 200)
  freshAccounts: [],      // { phone, accountKey } (successful sessions)
  lastError: '',
  poolLoaded: false,      // false = asal me load ho raha hai; true + 0 = source sach me khali
  poolTotal: 0,
  poolFresh: 0,
  poolSourceId: '',
  poolSourceName: '',
  poolSourceHost: '',
  poolSourcesTried: 0,
  poolSourcesTotal: 0,
  poolSourceErrors: 0,
  poolEmptySources: 0,
  poolStatus: 'idle',     // loading | ready | empty | no-fresh | error
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
  scanCandidateOnline: 0, // current pass candidates: pakke ONLINE devices
  scanCandidateUnknown: 0,// current pass candidates: status maloom nahi
  scanCandidateOffline: 0,// current pass candidates: pakke offline devices
};

export function getAutopilotSnapshot() {
  // Hermes claim ke beech engine state aksar purana hota hai (worker ek
  // await par hota hai). Status ke waqt provider ki taazi screen/click
  // jaankari lo taaki card par asal NEW/FIND click saaf dikhe.
  let telegramLive = {};
  if (state.running && state.sourceMode === 'telegram') {
    try { telegramLive = getTelegramOtpStatus() || {}; } catch {}
  }
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
    manualSkips: state.manualSkips || 0,
    manualSkipRequests: state.manualSkipRequests || 0,
    otpFailures: state.otpFailures || 0,
    skipRequested: Boolean(state.skipRequestedPhone),
    skipRequestedPhone: state.skipRequestedPhone || '',
    skipRequestedLaneId: state.skipRequestedLaneId || 0,
    skipRequestedAt: state.skipRequestedAt || 0,
    lastSkippedPhone: state.lastSkippedPhone || '',
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
    sourceMode: state.sourceMode || 'firebase',
    telegramBotUsername: state.telegramBotUsername || '',
    telegramOtpTimeoutMs: state.telegramOtpTimeoutMs || 20_000,
    telegramOtpRefreshMs: state.telegramOtpRefreshMs || 2_500,
    telegramConfigured: Boolean(state.telegramConfigured),
    telegramConnected: Boolean(state.telegramConnected),
    telegramAuthorized: Boolean(state.telegramAuthorized),
    telegramLoginInProgress: Boolean(state.telegramLoginInProgress),
    telegramMissing: [...(state.telegramMissing || [])],
    telegramMe: state.telegramMe || '',
    telegramCurrentPhone: state.telegramCurrentPhone || '',
    telegramClaimed: state.telegramClaimed || 0,
    telegramRejected: state.telegramRejected || 0,
    telegramInfraRetries: state.telegramInfraRetries || 0,
    telegramClaimRetries: state.telegramClaimRetries || 0,
    telegramScreenButtons: [...(telegramLive.lastScreenButtons || [])],
    telegramLastClickedButton: telegramLive.lastClickedButton || '',
    telegramLastClickedRole: telegramLive.lastClickedRole || '',
    telegramCallbackMessage: telegramLive.lastCallbackMessage || '',
    telegramClaimPhase: telegramLive.claimPhase || '',
    telegramLastActionAt: Number(telegramLive.lastActionAt) || 0,
    workerRecoveries: state.workerRecoveries || 0,
    addressAdded: state.addressAdded || 0,
    addressFailed: state.addressFailed || 0,
    telegramLastCheckedAt: state.telegramLastCheckedAt || 0,
    activeNumbers: (state.activeNumbers || []).map((n) => ({ ...n })),
    poolLoaded: Boolean(state.poolLoaded),
    poolTotal: state.poolTotal,
    poolFresh: state.poolFresh,
    poolSourceId: state.poolSourceId || '',
    poolSourceName: state.poolSourceName || '',
    poolSourceHost: state.poolSourceHost || '',
    poolSourcesTried: state.poolSourcesTried || 0,
    poolSourcesTotal: state.poolSourcesTotal || 0,
    poolSourceErrors: state.poolSourceErrors || 0,
    poolEmptySources: state.poolEmptySources || 0,
    poolStatus: state.poolStatus || 'idle',
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
    scanCandidateOnline: state.scanCandidateOnline || 0,
    scanCandidateUnknown: state.scanCandidateUnknown || 0,
    scanCandidateOffline: state.scanCandidateOffline || 0,
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

// ⏭ Owner ka current-number SKIP. Ye poora batch nahi rokta: sirf live
// card par dikh raha pehla active number cooperative checkpoints par
// khatam hoga, phir wahi lane NEW NUMBER legi.
export function requestAutopilotSkipCurrent(reason = 'manual') {
  if (!state.running) return { ok: false, reason: 'not-running', phone: '' };
  if (state.stopRequested) return { ok: false, reason: 'batch-stopping', phone: '' };
  const active = Array.isArray(state.activeNumbers) ? state.activeNumbers.filter(Boolean) : [];
  const current = active[0] || state.current || null;
  const phone = String(current?.phone || state.telegramCurrentPhone || '').replace(/\D/g, '').slice(-10);
  if (!phone) return { ok: false, reason: 'no-current-number', phone: '' };
  if (state.skipRequestedPhone === phone) {
    return { ok: true, already: true, reason, phone, laneId: Number(current?.laneId || state.skipRequestedLaneId || 0) };
  }
  state.skipRequestedPhone = phone;
  state.skipRequestedLaneId = Number(current?.laneId || 0);
  state.skipRequestedAt = Date.now();
  state.manualSkipRequests = (state.manualSkipRequests || 0) + 1;
  return { ok: true, already: false, reason, phone, laneId: state.skipRequestedLaneId };
}

export function isAutopilotSkipRequested(phone = '') {
  const clean = String(phone || '').replace(/\D/g, '').slice(-10);
  return Boolean(clean && state.skipRequestedPhone === clean);
}

function clearAutopilotSkipRequest(phone = '') {
  const clean = String(phone || '').replace(/\D/g, '').slice(-10);
  if (clean && state.skipRequestedPhone !== clean) return false;
  state.skipRequestedPhone = '';
  state.skipRequestedLaneId = 0;
  state.skipRequestedAt = 0;
  return true;
}

// OTP se juda koi bhi failure is number ko isi run ke liye khatam kar
// deta hai. Route/WAF recovery iske baad bhi chalegi, lekin sirf agle
// NEW number ke liye — pending/deferred same-number retry nahi hoga.
export function isOneShotOtpFailureResult(res = {}) {
  if (!res || res.ok || res.success === true) return false;
  if (res.otpFailure === true || res.otpAttemptConsumed === true) return true;
  const kind = String(res.kind || '');
  if ([
    'failed_otp_send',
    'failed_fresh_otp_send',
    'failed_otp_miss',
    'failed_fresh_otp_miss',
    'failed_otp_timeout',
    'failed_otp_verify',
    'failed_verify',
    'deferred_delete_otp_miss',
  ].includes(kind)) return true;
  const stage = String(res.stage || '');
  return [
    'otp_send',
    'fresh_otp_send',
    'delete_otp_send',
    'otp_wait',
    'otp_wait',
    'verify',
    'otp_verify',
    'delete_otp_wait',
    'delete_otp_verify',
  ].includes(stage);
}

export function nextNumberGapMs({
  telegramMode = false,
  outcome = '',
  configuredGapMs = 6_000,
} = {}) {
  const configured = Math.max(0, Number(configuredGapMs) || 0);
  if (outcome === 'manual_skip') return 0;
  if (telegramMode) return outcome === 'ok' ? Math.min(configured, 1_000) : 0;
  return configured;
}

// User ka fast-recovery rule: rate-limit/WAF par number minuteon queue me
// na fase — pehli recovery koshish 15 second ke andar nayi IP/token se ho.
export const FAST_ROUTE_RECOVERY_MS = 15_000;
export const FREE_PROXY_TARGET_COUNT = 30;

export function fastRouteRecoveryCapMs(requestedMs, fallbackMs = FAST_ROUTE_RECOVERY_MS) {
  const n = Number(requestedMs);
  const base = Number.isFinite(n) && n >= 0 ? n : (Number(fallbackMs) || FAST_ROUTE_RECOVERY_MS);
  return Math.max(0, Math.min(base, FAST_ROUTE_RECOVERY_MS));
}

export function rateLimitRecoveryWaitMs(consecutiveStrikes = 1, configuredBackoffMs = 0) {
  const strikes = Math.max(1, Number(consecutiveStrikes) || 1);
  const fastLadder = strikes <= 1 ? FAST_ROUTE_RECOVERY_MS : 30_000;
  const configured = Number(configuredBackoffMs) || fastLadder;
  // Configured backoff kitna bhi lamba ho, pehli do recoveries fast hongi;
  // third strike par engine pehle ki tarah run ko rok sakta hai.
  return Math.min(configured, fastLadder);
}

// Security challenge ke baad IP ko sirf chhota sa saans do, phir nayi
// IP/token se retry. Purani 30s→240s ladder ek hi Hermes lane ko 4 minute
// rok deti thi aur result slow/inconsistent lagta tha.
export function wafChallengeWaitMs(consecutiveStrikes, poolCooldownMs = 0) {
  const ladder = [5_000, 10_000, FAST_ROUTE_RECOVERY_MS, FAST_ROUTE_RECOVERY_MS];
  const idx = Math.min(Math.max(1, Number(consecutiveStrikes) || 1), ladder.length) - 1;
  const poolPart = fastRouteRecoveryCapMs(poolCooldownMs, 0);
  return Math.min(Math.max(ladder[idx], poolPart), FAST_ROUTE_RECOVERY_MS);
}

// Swiggy/proxy temporary 5xx ya network error par cool-off ladder. Proxy
// rotate ho jaye to pehle 2 strikes par wait nahi (nayi IP turant try hogi);
// ye wait sirf direct/no-next-proxy ya 3+ lagatar transient errors par
// istemal hota hai taaki asal Swiggy outage me poora pool churn na ho.
export function transientSwiggyRetryWaitMs(consecutiveStrikes) {
  const ladder = [FAST_ROUTE_RECOVERY_MS, 30_000, 45_000, 45_000];
  const idx = Math.min(Math.max(1, Number(consecutiveStrikes) || 1), ladder.length) - 1;
  return ladder[idx];
}

// Backward-compatible export, lekin latest owner rule isay supersede kar
// chuka hai: Hermes number par OTP-send/miss/verify failure ek baar aate
// hi woh number isi run ke liye khatam. Route recovery ke baad seedha
// NEW NUMBER hoga — pending same-number retry kabhi nahi.
export function telegramInfraRetryDecision(_opts = {}) {
  return false;
}

// Naya number claim karne se pehle route ki haalat. Tokenless +
// solve-cooling proxy par OTP bhejna lagbhag pakka challenge/transient
// hai; challenged proxy ko token ke baghair ready nahi mana jayega.
// Clean/manual route par reliable solve ke baad bhi token na mile to ek
// raw attempt allowed hai (homepage clean thi / Chrome solver alag fail
// ho sakta hai), warna solver ki ek kharabi poori run ko rok degi.
export function routeClaimReadiness({
  proxy = null,
  routeState = {},
  tokenReady = false,
} = {}) {
  const solveCooldownLeftMs = Math.max(0, Number(routeState?.wafSolveCooldownLeftMs) || 0);
  const readyToken = Boolean(tokenReady || routeState?.tokenReady);
  if (readyToken) return { ready: true, action: 'ready', reason: 'token-ready', solveCooldownLeftMs };
  if (!proxy?.id) return { ready: false, action: 'solve', reason: 'direct-token-missing', solveCooldownLeftMs };
  if (solveCooldownLeftMs > 1_000) {
    return { ready: false, action: 'rotate', reason: 'solve-cooling', solveCooldownLeftMs };
  }
  if (String(proxy.quality || '').toLowerCase() === 'challenged') {
    return { ready: false, action: 'solve', reason: 'challenged-token-missing', solveCooldownLeftMs };
  }
  return { ready: false, action: 'solve', reason: 'token-missing', rawFallback: true, solveCooldownLeftMs };
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

function plainStageText(raw = '') {
  return String(raw || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function truncateUiText(value = '', max = 96) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trim()}…` : text;
}

function stageParts(stageText = '') {
  const raw = String(stageText || '');
  const titleMatch = raw.match(/<b>([\s\S]*?)<\/b>/i);
  const title = plainStageText(titleMatch?.[1] || '');
  const lines = raw
    .split(/\n+/)
    .map((line) => plainStageText(line).replace(/^[›•·-]\s*/, '').trim())
    .filter(Boolean)
    .filter((line) => line !== title && !/^(processed|fresh sessions|skipped|failed|parallel lanes|proxy|pool)\b/i.test(line) && !/number\s*:/i.test(line));
  return { title, detail: truncateUiText(lines[0] || '', 104) };
}

function compactStepInfo(snap = {}, stageText = '') {
  const { title, detail } = stageParts(stageText);
  const text = `${title} ${detail}`.toLowerCase();
  const telegram = snap.sourceMode === 'telegram';
  let step = telegram ? 'NEW' : 'POOL';
  let now = telegram ? 'New number le raha hoon' : 'Number select ho raha hai';

  if (/number skip|manual_skip|current number skip|skip ho raha/.test(text)) {
    step = telegram ? 'NEW' : 'POOL';
    now = 'Current number SKIP ho gaya';
  } else if (/otp fail|failed_otp|failed_verify|one shot otp|one-shot otp/.test(text)) {
    step = telegram ? 'NEW' : 'POOL';
    now = 'OTP fail — ye number khatam';
  } else if (/address/.test(text)) {
    step = 'ADDR';
    now = 'Swiggy me address add ho raha hai';
  } else if (/route ready|waf|token|security|proxy|direct ip|rate limit/.test(text)) {
    step = telegram ? 'NEW' : 'POOL';
    now = /rate limit/.test(text) ? 'Rate-limit — nayi IP le raha hoon' : 'Route/WAF ready ho raha hai';
  } else if (/otp wait|refresh|otp.*intezaar|otp.*wait/.test(text)) {
    step = telegram ? 'REFRESH' : 'INBOX';
    now = telegram ? 'REFRESH par OTP aa raha hai' : 'OTP inbox check ho raha hai';
  } else if (/verify retry|verify/.test(text)) {
    step = 'VERIFY';
    now = 'OTP verify ho raha hai';
  } else if (/delete ho gaya|fresh registration|fresh account|signup/.test(text)) {
    step = 'VERIFY';
    now = 'Fresh account ban raha hai';
  } else if (/delete account|delete otp/.test(text)) {
    step = 'VERIFY';
    now = 'Purana account delete ho raha hai';
  } else if (/number done|fresh session/.test(text)) {
    step = 'FRESH';
    now = 'Fresh session ready hai';
  } else if (/device mil gaya|number process|current number|otp bheja|otp send/.test(text)) {
    step = 'OTP';
    now = 'Number mil gaya — OTP bhej raha hoon';
  } else if (/zinda devices|device scan|fresh device ka wait|scanning/.test(text) || snap.scanning) {
    step = 'POOL';
    now = 'Zinda device dhoondh raha hoon';
  } else if (/hermes ready|telegram hermes ready/.test(text)) {
    step = 'NEW';
    now = 'Hermes ready — NEW NUMBER lunga';
  } else if (/temporary error|retry|claim.*fail|number safe/.test(text)) {
    step = telegram ? 'NEW' : 'POOL';
    now = 'Temporary error — khud retry hoga';
  } else if (/result|failed|skipped|aborted/.test(text)) {
    step = telegram ? 'NEW' : 'POOL';
    now = 'Result aaya — agla number lunga';
  } else if (/parallel lanes ready|warm-up|warm up/.test(text)) {
    step = telegram ? 'NEW' : 'POOL';
    now = telegram ? 'Hermes + route ready ho rahe hain' : 'Pool + lanes ready ho rahe hain';
  } else if (snap.current?.phone || snap.activeNumbers?.length) {
    step = 'OTP';
    now = 'Number process ho raha hai';
  } else if (title) {
    now = truncateUiText(title.replace(/^[^\p{L}\p{N}]+/u, ''), 54);
  }

  // Hermes claim ke beech generic "New number le raha hoon" kaafi nahi hai.
  // Provider ki taazi latest-screen/click state ho to wahi ek line me dikhao;
  // route/WAF wala asal stage isse override nahi hoga.
  if (
    telegram && step === 'NEW'
    && !snap.current?.phone && !(snap.activeNumbers || []).length
    && !/route ready|waf|token|security|proxy|direct ip|rate limit/.test(text)
  ) {
    const claimPhase = String(snap.telegramClaimPhase || '').toLowerCase();
    const clickedButton = truncateUiText(
      String(snap.telegramLastClickedButton || '').replace(/^[^\p{L}\p{N}]+/u, ''),
      24
    );
    const actionAgeMs = Number(snap.telegramLastActionAt) > 0
      ? Date.now() - Number(snap.telegramLastActionAt)
      : Number.POSITIVE_INFINITY;
    if (/no-matching-button|no-button|no-latest-screen/.test(claimPhase)) {
      now = 'Latest Hermes screen par NEW/FIND nahi mila';
    } else if (/latest-screen-different-number/.test(claimPhase)) {
      now = 'Latest Hermes card alag number ka hai';
    } else if (/send-start/.test(claimPhase)) {
      now = '/start bhej kar FIND screen la raha hoon';
    } else if (/excluded-card/.test(claimPhase)) {
      now = 'Consumed card mila — NEW NUMBER lunga';
    } else if (/latest-screen-cycle/.test(claimPhase)) {
      now = 'Latest Hermes screen dobara padh raha hoon';
    } else if (clickedButton && (/clicked|click-|wait/.test(claimPhase) || actionAgeMs < 45_000)) {
      now = `${clickedButton} click — number card ka wait`;
    } else if (/connect/.test(claimPhase)) {
      now = 'Hermes connect ho raha hai';
    }
  }

  const flow = telegram
    ? ['NEW', 'OTP', 'REFRESH', 'VERIFY', 'ADDR', 'FRESH']
    : ['POOL', 'OTP', 'INBOX', 'VERIFY', 'ADDR', 'FRESH'];
  if (!flow.includes(step)) step = flow[0];
  const flowText = flow.map((x) => (x === step ? `[${x}]` : x)).join(' › ');
  const nextByStep = telegram
    ? {
        NEW: 'Number aate hi Swiggy OTP jayega',
        OTP: 'OTP ke baad REFRESH chalega',
        REFRESH: 'OTP mila to verify · na mila to NEW NUMBER',
        VERIFY: 'Fresh banega, phir address add hoga',
        ADDR: 'Address verify hote hi JSON aayega',
        FRESH: 'JSON isi chat me bhej diya hai',
      }
    : {
        POOL: 'Device milte hi OTP jayega',
        OTP: 'OTP inbox me check hoga',
        INBOX: 'OTP milte hi verify hoga',
        VERIFY: 'Fresh banega, phir address add hoga',
        ADDR: 'Address verify hote hi JSON aayega',
        FRESH: 'JSON isi chat me bhej diya hai',
      };
  const manualSkip = /number skip|manual_skip|current number skip|skip ho raha/.test(text);
  const oneShotOtp = /otp fail|failed_otp|failed_verify|one shot otp|one-shot otp/.test(text);
  const errorish = !manualSkip && /error|retry|waf|security|rate|temporary|fail|claim/.test(text);
  return {
    title,
    detail,
    step,
    now,
    flowText,
    next: manualSkip
      ? 'Batch chalega — NEW NUMBER aayega'
      : oneShotOtp
        ? 'Ye number khatam — route ready karke NEW NUMBER aayega'
        : errorish
          ? 'Route recovery hoga — STOP nahi hoga'
          : nextByStep[step],
    errorish,
  };
}

function compactSourceLine(snap = {}) {
  if (snap.sourceMode === 'telegram') {
    return `📨 ${mono('HERMES ONLY')} · 🔥 Firebase ${mono('OFF')}`;
  }
  const source = truncateUiText(snap.poolSourceHost || snap.poolSourceName || 'Firebase', 28);
  return `🔥 ${mono(source)} · Pool ${mono(`${Number(snap.poolFresh) || 0} fresh`)}`;
}

function compactElapsedMs(snap = {}) {
  if (Number(snap.elapsedMs) > 0) return Number(snap.elapsedMs);
  const start = Number(snap.startedAt) || Date.now();
  const end = Number(snap.finishedAt) || Date.now();
  return Math.max(0, end - start);
}

// Live card ka ek hi sach: abhi kya ho raha hai, kaunsa number hai,
// kitna target hua, aur agla step kya hai. Purani lambi diagnostics
// (pool/scan/proxy counters ke paragraphs) yahan nahi ghusengi.
export function formatCompactAutopilotCard(snap = state, { stageText = '', final = false } = {}) {
  const s = snap || {};
  const info = compactStepInfo(s, stageText);
  const active = Array.isArray(s.activeNumbers) ? s.activeNumbers.filter(Boolean) : [];
  const currentPhone = active[0]?.phone || s.current?.phone || s.telegramCurrentPhone || '';
  const phoneText = active.length > 1
    ? `${active.slice(0, 2).map((n) => n.phone).join(', ')} +${active.length - 2}`
    : (currentPhone || '—');
  const retries = (Number(s.serverErrors) || 0)
    + (Number(s.telegramClaimRetries) || 0)
    + (Number(s.workerRecoveries) || 0)
    + (Number(s.telegramInfraRetries) || 0);
  const fresh = Number(s.fresh) || 0;
  const target = Number(s.target) || 0;
  const reason = {
    target: 'Target complete',
    time: 'Max time complete',
    manual: 'Aapne STOP kiya',
    stopped: 'STOP kiya gaya',
    'pool-exhausted': s.sourceMode === 'telegram' ? 'Hermes number nahi mila' : 'Firebase pool khatam',
    'telegram-setup': 'Hermes account setup pending',
    telegram: 'Hermes connection error',
    firebase: s.sourceMode === 'telegram' ? 'Hermes connection error' : 'Firebase error',
    rate_limited: 'Swiggy rate-limit',
    security_challenge: 'Security challenge rukawat',
    waf_stuck: 'WAF rukawat',
    circuit_breaker: 'Lagatar failures par safety stop',
  }[s.stopReason] || (s.stopReason ? `Stop: ${s.stopReason}` : 'Batch complete');
  const skipRequested = !final && Boolean(s.skipRequestedPhone && s.skipRequestedPhone === currentPhone);
  const now = final ? reason : (skipRequested ? 'Current number SKIP ho raha hai' : info.now);
  const next = skipRequested ? 'Safe checkpoint par ruk kar NEW NUMBER aayega' : info.next;
  const title = final ? '🏁 BATCH KHATAM' : '🟢 LIVE';
  const lines = [
    mono(info.flowText),
    `<b>Abhi:</b> ${esc(now)}`,
    !final && info.detail && info.detail !== now ? `<i>${esc(info.detail)}</i>` : '',
    progressBar(fresh, target),
    `📱 ${mono(phoneText)} · ⏱ ${mono(fmtDuration(compactElapsedMs(s)))}${s.sourceMode !== 'telegram' && (s.concurrency || 1) > 1 ? ` · ⚡ ${mono(`${Number(s.activeWorkers) || active.length}/${Number(s.concurrency) || 1}`)}` : ''}`,
    compactSourceLine(s),
    `✅ ${mono(`FRESH ${fresh}`)} · ⚙ ${mono(`DONE ${Number(s.processed) || 0}`)} · × ${mono(`FAIL ${Number(s.failed) || 0}`)}${retries ? ` · ↻ ${mono(`RETRY ${retries}`)}` : ''}${Number(s.manualSkips) ? ` · ⏭ ${mono(`SKIP ${Number(s.manualSkips) || 0}`)}` : ''}${fresh ? ` · 🏠 ${mono(`ADDR ${Number(s.addressAdded) || 0}/${fresh}`)}` : ''}`,
    final
      ? (fresh ? sub('Fresh JSON chat me bhej diye hain.') : sub('Is run me fresh session nahi bana.'))
      : `<b>Next:</b> ${esc(next)}`,
    (final || info.errorish) && s.lastError ? `⚠ ${mono(truncateUiText(s.lastError, 76))}` : '',
  ];
  if (final && Array.isArray(s.freshAccounts) && s.freshAccounts.length) {
    const latest = s.freshAccounts.slice(-5);
    lines.push(`<b>Latest:</b> ${latest.map((a) => mono(a.phone)).join(' · ')}${s.freshAccounts.length > latest.length ? ` <i>+${s.freshAccounts.length - latest.length} aur</i>` : ''}`);
  }
  return statusCard(title, lines);
}

function statsLines() {
  return [
    `✅ ${mono(`FRESH ${Number(state.fresh) || 0}/${Number(state.target) || 0}`)} · ⚙ ${mono(`DONE ${Number(state.processed) || 0}`)} · × ${mono(`FAIL ${Number(state.failed) || 0}`)}`,
    compactSourceLine(state),
  ];
}

function idleCard() {
  if (state.running) return formatCompactAutopilotCard(state);
  if (state.finishedAt) return formatCompactAutopilotCard(state, { final: true });
  const telegram = state.sourceMode === 'telegram';
  return statusCard('🟢 READY', [
    mono(telegram ? '[NEW] › OTP › REFRESH › VERIFY › ADDR › FRESH' : '[POOL] › OTP › INBOX › VERIFY › ADDR › FRESH'),
    '<b>Abhi:</b> START ka wait hai',
    compactSourceLine(state),
    `🎯 ${mono(`${state.target || envInt('PREMIUM_BATCH_TARGET', 100)} fresh`)} · ⏱ ${mono(`${state.maxMinutes || envInt('PREMIUM_BATCH_MAX_MINUTES', 120)} min`)}`,
    '<b>Next:</b> START dabao — live card par har step saaf dikhega',
  ]);
}

function progressCard(stageText) {
  return formatCompactAutopilotCard(state, { stageText });
}

function summaryCard() {
  return formatCompactAutopilotCard(state, { final: true });
}

function stopRows() {
  return [
    [
      { text: '⏭ SKIP NUMBER', callback_data: 'prem_batch_skip_current', style: 'primary' },
      { text: '⏹ STOP BATCH', callback_data: 'prem_batch_stop', style: 'danger' },
    ],
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
  const telegramSetting = s('telegramOtpMode', false) === true;
  const sourceMode = resolveAutopilotNumberSource({
    ...opts,
    telegramSetting,
  });
  const telegramCfg = (() => {
    try { return getTelegramOtpConfig(); } catch { return null; }
  })();
  const telegramStatus = (() => {
    try { return getTelegramOtpStatus(); } catch { return {}; }
  })();
  const telegramTimeoutNumber = Number(
    opts.telegramOtpTimeoutMs ?? s('telegramOtpTimeoutMs', envInt('TELEGRAM_OTP_TIMEOUT_MS', 20_000))
  );
  const telegramOtpTimeoutMs = Number.isFinite(telegramTimeoutNumber)
    ? Math.max(1_000, telegramTimeoutNumber)
    : 20_000;
  const telegramRefreshNumber = Number(
    opts.telegramOtpRefreshMs ?? s('telegramOtpRefreshMs', envInt('TELEGRAM_OTP_REFRESH_MS', 2_500))
  );
  const telegramOtpRefreshMs = Number.isFinite(telegramRefreshNumber)
    ? Math.max(800, telegramRefreshNumber)
    : 2_500;
  const telegramMode = sourceMode === 'telegram';
  if (telegramMode && telegramStatus.loginInProgress) {
    return { ok: false, reason: 'telegram-login-in-progress' };
  }
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
    numberSource: sourceMode,
    source: sourceMode,
    telegramOtpMode: telegramMode,
    telegramOtpTimeoutMs,
    telegramOtpRefreshMs,
    telegramWaitMs: 0,
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
    manualSkips: 0, manualSkipRequests: 0, otpFailures: 0,
    skipRequestedPhone: '', skipRequestedLaneId: 0, skipRequestedAt: 0, lastSkippedPhone: '',
    rateStrikes: 0, wafStrikes: 0, wafCooldowns: 0, serverErrors: 0, transientStrikes: 0,
    consecutiveFails: 0, proxyRotations: 0,
    routeMode: 'direct', proxyChallenges: 0, directChallenges: 0, deferredQueue: 0,
    current: null, activeNumbers: [], history: [], freshAccounts: [], lastError: '',
    sourceMode,
    telegramBotUsername: telegramMode ? (telegramCfg?.botUsername || telegramStatus.botUsername || '') : '',
    telegramOtpTimeoutMs,
    telegramOtpRefreshMs,
    telegramConfigured: telegramMode ? Boolean(telegramCfg?.configured) : false,
    telegramConnected: telegramMode ? Boolean(telegramStatus.connected) : false,
    telegramAuthorized: telegramMode ? Boolean(telegramStatus.authorized) : false,
    telegramLoginInProgress: telegramMode ? Boolean(telegramStatus.loginInProgress) : false,
    telegramMissing: telegramMode ? [...(telegramCfg?.missing || telegramStatus.missing || [])] : [],
    telegramMe: telegramMode ? (telegramStatus.me || telegramStatus.accountLabel || '') : '',
    telegramCurrentPhone: '',
    telegramClaimed: 0,
    telegramRejected: 0,
    telegramInfraRetries: 0,
    telegramClaimRetries: 0,
    workerRecoveries: 0,
    addressAdded: 0,
    addressFailed: 0,
    telegramLastCheckedAt: 0,
    poolLoaded: telegramMode, poolTotal: 0, poolFresh: 0,
    poolSourceId: '', poolSourceName: telegramMode ? 'Telegram Hermes' : '', poolSourceHost: '',
    poolSourcesTried: 0, poolSourcesTotal: 0, poolSourceErrors: 0,
    poolEmptySources: 0, poolStatus: telegramMode ? 'ready' : 'loading',
    scanning: false, scanChecked: 0, scanTotalProbes: 0,
    scanUniqueChecked: 0, scanTotalDevices: 0, scanPass: 1,
    scanWindowMs: Number(otpCfg.activeWindowMs) || 0, scanBestActivityMs: 0, scanBestActivityAgeMs: 0, scanFresh: 0,
    scanCandidateOnline: 0, scanCandidateUnknown: 0, scanCandidateOffline: 0,
  });
  // Pichhli run kisi fatal par ruki ho to stale lane reservations nayi
  // run ki saari IPs ko block na kar dein.
  try { proxyPool._clearProxyReservations(); } catch {}

  const userId = opts.userId || 'autopilot';
  let endReason = 'target';
  // Is run ke Firebase sources: saved ACTIVE pehle, phir baaki enabled.
  // Numbers + OTP hamesha current run-source se aayenge; source sirf tab
  // badlega jab koi number active na ho, warna OTP doosri DB me dhoondha
  // jayega. Saved ACTIVE setting run ke baad restore ho jati hai.
  let runSources = [];
  let runSourceIndex = -1;
  let currentRunSource = null;
  const triedRunSourceKeys = new Set();
  const markRunSourceState = (src) => {
    currentRunSource = src || null;
    if (src) {
      triedRunSourceKeys.add(src.id || src.url || `source-${runSourceIndex}`);
      state.poolSourceId = src.id || '';
      state.poolSourceName = src.name || firebaseSourceHost(src.url) || 'Firebase';
      state.poolSourceHost = firebaseSourceHost(src.url);
    } else {
      state.poolSourceId = '';
      state.poolSourceName = 'ENV Firebase';
      state.poolSourceHost = firebaseSourceHost(process.env.FIREBASE_DB_URL || '');
    }
    state.poolSourcesTried = triedRunSourceKeys.size;
    state.poolSourcesTotal = runSources.length;
  };

  const tally = (res) => {
    // Owner ka manual SKIP na fresh hai, na fail, na DONE. Alag counter +
    // history me record hoga aur batch agle number par chalega.
    if (res.kind === 'manual_skip') {
      state.manualSkips = (state.manualSkips || 0) + 1;
      state.lastSkippedPhone = res.phone || state.lastSkippedPhone || '';
      state.history.push({ phone: res.phone, kind: res.kind, reason: res.reason || 'manual skip', at: new Date().toISOString() });
      if (state.history.length > 200) state.history.splice(0, state.history.length - 200);
      return 'manual_skip';
    }
    if (isOneShotOtpFailureResult(res)) {
      state.otpFailures = (state.otpFailures || 0) + 1;
    }

    // WAF cooldown OTP confirm hone se pehle aaya — processed/fail me
    // mat lo, warna summary jhootha dikhega. Phone phir bhi post-tally
    // one-shot consumed hoga, taaki chaalu batch isi par waqt na jalaye.
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

    // Security challenge — request WAF par hi ruk gayi. Processed/fail
    // me gina jata tha to stats jhoothe padte the; engine isko alag
    // handle karta hai (number one-shot consumed + IP cooldown/token).
    if (res.kind === 'security_challenge') return 'security_challenge';

    // Swiggy/proxy temporary 5xx ya network error — OTP confirm hi nahi
    // hua, isliye number processed/failed NAHI gina jayega. Engine proxy
    // rotate karke agla NEW number lega; ye phone retry queue me nahi.
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
    if (res.kind !== 'rate_limited') state.rateStrikes = 0;
    state.proxyChallenges = 0;
    state.directChallenges = 0;
    state.history.push({ phone: res.phone, kind: res.kind, reason: res.reason || '', at: new Date().toISOString() });
    if (state.history.length > 200) state.history.splice(0, state.history.length - 200);

    if (res.ok) {
      state.fresh++;
      if (res.kind === 'fresh_new') state.freshNew++;
      if (res.kind === 'fresh_after_delete') state.freshAfterDelete++;
      const remoteAddressStatus = String(res.account?.remoteAddressStatus || res.account?.exportJson?.remoteAddressStatus || '').toLowerCase();
      const remoteAddressId = String(res.account?.remoteAddressId || res.account?.exportJson?.remoteAddressId || '').trim();
      if (remoteAddressStatus === 'added' && remoteAddressId) state.addressAdded = (state.addressAdded || 0) + 1;
      else if (remoteAddressStatus) state.addressFailed = (state.addressFailed || 0) + 1;
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
    if (telegramMode) {
      runSources = [];
      state.poolSourcesTotal = 0;
      state.poolSourcesTried = 0;
      state.poolSourceId = '';
      state.poolSourceName = 'Telegram Hermes';
      state.poolSourceHost = '';
      state.telegramBotUsername = telegramCfg?.botUsername || telegramStatus.botUsername || state.telegramBotUsername || '';
      state.telegramConfigured = Boolean(telegramCfg?.configured);
      state.telegramMissing = [...(telegramCfg?.missing || telegramStatus.missing || [])];
    } else {
      // Dynamic Firebase — saare saved sources ACTIVE pool me hain.
      // First-try source pehle load hota hai; woh khali/error/exhaust ho
      // to baaki ACTIVE sources isi batch me khud try honge. User ko kisi
      // DB ko alag se enable/ACTIVE karne ki zaroorat nahi.
      try { runSources = listRunSources(); } catch { runSources = []; }
      state.poolSourcesTotal = runSources.length;
      if (runSources.length) {
        runSourceIndex = 0;
        applySourceForRun(runSources[0]);
        markRunSourceState(runSources[0]);
      } else {
        applyActiveSource();
        markRunSourceState(null);
      }
    }

    if (telegramMode && !telegramCfg?.configured) {
      endReason = 'telegram-setup';
      state.stopReason = 'telegram-setup';
      state.lastError = 'Telegram Hermes setup pending';
      state.telegramConfigured = false;
      state.telegramMissing = [...(telegramCfg?.missing || [])];
      await push(section(
        '⚙️ Telegram Hermes Setup Pending',
        telegramOtpSetupHintLines(telegramCfg || undefined).join('\n')
      ), [
        [{ text: '👤 Add Telegram Account', callback_data: 'ap_telegram_account', style: 'primary' }],
        [{ text: '⚙️ Settings', callback_data: 'ap_settings' }, { text: '🏠 Menu', callback_data: 'ap_home', style: 'primary' }],
      ]);
      return { ok: false, reason: 'telegram-setup' };
    }

    if (!telegramMode && !isFirebaseConfigured()) {
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
    await push(progressCard(section('🔥 Warm-up', telegramMode
      ? 'Hermes + route/WAF ready ho rahe hain'
      : 'Pool + route/WAF ready ho rahe hain')), stopRows());

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
        const r = await proxyPool.ensureFreeProxies({
          // Telegram me lane 1 hai, phir bhi WAF/rate-limit se bachne ke
          // liye sequential backup IPs chahiye. Sirf lane-count ginna pool
          // ko 1-10 par rok kar result slow kar deta tha.
          min: Math.max(12, requestedConcurrency),
          want: FREE_PROXY_TARGET_COUNT,
        });
        if (r && !r.skipped) {
          console.log(r.added
            ? `[Autopilot] 🌐 Free proxies: ${r.candidates || 0} candidates me se ${r.checked} parkhin, ${r.added} rakhin (clean ${r.clean || 0}, WAF-ready ${r.challenged || 0}) — IP rotation ON.`
            : `[Autopilot] 🌐 Free proxies: ${r.candidates || 0} candidates me se ${r.checked} parkhin, koi Swiggy-reachable nahi mili — direct mode chalega.`);
        }
        return r;
      } catch { return null; }
    })();
    // Hermes single-lane hai: 30 backup proxies probe hone tak pehla
    // NEW/FIND click rokna hi 4-minute wale NEW-stuck ki ek wajah tha.
    // Free probing background me jaari rahegi, lekin start/warm-up sirf
    // 12s tak uska wait karega (agar pehle se usable route hai to bilkul
    // nahi). Firebase ki 10-lane route ginti ke liye purana full wait hai.
    const freeStartWaitMs = telegramMode && !(Number(ps.usableCount) > 0) ? 12_000 : 0;
    const freeStartPromise = freeStartWaitMs > 0
      ? Promise.race([
          freePromise,
          sleep(freeStartWaitMs, () => state.stopRequested).then(() => null),
        ])
      : freePromise;

    // Pool load (bada node — ek baar, zarurat par refresh). YE WAF warm-up ke
    // SAATH parallel chalega — pehle dono ek-ke-peeche-ek the isliye pehla
    // number 30-60s baad ja kar start hota tha.
    let pool = [];
    let poolLoadedAt = 0;
    const syncTelegramState = (checkedAt = Date.now()) => {
      if (!telegramMode) return;
      let sNow = {};
      try { sNow = getTelegramOtpStatus(); } catch {}
      state.telegramBotUsername = sNow.botUsername || telegramCfg?.botUsername || state.telegramBotUsername || '';
      state.telegramConfigured = Boolean(sNow.configured ?? telegramCfg?.configured);
      state.telegramAuthorized = Boolean(sNow.authorized ?? sNow.isAuthorized);
      state.telegramConnected = Boolean(sNow.connected ?? sNow.ok ?? state.telegramConnected);
      state.telegramLoginInProgress = Boolean(sNow.loginInProgress);
      state.telegramMissing = [...(sNow.missing || telegramCfg?.missing || [])];
      state.telegramMe = sNow.me || sNow.accountLabel || state.telegramMe || '';
      state.telegramCurrentPhone = sNow.currentPhone || state.telegramCurrentPhone || '';
      state.telegramLastCheckedAt = checkedAt;
      state.poolLoaded = true;
      state.poolTotal = 0;
      state.poolFresh = 0;
      state.poolStatus = state.stopRequested ? 'stopped' : 'ready';
      state.poolSourceId = '';
      state.poolSourceName = 'Telegram Hermes';
      state.poolSourceHost = '';
      state.poolSourcesTried = 0;
      state.poolSourcesTotal = 0;
      state.poolSourceErrors = 0;
      state.poolEmptySources = 0;
      state.scanning = false;
      state.scanChecked = 0;
      state.scanTotalProbes = 0;
      state.scanUniqueChecked = 0;
      state.scanTotalDevices = 0;
      state.scanFresh = 0;
      state.scanCandidateOnline = state.telegramAuthorized || state.telegramConnected ? 1 : 0;
      state.scanCandidateUnknown = 0;
      state.scanCandidateOffline = 0;
      state.scanBestActivityMs = 0;
      state.scanBestActivityAgeMs = 0;
    };
    const loadPool = async () => {
      if (telegramMode) {
        pool = [];
        poolLoadedAt = Date.now();
        syncTelegramState(poolLoadedAt);
        return pool;
      }
      const nextPool = await listPoolNumbers();
      pool = nextPool;
      poolLoadedAt = Date.now();
      state.poolLoaded = true;
      state.poolTotal = pool.length;
      state.poolFresh = freshEntriesFrom(pool).length;
      state.poolStatus = !pool.length
        ? 'empty'
        : state.poolFresh > 0
          ? 'ready'
          : 'no-fresh';
      return pool;
    };
    const usablePoolCount = () => {
      const gateNeedsDevice = Number(otpCfg.activeWindowMs) > 0;
      return freshEntriesFrom(pool).filter((e) => !gateNeedsDevice || e.deviceId).length;
    };
    const loadInitialPool = async () => {
      if (telegramMode) {
        pool = [];
        poolLoadedAt = Date.now();
        syncTelegramState(poolLoadedAt);
        for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          const check = await verifyTelegramOtpConnection({ sendStartIfEmpty: true });
          if (check && check.ok === false) {
            throw new Error(check.reason || check.error || 'Telegram Hermes connect nahi hua');
          }
          if (
            check && (
              check.configured === false
              || check.connected === false
              || check.authorized === false
              || check.isAuthorized === false
            )
          ) {
            throw new Error(check.reason || check.error || 'Telegram spare account authorized nahi hai');
          }
          syncTelegramState(Date.now());
          if (!state.telegramConnected) state.telegramConnected = true;
          if (!state.telegramAuthorized) state.telegramAuthorized = true;
          state.lastError = '';
          await push(progressCard(section('📨 Telegram Hermes Ready', [
            `› @${esc(String(state.telegramBotUsername || telegramCfg?.botUsername || 'HermeshuOTPROBOT').replace(/^@+/, ''))} connected hai${state.telegramMe ? ` (${esc(state.telegramMe)})` : ''}.`,
            `› Har naya number NEW NUMBER se aayega; OTP ${Math.round(telegramOtpTimeoutMs / 1000)}s tak REFRESH karunga.`,
            sub('Firebase pool/device scan bypass hai — Telegram only mode me fallback OFF hai.'),
          ].join('\n'))), stopRows());
          return pool;
        } catch (e) {
          const message = String(e?.message || e || 'Telegram Hermes connect nahi hua');
          state.telegramConnected = false;
          state.poolStatus = 'error';
          syncTelegramState(Date.now());
          state.poolStatus = 'error';
          if (attempt < 5 && !state.stopRequested) {
            state.telegramClaimRetries = (state.telegramClaimRetries || 0) + 1;
            const waitMs = Math.min(12_000, 2_000 * (2 ** (attempt - 1)));
            await push(progressCard(section('↻ Hermes Retry', [
              'Connection abhi nahi bana — batch band nahi ho raha.',
              `Chhota wait ke baad dobara try hoga. ${esc(truncateUiText(message, 90))}`,
            ].join('\n'))), stopRows());
            await sleep(waitMs, () => state.stopRequested);
            continue;
          }
          throw new Error(message);
        }
        }
      }
      if (!runSources.length) {
        await loadPool();
        return pool;
      }

      let sawSuccessfulLoad = false;
      let lastSourceError = '';
      for (let i = 0; i < runSources.length; i++) {
        if (state.stopRequested) break;
        const src = runSources[i];
        runSourceIndex = i;
        applySourceForRun(src);
        markRunSourceState(src);
        pool = [];
        poolLoadedAt = 0;
        state.poolLoaded = false;
        state.poolTotal = 0;
        state.poolFresh = 0;
        state.poolStatus = 'loading';
        if (i > 0) {
          void push(progressCard(section('🔁 Firebase Source Fallback', [
            `› Pichhle source se usable number nahi mila.`,
            `› Ab <b>${esc(src.name || firebaseSourceHost(src.url))}</b> load kar raha hoon — source ${i + 1}/${runSources.length}.`,
            sub('Batch band nahi hoga; pehla usable pool milte hi lanes usi source se shuru hongi.'),
          ].join('\n'))), stopRows());
        }

        try {
          await loadPool();
          sawSuccessfulLoad = true;
          const usable = usablePoolCount();
          if (!pool.length) state.poolEmptySources = (state.poolEmptySources || 0) + 1;
          console.log(
            `[Autopilot] 🔥 Firebase source ${i + 1}/${runSources.length} (${src.name || firebaseSourceHost(src.url)}): ` +
            `${state.poolFresh} fresh / ${pool.length} numbers, usable ${usable}.`
          );
          if (usable > 0) {
            state.lastError = '';
            state.poolStatus = 'ready';
            return pool;
          }
          // Khali hai ya saare numbers cooldown/used/no-device hain —
          // batch ko yahin pool-exhausted mat karo, agla enabled DB dekho.
        } catch (e) {
          lastSourceError = String(e?.message || e);
          state.poolSourceErrors = (state.poolSourceErrors || 0) + 1;
          state.poolLoaded = false;
          state.poolTotal = 0;
          state.poolFresh = 0;
          state.poolStatus = 'error';
          pool = [];
          console.warn(
            `[Autopilot] 🔥 Firebase source ${i + 1}/${runSources.length} (${src.name || firebaseSourceHost(src.url)}) fail: ${lastSourceError}`
          );
        }
      }

      if (!sawSuccessfulLoad && lastSourceError) {
        throw new Error(
          `Kisi bhi ACTIVE Firebase source se pool load nahi hua (${triedRunSourceKeys.size}/${runSources.length} check). Last error: ${lastSourceError}`
        );
      }
      // Kam az kam ek source safalta se load hua, magar kahin usable
      // candidate nahi mila. Ye "abhi load ho raha hai" nahi hai — card
      // par asal 0/status dikhega.
      state.poolLoaded = true;
      state.poolTotal = pool.length;
      state.poolFresh = freshEntriesFrom(pool).length;
      state.poolStatus = pool.length ? 'no-fresh' : 'empty';
      return pool;
    };
    const poolPromise = loadInitialPool().catch((e) => {
      state.lastError = e?.message || 'pool load fail';
      state.poolLoaded = true;
      state.poolStatus = 'error';
      return pool;
    });

    // WAF warm-up BACKGROUND me — pool load + device scan iska wait nahi
    // karte. Pehla OTP bhejane se pehle ensureWarm() ise await karega.
    let wafTok = '';
    const warmPromise = (async () => {
      try {
        // PEHLE proxy final karo (free auto-fetch khatam hone do), PHIR token
        // solve karo — aws-waf-token IP-bound hai, galat IP ka token bekar hai.
        await freeStartPromise;
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
        wafTok = await getLiveSwiggyWafToken(false, {
          solveBudgetMs: telegramMode ? WAF_SOLVE_RELIABLE_BUDGET_MS : WAF_SOLVE_FAST_BUDGET_MS,
        });
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
      // One-shot OTP / manual SKIP wala phone kisi bhi branch se retry
      // queue me wapas nahi jayega.
      try { if (phoneConsumedThisRun(entry.phone)) return; } catch {}
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
    if (!telegramMode && !pool.length && state.lastError) throw new Error(state.lastError); // Firebase error ko fatal hi rakho (pehle wala behavior)

    // RUNNING card ab pool ke ASAL numbers ke saath (pehle 0/0 dikhta tha)
    await push(idleCard(), stopRows());

    const refreshIfStale = async () => {
      if (telegramMode) return;
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
    const telegramClaimedThisRun = new Set();
    const telegramRejectedThisRun = new Set();
    // Is run me extract/send ho chuke numbers — ledger ke ilawa in-memory
    // hard stop, taaki koi purani hot/retry queue entry inhe dobara na uthaye.
    const extractedThisRun = new Set();
    // One-shot OTP + owner SKIP: ye phones is run me kisi queue/claim se
    // dobara nahi uthenge. Route recovery sirf agle NEW number ke liye hai.
    const otpFailedThisRun = new Set();
    const manualSkippedThisRun = new Set();
    const phoneConsumedThisRun = (phone) => Boolean(
      phone && (otpFailedThisRun.has(phone) || manualSkippedThisRun.has(phone))
    );
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
      const willRetry = attempt < 2 && !phoneConsumedThisRun(phone);
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
        .filter((e) => !phoneConsumedThisRun(e.phone))
        .filter((e) => !staleThisRun.has(e.phone))
        .filter((e) => !isEntryActive(e));
      if (!allowOffline) {
        // Pakka ONLINE device ho to pakke offline ko pehle side par rakho,
        // lekin status-unknown ko ONLINE samajh kar offline devices ke
        // SMS timestamps scan karne ka mauqa khatam mat karo. Koi pakka
        // ONLINE na ho to unknown + offline sab timestamp scan me rahenge;
        // bina timestamp ke sirf asal ONLINE fallback hi aage badhega.
        const hasKnownOnline = list.some((e) => e.online === true);
        if (hasKnownOnline) list = list.filter((e) => e.online !== false);
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
          phoneConsumedThisRun(entry.phone) ||
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
          phoneConsumedThisRun(entry.phone) ||
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
      const candidateStates = _countDeviceOnlineStates(allCandidates);
      state.scanCandidateOnline = candidateStates.online;
      state.scanCandidateUnknown = candidateStates.unknown;
      state.scanCandidateOffline = candidateStates.offline;
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
                ? `Quick scan budget ${fmtDuration(deviceScanBudgetMs)} hai. Probed sample me taaza SMS timestamp ya pakka ONLINE device mile to foran process hoga; bilkul saboot na mile to baaki devices isi pass me check honge, phir ek retry ke baad agla Firebase source try hoga.`
                : 'Candidate milte hi scan ruk kar number process hoga; 12 ranked backups bhi queue me rahenge.';
              void push(progressCard(section('🔎 Zinda Devices Dhoondh Raha Hoon', [
                `› Pass ${state.scanPass || 1}: <b>${state.scanUniqueChecked}/${state.scanTotalDevices}</b> unique devices check hue — base window me <b>${freshCount}</b> fresh; current ladder ≤${fmtDuration(state.scanWindowMs)}.`,
                bestLine,
                formatScanCandidateStates(state) ? `› Candidate devices: <b>${esc(formatScanCandidateStates(state))}</b>.` : '',
                `› Total probes: ${state.scanTotalProbes} (repeated passes sameet — ye unique devices ki ginti nahi hai).`,
                sub(budgetLine),
              ].filter(Boolean).join('\n'))), stopRows());
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
        // Tokenless + abhi-abhi solver fail hua route asal me usable nahi:
        // use current lane par chipka rakhne se har naya number raw request
        // par challenge/transient khata tha. Token ready ho to purani solve
        // failure irrelevant hai (setProxyToken use waise bhi clear karti hai).
        const rawRouteProven = lane.rawRouteOkKey === `proxy:${lane.proxy.id}`;
        const tokenlessSolveCooling = !rawRouteProven && !route.tokenReady && (route.wafSolveCooldownLeftMs || 0) > 1_000;
        return !tokenlessSolveCooling &&
          (route.cooldownLeftMs || 0) <= 5_000 &&
          (route.consecutiveErrors || 0) < 3;
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
      lane.rawRouteOkKey = '';
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
      if (lane.rawRouteOkKey && lane.rawRouteOkKey !== lane.routeKey) lane.rawRouteOkKey = '';
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
      if (lane.rawRouteOkKey && lane.rawRouteOkKey !== 'direct') lane.rawRouteOkKey = '';
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
    // 🌐 Mid-run proxy refill — "rukna hi na pare". Jab saare IPs cooling
    // ho jate hain to lanes seedha DIRECT (flagged Render IP) par chali jaati
    // thin jahan WAF challenge guaranteed tha → 4 strikes par run khatam.
    // Ab usable backups lane-count se kam hon to background me free pool
    // se naye IPs test karke laya jata hai (max ek baar har 60s).
    let lastProxyRefillAt = 0;
    let refillInFlight = false;
    const maybeRefillFreeProxies = () => {
      if (refillInFlight || !proxyPool.isEnabled()) return;
      const now = Date.now();
      if (now - lastProxyRefillAt < 60_000) return;
      lastProxyRefillAt = now;
      refillInFlight = true;
      (async () => {
        try {
          const before = proxyPool.proxySummary();
          // Pool poori tarah marne ka wait mat karo — usable backups
          // lane-count se kam hon to peeche refill shuru kar do.
          if ((before.usableCount || 0) >= Math.max(2, laneCount || 1)) return;
          const r = await proxyPool.refreshFreeProxies({ want: FREE_PROXY_TARGET_COUNT });
          const after = proxyPool.proxySummary();
          console.log(`[Autopilot] 🌐 Sab IPs cooling the — refill: ${r?.checked || 0} check → ${r?.added || 0} nayi (usable ab ${after.usableCount || 0}/${after.enabledCount || 0}).`);
          if ((after.usableCount || 0) > 0) notifyRouteChanged();
        } catch (e) {
          console.warn('[Autopilot] proxy refill skip:', e?.message || e);
        } finally {
          refillInFlight = false;
        }
      })();
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
          lane.routeWaitSince = 0;
          return true;
        }
        // Proxy pool hai par abhi koi pick-layak nahi (sab cooling ya lanes me
        // reserved). DIRECT fallback = flagged IP par challenge jala kar strike
        // barhana, isliye pehle naye IP ka intezaar: free refill background me
        // chalu, cooldown khatam hote hi lane khud age badhegi. 15s se
        // zyada route ka wait nahi — phir direct ko ek tez mauqa milega aur
        // peeche refill chalti rahegi.
        const s = proxyPool.proxySummary();
        if ((s.enabledCount || 0) > 0) {
          if (!lane.routeWaitSince) lane.routeWaitSince = Date.now();
          maybeRefillFreeProxies();
          if (Date.now() - lane.routeWaitSince < FAST_ROUTE_RECOVERY_MS) return false;
          console.log(`[Autopilot] Lane ${lane.id}: 15s me koi free IP nahi mili — direct fallback le raha hai.`);
        }
      }
      lane.routeWaitSince = 0;
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
    const solveLaneToken = async (lane, force = false, budgetMs = 0) => {
      try {
        const solveBudgetMs = Number(budgetMs) > 0
          ? Number(budgetMs)
          : ((laneCount || 1) <= 1 ? WAF_SOLVE_RELIABLE_BUDGET_MS : WAF_SOLVE_FAST_BUDGET_MS);
        return await runWithBridgeProxy(
          lane.proxy || null,
          () => getLiveSwiggyWafToken(force, { solveBudgetMs }),
          { owner: lane.owner, releaseOnExit: false }
        );
      } catch { return ''; }
    };

    // Telegram/Hermes me number claim karna ek asal side-effect hai: FIND /
    // NEW ke baad current card badal jata hai. Isliye route/WAF token ka
    // intezaam claim se PEHLE hoga. Pehle worker pehle Hermes number le
    // leta tha, phir tokenless/solve-cooling route par bhej kar use infra
    // failure me consume kar deta tha. Ab zyada se zyada 3 routes tayyar
    // hongi; challenged route token ke baghair aage nahi
    // jayegi. Clean/manual route par solve fail ho tab bhi ek raw attempt
    // allowed hai, kyunki us IP par Swiggy homepage clean aa chuki hoti hai
    // aur bridge ke paas apni Android/browser recovery bhi hai.
    const prepareLaneRouteBeforeClaim = async (lane) => {
      if (!telegramMode) return true;
      // Hermes startup ab free-proxy probing ke poora khatam hone ka wait
      // nahi karta; background me nayi routes aayein to agli claim se
      // pehle summary taaza kar lo, warna ps purana OFF snapshot reh jayega.
      try { ps = proxyPool.proxySummary(); } catch {}
      const attemptedRoutes = new Set();
      let notified = false;
      const notifyPreparing = async (routeLabel) => {
        const now = Date.now();
        if (notified || (lane.routePrepNoticeAt && now - lane.routePrepNoticeAt < 30_000)) return;
        notified = true;
        lane.routePrepNoticeAt = now;
        await push(progressCard(section('🛡 Route Ready — Phir NEW NUMBER', [
          `› Lane ${lane.id} ki route <code>${esc(routeLabel || 'direct')}</code> par WAF token solve ho raha hai.`,
          '› Pehle IP/token ready hoga, phir <b>NEW NUMBER</b> claim hoga — purana OTP-failed number dobara nahi chalega.',
          sub('Token jaldi mil jaye to solve turant khatam ho jayega; clean route par fast solve, challenged/direct route par reliable budget 45s tak hai.'),
        ].join('\n'))), stopRows());
      };

      for (let attempt = 0; attempt < 3; attempt++) {
        if (state.stopRequested) return false;
        if (!ensureLaneRoute(lane)) return false;

        const routeKey = lane.proxy?.id ? `proxy:${lane.proxy.id}` : 'direct';
        if (attemptedRoutes.has(routeKey)) return false;
        attemptedRoutes.add(routeKey);

        // Isi route par pichhla number asal Swiggy response tak gaya tha
        // (OTP send/verify stage paar hua). Token solver fail hone ke
        // bawjood ye route raw kaam kar chuki hai — har agle number se
        // pehle dobara solver ghuma kar use churn mat karo. Infra outcome
        // aate hi ye raw-ok nishan saaf ho jata hai.
        if (lane.rawRouteOkKey && lane.rawRouteOkKey === routeKey) return true;

        if (!lane.proxy?.id) {
          await notifyPreparing('direct');
          const token = await solveLaneToken(lane, false, WAF_SOLVE_RELIABLE_BUDGET_MS);
          if (state.stopRequested) return false;
          if (token) return true;
          if (ps.enabled) {
            const next = rotateLaneProxy(lane, '', { countRotation: true });
            if (next) continue;
          }
          // Direct-only / koi proxy free nahi: bridge ki raw + Android /
          // browser recovery ko ek mauqa do. OTP fail par ye number
          // one-shot consumed hoga aur recovery agle NEW ke liye hogi.
          return true;
        }

        let routeState = {};
        try { routeState = proxyPool.getProxyRouteState(lane.proxy.id) || {}; } catch {}
        const readiness = routeClaimReadiness({ proxy: lane.proxy, routeState });
        if (readiness.ready) return true;

        if (readiness.action === 'rotate') {
          const failedId = lane.proxy.id;
          const next = rotateLaneProxy(lane, failedId, { countRotation: true });
          if (next && next.id !== failedId) continue;
          maybeRefillFreeProxies();
          return false;
        }

        await notifyPreparing(lane.proxy.label || lane.proxy.id);
        // Challenged IP ko token ke baghair aage nahi bhejenge, isliye
        // reliable budget. Clean/manual IP par fast solve kaafi hai —
        // fail ho to neeche raw fallback hai, aur agar wo bhi infra de to
        // outcome branch nayi route par reliable solve karega. Har clean
        // route par pehle se 45s jalana throughput ko bina wajah marega.
        const token = await solveLaneToken(
          lane,
          false,
          readiness.rawFallback ? WAF_SOLVE_FAST_BUDGET_MS : WAF_SOLVE_RELIABLE_BUDGET_MS
        );
        if (state.stopRequested) return false;
        try { routeState = proxyPool.getProxyRouteState(lane.proxy.id) || {}; } catch {}
        if (token || routeState.tokenReady) return true;

        let chromeFound = true;
        try { chromeFound = Boolean(getChromeStatus()?.found); } catch {}
        const challenged = String(lane.proxy.quality || '').toLowerCase() === 'challenged';
        if (!chromeFound && !challenged) return true;
        if (chromeFound && readiness.rawFallback) return true;

        const failedId = lane.proxy.id;
        const next = rotateLaneProxy(lane, failedId, { countRotation: true });
        if (next && next.id !== failedId) continue;
        // Chrome hi nahi aur sirf challenged route bachi hai to raw bridge
        // recovery hi aakhri mauqa hai; warna tokenless challenged IP par
        // number claim karke jalana sahi nahi.
        return !chromeFound;
      }

      maybeRefillFreeProxies();
      return false;
    };

    let freshWaitUntil = 0;
    const resetPoolScanStateForSourceSwitch = () => {
      hotQueue.length = 0;
      retryLater.length = 0;
      probedDevices.clear();
      staleThisRun.clear();
      freshWaitRounds = 0;
      freshWaitUntil = 0;
      state.deferredQueue = 0;
      state.scanning = false;
      state.scanUniqueChecked = 0;
      state.scanTotalDevices = 0;
      state.scanPass = 1;
      state.scanWindowMs = Number(otpCfg.activeWindowMs) || 0;
      state.scanBestActivityMs = 0;
      state.scanBestActivityAgeMs = 0;
      state.scanFresh = 0;
      state.scanCandidateOnline = 0;
      state.scanCandidateUnknown = 0;
      state.scanCandidateOffline = 0;
    };
    // Current source khatam/khali ho aur koi lane kisi number par active
    // na ho to batch band karne ke bajaye agla enabled Firebase lagao.
    // Active number hote hue switch kabhi nahi: uska OTP purani DB ke
    // messages node me aayega.
    const tryRotateRunSource = async (why = 'pool-exhausted') => {
      if (telegramMode || !runSources.length || activePhones.size || state.stopRequested) return false;
      const fromName = state.poolSourceName || currentRunSource?.name || 'current source';
      let sawSuccessfulLoad = false;
      let lastSourceError = '';

      for (let nextIndex = runSourceIndex + 1; nextIndex < runSources.length; nextIndex++) {
        if (state.stopRequested || activePhones.size) return false;
        const src = runSources[nextIndex];
        runSourceIndex = nextIndex;
        applySourceForRun(src);
        markRunSourceState(src);
        resetPoolScanStateForSourceSwitch();
        pool = [];
        poolLoadedAt = 0;
        state.poolLoaded = false;
        state.poolTotal = 0;
        state.poolFresh = 0;
        state.poolStatus = 'loading';
        await push(progressCard(section('🔁 Firebase Source Switch', [
          `› <b>${esc(fromName)}</b> par usable number nahi bacha (${esc(why)}).`,
          `› Ab <b>${esc(src.name || firebaseSourceHost(src.url))}</b> load kar raha hoon — source ${nextIndex + 1}/${runSources.length}. Batch band nahi hoga.`,
          sub('Numbers aur OTP dono ab isi naye source se aayenge; pehle source ka koi number active nahi hai.'),
        ].join('\n'))), stopRows());

        try {
          await loadPool();
          sawSuccessfulLoad = true;
          const usable = usablePoolCount();
          if (!pool.length) state.poolEmptySources = (state.poolEmptySources || 0) + 1;
          console.log(
            `[Autopilot] 🔁 Firebase source switch → ${src.name || firebaseSourceHost(src.url)}: ` +
            `${state.poolFresh} fresh / ${pool.length} numbers, usable ${usable}.`
          );
          if (usable > 0) {
            state.lastError = '';
            state.poolStatus = 'ready';
            await push(progressCard(section('🔥 Naya Firebase Source Ready', [
              `› <b>${esc(src.name || firebaseSourceHost(src.url))}</b>: ${state.poolFresh} fresh / ${pool.length} numbers.`,
              `› Isi batch me aage ke numbers ab is source se process honge.`,
            ].join('\n'))), stopRows());
            return true;
          }
        } catch (e) {
          lastSourceError = String(e?.message || e);
          state.poolSourceErrors = (state.poolSourceErrors || 0) + 1;
          state.poolLoaded = false;
          state.poolTotal = 0;
          state.poolFresh = 0;
          state.poolStatus = 'error';
          pool = [];
          console.warn(`[Autopilot] 🔁 Firebase source ${src.name || firebaseSourceHost(src.url)} fail: ${lastSourceError}`);
        }
      }

      if (sawSuccessfulLoad || triedRunSourceKeys.size >= runSources.length) {
        state.poolLoaded = true;
        state.poolTotal = pool.length;
        state.poolFresh = freshEntriesFrom(pool).length;
        state.poolStatus = pool.length ? 'no-fresh' : (lastSourceError ? 'error' : 'empty');
      }
      if (lastSourceError && !state.processed) {
        state.lastError = `Firebase sources ${triedRunSourceKeys.size}/${runSources.length} check hue. Last error: ${lastSourceError}`.slice(0, 220);
      }
      return false;
    };
    let telegramClaimRetryStreak = 0;
    const claimNextPick = () => withClaimLock(async () => {
    for (;;) {
      if (state.stopRequested) return { status: 'stopped' };
      if (state.fresh >= target) return { status: 'target' };
      if (state.fresh + activePhones.size >= target) return { status: 'waiting', waitMs: 500 };
      if (telegramMode) {
        syncTelegramState(Date.now());
        if (activePhones.size) return { status: 'waiting', waitMs: 1_000 };

        const excluded = new Set([
          ...telegramClaimedThisRun,
          ...telegramRejectedThisRun,
          ...extractedThisRun,
          ...otpFailedThisRun,
          ...manualSkippedThisRun,
          ...staleThisRun,
          ...infraCappedThisRun,
          ...activePhones,
        ].map(String));
        const acceptTelegramEntry = async (entry) => {
          const phone = String(entry?.phone || '').replace(/\D/g, '').slice(-10);
          const ok = Boolean(
            /^[6-9]\d{9}$/.test(phone)
            && !isEntryActive(entry)
            && !telegramClaimedThisRun.has(phone)
            && !telegramRejectedThisRun.has(phone)
            && !extractedThisRun.has(phone)
            && !phoneConsumedThisRun(phone)
            && !staleThisRun.has(phone)
            && underFailCap(entry)
            && underTransientCap(entry)
            && underInfraCap(entry)
            && !isPhoneBlockedByPremiumLedger(phone)
          );
          if (!ok) {
            if (phone) {
              telegramRejectedThisRun.add(phone);
              state.telegramRejected = telegramRejectedThisRun.size;
            }
            syncTelegramState(Date.now());
            if (!state.telegramConnected) state.telegramConnected = true;
            if (!state.telegramAuthorized) state.telegramAuthorized = true;
            state.telegramRejected = telegramRejectedThisRun.size;
          }
          return ok;
        };

        let entry;
        try {
          entry = await getNextTelegramNumber({
            forceNew: true,
            excludePhones: [...excluded],
            maxAttempts: 8,
            timeoutMs: telegramOtpTimeoutMs,
            acceptEntry: acceptTelegramEntry,
            shouldAbort: () => state.stopRequested,
          });
        } catch (e) {
          const message = String(e?.message || e || 'Telegram Hermes se usable number nahi mila');
          state.lastError = message.slice(0, 240);
          syncTelegramState(Date.now());
          state.telegramRejected = telegramRejectedThisRun.size;
          if (state.stopRequested) return { status: 'stopped' };
          const terminalSetup = telegramCfg?.configured === false
            || /not configured|missing.*(api|session)|install teleproto|login in progress/i.test(message);
          if (terminalSetup) return { status: 'exhausted' };
          // Hermes/MTProto ki temporary rukawat par pura batch force-stop
          // nahi hoga. Worker chhota backoff lekar NEW NUMBER phir try karega;
          // target/max-time/manual STOP hi normal end points rahenge.
          telegramClaimRetryStreak += 1;
          state.telegramClaimRetries = (state.telegramClaimRetries || 0) + 1;
          return {
            status: 'claim-retry',
            waitMs: Math.min(15_000, 2_000 * (2 ** Math.min(3, telegramClaimRetryStreak - 1))),
            error: message,
          };
        }

        syncTelegramState(Date.now());
        if (!state.telegramConnected) state.telegramConnected = true;
        if (!state.telegramAuthorized) state.telegramAuthorized = true;
        const phone = String(entry.phone).replace(/\D/g, '').slice(-10);
        telegramClaimRetryStreak = 0;
        telegramClaimedThisRun.add(phone);
        state.telegramClaimed = telegramClaimedThisRun.size;
        state.telegramCurrentPhone = phone;
        state.telegramLastCheckedAt = Date.now();
        state.lastError = '';

        const picked = {
          entry: {
            ...entry,
            phone,
            source: 'telegram',
            otpProvider: 'telegram',
            sourceMode: 'telegram',
            telegramBotUsername: entry.telegramBotUsername || state.telegramBotUsername || telegramCfg?.botUsername || '',
            noPatch: true,
          },
          lastActivityMs: Date.now(),
          windowMs: telegramOtpTimeoutMs,
          checkedAt: Date.now(),
          onlineFallback: true,
          telegram: true,
        };
        if (state.fresh + activePhones.size >= target) return { status: 'waiting', waitMs: 500 };
        if (!claimPickedEntry(picked.entry)) return { status: 'waiting', waitMs: 250 };
        removeRetryLaterPhone(picked.entry.phone);
        return { status: 'picked', picked };
      }
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
          if (usablePoolCount() <= 0) {
            if (await tryRotateRunSource(pool.length ? 'no-usable-fresh-candidate' : 'empty-pool')) continue;
            return { status: 'exhausted' };
          }
          const hasNextRunSource = runSourceIndex >= 0 && runSourceIndex < runSources.length - 1;
          const waitPassLimit = noEvidenceWaitPassLimit({ hasNextSource: hasNextRunSource });
          if (state.poolFresh > 0 && freshWaitRounds < waitPassLimit) {
            const now = Date.now();
            if (now < freshWaitUntil) return { status: 'waiting', waitMs: Math.max(250, freshWaitUntil - now) };
            freshWaitRounds++;
            const candidateStates = formatScanCandidateStates(state);
            await push(progressCard(section('🕐 Fresh Device Ka Wait', [
              `› Pass ${state.scanPass || 1} ke <b>${state.scanUniqueChecked || 0}/${state.scanTotalDevices || 0}</b> unique devices me koi usable last-activity timestamp ya ONLINE fallback nahi mila.`,
              candidateStates ? `› Candidate devices: <b>${esc(candidateStates)}</b>.` : '',
              `› Total probes: ${state.scanTotalProbes || state.scanChecked || 0} (repeated passes sameet). 15s ruk kar ek naya pass karunga (round ${freshWaitRounds}/${waitPassLimit}).`,
              sub(hasNextRunSource
                ? 'Is retry pass me bhi saboot na mila to isi source par 40 passes nahi ghumunga — agla ACTIVE Firebase source try hoga.'
                : 'Timestamp wala device hota to isi pass par window double karke use le liya jata — dobara scan sirf nayi activity ke intezaar ke liye hai.'),
            ].filter(Boolean).join('\n'))), stopRows());
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
          if (await tryRotateRunSource('SMS timestamp ya ONLINE device nahi mila')) continue;
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
            if (!fresh.length) {
              if (await tryRotateRunSource(pool.length ? 'no-usable-fresh-candidate' : 'empty-pool')) continue;
              return { status: 'exhausted' };
            }
            picked = { entry: fresh[0] };
          }
        } else {
          picked = { entry: fresh[0] };
        }
      }

      if (!picked?.entry) {
        if (activePhones.size) return { status: 'waiting', waitMs: 1_000 };
        if (await tryRotateRunSource(pool.length ? 'no-usable-fresh-candidate' : 'empty-pool')) continue;
        return { status: 'exhausted' };
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
    }
    });

    // Pehla scan yahin — WAF warm-up ke parallel me hi (ensureWarm pehle
    // OTP se pehle token confirm karega).
    if (!telegramMode && gateOn) await refillHotQueue();

    // Distinct routes tay hone ke baad asal lane count final karo. Free
    // auto-fetch pool/scan ke parallel chal raha tha; uske baghair lanes
    // ko pata hi nahi chalta kitni alag IPs asal me available hain.
    await freeStartPromise;
    ps = proxyPool.proxySummary();
    laneCount = effectiveAutopilotLanes({
      sourceMode,
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
      routePrepNoticeAt: 0,
      rawRouteOkKey: '',
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
      let restartWorker = true;
      while (restartWorker && !state.stopRequested) {
        restartWorker = false;
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
          if (state.consecutiveFails >= failLimit) {
            if (telegramMode) {
              // Hermes-only batch ko generic fail streak par force-stop
              // nahi karna. Ye sirf recovery checkpoint hai: counters reset,
              // chhota saans, phir NEW NUMBER se kaam jaari. Target/max-time/
              // manual STOP hi batch khatam karenge.
              state.consecutiveFails = 0;
              lane.consecutiveFails = 0;
              state.workerRecoveries = (state.workerRecoveries || 0) + 1;
              await push(progressCard(section('↻ Recovery Checkpoint', [
                'Lagatar failures aaye — batch band nahi ho raha.',
                'Route recovery ke baad NEW NUMBER se kaam jaari rahega.',
              ].join('\n'))), stopRows());
              await sleep(2_000, () => state.stopRequested);
              continue;
            }
            requestRunEnd('circuit_breaker');
            break;
          }

          if (!ensureLaneRoute(lane)) {
            await waitForRouteChange(1_000);
            continue;
          }
          // Hermes number claim karne se pehle is lane ki IP/WAF haalat
          // tayyar karo. Route ready na ho to FIND/NEW bilkul nahi chalega.
          if (telegramMode && !(await prepareLaneRouteBeforeClaim(lane))) {
            await waitForRouteChange(1_000);
            continue;
          }

          // One-shot OTP rule: pichhla Hermes number kabhi pending retry
          // se wapas nahi aayega. Har asal claim NEW NUMBER se hoga.
          const claim = await claimNextPick();
          if (claim.status === 'target') { requestRunEnd('target'); break; }
          if (claim.status === 'stopped') break;
          if (claim.status === 'waiting') {
            await sleep(claim.waitMs || 1_000, () => state.stopRequested);
            continue;
          }
          if (claim.status === 'claim-retry') {
            await push(progressCard(section('↻ Hermes Retry', [
              'NEW NUMBER abhi nahi mila — batch band nahi ho raha.',
              `Chhota wait ke baad dobara try hoga. ${esc(truncateUiText(claim.error || state.lastError || '', 90))}`,
            ].join('\n'))), stopRows());
            await sleep(claim.waitMs || 2_000, () => state.stopRequested);
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
      // Route-prep/gap ke dauran pichhle number par laga stale SKIP
      // naye current number ki card/state ko confuse na kare. Kisi aur
      // lane ka asal active target ho to use bilkul mat chhuo.
      if (
        state.skipRequestedPhone
        && state.skipRequestedPhone !== entry.phone
        && !activePhones.has(state.skipRequestedPhone)
      ) {
        clearAutopilotSkipRequest(state.skipRequestedPhone);
      }
      const manualSkipResult = () => ({
        ok: false,
        kind: 'manual_skip',
        phone: entry.phone,
        stage: 'engine',
        manualSkip: true,
        reason: 'Owner ne current number SKIP kar diya',
      });

      // Card par foran saaf dikhao ke scan ruk chuka hai aur asal number
      // process ho raha hai. Warna WAF warm-up / OTP wait ke dauran purana
      // scan card dekh kar bot atka hua lagta tha.
      if (picked.lastActivityMs || picked.onlineFallback) {
        const pickedAgeMs = picked.lastActivityMs
          ? Math.max(0, Date.now() - Number(picked.lastActivityMs))
          : null;
        await push(progressCard(section(
          '📟 Device Mil Gaya — Number Process Shuru',
          [
            `📱 <b>Number:</b> <code>${esc(entry.phone)}</code> · lane ${lane.id} · ${esc(lane.proxy?.label || 'direct')}`,
            picked.onlineFallback
              ? '› Quick scan me taaza SMS activity nahi mili — Firebase <b>clients me ONLINE</b> dikh raha device liya hai. Full pool scan ka wait nahi kiya.'
              : `› Device ki last SMS activity ~${fmtDuration(pickedAgeMs || 0)} purani · ladder ≤${fmtDuration(Math.max(Number(otpCfg.activeWindowMs) || 0, Number(picked.windowMs) || 0))} · queue me ${hotQueue.length} backup(s).`,
            sub('Is lane par ab WAF/OTP flow chalega; baaki lanes apna kaam jaari rakhengi. Processed count result aate hi badhega.'),
          ].join('\n'))), stopRows());
      }

      // WAF warm-up background me chal raha tha — pehla OTP iske baghair na jaye.
      // Owner ne isi beech SKIP kar diya ho to warm-up ka wait bhi mat karo.
      if (!isAutopilotSkipRequested(entry.phone)) await ensureWarm();

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
      const rawRes = isAutopilotSkipRequested(entry.phone)
        ? manualSkipResult()
        : await runWithBridgeProxy(lane.proxy || null, async () => {
          try {
            return await processSingleNumber({
              userId: lane.userId,
              entry,
              otpCfg: numCfg,
              shouldAbort: () => state.stopRequested || isAutopilotSkipRequested(entry.phone),
              shouldSkip: () => isAutopilotSkipRequested(entry.phone),
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
      // SKIP kisi lambay bridge step ke bilkul aakhir me aaya ho tab bhi
      // tally se pehle manual outcome hi jeetega — ye number fresh count
      // ya instant JSON me nahi jayega.
      const res = isAutopilotSkipRequested(entry.phone) && !state.stopRequested
        ? manualSkipResult()
        : rawRes;
      syncLaneRouteAfterProcess(lane, finalProxy);
      const finalProxyId = finalProxy?.id || '';

      setLaneCurrent(lane, null);
      const outcome = tally(res);
      // Route asal Swiggy response tak gayi ho (OTP send/verify paar) to
      // use raw-proven rakho: solver fail/cooldown ke bawjood agli claim
      // par wahi sticky IP chalegi. Infra outcome par proof khatam —
      // route ab garam/bad mani jayegi aur recovery/rotation chalegi.
      const routeReachedSwiggy = ['ok', 'skipped', 'deferred', 'failed'].includes(outcome) &&
        !['failed_exception', 'failed_bad_entry'].includes(String(res?.kind || ''));
      if (routeReachedSwiggy) {
        lane.rawRouteOkKey = finalProxyId ? `proxy:${finalProxyId}` : 'direct';
      } else if (['swiggy_transient', 'security_challenge', 'rate_limited', 'waf_cooldown'].includes(outcome)) {
        lane.rawRouteOkKey = '';
      }
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
      // One-shot OTP / manual SKIP: is phone ko isi run ki har queue aur
      // claim filter se consumed kar do. Neeche wali route recovery ab
      // sirf agle NEW number ke liye hai.
      const oneShotOtpFailure = isOneShotOtpFailureResult(res);
      if (oneShotOtpFailure && res.phone) {
        otpFailedThisRun.add(res.phone);
        if (telegramMode) telegramRejectedThisRun.add(res.phone);
        purgeQueuedPhone(res.phone);
      }
      if (outcome === 'manual_skip' && res.phone) {
        manualSkippedThisRun.add(res.phone);
        if (telegramMode) telegramRejectedThisRun.add(res.phone);
        purgeQueuedPhone(res.phone);
      }
      if (telegramMode) state.telegramRejected = telegramRejectedThisRun.size;
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
              : res.kind === 'manual_skip'
                ? '⏭ Number SKIP'
                : oneShotOtpFailure
                  ? '⚡ OTP Fail — New Number'
                  : res.kind === 'skipped_delete_blocked'
                    ? '⚠️ Skipped'
                    : res.kind === 'aborted'
                      ? '⏹ Aborted'
                      : res.kind === 'deferred_swiggy_transient'
                        ? '↻ Temporary Swiggy Error — Route Recovery'
                        : '× Result',
            [
            `📱 <b>Number:</b> <code>${esc(res.phone)}</code> · lane ${lane.id} · ${esc(lane.proxy?.label || 'direct')}`,
            `› <b>Outcome:</b> <code>${esc(res.kind)}</code>`,
            res.reason ? `<blockquote>${esc(String(res.reason).slice(0, 300))}</blockquote>` : '',
          ].filter(Boolean).join('\n'))
        ), stopRows());
      }

      // Engine-level reactions — "rukna hi na pare":
      //   rate-limit/WAF → TURANT proxy badal (nayi IP), lekin OTP-failed
      //   number defer nahi hoga. Sirf tab ruk jab saare proxies side par.

      // Owner SKIP: sirf ye number khatam, batch bina gap agle number par.
      if (outcome === 'manual_skip') {
        clearAutopilotSkipRequest(res.phone || entry.phone);
        continue;
      }

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

      // Swiggy/proxy temporary 5xx ya network error par route turant
      // rotate hogi, lekin OTP-stage failure wala number one-shot rule
      // se isi run me khatam hai — recovery agle NEW number ke liye hai.
      if (outcome === 'swiggy_transient') {
        const attempt = (transientAttemptsThisRun.get(res.phone) || 0) + 1;
        if (res.phone) transientAttemptsThisRun.set(res.phone, attempt);
        const infra = recordInfraAttempt(res.phone);
        const willRetry = Boolean(res.phone && attempt < 2 && infra.willRetry && !oneShotOtpFailure);
        if (willRetry && !telegramMode) deferNumber(entry, 'swiggy_transient');
        if (finalProxyId) {
          try { proxyPool.markProxyTransientFailure(finalProxyId, 60_000); } catch {}
        }

        let next = null;
        if (ps.enabled) {
          next = rotateLaneProxy(lane, finalProxyId, { countRotation: true });
        }

        const needsCoolOff = !next || (state.transientStrikes || 0) >= 3;
        const waitMs = needsCoolOff ? transientSwiggyRetryWaitMs(state.transientStrikes) : 0;
        await push(progressCard(section('↻ Temporary Error — Route Recovery', [
          `› ${res.httpStatus ? `HTTP ${res.httpStatus}` : 'Network/5xx'} temporary error — ye number <b>one-shot OTP rule</b> se khatam hai.`,
          telegramMode
            ? '› Route ready karke seedha NEW NUMBER aayega — isi number par dusra try nahi hoga.'
            : '› Route recovery ke baad agla naya number aayega — isi number par dusra OTP try nahi hoga.',
          next
            ? `› Proxy rotate kar diya: <code>${esc(next.label)}</code> (rotation #${state.proxyRotations})`
            : `› Doosri proxy available nahi — isi IP par cool-off ke baad aage badhunga.`,
          waitMs
            ? `› Lagatar ${state.transientStrikes} temporary errors — sirf lane ${lane.id} ${Math.round(waitMs / 1000)}s cool-off legi, baaki lanes chalti rahengi.`
            : '› Nayi IP par turant agla number — batch nahi rukega.',
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
        // OTP failure wala number defer nahi hoga; nayi IP sirf agle
        // NEW number ke liye ready ki jayegi.
        const rateInfra = recordInfraAttempt(res.phone);
        if (res.phone && rateInfra.willRetry && !oneShotOtpFailure && !telegramMode) deferNumber(entry, 'rate_limited');

        if (ps.enabled) {
          const before = finalProxyId;
          const next = rotateLaneProxy(lane, before, { countRotation: true });
          if (next) {
            await push(progressCard(section('🔀 Rate Limit — Proxy Rotate (zero wait)', [
              `› IP ko limit lagi — nayi IP (proxy) le liya: <code>${esc(next.label)}</code>`,
              telegramMode
                ? '› Ye Hermes number one-shot OTP rule se khatam — agla number NEW NUMBER se aayega.'
                : '› Ye number one-shot OTP rule se khatam — nayi IP par agla naya number aayega.',
              `› Strike ${state.rateStrikes} — lane ${lane.id} nayi IP par, baaki lanes unaffected.`,
            ].join('\n'))), stopRows());
            state.consecutiveFails = 0;
            lane.consecutiveFails = 0;
            continue; // turant agla number — ZERO wait
          }
        }

        // Direct mode (koi proxy nahi) — fast recovery: pehla retry 15s,
        // doosra 30s. Number minuteon queue me nahi fasega. Hermes mode me
        // 3 strikes sirf recovery checkpoint hai — batch force-stop nahi.
        if (state.rateStrikes >= 3) {
          if (!telegramMode) { requestRunEnd('rate_limited'); break; }
          state.rateStrikes = 1;
          state.workerRecoveries = (state.workerRecoveries || 0) + 1;
        }
        const backoff = rateLimitRecoveryWaitMs(state.rateStrikes, backoffMs);
        void proxyPool.ensureFreeProxies?.({ min: 12, want: FREE_PROXY_TARGET_COUNT }).then((r) => {
          if (r?.added) ps = proxyPool.proxySummary();
        }).catch(() => {});
        await push(progressCard(section('🚦 Swiggy Rate Limit — 15s Fast Recovery', [
          `› Sirf lane ${lane.id} ~${Math.max(1, Math.round(backoff / 1000))}s ruk kar nayi IP/token se aage badhegi (strike ${state.rateStrikes}/3); baaki lanes chalti rahengi.`,
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
        if (state.wafCooldowns > wafCooldownLimit) {
          if (!telegramMode) { requestRunEnd('waf_stuck'); break; }
          // Cumulative counter Hermes run ko safalta ke baghair bhi sirf
          // waqt guzarne par maar sakta tha. Ise recovery checkpoint rakho.
          state.wafCooldowns = 0;
          state.workerRecoveries = (state.workerRecoveries || 0) + 1;
        }
        const wafInfra = recordInfraAttempt(res.phone);
        if (res.phone && wafInfra.willRetry && !oneShotOtpFailure && !telegramMode) deferNumber(entry, 'waf_cooldown');

        // Fast recovery: ek wait kabhi 15s se zyada nahi. Uske baad nayi
        // IP/token se asal retry hoga; purani 5-minute neend result ko
        // slow aur inconsistent banati thi.
        const cdMs = fastRouteRecoveryCapMs(res.cooldownMs, FAST_ROUTE_RECOVERY_MS);
        maybeRefillFreeProxies();
        await push(progressCard(section('🛡 WAF Cooling — 15s Fast Recovery', [
          `› Swiggy ki WAF abhi lane ${lane.id} ki IP ko garam bol rahi hai — sirf ~${Math.max(1, Math.round(cdMs / 1000))}s me nayi IP/token try hogi; baaki lanes chalti rahengi.`,
          telegramMode
            ? '› Ye Hermes number one-shot OTP rule se khatam — batch zinda hai, agla number NEW NUMBER se aayega.'
            : '› Ye number one-shot OTP rule se khatam — batch zinda hai, route recovery ke baad naya number aayega.',
          sub('Proxies add karoge to ye wait ghat kar seconds me aa jayegi (nayi IP = turant aage).'),
        ].join('\n'))), stopRows());
        await sleep(cdMs, () => state.stopRequested);
        if (state.stopRequested) { endReason = state.stopReason || 'manual'; break; }
        const rotated = rotateLaneProxy(lane, '', { countRotation: true }); // is lane ke liye jo bhi free hua, use le lo
        if (!rotated) {
          // Koi proxy free nahi bachi (free wali jaldi marti hain) — background
          // me nayi free proxies le aao, batch ko roke baghair.
          void proxyPool.refreshFreeProxies({ want: FREE_PROXY_TARGET_COUNT }).then((r) => {
            if (r?.added) { ps = proxyPool.proxySummary(); console.log(`[Autopilot] 🌐 ${r.added} free proxies aa gayin (clean ${r.keptClean || 0}, WAF-ready ${r.keptChallenged || 0}).`); }
          }).catch(() => {});
        }
        state.consecutiveFails = 0;
        lane.consecutiveFails = 0;
        continue;
      }

      // Security challenge (403) — batch NAHI marta. OTP-failed number
      // khatam karke IP ko thanda hone do, naya token lo aur aage badho. Ek success par strikes
      // reset (tally me) — isliye milawat wali run kabhi is par nahi rukti.
      // Sirf bahut lagatar (bina ek bhi processed outcome ke) challenges
      // par roko. Parallel lanes me limit lane-count ke hisaab se scale
      // hoti hai taaki pehli 10-lane wave hi batch ko premature na mare.
      // (Pehle: 4 par seedha batch band — boss ki sab se bari dikkat yahi thi.)
      if (outcome === 'security_challenge') {
        state.wafStrikes++;
        state.lastError = `security challenge ×${state.wafStrikes}`;
        const securityInfra = recordInfraAttempt(res.phone);
        if (res.phone && securityInfra.willRetry && !oneShotOtpFailure && !telegramMode) deferNumber(entry, 'security_challenge');
        const numberRetryLine = telegramMode
          ? 'Ye Hermes number one-shot OTP rule se khatam — route ready karke NEW NUMBER aayega.'
          : 'Ye number one-shot OTP rule se khatam — route recovery ke baad naya number aayega.';
        if (state.wafStrikes >= securityStormLimit) {
          if (!telegramMode) { requestRunEnd('security_challenge'); break; }
          // Hermes lane ke liye security storm bhi recovery checkpoint hai;
          // route rotation/cooldown neeche chalega, batch force-stop nahi.
          state.wafStrikes = 1;
          state.workerRecoveries = (state.workerRecoveries || 0) + 1;
        }

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
              if (!info || !info.cooldownLeftMs) proxyPool.markProxyWafHit(currentId, 120_000);
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
          void proxyPool.refreshFreeProxies({ want: FREE_PROXY_TARGET_COUNT }).then((r) => {
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
            continue; // agla NEW number nayi IP par; ye phone consumed hai
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
        await push(progressCard(section('🛡 Swiggy Security Check — 15s Fast Recovery', [
          `› Lane ${lane.id} ko challenge mila — direct IP abhi garam hai.`,
          `› Sirf ye lane max ~15s me fresh WAF token ke saath wapas ayegi; baaki lanes chalti rahengi. ${numberRetryLine}`,
          sub(ps.enabled
            ? 'Ek aur direct challenge par best proxy route dobara try hogi.'
            : 'Batch nahi rukega. Ek success milte hi ye ginti reset ho jati hai.'),
        ].join('\n'))), stopRows());
        // Wait aur 15s-cap wala token solve saath chalao — warna 15+15
        // hokar recovery phir slow ho jayegi.
        const fastSolvePromise = solveLaneToken(lane, true, WAF_SOLVE_FAST_BUDGET_MS);
        await sleep(waitMs, () => state.stopRequested);
        if (state.stopRequested) { endReason = state.stopReason || 'manual'; break; }
        await fastSolvePromise;
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
          if (state.proxyRotations > rotationLimit) {
            if (!telegramMode) { requestRunEnd('circuit_breaker'); break; }
            state.proxyRotations = 0;
            state.workerRecoveries = (state.workerRecoveries || 0) + 1;
          }
          await push(progressCard(section('🔀 Fail Streak — Proxy Rotate', [
            `› Lane ${lane.id} par ${laneFailStreak} lagatar failures — IP issue lag raha hai.`,
            `› Sirf is lane ki nayi IP: <code>${esc(next.label)}</code> (rotation #${state.proxyRotations}/${rotationLimit})`,
            sub('Baaki lanes apni IPs par chalti rahengi.'),
          ].join('\n'))), stopRows());
          continue;
        }
      }

      // Gap between numbers — per-lane/per-IP hai, global nahi. Hermes
      // single-lane me OTP fail ke baad 6-9s ki fuzool neend speed marti
      // thi: wahan sirf success par max 1s, baaki outcomes par zero gap.
      if (state.fresh < target && !state.stopRequested) {
        const baseGapMs = nextNumberGapMs({
          telegramMode,
          outcome,
          configuredGapMs: gapMs,
        });
        const jitter = telegramMode ? 0 : Math.floor(Math.random() * 3_000);
        if (baseGapMs + jitter > 0) {
          await sleep(baseGapMs + jitter, () => state.stopRequested);
        }
      }
          } finally {
            const endingPhone = lane.currentEntry?.phone || '';
            if (endingPhone && isAutopilotSkipRequested(endingPhone)) {
              manualSkippedThisRun.add(endingPhone);
              purgeQueuedPhone(endingPhone);
              clearAutopilotSkipRequest(endingPhone);
            }
            setLaneCurrent(lane, null);
            if (lane.currentEntry) releaseClaimedEntry(lane.currentEntry);
            lane.currentEntry = null;
            notifyRouteChanged();
          }
        }
      } catch (err) {
        console.error(`[Autopilot] Lane ${lane.id}:`, err?.stack || err?.message);
        state.lastError = String(err?.message || err).slice(0, 240);
        // Ek iteration ka unexpected error poori run/lane ko force-stop na
        // kare. Current entry finally me release hogi; worker fresh state
        // ke saath dobara chalega. Manual STOP/time/target par restart nahi.
        state.workerRecoveries = (state.workerRecoveries || 0) + 1;
        restartWorker = Boolean(
          !state.stopRequested
          && state.fresh < target
          && Date.now() - state.startedAt <= maxMinutes * 60_000
        );
        if (restartWorker) {
          try {
            await push(progressCard(section('↻ Worker Recovery', [
              'Ek temporary error aaya — batch band nahi ho raha.',
              `Worker khud restart hokar agla step lega. ${esc(truncateUiText(state.lastError, 90))}`,
            ].join('\n'))), stopRows());
          } catch {}
          await sleep(1_500, () => state.stopRequested);
        }
      } finally {
        if (lane.currentEntry) releaseClaimedEntry(lane.currentEntry);
        lane.currentEntry = null;
        setLaneCurrent(lane, null);
        releaseLaneRoute(lane);
      }
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
    endReason = telegramMode ? 'telegram' : 'firebase';
    try {
      await push(section('× Autopilot Fatal Error', [
        `<blockquote>${esc(state.lastError)}</blockquote>`,
        sub('Console/logs me details. Config check karke dobara start karein.'),
      ].join('\n')), doneRows());
    } catch {}
  } finally {
    try { proxyPool._clearProxyReservations(); } catch {}
    // Run ke andar fallback source laga ho to saved ACTIVE wapas lagao —
    // agli manual/diag call user ki asal choice se hi chalni chahiye.
    // Snapshot ke poolSource* fields final summary ke liye waise hi rahenge.
    if (!telegramMode) { try { applyActiveSource(); } catch {} }
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
