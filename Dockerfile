FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg fonts-dejavu-core libgomp1 python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

COPY scripts/requirements-whisper.txt /tmp/requirements-whisper.txt
COPY scripts/darija_whisper.py /tmp/darija_whisper.py
# Fetch the CPU-only PyTorch wheel from PyTorch. Resolve its dependencies on PyPI.
RUN python3 -m venv /opt/media-tools \
    && /opt/media-tools/bin/python -m pip install --no-cache-dir --index-url https://pypi.org/simple 'pip==26.3' \
    && /opt/media-tools/bin/python -m pip install --no-cache-dir --no-deps --only-binary=:all: \
        --index-url https://download.pytorch.org/whl/cpu 'torch==2.8.0+cpu' \
    && /opt/media-tools/bin/python -m pip install --no-cache-dir --index-url https://pypi.org/simple \
        'torch==2.8.0+cpu' 'yt-dlp[default,curl-cffi]==2026.10.26' -r /tmp/requirements-whisper.txt \
    && /opt/media-tools/bin/python -m pip check

ENV PATH="/opt/media-tools/bin:${PATH}" XDG_CACHE_HOME=/opt/clip-maker-cache
RUN python3 -c 'import whisper; whisper.load_model("base", device="cpu")' \
    && python3 /tmp/darija_whisper.py \
    && chown -R node:node /opt/clip-maker-cache

COPY package.json package-lock.json ./
RUN npm ci --include=dev --legacy-peer-deps

COPY client ./client
COPY shared ./shared
COPY server ./server
COPY scripts ./scripts
COPY assets ./assets
COPY drizzle ./drizzle
COPY dist/index.js ./dist/index.js
COPY vite.config.ts tsconfig.json drizzle.config.ts ./

RUN npm run build && install -d -o node -g node /app/.data

ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
EXPOSE 3000
USER node
CMD ["node", "dist/index.js"]
