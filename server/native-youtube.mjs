import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const run = promisify(execFile);
const videoID = z.string().regex(/^[A-Za-z0-9_-]{11}$/);
const clipInput = z.object({
  id: videoID,
  start: z.number().finite().min(0),
  end: z.number().finite().positive(),
}).refine(({ start, end }) => end - start >= 0.5 && end - start <= 90);
const link = id => `https://www.youtube.com/watch?v=${id}`;
const expiry = 5 * 60_000;
const maxEntries = 40;

class ImportError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function suggestions(info) {
  const { duration } = info;
  if (duration <= 35) {
    return [{ title: "Full video", start: 0, end: duration, reason: "Use the full video as your starting point." }];
  }

  const options = [];
  const length = Math.min(30, duration);
  const add = (start, end, title, reason) => {
    const candidate = { start: Math.round(start * 10) / 10, end: Math.min(duration, Math.round(end * 10) / 10), title, reason };
    if (candidate.end - candidate.start < 1 || options.length === 5) return;
    if (options.some(option => {
      const overlap = Math.min(option.end, candidate.end) - Math.max(option.start, candidate.start);
      return overlap > Math.min(option.end - option.start, candidate.end - candidate.start) * 0.45;
    })) return;
    options.push(candidate);
  };

  const replayed = (info.heatmap ?? [])
    .filter(point => Number.isFinite(point.start_time) && Number.isFinite(point.value) && point.value >= 0.08)
    .sort((a, b) => b.value - a.value);
  for (const peak of replayed) {
    const start = Math.min(duration - length, Math.max(0, peak.start_time - 5));
    const separation = Math.max(length * 0.65, Math.min(duration / 9, 65));
    if (options.some(option => Math.abs(option.start - start) < separation)) continue;
    add(start, start + length, "Most replayed", "Based on YouTube’s replay activity.");
  }

  for (const chapter of info.chapters ?? []) {
    if (!Number.isFinite(chapter.start_time) || !Number.isFinite(chapter.end_time)) continue;
    const start = Math.max(0, chapter.start_time);
    add(start, Math.min(duration, chapter.end_time, start + 45), chapter.title?.slice(0, 100) || "Chapter highlight",
      "Starts at a chapter in this video.");
  }

  const fallbackCount = Math.min(5, Math.ceil(duration / length));
  for (let index = 0; index < fallbackCount; index++) {
    const start = (duration - length) * index / Math.max(1, fallbackCount - 1);
    add(start, start + length, `Clip option ${options.length + 1}`, "A section you can trim in the editor.");
  }
  return options;
}

function captionTrack(info) {
  for (const tracks of [info.subtitles, info.automatic_captions]) {
    for (const key of ["en", "en-orig", info.language].filter(Boolean)) {
      const selected = tracks?.[key]?.find(track => track.ext === "json3");
      if (!selected?.url) continue;
      try {
        const url = new URL(selected.url);
        if (url.protocol === "https:" && url.hostname === "www.youtube.com" && url.pathname === "/api/timedtext") return url;
      } catch {
        continue;
      }
    }
  }
  return null;
}

async function readCaptions(track, start, end) {
  if (!track) return [];
  try {
    const response = await fetch(track, { redirect: "error", signal: AbortSignal.timeout(3500) });
    if (!response.ok || !response.body) return [];
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > 2 * 1024 * 1024) return [];
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return (Array.isArray(data.events) ? data.events : []).flatMap(event => {
      const text = event.segs?.map(segment => segment.utf8 ?? "").join("").replace(/\s+/g, " ").trim();
      const from = Number(event.tStartMs) / 1000;
      const until = from + Number(event.dDurationMs) / 1000;
      if (!text || !Number.isFinite(from) || !Number.isFinite(until) || until <= start || from >= end) return [];
      const relativeStart = Math.max(0, from - start);
      const relativeEnd = Math.min(end, until) - start;
      return relativeEnd > relativeStart ? [{ text: text.slice(0, 140), start: relativeStart, end: relativeEnd }] : [];
    }).slice(0, 160);
  } catch {
    return [];
  }
}

function upstreamError(error) {
  const details = String(error.stderr ?? "");
  if (/sign in|age.restrict|private|members.only|not available in your country|video is unavailable/i.test(details)) {
    return new ImportError(422, "YouTube couldn’t provide this video. Try a public video that plays without signing in.");
  }
  return new ImportError(502, "YouTube couldn’t provide the video right now. Try again or import the original file.");
}

export function registerNativeYouTube(app, { findYtDlp, findFfmpeg }) {
  const analyses = new Map();
  const pending = new Map();
  let downloads = 0;

  async function executable() {
    const command = process.env.CLIP_MAKER_YTDLP || await findYtDlp();
    if (!command) throw new ImportError(503, "YouTube import is unavailable on this server.");
    return command;
  }

  function ytOptions() {
    return [
      "--ignore-config", "--no-playlist", "--no-warnings",
      "--socket-timeout", "12", "--retries", "1",
      "--extractor-retries", "1", "--js-runtimes", `node:${process.execPath}`,
    ];
  }

  async function inspect(id) {
    const saved = analyses.get(id);
    if (saved && saved.expires > Date.now()) return saved;
    if (pending.has(id)) return pending.get(id);
    if (pending.size >= 3) throw new ImportError(503, "Clip Maker is busy. Try again in a moment.");

    const operation = (async () => {
      const command = await executable();
      let info;
      try {
        const result = await run(command, [...ytOptions(), "--dump-single-json", "--skip-download", "--", link(id)],
          { timeout: 40_000, maxBuffer: 12 * 1024 * 1024 });
        info = JSON.parse(result.stdout);
      } catch (error) {
        console.warn("[Clip Maker] YouTube analysis:", String(error.stderr || error.message).slice(0, 500));
        throw upstreamError(error);
      }
      if (info.is_live || info.live_status === "is_upcoming" || !Number.isFinite(info.duration) || info.duration < 0.5) {
        throw new ImportError(422, "Choose a finished YouTube video with at least half a second of footage.");
      }
      const result = {
        expires: Date.now() + expiry,
        track: captionTrack(info),
        details: {
          id,
          title: String(info.title || "YouTube video").slice(0, 200),
          channel: String(info.channel || info.uploader || "").slice(0, 160),
          duration: info.duration,
          suggestions: suggestions(info),
        },
      };
      analyses.delete(id);
      if (analyses.size >= maxEntries) analyses.delete(analyses.keys().next().value);
      analyses.set(id, result);
      return result;
    })();
    pending.set(id, operation);
    try {
      return await operation;
    } finally {
      pending.delete(id);
    }
  }

  const responseError = (res, error) => {
    if (res.headersSent || res.destroyed) return;
    res.status(error instanceof ImportError ? error.status : 500).json({
      error: error instanceof ImportError ? error.message : "Clip Maker couldn’t complete this request.",
    });
  };

  app.post("/api/native/youtube/analyze", async (req, res) => {
    const parsed = videoID.safeParse(req.body?.id);
    if (!parsed.success) return res.status(400).json({ error: "Enter a valid YouTube video link." });
    try {
      res.json((await inspect(parsed.data)).details);
    } catch (error) {
      responseError(res, error);
    }
  });

  app.post("/api/native/youtube/captions", async (req, res) => {
    const parsed = clipInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Choose a valid clip range." });
    try {
      const { id, start, end } = parsed.data;
      const analysis = await inspect(id);
      res.json(await readCaptions(analysis.track, start, Math.min(end, analysis.details.duration)));
    } catch (error) {
      responseError(res, error);
    }
  });

  app.post("/api/native/youtube/clip", async (req, res) => {
    const parsed = clipInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Choose a clip between half a second and 90 seconds." });
    if (downloads >= 2) return res.status(503).json({ error: "Two clips are importing. Try again in a moment." });
    downloads++;
    let directory;
    const abort = new AbortController();
    const onClose = () => abort.abort();
    res.once("close", onClose);
    try {
      const { id, start, end } = parsed.data;
      const analysis = await inspect(id);
      if (end > analysis.details.duration + 0.05) {
        throw new ImportError(400, "Choose a range within the video’s duration.");
      }
      const command = await executable();
      const ffmpeg = await findFfmpeg();
      if (!ffmpeg) throw new ImportError(503, "Video processing is unavailable on this server.");
      directory = await mkdtemp(path.join(os.tmpdir(), "clip-maker-youtube-"));
      const file = path.join(directory, "clip.mp4");
      try {
        await run(command, [
          ...ytOptions(),
          "--ffmpeg-location", ffmpeg,
          "-f", "bv*[ext=mp4][vcodec^=avc1][height<=1080]+ba[ext=m4a]/b[ext=mp4][height<=1080]/b[ext=mp4]/best",
          "--merge-output-format", "mp4", "--recode-video", "mp4",
          "--download-sections", `*${start.toFixed(3)}-${Math.min(end, analysis.details.duration).toFixed(3)}`,
          "--force-keyframes-at-cuts", "-o", path.join(directory, "clip.%(ext)s"), "--", link(id),
        ], { timeout: 150_000, maxBuffer: 2 * 1024 * 1024, signal: abort.signal });
        if (!(await stat(file)).size) throw new Error("Empty clip file");
      } catch (error) {
        if (abort.signal.aborted) return;
        console.warn("[Clip Maker] YouTube clip:", String(error.stderr || error.message).slice(-800));
        throw upstreamError(error);
      }

      if (!res.destroyed) {
        res.set("Cache-Control", "private, no-store");
        await new Promise((resolve, reject) => {
          res.download(file, "youtube-clip.mp4", error => error ? reject(error) : resolve());
        });
      }
    } catch (error) {
      responseError(res, error);
    } finally {
      res.off("close", onClose);
      downloads--;
      if (directory) await rm(directory, { recursive: true, force: true }).catch(console.error);
    }
  });
}
