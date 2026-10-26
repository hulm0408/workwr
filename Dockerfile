# ===== Swiggy Fresh Bot — Render (Docker) =====
# Kyun Docker? Render ke native Node environment me Chrome NAHI hota, aur
# bina Chrome ke WAF solver nahi chalta (har OTP par 403). Is image me
# google-chrome-stable pehle se install hai — bot use khud dhoondh lega.
FROM node:22-bookworm-slim

# Chrome install (puppeteer-core ke liye browser system se chahiye).
# Google ke official current .deb ko seedha install karo — alag APT repo +
# signing-key wala route key rotation par NO_PUBKEY dekar poora Render
# build gira sakta hai. Download me retries bhi rakhe hain taaki ek
# temporary network jhatka deploy na rok de.
RUN set -eux; \
    apt-get -o Acquire::Retries=3 update; \
    apt-get install -y --no-install-recommends wget ca-certificates fonts-liberation; \
    wget --tries=5 --waitretry=5 --timeout=30 \
      -O /tmp/google-chrome-stable.deb \
      https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb; \
    apt-get install -y --no-install-recommends /tmp/google-chrome-stable.deb; \
    rm -f /tmp/google-chrome-stable.deb; \
    rm -rf /var/lib/apt/lists/*; \
    google-chrome-stable --version

ENV NODE_ENV=production \
    HEADLESS=1 \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

WORKDIR /app

# Pehle sirf package files (layer cache — code badle par npm dobara na chale)
COPY package.json package-lock.json ./
# Registry ke temporary network jhatke par npm khud kuch dafa retry kare;
# lockfile phir bhi exact wahi rahegi (npm ci kabhi versions nahi badalta).
RUN npm ci --omit=dev \
      --fetch-retries=5 \
      --fetch-retry-mintimeout=20000 \
      --fetch-retry-maxtimeout=120000 \
      --fetch-timeout=300000

COPY . .

# data/ = bot ka db (settings/accounts). Render par persistent disk yahin
# mount hoga (render.yaml dekho) — bina disk ke ye folder har deploy par
# fresh hoga aur accounts cloud vault se wapas aayenge (hydrate).
RUN mkdir -p /app/data

CMD ["node", "fresh-bot.js"]
