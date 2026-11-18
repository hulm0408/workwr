// ============================================================================
// db-payload.js — Linked database ka payload + merge rules (pure, koi I/O nahi)
// ============================================================================
//
import { createHash } from 'node:crypto';
//
// KYUN ye file hai?
//   Bot ka DB `data/db.json` hai. Render free disk / GitHub Actions runner
//   par ye har restart/redeploy par MIT jata hai — accounts, settings,
//   number-ledger, Firebase source list — sab chala jata hai. Isi liye DB
//   ko ek DURABLE linked database (GitHub vault / Vercel KV) se bind karna
//   zaroori hai.
//
// SABSE IMPORTANT rule yahan hai:
//   mergeDbSnapshots() kabhi remote data ko DELETE nahi karta — sirf ADD
//   karta hai (tombstone ke alawa).
//
//   Pehle ka push sirf `premiumFlow.used` (ledger) merge karta tha. Accounts,
//   orders, sessionVault aur Firebase sources remote se BILKUL overwrite ho
//   jaate the. Iska matlab: ek fresh/empty db (naya deploy, disk nahi) jo
//   pehli baar push karta hai → remote ka poora DB WIPE. Yahi "data bahut
//   loss ho raha" ka asli reason tha.
//
//   Ab: har push remote ke saath MERGE hota hai.
//     • local me jo hai   → local jeeta (wo live/fresh hai)
//     • sirf remote me hai → remote bachta hai (add)
//     • local me delete   → tombstone jeeta (delete kabhi undo nahi hota)
//     • local me DOBARA   → re-login jeeta, tombstone hat jata hai
//
//   Is module ke functions pure hain — test karna aasan hai.
// ============================================================================

// Credential fields — inhe merge karte waqt "local empty, remote filled"
// case me remote ka value rakhna hai ( warna ek half-written account
// remote ke full account ko overwrite kar deta hai).
const CREDENTIAL_FIELDS = [
  'cookies',
  'tid',
  'token',
  'sid',
  'deviceId',
  '_session_tid',
  'jwtTid',
  'customerId',
];

// Firebase source ki list me duplicate check ke liye URL normalize.
function normUrl(raw) {
  return String(raw || '').trim().replace(/\/+$/, '').toLowerCase();
}

// 10-digit phone (91 prefix bhi chalta hai) — tombstone match ke liye.
export function normalizeDbPhone(raw = '') {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length > 10) return digits.slice(-10);
  return digits.length === 10 ? digits : '';
}

// Tombstone check — key se ya phone se.
export function isDbTombstoned(deleted = {}, key = '', phone = '') {
  if (!deleted || typeof deleted !== 'object') return false;
  if (key && deleted[key]) return true;
  if (phone && (deleted[`acc_${phone}`] || deleted[phone])) return true;
  return false;
}

// Ek entry ki "freshness" — ledger me sabse naya timestamp jeeta.
export function dbEntryTimestampMs(entry) {
  const raw = entry?.extractedAt || entry?.sentAt || entry?.at || entry?.updatedAt || entry?.createdAt || '';
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw > 1e12) return raw;
    if (raw > 1e9) return raw * 1000;
    return 0;
  }
  const parsed = Date.parse(String(raw || ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

// Khali payload — linked DB me pehli baar likhne ke liye.
export function emptyDbPayload() {
  return {
    version: 18,
    updatedAt: new Date().toISOString(),
    accounts: {},
    deletedAccounts: {},
    sessionVault: {},
    premiumFlow: { used: {} },
    orders: {},
    firebaseSources: null,
    freshSettings: {},
    userStates: {},
    waf: null,
  };
}

// Firebase sources ka merge — list union (URL ke hisaab se), deleted union,
// health me naya timestamp jeeta.
function mergeFirebaseSources(local = null, remote = null) {
  if (!local && !remote) return null;
  const L = local && typeof local === 'object' ? local : {};
  const R = remote && typeof remote === 'object' ? remote : {};

  const deleted = new Set([
    ...(Array.isArray(L.deleted) ? L.deleted : []),
    ...(Array.isArray(R.deleted) ? R.deleted : []),
  ].map(normUrl).filter(Boolean));

  const byUrl = new Map();
  for (const s of Array.isArray(R.list) ? R.list : []) {
    if (!s || !normUrl(s.url)) continue;
    byUrl.set(normUrl(s.url), { ...s });
  }
  let added = 0;
  for (const s of Array.isArray(L.list) ? L.list : []) {
    if (!s || !normUrl(s.url)) continue;
    const key = normUrl(s.url);
    const prev = byUrl.get(key);
    if (!prev) { byUrl.set(key, { ...s }); added++; continue; }
    byUrl.set(key, { ...prev, ...s, url: s.url || prev.url });
  }

  const health = { ...(R.health && typeof R.health === 'object' ? R.health : {}) };
  for (const [hid, h] of Object.entries(L.health && typeof L.health === 'object' ? L.health : {})) {
    const cur = health[hid];
    const touchRemote = Number(cur?.lastOkAt) || Number(cur?.lastFailAt) || 0;
    const touchLocal = Number(h?.lastOkAt) || Number(h?.lastFailAt) || 0;
    if (!cur || touchLocal > touchRemote) health[hid] = { ...h };
  }

  const list = [...byUrl.values()].filter((s) => s && normUrl(s.url) && !deleted.has(normUrl(s.url)));
  if (!list.length && !deleted.size && !L.cleared && !R.cleared) return null;

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    activeId: L.activeId || R.activeId || '',
    seedVersion: Number(L.seedVersion) || Number(R.seedVersion) || 0,
    deleted: [...deleted],
    health,
    cleared: Boolean(L.cleared || R.cleared),
    list,
    __added: added,
  };
}

// ── MAIN MERGE ──────────────────────────────────────────────────────────────
// local = ye instance ka live snapshot, remote = linked DB ka snapshot.
// Return: merged payload + stats (kya add hua).
export function mergeDbSnapshots(local = {}, remote = {}) {
  const L = local && typeof local === 'object' ? local : {};
  const R = remote && typeof remote === 'object' ? remote : {};
  const stats = {
    accountsAdded: 0,
    accountsRemoved: 0,
    accountsFilled: 0,
    ordersAdded: 0,
    vaultAdded: 0,
    ledgerMerged: 0,
    sourcesAdded: 0,
    deletedMerged: 0,
  };

  // 1) Tombstones — union. Local delete = remote me bhi delete.
  const deleted = { ...(R.deletedAccounts && typeof R.deletedAccounts === 'object' ? R.deletedAccounts : {}) };
  for (const [k, v] of Object.entries(L.deletedAccounts && typeof L.deletedAccounts === 'object' ? L.deletedAccounts : {})) {
    deleted[k] = v;
    stats.deletedMerged++;
  }

  // 2) Accounts — remote base, local upar. Credential fields me "local
  //    khaali, remote filled" case me remote jeeta (half-written account
  //    full account ko overwrite na kar de).
  const remoteAccounts = R.accounts && typeof R.accounts === 'object' ? R.accounts : {};
  const localAccounts = L.accounts && typeof L.accounts === 'object' ? L.accounts : {};
  const accounts = {};
  for (const [k, v] of Object.entries(remoteAccounts)) if (v && typeof v === 'object') accounts[k] = { ...v };
  for (const [k, v] of Object.entries(localAccounts)) {
    if (!v || typeof v !== 'object') continue;
    const base = accounts[k] && typeof accounts[k] === 'object' ? accounts[k] : null;
    if (!base) { accounts[k] = { ...v }; stats.accountsAdded++; continue; }
    const merged = { ...base, ...v };
    for (const f of CREDENTIAL_FIELDS) {
      const localVal = String(merged[f] ?? '').trim();
      const remoteVal = String(base[f] ?? '').trim();
      if (!localVal && remoteVal) { merged[f] = base[f]; stats.accountsFilled++; }
    }
    accounts[k] = merged;
  }

  // 3) Tombstone apply — delete permanent hai, EXCEPT jab local me wo
  //    account DOBARA bana ho (re-login) → tombstone hat jata hai.
  for (const [k, v] of Object.entries(accounts)) {
    const phone = normalizeDbPhone(v?.phone || v?.mobile || String(k).replace(/^acc_/, ''));
    const keyTomb = Boolean(deleted[k]);
    const phoneTomb = Boolean(phone && (deleted[`acc_${phone}`] || deleted[phone]));
    if (keyTomb) {
      if (localAccounts[k]) { delete deleted[k]; continue; } // re-login jeeta
      delete accounts[k]; stats.accountsRemoved++; continue;
    }
    if (phoneTomb && !localAccounts[k]) { delete accounts[k]; stats.accountsRemoved++; }
  }

  // 4) Session vault — union (local jeeta).
  const sessionVault = {};
  const remoteVault = R.sessionVault && typeof R.sessionVault === 'object' ? R.sessionVault : {};
  const localVault = L.sessionVault && typeof L.sessionVault === 'object' ? L.sessionVault : {};
  for (const [k, v] of Object.entries(remoteVault)) if (v) sessionVault[k] = v;
  for (const [k, v] of Object.entries(localVault)) {
    if (!v) continue;
    if (!sessionVault[k]) { sessionVault[k] = v; stats.vaultAdded++; continue; }
    sessionVault[k] = { ...sessionVault[k], ...v };
  }

  // 5) Orders — union (local jeeta), missing fields remote se bhar jate hain.
  const orders = {};
  const remoteOrders = R.orders && typeof R.orders === 'object' ? R.orders : {};
  const localOrders = L.orders && typeof L.orders === 'object' ? L.orders : {};
  for (const [k, v] of Object.entries(remoteOrders)) if (v && typeof v === 'object') orders[k] = { ...v };
  for (const [k, v] of Object.entries(localOrders)) {
    if (!v || typeof v !== 'object') continue;
    const base = orders[k] && typeof orders[k] === 'object' ? orders[k] : null;
    if (!base) { orders[k] = { ...v }; stats.ordersAdded++; continue; }
    const merged = { ...base, ...v };
    for (const f of ['swiggyOrderId', 'pendingSwiggyOrderId', 'trackingLink', 'trackingLinkSource', 'deliveryOtp', 'selectedAccount', 'liveOrderStatus']) {
      if (!merged[f] && base[f]) merged[f] = base[f];
    }
    orders[k] = merged;
  }

  // 6) Number ledger (7-day cooldown) — per phone sabse naya timestamp jeeta.
  const used = { ...(R.premiumFlow?.used && typeof R.premiumFlow.used === 'object' ? R.premiumFlow.used : {}) };
  for (const [phone, entry] of Object.entries(L.premiumFlow?.used && typeof L.premiumFlow.used === 'object' ? L.premiumFlow.used : {})) {
    if (!entry || typeof entry !== 'object') continue;
    const cur = used[phone];
    if (!cur || dbEntryTimestampMs(entry) > dbEntryTimestampMs(cur)) {
      used[phone] = { ...entry };
      stats.ledgerMerged++;
    }
  }

  // 7) Bot settings — local jeeta, remote sirf missing fill karta hai.
  const freshSettings = { ...(R.freshSettings && typeof R.freshSettings === 'object' ? R.freshSettings : {}) };
  for (const [k, v] of Object.entries(L.freshSettings && typeof L.freshSettings === 'object' ? L.freshSettings : {})) {
    if (v !== undefined && v !== null) freshSettings[k] = v;
  }

  // 7b) Per-user states (spare Telegram accounts, per-user pending/login state) — newest updatedAt wins per uid.
  const userStates = {};
  const rUsers = R.userStates && typeof R.userStates === 'object' ? R.userStates : {};
  const lUsers = L.userStates && typeof L.userStates === 'object' ? L.userStates : {};
  for (const [uid, st] of Object.entries(rUsers)) {
    if (st && typeof st === 'object') userStates[uid] = { ...st };
  }
  for (const [uid, st] of Object.entries(lUsers)) {
    if (!st || typeof st !== 'object') continue;
    const prev = userStates[uid];
    if (!prev) { userStates[uid] = { ...st }; continue; }
    const lTs = Number(st.updatedAt) || 0;
    const rTs = Number(prev.updatedAt) || 0;
    userStates[uid] = lTs >= rTs ? { ...prev, ...st } : { ...st, ...prev };
  }

  // 8) WAF token — naya acquiredAt jeeta.
  let waf = R.waf && typeof R.waf === 'object' ? { ...R.waf } : null;
  if (L.waf && typeof L.waf === 'object') {
    const lAcq = Number(L.waf.acquiredAt) || 0;
    const rAcq = Number(waf?.acquiredAt) || 0;
    if (!waf || lAcq >= rAcq) waf = { ...(waf || {}), ...L.waf };
  }

  const sources = mergeFirebaseSources(L.firebaseSources, R.firebaseSources);
  if (sources) stats.sourcesAdded = Number(sources.__added) || 0;
  if (sources) delete sources.__added;

  return {
    payload: {
      version: 18,
      updatedAt: new Date().toISOString(),
      accounts,
      deletedAccounts: deleted,
      sessionVault,
      premiumFlow: { used },
      orders,
      firebaseSources: sources,
      freshSettings,
      userStates,
      waf,
    },
    stats,
  };
}

// Fingerprint — "data badla ya nahi" check karne ke liye (push skip).
export function payloadFingerprint(payload = {}) {
  const clone = { ...(payload || {}) };
  delete clone.updatedAt;
  try {
    return createHash('sha1').update(JSON.stringify(clone)).digest('hex');
  } catch {
    return '';
  }
}
