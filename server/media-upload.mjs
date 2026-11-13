import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const MAX_BYTES = 500 * 1024 * 1024;
const MAX_ACTIVE_UPLOADS = 2;
const INPUT_FORMATS = "mov,matroska,avi,mp3,wav,flac,ogg,mpegts,mpeg,asf,flv,aac";
const inputOptions = ["-protocol_whitelist", "file", "-format_whitelist", INPUT_FORMATS];

class UploadError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function writeUpload(request, destination) {
  let bytes = 0;
  const limit = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > MAX_BYTES ? new UploadError(413, "Choose a file under 500 MB.") : null, chunk);
    },
  });
  // Keep the request outside the pipeline so an oversized chunked upload can
  // still receive a response after the output stream is closed.
  request.pipe(limit);
  const abort = () => limit.destroy(new UploadError(400, "The upload was interrupted."));
  request.once("aborted", abort);
  request.once("error", abort);
  try {
    await pipeline(limit, createWriteStream(destination, { flags: "wx" }));
    if (bytes === 0) throw new UploadError(400, "The selected file is empty.");
  } finally {
    request.off("aborted", abort);
    request.off("error", abort);
    request.unpipe(limit);
    request.resume();
  }
}

async function normaliseUpload(ffmpeg, source, destination) {
  let description;
  try {
    await run(ffmpeg, ["-hide_banner", ...inputOptions, "-i", source], { timeout: 30_000 });
  } catch (error) {
    // FFmpeg prints input stream metadata before reporting the missing output.
    description = error.stderr ?? "";
  }
  const hasVideo = /^\s*Stream #0:.*Video:.*$/m.test(description.replace(/^.*\(attached pic\).*$/gm, ""));
  const hasAudio = /^\s*Stream #0:.*Audio:/m.test(description);
  if (!hasVideo && !hasAudio) throw new UploadError(422, "This file has no supported video or audio track.");

  const background = hasVideo ? [] : ["-f", "lavfi", "-i", "color=c=0x171923:s=720x1280:r=24"];
  const tracks = hasVideo ? ["-map", "0:V:0", "-map", "0:a:0?"] : ["-map", "1:v:0", "-map", "0:a:0", "-shortest"];
  try {
    await run(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-nostdin", ...inputOptions, "-i", source, ...background, ...tracks,
      "-vf", "scale=w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
      "-c:v", "libx264", "-preset", "fast", "-crf", "19", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-movflags", "+faststart", destination,
    ], { timeout: 30 * 60_000, maxBuffer: 1024 * 1024 });
  } catch (error) {
    console.warn("[Upload] FFmpeg failed:", error.stderr || error.message);
    throw new UploadError(422, "Couldn’t read this media file. Try a different MP4, MOV, or audio file.");
  }
  return hasAudio;
}

export function registerMediaUpload(app, {
  authenticate, ensureDirs, findFfmpeg, probeMedia, transcribe, storeVideo, videoDirectory, workDirectory,
}) {
  let activeUploads = 0;
  app.post("/api/media/upload", async (request, response) => {
    const user = await authenticate(request).catch(() => null);
    if (!user) return response.status(401).json({ error: "Sign in to upload a video." });

    const { title, language = "auto", captions } = request.query;
    if (typeof title !== "string" || !title.trim() || title.trim().length > 512
        || typeof language !== "string" || !/^(?:auto|[a-z]{2,3}(?:-[a-z]{2})?)$/i.test(language)
        || !["on", "off"].includes(captions) || !request.is("application/octet-stream")) {
      return response.status(400).json({ error: "Choose a media file and enter a title of up to 512 characters." });
    }
    if (Number(request.headers["content-length"]) > MAX_BYTES) {
      return response.status(413).json({ error: "Choose a file under 500 MB." });
    }
    if (activeUploads >= MAX_ACTIVE_UPLOADS) {
      return response.status(503).json({ error: "Other uploads are processing. Try again in a moment." });
    }

    activeUploads++;
    let work;
    let savedFile;
    let committed = false;
    try {
      const ffmpeg = await findFfmpeg();
      if (!ffmpeg) throw new UploadError(503, "FFmpeg is unavailable on this server.");
      await ensureDirs();
      work = await mkdtemp(path.join(workDirectory, "upload-"));
      const source = path.join(work, "source");
      const normalised = path.join(work, "video.mp4");
      await writeUpload(request, source);
      const hasAudio = await normaliseUpload(ffmpeg, source, normalised);
      const { duration, width, height } = await probeMedia(normalised);
      if (!Number.isFinite(duration) || duration <= 0 || !width || !height) {
        throw new UploadError(422, "The uploaded file did not contain playable media.");
      }

      let transcript = "";
      let words = [];
      let note;
      if (captions === "on" && hasAudio) {
        const audio = path.join(work, "speech.wav");
        try {
          await run(ffmpeg, [
            "-hide_banner", "-loglevel", "error", "-nostdin", "-i", normalised,
            "-vn", "-ac", "1", "-ar", "16000", audio,
          ], { timeout: 10 * 60_000 });
          ({ text: transcript, words } = await transcribe(audio, language));
          if (!words.length) note = "No speech was detected. You can still edit and export this clip.";
        } catch (error) {
          console.warn("[Upload] Transcription unavailable:", error.message);
          note = "Automatic captions are unavailable. You can still edit and export this clip.";
        }
      }

      if (response.destroyed) return;
      const name = `video-${user.id}-${randomUUID().replaceAll("-", "")}.mp4`;
      savedFile = path.join(videoDirectory, name);
      await rename(normalised, savedFile);
      const id = await storeVideo({
        userId: user.id, title: title.trim(), sourceType: "upload", status: "done",
        duration, width, height, transcript, transcriptWords: words.length ? words : null,
        captionLanguage: language.toLowerCase(),
        transcriptionEnabled: captions === "on", hostedStatus: "ready", hostProgress: 100,
        hostedUrl: `/api/media/video/${name}`,
      });
      committed = true;
      response.status(201).json({ id, duration, transcript, words, note });
    } catch (error) {
      if (!(error instanceof UploadError)) console.error("[Upload]", error);
      if (!response.destroyed) {
        response.status(error.status ?? 500).json({
          error: error instanceof UploadError ? error.message : "Couldn’t save this upload. Try again.",
        });
      }
    } finally {
      activeUploads--;
      if (work) await rm(work, { recursive: true, force: true }).catch(console.error);
      if (savedFile && !committed) await rm(savedFile, { force: true }).catch(console.error);
    }
  });
}
