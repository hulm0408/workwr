let _depsPromise = null;

async function loadDeps() {
  if (!process.env.DATA_DIR) {
    process.env.DATA_DIR = '/tmp/workwr-data';
  }
  if (!_depsPromise) {
    _depsPromise = Promise.all([
      import('../fresh-bot.js'),
      import('../store.js'),
      import('../telegram-otp-source.js'),
    ]).catch((err) => {
      _depsPromise = null;
      throw err;
    });
  }
  return _depsPromise;
}

export default async function handler(req, res) {
  try {
    const [freshBot, store, tgMod] = await loadDeps();
    await freshBot.ensureBotInitialized();
    const payload = freshBot.buildHealthPayload();
    const dbLink = store.getDbLinkStatus();
    const tg = tgMod.getTelegramOtpConfig();
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      ...payload,
      mode: 'vercel-webhook',
      publicMode: String(process.env.PUBLIC_BOT_MODE ?? '1').trim() !== '0',
      botTokenSet: Boolean(String(process.env.BOT_TOKEN || process.env.AUTOPILOT_BOT_TOKEN || '').trim()),
      ownerIdsSet: Boolean(String(process.env.OWNER_IDS || process.env.AUTOPILOT_OWNER_IDS || '').trim()),
      telegramApiConfigured: Boolean(tg.apiIdPresent && tg.apiHashPresent),
      telegramSessionConfigured: Boolean(tg.sessionPresent),
      dbLink: {
        linked: Boolean(dbLink.linked),
        driver: dbLink.driver || 'none',
      },
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: String(err?.message || 'Health check error').slice(0, 240),
      code: err?.code || '',
    });
  }
}
