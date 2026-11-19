# 🌐 Service Hub — pehle card, phir spare, phir bot, phir START

Ek hi web page. Kholte hi **service card** dikhta hai — phir spare account,
phir OTP bot, phir process.

```
1️⃣ SERVICE          2️⃣ SPARE             3️⃣ BOT              4️⃣ START
🟡 Gold Drop   →  Spare #1 (✅)     →  📨 Hermes       →  number → OTP → reward
🌐 Toing Pro      Spare #2 (⚙️)        🐘 Hathi             number → OTP → session JSON
🟣 ZZBOT Zepto    Spare #3 (⚙️)        🔐 HardXotp          number → OTP → session JSON
🧩 Custom                                                 apne endpoints
```

## Services

| Card | Kya hota hai | Backend |
|---|---|---|
| 🟡 **Gold Drop** | register → security (NoCaptchaAI) → OTP → reward | `api/_gold-drop-core.js` |
| 🌐 **Toing Pro** | `send_otp` → OTP → `verify_otp` → export | `storelex.store/toing_web` |
| 🟣 **ZZBOT (Zepto)** | `login/otp` → OTP → `login/verify` → export | `storelex.store/zzbot` |
| 🧩 **Custom** | apni site ke send/verify endpoints | aapke URL |

## Deploy

Vercel → New Project → repo `hulm0408/workwr` → **Root Directory: `bot-hub-vercel`** → Deploy.

## Env

| Env | Kaam |
|---|---|
| `APP_PASSWORD` | page password (default `rahul@123` — **badal lo**) |
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` | spare account ka API login |
| `TELEGRAM_SESSION` | **Spare #1** (spare #2 = `TELEGRAM_SESSION_2`, … `_9`) |
| `OTP_BOT_USERNAME` | custom bot ka username (optional) |
| `ZZBOT_ACCESS_KEY` / `TOING_ACCESS_KEY` | access keys (defaults code me) |
| `NOCAP_API_KEY` | Gold Drop security solve (default built-in) |

## 🛡️ Gold Drop ka security check (captcha) — 1 click me test

Page par **🛡️ Captcha test** button hai. Ye do cheezein batata hai:

1. **Key chalu hai ya nahi** — asli `TurnstileTaskProxyLess` task bhejkar.
2. **Siteki key mil rahi hai ya nahi** — site ke HTML/JS bundle se.

> ⚠️ **Sabse badi galti:** NoCaptchaAI ka **Turnstile subscription plan me NAHI
> aata**. Ye alag pay-as-you-go wallet se **$0.0005 per solve** katta hai.
> "Recharge" karke bhi fail ho raha ho to `nocaptchaai.com/manage/billing` →
> **wallet** top-up karo (subscription nahi). Fail par charge nahi lagta.

Error ka matlab (ab UI me seedha Hinglish me dikhta hai, pehle chhup jata tha):

| Code | Matlab |
|---|---|
| `ERROR_ZERO_BALANCE` / `INSUFFICIENT` | wallet khaali — top-up karo |
| `ERROR_KEY_DOES_NOT_EXIST` / `ERROR_BAD_KEY` | key invalid — dobara copy |
| `ERROR_NO_SLOT_AVAILABLE` | NoCaptchaAI busy — 5-10s baad retry |

Solve ka timeout **120s** hai (pehle 45–50s tha, jisme asli solve aksar cut ho
jata tha). Env override: `NOCAP_API_BASE` (sirf test/mock ke liye),
`NOCAP_API_KEY` (key), `NOCAP_TIMEOUT_MS` (default 120000).

## OTP ke do raste

- **Manual** (default): OTP bot me code dekho → page par daalo. Har jagah chalta hai.
- **🤖 Auto**: spare account (MTProto) OTP bot se code khud uthata hai — 45s tak
  wait karta hai. Iske liye spare + `TELEGRAM_*` env chahiye.

## Banner (optional)

`public/gold.jpg`, `public/toing.jpg`, `public/zzbot.jpg`, `public/custom.jpg`
daal do to card par dikhenge. Na ho to gradient + emoji fallback.

## Local test

```
node api/index.js    # http://localhost:3741
```

## Note

- Session JSON = **live credential** — public URL par password zaroor lagao.
- State warm instance ki memory me hai (Gold Drop jaisa model).
