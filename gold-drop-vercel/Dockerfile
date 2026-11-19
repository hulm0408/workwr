# 🟡 Gold Drop web — Docker entry (Vercel container project)
#
# Project `workwr` Vercel par container type ka hai; uska root directory
# `gold-drop-vercel` hai, isliye is folder me Dockerfile chahiye — warna har
# deploy `[BUILD_FAILED] Container service must specify an entrypoint` deta hai
# (aur purana build live reh jaata hai).
#
# Is image me Chrome + Python + SeleniumBase + Playwright hain, kyunki Gold
# Drop ka security check SIRF asli browser me clear hota hai. Raw HTTP API par
# solved Turnstile token ke bawajood site 400 deti rehti hai (PR #91 ka finding).
FROM node:22-bookworm-slim

# ── Chrome (browser flow + puppeteer ke liye) ──
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

# ── Gold Drop stealth stack (SeleniumBase CDP + Playwright) ──
# Playwright ko apna browser download nahi chahiye — wo isi image ke
# google-chrome-stable se CDP par judta hai. libatomic1 Playwright ke node
# driver ke liye zaroori hai (iske bina "libatomic.so.1" crash).
RUN set -eux; \
    apt-get -o Acquire::Retries=3 update; \
    apt-get install -y --no-install-recommends python3 python3-venv xvfb libatomic1; \
    rm -rf /var/lib/apt/lists/*; \
    python3 -m venv /opt/golddrop-venv; \
    /opt/golddrop-venv/bin/pip install --no-cache-dir --upgrade pip; \
    /opt/golddrop-venv/bin/pip install --no-cache-dir seleniumbase playwright; \
    /opt/golddrop-venv/bin/sbase get uc_driver || echo "uc_driver pehli run par download hoga"

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    CHROME_PATH=/usr/bin/google-chrome-stable \
    GOLD_DROP_PYTHON=/opt/golddrop-venv/bin/python \
    PORT=3000

WORKDIR /app

COPY package.json ./
# Mirror ke liye teleproto (spare account se OTP bot padhna). Bina iske
# /otp-mirror har baar "Cannot find package 'teleproto'" deta hai.
RUN npm install --omit=dev --no-audit --no-fund

COPY api ./api
COPY gold_drop_stealth.py ./gold_drop_stealth.py

# Build par hi verify — deploy se pehle pata chale ki app aur worker theek hain
RUN node -e "Promise.all([import('./api/index.js'), import('./api/_otp-mirror.js'), import('./api/_telegram-login.js')]).then(([h]) => { if (typeof h.default !== 'function') throw new Error('handler missing'); console.log('gold-drop handler + mirror + tg-login OK') })" \
    && /opt/golddrop-venv/bin/python -m py_compile gold_drop_stealth.py \
    && /opt/golddrop-venv/bin/python gold_drop_stealth.py --selftest

EXPOSE 3000
CMD ["node", "api/index.js"]
