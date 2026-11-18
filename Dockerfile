FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg fonts-dejavu-core libgomp1 python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

COPY scripts/requirements-whisper.txt /tmp/requirements-whisper.txt
COPY scripts/darija_whisper.py /tmp/darija_whisper.py
COPY scripts/darija_int8.py /tmp/darija_int8.py
# Fetch the CPU-only PyTorch wheel from PyTorch. Resolve its dependencies on PyPI.
RUN python3 -m venv /opt/media-tools \
    && /opt/media-tools/bin/python -m pip install --no-cache-dir --index-url https://pypi.org/simple 'pip==26.3' \
    && /opt/media-tools/bin/python -m pip install --no-cache-dir --no-deps --only-binary=:all: \
        --index-url https://download.pytorch.org/whl/cpu 'torch==2.8.0+cpu' \
    && /opt/media-tools/bin/python -m pip install --no-cache-dir --index-url https://pypi.org/simple \
        'torch==2.8.0+cpu' 'yt-dlp[default,curl-cffi]==2026.10.26' -r /tmp/requirements-whisper.txt \
    && /opt/media-tools/bin/python -m pip check

ENV PATH="/opt/media-tools/bin:${PATH}" XDG_CACHE_HOME=/opt/clip-maker-cache CLIP_MAKER_WHISPER_CPU=int8
RUN python3 -c 'import whisper; whisper.load_model("base", device="cpu")' \
    && python3 -c 'from faster_whisper.utils import download_model; download_model("base")' \
    && python3 /tmp/darija_whisper.py \
    && python3 /tmp/darija_int8.py \
    && python3 -c 'from faster_whisper.utils import download_model; download_model("small")' \
    && python3 -c 'from faster_whisper.utils import download_model; download_model("large-v3-turbo")' \
    && chown -R node:node /opt/clip-maker-cache

# The default Darija model: Whisper large-v3-turbo with a Moroccan Darija
# adapter, merged and converted to INT8 here (about 820 MB kept) so no
# instance has to download and build it while a video waits.
COPY scripts/darija_turbo_int8.py /tmp/darija_turbo_int8.py
RUN HF_HUB_DISABLE_PROGRESS_BARS=1 python3 /tmp/darija_turbo_int8.py \
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

ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 CLIP_MAKER_HOSTED_STT=0 WHISPER_MODEL_ARABIC=large-v3-turbo
EXPOSE 3000
USER node
CMD ["node", "dist/index.js"]
