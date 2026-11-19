# 🌐 ZZBOT (Zepto Pro) — Vercel web signup

Toing Pro engine ka web version — browser par, Vercel par.

```
Number daalo → OTP (auto ya manual) → verify → Zepto session JSON download
```

| Step | zzbot API |
|---|---|
| 1. OTP bhejo | `POST /api/login/otp` `{ mobile }` |
| 2. OTP | Telegram OTP bot se auto, ya page par paste |
| 3. Verify | `POST /api/login/verify` `{ otp }` |
| 4. Session | `POST /api/accounts/{mobile}/export` |

Har call par `x-user-key` header jaata hai (access key).

## Deploy

Vercel Dashboard → New Project → repo `hulm0408/workwr` → **Root Directory: `zzbot-vercel`** → Deploy.

## Env (sab optional)

| Env | Kaam |
|---|---|
| `ZZBOT_ACCESS_KEY` | Access key (default `ZPT-BW9Z-PLMB-1H1W-9HSD`) |
| `ZZBOT_BASE_URL` | default `https://storelex.store/zzbot` |
| `APP_PASSWORD` | Page ka login password (default `rahul@123` — **badal lo**) |
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` / `TELEGRAM_SESSION` | Auto-OTP ke liye (wahi spare Telegram account jo bot use karta hai) |
| `OTP_BOT_USERNAME` | default `@HermeshuOTPROBOT` (ya `@Hathi_otp_bot`) |
| `TG_DELIVER_CHAT_ID` | Auto mode me session file yahan bhejo (optional) |

> Auto-OTP na ho to **manual mode** bilkul chalega — OTP bot me code dekho aur page par daal do.

## Local test

```
node api/index.js   # http://localhost:3739
```

## Note

- Session JSON = **live credential**. Public URL par password zaroor lagao.
- State per warm instance memory me hai (Gold Drop jaisa). Cold start par run reset ho jata hai — number/OTP dobara.
