# ===== Swiggy Fresh Bot — Render (Docker) =====
# Kyun Docker? Render ke native Node environment me Chrome NAHI hota, aur
# bina Chrome ke WAF solver nahi chalta (har OTP par 403). Is image me
# google-chrome-stable pehle se install hai — bot use khud dhoondh lega.
FROM node:22-bookworm-slim

# Chrome install (puppeteer-core ke liye browser system se chahiye)
RUN apt-get update \
  && apt-get install -y --no-install-recommends wget gnupg ca-certificates fonts-liberation \
  && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-linux.gpg \
  && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-linux.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends google-chrome-stable \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    HEADLESS=1 \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

WORKDIR /app

# Pehle sirf package files (layer cache — code badle par npm dobara na chale)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# data/ = bot ka db (settings/accounts). Render par persistent disk yahin
# mount hoga (render.yaml dekho) — bina disk ke ye folder har deploy par
# fresh hoga aur accounts cloud vault se wapas aayenge (hydrate).
RUN mkdir -p /app/data

CMD ["node", "fresh-bot.js"]
