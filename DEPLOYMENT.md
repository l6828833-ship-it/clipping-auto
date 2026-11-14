# Deploy Clip Maker on Rundploy

The project root contains a Dockerfile that builds the Vite website and starts the Express API. The native iOS app can use the same HTTPS origin for YouTube imports.

1. In [Rundploy](https://rundploy.com/dashboard/apps), create a web app. Upload the deployment folder or connect a GitHub branch that contains this build. Use the root `Dockerfile` if the app settings offer Docker builds. The deployment needs a running Node service with FFmpeg and Python.
2. Set the service port to `3000` if prompted. The server also honors a platform-provided `PORT`. If a health check path is available, use `/healthz`.
3. Add the following values as runtime environment secrets.

   | Name | Value |
   | --- | --- |
   | `DATABASE_URL` | The existing production PostgreSQL connection string. For Supabase on an IPv4-only host, use the Session pooler string from **Connect**. Keep the database tables private to the server. |
   | `JWT_SECRET` | The existing production signing secret to keep sessions valid, or a new value from `openssl rand -hex 32` for a fresh installation. |
   | `INWORLD_API_KEY` | The existing server key for web AI highlights and other Inworld features. |

4. Start with one instance. The web app stores uploaded videos, generated clips, and reels on disk. Mount writable persistent storage at `/app/.data`, or set `CLIP_MAKER_DATA_DIR` to the writable mount path supplied by the host. Confirm that files survive a redeploy before moving real users. When moving an existing site, copy its media volume as well as reusing the database.
5. For a fresh database, run `npm run db:migrate` once with `DATABASE_URL` set before creating web accounts. For an existing deployment, check its Drizzle migration history before running migrations.
6. Open the assigned HTTPS URL and test web sign-in, video import, and clip export. Then set the Xcode target’s `CLIP_MAKER_SERVICE_URL` to that HTTPS origin. The iOS YouTube flow does not require a Clip Maker account.

Rundploy advertises GitHub and folder uploads. Docker builds and persistent volumes need to be confirmed in the app dashboard before publishing the full project.

The image includes OpenAI Whisper and its multilingual `base` model. When a source has no usable captions, the server downloads its audio and transcribes it on the CPU. Selecting Moroccan Darija uses a [Darija-trained Whisper model](https://huggingface.co/Anass-Srk/fine-tuned-whisper-small-darija) and timed words from the source audio. Allocate 4 GiB for server-side Darija transcription and allow background analysis to finish before stopping the instance. The Inworld key is used for AI highlights.

Arabic and Darija accuracy depends on the model. `scripts/whisper_words.py` picks it from the machine's memory: 8 GiB or more uses `large-v3-turbo` for Arabic and Darija (downloaded on first use, about 1.5 GB); less than that keeps the Darija fine-tune for Darija and uses `small` (4 GiB) or `WHISPER_MODEL` for Arabic. Override with `WHISPER_MODEL_ARABIC` or `WHISPER_MODEL_DARIJA` (`darija-finetune` selects the fine-tune). On a small instance, run the download worker on a Mac instead: it transcribes all Arabic sources locally on the Apple GPU.

Rendered clips fetch their own source range at up to 1440p (`CLIP_MAKER_MAX_SECTION_HEIGHT`, set `2160` for 4K or `CLIP_MAKER_HQ_SECTIONS=0` to render from the 1080p import only). A 9:16 crop keeps a third of a 16:9 frame, so the extra resolution is what keeps exports sharp.

### YouTube blocks the server's downloads

If the logs show “Sign in to confirm you’re not a bot,” set `YTDLP_YOUTUBE_PROXY` as a Rundploy runtime secret to an HTTP CONNECT proxy you control and that can reach YouTube. Use `http://host:port` or `http://username:password@host:port`. Redeploy and try the same video again. The web app uses this connection for YouTube metadata, source audio, and video downloads. Whisper still runs in the app container.

If you have no proxy, run Clip Maker’s download worker on a Mac or another computer that can download from YouTube. It connects out to the website over HTTPS and sends back audio or a selected video range when YouTube blocks the hosting server. The worker supports transfers up to 28 MiB and uses the single-instance deployment described above.

1. Generate a random token with `openssl rand -hex 32` and save it in the app’s Rundploy environment settings as the runtime secret `CLIP_MAKER_YOUTUBE_WORKER_TOKEN`. Redeploy. Rundploy recreates the service configuration from its own settings, so save the token there for future deployments.
2. On the worker computer, set the same `CLIP_MAKER_YOUTUBE_WORKER_TOKEN` and `CLIP_MAKER_SERVICE_URL` to the website’s HTTPS origin in the local, ignored `.env` file. Install Node 22, FFmpeg, a current yt-dlp with its JavaScript components, and the Python dependencies in `scripts/requirements-whisper.txt`. The worker runs Whisper locally for Moroccan Darija requests and videos at least 10 minutes long. Run `python3 scripts/darija_whisper.py` to cache the model before its first use. Set `WHISPER_PYTHON`, `CLIP_MAKER_YTDLP`, and `CLIP_MAKER_FFMPEG` to the executable paths if they’re outside your PATH.
3. Run `npm run youtube:worker` from the project directory and leave it running while using the website.
