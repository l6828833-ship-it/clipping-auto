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

async function processJob({ id, videoId, kind, range, language }) {
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[A-Za-z0-9_-]{11}$/.test(videoId) || !["audio", "video"].includes(kind)) return;
  const directory = await mkdtemp(path.join(tmpdir(), "clip-maker-worker-"));
  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const audio = kind === "audio";
    const format = audio
      ? ["-f", "bestaudio/best", "-x", "--audio-format", "mp3", "--audio-quality", "64K"]
      : ["-f", "b[height<=720][ext=mp4]/b[height<=480]/b"];
    const { stdout } = await run(ytDlp, [
      "--ignore-config", "--no-playlist", "--no-progress", "--socket-timeout", "15", "--retries", "1",
      "--js-runtimes", `node:${process.execPath}`, "--max-filesize", "350M", ...format,
      ...(process.env.CLIP_MAKER_FFMPEG ? ["--ffmpeg-location", ffmpeg] : []),
      "--print", "after_move:%(.{title,duration,uploader,language,filepath})j",
      "-o", path.join(directory, "download.%(ext)s"), "--", url,
    ], { timeout: 180_000, maxBuffer: 1024 * 1024 });
    const { filepath, ...info } = JSON.parse(stdout);
    if (audio && info.duration >= 600) {
      await request(`${id}/transcribing`);
      const selectedLanguage = language && language !== "auto" ? language : info.language || "auto";
      const { stdout: words } = await run(process.env.WHISPER_PYTHON || "python3", [
        fileURLToPath(new URL("./whisper_words.py", import.meta.url)),
        filepath, selectedLanguage, "base",
      ], { timeout: 660_000, maxBuffer: 4 * 1024 * 1024, env: workerEnv });
      const response = await request(`${id}/transcript`, {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metadata: info, transcript: JSON.parse(words) }),
      });
      if (!response.ok) throw new Error(`Rundploy rejected the transcript (HTTP ${response.status}).`);
      console.log(`Sent timed Whisper transcript for ${videoId}.`);
      return;
    }
    let output = filepath;
    if (!audio) {
      output = path.join(directory, "source.mp4");
      const rangeArgs = range && Number.isFinite(range.start) && Number.isFinite(range.duration)
        ? ["-ss", String(Math.max(0, range.start)), "-t", String(range.duration)] : [];
      await run(ffmpeg, [
        "-nostdin", "-loglevel", "error", ...rangeArgs, "-i", filepath,
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
    console.warn(`YouTube job ${videoId} failed:`, String(error.stderr || error.message).slice(-500));
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
