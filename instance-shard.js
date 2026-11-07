// ============================================================================
// instance-shard.js — ek hi pool/proxy par kai bots, bina ladai
// ============================================================================
// Problem jo asal me hui: 4 instances ek hi Firebase pool + ek hi proxy list
// + ek hi OTP bot par chal rahe the. Har instance wahi numbers uthata tha,
// wahi proxies try karta tha, aur Swiggy ka per-IP rate-limit sabko ek saath
// lagta tha — natija: "4 bot milkar 1 bot se bhi kam kaam".
//
// Fix: har instance ko pool ka ek **stable hissa** do.
//   INSTANCE_LABEL=bot2 + INSTANCE_COUNT=4  → is instance ke paas 1/4 slice
//
// Slice deterministic hai (hash based, random nahi) — isliye restart par
// wahi numbers/proxies milte hain, aur do instances kabhi ek hi phone/proxy
// par nahi girte. Sab instances milkar poora pool cover karte hain.
//
// Default: INSTANCE_COUNT unset → sharding OFF (purana behaviour bilkul waisa).

import crypto from 'node:crypto';
import { getInstanceLabel } from './instance-info.js';

export const DEFAULT_INSTANCE_COUNT = 1;

function normalizeCount(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 32) return DEFAULT_INSTANCE_COUNT;
  return n;
}

// "bot2" → 2, "bot3" → 3; naam se number na mile to label hash se.
export function instanceIndexFromLabel(label = '', count = 1) {
  const safeCount = normalizeCount(count);
  if (safeCount <= 1) return 0;
  const text = String(label || '').trim().toLowerCase();
  // "main" = pehla/purana bot → uska hissa hamesha pehla.
  if (!text || text === 'main') return 0;
  const numbered = text.match(/^bot[\s_-]?(\d+)$/) || text.match(/(\d+)$/);
  if (numbered) {
    const n = Number(numbered[1]);
    if (Number.isInteger(n) && n >= 1) return (n - 1) % safeCount;
  }
  if (!text) return 0;
  const digest = crypto.createHash('sha1').update(text).digest();
  return digest[0] % safeCount;
}

export function shardConfig(env = process.env) {
  const count = normalizeCount(env?.INSTANCE_COUNT);
  const label = getInstanceLabel(env);
  const explicitIndex = env?.INSTANCE_INDEX;
  const index = explicitIndex !== undefined && explicitIndex !== ''
    ? (() => {
      const n = Number(explicitIndex);
      return Number.isInteger(n) && n >= 0 && n < count ? n : instanceIndexFromLabel(label, count);
    })()
    : instanceIndexFromLabel(label, count);
  return { enabled: count > 1, count, index, label };
}

// FNV-1a — chhota, stable, dependency-free. Kisi bhi key ko 0..count-1 me.
export function hashBucket(key = '', count = 1) {
  const safeCount = normalizeCount(count);
  if (safeCount <= 1) return 0;
  const text = String(key ?? '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % safeCount;
}

export function ownsKey(key, env = process.env) {
  const cfg = shardConfig(env);
  if (!cfg.enabled) return true;
  return hashBucket(key, cfg.count) === cfg.index;
}

// Proxy list ke index par — proxy URL ko hi key banate hain taaki list ka
// order badalne se ownership na badle.
export function ownsProxy(proxy, env = process.env) {
  if (!proxy) return true;
  const key = proxy.url || proxy.id || proxy.label || '';
  return ownsKey(key, env);
}

export function filterOwned(items = [], keyFn = (item) => item, env = process.env) {
  const list = Array.isArray(items) ? items : [];
  return list.filter((item) => ownsKey(keyFn(item), env));
}

// /health aur /diag ke liye chhota summary.
export function shardSummary(env = process.env) {
  const cfg = shardConfig(env);
  return {
    enabled: cfg.enabled,
    index: cfg.index,
    count: cfg.count,
    label: cfg.label,
    share: cfg.enabled ? `${cfg.index + 1}/${cfg.count}` : 'all',
  };
}

// Naye/secondary instance par lanes kam — 4 bots × 10 lanes ek hi pool ko
// jala dete hain. User Settings se hamesha badha sakta hai.
export function suggestedConcurrency(env = process.env, current = 0) {
  const cfg = shardConfig(env);
  if (!cfg.enabled) return Number(current) || 0;
  const cap = Math.max(1, Math.min(5, Math.ceil(10 / cfg.count)));
  const value = Number(current) || 0;
  return value > cap ? cap : value || cap;
}
