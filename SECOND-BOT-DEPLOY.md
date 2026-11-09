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
- Doosre spare account ke bina: `/start` → **🌍 SWIGGY BY WORLD** (ya
  Advanced → **🔥 Firebase (N)**) chuno → Telegram mode off, Firebase OTP.
  World Bot ke buttons click karne ke liye spare Telegram account phir bhi
  chahiye hota hai; Telegram-only flow tabhi milega jab account ho.

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
| `SHOP_BOT_STOCK_ENABLED` / `SHOP_BOT_USERNAME` | `1` / `its_shop_bot` | stock push |

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

## 4️⃣d Ek bot chal raha, baaki accounts kaam nahi kar rahe?

Ye 100% account-level problem hoti hai (bot/numbers ka dosh nahi). Har spare
account ki apni sehat hoti hai, aur pehle app use **chup-chaap** side par kar
deta tha — sirf "connection error" dikhta tha. Ab:

1. **`/diag`** kholo → `👥 Accounts` section:
   ```
   👥 Accounts: 2/4 READY · active #1
   ✅ account 1 · 3445d362
   ⏳ account 2 · 58bf9ca5 · FLOOD_WAIT_900 · 12m baaki
   ⛔ account 3 · e36fa7c0 · PEER_FLOOD (PEER_FLOOD — bots ko message block)
   ✅ account 4 · 9aa41b02
   ```
2. Har line ka matlab:

| Line | Matlab | Kya karo |
|---|---|---|
| `✅ ready` | account theek | kuch nahi |
| `⏳ FLOOD_WAIT_… · Xm baaki` | Telegram ne us account par rate-limit lagaya | us account ko X min chhodo — bot khud doosra uthayega |
| `⛔ PEER_FLOOD` | ye account bots ko **message bhej hi nahi sakta** (naya/spammy account) | 1-2 din warm-up, ya naya spare account |
| `⛔ AUTH_KEY_* / SESSION_REVOKED` | session mar gaya | Add Telegram Account se dobara login |
| `⛔ CHAT_WRITE_FORBIDDEN` | OTP bot ne us account ko block kiya | doosra account |
| `⛔ SESSION_INVALID` | session string adhuri paste hui | poora string dobara paste |
| `🌐 NETWORK` | network/restart ka jhatka, account theek hai | 15s me khud retry |

3. **Sabse tez jaanch** (laptop par, session wahi ke wahi):
   ```
   TELEGRAM_API_ID=... TELEGRAM_API_HASH=... \
   TELEGRAM_SESSION=<a1> TELEGRAM_SESSION_2=<a2> TELEGRAM_SESSION_3=<a3> \
   npm run telegram:audit
   ```
   Har account ka jawab: connect → authorize → kaun sa account → OTP bot ke
   buttons. Jo account fail, uski wajah + fix wahi line me.

4. **Multi-account auto-rotation** (naya): env me
   `TELEGRAM_SESSION`, `TELEGRAM_SESSION_2`, `TELEGRAM_SESSION_3`, `TELEGRAM_SESSION_4`
   daal do. Bot claim ke waqt **healthy** account chunta hai; kharab account
   cooldown me chala jata hai aur baaki kaam karte rehte hain — batch rukta
   nahi. (Number mil jane ke baad account **nahi** badalta — OTP usi account ke
   chat me aata hai; isliye pinning hai.)

5. **Ek chhoti si trap:** Render free par disk nahi. Bot ke andar se login kiya
   session restart par ud jata hai — isliye account ka `TELEGRAM_SESSION` **env
   me** rakho, tabhi wo hamesha zinda rahega.

## 4️⃣e Proxy ka jhameela band karo — DIRECT mode

Proxy ke liye ladai ki asli wajah: **har instance apni free-proxy list khud
fetch karta hai aur har proxy par alag Chrome WAF solve karta hai.** 4 bots par
ye 4× kaam hai, aur 0.1 CPU (Render free) par ek-ek solve minute leta hai.
Isi liye "bahut time waste" hota hai.

Agar proxy ka jhameela nahi chahiye — **ek env aur sab band**:

```
PROXY_MODE=direct
```

Iske baad:

| Cheez | Direct mode me |
|---|---|
| Free-proxy fetch | ❌ bilkul nahi (sabse bada time-saver) |
| Per-proxy Chrome WAF solve | ❌ nahi |
| Proxy rotation / cooldown / aapas ki ladai | ❌ nahi |
| Lanes | **1** (ek IP — zyada lanes sirf rate-limit bulati hain) |
| Speed | slow par **predictable**; rate-limit par fast ladder (15-30s) ruk kar agla number |
| `/diag` | `🔀 Proxies: DIRECT MODE — koi proxy nahi, ek IP, 1 lane` |
| Live card | `🔀 DIRECT · bina proxy, ek IP` |

**Kab direct sahi hai:** 2+ bots, free proxies, ya jab "result consistent
chahiye, bas chalna chahiye". **Kab proxy better hai:** ek hi bot aur speed
chahiye (tab `PROXY_MODE=auto` rakho aur sticky proxies daalo).

**Speed ka sach (imeandaari se):** direct mode me ek IP par Swiggy ki per-IP
limit lagti hai, isliye 1 ID / minute ka target nahi milta — realistic ~1 ID per
3-5 min, din bhar me ~100-200 attempts. Proxy pool ke bina isse zyada possible
hi nahi, chahe koi kuch bhi bole.

## 4️⃣f Ek number = ek hi baar (1 minute decision window)

**Rule (owner):** number milne ke **60 seconds ke andar attempt start** hona chahiye;
warna number chhod do. Number ko **queue me park karke baad me try karna allowed nahi**.

Isliye code me:

- Number retry queue/selector hata diya — koi `deferNumber()` ya `retryLater`
  nahi; purana number baad me pick nahi hota.
- Number milte hi **60s decision clock** start hoti hai. WAF warm-up/preflight me 60s nikal jaaye to number attempt kiye baghair chhod diya jata hai.
- Pehla actual attempt number ko lock/consume karta hai; generic failure ya exception ke baad bhi dobara pick nahi hota (same process me agle batches samet). Process/redeploy restart par in-memory lock reset hoti hai.
- Rate-limit / WAF / security challenge / 5xx par number **retire** hota hai
  (`retireNumber()`) — same process me wapas nahi uthta.
- Lane turant **NAYA number** leti hai. Lane ka wait 5s → 8s → 12s (chhat 15s)
  aur hamesha 1-minute window ke andar.
- Run **stop nahi hota**: Never-stop ON (default) me 40 rate-limit outcomes
  sirf ek recovery checkpoint hain — saari lanes cool-off lekar nayi IP par
  wapas aati hain. OFF karne par purana safety stop wapas.

Decision window fixed **60s** hai; is rule ko env se lamba nahi kiya ja sakta.
`PREMIUM_RATE_LIMIT_RETRY_MS=5000` rate-limit par lane ka pehla cooldown hai; cooldown ke baad lane **naya number** legi.

Dikhne me:

- Card title: `⏳ Rate Limit — Ye Number Khatam`
- Card line: *"ye number khatam (one-shot). Queue me park nahi hota, dobara
  try nahi hoga"* · `5s me lane naya number legi`
- Compact chip: `⏳ RATE-LIMIT #4 · ye number khatam · agla naya 5s me`
- `/diag` → `⛔ Number rule: 1 NUMBER = 1 BAAR — 60s me attempt start`
  aur `🔒 Consumed: N unique numbers is run me lock`

**Sach:** 5s me kaam "turant" nahi hota — Swiggy ki per-IP limit minutes me
hoti hai. Faayda: bot **rukta nahi**, same number par OTP **burn nahi hota**,
aur har number par pehla attempt maximum 1 minute ke andar start hota hai. Lock process memory me rehta hai, redeploy tak.

### 🌍 Swiggy World Bot mode (@SwiggyByWorldBot)

Do account engines hain (Settings → 🌍 Account engine, ya
`PREMIUM_ACCOUNT_ENGINE=worldbot`):

| | DIRECT API (default) | WORLD BOT |
|---|---|---|
| Swiggy call | is bot ka bridge | `@SwiggyByWorldBot` |
| Proxy / WAF solver | zaroori | **bilkul nahi** |
| Number + OTP source | Firebase pool / Hermes / Hathi | Firebase pool **ya** Hermes/Hathi |
| Session delivery | `.json` file chat me | `.json` file chat me |

World Bot flow (jaise owner ke screenshots me hai):

1. Spare Telegram account se bot chat kholo → `/start` → **🔐 Login** →
   **📲 OTP Login** → 10-digit number bhejo.
2. Bot `OTP Sent` bolta hai. OTP Firebase inbox se aata hai (wahi device jisse
   number aaya) → bot ko bhej do. OTP na aaye / galat ho to `❌ Cancel` aur
   agla number — wahi one-shot rule.
3. Bot **naam poochhta hai** = naya account → JSON aata hai → bot DB me save
   + owner ko **`.json` file**.
4. Bot **naam nahi poochhta** = purana account →
   `🤵 Order Hub → woh account → 🗑 Delete Account → wohi account →
   Delete OTP → Account Deleted Successfully` → phir se OTP Login
   (ab naam poochhega) → fresh JSON.
5. Login successful → JSON ka **starting se ending** (`{` … `}`) hissa **ek
   `.json` file** me (`data/session-files/acc_<number>.json`) → wahi file
   **worker bot** par bheji jaati hai → **10 poore** hone par wahi 10 files
   `@its_shop_bot` (stock) me — zip nahi, ek-ek JSON file.
6. File bhejne ke **BAAD** hi best-effort `Switch Accounts → account →
   Permanently Logged Out` (`SWIGGY_WORLD_LOGOUT_AFTER_DELETE=0` se band).
   File attach fail ho to logout nahi hota; engine dobara bhejta hai
   (`sessionSent` flag se double send nahi).

#### 🚀 START ke teen source buttons

| Button | Number + OTP | Swiggy account kaam |
|---|---|---|
| 🤝 HERMESHU + SWIGGYBYWORLD | `@HermeshuOTPROBOT` card | `@SwiggyByworldBot` |
| 🐘 HATHI WALA BOT | `@Hathi_otp_bot` card | `@SwiggyByworldBot` (wahi world bot engine) |
| 🌍 SWIGGY BY WORLD | Firebase pool (device scan + SMS) | `@SwiggyByworldBot` |

`⚙️ Advanced` me purane sab option (Firebase only, HardXotp) aur
**🗑 Delete All Firebase** milta hai.

#### 🔁 Bot pool + failover (saare bot same)

World bots ka default pool: `@SwiggyByworldBot`, `@SwiggyByworld1Bot` …
`@SwiggyByworld5Bot` — **saare bilkul same** kaam karte hain. Rules:

- Ek number par **pehla bot hi** chalta hai; jo bot chal jaye wahi **sticky**
  rehta hai.
- **Switch sirf do soorat me:** bot `OTP Sent` 20s me confirm na kare, ya bot
  "queue/wait" me 20s se zyada atka rahe. Tab agla bot, ek number par max 3.
- **Switch nahi:** OTP 20s me nahi aaya (number skip), OTP galat, delete fail,
  flow atka, STOP/SKIP, invalid number, Telegram setup pending.
- OTP ka wait hamesha **20 second** — OTP aane par turant enter hota hai (send
  confirm hota hai; na jaye to wahi OTP dobara, bot nahi badalta).
- **OTP send hi confirm na ho aur bot `Cancel` bhi na bheje** (owner ne ye screen
  dekhi thi) → number **skip nahi** hota: pehle *wahi* number `Login → 2 (OTP Login)
  → number` se dobara issue hota hai (`SWIGGY_WORLD_NUMBER_RETRIES`, default 1).
  Tab bhi na ho to hi number aage badta hai aur bot rotate hota hai.
- **Ganda state kabhi nahi:** naya login shuru karne se pehle bot ka adhoora
  OTP/number prompt `Cancel` (ya `/cancel`) se saaf hota hai, phir `/start`.
  Bot jab OTP/number/naam maang raha ho to **button ka text nahi bhejta** —
  warna wahi text OTP/number ban kar `❌ Invalid OTP` / `❌ Invalid Mobile Number`
  deta tha (owner ke log me yahi ho raha tha).
- **Bot ke apne refuse:** `❌ Could not send OTP … account suspended` = number
  dead (skip, bot wahi) · `… login attempts exceeded` = number 2 ghante cooldown.
  Aise case me 20s wait ya retry nahi hota.
- **Telegram lock re-entrant hai:** world-bot login poora `withTelegramUserClient`
  (lock) ke andar chalta hai, aur OTP fetch (`snapshotTelegramOtpState` /
  `waitForTelegramOtpCode`) bhi wahi lock maangta hai. Pehle wo apne hi lock ka
  intezaar karta reh jata tha = **deadlock** → number aata tha, OTP kabhi nahi
  (aur world bot me type bhi nahi hota tha). Ab `AsyncLocalStorage` se same
  async context me lock re-entrant hai; parallel calls ab bhi serialize hote hain.
- **REFRESH har second:** OTP Sent ke baad OTP bot (Hermes/Hathi/HardXotp) me
  `SWIGGY_OTP_REFRESH_MS` (default 1000ms) ke hisaab se REFRESH dabta hai —
  chat ke aakhri `SWIGGY_OTP_SCAN_LIMIT` (30) messages + number-card ki message
  id padhi jati hai, aur number bhejne se pehle liya gaya **watermark** tay
  karta hai ki code naya hai (jaldi aaya OTP bhi miss nahi hota) —
  button 12 screens tak dhoondha jata hai, na mile to `Refresh` (HardXotp me
  `View Messages`) text bhej diya jata hai. Pehle sirf "latest" screen dekhi
  jati thi, isliye dusre number ki card ho to refresh hi nahi hota tha.
- **Duplicate command nahi:** click se screen badal jaye **ya bot ka callback
  aa jaye** to button ka text dobara nahi bhejta (isliye `OTP Login` do baar
  nahi likha jata — wahi duplicate Swiggy se `login attempts exceeded` karata
  tha), aur `Cancel` ka jawab aane ka intezaar hota hai (`/cancel` duplicate
  nahi).
- **"OTP Sent" blank/photo ho to bhi sent:** number ke baad bot ka jawab bina
  text (photo ya khali message) aaya to 3s grace ke baad OTP Sent maan liya
  jata hai — pehle wahan `Cancel` + dobara number jata tha, number jal jata tha
  aur OTP kabhi type nahi hota tha.
- **Flood wait / late reply:** Telegram `Sleeping for 4s/16s on flood wait
  (GetHistory)` par step fail nahi hota: ek waqt me ek GetHistory, slow read
  par 8s cache, read ka waqt step budget me add, timeout par 90s ka late-reply
  scan (`SWIGGY_WORLD_LATE_REPLY_GRACE_MS`, 0 = off), OTP bot refresh bhi
  throttle par 2–5s. Delete/login ka jawab late aaye to **wahi number** par
  dobara try — naya number nahi.
- **Delete ke baad wahi number (naya card nahi):** delete hone ke baad koi
  naya number ya OTP bot se naya card nahi liya jata — jo number delete hua
  wahi `Login → OTP Login → OTP` par dobara jaata hai.
- **JSON file + worker bot + stock:** login ke baad bot ke JSON ka pehla `{`
  se aakhri `}` tak ka hissa ek `.json` file me likha jata hai, wahi file
  worker bot par jaati hai, 10 poore hone par wahi files `@its_shop_bot` ko.
  File jaane ke **baad** logout.
- **Delete ke baad Main Menu:** `Account Deleted Successfully` par `Haan 💜`
  (bot se remove) ke baad **🏠 Main Menu** dabta hai — na `/start`, na seedha
  `Login`. Uske baad wahi number se fresh login: `Login` → `OTP Login` → number
  → OTP → naam → JSON (JSON aate hi bhej diya jata hai).
- **Delete blocked (charges/dues):** bot bole "this account can't be deleted
  because user charges are present" → fresh account us number par possible
  nahi. Flow: **Main Menu → Switch Accounts → woh ID → Permanently Logged
  Out → naya number**. Number skip hota hai (ledger me skipped), bot nahi
  badalta. Card: `⛔ Delete Blocked (Charges) — Naya Number`.
- **Naam phone se:** bot jab naam maange to `swiggyNameFromPhone(phone)` —
  10 digit ke pehle 5 digit → alphabetic (1→a … 9→i, **0→x**). `92046…` →
  `ibxdf`, `98765…` → `ihgfe`.
- **Delete success = turant Main Menu:** delete confirmation ka poll 500ms aur
  Main Menu click bina settle-wait (`settle:false`) — screen aate hi button dab
  jata hai. Uske baad wahi number: Login → OTP Login → number → OTP → naam.
- **Logout par do confirmation:** Permanently Logged Out → "konsa account" →
  `✅ Yes / ❌ Cancel` → **Yes** dabta hai (Cancel kabhi nahi). Yes na aaye to
  result `logout_not_confirmed` (jhoothi success nahi). Transcript wala rasta
  pehle try hota hai: `Main Menu → 📇 Swiggy Accounts → woh number → 🗑 Permanent
  Logout`, uske baad Switch Accounts / Order Hub.
- **Delete OTP ≠ delete success:** `✅ Delete OTP Sent … account will be
  permanently deleted` ab `deleteSent` hai (pehle "deleted" shabd ki wajah se
  delete-success maan liya jata tha).
- **Telegram disconnect:** har read/send se pehle connection check + reconnect;
  socket mara ho to `worldbot_offline` — batch rukta hai, number retire nahi
  hota ("Cannot send requests while disconnected" wala 60s spam dekha gaya tha).
- **Blank reply verify hota hai:** text khali/photo reply par pehle poora screen
  padha jata hai — `Could not send OTP … login attempts exceeded` mile to OTP
  Sent nahi maana jata (20 refresh se pehle hi number ka faisla).
- **Flood wait friendly:** `messages.GetHistory` flood wait ya khali read par 3
  koshish + 0.4s read-cache; `Login button nahi mila — screen: none` par bot
  switch nahi, pehle menu reset karke ek aur koshish.
- **OTP type hota hai:** OTP source se code milte hi bot ko bhej diya jata hai
  (sirf tab nahi jab bot saaf-saaf number/naam maang raha ho) — **ek hi baar**.
  20s = "OTP Sent" confirm; OTP inbox ka wait alag
  (`SWIGGY_WORLD_OTP_INBOX_TIMEOUT_MS`, default 90s). Code na mile to reason
  card me: "OTP source me code hi nahi aaya".
- **Queue:** bot "queue/wait" bole to 45s tak wait (`SWIGGY_WORLD_QUEUE_WAIT_MS`)
  — asli run me queue ke baad OTP Sent ~40-60s me aata hai.
- **Ek command → bot ka jawab → agla command:** har step se pehle `settledScreen()`
  bot ke latest message ka id rukne tak wait karta hai. Button role sirf **latest
  1-2 messages** me dhoondha jata hai (poori purani chat me nahi) — warna purane
  menu se hi "step ho gaya" maan kar bot ko 3-4 command ek saath chali jati thi
  (`/start` + `Login` + `OTP Login` ek hi second me → `❌ Invalid OTP`).
- **Cancel/menu/ready** jo message aaye, uske neeche pada purana OTP prompt
  ignore hota hai (dobara `/cancel` nahi jata).
- **Button trigger:** pehle click; screen na badle to **usi button ka text likh kar
  bhej** diya jata hai (`🔐 Login` → `Login` → `login`). Click ka jawab der se aaye to
  type skip (double action nahi). `SWIGGY_WORLD_TRIGGER=type` = click hi nahi.
- **Bachaav:** OTP sirf digits (spaces/paste safe), purana OTP dobara nahi bhejta,
  JSON adhoora ho to `Copy Code` retry, delete me number na mile to `/start` retry,
  `FLOOD_WAIT` par ruk kar dobara, network hiccup par 2 retry, session dead par
  batch saaf message ke saath rukta hai.
- Pool badalna ho to env: `SWIGGY_WORLD_BOT_USERNAMES=A_bot,B_bot` (CSV).

#### 📦 Shop Bot stock (@its_shop_bot)

Har fresh Swiggy JSON apne aap stock queue me jaata hai. **10 poore** hone par
wahi 10 files ek-ek `.json` document (zip nahi) spare Telegram account se
`@its_shop_bot` ko chali jaati hain aur shop bot unhe **Swiggy / Twing**
product me daal deta hai. Batch size fix **10** hai (min 10, max 10).

- Status / manual push: `/shopstock` → **📤 Abhi Bhejo**
- Band karna ho: `SHOP_BOT_STOCK_ENABLED=0`
- Fail par queue safe — agle fresh par dobara try

Ek hi Telegram chat = **1 lane** (engine khud force karta hai), isliye World Bot
mode slow par predictable hai. Kuch atke to **Settings → 🔎 World Bot screen
check** ya `/world` — bot ka latest text + buttons dikhata hai, usi se pata
chalta hai kaunsa step badla hai.

### 🔁 Never-stop + auto-resume (batch na ruke)

Owner ka pakka rule: **batch khud na ruke**. Engine me do layer hain:

1. **In-run never-stop** (Settings → 🔁 Never-stop, default ON;
   `PREMIUM_NEVER_STOP=1`) — time cap pura ho to deadline usi run me aage
   badh jaati hai; lagatar fails, 40 rate-limit outcomes, WAF cooldown storm
   aur 403 storm par saari lanes 60s → 120s → 300s → 600s ka cool-off le kar
   nayi IP/token se wapas aati hain; pool khali ho to 20s → 180s ke gap se
   saare ACTIVE Firebase sources dobara scan hote hain. **Sirf TARGET pura
   hona ya ⏹ STOP** run khatam karta hai. Ek fresh session milte hi recovery
   ladder reset ho jaati hai.
2. **Auto-resume** (restart ke baad) — Render deploy/restart, GitHub-Actions
   runner badalna (har ~6 ghante) ya crash ke baad `data/db.json` + cloud vault
   me `wanted` flag rehta hai, aur boot ke ~25s baad bot **wahi batch** (wahi
   target/source/OTP bot) khud shuru kar deta hai. Manual STOP ya target pura
   hone par flag clear ho jata hai.

Recovery cards `BATCH KHATAM` nahi kehte — wo `↻ Fail-Streak Checkpoint —
Batch Jaari`, `⏳ Rate-Limit Flood — Batch Jaari`, `🛡 WAF Storm — Batch Jaari`,
`🌊 Security Storm — Batch Jaari`, `🕳 Number Nahi Mila — Batch Jaari` ya
`⏱ Time Cap Pura — Batch Jaari` hote hain. Live card par `🔁 NEVER-STOP` chip
dikhta hai.

### 403 OTP security-challenge — never-stop vs safety stop

Agar logs me `WAF solver OK` ke baad OTP send par
`SWIGGY_SECURITY_CHALLENGE` / HTTP 403 aaye, token solver sirf route token
ready kar paya—OTP endpoint ne phir bhi request roki.

- **Never-stop ON (default):** **3 lagataar security-challenge outcomes**
  ek storm checkpoint hain — batch band nahi hota, saari lanes lamba cool-off
  (60s → 600s) le kar proxies refresh karke nayi IP/token par wapas try karti
  hain. Naye numbers tab tak claim nahi hote jab tak cool-off khatam na ho.
- **Never-stop OFF:** wahi 3 outcomes current batch ko gracefully end karte
  hain aur final reason `/diag`/summary me `Swiggy ne 3 baar OTP security
  challenge diya — batch safety stop` dikhta hai.

Official Swiggy app/site verification ya existing session export hi supported
next step hai; proxy/WAF verification ko bypass karne ki koshish mat karo.
Baar-baar 403 aaye to Never-stop off karke manual verification karna behtar
hai (warna numbers sirf cool-off me jaate rahenge).

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
