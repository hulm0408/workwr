// Unit tests — Swiggy Fresh Bot (koi network nahi; fetch MOCK hai).
//   node test_fresh_unit.mjs   (ya npm test)
//
// Kya cover hota hai:
//   • Firebase reader v2 — clients pool parser, forwarder dateTime, OTP code extract
//   • OTP candidates — device messages node se candidate banna (mocked fetch)
//   • snapshot/exclude — purana OTP kabhi accept na ho, naya aaye to turant mile
//   • Pipeline helpers — ledger se fresh filtering + online-first ordering

import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';

// Env (import se PEHLE) — mock base URL taaki accidentally real fetch na ho
process.env.FIREBASE_DB_URL = 'https://mock-firebase.test.firebaseio.com';
process.env.FIREBASE_CLIENTS_PATH = 'clients';
process.env.FIREBASE_MESSAGES_PATH = 'messages';
process.env.FIREBASE_OTP_PATH = 'otp';
process.env.FIREBASE_SMS_PATH = 'sms';
delete process.env.FIREBASE_NUMBERS_PATH;
delete process.env.FIREBASE_DB_AUTH;

// Test ka APNA DB folder — production data/db.json KABHI touch na ho.
// (Pehle ye nahi tha: tests ensureSeeded() se mock URL production db.json me
// persist kar dete the → bot us fake URL par "fetch failed" karne lagta tha.)
process.env.DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-data');

let passed = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  passed++;
  console.log(`  ✓ ${label}`);
}

// ---------------------------------------------------------------------------
// MOCK fetch — URL ke hisaab se Firebase nodes
// ---------------------------------------------------------------------------
const mock = {
  clients: null,     // /clients.json
  messages: {},      // /messages/<deviceId>.json
  numbers: null,     // /numbers.json (legacy)
  otp: {},           // /otp/<phone>.json
  sms: {},           // /sms/<phone>.json
  calls: [],
};

globalThis.fetch = async (url) => {
  const u = String(url);
  mock.calls.push(u);
  const path = u.replace(/^https:\/\/[^/]+\//, '').replace(/\.json.*$/, '');
  const respond = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });

  if (path === 'clients') return respond(mock.clients);
  if (path === 'numbers') return respond(mock.numbers);
  if (path.startsWith('messages/')) {
    const devId = decodeURIComponent(path.slice('messages/'.length));
    let data = mock.messages[devId] ?? null;
    const limit = Number(new URL(u).searchParams.get('limitToLast') || 0);
    if (data && typeof data === 'object' && !Array.isArray(data) && limit > 0) {
      const entries = Object.entries(data)
        .sort(([a], [b]) => String(a).localeCompare(String(b), undefined, { numeric: true }));
      data = Object.fromEntries(entries.slice(-limit));
    }
    return respond(data);
  }
  if (path.startsWith('otp/')) {
    const phone = decodeURIComponent(path.slice('otp/'.length));
    return respond(mock.otp[phone] ?? null);
  }
  if (path.startsWith('sms/')) {
    const phone = decodeURIComponent(path.slice('sms/'.length));
    return respond(mock.sms[phone] ?? null);
  }
  return respond(null);
};
const mockFetch = globalThis.fetch;

const {
  normalizePoolPhone, _parsePool, _parseClientsPool, _clientOnlineState, _countDeviceOnlineStates,
  _parseTs, _firebaseErrorMessage,
  parseForwarderDateTime, _extractSixDigitCode, isFirebaseConfigured,
  listPoolNumbers, fetchOtpCandidates, snapshotSeenOtpState, waitForOtpCode,
  setFirebaseSource, getFirebaseSource,
} = await import('./firebase-numbers.js');
const {
  freshEntriesFrom,
  preferOnline,
  getPremiumLedger,
  getExtractedNumberCooldown,
  isPhoneBlockedByPremiumLedger,
  EXTRACTED_NUMBER_COOLDOWN_MS,
} = await import('./number-pipeline.js');
const {
  getAutopilotSnapshot, isAutopilotRunning, requestAutopilotStop,
  normalizeBatchConcurrency, availableParallelLanes, parallelWorkerUserId,
  formatPoolStatus, formatFirebaseSourceStatus, formatScanCandidateStates,
  noEvidenceWaitPassLimit, poolExhaustedReasonText,
} = await import('./autopilot-engine.js');
const srcMod = await import('./firebase-sources.js');
const bs = await import('./bot-settings.js');
const px = await import('./proxy-pool.js');
const keepAlive = await import('./keep-alive.js');

// ---------------------------------------------------------------------------
console.log('isFirebaseConfigured:');
ok(isFirebaseConfigured() === true, 'FIREBASE_DB_URL set → configured');

// ---------------------------------------------------------------------------
console.log('normalizePoolPhone:');
ok(normalizePoolPhone('+91 98765 43210') === '9876543210', '+91 spaced form → 10 digit');
ok(normalizePoolPhone('919876543210') === '9876543210', '91-prefixed → 10 digit');
ok(normalizePoolPhone('09876543210') === '9876543210', 'leading-zero 11-digit → 10 digit');
ok(normalizePoolPhone('9876543210') === '9876543210', 'plain 10 digit passthrough');
ok(normalizePoolPhone('12345') === null, 'garbage → null');
ok(normalizePoolPhone(null) === null, 'null → null');

// ---------------------------------------------------------------------------
console.log('_parsePool (legacy numbers path):');
{
  const pool = _parsePool(['+919876543210', '9876543211']);
  ok(pool.length === 2 && pool[0].phone === '9876543210', 'array of phones parsed');
}
{
  const pool = _parsePool({ a: { number: '9876543212', status: 'used' } });
  ok(pool.length === 1 && pool[0].status === 'used', 'object with status parsed');
}
ok(_parsePool(null).length === 0, 'null pool → empty');
ok(_parsePool(['abc']).length === 0, 'garbage entries dropped');
ok(_parsePool({ a: '9876543210', b: '+91 98765 43210' }).length === 1, 'duplicate phones deduped');

// ---------------------------------------------------------------------------
console.log('_parseClientsPool (clients — asli structure):');
{
  const raw = {
    DEV1: {
      mobNo: '+91 98765 43210',
      status: true,
      modelName: 'Samsung M12',
      joined: '2026-01-01',
      sims: [{ phoneNumber: '9876543210' }, { phoneNumber: '9876543299' }],
    },
    DEV2: {
      status: false,
      sims: [{ phoneNumber: '09876543211' }],
    },
    DEV3: 'garbage',
    DEV4: null,
  };
  const pool = _parseClientsPool(raw);
  ok(pool.length === 3, '3 unique numbers (DEV3/DEV4 skip, DEV1 ke 2 sims)');
  const d1 = pool.find((p) => p.phone === '9876543210');
  ok(Boolean(d1) && d1.online === true, 'mobNo entry online=true (status===true)');
  ok(d1.label === 'Samsung M12', 'modelName label bana');
  ok(d1.deviceId === 'DEV1' && d1.childKey === 'DEV1', 'deviceId/childKey set');
  ok(d1.noPatch === true, 'noPatch=true (device status field bachao)');
  const d2 = pool.find((p) => p.phone === '9876543211');
  ok(Boolean(d2) && d2.online === false, 'status!==true → online=false');
  const d1s2 = pool.find((p) => p.phone === '9876543299');
  ok(Boolean(d1s2) && d1s2.deviceId === 'DEV1', 'sims[1] bhi usi device se link');
}
ok(_parseClientsPool(null).length === 0, 'null → empty');
ok(_parseClientsPool([]).length === 0, 'array → empty (clients object hi chalega)');
ok(_parseClientsPool({ A: { mobNo: '12345' } }).length === 0, 'sirf garbage phone → empty');
{
  ok(_clientOnlineState({ status: true }) === true, 'presence: boolean true ONLINE');
  ok(_clientOnlineState({ status: 'online' }) === true, 'presence: "online" string ONLINE');
  ok(_clientOnlineState({ isOnline: 'TRUE' }) === true, 'presence: isOnline text ONLINE');
  ok(_clientOnlineState({ online: 1 }) === true, 'presence: numeric 1 ONLINE');
  ok(_clientOnlineState({ presence: 'connected' }) === true, 'presence: connected ONLINE');
  ok(_clientOnlineState({ status: false }) === false, 'presence: boolean false offline');
  ok(_clientOnlineState({ status: 'offline' }) === false, 'presence: "offline" offline');
  ok(_clientOnlineState({ active: 0 }) === false, 'presence: numeric 0 offline');
  ok(_clientOnlineState({ status: 'busy' }) === null, 'presence: unknown string ko zabardasti offline nahi');
  ok(_clientOnlineState({}) === null, 'presence: missing status unknown');
  ok(_clientOnlineState({ online: 'garbage', status: true }) === true, 'presence: bad early field ke baad valid status bhi check');
  const parsed = _parseClientsPool({
    DEV_ONLINE: { mobNo: '9876501001', status: 'online' },
    DEV_UNKNOWN: { mobNo: '9876501002' },
    DEV_OFFLINE: { mobNo: '9876501003', status: 'offline' },
  });
  ok(parsed.find((p) => p.deviceId === 'DEV_ONLINE')?.online === true, 'clients parser: string ONLINE asal ONLINE bana');
  ok(parsed.find((p) => p.deviceId === 'DEV_UNKNOWN')?.online === undefined, 'clients parser: missing status unknown rakha, false nahi');
  ok(parsed.find((p) => p.deviceId === 'DEV_OFFLINE')?.online === false, 'clients parser: string offline asal offline bana');
  const counts = _countDeviceOnlineStates([
    ...parsed,
    { phone: '9876501099', deviceId: 'DEV_UNKNOWN', online: true },
    { phone: '9876501098', deviceId: 'DEV_OFFLINE', online: undefined },
  ]);
  ok(counts.online === 2 && counts.unknown === 1 && counts.offline === 0 && counts.total === 3,
    'device status counts: device-wise dedupe + true > unknown > false');
}

// ---------------------------------------------------------------------------
console.log('_parseTs:');
ok(_parseTs(1712345678901) === 1712345678901, 'epoch ms passthrough');
ok(_parseTs(1712345678) === 1712345678000, 'epoch seconds × 1000');
ok(_parseTs('1712345678901') === 1712345678901, 'numeric string parsed');
ok(_parseTs('2026-10-24T10:00:00Z') === Date.parse('2026-10-24T10:00:00Z'), 'ISO string parsed');
ok(_parseTs('garbage') === null, 'garbage → null');
ok(_parseTs(null) === null, 'null → null');

// ---------------------------------------------------------------------------
console.log('parseForwarderDateTime (IST "DD-MM-YYYY | hh:mm AM"):');
{
  const ts = parseForwarderDateTime('23-10-2026 | 04:48 AM');
  ok(ts === Date.UTC(2026, 9, 23, 4, 48) - 5.5 * 3600 * 1000, '"23-10-2026 | 04:48 AM" → IST epoch');
}
{
  const ts = parseForwarderDateTime('06/10/2026 | 03:50 pm');
  ok(ts === Date.UTC(2026, 9, 6, 15, 50) - 5.5 * 3600 * 1000, 'slash format + pm → 15:50 IST epoch');
}
ok(parseForwarderDateTime('99-99-2026 | 04:48 AM') === null, 'invalid date → null');
ok(parseForwarderDateTime('garbage') === null, 'garbage → null');
ok(parseForwarderDateTime(1712345678901) === 1712345678901, 'number passthrough');

// ---------------------------------------------------------------------------
console.log('_extractSixDigitCode:');
ok(_extractSixDigitCode('Your Swiggy OTP is 123456. Valid for 5 mins') === '123456', 'simple Swiggy OTP line');
ok(_extractSixDigitCode('Bank ref 999888\nSwiggy: use 654321 to login') === '654321', 'Swiggy line ko prefer kiya');
ok(_extractSixDigitCode('OTP 123456\n-JP-987654-A') === '123456', 'pehla 6-digit code (no swiggy line)');
ok(_extractSixDigitCode('no code here') === '', 'code absent → empty');
ok(_extractSixDigitCode('') === '', 'empty text → empty');
ok(_extractSixDigitCode('code 1234567 (7 digit)') === '', '7-digit ko 6-digit nahi samjha');

// ---------------------------------------------------------------------------
console.log('listPoolNumbers (clients primary, numbers legacy fallback):');
{
  mock.clients = { DEV1: { mobNo: '9876543210', status: true } };
  mock.numbers = ['9876543255'];
  const pool = await listPoolNumbers();
  ok(pool.length === 1 && pool[0].phone === '9876543210', 'clients pool use hua (legacy nahi)');
}
{
  mock.clients = null;
  mock.numbers = ['9876543255', '9876543256'];
  const pool = await listPoolNumbers();
  ok(pool.length === 2, 'clients khali → legacy numbers fallback');
}
ok(_firebaseErrorMessage({ error: 'The Firebase database has been deactivated.' }).includes('deactivated'), 'Firebase error JSON pehchana gaya');
ok(_firebaseErrorMessage({ error: 'not-an-error', DEV1: {} }) === '', 'data node ke random error child ko Firebase error nahi samjha');
{
  mock.clients = { error: 'The Firebase database has been deactivated.' };
  mock.numbers = ['9876543255'];
  let err = '';
  try { await listPoolNumbers(); } catch (e) { err = String(e?.message || e); }
  ok(/deactivated/.test(err), 'deactivated Firebase error empty pool bankar chhupta nahi');
}
{
  mock.numbers = ['9876543255'];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/clients.json')) throw new Error('socket reset');
    return mockFetch(url, opts);
  };
  let err = '';
  try { await listPoolNumbers(); } catch (e) { err = String(e?.message || e); } finally { globalThis.fetch = mockFetch; }
  ok(/socket reset/.test(err), 'clients transient fetch fail empty pool nahi banta (agla source try hoga)');
}
{
  mock.numbers = ['9876543255', '9876543256'];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/clients.json')) {
      return { ok: false, status: 404, json: async () => null, text: async () => 'missing' };
    }
    return mockFetch(url, opts);
  };
  let pool = [];
  try { pool = await listPoolNumbers(); } finally { globalThis.fetch = mockFetch; }
  ok(pool.length === 2, 'sirf clients 404 par legacy numbers fallback');
}
mock.clients = { DEV1: { mobNo: '9876543210', status: true } };

// ---------------------------------------------------------------------------
console.log('fetchOtpCandidates (device messages node):');
{
  mock.messages.DEV1 = {
    m1: {
      dateTime: '23-10-2026 | 04:48 AM',
      message: 'Your Swiggy login OTP is 111222. Do not share.',
      sender: 'VM-SWIGGY',
      type: 'incoming',
    },
    m2: { message: 'HDFC: 333444 is your txn OTP', sender: 'AD-HDFCBK' },
  };
  const cands = await fetchOtpCandidates('9876543210', { deviceIds: ['DEV1'] });
  ok(cands.length === 2, 'dono messages se candidate bane');
  const sw = cands.find((c) => c.code === '111222');
  ok(Boolean(sw) && sw.via === 'device', 'Swiggy OTP code 111222 mila (via device)');
  ok(sw.idKey === 'messages/DEV1/m1', 'idKey = messages/<dev>/<key>');
  ok(typeof sw.ts === 'number' && sw.ts > 0, 'forwarder dateTime se ts bana');
  const bank = cands.find((c) => c.code === '333444');
  ok(Boolean(bank) && bank.meta === 'AD-HDFCBK', 'non-Swiggy code bhi candidate (sender meta)');
}
{
  mock.messages.DEV1 = {}; mock.messages.DEV2 = {};
  const cands = await fetchOtpCandidates('9876543210', { deviceIds: ['DEV1', 'DEV2'] });
  ok(cands.length === 0, 'khali inbox → 0 candidates');
}

// ---------------------------------------------------------------------------
console.log('snapshot + waitForOtpCode (exclude purana, naya turant):');
{
  // Purana Swiggy message inbox me pada hai
  mock.messages.DEV1 = {
    m1: { message: 'Swiggy OTP 111222', sender: 'VM-SWIGGY', date: Date.now() - 600_000 },
  };
  const snapBefore = await snapshotSeenOtpState('9876543210', { deviceIds: ['DEV1'] });
  ok(snapBefore.ids.has('messages/DEV1/m1') && snapBefore.codes.has('111222'), 'snapshot me purana OTP');

  // Ab naya OTP aaya (Swiggy ne bheja)
  mock.messages.DEV1.m2 = { message: 'Swiggy: 654321 is your OTP', sender: 'VM-SWIGGY', date: Date.now() };
  const otp = await waitForOtpCode('9876543210', {
    deviceIds: ['DEV1'],
    excludeIds: snapBefore,
    waitMs: 0, timeoutMs: 3_000, pollMs: 100, acceptAnyAfterMs: 0,
    sinceTs: Date.now() - 30_000,
  });
  ok(otp.code === '654321', 'naya OTP mila, purana exclude');
}
{
  // Sirf purana OTP — naya kuch nahi → timeout par empty
  mock.messages.DEV1 = {
    m1: { message: 'Swiggy OTP 111222', sender: 'VM-SWIGGY', date: Date.now() - 600_000 },
  };
  const snap = await snapshotSeenOtpState('9876543210', { deviceIds: ['DEV1'] });
  const otp = await waitForOtpCode('9876543210', {
    deviceIds: ['DEV1'],
    excludeIds: snap,
    waitMs: 0, timeoutMs: 500, pollMs: 100, acceptAnyAfterMs: 0,
    sinceTs: Date.now() - 30_000,
  });
  ok(otp.code === '' && !otp.aborted, 'sirf purana OTP → timeout par empty (accept nahi)');
}
{
  // Swiggy vs bank dono naye aaye → Swiggy hi chune
  mock.messages.DEV1 = {
    m9: { message: 'SBI: 999111 is your OTP', sender: 'AD-SBI', date: Date.now() },
    m8: { message: 'Swiggy: 222333 is your OTP', sender: 'VM-SWIGGY', date: Date.now() - 1_000 },
  };
  const otp = await waitForOtpCode('9876543210', {
    deviceIds: ['DEV1'],
    excludeIds: { ids: new Set(), codes: new Set() },
    waitMs: 0, timeoutMs: 2_000, pollMs: 100, acceptAnyAfterMs: 60_000,
    sinceTs: 0,
  });
  ok(otp.code === '222333', 'Swiggy line hamesha prefer (bank OTP ke baavjood)');
}
{
  // STOP dabaya → abort
  const otp = await waitForOtpCode('9876543210', {
    deviceIds: ['DEV1'],
    waitMs: 0, timeoutMs: 5_000, pollMs: 100,
    shouldAbort: () => true,
  });
  ok(otp.aborted === true && otp.code === '', 'shouldAbort → aborted');
}

// ---------------------------------------------------------------------------
console.log('freshEntriesFrom + preferOnline (pipeline helpers):');
{
  const ledger = getPremiumLedger();
  ok(ledger && typeof ledger === 'object', 'ledger mili (db.json premiumFlow.used)');
  const pool = [
    { phone: '9876500001', status: '', online: true },
    { phone: '9876500002', status: 'used', online: true },
    { phone: '9876500003', status: '', online: false },
  ];
  const fresh = freshEntriesFrom(pool);
  ok(fresh.length === 2, 'status=used wala filter hua');
  ok(!fresh.find((n) => n.phone === '9876500002'), 'used number fresh list me nahi');

  const ordered = preferOnline(fresh);
  ok(ordered[0].online === true && ordered[ordered.length - 1].online === false, 'online pehle, offline baad me');
  const triStateOrdered = preferOnline([
    { phone: '9876500203', online: false },
    { phone: '9876500202', online: undefined },
    { phone: '9876500201', online: true },
  ]);
  ok(triStateOrdered.map((e) => e.phone).join(',') === '9876500201,9876500202,9876500203',
    'preferOnline: asal ONLINE → status-unknown → offline order');

  // 7-day extracted-number cooldown: 6 din pehle bheja number block,
  // exact 7 din guzarne ke baad hi dobara eligible.
  const now = Date.now();
  const cooldownLedger = {
    '9876500011': { status: 'success', at: new Date(now - 6 * 24 * 60 * 60 * 1000).toISOString() },
    '9876500012': { status: 'success', at: new Date(now - EXTRACTED_NUMBER_COOLDOWN_MS - 1).toISOString() },
    '9876500013': { status: 'skipped', at: new Date(now - EXTRACTED_NUMBER_COOLDOWN_MS - 1).toISOString() },
  };
  const cooldownPool = ['9876500011', '9876500012', '9876500013', '9876500014']
    .map((phone) => ({ phone, status: '', online: true }));
  const afterCooldownFilter = freshEntriesFrom(cooldownPool, {
    now,
    ledger: cooldownLedger,
    savedSessions: new Map(),
  }).map((n) => n.phone);
  ok(!afterCooldownFilter.includes('9876500011'), '7-day cooldown: 6 din pehle extracted number block');
  ok(afterCooldownFilter.includes('9876500012'), '7-day cooldown: 7 din guzarne ke baad number eligible');
  ok(!afterCooldownFilter.includes('9876500013'), 'skipped ledger entry 7 din baad bhi block (purani safety barqarar)');
  ok(getExtractedNumberCooldown('9876500011', {
    now,
    ledger: cooldownLedger,
    savedSessions: new Map(),
  }).blocked === true, 'cooldown helper: recent extracted number blocked');
  ok(isPhoneBlockedByPremiumLedger('9876500012', {
    now,
    ledger: cooldownLedger,
    savedSessions: new Map(),
  }) === false, 'cooldown helper: expired success dobara allowed');

  // Agar local ledger restart/deploy me kho jaye lekin saved session
  // cloud se wapas aa jaye, to uska savedAt bhi wahi 7 din rokega.
  const savedFallback = freshEntriesFrom([{ phone: '9876500015', status: '', online: true }], {
    now,
    ledger: {},
    savedSessions: new Map([['9876500015', now - 60_000]]),
  });
  ok(savedFallback.length === 0, 'ledger missing ho to saved-session savedAt se 7-day cooldown');

  // Cloud snapshot/merge: premium ledger ab accounts ke saath durable hai.
  const store = await import('./store.js');
  const snapshot = store.buildCloudVaultSnapshot({
    config: { accounts: {}, deletedAccounts: {} },
    sessionVault: {},
    orders: {},
    premiumFlow: { used: cooldownLedger },
  });
  ok(snapshot.premiumFlow.used['9876500011'].status === 'success', 'cloud snapshot me extracted-number ledger shamil');
  const mergedLedger = store._mergePremiumLedgerEntries(
    { '9876500016': { status: 'success', at: new Date(now - 10_000).toISOString() } },
    { '9876500016': { status: 'success', at: new Date(now - 1_000).toISOString() } },
  );
  ok(mergedLedger.changed === 1 && Date.parse(mergedLedger.used['9876500016'].at) === now - 1_000,
    'cloud ledger merge: nayi extracted timestamp jeet-ti hai');
  const vaultSync = await import('./vault-sync.js');
  const safePushPayload = vaultSync._mergeVaultPremiumLedger(
    { premiumFlow: { used: {} } },
    { premiumFlow: { used: cooldownLedger } },
  );
  ok(safePushPayload.premiumFlow.used['9876500011'].status === 'success',
    'cloud push safeguard: khali local snapshot remote 7-day ledger erase nahi karta');
}

// ---------------------------------------------------------------------------
console.log('setFirebaseSource (dynamic source override):');
{
  setFirebaseSource({ url: 'https://alt-firebase.test.firebaseio.com/', clientsPath: 'devices' });
  const active = getFirebaseSource();
  ok(active.url === 'https://alt-firebase.test.firebaseio.com', 'trailing slash cut gaya');
  ok(active.clientsPath === 'devices', 'custom clientsPath save');
  ok(isFirebaseConfigured() === true, 'override se configured');
  // Reader ab ALT source ka URL use kare (mock fetch par nazar)
  mock.calls.length = 0;
  mock.clients = { D9: { mobNo: '9876543210', status: true } };
  await listPoolNumbers();
  ok(mock.calls.some((u) => u.startsWith('https://alt-firebase.test.firebaseio.com/devices.json')), 'pool fetch ALT URL par gaya');
  ok(mock.calls.every((u) => u.startsWith('https://alt-firebase.test.firebaseio.com/')), 'koi bhi call env URL par nahi gaya');
  setFirebaseSource(null);
  ok(getFirebaseSource() === null, 'null → env fallback restore');
  mock.calls.length = 0;
  await listPoolNumbers();
  ok(mock.calls.every((u) => u.startsWith('https://mock-firebase.test.firebaseio.com/')), 'env URL wapas apply');
}

// ---------------------------------------------------------------------------
console.log('firebase-sources (db-backed manager):');
{
  const seeded = srcMod.listSources();
  ok(seeded.length >= 1, 'ensureSeeded — default source auto-seed');
  ok(Boolean(srcMod.getActiveSource()), 'first-try source set');
  ok(seeded.every((s) => s.active === true && s.enabled === true), 'saare seeded Firebase hamesha ACTIVE hain');
  ok(seeded.filter((s) => s.primary).length === 1, 'sirf batch-order ke liye ek first-try marked hai; baaki bhi ACTIVE hain');
  {
    const store = await import('./store.js');
    const db = store.getDb();
    const raw = db.firebaseSources.list.find((s) => s.id === seeded[0].id);
    raw.enabled = false;
    store.saveDb(db);
    const migrated = srcMod.getSource(seeded[0].id);
    ok(migrated.enabled === true && migrated.active === true
      && srcMod.listRunSources().some((s) => s.id === seeded[0].id),
    'purana disabled source load par ACTIVE normalize — sirf Delete se hatega');
  }
  ok(srcMod.BUILTIN_FIREBASE_SOURCE_URLS.length >= 400,
    `owner ki poori ROLEX VIP list built-in hai (${srcMod.BUILTIN_FIREBASE_SOURCE_URLS.length} URLs)`);
  ok(new Set(srcMod.BUILTIN_FIREBASE_SOURCE_URLS.map((u) => u.toLowerCase())).size === srcMod.BUILTIN_FIREBASE_SOURCE_URLS.length,
    'built-in Firebase URLs me duplicate nahi');
  ok(srcMod.BUILTIN_FIREBASE_SOURCE_URLS[0] === 'https://admin143-dab82-default-rtdb.firebaseio.com', 'pehla built-in Firebase URL sahi');
  ok(srcMod.BUILTIN_FIREBASE_SOURCE_URLS.includes('https://do-admin-v21-default-rtdb.firebaseio.com'), 'purani 55 wali list bhi shamil');
  ok(srcMod.BUILTIN_FIREBASE_SOURCE_URLS.includes('https://choduu00111-default-rtdb.firebaseio.com'), 'choduu00111 Firebase URL shamil');
  ok(srcMod.BUILTIN_FIREBASE_SOURCE_URLS.includes('https://myypppp-default-rtdb.asia-southeast1.firebasedatabase.app'), 'asia-southeast1 Firebase URL shamil');
  ok(srcMod.BUILTIN_FIREBASE_SOURCE_URLS.includes('https://a4jaat-208cb-default-rtdb.firebaseio.com'), 'ROLEX list ka pehla Firebase URL shamil');
  ok(srcMod.BUILTIN_FIREBASE_SOURCE_URLS.includes('https://painislv-default-rtdb.firebaseio.com'), 'ROLEX list ka aakhri poora Firebase URL shamil');
  ok(!srcMod.BUILTIN_FIREBASE_SOURCE_URLS.some((u) => /pari-7907d/i.test(u)), 'adhoora cut hua URL seed list me nahi');
  ok(srcMod.MAX_BULK_FIREBASE_SOURCES >= 1000, 'ek message me 1000 tak Firebase add ho sakte hain');
  {
    const seededUrls = new Set(seeded.map((s) => s.url.replace(/\/+$/, '').toLowerCase()));
    ok(srcMod.BUILTIN_FIREBASE_SOURCE_URLS.every((u) => seededUrls.has(u.toLowerCase())), 'saare built-in Firebase sources seed ho gaye');
    ok(seeded.filter((s) => s.builtin).length === srcMod.BUILTIN_FIREBASE_SOURCE_URLS.length,
      'poori built-in list builtin tag ke saath save');
    ok(new Set(seeded.map((s) => s.id)).size === seeded.length, 'source IDs unique hain');
    ok(seeded.every((s) => /^[a-f0-9-]{1,10}$/.test(s.id)), 'source IDs Telegram callback-compatible hain');
  }
  {
    const ordered = srcMod.orderSourcesForRun([
      { id: 'a', url: 'https://a-default-rtdb.firebaseio.com', enabled: true },
      { id: 'b', url: 'https://b-default-rtdb.firebaseio.com', enabled: true },
      { id: 'c', url: 'https://c-default-rtdb.firebaseio.com', enabled: false },
      { id: 'dup', url: 'https://a-default-rtdb.firebaseio.com/', enabled: true },
      { id: 'd', url: 'https://d-default-rtdb.firebaseio.com', enabled: true },
    ], 'b');
    ok(ordered.map((s) => s.id).join(',') === 'b,a,c,d', 'batch source order: first-try pehle, duplicate bahar, stale disabled bhi ACTIVE');
    ok(ordered.every((s) => s.enabled === true && s.active === true) && ordered[0]?.primary === true,
      'ordered run sources sab ACTIVE decorated; primary sirf order marker hai');
    const runSources = srcMod.listRunSources();
    ok(runSources[0]?.id === srcMod.getActiveSource()?.id, 'listRunSources first-try source ko pehle rakhta hai');
    ok(runSources.length === srcMod.listSources().length
      && runSources.every((s) => s.enabled && s.active),
    'listRunSources har saved Firebase ko ACTIVE pool me rakhta hai');
  }

  const before = srcMod.listSources().length;
  const bad = srcMod.addSource({ url: 'https://not-a-firebase.example.com' });
  ok(bad.ok === false, 'galat URL reject');
  const dup = srcMod.addSource({ url: srcMod.getActiveSource().url });
  ok(dup.ok === false, 'duplicate URL reject');
  const add = srcMod.addSource({ url: 'https://secondfb-default-rtdb.firebaseio.com', name: 'Second' });
  ok(add.ok === true && add.source.active === true, 'naya source add + ACTIVE');
  ok(srcMod.listSources().length === before + 1, 'list me add ho gaya');
  ok(srcMod.getActiveSource().name === 'Second', 'legacy single-add ne first-try badal diya (saare phir bhi ACTIVE)');
  ok(getFirebaseSource()?.url === 'https://secondfb-default-rtdb.firebaseio.com', 'reader par bhi apply (auto)');

  const first = srcMod.listSources().find((s) => s.name !== 'Second');
  const sw = srcMod.setActiveSource(first.id);
  ok(sw.ok === true && srcMod.getActiveSource().id === first.id, 'first-try order badalna kaam karta hai; koi inactive nahi hota');

  {
    const bulkBefore = srcMod.listSources().length;
    const bulkText = [
      'https://bulkone-default-rtdb.firebaseio.com/, bulktwo-default-rtdb.firebaseio.com | bulk-secret',
      '- https://bulkthree-default-rtdb.firebaseio.com/',
      'https://bulkone-default-rtdb.firebaseio.com/',
      add.source.url,
      'not-a-firebase-url',
    ].join('\n');
    const parsedBulk = srcMod.parseFirebaseSourceBulkInput(bulkText);
    ok(parsedBulk.entries.length === 5 && parsedBulk.invalid.length === 1,
      'bulk parser: line/comma/bare-host entries mile, garbage invalid report');
    ok(parsedBulk.entries[1]?.url === 'https://bulktwo-default-rtdb.firebaseio.com'
      && parsedBulk.entries[1]?.auth === 'bulk-secret',
    'bulk parser: bare hostname par https + per-URL auth sahi');

    const bulk = srcMod.addSourcesBulk(bulkText, { setFirstAsPrimary: true });
    ok(bulk.ok === true && bulk.added.length === 3 && bulk.duplicates.length === 2 && bulk.invalid.length === 1,
      'bulk add: ek baar me 3 naye, existing/input duplicates skip, invalid report');
    ok(bulk.added.every((s) => s.active === true && s.enabled === true)
      && srcMod.listSources().every((s) => s.active === true && s.enabled === true),
    'bulk add ke baad purane + naye saare Firebase ACTIVE');
    ok(bulk.total === bulkBefore + 3 && srcMod.listSources().length === bulkBefore + 3,
      'bulk add: total count sirf asal naye sources se badha');
    ok(srcMod.getActiveSource()?.id === bulk.added[0]?.id
      && getFirebaseSource()?.url === bulk.added[0]?.url,
    'bulk add: pehla naya URL first-try/reader par, baaki sab phir bhi ACTIVE');

    for (const addedSource of bulk.added) srcMod.removeSource(addedSource.id);
    const afterBulkDelete = srcMod.listSources();
    ok(afterBulkDelete.length === bulkBefore
      && bulk.added.every((addedSource) => !afterBulkDelete.some((s) => s.id === addedSource.id))
      && afterBulkDelete.every((s) => s.active === true),
    'bulk sources sirf Delete se hate; baaki saare ACTIVE rahe');
    srcMod.setActiveSource(first.id);
  }

  const tg = srcMod.toggleSource(first.id);
  ok(tg.ok === true && tg.enabled === true && tg.alwaysActive === true
    && srcMod.getSource(first.id)?.active === true
    && srcMod.listRunSources().some((s) => s.id === first.id),
  'toggle kabhi disable nahi karta — Delete tak source ACTIVE rehta hai');

  const rm = srcMod.removeSource(add.source.id);
  ok(rm.ok === true, 'delete ho gaya');
  const onlyOne = srcMod.listSources();
  if (onlyOne.length === 1) {
    ok(srcMod.removeSource(onlyOne[0].id).ok === false, 'aakhri source delete nahi hota');
  }
  srcMod.applyActiveSource();
  ok(getFirebaseSource() !== null || isFirebaseConfigured(), 'applyActiveSource baad bhi safe');
  {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ error: 'The Firebase database has been deactivated.' }),
      text: async () => '{"error":"deactivated"}',
    });
    let verified;
    try { verified = await srcMod.verifySource(srcMod.getActiveSource().id); }
    finally { globalThis.fetch = mockFetch; }
    ok(verified.ok === false && /deactivated/.test(verified.error), 'verifySource Firebase error JSON ko fail kehta hai');
  }
}

// ---------------------------------------------------------------------------
console.log('firebase durability + speed (env seed, delete-memory, health, vault):');
{
  // 1) env FIREBASE_DB_URLS → boot par missing URLs auto-add
  const prevEnvUrls = process.env.FIREBASE_DB_URLS;
  process.env.FIREBASE_DB_URLS = 'https://envone-default-rtdb.firebaseio.com\nhttps://envtwo-default-rtdb.firebaseio.com';
  try {
    const envUrls = srcMod.envSeedUrls();
    ok(envUrls.length === 2 && envUrls[0] === 'https://envone-default-rtdb.firebaseio.com'
      && envUrls[1] === 'https://envtwo-default-rtdb.firebaseio.com',
    'FIREBASE_DB_URLS se poori list parse (newline/comma)');
    ok(srcMod.FIREBASE_ENV_URL_KEYS.includes('FIREBASE_DB_URLS'), 'env key documented/exported');

    const seededEnv = srcMod.ensureSeeded();
    const envAdded = seededEnv.list.filter((s) => /env(one|two)-default-rtdb/.test(s.url));
    ok(envAdded.length === 2, 'env URLs boot seed me add ho gayi (restart-proof setup)');

    // Delete-memory: delete ki hui URL seed se wapas nahi aati
    srcMod.removeSource(envAdded[0].id);
    const afterDelete = srcMod.ensureSeeded();
    ok(!afterDelete.list.some((s) => /envone-default-rtdb/.test(s.url)),
      'Delete ki hui URL env/built-in seed se wapas nahi aati');
    const reAdd = srcMod.addSource({ url: 'https://envone-default-rtdb.firebaseio.com' });
    ok(reAdd.ok === true, 'manually dobara add karna chalta hai');
    const readded = srcMod.ensureSeeded().list.filter((s) => /envone-default-rtdb/.test(s.url));
    ok(readded.length === 1, 're-add ke baad duplicate nahi banta');
  } finally {
    if (prevEnvUrls === undefined) delete process.env.FIREBASE_DB_URLS;
    else process.env.FIREBASE_DB_URLS = prevEnvUrls;
  }

  // 2) Health: 2 fail → 30 min quarantine → order me sabse aakhir
  {
    const victim = srcMod.getActiveSource();
    srcMod.resetSourceHealth();
    srcMod.recordSourceResult(victim.id, { ok: false, error: 'timeout' });
    ok(srcMod.getSourceHealth(victim.id).failStreak === 1, 'ek failure par streak 1');
    ok(srcMod.isSourceQuarantined(victim.id) === false, 'ek failure par abhi quarantine nahi');
    srcMod.recordSourceResult(victim.id, { ok: false, error: 'timeout' });
    ok(srcMod.isSourceQuarantined(victim.id) === true, '2 lagatar failure par quarantine');
    const ordered = srcMod.listRunSources();
    ok(ordered.at(-1)?.id === victim.id, 'quarantined DB run order me sabse aakhir');
    ok(ordered.length === srcMod.listSources().length, 'quarantine DB ko list se nahi hatata');
    ok(ordered[0]?.primary === true && ordered[0]?.id !== victim.id, 'top healthy/untried DB first-try banti hai');

    srcMod.recordSourceResult(victim.id, { ok: true, ms: 90 });
    ok(srcMod.getSourceHealth(victim.id).failStreak === 0, 'success par fail streak reset');
    ok(srcMod.isSourceQuarantined(victim.id) === false, 'success quarantine clear karta hai');

    srcMod.recordSourceResult(victim.id, { empty: true, error: 'khali pool' });
    srcMod.recordSourceResult(victim.id, { empty: true, error: 'khali pool' });
    ok(srcMod.isSourceQuarantined(victim.id) === true, 'khali pool bhi 2 baar par quarantine');
    srcMod.resetSourceHealth();
    const summary = srcMod.sourceHealthSummary();
    ok(summary.total === srcMod.listSources().length && summary.quarantined === 0,
      'health summary reset ke baad saaf');
  }

  // 3) Bulk limit: 250 URLs ek message me (purani 200 limit nahi)
  {
    const many = Array.from({ length: 250 }, (_, i) => `https://loadtest${i}-default-rtdb.firebaseio.com`).join('\n');
    const bulkRes = srcMod.addSourcesBulk(many, { setFirstAsPrimary: false, applyReader: false });
    ok(bulkRes.added.length === 250, 'ek message me 250 Firebase add (200 se zyada)');
    ok(bulkRes.invalid.length === 0, 'bulk 250 me koi invalid nahi');
    for (const a of bulkRes.added) srcMod.removeSource(a.id);
    ok(!srcMod.listSources().some((s) => /loadtest\d+-default-rtdb/.test(s.url)), 'bulk test sources delete ho gaye');
  }

  // 4) Cloud vault: sources + settings snapshot aur hydrate-merge
  {
    const store = await import('./store.js');
    const db = store.getDb();
    db.freshSettings = { ...(db.freshSettings || {}), target: 321, concurrency: 10 };
    store.saveDb(db);

    const snap = store.buildCloudVaultSnapshot(store.getDb());
    ok(Array.isArray(snap.firebaseSources?.list) && snap.firebaseSources.list.length >= 400,
      `vault snapshot me poori Firebase list (${snap.firebaseSources?.list?.length})`);
    ok(snap.firebaseSources.list.every((s) => s.enabled === true), 'vault snapshot me sab sources ACTIVE');
    ok(snap.freshSettings?.target === 321, 'vault snapshot me batch settings');

    // Remote snapshot me ek naya source + setting — merge hone chahiye
    const fakeDb = { firebaseSources: { activeId: '', list: [], deleted: [], health: {} }, freshSettings: {} };
    const remote = {
      firebaseSources: {
        activeId: '',
        seedVersion: 3,
        deleted: [],
        health: {},
        list: [
          { id: 'abc12345', url: 'https://vaultonly-default-rtdb.firebaseio.com', enabled: true },
          { id: 'def67890', url: 'https://vaulttwo-default-rtdb.firebaseio.com', enabled: true },
        ],
      },
      freshSettings: { target: 500, gapMs: 4000 },
    };
    const merged = store.mergeVaultFirebaseState(fakeDb, remote);
    ok(merged.restoredSources === 2 && merged.restoredSettings === 2,
      'vault se missing Firebase sources + settings restore');
    ok(fakeDb.firebaseSources.list.every((s) => s.enabled === true), 'restored sources ACTIVE');
    ok(fakeDb.firebaseSources.seedVersion === 3, 'seedVersion vault se restore');

    // Local delete vault se undo nahi hota
    fakeDb.firebaseSources.deleted = ['https://vaultonly-default-rtdb.firebaseio.com'];
    const db2 = { firebaseSources: { activeId: '', list: [], deleted: [], health: {} }, freshSettings: {} };
    const merged2 = store.mergeVaultFirebaseState(db2, {
      firebaseSources: { ...remote.firebaseSources, deleted: ['https://vaultonly-default-rtdb.firebaseio.com'] },
    });
    ok(merged2.restoredSources === 1
      && !db2.firebaseSources.list.some((s) => /vaultonly/.test(s.url)),
    'vault merge delete-memory ka respect karta hai');
  }
}

// ---------------------------------------------------------------------------
console.log('bot-settings (UI se knobs — validation + clamp):');
{
  const t = bs.getSetting('target');
  ok(Number.isFinite(t) && t >= 1, 'default target mila');
  const r1 = bs.setSetting('target', 150);
  ok(r1.ok && bs.getSetting('target') === 150, 'target set + readback');
  const r2 = bs.setSetting('target', 99999);
  ok(r2.ok === false, 'target over max reject (5000)');
  const r3 = bs.setSetting('target', 0);
  ok(r3.ok === false, 'target under min reject');
  const r4 = bs.setSetting('nope', 5);
  ok(r4.ok === false, 'unknown key reject');
  const r5 = bs.setSetting('gapMs', 30000);
  ok(r5.ok && bs.fmtSetting('gapMs') === '30s', 'gap set + fmt seconds');
  const r6 = bs.setSetting('backoffMs', 900000);
  ok(r6.ok && bs.fmtSetting('backoffMs') === '15 min', 'backoff fmt minutes');
  const r7 = bs.setSetting('allowOffline', true);
  ok(r7.ok && bs.getSetting('allowOffline') === true, 'bool toggle');
  ok(bs.getSetting('concurrency') === 10, 'parallel lanes default = 10');
  const r8 = bs.setSetting('concurrency', 5);
  ok(r8.ok && bs.getSetting('concurrency') === 5, 'parallel lanes set + readback');
  ok(bs.setSetting('concurrency', 11).ok === false, 'parallel lanes 10 se zyada reject');
  ok(bs.setSetting('concurrency', 0).ok === false, 'parallel lanes 0 reject');
  const all = bs.getAllSettings();
  ok(all.target === 150 && all.allowOffline === true && all.concurrency === 5, 'getAllSettings consistent');
  bs.setSetting('target', 100); // restore default
  bs.setSetting('concurrency', 10);
}

// ---------------------------------------------------------------------------
console.log('proxy-pool (IP rotation — "rukna hi na pare"):');
{
  // Parse — saare supported formats
  ok(px.parseProxyUrl('1.2.3.4:8080')?.url === 'http://1.2.3.4:8080', 'host:port → http prefix');
  ok(px.parseProxyUrl('http://user:pass@5.6.7.8:3128')?.auth === 'user:pass', 'user:pass auth parse');
  ok(px.parseProxyUrl('socks5://9.9.9.9:1080')?.url.startsWith('socks5://'), 'socks5 support');
  ok(px.parseProxyUrl('garbage') === null, 'bina port = reject');
  ok(px.parseProxyUrl('ftp://1.1.1.1:21') === null, 'galat protocol reject');
  ok(px.parseProxyUrl('') === null, 'khali reject');

  // CRUD
  const before = px.listProxies().length;
  const dup = px.addProxy('1.2.3.4:8080');
  ok(dup.ok === true && dup.proxy.label === '1.2.3.4:8080', 'proxy add + auto-label');
  ok(px.listProxies().length === before + 1, 'list me add');
  ok(px.addProxy('1.2.3.4:8080').ok === false, 'duplicate reject');
  ok(px.addProxy('not-a-proxy').ok === false, 'galat proxy reject');

  // Rotation ON (addProxy ne khud kiya)
  ok(px.isEnabled() === true, 'proxy add = rotation auto-ON');
  ok(px.proxySummary().enabled === true, 'summary enabled');

  const p2 = px.addProxy('http://user:secret@5.6.7.8:3128');
  ok(p2.ok === true, 'doosra proxy add (auth wala)');
  ok(px.proxySummary().enabledCount === 2, '2 proxies ON');

  // pickProxy — round-robin (dono ko bar-bar pick ho)
  const a = px.pickProxy();
  const b = px.pickProxy();
  ok(a && b && a.id !== b.id, 'round-robin — alag proxy mila');

  // Exclude — jab doosra proxy exclude ho, pehla hi milega
  const c = px.pickProxy({ excludeIds: [a.id] });
  ok(c && c.id !== a.id, 'exclude kaam karta hai');

  // Parallel lane reservations — ek proxy do lanes ko ek saath kabhi
  // nahi milni chahiye, warna "10 alag IP" wala dawa jhootha hoga.
  ok(px.reserveProxy(a.id, 'lane-a') === true, 'lane reservation: pehli lane ko route mila');
  ok(px.reserveProxy(a.id, 'lane-b') === false, 'lane reservation: same IP doosri lane ko reject');
  const reservedPick = px.pickProxy({ reserveFor: 'lane-b' });
  ok(reservedPick?.id === b.id && px.getProxyReservationOwner(b.id) === 'lane-b',
    'lane reservation: picker doosri free IP reserve karke deta hai');
  ok(px.pickProxy({ reserveFor: 'lane-c' }) === null, 'lane reservation: free IP na ho to koi route nahi');
  ok(px.releaseProxyReservation(a.id, 'lane-b') === false, 'lane reservation: ghalat owner release nahi kar sakta');
  ok(px.releaseProxyReservationsForOwner('lane-a') === 1, 'lane reservation: owner ki route release');
  ok(px.releaseProxyReservationsForOwner('lane-b') === 1, 'lane reservation: doosri route bhi release');

  // Per-proxy WAF token (IP-bound hota hai)
  px.setProxyToken(a.id, 'TOKEN_FOR_IP_A'.padEnd(60, 'x'));
  ok(px.getProxyToken(a.id).startsWith('TOKEN_FOR_IP_A'), 'token per-proxy store');
  ok(px.getProxyToken(b.id) === '', 'doosre proxy par wo token nahi (IP-bound)');
  px.invalidateProxyToken(a.id);
  ok(px.getProxyToken(a.id) === '', 'token invalidate');

  // Route priority — jis IP par fresh WAF token pehle se hai, rotation
  // usi ko pehle le (warna har rotate par naya Chromium solve lagta tha).
  px.setProxyToken(b.id, 'TOKEN_FOR_IP_B'.padEnd(60, 'y'));
  ok(px.pickProxy()?.id === b.id, 'picker: fresh-token wali proxy pehle');
  ok(px.pickProxy({ requireToken: true })?.id === b.id, 'picker: requireToken sirf token-ready route');
  ok(px.proxySummary().tokenReadyCount === 1, 'summary: token-ready count');

  // Solver jis proxy par fail hua, use turant dobara mat uthao — full
  // Chromium solve dobara chalana hi 4-minute loop ki asal wajah thi.
  px.markProxyWafSolveFailure(b.id, 60_000);
  const bDetail = px.listProxies().find((x) => x.id === b.id);
  ok(bDetail.wafSolveCooldownLeftMs > 50_000 && bDetail.wafSolveFailures === 1 && !bDetail.tokenReady,
    'solve failure: route quarantine + token clear');
  ok(px.pickProxy()?.id === a.id, 'picker: solve-failed proxy side par');

  // Cooldown — hit hone par proxy thodi der side par
  px.markProxyWafHit(a.id, 60_000);
  const detail = px.listProxies().find((x) => x.id === a.id);
  ok(detail.cooldownLeftMs > 50_000, 'cooldown set (proxy side par)');
  ok(detail.wafHits === 1 && !detail.tokenReady, 'WAF hit: count + jala token clear');
  const d = px.pickProxy({ excludeIds: [] });
  ok(d && d.id !== a.id, 'cooldown wala proxy pick nahi hua');
  ok(px.proxySummary().usableCount === 0 && px.proxySummary().wafCoolingCount >= 1,
    'summary: ON ke bajaye asal usable/cooling proxy count (solve-cooling last-resort ko backup nahi ginta)');
  ok(px.usableProxyCount() === px.proxySummary().usableCount,
    'usableProxyCount: refill decision asal backup count par — sirf enabled total par nahi');

  // Error / success streak
  px.markProxyError(b.id);
  ok(px.listProxies().find((x) => x.id === b.id).consecutiveErrors === 1, 'error count');
  px.markProxySuccess(b.id);
  ok(px.listProxies().find((x) => x.id === b.id).consecutiveErrors === 0, 'success = errors reset');

  // Asal OTP attempt par 5xx/network dene wali route pool me turant wapas
  // nahi ghumni chahiye, lekin ye WAF hit nahi — IP-bound token na jale.
  px.setProxyToken(b.id, 'TRANSIENT_KEEP_TOKEN'.padEnd(60, 't'));
  px.markProxyTransientFailure(b.id, 60_000);
  const transientDetail = px.listProxies().find((x) => x.id === b.id);
  ok(transientDetail.cooldownLeftMs > 50_000
    && transientDetail.transientFailures === 1
    && transientDetail.tokenReady === true,
  'transient proxy failure: 60s route side par, WAF token burn nahi');

  // fetchSwiggy — proxy null ho to plain fetch (backward compat)
  mock.calls.length = 0;
  const r1 = await px.fetchSwiggy('https://www.swiggy.com/dapi/test', {}, null);
  ok(r1 && r1.ok === true, 'proxy null = direct fetch chala');
  ok(mock.calls.length === 1, 'fetch hua (no dispatcher)');

  // puppeteer args
  ok(px.puppeteerProxyArgs({ url: 'http://1.2.3.4:8080' })[0] === '--proxy-server=http://1.2.3.4:8080', 'puppeteer proxy arg');
  ok(px.puppeteerProxyArgs(null).length === 0, 'proxy null = koi arg nahi');

  // Cleanup — tests ke baad pool khali (dobara run clean ho)
  px.removeProxy(a.id);
  px.removeProxy(b.id);
  ok(px.listProxies().length === before, 'cleanup ke baad list wapas');
  px.setPoolEnabled(false);
  ok(px.isEnabled() === false, 'rotation OFF kar diya');
}

// ---------------------------------------------------------------------------
console.log('autopilot-engine (singleton state):');
ok(isAutopilotRunning() === false, 'shuru me running nahi');
ok(requestAutopilotStop('manual') === false, 'na chalne wale batch ko stop = false');
{
  const snap = getAutopilotSnapshot();
  ok(snap.running === false && snap.processed === 0, 'default snapshot clean');
  ok(snap.concurrency >= 1 && Array.isArray(snap.activeNumbers) && snap.activeWorkers === 0,
    'snapshot: parallel lane fields maujood');
  ok(snap.poolLoaded === false && 'poolSourceName' in snap && 'poolSourcesTotal' in snap,
    'snapshot: pool loading vs loaded-empty + Firebase source fields maujood');
  ok(formatPoolStatus({ poolLoaded: false, poolFresh: 0, poolTotal: 0 }) === 'load ho raha hai…',
    'pool asal me load ho raha ho tabhi loading text');
  ok(formatPoolStatus({ poolLoaded: true, poolFresh: 0, poolTotal: 0 }).startsWith('0 fresh / 0 numbers'),
    'loaded-empty pool ko loading nahi dikhaya jata');
  ok(formatPoolStatus({ poolLoaded: false, poolFresh: 0, poolTotal: 0, finishedAt: Date.now() }).startsWith('0 fresh / 0 numbers'),
    'finished run ki final summary loading par nahi atki rehti');
  ok(formatFirebaseSourceStatus({ poolSourceName: 'tinku-152d3', poolSourcesTried: 3, poolSourcesTotal: 56 }).includes('source 3/56'),
    'Firebase card current source + fallback progress dikhata hai');
  ok(poolExhaustedReasonText({ poolTotal: 0, processed: 0, poolSourcesTried: 56, poolSourcesTotal: 56 }).includes('Kisi ACTIVE Firebase source se valid number nahi mila'),
    '0-processed summary jhootha “saare process ho gaye” nahi kehta');
  ok('scanCandidateOnline' in snap && 'scanCandidateUnknown' in snap && 'scanCandidateOffline' in snap,
    'snapshot: scanner candidate status counts maujood');
  ok(formatScanCandidateStates({ scanCandidateOnline: 3, scanCandidateUnknown: 5, scanCandidateOffline: 7 }) === 'ONLINE 3 · status-unknown 5 · offline 7',
    'scanner card: ONLINE/unknown/offline alag-alag dikhte hain');
  ok(formatScanCandidateStates({}) === '', 'scanner card: koi candidate count na ho to khali text');
  ok(noEvidenceWaitPassLimit({ hasNextSource: true }) === 1,
    'dead source: agla Firebase ho to sirf 1 retry pass, phir rotate');
  ok(noEvidenceWaitPassLimit({ hasNextSource: false }) === 40,
    'dead source: aakhri/ekmatra source par lambi fresh-wait policy barqarar');
  ok(poolExhaustedReasonText({
    poolTotal: 693, processed: 0, poolSourcesTried: 56, poolSourcesTotal: 56,
    scanCandidateOnline: 0, scanCandidateUnknown: 640, scanCandidateOffline: 0,
  }).includes('SMS timestamp ya ONLINE saboot nahi mila'),
    '0-processed dead scan: summary asal no-evidence wajah batati hai');
  ok(normalizeBatchConcurrency(99) === 10, 'parallel lanes max 10 par cap');
  ok(normalizeBatchConcurrency(0) === 1, 'parallel lanes min 1');
  ok(normalizeBatchConcurrency('x') === 10, 'parallel lanes invalid value par default 10');
  ok(availableParallelLanes({ requested: 10, proxyEnabled: false, enabledProxyCount: 0 }) === 1,
    'direct-only mode: ek hi IP isliye 1 lane');
  ok(availableParallelLanes({ requested: 10, proxyEnabled: true, enabledProxyCount: 9 }) === 10,
    '9 proxies + 1 direct = 10 distinct lanes');
  ok(availableParallelLanes({ requested: 10, proxyEnabled: true, enabledProxyCount: 3 }) === 4,
    'routes kam hon to lanes bhi distinct routes tak limited');
  ok(availableParallelLanes({ requested: 3, proxyEnabled: true, enabledProxyCount: 9 }) === 3,
    'user ki requested lane limit respect hoti hai');
  ok(parallelWorkerUserId('owner-1', 7) === 'owner-1:lane7', 'har lane ki bridge session ID alag');
}

// ---------------------------------------------------------------------------
console.log('Render keep-alive (free Web Service neend rokna):');
{
  ok(keepAlive.resolveKeepAliveUrl({ RENDER_EXTERNAL_URL: 'https://demo-bot.onrender.com' }) === 'https://demo-bot.onrender.com/health',
    'Render external URL root → /health');
  ok(keepAlive.resolveKeepAliveUrl({ KEEP_ALIVE_URL: 'https://demo-bot.onrender.com/robots.txt' }) === 'https://demo-bot.onrender.com/health',
    'robots.txt wala galat cron URL /health par fix');
  ok(keepAlive.resolveKeepAliveUrl({ KEEP_ALIVE_URL: 'https://demo-bot.onrender.com/custom-health' }) === 'https://demo-bot.onrender.com/custom-health',
    'custom health path respect');
  ok(keepAlive.resolveKeepAliveUrl({ RENDER_EXTERNAL_HOSTNAME: 'demo-bot.onrender.com' }) === 'https://demo-bot.onrender.com/health',
    'Render hostname fallback');
  ok(keepAlive.resolveKeepAliveUrl({ KEEP_ALIVE_URL: 'http://localhost:10000/health' }) === '',
    'localhost ping reject (Render idle timer reset nahi hota)');
  ok(keepAlive.isKeepAliveEnabled({ KEEP_ALIVE: '0' }) === false, 'KEEP_ALIVE=0 par disable');
  ok(keepAlive.keepAliveIntervalMs({}) === 5 * 60_000, 'default interval 5 min (15 min neend se pehle)');
  ok(keepAlive.keepAliveIntervalMs({ KEEP_ALIVE_INTERVAL_MINUTES: '30' }) === 14 * 60_000,
    'interval max 14 min par clamp (15+ par service so jayegi)');

  let scheduled = null;
  const fakeSetTimeout = (fn, ms) => {
    scheduled = { fn, ms };
    return { unref() {} };
  };
  const fakeClearTimeout = () => { scheduled = null; };
  let pingCalls = 0;
  let pingShouldFail = false;
  const handle = keepAlive.startKeepAlive({
    env: { RENDER_EXTERNAL_URL: 'https://demo-bot.onrender.com' },
    fetchImpl: async () => {
      pingCalls++;
      if (pingShouldFail) throw new Error('network down');
      return { ok: true, status: 200, text: async () => '{"ok":true}' };
    },
    logger: { log() {}, warn() {} },
    setTimeoutImpl: fakeSetTimeout,
    clearTimeoutImpl: fakeClearTimeout,
  });
  ok(handle.getState().enabled === true && scheduled?.ms === 30_000, 'self-ping schedule hota hai');
  await scheduled.fn();
  ok(pingCalls === 1 && handle.getState().successes === 1 && scheduled?.ms === 5 * 60_000,
    'successful ping ke baad agla 5 min par');
  pingShouldFail = true;
  await scheduled.fn();
  ok(handle.getState().failures === 1 && scheduled?.ms === 30_000, 'failed ping 30s me retry (neend se pehle)');
  handle.stop();
  ok(scheduled === null, 'stop par timer clear');
}

// ---------------------------------------------------------------------------
console.log('chrome discovery + proxy dispatcher (2026 fixes):');
{
  const bridge = await import('./swiggy-bridge.js');
  // Env me maujud file do to wahi mile (process.execPath hamesha exist karta hai)
  const prevEnv = process.env.PUPPETEER_EXECUTABLE_PATH;
  process.env.PUPPETEER_EXECUTABLE_PATH = process.execPath;
  ok(bridge.findChromePath() === process.execPath, 'PUPPETEER_EXECUTABLE_PATH (valid file) respect');
  // Env me GALAT path ho to usi jhoothe path par latke na rahe — auto-detect
  process.env.PUPPETEER_EXECUTABLE_PATH = '/definitely/not/chrome-xyz.exe';
  ok(bridge.findChromePath() !== '/definitely/not/chrome-xyz.exe', 'galat env Chrome path par fallback (latakta nahi)');
  if (prevEnv === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH;
  else process.env.PUPPETEER_EXECUTABLE_PATH = prevEnv;

  const cs = bridge.getChromeStatus();
  ok(typeof cs.found === 'boolean' && 'path' in cs && 'headless' in cs, 'getChromeStatus shape (found/path/headless)');

  // Kaunsa undici agent kis protocol par — socks5 ko HTTP agent na mile
  ok(px.dispatcherKind('http://1.2.3.4:8080') === 'http', 'http proxy → http dispatcher');
  ok(px.dispatcherKind('https://1.2.3.4:8443') === 'http', 'https proxy → http dispatcher');
  ok(px.dispatcherKind('socks5://1.2.3.4:1080') === 'socks5', 'socks5 proxy → socks5 dispatcher');
  ok(px.dispatcherKind('socks4://1.2.3.4:1080') === 'unsupported', 'socks4 → unsupported (saaf error milega)');
  ok(px.dispatcherKind('not-a-url') === 'unsupported', 'ganda URL → unsupported');

  // WAF solver coalescing route-keyed hai — ek proxy ka token doosri
  // proxy ke solver promise se leak nahi hona chahiye.
  ok(bridge._wafSolveRouteKey(null) === 'direct', 'WAF solver route-key: direct');
  ok(bridge._wafSolveRouteKey({ id: 'proxy-a' }) !== bridge._wafSolveRouteKey({ id: 'proxy-b' }),
    'WAF solver route-key: har proxy alag (IP-bound token safety)');
  ok(bridge.WAF_SOLVE_FAST_BUDGET_MS === 15_000
    && bridge.WAF_SOLVE_RELIABLE_BUDGET_MS === 45_000
    && bridge.normalizeWafSolveBudgetMs(45_000) === 45_000
    && bridge.normalizeWafSolveBudgetMs(999_000) === 60_000
    && bridge.normalizeWafSolveBudgetMs(0) === 45_000,
  'WAF solver: reliable 45s budget 15s hard cap me band nahi (slow proxy par token ban sakta hai)');

  // Challenge ke baad current proxy ka token asal me burn hona chahiye.
  // Pehle sirf direct/shared cache saaf hota tha — retry wahi jala token
  // dobara chipka deti thi.
  const burnProxy = px.addProxy('8.8.8.8:8080').proxy;
  px.setProxyToken(burnProxy.id, 'BURN_ME'.padEnd(60, 'z'));
  bridge.setBridgeProxy(burnProxy);
  bridge.burnCurrentWafToken();
  ok(px.getProxyToken(burnProxy.id) === '', 'burnCurrentWafToken: per-proxy jala token clear');
  bridge.setBridgeProxy(null);
  px.removeProxy(burnProxy.id);
  px.setPoolEnabled(false);

  // Lane-local bridge routes — do parallel contexts ek dusre ki IP
  // kabhi overwrite na karein. Ye naive Promise.all wale sabse bare
  // corruption bug ki regression guard hai.
  const laneRouteA = { id: 'lane-route-a', label: 'lane A' };
  const laneRouteA2 = { id: 'lane-route-a2', label: 'lane A rotated' };
  const laneRouteB = { id: 'lane-route-b', label: 'lane B' };
  const laneRoutesSeen = await Promise.all([
    bridge.runWithBridgeProxy(laneRouteA, async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      bridge.setBridgeProxy(laneRouteA2);
      return bridge.getBridgeProxy()?.id;
    }, { owner: 'test-lane-a' }),
    bridge.runWithBridgeProxy(laneRouteB, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return bridge.getBridgeProxy()?.id;
    }, { owner: 'test-lane-b' }),
  ]);
  ok(laneRoutesSeen[0] === 'lane-route-a2' && laneRoutesSeen[1] === 'lane-route-b',
    'bridge ALS: parallel lanes ki IPs alag rehti hain');
  ok(bridge.getBridgeProxy() === null, 'bridge ALS: lane rotate global route ko touch nahi karta');
  ok(px.getProxyReservationOwner('lane-route-a2') === '' && px.getProxyReservationOwner('lane-route-b') === '',
    'bridge ALS: context khatam hone par reservations release');
  let laneRouteConflict = false;
  await bridge.runWithBridgeProxy(laneRouteA, async () => {
    try {
      await bridge.runWithBridgeProxy(laneRouteA, async () => {}, { owner: 'test-lane-other' });
    } catch { laneRouteConflict = true; }
  }, { owner: 'test-lane-a' });
  ok(laneRouteConflict === true, 'bridge ALS: reserved IP doosri lane ko reject');

  // Security route policy — 3 proxy challenges ke baad kharab pool me
  // ghoomne ke bajaye direct, 2 direct challenges ke baad best proxy wapas.
  const engine = await import('./autopilot-engine.js');
  ok(engine.securityRouteAction({ proxyEnabled: true, proxyChallenges: 2 }) === 'rotate_proxy',
    'security route: 2 proxy challenges tak rotate');
  ok(engine.securityRouteAction({ proxyEnabled: true, proxyChallenges: 3 }) === 'direct_fallback',
    'security route: 3 proxy challenges ke baad direct fallback');
  ok(engine.securityRouteAction({ proxyEnabled: true, usingDirectFallback: true, directChallenges: 1 }) === 'direct_cooldown',
    'security route: pehla direct challenge cooldown');
  ok(engine.securityRouteAction({ proxyEnabled: true, usingDirectFallback: true, directChallenges: 2 }) === 'restore_proxy',
    'security route: 2 direct challenges ke baad proxy restore');
  ok(engine.securityRouteAction({ proxyEnabled: false, proxyChallenges: 0 }) === 'direct_cooldown',
    'security route: proxy OFF par direct cooldown');
  ok(engine.securityChallengeRouteKind({
    proxyEnabled: true,
    routeModeAtStart: 'proxy',
    proxyIdAtStart: 'proxy-a',
    finalProxyId: '',
  }) === 'proxy', 'security route kind: proxy episode ko final empty ID par direct mat gino');
  ok(engine.securityChallengeRouteKind({
    proxyEnabled: true,
    routeModeAtStart: 'direct-fallback',
    proxyIdAtStart: '',
    finalProxyId: '',
  }) === 'direct', 'security route kind: direct-fallback episode direct hi hai');
}

// ---------------------------------------------------------------------------
console.log('isUnregisteredSwiggyAuthResponse (failed_otp_send wala bug):');
{
  const bridge = await import('./swiggy-bridge.js');
  const det = bridge.isUnregisteredSwiggyAuthResponse;
  // ASLI BUG: raw JSON me `csrfToken` field hone se purana detector
  // "user not registered" ko bhi reject kar deta tha → har naya number fail
  const newUser = { statusCode: 1, statusMessage: 'user not registered', csrfToken: 'tok123', tid: 't1' };
  ok(det({ status: 200, data: newUser, rawText: JSON.stringify(newUser) }) === true,
    'csrfToken field ke bawjood "user not registered" detect (REGRESSION)');
  ok(det({ status: 200, data: { statusCode: 1, statusMessage: 'Invalid OTP' }, rawText: '' }) === false,
    'Invalid OTP → unregistered NAHI');
  ok(det({ status: 200, data: { statusCode: 1, statusMessage: 'Invalid CSRF token' }, rawText: '' }) === false,
    'asli CSRF error → unregistered NAHI');
  ok(det({ status: 200, data: { statusCode: 0, statusMessage: 'OTP sent successfully', csrfToken: 'x' }, rawText: '{"csrfToken":"x"}' }) === false,
    'normal OTP-sent (registered number) → false');
  ok(det({ status: 200, data: { statusCode: 999, statusMessage: '' }, rawText: '' }) === true,
    'statusCode 999 → unregistered');
  ok(det({ status: 200, data: { statusCode: 1, statusMessage: 'Too many requests, rate limit' }, rawText: '' }) === false,
    'rate limit → unregistered NAHI');
  ok(det({ status: 403, data: { statusCode: 1, statusMessage: 'user not registered' }, rawText: '' }) === false,
    'HTTP 403 par kabhi true nahi');
  ok(det(null) === false && det(undefined) === false, 'null/undefined safe');
}

// ---------------------------------------------------------------------------
console.log('Swiggy temporary 5xx/network — one-shot OTP number consumed, retry sirf next number:');
{
  const bridge = await import('./swiggy-bridge.js');
  const pipe = await import('./number-pipeline.js');
  const engine = await import('./autopilot-engine.js');

  const serverErr = bridge.parseSwiggyOtpError({
    status: 500,
    rawText: '{"statusCode":1,"statusMessage":"Internal server error"}',
    data: { statusCode: 1, statusMessage: 'Internal server error' },
  });
  ok(serverErr.code === 'SWIGGY_SERVER_ERROR' && serverErr.retryable === true,
    'asal HTTP 500 response → SWIGGY_SERVER_ERROR (retryable)');

  const systemErr = bridge.parseSwiggyOtpError({
    status: 500,
    error: 'ECONNRESET socket hang up',
    rawText: '',
    data: { statusMessage: 'ECONNRESET socket hang up' },
  });
  ok(systemErr.code === 'SYSTEM_ERROR' && /ECONNRESET/.test(systemErr.message),
    'proxy/network exception wala synthetic 500 → SYSTEM_ERROR (asli wajah barkarar)');

  const c1 = pipe._classifyOtpSendFailure({
    success: false,
    code: 'SWIGGY_SERVER_ERROR',
    httpStatus: 500,
    retryable: true,
    message: serverErr.message,
  }, '6306779573');
  ok(c1.kind === 'deferred_swiggy_transient'
    && c1.retryable === false
    && c1.routeRetryable === true
    && c1.otpFailure === true
    && c1.otpAttemptConsumed === true
    && c1.otpAttempts === 1
    && c1.httpStatus === 500
    && c1.stage === 'otp_send',
    'pipeline: HTTP 500 par route recover hoga, number one-shot consumed hai');

  const c2 = pipe._classifyOtpSendFailure({
    success: false,
    code: 'SYSTEM_ERROR',
    httpStatus: 0,
    retryable: true,
    message: systemErr.message,
  }, '6306779573', { failKind: 'failed_fresh_otp_send', stage: 'fresh_otp_send' });
  ok(c2.kind === 'deferred_swiggy_transient'
    && c2.retryable === false
    && c2.routeRetryable === true
    && c2.otpFailure === true
    && c2.otpAttemptConsumed === true
    && c2.stage === 'fresh_otp_send',
    'pipeline: network/system error par bhi wahi number dobara OTP nahi lega');

  const c3 = pipe._classifyOtpSendFailure({
    success: false,
    code: 'INVALID_MOBILE',
    httpStatus: 400,
    retryable: false,
    message: 'invalid',
  }, '12345');
  ok(c3.kind === 'failed_otp_send', 'pipeline: invalid mobile transient nahi — asli failed_otp_send');

  const rateOneShot = pipe._classifyOtpSendFailure({ success: false, code: 'SWIGGY_RATE_LIMIT', message: 'limit' }, '9812345670');
  const securityOneShot = pipe._classifyOtpSendFailure({ success: false, code: 'SWIGGY_SECURITY_CHALLENGE', message: 'waf' }, '9812345670');
  ok(
    rateOneShot.kind === 'rate_limited'
    && rateOneShot.otpAttemptConsumed === true
    && securityOneShot.kind === 'security_challenge'
    && securityOneShot.otpAttemptConsumed === true,
  'pipeline: rate/security route recovery karegi, lekin ye number run me dubara nahi');
  ok(pipe._classifyOtpSendFailure({ success: true }, '9812345670') === null,
    'pipeline: successful OTP send par failure classification null');

  ok(engine.transientSwiggyRetryWaitMs(1) === 15_000
    && engine.transientSwiggyRetryWaitMs(2) === 30_000
    && engine.transientSwiggyRetryWaitMs(3) === 45_000
    && engine.transientSwiggyRetryWaitMs(99) === 45_000,
  'engine: transient cool-off ladder 15s→30s→45s cap');
  ok(engine.rateLimitRecoveryWaitMs(1, 10 * 60_000) === 15_000
    && engine.rateLimitRecoveryWaitMs(2, 10 * 60_000) === 30_000
    && engine.fastRouteRecoveryCapMs(10 * 60_000) === 15_000,
  'engine: rate-limit/WAF pehli recovery max 15s (number queue me fasa nahi)');
  ok(engine.telegramInfraRetryDecision({
    telegramMode: true, willRetry: true, phone: '9876543210', stage: 'otp_send',
  }) === false, 'Hermes: OTP-send fail par same-number retry hamesha OFF');
  ok(engine.telegramInfraRetryDecision({
    telegramMode: true, willRetry: true, phone: '9876543210', stage: 'fresh_otp_send',
  }) === false, 'Hermes: fresh OTP-send fail par bhi next NEW NUMBER');
  ok(engine.telegramInfraRetryDecision({
    telegramMode: true, willRetry: true, phone: '9876543210', stage: 'verify',
  }) === false
    && engine.telegramInfraRetryDecision({
      telegramMode: false, willRetry: true, phone: '9876543210', stage: 'otp_send',
    }) === false
    && engine.telegramInfraRetryDecision({
      telegramMode: true, willRetry: false, phone: '9876543210', stage: 'otp_send',
    }) === false,
  'Hermes: aadha process / Firebase mode / cap khatam par current-number replay nahi');
  ok(engine.routeClaimReadiness({
    proxy: { id: 'p1', quality: 'challenged' },
    routeState: { tokenReady: true },
  }).ready === true, 'route gate: token-ready challenged proxy claim ke liye ready');
  ok(engine.routeClaimReadiness({
    proxy: { id: 'p1', quality: 'clean' },
    routeState: { tokenReady: false, wafSolveCooldownLeftMs: 60_000 },
  }).action === 'rotate', 'route gate: tokenless solve-cooling proxy par naya number claim nahi');
  ok(engine.routeClaimReadiness({
    proxy: { id: 'p1', quality: 'challenged' },
    routeState: { tokenReady: false },
  }).action === 'solve'
    && engine.routeClaimReadiness({
      proxy: { id: 'p2', quality: 'clean' },
      routeState: { tokenReady: false },
    }).rawFallback === true,
  'route gate: challenged ko token solve, clean ko solve ke baad raw fallback mauqa');
  ok(
    engine.isOneShotOtpFailureResult({ ok: false, kind: 'failed_verify', stage: 'otp_verify' }) === true
    && engine.isOneShotOtpFailureResult({ ok: false, kind: 'failed_otp_miss', stage: 'otp_wait' }) === true
    && engine.isOneShotOtpFailureResult({ ok: false, kind: 'deferred_swiggy_transient', stage: 'otp_send' }) === true
    && engine.isOneShotOtpFailureResult({ ok: false, kind: 'manual_skip', stage: 'manual_skip' }) === false
    && engine.isOneShotOtpFailureResult({ ok: true, kind: 'fresh_new', stage: 'otp_send' }) === false,
    'engine: OTP send/wait/verify failures one-shot consumed; manual/fresh alag'
  );
  ok(
    engine.nextNumberGapMs({ telegramMode: true, outcome: 'failed', configuredGapMs: 6_000 }) === 0
    && engine.nextNumberGapMs({ telegramMode: true, outcome: 'manual_skip', configuredGapMs: 6_000 }) === 0
    && engine.nextNumberGapMs({ telegramMode: true, outcome: 'ok', configuredGapMs: 6_000 }) === 1_000
    && engine.nextNumberGapMs({ telegramMode: false, outcome: 'failed', configuredGapMs: 6_000 }) === 6_000,
    'engine: Hermes me fail/skip ke baad 6s gap nahi; success max 1s'
  );
  const snap = engine.getAutopilotSnapshot();
  ok(
    Number.isFinite(snap.serverErrors)
    && Number.isFinite(snap.transientStrikes)
    && Number.isFinite(snap.telegramInfraRetries)
    && Number.isFinite(snap.manualSkips)
    && Number.isFinite(snap.otpFailures)
    && typeof snap.skipRequested === 'boolean',
    'engine snapshot: recovery + SKIP + one-shot OTP counters maujood');
}

// ---------------------------------------------------------------------------
console.log('device last-seen gate (mare hue device par OTP waste nahi):');
{
  const fbn = await import('./firebase-numbers.js');
  const pipe = await import('./number-pipeline.js');
  const now = Date.now();
  mock.messages['devFresh'] = {
    [String(now - 5000)]: { message: 'hello', dateTime: '' },
    '42': { message: 'old inbox', dateTime: '01-01-2025 | 10:00 AM' },
  };
  mock.messages['devStale'] = { '7': { message: 'purana', dateTime: '01-01-2025 | 10:00 AM' } };

  const t1 = await fbn.fetchDeviceLastActivityMs('devFresh');
  ok(t1 === now - 5000, 'epoch-ms key se last activity mili (chhote inbox ids ignore)');
  ok(mock.calls.at(-1).includes('messages/devFresh') && mock.calls.at(-1).includes('limitToLast=5'),
    'last-seen probe halki hai: pehle sirf last 5 messages (50 full SMS nahi)');
  const t2 = await fbn.fetchDeviceLastActivityMs('devStale');
  ok(Boolean(t2) && (now - t2) > 60_000, 'purani dateTime wali activity stale pehchani');
  ok((await fbn.fetchDeviceLastActivityMs('devMissing')) === null, 'khali/missing device → null');

  // Agar last 5 entries me koi parseable timestamp na ho to purani
  // 50-entry query fallback ke tor par chalegi.
  mock.messages['devOdd'] = {
    a: { message: 'old but parseable', dateTime: '01-01-2025 | 10:00 AM' },
    b: { message: 'no date 1' },
    c: { message: 'no date 2' },
    d: { message: 'no date 3' },
    e: { message: 'no date 4' },
    f: { message: 'no date 5' },
  };
  const oddCallsBefore = mock.calls.length;
  const tOdd = await fbn.fetchDeviceLastActivityMs('devOdd');
  const oddCalls = mock.calls.slice(oddCallsBefore).filter((u) => u.includes('messages/devOdd'));
  ok(Boolean(tOdd) && oddCalls.length === 2 && oddCalls[1].includes('limitToLast=50'),
    'last 5 me timestamp na mile to 50-entry fallback query');

  // Stale device: OTP request Swiggy tak jani hi nahi chahiye
  const callsBefore = mock.calls.length;
  const r1 = await pipe.processSingleNumber({
    userId: 'test',
    entry: { phone: '9812345672', deviceId: 'devStale', online: true },
    otpCfg: { activeWindowMs: 60_000, waitMs: 0, timeoutMs: 100 },
  });
  ok(r1.kind === 'deferred_device_stale', 'stale device → deferred_device_stale (OTP nahi bheja)');
  ok(!mock.calls.slice(callsBefore).some((u) => u.includes('swiggy.com')), 'stale par Swiggy ko ek bhi request nahi gayi');
  ok(r1.ok === false && Boolean(r1.reason), 'stale result me wajah hai');

  // Pipeline-level hard gate: retry/hot queue me purani entry reh bhi jaye
  // to recently extracted number OTP se pehle hi ruk jaye.
  pipe.markLedger('9812345671', 'success');
  const rCooldown = await pipe.processSingleNumber({
    userId: 'test',
    entry: { phone: '9812345671', deviceId: 'devFresh', online: true },
    otpCfg: { activeWindowMs: 60_000, waitMs: 0, timeoutMs: 100 },
  });
  ok(rCooldown.kind === 'deferred_number_cooldown', '7-day cooldown: pipeline extracted number ko OTP se pehle rokta hai');

  // Fresh device: gate pass karke bridge tak jaye. Galat-format number rakha
  // taaki bridge bina network ke turant INVALID_MOBILE de (test pure rahe) —
  // pipeline use failed_otp_send me map karegi, matlab gate PASS hua tha.
  const r2 = await pipe.processSingleNumber({
    userId: 'test',
    entry: { phone: '12345', deviceId: 'devFresh', online: true },
    otpCfg: { activeWindowMs: 60_000, waitMs: 0, timeoutMs: 100 },
  });
  ok(r2.kind === 'failed_otp_send', 'fresh device gate pass (bridge tak gaya)');

  // Gate off (0): stale device bhi aage badhe
  const r3 = await pipe.processSingleNumber({
    userId: 'test',
    entry: { phone: '12345', deviceId: 'devStale', online: true },
    otpCfg: { activeWindowMs: 0, waitMs: 0, timeoutMs: 100 },
  });
  ok(r3.kind === 'failed_otp_send', 'activeWindowMs=0 → gate off, stale bhi aage gaya');

  // Autopilot ladder mode: selected device ki activity fixed limit se
  // bahar ho to pipeline use stale kehne ke bajaye window double karke
  // aage badhegi. Invalid-format number par bridge wala failed_otp_send
  // hi saboot hai ke gate pass hua.
  const r4 = await pipe.processSingleNumber({
    userId: 'test',
    entry: { phone: '12345', deviceId: 'devStale', online: true },
    otpCfg: {
      activeWindowMs: 10_000, waitMs: 0, timeoutMs: 100,
      widenLastSeenByDoubling: true,
    },
  });
  ok(r4.kind === 'failed_otp_send', 'pipeline doubling: purani activity bhi ladder se gate pass (stale loop nahi)');

  // Scanner ka explicit clients-ONLINE fallback: device ke paas koi SMS
  // timestamp hi na ho tab bhi pipeline use stale keh kar wapas scan par
  // nahi bhejegi. SMS ka na aana device band honay ka saboot nahi hai.
  const r5 = await pipe.processSingleNumber({
    userId: 'test',
    entry: { phone: '12345', deviceId: 'devMissing', online: true },
    otpCfg: {
      activeWindowMs: 10_000, waitMs: 0, timeoutMs: 100,
      skipLastSeenGate: true,
    },
  });
  ok(r5.kind === 'failed_otp_send', 'pipeline ONLINE fallback: SMS timestamp na ho tab bhi gate pass');
}

// ---------------------------------------------------------------------------
console.log('parallel device scan (hot-queue) + pipeline precheck:');
{
  const fbn = await import('./firebase-numbers.js');
  const pipe = await import('./number-pipeline.js');
  const now = Date.now();
  const mkEntries = (n) => Array.from({ length: n }, (_, i) => ({
    phone: String(9000000000 + i), deviceId: `D${i}`, online: true,
  }));

  // fetchDevicesLastActivityMs — parallel probe + dedupe + error → null
  {
    const calls = [];
    const probe = async (id) => {
      calls.push(id);
      if (id === 'boom') throw new Error('fb gone');
      return id === 'hot' ? now - 1000 : null;
    };
    const m = await fbn.fetchDevicesLastActivityMs(['hot', 'cold', 'hot', 'boom', ''], { concurrency: 2, probe });
    ok(m.get('hot') === now - 1000 && m.get('cold') === null && m.get('boom') === null, 'probe map sahi (error → null)');
    ok(calls.filter((c) => c === 'hot').length === 1 && calls.length === 3, 'duplicate deviceIds dedupe hue');
  }

  // scanFreshDevices — window ke andar fresh, sorted desc, want milte hi stop
  {
    const probe = async (id) => (id === 'D3' ? now - 5000 : id === 'D7' ? now - 2000 : null);
    const r = await fbn.scanFreshDevices(mkEntries(500), { windowMs: 60_000, want: 2, chunkSize: 50, maxProbe: 800, probe });
    ok(r.widened === false && r.fresh.length === 2, 'window ke andar 2 fresh mile (widen nahi hua)');
    ok(r.fresh[0].entry.deviceId === 'D7' && r.fresh[1].entry.deviceId === 'D3', 'sabse taaza device sabse pehle (sorted)');
    ok(r.checked === 50 && r.exhausted === false, 'want milte hi scan ruk gaya (poora pool scan nahi kiya)');
    ok(r.probedDeviceIds.length === 50, 'probedDeviceIds wapas mile (engine dubara probe nahi karega)');
  }

  // scanFreshDevices — window me koi na mile to widen (best-available), 15m+ purane exclude
  {
    const probe = async (id) =>
      id === 'D40' ? now - 5 * 60_000 :
      id === 'D90' ? now - 10 * 60_000 :
      id === 'D60' ? now - 2 * 3600_000 : null;
    const r = await fbn.scanFreshDevices(mkEntries(300), { windowMs: 60_000, want: 8, chunkSize: 50, maxProbe: 120, maxWidenMs: 15 * 60_000, probe });
    ok(r.widened === true, 'window empty → widen hua (batch atka nahi)');
    ok(r.fresh.length === 2 && r.fresh[0].entry.deviceId === 'D40', 'widened me sabse taaza pehle, 2h-purana exclude');
    ok(r.widestWindowMs > 60_000 && r.checked === 120, 'widestWindowMs asal age tak badha + maxProbe respect');
  }

  // Generic cap mode — maxWidenMs = windowMs ho to purani activity fresh
  // nahi banti. (Engine ab is mode ki jagah neeche wala doubling ladder
  // use karta hai.)
  {
    const probe = async (id) => (id === 'D2' ? now - 30_000 : null);
    const r = await fbn.scanFreshDevices(mkEntries(20), {
      windowMs: 10_000, maxWidenMs: 10_000, want: 1, chunkSize: 20, probe,
    });
    ok(r.fresh.length === 0 && r.widened === false && r.widestWindowMs === 10_000,
      'cap mode: maxWiden=window par 10s se purani activity fresh nahi banti');
  }

  // Doubling ladder — base 10s me koi na mile to ISI pass ke cached
  // timestamps par 20s → 40s → 80s → 160s ... Firebase ko har ladder step
  // par dobara scan nahi karna chahiye.
  {
    ok(fbn.doubledWidenWindowMs(10_000, 10_000) === 10_000 &&
      fbn.doubledWidenWindowMs(10_000, 10_001) === 20_000 &&
      fbn.doubledWidenWindowMs(10_000, 40_001) === 80_000 &&
      fbn.doubledWidenWindowMs(10_000, 120_000) === 160_000,
    'doubling helper: 10s → 20s → 40s → 80s → 160s');

    const calls = [];
    const probe = async (id) => {
      calls.push(id);
      return id === 'D2' ? now - 97_000 : id === 'D5' ? now - 300_000 : null;
    };
    const r = await fbn.scanFreshDevices(mkEntries(20), {
      windowMs: 10_000,
      maxWidenMs: Number.POSITIVE_INFINITY,
      widenByDoubling: true,
      want: 1,
      chunkSize: 20,
      maxProbe: 20,
      probe,
    });
    ok(r.fresh.length === 1 && r.fresh[0].entry.deviceId === 'D2' && r.fresh[0].windowMs === 160_000,
      'doubling ladder: 97s purani sabse taazi activity ≤160s window me mili');
    ok(r.widened === true && r.widestWindowMs === 160_000 && r.checked === 20 && calls.length === 20,
      'doubling ladder: ek hi pass ke cached probes reuse (koi rescan nahi)');
  }

  // Ranked backups + early ladder: full pool khatam hone ka intezaar nahi.
  // Pehle chunk ke baad hi ≤20s/40s wala candidate mil jaye to backups ke
  // saath return, aur pehla miss ho to agla cached device engine ke paas hai.
  {
    const calls = [];
    const probe = async (id) => {
      calls.push(id);
      await new Promise((resolve) => setTimeout(resolve, 2));
      return id === 'D2' ? now - 15_000 : id === 'D3' ? now - 18_000 : id === 'D90' ? now - 1000 : null;
    };
    const r = await fbn.scanFreshDevices(mkEntries(100), {
      windowMs: 10_000,
      maxWidenMs: Number.POSITIVE_INFINITY,
      widenByDoubling: true,
      earlyWidenStepMs: 1,
      backupCount: 2,
      want: 1,
      chunkSize: 20,
      maxProbe: 100,
      probe,
    });
    ok(r.checked === 20 && calls.length === 20 && r.exhausted === false,
      'early ladder: full pool scan kiye baghair pehle chunk ke baad return');
    ok(r.fresh.length === 2 && r.fresh[0].entry.deviceId === 'D2' && r.fresh[1].entry.deviceId === 'D3',
      'early ladder: ranked backup devices bhi mile (agla miss par rescan nahi)');
    ok(r.earlyWidened === true && r.fresh[0].windowMs === 20_000,
      'early ladder: 15s activity ≤20s window me select');
  }

  // Hard quick-scan budget: agar koi bhi device ki last SMS taazi nahi hai
  // (zinda device ko bhi dinon SMS nahi aata), to full pool ghumane ke
  // bajaye budget ke andar probed sample ka sabse taaza device mil jaye.
  {
    const calls = [];
    const probe = async (id) => {
      calls.push(id);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return id === 'D2' ? now - 2 * 24 * 3600_000 : id === 'D90' ? now - 1000 : null;
    };
    const r = await fbn.scanFreshDevices(mkEntries(100), {
      windowMs: 10_000,
      maxWidenMs: Number.POSITIVE_INFINITY,
      widenByDoubling: true,
      maxScanMs: 1,
      backupCount: 2,
      want: 1,
      chunkSize: 20,
      maxProbe: 100,
      probe,
    });
    ok(r.scanTimedOut === true && r.checked === 20 && calls.length === 20 && r.exhausted === false,
      'quick-scan budget: deadline par full pool scan ruk gaya');
    ok(r.fresh.length === 1 && r.fresh[0].entry.deviceId === 'D2' && r.bestLastActivityMs === now - 2 * 24 * 3600_000,
      'quick-scan budget: probed sample ka sabse taaza SMS device process ke liye mila');
  }

  // ONLINE fallback: probed sample me SMS timestamp ek bhi na ho, lekin
  // clients status ONLINE ho, to scanner khali haath lot kar dobara scan
  // nahi ghumayega — online devices ko explicit flag ke saath dega.
  {
    const calls = [];
    const probe = async (id) => {
      calls.push(id);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return null;
    };
    const r = await fbn.scanFreshDevices(mkEntries(100), {
      windowMs: 10_000,
      maxWidenMs: Number.POSITIVE_INFINITY,
      widenByDoubling: true,
      maxScanMs: 1,
      onlineFallback: true,
      backupCount: 2,
      want: 1,
      chunkSize: 20,
      maxProbe: 100,
      probe,
    });
    ok(r.scanTimedOut === true && r.checked === 20 && calls.length === 20,
      'ONLINE fallback: deadline ke baad baqi pool scan nahi hua');
    ok(r.onlineFallback === true && r.fresh.length === 2 && r.fresh.every((f) => f.onlineFallback && !f.lastActivityMs),
      'ONLINE fallback: SMS timestamp na hone par clients-online backups mile');
  }

  // Status-unknown ONLINE nahi hota: timestamp bhi na ho to scanner usay
  // blind process nahi karega. Sirf pakka online=true fallback chalega.
  {
    const unknownOnly = await fbn.scanFreshDevices([
      { phone: '9876503001', deviceId: 'UNK1', online: undefined },
      { phone: '9876503002', deviceId: 'UNK2' },
      { phone: '9876503003', deviceId: 'OFF1', online: false },
    ], { windowMs: 10_000, onlineFallback: true, probe: async () => null });
    ok(unknownOnly.fresh.length === 0 && unknownOnly.onlineFallback === false && unknownOnly.exhausted === true,
      'ONLINE fallback: status-unknown/offline ko bina SMS timestamp blind process nahi');
    const mixed = await fbn.scanFreshDevices([
      { phone: '9876503011', deviceId: 'UNK9', online: undefined },
      { phone: '9876503012', deviceId: 'ON9', online: true },
    ], { windowMs: 10_000, onlineFallback: true, backupCount: 2, probe: async () => null });
    ok(mixed.fresh.length === 1 && mixed.fresh[0].entry.deviceId === 'ON9',
      'ONLINE fallback: mixed pool me sirf pakka ONLINE device select');
  }

  // scanFreshDevices — bilkul khali activity → fresh [] + exhausted
  {
    const r = await fbn.scanFreshDevices(mkEntries(10), { windowMs: 60_000, probe: async () => null });
    ok(r.fresh.length === 0 && r.exhausted === true && r.checked === 10, 'kuch na mile → fresh [] + exhausted');
    const r2 = await fbn.scanFreshDevices([{ phone: '9812345670' }], { probe: async () => now });
    ok(r2.totalDevices === 0 && r2.fresh.length === 0, 'deviceId bina entries skip');
  }

  // Pipeline precheck — engine ke scan ka result reuse (live stale data par bhi pass)
  {
    // mock devStale ki live activity purani (2025) hai. Fresh precheck diya to
    // gate usi par pass hona chahiye (refetch karta to deferred ho jata).
    const r1 = await pipe.processSingleNumber({
      userId: 'test',
      entry: { phone: '12345', deviceId: 'devStale', online: true },
      otpCfg: { activeWindowMs: 60_000, waitMs: 0, timeoutMs: 100, precheckedLastActivityMs: now - 3000, precheckedAt: now },
    });
    ok(r1.kind === 'failed_otp_send', 'fresh precheck → gate pass bina refetch ke (bridge tak gaya)');

    // Precheck EXPired (2 min purana) → live refetch → device asal me stale → deferred
    const r2 = await pipe.processSingleNumber({
      userId: 'test',
      entry: { phone: '12345', deviceId: 'devStale', online: true },
      otpCfg: { activeWindowMs: 60_000, waitMs: 0, timeoutMs: 100, precheckedLastActivityMs: now - 3000, precheckedAt: now - 120_000 },
    });
    ok(r2.kind === 'deferred_device_stale', 'expired precheck → live refetch → stale defer');

    // Scan ke baad queue me activity 10s window se baahar ho gayi, lekin
    // mock devFresh par live taazi activity maujud hai. Purana code 45s ke
    // andar wala precheck hi use karke number ko galat stale keh deta tha;
    // ab window se bahar precheck par live refetch lazmi hai.
    const r3 = await pipe.processSingleNumber({
      userId: 'test',
      entry: { phone: '12345', deviceId: 'devFresh', online: true },
      otpCfg: {
        activeWindowMs: 10_000, waitMs: 0, timeoutMs: 100,
        precheckedLastActivityMs: now - 30_000, precheckedAt: now,
      },
    });
    ok(r3.kind === 'failed_otp_send', 'window se bahar precheck → live refetch → taazi activity par gate pass');
  }
}

// ---------------------------------------------------------------------------
console.log('fresh JSON chat me turant bhejna (export + engine notify):');
{
  const store = await import('./store.js');
  const engine = await import('./autopilot-engine.js');
  const bridge = await import('./swiggy-bridge.js');

  // Bridge ke diye exportJson ko waisi ka waisa tarjeeh
  const bridgeJson = { account: 'AK1', name: 'Naya', phone: '9812345670', token: 'TOK', cookies: 'x=y' };
  ok(store.getSessionExportJson('AK1', { exportJson: bridgeJson }) === bridgeJson,
    'bridge exportJson passthrough (wahi fresh JSON chat me jayega)');

  // Bridge ka na mile to DB ke saved account se wahi shape banao
  store.updateAccount('TESTEXPORT1', {
    name: 'Test User', swiggyName: 'Swg', botTag: 'tag1', phone: '9812345670',
    customerId: 'CUST9', token: 'TOKEN9', tid: 'TID9', sid: 'SID9', deviceId: 'DEV9',
    isLoggedIn: true, savedAt: '2026-10-24T00:00:00.000Z',
  });
  const rebuilt = store.getSessionExportJson('TESTEXPORT1', null);
  ok(Boolean(rebuilt) && rebuilt.account === 'TESTEXPORT1' && rebuilt.token === 'TOKEN9'
    && rebuilt.tid === 'TID9' && rebuilt.sid === 'SID9' && rebuilt.deviceId === 'DEV9'
    && rebuilt.phone === '9812345670' && rebuilt.mobile === '9812345670'
    && rebuilt.customerId === 'CUST9',
    'DB account se export shape rebuild (token/tid/sid/phone sahi)');

  ok(store.getSessionExportJson('NO_SUCH_ACCOUNT_XYZ', null) === null, 'account na mile → null (crash nahi)');

  // Engine notify — fresh bante hi ui.sendSession ko payload jaye
  const sent = [];
  const uiOk = { sendSession: async (p) => { sent.push(p); } };
  ok(engine.notifyFreshSession(uiOk, { phone: '9812345670', accountKey: 'AK1', kind: 'fresh_new', account: { exportJson: bridgeJson } }) === true,
    'notifyFreshSession → sendSession bulaaya');
  ok(sent.length === 1 && sent[0].phone === '9812345670' && sent[0].accountKey === 'AK1' && sent[0].kind === 'fresh_new',
    'payload me phone/accountKey/kind sahi gaya');

  ok(engine.notifyFreshSession({}, {}) === false && engine.notifyFreshSession(null, {}) === false,
    'sendSession na ho → false (batch normal chalta rahe)');

  ok(engine.notifyFreshSession({ sendSession: () => { throw new Error('tg down'); } }, {}) === false,
    'sendSession throw kare → bhi crash nahi');

  const rej = engine.notifyFreshSession({ sendSession: async () => { throw new Error('tg 500'); } }, {});
  ok(rej === true, 'async reject fire-and-forget (batch nahi rukta)');
  await new Promise((r) => setTimeout(r, 10)); // unhandledRejection hota to yahin crash hota

  // JSON har 2–3 ghante me dobara isliye maangna padta tha kyunki web
  // login ka JWT short-life hota hai. Export se pehle / /session par
  // Android chkout se lambi-life JWT rotate hogi; guest ya dusre
  // customer ka JWT kabhi accept nahi hoga.
  const jwtNowMs = Date.parse('2026-11-04T00:00:00.000Z');
  const jwtNowSec = Math.floor(jwtNowMs / 1000);
  const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const makeJwt = ({ user = '123456', iat = jwtNowSec, exp }) => [
    b64url({ alg: 'none', typ: 'JWT' }),
    b64url({ user_id: user, iat, exp }),
    'sig',
  ].join('.');
  const shortJwt = makeJwt({ exp: jwtNowSec + 2 * 60 * 60 });
  const longJwt = makeJwt({ exp: jwtNowSec + 30 * 24 * 60 * 60 });
  const guestJwt = makeJwt({ user: '0', exp: jwtNowSec + 30 * 24 * 60 * 60 });
  const expiredJwt = makeJwt({ iat: jwtNowSec - 3 * 60 * 60, exp: jwtNowSec - 10 * 60 });
  const dapiJwt = makeJwt({ exp: jwtNowSec + 3 * 60 * 60 });
  const jsonResponse = (data, status = 200) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    text: async () => JSON.stringify(data),
    json: async () => data,
  });

  const shortInfo = bridge.getSwiggyJwtSessionInfo(shortJwt, jwtNowMs);
  const longInfo = bridge.getSwiggyJwtSessionInfo(longJwt, jwtNowMs);
  ok(shortInfo.customerId === '123456' && shortInfo.isShortLived && shortInfo.remainingMs === 2 * 60 * 60 * 1000,
    'session life: 2-hour web JWT short-lived pehchana jata hai');
  ok(longInfo.isLongLived && longInfo.remainingMs === 30 * 24 * 60 * 60 * 1000,
    'session life: 30-day Android JWT long-lived pehchana jata hai');

  const baseCreds = {
    phone: '9812345670',
    customerId: '123456',
    tid: shortJwt,
    token: 'TOKEN9',
    sid: 'SID9',
    deviceId: 'DEV9',
    _session_tid: 'SESSION-TID-9',
    cookies: `tid=${shortJwt}; _session_tid=SESSION-TID-9; token=TOKEN9; _sid=SID9; _device_id=DEV9; _is_logged_in=1`,
  };
  const rotated = await bridge.refreshSwiggySessionCredentials(baseCreds, {
    nowMs: jwtNowMs,
    allowDapiFallback: false,
    fetchImpl: async (url) => {
      ok(String(url).includes('chkout.swiggy.com'), 'session refresh: Android chkout rotation endpoint use hota hai');
      return jsonResponse({ statusCode: 0, tid: longJwt, sid: 'SIDLONG', deviceId: 'DEVLONG' });
    },
  });
  ok(rotated.ok && rotated.refreshed && rotated.tid === longJwt && rotated.longLived,
    'session refresh: short web JWT export se pehle 30-day JWT se rotate hota hai');
  ok(rotated.cookies.includes(`tid=${longJwt}`) && rotated.cookies.includes('_session_tid=SESSION-TID-9'),
    'session refresh: rotated JWT cookies me bhi save hota hai, _session_tid gayab nahi hota');
  const aliasRotated = await bridge.refreshSwiggySessionCredentials({
    ...baseCreds,
    token: shortJwt,
    cookies: `tid=${shortJwt}; _session_tid=SESSION-TID-9; token=${shortJwt}; _sid=SID9; _device_id=DEV9; _is_logged_in=1`,
  }, {
    nowMs: jwtNowMs,
    allowDapiFallback: false,
    fetchImpl: async () => jsonResponse({ statusCode: 0, tid: longJwt }),
  });
  ok(aliasRotated.token === longJwt && aliasRotated.cookies.includes(`token=${longJwt}`),
    'session refresh: token agar purane short JWT ki copy ho to woh bhi long JWT se badalta hai');

  const guestRejected = await bridge.refreshSwiggySessionCredentials(baseCreds, {
    nowMs: jwtNowMs,
    allowDapiFallback: false,
    fetchImpl: async () => jsonResponse({ statusCode: 0, tid: guestJwt }),
  });
  ok(guestRejected.tid === shortJwt && !guestRejected.refreshed,
    'session refresh: guest JWT ko long session kehkar accept nahi karta');

  let chkoutCalls = 0;
  const expiredRecovered = await bridge.refreshSwiggySessionCredentials({
    ...baseCreds,
    tid: expiredJwt,
    cookies: `tid=${expiredJwt}; _session_tid=SESSION-TID-9; token=TOKEN9; _sid=SID9; _device_id=DEV9; _is_logged_in=1`,
  }, {
    nowMs: jwtNowMs,
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes('chkout.swiggy.com')) {
        chkoutCalls++;
        return chkoutCalls === 1
          ? jsonResponse({ statusCode: 999, statusMessage: 'expired' })
          : jsonResponse({ statusCode: 0, tid: longJwt, sid: 'SIDLONG', deviceId: 'DEVLONG' });
      }
      if (u.includes('/dapi/profile/info')) {
        return jsonResponse({
          statusCode: 0,
          tid: dapiJwt,
          sid: 'SIDDAPI',
          deviceId: 'DEVDAPI',
          data: { customer_id: '123456', token: 'TOKEN-DAPI' },
        });
      }
      return jsonResponse({ statusCode: 1, statusMessage: 'unexpected test URL' }, 404);
    },
  });
  ok(expiredRecovered.ok && expiredRecovered.tid === longJwt && chkoutCalls === 2,
    'session refresh: expired JWT + zinda _session_tid se bina naya OTP liye session refresh hota hai');

  store.updateAccount('TEST_LONG_SESSION', {
    name: 'Long Session Test',
    phone: '9812345670',
    customerId: '123456',
    _session_tid: 'SESSION-TID-9',
    token: 'TOKEN9',
    tid: shortJwt,
    sid: 'SID9',
    deviceId: 'DEV9',
    cookies: baseCreds.cookies,
    isLoggedIn: true,
    savedAt: '2026-11-04T00:00:00.000Z',
  });
  const savedRefresh = await bridge.refreshSavedSwiggySession('TEST_LONG_SESSION', {
    nowMs: jwtNowMs,
    allowDapiFallback: false,
    fetchImpl: async () => jsonResponse({ statusCode: 0, tid: longJwt, sid: 'SIDLONG', deviceId: 'DEVLONG' }),
  });
  const persistedLong = store.getDb()?.config?.accounts?.TEST_LONG_SESSION;
  const longExport = store.getSessionExportJson('TEST_LONG_SESSION', null);
  ok(savedRefresh.ok && persistedLong?.tid === longJwt && persistedLong?.jwtTid === longJwt
    && persistedLong?._session_tid === 'SESSION-TID-9' && persistedLong?.sessionLongLived === true,
    'saved session refresh: rotated 30-day JWT DB me persist hota hai');
  ok(longExport?.tid === longJwt && longExport?.jwtTid === longJwt
    && longExport?._session_tid === 'SESSION-TID-9'
    && longExport?.tidExpiresAt === new Date(longInfo.expiresAtMs).toISOString()
    && longExport?.sessionLongLived === true,
    'saved session refresh: /session wala JSON updated long-life token ke saath banta hai');
}

// ---------------------------------------------------------------------------
console.log('WAF challenge survival (jala token invalidate + batch-marta-nahi ladder):');
{
  const wafPool = await import('./waf-pool.js');
  const engine = await import('./autopilot-engine.js');
  const bridge = await import('./swiggy-bridge.js');
  const fakeToken = 't'.repeat(80);

  // Seed → mile; invalidate → gayab (challenge ke baad jala token reuse na ho)
  ok(wafPool.seedToken(fakeToken, { source: 'manual' }) === true && wafPool.getTokenSync() === fakeToken,
    'seedToken ke baad token milta hai');
  wafPool.invalidateToken();
  ok(wafPool.getTokenSync() === '', 'invalidateToken ke baad token nahi milta');

  // TTL 30 min — 31 min purana token dead (pehle 2h tak jala token chalta rehta tha)
  wafPool.seedToken(fakeToken, { source: 'manual', acquiredAt: Date.now() - 31 * 60_000 });
  ok(wafPool.getTokenSync() === '', '31 min purana token TTL se bahar (fresh solve hoga)');

  // Challenge (markWafHit) → token turant invalidate + cooldown lag jaye
  wafPool.seedToken(fakeToken, { source: 'manual' });
  wafPool.markWafHit();
  ok(wafPool.getTokenSync() === '', 'markWafHit par jala token invalidate ho gaya');
  ok(wafPool.cooldownRemainingMs() > 0, 'markWafHit par circuit-breaker cooldown laga');
  wafPool.clearCooldown();
  ok(wafPool.cooldownRemainingMs() === 0, 'clearCooldown reset karta hai');
  ok(bridge.DIRECT_WAF_SOLVE_FAILURE_COOLDOWN_MS === 60_000 && bridge._directWafSolveCooldownLeftMs() === 0,
    'direct WAF solver failure par short cooldown hai — har claim par 45s dobara nahi jalega');

  // Engine wait ladder: 5s → 10s → 15s cap; pool cooldown chahe lamba
  // bole, route recovery 15s se upar number ko queue me nahi latkati.
  ok(engine.wafChallengeWaitMs(1, 0) === 5_000, 'ladder strike1 = 5s (fast route recovery)');
  ok(engine.wafChallengeWaitMs(2, 0) === 10_000 && engine.wafChallengeWaitMs(3, 0) === 15_000, 'ladder strike2/3 = 10s/15s');
  ok(engine.wafChallengeWaitMs(9, 0) === 15_000, 'ladder cap 15s (strike chahe kitne bhi)');
  ok(engine.wafChallengeWaitMs(1, 4 * 60_000) === 15_000, 'lamba pool cooldown bhi 15s par cap');
  ok(engine.wafChallengeWaitMs(1, 30 * 60_000) === 15_000, 'ek saath max 15s (batch consistent rahe)');
  ok(engine.wafChallengeWaitMs(0, 0) === 5_000, 'strikes 0/invalid → pehla step (5s)');
}

// ---------------------------------------------------------------------------
console.log('🌐 free proxies auto-fetch (ProxyScrape parse/rank/probe/refresh):');
{
  const pp = await import('./proxy-pool.js');
  const before = pp.proxySummary();

  // JSON parse — socks4 + dead bahar, fields mapped
  const sample = {
    proxies: [
      { proxy: 'socks5://1.2.3.4:1080', protocol: 'socks5', alive: true, ssl: true, uptime: 90, average_timeout: 800, ip_data: { countryCode: 'IN', hosting: false } },
      { proxy: 'socks4://5.6.7.8:4145', protocol: 'socks4', alive: true, ssl: true, uptime: 99, average_timeout: 100, ip_data: { countryCode: 'IN', hosting: false } },
      { proxy: 'http://9.9.9.9:8080', protocol: 'http', alive: false, ssl: true, uptime: 99, average_timeout: 100, ip_data: { countryCode: 'US', hosting: true } },
      { proxy: 'http://8.8.8.8:3128', protocol: 'http', alive: true, ssl: true, uptime: 70, average_timeout: 1500, ip_data: { countryCode: 'US', hosting: true } },
    ],
  };
  const parsed = pp._parseFreeProxyListJson(sample);
  ok(parsed.length === 2, 'JSON: socks4 + dead exclude, 2 kaam ke bache');
  ok(parsed[0].country === 'IN' && parsed[0].hosting === false && parsed[0].avgTimeoutMs === 800, 'JSON: country/hosting/timeout fields mapped');

  // GitHub shard / Proxifly array shapes bhi parse hon (multi-source v2)
  const generic = pp._parseFreeProxyListJson([
    { protocol: 'http', ip: '4.4.4.4', port: 8080, country_code: 'IN', uptime_percent: 88, latency_ms: 250, anonymity: 'elite', ssl: true },
    { proxy: 'socks5://5.5.5.5:1080', geolocation: { country: 'IN' }, score: 2, https: true },
  ]);
  ok(generic.length === 2 && generic[0].country === 'IN' && generic[0].uptime === 88 && generic[0].avgTimeoutMs === 250 && generic[0].ssl === true,
    'JSON arrays: GitHub/Proxifly metadata mapped');

  // Text parse
  const txt = pp._parseFreeProxyListText('socks5://1.1.1.1:1080\nGARBAGE LINE\nhttp://2.2.2.2:8080\nsocks4://3.3.3.3:1080\n');
  ok(txt.length === 2, 'text: garbage + socks4 exclude');
  const bareSocks = pp._parseFreeProxyListText('7.7.7.7:1080\n', { defaultProtocol: 'socks5', country: 'IN' });
  ok(bareSocks.length === 1 && bareSocks[0].url.startsWith('socks5://') && bareSocks[0].country === 'IN',
    'text: bare ip:port par source protocol/country apply');

  // Ranking — IN pehle, phir non-hosting, phir uptime/timeout
  const ranked = pp._rankFreeCandidates([
    { url: 'http://us-host:1', country: 'US', hosting: true, uptime: 99, avgTimeoutMs: 100 },
    { url: 'http://in-host:1', country: 'IN', hosting: true, uptime: 50, avgTimeoutMs: 900 },
    { url: 'http://in-resi:1', country: 'IN', hosting: false, uptime: 40, avgTimeoutMs: 500 },
    { url: 'http://de-resi:1', country: 'DE', hosting: false, uptime: 95, avgTimeoutMs: 200 },
    { url: 'http://in-resi:1', country: 'IN', hosting: false, uptime: 40, avgTimeoutMs: 500 }, // duplicate
  ]);
  ok(ranked.length === 4 && ranked[0].url.includes('in-resi') && ranked[1].url.includes('in-host') && ranked[2].url.includes('de-resi'),
    'ranking: IN residential sab se pehle + dedupe');

  // Ek hi IP ke kai ports probe queue ke top par ghus kar diversity na marein
  const diversified = pp._rankFreeCandidates([
    { url: 'http://same-host:1001', country: 'IN', uptime: 100, avgTimeoutMs: 100, ssl: true },
    { url: 'http://same-host:1002', country: 'IN', uptime: 99, avgTimeoutMs: 100, ssl: true },
    { url: 'http://other-host:1003', country: 'IN', uptime: 98, avgTimeoutMs: 100, ssl: true },
  ]);
  ok(diversified[1].url.includes('other-host'), 'ranking: per-IP diversity (same host ke ports peeche)');
  ok(ranked[0].sourceCount === 2, 'ranking: duplicate sources corroboration count me merge');

  // Probe — early stop + tez pehle sorted
  {
    const cands = Array.from({ length: 30 }, (_, i) => ({ url: `http://bad${i}:80`, country: '', hosting: false, uptime: 0, avgTimeoutMs: 1 }));
    cands[10] = { url: 'http://good-slow:80', country: '', hosting: false, uptime: 0, avgTimeoutMs: 1 };
    cands[11] = { url: 'http://good-fast:80', country: '', hosting: false, uptime: 0, avgTimeoutMs: 1 };
    const check = async (c) => c.url.includes('good-fast') ? { ok: true, latencyMs: 90 }
      : c.url.includes('good-slow') ? { ok: true, latencyMs: 400 } : { ok: false, latencyMs: 10 };
    const r = await pp.probeFreeCandidates(cands, { want: 2, concurrency: 4, check });
    ok(r.good.length === 2 && r.good[0].url.includes('good-fast'), 'probe: 2 zinda mile, tez wala pehle');
    ok(r.checked < 30, 'probe: want milte hi ruk gaya (poori list nahi parkhi)');
  }

  // Challenged-but-reachable fallback — clean pehle, WAF-ready baad me.
  // (Yahi purani "0 proxies" ki ek wajah thi: challenged = dead phenk dete the.)
  {
    const cands = [
      { url: 'http://challenged-fast:80', country: 'IN', hosting: false, uptime: 90, avgTimeoutMs: 100 },
      { url: 'http://clean-slow:80', country: 'IN', hosting: false, uptime: 80, avgTimeoutMs: 100 },
      { url: 'http://dead-one:80', country: 'IN', hosting: false, uptime: 10, avgTimeoutMs: 100 },
    ];
    const tierCheck = async (c) => c.url.includes('clean')
      ? { ok: true, quality: 'clean', latencyMs: 500, status: 200 }
      : c.url.includes('challenged')
        ? { ok: true, quality: 'challenged', challenged: true, latencyMs: 50, status: 403 }
        : { ok: false, quality: 'dead', latencyMs: 10, reason: 'ECONNREFUSED' };
    const r = await pp.probeFreeCandidates(cands, { want: 2, concurrency: 2, check: tierCheck });
    ok(r.good.length === 2 && r.good[0].quality === 'clean' && r.good[1].quality === 'challenged',
      'probe tiers: clean pehle, WAF-challenged fallback baad me');
    ok(r.cleanCount === 1 && r.challengedCount === 1 && r.stats.dead === 1 && r.stats.reasons[0]?.reason === 'ECONNREFUSED',
      'probe diagnostics: clean/challenged/dead + top reason');
  }

  // REGRESSION: npm undici agent global fetch ke saath incompatible tha
  // ("invalid onRequestStart method") — har check network se pehle fail.
  // Band local port par ab asli ECONNREFUSED aana chahiye, compat error nahi.
  {
    const r = await pp.checkProxyOnce('http://127.0.0.1:9', { timeoutMs: 1500 });
    ok(r.ok === false && r.quality === 'dead' && !/onRequestStart|UND_ERR_INVALID_ARG/i.test(r.reason || ''),
      'undici regression: dispatcher apne hi fetch se chalta hai (no onRequestStart)');
  }

  // Local loopback par asal HTTP proxy se end-to-end — sirf compat error
  // gayab hona kaafi nahi, request proxy hokar origin tak jaani chahiye.
  {
    const http = await import('node:http');
    const origin = http.createServer((req, res) => {
      if (req.url === '/generic') { res.writeHead(204); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok');
    });
    const proxy = http.createServer((req, res) => {
      const upstream = http.request(req.url, { method: req.method, headers: req.headers }, (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(upstream);
    });
    await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    try {
      const originBase = `http://127.0.0.1:${origin.address().port}`;
      const r = await pp.checkProxyOnce(`http://127.0.0.1:${proxy.address().port}`, {
        timeoutMs: 2500,
        genericTarget: `${originBase}/generic`,
        target: `${originBase}/swiggy`,
      });
      ok(r.ok === true && r.quality === 'clean' && r.genericStatus === 204 && r.status === 200,
        'undici regression: local HTTP proxy se asal request origin tak gayi');

      // Sticky-route regression: session-bound request fail ho to
      // fetchSwiggy khud doosri IP se chup-chaap retry NAHI karega.
      // Cookies/WAF token pehli IP ke hote hain; rotation bridge/engine
      // ki explicit recovery hi karegi.
      const goodProxy = pp.addProxy(`http://127.0.0.1:${proxy.address().port}`).proxy;
      const badProxy = pp.addProxy('127.0.0.1:9').proxy;
      let stickyThrew = false;
      try {
        await pp.fetchSwiggy(`${originBase}/swiggy`, { signal: AbortSignal.timeout(2000) }, badProxy);
      } catch {
        stickyThrew = true;
      }
      ok(stickyThrew === true, 'fetchSwiggy sticky: bad route par silent alternate-IP retry nahi');
      pp.removeProxy(goodProxy.id);
      pp.removeProxy(badProxy.id);
      if (!before.enabled) pp.setPoolEnabled(false);
    } finally {
      await Promise.allSettled([
        new Promise((resolve) => proxy.close(resolve)),
        new Promise((resolve) => origin.close(resolve)),
      ]);
    }
  }

  // Refresh glue — injected list + check; pool me auto entries; dobara me zinda ki id barkarar
  const fetchImpl = async () => ({ ok: true, text: async () => JSON.stringify(sample) });
  const okCheck = async (c) => ({ ok: true, latencyMs: 120, status: 200 });
  const r1 = await pp.refreshFreeProxies({ want: 2, fetchImpl, check: okCheck });
  ok(r1.ok && r1.added === 2, 'refresh: 2 auto proxies pool me gayin');
  const autos1 = pp.listProxies().filter((p) => p.auto);
  ok(autos1.length === 2 && autos1.every((p) => p.enabled), 'auto entries enabled + tagged hain');
  const keepId = autos1.find((p) => p.url.includes('1.2.3.4'))?.id;

  const pickyCheck = async (c) => ({ ok: c.url.includes('1.2.3.4'), latencyMs: 100, status: 200 });
  const r2 = await pp.refreshFreeProxies({ want: 2, fetchImpl, check: pickyCheck });
  const autos2 = pp.listProxies().filter((p) => p.auto);
  ok(r2.added === 1 && autos2.length === 1 && autos2[0].id === keepId,
    'dusra refresh: mari hui auto nikal gayi, zinda ki ID wahi rahi (token continuity)');

  // Multi-source v2: baki sources fail hon tab bhi ek zinda source kaafi;
  // sirf WAF-challenged reachable mile to bhi pool 0 nahi rehta.
  const oneSourceFetch = async (url) => {
    if (!String(url).includes('api.proxyscrape.com')) throw new Error('source down');
    return { ok: true, text: async () => JSON.stringify(sample) };
  };
  const challengedCheck = async (c) => c.url.includes('1.2.3.4')
    ? { ok: true, quality: 'challenged', challenged: true, latencyMs: 140, status: 403 }
    : { ok: false, quality: 'dead', latencyMs: 10, reason: 'timeout' };
  const r3 = await pp.refreshFreeProxies({ want: 2, fetchImpl: oneSourceFetch, check: challengedCheck });
  const autos3 = pp.listProxies().filter((p) => p.auto);
  ok(r3.added === 1 && autos3.length === 1 && autos3[0].id === keepId && autos3[0].quality === 'challenged',
    'refresh v2: ek source + sirf WAF-ready proxy par bhi pool me entry');
  ok(r3.sourcesOk >= 1 && r3.sourcesTotal >= 15 && r3.candidates >= 2 && r3.stats?.challenged === 1,
    'refresh v2: source/candidate/tier diagnostics wapas');

  // Kill switch — env 0 par auto band
  process.env.PREMIUM_AUTO_FREE_PROXIES = '0';
  ok(pp.freeProxiesEnabled() === false, 'PREMIUM_AUTO_FREE_PROXIES=0 → auto-fetch OFF');
  const skipped = await pp.ensureFreeProxies({ min: 99 });
  ok(skipped.skipped === true && skipped.reason === 'disabled', 'ensureFreeProxies disabled par seedha skip');
  delete process.env.PREMIUM_AUTO_FREE_PROXIES;

  // Cleanup — test DB ko wapas waisa chhodo jaisa mila tha
  for (const p of pp.listProxies().filter((x) => x.auto)) pp.removeProxy(p.id);
  if (!before.enabled) pp.setPoolEnabled(false);
}

// ---------------------------------------------------------------------------
console.log('telegram Hermes source + Add Telegram Account primitives:');
{
  const tg = await import('./telegram-otp-source.js');
  const engine = await import('./autopilot-engine.js');
  const bridge = await import('./swiggy-bridge.js');
  const store = await import('./store.js');
  const rich = await import('./rich-text.js');

  tg._resetTelegramOtpSourceForTests();

  // Compact live UI: mono values + ek chhota flow card. Lambi pool/scan
  // diagnostics is card me wapas nahi ghusni chahiye.
  ok(rich.mono('98765<43210&') === '<code>98765&lt;43210&amp;</code>', 'mono helper value ko escape karke <code> me rakhta hai');
  ok(rich.progressBar(3, 10).includes('3/10') && rich.progressBar(3, 10).includes('▰') && rich.progressBar(3, 10).includes('▱'), 'progress bar soft blocks + done/total dikhata hai');
  ok(rich.progressBar(3, 10).includes('30%'), 'progress bar percentage bhi dikhata hai');
  ok(rich.progressBar(99, 10).includes('99/10') && !rich.progressBar(99, 10).includes('▱'), 'progress bar over-target par full rehta hai, crash nahi');
  ok(rich.statusCard('LIVE', ['one', '', 'two']).includes('<b>LIVE</b>') && !rich.statusCard('LIVE', ['one', '', 'two']).includes('\n\n'), 'statusCard khali lines hata kar compact card banata hai');
  const compactLive = engine.formatCompactAutopilotCard({
    sourceMode: 'telegram', running: true, target: 10, fresh: 2, processed: 3, failed: 1,
    addressAdded: 1, startedAt: Date.now() - 65_000, elapsedMs: 65_000,
    current: { phone: '9876543210' }, activeNumbers: [{ phone: '9876543210' }],
    telegramCurrentPhone: '9876543210', concurrency: 1,
  }, { stageText: rich.section('🔎 OTP Wait', 'REFRESH par naya OTP dhoondh raha hoon') });
  ok(compactLive.includes('[REFRESH]') && compactLive.includes('HERMES ONLY') && compactLive.includes('Firebase') && compactLive.includes('<code>OFF</code>'), 'compact live card: REFRESH step + Hermes-only/Firebase OFF lock saaf');
  ok(compactLive.includes('<code>9876543210</code>') && compactLive.includes('2/10') && compactLive.includes('ADDR 1/2'), 'compact live card: current number + progress + verified address count mono me');
  ok(!compactLive.includes('Device scan') && !compactLive.includes('Parallel lanes') && compactLive.length < 900, 'compact live card purani lambi diagnostics nahi dohrata');
  const compactAddress = engine.formatCompactAutopilotCard({
    sourceMode: 'telegram', running: true, target: 10, fresh: 2, processed: 3,
    current: { phone: '9876543210' }, elapsedMs: 90_000,
  }, { stageText: rich.section('🏠 Address Add Ho Raha Hai', 'Swiggy Add Address page par Maharashtra address save + verify ho raha hai') });
  ok(compactAddress.includes('[ADDR]') && compactAddress.includes('Swiggy me address add ho raha hai'), 'compact live card asal Add Address step ko ADDR dikhata hai');
  const compactFinal = engine.formatCompactAutopilotCard({
    sourceMode: 'telegram', running: false, stopReason: 'manual', target: 10, fresh: 1,
    processed: 2, failed: 1, addressAdded: 1, elapsedMs: 120_000,
    freshAccounts: [{ phone: '9876543210', accountKey: 'AK1' }],
  }, { final: true });
  ok(compactFinal.includes('BATCH KHATAM') && compactFinal.includes('Aapne STOP kiya') && compactFinal.includes('Fresh JSON chat me'), 'compact final card asal stop reason + JSON note deta hai');
  const compactHermesClaim = engine.formatCompactAutopilotCard({
    sourceMode: 'telegram', running: true, target: 100, fresh: 0, processed: 0,
    elapsedMs: 12_000, telegramClaimPhase: 'clicked-new',
    telegramLastClickedButton: '🗳 NEW NUMBER', telegramLastActionAt: Date.now(),
    telegramScreenButtons: ['🗳 NEW NUMBER', '✅ REFRESH'],
  }, { stageText: rich.section('📨 Hermes Number Claim', 'Hermes se new number claim ho raha hai') });
  ok(compactHermesClaim.includes('[NEW]') && compactHermesClaim.includes('NEW NUMBER click — number card ka wait'),
    'compact live card Hermes ka asal latest-screen click dikhata hai');
  const recoverySnapshot = engine.getAutopilotSnapshot();
  ok(recoverySnapshot.telegramClaimRetries === 0 && recoverySnapshot.workerRecoveries === 0
    && recoverySnapshot.addressAdded === 0 && recoverySnapshot.addressFailed === 0, 'snapshot: claim-retry/worker-recovery/address counters maujood');
  ok(Array.isArray(recoverySnapshot.telegramScreenButtons)
    && recoverySnapshot.telegramLastClickedButton === ''
    && recoverySnapshot.telegramClaimPhase === '',
    'snapshot: Hermes latest-screen/click diagnostics fields maujood');

  // Visible Hermeshu labels: FIND strict hai; SEARCH/ACTIVE ko FIND nahi
  // samjha jayega, warna bot galat screen par ja sakta hai.
  ok(tg.telegramButtonRole('FIND NUMBER') === 'find', 'Hermes FIND NUMBER → find');
  ok(tg.telegramButtonRole('🔍 FIND NUMBER') === 'find', 'emoji ke saath FIND NUMBER → find');
  ok(tg.telegramButtonRole('SEARCH NUMBER') === '', 'Hermes SEARCH NUMBER FIND nahi hai');
  ok(tg.telegramButtonRole('ACTIVE NUMBERS') === '', 'Hermes ACTIVE NUMBERS FIND nahi hai');
  ok(tg.telegramButtonRole('NEW NUMBER') === 'new', 'Hermes NEW NUMBER → new');
  ok(tg.telegramButtonRole('REFRESH') === 'refresh', 'Hermes REFRESH → refresh');

  const welcomeOnly = [
    'WELCOME TO Hermes',
    'FIND NUMBER • SEARCH NUMBER • ACTIVE NUMBERS',
  ].join('\n');
  ok(tg.parseTelegramNumberCard(welcomeOnly) === null, 'welcome card bina phone ke number card nahi banta');

  const cardText = [
    'YOUR NUMBER: +91 98765 43210',
    'STATUS: ACTIVE',
    'DEVICE: DEVICE-TEST-1',
    'LAST SMS: [NEWSWI-GY] OTP: 123456',
    '01/01/2026 | 10:15 AM',
  ].join('\n');
  const parsedCard = tg.parseTelegramNumberCard(cardText);
  ok(parsedCard?.phone === '9876543210', 'Hermes number card se 10-digit phone parsed');
  ok(parsedCard?.status === 'ACTIVE', 'Hermes card STATUS ACTIVE parsed');
  ok(parsedCard?.device === 'DEVICE-TEST-1', 'Hermes card device parsed');
  ok(parsedCard?.sender === 'NEWSWI-GY' && parsedCard?.code === '123456', 'Hermes LAST SMS sender + OTP parsed');
  ok(tg.extractTelegramOtpFromText('SENDER: VM-SWIGGY\nYour OTP is 654321') === '654321', 'SENDER label wale Hermes text se OTP');
  ok(tg.parseTelegramNumberCard('WELCOME TO Hermes\nNAME: RAHUL\nID: 7458637854\nFIND NUMBER') === null,
    'welcome card ki Telegram ID ko Hermes mobile number nahi mana jata');

  // Owner ka exact click rule sirf CURRENT/latest button-screen par hai:
  // NEW NUMBER ho to NEW, warna FIND NUMBER. Purani screens stale hain.
  const latestWelcomeOldCard = tg._selectHermesLatestScreenAction([
    { text: 'WELCOME TO Hermes', buttons: ['FIND NUMBER', 'HELP'] },
    { text: cardText, buttons: ['NEW NUMBER', 'REFRESH'] },
  ]);
  ok(latestWelcomeOldCard?.role === 'find' && latestWelcomeOldCard.screenIndex === 0,
    'latest welcome screen par FIND hi click hoga — purane card ka NEW stale hai');
  const latestCardOldWelcome = tg._selectHermesLatestScreenAction([
    { text: cardText, buttons: ['NEW NUMBER', 'REFRESH'] },
    { text: 'WELCOME TO Hermes', buttons: ['FIND NUMBER'] },
  ]);
  ok(latestCardOldWelcome?.role === 'new' && latestCardOldWelcome.screenIndex === 0,
    'latest number card par NEW NUMBER ko FIND se pehle priority');
  const latestNoClaimButton = tg._selectHermesLatestScreenAction([
    { text: 'Hermes HELP', buttons: ['HELP', 'BACK'] },
    { text: cardText, buttons: ['NEW NUMBER', 'REFRESH'] },
  ]);
  ok(latestNoClaimButton?.role === '' && latestNoClaimButton.reason === 'no-matching-button-on-latest-screen',
    'latest screen par NEW/FIND na ho to purani screen ka button click nahi hota');
  const buttonlessThenWelcome = tg._selectHermesLatestScreenAction([
    { text: 'Hermes notice', buttons: [] },
    { text: 'WELCOME TO Hermes', buttons: ['FIND NUMBER'] },
  ]);
  ok(buttonlessThenWelcome?.role === 'find' && buttonlessThenWelcome.screenIndex === 1,
    'buttonless notice ke baad pehli asal button-screen hi current mani jati hai');
  const refreshDifferentLatest = tg._selectHermesLatestScreenAction([
    { text: 'YOUR NUMBER: +91 91234 56780', buttons: ['NEW NUMBER', 'REFRESH'] },
    { text: cardText, buttons: ['NEW NUMBER', 'REFRESH'] },
  ], { mode: 'refresh', phone: '9876543210' });
  ok(refreshDifferentLatest?.role === '' && refreshDifferentLatest.reason === 'latest-screen-different-number',
    'REFRESH stale purane card par nahi — latest different number par rukta hai');
  const refreshMatchingLatest = tg._selectHermesLatestScreenAction([
    { text: cardText, buttons: ['NEW NUMBER', 'REFRESH'] },
  ], { mode: 'refresh', phone: '9876543210' });
  ok(refreshMatchingLatest?.role === 'refresh' && refreshMatchingLatest.cardPhone === '9876543210',
    'REFRESH sirf latest matching number card par click hota hai');

  // FIND/NEW ke baad jo SABSE LAST number aaye wahi try hoga. Click se
  // pehle wala card baseline me chhoot bhi jaye, tab bhi woh fresh nahi
  // mana jayega; latest excluded ho to usse purana number fallback nahi.
  const oldCardText = 'YOUR NUMBER: +91 91234 56780\nSTATUS: ACTIVE\nDEVICE: OLD-1';
  const newCardText = 'YOUR NUMBER: +91 99887 76655\nSTATUS: ACTIVE\nDEVICE: NEW-1';
  const freshAfterFind = tg._selectLatestFreshHermesNumberCard([
    { id: 103, text: 'Hermes notice' },
    { id: 102, text: newCardText },
    { id: 99, text: oldCardText },
  ], { afterMessageId: 100, afterSignature: '100|0|WELCOME TO Hermes' });
  ok(freshAfterFind.status === 'fresh' && freshAfterFind.result?.card?.phone === '9988776655',
    'FIND ke baad sabse last aaya number hi fresh mana jata hai');
  const previousOnlyAfterFind = tg._selectLatestFreshHermesNumberCard([
    { id: 99, text: oldCardText },
  ], { afterMessageId: 100, afterSignature: '100|0|WELCOME TO Hermes' });
  ok(previousOnlyAfterFind.status === 'before-click-latest' && previousOnlyAfterFind.result?.card?.phone === '9123456780',
    'FIND click se pehle wala number baseline miss par bhi try nahi hota');
  const baselineLatestCard = tg._selectLatestFreshHermesNumberCard([
    { id: 102, text: newCardText },
  ], {
    baselineSignatures: new Set([`102|0|${newCardText}`]),
    afterMessageId: 100,
  });
  ok(baselineLatestCard.status === 'baseline-latest',
    'click se pehle baseline me li gayi latest card dobara fresh nahi banti');
  const excludedLatestCard = tg._selectLatestFreshHermesNumberCard([
    { id: 102, text: newCardText },
    { id: 99, text: oldCardText },
  ], {
    afterMessageId: 100,
    excludePhones: new Set(['9988776655']),
  });
  ok(excludedLatestCard.status === 'excluded-latest' && excludedLatestCard.result?.card?.phone === '9988776655',
    'latest card excluded ho to usse pehla purana number fallback me try nahi hota');
  const editedClickedCard = tg._selectLatestFreshHermesNumberCard([
    { id: 100, text: newCardText },
  ], {
    afterMessageId: 100,
    afterSignature: `100|0|${oldCardText}`,
    afterPhone: '9123456780',
  });
  ok(editedClickedCard.status === 'fresh' && editedClickedCard.result?.card?.phone === '9988776655',
    'clicked card edit hokar naya number bane to wahi latest fresh mana jata hai');
  const editedSamePhoneCard = tg._selectLatestFreshHermesNumberCard([
    { id: 100, text: `${oldCardText}\nLAST SMS: [AD-SWIGGY] OTP: 111111` },
  ], {
    afterMessageId: 100,
    afterSignature: `100|0|${oldCardText}`,
    afterPhone: '9123456780',
  });
  ok(editedSamePhoneCard.status === 'baseline-latest',
    'clicked card par sirf SMS edit ho aur phone wahi ho to use naya number nahi mana jata');

  ok(tg.normalizeTelegramLoginPhone('98765 43210') === '+919876543210', 'in-bot login: Indian 10-digit → +91');
  ok(tg.normalizeTelegramLoginPhone('+1 202 555 0101') === '+12025550101', 'in-bot login: country-code phone preserved');
  ok(tg.normalizeTelegramLoginPhone('12345') === '', 'in-bot login: invalid short phone reject');

  const noTelegramEnv = {
    TELEGRAM_SESSION_FILE: '/tmp/workwr-missing-telegram.session',
    TELEGRAM_API_CREDENTIALS_FILE: '/tmp/workwr-missing-telegram-api.json',
  };
  const missingStatus = tg.getTelegramOtpStatus(noTelegramEnv);
  ok(missingStatus.configured === false && missingStatus.sessionPresent === false, 'Telegram setup missing → status not configured');
  ok(['TELEGRAM_API_ID', 'TELEGRAM_API_HASH', 'TELEGRAM_SESSION'].every((k) => missingStatus.missing.includes(k)), 'Telegram status missing keys saaf batata hai');
  ok(tg.telegramOtpSetupHintLines(noTelegramEnv).join('\n').includes('Add Telegram Account'), 'setup hint Add Telegram Account flow batata hai');
  ok(tg.resolveNumberSourceMode({ env: { NUMBER_SOURCE: 'telegram' }, telegramSetting: false }) === 'telegram', 'NUMBER_SOURCE=telegram → Telegram only');
  ok(tg.resolveNumberSourceMode({ env: { NUMBER_SOURCE: 'firebase' }, telegramSetting: true }) === 'telegram', 'Bot Hermes ON stale NUMBER_SOURCE=firebase ko override karta hai — Hermes run me Firebase try nahi');
  ok(tg.resolveNumberSourceMode({ env: { NUMBER_SOURCE: 'firebase' }, telegramSetting: false }) === 'firebase', 'Bot Hermes OFF ho tabhi NUMBER_SOURCE=firebase respect');
  ok(engine.resolveAutopilotNumberSource({ sourceMode: 'telegram', env: { NUMBER_SOURCE: 'firebase' }, telegramSetting: false }) === 'telegram', 'launch par locked sourceMode=telegram stale env se upar');
  ok(tg._isTelegramClientConnectionError(new Error('read ECONNRESET')) === true
    && tg._isTelegramClientConnectionError(new Error('socket timeout')) === true
    && tg._isTelegramClientConnectionError(new Error('button nahi mila')) === false, 'MTProto dead-socket/timeout errors cached client invalidate karte hain');
  ok(tg._telegramClientLooksConnected({ connected: false }) === false
    && tg._telegramClientLooksConnected({ _connected: false }) === false
    && tg._telegramClientLooksConnected({ isConnected: () => true }) === true, 'MTProto cached client disconnected dikhe to reuse nahi hota');
  ok(engine.resolveAutopilotNumberSource({ env: { NUMBER_SOURCE: 'telegram' } }) === 'telegram', 'Autopilot source resolver Telegram env');
  ok(engine.effectiveAutopilotLanes({ sourceMode: 'telegram', requested: 10, proxyEnabled: true, enabledProxyCount: 20 }) === 1, 'ek Hermes chat → Telegram mode hamesha 1 lane');
  ok(engine.effectiveAutopilotLanes({ sourceMode: 'firebase', requested: 10, proxyEnabled: true, enabledProxyCount: 9 }) === 10, 'Firebase mode ki 10-lane behavior unchanged');
  ok(engine.formatNumberSourceStatus({ sourceMode: 'telegram', telegramBotUsername: 'HermeshuOTPROBOT', telegramConfigured: true }).includes('@HermeshuOTPROBOT'), 'source status Hermes bot dikhata hai');

  // Fresh-ID email rule: first five digits + exact Rahul@gmail.com.
  ok(bridge.generateFreshSwiggyEmail('9876543210') === '98765Rahul@gmail.com', 'fresh email: 9876543210 → 98765Rahul@gmail.com');
  ok(bridge.generateFreshSwiggyEmail('+91 98765 43210') === '98765Rahul@gmail.com', 'fresh email: +91 input ke first five mobile digits');
  ok(bridge.generateFreshSwiggyEmail('9876543210', { attempt: 1 }) === '98765Rahul1@gmail.com', 'fresh email duplicate par sirf numbered fallback');
  ok(!bridge.generateFreshSwiggyEmail('9876543210').includes(' '), 'fresh email me spaces nahi');

  // Deterministic random function se Maharashtra ka complete address.
  const randomAddress = bridge.generateRandomSwiggyAddress('9876543210', 'Rahul Kumar', () => 0.42);
  ok(randomAddress.mobile === '9876543210' && randomAddress.phone === '9876543210', 'random address me account phone saved');
  ok(Boolean(randomAddress.address && randomAddress.city && randomAddress.pincode && randomAddress.landmark), 'random address complete fields ke saath banta hai');
  ok(bridge.formatSwiggyAddress(randomAddress) === randomAddress.address, 'random address format helper string return karta hai');
  ok(randomAddress.state === 'Maharashtra' && randomAddress.source === 'generated-maharashtra', 'random address Maharashtra ka hai — user ke Lucknow/UP ka nahi');
  ok(['Mumbai', 'Pune', 'Nagpur', 'Nashik', 'Thane', 'Chhatrapati Sambhajinagar', 'Kolhapur', 'Solapur'].includes(randomAddress.city), 'random address city Maharashtra cities me se koi ek hai');
  ok(randomAddress.fullAddress === randomAddress.address && randomAddress.postalCode === randomAddress.pincode
    && randomAddress.latitude === randomAddress.lat && randomAddress.longitude === randomAddress.lng, 'random address remote-create fields (fullAddress/postalCode/lat-lng) rakhta hai');

  // Swiggy CAS create payload + pakka addressId par hi remote success.
  const casPayload = bridge.buildSwiggyCreateAddressPayload(randomAddress, { customerId: 'CUSTTG1' });
  ok(casPayload?.entityCtx?.id === 'CUSTTG1' && casPayload?.entityCtx?.type === 'ENTITY_TYPE_CUSTOMER'
    && casPayload?.requestCtx?.clientCtx?.clientId === 'android-consumer-app'
    && casPayload?.address?.city === randomAddress.city
    && casPayload?.address?.location?.lat === randomAddress.lat
    && casPayload?.address?.addressCategory?.[0] === 'ADDRESS_CATEGORY_HOME', 'CAS payload: customer + Maharashtra address + coords + HOME sahi map');
  ok(bridge.buildSwiggyCreateAddressPayload(randomAddress, {}) === null, 'CAS payload: customerId ke bina blind create nahi');
  ok(bridge.parseSwiggyCreateAddressResponse(200, { id: 'ADDR-77' }).ok === true
    && bridge.parseSwiggyCreateAddressResponse(200, { data: { addressId: 'ADDR-78' } }).addressId === 'ADDR-78'
    && bridge.parseSwiggyCreateAddressResponse(200, { statusCode: 0 }).ok === false
    && bridge.parseSwiggyCreateAddressResponse(403, { id: 'X' }).ok === false, 'CAS response: success sirf HTTP 2xx + pakka addressId par');

  const addressSession = {
    phone: '9876543210',
    cookieMap: new Map([['tid', 'TIDTG1'], ['_sid', 'SIDTG1'], ['token', 'TOKENTG1'], ['_device_id', 'DEVTG1']]),
    deviceProfile: { deviceId: 'DEVTG1', swuid: 'DEVTG1', osVersion: '14' },
  };
  let remoteCalls = 0;
  const remoteAdded = await bridge.addSwiggyAddressViaBridgeSession(addressSession, randomAddress, {
    customerId: 'CUSTTG1',
    urls: ['https://example.test/addresses/v1'],
    fetchImpl: async (_url, opts) => {
      remoteCalls++;
      const sent = JSON.parse(opts.body);
      ok(sent?.address?.city === randomAddress.city && sent?.entityCtx?.id === 'CUSTTG1', 'remote address POST body me wahi Maharashtra address jata hai');
      return { status: 200, headers: new Headers(), text: async () => JSON.stringify({ id: 'ADDR-REMOTE-1' }) };
    },
  });
  ok(remoteAdded.ok && remoteAdded.addressId === 'ADDR-REMOTE-1' && remoteCalls === 1, 'remote address: addressId mile to added success');
  let forbiddenCalls = 0;
  const remoteForbidden = await bridge.addSwiggyAddressViaBridgeSession(addressSession, randomAddress, {
    customerId: 'CUSTTG1',
    urls: ['https://example.test/a', 'https://example.test/b'],
    fetchImpl: async () => {
      forbiddenCalls++;
      return { status: 403, headers: new Headers(), text: async () => JSON.stringify({ error: { message: 'denied' } }) };
    },
  });
  ok(!remoteForbidden.ok && forbiddenCalls === 1, 'remote address: 403 par dusra blind POST nahi (duplicate bacha)');

  // Asal saved-address list se hi verified address banta hai. Generated
  // candidate ko match/normalize karna remote proof nahi hai — pakka ID
  // Swiggy ke record se aana chahiye.
  const savedRemoteAddress = {
    id: 'ADDR-SAVED-9',
    address: randomAddress.address,
    flat_no: randomAddress.flatNo,
    landmark: randomAddress.landmark,
    area: randomAddress.area,
    city: randomAddress.city,
    pincode: randomAddress.pincode,
    mobile: '9876543210',
    lat: randomAddress.lat,
    lng: randomAddress.lng,
  };
  const extractedSaved = bridge.extractSwiggySavedAddresses({ statusCode: 0, data: { addresses: [savedRemoteAddress] } });
  ok(bridge.setSwiggyBridgeSessionProgressReporter('missing-user', () => {}) === false, 'address progress reporter missing bridge session par safe false deta hai');
  ok(extractedSaved.length === 1 && extractedSaved[0].id === 'ADDR-SAVED-9', 'saved-address extractor nested Swiggy list se real ID wala record nikalta hai');
  ok(bridge.findMatchingSwiggySavedAddress(extractedSaved, randomAddress)?.id === 'ADDR-SAVED-9', 'saved-address matcher candidate ko Swiggy ke saved record se verify karta hai');
  ok(bridge.findMatchingSwiggySavedAddress(extractedSaved, { ...randomAddress, mobile: '9123456780', phone: '9123456780', lat: randomAddress.lat + 1, lng: randomAddress.lng + 1, flatNo: 'Flat Z-999', addressLine: 'Flat Z-999', pincode: '400001', area: 'Bandra', city: 'Mumbai', landmark: 'Near Station' }) === null, 'saved-address matcher alag address ko galat match nahi karta');
  const verifiedSavedAddress = bridge.normalizeVerifiedSwiggyAddress(savedRemoteAddress, randomAddress);
  ok(verifiedSavedAddress.source === 'swiggy-saved-address' && verifiedSavedAddress.remoteAddressStatus === 'added'
    && verifiedSavedAddress.remoteAddressId === 'ADDR-SAVED-9', 'verified address normalization sirf remote ID ke saath ADDED banti hai');
  const webForm = bridge.buildSwiggyWebAddressFormValues(randomAddress);
  ok(webForm.flatNo === randomAddress.flatNo && webForm.landmark === randomAddress.landmark
    && webForm.address.includes(randomAddress.city) && webForm.label === 'Home'
    && webForm.lat === randomAddress.lat && webForm.lng === randomAddress.lng, 'Add Address web form: Address + Door/Flat + Landmark + Home + Maharashtra coords sahi');

  // Browser Add Address UI ka mocked page flow: pehle saved list khali,
  // form fill + SAVE, phir saved list me wahi address real ID ke saath.
  {
    let visitedUrl = '';
    let saveClicked = false;
    const cookiesSet = [];
    const formSnapshot = {
      url: 'https://www.swiggy.com/web-cart-add-address',
      title: 'Add Address',
      readyState: 'complete',
      bodyText: 'Delivery address Address Door / Flat No. Landmark Home SAVE ADDRESS & PROCEED',
      fields: [
        { tag: 'input', type: 'text', name: 'building', label: 'door flat', visible: true, disabled: false },
        { tag: 'input', type: 'text', name: 'landmark', label: 'landmark', visible: true, disabled: false },
      ],
      buttons: [{ text: 'Home', visible: true }, { text: 'SAVE ADDRESS & PROCEED', visible: true }],
    };
    const mockPage = {
      setViewport: async () => {}, setGeolocation: async () => {}, setUserAgent: async () => {},
      setCookie: async (cookie) => { cookiesSet.push(cookie); },
      cookies: async () => [], on: () => {}, off: () => {}, frames: () => [],
      goto: async (url) => { visitedUrl = url; },
      evaluate: async (fn, arg) => {
        const fnName = typeof fn === 'function' ? fn.name : String(fn || '');
        if (fnName === 'swiggyAddressSnapshotInBrowser') return formSnapshot;
        if (fnName === 'swiggyAddressFillInBrowser') {
          return {
            ok: true,
            filled: { address: false, flatNo: true, landmark: true },
            fields: 2,
            addressStatic: true,
            selected: { address: '', flatNo: 'input:building', landmark: 'input:landmark' },
            saveDisabled: false,
            url: formSnapshot.url,
          };
        }
        if (fnName === 'swiggyAddressClickTextInBrowser') {
          const isSave = Array.isArray(arg) && arg.some((text) => String(text).includes('save address'));
          if (isSave) saveClicked = true;
          return { clicked: isSave, text: isSave ? 'save address & proceed' : '' };
        }
        return {
          status: 200,
          data: { statusCode: 0, data: { addresses: saveClicked ? [savedRemoteAddress] : [] } },
          rawText: '{}',
        };
      },
    };
    const uiAdded = await bridge.addSwiggyAddressViaWebUi(addressSession, randomAddress, {
      pageFactory: async () => ({ page: mockPage, owned: false }),
      timeoutMs: 12_000,
    });
    ok(uiAdded.ok && uiAdded.addressId === 'ADDR-SAVED-9' && uiAdded.verifiedAddress?.source === 'swiggy-saved-address', 'asal Add Address UI flow SAVE ke baad saved list se verify karta hai');
    ok(saveClicked && visitedUrl.includes('/web-cart-add-address') && visitedUrl.includes(`lat=${randomAddress.lat}`) && cookiesSet.some((c) => c.name === '_is_logged_in'), 'Add Address UI authenticated cookies + Maharashtra pin ke saath page kholta hai');
    ok(
      bridge.classifySwiggyAddressPageState(formSnapshot, { status: 200 }) === 'form-ready'
      && bridge.classifySwiggyAddressPageState({ url: formSnapshot.url, bodyText: 'Drag map to choose location Proceed', buttons: [{ text: 'Proceed' }], fields: [] }) === 'map-gate'
      && bridge.classifySwiggyAddressPageState({ url: formSnapshot.url, bodyText: 'Security check Verify you are human', buttons: [], fields: [] }) === 'security-challenge'
      && bridge.classifySwiggyAddressPageState({ url: 'https://www.swiggy.com/', bodyText: 'Login Existing account', buttons: [], fields: [] }) === 'redirected',
      'Add Address page states form/map/security/redirect ko alag pehchanti hai'
    );
    const sanitizedHtml = bridge.sanitizeSwiggyAddressFailureMessage('<!doctype html><html><body>WAF challenge secret</body></html>');
    ok(
      bridge._isHtmlSwiggyResponseText('<!doctype html><html></html>') === true
      && sanitizedHtml.includes('HTML/WAF page')
      && !sanitizedHtml.includes('<!doctype')
      && !sanitizedHtml.includes('secret'),
      'Add Address/CAS HTML response raw markup ke roop me user ko nahi dikhta'
    );
  }

  // Live wala map-gate case: pehla DOM Proceed click bekaar ho to bot wahi
  // atka nahi rahega — dusri baari asal coordinates par physical click, phir
  // form. Success phir bhi saved list ke real ID se hi verify hoga.
  {
    let physicalGateClicks = 0;
    let gateDomClicks = 0;
    let mapGateSaveClicked = false;
    const mapSnapshot = {
      url: 'https://www.swiggy.com/web-cart-add-address',
      title: 'Add Address',
      readyState: 'complete',
      bodyText: 'Delivery address Drag map to choose location Proceed',
      fields: [],
      buttons: [{ text: 'Proceed', visible: true, disabled: false, tag: 'a', x: 640, y: 820, width: 220, height: 48 }],
    };
    const openedFormSnapshot = {
      url: mapSnapshot.url,
      title: 'Add Address',
      readyState: 'complete',
      bodyText: 'Delivery address Address Door / Flat No. Landmark Home SAVE ADDRESS & PROCEED',
      fields: [
        { tag: 'input', type: 'text', name: 'building', label: 'door flat', visible: true, disabled: false },
        { tag: 'input', type: 'text', name: 'landmark', label: 'landmark', visible: true, disabled: false },
      ],
      buttons: [{ text: 'Home', visible: true }, { text: 'SAVE ADDRESS & PROCEED', visible: true }],
    };
    const mapGatePage = {
      setViewport: async () => {}, setGeolocation: async () => {}, setUserAgent: async () => {},
      setCookie: async () => {}, cookies: async () => [], on: () => {}, off: () => {}, frames: () => [],
      goto: async () => {},
      viewport: () => ({ width: 1280, height: 900 }),
      mouse: {
        click: async (x, y) => {
          if (x === 640 && y === 820) physicalGateClicks++;
        },
        move: async () => {}, down: async () => {}, up: async () => {},
      },
      evaluate: async (fn, arg) => {
        const fnName = typeof fn === 'function' ? fn.name : String(fn || '');
        if (fnName === 'swiggyAddressSnapshotInBrowser') return physicalGateClicks ? openedFormSnapshot : mapSnapshot;
        if (fnName === 'swiggyAddressFillInBrowser') {
          return {
            ok: true,
            filled: { address: false, flatNo: true, landmark: true },
            fields: 2,
            addressStatic: true,
            selected: { address: '', flatNo: 'input:building', landmark: 'input:landmark' },
            saveDisabled: false,
            url: openedFormSnapshot.url,
          };
        }
        if (fnName === 'swiggyAddressClickTextInBrowser') {
          const patterns = Array.isArray(arg) ? arg.map(String) : [];
          const isSave = patterns.some((text) => text.includes('save address'));
          if (isSave) {
            mapGateSaveClicked = true;
            return { clicked: true, text: 'save address & proceed', tag: 'a', x: 640, y: 840 };
          }
          gateDomClicks++;
          return { clicked: true, text: 'proceed', tag: 'a', x: 640, y: 820 };
        }
        return {
          status: 200,
          data: { statusCode: 0, data: { addresses: mapGateSaveClicked ? [savedRemoteAddress] : [] } },
          rawText: '{}',
        };
      },
    };
    const mapGateAdded = await bridge.addSwiggyAddressViaWebUi(addressSession, randomAddress, {
      pageFactory: async () => ({ page: mapGatePage, owned: false }),
      timeoutMs: 15_000,
    });
    ok(mapGateAdded.ok && mapGateAdded.addressId === 'ADDR-SAVED-9',
      'Add Address map gate DOM click fail ke baad physical Proceed click se asal form tak pahunchta hai');
    ok(gateDomClicks === 1 && physicalGateClicks === 1 && mapGateSaveClicked,
      'Add Address gate: DOM click ke baad physical fallback ek-ek baari, double activation nahi');
  }

  // Orchestration order: saved list → browser UI → sirf non-submit UI
  // failure par CAS. UI SAVE ke baad uncertain ho to CAS POST bilkul nahi.
  {
    const jsonResponse = (data, status = 200) => ({ status, headers: new Headers(), text: async () => JSON.stringify(data) });
    let browserCalls = 0;
    const existingFirst = await bridge.addSwiggyAddressToAccount(addressSession, randomAddress, {
      customerId: 'CUSTTG1',
      fetchImpl: async (url) => String(url).includes('/dapi/address/all')
        ? jsonResponse({ statusCode: 0, data: { addresses: [savedRemoteAddress] } })
        : jsonResponse({ error: 'should-not-post' }, 500),
      browserAddImpl: async () => { browserCalls++; return { ok: false, submitAttempted: false }; },
    });
    ok(existingFirst.ok && existingFirst.method === 'saved-address-list' && browserCalls === 0, 'address orchestration: saved list me pehle se ho to duplicate Add Address nahi khulta');

    let casCalls = 0;
    const browserBeforeCas = await bridge.addSwiggyAddressToAccount(addressSession, randomAddress, {
      customerId: 'CUSTTG1',
      urls: ['https://example.test/addresses/v1'],
      fetchImpl: async (url) => {
        if (String(url).includes('/dapi/address/all')) return jsonResponse({ statusCode: 0, data: { addresses: [] } });
        casCalls++;
        return jsonResponse({ id: 'ADDR-CAS-1' });
      },
      browserAddImpl: async () => ({ ok: false, addressId: '', submitAttempted: false, message: 'Chrome nahi mila' }),
    });
    ok(browserBeforeCas.ok && browserBeforeCas.method === 'cas-address-api' && casCalls === 1, 'address orchestration: UI submit hi na ho tabhi CAS fallback');

    casCalls = 0;
    const uncertainUi = await bridge.addSwiggyAddressToAccount(addressSession, randomAddress, {
      customerId: 'CUSTTG1',
      urls: ['https://example.test/addresses/v1'],
      fetchImpl: async (url) => {
        if (String(url).includes('/dapi/address/all')) return jsonResponse({ statusCode: 0, data: { addresses: [] } });
        casCalls++;
        return jsonResponse({ id: 'ADDR-DUPLICATE-RISK' });
      },
      browserAddImpl: async () => ({ ok: false, addressId: '', submitAttempted: true, uncertain: true, message: 'SAVE verify nahi hua' }),
    });
    ok(!uncertainUi.ok && uncertainUi.submitAttempted === true && casCalls === 0, 'address orchestration: UI SAVE uncertain ho to duplicate rokne ke liye CAS POST nahi');

    const oldCreateUrl = process.env.SWIGGY_ADDRESS_CREATE_URL;
    delete process.env.SWIGGY_ADDRESS_CREATE_URL;
    casCalls = 0;
    try {
      const noBlindCas = await bridge.addSwiggyAddressToAccount(addressSession, randomAddress, {
        customerId: 'CUSTTG1',
        fetchImpl: async (url) => {
          if (String(url).includes('/dapi/address/all')) return jsonResponse({ statusCode: 0, data: { addresses: [] } });
          casCalls++;
          return jsonResponse({ id: 'ADDR-SHOULD-NOT-POST' });
        },
        browserAddImpl: async () => ({
          ok: false,
          addressId: '',
          submitAttempted: false,
          pageState: 'form-not-found',
          message: 'Add Address form ready nahi hua (state=form-not-found, fields=0)',
        }),
      });
      ok(
        !noBlindCas.ok && casCalls === 0 && !/<\s*!?doctype/i.test(noBlindCas.message || ''),
        'address orchestration: explicit CAS URL na ho to guessed endpoint par HTML wala blind POST nahi'
      );
    } finally {
      if (oldCreateUrl === undefined) delete process.env.SWIGGY_ADDRESS_CREATE_URL;
      else process.env.SWIGGY_ADDRESS_CREATE_URL = oldCreateUrl;
    }
  }

  // Saved account se /session fallback export me email/address survive kare.
  store.updateAccount('TEST_TELEGRAM_FRESH_EXPORT', {
    name: 'Telegram Fresh Test',
    swiggyName: 'Rahul Kumar',
    botTag: 'tag-telegram-fresh',
    email: bridge.generateFreshSwiggyEmail('9876543210'),
    address: randomAddress.address,
    addressDetails: randomAddress,
    phone: '9876543210',
    customerId: 'CUSTTG1',
    token: 'TOKENTG1',
    tid: 'TIDTG1',
    sid: 'SIDTG1',
    deviceId: 'DEVTG1',
    cookies: 'tid=TIDTG1; _sid=SIDTG1; _device_id=DEVTG1; token=TOKENTG1',
    isLoggedIn: true,
    savedAt: '2026-11-03T00:00:00.000Z',
  });
  const sessionExport = store.getSessionExportJson('TEST_TELEGRAM_FRESH_EXPORT', null);
  ok(sessionExport?.email === '98765Rahul@gmail.com', 'session fallback export me fresh email included');
  ok(store._isUnverifiedGeneratedAddress({ addressDetails: randomAddress, remoteAddressStatus: 'pending' }) === true, 'unverified generated candidate ko store fake success nahi manta');
  ok(sessionExport?.address === undefined && sessionExport?.addressDetails === undefined
    && sessionExport?.remoteAddressStatus === 'pending', 'session fallback export unverified fake address data nahi bhejta — sirf pending status');
  const fullExport = store.exportSessionJson('TEST_TELEGRAM_FRESH_EXPORT');
  ok(fullExport?.email === '98765Rahul@gmail.com' && fullExport?.address === undefined && fullExport?.addressDetails === undefined, 'full session export bhi unverified generated address suppress karta hai');
  const bridgeProvidedUnverified = {
    account: 'TEST_TELEGRAM_FRESH_EXPORT', address: randomAddress.address,
    addressDetails: randomAddress, remoteAddressStatus: 'failed', remoteAddressId: 'FAKE-ID',
  };
  const bridgeProvidedClean = store.getSessionExportJson('TEST_TELEGRAM_FRESH_EXPORT', { exportJson: bridgeProvidedUnverified });
  ok(bridgeProvidedClean?.address === undefined && bridgeProvidedClean?.remoteAddressId === undefined
    && bridgeProvidedUnverified.remoteAddressId === 'FAKE-ID', 'bridge-provided export unverified address/ID strip karta hai bina original mutate kiye');

  // Remote proof milne ke baad wahi account ka verified Swiggy record
  // export me aana chahiye — generated candidate apne aap nahi.
  store.updateAccount('TEST_TELEGRAM_FRESH_EXPORT', {
    address: verifiedSavedAddress.address,
    addressDetails: verifiedSavedAddress,
    deliveryAddress: verifiedSavedAddress,
    remoteAddressStatus: 'added',
    remoteAddressId: verifiedSavedAddress.remoteAddressId,
    remoteAddressMessage: verifiedSavedAddress.remoteAddressMessage,
  });
  const verifiedExport = store.getSessionExportJson('TEST_TELEGRAM_FRESH_EXPORT', null);
  ok(verifiedExport?.address === verifiedSavedAddress.address
    && verifiedExport?.addressDetails?.source === 'swiggy-saved-address'
    && verifiedExport?.remoteAddressStatus === 'added'
    && verifiedExport?.remoteAddressId === 'ADDR-SAVED-9', 'verified remote address + real ID session export me included');
  const verifiedFullExport = store.exportSessionJson('TEST_TELEGRAM_FRESH_EXPORT');
  ok(verifiedFullExport?.addressDetails?.remoteAddressId === 'ADDR-SAVED-9', 'full export me sirf verified Swiggy address ID aata hai');
}

// ---------------------------------------------------------------------------
console.log('manual SKIP current number — owner control + one-shot outcome:');
{
  const pipe = await import('./number-pipeline.js');
  const engine = await import('./autopilot-engine.js');
  const fs = await import('node:fs/promises');
  const fsp = await import('node:fs/promises');
  const freshBotSource = await fsp.readFile(new URL('./fresh-bot.js', import.meta.url), 'utf8');
  const engineSource = await fsp.readFile(new URL('./autopilot-engine.js', import.meta.url), 'utf8');

  const skipped = await pipe.processSingleNumber({
    userId: 'manual-skip-test',
    entry: { phone: '9812345670', source: 'telegram', otpProvider: 'telegram' },
    otpCfg: { numberSource: 'telegram' },
    shouldSkip: () => true,
    markUsed: false,
  });
  ok(
    skipped.kind === 'manual_skip' && skipped.manualSkip === true && !skipped.ok,
    'pipeline: shouldSkip pehle checkpoint par manual_skip deta hai'
  );
  ok(
    engine.isOneShotOtpFailureResult(skipped) === false,
    'manual SKIP ko OTP-failure nahi gina jata; alag SKIP counter hai'
  );
  ok(
    freshBotSource.includes('requestAutopilotSkipCurrent')
    && freshBotSource.includes("callback_data: 'ap_skip_current'")
    && freshBotSource.includes("bot.action('ap_skip_current', skipCurrentNumber)")
    && freshBotSource.includes("bot.action('prem_batch_skip_current', skipCurrentNumber)")
    && engineSource.includes("callback_data: 'prem_batch_skip_current'"),
    'Fresh Bot + engine live keyboards dono me SKIP NUMBER functional wiring hai'
  );
  ok(
    engineSource.includes('otpFailedThisRun')
    && engineSource.includes('manualSkippedThisRun')
    && !engineSource.includes('pendingTelegramRetry'),
    'engine: OTP-failed/manual-skipped numbers run-consumed hain, pending same-number retry nahi'
  );
}

// ---------------------------------------------------------------------------
console.log('OTP bot profiles (Hermes + HardXotp) — buttons/cards/latest-screen:');
{
  const profiles = await import('./otp-bot-profiles.js');
  const tg = await import('./telegram-otp-source.js');
  const store = await import('./store.js');

  ok(profiles.normalizeOtpBotProfileId('chauhan') === 'chauhan', 'profile: chauhan id');
  ok(profiles.normalizeOtpBotProfileId('@HardXotp_Bot') === 'chauhan', 'profile: @HardXotp_Bot username se pehchana jata hai');
  ok(profiles.normalizeOtpBotProfileId('HermeshuOTPROBOT') === 'hermes', 'profile: Hermes username se hermes');
  ok(profiles.normalizeOtpBotProfileId('kuch-bhi') === 'hermes', 'profile: unknown → default Hermes');
  ok(profiles.getOtpBotProfile('chauhan').username === 'HardXotp_Bot', 'profile: HardXotp username');

  // Button roles
  ok(profiles.otpBotButtonRole('GET NUMBERS 📱', 'chauhan') === 'find', 'HardXotp: GET NUMBERS = naya number (find)');
  ok(profiles.otpBotButtonRole('NEW NUMBER ➕', 'chauhan') === 'new', 'HardXotp: NEW NUMBER = new');
  ok(profiles.otpBotButtonRole('VIEW MESSAGES 💬', 'chauhan') === 'view', 'HardXotp: VIEW MESSAGES = messages/view');
  ok(profiles.otpBotButtonRole('LIVE STATS 📊', 'chauhan') === '', 'HardXotp: LIVE STATS ignore');
  ok(profiles.otpBotButtonRole('FIND DEVICE 🔍', 'chauhan') === '', 'HardXotp: FIND DEVICE ignore (FIND NUMBER nahi)');
  ok(profiles.otpBotButtonRole('BACK', 'chauhan') === '', 'HardXotp: BACK ignore');
  ok(profiles.otpBotButtonRole('FIND NUMBER', 'hermes') === 'find', 'Hermes: FIND NUMBER = find');
  ok(profiles.otpBotButtonRole('NEW NUMBER', 'hermes') === 'new', 'Hermes: NEW NUMBER = new');
  ok(profiles.otpBotButtonRole('REFRESH', 'hermes') === 'refresh', 'Hermes: REFRESH = refresh');
  ok(profiles.otpBotButtonRole('VIEW MESSAGES', 'hermes') === '', 'Hermes: VIEW MESSAGES role nahi (purana behaviour intact)');

  // Card parse (screenshot wala HardXotp card)
  const cardText = [
    '✅ CONNECTED SUCCESSFULLY!',
    '🔑 FINDER KEY: CH-HK3D',
    '📞 ASSIGNED NUMBER: 9080104284',
    '✅ STATUS: Online',
    '⏱ LAST SMS RECEIVED: 05:40 pm | 07-11-2026',
    'Live SMS pulling is now active.',
  ].join('\n');
  const card = tg.parseTelegramNumberCard(cardText);
  ok(card?.phone === '9080104284', 'HardXotp card: ASSIGNED NUMBER parse hua');
  ok(/ONLINE/i.test(card?.status || ''), 'HardXotp card: STATUS Online parse hua');
  ok(tg.parseTelegramNumberCard('🔑 FINDER KEY: CH-HK3D\nLive SMS pulling is now active.') === null, 'HardXotp welcome: finder key ko number nahi samjha');

  // Latest-screen selection: welcome (GET NUMBERS) vs card (NEW NUMBER / VIEW MESSAGES)
  const welcome = [{
    text: 'OTP BOT BY CHAUHAN\nCHOOSE AN OPTION BELOW\nID: 6484999726',
    buttons: ['GET NUMBERS 📱', 'LIVE STATS 📊', 'FIND DEVICE 🔍', 'BACK'],
  }];
  const claimWelcome = tg._selectHermesLatestScreenAction(welcome, { mode: 'claim', profileId: 'chauhan' });
  ok(claimWelcome?.role === 'find' && claimWelcome.buttonText === 'GET NUMBERS 📱',
    'HardXotp: latest welcome screen par GET NUMBERS click hoga');

  const numberScreen = [{
    text: cardText,
    buttons: ['VIEW MESSAGES 💬', 'NEW NUMBER ➕', 'BACK'],
  }];
  const claimCard = tg._selectHermesLatestScreenAction(numberScreen, { mode: 'claim', profileId: 'chauhan' });
  ok(claimCard?.role === 'new' && claimCard.buttonText === 'NEW NUMBER ➕',
    'HardXotp: number card par NEW NUMBER priority (GET se pehle)');
  const refreshCard = tg._selectHermesLatestScreenAction(numberScreen, {
    mode: 'refresh', phone: '9080104284', profileId: 'chauhan',
  });
  ok(refreshCard?.role === 'view' && refreshCard.buttonText === 'VIEW MESSAGES 💬',
    'HardXotp: OTP check par VIEW MESSAGES click hota hai');
  const refreshOther = tg._selectHermesLatestScreenAction(numberScreen, {
    mode: 'refresh', phone: '9999999999', profileId: 'chauhan',
  });
  ok(refreshOther?.role === '' && refreshOther.reason === 'latest-screen-different-number',
    'HardXotp: dusre number ki card par VIEW MESSAGES click nahi');

  // Purani (stale) screen ka button ignore — sirf latest screen chalti hai
  // screens[0] = sabse latest (messages newest-first aate hain)
  const staleScreens = [
    { text: 'CONNECTED SUCCESSFULLY!\nLive SMS pulling is now active.', buttons: ['BACK'] },
    { text: cardText, buttons: ['NEW NUMBER ➕'] },
  ];
  const stalePick = tg._selectHermesLatestScreenAction(staleScreens, { mode: 'claim', profileId: 'chauhan' });
  ok(stalePick?.buttonIndex === -1 && stalePick?.reason === 'no-matching-button-on-latest-screen',
    'HardXotp: latest screen par claim button na ho to purani screen ka NEW NUMBER click nahi');

  // OTP message (HardXotp live SMS forward)
  const otpMsg = 'NEW SMS ✅\nNUMBER: 9080104284\nSENDER: SWIGGY\nMESSAGE: 483920 is your Swiggy OTP. Do not share it with anyone.\n07-11-2026 | 05:41 pm';
  ok(tg.extractTelegramOtpFromText(otpMsg) === '483920', 'HardXotp SMS forward se 6-digit OTP nikala');
  ok(tg.parseTelegramOtpText(otpMsg)?.phone === '9080104284', 'HardXotp SMS message me number bhi parse hua');

  // Config: profile se bot username badalta hai
  tg.setActiveOtpBotProfile('chauhan');
  const cfgChauhan = tg.getTelegramOtpConfig({ TELEGRAM_API_ID: '1', TELEGRAM_API_HASH: 'h', TELEGRAM_SESSION: 's' });
  ok(cfgChauhan.botUsername === 'HardXotp_Bot', 'config: chauhan profile → @HardXotp_Bot');
  ok(cfgChauhan.otpBotProfile === 'chauhan', 'config: profile id exposed');
  tg.setActiveOtpBotProfile('hermes');
  const cfgHermes = tg.getTelegramOtpConfig({ TELEGRAM_API_ID: '1', TELEGRAM_API_HASH: 'h', TELEGRAM_SESSION: 's' });
  ok(cfgHermes.botUsername === 'HermeshuOTPROBOT', 'config: hermes profile → @HermeshuOTPROBOT');
  ok(tg.getTelegramOtpStatus({ TELEGRAM_API_ID: '1', TELEGRAM_API_HASH: 'h', TELEGRAM_SESSION: 's' }).otpBotProfile === 'hermes',
    'status: otpBotProfile expose hota hai');
  tg.resetActiveOtpBotProfile();

  // ---- @Hathi_otp_bot — Hermeshu jaisa hi behaviour ----
  ok(profiles.getOtpBotProfile('hathi').username === 'Hathi_otp_bot', 'Hathi: username @Hathi_otp_bot');
  ok(profiles.normalizeOtpBotProfileId('@Hathi_otp_bot') === 'hathi', 'Hathi: username se profile milti hai');
  ok(profiles.normalizeOtpBotProfileId('hathi') === 'hathi', 'Hathi: id se profile milti hai');
  ok(profiles.OTP_BOT_PROFILE_IDS.includes('hathi'), 'Hathi: profile list me shamil');
  ok(profiles.listOtpBotProfiles().map((x) => x.id).join(',') === 'hermes,hathi,chauhan',
    'OTP bot list order: hermes, hathi, chauhan (UI isi se banti hai)');
  {
    const h = profiles.getOtpBotProfile('hermes');
    const a = profiles.getOtpBotProfile('hathi');
    ok(a.claimPreference.join(',') === h.claimPreference.join(','), 'Hathi: claim order Hermes jaisa (NEW → FIND)');
    ok(a.refreshRoles.join(',') === h.refreshRoles.join(','), 'Hathi: refresh roles Hermes jaise');
    ok(a.refreshLabel === 'REFRESH', 'Hathi: OTP check REFRESH button se');
    ok(a.ignoreRolePatterns.length === h.ignoreRolePatterns.length, 'Hathi: ignore patterns Hermes jaise');
    for (const label of ['FIND NUMBER', 'NEW NUMBER', 'REFRESH', 'SEARCH NUMBER', 'ACTIVE NUMBERS']) {
      ok(profiles.otpBotButtonRole(label, 'hathi') === profiles.otpBotButtonRole(label, 'hermes'),
        `Hathi: "${label}" ka role Hermes jaisa hi hai`);
    }
  }
  // Hathi card = Hermes jaisa number card
  const hathiCard = '👤 NUMBER: 9876543210\n✅ STATUS: ACTIVE\n📱 DEVICE: CH-AB12\nLAST SMS: [SWIGGY] OTP: 123456 | 07-11-2026 | 05:41 pm';
  const hathiParsed = tg.parseTelegramNumberCard(hathiCard);
  ok(hathiParsed?.phone === '9876543210', 'Hathi card: NUMBER parse hua');
  ok(tg.extractTelegramOtpFromText(hathiCard) === '123456', 'Hathi card: OTP parse hua');
  const hathiWelcome = [{ text: 'WELCOME', buttons: ['SEARCH NUMBER', 'ACTIVE NUMBERS', 'FIND NUMBER'] }];
  const hathiClaim = tg._selectHermesLatestScreenAction(hathiWelcome, { mode: 'claim', profileId: 'hathi' });
  ok(hathiClaim?.role === 'find' && hathiClaim.buttonText === 'FIND NUMBER',
    'Hathi: welcome par FIND NUMBER hi click hota hai (SEARCH/ACTIVE nahi)');
  const hathiNumScreen = [{ text: hathiCard, buttons: ['NEW NUMBER', 'REFRESH'] }];
  const hathiNew = tg._selectHermesLatestScreenAction(hathiNumScreen, { mode: 'claim', profileId: 'hathi' });
  ok(hathiNew?.role === 'new' && hathiNew.buttonText === 'NEW NUMBER', 'Hathi: number card par NEW NUMBER priority');
  const hathiRefresh = tg._selectHermesLatestScreenAction(hathiNumScreen, { mode: 'refresh', phone: '9876543210', profileId: 'hathi' });
  ok(hathiRefresh?.role === 'refresh' && hathiRefresh.buttonText === 'REFRESH', 'Hathi: OTP check par REFRESH click');
  tg.setActiveOtpBotProfile('hathi');
  const cfgHathi = tg.getTelegramOtpConfig({ TELEGRAM_API_ID: '1', TELEGRAM_API_HASH: 'h', TELEGRAM_SESSION: 's' });
  ok(cfgHathi.botUsername === 'Hathi_otp_bot' && cfgHathi.otpBotProfile === 'hathi',
    'Hathi: config usi bot ka username deta hai');
  tg.resetActiveOtpBotProfile();

  // Settings enum
  const bsMod = await import('./bot-settings.js');
  ok(bsMod.getSetting('otpBotProfile') === 'hermes', 'settings: default OTP bot Hermes');
  ok(bsMod.setSetting('otpBotProfile', 'chauhan').ok === true && bsMod.getSetting('otpBotProfile') === 'chauhan',
    'settings: OTP bot switch save hota hai');
  ok(bsMod.setSetting('otpBotProfile', 'random').ok === false, 'settings: galat OTP bot reject');
  ok(bsMod.setSetting('otpBotProfile', 'hathi').ok === true && bsMod.fmtSetting('otpBotProfile') === 'Hathi',
    'settings: Hathi bhi valid OTP bot hai');
  ok(bsMod.setSetting('otpBotProfile', 'chauhan').ok === true && bsMod.fmtSetting('otpBotProfile') === 'HardXotp',
    'settings: fmt label HardXotp');
  bsMod.setSetting('otpBotProfile', 'hermes');
  ok(typeof store.getDb === 'function', 'store available');

  // Live card ka source line chune hue bot ka naam dikhata hai.
  const engineMod = await import('./autopilot-engine.js');
  const cardChauhan = engineMod.formatCompactAutopilotCard({
    sourceMode: 'telegram', running: true, target: 10, fresh: 1, processed: 1,
    current: { phone: '9080104284' }, elapsedMs: 45_000,
    otpBotProfile: 'chauhan', otpBotLabel: 'HardXotp',
  }, { stageText: 'OTP wait' });
  ok(cardChauhan.includes('HARDXOTP ONLY') && cardChauhan.includes('Firebase'),
    'compact card HardXotp mode par HARDXOTP ONLY dikhata hai');
  const cardHermes = engineMod.formatCompactAutopilotCard({
    sourceMode: 'telegram', running: true, target: 10, fresh: 1,
    current: { phone: '9876543210' }, elapsedMs: 45_000,
    otpBotProfile: 'hermes', otpBotLabel: 'Hermes',
  }, { stageText: 'OTP wait' });
  ok(cardHermes.includes('HERMES ONLY'), 'compact card Hermes mode par HERMES ONLY dikhata hai');
}

// ---------------------------------------------------------------------------
console.log('START source picker + Delete All Firebase:');
{
  const srcMod = await import('./firebase-sources.js');
  const fbMod = await import('./firebase-numbers.js');
  const store = await import('./store.js');
  const fsp = await import('node:fs/promises');
  const freshBotSource = await fsp.readFile(new URL('./fresh-bot.js', import.meta.url), 'utf8');
  const engineSource = await fsp.readFile(new URL('./autopilot-engine.js', import.meta.url), 'utf8');

  ok(freshBotSource.includes('ap_start_go_${profile.id}')
    && freshBotSource.includes("callback_data: 'ap_start_go_firebase'")
    && freshBotSource.includes('otpBotProfiles.OTP_BOT_PROFILE_IDS.join'),
  'START par source picker wiring (saare OTP bots + Firebase, list se auto)');
  ok(freshBotSource.includes("callback_data: 'ap_src_delete_all'")
    && freshBotSource.includes("bot.action('ap_src_delete_all_yes'"),
  'START/source screen par Delete All Firebase wiring');
  ok(freshBotSource.includes('otpBot: lockedOtpBot'), 'batch start par OTP bot profile engine ko jata hai');
  ok(engineSource.includes('setActiveOtpBotProfile(otpBotProfileId)'), 'engine start par active OTP bot set hota hai');
  ok(engineSource.includes("'firebase-cleared'"), 'engine delete-all ko saaf stop reason deta hai');

  // Puraani state bachao — delete-all test ke baad wapas restore karenge.
  const dbBefore = store.getDb();
  const sourcesBefore = JSON.parse(JSON.stringify(dbBefore.firebaseSources || {}));
  try {
    ok(srcMod.listSources().length > 0, 'delete-all se pehle sources maujood hain');
    const beforeCount = srcMod.listSources().length;
    const res = srcMod.removeAllSources();
    ok(res.ok === true && res.removed === beforeCount, 'delete all: saare sources hat gaye');
    ok(srcMod.listSources().length === 0, 'delete all: list khali');
    ok(srcMod.isFirebaseSourceListCleared() === true, 'delete all: cleared flag set');
    ok(srcMod.ensureSeeded().list.length === 0, 'delete all: restart/seed par list wapas nahi aati');
    ok(srcMod.envSeedUrls !== undefined, 'env seed helper available');
    const applied = srcMod.applyActiveSource();
    ok(applied === null && fbMod.isFirebaseDisabled() === true, 'delete all: Firebase OFF (env fallback bhi band)');
    ok(fbMod.isFirebaseConfigured() === false, 'delete all: isFirebaseConfigured false');

    // Vault bhi delete-all yaad rakhta hai
    const snap = store.buildCloudVaultSnapshot(store.getDb());
    ok(snap.firebaseSources?.cleared === true && snap.firebaseSources.list.length === 0,
      'delete all: vault snapshot me cleared state jata hai');
    const fakeDb = { firebaseSources: { activeId: '', list: [], deleted: [], health: {} }, freshSettings: {} };
    store.mergeVaultFirebaseState(fakeDb, {
      firebaseSources: { cleared: true, list: [], deleted: ['https://x-default-rtdb.firebaseio.com'], health: {} },
    });
    ok(fakeDb.firebaseSources.cleared === true, 'delete all: vault se cleared state restore hoti hai');

    // Naya source add → Firebase wapas chalu
    const addBack = srcMod.addSource({ url: 'https://afterdelete-default-rtdb.firebaseio.com' });
    ok(addBack.ok === true && srcMod.isFirebaseSourceListCleared() === false, 'naya DB add → cleared hat gaya');
    ok(fbMod.isFirebaseDisabled() === false, 'naya DB add → Firebase dobara ON');
    ok(srcMod.listSources().length === 1, 'naya DB list me ek hi hai (seeding ne purani list wapas nahi ki)');
  } finally {
    const db = store.getDb();
    db.firebaseSources = sourcesBefore;
    store.saveDb(db);
    fbMod.setFirebaseDisabled(false);
    srcMod.applyActiveSource();
  }
  ok(srcMod.listSources().length > 0, 'delete-all test ke baad purane sources restore ho gaye');
}

// ---------------------------------------------------------------------------
console.log('Doosra bot / doosra instance (INSTANCE_LABEL):');
{
  const inst = await import('./instance-info.js');
  const fsp = await import('node:fs/promises');

  // Purana behaviour: label nahi diya to kuch bhi extra nahi.
  ok(inst.getInstanceLabel({}) === 'main', 'instance: default label main');
  ok(inst.isSecondaryInstance({}) === false, 'instance: default secondary nahi');
  ok(inst.instanceSuffix({}) === '' && inst.instanceTitle('🆕 Swiggy Fresh Bot', {}) === '🆕 Swiggy Fresh Bot',
    'instance: default title bilkul purana (koi suffix nahi)');
  ok(inst.instanceTitle('🆕 Swiggy Fresh Bot', { INSTANCE_LABEL: '   ' }) === '🆕 Swiggy Fresh Bot',
    'instance: khali/space label bhi purana title deta hai');

  // Doosra bot: label title + badge me.
  ok(inst.getInstanceLabel({ INSTANCE_LABEL: 'bot2' }) === 'bot2', 'instance: INSTANCE_LABEL padha jata hai');
  ok(inst.isSecondaryInstance({ INSTANCE_LABEL: 'bot2' }) === true, 'instance: bot2 secondary hai');
  ok(inst.instanceTitle('🆕 Swiggy Fresh Bot', { INSTANCE_LABEL: 'bot2' }) === '🆕 Swiggy Fresh Bot · bot2',
    'instance: title me "· bot2" lagta hai');

  // Sanitization — HTML/newline/atishay lamba label UI na tode.
  ok(inst.normalizeInstanceLabel('  bot2   extra  ') === 'bot2 extra', 'instance: extra spaces collapse');
  ok(inst.normalizeInstanceLabel('<b>bot2</b>') === 'bbot2/b', 'instance: angle brackets strip (HTML injection nahi)');
  ok(inst.normalizeInstanceLabel('bot2\nsecond') === 'bot2 second', 'instance: newline space ban jata hai');
  ok(inst.normalizeInstanceLabel('x'.repeat(50)).length === inst.INSTANCE_LABEL_MAX, 'instance: label 20 chars par cut');
  ok(inst.normalizeInstanceLabel(null) === '' && inst.getInstanceLabel({ INSTANCE_LABEL: null }) === 'main',
    'instance: null label safe');

  // fresh-bot.js wiring — health/deeplink/log/START sab label use karein.
  const freshBotSource = await fsp.readFile(new URL('./fresh-bot.js', import.meta.url), 'utf8');
  ok(freshBotSource.includes("await import('./instance-info.js')"), 'instance: fresh-bot instance-info load karta hai');
  ok(freshBotSource.includes('instance: instanceInfo.getInstanceLabel()'), 'instance: /health payload me instance');
  ok(freshBotSource.includes("instanceInfo.instanceTitle('🆕 Swiggy Fresh Bot')"),
    'instance: START card title label ke saath');
  ok(freshBotSource.includes("field('🏷 Instance'"), 'instance: /diag me instance line');
  ok(freshBotSource.includes('🏷 Instance:'), 'instance: boot log me instance');

  // Doosra deployment blueprint bhi repo me hai (free web service route).
  const secondYaml = await fsp.readFile(new URL('./render.second.yaml', import.meta.url), 'utf8');
  ok(secondYaml.includes('plan: free') && secondYaml.includes('type: web'),
    'render.second.yaml: free web service (card ke bina)');
  ok(secondYaml.includes('healthCheckPath: /health'), 'render.second.yaml: health check /health par');
  ok(secondYaml.includes('INSTANCE_LABEL') && secondYaml.includes('GITHUB_VAULT_BRANCH'),
    'render.second.yaml: instance label + alag vault branch');

  const guide = await fsp.readFile(new URL('./SECOND-BOT-DEPLOY.md', import.meta.url), 'utf8');
  ok(guide.includes('Vercel') && guide.includes('409'),
    'guide: Vercel limitation + ek token ek instance rule likha hai');
  ok(guide.includes('GITHUB_VAULT_BRANCH'), 'guide: vault branch alag rakhne ki hidayat');
  ok(guide.includes('bot-vault-3') && guide.includes('bot-vault-4'),
    'guide: 3 naye bots (bot2/bot3/bot4) ke alag vault branches');
  ok(guide.includes('750 free hours') && guide.includes('per account'),
    'guide: har bot ke liye alag Render account (750h per account)');
  ok(guide.includes('40 lanes'), 'guide: 4 bots = shared Firebase pool par 40 lanes ka warning');
  ok(guide.includes('spare Telegram account'), 'guide: har bot ko apna spare Telegram account');

  // GitHub Actions route (free, bina card) — workflow + guide dono maujood.
  const workflow = await fsp.readFile(new URL('./.github/workflows/bot-live.yml', import.meta.url), 'utf8');
  ok(workflow.includes('name: Bot live') && workflow.includes('workflow_dispatch'),
    'workflow: bot-live manual dispatch se chalta hai');
  ok(workflow.includes("cron: '0 */6 * * *'") && workflow.includes('cancel-in-progress: true'),
    'workflow: 6-ghante schedule + purane run ko cancel (409 se bachne ke liye)');
  ok(workflow.includes('INSTANCE_LABEL') && workflow.includes('GITHUB_VAULT_BRANCH'),
    'workflow: per-instance label + alag vault branch');
  ok(workflow.includes("if [ -z \"$BOT_TOKEN\" ]"), 'workflow: token missing ho to skip (noise nahi)');
  ok(workflow.includes('timeout -s SIGTERM'), 'workflow: clean SIGTERM stop (state save)');
  ok(guide.includes('bot-live.yml') && guide.includes('6 ghante'),
    'guide: GitHub Actions route + 6-ghante gap likha hai');

  // Ek-page deploy card + 1-click button (friction kam).
  const deployNow = await fsp.readFile(new URL('./DEPLOY-NOW.md', import.meta.url), 'utf8');
  ok(deployNow.includes('settings/secrets/actions/new') && deployNow.includes('Bot live'),
    'DEPLOY-NOW: Actions route ke exact links');
  ok(deployNow.includes('render.com/deploy?repo=') && deployNow.includes('render.second.yaml'),
    'DEPLOY-NOW: Render 1-click + free blueprint dono');
  ok(deployNow.includes('BOT_TOKEN_3') && deployNow.includes('bot-vault-3'),
    'DEPLOY-NOW: bot3/bot4 ki label + secret table');
  ok(deployNow.includes('Vercel') && deployNow.includes('409'),
    'DEPLOY-NOW: Vercel + duplicate-token warning');
  const readme = await fsp.readFile(new URL('./README.md', import.meta.url), 'utf8');
  ok(readme.includes('render.com/deploy?repo=https://github.com/hulm0408/workwr')
    && readme.includes('DEPLOY-NOW.md'),
  'README: deploy button + DEPLOY-NOW link');

  // ---- Vercel monitor (jo Vercel par ASAL ME chalta hai) ----
  const monitor = await import('./vercel-monitor/lib/health.js');
  ok(monitor.escapeHtml('<b>x</b>') === '&lt;b&gt;x&lt;/b&gt;', 'monitor: HTML escape');
  const targets = monitor.healthTargets({
    BOT_HEALTH_URLS: 'https://bot-a.onrender.com/health, https://bot-b.onrender.com/health , galat-url',
  });
  ok(targets.length === 2, 'monitor: comma-separated URLs parse (galat URL chhoot jata hai)');
  ok(targets[0].name === 'bot-a' && targets[0].url === 'https://bot-a.onrender.com/health',
    'monitor: hostname se naam');
  ok(monitor.healthTargets({}).length === 0, 'monitor: URL nahi to khali list (setup page)');
  ok(monitor.healthTargets({ BOT_HEALTH_URL: 'https://x.onrender.com/health' }).length === 1,
    'monitor: purana single-URL naam bhi chalta hai');

  const down = await monitor.fetchTarget({ url: 'http://127.0.0.1:1/health', name: 'down-bot', label: 'down-bot' });
  ok(down.up === false && Boolean(down.error), 'monitor: down bot par error set, crash nahi');

  const monitorIndex = await fsp.readFile(new URL('./vercel-monitor/api/index.js', import.meta.url), 'utf8');
  const monitorLib = await fsp.readFile(new URL('./vercel-monitor/lib/health.js', import.meta.url), 'utf8');
  ok(monitorIndex.includes('DASH_KEY') && monitorIndex.includes('401'),
    'monitor: optional DASH_KEY gate');
  ok(monitorIndex.includes('escapeHtml(bot.label)'), 'monitor: label escape (XSS safe)');
  ok(monitorLib.includes('AbortSignal.timeout'), 'monitor: fetch timeout (ek down bot poora page nahi atkata)');
  ok(monitorIndex.includes('Content-Type'), 'monitor: HTML content type');

  const monitorPkg = JSON.parse(await fsp.readFile(new URL('./vercel-monitor/package.json', import.meta.url), 'utf8'));
  ok(monitorPkg.type === 'module', 'monitor: ESM package (Vercel Node functions)');
  const vercelJson = JSON.parse(await fsp.readFile(new URL('./vercel-monitor/vercel.json', import.meta.url), 'utf8'));
  ok(vercelJson.rewrites.some((r) => r.destination === '/api/index'),
    'monitor: vercel.json "/" ko dashboard par bhejta hai');
  const monitorReadme = await fsp.readFile(new URL('./vercel-monitor/README.md', import.meta.url), 'utf8');
  ok(monitorReadme.includes('Root Directory') && monitorReadme.includes('vercel-monitor'),
    'monitor: deploy steps me Root Directory=vercel-monitor');
  // ---- Telegram getMe hang guard (Render: health 200 par ready:false stuck) ----
  const fbSrc = await fsp.readFile(new URL('./fresh-bot.js', import.meta.url), 'utf8');
  ok(fbSrc.includes('function withTelegramTimeout('), 'guard: getMe ke liye timeout helper hai');
  ok(fbSrc.includes('TELEGRAM_CALL_TIMEOUT_MS'), 'guard: timeout env se tunable (default 20s)');
  ok(fbSrc.includes("withTelegramTimeout(bot.telegram.getMe(), 'getMe')"),
    'guard: preflight getMe timeout ke andar');
  ok(!/const me = await bot\.telegram\.getMe\(\)/.test(fbSrc),
    'guard: preflight me bina timeout wala getMe nahi bacha');
  ok(fbSrc.includes("'deleteWebhook')"), 'guard: deleteWebhook bhi timeout ke andar');
  ok(fbSrc.includes("'getMe (watchdog)'"), 'guard: watchdog bhi wahi helper use karta hai');

  const vercelDoc = await fsp.readFile(new URL('./VERCEL.md', import.meta.url), 'utf8');
  ok(vercelDoc.includes('vercel-monitor') && vercelDoc.includes('300s'),
    'VERCEL.md: kya chalta hai + function limit likha hai');
  ok(vercelDoc.includes('Upstash') && vercelDoc.includes('QStash'),
    'VERCEL.md: poora rewrite ke 5 steps');
  const deployNow2 = await fsp.readFile(new URL('./DEPLOY-NOW.md', import.meta.url), 'utf8');
  ok(deployNow2.includes('vercel-monitor') && deployNow2.includes('VERCEL.md'),
    'DEPLOY-NOW: Vercel dashboard route ka link');
  if (passed % 1 === 0) { /* keep counter */ }
}

// ---------------------------------------------------------------------------
console.log('Multi-instance shard + JSON file + card polish:');
{
  const shard = await import('./instance-shard.js');
  const fsp = await import('node:fs/promises');

  // Default: sharding OFF (purana behaviour bilkul waisa).
  ok(shard.shardConfig({}).enabled === false, 'shard: default off (single bot)');
  ok(shard.ownsKey('9876543210', {}) === true, 'shard: off hone par har number allowed');
  ok(shard.shardSummary({}).share === 'all', 'shard: off par share = all');

  // bot2/bot3/bot4 → index 1/2/3 of 4
  ok(shard.instanceIndexFromLabel('bot2', 4) === 1, 'shard: bot2 → index 1');
  ok(shard.instanceIndexFromLabel('bot3', 4) === 2, 'shard: bot3 → index 2');
  ok(shard.instanceIndexFromLabel('bot4', 4) === 3, 'shard: bot4 → index 3');
  ok(shard.instanceIndexFromLabel('main', 4) === 0, 'shard: main → index 0');
  ok(shard.instanceIndexFromLabel('', 1) === 0 && shard.instanceIndexFromLabel('bot9', 1) === 0,
    'shard: single instance par index 0');

  const env4 = { INSTANCE_LABEL: 'bot3', INSTANCE_COUNT: '4' };
  ok(shard.shardConfig(env4).enabled === true && shard.shardConfig(env4).index === 2,
    'shard: INSTANCE_COUNT + label se config');

  // Deterministic + disjoint: har phone theek ek instance ka.
  const phones = Array.from({ length: 400 }, (_, i) => `9${String(700000000 + i * 7).slice(0, 9)}`);
  const owners = new Map();
  let disjoint = true;
  for (const label of ['bot2', 'bot3', 'bot4', 'main']) {
    const env = { INSTANCE_LABEL: label, INSTANCE_COUNT: '4' };
    for (const phone of phones) {
      if (!shard.ownsKey(phone, env)) continue;
      if (owners.has(phone)) { disjoint = false; break; }
      owners.set(phone, label);
    }
  }
  ok(disjoint === true, 'shard: koi number do instances ko nahi milta (disjoint slices)');
  ok(owners.size > 200, 'shard: chaar instances milkar pool ke zyadatar numbers cover karte hain');

  // Restart par wahi hissa (stable hash), random nahi.
  const a1 = phones.filter((p) => shard.ownsKey(p, env4));
  const a2 = phones.filter((p) => shard.ownsKey(p, { INSTANCE_LABEL: 'bot3', INSTANCE_COUNT: 4 }));
  ok(a1.join(',') === a2.join(','), 'shard: slice stable hai (restart par same)');

  // Proxy ownership bhi isi hash par.
  ok(shard.ownsProxy({ url: 'http://1.2.3.4:8000' }, env4) === shard.ownsKey('http://1.2.3.4:8000', env4),
    'shard: proxy ownership proxy URL par');
  ok(shard.ownsProxy(null, env4) === true, 'shard: null proxy safe');

  // Lanes cap: 4 bots par 10 lanes → 3
  ok(shard.suggestedConcurrency({ INSTANCE_COUNT: '4' }, 10) === 3, 'shard: 4 instances par lanes 10 → 3');
  ok(shard.suggestedConcurrency({ INSTANCE_COUNT: '2' }, 10) === 5, 'shard: 2 instances par lanes 10 → 5');
  ok(shard.suggestedConcurrency({}, 10) === 10, 'shard: shard off par lanes na chhedo');
  ok(shard.suggestedConcurrency({ INSTANCE_COUNT: '4' }, 2) === 2, 'shard: user ki chhoti value respect hoti hai');

  // Wiring — pool pick, proxy pick, lanes, health/diag.
  const engineSrc = await fsp.readFile(new URL('./autopilot-engine.js', import.meta.url), 'utf8');
  const freshSrc = await fsp.readFile(new URL('./fresh-bot.js', import.meta.url), 'utf8');
  const proxySrc = await fsp.readFile(new URL('./proxy-pool.js', import.meta.url), 'utf8');
  ok(engineSrc.includes('instanceShard.ownsKey(e.phone)'), 'shard: pool picking shard-aware');
  ok(engineSrc.includes('effectiveConcurrency'), 'shard: lanes shard cap se guzarte hain');
  ok(proxySrc.includes('instanceShard.ownsProxy(p)'), 'shard: proxy pick shard-aware');
  ok(freshSrc.includes('shard: instanceShard.shardSummary()'), 'shard: /health me shard');
  ok(freshSrc.includes('🧩 Shard'), 'shard: /diag me shard line');
  ok(freshSrc.includes('INSTANCE_COUNT nahi'), 'shard: boot par warning jab count set nahi');
  ok(freshSrc.includes('telegramSessionTag'), 'shard: shared Telegram session detect hota hai');

  // Telegram session tag — chhota fingerprint, poora session kabhi nahi.
  const tg = await import('./telegram-otp-source.js');
  const tagA = tg.telegramSessionTag({ TELEGRAM_API_ID: '1', TELEGRAM_API_HASH: 'h', TELEGRAM_SESSION: 'abc' });
  const tagB = tg.telegramSessionTag({ TELEGRAM_API_ID: '1', TELEGRAM_API_HASH: 'h', TELEGRAM_SESSION: 'xyz' });
  ok(tagA.length === 10 && tagA !== tagB, 'sessionTag: 10 chars aur sessions alag');
  ok(!tagA.includes('abc'), 'sessionTag: session value leak nahi hota');
  ok(tg.telegramSessionTag({}) === '', 'sessionTag: session na ho to khali');

  // JSON delivery — ab scattered text nahi, layered file send.
  ok(freshSrc.includes('sendSessionFile'), 'json: dedicated file sender');
  ok(freshSrc.includes("label: 'buffer+filename'") && freshSrc.includes("label: 'source+filename'")
    && freshSrc.includes("label: 'value+filename'"),
  'json: teen payload shapes try hoti hain');
  ok(freshSrc.includes('JSON_TEXT_FALLBACK'), 'json: text-chunks sirf opt-in (default off)');
  ok(freshSrc.includes('.json file attach nahi hui'), 'json: fail par saaf message + /session retry');
  ok(!/JSON hissa \$\{i \+ 1\}/.test(freshSrc), 'json: purana "hissa x/y" spam default path se hata');

  // Card polish — percentage bar.
  const rt = await import('./rich-text.js');
  const bar = rt.progressBar(5, 10);
  ok(bar.includes('50%') && bar.includes('▰') && bar.includes('▱'), 'card: progress bar me percentage + soft blocks');
  const bar0 = rt.progressBar(0, 100);
  ok(bar0.includes('0%') && bar0.includes('0/100'), 'card: zero par bhi padhne layak');
  const cardShard = engineSrc.includes('SHARE ${s.shardShare');
  ok(cardShard, 'card: shard share live card par dikhta hai');
}

console.log(`\n✅ ALL PASSED — ${passed} checks`);
