import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoldDropClient, goldDropEmailForMobile, goldDropCaptchaPreflight, isGoldDropDailyOtpLimit, isGoldDropInvalidOtp, isGoldDropSecurityCheck, nocapCheckKey, nocapExplain, nocapSolveTurnstile, retryGoldDropSecurity, signGoldDropPayload, unwrapGoldDropResponse } from './gold-drop-client.js';
import { GoldDropCookieJar } from './gold-drop-cookies.js';
import { extractGoldDropReward, isNewGoldDropReward, findFreshGoldDropReward } from './gold-drop-rewards.js';
import { parseTelegramNumberCard } from './telegram-otp-source.js';
import { parseWinningCodes, checkGoldDropCode, launchGoldDropChecker, launchGoldDropStealthChecker, warmupGoldDropStealth, registerGoldDropStealth, verifyGoldDropOtpStealth } from './gold-drop-checker.js';

const key = 'abcdefghijklmnopqrstuv';
const signed = signGoldDropPayload({ otp: '123456' }, key, 'user', '1234');
const [ts, payload, mixed] = signed.split('.');
const m = Number(mixed[0]), p = Number(mixed[1]);
const digest = mixed.slice(2, 2 + p) + mixed.slice(2 + p + m);
assert.equal(Buffer.from(digest, 'base64').toString(), createHmac('sha256', key.slice(4, 18)).update(`${ts}.${payload}`).digest('hex'));
assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64')), { otp: '123456', userKey: 'user', t: '1234' });
assert.deepEqual(unwrapGoldDropResponse({ resp: Buffer.from('{"ok":true}').toString('base64') }), { ok: true });

const calls = [];
const replies = [{ userKey: 'u', dataKey: key }, { statusCode: 200 }, { statusCode: 200 }];
const client = new GoldDropClient({ fetchImpl: async (url, options) => {
  calls.push({ url, options });
  return new Response(JSON.stringify(replies.shift()), { status: 200 });
} });
await client.bootstrap();
await client.register({ name: 'Rahul Kumar', mobile: '9876543210', email: 'x@example.com', pincode: '509412', code: 'KKD2LS01261026', image: Buffer.from('photo') });
await client.verifyOtp('123456');
// drop.py method: sirf 3 calls — users (session keys) → register → verify-otp.
// Koi get-start call nahi, koi browser/warmup nahi.
assert.equal(calls.length, 3);
// Har call par fixed desktop-Chrome UA jaata hai (drop.py shape).
assert.match(calls[0].options.headers['user-agent'], /Chrome\/120\.0\.0\.0/);
assert.equal(calls[0].options.headers['X-Requested-With'], undefined);
assert.equal(calls[1].options.headers.Cookie, 'gold-drop-id=u');
assert.match(calls[1].options.body.toString(), /name="img"; filename="sample.jpg"/);
assert.match(calls[2].url, /\/users\/verify-otp\/u\?t=/);
assert.equal(calls[2].options.headers.referer, 'https://golddropgolddhamaka.com/otp');

const cookieCalls = [];
const sessionClient = new GoldDropClient({ fetchImpl: async (url, opts) => {
  cookieCalls.push({ url, opts });
  const first = cookieCalls.length === 1;
  const headers = new Headers();
  if (first) {
    headers.append('set-cookie', 'session=one; Path=/api; Secure; HttpOnly');
    headers.append('set-cookie', 'narrow=private; Path=/api/users/get-start; Secure');
    headers.append('set-cookie', 'foreign=ignored; Domain=example.com; Path=/');
  }
  return new Response(JSON.stringify(first ? { userKey: 'u', dataKey: key } : { statusCode: 200 }), { status: 200, headers });
} });
await sessionClient.bootstrap();
await sessionClient.register({ name: 'Rahul Kumar', mobile: '9876543210', email: 'x@example.com', pincode: '509412', code: 'KKD2LS01261026', image: Buffer.from('photo') });
// Ab get-start call nahi hoti — cookieCalls[0] = users (bootstrap), [1] = register.
// narrow cookie ka Path=/api/users/get-start tha, isliye kahin nahi jaata.
assert.equal(cookieCalls.length, 2);
assert.match(cookieCalls[1].opts.headers.Cookie, /session=one/);
assert.doesNotMatch(cookieCalls[1].opts.headers.Cookie, /narrow=private|foreign=ignored/);
assert.match(cookieCalls[1].opts.headers.Cookie, /gold-drop-id=u/);
const jar = new GoldDropCookieJar('https://example.com/api');
const hdr = new Headers(); hdr.append('set-cookie', 'x=1; Path=/api; Secure');
jar.store(hdr, 'https://example.com/api/users');
assert.equal(jar.header('https://other.example.com/api/users'), '');
assert.equal(jar.header('https://example.com/apix'), '');
const removed = new Headers(); removed.append('set-cookie', 'x=; Path=/api; Max-Age=0');
jar.store(removed, 'https://example.com/api/users');
assert.equal(jar.header('https://example.com/api/users'), '');
// importCookies: stealth warmup ke browser cookies (Playwright/CDP format)
const warmJar = new GoldDropCookieJar('https://golddropgolddhamaka.com/api');
const importedCount = warmJar.importCookies([
  { name: 'cf_clearance', value: 'tok123', domain: '.golddropgolddhamaka.com', path: '/', secure: true, expires: 2000000000 },
  { name: 'session_cookie', value: 's1', domain: 'golddropgolddhamaka.com', path: '/api', secure: true, expires: -1 },
  { name: 'expired_one', value: 'x', domain: '.golddropgolddhamaka.com', path: '/', secure: true, expires: 1000 },
  { name: 'foreign', value: 'x', domain: '.other.example.com', path: '/', secure: true, expires: 2000000000 },
  { name: 'parent', value: 'x', domain: '.example.com', path: '/', secure: true, expires: 2000000000 },
  { name: 'bad name!', value: 'x', domain: '.golddropgolddhamaka.com', path: '/', secure: false, expires: 2000000000 },
]);
assert.equal(importedCount, 2);
assert.match(warmJar.header('https://golddropgolddhamaka.com/api/users'), /cf_clearance=tok123/);
assert.match(warmJar.header('https://golddropgolddhamaka.com/api/users'), /session_cookie=s1/);
assert.doesNotMatch(warmJar.header('https://golddropgolddhamaka.com/api/users'), /foreign|parent|expired_one|bad name/);
assert.equal(warmJar.header('https://other.example.com/api/users'), '');
assert.equal(warmJar.header('http://golddropgolddhamaka.com/api/users'), ''); // secure cookies http par nahi

// 🛡️ Security-check flow: register reject → sitekey site se → NoCaptchaAI
// solve → 1 retry jisme cf-turnstile-response field ke saath token jaata hai.
{
  const seen = [];
  let regAttempts = 0;
  const nocapClient = new GoldDropClient({
    nocapApiKey: 'nocap_testkey',
    fetchImpl: async (url, options = {}) => {
      const u = String(url);
      seen.push(u);
      if (options.method === 'POST' && u.endsWith('/api/users')) {
        return new Response(JSON.stringify({ userKey: 'u', dataKey: key }), { status: 200 });
      }
      if (options.method === 'POST' && u.includes('/api/users/register/')) {
        regAttempts++;
        const body = options.body.toString();
        if (!body.includes('cf-turnstile-response')) {
          return new Response(JSON.stringify({ message: 'Please complete the security check to continue' }), { status: 400 });
        }
        assert.match(body, /name="cf-turnstile-response"\r\n\r\ntok123/);
        return new Response(JSON.stringify({ statusCode: 200, message: 'OTP sent' }), { status: 200 });
      }
      if (u === 'https://golddropgolddhamaka.com/register') { // sitekey fetch (GET page)
        return new Response('<html><script>window.sk="0x4AAAAAAABkMYinukE8nvUc7h";</script></html>', { status: 200 });
      }
      if (u.endsWith('/createTask')) {
        return new Response(JSON.stringify({ errorId: 0, status: 'idle', taskId: 't1' }), { status: 200 });
      }
      if (u.endsWith('/getTaskResult')) {
        return new Response(JSON.stringify({ errorId: 0, status: 'ready', solution: { token: 'tok123' } }), { status: 200 });
      }
      throw new Error(`unexpected ${u}`);
    },
  });
  await nocapClient.bootstrap();
  const secured = await nocapClient.register({ name: 'Rahul Kumar', mobile: '9876543210', email: 'x@example.com', pincode: '509412', code: 'KKD2LS01261026', image: Buffer.from('photo') });
  assert.equal(secured.statusCode, 200);
  assert.equal(regAttempts, 2); // pehla bina token (reject), doosra token ke saath
  assert.ok(seen.includes('https://golddropgolddhamaka.com/register'));
}
await assert.rejects(client.verifyOtp('123'), /six digits/);
const sample = '▪️ ʟᴀꜱᴛ ꜱᴍꜱ\n[VK-BGCITY-S] Success! Your Reward Code is 7E8RJ9MMYFWA. Please visit https://www.go\nᴛɪᴍᴇ: 17-11-2026 | 05:21 pm';
assert.deepEqual(extractGoldDropReward(sample), { code: '7E8RJ9MMYFWA', sms: '[VK-BGCITY-S] Success! Your Reward Code is 7E8RJ9MMYFWA. Please visit https://www.go' });
assert.equal(isNewGoldDropReward(sample, []), true);
assert.equal(isNewGoldDropReward(sample, [`1|${sample}`]), false);
assert.equal(isNewGoldDropReward(sample.replace('05:21', '05:22'), [`1|${sample}`]), false);
assert.equal(extractGoldDropReward('OTP 123456, registration success'), null);
assert.deepEqual(extractGoldDropReward('[VK-BGCITY-S] Your reward code: ABC12345. Redeem now'), { code: 'ABC12345', sms: '[VK-BGCITY-S] Your reward code: ABC12345. Redeem now' });
assert.deepEqual(extractGoldDropReward('[VK-BGCITY-S] Your reward code is\nAB12CD34. Visit the site\nTIME: 5:21'), { code: 'AB12CD34', sms: '[VK-BGCITY-S] Your reward code is\nAB12CD34. Visit the site' });
assert.equal(extractGoldDropReward('Your OTP code is 123456'), null);
const hathiCard = '━[ 📞 ʏᴏᴜʀ ɴᴜᴍʙᴇʀ ]━\n────────────────────\n📞 ɴᴜᴍʙᴇʀ: +91 70025 99623\n🟢 ꜱᴛᴀᴛᴜꜱ: ᴀᴄᴛɪᴠᴇ\n📱 ᴅᴇᴠɪᴄᴇ: RMX1827\n\n▪ ʟᴀꜱᴛ ꜱᴍꜱ\n[JX-BGCITY-S] Success! Your Reward Code is 7EKMXEY3R3H3. Please visit https://www.go\nᴛɪᴍᴇ: 17-11-2026 | 06:47 PM\n\n━ ⚡ HATHIX OTP ━';
assert.equal(parseTelegramNumberCard(hathiCard)?.phone, '7002599623');
const cardPhoneOf = text => parseTelegramNumberCard(text)?.phone || '';
const hathiReward = { code: '7EKMXEY3R3H3', sms: '[JX-BGCITY-S] Success! Your Reward Code is 7EKMXEY3R3H3. Please visit https://www.go' };
assert.deepEqual(findFreshGoldDropReward([{ id: 10, text: hathiCard }], { phone: '7002599623', baseline: ['10|old OTP card'], cardPhoneOf }), hathiReward);
assert.equal(findFreshGoldDropReward([{ id: 10, text: hathiCard }], { phone: '9999999999', baseline: [], cardPhoneOf }), null);
assert.equal(findFreshGoldDropReward([{ id: 10, text: hathiCard }], { phone: '7002599623', baseline: [`10|${hathiCard}`], cardPhoneOf }), null);
assert.equal(findFreshGoldDropReward([{ id: 10, text: hathiCard }], { phone: '7002599623', deliveredCodes: new Set(['7EKMXEY3R3H3']), cardPhoneOf }), null);
assert.equal(goldDropEmailForMobile('itsnoob012@gmail.com', '9876543210', () => 0), 'itsnoob012+987654@gmail.com');
assert.equal(goldDropEmailForMobile('itsnoob012@gmail.com', '9876543210', n => n - 1), 'itsnoob012+012345@gmail.com');
assert.throws(() => goldDropEmailForMobile('not-an-email', '9876543210'), /Invalid/);
assert.throws(() => goldDropEmailForMobile('itsnoob012@gmail.com', '123'), /Invalid/);
const limitMessage = 'Your OTP limit for today is exhausted. Please try again tomorrow';
assert.equal(isGoldDropDailyOtpLimit(new Error(`Gold Drop HTTP 400: ${limitMessage}`)), true);
assert.equal(isGoldDropDailyOtpLimit(new Error(limitMessage)), true);
assert.equal(isGoldDropDailyOtpLimit(new Error(`Gold Drop HTTP 400: ${limitMessage}"`)), true);
assert.equal(isGoldDropInvalidOtp(new Error('Gold Drop HTTP 400: Invalid OTP, Please enter OTP ')), true);
assert.equal(isGoldDropInvalidOtp(new Error('Invalid OTP, Please enter OTP"')), true);
assert.equal(isGoldDropInvalidOtp(new Error('Gold Drop HTTP 500: internal error')), false);
assert.equal(isGoldDropInvalidOtp(new Error('fetch failed')), false);
assert.equal(isGoldDropDailyOtpLimit(new Error('Gold Drop HTTP 400: Please try again tomorrow using the same number')), true);
assert.equal(isGoldDropDailyOtpLimit(new Error('Gold Drop HTTP 429: Too many requests')), false);
assert.equal(isGoldDropDailyOtpLimit(new Error('fetch failed')), false);
for (const status of [200, 400]) {
  const limited = new GoldDropClient({ fetchImpl: async () => new Response(JSON.stringify({ statusCode: 400, message: limitMessage }), { status }) });
  limited.userKey = 'u'; limited.dataKey = key;
  await assert.rejects(limited.register({ name: 'Rahul Kumar', mobile: '9876543210', email: 'x@example.com', pincode: '509412', code: 'KKD2LS01261026', image: Buffer.from('photo') }), isGoldDropDailyOtpLimit);
}
for (const status of [200, 400]) {
  const invalid = new GoldDropClient({ fetchImpl: async () => new Response(JSON.stringify({ statusCode: 400, message: 'Invalid OTP, Please enter OTP' }), { status }) });
  invalid.userKey = 'u'; invalid.dataKey = key;
  await assert.rejects(invalid.verifyOtp('123456'), isGoldDropInvalidOtp);
}
const securityMessage = 'Please complete the security check to continue.';
assert.equal(isGoldDropSecurityCheck(new Error(`Gold Drop HTTP 400: ${securityMessage}`)), true);
assert.equal(isGoldDropSecurityCheck(new Error('fetch failed')), false);
for (const status of [200, 400]) {
  const blocked = new GoldDropClient({ nocapApiKey: 'off', fetchImpl: async () => new Response(JSON.stringify({ statusCode: 400, message: securityMessage }), { status }) });
  await assert.rejects(blocked.bootstrap(), isGoldDropSecurityCheck);
  blocked.userKey = 'u'; blocked.dataKey = key;
  // Security rejection par NoCaptchaAI retry hota hai; key OFF hone par loud error.
  await assert.rejects(blocked.register({ name: 'Rahul Kumar', mobile: '9876543210', email: 'x@example.com', pincode: '509412', code: 'KKD2LS01261026', image: Buffer.from('photo') }), /NoCaptchaAI key OFF/);
}
// ─── NoCaptchaAI: docs v2 ke error codes + turnstile poll flow ───
// Turnstile subscription plan me nahi aata — wallet khaali ho to yeh reason
// aana chahiye (yahi "recharge ke baad bhi solve nahi hua" ka asli kaaran tha).
assert.match(nocapExplain({ errorId: 1, errorCode: 'ERROR_ZERO_BALANCE' }), /wallet.*top-up/i);
assert.match(nocapExplain({ errorCode: 'ERROR_KEY_DOES_NOT_EXIST' }), /key galat/i);
assert.match(nocapExplain({ errorCode: 'ERROR_NO_SLOT_AVAILABLE' }), /busy/i);
assert.equal(nocapExplain({ errorId: 0 }), '');

function nocapFake(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init?.body || '{}');
    calls.push({ url, body });
    const out = handler(url, body);
    return new Response(JSON.stringify(out), { status: 200 });
  };
  return { calls, fetchImpl };
}

// 1) pehla type reject, doosra chale → token (aur dono type try hue)
{
  const fake = nocapFake((url, body) => {
    if (url.endsWith('/createTask')) {
      return body.task.type === 'TurnstileTaskProxyLess'
        ? { errorId: 1, errorCode: 'ERROR_BAD_PARAMETERS', errorDescription: 'bad type' }
        : { errorId: 0, status: 'idle', taskId: 'T1' };
    }
    return { errorId: 0, status: 'ready', solution: { token: 'TOKEN-OK' } };
  });
  assert.equal(await nocapSolveTurnstile('k', '0x4AAAA', 'https://x/register', { fetchImpl: fake.fetchImpl, sleepFn: async () => {} }), 'TOKEN-OK');
  assert.equal(fake.calls.filter(c => c.url.endsWith('/createTask')).length, 2);
}

// 2) wallet khaali → saaf reason (silent "fail" nahi)
{
  const fake = nocapFake(() => ({ errorId: 1, errorCode: 'ERROR_ZERO_BALANCE' }));
  await assert.rejects(
    nocapSolveTurnstile('k', '0x4AAAA', 'https://x/register', { fetchImpl: fake.fetchImpl, sleepFn: async () => {} }),
    /wallet.*top-up/i,
  );
}

// 3) ready par khali token → loud error
{
  const fake = nocapFake(url => url.endsWith('/createTask')
    ? { errorId: 0, taskId: 'T2' }
    : { errorId: 0, status: 'ready', solution: {} });
  await assert.rejects(
    nocapSolveTurnstile('k', '0x4AAAA', 'https://x/register', { fetchImpl: fake.fetchImpl, sleepFn: async () => {} }),
    /khali token/,
  );
}

// 4) key check: ok aur zero-balance dono
{
  const okFake = nocapFake(() => ({ errorId: 0, taskId: 'PROBE1' }));
  const ok = await nocapCheckKey('nocap_test', { fetchImpl: okFake.fetchImpl });
  assert.equal(ok.ok, true);
  assert.equal(ok.taskId, 'PROBE1');
  const badFake = nocapFake(() => ({ errorId: 1, errorCode: 'ERROR_ZERO_BALANCE' }));
  const bad = await nocapCheckKey('nocap_test', { fetchImpl: badFake.fetchImpl });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /wallet/i);
}

// 5) sitekey: data-sitekey attribute pehle, phir plain 0x4… string
{
  const attr = async () => new Response('<div class="cf-turnstile" data-sitekey="0x4AAAAAAAabcdefghijklmnop"></div>', { status: 200 });
  const { fetchTurnstileSitekey } = await import('./gold-drop-client.js');
  assert.equal(await fetchTurnstileSitekey(attr, 'https://x/register'), '0x4AAAAAAAabcdefghijklmnop');
  const plain = async () => new Response('<script>turnstile.render({sitekey:"0x4BBBBBBBaveryverylongsitekey"})</script>', { status: 200 });
  assert.equal(await fetchTurnstileSitekey(plain, 'https://x/register'), '0x4BBBBBBBaveryverylongsitekey');
  const blockedPage = async () => new Response('<title>Just a moment...</title>', { status: 200 });
  await assert.rejects(fetchTurnstileSitekey(blockedPage, 'https://x/register'), /Cloudflare challenge/);
}

// 6) preflight: key off → turant reason, sitekey phir bhi try
{
  const diag = await goldDropCaptchaPreflight('off', { fetchImpl: async () => new Response('<i data-sitekey="0x4CCCCCCCCsitekeykeykeykey">', { status: 200 }) });
  assert.equal(diag.keyOk, false);
  assert.equal(diag.sitekey, '0x4CCCCCCCCsitekeykeykeykey');
}

assert.deepEqual(parseWinningCodes('ABC123\nxyz987 ABC123'), ['ABC123', 'XYZ987']);
assert.throws(() => parseWinningCodes('bad/code'), /letters\/digits/);
assert.throws(() => parseWinningCodes('A'.repeat(13)), /12 characters/);
function mockCheckerPage({ security = true, view = { body: '', errors: [], otpField: true } } = {}) {
  const clicks = [];
  const page = {
    goto: async () => {}, waitForSelector: async () => {}, type: async () => {},
    $eval: async () => false, click: async selector => { clicks.push(selector); },
    waitForFunction: async () => { if (!security) throw new Error('timeout'); },
    waitForNavigation: async () => {}, evaluate: async () => view, close: async () => {},
  };
  return { browser: { newPage: async () => page }, clicks };
}
const allowed = mockCheckerPage();
assert.equal((await checkGoldDropCode(allowed.browser, { code: 'ABC123', name: 'Rahul Kumar', mobile: '9876543210' })).status, 'otp_sent');
assert.equal(allowed.clicks.includes('#enbBtn'), true);
const blocked = mockCheckerPage({ security: false });
assert.equal((await checkGoldDropCode(blocked.browser, { code: 'ABC123', name: 'Rahul Kumar', mobile: '9876543210' })).status, 'security_check');
assert.equal(blocked.clicks.includes('#enbBtn'), false);
const rejected = mockCheckerPage({ view: { body: '', errors: ['Invalid winning code'], otpField: false } });
assert.equal((await checkGoldDropCode(rejected.browser, { code: 'ABC123', name: 'Rahul Kumar', mobile: '9876543210' })).message, 'Invalid winning code');
let attempts = 0, waited = 0, waitNotices = 0;
assert.equal(await retryGoldDropSecurity(async () => {
  if (++attempts < 3) throw new Error(securityMessage);
  return 'ok';
}, { delayMs: 60000, sleep: async ms => { waited += ms; }, onWait: async () => { waitNotices++; } }), 'ok');
assert.equal(attempts, 3);
assert.equal(waited, 120000);
assert.equal(waitNotices, 2);
let blockedAttempts = 0;
await assert.rejects(retryGoldDropSecurity(async () => { blockedAttempts++; throw new Error(securityMessage); }, { maxRetries: 3, delayMs: 1, sleep: async () => {} }), isGoldDropSecurityCheck);
assert.equal(blockedAttempts, 4);
let otherAttempts = 0;
await assert.rejects(retryGoldDropSecurity(async () => { otherAttempts++; throw new Error('network error'); }, { sleep: async () => {} }), /network error/);
assert.equal(otherAttempts, 1);
let stopped = false, cancelledAttempts = 0;
await assert.rejects(retryGoldDropSecurity(async () => { cancelledAttempts++; throw new Error(securityMessage); }, { shouldStop: () => stopped, sleep: async () => { stopped = true; } }), /stopped/);
assert.equal(cancelledAttempts, 1);

// ─── Stealth bridge: SeleniumBase CDP mode + Playwright connect_over_cdp ───
let python3 = '';
for (const candidate of ['python3', 'python']) {
  try { execFileSync(candidate, ['--version'], { stdio: 'pipe' }); python3 = candidate; break; } catch {}
}
if (python3) {
  // Worker ka syntax + offline selftest (browser launch nahi hota).
  execFileSync(python3, ['-m', 'py_compile', 'gold_drop_stealth.py'], { stdio: 'pipe' });
  assert.match(execFileSync(python3, ['gold_drop_stealth.py', '--selftest'], { encoding: 'utf8' }), /selftest OK/);

  // Fake worker: NDJSON protocol, ek garbage line bhi bhejta hai (ignore honi chahiye).
  const fakeWorker = join(mkdtempSync(join(tmpdir(), 'gold-fake-worker-')), 'fake_worker.py');
  writeFileSync(fakeWorker, String.raw`import json, os, sys

def send(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()

sys.stdout.write("ye line JSON nahi hai — bridge ko ignore karni chahiye\n")
sys.stdout.flush()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    cmd = json.loads(line)
    kind = cmd.get("cmd")
    if kind == "ping":
        send({"type": "pong"})
    elif kind == "launch":
        send({"type": "ready", "id": cmd.get("id"), "endpointUrl": "http://127.0.0.1:19222"})
    elif kind == "check":
        if cmd.get("code") == "CRASH":
            os._exit(3)
        send({"type": "result", "id": cmd.get("id"), "status": "otp_sent", "message": "fake:" + str(cmd.get("code"))})
    elif kind == "warmup":
        send({"type": "warmup", "id": cmd.get("id"), "ok": True, "userAgent": "FakeStealthUA/9.9",
              "cookies": [{"name": "cf_clearance", "value": "abc123", "domain": ".golddropgolddhamaka.com",
                            "path": "/", "secure": True, "expires": 2000000000},
                          {"name": "foreign", "value": "nope", "domain": ".other.example.com",
                            "path": "/", "secure": True, "expires": 2000000000}]})
    elif kind == "register":
        if cmd.get("mobile") == "9000000000":
            send({"type": "register", "id": cmd.get("id"), "ok": False,
                  "message": "Your OTP limit for today is exhausted. Please try again tomorrow."})
        else:
            send({"type": "register", "id": cmd.get("id"), "ok": True, "stage": "otp",
                  "message": "Site ne OTP step dikhaya."})
    elif kind == "verify":
        if cmd.get("otp") == "000000":
            send({"type": "verify", "id": cmd.get("id"), "ok": False, "message": "Invalid OTP, Please enter OTP"})
        else:
            send({"type": "verify", "id": cmd.get("id"), "ok": True, "message": "Site ne verify success dikhaya."})
    elif kind == "close":
        break
sys.exit(0)
`);

  // Handshake endpointUrl deta hai; check commands parse hote hain; close saaf.
  const stealth = await launchGoldDropStealthChecker({ pythonPath: python3, workerPath: fakeWorker });
  assert.equal(stealth.stealth, true);
  assert.equal(stealth.endpointUrl, 'http://127.0.0.1:19222');
  assert.deepEqual(await checkGoldDropCode(stealth, { code: 'ABC123', name: 'Rahul Kumar', mobile: '9876543210' }), { status: 'otp_sent', message: 'fake:ABC123' });
  assert.equal((await checkGoldDropCode(stealth, { code: 'XYZ987', name: 'Rahul Kumar', mobile: '9876543210' })).message, 'fake:XYZ987');
  await stealth.close();
  assert.equal(stealth.closed, true);

  // Worker crash → pending + baad ke checks dono saaf reject hote hain.
  const crashing = await launchGoldDropStealthChecker({ pythonPath: python3, workerPath: fakeWorker });
  await assert.rejects(checkGoldDropCode(crashing, { code: 'CRASH', name: 'x', mobile: '9876543210' }), /band ho gaya/);
  await assert.rejects(checkGoldDropCode(crashing, { code: 'ABC123', name: 'x', mobile: '9876543210' }), /band hai/);
  await crashing.close();

  // Warmup: clearance cookies + browser UA wapas aate hain (checker bridge).
  // (Registration ka direct drop.py API flow ab warmup cookies use nahi karta.)
  const warming = await launchGoldDropStealthChecker({ pythonPath: python3, workerPath: fakeWorker });
  const warm = await warmupGoldDropStealth(warming);
  assert.equal(warm.ok, true);
  assert.equal(warm.userAgent, 'FakeStealthUA/9.9');
  assert.equal(warm.cookies.length, 2);

  // Browser-native registration: site ke messages verbatim aate hain, taaki
  // daily-limit / invalid-OTP classification bilkul API flow jaisa rahe.
  const regOk = await registerGoldDropStealth(warming, { name: 'Rahul Kumar', mobile: '9876543210', email: 'x@gmail.com', pincode: '509412', code: 'KKD2LS01261026', image: '' });
  assert.equal(regOk.ok, true);
  assert.equal(regOk.stage, 'otp');
  const regLimited = await registerGoldDropStealth(warming, { name: 'Rahul Kumar', mobile: '9000000000', email: 'x@gmail.com', pincode: '509412', code: 'KKD2LS01261026', image: '' });
  assert.equal(regLimited.ok, false);
  assert.equal(isGoldDropDailyOtpLimit(new Error(regLimited.message)), true);
  const verifyOk = await verifyGoldDropOtpStealth(warming, '123456');
  assert.equal(verifyOk.ok, true);
  const verifyBad = await verifyGoldDropOtpStealth(warming, '000000');
  assert.equal(verifyBad.ok, false);
  assert.equal(isGoldDropInvalidOtp(new Error(verifyBad.message)), true);
  await warming.close();

  // Asal worker protocol smoke test — ping/pong/close bina browser ke chalta
  // hai (seleniumbase/playwright sirf launch par import hote hain).
  const real = spawn(python3, ['-u', 'gold_drop_stealth.py', '--serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let realBuffer = '';
  const lineWaiters = [];
  real.stdout.setEncoding('utf8');
  real.stdout.on('data', chunk => {
    realBuffer += chunk;
    let index;
    while ((index = realBuffer.indexOf('\n')) >= 0) {
      const line = realBuffer.slice(0, index).trim();
      realBuffer = realBuffer.slice(index + 1);
      if (line && lineWaiters.length) lineWaiters.shift()(line);
    }
  });
  const nextLine = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker response timeout')), 15000);
    lineWaiters.push(line => { clearTimeout(timer); resolve(line); });
  });
  const pongPromise = nextLine();
  real.stdin.write(JSON.stringify({ cmd: 'ping' }) + '\n');
  assert.deepEqual(JSON.parse(await pongPromise), { type: 'pong' });
  const exitPromise = new Promise(resolve => real.once('exit', resolve));
  real.stdin.write(JSON.stringify({ cmd: 'close' }) + '\n');
  assert.equal(await Promise.race([exitPromise, new Promise((_, reject) => setTimeout(() => reject(new Error('close timeout')), 15000))]), 0);
}

// Engine selection: GOLD_DROP_STEALTH=0 → seedha puppeteer (Chromium zaroori).
process.env.GOLD_DROP_STEALTH = '0';
await assert.rejects(launchGoldDropChecker(''), /Chromium nahi mila/);
// STRICT stealth (1): worker na chale to error hi milta hai, fallback nahi.
process.env.GOLD_DROP_STEALTH = '1';
await assert.rejects(launchGoldDropChecker('', { pythonPath: '/nonexistent-python-gold-drop' }), /start nahi hua/);
// auto (default): stealth fail → puppeteer-real-browser fallback.
delete process.env.GOLD_DROP_STEALTH;
await assert.rejects(launchGoldDropChecker('', { pythonPath: '/nonexistent-python-gold-drop' }), /Chromium nahi mila/);

console.log('Gold Drop client, reward, checker and stealth-bridge tests passed');
