// ===== 🆕 SWIGGY FRESH BOT — ek START, baaki sab khud =====
//
// Ye STANDALONE bot hai (alag project, alag DB):
//   /start → ▶️ START BATCH · ⏹ STOP · 📊 STATUS · ⚙️ SETTINGS
//
// Ek START ke baad ye apne aap chalta hai:
//   1️⃣ Firebase pool (clients/) se number uthata — online devices pehle
//   2️⃣ Swiggy OTP bhejta hai → isi Firebase (messages/) se live poll karke
//      OTP padh kar khud paste karta hai
//   3️⃣ 🆕 naya number = register + session save
//      ♻️ purana number = login → delete account → usi number se fresh login
//   4️⃣ charges/order/wallet block = SKIP · rate-limit = auto backoff ·
//      WAF challenge = auto token-refresh + retry (batch nahi rukta) ·
//      STOP dabane par ruk jata hai
//
// ⚙️ SETTINGS — user ki azadi (env chhedni ki zaroorat nahi):
//   • 🔥 Firebase Sources — multiple DB ek saath add; sab Delete tak ACTIVE
//   • 🎯 Target / ⏱ Max time / 🚦 Gap / ⏳ OTP wait — sab yahin se
//
// Setup (sirf 2 cheezein):
//   .env → BOT_TOKEN=<BotFather ka token>   (AUTOPILOT_BOT_TOKEN bhi chalega)
//          OWNER_IDS=<aapka Telegram id>    (warna store boss + fallback)
//   FIREBASE_DB_URL ki zaroorat NAHI — default hi vuvhbjbi Firebase hai.
//
// Chalao:  node fresh-bot.js   (ya npm start)

import dotenv from 'dotenv';
dotenv.config();

// OTP + numbers dono ISI Firebase se aate hain (premium/firebase koi third source nahi)
process.env.FIREBASE_DB_URL ||= 'https://vuvhbjbi-default-rtdb.firebaseio.com/';

// Dynamic import — defaults set karne KE BAAD hi modules load ho, warna
// firebase-numbers.js env ko call-time par hi padhta hai, phir bhi safe side.
const { Telegraf } = await import('telegraf');
const {
  isBoss,
  hydrateAccountsFromCloudVault,
  getSessionExportJson,
  getDb,
  findAccountKeyByPhone,
} = await import('./store.js');
const {
  startAutopilot,
  requestAutopilotStop,
  requestAutopilotSkipCurrent,
  getAutopilotSnapshot,
  isAutopilotRunning,
  formatPoolStatus,
  formatFirebaseSourceStatus,
  formatTelegramSourceStatus,
  formatNumberSourceStatus,
  formatScanCandidateStates,
  poolExhaustedReasonText,
  resolveAutopilotNumberSource,
  formatCompactAutopilotCard,
  numberDecisionWindowMs,
  setAutopilotNeverStop,
} = await import('./autopilot-engine.js');
const { isFirebaseConfigured, firebaseSetupHintLines, listPoolNumbers, _countDeviceOnlineStates } = await import('./firebase-numbers.js');
const telegramOtp = await import('./telegram-otp-source.js');
const sources = await import('./firebase-sources.js');
const otpBotProfiles = await import('./otp-bot-profiles.js');
const startPresets = await import('./start-source-presets.js');
const shopStock = await import('./shop-bot-stock.js');
const customBots = await import('./custom-bots.js');
const customRunner = await import('./custom-bot-runner.js');
const bs = await import('./bot-settings.js');
const proxyPool = await import('./proxy-pool.js');
const {
  getChromeStatus,
  getSwiggyAccountJwtSessionInfo,
  refreshSavedSwiggySession,
  SWIGGY_LONG_SESSION_MIN_MS,
} = await import('./swiggy-bridge.js');
const wafPool = await import('./waf-pool.js');
const { esc, section, sectionStamp, sub, field, mono, statusCard, details, stamp } = await import('./rich-text.js');
const { createServer } = await import('node:http');
const { startKeepAlive } = await import('./keep-alive.js');
const instanceInfo = await import('./instance-info.js');
const instanceShard = await import('./instance-shard.js');
const worldBot = await import('./swiggy-world-bot.js');
// 🎓 Custom trained OTP bots — claim/refresh hooks telegram-otp-source me
// inject karo (coding wala Hermes/Hathi flow jab custom profile active ho to
// owner ki training se replace ho jata hai). Custom profiles provider custom-
// bots.js ne otp-bot-profiles.js me already register kar diya hai.
try { telegramOtp.setCustomBotClaimRunner(customRunner.runCustomClaim); } catch (e) { console.warn('[FreshBot] custom claim runner wire fail:', e?.message || e); }
try { telegramOtp.setCustomBotRefreshRunner(customRunner.runCustomRefresh); } catch (e) { console.warn('[FreshBot] custom refresh runner wire fail:', e?.message || e); }

// ---------------------------------------------------------------------------
// Process guards — ek stray async error poore bot ko NA maare.
// (Pehle: koi bhi unhandled rejection/handler error = process band, aur
// user ko sirf "bot work nahi kar raha" dikhta tha, wajah kabhi nahi.)
// ---------------------------------------------------------------------------
process.on('unhandledRejection', (err) => {
  console.error('[FreshBot] unhandledRejection (bot chalta rahega):', err?.stack || err?.message || err);
});
process.on('uncaughtException', (err) => {
  console.error('[FreshBot] uncaughtException (bot chalta rahega):', err?.stack || err?.message || err);
});

// ---------------------------------------------------------------------------
// ❤️ Runtime health + Render keep-alive
// Health server bot launch se pehle shuru hota hai taaki Render ko port
// foran mile. /health hamesha process-liveness batata hai; /health/ready
// tabhi 200 deta hai jab Telegram polling asal me launch ho gayi ho.
// ---------------------------------------------------------------------------
const runtimeHealth = {
  bootAt: Date.now(),
  telegramReady: false,
  telegramReadyAt: 0,
  telegramUsername: '',
  telegramApiOkAt: 0,
  telegramApiFailures: 0,
  lastTelegramError: '',
  telegramUpdates: 0,
  lastTelegramUpdateAt: 0,
  healthRequests: 0,
  lastHealthRequestAt: 0,
};
let healthServer = null;
let keepAliveHandle = null;
let telegramWatchdogTimer = null;

function buildHealthPayload() {
  let snap = {};
  try { snap = getAutopilotSnapshot(); } catch {}
  return {
    ok: true,
    ready: runtimeHealth.telegramReady,
    service: 'swiggy-fresh-bot',
    instance: instanceInfo.getInstanceLabel(),
    shard: instanceShard.shardSummary(),
    now: new Date().toISOString(),
    uptimeSec: Math.floor((Date.now() - runtimeHealth.bootAt) / 1000),
    batchRunning: Boolean(snap.running),
    processed: snap.processed ?? 0,
    freshThisRun: snap.fresh ?? 0,
    activeWorkers: snap.activeWorkers ?? 0,
    concurrency: snap.concurrency ?? 1,
    telegram: {
      ready: runtimeHealth.telegramReady,
      username: runtimeHealth.telegramUsername || '',
      apiOkAt: runtimeHealth.telegramApiOkAt || 0,
      apiFailures: runtimeHealth.telegramApiFailures || 0,
      lastError: runtimeHealth.lastTelegramError || '',
      sessionTag: (() => { try { return telegramOtp.telegramSessionTag(); } catch { return ''; } })(),
      updates: runtimeHealth.telegramUpdates || 0,
      lastUpdateAt: runtimeHealth.lastTelegramUpdateAt || 0,
    },
    keepAlive: keepAliveHandle?.getState?.() || { enabled: false, reason: 'not-started' },
    healthRequests: runtimeHealth.healthRequests,
  };
}

function startHealthServer() {
  if (healthServer || !process.env.PORT) return null;
  const port = Number(process.env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.warn(`[FreshBot] Health server start nahi hua — PORT galat hai: ${process.env.PORT}`);
    return null;
  }

  healthServer = createServer((req, res) => {
    runtimeHealth.healthRequests++;
    runtimeHealth.lastHealthRequestAt = Date.now();

    let pathname = '/';
    try { pathname = new URL(req.url || '/', 'http://localhost').pathname; } catch {}
    const readyPath = pathname === '/health/ready' || pathname === '/ready';
    const healthPath = pathname === '/' || pathname === '/health' || pathname === '/health/live' || pathname === '/ping' || readyPath;
    const payload = buildHealthPayload();
    if (readyPath) payload.ok = runtimeHealth.telegramReady;

    const status = !healthPath ? 404 : (readyPath && !runtimeHealth.telegramReady ? 503 : 200);
    const body = JSON.stringify(healthPath ? payload : { ok: false, error: 'not found' });
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });

  healthServer.on('error', (e) => {
    console.warn('[FreshBot] Health server error:', e?.message || e);
  });
  healthServer.listen(port, '0.0.0.0', () => {
    console.log(`[FreshBot] Health server port ${port} par sun raha hai — GET /health (live) · GET /health/ready (Telegram ready).`);
    if (!keepAliveHandle) {
      keepAliveHandle = startKeepAlive();
    }
  });
  return healthServer;
}

// ---------------------------------------------------------------------------
// Config + owner gate
// ---------------------------------------------------------------------------
const TOKEN = String(process.env.BOT_TOKEN || process.env.AUTOPILOT_BOT_TOKEN || '').trim();

function ownerIds() {
  const raw = String(process.env.OWNER_IDS || process.env.AUTOPILOT_OWNER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (raw.length) return new Set(raw);
  return null; // fallback: store bossIds + known owner
}

function isOwner(userId) {
  const ids = ownerIds();
  const uid = String(userId);
  if (ids) return ids.has(uid);
  try { if (isBoss(Number(userId))) return true; } catch {}
  try { if (isBoss(uid)) return true; } catch {}
  return uid === '5393396812';
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------
const kb = (rows) => ({ parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: rows } });

function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function telegramSettingEnabled() {
  try { return bs.getSetting('telegramOtpMode') === true; } catch { return false; }
}

function resolvedNumberSourceMode() {
  try {
    return resolveAutopilotNumberSource({ telegramSetting: telegramSettingEnabled() });
  } catch {
    return telegramSettingEnabled() ? 'telegram' : 'firebase';
  }
}

function isTelegramNumberSource() {
  return resolvedNumberSourceMode() === 'telegram';
}

function telegramProviderStatus() {
  try { return telegramOtp.getTelegramOtpStatus?.() || {}; } catch { return {}; }
}

function normalizedTelegramSnapshot(snap = {}) {
  const status = telegramProviderStatus();
  const mode = snap.sourceMode || resolvedNumberSourceMode();
  const runningSnapshot = snap.sourceMode && mode === 'telegram' && snap.startedAt;
  if (mode !== 'telegram') return snap;
  return {
    ...snap,
    sourceMode: 'telegram',
    telegramBotUsername: snap.telegramBotUsername || status.botUsername || 'HermeshuOTPROBOT',
    telegramConfigured: runningSnapshot || snap.telegramConfigured !== undefined
      ? Boolean(snap.telegramConfigured ?? status.configured)
      : Boolean(status.configured),
    telegramConnected: runningSnapshot || snap.telegramConnected !== undefined
      ? Boolean(snap.telegramConnected ?? status.connected)
      : Boolean(status.connected),
    telegramAuthorized: runningSnapshot || snap.telegramAuthorized !== undefined
      ? Boolean(snap.telegramAuthorized ?? status.authorized)
      : Boolean(status.authorized),
    telegramLoginInProgress: Boolean(snap.telegramLoginInProgress || status.loginInProgress),
    telegramMissing: [...(snap.telegramMissing?.length ? snap.telegramMissing : (status.missing || []))],
    telegramCurrentPhone: snap.telegramCurrentPhone || snap.current?.phone || status.currentPhone || '',
    telegramClaimed: Number(snap.telegramClaimed) || 0,
    telegramRejected: Number(snap.telegramRejected) || 0,
    telegramScreenButtons: [...(snap.telegramScreenButtons?.length ? snap.telegramScreenButtons : (status.lastScreenButtons || []))],
    telegramLastClickedButton: snap.telegramLastClickedButton || status.lastClickedButton || '',
    telegramLastClickedRole: snap.telegramLastClickedRole || status.lastClickedRole || '',
    telegramCallbackMessage: snap.telegramCallbackMessage || status.lastCallbackMessage || '',
    telegramClaimPhase: snap.telegramClaimPhase || status.claimPhase || '',
    telegramLastActionAt: Number(snap.telegramLastActionAt || status.lastActionAt) || 0,
  };
}

function numberSourceLine(snap = getAutopilotSnapshot()) {
  const normalized = normalizedTelegramSnapshot(snap);
  return normalized.sourceMode === 'telegram'
    ? field('📨 Telegram Hermes', formatTelegramSourceStatus(normalized))
    : field('🔥 Firebase', formatFirebaseSourceStatus(normalized));
}

function activeSourceLine() {
  if (isTelegramNumberSource()) {
    return field('📨 Telegram Hermes', formatTelegramSourceStatus(normalizedTelegramSnapshot(getAutopilotSnapshot())));
  }
  try {
    const src = sources.getActiveSource();
    if (!src) return field('🔥 Firebase', '— (koi source nahi)');
    const list = sources.listSources();
    let health = null;
    try { health = sources.sourceHealthSummary(list); } catch {}
    return field('🔥 Firebase', `${esc(src.name)} first-try  ·  ${list.length} ACTIVE source${list.length === 1 ? '' : 's'}${health ? ` · 🩺 live ${health.live} / quarantine ${health.quarantined}` : ''}`);
  } catch {
    return field('🔥 Firebase', '—');
  }
}

// Abhi ka OTP bot label (Hermes / HardXotp) — UI me hamesha wahi dikhao jo
// batch chalayega.
function activeOtpBotLabel() {
  try { return otpBotProfiles.getOtpBotProfile(bs.getSetting('otpBotProfile')).label; } catch { return 'Hermes'; }
}

function startCard() {
  const snap = getAutopilotSnapshot();
  if (snap.running) return runningCard(snap);
  if (snap.finishedAt) return summaryCard(snap);
  const telegram = isTelegramNumberSource();
  const target = Number(bs.getSetting('target')) || 100;
  const maxMin = Number(bs.getSetting('maxMinutes')) || 120;
  const engineWorld = bs.getSetting('accountEngine') === 'worldbot';
  return statusCard(instanceInfo.instanceTitle('🆕 Swiggy Fresh Bot'), [
    field('Status', 'READY — START ka wait'),
    telegram
      ? `📨 <b>Source:</b> ${mono(`${activeOtpBotLabel().toUpperCase()} ONLY`)} · 🔥 Firebase ${mono('OFF')}`
      : activeSourceLine(),
    `🌍 <b>Engine:</b> ${engineWorld ? mono(`WORLD BOT @${worldBot.worldBotUsername()}`) : mono('CHROMIUM')}`,
    `🎯 <b>Batch:</b> ${mono(`${target} fresh`)} · ${mono(`${maxMin} min`)} · never-stop ${mono(bs.getSetting('autoContinue') ? 'ON' : 'OFF')}`,
    `🧭 <b>Flow:</b> ${mono(engineWorld
      ? 'LOGIN › OTP › JSON'
      : (telegram ? 'NEW › OTP › VERIFY › ADDR › FRESH' : 'POOL › OTP › INBOX › VERIFY › ADDR › FRESH'))}`,
    ``,
    '<b>Next:</b> START dabao → source chuno → batch chalu.',
  ].filter(Boolean));
}

function runningCard(snap, stageText = '') {
  return formatCompactAutopilotCard(normalizedTelegramSnapshot(snap), { stageText });
}

function summaryCard(snap) {
  return formatCompactAutopilotCard(normalizedTelegramSnapshot(snap), { final: !snap.running });
}

const startRows = () => [
  [{ text: '▶️ START BATCH', callback_data: 'ap_start', style: 'success' }],
  [{ text: '📊 Status', callback_data: 'ap_status' }, { text: '⚙️ Settings', callback_data: 'ap_settings' }],
];
const stopRows = () => [
  [
    { text: '⏭ SKIP NUMBER', callback_data: 'ap_skip_current', style: 'primary' },
    { text: '⏹ STOP BATCH', callback_data: 'ap_stop', style: 'danger' },
  ],
  [{ text: '📊 Status', callback_data: 'ap_status' }, { text: '⚙️ Settings', callback_data: 'ap_settings' }],
];
const idleRows = () => [
  [{ text: '▶️ START BATCH', callback_data: 'ap_start', style: 'success' }],
  [{ text: '📊 Status', callback_data: 'ap_status' }, { text: '⚙️ Settings', callback_data: 'ap_settings' }],
];

// ---------------------------------------------------------------------------
// ⚙️ SETTINGS — Firebase sources + batch knobs (user ki azadi, env nahi)
// ---------------------------------------------------------------------------
function settingsCard() {
  const ps = proxyPool.proxySummary();
  const engineWorld = bs.getSetting('accountEngine') === 'worldbot';
  const proxyLine = ps.direct
    ? 'DIRECT (no proxy)'
    : (ps.enabled ? `${ps.enabledCount}/${ps.total} ON · ${ps.rotation}` : 'OFF — batch ruk sakta hai');
  return section('⚙️ Settings', [
    field('Target', `${bs.getSetting('target')} fresh`),
    field('Lanes', `${bs.getSetting('concurrency')} parallel`),
    field('Time', `${bs.getSetting('maxMinutes')} min`),
    field('Gap', bs.fmtSetting('gapMs')),
    field('Never-stop', bs.getSetting('autoContinue') ? 'ON' : 'OFF'),
    field('Offline', bs.getSetting('allowOffline') ? 'ON' : 'OFF'),
    ``,
    field('Source', isTelegramNumberSource() ? `Telegram · ${activeOtpBotLabel()}` : 'Firebase'),
    field('OTP bot', bs.fmtSetting('otpBotProfile')),
    field('Engine', engineWorld ? `Swiggy World @${worldBot.worldBotUsername()}` : 'Chromium (direct)'),
    engineWorld ? '' : field('Proxies', proxyLine),
    field('OTP wait', isTelegramNumberSource()
      ? `${bs.fmtSetting('telegramOtpTimeoutMs')} · refresh ${bs.fmtSetting('telegramOtpRefreshMs')}`
      : bs.fmtSetting('otpWaitMs')),
    ``,
    details([
      activeSourceLine(),
      numberSourceLine(),
      sub('Sab kuch yahin se badlo — .env chhedne ki zaroorat nahi.'),
    ], { title: 'Source detail' }),
  ].filter(Boolean).join('\n'));
}

const settingsRows = () => {
  const engineWorld = bs.getSetting('accountEngine') === 'worldbot';
  const proxySummary = proxyPool.proxySummary();
  return [
    [
      { text: `🎯 Target: ${bs.getSetting('target')}`, callback_data: 'ap_pick_target' },
      { text: `⚡ Lanes: ${bs.getSetting('concurrency')}`, callback_data: 'ap_pick_parallel' },
    ],
    [
      { text: `⏱ Max: ${bs.getSetting('maxMinutes')}m`, callback_data: 'ap_pick_time' },
      { text: `🚦 Gap: ${bs.fmtSetting('gapMs')}`, callback_data: 'ap_pick_gap' },
    ],
    [
      { text: `🔁 Never-stop: ${bs.getSetting('autoContinue') ? 'ON' : 'OFF'}`, callback_data: 'ap_toggle_neverstop', style: 'success' },
      { text: `📴 Offline: ${bs.getSetting('allowOffline') ? 'ON' : 'OFF'}`, callback_data: 'ap_toggle_offline' },
    ],
    [
      { text: `📨 Telegram: ${bs.fmtSetting('telegramOtpMode')}`, callback_data: 'ap_toggle_telegram', style: 'primary' },
      { text: `🤖 ${bs.fmtSetting('otpBotProfile')}`, callback_data: 'ap_pick_otp_bot', style: 'primary' },
    ],
    [
      { text: '🔥 Firebase Sources', callback_data: 'ap_sources', style: 'primary' },
      // 🌍 World Bot aur Toing Pro mode me proxy ka koi button/wording nahi.
      ...(['worldbot', 'toing_pro'].includes(bs.getSetting('accountEngine')) ? [] : [{
        text: proxySummary.direct ? '🔀 Proxies: DIRECT' : `🔀 Proxies: ${proxySummary.enabledCount}`,
        callback_data: 'ap_proxies',
        style: 'primary',
      }]),
    ],
    // 👤 Owner: "otp bot + chromium" aur "otp bot + swiggy world" — dono options
    // ek hi screen par, jo chalu hai us par ✓.
    [
      {
        text: `${engineWorld ? '' : '✓ '}🧩 Chromium`,
        callback_data: 'ap_engine_chromium',
        style: engineWorld ? 'primary' : 'success',
      },
      {
        text: `${engineWorld ? '✓ ' : ''}🌍 World Bot`,
        callback_data: 'ap_engine_worldbot',
        style: 'primary',
      },
    ],
    ...(isTelegramNumberSource() ? [[
      { text: `⏳ OTP wait: ${bs.fmtSetting('telegramOtpTimeoutMs')}`, callback_data: 'ap_pick_telegram_wait' },
      { text: `🔄 Refresh: ${bs.fmtSetting('telegramOtpRefreshMs')}`, callback_data: 'ap_pick_telegram_refresh' },
    ]] : []),
    [
      { text: '👤 Add Telegram Account', callback_data: 'ap_telegram_account', style: 'success' },
      { text: `🧪 Test ${activeOtpBotLabel()}`, callback_data: 'ap_test_hermes' },
    ],
    [
      { text: '📦 Shop Stock', callback_data: 'ap_shop_stock', style: 'success' },
      { text: '🔎 World screen', callback_data: 'ap_world_probe' },
    ],
    // 🎓 Custom bot training — owner apna koi bhi OTP/SMS bot add + train kare
    [{ text: '🎓 Train Custom Bot', callback_data: 'ap_train_bots', style: 'success' }],
    [
      { text: '🩺 Diagnose', callback_data: 'ap_diag' },
      { text: '🗑 Remove Telegram', callback_data: 'ap_remove_telegram', style: 'danger' },
    ],
    // 🧙‍♂️ Quick Setup wizard — ek tap me saara setup (engine + OTP bot + proxy + start)
    [{ text: '🧙‍♂️ Quick Setup', callback_data: 'ap_setup_wizard', style: 'success' }],
    [{ text: '↩️ Back', callback_data: 'ap_home', style: 'primary' }],
  ];
};

// ---------------------------------------------------------------------------
// 🔀 PROXIES — "rukna hi na pare" ka tod. Multiple proxies = multiple IPs.
//   Ek IP blocked → bot TURANT doosri IP (zero wait).
// ---------------------------------------------------------------------------
function proxiesCard() {
  const list = proxyPool.listProxies();
  const ps = proxyPool.proxySummary();
  const rows = list.map((p) => [
    {
      text: `${p.enabled ? (p.cooldownLeftMs > 0 ? '🟡' : '▫️') : '🚫'} ${p.label}${p.tokenReady ? ' 🔑' : ''}`,
      callback_data: `ap_px_${p.id}`,
    },
  ]);
  rows.push([{ text: '🌐 Free Proxies Lao (auto)', callback_data: 'ap_px_free', style: 'success' }]);
  rows.push([{ text: '➕ Add Proxy (khud ki)', callback_data: 'ap_px_add' }]);
  rows.push([{ text: `🌐 Free Auto: ${ps.autoFree ? 'ON' : 'OFF'}`, callback_data: 'ap_px_autotoggle' }]);
  rows.push([{ text: ps.enabled ? '⏸ Pause Rotation' : '▶️ Enable Rotation', callback_data: 'ap_px_rot' }]);
  rows.push([{ text: '↩️ Settings', callback_data: 'ap_settings', style: 'primary' }]);
  return {
    text: section('🔀 Proxies', [
      field('Status', ps.enabled ? `ON (${ps.enabledCount}/${ps.total})` : 'OFF'),
      field('Rotation', ps.rotation),
      field('Free auto', `${ps.autoFree ? 'ON' : 'OFF'}${ps.autoCount ? ` · ${ps.autoCount} auto (${ps.autoClean || 0} clean${ps.autoChallenged ? ` · ${ps.autoChallenged} 🛡 WAF-ready` : ''})` : ''}`),
      ``,
      list.length
        ? list.map((p) =>
            `${p.enabled ? (p.cooldownLeftMs > 0 ? `🟡 ${Math.ceil(p.cooldownLeftMs / 1000)}s` : '▫️') : '🚫'} <b>${esc(p.label)}</b>${p.quality === 'challenged' ? ' 🛡' : ''}${p.tokenReady ? ' 🔑' : ''} · ${p.hits || 0} hits`
          ).join('\n')
        : sub('Koi proxy nahi — sab kuch EK IP se ja raha hai (rukne ka khatra).'),
      ``,
      sub('🌐 Free Proxies dabao — sirf Swiggy par zinda proxies rakhega. Ek IP block → turant doosri IP.'),
    ].join('\n')),
    rows,
  };
}

function proxyDetailCard(pxId) {
  const p = proxyPool.listProxies().find((x) => x.id === pxId);
  if (!p) return { text: '❌ Proxy nahi mila.', rows: [[{ text: '↩️ Proxies', callback_data: 'ap_proxies' }]] };
  return {
    text: section(`🔀 ${esc(p.label)}`, [
      `URL: <code>${esc(p.url.replace(/\/\/[^@]*@/, '//***:***@'))}</code>`,
      `Status: ${p.enabled ? '▫️ enabled' : '🚫 disabled'}${p.cooldownLeftMs > 0 ? ` · 🟡 WAF cooldown ${Math.ceil(p.cooldownLeftMs / 1000)}s` : ''}`,
      p.auto ? `🌐 Free auto proxy${p.country ? ` · ${esc(p.country)}` : ''}${p.latencyMs ? ` · ⚡ ${p.latencyMs}ms (last check)` : ''}${p.quality === 'challenged' ? ' · 🛡 Swiggy WAF challenge deta hai — browser token solve karke chalegi' : ' · ✅ clean'} — marne par khud replace ho jayegi` : '',
      `WAF token: ${p.tokenReady ? '🔑 ready (per-proxy)' : '— (demand par banega)'}`,
      `Hits: ${p.hits || 0} · errors: ${p.consecutiveErrors || 0}`,
      ``,
      sub('Ye proxy OFF ho to bot seedha aapke IP se karega (ruk sakta hai).'),
    ].join('\n')),
    rows: [
      [{ text: p.enabled ? '🚫 Disable' : '▫️ Enable', callback_data: `ap_px_toggle_${p.id}` }],
      [{ text: '🗑 Delete', callback_data: `ap_px_del_${p.id}`, style: 'danger' }],
      [{ text: '↩️ Proxies', callback_data: 'ap_proxies', style: 'primary' }],
    ],
  };
}

const SOURCES_PER_PAGE = 10;

function sourcePageFor(sourceId) {
  const idx = sources.listSources().findIndex((s) => s.id === sourceId);
  return idx < 0 ? 0 : Math.floor(idx / SOURCES_PER_PAGE);
}

function sourcesCard(requestedPage = 0) {
  const list = sources.listSources();
  const totalPages = Math.max(1, Math.ceil(list.length / SOURCES_PER_PAGE));
  const page = Math.min(Math.max(0, Number(requestedPage) || 0), totalPages - 1);
  const start = page * SOURCES_PER_PAGE;
  const pageItems = list.slice(start, start + SOURCES_PER_PAGE);
  const primary = list.find((s) => s.primary);
  let health = null;
  try { health = sources.sourceHealthSummary(list); } catch {}

  const rows = pageItems.map((s) => [
    {
      text: `✅ ${s.name} (ACTIVE)${s.primary ? ' ⭐' : ''}`,
      callback_data: `ap_src_${s.id}`,
    },
  ]);
  if (totalPages > 1) {
    const nav = [];
    if (page > 0) nav.push({ text: '◀️ Prev', callback_data: `ap_sources_p${page - 1}` });
    nav.push({ text: `${page + 1}/${totalPages}`, callback_data: `ap_sources_p${page}` });
    if (page < totalPages - 1) nav.push({ text: 'Next ▶️', callback_data: `ap_sources_p${page + 1}` });
    rows.push(nav);
  }
  rows.push([{ text: '➕ Add Firebase (Bulk)', callback_data: 'ap_src_add', style: 'success' }]);
  rows.push([{ text: '🗑 Delete All Firebase', callback_data: 'ap_src_delete_all', style: 'danger' }]);
  rows.push([{ text: '↩️ Settings', callback_data: 'ap_settings', style: 'primary' }]);

  return {
    text: section('🔥 Firebase Sources', [
      field('Total', `${list.length} ACTIVE · page ${page + 1}/${totalPages}`),
      field('First try', primary ? primary.name : '—'),
      health ? field('Health', `live ${health.live} · untried ${health.neverTried} · quarantine ${health.quarantined}`) : '',
      list.length ? '' : sub('Abhi koi Firebase add nahi — Add Firebase se naya DB daalo.'),
      ``,
      ...pageItems.map((s, i) =>
        `${start + i + 1}. ✅ <b>${esc(s.name)}</b>${s.primary ? ' ⭐' : ''} — <code>${esc(s.url.replace('https://', ''))}</code>${s.auth ? ' 🔑' : ''}`
      ),
      ``,
      details([
        'Saare added Firebase hamesha ACTIVE hain — disable/switch-off nahi hota; sirf Delete se hatt-ta hai.',
        'Batch ek waqt me ek DB current rakhta hai taaki number ka OTP usi DB se mile; khali/error/exhaust ho to agli ACTIVE DB isi batch me auto-try hoti hai.',
        'Dead DB 30 min ke liye quarantine ho jata hai.',
        'Source tap karke: first-try / verify / delete.',
      ], { title: 'Kaise kaam karta hai' }),
    ].filter(Boolean).join('\n')),
    rows,
  };
}

function sourceDetailCard(srcId) {
  const s = sources.getSource(srcId);
  if (!s) return { text: '❌ Source nahi mila.', rows: [[{ text: '↩️ Sources', callback_data: 'ap_sources' }]] };
  return {
    text: section(`🔥 ${esc(s.name)}`, [
      `URL: <code>${esc(s.url)}</code>`,
      s.auth ? 'Auth: 🔑 set hai' : 'Auth: nahi (open rules)',
      `Paths: clients=<code>${esc(s.clientsPath)}</code> · messages=<code>${esc(s.messagesPath)}</code>`,
      `Status: ✅ <b>ACTIVE</b> — Delete tak hamesha active rahega`,
      s.primary ? '⭐ Batch is source ko sabse pehle try karega (baaki sab bhi ACTIVE hain).' : 'Batch order me ye source bhi ACTIVE pool me shamil hai.',
      ``,
      sub('Verify = test ki DB reachable hai (shallow root read).'),
    ].join('\n')),
    rows: [
      ...(s.primary ? [] : [[{ text: '⭐ Pehle Try Karo', callback_data: `ap_src_use_${s.id}`, style: 'success' }]]),
      [{ text: '🧪 Verify', callback_data: `ap_src_verify_${s.id}` }],
      [{ text: '🗑 Delete', callback_data: `ap_src_del_${s.id}`, style: 'danger' }],
      [{ text: '↩️ Sources', callback_data: `ap_sources_p${sourcePageFor(s.id)}`, style: 'primary' }],
    ],
  };
}

const pickRows = (prefix, opts, extra = []) => [
  opts.map((o) => ({ text: String(o.label), callback_data: `${prefix}${o.v}` })),
  ...extra,
  [{ text: '↩️ Settings', callback_data: 'ap_settings', style: 'primary' }],
];

const TARGET_PRESETS = [10, 25, 50, 100, 200, 500].map((v) => ({ label: `${v}`, v }));
const PARALLEL_PRESETS = [1, 3, 5, 10].map((v) => ({ label: `${v}`, v }));
const TIME_PRESETS = [15, 30, 60, 120, 240, 480].map((v) => ({ label: `${v}m`, v }));
const GAP_PRESETS = [
  { label: '0s', v: 0 }, { label: '5s', v: 5000 }, { label: '15s', v: 15000 },
  { label: '30s', v: 30000 }, { label: '60s', v: 60000 },
];
const TELEGRAM_WAIT_PRESETS = [
  { label: '20s (default)', v: 20000 },
  { label: '30s', v: 30000 },
  { label: '45s', v: 45000 },
  { label: '60s', v: 60000 },
  { label: '90s', v: 90000 },
];
const TELEGRAM_REFRESH_PRESETS = [
  { label: '1s', v: 1000 },
  { label: '2s', v: 2000 },
  { label: '2.5s (default)', v: 2500 },
  { label: '3s', v: 3000 },
  { label: '5s', v: 5000 },
];

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
if (!TOKEN) {
  console.error('❌ BOT_TOKEN nahi mila. .env me daalo:  BOT_TOKEN=<BotFather token>');
  process.exit(1);
}

// handlerTimeout: 0 GHALT tha — Telegraf me 0 = "0ms me timeout" (har handler
// turant maar jaata tha). Default 90s rakhte hain; batch background me chalta
// hai isliye handlers fast hi rehte hain.
const bot = new Telegraf(TOKEN);

// ⚠️ SABSE BADA FIX: pehle bot.catch hi nahi tha. Telegraf ka default error
// handler error ko WAPAS throw karta hai → polling loop reject →
// bot.launch() reject → process.exit(1). Matlab EK bhi handler me kahin
// chhota sa error (message edit fail, Firebase slow, kuch bhi) = POORA BOT
// BAND. Ab error log hoga, bot chalta rahega.
bot.catch((err, ctx) => {
  console.error(`[FreshBot] handler error (update ${ctx?.update?.update_id ?? '?'}):`, err?.stack || err?.message || err);
  // User ko bhi bata do ke kuch gadbad hui (chup rehne se "bot dead hai" lagta hai).
  // try/catch zaroori hai: message-update par answerCbQuery sync throw karta
  // hai — error-handler khud throw kare to bot wapas marr jayega.
  try { ctx?.reply?.('⚠️ Ek error aayi hai — console me details hain. /start dubara dabao, bot chal raha hai.')?.catch?.(() => {}); } catch {}
  try { ctx?.answerCbQuery?.('⚠️ Error — /start dubara dabao')?.catch?.(() => {}); } catch {}
});

// Polling asal me updates de rahi hai ya nahi — /health par dikhega.
bot.use(async (ctx, next) => {
  runtimeHealth.telegramUpdates++;
  runtimeHealth.lastTelegramUpdateAt = Date.now();
  return next();
});

// Render Web Service par port sab se pehle kholo. Pehle health server
// cloud-vault hydrate ke baad banta tha; ab deploy/cold-start par Render
// aur bahar wale cron ko foran /health mil jayega.
startHealthServer();

const gate = async (ctx) => {
  const uid = ctx.from?.id;
  if (!isOwner(uid)) {
    await ctx.answerCbQuery?.('⛔ Sirf owner.', { show_alert: true }).catch(() => {});
    await ctx.reply(section('⛔ Ye bot sirf owner ke liye hai', [
      `Aapki Telegram ID: <code>${uid}</code>`,
      ``,
      sub('Is ID ko .env me OWNER_IDS me daalein aur bot restart karein:'),
      `<code>OWNER_IDS=${uid}</code>`,
    ].join('\n'))).catch(() => {});
    return false;
  }
  return true;
};

// Transient network jhatke (ENOTFOUND/fetch failed/5xx) par 3 try — pehle
// ek hi failure me progress message chup-chaap drop ho jata tha (log me
// "live send: getaddrinfo ENOTFOUND api.telegram.org"), aur owner ko batch
// ka haal hi nahi milta tha.
const sendLive = async (chatId, text, rows) => {
  const payload = () => bot.telegram.sendMessage(chatId, text, kb(rows || idleRows()));
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await payload();
      return;
    } catch (e) {
      const msg = String(e?.message || e);
      const transient = tgCode(e) >= 500 || tgCode(e) === 429 ||
        /ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|fetch|network|socket|timed? ?out/i.test(msg);
      if (!transient || attempt === 3) {
        console.warn(`[FreshBot] live send (try ${attempt}/3):`, msg);
        return;
      }
      await sleepMs(attempt * 1_500);
    }
  }
};

// Document send kisi transient Telegram/network wajah se fail ho jaye to
// fresh JSON phir bhi chat me poora bhejna hai. Text ko HTML-escape ke baad
// ki lambai dekh kar tukdon me kaato taaki har message Telegram limit me rahe.
function splitJsonForTelegram(jsonText, maxEscapedLength = 2400) {
  const text = String(jsonText || '');
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxEscapedLength);
    while (end > start && esc(text.slice(start, end)).length > maxEscapedLength) end -= 1;
    if (end === start) end = Math.min(text.length, start + 1);
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks.length ? chunks : [''];
}

function formatSessionRemaining(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value)) return '';
  if (value <= 0) return 'EXPIRED';
  const minutes = Math.max(1, Math.round(value / 60_000));
  if (minutes < 60) return `~${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `~${hours}h`;
  return `~${Math.round(hours / 24)}d`;
}

function sessionLifeLine(exportData = {}) {
  try {
    const info = getSwiggyAccountJwtSessionInfo(exportData);
    if (info.expiresAtMs) {
      const left = formatSessionRemaining(info.remainingMs);
      return info.remainingMs >= SWIGGY_LONG_SESSION_MIN_MS
        ? `⏳ Session: ${mono(`${left} LEFT`)}`
        : `⚠️ Short session: ${mono(`${left} LEFT`)} — /session par refresh hoga`;
    }
    if (info.hasSessionTid) return `⏳ Session: ${mono('WEB SESSION SAVED')}`;
  } catch {}
  return '';
}

// Fresh JSON ki asal delivery — Autopilot ke instant send aur owner ke
// /session resend command dono yahi use karte hain. Document 3 baar try;
// phir bhi fail ho to poora JSON code-block hissoun me.
// 📄 `jsonText`/`fileName` diye jaate hain to BILKUL wahi text/file jaati hai
// (World-bot pipeline khud "starting se ending tak" ki file banati hai —
// Task T). Warna purana rasta: DB se export karke pretty JSON.
async function deliverSessionJson(chatId, { phone, accountKey, kind, account, note = '', jsonText: rawJsonText = '', fileName = '', buffer: givenBuffer = null, source = '' } = {}) {
  if (!chatId) return false;
  const typeText = kind === 'fresh_after_delete'
    ? '♻️ Delete + Fresh'
    : kind === 'resend_refreshed'
      ? '♻️ Session Refresh'
      : kind === 'resend'
        ? '↩️ Dobara Bheja'
        : '🆕 Naya Fresh';
  const baseCaption = [
    `✅ <b>Fresh Session Ready</b> — ${typeText}`,
    `📱 ${mono(phone || '')} · 👤 ${mono(accountKey || '')}`,
  ].join('\n');

  const givenText = String(rawJsonText || '').trim();
  let exportData = null;
  try { exportData = getSessionExportJson(accountKey, account); } catch {}
  if (!givenText && !exportData) {
    await bot.telegram.sendMessage(chatId,
      `${baseCaption}\n\n<i>(JSON export nahi mil paya — session bot DB me saved hai)</i>`,
      { parse_mode: 'HTML' }).catch(() => {});
    return false;
  }
  const addressLine = exportData?.remoteAddressStatus === 'added' && exportData?.remoteAddressId
    ? `🏠 Address: ${mono(`ADDED · ${exportData.remoteAddressId}`)}`
    : exportData?.remoteAddressStatus
      ? `🏠 Address: ${mono('NOT ADDED')} — wajah JSON me hai`
      : '';
  const caption = [
    baseCaption,
    exportData ? sessionLifeLine(exportData) : '',
    addressLine,
    note ? esc(String(note).slice(0, 220)) : '',
  ].filter(Boolean).join('\n');

  const jsonText = givenText || JSON.stringify(exportData, null, 2);
  const filename = String(fileName || '').trim() || `${phone || accountKey || 'session'}.json`;
  // 📎 World Bot ke "Export Login JSON" document ke asli bytes — diye ho to
  // bilkul wahi file jaati hai (owner Part 43: document, text nahi).
  const docBuffer = Buffer.isBuffer(givenBuffer) && givenBuffer.length ? givenBuffer : null;
  if (source === 'export-document' && docBuffer) {
    console.log(`[FreshBot] 📎 session file bot ke export document se: ${filename} (${docBuffer.length} bytes)`);
  }
  const sent = await sendSessionFile(chatId, { jsonText, filename, caption, buffer: docBuffer });
  if (sent.ok) return true;

  // Document attach nahi hua. Pehle owner ne bola tha "JSON turant chat me" —
  // lekin raw JSON ke 4 tukde bikhar kar aana padhne layak nahi tha. Isliye
  // ab saaf message + retry ka rasta, aur text-fallback sirf opt-in.
  console.warn(`[FreshBot] session file attach fail: ${sent.error || 'unknown'}`);
  const reason = esc(String(sent.error || 'unknown error').slice(0, 160));
  if (String(process.env.JSON_TEXT_FALLBACK || '') === '1') {
    const chunks = splitJsonForTelegram(jsonText);
    let okChunks = 0;
    for (let i = 0; i < chunks.length; i++) {
      const heading = i === 0
        ? `${caption}\n\n<i>File attach fail (${reason}) — JSON neeche ${chunks.length} hissoun me.</i>`
        : `<b>${esc(filename)}</b> — hissa ${i + 1}/${chunks.length}`;
      const msg = await bot.telegram.sendMessage(chatId, `${heading}\n\n<pre>${esc(chunks[i])}</pre>`, { parse_mode: 'HTML' })
        .catch((e) => { console.warn(`[FreshBot] session JSON chunk ${i + 1}/${chunks.length}:`, e?.message); return null; });
      if (msg) okChunks++;
    }
    return okChunks === chunks.length;
  }

  await bot.telegram.sendMessage(chatId, [
    `⚠️ <b>Session ban gaya, par .json file attach nahi hui</b>`,
    `📱 ${mono(phone || '')} · 👤 ${mono(accountKey || '')}`,
    `<i>Telegram error: ${reason}</i>`,
    ``,
    `<b>JSON lo:</b> /session ${esc(phone || accountKey || '')}`,
    '<i>(session bot DB me safe hai — kuch loss nahi hua)</i>',
  ].join('\n'), { parse_mode: 'HTML' }).catch(() => {});
  return false;
}

// -----------------------------------------------------------------------------
// .json file delivery — teen payload shapes + plain-caption retry.
// Pehle sirf ek shape try hoti thi; wo fail hote hi JSON text ke 4 tukde
// chat me bikhar jate the ("JSON hissa 3/4"). Ab har shape try hoti hai aur
// aakhri fallback saaf message hai (raw text nahi, jab tak
// JSON_TEXT_FALLBACK=1 na ho).
// -----------------------------------------------------------------------------
async function sendSessionFile(chatId, { jsonText = '', filename = 'session.json', caption = '', buffer: givenBuffer = null } = {}) {
  const buffer = Buffer.isBuffer(givenBuffer) && givenBuffer.length
    ? givenBuffer
    : Buffer.from(String(jsonText || ''), 'utf8');
  const attempts = [
    { label: 'buffer+filename', doc: buffer, extra: { filename } },
    { label: 'source+filename', doc: { source: buffer, filename }, extra: {} },
    { label: 'value+filename', doc: { value: buffer, filename }, extra: {} },
  ];
  let lastError = '';
  for (const attempt of attempts) {
    for (const withHtml of [true, false]) {
      try {
        await bot.telegram.sendDocument(chatId, attempt.doc, {
          ...attempt.extra,
          ...(caption ? { caption, ...(withHtml ? { parse_mode: 'HTML' } : {}) } : {}),
        });
        return { ok: true, shape: attempt.label, html: withHtml };
      } catch (e) {
        lastError = `${attempt.label}${withHtml ? ' (html)' : ' (plain)'}: ${String(e?.message || e).slice(0, 160)}`;
        console.warn(`[FreshBot] sendDocument ${lastError}`);
      }
    }
  }
  return { ok: false, error: lastError };
}

// ---------------------------------------------------------------------------
// 🚀 START → source chuno
// Owner ka rule: START dabane par poochho — Hermes bot, HardXotp bot, ya
// Firebase. Isi screen par "Delete All Firebase" bhi hai taaki purani 400+
// list ek tap me saaf ho jaye.
// ---------------------------------------------------------------------------
// Owner ka rule: START par sirf TEEN source buttons —
//   1) HERMESHU + SWIGGYBYWORLD (combined)  2) HATHI WALA BOT  3) SWIGGY BY WORLD
// Advanced (Firebase only / HardXotp) alag screen par, taaki main screen saaf
// rahe aur galti se galat source na chale.
function activeStartPresetId() {
  const engine = bs.getSetting('accountEngine');
  if (engine === 'toing_pro') {
    const prof = bs.getSetting('otpBotProfile');
    return prof === 'hathi' ? 'toing_hathi' : 'toing_hermes';
  }
  const normEngine = engine === 'worldbot' ? 'worldbot' : 'direct';
  const tgMode = telegramSettingEnabled();
  // 👤 Owner ke options: OTP bot + Chromium ya OTP bot + Swiggy World ya Toing Pro.
  if (tgMode) return normEngine === 'worldbot' ? 'otp_world' : 'otp_chromium';
  return normEngine === 'worldbot' ? 'world' : '';
}

function otpBotChoiceRows() {
  const status = telegramProviderStatus();
  const tick = status.configured ? '✅' : '⚙️';
  const active = activeStartPresetId();
  const presetRow = (id, style = 'success') => {
    const preset = startPresets.getStartSourcePreset(id);
    if (!preset) return null;
    const needsTg = preset.sourceMode === 'telegram';
    return [{
      text: `${needsTg ? tick : '🔥'} ${preset.label}${active === id ? ' ✓' : ''}`,
      callback_data: `ap_start_go_${id}`,
      style: preset.accountEngine === 'worldbot' ? 'primary' : style,
    }];
  };
  return [
    [{ text: `🌐 TOING PRO WEB SIGNUP`, callback_data: 'ap_start_toing_pro', style: 'primary' }],
    // 👤 Owner: "otp bot + chromium" aur "otp bot + swiggy world" — do saaf option.
    presetRow('otp_chromium'),
    presetRow('otp_world'),
    presetRow('hathi'),
    presetRow('world'),
    [{ text: '⚙️ Advanced (Firebase only / HardXotp)', callback_data: 'ap_start_adv' }],
    [{ text: '🗑 Delete All Firebase', callback_data: 'ap_src_delete_all', style: 'danger' }],
    [{ text: '↩️ Back', callback_data: 'ap_home' }],
  ].filter(Boolean);
}

// Advanced screen — pehle wala poora picker (per-bot + Firebase only).
function advancedSourceRows() {
  const status = telegramProviderStatus();
  const fbCount = (() => { try { return sources.listSources().length; } catch { return 0; } })();
  const ready = status.configured ? '✅' : '⚙️';
  const activeProfile = bs.getSetting('otpBotProfile');
  const botRows = otpBotProfiles.listOtpBotProfiles().map((profile) => [{
    text: `${ready} ${profile.emoji || '📨'} ${profile.label} bot${activeProfile === profile.id ? ' ✓' : ''}`,
    callback_data: `ap_start_go_${profile.id}`,
    style: 'success',
  }]);
  return [
    ...botRows,
    [{ text: `🔥 Firebase (${fbCount})`, callback_data: 'ap_start_go_firebase', style: 'primary' }],
    [{ text: '↩️ Back', callback_data: 'ap_start' }],
  ];
}

function startSourceCard() {
  const status = telegramProviderStatus();
  const fbCount = (() => { try { return sources.listSources().length; } catch { return 0; } })();
  const active = activeStartPresetId();
  const presetLines = startPresets.listStartSourcePresets().flatMap((preset) => [
    `${active === preset.id ? '👉' : '•'} <b>${preset.label}</b>${active === preset.id ? ' ✓' : ''}`,
    ...preset.lines.map((line) => sub(line)),
    '',
  ]);
  const activePreset = active ? startPresets.getStartSourcePreset(active) : null;
  return section('🚀 Batch Source', [
    field('Selected', activePreset ? activePreset.shortLabel : 'Firebase only'),
    field('Telegram', status.configured ? 'ready' : 'account add karo'),
    field('Firebase', `${fbCount} source`),
    field('OTP wait', `${bs.fmtSetting('telegramOtpTimeoutMs')} · na aaye to number skip`),
    field('Shop stock', `${shopStock.shopStockStatus().pending}/10 — 10 par JSON files`),
    ``,
    sub('Neeche ek option chuno — wahi is batch ka source lock hoga.'),
    details(presetLines, { title: 'Options detail' }),
  ].filter(Boolean).join('\n'));
}

async function showStartSourcePicker(ctx) {
  if (!(await gate(ctx))) return;
  if (isAutopilotRunning()) {
    await ctx.answerCbQuery('Pehle se chal raha hai!', { show_alert: true }).catch(() => {});
    return;
  }
  await ctx.answerCbQuery().catch(() => {});
  const text = startSourceCard();
  const rows = otpBotChoiceRows();
  await ctx.editMessageText(text, kb(rows))
    .catch(async () => { await ctx.reply(text, kb(rows)).catch(() => {}); });
}

async function launchBatch(ctx, opts = {}) {
  // Pehle yahan owner-gate tha hi nahi — koi bhi START daba kar batch chala
  // sakta tha (bot username janna hi kaafi tha).
  if (!(await gate(ctx))) return;
  if (isAutopilotRunning()) {
    await ctx.answerCbQuery('Pehle se chal raha hai!').catch(() => {});
    return;
  }

  // START picker se aaya source: settings yahin lock karo taaki engine,
  // pipeline aur UI — teeno ek hi source par rahein.
  const rawChoice = String(opts.source || '').trim().toLowerCase();
  // 🚀 Teen main buttons (Hermes+World / Hathi / Swiggy by World) preset hain:
  // ek tap me number-source + account-engine dono set ho jate hain.
  const preset = startPresets.getStartSourcePreset(rawChoice);
  if (preset) {
    const patch = startPresets.startSourcePresetSettings(preset) || {};
    for (const [key, value] of Object.entries(patch)) {
      try { bs.setSetting(key, value); } catch {}
    }
    if (patch.otpBotProfile) {
      try { telegramOtp.setActiveOtpBotProfile(patch.otpBotProfile); } catch {}
    }
    console.log(`[FreshBot] 🚀 START preset: ${startPresets.startSourcePresetLine(preset)}`);
  }
  const chosen = preset
    ? (preset.sourceMode === 'telegram' ? preset.otpBotProfile : 'firebase')
    : rawChoice;
  if (otpBotProfiles.isOtpBotProfileId(chosen)) {
    try { bs.setSetting('otpBotProfile', chosen); } catch {}
    try { bs.setSetting('telegramOtpMode', true); } catch {}
    try { telegramOtp.setActiveOtpBotProfile(chosen); } catch {}
  } else if (chosen === 'firebase') {
    try { bs.setSetting('telegramOtpMode', false); } catch {}
  }

  // 🌍 World Bot mode me number-source Hermes nahi hota, lekin wahi spare
  // Telegram account chahiye (bot ke buttons click karne ke liye).
  const worldBotEngine = bs.getSetting('accountEngine') === 'worldbot';
  if (worldBotEngine) {
    // ⚠️ Ye status function ASYNC hai — await ke bina Promise milta tha,
    // isliye `tg.configured` hamesha undefined nikalti thi aur login hone ke
    // baad bhi START "spare Telegram account chahiye" bolta reh jata tha.
    let tg = {};
    try { tg = await telegramOtp.telegramUserClientStatus(); } catch {}
    if (telegramLoginFlow || tg.loginInProgress) {
      await ctx.answerCbQuery('⏳ Telegram login chal raha hai — pehle complete karo.', { show_alert: true }).catch(() => {});
      await ctx.reply(telegramAccountCard(), kb(telegramLoginRows())).catch(() => {});
      return;
    }
    if (!tg.configured) {
      await ctx.answerCbQuery('👤 World Bot ke liye spare Telegram account chahiye!', { show_alert: true }).catch(() => {});
      await ctx.reply(
        section('👤 World Bot — Telegram Account Required', [
          `🌍 <code>@${esc(worldBot.worldBotUsername())}</code> ke buttons click karne ke liye wahi spare Telegram user session chahiye jo OTP bots ke liye use hota hai.`,
          '',
          ...telegramOtp.telegramOtpSetupHintLines(),
        ].join('\n')),
        kb([
          [{ text: '👤 Add Telegram Account', callback_data: 'ap_telegram_account', style: 'success' }],
          [{ text: '⚙️ Settings', callback_data: 'ap_settings', style: 'primary' }],
        ])
      ).catch(() => {});
      return;
    }
  }

  if (!worldBotEngine && isTelegramNumberSource()) {
    const status = telegramProviderStatus();
    if (telegramLoginFlow || status.loginInProgress) {
      await ctx.answerCbQuery('⏳ Telegram login chal raha hai — pehle Add Telegram Account complete karo.', { show_alert: true }).catch(() => {});
      await ctx.reply(telegramAccountCard(), kb(telegramLoginRows())).catch(() => {});
      return;
    }
    if (!status.configured) {
      await ctx.answerCbQuery('👤 Pehle Telegram account add karo!', { show_alert: true }).catch(() => {});
      await ctx.reply(
        section('👤 Add Telegram Account Required', telegramOtp.telegramOtpSetupHintLines().join('\n')),
        kb([
          [{ text: '👤 Add Telegram Account', callback_data: 'ap_telegram_account', style: 'success' }],
          [{ text: '⚙️ Settings', callback_data: 'ap_settings', style: 'primary' }, { text: '🏠 Menu', callback_data: 'ap_home' }],
        ])
      ).catch(() => {});
      return;
    }
  } else if (!isTelegramNumberSource() && !isFirebaseConfigured()) {
    await ctx.answerCbQuery('⚙️ Firebase config pending!', { show_alert: true }).catch(() => {});
    await ctx.reply(section('⚙️ Firebase Setup Pending', firebaseSetupHintLines().join('\n')),
      kb([[{ text: '🏠 Menu', callback_data: 'ap_home', style: 'primary' }]])).catch(() => {});
    return;
  }
  await ctx.answerCbQuery('🚀 Autopilot start…').catch(() => {});
  await ctx.editMessageText(startCard(), kb(stopRows())).catch(() => {});

  // Live card: pehle usi message ko edit karo (jo START par tha), warna naya message
  let lastText = '';
  let lastRowsKey = '';
  const fallback = { chatId: ctx.chat?.id, seq: 0 };
  const ui = {
    async update(text, rows) {
      const rowsKey = JSON.stringify(rows);
      if (text === lastText && rowsKey === lastRowsKey) return;
      lastText = text;
      lastRowsKey = rowsKey;
      try {
        await ctx.editMessageText(text, kb(rows));
      } catch (e) {
        const msg = String(e?.message || '');
        if (/message is not modified/i.test(msg)) return;
        // edit fail (purana message/delete) → naya message bhej do
        if (fallback.chatId) {
          fallback.seq += 1;
          await sendLive(fallback.chatId, text, rows);
        }
      }
    },

    // 📤 Fresh session bante HI uska JSON isi chat me FILE bana kar bhej do
    // (boss ki demand: "jaise koi bhi fresh JSON mile, same time par chat
    // me send karna hai"). Batch ka end/summary ka wait bilkul nahi.
    // Return true/false — pipeline isi ka intezaar karke logout karti hai.
    async sendSession(payload = {}) {
      return deliverSessionJson(ctx.chat?.id || fallback.chatId, payload);
    },
  };

  // START picker ne jo chuna woh env NUMBER_SOURCE ko bhi override karta hai
  // (user ka explicit choice). Khali ho to purana resolve logic chalta hai.
  const explicitMode = preset
    ? preset.sourceMode
    : (otpBotProfiles.isOtpBotProfileId(chosen)
      ? 'telegram'
      : (chosen === 'firebase' ? 'firebase' : ''));
  const lockedSourceMode = explicitMode || resolvedNumberSourceMode();
  const lockedOtpBot = lockedSourceMode === 'telegram'
    ? otpBotProfiles.normalizeOtpBotProfileId(chosen || bs.getSetting('otpBotProfile'))
    : '';
  startAutopilot({
    userId: String(ctx.from.id),
    telegramSetting: telegramSettingEnabled(),
    // Is run ka source yahin lock kar do. Hermes/HardXotp ON ho to stale env
    // ya beech-run setting is batch ko Firebase par nahi ghuma sakti.
    sourceMode: lockedSourceMode,
    numberSource: lockedSourceMode,
    source: lockedSourceMode,
    otpBot: lockedOtpBot,
    // Engine choice isi batch ke liye lock — preset/Settings jo kehta hai wahi.
    accountEngine: bs.getSetting('accountEngine') === 'worldbot' ? 'worldbot' : (bs.getSetting('accountEngine') === 'toing_pro' ? 'toing_pro' : 'direct'),
    ui,
  }).catch((e) => console.error('[FreshBot] autopilot:', e?.stack || e?.message));
}

bot.start(async (ctx) => {
  if (!isOwner(ctx.from?.id)) {
    return ctx.reply(section('⛔ Ye bot sirf owner ke liye hai', [
      `Aapki Telegram ID: <code>${ctx.from?.id}</code>`,
      ``,
      sub('Bot band karke .env me ye line daalein:'),
      `<code>OWNER_IDS=${ctx.from?.id}</code>`,
      ``,
      sub('Phir dobara chalayein (npm start) aur /start dabayein.'),
    ].join('\n'))).catch(() => {});
  }
  await ctx.reply(startCard(), kb(isAutopilotRunning() ? stopRows() : startRows())).catch(() => {});
});

bot.help((ctx) => ctx.reply([
  '<b>Commands</b>',
  '/start — menu',
  '/status — batch status',
  '/diag — health check',
  '/session &lt;number&gt; — fresh JSON',
  '/world — World Bot screen check',
  '/shopstock — shop bot stock',
].join('\n'), { parse_mode: 'HTML' }).catch(() => {}));

// ---------------------------------------------------------------------------
// 🩺 /diag — "bot work nahi kar raha" ka jawab ek tap me.
// Firebase reachable? Pool me numbers? Chrome mila? WAF token? Sab check.
// ---------------------------------------------------------------------------
async function diagCard() {
  const lines = [];
  // 🌍 World Bot engine: proxy/Chrome/WAF-token lafz hi nahi dikhne chahiye
  // (owner ka rule) — is mode me ye cheezein exist hi nahi karti.
  const diagWorld = bs.getSetting('accountEngine') === 'worldbot';
  lines.push(field('Node', process.version));
  {
    const shard = instanceShard.shardSummary();
    lines.push(field('🏷 Instance', shard.enabled
      ? `${shard.label} · shard ${shard.share}`
      : `${shard.label} · akela (INSTANCE_COUNT nahi)`));
    if (shard.enabled) {
      lines.push(field('🧩 Shard', `${shard.count} shard · ye #${shard.index + 1}`));
    }
  }
  lines.push(field('⏰ Uptime', fmtDuration(Date.now() - runtimeHealth.bootAt)));
  {
    const ka = keepAliveHandle?.getState?.() || { enabled: false, reason: 'not-started' };
    const lastOk = ka.lastSuccessAt
      ? `${fmtDuration(Date.now() - ka.lastSuccessAt)} pehle OK`
      : 'abhi pehla ping baqi';
    lines.push(field('❤️ Keep-alive', ka.enabled
      ? `✅ ON · ${Math.round((ka.intervalMs || 300000) / 60000)} min · ${lastOk}${ka.lastError ? ` · err: ${esc(String(ka.lastError).slice(0, 60))}` : ''}`
      : `❌ OFF — KEEP_ALIVE_URL set karo`));
  }
  lines.push(field('📡 FresBot Bot API', runtimeHealth.telegramReady
    ? `✅ ready${runtimeHealth.telegramUsername ? ` (@${esc(runtimeHealth.telegramUsername)})` : ''}`
    : `❌ ready nahi${runtimeHealth.lastTelegramError ? ` — ${esc(String(runtimeHealth.lastTelegramError).slice(0, 100))}` : ''}`));
  // Chrome + WAF token — sirf direct-API engine ke liye (World Bot me nahi).
  if (!diagWorld) {
    try {
      const c = getChromeStatus();
      lines.push(field('🌐 Chrome', c.found ? `✅ mila — <code>${esc(c.path)}</code>${c.headless ? ' (headless)' : ''}` : '❌ NAHI mila — Chrome install karo ya .env me PUPPETEER_EXECUTABLE_PATH do'));
    } catch { lines.push(field('🌐 Chrome', '—')); }
    try {
      wafPool.loadFromDb?.(); // db.json me saved token bhi dikhe (warna hamesha "nahi hai" lagega)
      const w = wafPool.getSummary();
      lines.push(field('🛡 WAF token', w.hasToken ? `✅ hai (${w.tokenAgeMin}m purana, ${esc(w.source)})` : (w.stale ? '⚠️ expired — start par naya banega' : '— start par banega')));
    } catch { lines.push(field('🛡 WAF token', '—')); }
  }
  const diagTelegramMode = isTelegramNumberSource();
  if (diagTelegramMode) {
    // Telegram-only mode me Firebase ko "toota hua" mat dikhao — number aur
    // OTP dono spare Telegram account → Hermes se aa rahe hain.
    const status = telegramProviderStatus();
    const runSnap = getAutopilotSnapshot();
    const botName = String(status.botUsername || 'HermeshuOTPROBOT').replace(/^@+/, '');
    lines.push(field('📨 Number source', `Telegram only — Hermes @${esc(botName)}`));
    const accounts = status.accounts || { count: 0, healthy: 0, accounts: [] };
    const tag = (() => { try { return telegramOtp.telegramSessionTag(); } catch { return ''; } })();
    if (tag && accounts.count <= 1) {
      lines.push(field('🔑 Session tag', `${mono(tag)} <i>(duplicate = conflict)</i>`));
    }
    if (accounts.count > 1) {
      lines.push(field('👥 Accounts', `${mono(`${accounts.healthy}/${accounts.count} READY`)} · active #${Number(status.accountSlot) + 1}`));
      for (const line of (accounts.accounts || []).map((a) => a.line || '')) {
        lines.push(sub(String(line)));
      }
      lines.push(sub('Account flood/dead ho to bot khud agla account uthata hai — batch rukta nahi.'));
    } else {
      lines.push(sub('Ek account. 4 ke liye TELEGRAM_SESSION, _2, _3, _4 env me daalo.'));
    }
    if (status.lastErrorCode && status.lastErrorCode !== 'UNKNOWN') {
      lines.push(field('🧯 Last account error', `${mono(status.lastErrorLabel || status.lastErrorCode)}${status.lastErrorHint ? `\n<i>${esc(status.lastErrorHint)}</i>` : ''}`));
    }
    lines.push(field('👤 Telegram account', status.configured
      ? `✅ ${status.me ? `${esc(status.me)} · ` : ''}API ${status.apiIdPresent && status.apiHashPresent ? '✅' : '❌'} · session ${status.sessionPresent ? '✅' : '❌'}`
      : `❌ pending${status.missing?.length ? ` — missing ${esc(status.missing.join(', '))}` : ''} · Settings → Add Telegram Account`));
    lines.push(field('⏳ Hermes timing', `OTP wait ${bs.fmtSetting('telegramOtpTimeoutMs')} · REFRESH har ${bs.fmtSetting('telegramOtpRefreshMs')}`));

    if (runSnap.running) {
      lines.push(field('📨 Hermes', `● running — ${esc(formatNumberSourceStatus(runSnap))}${status.currentPhone ? ` · ${esc(status.currentPhone)}` : ''}`));
      lines.push(field('📱 Number pool', esc(formatPoolStatus(runSnap))));
    } else if (telegramLoginFlow || status.loginInProgress) {
      lines.push(field('📨 Hermes', `⏳ login — ${telegramLoginFlow ? esc(telegramLoginStageLabel(telegramLoginFlow.stage)) : 'chal raha hai'}`));
      lines.push(field('📱 Number pool', 'login ke baad FIND NUMBER'));
    } else if (!status.configured) {
      lines.push(field('📨 Hermes', '❌ Add Telegram Account pehle'));
      lines.push(field('📱 Number pool', 'Telegram-only — Firebase pool use nahi hota'));
    } else {
      try {
        const t0 = Date.now();
        const v = await telegramOtp.verifyTelegramOtpConnection({ sendStartIfEmpty: true });
        lines.push(field('📨 Hermes', `✅ reachable ${Date.now() - t0}ms — @${esc(String(v.botUsername || botName).replace(/^@+/, ''))}${v.me ? ` · ${esc(v.me)}` : ''}`));
        lines.push(field('📱 Number pool', v.currentPhone
          ? `current ${mono(v.currentPhone)}`
          : 'koi card nahi — batch FIND NUMBER se shuru'));
        lines.push(field('🔘 Hermes buttons', v.buttons?.length ? esc(v.buttons.slice(0, 10).join(' · ')) : 'koi button nahi mila'));
      } catch (e) {
        lines.push(field('📨 Hermes', `❌ ${esc(String(e?.message || e).slice(0, 140))}`));
        lines.push(field('📱 Number pool', 'Settings → 🧪 Test se dobara'));
      }
    }
    lines.push(field('📟 Device gate', 'bypass — Hermes STATUS: ACTIVE hi source'));
  } else {
    // Firebase (active source verify = shallow root read, halka test)
    try {
      const src = sources.getActiveSource();
      if (src) {
        const t0 = Date.now();
        const v = await sources.verifySource(src.id);
        lines.push(field('🔥 Firebase', v.ok
          ? `✅ reachable ${Date.now() - t0}ms — ${esc(src.name)}`
          : `❌ ${esc(v.error || 'unreachable')} — URL/auth/rules check karo`));
      } else {
        lines.push(field('🔥 Firebase', '❌ koi active source nahi (⚙️ Settings → Firebase Sources)'));
      }
    } catch (e) { lines.push(field('🔥 Firebase', `❌ ${esc(String(e?.message || e).slice(0, 120))}`)); }
    // Pool count (asli test — thoda slow ho sakta hai, isliye alag try).
    // Batch chal raha ho to yahan ACTIVE dobara apply NAHI karte: engine
    // kisi fallback source par ho sakta hai aur uske OTP usi DB me aayenge.
    try {
      const runSnap = getAutopilotSnapshot();
      if (runSnap.running) {
        lines.push(field('📱 Number pool', `● batch chal raha hai — ${esc(formatNumberSourceStatus(runSnap))}: ${esc(formatPoolStatus(runSnap))}`));
      } else {
        sources.applyActiveSource();
        const pool = await listPoolNumbers();
        const deviceStates = _countDeviceOnlineStates(pool);
        const fallbackCount = Math.max(0, sources.listRunSources().length - 1);
        lines.push(field('📱 Number pool', pool.length
          ? `✅ ${pool.length} numbers · online ${deviceStates.online} · unknown ${deviceStates.unknown} · offline ${deviceStates.offline}`
          : `⚠️ 0 numbers — clients/paths check karo${fallbackCount ? ` · baaki ${fallbackCount} source auto-try` : ''}`));
      }
    } catch (e) {
      let fallbackNote = '';
      try {
        const fallbackCount = Math.max(0, sources.listRunSources().length - 1);
        if (fallbackCount) fallbackNote = ` · batch me baaki ${fallbackCount} ACTIVE source(s) auto-try honge`;
      } catch {}
      lines.push(field('📱 Number pool', `❌ First-try ACTIVE source: ${esc(String(e?.message || e).slice(0, 140))}${fallbackNote}`));
    }
    // Device last-seen gate
    {
      const w = Number(process.env.PREMIUM_DEVICE_ACTIVE_WINDOW_MS);
      const wMs = Number.isFinite(w) && w > 0 ? w : 60_000;
      lines.push(field('📟 Device gate', `last activity ≤${Math.round(wMs / 1000)}s (PREMIUM_DEVICE_ACTIVE_WINDOW_MS)`));
    }
  }
  // Proxies — sirf direct-API engine me (World Bot me proxy hoti hi nahi).
  if (!diagWorld) {
    try {
      const ps = proxyPool.proxySummary();
      if (ps.direct) {
        lines.push(field('🔀 Proxies', `${mono('DIRECT MODE')} — 1 IP · 1 lane`));
      } else {
        lines.push(field('🔀 Proxies', ps.enabled ? `✅ ${ps.enabledCount}/${ps.total} ON` : '⚠️ OFF (ek hi IP — rukna pad sakta hai)'));
      }
    } catch { lines.push(field('🔀 Proxies', '—')); }
  }
  // Ek number = ek hi baar (owner rule): number park/queue nahi hota.
  try {
    const win = Math.round(numberDecisionWindowMs() / 1000);
    lines.push(field('⛔ Number rule', `${mono('1 NUMBER = 1 BAAR')} — ${win}s me attempt start, warna chhod do`));
  } catch { lines.push(field('⛔ Number rule', 'ek number = ek hi baar')); }
  // 🌍 Account engine — kaun Swiggy account bana raha hai.
  try {
    const engine = bs.getSetting('accountEngine') === 'worldbot' ? 'worldbot' : 'direct';
    const wbStatus = worldBot.getWorldBotStatus();
    let tg = {};
    try { tg = await telegramOtp.telegramUserClientStatus(); } catch {}
    const wbLine = wbStatus?.phase && wbStatus.phase !== 'idle'
      ? ` · last phase: ${wbStatus.phase}${wbStatus.lastAction ? ` (${wbStatus.lastAction})` : ''}`
      : '';
    lines.push(field('🌍 Account engine', engine === 'worldbot'
      ? `${mono('WORLD BOT')} @${esc(worldBot.worldBotUsername())} · spare TG ${tg.configured ? '✅' : '❌'}${esc(wbLine)}`
      : `${mono('DIRECT API')} — bridge + proxy/WAF solver`));
  } catch { lines.push(field('🌍 Account engine', '—')); }
  // 🔁 Never-stop + auto-resume — batch rukne na rukne ka sach.
  try {
    const resume = bs.getAutopilotResume();
    const ns = bs.getSetting('autoContinue') ? 'ON' : 'OFF';
    const resumeLine = resume?.wanted
      ? `auto-resume armed (${String(resume.lastEndReason || 'restart')})`
      : 'auto-resume idle';
    lines.push(field('🔁 Never-stop', bs.getSetting('autoContinue')
      ? `${mono(ns)} — self-recover, sirf TARGET/STOP end · ${esc(resumeLine)}`
      : `⚠️ ${mono(ns)} — safety stops batch band kar sakte hain · ${esc(resumeLine)}`));
  } catch { lines.push(field('🔁 Never-stop', '—')); }
  const snap = getAutopilotSnapshot();
  if (Number(snap.consumedNumbers)) {
    lines.push(field('🔒 Consumed', `${mono(String(snap.consumedNumbers))} number lock — dobara try nahi`));
  }
  lines.push(field('▶️ Batch', snap.running ? `● RUNNING — ${snap.fresh}/${snap.target} fresh` : (snap.finishedAt ? `⏹ last: ${snap.fresh} fresh · ${esc(snap.stopReason || 'done')}${snap.lastError ? ` · last error: ${esc(String(snap.lastError).slice(0, 100))}` : ''}` : 'ready')));
  return section('🩺 Diagnose', [
    ...lines,
    '',
    details([
      'Jahan ❌ hai wahi problem hai. Sab ✅ ho aur batch phir bhi fail ho to console logs dekho — har number ka exact reason wahan hai.',
      'DIRECT MODE: proxy fetch/WAF-solve ka time bachta hai, par Swiggy per-IP rate-limit seedha lagti hai.',
    ], { title: 'Fix hints' }),
  ].join('\n'));
}

bot.command('diag', async (ctx) => {
  if (!isOwner(ctx.from?.id)) return;
  const wait = await ctx.reply('🩺 Check kar raha hoon… (pool test me ~15s lag sakta hai)').catch(() => null);
  const text = await diagCard();
  if (wait) {
    await ctx.telegram.editMessageText(ctx.chat.id, wait.message_id, undefined, text, kb(idleRows())).catch(async () => {
      await ctx.reply(text, kb(idleRows())).catch(() => {});
    });
  } else {
    await ctx.reply(text, kb(idleRows())).catch(() => {});
  }
});

bot.command('status', async (ctx) => {
  if (!isOwner(ctx.from?.id)) return;
  const snap = getAutopilotSnapshot();
  await ctx.reply(snap.running || snap.finishedAt ? summaryCard(snap) : startCard(),
    kb(snap.running ? stopRows() : idleRows())).catch(() => {});
});

// Owner saved session ka latest JSON manga sakta hai:
// /session 9876543210  ya  /session acc_9876543210
// Short/expired JWT par pehle wahi saved account bina naya OTP liye
// Android chkout / web _session_tid se refresh hota hai; phir updated
// JSON bhejta hai. Isiliye 2–3 ghante baad naya number/account banane ki
// zaroorat nahi — pehle /session se refreshed JSON lo.
bot.command('session', async (ctx) => {
  if (!isOwner(ctx.from?.id)) return;
  const query = String(ctx.message?.text || '').trim().split(/\s+/)[1] || '';
  if (!query) {
    await ctx.reply('Usage: <code>/session 9876543210</code> ya <code>/session acc_9876543210</code>', { parse_mode: 'HTML' }).catch(() => {});
    return;
  }

  const accounts = getDb()?.config?.accounts || {};
  const digits = query.replace(/\D/g, '');
  const phone10 = digits.length >= 10 ? digits.slice(-10) : '';
  const accountKey = accounts[query]
    ? query
    : phone10 && accounts[`acc_${phone10}`]
      ? `acc_${phone10}`
      : phone10
        ? findAccountKeyByPhone(accounts, phone10)
        : null;
  const account = accountKey ? accounts[accountKey] : null;
  if (!accountKey || !account) {
    await ctx.reply(`❌ Session nahi mila: <code>${esc(query)}</code>`, { parse_mode: 'HTML' }).catch(() => {});
    return;
  }

  const phone = String(account.phone || account.mobile || phone10 || '').replace(/\D/g, '').slice(-10);
  let liveAccount = account;
  let deliveryKind = 'resend';
  let deliveryNote = '';
  try {
    const info = getSwiggyAccountJwtSessionInfo(account);
    const needsRefresh = Boolean(
      !info.expiresAtMs
      || info.isExpired
      || info.remainingMs < SWIGGY_LONG_SESSION_MIN_MS
    );
    if (needsRefresh && isAutopilotRunning()) {
      deliveryNote = 'Batch chal raha hai — saved JSON bheja. Batch rukne ke baad /session dobara chalane par refresh hoga.';
    } else if (needsRefresh) {
      await ctx.reply('♻️ Saved Swiggy session refresh karke latest JSON bhej raha hoon…', { parse_mode: 'HTML' }).catch(() => {});
      const refreshed = await refreshSavedSwiggySession(accountKey, { timeoutMs: 5_000 });
      if (refreshed?.ok) {
        liveAccount = getDb()?.config?.accounts?.[accountKey] || refreshed.account || account;
        deliveryKind = 'resend_refreshed';
        deliveryNote = refreshed.longLived
          ? 'Session refresh ho gaya — ye updated JSON use karo.'
          : 'Session rotate ho gaya, lekin Swiggy ne is baar bhi short-life token diya. Expire par /session se phir refresh hoga.';
      } else {
        deliveryNote = refreshed?.authRejected
          ? 'Refresh fail: Swiggy ne saved session expired/revoked mana. Purana saved JSON bhej raha hoon; asal zinda session ke liye naya OTP login lagega.'
          : 'Refresh abhi fail hua — saved purana JSON bhej raha hoon.';
      }
    }
  } catch (e) {
    console.warn('[FreshBot] /session refresh:', e?.message || e);
    deliveryNote = 'Refresh fail hua — saved purana JSON bhej raha hoon.';
  }

  const delivered = await deliverSessionJson(ctx.chat?.id, {
    phone,
    accountKey,
    kind: deliveryKind,
    account: liveAccount,
    note: deliveryNote,
  });
  if (!delivered && getSessionExportJson(accountKey, liveAccount)) {
    await ctx.reply('⚠️ JSON phir bhi poora send nahi ho paya — thodi der baad /session dobara try karo.', { parse_mode: 'HTML' }).catch(() => {});
  }
});

// START → pehle source chuno (Hermes bot / HardXotp bot / Firebase).
bot.action('ap_start', showStartSourcePicker);
// Engine ke rows premium callback names bhi bhejta hai — same kaam, same handler
bot.action('prem_batch_start', showStartSourcePicker);

// 🌐 Toing Pro Web flow: Ask user to choose OTP bot (🐘 Hathi or 📨 Hermes)
bot.action('ap_start_toing_pro', async (ctx) => {
  if (!(await gate(ctx))) return;
  if (isAutopilotRunning()) {
    await ctx.answerCbQuery('Pehle se chal raha hai!', { show_alert: true }).catch(() => {});
    return;
  }
  await ctx.answerCbQuery().catch(() => {});
  const text = section('🌐 TOING PRO WEB SIGNUP', [
    'Toing Pro Web flow (storelex.store/toing_web API):',
    '• Mobile check (New user vs Existing user)',
    '• OTP Gateway trigger',
    '• Auto OTP verify & Session export (.json)',
    '',
    sub('Neeche apna Telegram OTP bot chunein jahan se number aur OTP claim karna hai:'),
  ].join('\n'));
  const rows = [
    [{ text: '🐘 Hathi OTP Bot (@Hathi_otp_bot)', callback_data: 'ap_start_go_toing_hathi', style: 'success' }],
    [{ text: '📨 Hermeshu OTP Bot (@HermeshuOTPROBOT)', callback_data: 'ap_start_go_toing_hermes', style: 'primary' }],
    [{ text: '↩️ Back', callback_data: 'ap_start' }],
  ];
  await ctx.editMessageText(text, kb(rows))
    .catch(async () => { await ctx.reply(text, kb(rows)).catch(() => {}); });
});

bot.action(new RegExp(`^ap_start_go_(${[...startPresets.START_SOURCE_PRESET_IDS, ...startPresets.LEGACY_START_SOURCE_PRESET_IDS, ...otpBotProfiles.OTP_BOT_PROFILE_IDS, 'firebase'].join('|')}|custom_[a-z0-9]+)$`), async (ctx) => {
  await launchBatch(ctx, { source: ctx.match[1] });
});

// ⚙️ Advanced source list (Firebase only / HardXotp / delete all)
bot.action('ap_start_adv', async (ctx) => {
  if (!(await gate(ctx))) return;
  if (isAutopilotRunning()) {
    await ctx.answerCbQuery('Pehle se chal raha hai!', { show_alert: true }).catch(() => {});
    return;
  }
  await ctx.answerCbQuery().catch(() => {});
  const text = section('⚙️ Advanced Source', [
    'Yahan se purane source bhi chun sakte ho.',
    '',
    sub('Normal use ke liye ↩️ Back karke teen main buttons hi kaafi hain.'),
  ].join('\n'));
  const rows = advancedSourceRows();
  await ctx.editMessageText(text, kb(rows))
    .catch(async () => { await ctx.reply(text, kb(rows)).catch(() => {}); });
});

// 🗑 Delete All Firebase — pehle confirm, phir poori list saaf + delete-memory
// (restart par seeding wapas na laaye). Batch chal raha ho to pehle STOP.
bot.action('ap_src_delete_all', async (ctx) => {
  if (!(await gate(ctx))) return;
  if (await blockSourceChangeWhileRunning(ctx)) return;
  const count = (() => { try { return sources.listSources().length; } catch { return 0; } })();
  await ctx.answerCbQuery().catch(() => {});
  const text = section('🗑 Delete All Firebase?', [
    `Abhi <b>${count} ACTIVE Firebase</b> sources hain.`,
    ``,
    `› Sab delete ho jayenge aur <b>Firebase mode OFF</b> rahega.`,
    `› Delete yaad rahega — restart/redeploy par seeding inhe wapas <b>nahi</b> laayegi.`,
    `› Hermes / HardXotp bot isse bilkul affect nahi hote.`,
    ``,
    sub('Wapas chahiye to naya DB add karo (Settings → Firebase Sources → Add Firebase).'),
  ].join('\n'));
  const rows = [
    [{ text: `🗑 Haan, Sab Delete Karo (${count})`, callback_data: 'ap_src_delete_all_yes', style: 'danger' }],
    [{ text: '↩️ Cancel', callback_data: 'ap_start', style: 'primary' }],
  ];
  await ctx.editMessageText(text, kb(rows))
    .catch(async () => { await ctx.reply(text, kb(rows)).catch(() => {}); });
});

bot.action('ap_src_delete_all_yes', async (ctx) => {
  if (!(await gate(ctx))) return;
  if (await blockSourceChangeWhileRunning(ctx)) return;
  let result = { removed: 0, remembered: 0 };
  try { result = sources.removeAllSources(); } catch (e) { console.warn('[FreshBot] delete all firebase:', e?.message || e); }
  try { sources.applyActiveSource(); } catch {}
  await ctx.answerCbQuery(`🗑 ${result.removed} Firebase delete ho gaye`).catch(() => {});
  const text = section('🗑 Firebase Saaf', [
    `✅ <b>${result.removed}</b> sources delete — ab Firebase mode OFF hai.`,
    `🧠 ${result.remembered || result.removed} URLs yaad rakhi gayi — restart par wapas nahi aayengi.`,
    ``,
    `📨 Hermes / 🔐 HardXotp bot isse untouched hain — START se woh chuno.`,
    sub('Naya DB add karte hi Firebase dobara chalu ho jayega.'),
  ].join('\n'));
  const rows = [
    [{ text: '▶️ START', callback_data: 'ap_start', style: 'success' }],
    [{ text: '🔥 Firebase Sources', callback_data: 'ap_sources', style: 'primary' }],
  ];
  await ctx.editMessageText(text, kb(rows))
    .catch(async () => { await ctx.reply(text, kb(rows)).catch(() => {}); });
});

bot.action('ap_stop', async (ctx) => {
  if (!(await gate(ctx))) return;
  const stopped = requestAutopilotStop('manual');
  await ctx.answerCbQuery(stopped ? '⏹ STOP signal bhej diya…' : 'Kuch chal nahi raha.').catch(() => {});
  if (stopped) await ctx.editMessageText('⏹ <b>Stop ho raha hai…</b> current number complete hoke ruk jayega.', kb(idleRows())).catch(() => {});
});
bot.action('prem_batch_stop', async (ctx) => {
  if (!(await gate(ctx))) return;
  const stopped = requestAutopilotStop('manual');
  await ctx.answerCbQuery(stopped ? '⏹ STOP signal bhej diya…' : 'Kuch chal nahi raha.').catch(() => {});
});

async function skipCurrentNumber(ctx) {
  if (!(await gate(ctx))) return;
  const result = requestAutopilotSkipCurrent('manual');
  if (!result?.ok) {
    await ctx.answerCbQuery(
      result?.reason === 'no-current-number'
        ? 'Abhi koi current number active nahi hai.'
        : 'Batch chal nahi raha — SKIP nahi ho sakta.',
      { show_alert: true }
    ).catch(() => {});
    return;
  }
  await ctx.answerCbQuery(
    result.already
      ? `⏭ ${result.phone} par SKIP pehle se laga hai…`
      : `⏭ ${result.phone} SKIP ho raha hai — NEW NUMBER aayega`
  ).catch(() => {});
  const snap = getAutopilotSnapshot();
  if (snap.running && ctx.callbackQuery?.message) {
    await ctx.editMessageText(runningCard(snap), kb(stopRows())).catch(() => {});
  }
}
bot.action('ap_skip_current', skipCurrentNumber);
bot.action('prem_batch_skip_current', skipCurrentNumber);

bot.action('ap_status', async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  const snap = getAutopilotSnapshot();
  const text = snap.running ? runningCard(snap) : (snap.finishedAt ? summaryCard(snap) : startCard());
  await ctx.editMessageText(text, kb(snap.running ? stopRows() : idleRows()))
    .catch(async () => { await ctx.reply(text, kb(snap.running ? stopRows() : idleRows())).catch(() => {}); });
});
bot.action('prem_batch_status', async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  const snap = getAutopilotSnapshot();
  const text = snap.running ? runningCard(snap) : (snap.finishedAt ? summaryCard(snap) : startCard());
  await ctx.reply(text, kb(snap.running ? stopRows() : idleRows())).catch(() => {});
});

// Engine ke rows me Main Menu / Get Number buttons bhi aate hain — yahan bas menu dikhao
bot.action('ap_home', async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  const text = startCard();
  await ctx.editMessageText(text, kb(isAutopilotRunning() ? stopRows() : startRows()))
    .catch(async () => { await ctx.reply(text, kb(isAutopilotRunning() ? stopRows() : startRows())).catch(() => {}); });
});
bot.action(['boss_panel_home', 'prem_get_number'], async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery('Is bot me sirf BATCH hai — START dabao. ✅', { show_alert: false }).catch(() => {});
  const text = startCard();
  await ctx.editMessageText(text, kb(isAutopilotRunning() ? stopRows() : startRows()))
    .catch(async () => { await ctx.reply(text, kb(isAutopilotRunning() ? stopRows() : startRows())).catch(() => {}); });
});

// ---------------------------------------------------------------------------
// ⚙️ Settings handlers — sources + knobs (kuch bhi text-input wait-state me)
// ---------------------------------------------------------------------------
const pending = new Map(); // uid → { action, srcId? } — text input ka wait-state

// ---------------------------------------------------------------------------
// 👤 Add Telegram Account — owner ki private chat ke andar spare-account login
// Ek waqt me sirf ek flow. Har input promise Teleproto ke auth callbacks ko
// jata hai; session/API hash/code/password chat me kabhi echo nahi hote.
// ---------------------------------------------------------------------------
const TELEGRAM_LOGIN_INPUT_TIMEOUT_MS = 10 * 60_000;
let telegramLoginFlow = null;

function telegramLoginAbortError(message = 'Telegram account login cancel/timeout ho gaya.') {
  const err = new Error(message);
  err.code = 'TELEGRAM_LOGIN_ABORTED';
  return err;
}

function telegramLoginStageLabel(stage) {
  return {
    starting: 'shuru ho raha hai',
    api_id: 'API ID ka wait',
    api_hash: 'API hash ka wait',
    connecting: 'connect ho raha hai',
    phone: 'phone ka wait',
    code: 'login code ka wait',
    password: '2FA password ka wait',
    name: 'naam ka wait',
    verifying: 'Hermes test',
  }[stage] || 'login chal raha hai';
}

function telegramLoginRows() {
  return [[
    { text: '✖️ Cancel Login', callback_data: 'ap_telegram_login_cancel', style: 'danger' },
    { text: '⚙️ Settings', callback_data: 'ap_settings', style: 'primary' },
  ]];
}

function maskTelegramLoginPhone(phone = '') {
  const clean = String(phone || '').trim();
  if (!clean) return '';
  if (clean.length <= 6) return '••••';
  return `${clean.slice(0, 3)}••••${clean.slice(-4)}`;
}

function shortTelegramLoginError(error) {
  return String(error?.message || error || 'Unknown error')
    .replace(/\s+/g, ' ')
    .slice(0, 220);
}

function clearTelegramLoginWait(flow) {
  if (flow?.timer) clearTimeout(flow.timer);
  if (flow) {
    flow.timer = null;
    flow.resolveInput = null;
    flow.rejectInput = null;
    const st = pending.get(flow.ownerId);
    if (st?.action === 'telegram_login' && st.flowId === flow.id) pending.delete(flow.ownerId);
  }
}

function finishTelegramLoginFlow(flow) {
  if (!flow) return;
  clearTelegramLoginWait(flow);
  flow.apiHash = '';
  flow.done = true;
  if (telegramLoginFlow === flow) telegramLoginFlow = null;
}

function cancelTelegramLoginFlow(reason = 'cancel') {
  const flow = telegramLoginFlow;
  if (!flow) return false;
  flow.cancelled = true;
  flow.cancelReason = reason;
  const reject = flow.rejectInput;
  clearTelegramLoginWait(flow);
  if (reject) {
    reject(telegramLoginAbortError(
      reason === 'timeout'
        ? 'Telegram login input ka time khatam ho gaya.'
        : 'Telegram account login cancel ho gaya.'
    ));
  }
  return true;
}

async function sendTelegramLoginMessage(flow, text, rows = telegramLoginRows()) {
  if (!flow?.chatId) return null;
  return bot.telegram.sendMessage(flow.chatId, text, kb(rows)).catch((e) => {
    console.warn('[FreshBot] Telegram login prompt send:', e?.message || e);
    return null;
  });
}

async function waitForTelegramLoginInput(flow, stage, prompt) {
  if (!flow || flow.cancelled || telegramLoginFlow !== flow) throw telegramLoginAbortError();
  if (flow.resolveInput) throw new Error('Telegram login input pehle se pending hai.');

  flow.stage = stage;
  let resolveInput;
  let rejectInput;
  const inputPromise = new Promise((resolve, reject) => {
    resolveInput = resolve;
    rejectInput = reject;
  });
  flow.resolveInput = resolveInput;
  flow.rejectInput = rejectInput;
  pending.set(flow.ownerId, { action: 'telegram_login', flowId: flow.id, stage });
  flow.timer = setTimeout(() => {
    const reject = flow.rejectInput;
    flow.cancelled = true;
    flow.cancelReason = 'timeout';
    clearTelegramLoginWait(flow);
    reject?.(telegramLoginAbortError('Telegram login input ka time khatam ho gaya.'));
  }, TELEGRAM_LOGIN_INPUT_TIMEOUT_MS);
  flow.timer.unref?.();

  const sent = await sendTelegramLoginMessage(flow, prompt);
  if (!sent && flow.resolveInput === resolveInput) {
    clearTelegramLoginWait(flow);
    throw new Error('Telegram login prompt nahi bhej paya — bot chat check karke dobara try karo.');
  }
  return inputPromise;
}

async function askTelegramLoginValue(flow, stage, prompt, validate) {
  for (;;) {
    const raw = await waitForTelegramLoginInput(flow, stage, prompt);
    const checked = validate(raw);
    if (checked?.ok) return checked.value;
    await sendTelegramLoginMessage(flow, section('⚠️ Input Sahi Nahi', [
      esc(checked?.error || 'Dobara sahi value bhejo.'),
      ``,
      sub('Sahi value dubara bhejo, ya Cancel dabao.'),
    ].join('\n')));
  }
}

function telegramAccountCard() {
  const status = telegramProviderStatus();
  const botName = String(status.botUsername || 'HermeshuOTPROBOT').replace(/^@+/, '');
  const flow = telegramLoginFlow;
  const ready = Boolean(status.apiIdPresent && status.apiHashPresent && status.sessionPresent);
  return section('👤 Telegram Account', [
    field('Status', (flow || status.loginInProgress) ? '⏳ LOGIN CHAL RAHA' : (ready ? 'READY' : 'SETUP PENDING')),
    field('Bot', `@${botName}`),
    field('API ID', status.apiIdPresent ? '✅ saved' : '❌ missing'),
    field('API hash', status.apiHashPresent ? '✅ saved' : '❌ missing'),
    field('Session', status.sessionPresent ? '✅ saved' : '❌ login nahi'),
    status.me ? field('Account', status.me) : '',
    flow ? field('Stage', telegramLoginStageLabel(flow.stage)) : '',
    status.loginInProgress && !flow ? field('Stage', 'provider me login chal raha hai') : '',
    ``,
    sub('Sirf spare account. Session chat me kabhi nahi dikhegi.'),
  ].filter(Boolean).join('\n'));
}

async function requirePrivateTelegramChat(ctx, actionLabel = 'Telegram account action') {
  if (ctx.chat?.type === 'private') return true;
  await ctx.answerCbQuery(`${actionLabel} sirf bot ki private chat me hoga.`, { show_alert: true }).catch(() => {});
  return false;
}

async function runTelegramLoginFlow(flow) {
  try {
    const initialStatus = telegramProviderStatus();
    if (!initialStatus.apiIdPresent) {
      flow.apiId = await askTelegramLoginValue(
        flow,
        'api_id',
        section('👤 Telegram Setup · 1/2', [
          field('Status', 'API ID saved nahi'),
          field('Chahiye', 'numeric API ID'),
          field('Kahan se', 'my.telegram.org → API development tools'),
          ``,
          '<b>Send:</b> API ID yahan bhejo (sirf digits).',
          sub('Input delete hoga. Sirf spare account.'),
        ].join('\n')),
        (raw) => {
          const value = String(raw || '').trim();
          return /^\d{3,15}$/.test(value)
            ? { ok: true, value }
            : { ok: false, error: 'API ID sirf digits me bhejo (my.telegram.org wali numeric ID).' };
        }
      );
    }
    if (!initialStatus.apiHashPresent) {
      flow.apiHash = await askTelegramLoginValue(
        flow,
        'api_hash',
        section('👤 Telegram Setup · 2/2', [
          field('Chahiye', 'API hash'),
          field('App', 'wahi API app (my.telegram.org)'),
          ``,
          '<b>Send:</b> API hash yahan bhejo.',
          sub('Hash chat me dobara nahi dikhega; input delete hoga.'),
        ].join('\n')),
        (raw) => {
          const value = String(raw || '').trim().replace(/^['"]+|['"]+$/g, '');
          return value.length >= 16 && !/\s/.test(value)
            ? { ok: true, value }
            : { ok: false, error: 'API hash sahi nahi laga — spaces ke bina poora hash bhejo.' };
        }
      );
    }

    flow.stage = 'connecting';
    await sendTelegramLoginMessage(flow, section('🔐 Telegram Login', [
      field('Flow', 'phone → login code'),
      `Spare account se connect kar raha hoon…`,
      ``,
      sub('Code/password message milte hi delete hoga.'),
    ].join('\n')));

    const result = await telegramOtp.loginTelegramUserInteractive({
      phoneNumber: async () => {
        const phone = await askTelegramLoginValue(
          flow,
          'phone',
          section('📱 Spare Telegram Number', [
            field('Chahiye', 'spare account ka phone'),
            field('Format', '+91XXXXXXXXXX ya 10-digit'),
            ``,
            '<b>Send:</b> phone number yahan bhejo.',
          ].join('\n')),
          (raw) => {
            const value = telegramOtp.normalizeTelegramLoginPhone?.(raw) || '';
            return value
              ? { ok: true, value }
              : { ok: false, error: 'Valid phone bhejo — Indian 10-digit ya country code ke saath.' };
          }
        );
        flow.phone = phone;
        return phone;
      },
      phoneCode: async (isCodeViaApp, info) => {
        const delivery = String(info?.type || (isCodeViaApp ? 'Telegram app' : 'SMS/call'));
        return askTelegramLoginValue(
          flow,
          'code',
          section('🔑 Telegram Login Code', [
            field('Delivery', delivery),
            ``,
            '<b>Send:</b> Telegram ka login code yahan bhejo.',
            sub('Ye Hermes OTP nahi — spare Telegram account ka login code hai.'),
          ].join('\n')),
          (raw) => {
            const value = String(raw || '').replace(/[\s-]+/g, '').trim();
            return value && value.length <= 20
              ? { ok: true, value }
              : { ok: false, error: 'Login code khali ya bahut lamba hai — sahi code dobara bhejo.' };
          }
        );
      },
      password: async (hint) => askTelegramLoginValue(
        flow,
        'password',
        section('🔐 Telegram 2FA Password', [
          field('Status', 'two-step verification ON'),
          hint ? field('Hint', String(hint).slice(0, 80)) : '',
          ``,
          '<b>Send:</b> 2FA password yahan bhejo.',
        ].filter(Boolean).join('\n')),
        (raw) => {
          const value = String(raw ?? '');
          return value.length > 0
            ? { ok: true, value }
            : { ok: false, error: '2FA password khali hai — password dobara bhejo.' };
        }
      ),
      firstAndLastNames: async () => askTelegramLoginValue(
        flow,
        'name',
        section('👤 Naya Telegram Account', [
          field('Status', 'is number par account registered nahi'),
          ``,
          '<b>Send:</b> display name bhejo (jaise Spare Account).',
          sub('Naya account nahi banana? Cancel dabao.'),
        ].join('\n')),
        (raw) => {
          const value = String(raw || '').trim();
          return value
            ? { ok: true, value }
            : { ok: false, error: 'Display name khali hai — naam dobara bhejo.' };
        }
      ),
      onError: async (error) => {
        if (flow.cancelled) return true;
        const message = shortTelegramLoginError(error);
        const unrecoverable = /API_ID_INVALID|API_HASH_INVALID|PHONE_NUMBER_BANNED|FLOOD_WAIT|AUTH_KEY_(UNREGISTERED|DUPLICATED)|USER_DEACTIVATED|PHONE_NUMBER_INVALID/i.test(message);
        await sendTelegramLoginMessage(flow, section(
          unrecoverable ? '❌ Telegram Login Ruk Gaya' : '⚠️ Telegram Ne Retry Manga',
          [
            esc(message),
            ``,
            sub(unrecoverable
              ? 'Details check karke Add Telegram Account dobara start karo.'
              : 'Galat code/password ho to agla prompt aayega — sahi value wahan bhejo.'),
          ].join('\n')
        )).catch(() => {});
        return unrecoverable;
      },
    }, {
      apiId: flow.apiId || undefined,
      apiHash: flow.apiHash || undefined,
      shouldAbort: () => Boolean(flow.cancelled || telegramLoginFlow !== flow),
    });

    if (flow.cancelled) throw telegramLoginAbortError();
    flow.apiHash = '';
    try { bs.setSetting('telegramOtpMode', true); } catch {}

    flow.stage = 'verifying';
    let verifyLine = 'Hermes test baaki hai — Settings → 🧪 Test Hermes dabao.';
    try {
      const verify = await telegramOtp.verifyTelegramOtpConnection({ sendStartIfEmpty: true });
      const verifyBot = String(verify.botUsername || result.botUsername || 'HermeshuOTPROBOT').replace(/^@+/, '');
      verifyLine = `@${verifyBot} connect ho gaya${verify.currentPhone ? ` · current number ${verify.currentPhone}` : ''}${verify.buttons?.length ? ` · buttons mile: ${verify.buttons.slice(0, 6).join(' · ')}` : ''}`;
    } catch (e) {
      verifyLine = `Login saved hai, lekin Hermes test abhi fail: ${shortTelegramLoginError(e)} — Settings → 🧪 Test Hermes se dobara check karo.`;
    }

    await sendTelegramLoginMessage(flow, section('✅ Telegram Account Add Ho Gaya', [
      field('Account', esc(result.me || result.accountLabel || maskTelegramLoginPhone(result.phone || flow.phone) || 'saved')),
      field('Hermes mode', '📨 ON (Telegram only)'),
      field('Hermes test', esc(verifyLine)),
      field('Session', '🔐 secure saved — chat me kabhi nahi dikhegi'),
      field('World Bot', `✅ isi account se @${esc(worldBot.worldBotUsername())} ke buttons click honge`),
      field('Shop Bot stock', `✅ isi account se @${esc(shopStock.shopBotConfig().username)} ko JSON files jayengi`),
      ``,
      sub('Ek spare account hi kaafi hai. Ab START dabao.'),
    ].join('\n')), settingsRows());
  } catch (error) {
    const aborted = flow.cancelled || error?.code === 'TELEGRAM_LOGIN_ABORTED' || /AUTH_USER_CANCEL|cancel\/timeout/i.test(String(error?.message || ''));
    if (!flow.done) {
      await sendTelegramLoginMessage(flow, section(
        aborted ? '✖️ Telegram Login Cancel' : '❌ Telegram Login Fail',
        [
          esc(aborted
            ? 'Login flow band kar diya gaya hai. Partial session save nahi hui.'
            : shortTelegramLoginError(error)),
          ``,
          sub('Settings → Add Telegram Account se dobara try kar sakte ho.'),
        ].join('\n')
      ), settingsRows()).catch(() => {});
    }
    if (!aborted) console.warn('[FreshBot] Telegram account login fail:', shortTelegramLoginError(error));
  } finally {
    finishTelegramLoginFlow(flow);
  }
}

async function startTelegramLoginFlow(ctx) {
  if (!(await requirePrivateTelegramChat(ctx, 'Add Telegram Account'))) return;
  if (isAutopilotRunning()) {
    await ctx.answerCbQuery('⏳ Batch chal raha hai — pehle STOP karo, phir Telegram account add karo.', { show_alert: true }).catch(() => {});
    return;
  }
  if (telegramLoginFlow) {
    await ctx.answerCbQuery(`⏳ Login pehle se chal raha hai: ${telegramLoginStageLabel(telegramLoginFlow.stage)}`, { show_alert: true }).catch(() => {});
    await editOrSend(ctx, telegramAccountCard(), telegramLoginRows());
    return;
  }
  const status = telegramProviderStatus();
  if (status.loginInProgress) {
    await ctx.answerCbQuery('⏳ Telegram login provider me pehle se chal raha hai.', { show_alert: true }).catch(() => {});
    await editOrSend(ctx, telegramAccountCard(), telegramLoginRows());
    return;
  }

  const flow = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    ownerId: String(ctx.from.id),
    chatId: ctx.chat.id,
    stage: 'starting',
    startedAt: Date.now(),
    cancelled: false,
    cancelReason: '',
    done: false,
    deleteWarned: false,
    apiId: '',
    apiHash: '',
    phone: '',
    resolveInput: null,
    rejectInput: null,
    timer: null,
  };
  telegramLoginFlow = flow;
  await ctx.answerCbQuery('👤 Telegram login shuru…').catch(() => {});
  await editOrSend(ctx, section('👤 Add Telegram Account', [
    field('Saved session', status.sessionPresent ? '⚠️ replace hoga' : '— koi nahi'),
    field('Kahan', 'is private chat me'),
    ``,
    '<b>Next:</b> har prompt par value bhejo — rokne ke liye Cancel.',
    sub('Session chat me kabhi nahi dikhegi; main account mat use karo.'),
  ].filter(Boolean).join('\n')), telegramLoginRows());
  runTelegramLoginFlow(flow).catch((e) => console.error('[FreshBot] telegram login runner:', e?.stack || e?.message || e));
}

const editOrSend = async (ctx, text, rows) => {
  await ctx.editMessageText(text, kb(rows))
    .catch(async () => { await ctx.reply(text, kb(rows)).catch(() => {}); });
};

bot.action('ap_settings', async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  await editOrSend(ctx, settingsCard(), settingsRows());
});

bot.action('ap_diag', async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery('🩺 Checking…').catch(() => {});
  await editOrSend(ctx, '🩺 Check kar raha hoon… (pool test me ~15s lag sakta hai)', [[{ text: '↩️ Settings', callback_data: 'ap_settings', style: 'primary' }]]);
  const text = await diagCard();
  await editOrSend(ctx, text, [[{ text: '↩️ Settings', callback_data: 'ap_settings', style: 'primary' }]]);
});

bot.action('ap_sources', async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  const { text, rows } = sourcesCard();
  await editOrSend(ctx, text, rows);
});

bot.action(/^ap_sources_p(\d+)$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  const { text, rows } = sourcesCard(Number(ctx.match[1]));
  await editOrSend(ctx, text, rows);
});

// Source detail — regex har naye source id tak match karega
bot.action(/^ap_src_(?!add$)([a-f0-9-]{1,10})$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  const { text, rows } = sourceDetailCard(ctx.match[1]);
  await editOrSend(ctx, text, rows);
});

async function blockSourceChangeWhileRunning(ctx) {
  if (!isAutopilotRunning()) return false;
  await ctx.answerCbQuery(
    '⏳ Batch chal raha hai — pehle STOP karein. Beech me Firebase badalna OTP ko galat DB par bhej dega.',
    { show_alert: true }
  ).catch(() => {});
  return true;
}

bot.action(/^ap_src_use_([a-f0-9-]{1,10})$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  if (await blockSourceChangeWhileRunning(ctx)) return;
  const r = sources.setActiveSource(ctx.match[1]);
  await ctx.answerCbQuery(
    r.ok ? '⭐ First-try set — saare Firebase ACTIVE hi rahenge.' : `❌ ${r.error}`,
    !r.ok && { show_alert: true }
  ).catch(() => {});
  const { text, rows } = r.ok ? sourcesCard(sourcePageFor(ctx.match[1])) : sourceDetailCard(ctx.match[1]);
  await editOrSend(ctx, text, rows);
});

// Purane keyboards me Disable button ho sakta hai. Naye rule me ye kabhi
// source ko off nahi karega — hatana ho to sirf Delete.
bot.action(/^ap_src_toggle_([a-f0-9-]{1,10})$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  const r = sources.toggleSource(ctx.match[1]);
  await ctx.answerCbQuery(
    r.ok ? '✅ Ye Firebase hamesha ACTIVE rahega — hatana ho to Delete karein.' : `❌ ${r.error}`,
    { show_alert: true }
  ).catch(() => {});
  const { text, rows } = sourceDetailCard(ctx.match[1]);
  await editOrSend(ctx, text, rows);
});

bot.action(/^ap_src_verify_(.{1,10})$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery('🧪 Testing…').catch(() => {});
  const id = ctx.match[1];
  const r = await sources.verifySource(id);
  const s = sources.getSource(id);
  const name = s ? esc(s.name) : id;
  const text = r.ok
    ? section('🧪 Verify — OK', [
        `<b>${name}</b>: reachable in ${r.ms}ms.`,
        r.topKeys?.length ? `Top keys: <code>${esc(r.topKeys.join(', '))}</code>` : 'Root khali hai.',
      ].join('\n'))
    : section('🧪 Verify — FAILED', [
        `<b>${name}</b>: ${esc(r.error)}`,
        sub('URL/auth/rules check karein.'),
      ].join('\n'));
  await editOrSend(ctx, text, [
    [{ text: '↩️ Source', callback_data: `ap_src_${id}` }],
  ]);
});

bot.action(/^ap_src_del_(.{1,10})$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  if (await blockSourceChangeWhileRunning(ctx)) return;
  const r = sources.removeSource(ctx.match[1]);
  await ctx.answerCbQuery(r.ok ? '🗑 Delete ho gaya.' : `❌ ${r.error}`, !r.ok && { show_alert: true }).catch(() => {});
  sources.applyActiveSource();
  const { text, rows } = sourcesCard(sourcePageFor(sources.getActiveSource()?.id));
  await editOrSend(ctx, text, rows);
});

// ➕ Add Firebase — ek ya bahut saare URLs ek hi message me.
// Har add hote hi ACTIVE ho jayega aur Delete tak ACTIVE rahega.
bot.action('ap_src_add', async (ctx) => {
  if (!(await gate(ctx))) return;
  if (await blockSourceChangeWhileRunning(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  pending.set(String(ctx.from.id), { action: 'add_source' });
  await editOrSend(ctx, section('➕ Add Firebase — Bulk Bhi Chalega', [
    `Ab <b>ek ya bahut saare Firebase URL ek saath bhejo</b> — har line me ek,`,
    `ya comma se alag karke:`,
    `<code>https://one-default-rtdb.firebaseio.com/</code>`,
    `<code>https://two-default-rtdb.firebaseio.com/</code>`,
    `<code>https://three-default-rtdb.firebaseio.com/</code>`,
    ``,
    `Kisi URL ko auth lage to usi line par pipe ke saath:`,
    `<code>&lt;url&gt; | &lt;DB_AUTH_secret&gt;</code>`,
    ``,
    `✅ Add hote hi <b>saare ACTIVE</b> ho jayenge aur Delete tak ACTIVE rahenge.`,
    `📦 Ek message me <b>${sources.MAX_BULK_FIREBASE_SOURCES}</b> tak URLs. Duplicate khud skip.`,
    sub('Ye list cloud vault me bhi save hoti hai — Render restart/redeploy par gayab nahi hogi. Cancel ke liye /start dabao.'),
  ].join('\n')), [[{ text: '↩️ Cancel', callback_data: 'ap_sources', style: 'primary' }]]);
});

// ---------------------------------------------------------------------------
// 🔀 Proxy handlers — add (text input) / toggle / delete / rotation on-off
// ---------------------------------------------------------------------------
bot.action('ap_proxies', async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  // 🌍 World Bot mode: proxy pool ka concept nahi — sirf saaf jawab.
  if (bs.getSetting('accountEngine') === 'worldbot') {
    await editOrSend(ctx, section('🌍 World Bot ON', [
      '› Login, OTP aur account banane ka kaam Swiggy World Bot ke andar hota hai.',
      '',
      sub('Engine badalna ho to Settings → 🌍 Account engine.'),
    ].join('\n')), [[{ text: '↩️ Settings', callback_data: 'ap_settings', style: 'primary' }]]);
    return;
  }
  const { text, rows } = proxiesCard();
  await editOrSend(ctx, text, rows);
});

bot.action(/^ap_px_(?!add$|rot$|free$|autotoggle$)([a-f0-9-]{1,10})$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  const { text, rows } = proxyDetailCard(ctx.match[1]);
  await editOrSend(ctx, text, rows);
});

bot.action(/^ap_px_toggle_([a-f0-9-]{1,10})$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  const r = proxyPool.toggleProxy(ctx.match[1]);
  await ctx.answerCbQuery(r.ok ? (r.enabled ? '▫️ Enabled' : '🚫 Disabled') : `❌ ${r.error}`, !r.ok && { show_alert: true }).catch(() => {});
  const { text, rows } = proxiesCard();
  await editOrSend(ctx, text, rows);
});

bot.action(/^ap_px_del_([a-f0-9-]{1,10})$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  const r = proxyPool.removeProxy(ctx.match[1]);
  await ctx.answerCbQuery(r.ok ? '🗑 Delete ho gaya.' : `❌ ${r.error}`, !r.ok && { show_alert: true }).catch(() => {});
  const { text, rows } = proxiesCard();
  await editOrSend(ctx, text, rows);
});

bot.action('ap_px_rot', async (ctx) => {
  if (!(await gate(ctx))) return;
  const cur = proxyPool.proxySummary().enabled;
  const r = proxyPool.setPoolEnabled(!cur);
  await ctx.answerCbQuery(r.ok ? (r.enabled ? '▶️ Rotation ON' : '⏸ Rotation OFF') : `❌ ${r.error}`, !r.ok && { show_alert: true }).catch(() => {});
  const { text, rows } = proxiesCard();
  await editOrSend(ctx, text, rows);
});

// 🌐 Free Proxies Lao — kai public lists se la kar pehle generic HTTPS,
// phir seedha Swiggy par test. Clean pehle; WAF-challenged lekin reachable
// proxies bhi fallback tier me pool me rehti hain (token solve se chalti hain).
bot.action('ap_px_free', async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery('🌐 Free proxies dhoondh raha hoon…').catch(() => {});
  const backRows = [[{ text: '↩️ Proxies', callback_data: 'ap_proxies', style: 'primary' }]];
  await editOrSend(ctx, section('🌐 Free Proxies La Raha Hoon', [
    '› Kai public free lists se candidates la raha hoon…',
    '› Har ek ko pehle HTTPS, phir <b>seedha Swiggy par test</b> kar raha hoon…',
    '',
    sub('Zinda proxies kam milen to 1–2 minute lag sakte hain. Progress yahi card par dikhega.'),
  ].join('\n')), backRows);
  let finished = false;
  let lastProgressAt = 0;
  let progressPromise = Promise.resolve();
  try {
    const r = await proxyPool.refreshFreeProxies({
      want: 30,
      onProgress: ({ checked = 0, clean = 0, challenged = 0, total = 0 } = {}) => {
        const now = Date.now();
        if (finished || now - lastProgressAt < 10_000) return;
        lastProgressAt = now;
        progressPromise = editOrSend(ctx, section('🌐 Free Proxies Test Ho Rahi Hain', [
          `🧪 Parkhin: <b>${checked}${total ? `/${total}` : ''}</b>`,
          `✅ Clean mili: <b>${clean}</b>`,
          `🛡 Swiggy-reachable (WAF challenge): <b>${challenged}</b>`,
          '',
          sub('Clean 30 milte hi ruk jaunga; warna deadline tak best fallback bhi jama karunga.'),
        ].join('\n')), backRows).catch(() => {});
      },
    });
    finished = true;
    await progressPromise.catch(() => {});
    const ps = proxyPool.proxySummary();
    const reasons = (r?.stats?.reasons || []).slice(0, 3)
      .map((x) => `${x.reason}×${x.count}`).join(', ');
    await editOrSend(ctx, section('🌐 Free Proxies — Result', [
      r?.added
        ? `✅ <b>${r.added} proxies</b> pool me daal di — ${r.keptClean || 0} clean + ${r.keptChallenged || 0} 🛡 WAF-ready.`
        : `⚠️ Is baar koi bhi proxy Swiggy tak nahi pohanchi. Thodi der baad phir dabana — free proxies aati-jaati rehti hain.`,
      `📥 Sources: <b>${r?.sourcesOk || 0}/${r?.sourcesTotal || 0}</b> · candidates: <b>${r?.candidates || 0}</b> · parkhin: <b>${r?.checked || 0}</b>`,
      `🔀 Pool ab: <b>${ps.enabledCount}/${ps.total} ON</b> (${ps.autoCount} auto) — ${esc(ps.rotation)}`,
      reasons ? sub(`Dead ki top wajuhat: ${esc(reasons)}`) : '',
      '',
      sub('Clean proxies pehle use hongi; 🛡 wali par browser WAF token solve hoga. Mari hui auto proxies agle refresh par khud nikal jayengi.'),
    ].filter(Boolean).join('\n')), backRows);
  } catch (e) {
    finished = true;
    await progressPromise.catch(() => {});
    await editOrSend(ctx, section('🌐 Free Proxies — Fail', [
      `❌ <code>${esc(String(e?.message || e).slice(0, 200))}</code>`,
      sub('Kuch list sources down ho sakte hain — thodi der baad phir try karo, ya apni proxy ➕ se add kar do.'),
    ].join('\n')), backRows);
  }
});

// 🌐 Auto-fetch on/off (batch-start par khud laana)
bot.action('ap_px_autotoggle', async (ctx) => {
  if (!(await gate(ctx))) return;
  const cur = proxyPool.proxySummary().autoFree;
  const r = proxyPool.setAutoFree(!cur);
  await ctx.answerCbQuery(r.autoFree ? '🌐 Free auto-fetch ON' : '🌐 Free auto-fetch OFF').catch(() => {});
  const { text, rows } = proxiesCard();
  await editOrSend(ctx, text, rows);
});

// ➕ Add Proxy — bot proxy string text me maangta hai
bot.action('ap_px_add', async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  pending.set(String(ctx.from.id), { action: 'add_proxy' });
  await editOrSend(ctx, section('➕ Add Proxy', [
    `Ab <b>proxy bhejo</b>. Formats:`,
    `<code>host:port</code>`,
    `<code>http://user:pass@host:port</code>`,
    `<code>socks5://host:port</code>`,
    ``,
    `Ek saath bahut saare bhejne ho to line me (comma):`,
    `<code>host1:port1, host2:port2</code>`,
    ``,
    sub('Add hote hi rotation ON — bot turant nayi IP se traffic bhejega.'),
  ].join('\n')), [[{ text: '↩️ Cancel', callback_data: 'ap_proxies', style: 'primary' }]]);
});

// ===== 🧙‍♂️ QUICK SETUP WIZARD — ek tap me saara setup =====
//   1) Account engine: Chromium vs Swiggy World Bot
//   2) OTP bot: Hermes / Hathi / Chauhan
//   3) Proxy: with or without (agar with to URL paste karo)
//   4) Confirm: saara setup dikhao → Start / Cancel

function setupWizardCard(st) {
  const c = st.choices || {};
  const engineLabel = c.accountEngine === 'worldbot' ? '🌍 Swiggy World Bot' : '🧩 Chromium (Direct API)';
  const otpLabel = c.otpBotProfile ? otpBotProfiles.getOtpBotProfile(c.otpBotProfile).uiLabel : '—';
  const proxyLabel = c.proxy === 'yes' ? '✅ With Proxy' : '❌ Without Proxy (Direct)';
  const proxyDetail = c.proxyUrl ? ` · <code>${esc(c.proxyUrl.replace(/\/\/[^@]*@/, '//***:***@'))}</code>` : '';

  const lines = [
    '🧙‍♂️ <b>Quick Setup — sab kuch ek saath</b>',
    '',
    `1️⃣ Account Engine: <b>${engineLabel}</b>`,
    `2️⃣ OTP Bot: <b>${otpLabel}</b>`,
    `3️⃣ Proxy: <b>${proxyLabel}</b>${proxyDetail}`,
    '',
  ];

  const rows = [];
  const stage = st.stage;

  if (stage === 'engine') {
    lines.push('Kaunsa Swiggy account engine chahiye?');
    rows.push([
      { text: '🧩 Chromium (Direct API)', callback_data: 'ap_setup_engine_direct', style: 'success' },
      { text: '🌍 Swiggy World Bot', callback_data: 'ap_setup_engine_worldbot', style: 'primary' },
    ]);
  } else if (stage === 'otp_bot') {
    lines.push('Kaunsa OTP bot number + OTP dega?');
    const profiles = otpBotProfiles.listOtpBotProfiles();
    for (const p of profiles) {
      rows.push([{ text: `${p.emoji} ${p.uiLabel} (@${p.username})`, callback_data: `ap_setup_otp_${p.id}`, style: 'success' }]);
    }
  } else if (stage === 'proxy_choice') {
    lines.push('Proxy use karna hai?');
    rows.push([
      { text: '✅ Haan — apna proxy URL paanga', callback_data: 'ap_setup_proxy_yes', style: 'success' },
      { text: '❌ Nahi — direct (bina proxy)', callback_data: 'ap_setup_proxy_no', style: 'primary' },
    ]);
  } else if (stage === 'confirm') {
    lines.push('Sab set hai. Start dabao taaki batch shuru ho, ya Cancel karke wapas jao.');
    rows.push([
      { text: '🚀 START BATCH', callback_data: 'ap_setup_confirm_start', style: 'success' },
      { text: '❌ Cancel', callback_data: 'ap_setup_confirm_cancel', style: 'danger' },
    ]);
  }

  rows.push([{ text: '↩️ Back', callback_data: 'ap_settings', style: 'primary' }]);

  return { text: lines.join('\n'), rows };
}

// Start wizard
bot.action('ap_setup_wizard', async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  pending.set(String(ctx.from.id), { action: 'setup_wizard', stage: 'engine', choices: {} });
  const card = setupWizardCard(pending.get(String(ctx.from.id)));
  await editOrSend(ctx, card.text, card.rows);
});

// Engine choice
bot.action('ap_setup_engine_direct', async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  const st = pending.get(String(ctx.from.id));
  if (!st || st.action !== 'setup_wizard') return;
  st.choices.accountEngine = 'direct';
  st.stage = 'otp_bot';
  pending.set(String(ctx.from.id), st);
  const card = setupWizardCard(st);
  await editOrSend(ctx, card.text, card.rows);
});

bot.action('ap_setup_engine_worldbot', async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  const st = pending.get(String(ctx.from.id));
  if (!st || st.action !== 'setup_wizard') return;
  st.choices.accountEngine = 'worldbot';
  st.stage = 'otp_bot';
  pending.set(String(ctx.from.id), st);
  const card = setupWizardCard(st);
  await editOrSend(ctx, card.text, card.rows);
});

// OTP bot choice
bot.action(/^ap_setup_otp_(hermes|hathi|chauhan|custom_[a-z0-9]+)$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  const st = pending.get(String(ctx.from.id));
  if (!st || st.action !== 'setup_wizard') return;
  st.choices.otpBotProfile = ctx.match[1];
  st.stage = 'proxy_choice';
  pending.set(String(ctx.from.id), st);
  const card = setupWizardCard(st);
  await editOrSend(ctx, card.text, card.rows);
});

// Proxy choice — yes -> paste URL
bot.action('ap_setup_proxy_yes', async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  const st = pending.get(String(ctx.from.id));
  if (!st || st.action !== 'setup_wizard') return;
  st.choices.proxy = 'yes';
  st.stage = 'proxy_paste';
  pending.set(String(ctx.from.id), st);
  await editOrSend(ctx, section('🌐 Proxy Paste', [
    `Ab <b>proxy URL bhejo</b>. Format:`,
    `<code>http://user:pass@host:port</code>`,
    '',
    `Jaise:`,
    `<code>http://res-in-sid-qopmefn2:pgw-968e1db878249b7d70e51b0a1b8279758a0a5f6a3c19ac18@gw.proxyrise.com:443</code>`,
    '',
    sub('Add hote hi rotation ON ho jayegi. Cancel se wapas settings par.'),
  ].join('\n')), [[{ text: '❌ Cancel', callback_data: 'ap_setup_confirm_cancel', style: 'danger' }]]);
});

// Proxy choice — no -> skip to confirm
bot.action('ap_setup_proxy_no', async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  const st = pending.get(String(ctx.from.id));
  if (!st || st.action !== 'setup_wizard') return;
  st.choices.proxy = 'no';
  st.stage = 'confirm';
  pending.set(String(ctx.from.id), st);
  const card = setupWizardCard(st);
  await editOrSend(ctx, card.text, card.rows);
});

// Confirm — apply settings and start batch
bot.action('ap_setup_confirm_start', async (ctx) => {
  if (!(await gate(ctx))) return;
  if (isAutopilotRunning()) {
    await ctx.answerCbQuery('Pehle se chal raha hai!', { show_alert: true }).catch(() => {});
    return;
  }
  await ctx.answerCbQuery('🚀 Setup apply kar raha hoon…').catch(() => {});
  const st = pending.get(String(ctx.from.id));
  if (!st || st.action !== 'setup_wizard') return;
  const c = st.choices || {};

  // Apply all settings
  try { bs.setSetting('accountEngine', c.accountEngine === 'worldbot' ? 'worldbot' : 'direct'); } catch {}
  try { bs.setSetting('telegramOtpMode', true); } catch {}
  if (c.otpBotProfile) {
    try { bs.setSetting('otpBotProfile', c.otpBotProfile); } catch {}
    try { telegramOtp.setActiveOtpBotProfile(c.otpBotProfile); } catch {}
  }

  // Source preset based on engine
  const sourcePreset = c.accountEngine === 'worldbot' ? 'otp_world' : 'otp_chromium';

  pending.delete(String(ctx.from.id));

  // Launch via existing launchBatch (validates prereqs, starts autopilot)
  await launchBatch(ctx, { source: sourcePreset });
});

// Cancel wizard
bot.action('ap_setup_confirm_cancel', async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery('Cancel kar diya.').catch(() => {});
  pending.delete(String(ctx.from.id));
  await editOrSend(ctx, settingsCard(), settingsRows());
});

// 🎯/⏱/🚦 pickers
bot.action('ap_pick_target', async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  await editOrSend(ctx, section('🎯 Target — kitne fresh sessions?', [
    `Abhi: <b>${bs.getSetting('target')}</b>`,
    ``,
    sub('Ya koi bhi number likh kar bhejo (1–5000), jaise: 150'),
  ].join('\n')), pickRows('ap_set_target_', TARGET_PRESETS, [[{ text: '✏️ Custom number', callback_data: 'ap_custom_target' }]]));
});

bot.action(/^ap_set_target_(\d+)$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  const r = bs.setSetting('target', Number(ctx.match[1]));
  await ctx.answerCbQuery(r.ok ? `🎯 Target = ${r.value}` : `❌ ${r.error}`, !r.ok && { show_alert: true }).catch(() => {});
  await editOrSend(ctx, settingsCard(), settingsRows());
});

bot.action('ap_custom_target', async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  pending.set(String(ctx.from.id), { action: 'custom_target' });
  await editOrSend(ctx, section('✏️ Custom Target', [
    `Kitne fresh sessions chahiye? <b>Number likh kar bhejo</b> (1–5000):`,
    `Jaise: <code>150</code>`,
  ].join('\n')), [[{ text: '↩️ Cancel', callback_data: 'ap_settings', style: 'primary' }]]);
});

bot.action('ap_pick_parallel', async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  await editOrSend(ctx, section('⚡ Parallel Lanes — ek saath kitne numbers?', [
    `Abhi: <b>${bs.getSetting('concurrency')}</b> lanes`,
    ``,
    sub('Har active lane alag number + alag proxy/IP legi. Jitni usable IPs hongi utni lanes asal me chalengi; proxy na ho to direct sirf 1 lane hogi.'),
  ].join('\n')), pickRows('ap_set_parallel_', PARALLEL_PRESETS));
});

bot.action(/^ap_set_parallel_(\d+)$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  const r = bs.setSetting('concurrency', Number(ctx.match[1]));
  await ctx.answerCbQuery(r.ok ? `⚡ Parallel = ${r.value} lanes` : `❌ ${r.error}`, !r.ok && { show_alert: true }).catch(() => {});
  await editOrSend(ctx, settingsCard(), settingsRows());
});

bot.action('ap_pick_time', async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  await editOrSend(ctx, section('⏱ Max Time — kitne minute chale?', [
    `Abhi: <b>${bs.getSetting('maxMinutes')}</b> min`,
  ].join('\n')), pickRows('ap_set_time_', TIME_PRESETS));
});

bot.action(/^ap_set_time_(\d+)$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  const r = bs.setSetting('maxMinutes', Number(ctx.match[1]));
  await ctx.answerCbQuery(r.ok ? `⏱ Max = ${r.value} min` : `❌ ${r.error}`, !r.ok && { show_alert: true }).catch(() => {});
  await editOrSend(ctx, settingsCard(), settingsRows());
});

bot.action('ap_pick_gap', async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  await editOrSend(ctx, section('🚦 Gap — do numbers ke beech kitna rukna?', [
    `Abhi: <b>${bs.fmtSetting('gapMs')}</b>`,
    ``,
    sub('Kam gap = jaldi, zyada gap = Swiggy kam chances dega.'),
  ].join('\n')), pickRows('ap_set_gap_', GAP_PRESETS));
});

bot.action(/^ap_set_gap_(\d+)$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  const r = bs.setSetting('gapMs', Number(ctx.match[1]));
  await ctx.answerCbQuery(r.ok ? `🚦 Gap = ${bs.fmtSetting('gapMs')}` : `❌ ${r.error}`, !r.ok && { show_alert: true }).catch(() => {});
  await editOrSend(ctx, settingsCard(), settingsRows());
});

// 🔁 NEVER-STOP — owner ka rule: "batch na ruke". ON hone par engine time
// cap, fail-streak, rate-limit flood, WAF/403 storm aur khali pool par batch
// khatam nahi karta; sirf TARGET ya manual STOP end karte hain.
bot.action('ap_toggle_neverstop', async (ctx) => {
  if (!(await gate(ctx))) return;
  const cur = bs.getSetting('autoContinue');
  const r = bs.setSetting('autoContinue', !cur);
  if (r.ok) {
    if (isAutopilotRunning()) {
      // Chalte batch me setting turant apply kar do — restart ki zaroorat nahi.
      try { setAutopilotNeverStop(r.value !== false); } catch {}
    }
  }
  await ctx.answerCbQuery(r.ok
    ? (r.value ? '🔁 Never-stop ON — batch ab khud aage badhega' : '🔁 Never-stop OFF — purana safety-stop behaviour')
    : `❌ ${r.error}`, { show_alert: true }).catch(() => {});
  await editOrSend(ctx, settingsCard(), settingsRows());
});

// 🌍 ACCOUNT ENGINE — direct API (proxy + WAF solver) ya Swiggy World Bot
// (@SwiggyByWorldBot ke buttons click; koi proxy nahi). Batch chalte waqt
// badalna allowed nahi — warna aadha batch ek engine par, aadha doosre par.
// 👤 Owner ke do saaf options (Settings me do buttons):
//   🧩 OTP BOT + CHROMIUM      → number/OTP OTP bot se, account Chromium bridge se
//   🌍 OTP BOT + SWIGGY WORLD  → number/OTP OTP bot se, account World Bot se
// Engine badalne par number-source ko chhedte nahi — OTP bot hi rehta hai
// (pipeline dono engine ke saath telegram numbers/OTP chalati hai).
async function applyAccountEngineChoice(ctx, next) {
  if (!(await gate(ctx))) return;
  if (isAutopilotRunning()) {
    await ctx.answerCbQuery('⏳ Batch chal raha hai — pehle STOP karo, phir engine badlo.', { show_alert: true }).catch(() => {});
    return;
  }
  const want = next === 'worldbot' ? 'worldbot' : 'direct';
  const already = bs.getSetting('accountEngine') === want;
  const r = bs.setSetting('accountEngine', want);
  if (!r.ok) {
    await ctx.answerCbQuery(`❌ ${r.error}`, { show_alert: true }).catch(() => {});
    return;
  }
  let note = want === 'worldbot'
    ? '🌍 OTP BOT + SWIGGY WORLD ON — number/OTP OTP bot se, account @' + worldBot.worldBotUsername() + ' ke buttons se.'
    : '🧩 OTP BOT + CHROMIUM ON — number/OTP OTP bot se, account is bot ke apne Swiggy bridge (Chromium) se.';
  if (already) note = `${note} (pehle se yahi chalu hai)`;
  if (want === 'worldbot') {
    let st = {};
    try { st = await telegramOtp.telegramUserClientStatus(); } catch {}
    if (!st.configured) {
      note = '⚠️ Swiggy World ke liye spare Telegram account chahiye — Settings → Add Telegram Account karo. (Abhi ke liye 🧩 OTP BOT + CHROMIUM chalega.)';
    }
  }
  await ctx.answerCbQuery(note, { show_alert: true }).catch(() => {});
  await editOrSend(ctx, settingsCard(), settingsRows());
}

bot.action('ap_engine_chromium', async (ctx) => {
  await ctx.answerCbQuery('🧩 OTP bot + Chromium').catch(() => {});
  await applyAccountEngineChoice(ctx, 'direct');
});

bot.action('ap_engine_worldbot', async (ctx) => {
  await ctx.answerCbQuery('🌍 OTP bot + Swiggy World').catch(() => {});
  await applyAccountEngineChoice(ctx, 'worldbot');
});

// Purana button (kisi purane message me pada ho to bhi kaam kare): flip.
bot.action('ap_toggle_engine', async (ctx) => {
  const cur = (() => { try { return bs.getSetting('accountEngine') === 'worldbot' ? 'worldbot' : 'direct'; } catch { return 'direct'; } })();
  await applyAccountEngineChoice(ctx, cur === 'worldbot' ? 'direct' : 'worldbot');
});

// 🔎 World Bot screen check — bot ke latest buttons/text dikhata hai, taaki
// flow kahan atka ye turant pata chale (bina batch start kiye).
async function worldProbeCard() {
  const cfg = worldBot.worldBotConfig();
  const probe = await worldBot.probeWorldBot({ limit: 4, config: cfg });
  if (!probe.ok) {
    return section('🌍 World Bot — Check Fail', [
      `🤖 Bot: <code>@${esc(cfg.username)}</code>`,
      `❌ <code>${esc(String(probe.reason || 'unknown').slice(0, 220))}</code>`,
      '',
      sub('Spare Telegram account configured hona chahiye (Settings → 👤 Add Telegram Account). Session sirf ek jagah chale — doosri copy band rakho.'),
    ].join('\n'));
  }
  const lines = [
    `🤖 <b>Bot:</b> <code>@${esc(cfg.username)}</code> · engine: <b>${esc(bs.fmtSetting('accountEngine'))}</b>`,
    '',
  ];
  for (const screen of probe.screens.slice(0, 3)) {
    lines.push(`› <i>${esc(screen.text || '(text nahi)')}</i>`);
    if (screen.buttons.length) lines.push(`   ⌨️ ${screen.buttons.map((b) => mono(esc(String(b).slice(0, 28)))).join(' · ')}`);
    lines.push('');
  }
  // Batch ke andar bot ne jo screens dikhayi (phase ke saath) — isse pata
  // chalta hai bot kis step par kya keh raha hai (create/delete/logout/JSON).
  const status = worldBot.getWorldBotStatus();
  const recent = Array.isArray(status.recentScreens) ? status.recentScreens.slice(0, 5) : [];
  if (recent.length) {
    // 5 screens card ko lamba karti thi — ab collapsible block me (kholne par
    // poora detail, band hone par card saaf).
    const stepLines = [];
    for (const step of recent) {
      const when = stamp(step.at ? new Date(step.at) : new Date());
      stepLines.push(`› <code>${esc(String(step.phase || '').slice(0, 22))}</code> ${esc(when)} — <i>${esc(String(step.text || '(text nahi)').slice(0, 140))}</i>`);
      if (step.buttons?.length) stepLines.push(`   ⌨️ ${step.buttons.slice(0, 6).map((b) => mono(esc(String(b).slice(0, 24)))).join(' · ')}`);
    }
    lines.push(details(stepLines, { title: `📜 Batch ke andar ke ${recent.length} steps` }), '');
  }
  if (status.lastError) lines.push(`⚠️ Last error: <code>${esc(String(status.lastError).slice(0, 160))}</code>`, '');
  lines.push(sub('Ye wahi screen hai jis par batch click karega. Buttons na dikhein to bot me /start bhej kar dobara check karo.'));
  return sectionStamp('🌍 World Bot — Live Screen', lines.join('\n'), new Date());
}

bot.action('ap_world_probe', async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery('🔎 World Bot screen dekh raha hoon…').catch(() => {});
  await editOrSend(ctx, await worldProbeCard(), [[{ text: '↩️ Settings', callback_data: 'ap_settings', style: 'primary' }]]);
});

// ---------------------------------------------------------------------------
// 📦 SHOP BOT STOCK — har fresh JSON @its_shop_bot ke stock me
// Owner ka rule: 10 poore hone par wahi 10 JSON files (zip NAHI) bhejo,
// minimum 10 aur maximum bhi 10. Shop bot unhe Swiggy/Twing product me daalta
// hai. Ye screen queue/status dikhati hai aur "abhi bhejo" ka option deti hai.
// ---------------------------------------------------------------------------
function shopStockCard() {
  const st = shopStock.shopStockStatus();
  const when = st.lastSentAt ? new Date(st.lastSentAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '';
  return section('📦 Shop Bot Stock', [
    `${st.enabled ? '✅' : '🚫'} Bot: <code>@${esc(st.username)}</code> · batch <b>${st.batchSize}</b> JSON files`,
    `› Queue: <b>${st.pending}/${st.batchSize}</b>${st.needed ? ` — ${st.needed} aur aate hi apne aap chala jayega` : ' — bhejne wala hai'}`,
    `› Ab tak bheje: <b>${st.sent}</b>${when ? ` · last batch ${esc(when)}` : ''}`,
    st.lastError ? `⚠️ Last error: <code>${esc(st.lastError)}</code>` : '',
    '',
    sub('Har fresh Swiggy session ka JSON yahin queue hota hai. Bhejte waqt ZIP nahi hota — ek-ek .json file hi jaati hai, taaki shop bot use seedha stock me daal de.'),
  ].filter(Boolean).join('\n'));
}

function shopStockRows() {
  const st = shopStock.shopStockStatus();
  return [
    [{ text: st.pending ? `📤 Abhi Bhejo (${st.pending})` : '📤 Abhi Bhejo (queue khali)', callback_data: 'ap_shop_flush', style: 'success' }],
    [{ text: '⚙️ Settings', callback_data: 'ap_settings', style: 'primary' }],
  ];
}

async function showShopStock(ctx) {
  const text = shopStockCard();
  const rows = shopStockRows();
  await ctx.editMessageText(text, kb(rows))
    .catch(async () => { await ctx.reply(text, kb(rows)).catch(() => {}); });
}

bot.command(['shopstock', 'shopbot', 'stock'], async (ctx) => {
  if (!isOwner(ctx.from?.id)) return;
  const text = shopStockCard();
  const rows = shopStockRows();
  await ctx.reply(text, kb(rows)).catch(() => {});
});

bot.action('ap_shop_stock', async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  await showShopStock(ctx);
});

bot.action('ap_shop_flush', async (ctx) => {
  if (!(await gate(ctx))) return;
  const st = shopStock.shopStockStatus();
  if (!st.pending) {
    await ctx.answerCbQuery('Queue khali hai — pehle 10 fresh aane do.', { show_alert: true }).catch(() => {});
    return;
  }
  await ctx.answerCbQuery('📤 Bhej raha hoon…').catch(() => {});
  const res = await shopStock.flushShopStock({ force: true });
  const msg = res.ok
    ? `📤 ${res.sent} JSON files @${st.username} ko bhej di`
    : `⚠️ ${res.sent || 0} gaye, baaki queue me safe: ${res.error || res.kind || 'fail'}`;
  await ctx.answerCbQuery(msg.slice(0, 190), { show_alert: !res.ok }).catch(() => {});
  await showShopStock(ctx);
});

bot.command('world', async (ctx) => {
  if (!isOwner(ctx.from?.id)) return;
  const wait = await ctx.reply('🌍 World Bot se baat kar raha hoon…').catch(() => null);
  const text = await worldProbeCard();
  const rows = [[{ text: '⚙️ Settings', callback_data: 'ap_settings', style: 'primary' }]];
  if (wait) {
    await ctx.telegram.editMessageText(ctx.chat.id, wait.message_id, undefined, text, kb(rows)).catch(async () => {
      await ctx.reply(text, kb(rows)).catch(() => {});
    });
  } else {
    await ctx.reply(text, kb(rows)).catch(() => {});
  }
});

bot.action('ap_toggle_offline', async (ctx) => {
  if (!(await gate(ctx))) return;
  const cur = bs.getSetting('allowOffline');
  const r = bs.setSetting('allowOffline', !cur);
  await ctx.answerCbQuery(r.ok ? `📴 Offline = ${r.value ? 'ON' : 'OFF'}` : `❌ ${r.error}`, !r.ok && { show_alert: true }).catch(() => {});
  await editOrSend(ctx, settingsCard(), settingsRows());
});

// ---------------------------------------------------------------------------
// 📨 Telegram Hermes settings — mode, timing, spare-account login/test/remove
// ---------------------------------------------------------------------------
// 🤖 Kaunsa OTP bot — Hermes / Hathi / HardXotp (sab ek hi spare session se).
bot.action('ap_pick_otp_bot', async (ctx) => {
  if (!(await gate(ctx))) return;
  if (isAutopilotRunning()) {
    await ctx.answerCbQuery('⏳ Batch chal raha hai — pehle STOP karo.', { show_alert: true }).catch(() => {});
    return;
  }
  await ctx.answerCbQuery().catch(() => {});
  const current = bs.getSetting('otpBotProfile');
  const botLines = otpBotProfiles.listOtpBotProfiles().flatMap((profile) => ([
    `${current === profile.id ? '✅' : '▫️'} <b>${profile.emoji || '📨'} ${esc(profile.label)}</b> — <code>@${esc(profile.username)}</code>`,
    sub(profile.hint),
    '',
  ]));
  const text = section('🤖 OTP Bot Chuno', [
    `Abhi: <b>${esc(bs.fmtSetting('otpBotProfile'))}</b>`,
    ``,
    ...botLines,
    sub('Sab same spare Telegram account/session se chalte hain; sirf buttons badalte hain.'),
  ].join('\n'));
  const rows = [
    ...otpBotProfiles.listOtpBotProfiles().map((profile) => [{
      text: `${current === profile.id ? '✅ ' : ''}${profile.emoji || '📨'} ${profile.label}`,
      callback_data: `ap_set_otp_bot_${profile.id}`,
      style: 'success',
    }]),
    [{ text: '↩️ Settings', callback_data: 'ap_settings', style: 'primary' }],
  ];
  await ctx.editMessageText(text, kb(rows))
    .catch(async () => { await ctx.reply(text, kb(rows)).catch(() => {}); });
});

bot.action(new RegExp(`^ap_set_otp_bot_(${otpBotProfiles.OTP_BOT_PROFILE_IDS.join('|')}|custom_[a-z0-9]+)$`), async (ctx) => {
  if (!(await gate(ctx))) return;
  if (isAutopilotRunning()) {
    await ctx.answerCbQuery('⏳ Batch chal raha hai — pehle STOP karo.', { show_alert: true }).catch(() => {});
    return;
  }
  const id = ctx.match[1];
  const r = bs.setSetting('otpBotProfile', id);
  if (r.ok) {
    try { bs.setSetting('telegramOtpMode', true); } catch {}
    try { telegramOtp.setActiveOtpBotProfile(id); } catch {}
  }
  await ctx.answerCbQuery(r.ok ? `🤖 OTP bot = ${bs.fmtSetting('otpBotProfile')}` : `❌ ${r.error}`, !r.ok && { show_alert: true }).catch(() => {});
  const text = settingsCard();
  await ctx.editMessageText(text, kb(settingsRows()))
    .catch(async () => { await ctx.reply(text, kb(settingsRows())).catch(() => {}); });
});

bot.action('ap_toggle_telegram', async (ctx) => {
  if (!(await gate(ctx))) return;
  if (isAutopilotRunning()) {
    await ctx.answerCbQuery('⏳ Batch chal raha hai — source beech me nahi badal sakte. Pehle STOP karo.', { show_alert: true }).catch(() => {});
    return;
  }
  if (telegramLoginFlow || telegramProviderStatus().loginInProgress) {
    await ctx.answerCbQuery('⏳ Telegram login chal raha hai — pehle use complete ya cancel karo.', { show_alert: true }).catch(() => {});
    return;
  }
  const wantOn = !telegramSettingEnabled();
  const r = bs.setSetting('telegramOtpMode', wantOn);
  if (!r.ok) {
    await ctx.answerCbQuery(`❌ ${r.error}`, { show_alert: true }).catch(() => {});
    return;
  }
  const resolved = resolvedNumberSourceMode();
  const status = telegramProviderStatus();
  let note = wantOn
    ? '📨 Hermes mode ON — number + OTP Telegram se aayenge; Firebase fallback nahi hoga.'
    : '📨 Hermes setting OFF kar di.';
  if (!wantOn && resolved === 'telegram') {
    note = '⚠️ Setting OFF hai, lekin env NUMBER_SOURCE/configured Telegram ki wajah se source abhi Telegram hi resolve ho raha hai.';
  } else if (wantOn && !status.configured) {
    note = '📨 Hermes mode ON — ab Add Telegram Account se spare account login karo.';
  }
  await ctx.answerCbQuery(note, { show_alert: true }).catch(() => {});
  await editOrSend(ctx, settingsCard(), settingsRows());
});

bot.action('ap_pick_telegram_wait', async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  await editOrSend(ctx, section('⏳ Hermes OTP Wait — REFRESH kitni der?', [
    `Abhi: <b>${bs.fmtSetting('telegramOtpTimeoutMs')}</b>`,
    ``,
    sub('Swiggy OTP bhejne ke baad itni der Hermes REFRESH hoga. OTP na aaye to NEW NUMBER se agla number aayega. Default 20s hai.'),
  ].join('\n')), pickRows('ap_set_telegram_wait_', TELEGRAM_WAIT_PRESETS));
});

bot.action(/^ap_set_telegram_wait_(\d+)$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  const r = bs.setSetting('telegramOtpTimeoutMs', Number(ctx.match[1]));
  await ctx.answerCbQuery(r.ok ? `⏳ Hermes OTP wait = ${bs.fmtSetting('telegramOtpTimeoutMs')}` : `❌ ${r.error}`, !r.ok && { show_alert: true }).catch(() => {});
  await editOrSend(ctx, settingsCard(), settingsRows());
});

bot.action('ap_pick_telegram_refresh', async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  await editOrSend(ctx, section('🔄 Hermes Refresh Interval', [
    `Abhi: <b>${bs.fmtSetting('telegramOtpRefreshMs')}</b>`,
    ``,
    sub('OTP wait ke dauran Hermes ka REFRESH button itne gap par dobara check hoga. Default 2.5s hai.'),
  ].join('\n')), pickRows('ap_set_telegram_refresh_', TELEGRAM_REFRESH_PRESETS));
});

bot.action(/^ap_set_telegram_refresh_(\d+)$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  const r = bs.setSetting('telegramOtpRefreshMs', Number(ctx.match[1]));
  await ctx.answerCbQuery(r.ok ? `🔄 Hermes refresh = ${bs.fmtSetting('telegramOtpRefreshMs')}` : `❌ ${r.error}`, !r.ok && { show_alert: true }).catch(() => {});
  await editOrSend(ctx, settingsCard(), settingsRows());
});

bot.action('ap_telegram_account', async (ctx) => {
  if (!(await gate(ctx))) return;
  if (!(await requirePrivateTelegramChat(ctx, 'Add Telegram Account'))) return;
  const status = telegramProviderStatus();
  if (telegramLoginFlow || status.loginInProgress) {
    await ctx.answerCbQuery('⏳ Telegram login pehle se chal raha hai.').catch(() => {});
    await editOrSend(ctx, telegramAccountCard(), telegramLoginRows());
    return;
  }
  if (status.sessionPresent) {
    await ctx.answerCbQuery('👤 Telegram account saved hai.').catch(() => {});
    await editOrSend(ctx, telegramAccountCard(), [
      [
        { text: '🔁 Dusra Account Login', callback_data: 'ap_telegram_login_start', style: 'success' },
        { text: '🧪 Test', callback_data: 'ap_test_hermes' },
      ],
      [
        { text: '🗑 Remove', callback_data: 'ap_remove_telegram', style: 'danger' },
        { text: '↩️ Settings', callback_data: 'ap_settings', style: 'primary' },
      ],
    ]);
    return;
  }
  await startTelegramLoginFlow(ctx);
});

bot.action('ap_telegram_login_start', async (ctx) => {
  if (!(await gate(ctx))) return;
  await startTelegramLoginFlow(ctx);
});

bot.action('ap_telegram_login_cancel', async (ctx) => {
  if (!(await gate(ctx))) return;
  const flow = telegramLoginFlow;
  if (!flow || flow.ownerId !== String(ctx.from.id)) {
    await ctx.answerCbQuery('Koi Telegram login flow chal nahi raha.').catch(() => {});
    await editOrSend(ctx, settingsCard(), settingsRows());
    return;
  }
  const wasWaiting = Boolean(flow.rejectInput);
  cancelTelegramLoginFlow('cancel');
  await ctx.answerCbQuery(wasWaiting ? '✖️ Telegram login cancel kar diya.' : '✖️ Cancel request bhej di — current step rukte hi flow band hoga.').catch(() => {});
  await editOrSend(ctx, section('✖️ Telegram Login Cancel', [
    `Login flow band ho raha hai. Partial session save nahi hogi.`,
    ``,
    sub('Dobara start karne ke liye Settings → Add Telegram Account dabao.'),
  ].join('\n')), settingsRows());
});

bot.action('ap_test_hermes', async (ctx) => {
  if (!(await gate(ctx))) return;
  if (!(await requirePrivateTelegramChat(ctx, 'Test Hermes'))) return;
  if (isAutopilotRunning()) {
    await ctx.answerCbQuery('⏳ Batch chal raha hai — Hermes chat batch ke paas hai; test baad me karo.', { show_alert: true }).catch(() => {});
    return;
  }
  if (telegramLoginFlow || telegramProviderStatus().loginInProgress) {
    await ctx.answerCbQuery('⏳ Telegram login chal raha hai — pehle use complete ya cancel karo.', { show_alert: true }).catch(() => {});
    await editOrSend(ctx, telegramAccountCard(), telegramLoginRows());
    return;
  }

  const status = telegramProviderStatus();
  if (!status.configured) {
    await ctx.answerCbQuery('⚙️ Telegram Hermes setup pending!', { show_alert: true }).catch(() => {});
    await editOrSend(
      ctx,
      section('⚙️ Telegram Hermes Setup Pending', telegramOtp.telegramOtpSetupHintLines().join('\n')),
      [
        [{ text: '👤 Add Telegram Account', callback_data: 'ap_telegram_account', style: 'success' }],
        [{ text: '↩️ Settings', callback_data: 'ap_settings', style: 'primary' }],
      ]
    );
    return;
  }

  // Test se pehle wahi bot active karo jo Settings me chuna hua hai.
  try { telegramOtp.setActiveOtpBotProfile(bs.getSetting('otpBotProfile')); } catch {}
  await ctx.answerCbQuery('🧪 Hermes test…').catch(() => {});
  const testBotLabel = status.otpBotProfileLabel || activeOtpBotLabel();
  await editOrSend(ctx, section(`🧪 ${testBotLabel} Test`, [
    `Spare Telegram account se Hermes connect karke latest card/buttons check kar raha hoon…`,
  ].join('\n')), [[{ text: '↩️ Settings', callback_data: 'ap_settings', style: 'primary' }]]);
  try {
    const t0 = Date.now();
    const r = await telegramOtp.verifyTelegramOtpConnection({ sendStartIfEmpty: true });
    const botName = String(r.botUsername || status.botUsername || 'HermeshuOTPROBOT').replace(/^@+/, '');
    await editOrSend(ctx, section('✅ Hermes Test OK', [
      field('Hermes bot', `@${esc(botName)}`),
      r.me ? field('Spare account', esc(r.me)) : '',
      field('Current number', r.currentPhone ? `<code>${esc(r.currentPhone)}</code>` : 'abhi koi number card nahi mila'),
      field('Buttons', r.buttons?.length ? esc(r.buttons.slice(0, 10).join(' · ')) : 'koi button nahi mila'),
      field('Time', `${Date.now() - t0}ms${r.sentStart ? ' · /start bheja gaya' : ''}`),
      ``,
      field('Next', 'START → FIND NUMBER'),
    ].filter(Boolean).join('\n')), settingsRows());
  } catch (e) {
    await editOrSend(ctx, section('❌ Hermes Test Fail', [
      esc(shortTelegramLoginError(e)),
      ``,
      sub('Session expire? Add Telegram Account se dobara login. API galat? setup check karo.'),
    ].join('\n')), [
      [{ text: '👤 Add Telegram Account', callback_data: 'ap_telegram_account', style: 'success' }],
      [{ text: '↩️ Settings', callback_data: 'ap_settings', style: 'primary' }],
    ]);
  }
});

bot.action('ap_remove_telegram', async (ctx) => {
  if (!(await gate(ctx))) return;
  if (!(await requirePrivateTelegramChat(ctx, 'Remove Telegram Account'))) return;
  if (isAutopilotRunning()) {
    await ctx.answerCbQuery('⏳ Batch chal raha hai — pehle STOP karo.', { show_alert: true }).catch(() => {});
    return;
  }
  if (telegramLoginFlow || telegramProviderStatus().loginInProgress) {
    await ctx.answerCbQuery('⏳ Telegram login chal raha hai — pehle use cancel karo.', { show_alert: true }).catch(() => {});
    await editOrSend(ctx, telegramAccountCard(), telegramLoginRows());
    return;
  }
  await ctx.answerCbQuery().catch(() => {});
  await editOrSend(ctx, section('🗑 Remove Telegram Account?', [
    telegramAccountCard(),
    ``,
    field('Effect', 'saved session delete + Hermes mode OFF'),
    field('Account', 'Telegram account khud delete nahi hoga'),
    ``,
    sub('TELEGRAM_SESSION env me bhi ho to restart par wapas aa sakti hai — wahan se bhi hatao.'),
  ].join('\n')), [
    [{ text: '🗑 Haan, Remove Kar Do', callback_data: 'ap_remove_telegram_confirm', style: 'danger' }],
    [{ text: '↩️ Cancel', callback_data: 'ap_settings', style: 'primary' }],
  ]);
});

bot.action('ap_remove_telegram_confirm', async (ctx) => {
  if (!(await gate(ctx))) return;
  if (!(await requirePrivateTelegramChat(ctx, 'Remove Telegram Account'))) return;
  if (isAutopilotRunning()) {
    await ctx.answerCbQuery('⏳ Batch chal raha hai — pehle STOP karo.', { show_alert: true }).catch(() => {});
    return;
  }
  if (telegramLoginFlow || telegramProviderStatus().loginInProgress) {
    await ctx.answerCbQuery('⏳ Telegram login chal raha hai — pehle use cancel karo.', { show_alert: true }).catch(() => {});
    return;
  }
  try {
    const r = await telegramOtp.clearTelegramSessionString();
    try { bs.setSetting('telegramOtpMode', false); } catch {}
    await ctx.answerCbQuery('🗑 Telegram account remove ho gaya.').catch(() => {});
    await editOrSend(ctx, section('🗑 Telegram Account Removed', [
      field('Saved session file', r.removedFile ? '✅ delete ho gaya' : 'file nahi mili / already clear'),
      field('Process env', r.removedEnv ? '✅ current process se clear' : 'env session current process me nahi thi'),
      field('Hermes mode', 'OFF'),
      r.envSessionMayReturnAfterRestart
        ? `⚠️ Session pehle env source se aayi thi — restart ke baad wapas na aaye, Render env <code>TELEGRAM_SESSION</code> bhi remove karo.`
        : '',
      ``,
      sub('Dobara use karna ho to Settings → Add Telegram Account se spare account login karo.'),
    ].filter(Boolean).join('\n')), settingsRows());
  } catch (e) {
    await ctx.answerCbQuery('❌ Telegram account remove fail', { show_alert: true }).catch(() => {});
    await editOrSend(ctx, section('❌ Remove Telegram Fail', [
      esc(shortTelegramLoginError(e)),
    ].join('\n')), settingsRows());
  }
});

// ---------------------------------------------------------------------------
// Text input — add-source URL / custom target (wait-state)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 🎓 CUSTOM BOT TRAINING — owner ka apna OTP/SMS bot add + train karna
//   Add bot → Claim/Refresh training steps → buttons se order badlo,
//   har step par OPTIONAL condition ("agar response me ye ho to…"),
//   built-in (Hermes/HardXotp) training template se shuru karo, live Test,
//   aur ek tap me is bot ko batch ka OTP bot banao.
// ---------------------------------------------------------------------------
const TRAIN_EMOJI_CHOICES = ['🤖', '📨', '🐘', '🔐', '📡', '🦾', '📲', '🚀'];
const routineKey = (routine) => (routine === 'refresh' ? 'r' : 'c');
const routineFromKey = (key) => (key === 'r' ? 'refresh' : 'claim');
const trainBackRow = (text, callback_data) => [[{ text, callback_data }]];

function trainStepCountLabel(bot) {
  const c = bot?.routines?.claim?.length || 0;
  const r = bot?.routines?.refresh?.length || 0;
  return `claim ${c} steps · refresh ${r} steps`;
}

function trainListText() {
  const bots = customBots.listCustomBots();
  return section('🎓 Train Custom Bot', [
    `Koi bhi OTP/SMS bot add karo aur use KHUD train karo —`,
    `"ye message bhejo → agar ye response aaye to ye likho / ye button dabao /`,
    `doosre bot par jao / Refresh dabao". Har cheez ka BUTTON hai.`,
    ``,
    ...(bots.length
      ? bots.flatMap((bot) => [
        `${bot.emoji} <b>${esc(bot.name)}</b> — <code>@${esc(bot.username)}</code>`,
        sub(trainStepCountLabel(bot)),
        '',
      ])
      : ['Abhi koi custom bot nahi hai. Neeche ➕ dabao.', '']),
    sub('Training poori hone ke baad bot card se "Batch ka OTP bot banao" dabao.'),
  ].join('\n'));
}

function trainListRows() {
  const bots = customBots.listCustomBots();
  const rows = bots.map((bot) => [{
    text: `${bot.emoji} ${bot.name}`,
    callback_data: `tr_view_${bot.id}`,
    style: 'primary',
  }]);
  rows.push([{ text: '➕ Naya bot add karo', callback_data: 'ap_train_add', style: 'success' }]);
  rows.push([{ text: '↩️ Settings', callback_data: 'ap_settings', style: 'primary' }]);
  return rows;
}

function customBotCardText(bot) {
  const claim = bot.routines.claim || [];
  const refresh = bot.routines.refresh || [];
  const selected = bs.getSetting('otpBotProfile') === bot.id;
  return section(`${bot.emoji} ${bot.name}`, [
    field('Bot', `@${esc(bot.username)}`),
    field('Batch me', selected ? '✅ Haan — yahi OTP bot hai' : 'Nahi'),
    field('Claim training', claim.length ? `${claim.length} steps (number lene ka flow)` : '— khali —'),
    field('Refresh training', refresh.length ? `${refresh.length} steps (OTP check ka flow)` : '— khali —'),
    '',
    sub('Claim = number kaise aayega (START/click/type). Refresh = OTP kaise check hoga.'),
    sub('Har step par OPTIONAL condition: "jab latest response me ye text ho tabhi step".'),
  ].join('\n'));
}

function customBotCardRows(bot) {
  const selected = bs.getSetting('otpBotProfile') === bot.id;
  return [
    [
      { text: `📋 Claim (${bot.routines.claim.length})`, callback_data: `tr_cl_${bot.id}`, style: 'primary' },
      { text: `🔄 Refresh (${bot.routines.refresh.length})`, callback_data: `tr_rf_${bot.id}` },
    ],
    [
      { text: '🧪 Test claim (live)', callback_data: `tr_testc_${bot.id}` },
      { text: '🧪 Test refresh (live)', callback_data: `tr_testr_${bot.id}` },
    ],
    [{ text: selected ? '✅ Batch ka OTP bot hai (tap = hata do)' : '▶️ Batch ka OTP bot banao', callback_data: `tr_use_${bot.id}`, style: selected ? 'success' : 'primary' }],
    [
      { text: '✏️ Naam badlo', callback_data: `tr_rename_${bot.id}` },
      { text: `😀 Emoji: ${bot.emoji}`, callback_data: `tr_emoji_${bot.id}` },
    ],
    [{ text: '🗑 Delete bot', callback_data: `tr_delbot_${bot.id}`, style: 'danger' }],
    [{ text: '↩️ Train Bots', callback_data: 'ap_train_bots', style: 'primary' }],
  ];
}

function trainRoutineLines(bot, routine) {
  const steps = bot.routines[routine] || [];
  if (!steps.length) return ['— khali — neeche ➕ se steps add karo —'];
  return steps.map((step, i) => `${i + 1}. ${esc(customBots.describeStep(step))}`);
}

function trainRoutineCard(bot, routine) {
  const meta = customBots.ROUTINE_META[routine];
  const steps = bot.routines[routine] || [];
  return section(`${meta.icon} ${meta.label} — ${bot.name}`, [
    field('Bot', `@${esc(bot.username)}`),
    field('Steps', `${steps.length}/${customBots.MAX_STEPS_PER_ROUTINE}`),
    sub(meta.desc),
    '',
    ...trainRoutineLines(bot, routine),
    '',
    sub('Step number dabao → condition/order/type-fallback badlo.'),
    sub('Condition = "jab latest response me ye text ho TABHI step" (blank = hamesha).'),
  ].join('\n'));
}

function trainRoutineRows(bot, routine) {
  const k = routineKey(routine);
  const steps = bot.routines[routine] || [];
  const rows = [];
  for (let i = 0; i < steps.length; i += 6) {
    rows.push(steps.slice(i, i + 6).map((_, offset) => {
      const idx = i + offset;
      return { text: `${idx + 1}`, callback_data: `tr_step_${bot.id}_${k}_${idx}` };
    }));
  }
  rows.push([
    { text: '➕ Step add karo', callback_data: `tr_add_${bot.id}_${k}`, style: 'success' },
    { text: '🧹 Saaf karo', callback_data: `tr_clear_${bot.id}_${k}`, style: 'danger' },
  ]);
  if (routine === 'claim') {
    rows.push([
      { text: '📋 Hermes template', callback_data: `tr_tmpl_${bot.id}_${k}_hermes` },
      { text: '🔐 HardXotp template', callback_data: `tr_tmpl_${bot.id}_${k}_chauhan` },
    ]);
    rows.push([{ text: '🧪 Test claim (live)', callback_data: `tr_testc_${bot.id}`, style: 'primary' }]);
  } else {
    rows.push([
      { text: '📋 Hermes refresh template', callback_data: `tr_tmpl_${bot.id}_${k}_hermes` },
      { text: '🔐 HardXotp refresh template', callback_data: `tr_tmpl_${bot.id}_${k}_chauhan` },
    ]);
    rows.push([{ text: '🧪 Test refresh (live)', callback_data: `tr_testr_${bot.id}`, style: 'primary' }]);
  }
  rows.push([{ text: '↩️ Bot card', callback_data: `tr_view_${bot.id}`, style: 'primary' }]);
  return rows;
}

function trainStepCard(bot, routine, idx) {
  const step = bot.routines[routine][idx];
  if (!step) return null;
  const meta = customBots.STEP_KINDS[step.kind] || { icon: '❓', label: step.kind };
  const lines = [
    field('Step', `${idx + 1} · ${meta.icon} ${meta.label}`),
    field('Kya karega', esc(customBots.describeStep(step))),
    field('Condition', step.when?.match ? `jab response me "${esc(step.when.match)}" ho` : '— (hamesha chale)'),
    field('Fail par', step.onFail === 'continue' ? 'Aage badho' : 'Routine rok do'),
  ];
  if (step.kind === 'click_button') {
    lines.push(field('Type fallback', step.typeIfMissing ? `ON — na mile to "${esc(step.typeText || step.match)}" type karo` : 'OFF — sirf click'));
  }
  return section(`${meta.icon} Step ${idx + 1} — ${meta.label}`, lines.join('\n'));
}

function trainStepRows(bot, routine, idx) {
  const k = routineKey(routine);
  const step = bot.routines[routine][idx];
  const kBack = routine === 'refresh' ? `tr_rf_${bot.id}` : `tr_cl_${bot.id}`;
  const rows = [
    [
      { text: '⬆️ Upar', callback_data: `tr_mv_${bot.id}_${k}_${idx}_u` },
      { text: '⬇️ Neeche', callback_data: `tr_mv_${bot.id}_${k}_${idx}_d` },
      { text: '🗑 Delete', callback_data: `tr_del_${bot.id}_${k}_${idx}`, style: 'danger' },
    ],
    [
      { text: '⚙️ Condition badlo', callback_data: `tr_cond_${bot.id}_${k}_${idx}` },
      { text: step.onFail === 'continue' ? '🛑 Fail par: AAGE (tap = STOP)' : '🛑 Fail par: STOP (tap = AAGE)', callback_data: `tr_fail_${bot.id}_${k}_${idx}` },
    ],
  ];
  if (['send_text', 'click_button', 'wait', 'switch_bot'].includes(step.kind)) {
    rows.push([{ text: '✏️ Text/value badlo', callback_data: `tr_param_${bot.id}_${k}_${idx}` }]);
  }
  if (step.kind === 'click_button') {
    rows.push([
      { text: step.typeIfMissing ? '🔁 Type fallback: ON (tap = OFF)' : '🔁 Type fallback: OFF (tap = ON)', callback_data: `tr_clicktype_${bot.id}_${k}_${idx}` },
      { text: '⌨️ Type text badlo', callback_data: `tr_typetext_${bot.id}_${k}_${idx}` },
    ]);
  }
  rows.push([{ text: '↩️ Steps', callback_data: kBack, style: 'primary' }]);
  return rows;
}

function trainAddKindRows(bot, routine) {
  const k = routineKey(routine);
  const kinds = ['send_text', 'click_button', 'wait', 'switch_bot', 'expect_number', 'expect_otp'];
  const rows = [];
  for (let i = 0; i < kinds.length; i += 2) {
    rows.push(kinds.slice(i, i + 2).map((kind) => ({
      text: `${customBots.STEP_KINDS[kind].icon} ${customBots.STEP_KINDS[kind].label}`,
      callback_data: `tr_addkind_${bot.id}_${k}_${kind}`,
    })));
  }
  rows.push([{ text: '↩️ Steps', callback_data: routine === 'refresh' ? `tr_rf_${bot.id}` : `tr_cl_${bot.id}`, style: 'primary' }]);
  return rows;
}

function trainParseStepParam(kind, raw) {
  const txt = String(raw || '').trim();
  switch (kind) {
    case 'send_text': {
      if (!txt) return { error: 'Message khali hai — /start jaisa text bhejo.' };
      return { patch: { text: txt.slice(0, customBots.MAX_TEXT_LEN) } };
    }
    case 'click_button': {
      if (!txt) return { error: 'Button ka text khali hai — jaise: NEW NUMBER' };
      // Sirf match badlo — typeText (type-fallback ka text) alag se editable hai.
      return { patch: { match: txt.slice(0, customBots.MAX_MATCH_LEN) } };
    }
    case 'wait': {
      const ms = Math.round(Number(txt.replace(/\D/g, '')));
      if (!Number.isFinite(ms) || ms < 100) return { error: 'Milliseconds me number bhejo (jaise 2000).' };
      return { patch: { ms: Math.min(30000, ms) } };
    }
    case 'switch_bot': {
      const username = customBots.normalizeCustomUsername(txt);
      if (!username) return { error: 'Username galat hai (@ ke bina, 5–32 chars). Jaise: AnotherBot123' };
      return { patch: { username } };
    }
    default:
      return { error: 'Is step me koi text nahi lagta.' };
  }
}

async function showTrainRoutine(ctx, bot, routine) {
  const text = trainRoutineCard(bot, routine);
  await ctx.editMessageText(text, kb(trainRoutineRows(bot, routine)))
    .catch(async () => { await ctx.reply(text, kb(trainRoutineRows(bot, routine))).catch(() => {}); });
}

async function showTrainBotCard(ctx, bot) {
  const text = customBotCardText(bot);
  await ctx.editMessageText(text, kb(customBotCardRows(bot)))
    .catch(async () => { await ctx.reply(text, kb(customBotCardRows(bot))).catch(() => {}); });
}

async function showTrainStep(ctx, bot, routine, idx) {
  const text = trainStepCard(bot, routine, idx);
  if (!text) { await showTrainRoutine(ctx, bot, routine); return; }
  const rows = trainStepRows(bot, routine, idx);
  await ctx.editMessageText(text, kb(rows))
    .catch(async () => { await ctx.reply(text, kb(rows)).catch(() => {}); });
}

// ---- Text input se aane wale training answers ---------------------------
async function handleCustomBotPending(ctx, st, rawTxt) {
  const uid = String(ctx.from?.id || '');
  const pendingClear = () => pending.delete(uid);
  const txt = String(rawTxt || '').trim();
  if (st.ts && Date.now() - st.ts > 10 * 60_000) {
    pendingClear();
    await ctx.reply('⌛ Timeout ho gaya — phir se try karo.', kb(trainBackRow('↩️ Train Bots', 'ap_train_bots'))).catch(() => {});
    return;
  }

  if (st.action === 'custom_bot_username') {
    pendingClear();
    const username = customBots.normalizeCustomUsername(txt);
    if (!username) {
      await ctx.reply('❌ Username galat hai. @ ke bina bhejo (5–32 letters/digits/underscore). Jaise: <code>HermeshuOTPROBOT</code>', kb(trainBackRow('↩️ Train Bots', 'ap_train_bots'))).catch(() => {});
      return;
    }
    pending.set(uid, { ts: Date.now(), action: 'custom_bot_name', username });
    await ctx.reply([
      `👍 Bot: <code>@${esc(username)}</code>`,
      '',
      'Ab is bot ka <b>Naam</b> bhejo (jo lista me dikhe). Jaise: <code>Mera FastBot</code>',
      sub('Blank/`-` bhejo to @' + esc(username) + ' hi naam rehega.'),
    ].join('\n'), kb(trainBackRow('❌ Cancel', 'ap_train_bots'))).catch(() => {});
    return;
  }

  if (st.action === 'custom_bot_name') {
    pendingClear();
    const name = txt === '-' ? '' : txt;
    const r = customBots.createCustomBot({ name, username: st.username, emoji: '🤖' });
    if (!r.ok) {
      await ctx.reply(`❌ ${esc(r.error)}`, kb(trainBackRow('↩️ Train Bots', 'ap_train_bots'))).catch(() => {});
      return;
    }
    const bot = r.bot;
    await ctx.reply(section('✅ Bot add ho gaya', [
      field('Bot', `${bot.emoji} <b>${esc(bot.name)}</b> — <code>@${esc(bot.username)}</code>`),
      '',
      'Ab iske do flows train karo:',
      '📋 <b>Claim</b> — number kaise lena hai',
      '🔄 <b>Refresh</b> — OTP kaise check karna hai',
      '',
      sub('Tip: pehle "📋 Hermes template" dabao — saari coding kiya hua default training ek tap me copy ho jata hai, phir edit karo.'),
    ].join('\n')), kb(customBotCardRows(bot))).catch(() => {});
    return;
  }

  if (st.action === 'custom_bot_rename') {
    pendingClear();
    if (txt === '-' || !txt) { await ctx.reply('Rename cancel.', kb(trainBackRow('↩️ Train Bots', 'ap_train_bots'))).catch(() => {}); return; }
    const r = customBots.updateCustomBot(st.botId, { name: txt });
    if (!r.ok) { await ctx.reply(`❌ ${esc(r.error)}`, kb(trainBackRow('↩️ Train Bots', 'ap_train_bots'))).catch(() => {}); return; }
    await ctx.reply(`✅ Naam = <b>${esc(r.bot.name)}</b>`, kb(customBotCardRows(r.bot))).catch(() => {});
    return;
  }

  if (st.action === 'custom_step_param' || st.action === 'custom_step_param_edit') {
    pendingClear();
    const kind = st.kind || customBots.getCustomBot(st.botId)?.routines?.[st.routine]?.[st.idx]?.kind;
    const parsed = trainParseStepParam(kind, txt);
    if (parsed.error) {
      await ctx.reply(`❌ ${parsed.error}`, kb(trainBackRow('↩️ Steps', st.routine === 'refresh' ? `tr_rf_${st.botId}` : `tr_cl_${st.botId}`))).catch(() => {});
      return;
    }
    if (st.action === 'custom_step_param') {
      const r = customBots.addStep(st.botId, st.routine, { kind, ...parsed.patch });
      if (!r.ok) { await ctx.reply(`❌ ${esc(r.error)}`, kb(trainBackRow('↩️ Steps', st.routine === 'refresh' ? `tr_rf_${st.botId}` : `tr_cl_${st.botId}`))).catch(() => {}); return; }
      const added = (r.routine || [])[r.routine.length - 1];
      pending.set(uid, { ts: Date.now(), action: 'custom_step_cond', botId: st.botId, routine: st.routine, stepId: added?.id || '' });
      await ctx.reply([
        `✅ Step add: <b>${esc(customBots.describeStep(added || parsed.patch))}</b>`,
        '',
        '⚙️ <b>Condition?</b> — "jab LATEST response me ye text ho TABHI ye step chale"',
        sub('Jaise: <code>OTP Sent</code> ya <code>Login</code>. re: ke saath regex bhi chalti hai.'),
        sub('Blank/`-` bhejo = hamesha chale (koi condition nahi).'),
      ].join('\n'), kb(trainBackRow('⏭️ Condition skip', `tr_condskip_${st.botId}_${routineKey(st.routine)}_${added?.id || ''}`))).catch(() => {});
      return;
    }
    // Edit mode — existing step ka param badalna hai
    const bot = customBots.getCustomBot(st.botId);
    const step = bot?.routines?.[st.routine]?.[st.idx];
    if (!step) { await ctx.reply('❌ Step nahi mila.', kb(trainBackRow('↩️ Steps', st.routine === 'refresh' ? `tr_rf_${st.botId}` : `tr_cl_${st.botId}`))).catch(() => {}); return; }
    const r = customBots.updateStep(st.botId, st.routine, step.id, parsed.patch);
    if (!r.ok) { await ctx.reply(`❌ ${esc(r.error)}`).catch(() => {}); return; }
    const botAfter = customBots.getCustomBot(st.botId);
    const newIdx = botAfter.routines[st.routine].findIndex((s) => s.id === step.id);
    await ctx.reply('✅ Badal gaya.', kb(trainStepRows(botAfter, st.routine, newIdx))).catch(() => {});
    return;
  }

  if (st.action === 'custom_step_typetext') {
    pendingClear();
    const bot = customBots.getCustomBot(st.botId);
    const step = bot?.routines?.[st.routine]?.[st.idx];
    if (!step) { await ctx.reply('❌ Step nahi mila.').catch(() => {}); return; }
    const value = txt.replace(/\s+$/g, '').slice(0, customBots.MAX_MATCH_LEN);
    if (!value) { await ctx.reply('❌ Khali nahi ho sakta — typeText bhejo.').catch(() => {}); return; }
    const r = customBots.updateStep(st.botId, st.routine, step.id, { typeText: value });
    const botAfter = customBots.getCustomBot(st.botId);
    const newIdx = botAfter?.routines?.[st.routine]?.findIndex((s) => s.id === step.id) ?? st.idx;
    await ctx.reply(r.ok ? `✅ Type fallback text = "${esc(value)}"` : `❌ ${esc(r.error || 'update fail')}`,
      botAfter ? kb(trainStepRows(botAfter, st.routine, newIdx)) : undefined).catch(() => {});
    return;
  }

  if (st.action === 'custom_step_cond') {
    pendingClear();
    const bot = customBots.getCustomBot(st.botId);
    const step = bot?.routines?.[st.routine]?.find((s) => s.id === st.stepId);
    if (!step) { await ctx.reply('❌ Step nahi mila.', kb(trainBackRow('↩️ Train Bots', 'ap_train_bots'))).catch(() => {}); return; }
    const clear = (txt === '-' || txt === '');
    const r = customBots.updateStep(st.botId, st.routine, st.stepId, { when: clear ? null : { match: txt.slice(0, customBots.MAX_MATCH_LEN) } });
    if (!r.ok) { await ctx.reply(`❌ ${esc(r.error)}`).catch(() => {}); return; }
    const botAfter = customBots.getCustomBot(st.botId);
    await ctx.reply(clear
      ? '✅ Condition hata di — step hamesha chalega.'
      : `✅ Condition lag gayi — step sirf tab chalega jab response me "${esc(txt.slice(0, 60))}" ho.`,
      kb(trainRoutineRows(botAfter, st.routine))).catch(() => {});
    return;
  }

  pendingClear();
}

// ---- Action handlers ------------------------------------------------------
bot.action(['ap_train_bots', 'ap_train_list'], async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  await ctx.editMessageText(trainListText(), kb(trainListRows()))
    .catch(async () => { await ctx.reply(trainListText(), kb(trainListRows())).catch(() => {}); });
});

bot.action('ap_train_add', async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  pending.set(String(ctx.from.id), { ts: Date.now(), action: 'custom_bot_username' });
  await editOrSend(ctx, section('➕ Naya Custom Bot', [
    'Bot ka <b>username</b> bhejo (@ ke bina). Jaise:',
    '<code>MyOtpBot123</code>',
    '',
    sub('Woh bot Telegram par maujood aur spare account se message/button-able hona chahiye (OTP bots, SMS forwarders…).'),
  ].join('\n')), trainBackRow('❌ Cancel', 'ap_train_bots'));
});

bot.action(/^tr_view_(custom_[a-z0-9]+)$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  const bot2 = customBotById(ctx.match[1]);
  if (!bot2) { await ctx.editMessageText('❌ Ye bot nahi mila (delete ho gaya?).', kb(trainBackRow('↩️ Train Bots', 'ap_train_bots'))).catch(() => {}); return; }
  await showTrainBotCard(ctx, bot2);
});

bot.action(/^tr_rename_(custom_[a-z0-9]+)$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  const id = ctx.match[1];
  if (!customBotById(id)) { await ctx.answerCbQuery('Bot nahi mila', { show_alert: true }).catch(() => {}); return; }
  pending.set(String(ctx.from.id), { ts: Date.now(), action: 'custom_bot_rename', botId: id });
  await editOrSend(ctx, '✏️ Naya Naam bhejo (ya `-` se cancel):', trainBackRow('❌ Cancel', `tr_view_${id}`));
});

bot.action(/^tr_emoji_(custom_[a-z0-9]+)$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  const id = ctx.match[1];
  const bot2 = customBotById(id);
  if (!bot2) { await ctx.answerCbQuery('Bot nahi mila', { show_alert: true }).catch(() => {}); return; }
  const idx = TRAIN_EMOJI_CHOICES.indexOf(bot2.emoji);
  const next = TRAIN_EMOJI_CHOICES[(idx + 1) % TRAIN_EMOJI_CHOICES.length];
  const r = customBots.updateCustomBot(id, { emoji: next });
  await ctx.answerCbQuery(r.ok ? `Emoji ${next}` : 'Update fail').catch(() => {});
  if (r.ok) await showTrainBotCard(ctx, r.bot);
});

// Is bot ko batch ka OTP bot banao (empty training par rok do).
bot.action(/^tr_use(?:force)?_(custom_[a-z0-9]+)$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  if (isAutopilotRunning()) {
    await ctx.answerCbQuery('⏳ Batch chal raha hai — pehle STOP karo.', { show_alert: true }).catch(() => {});
    return;
  }
  const id = ctx.match[1];
  const force = ctx.callbackQuery.data.startsWith('tr_useforce_');
  const bot2 = customBotById(id);
  if (!bot2) { await ctx.answerCbQuery('Bot nahi mila', { show_alert: true }).catch(() => {}); return; }
  // Toggle OFF — pehle se yahi OTP bot hai to Hermes wapas select kar do.
  if (!force && bs.getSetting('otpBotProfile') === id) {
    try { bs.setSetting('otpBotProfile', 'hermes'); } catch {}
    try { telegramOtp.setActiveOtpBotProfile('hermes'); } catch {}
    await ctx.answerCbQuery('Hermes wapas select ho gaya').catch(() => {});
    const botOff = customBots.getCustomBot(id);
    if (botOff) await showTrainBotCard(ctx, botOff);
    return;
  }
  const claimEmpty = (bot2.routines.claim || []).length === 0;
  const refreshEmpty = (bot2.routines.refresh || []).length === 0;
  if ((claimEmpty || refreshEmpty) && !force) {
    const missing = [claimEmpty ? 'CLAIM' : '', refreshEmpty ? 'REFRESH' : ''].filter(Boolean).join(' + ');
    await ctx.answerCbQuery(`⚠️ ${missing} training khali hai!`, { show_alert: true }).catch(() => {});
    await editOrSend(ctx, section('⚠️ Training khali hai', [
      field('Bot', `${bot2.emoji} <b>${esc(bot2.name)}</b>`),
      `${missing} ke steps nahi hain — batch me number/OTP nahi aayega.`,
      '',
      sub('Pehle training poori karo, ya jaanke force banao.'),
    ].join('\n')), [
      [{ text: '📋 Claim train karo', callback_data: `tr_cl_${id}`, style: 'primary' }, { text: '🔄 Refresh train karo', callback_data: `tr_rf_${id}` }],
      [{ text: '⚠️ Phir bhi yahi banao', callback_data: `tr_useforce_${id}`, style: 'danger' }],
      [{ text: '↩️ Bot card', callback_data: `tr_view_${id}`, style: 'primary' }],
    ]);
    return;
  }
  try { bs.setSetting('otpBotProfile', id); } catch {}
  try { bs.setSetting('telegramOtpMode', true); } catch {}
  try { telegramOtp.setActiveOtpBotProfile(id); } catch {}
  await ctx.answerCbQuery(`🎓 ${bot2.name} ab batch ka OTP bot hai`).catch(() => {});
  await editOrSend(ctx, section('🎓 Batch ka OTP bot', [
    `<b>${esc(bot2.emoji)} ${esc(bot2.name)}</b> (<code>@${esc(bot2.username)}</code>) ab batch ka OTP bot hai.`,
    '',
    `Claim: <b>${(bot2.routines.claim || []).length} steps</b> · Refresh: <b>${(bot2.routines.refresh || []).length} steps</b>`,
    sub('START dabao — training ke mutabik number/OTP aayega.'),
  ].join('\n')), trainBackRow('▶️ START / Settings', 'ap_settings'));
});

bot.action(/^tr_delbot_(custom_[a-z0-9]+)$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  const id = ctx.match[1];
  const bot2 = customBotById(id);
  if (!bot2) { await ctx.editMessageText('❌ Bot nahi mila.', kb(trainBackRow('↩️ Train Bots', 'ap_train_bots'))).catch(() => {}); return; }
  await editOrSend(ctx, section('🗑 Custom bot delete karein?', [
    field('Bot', `${bot2.emoji} <b>${esc(bot2.name)}</b> — <code>@${esc(bot2.username)}</code>`),
    field('Training', trainStepCountLabel(bot2)),
    '',
    sub('Training steps bhi delete ho jayenge. Batch me ye selected ho to Hermes wapas aa jayega.'),
  ].join('\n')), [
    [{ text: '🗑 Haan, delete karo', callback_data: `tr_delbot_yes_${id}`, style: 'danger' }],
    [{ text: '↩️ Nahi, wapas', callback_data: `tr_view_${id}`, style: 'primary' }],
  ]);
});

bot.action(/^tr_delbot_yes_(custom_[a-z0-9]+)$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  const id = ctx.match[1];
  // Agar ye batch ka OTP bot tha → Hermes wapas set karo (dangling id na rahe).
  try {
    if (bs.getSetting('otpBotProfile') === id) {
      bs.setSetting('otpBotProfile', 'hermes');
      telegramOtp.setActiveOtpBotProfile('hermes');
    }
  } catch {}
  const r = customBots.deleteCustomBot(id);
  await ctx.answerCbQuery(r.ok ? '🗑 Delete ho gaya' : 'Delete fail').catch(() => {});
  await ctx.editMessageText(r.ok ? '🗑 Custom bot delete ho gaya.' : `❌ ${esc(r.error || 'delete fail')}`, kb(trainBackRow('↩️ Train Bots', 'ap_train_bots'))).catch(() => {});
});

// ---- Routine list (Claim / Refresh) --------------------------------------
bot.action(/^tr_(cl|rf)_(custom_[a-z0-9]+)$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  const routine = routineFromKey(ctx.match[1]);
  const bot2 = customBotById(ctx.match[2]);
  if (!bot2) { await ctx.editMessageText('❌ Bot nahi mila.', kb(trainBackRow('↩️ Train Bots', 'ap_train_bots'))).catch(() => {}); return; }
  await showTrainRoutine(ctx, bot2, routine);
});

bot.action(/^tr_add_(custom_[a-z0-9]+)_(c|r)$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  const bot2 = customBotById(ctx.match[1]);
  const routine = routineFromKey(ctx.match[2]);
  if (!bot2) { await ctx.answerCbQuery('Bot nahi mila', { show_alert: true }).catch(() => {}); return; }
  if ((bot2.routines[routine] || []).length >= customBots.MAX_STEPS_PER_ROUTINE) {
    await ctx.answerCbQuery(`Max ${customBots.MAX_STEPS_PER_ROUTINE} steps — pehle kuch delete karo`, { show_alert: true }).catch(() => {});
    return;
  }
  await editOrSend(ctx, section('➕ Kaunsa step add karu?', [
    sub('Button dabao — "✉️ Message bhejo" / "🖱 Button dabao" waali detail next message me maangunga.'),
    sub('expect_* steps me koi input nahi lagta — seedha add ho jayenge.'),
  ].join('\n')), trainAddKindRows(bot2, routine));
});

bot.action(/^tr_addkind_(custom_[a-z0-9]+)_(c|r)_(send_text|click_button|wait|switch_bot|expect_number|expect_otp)$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  const id = ctx.match[1];
  const routine = routineFromKey(ctx.match[2]);
  const kind = ctx.match[3];
  const bot2 = customBotById(id);
  if (!bot2) { await ctx.answerCbQuery('Bot nahi mila', { show_alert: true }).catch(() => {}); return; }
  if ((bot2.routines[routine] || []).length >= customBots.MAX_STEPS_PER_ROUTINE) {
    await ctx.answerCbQuery(`Max ${customBots.MAX_STEPS_PER_ROUTINE} steps`, { show_alert: true }).catch(() => {});
    return;
  }
  const uid = String(ctx.from.id);
  if (kind === 'expect_number' || kind === 'expect_otp') {
    const r = customBots.addStep(id, routine, { kind });
    if (!r.ok) { await ctx.reply(`❌ ${esc(r.error)}`).catch(() => {}); return; }
    const added = (r.routine || [])[r.routine.length - 1];
    pending.set(uid, { ts: Date.now(), action: 'custom_step_cond', botId: id, routine, stepId: added?.id || '' });
    await editOrSend(ctx, [
      `✅ Step add: <b>${esc(customBots.describeStep(added))}</b>`,
      '',
      '⚙️ <b>Condition?</b> — "jab LATEST response me ye text ho TABHI ye step chale"',
      sub('Blank/`-` bhejo = hamesha chale.'),
    ].join('\n'), trainBackRow('⏭️ Condition skip', `tr_condskip_${id}_${routineKey(routine)}_${added?.id || ''}`));
    return;
  }
  const meta = customBots.STEP_KINDS[kind];
  pending.set(uid, { ts: Date.now(), action: 'custom_step_param', botId: id, routine, kind });
  await editOrSend(ctx, [
    `${meta.icon} <b>${esc(meta.label)}</b>`,
    '',
    `${meta.paramIcon} <b>${esc(meta.paramLabel)}</b> bhejo:`,
    sub(`Example: <code>${esc(meta.placeholder)}</code>`),
    ...(kind === 'click_button' ? [sub('Click se nahi chalega to wahi text AUTO type hoga (OFF karne ke liye step khulne ke baad 🔁 dabao). Regex chahiye to re: prefix (advanced).')] : []),
    ...(kind === 'wait' ? [sub('100–30000 ms.')] : []),
  ].join('\n'), trainBackRow('❌ Cancel', `tr_${routineKey(routine) === 'r' ? 'rf' : 'cl'}_${id}`));
});

bot.action(/^tr_step_(custom_[a-z0-9]+)_(c|r)_(\d{1,2})$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  const id = ctx.match[1];
  const routine = routineFromKey(ctx.match[2]);
  const idx = Number(ctx.match[3]);
  const bot2 = customBotById(id);
  if (!bot2) { await ctx.answerCbQuery('Bot nahi mila', { show_alert: true }).catch(() => {}); return; }
  await showTrainStep(ctx, bot2, routine, idx);
});

bot.action(/^tr_mv_(custom_[a-z0-9]+)_(c|r)_(\d{1,2})_(u|d)$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  const id = ctx.match[1];
  const routine = routineFromKey(ctx.match[2]);
  const idx = Number(ctx.match[3]);
  const dir = ctx.match[4] === 'u' ? -1 : 1;
  const bot2 = customBotById(id);
  const step = bot2?.routines?.[routine]?.[idx];
  if (!step) { await ctx.answerCbQuery('Step nahi mila', { show_alert: true }).catch(() => {}); return; }
  const r = customBots.moveStep(id, routine, step.id, dir);
  await ctx.answerCbQuery(r.ok ? '↕️ Moved' : 'Move fail').catch(() => {});
  if (r.ok) {
    const botAfter = customBots.getCustomBot(id);
    const newIdx = botAfter.routines[routine].findIndex((s) => s.id === step.id);
    await showTrainStep(ctx, botAfter, routine, newIdx);
  }
});

bot.action(/^tr_del_(custom_[a-z0-9]+)_(c|r)_(\d{1,2})$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  const id = ctx.match[1];
  const routine = routineFromKey(ctx.match[2]);
  const idx = Number(ctx.match[3]);
  const bot2 = customBotById(id);
  const step = bot2?.routines?.[routine]?.[idx];
  if (!step) { await ctx.answerCbQuery('Step nahi mila', { show_alert: true }).catch(() => {}); return; }
  const r = customBots.removeStep(id, routine, step.id);
  await ctx.answerCbQuery(r.ok ? '🗑 Step delete' : 'Delete fail').catch(() => {});
  if (r.ok) await showTrainRoutine(ctx, customBots.getCustomBot(id), routine);
});

bot.action(/^tr_cond_(custom_[a-z0-9]+)_(c|r)_(\d{1,2})$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  const id = ctx.match[1];
  const routine = routineFromKey(ctx.match[2]);
  const idx = Number(ctx.match[3]);
  const bot2 = customBotById(id);
  const step = bot2?.routines?.[routine]?.[idx];
  if (!step) { await ctx.answerCbQuery('Step nahi mila', { show_alert: true }).catch(() => {}); return; }
  pending.set(String(ctx.from.id), { ts: Date.now(), action: 'custom_step_cond', botId: id, routine, stepId: step.id });
  await editOrSend(ctx, [
    '⚙️ <b>Condition</b> — "jab LATEST response me ye text ho TABHI ye step chale"',
    '',
    `Abhi: ${step.when?.match ? `"${esc(step.when.match)}"` : '— (koi condition nahi)'}`,
    '',
    sub('Naya text bhejo (jaise <code>OTP Sent</code>). re: ke saath regex bhi.'),
    sub('Blank/`-` bhejo = condition hata do.'),
  ].join('\n'), trainBackRow('❌ Cancel', routine === 'refresh' ? `tr_rf_${id}` : `tr_cl_${id}`));
});

bot.action(/^tr_condskip_(custom_[a-z0-9]+)_(c|r)_(st_[a-z0-9]+)$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  const id = ctx.match[1];
  const routine = routineFromKey(ctx.match[2]);
  pending.delete(String(ctx.from.id));
  const bot2 = customBotById(id);
  if (bot2) await showTrainRoutine(ctx, bot2, routine);
});

bot.action(/^tr_fail_(custom_[a-z0-9]+)_(c|r)_(\d{1,2})$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  const id = ctx.match[1];
  const routine = routineFromKey(ctx.match[2]);
  const idx = Number(ctx.match[3]);
  const bot2 = customBotById(id);
  const step = bot2?.routines?.[routine]?.[idx];
  if (!step) { await ctx.answerCbQuery('Step nahi mila', { show_alert: true }).catch(() => {}); return; }
  const next = step.onFail === 'continue' ? 'stop' : 'continue';
  const r = customBots.updateStep(id, routine, step.id, { onFail: next });
  await ctx.answerCbQuery(next === 'continue' ? 'Fail par: AAGE' : 'Fail par: STOP').catch(() => {});
  if (r.ok) await showTrainStep(ctx, customBots.getCustomBot(id), routine, idx);
});

bot.action(/^tr_clicktype_(custom_[a-z0-9]+)_(c|r)_(\d{1,2})$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  const id = ctx.match[1];
  const routine = routineFromKey(ctx.match[2]);
  const idx = Number(ctx.match[3]);
  const bot2 = customBotById(id);
  const step = bot2?.routines?.[routine]?.[idx];
  if (!step) { await ctx.answerCbQuery('Step nahi mila', { show_alert: true }).catch(() => {}); return; }
  const r = customBots.updateStep(id, routine, step.id, { typeIfMissing: !step.typeIfMissing });
  await ctx.answerCbQuery(!step.typeIfMissing ? '🔁 Type fallback ON' : '🔁 Type fallback OFF').catch(() => {});
  if (r.ok) await showTrainStep(ctx, customBots.getCustomBot(id), routine, idx);
});

bot.action(/^tr_typetext_(custom_[a-z0-9]+)_(c|r)_(\d{1,2})$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  const id = ctx.match[1];
  const routine = routineFromKey(ctx.match[2]);
  const idx = Number(ctx.match[3]);
  const bot2 = customBotById(id);
  const step = bot2?.routines?.[routine]?.[idx];
  if (!step) { await ctx.answerCbQuery('Step nahi mila', { show_alert: true }).catch(() => {}); return; }
  pending.set(String(ctx.from.id), { ts: Date.now(), action: 'custom_step_typetext', botId: id, routine, idx });
  await editOrSend(ctx, [
    '⌨️ <b>Type fallback text</b> — button na mile/click na chale to BOT KO YEH bhejunga:',
    `Abhi: <code>${esc(step.typeText || step.match)}</code>`,
    '',
    sub('Naya text bhejo (jaise <code>Refresh</code> ya <code>View Messages</code>).'),
  ].join('\n'), trainBackRow('❌ Cancel', routine === 'refresh' ? `tr_rf_${id}` : `tr_cl_${id}`));
});

bot.action(/^tr_param_(custom_[a-z0-9]+)_(c|r)_(\d{1,2})$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  const id = ctx.match[1];
  const routine = routineFromKey(ctx.match[2]);
  const idx = Number(ctx.match[3]);
  const bot2 = customBotById(id);
  const step = bot2?.routines?.[routine]?.[idx];
  if (!step) { await ctx.answerCbQuery('Step nahi mila', { show_alert: true }).catch(() => {}); return; }
  pending.set(String(ctx.from.id), { ts: Date.now(), action: 'custom_step_param_edit', botId: id, routine, kind: step.kind, idx });
  const meta = customBots.STEP_KINDS[step.kind] || {};
  await editOrSend(ctx, [
    `✏️ <b>${esc(meta.label || step.kind)}</b> — naya value bhejo:`,
    step.kind === 'wait' ? sub('100–30000 ms (jaise 2000)') : '',
    step.kind === 'switch_bot' ? sub('Bot ka username (@ ke bina)') : '',
    step.kind === 'click_button' ? sub('Button ka text jaisa screen par dikhta hai') : '',
  ].filter(Boolean).join('\n'), trainBackRow('❌ Cancel', routine === 'refresh' ? `tr_rf_${id}` : `tr_cl_${id}`));
});

bot.action(/^tr_clear_(custom_[a-z0-9]+)_(c|r)$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  const id = ctx.match[1];
  const routine = routineFromKey(ctx.match[2]);
  const bot2 = customBotById(id);
  if (!bot2) { await ctx.answerCbQuery('Bot nahi mila', { show_alert: true }).catch(() => {}); return; }
  const meta = customBots.ROUTINE_META[routine];
  await editOrSend(ctx, section(`🧹 ${meta.label} saaf karein?`, [
    `Saare ${bot2.routines[routine].length} steps delete ho jayenge.`,
  ].join('\n')), [
    [{ text: '🧹 Haan, saaf karo', callback_data: `tr_clear_yes_${id}_${routineKey(routine)}`, style: 'danger' }],
    [{ text: '↩️ Wapas', callback_data: routine === 'refresh' ? `tr_rf_${id}` : `tr_cl_${id}`, style: 'primary' }],
  ]);
});

bot.action(/^tr_clear_yes_(custom_[a-z0-9]+)_(c|r)$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  const id = ctx.match[1];
  const routine = routineFromKey(ctx.match[2]);
  const r = customBots.clearRoutine(id, routine);
  await ctx.answerCbQuery(r.ok ? '🧹 Saaf ho gaya' : 'Fail').catch(() => {});
  const bot2 = customBots.getCustomBot(id);
  if (bot2) await showTrainRoutine(ctx, bot2, routine);
});

// Built-in (ab tak coding kiya hua) training template → confirmable replace
bot.action(/^tr_tmpl_(custom_[a-z0-9]+)_(c|r)_(hermes|chauhan)$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  const id = ctx.match[1];
  const routine = routineFromKey(ctx.match[2]);
  const template = ctx.match[3];
  const bot2 = customBotById(id);
  if (!bot2) { await ctx.answerCbQuery('Bot nahi mila', { show_alert: true }).catch(() => {}); return; }
  const steps = customBots.builtinTemplateSteps(routine, template);
  await editOrSend(ctx, section('📋 Template lagayein?', [
    `"${esc(customBots.BUILTIN_TEMPLATE_META[template]?.[routine] || template)}"`,
    '',
    ...steps.map((s, i) => `${i + 1}. ${esc(customBots.describeStep(s))}`),
    '',
    sub(`Current ${bot2.routines[routine].length} steps REPLACE ho jayenge.`),
  ].join('\n')), [
    [{ text: '✅ Template laga do', callback_data: `tr_tmpl_yes_${id}_${routineKey(routine)}_${template}`, style: 'success' }],
    [{ text: '↩️ Wapas', callback_data: routine === 'refresh' ? `tr_rf_${id}` : `tr_cl_${id}`, style: 'primary' }],
  ]);
});

bot.action(/^tr_tmpl_yes_(custom_[a-z0-9]+)_(c|r)_(hermes|chauhan)$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  const id = ctx.match[1];
  const routine = routineFromKey(ctx.match[2]);
  const template = ctx.match[3];
  const r = customBots.applyBuiltinTemplate(id, routine, template);
  await ctx.answerCbQuery(r.ok ? '📋 Template lag gaya' : 'Fail').catch(() => {});
  const bot2 = customBots.getCustomBot(id);
  if (bot2) await showTrainRoutine(ctx, bot2, routine);
});

// ---- Live test (spare Telegram account se real bot ko message/click) ------
async function runTrainTest(ctx, id, routine) {
  const bot2 = customBotById(id);
  if (!bot2) { await ctx.answerCbQuery('Bot nahi mila', { show_alert: true }).catch(() => {}); return; }
  if (!(await requirePrivateTelegramChat(ctx, 'Training test'))) return;
  if (isAutopilotRunning()) {
    await ctx.answerCbQuery('⏳ Batch chal raha hai — test baad me karo (spare account busy hai).', { show_alert: true }).catch(() => {});
    return;
  }
  if (telegramLoginFlow || telegramProviderStatus().loginInProgress) {
    await ctx.answerCbQuery('⏳ Telegram login chal raha hai — pehle complete/cancel karo.', { show_alert: true }).catch(() => {});
    return;
  }
  const status = telegramProviderStatus();
  if (!status.configured) {
    await ctx.answerCbQuery('⚙️ Telegram setup pending — pehle Add Telegram Account karo.', { show_alert: true }).catch(() => {});
    return;
  }
  await ctx.answerCbQuery('🧪 Training test chal raha hai…').catch(() => {});
  const meta = customBots.ROUTINE_META[routine];
  await editOrSend(ctx, section(`🧪 Test ${meta.label} — ${bot2.name}`, [
    `Spare account se <code>@${esc(bot2.username)}</code> ko training ke hisaab se message/click bhej raha hoon…`,
    sub('Test REAL bot ko asli actions bhejta hai — claim test ek naya number nikaal sakta hai.'),
  ].join('\n')), trainBackRow('↩️ Bot card', `tr_view_${id}`));
  const ICON = { ok: '✅', skip: '⏭️', fail: '❌' };
  try {
    const r = await customRunner.testCustomBotRoutine({ botId: id, routine, phone: '', timeoutMs: 25_000 });
    const stepLines = (r.steps || []).map((s) => `${ICON[s.status] || '•'} ${s.index}. ${esc(String(s.kind))} — ${esc(s.detail || '')}`);
    const resultLines = [];
    if (r.ok && r.card?.phone) {
      resultLines.push('', field('📱 Number card', `<code>${esc(r.card.phone)}</code>${r.card.device ? ` · ${esc(r.card.device)}` : ''}`));
    }
    if (r.ok && r.code) resultLines.push('', field('🔢 OTP', `<code>${esc(r.code)}</code>`));
    if (!r.ok) resultLines.push('', field('❌ Fail', esc(r.error || 'unknown')));
    await editOrSend(ctx, section(r.ok ? `✅ ${meta.label} — PASS` : `❌ ${meta.label} — FAIL`, [
      ...stepLines,
      ...resultLines,
      '',
      sub(r.ok ? 'Training chal rahi hai. Batch me use karne ke liye bot card → "▶️ Batch ka OTP bot banao".'
        : 'Jo step fail hua wahan se training fix karo (⚙️ Condition / fail-mode / ✏️ Text badlo).'),
    ].join('\n')), [
      [{ text: '📋 Claim', callback_data: `tr_cl_${id}`, style: 'primary' }, { text: '🔄 Refresh', callback_data: `tr_rf_${id}` }],
      [{ text: '▶️ Batch ka OTP bot banao', callback_data: `tr_use_${id}`, style: 'success' }],
      [{ text: '↩️ Bot card', callback_data: `tr_view_${id}`, style: 'primary' }],
    ]);
  } catch (error) {
    await editOrSend(ctx, section('❌ Test crash', [
      esc(shortTelegramLoginError(error)),
      '',
      sub('Session expire hua? Settings → Add Telegram Account se dobara login karo.'),
    ].join('\n')), [
      [{ text: '👤 Add Telegram Account', callback_data: 'ap_telegram_account', style: 'success' }],
      [{ text: '↩️ Bot card', callback_data: `tr_view_${id}`, style: 'primary' }],
    ]);
  }
}

bot.action(/^tr_testc_(custom_[a-z0-9]+)$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  await runTrainTest(ctx, ctx.match[1], 'claim');
});

bot.action(/^tr_testr_(custom_[a-z0-9]+)$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  await runTrainTest(ctx, ctx.match[1], 'refresh');
});


bot.on('text', async (ctx) => {
  const uid = String(ctx.from?.id);
  if (!isOwner(ctx.from?.id)) return;
  const st = pending.get(uid);
  if (!st) return;
  const rawMessageText = String(ctx.message?.text || '');
  const txt = rawMessageText.trim();

  if (typeof st.action === 'string' && st.action.startsWith('custom_')) {
    await handleCustomBotPending(ctx, st, txt);
    return;
  }

  if (st.action === 'telegram_login') {
    const flow = telegramLoginFlow;
    // Sensitive login inputs sabse pehle chat se delete karne ki koshish karo.
    let deleted = false;
    try {
      if (ctx.chat?.id && ctx.message?.message_id) {
        await bot.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id);
        deleted = true;
      }
    } catch {}

    if (!flow || flow.id !== st.flowId || flow.ownerId !== uid || flow.stage !== st.stage) {
      pending.delete(uid);
      await ctx.reply('⌛ Ye Telegram login step khatam ho gaya hai. Settings → Add Telegram Account se dobara shuru karo.', kb(settingsRows())).catch(() => {});
      return;
    }
    if (ctx.chat?.type !== 'private' || String(ctx.chat.id) !== String(flow.chatId)) {
      await ctx.reply('🔒 Telegram login input sirf usi private chat se bhejo jahan Add Telegram Account start kiya tha.').catch(() => {});
      return;
    }
    if (!deleted && !flow.deleteWarned) {
      flow.deleteWarned = true;
      await ctx.reply('⚠️ Input message auto-delete nahi ho paya — security ke liye use khud delete kar do.').catch(() => {});
    }
    if (/^\/cancel(?:@\w+)?$/i.test(txt)) {
      cancelTelegramLoginFlow('cancel');
      await ctx.reply('✖️ Telegram login cancel request mil gayi.', kb(settingsRows())).catch(() => {});
      return;
    }

    const resolve = flow.resolveInput;
    clearTelegramLoginWait(flow);
    if (!resolve) {
      await ctx.reply('⏳ Login processor abhi ready nahi hai — agla prompt aaye tab dobara bhejo.').catch(() => {});
      return;
    }
    // Password me leading/trailing spaces bhi ho sakte hain; baaki stages apne
    // validators me normalization karte hain. Isliye raw value resolve hoti hai.
    resolve(st.stage === 'password' ? rawMessageText : txt);
    return;
  }

  if (st.action === 'add_source') {
    pending.delete(uid);
    const batchRunning = isAutopilotRunning();
    const r = sources.addSourcesBulk(txt, {
      // Manual add ki purani aadat: naye group ka pehla URL first-try bane.
      // Is se baaki sources inactive nahi hote — sab ACTIVE pool me rehte hain.
      setFirstAsPrimary: !batchRunning,
      applyReader: !batchRunning,
    });

    const lines = [];
    if (r.added.length) {
      lines.push(`✅ <b>${r.added.length} Firebase add ho gaye — sab ACTIVE.</b>`);
      lines.push(...r.added.slice(0, 8).map((s) => `• <b>${esc(s.name)}</b> — <code>${esc(s.url.replace('https://', ''))}</code>`));
      if (r.added.length > 8) lines.push(`• …aur <b>${r.added.length - 8}</b> Firebase`);
    }
    if (r.duplicates.length) {
      lines.push(`↻ <b>${r.duplicates.length}</b> duplicate skip — woh pehle se ACTIVE thay.`);
    }
    if (r.invalid.length) {
      lines.push(`⚠️ <b>${r.invalid.length}</b> entry add nahi hui:`);
      lines.push(...r.invalid.slice(0, 3).map((x) => `• ${esc(x.error)}${x.input ? ` — <code>${esc(String(x.input).slice(0, 70))}</code>` : ''}`));
      if (r.invalid.length > 3) lines.push(`• …aur ${r.invalid.length - 3} invalid entries`);
    }
    if (!r.added.length && !r.duplicates.length && !r.invalid.length) {
      lines.push('❌ Koi Firebase URL nahi mila. Ek URL per line ya comma se alag karke bhejo.');
    }
    lines.push(`🔥 Total ab: <b>${r.total} ACTIVE Firebase</b> — Delete karne tak sab active rahenge.`);
    if (batchRunning && r.added.length) {
      lines.push('⏳ Batch chal raha hai — naye Firebase saved ACTIVE hain, lekin current OTP flow disturb kiye bina agle batch ke ACTIVE pool me aayenge.');
    }

    // Ek hi naya source ho to purani tarah turant verify bhi kar do. Bulk
    // me 50+ DBs ko ek-ek test karne se bot be-wajah atak sakta hai; woh
    // sab ACTIVE save ho chuke hain aur detail card se Verify ho sakte hain.
    if (r.added.length === 1) {
      const v = await sources.verifySource(r.added[0].id);
      lines.push(v.ok
        ? `🧪 Verify: reachable in ${v.ms}ms${v.topKeys?.length ? ` · keys: <code>${esc(v.topKeys.join(', '))}</code>` : ''}`
        : `⚠️ Verify fail: ${esc(v.error)} — source phir bhi ACTIVE save hai; URL/auth check kar sakte ho.`);
    } else if (r.added.length > 1) {
      lines.push('🧪 Bulk auto-verify skip kiya taaki add turant complete ho — kisi source ko tap karke Verify kar sakte ho.');
    }

    await ctx.reply(
      section(r.added.length ? '🔥 Firebase Sources Added' : '🔥 Firebase Add Result', lines.join('\n')),
      kb([[{ text: '↩️ Sources', callback_data: 'ap_sources', style: 'primary' }]])
    ).catch(() => {});
    return;
  }

  if (st.action === 'add_proxy') {
    pending.delete(uid);
    // Comma / newline se alag karke ek saath bahut saare add
    const parts = txt.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
    const added = [];
    const errs = [];
    for (const raw of parts) {
      const r = proxyPool.addProxy(raw);
      if (r.ok) added.push(r.proxy.label);
      else errs.push(`${raw.slice(0, 30)}: ${r.error}`);
    }
    const lines = [];
    if (added.length) lines.push(`✅ <b>${added.length}</b> proxy add: <code>${esc(added.join(', '))}</code>`);
    if (errs.length) lines.push(`⚠️ ${errs.slice(0, 3).map(esc).join('\n')}`);
    lines.push('', sub('Ab bot nayi-nayi IPs se traffic bhejega — rukna bilkul band.'));
    await ctx.reply(section('🔀 Proxy Pool Updated', lines.join('\n')), kb([[{ text: '↩️ Proxies', callback_data: 'ap_proxies', style: 'primary' }]])).catch(() => {});
    return;
  }

  if (st.action === 'setup_wizard_proxy') {
    const wizardSt = pending.get(uid);
    pending.delete(uid);
    if (!wizardSt || wizardSt.action !== 'setup_wizard') return;
    const parts = txt.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
    const added = [];
    const errs = [];
    for (const raw of parts) {
      const r = proxyPool.addProxy(raw);
      if (r.ok) added.push(r.proxy.label);
      else errs.push(`${raw.slice(0, 30)}: ${r.error}`);
    }
    if (added.length === 0) {
      // Invalid proxy — ask again
      pending.set(uid, { action: 'setup_wizard_proxy', stage: 'proxy_paste', choices: wizardSt.choices });
      await ctx.reply(section('❌ Proxy Invalid', [
        errs.slice(0, 3).map((e) => `• ${esc(e)}`).join('\n'),
        '',
        'Dobara proxy URL bhejo (format: <code>http://user:pass@host:port</code>), ya Cancel karo.',
      ].join('\n')), [[{ text: '❌ Cancel', callback_data: 'ap_setup_confirm_cancel', style: 'danger' }]]).catch(() => {});
      return;
    }
    // Save proxy info and move to confirm
    wizardSt.choices.proxyUrl = parts[0];
    wizardSt.choices.proxy = 'yes';
    wizardSt.stage = 'confirm';
    pending.set(uid, wizardSt);
    const card = setupWizardCard(wizardSt);
    await ctx.reply(card.text, kb(card.rows)).catch(() => {});
    return;
  }

  if (st.action === 'custom_target') {
    pending.delete(uid);
    const n = Number(txt.replace(/\D/g, ''));
    const r = bs.setSetting('target', n);
    if (!r.ok) {
      await ctx.reply(`❌ ${r.error}`).catch(() => {});
      return;
    }
    await ctx.reply(`🎯 Target = ${r.value} fresh sessions ✅`, kb([[{ text: '⚙️ Settings', callback_data: 'ap_settings', style: 'primary' }]])).catch(() => {});
    return;
  }

  pending.delete(uid);
});

// Unhandled engine callback kahin na phase — catch-all answer
bot.on('callback_query', async (ctx) => {
  if (!isOwner(ctx.from?.id)) return;
  await ctx.answerCbQuery().catch(() => {});
});

// ---------------------------------------------------------------------------
// 🚀 Launch — preflight + retry ke saath.
// PEHLE KE BUGS:
//  1) Ek hi network jhatka (TLS disconnect waghera) = "launch failed" bolkar
//     bot seedha band. Ab getMe preflight 6 baar retry karega.
//  2) 401/409 par wajah samajh hi nahi aati thi. Ab saaf bataega:
//       401 = BOT_TOKEN galat/revoke ho chuka
//       409 = isi token se DOOSRI copy pehle se chal rahi hai
//  3) SIGINT/SIGTERM handlers `await bot.launch()` ke BAAD lage the — launch
//     wala promise bot band hone par hi resolve hota hai, matlab handlers
//     kabhi register hi nahi hote the. Ab pehle lagte hain.
// ---------------------------------------------------------------------------
let shuttingDown = false;
const shutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[FreshBot] ${signal} mila — batch rok kar band kar raha hoon…`);
  runtimeHealth.telegramReady = false;
  try { requestAutopilotStop(signal); } catch {}
  try { keepAliveHandle?.stop?.(); } catch {}
  try { if (telegramWatchdogTimer) clearInterval(telegramWatchdogTimer); } catch {}
  try { bot.stop(signal); } catch {}
  try { healthServer?.close?.(); } catch {}
  setTimeout(() => process.exit(0), 1500).unref?.();
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

// Startup self-check — console me pehli nazar me sab dikh jaye
{
  const nodeMajor = Number(String(process.versions.node).split('.')[0]) || 0;
  console.log(`[FreshBot] 🏷 Instance: ${instanceInfo.getInstanceLabel()}${instanceInfo.isSecondaryInstance() ? ' (doosra bot — INSTANCE_LABEL env se)' : ''}`);
  {
    const shard = instanceShard.shardSummary();
    if (shard.enabled) {
      console.log(`[FreshBot] 🧩 Shard: pool/proxies ko ${shard.count} hisson me baanta — ye hissa ${shard.share} (INSTANCE_COUNT=${shard.count}, INSTANCE_INDEX=${shard.index})`);
    } else if (instanceInfo.isSecondaryInstance()) {
      console.warn('[FreshBot] ⚠️ INSTANCE_LABEL set hai par INSTANCE_COUNT nahi — agar kai bots ek hi Firebase pool/proxy par chal rahe hain to wo ek doosre se ladenge (same numbers, same IPs, same OTP). Fix: har instance me INSTANCE_COUNT=<kul bots> daalo (e.g. 4).');
    }
  }
  {
    try {
      const tag = telegramOtp.telegramSessionTag();
      if (tag) console.log(`[FreshBot] 🔑 Telegram session tag: ${tag} — DOOSRE bot par bhi yahi tag dikhe to wo ek hi spare account hai (OTP races + session conflict). Har bot ka apna account chahiye.`);
    } catch {}
  }
  console.log(`[FreshBot] Node ${process.version}${nodeMajor < 20 ? '  ⚠️ Node 20+ chahiye — nodejs.org se update karo, warna kuch bhi kabhi bhi toot sakta hai!' : ''}`);
  try {
    const c = getChromeStatus();
    console.log(c.found
      ? `[FreshBot] Chrome ✅ ${c.path}${c.headless ? ' (headless)' : ''}`
      : '[FreshBot] Chrome ❌ nahi mila — WAF solver nahi chalega. Chrome install karo ya .env me PUPPETEER_EXECUTABLE_PATH do. (Bot phir bhi chalega, /diag dekho.)');
  } catch {}
  console.log(`[FreshBot] Firebase ${isFirebaseConfigured() ? '✅ configured' : '❌ config nahi — FIREBASE_DB_URL / Settings → Firebase Sources'}`);
  console.log(`[FreshBot] Owner gate: ${ownerIds() ? 'OWNER_IDS (.env)' : 'store bossIds + default (OWNER_IDS khali hai)'}`);
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const tgCode = (e) => Number(e?.code ?? e?.response?.error_code ?? 0) || 0;
const isNetErr = (e) => /fetch|network|socket|TLS|ECONN|ETIMEDOUT|EAI_AGAIN|timed? ?out|disconnected/i.test(`${e?.name || ''} ${e?.message || ''}`);

// ---------------------------------------------------------------------------
// 🔒 Ek hi instance — dobara "409: Conflict: terminated by other getUpdates
// request" wala crash rokne ke liye. Ek lock file (data/bot.lock) batati hai
// ki isi machine par pehle se ek copy chal rahi hai. Purani copy band ho chuki
// hai to stale lock khud hata kar aage badh jaate hain.
// ---------------------------------------------------------------------------
async function acquireInstanceLock() {
  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = process.env.DATA_DIR
      ? path.resolve(process.env.DATA_DIR)
      : path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
    fs.mkdirSync(dir, { recursive: true });
    const lock = path.join(dir, 'bot.lock');
    if (fs.existsSync(lock)) {
      const pid = parseInt(String(fs.readFileSync(lock, 'utf8')).trim(), 10);
      if (pid && pid !== process.pid) {
        let alive = true;
        try { process.kill(pid, 0); } catch (e) { alive = e?.code === 'EPERM'; }
        if (alive) return { ok: false, pid, lock };
      }
      fs.unlinkSync(lock); // stale lock (purani copy mar chuki hai)
    }
    fs.writeFileSync(lock, String(process.pid));
    const mine = String(process.pid);
    process.on('exit', () => {
      try {
        if (String(fs.readFileSync(lock, 'utf8')).trim() === mine) fs.unlinkSync(lock);
      } catch {}
    });
    return { ok: true, lock };
  } catch {
    return { ok: true }; // lock na bane to bot band mat karo
  }
}

const lockState = await acquireInstanceLock();
if (!lockState.ok) {
  console.error(`❌ Isi machine par bot ALREADY chal raha hai (PID ${lockState.pid}).`);
  console.error('   Ek token = ek copy. Purani copy band karo (Ctrl+C wale terminal ya us service ko),');
  console.error('   phir npm start. Do copy ek saath = Telegram 409 Conflict.');
  process.exit(1);
}

// Token + internet pehle test karo (getMe) — network par retry, token galat
// ho to turant saaf wajah. Bina is test ke bot chup-chaap "launch failed"
// bolkar mar jata tha.
// getMe ka HARD timeout. Telegraf/undici kabhi kabhi reply ke intezaar me
// latak jate hain (Render par dekha gaya: /health par 200, ready:false, aur
// process na aage badha na restart hua). Isliye har network call khud band
// karo — hang = fail, phir normal retry.
const TELEGRAM_CALL_TIMEOUT_MS = Number(process.env.TELEGRAM_CALL_TIMEOUT_MS) || 20_000;
function withTelegramTimeout(promise, label = 'telegram call', ms = TELEGRAM_CALL_TIMEOUT_MS) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout (${Math.round(ms / 1000)}s)`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, guard]).finally(() => { if (timer) clearTimeout(timer); });
}

async function preflight() {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const me = await withTelegramTimeout(bot.telegram.getMe(), 'getMe');
      runtimeHealth.telegramUsername = me.username || '';
      runtimeHealth.telegramApiOkAt = Date.now();
      runtimeHealth.telegramApiFailures = 0;
      runtimeHealth.lastTelegramError = '';
      console.log(`[FreshBot] Telegram ✅ @${me.username} (id ${me.id})`);
      // Agar is token par kahin webhook laga ho (purana server, ya token
      // leak hone par kisi aur ne lagaya ho) to polling 409 marega aur bot
      // kabhi chalega hi nahi — isliye shuru me webhook saaf kar do.
      await withTelegramTimeout(bot.telegram.deleteWebhook({ drop_pending_updates: true }), 'deleteWebhook')
        .catch((e) => console.warn('[FreshBot] deleteWebhook skip:', e?.message || e));
      return me;
    } catch (e) {
      runtimeHealth.telegramApiFailures++;
      runtimeHealth.lastTelegramError = String(e?.message || e || '').slice(0, 180);
      const code = tgCode(e);
      if (code === 401) {
        console.error('❌ BOT_TOKEN galat hai ya revoke ho chuka hai (Telegram 401).');
        console.error('   Fix: Telegram me @BotFather → /mybots → apna bot → API Token → naya token lo,');
        console.error('   .env ki BOT_TOKEN= wali line me naya token daalo, phir npm start.');
        process.exit(1);
      }
      const waitSec = Math.min(3 * 2 ** (attempt - 1), 30);
      const retryable = isNetErr(e) || code === 429 || code >= 500 || code === 0;
      console.error(`[FreshBot] Telegram se connect nahi hua (try ${attempt}/6): ${e?.message || e}`);
      if (!retryable || attempt === 6) {
        console.error('❌ Internet/Telegram tak pahunch hi nahi paya. Net check karo (VPN/firewall?), phir npm start.');
        process.exit(1);
      }
      console.log(`[FreshBot] ${waitSec}s ruk kar dobara try…`);
      await sleepMs(waitSec * 1000);
    }
  }
}

// Telegram API/polling atak jaye to health server akele 200 deta rahega
// aur user ko lagega cron kaam kar raha hai lekin bot jawab nahi de raha.
// Watchdog har 2 minute me halka getMe check karta hai; lagatar 3 fail
// par process exit kar deta hai taaki Render fresh instance/polling start
// kare. Ek-aadh network jhatke par restart nahi hota.
function startTelegramWatchdog() {
  if (telegramWatchdogTimer) return;
  telegramWatchdogTimer = setInterval(async () => {
    if (shuttingDown || !runtimeHealth.telegramReady) return;
    try {
      const me = await withTelegramTimeout(bot.telegram.getMe(), 'getMe (watchdog)', 15_000);
      runtimeHealth.telegramUsername = me?.username || runtimeHealth.telegramUsername;
      runtimeHealth.telegramApiOkAt = Date.now();
      runtimeHealth.telegramApiFailures = 0;
      runtimeHealth.lastTelegramError = '';
    } catch (e) {
      const code = tgCode(e);
      runtimeHealth.telegramApiFailures++;
      runtimeHealth.lastTelegramError = String(e?.message || e || '').slice(0, 180);
      console.warn(`[FreshBot] Telegram watchdog fail ${runtimeHealth.telegramApiFailures}/3: ${runtimeHealth.lastTelegramError}`);
      if (code === 401 || runtimeHealth.telegramApiFailures >= 3) {
        if (isAutopilotRunning()) {
          // Active batch ko Telegram UI/API ke jhatke par force-stop mat
          // karo. Hermes/Swiggy ka kaam process ke andar jaari reh sakta
          // hai; restart sirf batch khatam honay ke baad watchdog karega.
          runtimeHealth.telegramApiFailures = 2;
          console.error('[FreshBot] Telegram API fail hai, lekin batch chal raha hai — restart batch ke baad tak deferred.');
          return;
        }
        console.error('[FreshBot] Telegram API lagatar fail hai — Render restart ke liye process exit kar raha hoon.');
        try { requestAutopilotStop('telegram-watchdog'); } catch {}
        process.exit(1);
      }
    }
  }, 2 * 60_000);
  telegramWatchdogTimer.unref?.();
}

// ---------------------------------------------------------------------------
// ☁️ Cloud-vault hydrate (Render ke liye khaas zaroori) — bina persistent
// disk ke har deploy/restart par data/db.json fresh banta hai aur saare
// saved accounts chale jate. Vault configured ho (GITHUB_VAULT_TOKEN +
// VAULT_ENCRYPTION_KEY) to accounts GitHub vault se wapas aa jate hain.
// Pehle ye function store me tha lekin bot ise KABHI bulata hi nahi tha.
// 12s timeout: vault slow/fail ho to bot startup atke nahi.
// ---------------------------------------------------------------------------
try {
  const hydrated = await Promise.race([
    hydrateAccountsFromCloudVault(),
    sleepMs(12_000).then(() => null),
  ]);
  if (hydrated) console.log(`[FreshBot] Cloud vault hydrate: ${hydrated.restored}/${hydrated.total} accounts wapas aaye.`);
} catch (e) {
  console.warn('[FreshBot] Cloud vault hydrate skipped:', e?.message || e);
}

// Saved OTP bot (Hermes / HardXotp) boot par hi apply karo — taaki /diag,
// Test Hermes aur batch — teeno ek hi bot dikhayen/chalayen.
try {
  const savedOtpBot = bs.getSetting('otpBotProfile');
  if (savedOtpBot && savedOtpBot !== 'hermes') telegramOtp.setActiveOtpBotProfile(savedOtpBot);
  else telegramOtp.setActiveOtpBotProfile(savedOtpBot || 'hermes');
  console.log(`[FreshBot] 🤖 OTP bot: ${otpBotProfiles.getOtpBotProfile(savedOtpBot).username}`);
} catch (e) {
  console.warn('[FreshBot] OTP bot apply skipped:', e?.message || e);
}

// Vault se owner ki Firebase list wapas aayi ho to reader par turant lagao —
// warna first-try purani env DB reh jati hai aur 400+ saved sources bekaar.
try {
  const applied = sources.applyActiveSource();
  const all = sources.listSources();
  console.log(`[FreshBot] 🔥 Firebase sources ready: ${all.length} ACTIVE · first-try ${applied?.name || 'env'}`);
} catch (e) {
  console.warn('[FreshBot] Firebase sources apply skipped:', e?.message || e);
}

// Health server upar bot bante hi start ho chuka hai (Render ko port
// foran chahiye hota hai) — yahan dobara start nahi karna.
await preflight();

// 409 = doosri copy chal rahi hai. Kabhi kabhi wo copy abhi mar rahi/Restart
// ho rahi hoti hai — aise me 1-2 try me yehi instance aage aa jata hai.
// Persistent conflict ho to saaf wajah ke saath band (retry se fayda nahi).
//
// ⚠️ Loop ka control `await bot.launch()` se hi — kabhi onLaunch callback se
// nahi. Telegraf me wo callback getMe ke BAAD aur polling se PEHLE chalta hai,
// to usse flag set karne par pehle hi 409 aane par bhi loop soch kar band ho
// jata tha (process chup-chaap exit 0, koi message nahi).
//
// "Live" ka confirmation bhi asal me hi: 409 aam taur par 1-2s me aa jata
// hai, isliye har attempt ke 6s baad bina ruke = polling stable. Health
// readiness/watchdog bhi isi stable point par ON hoti hai.
let liveTimer = null;
const armLiveConfirm = (attempt) => {
  if (liveTimer) clearTimeout(liveTimer);
  liveTimer = setTimeout(() => {
    runtimeHealth.telegramReady = true;
    runtimeHealth.telegramReadyAt = Date.now();
    startTelegramWatchdog();
    console.log('✅ Bot LIVE — Telegram polling stable (koi conflict nahi).');
    console.log('🆕 Swiggy Fresh Bot chal raha hai — START dabao, phone chhod ke aa jao. (/diag = health check)');
  }, 6_000);
  liveTimer.unref?.();
};
const disarmLiveConfirm = () => { if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; } };

// ---------------------------------------------------------------------------
// 🔁 AUTO-RESUME — Render deploy/restart, GitHub-Actions runner badalna ya
// process crash ke baad WAHI batch khud wapas shuru ho. Flag db (data/db.json)
// aur cloud vault dono me hota hai; manual STOP aur target pura hone par
// engine khud flag clear kar deta hai, isliye ye kabhi apne aap repeat nahi
// hota. Ye hi us "batch ruk gaya" ka tod hai jo restart par hota tha.
// ---------------------------------------------------------------------------
function createHeadlessUi(chatId) {
  let msgId = 0;
  let lastAt = 0;
  let lastText = '';
  return {
    async update(text, rows) {
      const now = Date.now();
      if (!text || text === lastText) return;
      // Flood se bachao: live card sirf ~15s me ek baar; final summary
      // ("BATCH KHATAM") hamesha jaati hai.
      const isFinal = /BATCH KHATAM/.test(text);
      if (!isFinal && now - lastAt < 15_000) return;
      lastAt = now;
      lastText = text;
      const extra = kb(Array.isArray(rows) ? rows : []);
      if (msgId) {
        try { await bot.telegram.editMessageText(chatId, msgId, undefined, text, extra); return; } catch {}
      }
      try {
        const m = await bot.telegram.sendMessage(chatId, text, extra);
        msgId = m?.message_id || 0;
      } catch {}
    },
    async sendSession(payload) {
      return deliverSessionJson(chatId, payload);
    },
  };
}

async function maybeAutoResumeBatch() {
  try {
    if (shuttingDown || isAutopilotRunning()) return;
    if (bs.getSetting('autoContinue') === false) return; // Never-stop OFF = koi auto start nahi
    const resume = bs.getAutopilotResume();
    if (!resume?.wanted) return;
    const savedAt = Number(resume.savedAt || resume.startedAt || 0);
    if (!savedAt || Date.now() - savedAt > 12 * 60 * 60_000) {
      bs.clearAutopilotResume();
      return;
    }
    const ids = ownerIds();
    const chatId = ids ? [...ids][0] : '5393396812';
    if (!chatId) return;
    const ui = createHeadlessUi(chatId);
    const mins = Math.max(1, Math.round((Date.now() - savedAt) / 60_000));
    console.log(`[FreshBot] 🔁 Auto-resume — pichhla batch ${mins} min pehle "${resume.lastEndReason || 'restart'}" par ruka tha; wapas shuru.`);
    await bot.telegram.sendMessage(chatId, section('🔁 Batch Auto-Resume', [
      `› Bot restart hua (${mins} min pehle), lekin batch adhura tha — ab <b>khud wapas</b> shuru kar raha hoon.`,
      `› Pichhla end: <code>${esc(String(resume.lastEndReason || 'restart'))}</code> · target ${Number(resume.target) || 0} fresh · source ${esc(String(resume.sourceMode || 'firebase'))}`,
      `› Live card /status par milega. Band karna ho to ⏹ STOP dabao.`,
      sub('Auto-resume Settings → 🔁 Never-stop se off hota hai.'),
    ].join('\n')), kb([
      [{ text: '📊 Status', callback_data: 'ap_status' }, { text: '⏹ STOP BATCH', callback_data: 'ap_stop', style: 'danger' }],
    ])).catch(() => {});
    void startAutopilot({
      userId: String(chatId),
      sourceMode: resume.sourceMode || undefined,
      numberSource: resume.sourceMode || undefined,
      source: resume.sourceMode || undefined,
      otpBot: resume.otp || '',
      target: Number(resume.target) || undefined,
      ui,
      autoResumedAt: Date.now(),
    }).catch((e) => console.error('[FreshBot] auto-resume:', e?.stack || e?.message));
  } catch (e) {
    console.warn('[FreshBot] auto-resume check:', e?.message || e);
  }
}

// Telegram ready hone ke ~25s baad ek hi baar check (polling ke saath parallel).
setTimeout(() => { void maybeAutoResumeBatch(); }, 25_000).unref?.();

let conflictAttempts = 0;
let transientLaunchAttempts = 0;
for (let attempt = 1; ; attempt++) {
  armLiveConfirm(attempt);
  try {
    await bot.launch({ dropPendingUpdates: true }, () => {
      console.log(`🔄 Telegram connect ho raha hai (attempt ${attempt})…`);
    });
    // Yahan tab aate hain jab launch resolve ho (yaani polling stop ho chuki —
    // shutdown already chal raha hoga). Dobara launch ki zaroorat nahi.
    disarmLiveConfirm();
    runtimeHealth.telegramReady = false;
    break;
  } catch (e) {
    disarmLiveConfirm();
    runtimeHealth.telegramReady = false;
    runtimeHealth.telegramApiFailures++;
    runtimeHealth.lastTelegramError = String(e?.message || e || '').slice(0, 180);
    const code = tgCode(e);
    if (shuttingDown) break;
    const batchRunning = (() => { try { return isAutopilotRunning(); } catch { return false; } })();
    if (code === 409) {
      conflictAttempts += 1;
      if (conflictAttempts < 4 || batchRunning) {
        console.error(`[FreshBot] 409 Conflict (try ${conflictAttempts}) — doosri copy abhi band ho rahi hogi; webhook saaf karke 15s baad dobara…`);
        try { bot.stop('retry-409'); } catch {}
        await bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
        await sleepMs(15_000);
        continue;
      }
    }
    if (code === 401 && batchRunning) {
      console.error('[FreshBot] Telegram 401 aaya, lekin batch chal raha hai — process ko force-stop nahi kar raha; 30s baad polling retry.');
      await sleepMs(30_000);
      continue;
    }
    if (code !== 401 && code !== 409) {
      transientLaunchAttempts += 1;
      if (batchRunning || transientLaunchAttempts <= 12) {
        const waitMs = Math.min(30_000, 5_000 * (2 ** Math.min(3, transientLaunchAttempts - 1)));
        console.error(`[FreshBot] Telegram launch temporary fail (try ${transientLaunchAttempts}) — ${Math.round(waitMs / 1000)}s baad retry. Batch force-stop nahi hoga.`);
        try { bot.stop('retry-launch'); } catch {}
        await sleepMs(waitMs);
        continue;
      }
    }
    if (code === 409) {
      console.error('❌ Telegram 409 Conflict — isi BOT_TOKEN se bot ki DOOSRI copy pehle se chal rahi hai.');
      console.error('   Fix: purani copy band karo (doosra terminal/server/PC jahan bot chal raha ho),');
      console.error('   phir yahan npm start. Ek token = ek hi copy ek waqt par.');
      console.error('   (Agar bot Render par bhi chalta hai to wahan aur yahan se EK HI jagah chalao.)');
    } else if (code === 401) {
      console.error('❌ Telegram 401 — BOT_TOKEN revoke/galat. @BotFather se naya token lekar .env me daalo.');
    } else {
      console.error('[FreshBot] launch failed:', e?.stack || e?.message || e);
    }
    process.exit(1);
  }
}
