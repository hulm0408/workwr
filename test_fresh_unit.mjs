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
    return respond(mock.messages[devId] ?? null);
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

const {
  normalizePoolPhone, _parsePool, _parseClientsPool, _parseTs,
  parseForwarderDateTime, _extractSixDigitCode, isFirebaseConfigured,
  listPoolNumbers, fetchOtpCandidates, snapshotSeenOtpState, waitForOtpCode,
  setFirebaseSource, getFirebaseSource,
} = await import('./firebase-numbers.js');
const { freshEntriesFrom, preferOnline, getPremiumLedger } = await import('./number-pipeline.js');
const { getAutopilotSnapshot, isAutopilotRunning, requestAutopilotStop } = await import('./autopilot-engine.js');
const srcMod = await import('./firebase-sources.js');
const bs = await import('./bot-settings.js');
const px = await import('./proxy-pool.js');

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
  ok(Boolean(srcMod.getActiveSource()), 'active source set');

  const before = srcMod.listSources().length;
  const bad = srcMod.addSource({ url: 'https://not-a-firebase.example.com' });
  ok(bad.ok === false, 'galat URL reject');
  const dup = srcMod.addSource({ url: srcMod.getActiveSource().url });
  ok(dup.ok === false, 'duplicate URL reject');
  const add = srcMod.addSource({ url: 'https://secondfb-default-rtdb.firebaseio.com', name: 'Second' });
  ok(add.ok === true && add.source.active === true, 'naya source add + auto-active');
  ok(srcMod.listSources().length === before + 1, 'list me add ho gaya');
  ok(srcMod.getActiveSource().name === 'Second', 'active source badal gaya');
  ok(getFirebaseSource()?.url === 'https://secondfb-default-rtdb.firebaseio.com', 'reader par bhi apply (auto)');

  const first = srcMod.listSources().find((s) => s.name !== 'Second');
  const sw = srcMod.setActiveSource(first.id);
  ok(sw.ok === true && srcMod.getActiveSource().id === first.id, 'manual switch kaam karta hai');

  const tg = srcMod.toggleSource(first.id);
  ok(tg.ok === true && tg.enabled === false, 'disable ho gaya');
  ok(srcMod.getActiveSource().id !== first.id, 'disabled active = auto-next par shift');
  srcMod.toggleSource(first.id);

  const rm = srcMod.removeSource(add.source.id);
  ok(rm.ok === true, 'delete ho gaya');
  const onlyOne = srcMod.listSources();
  if (onlyOne.length === 1) {
    ok(srcMod.removeSource(onlyOne[0].id).ok === false, 'aakhri source delete nahi hota');
  }
  srcMod.applyActiveSource();
  ok(getFirebaseSource() !== null || isFirebaseConfigured(), 'applyActiveSource baad bhi safe');
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
  const all = bs.getAllSettings();
  ok(all.target === 150 && all.allowOffline === true, 'getAllSettings consistent');
  bs.setSetting('target', 100); // restore default
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

  // Per-proxy WAF token (IP-bound hota hai)
  px.setProxyToken(a.id, 'TOKEN_FOR_IP_A'.padEnd(60, 'x'));
  ok(px.getProxyToken(a.id).startsWith('TOKEN_FOR_IP_A'), 'token per-proxy store');
  ok(px.getProxyToken(b.id) === '', 'doosre proxy par wo token nahi (IP-bound)');
  px.invalidateProxyToken(a.id);
  ok(px.getProxyToken(a.id) === '', 'token invalidate');

  // Cooldown — hit hone par proxy thodi der side par
  px.markProxyWafHit(a.id, 60_000);
  const detail = px.listProxies().find((x) => x.id === a.id);
  ok(detail.cooldownLeftMs > 50_000, 'cooldown set (proxy side par)');
  const d = px.pickProxy({ excludeIds: [] });
  ok(d && d.id !== a.id, 'cooldown wala proxy pick nahi hua');

  // Error / success streak
  px.markProxyError(b.id);
  ok(px.listProxies().find((x) => x.id === b.id).consecutiveErrors === 1, 'error count');
  px.markProxySuccess(b.id);
  ok(px.listProxies().find((x) => x.id === b.id).consecutiveErrors === 0, 'success = errors reset');

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
  const t2 = await fbn.fetchDeviceLastActivityMs('devStale');
  ok(Boolean(t2) && (now - t2) > 60_000, 'purani dateTime wali activity stale pehchani');
  ok((await fbn.fetchDeviceLastActivityMs('devMissing')) === null, 'khali/missing device → null');

  // Stale device: OTP request Swiggy tak jani hi nahi chahiye
  const callsBefore = mock.calls.length;
  const r1 = await pipe.processSingleNumber({
    userId: 'test',
    entry: { phone: '9812345670', deviceId: 'devStale', online: true },
    otpCfg: { activeWindowMs: 60_000, waitMs: 0, timeoutMs: 100 },
  });
  ok(r1.kind === 'deferred_device_stale', 'stale device → deferred_device_stale (OTP nahi bheja)');
  ok(!mock.calls.slice(callsBefore).some((u) => u.includes('swiggy.com')), 'stale par Swiggy ko ek bhi request nahi gayi');
  ok(r1.ok === false && Boolean(r1.reason), 'stale result me wajah hai');

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
  }
}

// ---------------------------------------------------------------------------
console.log('fresh JSON chat me turant bhejna (export + engine notify):');
{
  const store = await import('./store.js');
  const engine = await import('./autopilot-engine.js');

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
}

// ---------------------------------------------------------------------------
console.log('WAF challenge survival (jala token invalidate + batch-marta-nahi ladder):');
{
  const wafPool = await import('./waf-pool.js');
  const engine = await import('./autopilot-engine.js');
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

  // Engine wait ladder: 30s → 60s → 120s → 240s; pool cooldown lamba ho to wahi (5 min cap)
  ok(engine.wafChallengeWaitMs(1, 0) === 30_000, 'ladder strike1 = 30s (pehle seedha 1-3 min tha)');
  ok(engine.wafChallengeWaitMs(2, 0) === 60_000 && engine.wafChallengeWaitMs(3, 0) === 120_000, 'ladder strike2/3 = 60s/120s');
  ok(engine.wafChallengeWaitMs(9, 0) === 240_000, 'ladder cap 240s (strike chahe kitne bhi)');
  ok(engine.wafChallengeWaitMs(1, 4 * 60_000) === 4 * 60_000, 'pool cooldown lamba ho to wahi jeet');
  ok(engine.wafChallengeWaitMs(1, 30 * 60_000) === 5 * 60_000, 'ek saath max 5 min (batch zinda rahe)');
  ok(engine.wafChallengeWaitMs(0, 0) === 30_000, 'strikes 0/invalid → pehla step (30s)');
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
  ok(r3.sourcesOk >= 1 && r3.sourcesTotal >= 10 && r3.candidates >= 2 && r3.stats?.challenged === 1,
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

console.log(`\n✅ ALL PASSED — ${passed} checks`);
