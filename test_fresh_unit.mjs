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

console.log(`\n✅ ALL PASSED — ${passed} checks`);
