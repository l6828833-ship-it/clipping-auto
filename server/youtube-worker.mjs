import { randomUUID, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import express from "express";

const prefix = "/api/internal/youtube-worker";
const maxBytes = 28 * 1024 * 1024;
const jobs = new Map();
let lastPoll = 0;
const IDLE_JOB_MS = 900_000;
const MAX_JOB_MS = 3_600_000;

function workerToken() {
  return process.env.CLIP_MAKER_YOUTUBE_WORKER_TOKEN?.trim() || "";
}

/* Workers that ask for it are held open on /claim until a job arrives (up to
 * LONG_POLL_MS), instead of polling every few seconds: the job still starts at
 * once, and the host's request log gets one line per 20 seconds, not eight. */
const LONG_POLL_MS = 20_000;
const waiters = new Set();
const polledRecently = () => waiters.size > 0 || Date.now() - lastPoll <= 20_000;

/** True while the download worker is polling this server. */
export function youtubeWorkerAlive() {
  return Boolean(workerToken()) && polledRecently();
}

export async function downloadWithYouTubeWorker(videoId, destination, { kind = "audio", range, language, onTranscribing, signal } = {}) {
  signal?.throwIfAborted();
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId ?? "") || !workerToken() || (!polledRecently() && !jobs.size)) return null;
  if (jobs.size >= 4) throw new Error("The YouTube download worker is busy. Try again shortly.");

  const id = randomUUID();
  return new Promise((resolve, reject) => {
    /* The worker has 15 minutes between signs of life, and an hour in all.
     * A fixed 15-minute limit failed every long video: transcribing an hour
     * of speech with the large Whisper model takes longer than that, and the
     * worker reports progress the whole time. */
    const started = Date.now();
    let timeout;
    const finish = (error, metadata) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
      jobs.delete(id);
      if (error) reject(error);
      else resolve(metadata);
    };
    const cancel = () => finish(signal.reason);
    const touch = () => {
      clearTimeout(timeout);
      const left = started + MAX_JOB_MS - Date.now();
      timeout = setTimeout(() => finish(new Error("The YouTube download worker timed out.")), Math.max(1_000, Math.min(IDLE_JOB_MS, left)));
    };
    touch();
    jobs.set(id, { videoId, destination, kind, range, language, onTranscribing, finish, touch, state: "waiting" });
    signal?.addEventListener("abort", cancel, { once: true });
    /* Hand it straight to a worker that is waiting on /claim. */
    for (const waiter of waiters) if (waiter()) break;
  });
}

/** Claims the oldest waiting job; returns what the worker needs, or null. */
function claimNextJob() {
  for (const [id, job] of jobs) {
    if (job.state !== "waiting") continue;
    job.state = "claimed";
    /* The 15 minutes count from the claim, not from when the job was
     * queued. The worker takes one job at a time, so a job that waited
     * behind others used to expire while it was still being downloaded,
     * and its upload then got a 404. */
    job.touch();
    // The Mac worker only supplies blocked downloads. Self-hosted Whisper
    // runs in the web container, regardless of paid API configuration.
    return { id, videoId: job.videoId, kind: job.kind, range: job.range, language: job.language, transcribe: false };
  }
  return null;
}

/**
 * Answers a worker that reports on a job this server does not have. Jobs live
 * in this process's memory, so this means the server restarted after the job
 * was handed out, or the host ran a second instance and sent the request
 * there. The log line says so, because a bare 404 hid both.
 */
const reportedUnknown = new Set();
function unknownJob(req, res) {
  const id = String(req.params.id).slice(0, 36);
  /* Once per job: progress reports would otherwise repeat the line. */
  if (!reportedUnknown.has(id)) {
    if (reportedUnknown.size >= 200) reportedUnknown.clear();
    reportedUnknown.add(id);
    console.warn(`[YouTubeWorker] The worker reported on job ${id}, which this instance does not have `
      + "(the server restarted, or a second instance answered; run exactly one instance).");
  }
  return res.sendStatus(404);
}

export function registerYouTubeWorker(app) {
  app.use(prefix, (req, res, next) => {
    const token = workerToken();
    const expected = Buffer.from(`Bearer ${token}`);
    const received = Buffer.from(req.get("authorization") ?? "");
    if (!token) return res.sendStatus(404);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return res.sendStatus(401);
    res.set("Cache-Control", "no-store");
    next();
  });

  app.post(`${prefix}/claim`, (req, res) => {
    lastPoll = Date.now();
    const job = claimNextJob();
    if (job) return res.json(job);
    /* Older workers give up on a request after 10 seconds, so only hold the
     * ones that say how long they will wait. */
    const wait = Math.min(LONG_POLL_MS, Math.max(0, Number(req.get("x-clip-maker-wait")) * 1000 || 0));
    if (wait < 1000) return res.sendStatus(204);
    let timer;
    const done = () => { clearTimeout(timer); waiters.delete(waiter); lastPoll = Date.now(); };
    const waiter = () => {
      if (res.writableEnded || res.destroyed) { done(); return false; }
      const next = claimNextJob();
      if (!next) return false;
      done();
      res.json(next);
      return true;
    };
    timer = setTimeout(() => { done(); if (!res.writableEnded && !res.destroyed) res.sendStatus(204); }, wait);
    res.on("close", done);
    waiters.add(waiter);
  });

  app.post(`${prefix}/:id/failed`, (req, res) => {
    const job = jobs.get(req.params.id);
    if (job?.state !== "claimed") return unknownJob(req, res);
    job.finish(new Error("The YouTube download worker couldn’t fetch this video."));
    return res.sendStatus(204);
  });

  app.post(`${prefix}/:id/transcribing`, (req, res) => {
    const job = jobs.get(req.params.id);
    if (job?.state !== "claimed") return unknownJob(req, res);
    if (job.kind !== "audio") return res.sendStatus(404);
    job.touch();
    job.onTranscribing?.();
    return res.sendStatus(204);
  });

  app.post(`${prefix}/:id/transcript`, express.json({ limit: "4mb" }), (req, res) => {
    const job = jobs.get(req.params.id);
    if (job?.state !== "claimed") return unknownJob(req, res);
    if (job.kind !== "audio") return res.sendStatus(404);
    const { metadata, transcript } = req.body ?? {};
    if (!metadata || typeof transcript?.text !== "string" || !Array.isArray(transcript.words)
      || transcript.words.some(word => typeof word?.word !== "string" || !Number.isFinite(word.start)
        || !Number.isFinite(word.end) || word.start < 0 || word.end <= word.start)) return res.sendStatus(400);
    job.finish(null, { ...metadata, transcript });
    return res.sendStatus(204);
  });

  app.put(`${prefix}/:id/media`, async (req, res) => {
    const job = jobs.get(req.params.id);
    if (job?.state !== "claimed") return unknownJob(req, res);
    const expectedBytes = Number(req.get("content-length"));
    const mime = job.kind === "audio" ? "audio/mpeg" : "video/mp4";
    if (!req.is(mime) || !Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > maxBytes) {
      return res.sendStatus(400);
    }
    job.state = "receiving";
    /* A slow upload gets its own 15 minutes. */
    job.touch();
    const partial = `${job.destination}.partial`;
    let bytes = 0;
    try {
      const metadata = JSON.parse(Buffer.from(req.get("x-clip-maker-video") ?? "", "base64url"));
      await pipeline(req, new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          callback(bytes > expectedBytes ? new Error("Worker upload exceeded its declared size.") : null, chunk);
        },
      }), createWriteStream(partial, { flags: "wx" }));
      if (bytes !== expectedBytes || jobs.get(req.params.id) !== job) throw new Error("Worker upload expired or was incomplete.");
      await rename(partial, job.destination);
      job.finish(null, metadata);
      return res.sendStatus(204);
    } catch {
      if (jobs.get(req.params.id) === job) job.finish(new Error("The YouTube download worker couldn’t upload the media."));
      if (!res.destroyed) return res.sendStatus(400);
    } finally {
      await rm(partial, { force: true }).catch(() => {});
    }
  });
}
