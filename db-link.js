// ============================================================================
// db-link.js — Bot ka LINKED DATABASE (durable + multi-instance safe)
// ============================================================================
//
// KYUN?
//   Bot ka asli DB `data/db.json` hai. Ye Render free disk par ephemeral hai
//   aur GitHub Actions runner par har run me fresh — matlab accounts,
//   settings, number-ledger aur Firebase source list har restart par chale
//   jaate hain. Isi liye DB ko ek DURABLE linked database se bind karna
//   zaroori hai (tabhi "data link" hoga aur data loss nahi hoga).
//
// DRIVERS (auto-detect — priority order):
//   1. kv    → Vercel KV / Upstash REST (KV_REST_URL + KV_REST_TOKEN)
//   2. http  → koi bhi JSON document endpoint (DB_STORE_URL [+ DB_STORE_TOKEN])
//   3. vault → GitHub branch vault (GITHUB_VAULT_TOKEN + VAULT_ENCRYPTION_KEY)
//   4. none  → sirf local file ⚠️ (restart = data loss)
//
// SAFETY:
//   • Payload hamesha AES-256-GCM se encrypt hota hai (VAULT_ENCRYPTION_KEY
//     ya DB_STORE_KEY) — accounts me cookies/tokens hote hain, plaintext
//     me kabhi nahi jaane chahiye.
//   • Push hamesha REMOTE ke saath MERGE hota hai (db-payload.js) — remote
//     ka koi account/ledger kabhi wipe nahi hota.
//   • Push fail hua to snapshot outbox me bachta hai aur next boot/tick par
//     retry hota hai — network jhatka data loss nahi banata.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getInstanceLabel } from './instance-info.js';
import { mergeDbSnapshots, payloadFingerprint } from './db-payload.js';
import {
  pullAccountsFromCloudVault,
  pushAccountsToCloudVaultNow,
  encryptVaultPayloadText,
  decryptVaultPayloadText,
  resolveVaultToken,
  resolveVaultBranch,
  getVaultStatus,
} from './vault-sync.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_DATA_DIR = process.env.VERCEL ? '/tmp/workwr-data' : path.join(__dirname, 'data');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : DEFAULT_DATA_DIR;
const OUTBOX_FILE = path.join(DATA_DIR, 'db-outbox.json');

// Runtime status — /diag, startup log aur doctor CLI isse padhte hain.
export const linkStatus = {
  driver: 'none',
  target: '',
  key: '',
  linked: false,
  pushBlocked: false,
  blockedReason: '',
  lastPushAt: 0,
  lastPushOk: false,
  lastPullAt: 0,
  lastError: '',
  lastFingerprint: '',
  pendingOutbox: false,
};

function firstNonEmpty(...vals) {
  for (const v of vals) {
    const s = String(v ?? '').trim();
    if (s) return s;
  }
  return '';
}

function maskTarget(url = '') {
  const s = String(url);
  return s.length > 48 ? `${s.slice(0, 44)}…` : s;
}

// Linked DB ka key — har instance ka apna (taaki ek doosre ko na mare).
export function dbLinkKey(env = process.env) {
  const label = getInstanceLabel(env);
  return label === 'main' ? 'bot-db:main' : `bot-db:${label}`;
}

// ── Env resolution ─────────────────────────────────────────────────────────
export function resolveKvConfig(env = process.env) {
  const url = firstNonEmpty(env.KV_REST_URL, env.KV_REST_API_URL, env.UPSTASH_REDIS_REST_URL);
  const token = firstNonEmpty(env.KV_REST_TOKEN, env.KV_REST_API_TOKEN, env.UPSTASH_REDIS_REST_TOKEN);
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ''), token };
}

export function resolveHttpConfig(env = process.env) {
  const url = firstNonEmpty(env.DB_STORE_URL);
  if (!url) return null;
  return { url: url.replace(/\/+$/, ''), token: firstNonEmpty(env.DB_STORE_TOKEN) };
}

// Kaunsa driver chalega? Yehi function /diag + doctor dono ka source of truth hai.
export function resolveDbLink(env = process.env) {
  const kv = resolveKvConfig(env);
  if (kv) {
    return { linked: true, driver: 'kv', target: maskTarget(kv.url), key: dbLinkKey(env) };
  }
  const http = resolveHttpConfig(env);
  if (http) {
    return { linked: true, driver: 'http', target: maskTarget(http.url), key: dbLinkKey(env) };
  }
  const vaultToken = resolveVaultToken(env);
  if (vaultToken) {
    const encKey = firstNonEmpty(env.VAULT_ENCRYPTION_KEY, env.DB_STORE_KEY);
    return {
      linked: true,
      driver: 'vault',
      target: `github ${resolveVaultBranch(env)}`,
      key: dbLinkKey(env),
      pushBlocked: !encKey && String(env.ALLOW_PLAINTEXT_VAULT || '').trim() !== '1',
      blockedReason: !encKey
        ? 'VAULT_ENCRYPTION_KEY missing — push block hai (encryption ke liye key zaroori)'
        : '',
    };
  }
  return {
    linked: false,
    driver: 'none',
    target: '',
    key: dbLinkKey(env),
    blockedReason: 'GITHUB_VAULT_TOKEN / KV_REST_URL set nahi — DB sirf local file me hai',
  };
}

// Encryption key — VAULT_ENCRYPTION_KEY (shared) ya DB_STORE_KEY (override).
function linkEncryptionKey(env = process.env) {
  return firstNonEmpty(env.VAULT_ENCRYPTION_KEY, env.DB_STORE_KEY);
}

function allowPlaintext() {
  return String(process.env.ALLOW_PLAINTEXT_VAULT || '').trim() === '1';
}

// ── KV driver (Vercel KV / Upstash REST) ───────────────────────────────────
async function kvSet(cfg, key, value) {
  const res = await fetch(`${cfg.url}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Content-Type': 'text/plain; charset=utf-8',
    },
    body: value,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`KV SET HTTP ${res.status}`);
  const json = await res.json().catch(() => null);
  const result = json?.result ?? json?.status;
  if (result && String(result).toUpperCase() !== 'OK') throw new Error(`KV SET → ${result}`);
  return true;
}

async function kvGet(cfg, key) {
  const res = await fetch(`${cfg.url}/get/${encodeURIComponent(key)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${cfg.token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`KV GET HTTP ${res.status}`);
  const json = await res.json().catch(() => null);
  const value = json?.result;
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

// ── HTTP driver (generic JSON document endpoint) ───────────────────────────
async function httpGet(cfg, key) {
  const res = await fetch(`${cfg.url}/${encodeURIComponent(key)}`, {
    method: 'GET',
    headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {},
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`DB_STORE GET HTTP ${res.status}`);
  const text = await res.text();
  if (!text) return null;
  return text;
}

async function httpPut(cfg, key, value) {
  const res = await fetch(`${cfg.url}/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
    },
    body: JSON.stringify({ key, value, updatedAt: new Date().toISOString() }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`DB_STORE PUT HTTP ${res.status}`);
  return true;
}

// ── Payload encode/decode (encryption at rest) ─────────────────────────────
export function encodeLinkPayload(payload) {
  const key = linkEncryptionKey();
  if (!key && !allowPlaintext()) {
    throw new Error('VAULT_ENCRYPTION_KEY (ya DB_STORE_KEY) set nahi — linked DB me plaintext likhna REFUSE');
  }
  return encryptVaultPayloadText(payload, key || undefined);
}

export function decodeLinkPayload(rawText) {
  if (rawText === null || rawText === undefined) return null;
  const key = linkEncryptionKey();
  let obj;
  try { obj = JSON.parse(rawText); } catch { return null; }
  if (obj && obj.__vaultEnc) {
    return decryptVaultPayloadText(rawText, key || undefined);
  }
  return obj; // legacy plaintext
}

// ── Outbox — push fail hua to snapshot yaha bachta hai ─────────────────────
export function saveOutbox(payload) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const key = linkEncryptionKey();
    const body = key || allowPlaintext()
      ? encryptVaultPayloadText(payload, key || undefined)
      : JSON.stringify({ __vaultEnc: 'v2-aes256gcm', unencrypted: true, data: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64') });
    fs.writeFileSync(OUTBOX_FILE, body, 'utf-8');
    linkStatus.pendingOutbox = true;
    return true;
  } catch {
    return false;
  }
}

export function readOutbox() {
  try {
    if (!fs.existsSync(OUTBOX_FILE)) return null;
    const raw = fs.readFileSync(OUTBOX_FILE, 'utf-8');
    const key = linkEncryptionKey();
    let obj;
    try { obj = JSON.parse(raw); } catch { return null; }
    if (obj && obj.__vaultEnc === 'v2-aes256gcm' && obj.unencrypted) {
      // Key set nahi tha jab outbox likha gaya — base64 decode kar lo (retry
      // tab bhi kaam karega, sirf encryption nahi hua tha us moment).
      try { return JSON.parse(Buffer.from(String(obj.data || ''), 'base64').toString('utf8')); } catch { return null; }
    }
    if (obj && obj.__vaultEnc) return decryptVaultPayloadText(raw, key || undefined);
    return obj;
  } catch {
    return null;
  }
}

export function clearOutbox() {
  try {
    if (fs.existsSync(OUTBOX_FILE)) fs.unlinkSync(OUTBOX_FILE);
  } catch {}
  linkStatus.pendingOutbox = false;
}

// ── Public API ─────────────────────────────────────────────────────────────

// Vault pull ka chhota cache — boot par vault hydrate + linked hydrate
// dono call hote hain; dobara network maarne ki zaroorat nahi.
let vaultPullCache = { at: 0, payload: null };

// Linked DB se snapshot uthao (decrypted). Nahi mila to null.
export async function pullLinkedPayload() {
  const link = resolveDbLink();
  linkStatus.driver = link.driver;
  linkStatus.target = link.target;
  linkStatus.key = link.key;
  linkStatus.linked = link.linked;
  linkStatus.pushBlocked = Boolean(link.pushBlocked);
  linkStatus.blockedReason = link.blockedReason || '';
  if (!link.linked) return null;

  try {
    let payload = null;
    if (link.driver === 'vault') {
      if (vaultPullCache.at && Date.now() - vaultPullCache.at < 30_000) {
        payload = vaultPullCache.payload;
      } else {
        payload = await pullAccountsFromCloudVault();
        vaultPullCache = { at: Date.now(), payload };
      }
    } else {
      const cfg = link.driver === 'kv' ? resolveKvConfig() : resolveHttpConfig();
      const raw = link.driver === 'kv' ? await kvGet(cfg, link.key) : await httpGet(cfg, link.key);
      payload = decodeLinkPayload(raw);
    }
    if (payload) linkStatus.lastPullAt = Date.now();
    return payload && typeof payload === 'object' ? payload : null;
  } catch (err) {
    linkStatus.lastError = String(err?.message || err);
    console.warn(`[DbLink] Pull failed (${link.driver}):`, linkStatus.lastError);
    return null;
  }
}

// Linked DB me snapshot likho — pehle remote ke saath MERGE (never shrink).
export async function pushLinkedPayload(payload) {
  const link = resolveDbLink();
  linkStatus.driver = link.driver;
  linkStatus.target = link.target;
  linkStatus.key = link.key;
  linkStatus.linked = link.linked;
  if (!link.linked) return { ok: false, reason: 'NOT_LINKED' };
  if (link.pushBlocked) {
    linkStatus.lastError = link.blockedReason || 'push blocked';
    return { ok: false, reason: 'PUSH_BLOCKED', error: linkStatus.lastError };
  }
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'NO_PAYLOAD' };

  try {
    if (link.driver === 'vault') {
      // Vault driver merge khud karta hai (vault-sync.js).
      const res = await pushAccountsToCloudVaultNow(payload);
      linkStatus.lastPushOk = Boolean(res?.ok);
      linkStatus.lastPushAt = Date.now();
      if (res?.ok) {
        linkStatus.lastError = '';
        linkStatus.lastFingerprint = payloadFingerprint(payload);
        clearOutbox();
      } else {
        linkStatus.lastError = res?.error || res?.reason || 'vault push failed';
        saveOutbox(payload);
      }
      return res;
    }

    // KV / HTTP — remote padho, merge karo, phir likho.
    const cfg = link.driver === 'kv' ? resolveKvConfig() : resolveHttpConfig();
    let merged = payload;
    try {
      const raw = link.driver === 'kv' ? await kvGet(cfg, link.key) : await httpGet(cfg, link.key);
      const remote = decodeLinkPayload(raw);
      if (remote && typeof remote === 'object') merged = mergeDbSnapshots(payload, remote).payload;
    } catch {
      // Remote padhna fail hua — apna data likh do (worse than nothing nahi).
    }
    const encoded = encodeLinkPayload(merged);
    if (link.driver === 'kv') await kvSet(cfg, link.key, encoded);
    else await httpPut(cfg, link.key, encoded);

    linkStatus.lastPushOk = true;
    linkStatus.lastPushAt = Date.now();
    linkStatus.lastError = '';
    linkStatus.lastFingerprint = payloadFingerprint(payload);
    clearOutbox();
    return { ok: true, driver: link.driver };
  } catch (err) {
    linkStatus.lastPushOk = false;
    linkStatus.lastError = String(err?.message || err);
    saveOutbox(payload);
    console.warn(`[DbLink] Push failed (${link.driver}):`, linkStatus.lastError);
    return { ok: false, error: linkStatus.lastError };
  }
}

// Link kaam kar raha hai? (write → read-back)
export async function verifyDbLink() {
  const link = resolveDbLink();
  if (!link.linked) {
    return { ok: false, driver: 'none', detail: link.blockedReason || 'linked DB set nahi hai' };
  }
  const probeKey = `${link.key}:probe`;
  const probeValue = JSON.stringify({ at: Date.now(), by: getInstanceLabel() });
  try {
    if (link.driver === 'vault') {
      // Vault me probe file likhne ki jagah read check + credential check —
      // (probe likhne se asli vault file corrupt ho sakti thi).
      const pulled = await pullAccountsFromCloudVault();
      const st = getVaultStatus();
      const detail = st.encryptionKeyPresent
        ? `branch ${st.branch} readable${pulled ? ' · snapshot present' : ' · snapshot abhi empty'}`
        : `branch ${st.branch} readable par VAULT_ENCRYPTION_KEY missing — push block`;
      return { ok: Boolean(st.tokenPresent && st.encryptionKeyPresent), driver: 'vault', detail };
    }
    const cfg = link.driver === 'kv' ? resolveKvConfig() : resolveHttpConfig();
    if (link.driver === 'kv') {
      await kvSet(cfg, probeKey, probeValue);
      const back = await kvGet(cfg, probeKey);
      return { ok: back === probeValue, driver: 'kv', detail: `probe write+read ${back === probeValue ? 'OK' : 'mismatch'}` };
    }
    await httpPut(cfg, probeKey, JSON.stringify({ key: probeKey, value: probeValue }));
    const back = await httpGet(cfg, probeKey);
    return { ok: Boolean(back), driver: 'http', detail: back ? 'probe write+read OK' : 'probe read empty' };
  } catch (err) {
    return { ok: false, driver: link.driver, detail: String(err?.message || err) };
  }
}

// Full status — /diag, startup log, doctor CLI.
export function getDbLinkStatus() {
  const link = resolveDbLink();
  return {
    ...linkStatus,
    linked: link.linked,
    driver: link.driver,
    target: link.target,
    key: link.key,
    pushBlocked: Boolean(link.pushBlocked),
    blockedReason: link.blockedReason || '',
    pendingOutbox: fs.existsSync(OUTBOX_FILE),
    vault: link.driver === 'vault' ? getVaultStatus() : null,
  };
}
