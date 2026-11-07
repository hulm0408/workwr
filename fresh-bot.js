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
} = await import('./autopilot-engine.js');
const { isFirebaseConfigured, firebaseSetupHintLines, listPoolNumbers, _countDeviceOnlineStates } = await import('./firebase-numbers.js');
const telegramOtp = await import('./telegram-otp-source.js');
const sources = await import('./firebase-sources.js');
const otpBotProfiles = await import('./otp-bot-profiles.js');
const bs = await import('./bot-settings.js');
const proxyPool = await import('./proxy-pool.js');
const {
  getChromeStatus,
  getSwiggyAccountJwtSessionInfo,
  refreshSavedSwiggySession,
  SWIGGY_LONG_SESSION_MIN_MS,
} = await import('./swiggy-bridge.js');
const wafPool = await import('./waf-pool.js');
const { esc, section, sub, field, mono, statusCard } = await import('./rich-text.js');
const { createServer } = await import('node:http');
const { startKeepAlive } = await import('./keep-alive.js');

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
  return statusCard('🆕 Swiggy Fresh Bot', [
    mono(telegram ? '[NEW] › OTP › REFRESH › VERIFY › ADDR › FRESH' : '[POOL] › OTP › INBOX › VERIFY › ADDR › FRESH'),
    '<b>Abhi:</b> START ka wait hai',
    telegram
      ? `📨 ${mono(`${activeOtpBotLabel().toUpperCase()} ONLY`)} · 🔥 Firebase ${mono('OFF')}`
      : activeSourceLine(),
    `🎯 ${mono(`${target} fresh`)} · ⏱ ${mono(`${maxMin} min`)}`,
    '⏭ Running card par <b>SKIP NUMBER</b> bhi rahega — sirf current number chhodega, batch nahi rukega.',
    telegram
      ? '<b>Next:</b> START dabao — bot chuno, phir new number aayega'
      : '<b>Next:</b> START dabao — live card par har step dikhega',
  ]);
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
  return section('⚙️ Settings', [
    activeSourceLine(),
    field('🔀 Proxies', ps.enabled ? `${ps.enabledCount}/${ps.total} ON — ${ps.rotation}` : 'OFF (rukna pad sakta hai)'),
    ``,
    field('🎯 Target', `${bs.getSetting('target')} fresh`),
    field('⚡ Parallel lanes', `${bs.getSetting('concurrency')} numbers/IPs ek saath`),
    field('⏱ Max time', `${bs.getSetting('maxMinutes')} min`),
    field('🚦 Gap', bs.fmtSetting('gapMs')),
    field('⏳ OTP wait', bs.fmtSetting('otpWaitMs')),
    field('📴 Offline devices', bs.getSetting('allowOffline') ? 'ON (try bhi karenge)' : 'OFF (sirf online)'),
    ``,
    field('📨 Telegram mode', bs.fmtSetting('telegramOtpMode')),
    field('🤖 OTP bot', `${esc(bs.fmtSetting('otpBotProfile'))} — <code>@${esc(String(telegramProviderStatus().botUsername || ''))}</code>`),
    numberSourceLine(),
    isTelegramNumberSource()
      ? field('⏳ OTP wait', `${bs.fmtSetting('telegramOtpTimeoutMs')} budget · har ${bs.fmtSetting('telegramOtpRefreshMs')}`)
      : '',
    ``,
    sub(isTelegramNumberSource()
      ? 'Number + OTP Telegram Hermes se aayenge; Firebase fallback OFF hai.'
      : 'Sab kuch yahin se badlo — .env chhedni ki zaroorat nahi.'),
  ].join('\n'));
}

const settingsRows = () => [
  [{ text: `🔥 Firebase Sources${isTelegramNumberSource() ? ' · fallback OFF' : ''}`, callback_data: 'ap_sources', style: 'primary' }],
  [{ text: `📨 Telegram mode: ${bs.fmtSetting('telegramOtpMode')}`, callback_data: 'ap_toggle_telegram', style: 'primary' }],
  [{ text: `🤖 OTP bot: ${bs.fmtSetting('otpBotProfile')}`, callback_data: 'ap_pick_otp_bot', style: 'primary' }],
  [{ text: '👤 Add Telegram Account', callback_data: 'ap_telegram_account', style: 'success' }],
  [{ text: '🧪 Test Hermes', callback_data: 'ap_test_hermes' }, { text: '🗑 Remove Telegram', callback_data: 'ap_remove_telegram', style: 'danger' }],
  ...(isTelegramNumberSource() ? [[
    { text: `⏳ OTP wait: ${bs.fmtSetting('telegramOtpTimeoutMs')}`, callback_data: 'ap_pick_telegram_wait' },
    { text: `🔄 Refresh: ${bs.fmtSetting('telegramOtpRefreshMs')}`, callback_data: 'ap_pick_telegram_refresh' },
  ]] : []),
  [{ text: `🔀 Proxies: ${proxyPool.proxySummary().enabledCount}`, callback_data: 'ap_proxies', style: 'primary' }],
  [{ text: `🎯 Target: ${bs.getSetting('target')}`, callback_data: 'ap_pick_target' }],
  [{ text: `⚡ Parallel: ${bs.getSetting('concurrency')} lanes`, callback_data: 'ap_pick_parallel' }],
  [{ text: `⏱ Max: ${bs.getSetting('maxMinutes')}m`, callback_data: 'ap_pick_time' }],
  [{ text: `🚦 Gap: ${bs.fmtSetting('gapMs')}`, callback_data: 'ap_pick_gap' }],
  [{ text: `📴 Offline: ${bs.getSetting('allowOffline') ? 'ON' : 'OFF'}`, callback_data: 'ap_toggle_offline' }],
  [{ text: '🩺 Diagnose (kya toota hai?)', callback_data: 'ap_diag' }],
  [{ text: '↩️ Back', callback_data: 'ap_home', style: 'primary' }],
];

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
    text: section('🔀 Proxy Pool — IP Rotation', [
      `Status: <b>${ps.enabled ? `ON (${ps.enabledCount}/${ps.total})` : 'OFF'}</b> — ${esc(ps.rotation)}`,
      `🌐 Free auto-fetch: <b>${ps.autoFree ? 'ON' : 'OFF'}</b>${ps.autoCount ? ` · ${ps.autoCount} auto (${ps.autoClean || 0} clean${ps.autoChallenged ? ` · ${ps.autoChallenged} 🛡 WAF-ready` : ''})` : ''}`,
      ``,
      list.length
        ? list.map((p) =>
            `${p.enabled ? (p.cooldownLeftMs > 0 ? `🟡 (${Math.ceil(p.cooldownLeftMs / 1000)}s)` : '▫️') : '🚫'} <b>${esc(p.label)}</b>${p.quality === 'challenged' ? ' 🛡' : ''}${p.tokenReady ? ' 🔑' : ''} · hits: ${p.hits || 0}`
          ).join('\n')
        : sub('Koi proxy nahi — abhi sab kuch EK IP se ja raha hai (rukne ka khatra).'),
      ``,
      sub('🌐 dabao — bot free proxy list se la kar sirf Swiggy par zinda wali rakhega. Batch start par bhi auto ho jata hai. Ek IP blocked → bot turant doosri IP (ZERO wait).'),
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
      `<b>Saare added Firebase hamesha ACTIVE hain</b> — disable/switch-off`,
      `nahi hota. Koi source sirf <b>Delete</b> karne par hi hatega.`,
      `Batch ek waqt me ek DB ko current rakhta hai taaki number ka OTP`,
      `usi DB se mile; woh khali/error/exhaust ho to agli <b>ACTIVE</b> DB`,
      `isi batch me auto-try hoti hai.`,
      ``,
      `Total: <b>${list.length} ACTIVE</b> sources · Page <b>${page + 1}/${totalPages}</b>`,
      list.length ? '' : sub('Abhi koi Firebase add nahi — Delete All ke baad aisa hota hai. Add Firebase se naya DB daalo.'),
      primary ? `⭐ First-try: <b>${esc(primary.name)}</b> (baaki sab bhi ACTIVE)` : '⭐ First-try: —',
      health ? `🩺 Live <b>${health.live}</b> · untried <b>${health.neverTried}</b> · quarantine <b>${health.quarantined}</b> <i>(dead DB 30 min peeche)</i>` : '',
      ``,
      ...pageItems.map((s, i) =>
        `${start + i + 1}. ✅ <b>${esc(s.name)}</b> (ACTIVE)${s.primary ? ' ⭐' : ''} — <code>${esc(s.url.replace('https://', ''))}</code>${s.auth ? ' 🔑' : ''}`
      ),
      ``,
      sub('Source tap karke: first-try / verify / delete. Disable option nahi — har added Firebase ACTIVE rehta hai.'),
    ].join('\n')),
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
async function deliverSessionJson(chatId, { phone, accountKey, kind, account, note = '' } = {}) {
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

  const exportData = getSessionExportJson(accountKey, account);
  if (!exportData) {
    await bot.telegram.sendMessage(chatId,
      `${baseCaption}\n\n<i>(JSON export nahi mil paya — session bot DB me saved hai)</i>`,
      { parse_mode: 'HTML' }).catch(() => {});
    return false;
  }
  const addressLine = exportData.remoteAddressStatus === 'added' && exportData.remoteAddressId
    ? `🏠 Address: ${mono(`ADDED · ${exportData.remoteAddressId}`)}`
    : exportData.remoteAddressStatus
      ? `🏠 Address: ${mono('NOT ADDED')} — wajah JSON me hai`
      : '';
  const caption = [
    baseCaption,
    sessionLifeLine(exportData),
    addressLine,
    note ? esc(String(note).slice(0, 220)) : '',
  ].filter(Boolean).join('\n');

  const jsonText = JSON.stringify(exportData, null, 2);
  const filename = `${phone || accountKey || 'session'}.json`;
  let lastDocumentError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await bot.telegram.sendDocument(chatId,
        { source: Buffer.from(jsonText, 'utf8'), filename },
        { caption, parse_mode: 'HTML' });
      return true;
    } catch (e) {
      lastDocumentError = e;
      console.warn(`[FreshBot] session file send (try ${attempt}/3):`, e?.message);
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 800));
    }
  }

  const chunks = splitJsonForTelegram(jsonText);
  let sentChunks = 0;
  for (let i = 0; i < chunks.length; i++) {
    const heading = i === 0
      ? `${caption}\n\n<i>Document send fail (${esc(String(lastDocumentError?.message || 'unknown error').slice(0, 160))}) — JSON neeche hissa ${i + 1}/${chunks.length} me bhej raha hoon.</i>`
      : `<b>${esc(filename)}</b> — JSON hissa ${i + 1}/${chunks.length}`;
    const sent = await bot.telegram.sendMessage(
      chatId,
      `${heading}\n\n<pre>${esc(chunks[i])}</pre>`,
      { parse_mode: 'HTML' }
    ).catch((e) => console.warn(`[FreshBot] session JSON chunk ${i + 1}/${chunks.length}:`, e?.message));
    if (sent) sentChunks++;
  }
  return sentChunks === chunks.length;
}

// ---------------------------------------------------------------------------
// 🚀 START → source chuno
// Owner ka rule: START dabane par poochho — Hermes bot, HardXotp bot, ya
// Firebase. Isi screen par "Delete All Firebase" bhi hai taaki purani 400+
// list ek tap me saaf ho jaye.
// ---------------------------------------------------------------------------
function otpBotChoiceRows() {
  const status = telegramProviderStatus();
  const fbCount = (() => { try { return sources.listSources().length; } catch { return 0; } })();
  const ready = status.configured ? '✅' : '⚙️';
  const activeProfile = bs.getSetting('otpBotProfile');
  return [
    [{
      text: `${ready} 📨 Hermes bot${activeProfile === 'hermes' ? ' ✓' : ''}`,
      callback_data: 'ap_start_go_hermes',
      style: 'success',
    }],
    [{
      text: `${ready} 🔐 HardXotp bot${activeProfile === 'chauhan' ? ' ✓' : ''}`,
      callback_data: 'ap_start_go_chauhan',
      style: 'success',
    }],
    [{ text: `🔥 Firebase (${fbCount})`, callback_data: 'ap_start_go_firebase', style: 'primary' }],
    [{ text: '🗑 Delete All Firebase', callback_data: 'ap_src_delete_all', style: 'danger' }],
    [{ text: '↩️ Back', callback_data: 'ap_home' }],
  ];
}

function startSourceCard() {
  const status = telegramProviderStatus();
  const fbCount = (() => { try { return sources.listSources().length; } catch { return 0; } })();
  const hermes = otpBotProfiles.getOtpBotProfile('hermes');
  const chauhan = otpBotProfiles.getOtpBotProfile('chauhan');
  return section('🚀 Batch Kahan Se Chalega?', [
    `${status.configured ? '✅' : '⚙️'} <b>📨 Hermes bot</b> — <code>@${esc(hermes.username)}</code>`,
    sub(`NEW NUMBER → otp → wait → REFRESH`),
    '',
    `${status.configured ? '✅' : '⚙️'} <b>🔐 HardXotp bot</b> — <code>@${esc(chauhan.username)}</code>`,
    sub(`GET NUMBERS → assigned number → otp khud aata hai → VIEW MESSAGES`),
    '',
    `${fbCount ? '✅' : '⚙️'} <b>🔥 Firebase</b> — ${fbCount} ACTIVE source`,
    sub('Pool/device scan + SMS inbox'),
    '',
    `⏱ OTP wait ${bs.fmtSetting('telegramOtpTimeoutMs')} · OTP na aaye to number skip`,
    sub('Jo yahan chunoge wahi is batch ka source lock hoga. Telegram bots ke liye wahi spare account use hota hai.'),
  ].join('\n'));
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
  const chosen = String(opts.source || '').trim().toLowerCase();
  if (chosen === 'hermes' || chosen === 'chauhan') {
    try { bs.setSetting('otpBotProfile', chosen); } catch {}
    try { bs.setSetting('telegramOtpMode', true); } catch {}
  } else if (chosen === 'firebase') {
    try { bs.setSetting('telegramOtpMode', false); } catch {}
  }

  if (isTelegramNumberSource()) {
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
  } else if (!isFirebaseConfigured()) {
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
    async sendSession(payload = {}) {
      await deliverSessionJson(ctx.chat?.id || fallback.chatId, payload);
    },
  };

  // START picker ne jo chuna woh env NUMBER_SOURCE ko bhi override karta hai
  // (user ka explicit choice). Khali ho to purana resolve logic chalta hai.
  const explicitMode = (chosen === 'hermes' || chosen === 'chauhan')
    ? 'telegram'
    : (chosen === 'firebase' ? 'firebase' : '');
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

bot.help((ctx) => ctx.reply('/start — menu · /status — current batch · /diag — kya toota hai, check karo · /session <number> — saved session refresh karke latest JSON bhejo', { parse_mode: 'HTML' }).catch(() => {}));

// ---------------------------------------------------------------------------
// 🩺 /diag — "bot work nahi kar raha" ka jawab ek tap me.
// Firebase reachable? Pool me numbers? Chrome mila? WAF token? Sab check.
// ---------------------------------------------------------------------------
async function diagCard() {
  const lines = [];
  lines.push(field('Node', process.version));
  lines.push(field('⏰ Uptime', fmtDuration(Date.now() - runtimeHealth.bootAt)));
  {
    const ka = keepAliveHandle?.getState?.() || { enabled: false, reason: 'not-started' };
    const lastOk = ka.lastSuccessAt
      ? `${fmtDuration(Date.now() - ka.lastSuccessAt)} pehle OK`
      : 'abhi pehla ping baqi';
    lines.push(field('❤️ Keep-alive', ka.enabled
      ? `✅ ON · har ${Math.round((ka.intervalMs || 300000) / 60000)} min · ${lastOk}${ka.lastError ? ` · last error: ${esc(String(ka.lastError).slice(0, 80))}` : ''}`
      : `❌ OFF (${esc(ka.reason || 'unknown')}) — KEEP_ALIVE_URL=https://<service>.onrender.com/health set karo`));
  }
  lines.push(field('📡 FresBot Bot API', runtimeHealth.telegramReady
    ? `✅ ready${runtimeHealth.telegramUsername ? ` (@${esc(runtimeHealth.telegramUsername)})` : ''}`
    : `❌ ready nahi${runtimeHealth.lastTelegramError ? ` — ${esc(String(runtimeHealth.lastTelegramError).slice(0, 100))}` : ''}`));
  // Chrome (WAF solver ke liye zaroori)
  try {
    const c = getChromeStatus();
    lines.push(field('🌐 Chrome', c.found ? `✅ mila — <code>${esc(c.path)}</code>${c.headless ? ' (headless)' : ''}` : '❌ NAHI mila — Chrome install karo ya .env me PUPPETEER_EXECUTABLE_PATH do'));
  } catch { lines.push(field('🌐 Chrome', '—')); }
  // WAF token
  try {
    wafPool.loadFromDb?.(); // db.json me saved token bhi dikhe (warna hamesha "nahi hai" lagega)
    const w = wafPool.getSummary();
    lines.push(field('🛡 WAF token', w.hasToken ? `✅ hai (age ${w.tokenAgeMin}m, ${esc(w.source)})` : (w.stale ? '⚠️ purana/expired — batch start par naya banega (Chrome chahiye)' : '— abhi nahi (batch start par banega)')));
  } catch { lines.push(field('🛡 WAF token', '—')); }
  const diagTelegramMode = isTelegramNumberSource();
  if (diagTelegramMode) {
    // Telegram-only mode me Firebase ko "toota hua" mat dikhao — number aur
    // OTP dono spare Telegram account → Hermes se aa rahe hain.
    const status = telegramProviderStatus();
    const runSnap = getAutopilotSnapshot();
    const botName = String(status.botUsername || 'HermeshuOTPROBOT').replace(/^@+/, '');
    lines.push(field('📨 Number source', `Telegram only — Hermes @${esc(botName)}`));
    lines.push(field('👤 Telegram account', status.configured
      ? `✅ configured${status.me ? ` — ${esc(status.me)}` : ''} · API ${status.apiIdPresent && status.apiHashPresent ? '✅' : '❌'} · session ${status.sessionPresent ? '✅' : '❌'}`
      : `❌ setup pending${status.missing?.length ? ` — missing ${esc(status.missing.join(', '))}` : ''} · Settings → Add Telegram Account`));
    lines.push(field('⏳ Hermes timing', `OTP wait ${bs.fmtSetting('telegramOtpTimeoutMs')} · REFRESH har ${bs.fmtSetting('telegramOtpRefreshMs')}`));

    if (runSnap.running) {
      lines.push(field('📨 Hermes', `● batch chal raha hai — ${esc(formatNumberSourceStatus(runSnap))}${status.currentPhone ? ` · current ${esc(status.currentPhone)}` : ''}`));
      lines.push(field('📱 Number pool', esc(formatPoolStatus(runSnap))));
    } else if (telegramLoginFlow || status.loginInProgress) {
      lines.push(field('📨 Hermes', `⏳ Telegram login chal raha hai${telegramLoginFlow ? ` — ${esc(telegramLoginStageLabel(telegramLoginFlow.stage))}` : ''}`));
      lines.push(field('📱 Number pool', 'login complete hone ke baad FIND NUMBER available hoga'));
    } else if (!status.configured) {
      lines.push(field('📨 Hermes', '❌ pehle Add Telegram Account karo'));
      lines.push(field('📱 Number pool', 'Telegram-only mode me Firebase pool use nahi hota'));
    } else {
      try {
        const t0 = Date.now();
        const v = await telegramOtp.verifyTelegramOtpConnection({ sendStartIfEmpty: true });
        lines.push(field('📨 Hermes', `✅ reachable ${Date.now() - t0}ms — @${esc(String(v.botUsername || botName).replace(/^@+/, ''))}${v.me ? ` · ${esc(v.me)}` : ''}`));
        lines.push(field('📱 Number pool', v.currentPhone
          ? `current Hermes number <code>${esc(v.currentPhone)}</code>`
          : 'koi current number card nahi — batch FIND NUMBER se shuru karega'));
        lines.push(field('🔘 Hermes buttons', v.buttons?.length ? esc(v.buttons.slice(0, 10).join(' · ')) : 'koi button nahi mila'));
      } catch (e) {
        lines.push(field('📨 Hermes', `❌ ${esc(String(e?.message || e).slice(0, 140))}`));
        lines.push(field('📱 Number pool', 'Settings → 🧪 Test Hermes se dobara check karo'));
      }
    }
    lines.push(field('📟 Device gate', 'Telegram mode me Firebase last-seen gate bypass — Hermes STATUS: ACTIVE card hi source hai'));
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
          ? `✅ First-try ACTIVE source: ${pool.length} numbers · devices: ONLINE ${deviceStates.online} · status-unknown ${deviceStates.unknown} · offline ${deviceStates.offline}`
          : `⚠️ First-try ACTIVE source: 0 numbers mile — clients/ node khali ya paths galat${fallbackCount ? `; batch me baaki ${fallbackCount} ACTIVE source(s) auto-try honge` : ''}`));
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
      lines.push(field('📟 Device gate', `sirf wahi devices jinki last activity ≤${Math.round(wMs / 1000)}s purani ho (env PREMIUM_DEVICE_ACTIVE_WINDOW_MS se badal sakta hai)`));
    }
  }
  // Proxies
  try {
    const ps = proxyPool.proxySummary();
    lines.push(field('🔀 Proxies', ps.enabled ? `✅ ${ps.enabledCount}/${ps.total} ON` : '⚠️ OFF (ek hi IP — rukna pad sakta hai)'));
  } catch { lines.push(field('🔀 Proxies', '—')); }
  const snap = getAutopilotSnapshot();
  lines.push(field('▶️ Batch', snap.running ? `● RUNNING — ${snap.fresh}/${snap.target} fresh` : (snap.finishedAt ? `⏹ last: ${snap.fresh} fresh · ${esc(snap.stopReason || 'done')}${snap.lastError ? ` · last error: ${esc(String(snap.lastError).slice(0, 100))}` : ''}` : 'ready')));
  return section('🩺 Diagnose — kya toota hai?', [
    ...lines,
    '',
    sub('Jahan ❌ hai wahi problem hai. Sab ✅ ho aur phir bhi batch fail ho to console logs dekho — har number ka exact reason wahan likhta hai.'),
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
bot.action(/^ap_start_go_(hermes|chauhan|firebase)$/, async (ctx) => {
  await launchBatch(ctx, { source: ctx.match[1] });
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
    starting: 'login shuru ho raha hai',
    api_id: 'Telegram API ID ka wait hai',
    api_hash: 'Telegram API hash ka wait hai',
    connecting: 'Telegram se connect ho raha hai',
    phone: 'spare-account phone number ka wait hai',
    code: 'Telegram login code ka wait hai',
    password: '2FA password ka wait hai',
    name: 'naaye Telegram account ke naam ka wait hai',
    verifying: 'Hermes connection test ho raha hai',
  }[stage] || 'login chal raha hai';
}

function telegramLoginRows() {
  return [
    [{ text: '✖️ Login Cancel', callback_data: 'ap_telegram_login_cancel', style: 'danger' }],
    [{ text: '⚙️ Settings', callback_data: 'ap_settings', style: 'primary' }],
  ];
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
    await sendTelegramLoginMessage(flow, section('⚠️ Input sahi nahi hai', [
      esc(checked?.error || 'Dobara sahi value bhejo.'),
      ``,
      sub('Flow abhi chal raha hai — sahi value dubara bhejo, ya Cancel dabao.'),
    ].join('\n')));
  }
}

function telegramAccountCard() {
  const status = telegramProviderStatus();
  const botName = String(status.botUsername || 'HermeshuOTPROBOT').replace(/^@+/, '');
  const flow = telegramLoginFlow;
  return section('👤 Telegram Spare Account', [
    field('Hermes bot', `@${esc(botName)}`),
    field('API ID', status.apiIdPresent ? '✅ saved hai' : '❌ missing'),
    field('API hash', status.apiHashPresent ? '✅ saved hai' : '❌ missing'),
    field('Account session', status.sessionPresent ? '✅ saved hai' : '❌ login nahi hai'),
    status.me ? field('Account', esc(status.me)) : '',
    flow ? field('Login', `⏳ ${esc(telegramLoginStageLabel(flow.stage))}`) : '',
    status.loginInProgress && !flow ? field('Login', '⏳ provider me login chal raha hai') : '',
    ``,
    sub('Sirf spare/faltu Telegram account use karein. Session kabhi chat me nahi dikhegi.'),
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
        section('👤 Add Telegram Account — Step 1/2', [
          `Render/env me <b>Telegram API ID</b> saved nahi hai.`,
          ``,
          `<code>my.telegram.org</code> → <b>API development tools</b> se spare account ki API app ka <b>numeric API ID</b> yahan bhejo.`,
          ``,
          sub('Input milte hi message delete karne ki koshish hogi. Sirf spare account use karein.'),
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
        section('👤 Add Telegram Account — Step 2/2', [
          `Ab usi API app ka <b>API hash</b> bhejo.`,
          ``,
          sub('Hash ko chat me dobara nahi dikhaya jayega; input message delete karne ki koshish hogi.'),
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
      `Spare account se Telegram connect kar raha hoon…`,
      `Pehle phone number, phir Telegram ka login code lagega.`,
      ``,
      sub('Har code/password message milte hi delete karne ki koshish hogi.'),
    ].join('\n')));

    const result = await telegramOtp.loginTelegramUserInteractive({
      phoneNumber: async () => {
        const phone = await askTelegramLoginValue(
          flow,
          'phone',
          section('📱 Spare Telegram Number', [
            `Spare/faltu Telegram account ka phone number bhejo.`,
            `India ke liye 10-digit chalega; dusre country ke liye <code>+countrycode number</code> bhejo.`,
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
            `Telegram ne code bhej diya hai (${esc(delivery)}).`,
            `Woh code yahan bhejo — milte hi message delete karne ki koshish hogi.`,
            ``,
            sub('Ye Hermeshu ka SMS OTP nahi hai; ye spare Telegram account ka login code hai.'),
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
          `Is spare account par <b>two-step verification</b> ON hai.`,
          hint ? `Hint: <i>${esc(String(hint).slice(0, 80))}</i>` : '',
          `2FA password yahan bhejo — milte hi message delete karne ki koshish hogi.`,
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
          `Is number par Telegram account registered nahi lagta.`,
          `Naye spare account ke liye display name bhejo (jaise <code>Spare Account</code>).`,
          ``,
          sub('Agar naya account nahi banana, Login Cancel dabao.'),
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
      ``,
      sub('Ab START BATCH Hermes se FIND NUMBER karega; Firebase fallback use nahi hoga.'),
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
    `Spare/faltu Telegram account ka login yahin private chat me hoga.`,
    status.sessionPresent ? `⚠️ Ek saved account pehle se hai — naya login successful hone par wahi replace hoga.` : '',
    `Session chat me kabhi nahi dikhegi; main account mat use karo.`,
    ``,
    sub('Agle prompt me jo manga jaye wahi bhejo. Beech me rokne ke liye Login Cancel dabao.'),
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
// 🤖 Kaunsa OTP bot — Hermes ya HardXotp (dono ek hi spare session se).
bot.action('ap_pick_otp_bot', async (ctx) => {
  if (!(await gate(ctx))) return;
  if (isAutopilotRunning()) {
    await ctx.answerCbQuery('⏳ Batch chal raha hai — pehle STOP karo.', { show_alert: true }).catch(() => {});
    return;
  }
  await ctx.answerCbQuery().catch(() => {});
  const current = bs.getSetting('otpBotProfile');
  const hermes = otpBotProfiles.getOtpBotProfile('hermes');
  const chauhan = otpBotProfiles.getOtpBotProfile('chauhan');
  const text = section('🤖 OTP Bot Chuno', [
    `Abhi: <b>${esc(bs.fmtSetting('otpBotProfile'))}</b>`,
    ``,
    `${current === 'hermes' ? '✅' : '▫️'} <b>📨 ${esc(hermes.label)}</b> — <code>@${esc(hermes.username)}</code>`,
    sub(hermes.hint),
    '',
    `${current === 'chauhan' ? '✅' : '▫️'} <b>🔐 ${esc(chauhan.label)}</b> — <code>@${esc(chauhan.username)}</code>`,
    sub(chauhan.hint),
    '',
    sub('Dono same spare Telegram account/session se chalte hain; sirf buttons badalte hain.'),
  ].join('\n'));
  const rows = [
    [{ text: `${current === 'hermes' ? '✅ ' : ''}📨 Hermes`, callback_data: 'ap_set_otp_bot_hermes', style: 'success' }],
    [{ text: `${current === 'chauhan' ? '✅ ' : ''}🔐 HardXotp`, callback_data: 'ap_set_otp_bot_chauhan', style: 'success' }],
    [{ text: '↩️ Settings', callback_data: 'ap_settings', style: 'primary' }],
  ];
  await ctx.editMessageText(text, kb(rows))
    .catch(async () => { await ctx.reply(text, kb(rows)).catch(() => {}); });
});

bot.action(/^ap_set_otp_bot_(hermes|chauhan)$/, async (ctx) => {
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
      [{ text: '🔁 Dusra Spare Account Login Karo', callback_data: 'ap_telegram_login_start', style: 'success' }],
      [{ text: '🧪 Test Hermes', callback_data: 'ap_test_hermes' }, { text: '🗑 Remove Telegram', callback_data: 'ap_remove_telegram', style: 'danger' }],
      [{ text: '↩️ Settings', callback_data: 'ap_settings', style: 'primary' }],
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
      sub('Ab START BATCH isi account se FIND NUMBER dabayega.'),
    ].filter(Boolean).join('\n')), settingsRows());
  } catch (e) {
    await editOrSend(ctx, section('❌ Hermes Test Fail', [
      esc(shortTelegramLoginError(e)),
      ``,
      sub('Session expire ho to Add Telegram Account se dobara login karo; API ID/hash galat ho to setup check karo.'),
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
    `Saved spare-account session is bot se hata di jayegi aur Hermes mode bhi OFF ho jayega.`,
    `Telegram account khud delete nahi hoga.`,
    ``,
    sub('Agar session Render env TELEGRAM_SESSION me bhi rakhi hai, restart ke baad wahan se wapas aa sakti hai — env se bhi हटाना hoga.'),
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
bot.on('text', async (ctx) => {
  const uid = String(ctx.from?.id);
  if (!isOwner(ctx.from?.id)) return;
  const st = pending.get(uid);
  if (!st) return;
  const rawMessageText = String(ctx.message?.text || '');
  const txt = rawMessageText.trim();

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
async function preflight() {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const me = await bot.telegram.getMe();
      runtimeHealth.telegramUsername = me.username || '';
      runtimeHealth.telegramApiOkAt = Date.now();
      runtimeHealth.telegramApiFailures = 0;
      runtimeHealth.lastTelegramError = '';
      console.log(`[FreshBot] Telegram ✅ @${me.username} (id ${me.id})`);
      // Agar is token par kahin webhook laga ho (purana server, ya token
      // leak hone par kisi aur ne lagaya ho) to polling 409 marega aur bot
      // kabhi chalega hi nahi — isliye shuru me webhook saaf kar do.
      await bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
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
      const me = await Promise.race([
        bot.telegram.getMe(),
        sleepMs(15_000).then(() => { throw new Error('Telegram getMe timeout (15s)'); }),
      ]);
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
