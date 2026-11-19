#!/usr/bin/env node
// 🟡 Gold Drop security-check PROBE — sirf tumhare network par sach batata hai.
//
// Kyun: "Please complete the security check" ka matlab har machine par alag
// ho sakta hai (key/wallet, sitekey, token field, ya asli browser ki zaroorat).
// Ye script ek asli number se poora register try karta hai aur har step ka
// exact jawab dikhata hai — guess nahi.
//
// Chalao:
//   node gold-drop-probe.mjs --phone=9696607387 --key=nocap_xxx
//   node gold-drop-probe.mjs --phone=9696607387            # built-in key
//
// Ek number ek hi baar use karo (site OTP bhej degi, isliye asli number do).

import { GoldDropClient, goldDropCaptchaPreflight } from './gold-drop-client.js';
import { readFile } from 'node:fs/promises';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=')];
}));
const phone = String(args.phone || '').replace(/\D/g, '').slice(-10);
const key = String(args.key || process.env.NOCAP_API_KEY || '');
const pincode = String(args.pincode || '509412');
const batch = String(args.code || 'KKD2LS01261026');
const emailBase = String(args.email || 'itsnoob012@gmail.com');

const line = (tag, text) => console.log(`${tag} ${text}`);
const ok = (t) => line('✅', t);
const bad = (t) => line('❌', t);
const info = (t) => line('•', t);

if (!/^[6789]\d{9}$/.test(phone)) {
  console.error('Usage: node gold-drop-probe.mjs --phone=9876543210 [--key=nocap_xxx]');
  process.exit(2);
}

console.log('\n🟡 GOLD DROP PROBE');
info(`number: ${phone}`);
info(`key: ${key ? `${key.slice(0, 10)}…${key.slice(-4)}` : '(built-in)'}`);
info(`node: ${process.version} · platform: ${process.platform}`);
console.log('');

// 1) Key + sitekey status
console.log('1️⃣ NoCaptchaAI + sitekey check');
const pre = await goldDropCaptchaPreflight(key, {});
info(`key: ${pre.keyOk === true ? 'chalu ✅' : pre.keyOk === false ? 'FAIL ❌' : 'unknown'} — ${pre.keyMessage}`);
if (pre.sitekey) info(`sitekey: ${pre.sitekey}`);
else bad(`sitekey nahi mili — ${pre.sitekeyError}`);
console.log('');

// 2) Session bootstrap (site reachable hai?)
console.log('2️⃣ Site reachable + session');
const client = new GoldDropClient({
  nocapApiKey: key || undefined,
  onStatus: (text) => info(`   ${text}`),
});
try {
  await client.bootstrap();
  ok(`session mila (userKey ${String(client.userKey).slice(0, 6)}…)`);
} catch (error) {
  bad(`site tak nahi pahucha / session fail: ${String(error?.message || error).slice(0, 180)}`);
  console.log('\n👉 Network problem: site tumhare machine se block hai. VPN/proxy ya doosra network try karo.\n');
  process.exit(1);
}
console.log('');

// 3) Asli registration (short email suffix — site ke form jaisa)
console.log('3️⃣ Registration (asli number — OTP aa sakti hai)');
const suffix = String(phone).split('').sort(() => Math.random() - 0.5).slice(0, 6).join('');
const email = emailBase.includes('+') ? emailBase : emailBase.replace('@', `+${suffix}@`);
const image = await readFile(new URL('./assets/gold-drop-pack.jpg', import.meta.url));
try {
  const res = await client.register({ name: 'Rahul Kumar', mobile: phone, email, pincode, code: batch, image });
  ok(`register PASS — ${res.message || 'OTP sent'}`);
  info(`bheje gaye fields: ${(client.lastRegisterAttempt?.fields || []).join(', ')}`);
  if (client.lastRegisterAttempt?.token) info(`captcha token: ${client.lastRegisterAttempt.token} (${client.lastRegisterAttempt.tokenLength} chars)`);
  console.log('\n👉 Security check tumhare machine se CLEAR ho gaya. Ab bot me wahi key/number use karo.\n');
} catch (error) {
  bad(`register FAIL — ${String(error?.message || error).slice(0, 220)}`);
  if (client.lastRegisterAttempt) {
    info(`bheje gaye fields: ${client.lastRegisterAttempt.fields.join(', ')}`);
    if (client.lastRegisterAttempt.token) info(`captcha token: ${client.lastRegisterAttempt.token} (${client.lastRegisterAttempt.tokenLength} chars)`);
  }
  const text = String(error?.message || '');
  console.log('');
  if (/security check/i.test(text)) {
    console.log('👉 Site ne solved token ke bawajood reject kiya. Iska matlab:');
    console.log('   site ko asli browser chahiye (raw API par check kabhi clear nahi hota).');
    console.log('   → `pip install seleniumbase playwright && python -m playwright install chromium`');
    console.log('   → phir GOLD_DROP_BROWSER_REG=1 (default) ke saath bot chalao.');
  }
  if (/wallet/i.test(text)) console.log('👉 Wallet top-up: nocaptchaai.com/manage/billing → Wallet (subscription nahi).');
  process.exit(1);
}
console.log('');
