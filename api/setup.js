let _botPromise = null;

async function loadBot() {
  if (!process.env.DATA_DIR) {
    process.env.DATA_DIR = '/tmp/workwr-data';
  }
  if (!_botPromise) {
    _botPromise = import('../fresh-bot.js').catch((err) => {
      _botPromise = null;
      throw err;
    });
  }
  return _botPromise;
}

export default async function handler(req, res) {
  try {
    const setupKey = String(process.env.SETUP_KEY || '').trim();
    if (setupKey) {
      const provided = String(req.query?.key || req.headers['x-setup-key'] || '').trim();
      if (provided !== setupKey) {
        res.status(401).json({ ok: false, error: 'Invalid setup key' });
        return;
      }
    }

    const { bot, ensureBotInitialized } = await loadBot();
    await ensureBotInitialized();

    const prodHost = String(process.env.VERCEL_PROJECT_PRODUCTION_URL || '').trim();
    const host = prodHost || String(req.headers['x-forwarded-host'] || req.headers.host || '').trim();
    if (!host) {
      res.status(400).json({ ok: false, error: 'Cannot determine host for webhook URL' });
      return;
    }
    const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim() || 'https';
    const webhookUrl = `${proto}://${host}/api/telegram`;
    const secret = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();

    const opts = { drop_pending_updates: false };
    if (secret) opts.secret_token = secret;

    await bot.telegram.setWebhook(webhookUrl, opts);
    const [me, info] = await Promise.all([
      bot.telegram.getMe(),
      bot.telegram.getWebhookInfo(),
    ]);

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      ok: true,
      bot: me?.username ? `@${me.username}` : String(me?.id || ''),
      webhookUrl: info?.url || webhookUrl,
      pendingUpdateCount: Number(info?.pending_update_count || 0),
      lastErrorMessage: info?.last_error_message || '',
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: String(err?.message || 'Setup failed').slice(0, 240),
      code: err?.code || '',
    });
  }
}
