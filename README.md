# 🆕 Swiggy Fresh Bot

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/hulm0408/workwr)

> **1-click deploy?** Upar wala button Render par blueprint (`render.yaml`) ke saath
> seedha deploy khol deta hai — sirf `BOT_TOKEN` + `OWNER_IDS` bharna hai.
> **Free plan / doosra bot** chahiye to button ki jagah
> `render.second.yaml` se Blueprint banao (guide: [`SECOND-BOT-DEPLOY.md`](SECOND-BOT-DEPLOY.md)).
> Har cheez ki ek-page list: [`DEPLOY-NOW.md`](DEPLOY-NOW.md).
> **Vercel** par bot nahi chalta, par uska live status dashboard chalta hai —
> `vercel-monitor/` (2 min deploy) · kya-kya possible hai: [`VERCEL.md`](VERCEL.md).

**Ek START dabao — phone chhod ke aa jao.** Bot khud:

0. **START dabao → teen source buttons**: 🤝 **HERMESHU + SWIGGYBYWORLD** (number+OTP Hermes se, Swiggy kaam `@SwiggyByworldBot` se), 🐘 **HATHI WALA BOT** (number+OTP `@Hathi_otp_bot` se, Swiggy kaam bhi `@SwiggyByworldBot` se), 🌍 **SWIGGY BY WORLD** (number+OTP Firebase pool se, Swiggy kaam `@SwiggyByworldBot` se). `⚙️ Advanced` me purane option (Firebase only, HardXotp) aur 🗑 **Delete All Firebase** bhi hai.
1. Selected source se number uthata hai — Hermes/Hathi me **NEW NUMBER (warna FIND NUMBER)**, HardXotp me **NEW NUMBER (warna GET NUMBERS)**, Firebase me pool (`clients/`, online devices pehle)
2. Swiggy par OTP bhejta hai → bot ke card par **REFRESH** (Hermes/Hathi) / **VIEW MESSAGES** (HardXotp) ya Firebase **OTP inbox** (`messages/`) se code padh kar paste karta hai. OTP **20s** (configurable) me na aaye to wahi number chhod kar agla number.
3. Har number ko FRESH banata hai:
   - 🆕 **Naya number** → register + session JSON save
   - ♻️ **Purana number** → login → **Delete Account** flow → delete success par purge → **usi number se fresh registration**
   - ⚠️ **Delete block** (charges / active order / Swiggy Money / other) → **SKIP**, aage badhta hai
   - ⚡ **OTP send/miss/verify/delete-OTP ek baar fail** → wahi number isi run ke liye khatam; dusra OTP try nahi, seedha agla number
   - 🚦 **Rate limit / WAF / security / temporary network** → fast route recovery ke baad agla naya number; batch aam taur par force-stop nahi hota
4. Target (default **100 fresh sessions**) ya max time (default **120 min**) tak apne aap chalta rehta — live card ab ek hi compact mono flow dikhata hai (`NEW › OTP › REFRESH › VERIFY › ADDR › FRESH`), current number, progress, elapsed time, source lock, SKIP/OTP-fail counters, short error/next step aur verified-address count ke saath. Lambi pool/scan diagnostics live card me repeat nahi hoti.

Running card par **⏭ SKIP NUMBER** aur **⏹ STOP BATCH** alag-alag hain.
SKIP sirf current number ko chhodta hai — batch nahi rukti, agli claim turant
naye number ki hoti hai. STOP poore batch ko current safe point par rokta
hai.

> Ek run me source **locked** rehta hai: START par jo chuna wahi numbers + OTP deta hai aur dusra source bilkul try nahi hota; Firebase mode deliberately select ho tabhi saved ACTIVE Firebase sources use hotay hain.
>
> World bots (`@SwiggyByworldBot`, `@SwiggyByworld1Bot … 5Bot`) **saare same** hain.
> Har button pehle **click** hota hai; click se screen na badle to **usi button ka poora
> text likh kar bhej diya jata hai** (`🔐 Login` → `Login` → `login`). `/world` me
> `⌨️ Trigger: type` dikh jayega.
>
> Bot **sirf tab** badalta hai jab wo `OTP Sent` 20s me confirm na kar paye ya
> "queue/wait" me 20s se zyada atka rahe. **OTP 20s me nahi aaya = number skip,
> bot wahi.** OTP galat / delete fail / flow atka par bhi bot nahi badalta.
>
> ⚡ **Speed (2026-11-09):** har click ke baad 45s ka late scan nahi baithta
> (sirf 8s, phir seedha button ka text trigger). Step ka budget khatam hone par
> bhi poora 90s ka scan sirf tab chalta hai jab Telegram ne flood wait diya ho.
> Blank reply + screen par Login menu = number bot tak pahuncha hi nahi → OTP
> **type nahi** hota, wahi number dobara issue hota hai (pehle yahan OTP
> bekaar chala jata tha aur naam ka step kabhi aata hi nahi tha).
>
> ⛔ **“Cancel kiu ho ja raha?” (2026-11-09):** OTP type karne ke baad bot account
> bana raha hota hai (queue me 1–2 minute). Us waqt `/start` ya `Cancel` bhejna
> poora login jala deta hai — bot `❌ Login Cancelled / No account was logged in`
> deta hai. Ab jab tak login **khula** hai (`SWIGGY_WORLD_LOGIN_GUARD_MS`, default
> 5 min) `/start`/`Cancel` band rehte hain: pehle bot ka late jawab dekha jata
> hai (naam → naam + JSON, JSON → seedha save). 20s ka rule sirf OTP **source**
> (Hermes/Firebase) ka hai — OTP type karne ke baad alag budget
> (`SWIGGY_WORLD_OTP_VERIFY_WAIT_MS`, default 90s) chalta hai.
>
> 👤 **“New Account Detected” ka naam step:** ye screen jahan bhi dikhe — login
> ke shuru me, OTP type karne se pehle, ya login ke result ka intezaar me —
> wahan **turant naam (`Sudhani Kumar`) chala jata hai** aur JSON liya jata hai
> (naya OTP/naya number/`/start` bilkul nahi). Screen par koi dusra number
> likha ho (pichhle number ka aadha account) to usme naam nahi bharta —
> pehle Cancel karke saaf menu. `/cancel` bhi naam ke step par kabhi nahi
> jata (warna poora naya-account flow jal jata tha).

### 🐘 Hathi + 🔐 HardXotp — OTP bots

Teeno OTP bots ek hi spare Telegram account (usi MTProto session) se chalte hain,
sirf buttons/labels badalte hain:

| | Hermes (`@HermeshuOTPROBOT`) | Hathi (`@Hathi_otp_bot`) | HardXotp (`@HardXotp_Bot`) |
|---|---|---|---|
| Naya number | `NEW NUMBER` → warna `FIND NUMBER` | **Hermes jaisa hi** | `NEW NUMBER` → warna `GET NUMBERS` |
| Number card | `NUMBER: 98…` | **Hermes jaisa hi** | `ASSIGNED NUMBER: 98…` |
| OTP check | `REFRESH` | **REFRESH** | `VIEW MESSAGES` |
| Skip | `NEW NUMBER` | `NEW NUMBER` | `NEW NUMBER` |

Owner ka rule teeno par same hai: **OTP bhejo → 20s wait → OTP aaya to process,
nahi aaya to wahi number chhod do (one-shot) — naya number lo.**

Naya bot add karna ho to `otp-bot-profiles.js` me ek entry daal do — START
picker, Settings list, live card aur pipeline text sab khud update ho jate hain.


## Zaroori cheezein (warna bot "work nahi karega")

| Cheez | Kyun |
|---|---|
| **Node.js 20+** ([nodejs.org](https://nodejs.org)) | isse purane Node par dependencies toot-ti hain. Check: `node --version` |
| **Google Chrome** (ya Chromium/Edge) installed | WAF token aur Swiggy ke asal Add Address page ke liye. `puppeteer-core` ke saath browser bundled **nahi** aata — bot system Chrome khud dhoondhta hai. Na mile to `.env` me `PUPPETEER_EXECUTABLE_PATH=<chrome.exe ka full path>` do |
| **BOT_TOKEN** (@BotFather se) | bot iske baghair start hi nahi hoga |
| Internet | Telegram + Firebase + Swiggy teeno tak pahunch chahiye |

> 🤖 **Bot work nahi kar raha?** Telegram me **`/diag`** bhejo (ya ⚙️ Settings →
> 🩺 Diagnose) — ek-ek karke bata dega kya toota hai: Chrome, WAF token,
> Firebase, number pool, proxies. Startup par console bhi yahi check
> karke dikhata hai.

## Setup (2 minute)

```bash
cd E:\MyMedia\swiggy-fresh-bot
npm install          # pehli baar (node_modules git me ho tab bhi ye chala lena safe hai)
copy .env.example .env
```

`.env` me sirf **ek** cheez zaroori hai:

```env
BOT_TOKEN=<BotFather se mila token>
OWNER_IDS=<aapka Telegram ID>     # optional — warna default boss allow
```

FIREBASE_DB_URL ka default hi sahi hai (`https://vuvhbjbi-default-rtdb.firebaseio.com/`) — set karne ki zaroorat nahi.

## Chalao

```bash
npm start           # = node fresh-bot.js
```

Telegram me bot kholo → `/start` → **▶️ START BATCH** → phone chhod do.
Wapas aa kar **📊 STATUS** dabao, ya khatam hone par summary khud aa jayega.

## 📨 Telegram Hermes mode (Add Telegram Account)

Owner ka selected source ab **Telegram-only @HermeshuOTPROBOT** hai. Setup
bot ke andar hi hota hai:

1. Bot ki **private chat** me **⚙️ Settings → 👤 Add Telegram Account**
   dabao.
2. Agar API ID/hash env me saved nahi hain, bot
   `my.telegram.org → API development tools` wali spare-account API app ki
   details ek-ek karke maangega.
3. Phir **spare/faltu Telegram account** ka phone number, Telegram login
   code, aur 2FA ON ho to password lagega. Har sensitive input message ko
   bot milte hi delete karne ki koshish karta hai; **session kabhi chat me
   nahi dikhayi jaati**.
4. Login success par Hermes mode apne aap ON ho jata hai aur bot
   @HermeshuOTPROBOT ka connection test karta hai. Manual test ke liye
   **⚙️ Settings → 🧪 Test Hermes** bhi hai; account hatana ho to
   **🗑 Remove Telegram** (confirmation ke baad session clear hoti hai).

Batch is mode me ye simple one-shot flow karta hai: pehle lane ki
proxy/direct route aur WAF token ready → Hermes ki **sabse latest
button-screen** par **NEW NUMBER ho to NEW NUMBER, warna FIND NUMBER**
(purani Hermes screens ke stale buttons kabhi click nahi hote) → click ke
baad **sirf sabse last me aayi number-card** par Swiggy OTP. Click se pehli
wali card baseline me chhoot bhi jaye to woh fresh nahi mani jayegi; latest
card excluded ho to usse purani card fallback me try nahi hogi — bot usi
latest card par NEW karega ya naye jawab ka wait karega. Phir **REFRESH**
karte hue default **20 second**
wait (⚙️ Settings me 20/30/45/60/90s presets; env
`TELEGRAM_OTP_TIMEOUT_MS`) → OTP mile to ek hi verification round me
verify/register/delete/fresh process. OTP send, miss, verify ya delete-OTP
me se koi bhi failure **ek baar** aate hi woh number isi run ke liye
consumed ho jata hai: dusra code/verify, deferred queue, Hermes current
preserve ya same-number reclaim bilkul nahi; route recovery sirf agle
**NEW NUMBER** ke liye hoti hai. Owner ko number bekaar lage to live card
par **⏭ SKIP NUMBER** dabate hi sirf woh number khatam hota hai aur batch
bina bekaar gap naye number par jati hai. Hermes me fail/skip ke baad
configured 6s+ ki neend bhi nahi lagti (fresh success par max 1s). Refresh
gap default **2.5s** hai (Settings ya `TELEGRAM_OTP_REFRESH_MS`).
Hermes startup par free-proxy probing background me chalti rehti hai,
lekin pehla claim uske liye zyada se zyada **12s** rukega; live card par
asal clicked **NEW/FIND** button ya latest-screen ki exact rukawat dikhegi.

Bot ke andar **Hermes mode ON** ho to wahi is run ka locked source hai —
Render par purana `NUMBER_SOURCE=firebase` reh jaye tab bhi Hermes batch
Firebase numbers, pool, device scan ya Firebase OTP try nahi karega. Live card
par `HERMES ONLY` / `HARDXOTP ONLY` + `Firebase OFF` saaf dikhta hai. Ek spare account ki ek hi
Hermeshu chat serialized state hoti hai, isliye Telegram mode safety ke liye
**1 lane** par rehta hai; Firebase mode ki 10-lane behavior unchanged hai.

Hermes/MTProto claim, worker exception, Swiggy rate-limit, WAF/security aur
proxy-rotation ki temporary rukawatein ab recovery checkpoint hain: counters
reset, chhota backoff/route change, phir kaam jaari. Batch aam taur par sirf
target, max-time, manual STOP, ya asal terminal setup/auth masle par rukega;
final compact card me stop ki wajah aur short last error rahega.

Session/API files `data/telegram.session` aur `data/telegram-api.json`
me `0600` permissions se rehti hain aur gitignore me hain. Render free disk
restart/redeploy par mit sakti hai — durable setup ke liye local
`npm run telegram:login` ke baad session ko Render Secret env
`TELEGRAM_SESSION` me rakhna behtar hai. Session = full spare-account
access; use GitHub/chat/screenshot me kabhi mat bhejo, aur main account
login mat karo.

Fresh signup ka email ab number ke **first 5 digits +
`Rahul@gmail.com`** hota hai (misal: `9876543210` →
`98765Rahul@gmail.com`, bina spaces). Agar Swiggy us exact email ko
duplicate bole, tabhi numbered fallback use hota hai taaki signup atak na
jaye. Account fresh finalize hone par **Maharashtra** ki random city
(Mumbai/Pune/Nagpur/Nashik/Thane/Chhatrapati Sambhajinagar/Kolhapur/
Solapur) ka complete delivery address sirf ek **candidate** banta hai —
owner ka Lucknow/UP address bilkul use nahi hota, aur candidate apne aap
success nahi mana jata. Bot pehle authenticated session se Swiggy ki saved
address list (`POST /dapi/address/all`) check karta hai; wahi address pehle
se saved ho to duplicate nahi banata. Warna woh asal authenticated
**`/web-cart-add-address`** page kholkar Maharashtra pin/geolocation ke
saath **Address + Door / Flat No. + Landmark + Home → SAVE ADDRESS &
PROCEED** karta hai. Page ko pehle `form-ready`, `map-gate`,
`login-required`, `security-challenge`, `redirected` ya `loading` me
classify kiya jata hai; checkout ke proven input names `building`/`house`
aur `landmark` ko pehli tarjeeh milti hai, frames/shadow roots bhi check
hote hain, aur map/Proceed gate par pehle asal interactive control par
**ek hi** click, phir zarurat par physical coordinate click, halka map
drag aur **Add New / Delivery Address** drawer action try hota hai.
Failure me short exact page-state ke saath `fields=visible/total` aur
disabled button bhi saaf dikhta hai. Success tabhi hai jab create response ya
saved-address list se pakka remote address ID verify ho jaye.

CAS (`addresses/v1`) fallback ab default me guessed web URLs par blind
POST **nahi** karta — sirf caller ke explicit URL ya
`SWIGGY_ADDRESS_CREATE_URL` configure ho tab. HTML/WAF response aaye to
raw `<!doctype html>…` kabhi user ko nahi dikhaya jata; sirf short
sanitized wajah aati hai. SAVE ho chuka ho lekin verification uncertain
ho to duplicate rokne ke liye dusra CAS POST nahi hota. JSON/account
record me address, `remoteAddressStatus=added` aur `remoteAddressId` sirf
verified remote record par aayenge. Remote Add Address fail ho to fresh JSON
phir bhi turant bhej diya jayega, lekin usme generated/fake address data nahi
hoga — sirf `remoteAddressStatus=failed` aur short wajah hogi; live card aur
JSON caption par `ADDR x/y` / `NOT ADDED` saaf dikhega.

## ☁️ Render par host karo (24×7, PC band phir bhi bot on)

Repo me sab ready hai: **`Dockerfile`** (Chrome ke saath) + **`render.yaml`**
(Blueprint). Steps:

1. Pehle upar wala **🚨 Security** step: purana BOT_TOKEN **revoke** karo,
   naya token lo (public repo me purana leak ho chuka hai).
2. [dashboard.render.com](https://dashboard.render.com) → **New → Blueprint**
   → GitHub connect karke ye repo (`hulm0408/workwr`) select karo → **Apply**.
   *(Blueprint `main` branch se deploy karta hai — changes `main` me merge
   hone chahiye.)*
3. Render do values maangega:
   - `BOT_TOKEN` — @BotFather wala **naya** token
   - `OWNER_IDS` — aapki Telegram ID
4. Deploy (pehli baar ~3–5 min, Chrome download hota hai). Logs me ye dikhna
   chahiye: `Telegram ✅ @<bot>` + `🆕 Swiggy Fresh Bot chal raha hai`.
5. Telegram me `/start`, phir **`/diag`** — sab ✅ aana chahiye (Chrome
   Docker image me pehle se hai).

**Free Web Service par neend na aaye:** Render Free Web Service ko 15
minute inbound HTTP traffic na mile to service so jati hai; sirf Telegram
polling use jagata nahi rakhti. Bot ab khud Render ke
`RENDER_EXTERNAL_URL` se public **`/health`** ko har 5 minute ping karta
hai (localhost ping is timer ko reset nahi karta). `/diag` me
**❤️ Keep-alive ✅ ON** dikhna chahiye. External cron backup bhi isiliye
rakho: `GET https://<service>.onrender.com/health` har **5–10 min**, timeout
kam se kam **120s**. Cron URL me **`/robots.txt` mat lagao** — spun-down
service ko woh jagata nahi. Render ke Health Check Path me bhi `/health`
rakho; `/health/ready` alag se Telegram polling ready hone par hi 200 deta
hai. Soyi hui service khud ko akele nahi jaga sakti, isliye ek
successful external ping zaroori hai — uske baad built-in ping use phir
sone nahi dega (free monthly instance-hours baki hone chahiye).

**Plan ki baat:** `render.yaml` me **Background Worker (Starter)** + **1GB
persistent disk** (`/app/data`) set hai — yahi sahi combo hai:
- **Worker** = 24×7 chalta hai. Free **Web Service** 15 min me so jati hai
  → polling ruk jayegi, bot mar jayega. (Web Service par majboori ho to
  render.yaml me `type: web` kar do aur `disk:` hata do — health port
  bot khud khol deta hai, lekin neend wali problem rahegi.)
- **Disk** = accounts/settings/ledger deploy ke baad bhi bache rehte hain.
  Disk na ho to `GITHUB_VAULT_TOKEN` + `VAULT_ENCRYPTION_KEY` env set karo —
  bot startup par accounts cloud vault se wapas le aata hai (hydrate).
- Region **Singapore** set hai (India ke sabse paas).

> ⚠️ **Ek hi copy chalao!** Render par bot ON hai to local PC par
> `npm start` mat chalana — dono ek token se polling karenge to
> **409 Conflict** aayega aur ek band ho jayega.

## 🧬 Doosra bot (naya BOT_TOKEN) + doosri hosting

Same codebase se **doosra bot** chalana ho — naya @BotFather token, alag
account, purana bot jaisa hai waisa — to poori step-by-step guide:
**[`SECOND-BOT-DEPLOY.md`](SECOND-BOT-DEPLOY.md)**. Repo me
`render.second.yaml` (free web service, bina card) bhi ready hai.

Chhota summary:

- Doosre instance me `INSTANCE_LABEL=bot2` set karo → START card
  (`🆕 Swiggy Fresh Bot · bot2`), `/diag` aur `/health` me label dikhega
  (`"instance":"bot2"`), taaki dono bots me confusion na ho. Purane bot par
  label khali rakhne se UI bilkul pehle jaisi rehti hai.
- **Har instance ka apna token aur apna Telegram account** — ek token/ek
  session do jagah = 409 Conflict / session revoke.
- Cloud vault ka branch alag: `GITHUB_VAULT_BRANCH=bot-vault-2`.
- **Vercel par ye bot nahi chalega** (long polling, Chrome, disk) — Render
  ke 750 free hours account-wise hote hain, isliye doosra Render account.

## ⚙️ Settings — user ki azadi (env chhedni ki zaroorat nahi)

`/start` → **⚙️ Settings**:

- **🔥 Firebase Sources** — owner ki poori **ROLEX VIP list (400+ DBs)**
  code me built-in hai (`firebase-seed-urls.js`), isliye pehle boot par
  apne aap seed ho jati hai. Add Firebase me ek hi message me **1000 tak**
  URLs bhej sakte ho — har line me ek ya comma se alag; bare hostname aur
  har URL ke saath optional `| <DB_AUTH>` bhi chalega. Duplicate skip aur
  invalid entries ka count turant dikhega. **Har added Firebase hamesha
  ACTIVE rehta hai; disable/switch-off nahi hota — sirf Delete se hatega.**
  **Delete ki hui URL boot seeding se dobara wapas nahi aati.**
  Ek source add ho to auto-verify hota hai; bulk add me bot verify ke
  intezaar me nahi atkega, har source detail card se Verify ho sakta hai.
  Batch first-try (⭐) source se shuru hota hai; woh khali,
  error/deactivated ya exhaust ho to baaki saare **ACTIVE** sources isi
  run me ek-ek karke auto-try hote hain. Numbers + OTP current run-source
  se hi aate hain, aur source tabhi badalta hai jab koi number active na ho.
- **🩺 Source health** — ek DB 2 baar fail ya khali nikle to woh 30 minute
  ke liye quarantine me chala jata hai (list se hatta nahi, sirf try-order
  me peeche aata hai). Isliye 400+ DBs ke pool me har run pehle **zinda**
  DBs try karta hai, dead URLs par 10-10 second nahi jalte — live card par
  `⚡ IDs/min · ETA` bhi isi liye dikhta hai.
- **🤖 OTP bot** — Hermes / Hathi / HardXotp (sab same spare session; START par
  bhi chuna ja sakta hai aur choice save rehti hai)
- **🗑 Delete All Firebase** — poori list ek tap me saaf; delete yaad rehti hai
  (restart/redeploy par seeding wapas nahi laati) aur Firebase tab tak OFF
  rehta hai jab tak naya DB add na karo
- **🎯 Target** — presets (10/50/100/200/500) ya custom number text me likho
- **⏱ Max time** — 15m se 480m tak
- **🚦 Gap** — do numbers ke beech 0s–60s
- **📴 Offline devices** — try karein ya na karein
- **🔁 Never-stop** — ON (default) matlab batch **rukta nahi**: time cap pura
  ho to deadline khud badh jaati hai, fail-streak/rate-limit flood/WAF-403
  storm par saari lanes thoda cool-off lekar nayi IP par wapas aati hain, aur
  pool khali ho to saare ACTIVE Firebase sources dobara scan hote hain. Batch
  sirf **TARGET pura** hone ya **⏹ STOP** par khatam hota hai. OFF karne par
  purana safety-stop behaviour wapas aa jata hai.

- **🌍 Account engine** — `DIRECT API` (is bot ka apna Swiggy bridge + proxy/WAF
  solver) ya `WORLD BOT` (**@SwiggyByWorldBot** ke buttons click; **koi proxy
  nahi**). World Bot mode me numbers + OTP Firebase pool se aate hain aur
  Swiggy login/delete ka saara kaam wo bot karta hai:
  `/start → Login → OTP Login → number → OTP → (naam poochha = naya account)
  → JSON`. Naam na poochhe to account purana hai → `Order Hub → account →
  Delete Account → account → Delete OTP → Account Deleted Successfully` → phir
  se OTP Login (ab naam poochhega) → fresh JSON. Aakhir me best-effort
  `Switch Accounts → account → Permanently Logged Out`. Har fresh session wahi
  `.json` file ban kar is chat me aata hai.
- **🔁 Auto-resume** — batch chalte waqt Render deploy/restart, GitHub-Actions
  runner badalna ya process crash ho jaye to bot boot hone par **wahi batch
  khud shuru** karta hai (target/source wahi). Manual STOP ya target pura
  hone par flag clear ho jata hai, isliye ye apne aap repeat nahi hota.

Sab `data/db.json` me save hota hai — restart ke baad bhi yaad rehta hai.
Free Render par disk ephemeral hoti hai, isliye Firebase list + ye settings
cloud vault (`GITHUB_VAULT_TOKEN` + `VAULT_ENCRYPTION_KEY`) me bhi jaati hain
aur boot par wapas merge hoti hain (local delete kabhi undo nahi hota).
Poori list env se pakki karni ho (vault ke bina bhi):

```env
FIREBASE_DB_URLS=https://one-default-rtdb.firebaseio.com,https://two-default-rtdb.firebaseio.com
```

Boot par jo URLs missing hongi woh auto-add ho jayengi — Render restart/
redeploy ke baad list gayab nahi hoti.

## 📟 Fresh device + JSON delivery

- Scanner pehle configured base last-seen window (mis. 10s) me device
  dhoondhta hai. Har device ki halki probe pehle sirf uske **last 5 messages**
  dekhti hai (50 full SMS nahi). Ek refill ki quick scan ka hard budget
  **12s** hai (`PREMIUM_DEVICE_SCAN_BUDGET_MS`); is dauran har 4s par ladder
  agli window par khulti hai — 10s → 20s → 40s → 80s. Budget khatam ho to
  full pool ka intezaar nahi hota: probed sample ka sabse taaza SMS device,
  aur agar usable SMS timestamp hi na ho to Firebase `clients` me **ONLINE**
  dikh raha device, process hota hai. `clients` presence boolean ke alawa
  `online`/`active`/`connected` jaise text aur `1/0` formats me bhi samjhi
  jati hai; status missing/unknown ho to usay zabardasti offline ya ONLINE
  nahi mana jata — woh sirf SMS timestamp se hi aage badh sakta hai. Ek full
  pass + ek retry pass me na timestamp mile na pakka ONLINE device, aur agla
  ACTIVE Firebase maujood ho, to bot usi dead source par 40 passes nahi
  ghumata — agla source try karta hai. 40-pass fresh-wait sirf aakhri/ekmatra
  source ke liye hai. Ye zaroori hai kyunki last incoming SMS asal heartbeat
  nahi — zinda device ko bhi ghanton/dinon SMS nahi aata.
  Candidate milte hi scan ruk jata hai aur sabse taaze **12 ranked backups**
  bhi queue me rehte hain; ek miss ho to agla cached device process hota hai,
  Firebase pass dobara nahi ghumta. Card par current pass ke **unique
  devices**, **total probes**, current ladder window, candidate devices ke
  **ONLINE/status-unknown/offline** counts aur ab tak ki sabse taazi SMS age
  alag-alag dikhte hain.
- Har fresh session ka JSON usi waqt chat me `.json` file ki surat me jata hai.
  Telegram/document send fail ho to bot 3 baar retry karta hai; phir bhi na jaye
  to poora JSON code-block hissoun me bhej deta hai. Caption me bachi hui
  session life bhi dikhti hai.
- **JSON 2–3 ghante me purana kyun lagta tha:** web/DAPI OTP login ka JWT
  `tid` short-life ho sakta hai. Ab fresh JSON save/export hone se pehle bot
  usi authenticated session ko Android `chkout` se rotate karne ki koshish
  karta hai aur sirf isi customer ka non-guest, zyada-life wala JWT accept
  karta hai. Export me `_session_tid`, `jwtTid`, `tidExpiresAt` aur
  `sessionLongLived` bhi rehte hain, taaki asal life chhupi na rahe.
- **⏳ 7-day extracted-number cooldown:** jis number ka fresh session ek
  baar extract/send ho jaye, woh number **7 din se pehle dobara process
  nahi hota** — na hot-queue se, na purani retry-later entry se, na next
  run me. Success timestamp `premiumFlow.used` ledger me rehta hai aur
  cloud vault ke saath sync/hydrate hota hai, isliye Render restart/deploy
  ke baad bhi ye rok barqarar rehti hai. Ledger kisi wajah se missing ho
  to saved account/session ke `savedAt` se bhi wahi 7 din ginay jate hain.
  7 din guzarne ke baad hi number dobara eligible hota hai.
- Purane saved session ka latest JSON lena ho to owner command:
  `/session 9876543210` ya `/session acc_9876543210`. JWT short/expired ho
  to ye command pehle **usi saved account ko bina naya OTP liye refresh**
  karne ki koshish karti hai (Android chkout; JWT mar gaya ho lekin
  `_session_tid` zinda ho to DAPI fallback), naya token DB me save karti hai,
  phir updated JSON bhejti hai. Isliye dusra tool 2–3 ghante baad JSON
  maange to naya account turant mat banao — pehle `/session <number>` se
  refreshed JSON lo. Agar Swiggy ne session asal me revoke/expire kar diya
  ho, bot saaf batayega aur purana saved JSON bhejega; us haalat me naya OTP
  login hi asal ilaaj hai.

## ⚡ Parallel lanes — 10 numbers, 10 alag IPs, ek saath

Autopilot ab numbers ko ek-ek karke sequential process nahi karta. Batch
**dynamic parallel lanes** chalata hai:

- Har lane ka **alag number, alag device, alag bridge session aur reserved
  proxy/IP route** hota hai. Ek proxy ek waqt me do lanes ko nahi milti.
- Default **10 lanes** hain; ⚙️ **Settings → ⚡ Parallel** se 1/3/5/10
  choose kar sakte hain (env fallback: `PREMIUM_BATCH_CONCURRENCY`).
- Asal lane count distinct routes tak limited hai: **enabled proxies +
  1 direct Render IP**. Misal: 9 proxies + direct = 10 lanes; 3 proxies +
  direct = 4 lanes; proxy bilkul na ho to direct par sirf 1 lane (ek hi IP
  ko jhooth-mooth 10 IP nahi dikhaya jata).
- Jo lane pehle free hoti hai wahi agla number uthata hai — OTP wait,
  WAF/rate cooldown ya slow proxy baaki lanes ko nahi rokti.
- Ek hi phone ya ek hi `deviceId` ki doosri SIM do lanes ek saath nahi
  uthati, warna ek hi inbox par OTP ambiguity ho sakti hai.
- Har lane ki WAF/security/rate-limit reaction usi lane ki IP par hoti
  hai; ek IP garam hone se baaki IPs par kaam jaari rehta hai.
- Live card par saari active lanes ke number + route dikhte hain. Gap bhi
  ab **per-lane/per-IP** hai, poore batch ko rokne wala global gap nahi.
- Chromium WAF solver memory safety ke liye ek waqt me ek hi chalta hai,
  lekin lanes pehla HTTP/OTP attempt solver queue ke baghair bhej sakti
  hain; token sirf asal challenge par solve hota hai.

> 10 lanes ka matlab 10 guna output ki guarantee nahi — output phir bhi
> zinda devices, OTP forwarding aur proxy quality par depend karega.
> Lekin ek slow number/IP ab poore batch ko block nahi karega.

## 🛡 WAF / Security challenge — "aaye hi na" ka tod

Jo 403 challenge pehle poora batch maar deta tha, ab uska tod:

1. **Batch start se pehle WAF token warm-up** — Chromium solver ek valid
   `aws-waf-token` laata hai (2h tak valid), phir **har OTP/verify/delete
   request** usi token ke saath jaati hai → WAF ko normal browser traffic
   dikhta hai, challenge hi nahi.
2. **Phir bhi challenge aaye** → bot **turant naya token** lekar **ek baar
   retry** karta hai (na ki hammering).
3. **Engine-level** — challenge aane par batch **nahi rukta**: sirf us
   lane ki final proxy quarantine karke best next route milti hai, usi
   lane par **3 proxy challenges ke baad Render ki direct IP**, aur 2
   direct challenges ke baad best proxy dobara try hoti hai. Route ki
   ginti lane ke process-start route episode se hoti hai (bridge ke andar
   IP badalne par ginti gum nahi hoti). Ek hi number par ek run me
   combined WAF/security/rate/transient attempts max **2** hain, taaki
   storm me wohi number baar-baar time na jalaye. Card par active lanes,
   rotations, token-ready aur free-usable/lane-reserved/cooling proxy
   counts dikhte hain. Batch sirf bahut lagatar challenges par rukta hai
   — limit lanes ke hisaab se scale hoti hai taaki pehli parallel wave hi
   batch ko premature band na kar de; ek processed response bhi aa jaye
   to storm ginti reset ho jati hai.
4. **Solver route-locked; fast 15s / reliable 45s** — har proxy ka solve
   alag route key par hota hai (ek IP ka token doosri IP par leak nahi).
   Chalti request ke beech recovery aur clean route ke pre-claim solve ke
   liye **15s fast** budget hai; challenged/direct route ko number claim
   karne se pehle **45s reliable** budget milta hai. Token jaldi aa jaye to
   solver turant return karta hai.
   Ek hi 15s total cap Chromium launch + slow proxy navigation + 15s cookie
   wait ko jagah hi nahi deti thi. Jis proxy par solve fail ho wo 90s side
   par rehti hai. WAF-hit proxy ki quarantine 60–120s hai, aur asal OTP
   attempt par 5xx/network dene wali route 60s transient cooldown par jati
   hai (token burn kiye baghair).
5. **15-second route recovery waits** — engine WAF wait 5s→10s→**15s cap** hai;
   rate-limit par lane 5s→8s→12s (15s cap) ruk kar NAYA number leti hai.
   Global WAF circuit-breaker bhi ab 15s/30s/60s hai. Number queue me park
   nahi hota; garam IP par route recovery ke baad bhi purana number repeat nahi hota.

## 🔀 Proxies — "rukna hi na pare" ka asli tod (IP rotation)

**Asli problem:** Swiggy ka WAF/rate-limit **IP ko** block karta hai, number
ko nahi. Ek IP par lagatar request = flagged IP = 403 = wait.

**tod:** multiple proxies (nayi-nayi IPs). 🔀 **⚙️ Settings → 🔀 Proxies** se
jitne chahein add karo (ek saath comma me bhi):

- `host:port` · `http://user:pass@host:port` · `socks5://host:port`
- **🌐 Free Proxies Lao (auto)** — proxy card se ek tap: bot ab **18 public
  free sources** (ProxyScrape, Proxifly global/India, monosans, jetkai,
  TheSpeedX, hookzof, clarketm aur roosterkid) ko parallel fetch karke
  candidates merge karta hai, phir har proxy ko generic HTTPS ke baad
  **seedha Swiggy par test** karta hai. Target ab **30 usable backups** hai.
  Clean proxies pehle aati hain; jo Swiggy tak pohanchti hai lekin WAF
  challenge deti hai use 🛡 fallback tier me rakha jata hai kyunki browser
  usi IP ka `aws-waf-token` solve kar sakta hai. Card par sources/candidates/
  checked/clean/challenged diagnostics bhi dikhte hain. Batch start/mid-run
  par refill ka faisla sirf enabled ginti nahi, **asal usable** (cooling/
  errored excluded) ginti par hota hai — isliye “10 ON” ka matlab agar
  sirf 2 asal usable hon to bot phir se nayi proxies laata hai (OFF karna ho:
  proxy card par 🌐 Free Auto toggle, ya env `PREMIUM_AUTO_FREE_PROXIES=0`).
  Apni list URLs: `PREMIUM_PROXY_SOURCES=url1,url2` — ye baki sources ke
  saath merge hongi. Free proxies marne par refresh me khud replace ho jati
  hain; manual proxies ko haath nahi lagta. (Sach: free wali aksar slow/dead
  hoti hain — isliye health-check filter hai; best natija khud ki sticky
  proxies se hi milta hai.)
- Add karte hi **rotation ON**. Picker sirf round-robin nahi — fresh
  per-proxy token wali route sabse pehle, phir clean, Indian, kam-hit aur
  kam-latency route aati hai; challenged/solve-failed routes peeche
  rehti hain.
- **WAF/rate-limit/temporary 5xx hit = TURANT doosri proxy** — number
  failed count kiye baghair defer karke aage badhta hai, baad me **isi run
  me** ek aur mauqa milta hai (per number combined infra attempts max 2).
  Temporary errors ka cool-off bhi chhota hai: 15s→30s→45s cap.
- **`aws-waf-token` IP-bound** hota hai → har proxy ka **apna token** +
  apna WAF/solve-failure state (proxy-pool.js me per-proxy). Challenge par
  usi route ka token burn ho jata hai; ek session ke beech silent IP-switch
  nahi hota (**sticky route**, rotation sirf explicit recovery me).
- Proxy ON ho to **browser (puppeteer) bhi usi IP se** chalta hai.

**Batch sirf 3 cheezon par rukta hai: STOP · target · time.** Baaki kuch bhi
ho (403, rate-limit, Swiggy/proxy 5xx, network fail) — rotate/defer karke
chalta rehta hai; temporary error par number failed nahi gina jata.

> ⚠️ Bina proxy = ek hi IP = rukne ka khatra. Proxy add karo, rukna band.

## Files

| File | Kaam |
|---|---|
| `fresh-bot.js` | Bot UI — START/STOP/STATUS/**SETTINGS** (entry point) |
| `start-source-presets.js` | START ke 3 source buttons (Hermes+World / Hathi / Swiggy by World) |
| `shop-bot-stock.js` | Fresh JSON → `@its_shop_bot` stock queue (10-10 files, zip nahi) |
| `autopilot-engine.js` | **Parallel batch lanes** — distinct IPs/devices, target/time, lane-local rotate/defer, live-card |
| `number-pipeline.js` | EK number ka poora lifecycle (saare scenarios) |
| `firebase-numbers.js` | Firebase reader — pool + OTP inbox + **dynamic source override** |
| `firebase-sources.js` | **Multiple Firebase sources** — bulk add (1000)/verify/health; sab Delete tak ACTIVE (db-backed + vault) |
| `firebase-seed-urls.js` | Owner ki ROLEX VIP Firebase list (400+ DBs) — boot par permanently seed hoti hai |
| `otp-bot-profiles.js` | **OTP bot profiles** — Hermes / Hathi / HardXotp ke buttons, card labels aur UI labels (pure, tested) |
| `instance-info.js` | **Doosra deployment label** — `INSTANCE_LABEL` se title/diag/health me `· bot2` (default `main` = purana look) |
| `bot-settings.js` | **Batch knobs** — target/parallel lanes/time/gap (UI se, validated + clamped) |
| `proxy-pool.js` | **Proxy pool** — lane reservations, IP rotation, per-proxy WAF token + cooldown |
| `swiggy-bridge.js` | Swiggy automation + WAF token injection + **lane-local proxy routing** |
| `store.js` + `vault-sync.js` | Session DB (`data/db.json`) + cloud vault |
| `test_fresh_unit.mjs` | Unit tests (mocked fetch) — `npm test` |
| `scratch/firebase-inspect.mjs` | Firebase ka live structure dump — `npm run inspect` |

### 📦 Shop Bot stock (`@its_shop_bot`)

Har fresh Swiggy session (world bot ho ya direct) apne aap `@its_shop_bot` ke
stock queue me jaata hai:

1. Fresh JSON → queue (`/shopstock` par `7/10` dikhta hai).
2. **10 poore** hone par wahi 10 files ek-ek **`.json` document** ki tarah
   spare Telegram account se shop bot ko jaati hain — **zip nahi, text nahi**.
3. Shop bot unhe **Swiggy / Twing** product me stock kar deta hai (product
   button khud click hota hai, `SHOP_BOT_PICK_PRODUCT=0` se band).
4. Fail ho to queue **safe** rehti hai — agle fresh par dobara try. Manual:
   `/shopstock` → **📤 Abhi Bhejo** (adhoora batch bhi chala jayega).

Batch size fix **10** hai (min 10, max 10) — env se badal nahi sakta.

### 🛡️ Mistake-proofing — kya galat ho sakta hai, aur uska ilaaj

| Galti / rukawat | Bot kya karta hai |
|---|---|
| Button **click kaam na kare** (bot callback ignore kare) | Usi button ka **poora text type** karke trigger (pehle emoji ke saath, phir bina) |
| Click ka **jawab der se** aaye | Type **skip** ho jata hai — double `Delete Account`/double action nahi |
| Wahi text 8s ke andar dobara | Dobara nahi bhejta (duplicate action guard) |
| OTP `123 456` / paste me spaces | Sirf **digits** nikal kar bhejta hai |
| Wahi **purana OTP** dobara aaye | Number skip (bot wahi) — galat OTP se number nahi jalta |
| OTP 20s me nahi aaya | **Number skip**, bot wahi |
| Bot OTP **bhej hi na paye** / queue 20s+ | **Next bot** (ek number par max 3) |
| Bot hi na mile (username galat/block) | **Next bot** |
| Telegram `FLOOD_WAIT` | Ruk kar (max 45s) wahi message dobara |
| Network hiccup (screen read) | 2 retry, phir agla step |
| Session dead (`AUTH_KEY_UNREGISTERED`) | Batch saaf message ke saath rukta hai → Settings → Add Telegram Account |
| JSON **adhoora** mila | `Copy Code` se ek retry, phir saaf error |
| Delete ke baad number list me nahi | `/start` → Order Hub **retry**, phir hi skip |
| Bot `Haan`/confirm maange | Khud click/type karta hai |
| Logout ka naam alag ho | `permanently logged out` / `logout` / `sign out` — sab match |
| Bot switch storm | Sirf 3 hi soorat me switch, ek number par max 3 bot |

## Message style (in bots jaisa saaf look)

Bot ke saare cards ek hi shakal me aate hain — bikhri hui information nahi:

```
—[ 🟢 LIVE ]— 02:44
──────────────
NEW › OTP › [REFRESH] › VERIFY › ADDR › FRESH
Abhi: REFRESH par OTP aa raha hai
▰▰▱▱▱▱▱▱▱▱ 20%  2/10
📱 9876543210 · ⏱ 1m 5s
Next: OTP mila to verify · na mila to NEW NUMBER
```

* **Fancy heading** — `—[ ⚡ 𝗧𝗜𝗧𝗟𝗘 ]—` Unicode bold me (Telegram har device par dikhata hai), saath me right-side `HH:mm` (IST) time chip.
* **Patli line** — header ke niche `──────────────`; purani `━━━` / fake table art hamesha ke liye gayi.
* **Labels fancy, values plain** — `𝗬𝗼𝘂𝗿 𝗡𝘂𝗺𝗯𝗲𝗿:` ke aage number saada rehta hai.
* **Numbers / OTP / JSON kabhi fancy nahi** — copy-paste aur padhna kharab na ho (`mono()` inhe `<code>` me rakhta hai).
* **Ek command, phir bot ka jawab** — agla command tab hi jata hai jab bot ka pichla jawab poora aa chuka ho (`settledScreen`), aur button/label sirf **latest 1-2 messages** se padhe jate hain. Isliye `/start` + `Login` + `OTP Login` ek saath nahi jaate aur `❌ Invalid OTP` / `❌ Invalid Mobile Number` ka spam nahi hota.
* **Process wahi jo ideal flow me hai** — login se pehle bot ka adhoora OTP/number prompt pehle `Cancel` se saaf hota hai, phir `Main Menu` (button ho to wahi dabta hai, `/start` nahi) → `Login` → `OTP Login` → number → OTP.
* **Delete ke baad Main Menu** — `Haan 💜` (remove confirm) ke baad **🏠 Main Menu** dabta hai, phir `Login` → `OTP Login` → **wahi number** → OTP → naam → JSON. `/start` ya seedha `Login` delete screen se nahi hota.
* **Naam hamesha `Sudhani Kumar`** — World Bot jab `🆕 New Account Detected` bole to naam = **`Sudhani Kumar`** (space ke saath, default). Naam ka masla yahin khatam. Sirf agar bot yahi naam reject kare (`❌ Invalid name`, `already taken`) to fallback chalte hain: pipeline ka naam, phir number ke **pehle 5 digit alphabetic** (1→a … 9→i, **0→x**): `98765…` → `ihgfe`. Khali/invalid naam **bhejta hi nahi**.
* **Naam step kabhi atakta nahi** — khali/invalid naam **bhejta hi nahi** (phone digits se saaf naam banta hai). Bot naam reject kare (`❌ Invalid name`, `Name must be 3–20 letters`, `name already taken`) to turant **agla naam** try hota hai; bot `✅ Yes / ❌ Cancel` confirm maange to **Yes** dabta hai; naam ke baad JSON na aaye to **JSON recovery** (Copy button → aakhri 15 messages → 12s) chalti hai. Sab fail ho to `name_rejected`/`no-json` = **wahi number dobara**, bot wahi.
* **Har message ka kind ALAG check hota hai** — pehle screens ke text **jod kar** classify hote the (`Swiggy Login` + `OTP Login … number bhejo` = `loginScreen`), isliye number prompt pehchana nahi jata tha aur step 45s ke late-scan par chala jata tha. Ab `worldBotHasPromptKind()` har message alag dekhta hai — poora flow (login → delete → re-login) fake bot par seconds me chalta hai.
* **Stale button kabhi dobara nahi dabta** — delete me window me pada purana account button dobara click ho jata tha (bot delete-OTP maang raha hota tha) → 45s waste + galat step. Ab sirf **latest screen** ka button chalta hai, aur optional clicks ka late-scan budget 3s.
* **Logout ka pehla step `Switch Account`** — login ke baad bot JSON screen par hota hai, isliye pehle Main Menu → `Switch Account` → wahi account → `Permanent Logout` → `✅ Yes`; na mile to `Swiggy Accounts` → account, phir Order Hub.
* **`/start` kabhi flow ke beech nahi** — World Bot naam/OTP/number maang raha ho, ya screen par `Cancel`/`Copy` jaisa step-button ho, to `/start` **nahi** jata (warna bot reset ho kar `Invalid OTP` / `Invalid Mobile Number` deta tha). Pehle `Cancel`, phir `Main Menu` ka apna button; `/start` sirf tab jab screen sach me khali ho.
* **Delete se pehle Main Menu** — JSON/login ke baad seedha Order Hub dabane par wo button hi nahi hota tha; ab pehle `🏠 Main Menu`, phir `Order Hub` → account → `Delete Account`.
* **Delete success = turant Main Menu** — "Account Deleted Successfully" aate hi (500ms poll, koi 1.5s settle-wait nahi) `🏠 Main Menu` dabta hai, phir wahi number: `Login` → `OTP Login` → number → OTP → naam → JSON.
* **Logout par do confirmation** — `Permanently Logged Out` ke baad bot pehle "konsa account" poochhta hai (wo ID) aur phir `✅ Yes / ❌ Cancel` — **Yes** dabta hai, Cancel kabhi nahi. Yes na mile to `logout_not_confirmed` (jhoothi success nahi).
* **Telegram flood wait ka tod** — owner ke logs me `Sleeping for 4s / 16s on flood wait (GetHistory)` step ka poora budget kha jata tha, isliye delete/login ka aaya hua jawab bhi "nahi aaya" gin liya jata tha aur number bekaar skip ho jata tha. Ab: (1) ek waqt me **ek hi GetHistory** (single-flight), (2) slow read par **adaptive cache** (8s tak) taaki throttle aur na chhide, (3) read me flood ne jitna waqt liya wahi **step ke budget me wapas add** hota hai, (4) timeout par turant fail nahi — **90s ka dheema late-reply scan**, (5) "OTP Sent" ke 20s budget me bhi flood ka waqt add hota hai, (6) OTP bot ka 1s REFRESH khud dheema (2–5s) ho jata hai jab Telegram throttle kare.
* **Delete ka jawab late = number skip NAHI** — `delete_result_timeout` par wahi number se `Login → OTP Login → number → OTP` se state check hota hai: **naam poochha = account delete ho chuka** (seedha file → worker bot → logout), **naam nahi poochha = account zinda** (usi number par delete dobara). Login ka jawab late aaye to bhi **wahi number** dobara try hota hai (naya number/card nahi).
* **JSON file (starting se ending tak)** — login successful hote hi bot ke message se sirf pehla `{` se aakhri `}` tak ka hissa liya jata hai (header, code fence, "Copy Code" sab hata) aur **ek `.json` file** banti hai (`data/session-files/acc_<number>.json`). Wahi file worker bot par jaati hai — aur **10 poore** hone par wahi 10 files `@its_shop_bot` (stock) me bhi.
* **File jaane ke BAAD logout** — file worker bot par bhej di jaaye (asli result ka intezaar), uske baad hi `Permanently Logged Out` → `✅ Yes`. File attach fail ho to logout nahi hota aur engine dobara bhejne ki koshish karta hai (double send nahi hota — `sessionSent` flag).
* **Delete ke baad wahi number** — delete hone ke baad **naya number / OTP bot se naya card nahi** liya jata; jo number delete hua wahi `Login → OTP Login → OTP` par dobara jaata hai, aur usi ka JSON file banta hai.
* **Delete blocked (charges/dues)** — bot bole "this account can't be deleted because user charges are present" to fresh account us number par ban hi nahi sakta. Tab: **🏠 Main Menu → 🔁 Switch Accounts → woh ID → 🚪 Permanently Logged Out**, phir **naya number** (number skip, bot wahi). Card par: `⛔ Delete Blocked (Charges) — Naya Number`. Bot jab OTP/number/naam maang raha ho to **button ka text kabhi nahi bhejta** (warna bot usi ko OTP/number samajh kar `❌ Invalid OTP` / `❌ Invalid Mobile Number` deta tha).
* **Deadlock-free OTP fetch** — world-bot login jo Telegram lock pakadta hai, usi ke andar OTP fetch (wahi lock maangta hai) re-entrant chalta hai. Isse pehle ye apne hi lock par atka reh jata tha: number aata tha par OTP kabhi fetch/type nahi hota tha.
* **OTP ke liye REFRESH** — OTP Sent ke baad OTP bot (Hermes/Hathi) me **har second** REFRESH dabta hai (button 12 screens + window se bahar gaya number-card tak dhoondha jata hai; na mile/click na chale to button ka text `Refresh` type hota hai). OTP aate hi copy karke world bot me type hota hai.
* **OTP ka "sach me naya hai" test** — number bhejne se **thik pehle** OTP bot ka watermark (aakhri messages + unke edit waqt) yaad rakha jata hai. Iske baad aaya **ya edit hua** code hi is number ka OTP maana jata hai — isliye 2 second me aa gaya OTP bhi miss nahi hota, aur purana code galti se dobara type nahi hota.
* **OTP scan window chaudi** — OTP bot chat ke aakhri **30 messages** (`SWIGGY_OTP_SCAN_LIMIT`, 12–60) padhe jate hain, aur number card/OTP message **id se seedha** bhi padha jata hai — har second refresh se card window ke bahar chala jaye to bhi OTP mil jata hai. Code `OTP: 123456`, `123 456`, `123456 is your OTP` — teeno shakal me parse hota hai.
* **Blank / photo reply pehle verify hota hai** — Swiggy bot ka jawab kabhi bina text (photo ya khali message) aata hai. Pehle use seedha "OTP Sent" maan liya jata tha, jabki usi chat me `❌ Could not send OTP … login attempts exceeded` pada hota tha → 20 refresh, code hi nahi → number jal jata tha. Ab 3s ke baad **poora screen dobara padha jata hai**: `Could not send OTP` / `suspended` / `attempts exceeded` mile to wahi jeetta hai, `Login Cancelled` mile to wahi, warna hi OTP Sent.
* **`Delete OTP Sent` ab delete-success nahi** — transcript ki asli line hai `✅ Delete OTP Sent … the account will be permanently deleted`; isme "deleted" shabd ki wajah se classifier use **Account Deleted Successfully** maan leta tha. Ab delete ka OTP pehle check hota hai, delete-success baad me — isliye delete ke baad account zinda rehne ka case khatam.
* **Bot ke saare screens text se pehchane jate hain** — `🏠 Main Menu`, `🔐 Swiggy Login / Select a login method`, `✅ Login Successful + 🆔 Customer ID`, `Login JSON / Tap Copy`, `❌ Login Cancelled / No account was logged in`, `⏳ Swiggy rate limit … queue`, `🗑 Permanent Logout Successful`. Pehle inme se kai `''` the, isliye flood/blank read par step ka pata hi nahi chalta tha.
* **Logout ka transcript wala rasta** — `🏠 Main Menu → 📇 Swiggy Accounts → woh number → 🗑 Permanent Logout → (account) → ✅ Yes`. Pehle "Swiggy Accounts" button ka koi role hi nahi tha, isliye logout Order Hub/Switch Account se hi try hota tha.
* **Telegram disconnect = number nahi jalta** — Render par socket beech flow me mar jata tha (`Cannot send requests while disconnected` har 60s) aur har read khali/adhoori aati thi → "45s me jawab nahi aaya" → number retire. Ab har read/send se pehle connection check + `connect()` reconnect, aur disconnect ho to `worldbot_offline`: batch saaf message ke saath rukta hai, number bachta hai.
* **Timeout ka reason bot ka screen** — pehle log me `last: 230713` (humara hi bheja OTP) aata tha; ab `bot ka screen · apna bheja · buttons` — isi se `login attempts exceeded` jaisa chhupa hua faisla pakda jata hai (aur bot switch nahi hota).
* **Cancel ke baad OTP type nahi hota** — screen par `Login Cancelled` / `Could not send OTP` ho to OTP type karna band; number ka faisla (`login_cancelled`) — warna bot us OTP ko number samajh leta tha.
* **Refresh card kisi aur number ka ho to bhi** — OTP chat me agar sirf purane number ki card padi ho to 2nd attempt se usi card par REFRESH dabta hai (pehle `latest-screen-different-number` keh kar 20-21 attempts bina click chale jaate the aur naye number ka card banta hi nahi tha).
* **Click ka callback = kaam ho gaya** — button click par bot ka callback aa gaya to wahi text (jaise `OTP Login`) dobara **nahi** likha jata; isi duplicate se bot "login attempts exceeded" deta tha.
* **Flood wait par jhukna nahi** — `messages.GetHistory` flood wait / khali read par 3 koshish (0.9s, 1.8s backoff) + 0.4s read-cache, warna `Login button nahi mila — screen: none` jaisi jhooti fail aur bot switch hota tha.
* **OTP hamesha type hota hai** — OTP source se code aate hi bot ko bheja jata hai (sirf tab nahi jab bot saaf-saaf number/naam maang raha ho), aur **ek hi baar**. Code na aaye to card me saaf reason: `OTP source (Hermes/Firebase) me is number ka code hi nahi aaya`.
* **Do alag budgets** — `20s` sirf "OTP Sent" confirm karne ka; OTP inbox ka intezaar alag (`SWIGGY_WORLD_OTP_INBOX_TIMEOUT_MS`, default 90s). Number 20s me nahi marti.
* **Bot ke apne errors maane jate hain** — `❌ Could not send OTP … account suspended` ⇒ number dead (skip, bot na badlo); `… login attempts exceeded` ⇒ number 2 ghante cooldown; 20s wait/retry nahi.
* **Lambi detail collapsible** — `/world` ke last 5 screens `<blockquote expandable>` me: card chhota rehta hai, kholne par poora detail.

Helpers `rich-text.js` me hain: `fancy()`, `bracketHeader()`, `headerRule()`, `stamp()`, `sectionStamp()`, `details()`, aur ulta `plain()` (fancy glyphs → ASCII, taaki stage matching/regex na tootey).

## Env knobs (optional — defaults acche hain)

| Var | Default | Matlab |
|---|---|---|
| `PREMIUM_BATCH_TARGET` | 100 | Kitne fresh sessions tak chale |
| `PREMIUM_BATCH_CONCURRENCY` | 10 | Ek saath kitni parallel lanes (1–10); asal lanes distinct proxy/direct routes tak limited |
| `PREMIUM_BATCH_MAX_MINUTES` | 120 | Max run time (Never-stop ON me ye sirf checkpoint hai — deadline khud extend hoti hai) |
| `PREMIUM_NEVER_STOP` | 1 (ON) | `1` = batch khud na ruke (auto cool-off/reextend/rescan) · `0` = purane safety stops |
| `PREMIUM_ACCOUNT_ENGINE` | `direct` | `direct` = apna Swiggy bridge (proxy/WAF) · `worldbot` = @SwiggyByWorldBot ke buttons click (proxy nahi) |
| `SWIGGY_WORLD_BOT_USERNAME` | `SwiggyByWorldBot` | World Bot ka handle (badalna ho to) — pool me na ho to sabse aage lagta hai |
| `SWIGGY_WORLD_BOT_USERNAMES` | *(khali)* | Comma wali list se poora bot pool override — default pool: `SwiggyByworldBot, SwiggyByworld1Bot … SwiggyByworld5Bot` (saare same) |
| `SWIGGY_WORLD_STEP_TIMEOUT_MS` | 45000 | World Bot ke ek step (button/JSON) ka budget |
| `SWIGGY_WORLD_OTP_TIMEOUT_MS` | 20000 | OTP ka intezaar **sirf 20s** — nahi aaya to number skip (bot wahi) |
| `SWIGGY_WORLD_OTP_SEND_TIMEOUT_MS` | 20000 | Bot "OTP Sent" 20s me confirm na kare → **bot badlo** |
| `SWIGGY_WORLD_OTP_INBOX_TIMEOUT_MS` | 90000 | OTP **source** (Hermes/Firebase) me code aane ka intezaar — ye number ki life nahi, 20s se alag budget |
| `SWIGGY_OTP_REFRESH_MS` | 1000 | OTP bot (Hermes/Hathi) me REFRESH kitni der me — OTP Sent ke baad **har second** refresh, OTP aaye to copy karke world bot me |
| `SWIGGY_OTP_SCAN_LIMIT` | 30 | OTP bot chat ke kitne aakhri messages padhein (12–60). Thoda bada rakhna accha: refresh se purana card bahar chala jata hai, par id se phir bhi padha jata hai |
| `SWIGGY_WORLD_QUEUE_WAIT_MS` | 45000 | Bot "queue/wait" bole to itna wait (asli run me OTP Sent ~40-60s baad aata hai); isse zyada → **bot badlo** |
| `SWIGGY_WORLD_TRIGGER` | `auto` | Button **click** → screen na badle to **button ka text likh kar bhej** (`type` = click bilkul nahi) |
| `SWIGGY_WORLD_CLICK_GRACE_MS` | 4000 | Click ke baad screen badalne ka intezaar, phir text trigger |
| `SWIGGY_WORLD_OTP_VERIFY_WAIT_MS` | 90000 | OTP type karne ke **baad** bot ke jawab (naam/JSON) ka budget — account creation me waqt lagta hai (30s–240s). 20s sirf OTP **source** ka rule hai |
| `SWIGGY_WORLD_LOGIN_GUARD_MS` | 300000 | Itne waqt tak `/start` aur `Cancel` **band** jab login khula ho (number/OTP gaya, jawab nahi aaya) — warna World Bot "❌ Login Cancelled" de deta hai |
| `SWIGGY_WORLD_LATE_REPLY_GRACE_MS` | 90000 | Step ka budget khatam hone par aakhri dheemi scan — **flood wait hua ho tab hi poora** (warna max 20s), `0` = band. Isse "bekaar me minute bhar baithna" band hua |
| `SWIGGY_WORLD_NUMBER_RETRIES` | 1 | OTP send confirm na ho (aur bot ne Cancel bhi na bheja ho) to number **skip nahi** — wahi number itni baar `Login → 2 → number` se dobara issue (max 2, `0` = off) |
| `SWIGGY_WORLD_LOGOUT_AFTER_DELETE` | 1 | JSON file worker bot par jaane ke baad `Switch Accounts → Permanently Logged Out` try kare |
| `SHOP_BOT_STOCK_ENABLED` | 1 | Har fresh JSON ko `@its_shop_bot` ke stock me bheje (`0` = band) |
| `SHOP_BOT_USERNAME` | `its_shop_bot` | Stock lene wala shop bot |
| `SHOP_BOT_PICK_PRODUCT` | 1 | Shop bot ke **Swiggy/Twing** product button khud dabaye |
| `SHOP_BOT_PRODUCT_REGEX` | `swiggy\|twing` | Shop bot ke product button ka naam alag ho to regex |
| `PREMIUM_BATCH_GAP_MS` | 6000 | Ek hi lane/IP par do numbers ke beech gap |
| `PREMIUM_RATE_LIMIT_BACKOFF_MS` | 900000 | Fallback lane cooldown — fast ladder se cap hota hai (max 15s) |
| `PREMIUM_RATE_LIMIT_RETRY_MS` | 5000 | Rate-limit par lane ka pehla wait (5s → 8s → 12s, chhat 15s) |
| `PREMIUM_OTP_WAIT_MS` | 3000 | OTP bhejne ke baad poll shuru karne se pehle chhota wait (snapshot purane codes se bachata hai, jaldi poll safe hai) |
| `PREMIUM_OTP_TIMEOUT_MS` | 90000 | OTP inbox poll budget |
| `PREMIUM_DEVICE_ACTIVE_WINDOW_MS` | 60000 | **Last-seen base window**: pehle is window ki SMS activity wala device, phir doubling ladder. Sakht: `10000`, band: `0` |
| `PREMIUM_DEVICE_SCAN_BUDGET_MS` | 12000 | Ek refill me quick scan ka hard time budget; iske baad probed sample ka best ya clients-ONLINE device process hota hai |
| `PREMIUM_ALLOW_OFFLINE_DEVICES` | — | `1` = offline devices bhi try |
| `INSTANCE_LABEL` | `main` | Doosre bot/hosting par `bot2` — UI, `/diag` aur `/health` me pehchan |
| `INSTANCE_COUNT` | `1` | Kai bots ek hi pool/proxy par → kul bots ki ginti (4). Numbers + proxies ka apna hissa, lanes capped |
| `JSON_TEXT_FALLBACK` | — | `1` = `.json` file attach fail ho to raw JSON text me bhejo (default: saaf message + `/session`) |
| `TELEGRAM_CALL_TIMEOUT_MS` | `20000` | Boot ke getMe/deleteWebhook ka hard timeout (hang = fail → retry) |
| `PROXY_MODE` | `auto` | `direct` = proxy pool poori tarah band (no fetch, no WAF-solve, 1 lane, ek IP) — sabse simple aur sabse kam time-waste |
| `TELEGRAM_SESSION_2…_8` | — | Extra spare accounts. Ek account flood/dead ho to bot **khud agla** uthata hai (`npm run telegram:audit` se check) |
| `GITHUB_VAULT_BRANCH` | `bot-vault` | Doosre instance ke liye `bot-vault-2` (warna vault overwrite hoga) |

## Timing expectation

~35–90 second per number **per lane** lag sakte hain (purane numbers me 3 OTP rounds lagte hain — login OTP, delete OTP, phir naya signup OTP). 10 healthy lanes hon to ye waits overlap ho jate hain aur aggregate throughput sequential run se kai guna ho sakta hai; lekin dead devices, OTP na aana, kharab free proxies ya WAF solver queue asal speed ko limit kar sakte hain. Default target 100 + max 120 min isi liye hai.

## 🚨 Security — PEHLE YE KARO

**`.env` file live `BOT_TOKEN` ke saath is PUBLIC GitHub repo me commit ho
chuki thi.** Matlab token ab secret nahi raha — koi bhi use karke tumhara bot
hijack kar sakta hai, ya usi token se apni copy chala kar tumhare bot ko
**409 Conflict** par hamesha ke liye rok sakta hai ("bot work nahi kar raha"
ki ek wajah yahi ho sakti hai).

1. Telegram me **@BotFather** → `/mybots` → apna bot → **API Token →
   Revoke current token** → naya token milega.
2. Naya token **sirf** apni local `.env` me daalo (`BOT_TOKEN=...`).
3. `.env` ab `.gitignore` me hai — **ise dobara kabhi commit mat karna.**
   Purani git history me token ab bhi hai, isliye step 1 (revoke) hi asal
   fix hai — file delete karne se kaam nahi banega.

Aur: `vuvhbjbi` Firebase ke **rules open** hain — bina auth ke koi bhi isko
padh/sakta hai. Number pool + OTP inbox dono public hain. Rules lagwa lena
(ya kam se kam write band karwa lo) — warna koi bhi aapke OTP padh sakta hai.

## 🩺 Troubleshooting — "bot work nahi kar raha"

| Symptom | Wajah + tod |
|---|---|
| Bot start hi nahi hota, console `401` | BOT_TOKEN galat/revoke. @BotFather se naya token → `.env` |
| Console `409 Conflict` | Isi token se bot ki doosri copy chal rahi hai (purana terminal/server, ya leak hua token). Purani copy band karo; token revoke karke naya lo |
| `WAF solver OK`, phir OTP-send `SWIGGY_SECURITY_CHALLENGE`/403 | WAF token ready hona OTP endpoint ki permission nahi hai. Batch 3 consecutive 403 ke baad safety-stop karega; official Swiggy app/site verification ya existing session export use karo. WAF/verification bypass karne ke liye proxies rotate na karo |
| `/start` par "Sirf owner ke liye" | Tumhari Telegram ID allow nahi. Message me dikhi ID `.env` ke `OWNER_IDS=` me daalo, restart karo |
| Batch chala lekin `pool-exhausted`/0 numbers | Card ki **🔥 Firebase** + **Pool** lines dekho: kitne ACTIVE sources check hue aur current source par kitne valid numbers mile. Ek source khali/error ho to baaki ACTIVE sources auto-try hote hain; sab par 0 aaye to `clients/` paths/data check karo. Bekaar/deactivated DB ko pool se hatana ho to use **Delete** karo — disable option ab nahi hai; Delete ki hui URL dobara seed nahi hoti. 2 fail ke baad DB khud 30 min quarantine me chala jata hai, isliye 400+ list me bhi zinda DBs pehle try hote hain. Free Render par list gayab na ho iske liye `FIREBASE_DB_URLS` env (ya vault token) rakho. `/diag` first-try source ka test dikhata hai |
| OTP hi nahi aata (`failed_otp_miss`) | Device offline hai ya SMS forwarder band. Online devices wala pool use karo (⚙️ Settings → 📴 Offline OFF rakho jab tak pakka na ho) |
| Bot beech me chup-chaap band ho jata tha | Fix ho gaya — ab handler errors par bot nahi marta (`bot.catch` + guards). Phir bhi band ho to console ka aakhri error dekho |
| `Chrome ❌ nahi mila` (server/Render par) | Free cloud par Chrome hota hi nahi. Local PC/VPS par chalao jahan Chrome ho, ya build me Chromium install karke `PUPPETEER_EXECUTABLE_PATH` do |

## Test

```bash
npm test    # unit checks (koi network nahi — fetch mock hai)
```
