# 📊 Vercel Monitor — bot ka live status (Vercel par)

Ye **bot nahi** hai. Ye ek chhota read-only dashboard hai jo Vercel par chalta
hai aur tumhare Render/VPS par chal rahe bot(s) ka `/health` padh ke dikhata
hai: up/down, instance label, Telegram ready, uptime, batch running, lanes,
fresh count, latency, last error.

**Bot khud Vercel par nahi chal sakta** (long polling + Chrome + disk) — wo
Render/VPS par hi rahega. Ye monitor usko **dekhne** ka kaam karta hai, aur
Vercel account use hota hai. Detail: [`../SECOND-BOT-DEPLOY.md`](../SECOND-BOT-DEPLOY.md).

---

## Deploy (2 minute, free hobby)

### Option 1 — `vercel` CLI (sabse tez)

```bash
cd vercel-monitor
npx vercel            # preview
npx vercel --prod     # production
```

### Option 2 — Dashboard se

1. [vercel.com/new](https://vercel.com/new) → **Import Git Repository** →
   `hulm0408/workwr`
2. **Root Directory** → **Edit** → `vercel-monitor`  ← ye step zaroori hai
3. Framework Preset: **Other** (koi build nahi)
4. **Environment Variables**:
   | Key | Value |
   |---|---|
   | `BOT_HEALTH_URLS` | `https://<bot2>.onrender.com/health` (comma se multiple) |
   | `DASH_KEY` | *(optional)* lamba random string — sirf `?key=...` se khulega |
5. **Deploy** → URL milega, jaise `https://swiggy-bot-monitor.vercel.app`

Bina `BOT_HEALTH_URLS` ke bhi deploy ho jayega — page setup steps dikha dega,
phir env add karke **Redeploy** kar dena.

## Kya dikhega

```
🆕 Fresh Bot · live status
2/3 up · 2 ready · checked 2026-11-07 12:40:18 UTC · auto-refresh 20s

┌ bot2 · swiggy-fresh-bot-2                       ● READY
│ instance    bot2
│ telegram    ✅ @FreshBotTwo_bot
│ uptime      3h 12m
│ batch       ● running · lanes 8/10
│ fresh       4 is run me · 27 total
│ latency     142 ms
└
```

- `/` → HTML dashboard (auto-refresh 20s)
- `/status` → wahi data JSON me (mobile/watch/monitoring ke liye)

## Env variables

| Key | Zaroori | Matlab |
|---|---|---|
| `BOT_HEALTH_URLS` | ✅ | comma-separated `/health` URLs (max 12) |
| `DASH_KEY` | optional | set karo to page sirf `?key=...` ya `x-dash-key` header se khulega |

Purana single-URL naam `BOT_HEALTH_URL` bhi chalega.

## Safe kyun hai

- Sirf `GET /health` — bot par koi command, koi token, koi write nahi.
- Bot ka `/health` public JSON hai (usme koi secret nahi hota).
- Har fetch ka 6s timeout; ek bot down ho to baaki cards phir bhi dikhte hain.
- `DASH_KEY` se URL tak limited access rakh sakte ho (`X-Robots-Tag: noindex`).

## Local test

```bash
cd vercel-monitor
BOT_HEALTH_URLS="https://its-shop-bot.vercel.app/api/health" node --input-type=module -e "
  const m = await import('./lib/health.js');
  console.log(JSON.stringify(await m.fetchAllTargets(), null, 2));
"
```
