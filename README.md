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

## Setup (2 minute)

```bash
cd E:\MyMedia\swiggy-fresh-bot
npm install          # pehli baar (already done — 43 packages)
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
   chhota wait + usi number par dobara. **4 lagatar challenges** par hi
   rukta hai (IP flagged ho to).
4. **WAF cooldown** (circuit-breaker) active ho to request bheji hi nahi
   jaati — cooldown khatam hote hi khud aage badhta hai.

## 🔀 Proxies — "rukna hi na pare" ka asli tod (IP rotation)

**Asli problem:** Swiggy ka WAF/rate-limit **IP ko** block karta hai, number
ko nahi. Ek IP par lagatar request = flagged IP = 403 = wait.

**tod:** multiple proxies (nayi-nayi IPs). 🔀 **⚙️ Settings → 🔀 Proxies** se
jitne chahein add karo (ek saath comma me bhi):

- `host:port` · `http://user:pass@host:port` · `socks5://host:port`
- Add karte hi **rotation ON**. Bot round-robin me IPs ghoomta hai.
- **WAF/rate-limit hit = TURANT doosri proxy (ZERO wait)** — number defer
  karke aage badhta hai, baad me **isi run me** dobara try karta hai.
- **`aws-waf-token` IP-bound** hota hai → har proxy ka **apna token** +
  apna cooldown state (proxy-pool.js me per-proxy).
- Proxy ON ho to **browser (puppeteer) bhi usi IP se** chalta hai.

**Batch sirf 3 cheezon par rukta hai: STOP · target · time.** Baaki kuch bhi
ho (403, rate-limit, network fail) — rotate/defer karke chalta rehta hai.

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
| `PREMIUM_BATCH_GAP_MS` | 15000 | Do numbers ke beech gap |
| `PREMIUM_RATE_LIMIT_BACKOFF_MS` | 900000 | Rate-limit par rukna (15 min) |
| `PREMIUM_OTP_WAIT_MS` | 10000 | OTP se pehle 10s wait (user requirement) |
| `PREMIUM_OTP_TIMEOUT_MS` | 90000 | OTP inbox poll budget |
| `PREMIUM_ALLOW_OFFLINE_DEVICES` | — | `1` = offline devices bhi try |

## Timing expectation

~35–90 second per number (purane numbers me 3 OTP rounds lagte hain — login OTP, delete OTP, phir naya signup OTP). Isliye 100 numbers ≈ 60–120 min. Default target 100 + max 120 min isi liye hai.

## ⚠️ Security note

`vuvhbjbi` Firebase ke **rules open** hain — bina auth ke koi bhi isko padh/sakta hai. Number pool + OTP inbox dono public hain. Rules lagwa lena (ya kam se kam write band karwa lo) — warna koi bhi aapke OTP padh sakta hai.

## Test

```bash
npm test    # 59 unit checks (koi network nahi — fetch mock hai)
```
