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

The image includes OpenAI Whisper and its multilingual `base` model. When a source has no usable captions, the server downloads its audio and transcribes it on the CPU. Allow the app to finish background analysis before stopping the instance. The Inworld key is used for AI highlights. Whisper transcription runs with the model installed in the container.

### YouTube blocks the server's downloads

If the logs show “Sign in to confirm you’re not a bot,” set `YTDLP_YOUTUBE_PROXY` as a Rundploy runtime secret to an HTTP CONNECT proxy you control and that can reach YouTube. Use `http://host:port` or `http://username:password@host:port`. Redeploy and try the same video again. The web app uses this connection for YouTube metadata, source audio, and video downloads. Whisper still runs in the app container.

If you have no proxy, run Clip Maker’s download worker on a Mac or another computer that can download from YouTube. It connects out to the website over HTTPS and sends back audio or a selected video range when YouTube blocks the hosting server. The worker supports transfers up to 28 MiB and uses the single-instance deployment described above. Allocate 2 GiB of memory for Whisper when processing longer videos.

1. Generate a random token with `openssl rand -hex 32` and save it in the app’s Rundploy environment settings as the runtime secret `CLIP_MAKER_YOUTUBE_WORKER_TOKEN`. Redeploy. Rundploy recreates the service configuration from its own settings, so save the token there for future deployments.
2. On the worker computer, set the same `CLIP_MAKER_YOUTUBE_WORKER_TOKEN` and `CLIP_MAKER_SERVICE_URL` to the website’s HTTPS origin in the local, ignored `.env` file. Install Node 22, FFmpeg, a current yt-dlp with its JavaScript components, and the Python dependencies in `scripts/requirements-whisper.txt`. The worker runs Whisper locally for videos at least 10 minutes long. Set `WHISPER_PYTHON`, `CLIP_MAKER_YTDLP`, and `CLIP_MAKER_FFMPEG` to the executable paths if they’re outside your PATH.
3. Run `npm run youtube:worker` from the project directory and leave it running while using the website.
