# ▲ Vercel par kya chalta hai, kya nahi — saaf-saaf

Tumhara Vercel account use ho sakta hai. Bas **kis cheez ke liye**, wo samajhna
zaroori hai.

## ✅ Vercel par ye chalta hai (repo me ready)

**`vercel-monitor/`** — bot ka live status dashboard:
up/down · instance · Telegram ready · uptime · batch running · lanes ·
fresh count · latency · last error. Read-only, koi command nahi.

Deploy: [vercel.com/new](https://vercel.com/new) → import `hulm0408/workwr` →
**Root Directory = `vercel-monitor`** → env `BOT_HEALTH_URLS=https://<bot>.onrender.com/health`
→ Deploy. (Ya `cd vercel-monitor && npx vercel --prod`.)

Detail: [`vercel-monitor/README.md`](vercel-monitor/README.md)

## ❌ Vercel par bot khud nahi chalta

| Bot ko chahiye | Vercel ka limit | Nateeja |
|---|---|---|
| 24×7 process (`bot.launch()` long polling) | function max **300s** | poll loop mar jata hai |
| **Chrome** (Swiggy WAF token) | koi browser binary nahi | `Chrome ❌` — WAF ke aage kuch nahi |
| `data/db.json` + `data/telegram.session` | filesystem read-only/ephemeral | har cold start par state gayab |
| Ek writer per `BOT_TOKEN` | parallel lambdas | **409 Conflict** / duplicate |

Ye opinion nahi — ye Vercel ke apne limits hain. `its-shop-bot` Vercel par isliye
chala kyunki wo **webhook + Upstash Redis + koi browser nahi** wala design tha.

## 🔁 Agar poora bot Vercel par hi chahiye (rewrite)

Tab ye 5 cheezein banani padengi (naya project jitna kaam):

1. **Webhook** — `api/telegram.js` → `bot.handleUpdate()` + `setWebhook` + secret token
2. **State → Upstash Redis** — `store.js` ke 16 file-writes replace (`data/db.json` hatana)
3. **Remote Chrome** — `puppeteer.launch()` → `puppeteer.connect(BROWSER_WS_ENDPOINT)` (Browserless/Steel)
4. **Batch loop → step queue** — `while` loop ki jagah QStash se resumable steps (`api/tick.js`)
5. **MTProto (Hermes/Hathi) single-writer** — serverless me session conflict, isliye default Firebase OTP

Imaandaar expectation: uske baad bhi **10 lanes nahi**, realistically **2–3 lanes**,
aur speed Render wale setup se slow (~3–5 min/account vs abhi ~1–2 min).

**Faisla:** bot Render/VPS par (24×7, 10 lanes) + monitor Vercel par — yahi combo
sahi hai. Sirf Vercel-only chahiye to bolo, main phase-wise rewrite shuru karunga
(har phase chhota PR, pehle file-plan tumhare OK ke liye).
