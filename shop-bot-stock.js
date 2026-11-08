// ===== 📦 SHOP BOT STOCK PUSH — @its_shop_bot =====
//
// Owner ka rule:
//   "JAISE 10 ID WORKER BOT PAR SEND KARDI TO IS BOT ME WO ID STOCK PAR BHI
//    ADD KARDE — MINIMUM 10 ID AND MAX BHI 10. JAISE HI COMPLETE HO WO IS BOT
//    PAR ADD STOCK KARTA JAYEGA. ZIP NAHI, JSON FILE KO BAS SEND KARDENA HAI."
//
// Matlab: worker bot jab bhi fresh session banaye (Swiggy JSON), wo session
// queue me jaata hai. Jab queue me **poora 10** ho jate hain to wahi 10 JSON
// files ek-ek karke (bina zip) spare Telegram account se `@its_shop_bot` ko
// documents ki tarah bhej di jaati hain — shop bot unhe khud stock me daal
// leta hai (Swiggy/Twing product).
//
//   • Batch size hamesha 10 (na 9, na 11) — `SHOP_BOT_STOCK_BATCH` se sirf
//     kam kiya ja sakta hai, zyada nahi.
//   • `.json` file hi jaati hai (zip nahi, text nahi).
//   • Fail ho to queue safe rehti hai — agle fresh session par dobara try.
//   • Switch OFF: `SHOP_BOT_STOCK_ENABLED=0`.

import { getDb, saveDb, getSessionExportJson } from './store.js';
import { withTelegramUserClient } from './telegram-otp-source.js';

// Owner ka number — 10 se kam nahi, 10 se zyada nahi.
export const SHOP_STOCK_BATCH_SIZE = 10;
export const SHOP_STOCK_DEFAULT_USERNAME = 'its_shop_bot';
// Shop bot ke product buttons: "Swiggy" / "Twing" wale product.
export const SHOP_PRODUCT_TEXT_RE = /swiggy|twing|twig/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

function normHandle(value = '') {
  return String(value || '').trim().replace(/^@+/, '').replace(/^https?:\/\/t\.me\//i, '');
}

function envInt(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// ---------------------------------------------------------------------------
// Config (pure — test se env object pass ho sakta hai)
// ---------------------------------------------------------------------------
export function shopBotConfig(env = process.env) {
  return {
    enabled: String(env?.SHOP_BOT_STOCK_ENABLED ?? '1').trim() !== '0',
    username: normHandle(env?.SHOP_BOT_USERNAME || SHOP_STOCK_DEFAULT_USERNAME) || SHOP_STOCK_DEFAULT_USERNAME,
    // Owner rule: minimum 10 aur maximum bhi 10 — env se ye badal nahi sakta.
    batchSize: SHOP_STOCK_BATCH_SIZE,
    autoPickProduct: String(env?.SHOP_BOT_PICK_PRODUCT ?? '1').trim() !== '0',
    sendGapMs: envInt(env?.SHOP_BOT_SEND_GAP_MS, 1_200, 300, 10_000),
    replyWaitMs: envInt(env?.SHOP_BOT_REPLY_WAIT_MS, 3_000, 500, 20_000),
    // Fail hone par bar-bar retry nahi — itna wait karke agla try.
    retryMs: envInt(env?.SHOP_BOT_RETRY_MS, 60_000, 5_000, 3_600_000),
    // Shop bot ke product buttons ka naam badla ho to yahan regex do.
    productPattern: shopProductPattern(env?.SHOP_BOT_PRODUCT_REGEX),
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (network nahi — tests inhe seedha check karte hain)
// ---------------------------------------------------------------------------
// Queue me se kitne poore batch bante hain, aur kitna bacha.
export function planStockBatches(items = [], batchSize = SHOP_STOCK_BATCH_SIZE, { force = false } = {}) {
  const list = Array.isArray(items) ? items : [];
  const size = Math.max(1, Math.min(SHOP_STOCK_BATCH_SIZE, Number(batchSize) || SHOP_STOCK_BATCH_SIZE));
  const full = Math.floor(list.length / size);
  const batches = [];
  for (let i = 0; i < full; i++) batches.push(list.slice(i * size, (i + 1) * size));
  const rest = list.slice(full * size);
  // force = owner ne khud "abhi bhejo" dabaya → adhoora batch bhi jayega.
  if (force && rest.length) batches.push(rest);
  return {
    batches,
    rest: force && rest.length ? [] : rest,
    readyCount: batches.reduce((sum, batch) => sum + batch.length, 0),
  };
}

// Sirf .json file stock me jaati hai (zip/text nahi).
export function isShopStockJsonName(name = '') {
  return /\.json$/i.test(String(name || '').trim());
}

// Stock file ka naam: acc_9876543210.json (shop bot ko phone se pehchan ho).
export function shopStockFileName(phone = '', accountKey = '') {
  const digits = String(phone || '').replace(/\D/g, '').slice(-10);
  const base = String(accountKey || '').trim() || (digits ? `acc_${digits}` : '');
  const safe = (base || 'account').replace(/[^\w.-]+/g, '_');
  return `${safe}.json`;
}

// Custom regex (env) galat ho to default par gir jao — koi crash nahi.
export function shopProductPattern(custom = '') {
  const raw = String(custom || '').trim();
  if (!raw) return SHOP_PRODUCT_TEXT_RE;
  try { return new RegExp(raw, 'i'); } catch { return SHOP_PRODUCT_TEXT_RE; }
}

export function isShopProductButton(text = '', pattern = SHOP_PRODUCT_TEXT_RE) {
  return pattern.test(String(text || ''));
}

export function pickShopProductButtons(buttons = [], pattern = SHOP_PRODUCT_TEXT_RE) {
  const seen = new Set();
  const out = [];
  for (const entry of Array.isArray(buttons) ? buttons : []) {
    const text = String(entry?.text || '').trim();
    if (!text || !isShopProductButton(text, pattern)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, button: entry.button || entry });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Queue (db.json → shopBotStock)
// ---------------------------------------------------------------------------
// ⚠️ getDb() har call par file se naya object deta hai. Isliye state ko EK hi
// db object par mutate karke USI ko saveDb karna padta hai — warna queue
// likhne ke baad purana data save ho jata tha (queue 1/10 par atak jati thi).
function stockState(db = getDb(), { create = true } = {}) {
  if (!db || typeof db !== 'object') {
    return { pending: [], sent: 0, lastSentAt: 0, lastError: '', lastBatchAt: 0, sentKeys: [] };
  }
  if (!db.shopBotStock || typeof db.shopBotStock !== 'object') {
    if (!create) return { pending: [], sent: 0, lastSentAt: 0, lastError: '', lastBatchAt: 0, sentKeys: [] };
    db.shopBotStock = { pending: [], sent: 0, lastSentAt: 0, lastError: '', lastBatchAt: 0, sentKeys: [] };
  }
  const s = db.shopBotStock;
  if (!Array.isArray(s.pending)) s.pending = [];
  if (!Array.isArray(s.sentKeys)) s.sentKeys = [];
  s.sent = Number(s.sent) || 0;
  s.sentKeys = s.sentKeys.slice(-400);
  return s;
}

export function shopStockStatus(env = process.env) {
  const cfg = shopBotConfig(env);
  const s = stockState(getDb(), { create: false });
  return {
    enabled: cfg.enabled,
    username: cfg.username,
    batchSize: cfg.batchSize,
    pending: s.pending.length,
    needed: Math.max(0, cfg.batchSize - s.pending.length),
    sent: s.sent,
    lastSentAt: Number(s.lastSentAt) || 0,
    lastBatchAt: Number(s.lastBatchAt) || 0,
    lastError: s.lastError || '',
  };
}

// Ek fresh session queue me daalo. Duplicate (wahi account dobara) skip.
export async function queueShopStockJson({
  phone = '',
  accountKey = '',
  json = null,
  name = '',
  report = null,
} = {}) {
  const cfg = shopBotConfig();
  if (!cfg.enabled) return { ok: false, kind: 'disabled', queued: false };

  let payload = json;
  if (payload == null && accountKey) {
    try { payload = getSessionExportJson(accountKey); } catch {}
  }
  if (!payload) return { ok: false, kind: 'no-json', queued: false };

  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  if (!text.trim()) return { ok: false, kind: 'no-json', queued: false };

  const key = String(accountKey || phone || '').trim();
  const db = getDb();
  const s = stockState(db);
  if (key && (s.sentKeys.includes(key) || s.pending.some((item) => item.key === key))) {
    return { ok: true, kind: 'already-queued', queued: false, pending: s.pending.length };
  }

  s.pending.push({
    key,
    phone: String(phone || '').replace(/\D/g, '').slice(-10),
    name: isShopStockJsonName(name) ? name : shopStockFileName(phone, accountKey),
    json: text,
    at: Date.now(),
  });
  saveDb(db);
  const pending = s.pending.length;
  console.log(`[ShopStock] ➕ queued ${key || phone} (${pending}/${cfg.batchSize})`);

  // 10 poore ho gaye → foran bhej do (owner: "jaise hi complete ho").
  // Fail hua ho to 60s se pehle dobara nahi (bar-bar error card na aaye).
  if (pending >= cfg.batchSize) {
    const sinceAttempt = Date.now() - (Number(s.lastAttemptAt) || 0);
    if (sinceAttempt < cfg.retryMs) {
      return { ok: true, kind: 'queued', queued: true, pending, waitingRetry: true };
    }
    const flushed = await flushShopStock({ report });
    if (!flushed.ok && report) {
      try {
        await report(
          `⚠️ <b>Shop Bot stock:</b> ${pending} JSON ready hain, par bhejne me dikkat — ` +
          `<code>${esc0(String(flushed.error || flushed.kind || 'fail').slice(0, 120))}</code>\n` +
          `<i>Queue safe hai; ${Math.round(cfg.retryMs / 1000)}s baad dobara try hoga (/shopstock → 📤 Abhi Bhejo).</i>`
        );
      } catch {}
    }
    return { ok: flushed.ok, kind: flushed.ok ? 'queued+flushed' : 'queued', queued: true, pending, flushed };
  }
  if (report) {
    try {
      await report(
        `📦 <b>Shop Bot stock:</b> <code>${pending}/${cfg.batchSize}</code> ` +
        `— ${cfg.batchSize - pending} aur aate hi <code>@${cfg.username}</code> ko JSON files jayengi.`
      );
    } catch {}
  }
  return { ok: true, kind: 'queued', queued: true, pending };
}

// ---------------------------------------------------------------------------
// Flush — 10 JSON files, ek-ek document (zip nahi)
// ---------------------------------------------------------------------------
let flushing = null;

export async function flushShopStock({ report = null, force = false, env = process.env } = {}) {
  const cfg = shopBotConfig(env);
  if (!cfg.enabled) return { ok: false, kind: 'disabled', sent: 0 };
  if (flushing) return { ok: false, kind: 'busy', sent: 0 };

  flushing = (async () => {
    const db = getDb();
    const s = stockState(db);
    s.lastAttemptAt = Date.now();
    saveDb(db);
    const plan = planStockBatches(s.pending, cfg.batchSize, { force });
    if (!plan.batches.length) {
      return { ok: true, kind: 'nothing', sent: 0, pending: s.pending.length };
    }

    let sent = 0;
    let picked = [];
    let lastError = '';
    for (const batch of plan.batches) {
      try {
        const res = await sendStockBatch(batch, cfg);
        if (!res.ok) {
          lastError = res.reason || res.kind || 'send-fail';
          break;
        }
        // Sirf bheji hui files queue se hatao (fail par queue safe).
        const sentKeys = new Set(batch.map((item) => item.key).filter(Boolean));
        s.pending = s.pending.filter((item) => !(sentKeys.size ? sentKeys.has(item.key) : batch.includes(item)));
        s.sent = Number(s.sent) + batch.length;
        s.lastSentAt = Date.now();
        s.lastBatchAt = Date.now();
        s.sentKeys = [...s.sentKeys, ...batch.map((item) => item.key).filter(Boolean)].slice(-400);
        s.lastError = '';
        saveDb(db);
        sent += batch.length;
        picked = picked.concat(res.picked || []);
        console.log(`[ShopStock] 📤 ${batch.length} JSON @${cfg.username} ko bheje (kul ${s.sent}).`);
        if (report) {
          try {
            await report(
              `📤 <b>Shop Bot stock update:</b> <code>${batch.length}</code> JSON files <code>@${esc0(cfg.username)}</code> ko bhej di` +
              `${res.picked?.length ? ` · product: ${res.picked.map((p) => esc0(p)).join(', ')}` : ''}\n` +
              `<i>Kul bheje: ${s.sent} · queue me bache: ${s.pending.length}</i>`
            );
          } catch {}
        }
      } catch (e) {
        lastError = String(e?.message || e).slice(0, 180);
        s.lastError = lastError;
        saveDb(db);
        console.warn(`[ShopStock] ❌ batch fail: ${lastError}`);
        break;
      }
    }

    return {
      ok: !lastError,
      kind: lastError ? 'partial' : 'sent',
      sent,
      picked,
      pending: s.pending.length,
      error: lastError,
    };
  })();

  try {
    return await flushing;
  } finally {
    flushing = null;
  }
}

function esc0(value = '') {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendStockBatch(batch, cfg) {
  return withTelegramUserClient(async ({ client }) => {
    const entity = await client.getEntity(`@${cfg.username}`);
    let index = 0;
    for (const item of batch) {
      index += 1;
      const buf = Buffer.from(item.json, 'utf8');
      // Teleproto: Buffer par `.name` ho to wahi file name jata hai.
      buf.name = item.name || shopStockFileName(item.phone, item.key);
      await client.sendFile(entity, { file: buf, forceDocument: true });
      console.log(`[ShopStock] 📎 ${index}/${batch.length} ${buf.name}`);
      if (index < batch.length) await sleep(cfg.sendGapMs);
    }

    if (!cfg.autoPickProduct) return { ok: true, picked: [] };

    // Shop bot product poochhta hai ("Swiggy" / "Twing") — wahi button dabao.
    await sleep(cfg.replyWaitMs);
    const picked = await pickProductButtons(client, entity, cfg.productPattern);
    return { ok: true, picked };
  });
}

async function pickProductButtons(client, entity, pattern = SHOP_PRODUCT_TEXT_RE) {
  const picked = [];
  try {
    const messages = await client.getMessages(entity, { limit: 8 });
    const list = Array.isArray(messages) ? messages : [...(messages || [])];
    const buttons = [];
    for (const message of list) {
      let rows;
      try { rows = message?.buttons; } catch {}
      if (!rows) {
        try { rows = typeof message?.getButtons === 'function' ? await message.getButtons() : null; } catch {}
      }
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        for (const button of (Array.isArray(row) ? row : [row])) {
          const text = String(button?.text || '').trim();
          if (text) buttons.push({ text, button });
        }
      }
      if (buttons.length) break; // sabse nayi screen hi maayne rakhti hai
    }
    for (const entry of pickShopProductButtons(buttons, pattern).slice(0, 2)) {
      try {
        await entry.button.click({});
        picked.push(entry.text);
        console.log(`[ShopStock] 🖱 product button: ${entry.text}`);
        await sleep(800);
      } catch (e) {
        console.warn(`[ShopStock] product click fail (${entry.text}):`, e?.message || e);
      }
    }
  } catch (e) {
    console.warn('[ShopStock] product scan fail:', e?.message || e);
  }
  return picked;
}
