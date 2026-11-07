# ⚡ DEPLOY-NOW — ek page, bas itna

Do raaste hain. Dono free, dono bina card. Code GitHub par pehle se hai — kuch
push karne ki zaroorat nahi, bas neeche ka click/step karo.

---

## 🅰️ Raasta A — GitHub Actions (sabse tez, ~60 sec, koi new account nahi)

Bot public repo ke **Actions runner** par chalta hai. Runner me **Chrome pehle se**
hota hai, minutes free hain.

1. Token banao: **@BotFather** → `/newbot` → token (kisi chat me **mat** bhejo)
2. Secret daalo (2 field):
   👉 https://github.com/hulm0408/workwr/settings/secrets/actions/new
   - `BOT_TOKEN` = token
   - `OWNER_IDS` = apni Telegram id (bot ko `/start` karne par dikhti hai)
   - *(recommended)* `GITHUB_VAULT_TOKEN` + `VAULT_ENCRYPTION_KEY` — warna har
     6 ghante naye runner par accounts/settings reset ho jayenge
3. Chalao:
   👉 https://github.com/hulm0408/workwr/actions → **Bot live** → **Run workflow**
   → instance chuno → **Run workflow**
4. 1 minute me log me ye 3 line dikhni chahiye:
   ```
   🏷 Instance: bot2
   Chrome: Google Chrome 1xx.x.x
   Telegram ✅ @tumhara_bot (id ...)
   ```
5. Telegram me bot ko `/start` → `🆕 Swiggy Fresh Bot · bot2` → `/diag` sab ✅

**Kami:** har 6 ghante me ~5 min ka gap, runner ephemeral (vault zaroori)।

---

## 🅱️ Raasta B — Render (24×7, gap nahi, koi bhi email)

1. Token banao (upar jaisa hi)
2. **Deploy button** (main bot, disk + starter plan):
   👉 https://render.com/deploy?repo=https://github.com/hulm0408/workwr
3. **Free plan / doosra bot** ke liye: Render → **New → Blueprint** → repo
   `hulm0408/workwr` → **Blueprint Path: `render.second.yaml`** → Apply
4. Env bharo:
   | Key | Value |
   |---|---|
   | `BOT_TOKEN` | naya token |
   | `OWNER_IDS` | apni Telegram id |
   | `INSTANCE_LABEL` | `bot2` (bot3, bot4 …) |
   | `GITHUB_VAULT_BRANCH` | `bot-vault-2` (bot-vault-3 …) |
5. Deploy ke baad `https://<service>.onrender.com/health` → `"instance":"bot2"`
6. Free plan par neend na aaye: https://cron-job.org se
   `GET https://<service>.onrender.com/health` har 5–10 min

**Note:** Render ke 750 free hours **per account** hote hain → 1 account = 1 bot
free. 2–3 bots ke liye 2–3 accounts, ya Raasta A.

---

## 🅲 Raasta C — Vercel (dashboard, 2 min)

Bot Vercel par nahi chalta (polling + Chrome + disk), par **uska live status
dashboard** Vercel par chal sakta hai — repo me ready hai: `vercel-monitor/`.

1. [vercel.com/new](https://vercel.com/new) → import `hulm0408/workwr`
2. **Root Directory** → Edit → `vercel-monitor`
3. Env: `BOT_HEALTH_URLS` = `https://<bot>.onrender.com/health`
   (2–3 bots: comma se alag karo)
4. **Deploy** → URL khul jayega: up/down, instance, telegram, uptime, lanes,
   fresh count, latency. `/status` par wahi data JSON me.

Poora sach (kya chalta hai / kya nahi): [`VERCEL.md`](VERCEL.md)

---

## 🧩 Teesra bot (bot3, bot4) kaise

Wahi code, bas naya token + alag label:

| Cheez | bot2 | bot3 | bot4 |
|---|---|---|---|
| Token secret (Actions) | `BOT_TOKEN` | `BOT_TOKEN_3` | `BOT_TOKEN_4` |
| Owner secret | `OWNER_IDS` | `OWNER_IDS_3` | `OWNER_IDS_4` |
| `INSTANCE_LABEL` | `bot2` | `bot3` | `bot4` |
| Vault branch | `bot-vault-2` | `bot-vault-3` | `bot-vault-4` |

Bulk me chalane se pehle: har instance me **Settings → 🚦 Parallel lanes** kam
karo (3–4), warna shared Firebase pool + Swiggy rate-limit dono pressure me
aayenge.

---

## ❌ Kya nahi karna

- **Vercel** par deploy mat karo — long polling + Chrome + disk, teenon wahin
  fail hote hain (detail: `SECOND-BOT-DEPLOY.md` section 1).
- Ek `BOT_TOKEN` do jagah mat chalao → **409 Conflict**.
- Ek `TELEGRAM_SESSION` do jagah mat chalao → session revoke.
- Token chat/screenshot/GitHub me mat daalo — sirf hosting ke secret box me.

---

## 🩺 Atak gaya?

| Log me kya dikha | Fix |
|---|---|
| `BOT_TOKEN secret set nahi hai` (Actions) | Settings → Secrets me `BOT_TOKEN` add karo |
| `409 Conflict` | Wahi token kahin aur chal raha hai — purani copy band karo |
| `Chrome ❌` | Render me runtime **Docker** hona chahiye (Node nahi) |
| `telegram.ready:false` par `/health` 200 | Token galat/revoked — naya token |
| Batch me 0 numbers | Firebase pool khali/rate-limited — Settings → 🔥 Firebase check |
