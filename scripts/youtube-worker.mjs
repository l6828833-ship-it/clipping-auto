import { execFile, spawn } from "node:child_process";
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

/** Why the server refused a delivery, in words that point at the fix. */
function rejection(what, status) {
  if (status === 404) {
    return `The server no longer has this job, so it refused the ${what} (HTTP 404). It restarted after handing the job out, `
      + "or a second instance answered. Set the app to exactly one instance (minimum 1, maximum 1).";
  }
  return `Rundploy rejected the ${what} (HTTP ${status}).`;
}

/**
 * Runs yt-dlp in a process group of its own, so that a timeout also stops the
 * ffmpeg it started. Killing yt-dlp alone left that ffmpeg downloading by
 * itself for minutes after the job had already failed.
 */
function runYtDlp(args, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(ytDlp, args, { env: workerEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout = (stdout + chunk).slice(-1024 * 1024); });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-64 * 1024); });
    const timer = setTimeout(() => {
      killed = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }, timeout);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && !killed) return resolve({ stdout, stderr });
      reject(Object.assign(new Error(`Command failed: ${args.slice(-8).join(" ")}`), { code, signal, killed, stdout, stderr }));
    });
  });
}

async function request(endpoint, options = {}) {
  return fetch(new URL(`/api/internal/youtube-worker/${endpoint}`, origin), {
    method: "POST", ...options,
    redirect: "error",
    headers: { Authorization: `Bearer ${token}`, ...options.headers },
    signal: AbortSignal.timeout(options.timeout ?? (options.body ? 90_000 : 10_000)),
  });
}

/**
 * Runs Whisper on this machine and returns its JSON ({ text, words }), with
 * progress passed on to the server. An Apple-silicon Mac transcribes Darija
 * about twice as fast as the 4-vCPU web container, and the container's CPU
 * stays free for everyone else.
 */
async function transcribeHere(id, audioPath, language, seconds = 0) {
  const subprocess = run(process.env.WHISPER_PYTHON || "python3", [
    fileURLToPath(new URL("./whisper_words.py", import.meta.url)),
    audioPath, language || "auto", workerEnv.WHISPER_MODEL || "base",
  /* 40 minutes, or twice the audio's length for an hour-long part: Auto
   * language took 1.25 times real time here. */
  ], { timeout: Math.max(2_400_000, seconds * 2_000), maxBuffer: 16 * 1024 * 1024, env: {
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
  const { stdout } = await subprocess;
  const transcript = JSON.parse(stdout);
  if (typeof transcript?.text !== "string" || !Array.isArray(transcript.words)) throw new Error("Whisper returned no transcript.");
  return transcript;
}

async function processJob({ id, videoId, kind, range, analysisOnly, language, transcribe }) {
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[A-Za-z0-9_-]{11}$/.test(videoId) || !["audio", "video"].includes(kind)) return;
  const directory = await mkdtemp(path.join(tmpdir(), "clip-maker-worker-"));
  /* A sign of life every 30 seconds, so the server does not take a long
   * download for a stuck one. Servers without this route answer 404. */
  const heartbeat = setInterval(() => void request(`${id}/alive`).catch(() => {}), 30_000);
  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const audio = kind === "audio";
    const hasRange = range && Number.isFinite(range.start) && Number.isFinite(range.duration) && range.duration > 0;
    const section = !audio && hasRange;
    if (audio && hasRange) {
      await processAudioRange({ id, url, videoId, range, language, transcribe: transcribe === true, directory });
      return;
    }
    /* A clip's part of a video is short, so it can be fetched at 720p and
     * still fit the upload limit; 480p looked soft once cropped to vertical.
     * A whole video stays at 480p. */
    const height = analysisOnly ? 360 : section ? 720 : 480;
    const format = audio ? "ba[ext=m4a]/ba/b" : `bv[height<=${height}][ext=mp4][vcodec^=avc1]+ba[ext=m4a]/b[height<=${analysisOnly ? 360 : 720}][ext=mp4]/b`;
    const ytArgs = [
      "--ignore-config", "--no-playlist", "--no-progress", "--socket-timeout", "15", "--retries", "1",
      "--js-runtimes", `node:${process.execPath}`, "--max-filesize", "350M", "--check-formats", "-f", format,
      ...(process.env.CLIP_MAKER_FFMPEG ? ["--ffmpeg-location", ffmpeg] : []),
      "--print", "after_move:%(.{title,duration,uploader,language,filepath})j",
    ];
    const download = async (stem, extra = [], timeout = 180_000) => {
      const result = await runYtDlp([...ytArgs, ...extra, "-o", path.join(directory, `${stem}.%(ext)s`), "--", url], timeout);
      if (!result.stdout.trim()) throw new Error("YouTube returned no downloadable stream.");
      return result;
    };
    const sectionArgs = section ? ["--download-sections", `*${Math.max(0, range.start)}-${Math.max(0, range.start) + range.duration}`, "--merge-output-format", "mp4"] : [];
    /* yt-dlp hands --download-sections to ffmpeg, which reads YouTube at about
     * twice playback speed: the first 15 minutes of a 360p stream took over
     * 7 minutes, against a 3-minute limit, so every long analysis range
     * failed and the video got neither a transcript nor frames. yt-dlp's own
     * downloader fetches the whole 360p file in a fraction of that, and the
     * range is cut out below. A file over --max-filesize (a very long video)
     * falls back to the section download, given time to finish. */
    const whole = section && analysisOnly && range.duration > 120;
    let downloadedSection = false;
    let stdout;
    try {
      ({ stdout } = await download("download", whole ? ["--merge-output-format", "mp4"] : sectionArgs, whole ? 300_000 : 180_000));
      downloadedSection = Boolean(section) && !whole;
    } catch (error) {
      if (whole) {
        ({ stdout } = await download("section", sectionArgs, Math.max(180_000, range.duration * 750)));
        downloadedSection = true;
      } else {
        if (!section || analysisOnly) throw error;
        ({ stdout } = await download("fallback", ["-f", "b[height<=720][ext=mp4]/b[height<=480]/b"]));
      }
    }
    const { filepath, ...info } = JSON.parse(stdout);
    /* The server asks for a transcript (`transcribe: true`) only when it
     * wants this machine to run Whisper. */
    if (audio && transcribe === true) {
      await request(`${id}/transcribing`);
      try {
        await sendTranscript(id, videoId, info, await transcribeHere(id, filepath, language));
        return;
      } catch (error) {
        if (/rejected|no longer has/i.test(error.message)) throw error;
        console.warn(`Whisper failed here for ${videoId}; sending the audio instead:`, String(error.stderr || error.message).slice(-300));
      }
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
      /* The upload is capped at 28 MiB. Hold a section's bitrate to what fits
       * in 24 MiB for its length (up to 4.5 Mbit/s, plenty for 720p). */
      const seconds = section ? Math.max(1, range.duration) : 0;
      /* A part over 15 minutes (up to an hour) is only looked at as stills,
       * so it goes smaller: 240p at 10 frames a second, 32 kbit/s sound.
       * An hour then takes about 24 MiB. */
      const long = analysisOnly && seconds > 900;
      const audioKbps = long ? 32 : 64;
      const kbps = !section ? 0 : analysisOnly
        ? Math.max(long ? 24 : 100, Math.min(650, Math.floor(22 * 1024 * 8 / seconds) - (long ? audioKbps + 16 : 80)))
        : Math.max(600, Math.min(4500, Math.floor(24 * 1024 * 8 / seconds) - 160));
      const rateArgs = analysisOnly && section
        ? ["-vf", long ? "fps=10,scale=-2:min(240\\,ih)" : "scale=-2:min(360\\,ih)", "-b:v", `${kbps}k`, "-maxrate", `${kbps}k`, "-bufsize", `${kbps * 2}k`, "-b:a", `${audioKbps}k`]
        : section ? ["-crf", "21", "-maxrate", `${kbps}k`, "-bufsize", `${kbps * 2}k`] : [];
      await run(ffmpeg, [
        "-nostdin", "-loglevel", "error", ...rangeArgs, "-i", filepath, ...(section ? ["-t", String(range.duration)] : []),
        "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast", ...rateArgs, "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-movflags", "+faststart", "-y", output,
      ], { timeout: section ? Math.max(240_000, seconds * 200) : 90_000, maxBuffer: 1024 * 1024 });
    }
    const mime = audio ? "audio/mpeg" : "video/mp4";
    const media = await openAsBlob(output, { type: mime });
    const metadata = Buffer.from(JSON.stringify(info)).toString("base64url");
    const response = await request(`${id}/media`, {
      method: "PUT", body: media,
      headers: { "Content-Type": mime, "Content-Length": String(media.size), "X-Clip-Maker-Video": metadata },
    });
    if (!response.ok) throw new Error(rejection("media upload", response.status));
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
    clearInterval(heartbeat);
    await rm(directory, { recursive: true, force: true });
  }
}

async function sendTranscript(id, videoId, info, transcript) {
  const response = await request(`${id}/transcript`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ metadata: info, transcript }),
  });
  if (!response.ok) throw new Error(rejection("transcript", response.status));
  console.log(`Sent timed Whisper transcript for ${videoId} (${transcript.words.length} words).`);
}

/**
 * Audio for a selected part of a video, with word times counted from the
 * start of that part. The whole low-bitrate audio track comes first: yt-dlp
 * fetched all 6.5 hours of one stream (137 MB) in under 30 seconds, while
 * the same 15-minute part as a 360p video section took about 11 minutes,
 * because ffmpeg reads a section at about twice playback speed.
 */
async function processAudioRange({ id, url, videoId, range, language, transcribe, directory }) {
  const start = Math.max(0, range.start);
  const ytArgs = [
    "--ignore-config", "--no-playlist", "--no-progress", "--socket-timeout", "15", "--retries", "2",
    "--js-runtimes", `node:${process.execPath}`, "--max-filesize", "350M",
    "-f", "ba[abr<=72][ext=m4a]/ba[abr<=72]/ba[ext=m4a]/ba/b",
    ...(process.env.CLIP_MAKER_FFMPEG ? ["--ffmpeg-location", ffmpeg] : []),
    "--print", "after_move:%(.{title,duration,uploader,language,filepath})j",
  ];
  const download = async (stem, extra, timeout) => {
    const result = await runYtDlp([...ytArgs, ...extra, "-o", path.join(directory, `${stem}.%(ext)s`), "--", url], timeout);
    if (!result.stdout.trim()) throw new Error("YouTube returned no downloadable stream.");
    return JSON.parse(result.stdout.trim().split("\n").pop());
  };
  let info;
  let cutStart = start;
  try {
    info = await download("audio", [], 300_000);
  } catch (error) {
    /* Over --max-filesize (a very long video at a higher bitrate), or the
     * whole track failed: fetch only the part, given time to finish. */
    console.warn(`Whole audio for ${videoId} failed; downloading only the selected part:`, String(error.stderr || error.message).slice(-200));
    info = await download("section", ["--download-sections", `*${start}-${start + range.duration}`], Math.max(180_000, range.duration * 750));
    cutStart = 0;
  }
  const { filepath, ...metadata } = info;
  const wav = path.join(directory, "range.wav");
  await run(ffmpeg, [
    "-nostdin", "-loglevel", "error", "-ss", String(cutStart), "-i", filepath, "-t", String(range.duration),
    "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y", wav,
  ], { timeout: 300_000 });
  if (transcribe) {
    await request(`${id}/transcribing`);
    try {
      await sendTranscript(id, videoId, metadata, await transcribeHere(id, wav, language, range.duration));
      return;
    } catch (error) {
      if (/rejected|no longer has/i.test(error.message)) throw error;
      console.warn(`Whisper failed here for ${videoId}; sending the audio instead:`, String(error.stderr || error.message).slice(-300));
    }
  }
  /* The upload is capped at 28 MiB; 64 kbit/s covers 55 minutes. */
  const output = path.join(directory, "range.mp3");
  const kbps = Math.max(16, Math.min(64, Math.floor(26 * 1024 * 8 / Math.max(1, range.duration))));
  await run(ffmpeg, ["-nostdin", "-loglevel", "error", "-i", wav, "-ac", "1", "-ar", "16000", "-b:a", `${kbps}k`, "-y", output], { timeout: 300_000 });
  const media = await openAsBlob(output, { type: "audio/mpeg" });
  const response = await request(`${id}/media`, {
    method: "PUT", body: media,
    headers: { "Content-Type": "audio/mpeg", "Content-Length": String(media.size), "X-Clip-Maker-Video": Buffer.from(JSON.stringify(metadata)).toString("base64url") },
  });
  if (!response.ok) throw new Error(rejection("media upload", response.status));
  console.log(`Sent audio of ${Math.round(range.duration)} s from ${Math.round(start)} s for ${videoId}.`);
}

console.log(`Waiting for Clip Maker download jobs from ${origin.origin}.`);
let waitingForServer = false;
for (;;) {
  try {
    /* The server holds the request until a job arrives, up to 20 seconds. */
    const response = await request("claim", { headers: { "X-Clip-Maker-Wait": "20" }, timeout: 35_000 });
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
