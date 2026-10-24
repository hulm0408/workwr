// ===== 👑 AUTOPILOT ENGINE — ek START, apne aap poora batch =====
//
// Boss START dabata hai → engine pool se number uthata, processSingleNumber chalata,
// gap + backoff manage karta, STOP/time/target pe ruk jata hai — aur har stage ka
// status LIVE card par edit karta rehta hai. Boss60 minute baad aakar summary dekhta hai.
//
// Env knobs:
//   PREMIUM_BATCH_TARGET            — kitne fresh sessions (default 100)
//   PREMIUM_BATCH_MAX_MINUTES       — max run time (default 120)
//   PREMIUM_BATCH_GAP_MS            — do numbers ke beech gap (default 15000)
//   PREMIUM_RATE_LIMIT_BACKOFF_MS   — Swiggy rate-limit par ruk (default 15 min)
//   PREMIUM_ALLOW_OFFLINE_DEVICES   — '1' = offline devices bhi try karo
//   PREMIUM_OTP_WAIT_MS             — pehle wait (default 10000 = uske 10s)
//   PREMIUM_OTP_TIMEOUT_MS          — inbox poll budget (default 90000)
//
// Engine process-singleton hai: dono bots (main + autopilot) isi state ko dekhte hain.

import { isFirebaseConfigured, firebaseSetupHintLines, listPoolNumbers } from './firebase-numbers.js';
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
  proxyRotations: 0,
  deferredQueue: 0,
  consecutiveFails: 0,
  current: null,          // { phone, startedAt }
  history: [],            // { phone, kind, reason? } (last 200)
  freshAccounts: [],      // { phone, accountKey } (successful sessions)
  lastError: '',
  poolTotal: 0,
  poolFresh: 0,
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
    proxyRotations: state.proxyRotations,
    deferredQueue: state.deferredQueue,
    currentProxy: getBridgeProxy()?.label || '',
    current: state.current ? { ...state.current } : null,
    poolTotal: state.poolTotal,
    poolFresh: state.poolFresh,
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
      ? field('🛡 WAF', `${state.wafCooldowns} cooldown · challenges: ${state.wafStrikes} · rotations: ${state.proxyRotations}`)
      : '',
    pSummary?.enabled
      ? field('🔀 Proxy', `${getBridgeProxy()?.label || '—'}  ·  ${pSummary.enabledCount} ON  ·  rotates: ${state.proxyRotations}`)
      : field('🔀 Proxy', 'OFF (ek hi IP — ⚙️ Settings me add karo)'),
    field('Pool', `${state.poolFresh} fresh / ${state.poolTotal} numbers`),
    state.current
      ? `📍 <b>Abhi:</b> <code>${esc(state.current.phone)}</code> (${fmtDuration(Date.now() - state.current.startedAt)})`
      : sub('Agla number select ho raha hai…'),
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
        `1️⃣ Firebase pool se number uthata hai (online devices pehle)`,
        `2️⃣ Swiggy OTP → <b>10s wait</b> → OTP khud padh kar paste`,
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
    security_challenge: '🛡 Swiggy ne 4 lagatar security challenges diye (saare proxies flagged) — proxies badal kar dobara start karein.',
    waf_stuck: '🛡 20 baar saare proxies WAF cooldown me rahe — zyada proxies add karke dobara start karein.',
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
    sub('Saare sessions bot DB + cloud vault me saved hain (Connected Accounts / Export JSON).'),
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
    : s('gapMs', envInt('PREMIUM_BATCH_GAP_MS', 15_000));
  const backoffMs = s('backoffMs', envInt('PREMIUM_RATE_LIMIT_BACKOFF_MS', 15 * 60_000));
  const allowOffline = s('allowOffline', String(process.env.PREMIUM_ALLOW_OFFLINE_DEVICES || '') === '1') === true;
  const otpCfg = {
    waitMs: s('otpWaitMs', envInt('PREMIUM_OTP_WAIT_MS', 10_000)),
    timeoutMs: s('otpTimeoutMs', envInt('PREMIUM_OTP_TIMEOUT_MS', 90_000)),
    pollMs: 2_500,
    acceptAnyAfterMs: 30_000,
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
    rateStrikes: 0, wafStrikes: 0, wafCooldowns: 0, consecutiveFails: 0, proxyRotations: 0,
    current: null, history: [], freshAccounts: [], lastError: '',
    poolTotal: 0, poolFresh: 0,
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

    state.processed++;
    state.history.push({ phone: res.phone, kind: res.kind, reason: res.reason || '', at: new Date().toISOString() });
    if (state.history.length > 200) state.history.splice(0, state.history.length - 200);

    if (res.ok) {
      state.fresh++;
      if (res.kind === 'fresh_new') state.freshNew++;
      if (res.kind === 'fresh_after_delete') state.freshAfterDelete++;
      state.freshAccounts.push({ phone: res.phone, accountKey: res.accountKey });
      state.consecutiveFails = 0;
      state.wafStrikes = 0;   // ek success = WAF "storm" khatam
      return 'ok';
    }
    switch (res.kind) {
      case 'skipped_delete_blocked': state.skipped++; state.consecutiveFails = 0; return 'skipped';
      case 'deferred_delete_otp_miss': state.deferred++; state.consecutiveFails = 0; return 'deferred';
      case 'aborted': state.aborted++; return 'aborted';
      case 'rate_limited': state.rateStrikes++; return 'rate_limited';
      case 'security_challenge': return 'security_challenge';
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
    const ps = proxyPool.proxySummary();
    await push(section('🔥 Warm-up', [
      ps.enabled
        ? `🔀 Proxy pool: ${ps.enabledCount}/${ps.total} proxies ON — ${ps.rotation}`
        : `🔀 Proxy pool: OFF (ek hi IP) — ⚙️ Settings me proxy add karne par rukna bilkul band.`,
      'Swiggy WAF token arrange kar raha hoon (ek baar, ~15s)…',
      sub('Iske baad saari requests protected jaengi.'),
    ].join('\n')), stopRows());

    // Proxy assign — pehli enabled proxy (round-robin se). WAF token bhi
    // usi IP ke liye arrange hoga.
    const rotateProxy = (excludeId = '') => {
      if (!proxyPool.isEnabled()) return null;
      const next = proxyPool.pickProxy(excludeId ? { excludeIds: [excludeId] } : {});
      if (next) {
        setBridgeProxy(next);
        console.log(`[Autopilot] Proxy → ${next.label}`);
        return next;
      }
      return null;
    };
    if (ps.enabled) rotateProxy();

    let wafTok = '';
    try {
      wafPool.loadFromDb?.();
      wafTok = await getLiveSwiggyWafToken();
      console.log(wafTok ? '[Autopilot] WAF token ready (warm start).' : '[Autopilot] WAF token nahi mila (Chromium?) — raw mode me chalega.');
    } catch (e) {
      console.warn('[Autopilot] WAF warm-up skipped:', e?.message);
    }
    // Chrome hi nahi mila aur saved token bhi nahi → har OTP par 403 pakki
    // hai. Pehle ye sirf console me chup chaap reh jata tha aur user ko
    // lagta tha "bot work nahi kar raha" — ab Telegram card par saaf btao.
    if (!wafTok) {
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

    // 🔁 Retry-later queue — rate-limit/WAF se atke numbers yahan jate hain
    // aur batch ke aage ISSI run me dobara try hote hain (batch na rukne ke liye).
    const retryLater = []; // { entry, attempts, why }
    const deferNumber = (entry, why) => {
      if (!entry?.phone) return;
      if (retryLater.some((r) => r.entry.phone === entry.phone)) return;
      retryLater.push({ entry, attempts: 0, why });
      console.log(`[Autopilot] Deferred (${why}): ${entry.phone} — will retry in this run.`);
    };

    await push(idleCard(), stopRows());

    // Pool load (bada node — ek baar, zarurat par refresh)
    let pool = [];
    let poolLoadedAt = 0;
    const loadPool = async () => {
      pool = await listPoolNumbers();
      poolLoadedAt = Date.now();
      state.poolTotal = pool.length;
      return pool;
    };

    await loadPool();

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
    // Isi run me jo devices last-seen gate par stale nikle — dobara-dobara
    // unhi ko probe na karo. "Fresh device ka wait" round me clear hota hai
    // (device beech me zinda ho sakta hai).
    const staleThisRun = new Set(); // phone
    let freshWaitRounds = 0;
    const pickFreshList = () => {
      let list = preferOnline(freshEntriesFrom(pool)).filter(underFailCap).filter((e) => !staleThisRun.has(e.phone));
      if (!allowOffline) {
        const onlineOnly = list.filter((e) => e.online !== false);
        if (onlineOnly.length) list = onlineOnly;
      }
      return list;
    };

    for (;;) {
      if (state.stopRequested) { endReason = state.stopReason || 'manual'; break; }
      if (Date.now() - state.startedAt > maxMinutes * 60_000) { endReason = 'time'; break; }
      if (state.fresh >= target) { endReason = 'target'; break; }
      // Circuit breaker — proxy hone par zyada failures jhel sakte hain
      // (rotation se IP issue solve ho sakta hai), direct mode me 6.
      const failLimit = ps.enabled ? 10 : 6;
      if (state.consecutiveFails >= failLimit) { endReason = 'circuit_breaker'; break; }

      let fresh = pickFreshList();
      state.poolFresh = fresh.length;
      if (fresh.length) freshWaitRounds = 0;

      if (!fresh.length) {
        // Pool khali? Pehle retry-later queue check (ISI run me dobara).
        if (retryLater.length) {
          const r = retryLater.shift();
          fresh = [r.entry];
          state.poolFresh = 0;
        } else {
          await refreshIfStale();
          fresh = pickFreshList();
          state.poolFresh = fresh.length;
          if (!fresh.length) {
            // Numbers bache hain lekin sab ke devices abhi stale (last-seen
            // window se bahar) — batch band karne ki jagah thodi der ruk kar
            // dobara dekho, koi device zinda ho sakta hai. Max ~30 rounds
            // (20s each ≈ 10 min), phir hi pool-exhausted.
            const ledgerFreshLeft = freshEntriesFrom(pool).length;
            if (ledgerFreshLeft > 0 && freshWaitRounds < 30) {
              freshWaitRounds++;
              await push(progressCard(section('🕐 Fresh Device Ka Wait', [
                `› Abhi koi device last-seen window (≤${Math.round((otpCfg.activeWindowMs || 60000) / 1000)}s) me active nahi mila.`,
                `› ${state.staleSkips || 0} stale devices chhaante gaye — 20s ruk kar pool dobara check karunga (round ${freshWaitRounds}/30).`,
                sub('Andhere me mare hue devices par OTP waste nahi hoga.'),
              ].join('\n'))), stopRows());
              await sleep(20_000, () => state.stopRequested);
              if (state.stopRequested) { endReason = state.stopReason || 'manual'; break; }
              staleThisRun.clear();
              try { await loadPool(); } catch (e) { state.lastError = e?.message || 'pool reload fail'; }
              continue;
            }
            // Pool khali + retry-later bhi khali → tabhi khatam
            endReason = 'pool-exhausted';
            break;
          }
        }
      }

      const entry = fresh[0];
      state.current = { phone: entry.phone, startedAt: Date.now() };

      const res = await processSingleNumber({
        userId,
        entry,
        otpCfg,
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
          section(res.ok ? '✅ Number Done' : (res.kind === 'skipped_delete_blocked' ? '⚠️ Skipped' : (res.kind === 'aborted' ? '⏹ Aborted' : '× Result')), [
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

      if (outcome === 'rate_limited') {
        // NOTE: rateStrikes tally() me already badhta hai — yahan dobara ++
        // karne se 3-strike wali limit 2 hits par hi band ho jati thi.
        // Number defer — isi run me aakhir me dobara try hoga
        if (res.phone) deferNumber(entry, 'rate_limited');

        if (ps.enabled) {
          const before = getBridgeProxyId();
          const next = rotateProxy(before);
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

      // WAF cooldown — bridge ne request bhejne se mana kiya (sare proxies
      // side par). Number untouched; proxy free hote hi dobara.
      if (outcome === 'waf_cooldown') {
        state.wafCooldowns++;
        if (state.wafCooldowns > 20) { endReason = 'waf_stuck'; break; }
        if (res.phone) deferNumber(entry, 'waf_cooldown');

        // Pehle try: koi proxy free hua? (thoda wait, phir rotate)
        const cdMs = Math.min(Number(res.cooldownMs) || 120_000, 3 * 60_000);
        await push(progressCard(section('🛡 All Proxies Cooling — Short Wait', [
          `› Saare proxies WAF cooldown me. ${Math.round(cdMs / 60000)} min ruk kar nayi IP se aage.`,
          `› Hit #${state.wafCooldowns}/20 — number defer ho chuka hai (baad me dobara).`,
          sub('Zyada proxies add karoge to ye wait kabhi na aayegi.'),
        ].join('\n'))), stopRows());
        await sleep(cdMs, () => state.stopRequested);
        if (state.stopRequested) { endReason = state.stopReason || 'manual'; break; }
        rotateProxy(); // jo bhi free hua, use le lo
        state.consecutiveFails = 0;
        continue;
      }

      // Security challenge (403) — batch NAHI rukta. Proxy turant badal +
      // usi number par retry. Sirf 3 lagatar = IP flagged (proxy hi nahi badle).
      if (outcome === 'security_challenge') {
        state.wafStrikes++;
        state.lastError = `security challenge ×${state.wafStrikes}`;
        if (state.wafStrikes >= 4) { endReason = 'security_challenge'; break; }

        if (ps.enabled) {
          const before = getBridgeProxyId();
          const next = rotateProxy(before);
          if (next) {
            await push(progressCard(section('🔀 Security Challenge — Proxy Rotate + Retry', [
              `› Challenge mila (strike ${state.wafStrikes}/4) — nayi IP: <code>${esc(next.label)}</code>`,
              `› WAF token naya arrange kar raha hoon…`,
              sub('Batch nahi rukega — nayi IP par isi number ko dobara try karunga.'),
            ].join('\n'))), stopRows());
            try { await getLiveSwiggyWafToken(); } catch {}
            state.consecutiveFails = 0;
            continue; // wahi number dobara (nayi IP + naya token)
          }
        }

        // Direct mode — token refresh + chhota wait + retry
        const waitMs = Math.min(state.wafStrikes * 60_000, 3 * 60_000); // 1-3 min
        await push(progressCard(section('🛡 Swiggy Security Check — Auto-Recover', [
          `› Challenge mila (strike ${state.wafStrikes}/4). Naya WAF token le raha hoon…`,
          `› ${Math.round(waitMs / 60000)} min ruk kar isi number par dobara try karunga.`,
          sub('Batch nahi rukega — 4 lagatar challenges par hi rukega.'),
        ].join('\n'))), stopRows());
        try { await getLiveSwiggyWafToken(true); } catch {}
        await sleep(waitMs, () => state.stopRequested);
        if (state.stopRequested) { endReason = state.stopReason || 'manual'; break; }
        continue; // wahi number dobara (fresh token ke saath)
      }

      // Generic failure streak — pehle proxy badal kar dekho (IP issue ho
      // sakti hai), warna hi band. Pehle ye 6 par seedha band ho jata tha.
      if (outcome === 'failed' && state.consecutiveFails >= 4 && ps.enabled) {
        const next = rotateProxy(getBridgeProxyId());
        if (next) {
          state.consecutiveFails = 0;
          state.proxyRotations = (state.proxyRotations || 0) + 1;
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
        const jitter = Math.floor(Math.random() * 8_000);
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
