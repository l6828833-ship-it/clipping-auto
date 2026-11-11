FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg fonts-dejavu-core libgomp1 python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

COPY scripts/requirements-whisper.txt /tmp/requirements-whisper.txt
RUN python3 -m venv /opt/media-tools \
    && /opt/media-tools/bin/pip install --no-cache-dir \
        'yt-dlp[default,curl-cffi]==2026.10.26' -r /tmp/requirements-whisper.txt

ENV PATH="/opt/media-tools/bin:${PATH}"

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
