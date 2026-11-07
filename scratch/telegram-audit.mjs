// ===== 🔍 Telegram spare accounts ka audit — kaun sa account kharab hai =====
//
//   npm run telegram:audit
//
// Har configured spare account (TELEGRAM_SESSION, TELEGRAM_SESSION_2, ...) ko
// alag-alag test karta hai:
//   1. connect + authorize (session zinda hai?)
//   2. getMe (kaun sa account hai)
//   3. OTP bot ka chat padho (number card + buttons)
//
// Output me sirf account ka chhota tag aata hai — poora session kabhi nahi.
//
// Local PC par:
//   TELEGRAM_API_ID=... TELEGRAM_API_HASH=... \
//   TELEGRAM_SESSION=<acct1> TELEGRAM_SESSION_2=<acct2> npm run telegram:audit
//
// ⚠️ Render par ye command PORT ke bagair chalao (web service me shell nahi
// hota). Isliye isi jaankari ke liye bot ke andar /diag me
// "📨 Accounts" section hai.

import dotenv from 'dotenv';
import { auditTelegramAccounts, getTelegramOtpConfig, disconnectTelegramUserClient } from '../telegram-otp-source.js';

dotenv.config();

const config = getTelegramOtpConfig();
if (!config.configured) {
  console.error('❌ Telegram setup adhura hai. Missing:', config.missing.join(', '));
  console.error('   TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION (aur _2, _3… optional) set karo.');
  process.exit(1);
}

console.log(`🔍 Audit — ${config.accounts?.length || 1} account(s) · OTP bot @${config.botUsername}`);
console.log('   (session value kabhi print nahi hoti; sirf tag)\n');

const rows = await auditTelegramAccounts();

for (const row of rows) {
  const icon = row.ok ? '✅' : (row.stage === 'dead' ? '⛔' : '⚠️');
  console.log(`${icon} ${row.label} · ${row.envKey} · tag ${row.tag || '—'}`);
  if (row.ok) {
    console.log(`     me: ${row.me || '—'}`);
    console.log(`     number: ${row.currentPhone || '—'}`);
    console.log(`     buttons: ${row.buttons?.length ? row.buttons.join(' | ') : 'none'}`);
  } else {
    console.log(`     stage: ${row.stage}${row.code ? ` · code: ${row.code}` : ''}`);
    console.log(`     error: ${row.error || '—'}`);
    if (row.hint) console.log(`     fix: ${row.hint}`);
  }
  console.log('');
}

await disconnectTelegramUserClient().catch(() => {});

const okCount = rows.filter((r) => r.ok).length;
console.log(`— ${okCount}/${rows.length} account ready —`);
if (okCount === 0) {
  console.log('Koi account ready nahi: har line ka "fix" follow karo. Do account par same tag = ek hi session do jagah.');
  process.exit(2);
}
