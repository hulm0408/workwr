// ===== ❤️ RENDER KEEP-ALIVE — free Web Service ko sone se rokna =====
//
// Render ka Free Web Service 15 minute tak koi inbound HTTP traffic na
// mile to spin down ho jata hai. Telegram long-polling outbound hai, isliye
// batch chal raha ho tab bhi Render use "inactive" samajh kar band kar
// sakta hai.
//
// Is module ka kaam: service khud apne PUBLIC Render URL (/health) ko
// har 5 minute par GET kare. Request Render ke public router se hokar
// wapas aati hai, isliye wo inbound traffic count hoti hai. localhost
// ping se ye kaam nahi hota.
//
// Note: agar service kisi wajah se phir bhi so jaye to soya hua process
// khud timer nahi chala sakta — bahar wala cron (cron-job.org waghera)
// use jaga dega, phir ye self-ping dobara neend rokta rahega.

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 14 * 60_000;
const RETRY_DELAY_MS = 30_000;
const FIRST_PING_DELAY_MS = 30_000;

function isDisabledValue(value) {
  return ['0', 'false', 'off', 'no', 'disabled'].includes(String(value || '').trim().toLowerCase());
}

export function isKeepAliveEnabled(env = process.env) {
  if (isDisabledValue(env.KEEP_ALIVE_ENABLED)) return false;
  if (isDisabledValue(env.KEEP_ALIVE)) return false;
  return true;
}

function safeUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLocalHostname(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  return !host || host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1';
}

export function resolveKeepAliveUrl(env = process.env) {
  const candidates = [
    env.KEEP_ALIVE_URL,
    env.SELF_PING_URL,
    env.RENDER_EXTERNAL_URL,
    env.PUBLIC_URL,
  ];

  for (const candidate of candidates) {
    const url = safeUrl(candidate);
    if (!url) continue;
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    if (isLocalHostname(url.hostname)) continue;

    // Render spun-down service par /robots.txt ko khud jawab de deta hai;
    // wo request service ko jagati nahi. Galti se wahi URL set ho to
    // asal /health route par badal do.
    if (!url.pathname || url.pathname === '/' || url.pathname === '/robots.txt') {
      url.pathname = '/health';
    }
    url.hash = '';
    url.username = '';
    url.password = '';
    return url.toString();
  }

  const hostname = String(env.RENDER_EXTERNAL_HOSTNAME || '').trim();
  if (hostname && !isLocalHostname(hostname)) {
    return `https://${hostname.replace(/^https?:\/\//i, '').replace(/\/+$/, '')}/health`;
  }
  return '';
}

export function keepAliveIntervalMs(env = process.env) {
  const rawMs = Number(env.KEEP_ALIVE_INTERVAL_MS);
  if (Number.isFinite(rawMs) && rawMs > 0) {
    return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(rawMs)));
  }
  const rawMinutes = Number(env.KEEP_ALIVE_INTERVAL_MINUTES);
  if (Number.isFinite(rawMinutes) && rawMinutes > 0) {
    return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(rawMinutes * 60_000)));
  }
  return DEFAULT_INTERVAL_MS;
}

function displayUrl(rawUrl) {
  const url = safeUrl(rawUrl);
  if (!url) return '';
  return `${url.origin}${url.pathname}`;
}

export function startKeepAlive({
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = console,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const enabledSetting = isKeepAliveEnabled(env);
  const url = enabledSetting ? resolveKeepAliveUrl(env) : '';
  const intervalMs = keepAliveIntervalMs(env);
  const state = {
    enabled: Boolean(enabledSetting && url && typeof fetchImpl === 'function'),
    reason: '',
    url: displayUrl(url),
    intervalMs,
    attempts: 0,
    successes: 0,
    failures: 0,
    lastAttemptAt: 0,
    lastSuccessAt: 0,
    lastStatus: 0,
    lastError: '',
    nextPingAt: 0,
  };

  if (!enabledSetting) state.reason = 'disabled-by-env';
  else if (!url) state.reason = 'public-url-missing';
  else if (typeof fetchImpl !== 'function') state.reason = 'fetch-missing';

  let stopped = false;
  let inFlight = false;
  let timer = null;

  const schedule = (delayMs) => {
    if (stopped || !state.enabled) return;
    const delay = Math.max(0, Number(delayMs) || 0);
    state.nextPingAt = Date.now() + delay;
    timer = setTimeoutImpl(tick, delay);
    // Timer process ko akela zinda na rakhe; asal bot/HTTP server already
    // process ko hold karte hain.
    if (timer && typeof timer.unref === 'function') timer.unref();
  };

  const tick = async () => {
    if (stopped) return;
    if (inFlight) {
      schedule(RETRY_DELAY_MS);
      return;
    }
    inFlight = true;
    state.attempts++;
    state.lastAttemptAt = Date.now();
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'SwiggyFreshBot-KeepAlive/1.0',
          'Cache-Control': 'no-store',
        },
        signal: typeof AbortSignal?.timeout === 'function'
          ? AbortSignal.timeout(20_000)
          : undefined,
      });
      state.lastStatus = Number(res?.status) || 0;
      // Body consume/cancel kar do taaki socket atka na rahe.
      try { await res?.text?.(); } catch {}
      try { await res?.body?.cancel?.(); } catch {}

      if (res?.ok) {
        state.successes++;
        state.lastSuccessAt = Date.now();
        state.lastError = '';
        logger.log?.(`[KeepAlive] ping OK ${state.lastStatus} → ${state.url} (agli ${Math.round(intervalMs / 1000)}s baad)`);
        schedule(intervalMs);
      } else {
        state.failures++;
        state.lastError = `HTTP ${state.lastStatus || 'unknown'}`;
        logger.warn?.(`[KeepAlive] ping fail ${state.lastError} → ${state.url}; ${RETRY_DELAY_MS / 1000}s me retry`);
        schedule(RETRY_DELAY_MS);
      }
    } catch (e) {
      state.failures++;
      state.lastStatus = 0;
      state.lastError = String(e?.message || e || 'ping failed').slice(0, 180);
      logger.warn?.(`[KeepAlive] ping error → ${state.url}: ${state.lastError}; ${RETRY_DELAY_MS / 1000}s me retry`);
      schedule(RETRY_DELAY_MS);
    } finally {
      inFlight = false;
    }
  };

  if (state.enabled) {
    logger.log?.(`[KeepAlive] ON → ${state.url} har ${Math.round(intervalMs / 60_000)} min (pehla ping ${FIRST_PING_DELAY_MS / 1000}s baad)`);
    schedule(Math.min(FIRST_PING_DELAY_MS, intervalMs));
  } else if (enabledSetting) {
    logger.warn?.('[KeepAlive] OFF — public URL nahi mila. Render par RENDER_EXTERNAL_URL auto hota hai; warna KEEP_ALIVE_URL=https://<service>.onrender.com/health set karo.');
  }

  return {
    stop() {
      stopped = true;
      state.nextPingAt = 0;
      if (timer) {
        try { clearTimeoutImpl(timer); } catch {}
        timer = null;
      }
    },
    getState() {
      return { ...state };
    },
  };
}
