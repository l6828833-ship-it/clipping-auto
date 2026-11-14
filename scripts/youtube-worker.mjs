import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { openAsBlob } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import "dotenv/config";

const origin = new URL(process.env.CLIP_MAKER_SERVICE_URL || "");
const token = process.env.CLIP_MAKER_YOUTUBE_WORKER_TOKEN?.trim();
const ytDlp = process.env.CLIP_MAKER_YTDLP || "yt-dlp";
const ffmpeg = process.env.CLIP_MAKER_FFMPEG || "ffmpeg";
const run = promisify(execFile);
const workerEnv = { ...process.env };
if (path.isAbsolute(ffmpeg)) workerEnv.PATH = `${path.dirname(ffmpeg)}${path.delimiter}${workerEnv.PATH || ""}`;
if (origin.protocol !== "https:" && !(origin.protocol === "http:" && origin.hostname === "127.0.0.1")) {
  throw new Error("CLIP_MAKER_SERVICE_URL must be an HTTPS URL.");
}
if (!token) throw new Error("Set CLIP_MAKER_YOUTUBE_WORKER_TOKEN before starting the worker.");

async function request(endpoint, options = {}) {
  return fetch(new URL(`/api/internal/youtube-worker/${endpoint}`, origin), {
    method: "POST", ...options,
    redirect: "error",
    headers: { Authorization: `Bearer ${token}`, ...options.headers },
    signal: AbortSignal.timeout(options.body ? 90_000 : 10_000),
  });
}

async function processJob({ id, videoId, kind, range, language, transcribe }) {
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[A-Za-z0-9_-]{11}$/.test(videoId) || !["audio", "video"].includes(kind)) return;
  const directory = await mkdtemp(path.join(tmpdir(), "clip-maker-worker-"));
  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const audio = kind === "audio";
    const section = !audio && range && Number.isFinite(range.start) && Number.isFinite(range.duration) && range.duration > 0;
    const format = audio ? "ba[ext=m4a]/ba/b" : "bv[height<=480][ext=mp4][vcodec^=avc1]+ba[ext=m4a]/b[height<=720][ext=mp4]/b";
    const ytArgs = [
      "--ignore-config", "--no-playlist", "--no-progress", "--socket-timeout", "15", "--retries", "1",
      "--js-runtimes", `node:${process.execPath}`, "--max-filesize", "350M", "--check-formats", "-f", format,
      ...(process.env.CLIP_MAKER_FFMPEG ? ["--ffmpeg-location", ffmpeg] : []),
      "--print", "after_move:%(.{title,duration,uploader,language,filepath})j",
    ];
    const download = (stem, extra = []) => run(ytDlp, [
      ...ytArgs, ...extra, "-o", path.join(directory, `${stem}.%(ext)s`), "--", url,
    ], { timeout: 180_000, maxBuffer: 1024 * 1024, env: workerEnv });
    let downloadedSection = false;
    let stdout;
    try {
      const sectionArgs = section ? ["--download-sections", `*${Math.max(0, range.start)}-${Math.max(0, range.start) + range.duration}`, "--merge-output-format", "mp4"] : [];
      ({ stdout } = await download("download", sectionArgs));
      if (!stdout.trim()) throw new Error("YouTube returned no downloadable stream.");
      downloadedSection = Boolean(section);
    } catch (error) {
      if (!section) throw error;
      ({ stdout } = await download("fallback", ["-f", "b[height<=720][ext=mp4]/b[height<=480]/b"]));
    }
    const { filepath, ...info } = JSON.parse(stdout);
    const selectedLanguage = language && language !== "auto" ? language : info.language || "auto";
    /* `transcribe: false` means the server transcribes (hosted speech API),
     * so this machine only has to deliver the audio. */
    if (audio && transcribe !== false && (/^ar\b/.test(selectedLanguage) || info.duration >= 600)) {
      await request(`${id}/transcribing`);
      const subprocess = run(process.env.WHISPER_PYTHON || "python3", [
        fileURLToPath(new URL("./whisper_words.py", import.meta.url)),
        filepath, selectedLanguage, workerEnv.WHISPER_MODEL || "base",
      ], { timeout: 2_400_000, maxBuffer: 8 * 1024 * 1024, env: {
        ...workerEnv, CLIP_MAKER_WHISPER_ACCELERATE: workerEnv.CLIP_MAKER_WHISPER_ACCELERATE ?? "1",
        CLIP_MAKER_WHISPER_PROGRESS: "1",
      } });
      let progressBuffer = "";
      subprocess.child.stderr?.setEncoding("utf8").on("data", chunk => {
        const lines = (progressBuffer + chunk).split("\n");
        progressBuffer = lines.pop();
        for (const line of lines) {
          const progress = /^clip-maker-progress:(\d+(?:\.\d+)?)$/.exec(line)?.[1];
          if (progress) void request(`${id}/transcribing?progress=${progress}`).catch(() => {});
        }
      });
      const { stdout: words } = await subprocess;
      const response = await request(`${id}/transcript`, {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metadata: info, transcript: JSON.parse(words) }),
      });
      if (!response.ok) throw new Error(`Rundploy rejected the transcript (HTTP ${response.status}).`);
      console.log(`Sent timed Whisper transcript for ${videoId}.`);
      return;
    }
    let output = filepath;
    if (audio) {
      output = path.join(directory, "source.mp3");
      /* The upload is capped at 28 MiB. 64 kbit/s covers about 55 minutes;
       * longer recordings drop the bitrate (speech stays intelligible to
       * a transcriber well below that) instead of failing. */
      const seconds = Number.isFinite(info.duration) && info.duration > 0 ? info.duration : 0;
      const kbps = Math.max(16, Math.min(64, Math.floor(26 * 1024 * 8 / Math.max(1, seconds))));
      await run(ffmpeg, ["-nostdin", "-loglevel", "error", "-i", filepath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", `${kbps}k`, "-y", output], { timeout: 300_000 });
    } else {
      output = path.join(directory, "source.mp4");
      const rangeArgs = section && !downloadedSection ? ["-ss", String(Math.max(0, range.start))] : [];
      await run(ffmpeg, [
        "-nostdin", "-loglevel", "error", ...rangeArgs, "-i", filepath, ...(section ? ["-t", String(range.duration)] : []),
        "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-movflags", "+faststart", "-y", output,
      ], { timeout: 90_000, maxBuffer: 1024 * 1024 });
    }
    const mime = audio ? "audio/mpeg" : "video/mp4";
    const media = await openAsBlob(output, { type: mime });
    const metadata = Buffer.from(JSON.stringify(info)).toString("base64url");
    const response = await request(`${id}/media`, {
      method: "PUT", body: media,
      headers: { "Content-Type": mime, "Content-Length": String(media.size), "X-Clip-Maker-Video": metadata },
    });
    if (!response.ok) throw new Error(`Rundploy rejected the media upload (HTTP ${response.status}).`);
    console.log(`Sent ${kind} for ${videoId}.`);
  } catch (error) {
    /* Say how a child process ended, not only what it printed: a process
     * that is killed or times out leaves nothing useful on stderr. */
    const ending = [
      error.killed ? "killed (timeout)" : "",
      error.signal ? `signal ${error.signal}` : "",
      error.code != null ? `exit ${error.code}` : "",
    ].filter(Boolean).join(", ");
    console.warn(`YouTube job ${videoId} failed${ending ? ` [${ending}]` : ""}:`, String(error.stderr || error.message).slice(-500));
    await request(`${id}/failed`).catch(() => {});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

console.log(`Waiting for Clip Maker download jobs from ${origin.origin}.`);
let waitingForServer = false;
for (;;) {
  try {
    const response = await request("claim");
    if (response.status === 401 || response.status === 404) {
      if (!waitingForServer) console.warn("Waiting for the server to accept the worker token. Check the Rundploy runtime secret if this persists.");
      waitingForServer = true;
      await delay(15_000);
      continue;
    }
    if (response.ok && waitingForServer) {
      console.log("Reconnected to Clip Maker.");
      waitingForServer = false;
    }
    if (response.status !== 204) {
      if (!response.ok) throw new Error(`Worker polling returned HTTP ${response.status}.`);
      await processJob(await response.json());
    }
  } catch (error) {
    console.warn("Worker connection failed:", error.message);
    await delay(10_000);
  }
  await delay(2500);
}
