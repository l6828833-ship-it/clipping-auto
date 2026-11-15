# Deploy Clip Maker on Rundploy

The project root contains a Dockerfile that builds the Vite website and starts the Express API. The native iOS app can use the same HTTPS origin for YouTube imports.

1. In [Rundploy](https://rundploy.com/dashboard/apps), create a web app. Upload the deployment folder or connect a GitHub branch that contains this build. Use the root `Dockerfile` if the app settings offer Docker builds. The deployment needs a running Node service with FFmpeg and Python.
2. Set the service port to `3000` if prompted. The server also honors a platform-provided `PORT`. If a health check path is available, use `/health` (or `/`). Don't use `/healthz`: Cloud Run reserves it on the public URL and answers 404 there. Any other path gets a 404 from the app. The server opens its port before it touches the database, so a slow database doesn't fail the deploy.
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

Caption lines with Arabic in them read right to left, in the preview and in the export, even when they open on a French or English word. A short word such as ف, و, ما or ديال stays on the line of the word after it, and a stray ؟ or ! from the transcriber joins the word before it (`shared/captions.mjs`).

Arabic and Darija accuracy depends on the model. `scripts/whisper_words.py` picks it from the machine's memory: Darija always uses the Darija fine-tune; Arabic uses `large-v3-turbo` on 8 GiB or more (downloaded on first use, about 1.5 GB), else `small` (4 GiB) or `WHISPER_MODEL`. Override with `WHISPER_MODEL_ARABIC` or `WHISPER_MODEL_DARIJA` (`darija-finetune` selects the fine-tune). On a small instance, run the download worker on a Mac instead: it transcribes all Arabic sources locally on the Apple GPU.

When `INWORLD_API_KEY` is set, transcription uses the hosted Inworld speech API with word timings instead of local Whisper (`server/hosted-stt.mjs`). It tries `groq/whisper-large-v3`, then `inworld/inworld-stt-1`, and keeps the first that returns word timings; set `INWORLD_STT_MODEL` to force one, or `CLIP_MAKER_HOSTED_STT=0` to go back to local Whisper. If the API fails or returns no timings, local Whisper is used. The download worker then only delivers the audio and no longer runs Whisper.

Video styles (Normal, four single-speaker looks and four split-screen layouts) are stored per clip in a new nullable `clips.layout` column (migration `0003_clip_layout`, also added on start-up). The style is applied at render time (`server/montage.mjs`). The two footage styles use one of the user's own uploaded videos as the lower half; no footage ships with the app.

The Create wizard has four steps: Input (where the video style is chosen, or left to the AI), Highlights, Captions and Export. On Input, one Continue button reads the link, transcribes it and saves the video, with the progress shown; if no speech comes back it stops there with the reason, a Try again button and a way on to the manual clip picker. Highlights then runs by itself, and as soon as the AI answers, every suggested clip's part of the video is fetched in the background, best first (`videos.prefetch`), followed by the speaker framing that clip will be exported with. Going back to Highlights shows the same results without asking the AI again. A range that is already being fetched is shared rather than downloaded twice. On Captions, the preview plays the clip's own timed words, split into lines as the export splits them, and every setting changed there (design, size, colours, position, outline) applies at once and wins over the clip's video style, which used to override it (`own` in the saved caption style, see `shared/video-styles.mjs`). Export saves a clip for every selected highlight and renders them one after another; with the parts already fetched and framed it mostly encodes. Framing, cuts and per-clip styles can still be changed afterwards from the Clips page. Every file imported for a video is served to that video's owner, so a clip's part fetched in the background plays in the preview before the video row points at it.

The AI steps (highlights, titles) ask the Inworld router for `openai/gpt-4o-mini` unless `CLIP_MAKER_AI_MODEL` is set to another router id (`provider/model`, as listed on the Models page of the Inworld Portal). The model that answered is logged as `[Inworld] Highlights analysed by …`.

Dual Speaker is worked out shot by shot: a shot with two people on screen is split, one person per half; a shot with one person keeps the whole frame and follows them. The editor previews ask the server for that plan (`videos.previewFraming` with `style: "dual"`) and for which clip ranges are already imported (`videos.sections`), so moving between clips plays each from its own file instead of importing it again. Imported files live on the instance's disk: run a single instance, or another instance will not have them.

Speaker framing (`scripts/auto_frame.py`) cuts to whoever is talking when two people share a shot and are too far apart for one crop. It judges this from mouth movement, so it needs faces large enough to see; set `CLIP_MAKER_AUTO_REFRAME=0` to switch automatic framing off.

Clips are encoded with the x264 `veryfast` preset, which is several times quicker than `slow` on a small instance for a somewhat larger file; set `CLIP_MAKER_X264_PRESET` (`faster`, `medium`, `slow`, …) to trade speed for size. When a direct YouTube download of a clip stalls for 75 seconds and the download worker is connected, the worker fetches that part instead. The worker now fetches clip parts at 720p (whole videos stay at 480p); restart it after updating so it picks this up.

Run exactly one instance (minimum 1, maximum 1) with CPU always allocated. Imported videos and rendered clips are files on the instance's disk and renders run after the request has returned, so a second instance has neither the files nor the job. A running import or render stamps its row every half minute; one whose stamp is three minutes old is released as failed (checked at start-up and every two minutes), which replaces the old behaviour of failing every running job whenever any instance started. Download worker jobs live in the instance's memory too: a worker upload answered with a 404 (logged as "which this instance does not have") means the server restarted after handing the job out, or a second instance answered. A job's 15 minutes count from when the worker claims it, so a job that waited behind others no longer expires mid-download.

Two settings exist only for local testing: `INWORLD_BASE_URL` points the AI calls at a stand-in server, and `CLIP_MAKER_DB_POOL_MAX` caps the database pool for a test database that accepts one connection at a time. Leave both unset in production.

Jump cuts ("Tighten") are stored in a new nullable `clips.cuts` column (migration `0002_clip_cuts`). The server also adds it on start-up with `ADD COLUMN IF NOT EXISTS`, so a deploy works before `npm run db:migrate` has been run. AI reframing needs `onnxruntime` (in `scripts/requirements-whisper.txt`) and `assets/models/face-rfb-320.onnx`.

Rendered clips fetch their own source range at up to 1440p (`CLIP_MAKER_MAX_SECTION_HEIGHT`, set `2160` for 4K or `CLIP_MAKER_HQ_SECTIONS=0` to render from the 1080p import only). A 9:16 crop keeps a third of a 16:9 frame, so the extra resolution is what keeps exports sharp.

### YouTube blocks the server's downloads

If the logs show “Sign in to confirm you’re not a bot,” set `YTDLP_YOUTUBE_PROXY` as a Rundploy runtime secret to an HTTP CONNECT proxy you control and that can reach YouTube. Use `http://host:port` or `http://username:password@host:port`. Redeploy and try the same video again. The web app uses this connection for YouTube metadata, source audio, and video downloads. Whisper still runs in the app container.

If you have no proxy, run Clip Maker’s download worker on a Mac or another computer that can download from YouTube. It connects out to the website over HTTPS and sends back audio or a selected video range when YouTube blocks the hosting server. The worker supports transfers up to 28 MiB and uses the single-instance deployment described above.

1. Generate a random token with `openssl rand -hex 32` and save it in the app’s Rundploy environment settings as the runtime secret `CLIP_MAKER_YOUTUBE_WORKER_TOKEN`. Redeploy. Rundploy recreates the service configuration from its own settings, so save the token there for future deployments.
2. On the worker computer, set the same `CLIP_MAKER_YOUTUBE_WORKER_TOKEN` and `CLIP_MAKER_SERVICE_URL` to the website’s HTTPS origin in the local, ignored `.env` file. Install Node 22, FFmpeg, a current yt-dlp with its JavaScript components, and the Python dependencies in `scripts/requirements-whisper.txt`. The worker runs Whisper locally for Moroccan Darija requests and videos at least 10 minutes long. Run `python3 scripts/darija_whisper.py` to cache the model before its first use. Set `WHISPER_PYTHON`, `CLIP_MAKER_YTDLP`, and `CLIP_MAKER_FFMPEG` to the executable paths if they’re outside your PATH.
3. Run `npm run youtube:worker` from the project directory and leave it running while using the website.
