// GET / — ek page ka live dashboard (bot Render/VPS par chalta hai, ye sirf dikhata hai)
import { fetchAllTargets, escapeHtml } from '../lib/health.js';

function fmtDuration(sec = 0) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

function pill(up, ready) {
  if (!up) return '<span class="pill down">● DOWN</span>';
  return ready
    ? '<span class="pill up">● READY</span>'
    : '<span class="pill warn">● UP · telegram pending</span>';
}

function card(bot) {
  const b = bot.bot || {};
  const lines = [];
  lines.push(`<div class="row"><span class="k">instance</span><span class="v mono">${escapeHtml(b.instance || '—')}</span></div>`);
  lines.push(`<div class="row"><span class="k">telegram</span><span class="v mono">${b.telegramReady
    ? `✅ @${escapeHtml(b.telegramUsername || 'bot')}`
    : `❌ pending${b.telegramFailures ? ` · ${b.telegramFailures} fail` : ''}`}</span></div>`);
  lines.push(`<div class="row"><span class="k">uptime</span><span class="v mono">${escapeHtml(fmtDuration(b.uptimeSec))}</span></div>`);
  lines.push(`<div class="row"><span class="k">batch</span><span class="v mono">${b.batchRunning
    ? `● running · lanes ${b.activeWorkers}/${b.concurrency}`
    : '— idle'}</span></div>`);
  lines.push(`<div class="row"><span class="k">fresh</span><span class="v mono">${b.freshThisRun ?? 0} is run me · ${b.processed ?? 0} total</span></div>`);
  lines.push(`<div class="row"><span class="k">latency</span><span class="v mono">${bot.latencyMs} ms</span></div>`);
  if (bot.error) lines.push(`<div class="row"><span class="k">error</span><span class="v err mono">${escapeHtml(bot.error)}</span></div>`);
  if (b.telegramLastError) lines.push(`<div class="row"><span class="k">last</span><span class="v err mono">${escapeHtml(String(b.telegramLastError).slice(0, 110))}</span></div>`);

  return `<section class="card">
    <header>
      <div class="title">${escapeHtml(bot.label)}${bot.name && bot.name !== bot.label ? ` <span class="muted">· ${escapeHtml(bot.name)}</span>` : ''}</div>
      ${pill(bot.up, bot.ready)}
    </header>
    ${lines.join('\n    ')}
  </section>`;
}

function page(summary, opts = {}) {
  const { needsKey = false, noTargets = false } = opts;
  const body = noTargets
    ? `<section class="card setup">
        <div class="title">⚙️ Setup baaki hai</div>
        <p class="muted">Vercel → Project → <b>Settings → Environment Variables</b> me ye add karo, phir <b>Redeploy</b>:</p>
        <pre>BOT_HEALTH_URLS = https://your-bot.onrender.com/health

# 2-3 bots ho to comma se alag karo:
BOT_HEALTH_URLS = https://bot2.onrender.com/health, https://bot3.onrender.com/health

# optional: page ko key ke bina na kholne de
DASH_KEY = koi-lamba-random-string</pre>
        <p class="muted">Bot ka health URL wahi hai jo deploy ke baad mila tha — <code>/health</code> par JSON deta hai.</p>
      </section>`
    : summary.bots.map(card).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${needsKey || noTargets ? '' : '<meta http-equiv="refresh" content="20">'}
<title>Fresh Bot · status</title>
<style>
  :root { color-scheme: dark; --bg:#0d1117; --card:#161b22; --line:#21262d; --fg:#e6edf3; --muted:#8b949e; --up:#3fb950; --warn:#d29922; --down:#f85149; }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px 16px 48px; background:var(--bg); color:var(--fg);
         font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  main { max-width: 780px; margin: 0 auto; }
  h1 { font-size: 15px; font-weight: 600; letter-spacing:.4px; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 12px; margin: 0 0 20px; }
  .grid { display: grid; gap: 12px; }
  .card { background: var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .card header { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:10px; }
  .title { font-size: 13px; font-weight: 600; }
  .muted { color: var(--muted); font-size: 12px; }
  .row { display:flex; justify-content:space-between; gap:12px; padding:3px 0; font-size:12.5px; }
  .k { color: var(--muted); }
  .v { text-align:right; }
  .mono { font-variant-numeric: tabular-nums; }
  .err { color: var(--down); }
  .pill { font-size:11px; padding:3px 8px; border-radius:999px; border:1px solid currentColor; white-space:nowrap; }
  .pill.up { color: var(--up); }
  .pill.warn { color: var(--warn); }
  .pill.down { color: var(--down); }
  pre { background:#0b0f14; border:1px solid var(--line); border-radius:8px; padding:12px; overflow-x:auto; font-size:12px; }
  code { background:#0b0f14; padding:1px 5px; border-radius:4px; font-size:12px; }
  .setup p { font-size: 12.5px; line-height: 1.6; }
  footer { margin-top: 18px; color: var(--muted); font-size: 11px; text-align:center; }
</style>
</head>
<body>
<main>
  <h1>🆕 Fresh Bot · live status</h1>
  <p class="sub">${needsKey
    ? 'Access key chahiye — URL ke end me <code>?key=...</code> lagao'
    : noTargets
      ? 'BOT_HEALTH_URLS set karo (neeche steps)'
      : `${summary.up}/${summary.total} up · ${summary.ready} ready · checked ${escapeHtml(summary.checkedAt.replace('T', ' ').slice(0, 19))} UTC · auto-refresh 20s`}</p>
  <div class="grid">
    ${body}
  </div>
  <footer>read-only monitor · koi control nahi · data bot ke /health se</footer>
</main>
</body>
</html>`;
}

export default async function handler(req, res) {
  const expectedKey = String(process.env.DASH_KEY || '').trim();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  if (expectedKey) {
    const url = new URL(req.url || '/', 'http://localhost');
    const provided = url.searchParams.get('key') || String(req.headers['x-dash-key'] || '');
    if (provided !== expectedKey) {
      res.status(401).send(page({ bots: [], up: 0, total: 0, ready: 0, checkedAt: new Date().toISOString() }, { needsKey: true }));
      return;
    }
  }

  const summary = await fetchAllTargets(process.env);
  res.status(200).send(page(summary, { noTargets: summary.total === 0 }));
}
