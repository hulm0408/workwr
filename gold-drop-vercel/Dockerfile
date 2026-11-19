# 🟡 Gold Drop web — Docker entry (Vercel container project ke liye)
#
# Project `workwr` Vercel par container type ka hai, isliye usko Dockerfile
# chahiye. Yahan root directory `gold-drop-vercel` set hai — is file ka
# context wahi folder hai.
#
# Kyun image? Gold Drop ka security check sirf ASLI browser me clear hota hai
# (raw HTTP API par solved Turnstile token ke bawajood site 400 deti hai).
# Ye image Chrome deti hai, taaki browser-flow chal sake; aur build par hi
# image verify hoti hai — app "ERROR" deployment se purane build par nahi girti.
FROM node:22-bookworm-slim

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
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    CHROME_PATH=/usr/bin/google-chrome-stable \
    PORT=3000

WORKDIR /app

COPY package.json ./
COPY api ./api

# Build par hi verify — app chalta hai ya nahi, deploy se pehle pata chale.
RUN node -e "import('./api/index.js').then(m => { if (typeof m.default !== 'function') throw new Error('handler missing'); console.log('gold-drop handler OK') })"

EXPOSE 3000
CMD ["node", "api/index.js"]
