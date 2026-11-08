// ===== 🗂 SESSION JSON FILE — bot ka JSON "starting se ending tak" =====
//
// Owner ka rule (Task T):
//   "after successful login tujhe bas json file ke starting and ending ko
//    copy karke ek file banan hai"
//
// Matlab: World Bot ke message me JSON ke aage/peeche jo bhi hota hai —
// header line, "Tap Copy on the code block below", code fences (```), footer,
// "Copy Code" button ka text — sab chhod do. File me sirf wahi portion jaata
// hai jo pehle `{` (ya `[`) se aakhri `}` (ya `]`) tak hai, aur wo bhi tabhi
// jab wo asli valid JSON ho. Yahi ek file worker bot ko jaati hai aur wahi
// 10 poore hone par stock (@its_shop_bot) me bhi jaati hai — dono jagah
// bilkul same text, isliye do jagah do tarah ka JSON banne ka sawal hi nahi.
//
// File disk par bhi likhi jaati hai (`data/session-files/<acc_xx>.json`) —
// restart/deploy ke baad debugging me kaam aati hai. Ye folder git me nahi
// jaata (session = poora account access).

import fs from 'node:fs';
import path from 'node:path';

export const SESSION_FILE_DIR = process.env.SESSION_FILE_DIR
  || path.join(process.cwd(), 'data', 'session-files');

// JSON ka asli tukda: pehla `{`/`[` se aakhri `}`/`]` tak.
// Invalid JSON / braces hi na ho → khali string (caller fallback lagata hai).
export function sessionJsonBody(raw = '') {
  const text = typeof raw === 'string' ? raw : (raw == null ? '' : String(raw));
  if (!text.trim()) return '';

  let start = -1;
  for (const ch of ['{', '[']) {
    const at = text.indexOf(ch);
    if (at >= 0 && (start < 0 || at < start)) start = at;
  }
  if (start < 0) return '';

  let end = -1;
  for (const ch of ['}', ']']) {
    const at = text.lastIndexOf(ch);
    if (at > end) end = at;
  }
  if (end <= start) return '';

  const body = text.slice(start, end + 1).trim();
  try {
    JSON.parse(body);
    return body;
  } catch {
    return '';
  }
}

// String ya object — dono se file ka text. String par "starting…ending"
// wala trim chalta hai; object (DB export) seedha pretty JSON banta hai.
export function sessionFileText(value) {
  if (value == null) return '';
  if (typeof value !== 'string') {
    try { return JSON.stringify(value, null, 2); } catch { return ''; }
  }
  const trimmed = sessionJsonBody(value);
  if (trimmed) return trimmed;
  // Bot ne valid JSON nahi diya — jo hai wahi likho (adhoora JSON bhi
  // chhupana nahi, warna owner ko pata hi na chale).
  return value.trim();
}

export function sessionFileName(phone = '', accountKey = '') {
  const digits = String(phone || '').replace(/\D/g, '').slice(-10);
  const base = String(accountKey || '').trim() || (digits ? `acc_${digits}` : 'session');
  return `${base.replace(/[^\w.-]+/g, '_') || 'session'}.json`;
}

// File banao. Fail ho (permission/disk) to bhi flow na ruke — ok:false.
export function writeSessionFile({
  phone = '',
  accountKey = '',
  text = '',
  dir = SESSION_FILE_DIR,
} = {}) {
  const body = String(text || '').trim();
  if (!body) return { ok: false, kind: 'no-json' };
  const name = sessionFileName(phone, accountKey);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, name);
    // Session file = credentials → sirf owner padh sake (0600).
    fs.writeFileSync(filePath, body.endsWith('\n') ? body : `${body}\n`, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(filePath, 0o600); } catch {}
    return { ok: true, name, path: filePath, bytes: Buffer.byteLength(body, 'utf8'), at: Date.now() };
  } catch (error) {
    return { ok: false, kind: 'write-fail', name, reason: String(error?.message || error).slice(0, 160) };
  }
}
