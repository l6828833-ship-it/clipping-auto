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

function workerToken() {
  return process.env.CLIP_MAKER_YOUTUBE_WORKER_TOKEN?.trim() || "";
}

export async function downloadWithYouTubeWorker(videoId, destination, { kind = "audio", range, language, onTranscribing } = {}) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId ?? "") || !workerToken() || (Date.now() - lastPoll > 20_000 && !jobs.size)) return null;
  if (jobs.size >= 4) throw new Error("The YouTube download worker is busy. Try again shortly.");

  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("The YouTube download worker timed out.")), 900_000);
    const finish = (error, metadata) => {
      clearTimeout(timeout);
      jobs.delete(id);
      if (error) reject(error);
      else resolve(metadata);
    };
    jobs.set(id, { videoId, destination, kind, range, language, onTranscribing, finish, state: "waiting" });
  });
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

  app.post(`${prefix}/claim`, (_req, res) => {
    lastPoll = Date.now();
    for (const [id, job] of jobs) {
      if (job.state !== "waiting") continue;
      job.state = "claimed";
      return res.json({ id, videoId: job.videoId, kind: job.kind, range: job.range, language: job.language });
    }
    return res.sendStatus(204);
  });

  app.post(`${prefix}/:id/failed`, (req, res) => {
    const job = jobs.get(req.params.id);
    if (job?.state !== "claimed") return res.sendStatus(404);
    job.finish(new Error("The YouTube download worker couldn’t fetch this video."));
    return res.sendStatus(204);
  });

  app.post(`${prefix}/:id/transcribing`, (req, res) => {
    const job = jobs.get(req.params.id);
    if (job?.state !== "claimed" || job.kind !== "audio") return res.sendStatus(404);
    job.onTranscribing?.();
    return res.sendStatus(204);
  });

  app.post(`${prefix}/:id/transcript`, express.json({ limit: "4mb" }), (req, res) => {
    const job = jobs.get(req.params.id);
    if (job?.state !== "claimed" || job.kind !== "audio") return res.sendStatus(404);
    const { metadata, transcript } = req.body ?? {};
    if (!metadata || typeof transcript?.text !== "string" || !Array.isArray(transcript.words)
      || transcript.words.some(word => typeof word?.word !== "string" || !Number.isFinite(word.start)
        || !Number.isFinite(word.end) || word.start < 0 || word.end <= word.start)) return res.sendStatus(400);
    job.finish(null, { ...metadata, transcript });
    return res.sendStatus(204);
  });

  app.put(`${prefix}/:id/media`, async (req, res) => {
    const job = jobs.get(req.params.id);
    if (job?.state !== "claimed") return res.sendStatus(404);
    const expectedBytes = Number(req.get("content-length"));
    const mime = job.kind === "audio" ? "audio/mpeg" : "video/mp4";
    if (!req.is(mime) || !Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > maxBytes) {
      return res.sendStatus(400);
    }
    job.state = "receiving";
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
