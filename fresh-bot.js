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
//   • 🔥 Firebase Sources — multiple DB add/remove/enable/switch (bot UI se)
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
  getAutopilotSnapshot,
  isAutopilotRunning,
  formatPoolStatus,
  formatFirebaseSourceStatus,
  poolExhaustedReasonText,
} = await import('./autopilot-engine.js');
const { isFirebaseConfigured, firebaseSetupHintLines, listPoolNumbers } = await import('./firebase-numbers.js');
const sources = await import('./firebase-sources.js');
const bs = await import('./bot-settings.js');
const proxyPool = await import('./proxy-pool.js');
const { getChromeStatus } = await import('./swiggy-bridge.js');
const wafPool = await import('./waf-pool.js');
const { esc, section, sub, field } = await import('./rich-text.js');
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

function activeSourceLine() {
  try {
    const src = sources.getActiveSource();
    if (!src) return field('🔥 Firebase', '— (koi source nahi)');
    const list = sources.listSources();
    const enabledCount = list.filter((s) => s.enabled).length;
    return field('🔥 Firebase', `${esc(src.name)}  ·  ${enabledCount} enabled source${enabledCount === 1 ? '' : 's'} (batch me auto-fallback)`);
  } catch {
    return field('🔥 Firebase', '—');
  }
}

function startCard() {
  const snap = getAutopilotSnapshot();
  const target = bs.getSetting('target');
  const maxMin = bs.getSetting('maxMinutes');
  return section('🆕 Swiggy Fresh Bot', [
    `Bas <b>START</b> dabao — phone pe chhod ke aa jao,`,
    `baaki sab ye khud karega:`,
    ``,
    `1️⃣ Firebase pool se number (online pehle)`,
    `2️⃣ Swiggy OTP → <b>live inbox poll</b> → OTP khud padh kar paste`,
    `3️⃣ 🆕 naya = register · ♻️ purana = delete → fresh login`,
    `4️⃣ charges/order/wallet block = <b>SKIP</b> · WAF = <b>auto token-refresh + retry</b>`,
    ``,
    activeSourceLine(),
    field('🎯 Target', `${target} fresh sessions`),
    field('⏱ Max time', `${maxMin} minutes`),
    snap.finishedAt
      ? field('Last run', `${snap.fresh} fresh · ${fmtDuration(snap.elapsedMs)} · ${esc(snap.stopReason || 'done')}`)
      : '',
    ``,
    isAutopilotRunning()
      ? `● <b>RUNNING</b> — STOP/STATUS niche.`
      : sub('Start karke chhod do — ~1 hr baad aakar summary dekh lena.'),
  ].filter(Boolean).join('\n'));
}

function runningCard(snap, stageText = '') {
  return section('● Autopilot RUNNING', [
    field('Runtime', fmtDuration(snap.elapsedMs)),
    field('Target', String(snap.target)),
    field('⚡ Parallel lanes', `${snap.activeWorkers || 0}/${snap.concurrency || 1} active`),
    stageText || '',
    ``,
    field('Processed', String(snap.processed)),
    field('✅ Fresh', `${snap.fresh}  (naye: ${snap.freshNew} · delete+fresh: ${snap.freshAfterDelete})`),
    field('⚠️ Skipped', `${snap.skipped} · deferred: ${snap.deferred} · 7-day cooldown: ${snap.cooldownSkips || 0} · 📴 stale devices: ${snap.staleSkips || 0}`),
    field('× Failed', `${snap.failed} · rate-limit: ${snap.rateStrikes}`),
    field('🔥 Firebase', formatFirebaseSourceStatus(snap)),
    field('Pool', formatPoolStatus(snap)),
    (snap.scanning || snap.scanChecked)
      ? field('🔎 Device scan', `pass ${snap.scanPass || 1}: ${snap.scanUniqueChecked || 0}/${snap.scanTotalDevices || 0} unique · probes ${snap.scanTotalProbes || snap.scanChecked || 0} · window ≤${fmtDuration(snap.scanWindowMs || 0)} · ${snap.scanBestActivityMs ? `scan ke waqt best SMS ~${fmtDuration(snap.scanBestActivityAgeMs || Math.max(0, Date.now() - snap.scanBestActivityMs))} purani · ` : ''}${snap.scanFresh || 0} fresh ready${snap.scanning ? ' · scanning…' : ''}`)
      : '',
    (snap.activeNumbers?.length)
      ? `📍 <b>Abhi ${snap.activeNumbers.length} lanes:</b>\n${snap.activeNumbers.slice(0, 10).map((n) => `• <code>${esc(n.phone)}</code> · lane ${n.laneId || '?'} · ${esc(n.proxyLabel || 'direct')} (${fmtDuration(Date.now() - n.startedAt)})`).join('\n')}`
      : (snap.current
        ? `📍 <b>Abhi:</b> <code>${esc(snap.current.phone)}</code> (${fmtDuration(Date.now() - snap.current.startedAt)})`
        : (snap.scanning ? '🔎 Zinda devices dhoondh raha hoon (parallel scan)…' : '')),
    snap.lastError ? field('Last error', snap.lastError) : '',
  ].filter(Boolean).join('\n'));
}

function summaryCard(snap) {
  const freshList = (snap.freshAccounts || []).slice(-12)
    .map((a) => `• <code>${esc(a.phone)}</code> → <b>${esc(a.accountKey)}</b>`)
    .join('\n');
  return section('📊 Batch — Final Summary', [
    field('Status', snap.running ? '● RUNNING' : `⏹ ${esc(snap.stopReason || 'stopped')}`),
    field('Runtime', fmtDuration(snap.elapsedMs)),
    ``,
    field('Processed', String(snap.processed)),
    field('✅ Fresh', `${snap.fresh}  (naye: ${snap.freshNew} · delete+fresh: ${snap.freshAfterDelete})`),
    field('⚠️ Skipped', `${snap.skipped} · deferred: ${snap.deferred} · 7-day cooldown: ${snap.cooldownSkips || 0} · 📴 stale devices: ${snap.staleSkips || 0}`),
    field('× Failed', `${snap.failed} · rate-limit: ${snap.rateStrikes}`),
    field('🔥 Firebase', formatFirebaseSourceStatus(snap)),
    field('Pool', formatPoolStatus(snap)),
    snap.stopReason === 'pool-exhausted' ? poolExhaustedReasonText(snap) : '',
    snap.scanChecked ? field('🔎 Device scan', `pass ${snap.scanPass || 1}: ${snap.scanUniqueChecked || 0}/${snap.scanTotalDevices || 0} unique · total probes ${snap.scanTotalProbes || snap.scanChecked}`) : '',
    snap.lastError ? field('Last error', snap.lastError) : '',
    freshList ? `` : '',
    freshList ? `▤ <b>Latest fresh sessions:</b>` : '',
    freshList || sub('Abhi tak koi fresh session nahi bana.'),
    ``,
    sub('Har fresh session ka JSON chat me file bana kar bhej diya gaya hai (data/db.json + cloud vault me bhi saved).'),
  ].filter((x) => x !== '' && x !== false).join('\n'));
}

const startRows = () => [
  [{ text: '▶️ START BATCH', callback_data: 'ap_start', style: 'success' }],
  [{ text: '📊 Status', callback_data: 'ap_status' }, { text: '⚙️ Settings', callback_data: 'ap_settings' }],
];
const stopRows = () => [
  [{ text: '⏹ STOP BATCH', callback_data: 'ap_stop', style: 'danger' }],
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
    sub('Sab kuch yahin se badlo — .env chhedni ki zaroorat nahi.'),
  ].join('\n'));
}

const settingsRows = () => [
  [{ text: '🔥 Firebase Sources', callback_data: 'ap_sources', style: 'primary' }],
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
  const active = list.find((s) => s.active);

  const rows = pageItems.map((s) => [
    {
      text: `${s.active ? '✅' : (s.enabled ? '▫️' : '🚫')} ${s.name}${s.active ? ' (ACTIVE)' : ''}`,
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
  rows.push([{ text: '➕ Add Firebase', callback_data: 'ap_src_add', style: 'success' }]);
  rows.push([{ text: '↩️ Settings', callback_data: 'ap_settings', style: 'primary' }]);

  return {
    text: section('🔥 Firebase Sources', [
      `Aap jitne chahein Firebase DB add kar sakte hain — batch pehle`,
      `<b>ACTIVE</b> source use karega. Woh khali, error ya exhaust ho to`,
      `baaki <b>enabled</b> sources isi batch me ek-ek karke auto-try honge.`,
      ``,
      `Total: <b>${list.length}</b> sources · Page <b>${page + 1}/${totalPages}</b>`,
      active ? `ACTIVE: <b>${esc(active.name)}</b>` : 'ACTIVE: —',
      ``,
      ...pageItems.map((s, i) =>
        `${start + i + 1}. ${s.active ? '✅' : (s.enabled ? '▫️' : '🚫')} <b>${esc(s.name)}</b> — <code>${esc(s.url.replace('https://', ''))}</code>${s.auth ? ' 🔑' : ''}`
      ),
      ``,
      sub('Source tap karke: switch / verify / enable-disable / delete. Badi list ke liye Prev/Next use karein.'),
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
      `Status: ${s.enabled ? '▫️ enabled' : '🚫 disabled'}${s.active ? ' · <b>ACTIVE</b>' : ''}`,
      ``,
      sub('Verify = test ki DB reachable hai (shallow root read).'),
    ].join('\n')),
    rows: [
      [
        { text: '✅ Use this', callback_data: `ap_src_use_${s.id}`, style: 'success' },
        { text: s.enabled ? '🚫 Disable' : '▫️ Enable', callback_data: `ap_src_toggle_${s.id}` },
      ],
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

// Fresh JSON ki asal delivery — Autopilot ke instant send aur owner ke
// /session resend command dono yahi use karte hain. Document 3 baar try;
// phir bhi fail ho to poora JSON code-block hissoun me.
async function deliverSessionJson(chatId, { phone, accountKey, kind, account } = {}) {
  if (!chatId) return false;
  const typeText = kind === 'fresh_after_delete'
    ? '♻️ Delete + Fresh'
    : kind === 'resend'
      ? '↩️ Dobara Bheja'
      : '🆕 Naya Fresh';
  const caption = [
    `✅ <b>Fresh Session Ready</b> — ${typeText}`,
    `📱 <b>Number:</b> <code>${esc(phone || '')}</code>`,
    `👤 <b>Account:</b> <b>${esc(accountKey || '')}</b>`,
  ].join('\n');

  const exportData = getSessionExportJson(accountKey, account);
  if (!exportData) {
    await bot.telegram.sendMessage(chatId,
      `${caption}\n\n<i>(JSON export nahi mil paya — session bot DB me saved hai)</i>`,
      { parse_mode: 'HTML' }).catch(() => {});
    return false;
  }

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

async function launchBatch(ctx) {
  // Pehle yahan owner-gate tha hi nahi — koi bhi START daba kar batch chala
  // sakta tha (bot username janna hi kaafi tha).
  if (!(await gate(ctx))) return;
  if (isAutopilotRunning()) {
    await ctx.answerCbQuery('Pehle se chal raha hai!').catch(() => {});
    return;
  }
  if (!isFirebaseConfigured()) {
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

  startAutopilot({
    userId: String(ctx.from.id),
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

bot.help((ctx) => ctx.reply('/start — menu · /status — current batch · /diag — kya toota hai, check karo · /session <number> — saved fresh JSON dobara bhejo', { parse_mode: 'HTML' }).catch(() => {}));

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
  lines.push(field('📡 Telegram', runtimeHealth.telegramReady
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
      lines.push(field('📱 Number pool', `● batch chal raha hai — ${esc(formatFirebaseSourceStatus(runSnap))}: ${esc(formatPoolStatus(runSnap))}`));
    } else {
      sources.applyActiveSource();
      const pool = await listPoolNumbers();
      const online = pool.filter((p) => p.online !== false).length;
      const fallbackCount = Math.max(0, sources.listRunSources().length - 1);
      lines.push(field('📱 Number pool', pool.length
        ? `✅ ACTIVE source: ${pool.length} numbers (${online} online)`
        : `⚠️ ACTIVE source: 0 numbers mile — clients/ node khali ya paths galat${fallbackCount ? `; batch me baaki ${fallbackCount} enabled source(s) auto-try honge` : ''}`));
    }
  } catch (e) {
    let fallbackNote = '';
    try {
      const fallbackCount = Math.max(0, sources.listRunSources().length - 1);
      if (fallbackCount) fallbackNote = ` · batch me baaki ${fallbackCount} enabled source(s) auto-try honge`;
    } catch {}
    lines.push(field('📱 Number pool', `❌ ACTIVE source: ${esc(String(e?.message || e).slice(0, 140))}${fallbackNote}`));
  }
  // Device last-seen gate
  {
    const w = Number(process.env.PREMIUM_DEVICE_ACTIVE_WINDOW_MS);
    const wMs = Number.isFinite(w) && w > 0 ? w : 60_000;
    lines.push(field('📟 Device gate', `sirf wahi devices jinki last activity ≤${Math.round(wMs / 1000)}s purani ho (env PREMIUM_DEVICE_ACTIVE_WINDOW_MS se badal sakta hai)`));
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

// Kisi fresh session ka JSON pehli baar send fail ho jaye to owner usi ko
// dobara manga sakta hai: /session 9876543210  ya  /session acc_9876543210
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
  const delivered = await deliverSessionJson(ctx.chat?.id, {
    phone,
    accountKey,
    kind: 'resend',
    account,
  });
  if (!delivered && getSessionExportJson(accountKey, account)) {
    await ctx.reply('⚠️ JSON phir bhi poora send nahi ho paya — thodi der baad /session dobara try karo.', { parse_mode: 'HTML' }).catch(() => {});
  }
});

bot.action('ap_start', launchBatch);
// Engine ke rows premium callback names bhi bhejta hai — same kaam, same handler
bot.action('prem_batch_start', launchBatch);

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
  await ctx.answerCbQuery(r.ok ? '✅ Active source badal diya.' : `❌ ${r.error}`, !r.ok && { show_alert: true }).catch(() => {});
  const { text, rows } = r.ok ? sourcesCard(sourcePageFor(ctx.match[1])) : sourceDetailCard(ctx.match[1]);
  await editOrSend(ctx, text, rows);
});

bot.action(/^ap_src_toggle_([a-f0-9-]{1,10})$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  if (await blockSourceChangeWhileRunning(ctx)) return;
  const r = sources.toggleSource(ctx.match[1]);
  await ctx.answerCbQuery(r.ok ? (r.enabled ? '▫️ Enabled' : '🚫 Disabled') : `❌ ${r.error}`, !r.ok && { show_alert: true }).catch(() => {});
  const { text, rows } = sourcesCard(sourcePageFor(ctx.match[1]));
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

// ➕ Add Firebase — bot URL (aur chahein to auth) text me maangta hai
bot.action('ap_src_add', async (ctx) => {
  if (!(await gate(ctx))) return;
  if (await blockSourceChangeWhileRunning(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  pending.set(String(ctx.from.id), { action: 'add_source' });
  await editOrSend(ctx, section('➕ Add Firebase', [
    `Ab <b>URL bhejo</b> (Realtime Database URL):`,
    `<code>https://xxxx-default-rtdb.firebaseio.com/</code>`,
    ``,
    `Auth lage to pipe ke saath:`,
    `<code>&lt;url&gt; | &lt;DB_AUTH_secret&gt;</code>`,
    ``,
    sub('Cancel karne ke liye /start dabao.'),
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
      want: 10,
      onProgress: ({ checked = 0, clean = 0, challenged = 0, total = 0 } = {}) => {
        const now = Date.now();
        if (finished || now - lastProgressAt < 10_000) return;
        lastProgressAt = now;
        progressPromise = editOrSend(ctx, section('🌐 Free Proxies Test Ho Rahi Hain', [
          `🧪 Parkhin: <b>${checked}${total ? `/${total}` : ''}</b>`,
          `✅ Clean mili: <b>${clean}</b>`,
          `🛡 Swiggy-reachable (WAF challenge): <b>${challenged}</b>`,
          '',
          sub('Clean 10 milte hi ruk jaunga; warna deadline tak best fallback bhi jama karunga.'),
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
// Text input — add-source URL / custom target (wait-state)
// ---------------------------------------------------------------------------
bot.on('text', async (ctx) => {
  const uid = String(ctx.from?.id);
  if (!isOwner(ctx.from?.id)) return;
  const st = pending.get(uid);
  if (!st) return;
  const txt = String(ctx.message?.text || '').trim();

  if (st.action === 'add_source') {
    pending.delete(uid);
    const [urlPart, authPart] = txt.split('|').map((x) => x.trim());
    const batchRunning = isAutopilotRunning();
    const r = sources.addSource(
      { url: urlPart, auth: authPart || '' },
      { activate: !batchRunning }
    );
    if (!r.ok) {
      await ctx.reply(`❌ ${r.error}`).catch(() => {});
      return;
    }
    if (!batchRunning) sources.applyActiveSource();
    const v = await sources.verifySource(r.source.id);
    const lines = [
      `✅ <b>${esc(r.source.name)}</b> add ho gaya${r.source.active ? ' aur <b>ACTIVE</b>' : ''}.`,
      ...(batchRunning ? ['⏳ Batch chal raha hai — ye source current OTP flow disturb kiye bina agle batch se lagega.'] : []),
      v.ok
        ? `🧪 Verify: reachable in ${v.ms}ms${v.topKeys?.length ? ` · keys: <code>${esc(v.topKeys.join(', '))}</code>` : ''}`
        : `⚠️ Verify fail: ${esc(v.error)} — URL/auth check kar le, tab bhi use kar sakte ho.`,
    ];
    await ctx.reply(section('🔥 Firebase Source Added', lines.join('\n')), kb([[{ text: '↩️ Sources', callback_data: 'ap_sources', style: 'primary' }]])).catch(() => {});
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

for (let attempt = 1; attempt <= 4; attempt++) {
  armLiveConfirm(attempt);
  try {
    await bot.launch({ dropPendingUpdates: true }, () => {
      console.log(`🔄 Telegram connect ho raha hai (attempt ${attempt}/4)…`);
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
    if (code === 409 && attempt < 4) {
      console.error(`[FreshBot] 409 Conflict (try ${attempt}/4) — doosri copy abhi band ho rahi hogi; webhook saaf karke 15s baad dobara…`);
      try { bot.stop('retry-409'); } catch {}
      await bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
      await sleepMs(15_000);
      continue;
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
