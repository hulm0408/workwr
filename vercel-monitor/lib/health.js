// ============================================================================
// lib/health.js — bot(s) ka /health fetch + normalize
// ============================================================================
// Ye module SIRF padhta hai (read-only): Render/VPS par chal rahe bot ka
// public /health JSON. Koi token, koi command, koi write nahi.

const FETCH_TIMEOUT_MS = 6000;

export function escapeHtml(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// BOT_HEALTH_URLS = "https://a.onrender.com/health, https://b.onrender.com/health"
export function healthTargets(env = process.env) {
  const raw = String(env.BOT_HEALTH_URLS || env.BOT_HEALTH_URL || '').trim();
  if (!raw) return [];
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 12)
    .map((url, index) => {
      let name = '';
      try {
        const u = new URL(url);
        name = u.hostname.split('.')[0];
      } catch {
        return null;
      }
      return { url, name: name || `bot${index + 1}`, label: name || `bot${index + 1}` };
    })
    .filter(Boolean);
}

function normalize(payload = {}) {
  const telegram = payload.telegram || {};
  return {
    ok: payload.ok !== false,
    ready: payload.ready === true,
    service: payload.service || 'swiggy-fresh-bot',
    instance: payload.instance || 'main',
    uptimeSec: Number(payload.uptimeSec) || 0,
    batchRunning: payload.batchRunning === true,
    processed: Number(payload.processed) || 0,
    freshThisRun: Number(payload.freshThisRun) || 0,
    activeWorkers: Number(payload.activeWorkers) || 0,
    concurrency: Number(payload.concurrency) || 0,
    telegramReady: telegram.ready === true,
    telegramUsername: telegram.username || '',
    telegramFailures: Number(telegram.apiFailures) || 0,
    telegramLastError: telegram.lastError || '',
    now: payload.now || '',
  };
}

export async function fetchTarget(target) {
  const startedAt = Date.now();
  try {
    const res = await fetch(target.url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'application/json', 'user-agent': 'swiggy-bot-monitor/1.0' },
      cache: 'no-store',
    });
    const latencyMs = Date.now() - startedAt;
    if (!res.ok) {
      return { ...target, up: false, status: res.status, latencyMs, error: `HTTP ${res.status}` };
    }
    const payload = await res.json().catch(() => null);
    if (!payload) {
      return { ...target, up: false, status: res.status, latencyMs, error: 'JSON nahi mila' };
    }
    const data = normalize(payload);
    // Card ka label bot khud batata hai (INSTANCE_LABEL) — warna index-based.
    const label = data.instance && data.instance !== 'main' ? data.instance : target.label;
    return { ...target, label, up: true, status: res.status, latencyMs, data };
  } catch (e) {
    const message = e?.name === 'TimeoutError' ? `timeout (${FETCH_TIMEOUT_MS}ms)` : (e?.message || 'fetch failed');
    return { ...target, up: false, status: 0, latencyMs: Date.now() - startedAt, error: message.slice(0, 120) };
  }
}

export async function fetchAllTargets(env = process.env) {
  const targets = healthTargets(env);
  const results = await Promise.all(targets.map((t) => fetchTarget(t)));
  const summary = {
    checkedAt: new Date().toISOString(),
    total: results.length,
    up: results.filter((r) => r.up).length,
    ready: results.filter((r) => r.up && r.data?.ready).length,
    bots: results.map((r) => ({
      label: r.label,
      name: r.name,
      url: r.url,
      up: r.up,
      status: r.status,
      latencyMs: r.latencyMs,
      error: r.error || '',
      bot: r.data || null,
    })),
  };
  return summary;
}
