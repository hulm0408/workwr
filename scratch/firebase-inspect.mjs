// Firebase structure inspect — pool/OTP/SMS nodes ka shape dikhata hai (phones masked).
//
//   set FIREBASE_DB_URL= https://<project>-default-rtdb.firebaseio.com
//   set FIREBASE_DB_AUTH= <db-secret>        (optional but recommended)
//   node scratch/firebase-inspect.mjs
//
// Iska output share karoge to reader ke paths (FIREBASE_*_PATH) exact adjust ho jayenge.

import dotenv from 'dotenv';
dotenv.config();

const env = (k, d = '') => String(process.env[k] ?? d).trim();
const URL_BASE = env('FIREBASE_DB_URL').replace(/\/+$/, '');

function mask(text) {
  return String(text)
    .replace(/(\d{2})\d{5,7}(\d{2})/g, '$1*****$2')
    .replace(/([+91\s-]*\d{2})\d{6}(\d{2})/g, '$1**$2');
}

function clip(text, n = 90) {
  const s = String(text);
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function summarize(node, depth = 0, maxDepth = 3) {
  const pad = '  '.repeat(depth);
  if (node === null || node === undefined) return `${pad}(null)`;
  if (Array.isArray(node)) {
    const lines = [`${pad}Array[${node.length}]`];
    if (depth < maxDepth && node.length) lines.push(summarize(node[0], depth + 1, maxDepth));
    return lines.join('\n');
  }
  if (typeof node === 'object') {
    const keys = Object.keys(node);
    if (!keys.length) return `${pad}{ empty object }`;
    if (depth >= maxDepth) return `${pad}{ ${keys.slice(0, 6).map(mask).join(', ')}${keys.length > 6 ? ', …' : ''} }`;
    const lines = [`${pad}{ ${keys.length} keys: ${keys.slice(0, 8).map((k) => mask(k)).join(', ')}${keys.length > 8 ? ', …' : ''} }`];
    for (const key of keys.slice(0, 3)) {
      lines.push(`${pad}  [${mask(key)}] →`);
      lines.push(summarize(node[key], depth + 1, maxDepth));
    }
    if (keys.length > 3) lines.push(`${pad}  … ${keys.length - 3} more keys`);
    return lines.join('\n');
  }
  return `${pad}${typeof node}: "${mask(clip(node))}"`;
}

async function get(path) {
  const p = String(path || '').replace(/^\/+|\/+$/g, '');
  const auth = env('FIREBASE_DB_AUTH');
  const url = `${URL_BASE}/${p ? `${p}.json` : '.json'}${auth ? `&auth=${encodeURIComponent(auth)}` : ''}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} on /${p}`);
  return res.json();
}

async function main() {
  if (!URL_BASE) {
    console.error('FIREBASE_DB_URL set nahi hai.\n  set FIREBASE_DB_URL=https://<project>-default-rtdb.firebaseio.com');
    process.exit(1);
  }

  console.log(`\n=== Firebase root (${URL_BASE}) ===`);
  try {
    const root = await get('');
    if (root && typeof root === 'object' && !Array.isArray(root)) {
      console.log(`Top-level keys: ${Object.keys(root).map(mask).join(', ') || '(empty)'}`);
    } else {
      console.log(summarize(root, 0, 1));
    }
  } catch (e) {
    console.error(`Root read fail: ${e.message}`);
  }

  const targets = [
    ['NUMBERS', env('FIREBASE_NUMBERS_PATH', 'numbers')],
    ['SMS', env('FIREBASE_SMS_PATH', 'sms')],
    ['OTP', env('FIREBASE_OTP_PATH', 'otp')],
  ];

  for (const [label, path] of targets) {
    console.log(`\n=== ${label} — /${path} ===`);
    try {
      const node = await get(path);
      if (node === null || node === undefined) {
        console.log('(missing — path galat hai ya data nahi)');
        continue;
      }
      console.log(summarize(node, 0, 3));
    } catch (e) {
      console.error(`read fail: ${e.message}`);
    }
  }

  console.log('\nDone. Output share karo to FIREBASE_*_PATH exact kar dunga.\n');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
