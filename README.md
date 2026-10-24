# 🆕 Swiggy Fresh Bot

**Ek START dabao — phone chhod ke aa jao.** Bot khud:

1. Firebase **pool** (`clients/`) se number uthata hai — online devices pehle
2. Swiggy par OTP bhejta hai → **10 second wait** → usi Firebase ke **OTP inbox** (`messages/`) se code padh kar paste karta hai
3. Har number ko FRESH banata hai:
   - 🆕 **Naya number** → register + session JSON save
   - ♻️ **Purana number** → login → **Delete Account** flow → delete success par purge → **usi number se fresh registration**
   - ⚠️ **Delete block** (charges / active order / Swiggy Money / other) → **SKIP**, aage badhta hai
   - 🚦 **Rate limit** → auto backoff (15 min) · 🛡 **Security check** → band · ⏹ **STOP** → current number complete hoke rukta hai
4. Target (default **100 fresh sessions**) ya max time (default **120 min**) tak apne aap chalta rehta — **STATUS** live card par update hota rehta hai, aakhir me **summary** + latest sessions ki list.

> Numbers aur OTP **dono** isi ek Firebase (`vuvhbjbi-default-rtdb`) se aate hain — koi third/premium source NAHI.

## Zaroori cheezein (warna bot "work nahi karega")

| Cheez | Kyun |
|---|---|
| **Node.js 20+** ([nodejs.org](https://nodejs.org)) | isse purane Node par dependencies toot-ti hain. Check: `node --version` |
| **Google Chrome** (ya Chromium/Edge) installed | WAF token banane ke liye. `puppeteer-core` ke saath browser bundled **nahi** aata — bot system Chrome khud dhoondhta hai. Na mile to `.env` me `PUPPETEER_EXECUTABLE_PATH=<chrome.exe ka full path>` do |
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

## ⚙️ Settings — user ki azadi (env chhedni ki zaroorat nahi)

`/start` → **⚙️ Settings**:

- **🔥 Firebase Sources** — multiple Firebase DB add/remove/enable/disable/switch,
  sab bot UI se. Har add par **auto-verify** (reachable + top keys). Jo source
  **ACTIVE** hai, usi se numbers + OTP aate hain.
- **🎯 Target** — presets (10/50/100/200/500) ya custom number text me likho
- **⏱ Max time** — 15m se 480m tak
- **🚦 Gap** — do numbers ke beech 0s–60s
- **📴 Offline devices** — try karein ya na karein

Sab `data/db.json` me save hota hai — restart ke baad bhi yaad rehta hai.

## 🛡 WAF / Security challenge — "aaye hi na" ka tod

Jo 403 challenge pehle poora batch maar deta tha, ab uska tod:

1. **Batch start se pehle WAF token warm-up** — Chromium solver ek valid
   `aws-waf-token` laata hai (2h tak valid), phir **har OTP/verify/delete
   request** usi token ke saath jaati hai → WAF ko normal browser traffic
   dikhta hai, challenge hi nahi.
2. **Phir bhi challenge aaye** → bot **turant naya token** lekar **ek baar
   retry** karta hai (na ki hammering).
3. **Engine-level** — challenge aane par batch **nahi rukta**: token refresh +
   IP cool-down (ladder 30s→4m) + naya token + number defer karke aage. Sirf **12 lagatar challenges** (bina ek bhi request guzare) par batch rukta hai — ek request bhi paar ho gayi to ginti reset.
4. **WAF cooldown** (circuit-breaker) active ho to request bheji hi nahi
   jaati — cooldown khatam hote hi khud aage badhta hai.

## 🔀 Proxies — "rukna hi na pare" ka asli tod (IP rotation)

**Asli problem:** Swiggy ka WAF/rate-limit **IP ko** block karta hai, number
ko nahi. Ek IP par lagatar request = flagged IP = 403 = wait.

**tod:** multiple proxies (nayi-nayi IPs). 🔀 **⚙️ Settings → 🔀 Proxies** se
jitne chahein add karo (ek saath comma me bhi):

- `host:port` · `http://user:pass@host:port` · `socks5://host:port`
- **🌐 Free Proxies Lao (auto)** — proxy card se ek tap: bot kai public free
  lists (ProxyScrape API + uske GitHub shards, monosans, jetkai aur
  Proxifly-India) ko parallel fetch karke candidates merge karta hai, phir
  har proxy ko generic HTTPS ke baad **seedha Swiggy par test** karta hai.
  Clean proxies pehle aati hain; jo Swiggy tak pohanchti hai lekin WAF
  challenge deti hai use 🛡 fallback tier me rakha jata hai kyunki browser
  usi IP ka `aws-waf-token` solve kar sakta hai. Card par sources/candidates/
  checked/clean/challenged diagnostics bhi dikhte hain. Batch start par
  3 se kam enabled proxies hon to ye **khud bhi ho sakta hai** (OFF karna ho:
  proxy card par 🌐 Free Auto toggle, ya env `PREMIUM_AUTO_FREE_PROXIES=0`).
  Apni list URLs: `PREMIUM_PROXY_SOURCES=url1,url2` — ye baki sources ke
  saath merge hongi. Free proxies marne par refresh me khud replace ho jati
  hain; manual proxies ko haath nahi lagta. (Sach: free wali aksar slow/dead
  hoti hain — isliye health-check filter hai; best natija khud ki sticky
  proxies se hi milta hai.)
- Add karte hi **rotation ON**. Bot round-robin me IPs ghoomta hai.
- **WAF/rate-limit/temporary 5xx hit = TURANT doosri proxy** — number
  failed count kiye baghair defer karke aage badhta hai, baad me **isi run
  me** dobara try karta hai (per number max 2 temporary attempts). Lagatar
  3 temporary errors par 60s ka short cool-off lagta hai.
- **`aws-waf-token` IP-bound** hota hai → har proxy ka **apna token** +
  apna cooldown state (proxy-pool.js me per-proxy).
- Proxy ON ho to **browser (puppeteer) bhi usi IP se** chalta hai.

**Batch sirf 3 cheezon par rukta hai: STOP · target · time.** Baaki kuch bhi
ho (403, rate-limit, Swiggy/proxy 5xx, network fail) — rotate/defer karke
chalta rehta hai; temporary error par number failed nahi gina jata.

> ⚠️ Bina proxy = ek hi IP = rukne ka khatra. Proxy add karo, rukna band.

## Files

| File | Kaam |
|---|---|
| `fresh-bot.js` | Bot UI — START/STOP/STATUS/**SETTINGS** (entry point) |
| `autopilot-engine.js` | Batch loop — target/time/**proxy-rotate**/defer/live-card |
| `number-pipeline.js` | EK number ka poora lifecycle (saare scenarios) |
| `firebase-numbers.js` | Firebase reader — pool + OTP inbox + **dynamic source override** |
| `firebase-sources.js` | **Multiple Firebase sources** — add/switch/verify (db-backed) |
| `bot-settings.js` | **Batch knobs** — target/time/gap (UI se, validated + clamped) |
| `proxy-pool.js` | **Proxy pool** — IP rotation, per-proxy WAF token + cooldown |
| `swiggy-bridge.js` | Swiggy automation + **WAF token injection** + **proxy routing** |
| `store.js` + `vault-sync.js` | Session DB (`data/db.json`) + cloud vault |
| `test_fresh_unit.mjs` | Unit tests (mocked fetch) — `npm test` |
| `scratch/firebase-inspect.mjs` | Firebase ka live structure dump — `npm run inspect` |

## Env knobs (optional — defaults acche hain)

| Var | Default | Matlab |
|---|---|---|
| `PREMIUM_BATCH_TARGET` | 100 | Kitne fresh sessions tak chale |
| `PREMIUM_BATCH_MAX_MINUTES` | 120 | Max run time |
| `PREMIUM_BATCH_GAP_MS` | 6000 | Do numbers ke beech gap |
| `PREMIUM_RATE_LIMIT_BACKOFF_MS` | 900000 | Rate-limit par rukna (15 min) |
| `PREMIUM_OTP_WAIT_MS` | 3000 | OTP bhejne ke baad poll shuru karne se pehle chhota wait (snapshot purane codes se bachata hai, jaldi poll safe hai) |
| `PREMIUM_OTP_TIMEOUT_MS` | 90000 | OTP inbox poll budget |
| `PREMIUM_DEVICE_ACTIVE_WINDOW_MS` | 60000 | **Last-seen gate**: OTP sirf un devices par jin ki last activity (taaza forwarded message) is window ke andar ho — mare devices turant skip, OTP waste nahi. Sakht: `10000`, band: `0` |
| `PREMIUM_ALLOW_OFFLINE_DEVICES` | — | `1` = offline devices bhi try |

## Timing expectation

~35–90 second per number (purane numbers me 3 OTP rounds lagte hain — login OTP, delete OTP, phir naya signup OTP). Isliye 100 numbers ≈ 60–120 min. Default target 100 + max 120 min isi liye hai.

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
| Bot chalta hai, batch har number par `security_challenge`/403 | WAF token nahi ban raha — aksar **Chrome nahi mila**. `/diag` dekho; Chrome install karo ya `PUPPETEER_EXECUTABLE_PATH` do. Proxies add karne se bhi bachta hai |
| `/start` par "Sirf owner ke liye" | Tumhari Telegram ID allow nahi. Message me dikhi ID `.env` ke `OWNER_IDS=` me daalo, restart karo |
| Batch chala lekin `pool-exhausted`/0 numbers | Firebase `clients/` khali ya galat source active. `/diag` → Number pool line dekho; ⚙️ Settings → Firebase Sources check karo |
| OTP hi nahi aata (`failed_otp_miss`) | Device offline hai ya SMS forwarder band. Online devices wala pool use karo (⚙️ Settings → 📴 Offline OFF rakho jab tak pakka na ho) |
| Bot beech me chup-chaap band ho jata tha | Fix ho gaya — ab handler errors par bot nahi marta (`bot.catch` + guards). Phir bhi band ho to console ka aakhri error dekho |
| `Chrome ❌ nahi mila` (server/Render par) | Free cloud par Chrome hota hi nahi. Local PC/VPS par chalao jahan Chrome ho, ya build me Chromium install karke `PUPPETEER_EXECUTABLE_PATH` do |

## Test

```bash
npm test    # 126 unit checks (koi network nahi — fetch mock hai)
```
