// 🗄️ Chhoti key-value store — mirror session ko instance ke restart par bachane ke liye.
//
// Vercel serverless par memory instance-local hoti hai: ek instance par login
// karke session lagane se doosre instance ko pata nahi chalta, aur instance
// thodi der me band ho jaata hai. Isliye session ko Upstash Redis (ya koi bhi
// Redis REST) me rakhte hain — env:
//
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
//   (ya KV_REST_API_URL / KV_REST_API_TOKEN — Vercel KV ka purana naam)
//
// Env na ho to sab kuch chupchaap "no-store" mode me chalta hai (sirf memory),
// app kabhi crash nahi karti.

const URL_ = String(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').replace(/\/+$/, '');
const TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '');
const TTL_SEC = Number(process.env.MIRROR_SESSION_TTL_SEC || 60 * 60 * 24 * 30); // 30 din

export function storeConfigured() {
  return Boolean(URL_ && TOKEN);
}

export function storeMasked() {
  if (!storeConfigured()) return '';
  try { return new URL(URL_).host; } catch { return 'redis'; }
}

// SET key value EX ttl
export async function kvSet(key, value, ttlSec = TTL_SEC) {
  if (!storeConfigured()) return false;
  try {
    const res = await fetch(`${URL_}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      // Upstash REST: query se TTL dena `EX` option ke saath body me value
      body: JSON.stringify([String(value), 'EX', String(ttlSec)]),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function kvGet(key) {
  if (!storeConfigured()) return '';
  try {
    const res = await fetch(`${URL_}/get/${encodeURIComponent(key)}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return '';
    const data = await res.json().catch(() => ({}));
    return typeof data?.result === 'string' ? data.result : '';
  } catch {
    return '';
  }
}

export async function kvDel(key) {
  if (!storeConfigured()) return false;
  try {
    const res = await fetch(`${URL_}/del/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
