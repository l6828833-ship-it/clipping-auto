# syntax=docker/dockerfile:1

# The repository contains a precompiled Express/tRPC server in dist/index.js.
# We only rebuild the Vite client so the deployed image contains the current UI.
FROM node:22-bookworm-slim AS frontend-build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps

COPY client ./client
COPY server ./server
COPY shared ./shared
COPY vite.config.ts tsconfig.json components.json ./
RUN npx vite build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=8080 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# FFmpeg and yt-dlp are required by the hosted-video, subtitle, and render paths.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      ffmpeg \
      python3 \
      python3-pip \
    && pip3 install --no-cache-dir --break-system-packages -U yt-dlp \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --legacy-peer-deps

# The backend is precompiled in the repository. Bring in the original bundle
# and replace the static frontend assets with the freshly built Vite output.
COPY dist/index.js ./dist/index.js
COPY --from=frontend-build /app/dist/public ./dist/public
COPY assets ./assets

RUN mkdir -p /app/.data/videos /app/.data/clips /app/.data/render \
    && chown -R node:node /app

USER node

EXPOSE 8080

CMD ["node", "dist/index.js"]
