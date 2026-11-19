// 🟡 Gold Drop — ASLI BROWSER (stealth) adapter
//
// Kyun: site (BigCity SPA) ka "Please complete the security check" check
// application-level hai. Solved Turnstile token bhejne ke baad bhi raw HTTP
// API (`/users/register`) par wahi rejection aata hai — PR #91 me bhi exactly
// yahi hua, aur tab fix yahi tha: registration POORA asli browser ke andar.
//
// Ye module wahi `gold_drop_stealth.py` worker use karta hai (NDJSON over
// stdin/stdout). Node 20+ chahiye, Python 3 + seleniumbase + playwright chahiye:
//
//   pip install seleniumbase playwright
//   python -m playwright install chromium
//
// Worker na chale (Vercel par Python/Chrome nahi hota) to caller raw API par
// fallback kar sakta hai — par wahan security check clear nahi hoga.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// bot-hub-vercel/ se repo root; worker repo root par rehta hai.
const WORKER_CANDIDATES = [
  process.env.GOLD_DROP_WORKER || '',
  path.join(HERE, '..', 'gold_drop_stealth.py'),   // gold-drop-vercel/ (Docker image)
  path.join(HERE, '..', '..', 'gold_drop_stealth.py'),
  path.join(HERE, 'gold_drop_stealth.py'),
].filter(Boolean);

export function findStealthWorker() {
  return WORKER_CANDIDATES.find(p => p && existsSync(p)) || '';
}

export function goldDropBrowserAvailable() {
  if (['0', 'off', 'false', 'no'].includes(String(process.env.GOLD_DROP_BROWSER_REG || '1').toLowerCase())) return false;
  return Boolean(findStealthWorker());
}

function failAll(handle, message) {
  for (const [, entry] of handle.pending) entry.reject(new Error(message));
  handle.pending.clear();
}

// Worker ko NDJSON par ek command bhejo aur uska jawab wait karo.
function sendCommand(handle, payload, timeoutMs, timeoutMessage) {
  if (handle.closed) return Promise.reject(new Error('Stealth worker band ho gaya'));
  handle.seq += 1;
  const id = handle.seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      handle.pending.delete(id);
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    handle.pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    try {
      handle.proc.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
    } catch (error) {
      clearTimeout(timer);
      handle.pending.delete(id);
      reject(new Error(`Stealth worker ko command nahi gayi: ${String(error?.message || error).slice(0, 120)}`));
    }
  });
}

export async function launchGoldDropBrowser({
  pythonPath = process.env.GOLD_DROP_PYTHON || 'python3',
  chromePath = process.env.CHROME_PATH || '',
  launchTimeoutMs = Number(process.env.GOLD_DROP_LAUNCH_TIMEOUT_MS || 240000),
  nocapApiKey = '',
} = {}) {
  const workerPath = findStealthWorker();
  if (!workerPath) throw new Error('gold_drop_stealth.py nahi mila — repo root me hona chahiye');
  const env = { ...process.env };
  if (nocapApiKey) env.NOCAP_API_KEY = nocapApiKey;
  const proc = spawn(pythonPath, ['-u', workerPath, '--serve'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env,
  });
  const handle = { stealth: true, proc, seq: 0, closed: false, pending: new Map() };

  let buffer = '';
  proc.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { console.warn('[GoldDrop] worker ka non-JSON output ignore kiya'); continue; }
      const entry = handle.pending.get(message.id);
      if (!entry) continue;
      handle.pending.delete(message.id);
      if (message.type === 'error') entry.reject(new Error(String(message.message || 'stealth worker error')));
      else entry.resolve(message);
    }
  });

  const onGone = (reason) => {
    if (handle.closed) return;
    handle.closed = true;
    failAll(handle, reason);
  };
  proc.on('exit', code => onGone(`Stealth worker exit ho gaya (code ${code})`));
  proc.on('error', error => onGone(`Stealth worker start nahi hua: ${String(error?.message || error).slice(0, 140)}`));

  handle.close = async () => {
    if (handle._closeDone) return;
    handle._closeDone = true;
    handle.closed = true;
    failAll(handle, 'Stealth worker band ho gaya');
    try { proc.stdin.write(`${JSON.stringify({ cmd: 'close' })}\n`); } catch { /* ignore */ }
    try { proc.stdin.end(); } catch { /* ignore */ }
    if (proc.exitCode === null && proc.signalCode === null) {
      await Promise.race([
        new Promise(resolve => proc.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 10000)).then(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }),
      ]);
    }
  };

  const ready = await sendCommand(handle, { cmd: 'launch', chromePath, headed: false }, launchTimeoutMs,
    'Browser launch timeout — Chrome/Playwright setup check karo');
  if (ready.type !== 'ready') throw new Error(`Stealth worker ne launch par jawab nahi diya: ${String(ready.message || 'unknown')}`);
  handle.endpointUrl = ready.endpointUrl || '';
  return handle;
}

// Site ka asli form bhar kar register — koi raw API call nahi.
export async function browserRegister(handle, { name, mobile, email, pincode, code, imageBase64, url = 'https://golddropgolddhamaka.com/register' }) {
  const timeoutMs = Number(process.env.GOLD_DROP_REG_TIMEOUT_MS || 180000);
  const res = await sendCommand(handle, { cmd: 'register', name, mobile, email, pincode, code, image: imageBase64, url },
    timeoutMs, 'Browser registration timeout — site atki hui hai');
  return res;
}

export async function browserVerifyOtp(handle, otp, details = {}) {
  const timeoutMs = Number(process.env.GOLD_DROP_VERIFY_TIMEOUT_MS || 120000);
  return sendCommand(handle, { cmd: 'verify', otp, ...details }, timeoutMs, 'Browser verify timeout — site atki hui hai');
}

// Process-wide singletons: 1 browser per warm instance, dobara launch nahi.
let sharedBrowser = null;
let sharedBrowserError = '';

export async function getSharedBrowser(options = {}) {
  if (sharedBrowser && !sharedBrowser.closed) return sharedBrowser;
  if (sharedBrowserError) throw new Error(sharedBrowserError);
  try {
    sharedBrowser = await launchGoldDropBrowser(options);
    return sharedBrowser;
  } catch (error) {
    sharedBrowserError = String(error?.message || error).slice(0, 200);
    throw new Error(`Browser start nahi hua — ${sharedBrowserError}`);
  }
}

export async function closeSharedBrowser() {
  const handle = sharedBrowser;
  sharedBrowser = null;
  if (handle) await handle.close().catch(() => {});
}
