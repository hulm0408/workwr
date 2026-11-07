# 🧬 Doosra bot, doosri hosting — same codebase

Ye guide tab ke liye hai jab aap **wahi project ek naye BotFather bot par**
chalana chahte ho (naya `BOT_TOKEN`) aur usko **alag hosting account** par
rakhna chahte ho — pehla bot jaisa hai waisa hi chalta rahega.

> **Pehle ek zaroori sach:** Vercel par ye bot **nahi chalega**. Neeche
> section 1 me exact wajah hai. Recommended route **doosra Render account
> (free, bina card)** hai — steps section 3 me.

---

## 1️⃣ Vercel kyun nahi chalega (technical, not opinion)

Ye bot 24×7 ka **long-polling process** hai, Vercel **serverless function**
hai. Chaar cheezein tooti hain:

| Bot ko chahiye | Vercel deta hai | Nateeja |
|---|---|---|
| 24×7 chalta process (`bot.launch()` long polling) | function sirf request par chalta hai, max **300s** | poll loop mar jata hai, bot "offline" |
| **Chrome** (Swiggy WAF token solve) | koi browser binary nahi, deployment size limit | `Chrome ❌` — WAF ke aage kuch nahi hota |
| `data/db.json` + `data/telegram.session` disk par | filesystem read-only/ephemeral | har cold start par accounts, session, number ledger gayab |
| Ek hi writer per `BOT_TOKEN` | parallel lambdas | **409 Conflict** / duplicate processing |

Vercel par is project ka sirf ek chhota hissa host ho sakta hai (jaise ek
`/health` monitor ya dashboard). Bot khud nahi. Isko webhook + external
Redis + remote browser me convert karna **alag project jitna kaam** hai —
wo chaaho to bolo, plan bana dunga, par wo rewrite hai.

**Render free web service** in chaaron cheezon me se 3 handle karta hai
(Chrome Docker image me aata hai, disk ki jagah cloud vault, self-ping se
15-min neend nahi aati) — isliye wahi recommended hai.

---

## 2️⃣ Deploy se pehle: 4 decisions

| # | Cheez | Rule |
|---|---|---|
| 1 | **BOT_TOKEN** | @BotFather se **naya** bot. Purana token doosre bot me reuse **mat** karo — ek token = ek hi running instance (warna 409). |
| 2 | **Telegram account (session)** | Har instance ka **apna** spare Telegram account. Ek hi `TELEGRAM_SESSION` do jagah = session revoke/conflict. Doosra spare account na ho to doosre bot ko **Firebase-only** mode me chalao (Telegram login ki zaroorat nahi). |
| 3 | **Hosting account** | Render ke **750 free instance-hours poore account par share** hote hain. 2 × 24×7 = 1440 h → ek hi account par dono nahi chalenge. Isliye **doosra Render account** (naya email, free, card nahi). |
| 4 | **Data** | Firebase DB shared rakh sakte ho (numbers/OTP ek hi pool se, 7-din ledger common — sabse simple). Cloud vault ka **branch alag** rakho: `GITHUB_VAULT_BRANCH=bot-vault-2`, warna dono instances ek doosre ka vault overwrite karenge. |

---

## 3️⃣ Step-by-step (doosra bot + doosra Render account)

### A. Naya bot banao
1. Telegram me **@BotFather** → `/newbot` → naam + username (jaise
   `FreshBotTwo_bot`).
2. Token copy karo — `123456789:AAE...` (kisi ke saath share mat karo).
3. Us naye bot par apni ID se `/start` karo (welcome aayega, warna
   `OWNER_IDS` check karo).

### B. Doosra Render account
1. Naya email/Browser profile → [dashboard.render.com](https://dashboard.render.com)
   → GitHub se sign in (ya email) — **free, koi card nahi**.
2. **New → Web Service** → repo `hulm0408/workwr` → branch `main`.
3. Settings:
   - **Runtime**: `Docker` (Dockerfile path `./Dockerfile`)
   - **Instance type**: `Free`
   - **Region**: `Singapore`
   - **Health Check Path**: `/health`
4. **Environment** (section 4 ka table) bharke **Create Web Service**.
5. Pehla build ~3–5 min (Chrome download hota hai). Logs me dikhna chahiye:
   ```
   [FreshBot] 🏷 Instance: bot2 (doosra bot — INSTANCE_LABEL env se)
   [FreshBot] Chrome ✅ /usr/bin/google-chrome-stable
   [FreshBot] Telegram ✅ @FreshBotTwo_bot (id ...)
   ```

> Blueprint pasand ho to repo me `render.second.yaml` bhi hai — Render me
> **New → Blueprint** karke us file ka path de do. Content same hai jo
> upar manually set kiya.

### C. Doosre bot ka Telegram login (sirf Telegram mode ke liye)
- **Aasan tareeka:** naye bot me `/start` → **Settings → Add Telegram
  Account** → API ID/hash, spare account ka number, code, 2FA — sab
  private chat me. Session server par `data/telegram.session` ban jayegi.
- **Durable tareeka:** local PC par `npm run telegram:login` (doosre spare
  account se) → output `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`,
  `TELEGRAM_SESSION` → Render env me daalo. Free web service ki disk
  restart par mit sakti hai, isliye env route zyada tikau hai.
- Doosre spare account ke bina: `/start` → **🔥 Firebase (N)** chuno →
  Telegram mode off, Firebase OTP. Bot chalega, par Telegram-only flow
  tabhi milega jab account ho.

### D. Neend na aaye (free web service)
`RENDER_EXTERNAL_URL` Render khud deta hai → bot khud `.../health` ko har
5 min ping karta hai. **`/diag` me `❤️ Keep-alive ✅ ON`** dikhna chahiye.
Backup: [cron-job.org](https://cron-job.org) se `GET https://<service>.onrender.com/health`
har 5–10 min (timeout 120s).

### E. Check karo
1. `https://<service>.onrender.com/health` — JSON me
   `"instance":"bot2"`, `"telegram":{"username":"..."}`, `"ready":true`.
2. Naye bot me `/start` — title **`🆕 Swiggy Fresh Bot · bot2`**.
3. `/diag` — Instance, Chrome, WAF, Keep-alive sab ✅.
4. Pehla batch chhota rakho: Settings → **🎯 Target = 1** → `/start` →
   START → ek fresh account end-to-end.
5. Purana bot alag hai, usme kuch nahi badla — use waise hi chalao.

---

## 4️⃣ Env table (doosre instance ke liye)

| Key | Value | Zaroori? |
|---|---|---|
| `BOT_TOKEN` | **naya** BotFather token | ✅ |
| `OWNER_IDS` | `6484999726` | ✅ |
| `INSTANCE_LABEL` | `bot2` (kuch bhi chhota, e.g. `bot3`) | ✅ recommended |
| `FIREBASE_DB_URL` | `https://vuvhbjbi-default-rtdb.firebaseio.com/` | default |
| `HEADLESS` | `1` | ✅ |
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` / `TELEGRAM_SESSION` | doosre spare account ka (ya bot ke andar login) | Telegram mode |
| `GITHUB_VAULT_TOKEN` | wahi PAT | optional |
| `VAULT_ENCRYPTION_KEY` | wahi key | optional |
| `GITHUB_VAULT_BRANCH` | `bot-vault-2` | ✅ agar vault use kar rahe ho |

`DATA_DIR` sirf tab badlo jab ek hi machine/disk par do copy chala rahe ho
(do Render services ke liye zaroorat nahi — har service ka apna container).

---

## 4️⃣b Ek saath 3 naye bots (bot2 · bot3 · bot4)

Ek hi codebase se **teen aur bots**. Har bot ko alag token, alag label, alag
vault branch — aur (free plan par) **alag Render account**.

| Bot | `INSTANCE_LABEL` | `OWNER_IDS` | `GITHUB_VAULT_BRANCH` | Render account | Service name |
|---|---|---|---|---|---|
| bot2 | `bot2` | jo us bot ka owner hai | `bot-vault-2` | account #2 (email-2) | `swiggy-fresh-bot-2` |
| bot3 | `bot3` | jo us bot ka owner hai | `bot-vault-3` | account #3 (email-3) | `swiggy-fresh-bot-3` |
| bot4 | `bot4` | jo us bot ka owner hai | `bot-vault-4` | account #4 (email-4) | `swiggy-fresh-bot-4` |

**Har bot ke liye wahi 5 step** (guide ka section 3):

1. @BotFather → `/newbot` → **naya** token (kisi chat me paste mat karo).
2. Naya Render account (naya email, free, card nahi) → **New → Blueprint**
   → repo `hulm0408/workwr` → Blueprint Path `render.second.yaml` → Apply.
3. Render me service ka naam badlo (`swiggy-fresh-bot-3` etc.) aur env me
   `INSTANCE_LABEL` + `GITHUB_VAULT_BRANCH` + `BOT_TOKEN` + `OWNER_IDS` bharo.
4. `/health` kholo → `"instance":"bot3"` dikhe to deployment sahi hai.
5. Telegram me `/start` → title `🆕 Swiggy Fresh Bot · bot3` → `/diag` sab ✅.

**Teen cheezein jo 3 bots ke saath badal jati hain:**

- **Instance hours:** Render ke 750 free hours **per account** hote hain. Ek
  account = ek 24×7 free service. 3 aur bots = 3 aur accounts (ya paid
  worker+disk). Ek hi account me 4 free services daalne par total hours
  khatam hokar kuch services suspend ho jayengi.
- **Telegram account:** har bot ko **apna** spare Telegram account. Teen bots
  ke liye teen spare accounts. Warna us bot ko **Firebase-only** mode me
  chalao (Telegram login ki zaroorat nahi).
- **Firebase pool + proxies (sabse important):** saare bots ek hi Firebase DB
  aur ek hi proxy list par chalenge. 4 instances × 10 lanes = **40 lanes** ek
  hi pool/IP par → numbers jaldi khatam, per-IP Swiggy rate-limit, aur wahi
  numbers do bots me. **Iska code-level fix sharding hai** (neeche), warna
  "4 bot milkar 1 bot se bhi kam" hi hota hai.

### 🧩 Multi-bot sharding (zaroori — warna bots aapas me ladte hain)

Har instance me bas **do** env:

```
INSTANCE_LABEL=bot2     # ya bot3 / bot4 / main
INSTANCE_COUNT=4        # kul kitne bots ek saath chal rahe hain
```

Iske baad (automatically):

- **Numbers:** pool 4 hisson me baant diya jata hai — har bot apna hissa uthata
  hai, koi number do bots ko nahi milta. Slice **stable** hai (restart par wahi
  hissa), aur chaaron milkar poora pool cover karte hain.
- **Proxies:** same tarah — har bot ko proxy list ka apna slice. Isse per-IP
  rate-limit ek bot par lagti hai, poore setup par nahi.
- **Lanes:** `10 / INSTANCE_COUNT` par cap (4 bots → 3 lanes each), taaki
  total lanes 40 na ho jayein. Settings se kam kar sakte ho, badha bhi
  (cap sirf chhat hai).
- **`/diag`** me `🧩 Shard` line dikhti hai; live card par `🧩 SHARE 2/4`;
  `/health` JSON me `"shard":{"index":1,"count":4,"share":"2/4"}`.

**Ek aur cheez jo code se fix nahi hoti:** har bot ka **apna spare Telegram
account** hona chahiye. Do bots ek hi account par = OTP races, `FLOOD_WAIT`,
session revoke — isi liye "sab larre" wali feeling aati hai. Ab `/diag` me
**`🔑 Session tag`** dikhta hai (10-char fingerprint, session khud nahi):
do bots par **same tag** = wahi account, turant alag karo.

> Har bot ka `BOT_TOKEN` sirf uske apne hosting ke env me rahe — chat,
> screenshot, GitHub me kabhi nahi.

## 4️⃣c GitHub Actions se FREE (bina card, bina Render account) — 3 bots ke liye

Render par 1 account = 1 bot (750 free hours per account). Agar 3 aur bots
chahiye aur 3 accounts nahi banane, to **GitHub Actions** route available hai:
public repo ke runner minutes free hain aur runner image me **Chrome pehle se**
hota hai. Workflow repo me ready hai: **`.github/workflows/bot-live.yml`**.

Kaise:
1. GitHub → repo → **Settings → Secrets and variables → Actions → New repository secret**
   - `BOT_TOKEN` = bot2 ka token
   - `OWNER_IDS` = bot2 ka owner id
   - (bot3: `BOT_TOKEN_3` + `OWNER_IDS_3`, bot4: `BOT_TOKEN_4` + `OWNER_IDS_4`)
   - recommended: `GITHUB_VAULT_TOKEN`, `VAULT_ENCRYPTION_KEY` (state survive kare)
   - Telegram mode: `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION`
2. **Actions → Bot live → Run workflow** → `instance` = `bot2` → Run.
3. Logs me `🏷 Instance: bot2` + `Chrome: Google Chrome ...` + `Telegram ✅ @...`
   dikhe to bot live hai.

Imaandaar limits (Render se kam reliable):
- Job max **6 ghante** chalti hai → har **6 ghante par ~5 min ka gap** (polling rukti hai).
- Runner **ephemeral** hai: `data/` har run me khali → state **cloud vault** se
  aata/jata hai (`GITHUB_VAULT_TOKEN` + `VAULT_ENCRYPTION_KEY` ke bina accounts
  reset ho jayenge).
- Har run ka **IP badalta** hai (proxy pool phir bhi kaam karta hai, par direct
  route badalta rehta hai).
- GitHub 60 din repo inactivity par scheduled workflow **disable** kar deta hai
  (Actions tab se dobara enable karna padta hai).
- 24×7 reliability chahiye to **Render/VPS** hi sahi hai; Actions "free jugaad" hai.

## 5️⃣ Kya kabhi nahi karna

- ❌ Ek `BOT_TOKEN` do jagah — **409 Conflict**, dono me se ek mar jata hai.
- ❌ Ek `TELEGRAM_SESSION` do jagah — Telegram session revoke kar deta hai,
  dono bots ka OTP band.
- ❌ Dono instances ek hi vault branch par — accounts ek doosre ko
  overwrite karenge. `GITHUB_VAULT_BRANCH` alag.
- ❌ Doosre bot ko same spare Telegram account par login karke "shared"
  chalana — OTP/last-seen dono gadbad karenge.
- ❌ Vercel par `vercel deploy` karke "chal jayega" maan lena — section 1.

## 6️⃣ Problem aaye to

| Lakshan | Wajah / fix |
|---|---|
| Logs me `409 Conflict` | Wahi token kahin aur chal raha hai — purani copy band karo. |
| `Chrome ❌` | Docker runtime chuna tha? `render.second.yaml`/manual me runtime **Docker** hona chahiye, Node runtime nahi. |
| `/health` par 200 par `telegram.ready:false` | Token galat/revoked ya polling start nahi hui — logs dekho. |
| Batch 0 numbers | Dono bots ek hi Firebase pool kha rahe hain — pool khatam. Naya DB add karo (Settings → 🔥 Firebase). |
| Bot 15 min baad so jata hai | Keep-alive OFF hai — `KEEP_ALIVE_URL` set karo ya external cron lagao. |
| Accounts restart par gayab | Disk nahi hai (free plan) — `GITHUB_VAULT_TOKEN` + `VAULT_ENCRYPTION_KEY` set karo, ya Starter worker + disk lo. |
