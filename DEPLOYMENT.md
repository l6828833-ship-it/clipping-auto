# Deploy Clip Maker on Rundploy

The project root contains a Dockerfile that builds the Vite website and starts the Express API. The native iOS app can use the same HTTPS origin for YouTube imports.

1. In [Rundploy](https://rundploy.com/dashboard/apps), create a web app. Upload the deployment folder or connect a GitHub branch that contains this build. Use the root `Dockerfile` if the app settings offer Docker builds. The deployment needs a running Node service with FFmpeg and Python.
2. Set the service port to `3000` if prompted. The server also honors a platform-provided `PORT`. If a health check path is available, use `/health` (or `/`). Don't use `/healthz`: Cloud Run reserves it on the public URL and answers 404 there. Any other path gets a 404 from the app. The server opens its port before it touches the database, so a slow database doesn't fail the deploy.
3. Add the following values as runtime environment secrets.

   | Name | Value |
   | --- | --- |
   | `DATABASE_URL` | The existing production PostgreSQL connection string. For Supabase on an IPv4-only host, use the Session pooler string from **Connect**. Keep the database tables private to the server. |
   | `CLIP_MAKER_DB_SCHEMA` | Optional. The app keeps its tables in the `clip_maker` schema by default and creates them at start-up if they are missing, because the production Supabase database (`zmlrtyzrwmhbydcidpku`) is shared with another app that owns `public.users`. Set it to `public` only for a database where Clip Maker's tables are in `public` (then run `npm run db:migrate`). |
   | `JWT_SECRET` | The existing production signing secret to keep sessions valid, or a new value from `openssl rand -hex 32` for a fresh installation. |
   | `OPENAI_API_KEY` | An OpenAI API key, for AI highlights, titles and hooks (and transcription if switched on). |
   | `OPENAI_MODEL` | The OpenAI model for those AI steps, such as `gpt-5-mini` (the default) or `gpt-5`. |

4. Start with one instance. The web app stores uploaded videos, generated clips, and reels on disk. Mount writable persistent storage at `/app/.data`, or set `CLIP_MAKER_DATA_DIR` to the writable mount path supplied by the host. Confirm that files survive a redeploy before moving real users. When moving an existing site, copy its media volume as well as reusing the database.
5. For a fresh database, run `npm run db:migrate` once with `DATABASE_URL` set before creating web accounts. For an existing deployment, check its Drizzle migration history before running migrations.
6. Open the assigned HTTPS URL and test web sign-in, video import, and clip export. Then set the Xcode target’s `CLIP_MAKER_SERVICE_URL` to that HTTPS origin. The iOS YouTube flow does not require a Clip Maker account.

### Sign-in with Google or an email link

Users can sign in with Google or request a link by email. Supabase Auth project `zmlrtyzrwmhbydcidpku` handles sign-in. Clip Maker accounts and media records use the existing `DATABASE_URL`.

1. **Runtime variables** (already set if email links are being sent). Use the **Publishable key** from Supabase and keep the existing `JWT_SECRET`.

   | Variable | Value |
   | --- | --- |
   | `CLIP_MAKER_AUTH_SUPABASE_URL` | `https://zmlrtyzrwmhbydcidpku.supabase.co` |
   | `CLIP_MAKER_AUTH_SUPABASE_KEY` | The project's `sb_publishable_…` key |
   | `CLIP_MAKER_AUTH_SITE_URL` | `https://clip-maker.com` |

2. In **Supabase Auth → URL Configuration**, set the site URL to `https://clip-maker.com`. Allow `https://clip-maker.com/api/auth/email/confirm` and `https://clip-maker.com/api/auth/google/callback`. Enable Google under **Sign In / Providers** with the Clip Maker web OAuth client. [Supabase Google setup](https://supabase.com/docs/guides/auth/social-sign-in/auth-google)

3. **Send from clip-maker.com.** Without a custom SMTP server Supabase sends from `noreply@mail.app.supabase.io`, only a few emails an hour. In Supabase Auth → Emails → SMTP Settings, enable custom SMTP. With Cloudflare Email Service (the domain must use Cloudflare DNS, and sending to any recipient needs the Workers Paid plan):

   | Setting | Value |
   | --- | --- |
   | Sender email | `login@clip-maker.com` |
   | Sender name | `Clip Maker` |
   | Host | `smtp.mx.cloudflare.net` |
   | Port | `465` |
   | Username | `api_token` |
   | Password | A Cloudflare API token with the **Email Sending: Edit** permission |

   First onboard the domain in the Cloudflare dashboard under Compute → Email Service → Email Sending → Onboard Domain; Cloudflare adds the SPF, DKIM and DMARC records itself. [Cloudflare SMTP reference](https://developers.cloudflare.com/email-service/api/send-emails/smtp/). Any other SMTP provider works the same way with its own host and credentials. [Supabase SMTP setup](https://supabase.com/docs/guides/auth/auth-smtp)

4. **Make the link work in any browser.** In Supabase Auth → Emails → Templates, set the link in both the **Confirm signup** and the **Magic Link** template to:

   ```
   {{ .SiteURL }}/api/auth/email/confirm?token_hash={{ .TokenHash }}&type=email
   ```

   With Supabase's default `{{ .ConfirmationURL }}` the link still works, but only in the browser that asked for it.

5. Test with an inbox outside the Supabase team. Existing users should use the email already on their Clip Maker account to keep their projects.

### Cloudflare R2 media storage

The private R2 bucket `clip-maker-media` already exists in the Cloudflare account. Create an **Object Read & Write** API token scoped to that bucket (R2 → Manage API tokens); it gives the access key ID and secret. Set these runtime variables in the app's deployment settings. Keep the access key and secret on the server.

| Variable | Value |
| --- | --- |
| `CLIP_MAKER_S3_ENDPOINT` | The S3 endpoint from the R2 dashboard, such as `https://<account-id>.r2.cloudflarestorage.com` |
| `CLIP_MAKER_S3_BUCKET` | `clip-maker-media` |
| `CLIP_MAKER_S3_REGION` | `auto` |
| `CLIP_MAKER_S3_ACCESS_KEY_ID` | The R2 token's access key ID |
| `CLIP_MAKER_S3_SECRET_ACCESS_KEY` | The R2 token's secret access key |

Clip Maker saves new imports and exports to the bucket. After checking ownership, it gives the browser a temporary link for playback or download. Re-render an older export if its server copy was lost before R2 was connected. See the [Cloudflare R2 token instructions](https://developers.cloudflare.com/r2/api/tokens/).

The image includes OpenAI Whisper and its multilingual `base` model. When a source has no usable captions, the server downloads its audio and transcribes it on the CPU. Moroccan Darija (chosen, or found by auto-detect from Darija-only words in a short sample) uses the open-source `darija-turbo` model: Whisper `large-v3-turbo` with the MIT-licensed `anaszil/whisper-large-v3-turbo-darija` adapter merged in. `scripts/darija_turbo_int8.py` downloads both at pinned, checksummed revisions, merges them and converts them to INT8 during the Docker build (about 820 MB kept); no paid speech API is required. It ran at about real time on 4 threads; Whisper now uses every CPU the container is given (up to 8; `WHISPER_THREADS` overrides). General Arabic settings do not override the Darija model. The Docker image also defaults other Arabic speech to `large-v3-turbo`; an explicit `WHISPER_MODEL_ARABIC` environment override still takes precedence for non-Darija sources. Allocate 4 GiB for server-side Darija transcription and allow background analysis to finish before stopping the instance. The OpenAI key is used for AI highlights.

Caption lines with Arabic in them read right to left, in the preview and in the export, even when they open on a French or English word. A short word such as ف, و, ما or ديال stays on the line of the word after it, and a stray ؟ or ! from the transcriber joins the word before it (`shared/captions.mjs`).

Arabic and Darija accuracy depends on the model. `scripts/whisper_words.py` picks it from the machine's memory: Darija defaults to `darija-turbo` (set `WHISPER_MODEL_DARIJA=darija-finetune` for the small Darija model: about 3x faster, far less accurate on real conversation); other Arabic uses `large-v3-turbo` on 8 GiB or more (downloaded on first use, about 1.5 GB), else `small` (4 GiB) or `WHISPER_MODEL`. Override with `WHISPER_MODEL_ARABIC` or `WHISPER_MODEL_DARIJA` (`darija-finetune` selects the fine-tune). When the download worker is connected, a selected part of a YouTube video is fetched and transcribed on the worker's computer: it downloads the whole low-bitrate audio track (6.5 hours took under 30 seconds), cuts the part, runs Whisper there and sends back the timed words, while the 360p video for frames follows as a second job. On an M3 Mac, `darija-turbo` took 49 s for 2 minutes of audio, against about real time on the server's 4 vCPUs. Set `CLIP_MAKER_WORKER_TRANSCRIBE=0` on the server to have the worker send audio only; it also sends audio when `CLIP_MAKER_TRANSCRIBE=openai` is set, or when Whisper fails on the worker. Whole-video imports are still transcribed on the server. The worker sends a sign of life every 30 seconds, so a long download no longer trips the 10-minute stall limit. On a Mac (local development), the CTranslate2 models run on the Apple GPU (Metal), since CTranslate2 has no fast INT8 path for Apple CPUs: `darija-turbo` took 40 s per 30 seconds of audio there in INT8 and about 3 s on the GPU.

How the audio is cut matters as much as the model. Speech is found with Silero VAD at a 0.25 threshold (`WHISPER_VAD_THRESHOLD`); its usual 0.5 dropped telephone-quality speech and speech under music. Speech is packed into pieces of up to 28 seconds across pauses shorter than 3 seconds (`WHISPER_CHUNK_GAP`), since every piece costs a full 30-second pass however short it is; long speech is cut at its quietest moment. A piece that comes back with far fewer words than its speech holds (the decoder looped and lost the rest) is read again in shorter parts. On 16 minutes of Moroccan radio speech from the ALAMA dataset (three human reference transcripts per clip), these changes took `darija-turbo` from 41.1% to 34.9% word error rate (character error rate 20.6% to 15.7%) with 50 pieces instead of 77.

Transcription runs on the server with local Whisper by default. For speed and better Arabic, set `CLIP_MAKER_TRANSCRIBE=openai` (with `OPENAI_API_KEY`). Each speech piece (up to 28 seconds) then goes to OpenAI's `gpt-transcribe`, six at a time, with the video's title and channel as keywords so names are spelled the same way, and a short Darija prompt for Darija. That model gives no word timings, so the server places the returned words on the audio with the small local Whisper `base` model (forced alignment, one quick pass per piece; on Darija test clips it timed words within 0.02 s of the large Darija model). An hour of audio costs about $0.27 ($0.0045 a minute). The local work is one `base` pass per piece instead of a full `darija-turbo` decode. `OPENAI_TRANSCRIBE_MODEL=whisper-1` keeps the older path, where the API returns word timings itself (OpenAI retires `whisper-1` on 26 February 2027). If the API refuses (bad key, no credit, rate limit) or is unreachable, local Whisper is used, and after a refusal the API is not tried again for five minutes (`server/hosted-stt.mjs`, `scripts/hosted_transcribe.py`).

Video styles (Normal, four single-speaker looks and four split-screen layouts) are stored per clip in a new nullable `clips.layout` column (migration `0003_clip_layout`, also added on start-up). The style is applied at render time (`server/montage.mjs`). The two footage styles use one of the user's own uploaded videos as the lower half; no footage ships with the app.

The Create wizard has four steps: Input (where the video style is chosen, or left to the AI), Highlights, Captions and Export. On Input, one Continue button reads the link, transcribes it and saves the video, with the progress shown; if no speech comes back it stops there with the reason, a Try again button and a way on to the manual clip picker. Highlights then runs by itself, and as soon as the AI answers, every suggested clip's part of the video is fetched in the background, best first (`videos.prefetch`), followed by the speaker framing that clip will be exported with. Going back to Highlights shows the same results without asking the AI again. A range that is already being fetched is shared rather than downloaded twice. On Captions, the preview plays the clip's own timed words, split into lines as the export splits them, two sliders place the caption exactly (its centre, in percent of the frame, the same numbers the export uses), and every setting changed there (design, size, colours, position, outline) applies at once and wins over the clip's video style, which used to override it (`own` in the saved caption style, see `shared/video-styles.mjs`). Export saves a clip for every selected highlight and renders them one after another; with the parts already fetched and framed it mostly encodes. Framing, cuts and per-clip styles can still be changed afterwards from the Clips page. Every file imported for a video is served to that video's owner, so a clip's part fetched in the background plays in the preview before the video row points at it.

The AI steps (highlights, titles, hooks) call the OpenAI API directly with the model in `OPENAI_MODEL` (default `gpt-5-mini`; `CLIP_MAKER_AI_MODEL` is still read if `OPENAI_MODEL` is unset, without any `openai/` prefix). Settings a model refuses, such as a temperature on reasoning models, are dropped automatically. If a reasoning model returns no text because its thinking used the whole allowance, it is asked again with four times the room. Set `OPENAI_REASONING_EFFORT` (`low`, `medium`, `high`) to tune reasoning models. The model that answered is logged as `[AI] Highlights analysed by …`.

Dual Speaker is worked out shot by shot: a shot with two people on screen is split, one person per half; a shot with one person keeps the whole frame and follows them. The editor previews ask the server for that plan (`videos.previewFraming` with `style: "dual"`) and for which clip ranges are already imported (`videos.sections`), so moving between clips plays each from its own file instead of importing it again. Imported files live on the instance's disk: run a single instance, or another instance will not have them.

Speaker framing (`scripts/auto_frame.py`) cuts to whoever is talking when two people share a shot and are too far apart for one crop. It judges this from mouth movement, so it needs faces large enough to see; set `CLIP_MAKER_AUTO_REFRAME=0` to switch automatic framing off.

Clips are encoded with the x264 `veryfast` preset, which is several times quicker than `slow` on a small instance for a somewhat larger file; set `CLIP_MAKER_X264_PRESET` (`faster`, `medium`, `slow`, …) to trade speed for size. When a direct YouTube download of a clip stalls for 75 seconds and the download worker is connected, the worker fetches that part instead. The worker now fetches clip parts at 720p (whole videos stay at 480p); restart it after updating so it picks this up. A selected analysis range longer than two minutes is fetched as the whole 360p video and cut on the Mac: yt-dlp's section download goes through ffmpeg at about twice playback speed, so the first 15 minutes of a video never finished inside the 3-minute limit (the whole 86-minute video took 59 seconds, and the cut 18). A timed-out download now also stops the ffmpeg it started.

Run exactly one instance (minimum 1, maximum 1) with CPU always allocated. Imported videos and rendered clips are files on the instance's disk and renders run after the request has returned, so a second instance has neither the files nor the job. A running import or render stamps its row every half minute; one whose stamp is three minutes old is released as failed (checked at start-up and every two minutes), which replaces the old behaviour of failing every running job whenever any instance started. Download worker jobs live in the instance's memory too: a worker upload answered with a 404 (logged as "which this instance does not have") means the server restarted after handing the job out, or a second instance answered. A job's 15 minutes count from when the worker claims it, so a job that waited behind others no longer expires mid-download.

Two settings exist only for local testing: `OPENAI_BASE_URL` points the AI and transcription calls at a stand-in server, and `CLIP_MAKER_DB_POOL_MAX` caps the database pool for a test database that accepts one connection at a time. Leave both unset in production.

Jump cuts ("Tighten") are stored in a new nullable `clips.cuts` column (migration `0002_clip_cuts`). The server also adds it on start-up with `ADD COLUMN IF NOT EXISTS`, so a deploy works before `npm run db:migrate` has been run. AI reframing needs `onnxruntime` (in `scripts/requirements-whisper.txt`) and `assets/models/face-rfb-320.onnx`.

Rendered clips fetch their own source range at up to 1440p (`CLIP_MAKER_MAX_SECTION_HEIGHT`, set `2160` for 4K or `CLIP_MAKER_HQ_SECTIONS=0` to render from the 1080p import only). A 9:16 crop keeps a third of a 16:9 frame, so the extra resolution is what keeps exports sharp.

### YouTube blocks the server's downloads

If the logs show “Sign in to confirm you’re not a bot,” set `YTDLP_YOUTUBE_PROXY` as a Rundploy runtime secret to an HTTP CONNECT proxy you control and that can reach YouTube. Use `http://host:port` or `http://username:password@host:port`. Redeploy and try the same video again. The web app uses this connection for YouTube metadata, source audio, and video downloads. Whisper still runs in the app container.

If you have no proxy, run Clip Maker’s download worker on a Mac or another computer that can download from YouTube. It connects out to the website over HTTPS and sends back audio or a selected video range when YouTube blocks the hosting server. The worker supports transfers up to 28 MiB and uses the single-instance deployment described above.

1. Generate a random token with `openssl rand -hex 32` and save it in the app’s Rundploy environment settings as the runtime secret `CLIP_MAKER_YOUTUBE_WORKER_TOKEN`. Redeploy. Rundploy recreates the service configuration from its own settings, so save the token there for future deployments.
2. On the worker computer, set the same `CLIP_MAKER_YOUTUBE_WORKER_TOKEN` and `CLIP_MAKER_SERVICE_URL` to the website’s HTTPS origin in the local, ignored `.env` file. Install Node 22, FFmpeg, a current yt-dlp with its JavaScript components, and the Python dependencies in `scripts/requirements-whisper.txt`. The worker runs Whisper locally for selected parts of YouTube videos (see above). Run `python3 scripts/darija_turbo_int8.py` to build the default Darija model before its first use. Set `WHISPER_PYTHON`, `CLIP_MAKER_YTDLP`, and `CLIP_MAKER_FFMPEG` to the executable paths if they’re outside your PATH.
3. Run `npm run youtube:worker` from the project directory and leave it running while using the website.

### Visual and mixed-content highlights

The Create flow can analyse a saved video without a transcript. It combines timestamped frames, speech, replay peaks when available, and local sound-energy measurements. It asks for alternate candidates and verifies visual candidates with denser frame sequences. Speech candidates need spoken words in their interval; visual candidates keep their own event timing. Users can choose Auto, Interview, Football/Sport, Music/Performance, Comedy or Mixed.

This uses the existing `OPENAI_API_KEY` and an image-capable `OPENAI_MODEL` (the default `gpt-5-mini`). Frames are sent to that API; speech transcription stays local unless `CLIP_MAKER_TRANSCRIBE=openai` is explicitly configured. For local-only speech, leave that variable unset or set it to `local`. No Inworld speech API is used.

A 360p analysis copy may need downloading before the model can inspect frames. It is separate from the render-quality cache. If preparing it takes over a minute, the current request falls back to speech with a visible notice; retry can reuse the completed import. Model calls share a 270-second budget below the current 300-second request timeout. Uploaded originals avoid YouTube download failures.

Limits: sampled frames may miss brief goals or jokes. Loudness is not beat, chorus or music understanding. Visual analysis does not listen to the audio. Darija/code-switching ASR still makes mistakes, particularly with noise, overlapping voices and music; preview captions and clips before exporting. Do not promise a fixed number of highlights when evidence is insufficient.

Validation: `node --test tests/media-evidence.test.mjs`; `python3 tests/whisper_quality_test.py` with Python 3.10+; `npm run build`. The 50-second sample around 6:03 of `XTcpkSnhZW0` was exercised locally. The new mixed-language configuration preserved its English passage; no human-verified Darija reference transcript was available. Full-video local evidence extraction produced 56 frames in about 13 seconds after download. Production AI selection and Linux INT8 runtime quality still need deployment validation.
