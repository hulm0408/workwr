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

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.trim()) {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export default async function handler(req, res) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.status(200).json({ ok: true, endpoint: 'telegram-webhook', method: req.method });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  const expectedSecret = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
  if (expectedSecret) {
    const provided = String(req.headers['x-telegram-bot-api-secret-token'] || '').trim();
    if (provided !== expectedSecret) {
      res.status(401).json({ ok: false, error: 'Unauthorized webhook secret' });
      return;
    }
  }

  const update = await readJsonBody(req);
  if (!update || typeof update !== 'object') {
    res.status(400).json({ ok: false, error: 'Invalid Telegram update JSON' });
    return;
  }

  try {
    const { handleTelegramUpdate } = await loadBot();
    await handleTelegramUpdate(update);
  } catch (err) {
    console.error('[api/telegram] update error:', err?.stack || err?.message || err);
  }

  res.status(200).json({ ok: true });
}
