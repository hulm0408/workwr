// ===== 🔐 Telegram Hermes USER LOGIN (sirf local PC par chalana hai) =====
//
// Ye script SPARE Telegram account ko Teleproto/MTProto se login karke
// session string `data/telegram.session` me save karti hai. Render par
// interactive login nahi hota, isliye wahan isi file ki value ko
// TELEGRAM_SESSION env me paste karna hota hai.
//
// ⚠️ Session string = poora Telegram account access. Ise GitHub/chat me
// kabhi mat bhejna. Main account ki bajaye spare account use karo.
//
// Chalao:
//   npm run telegram:login
//   npm run telegram:check

import dotenv from 'dotenv';
import input from 'input';
import {
  createTelegramUserClient,
  disconnectTelegramUserClient,
  getTelegramOtpConfig,
  saveTelegramSessionString,
  verifyTelegramOtpConnection,
} from './telegram-otp-source.js';

dotenv.config();

const checkOnly = process.argv.includes('--check');

try {
  if (checkOnly) {
    const result = await verifyTelegramOtpConnection();
    console.log(`✅ Telegram Hermes connection OK — bot @${result.botUsername}${result.me ? ` · account ${result.me}` : ''}`);
    if (result.currentPhone) console.log(`📞 Hermes current number: ${result.currentPhone}`);
    if (result.buttons?.length) console.log(`🔘 Latest buttons: ${result.buttons.join(' | ')}`);
    await disconnectTelegramUserClient();
    process.exit(0);
  }

  let config = getTelegramOtpConfig();
  let apiId = config.apiId;
  let apiHash = config.apiHash;

  if (!apiId) {
    const raw = String(await input.text('TELEGRAM_API_ID (my.telegram.org se): ')).trim();
    apiId = /^\d+$/.test(raw) ? Number(raw) : 0;
  }
  if (!apiHash) {
    apiHash = String(await input.password('TELEGRAM_API_HASH (my.telegram.org se): ')).trim();
  }
  if (!apiId || !apiHash) {
    throw new Error('TELEGRAM_API_ID / TELEGRAM_API_HASH missing hai. Pehle my.telegram.org par spare account se API app banao.');
  }
  config = { ...config, apiId, apiHash };

  console.log('🔐 Spare Telegram account login shuru hai…');
  console.log('Telegram app/SMS me login code aayega. Code sirf isi terminal me daalo, chat/GitHub me nahi.');

  const client = await createTelegramUserClient(config.session || '', config);
  await client.start({
    phoneNumber: async () => String(await input.text('Spare Telegram account number (country code ke saath, jaise +91...): ')).trim(),
    phoneCode: async (isCodeViaApp, info) => {
      const delivery = info?.type || (isCodeViaApp ? 'app' : 'sms');
      console.log(`📩 Login code delivery: ${delivery}`);
      return String(await input.text('Telegram login code: ')).trim();
    },
    password: async (hint) => String(await input.password(`2FA password${hint ? ` (hint: ${hint})` : ''}: `)),
    firstAndLastNames: async () => {
      const firstName = String(await input.text('New Telegram account first name: ')).trim();
      return [firstName || 'Telegram', ''];
    },
    onError: (error) => {
      console.error('[TelegramLogin]', error?.message || error);
    },
  });

  const session = String(client.session.save() || '').trim();
  if (!session) throw new Error('Login ke baad session string khali mili — dobara try karo.');

  const savedSession = saveTelegramSessionString(session, { env: process.env });
  const sessionFile = savedSession.sessionFile;

  let meLabel = '';
  try {
    const me = await client.getMe();
    meLabel = me?.username ? `@${me.username}` : [me?.firstName, me?.lastName].filter(Boolean).join(' ');
  } catch {}

  console.log(`✅ Telegram login ho gaya${meLabel ? ` — ${meLabel}` : ''}.`);
  console.log(`🔐 Session saved: ${sessionFile}`);
  console.log('Render par is file ki poori value ko TELEGRAM_SESSION env me past karo.');
  console.log('Saath me TELEGRAM_API_ID, TELEGRAM_API_HASH aur NUMBER_SOURCE=telegram set karo.');
  await client.disconnect().catch(() => {});
} catch (error) {
  console.error(`❌ Telegram ${checkOnly ? 'check' : 'login'} fail:`, error?.stack || error?.message || error);
  try { await disconnectTelegramUserClient(); } catch {}
  process.exit(1);
}
