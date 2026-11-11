import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const run = promisify(execFile);
const rgb = z.string().regex(/^#[a-f\d]{6}$/i);
const fonts = ["Montserrat", "Oswald", "Inter", "Impact", "Arial Black"];
const reelInput = z.object({
  title: z.string().trim().min(1).max(100),
  accent: rgb,
  background: z.tuple([rgb, rgb]),
  font: z.enum(fonts),
  slots: z.array(z.object({
    rank: z.number().int().min(1).max(5),
    title: z.string().trim().min(1).max(120),
    clipId: z.number().int().positive().nullable(),
  })).min(1).max(5),
});

const width = 1080;
const height = 1920;
const maximumClipSeconds = 60;
const expiry = 60 * 60_000;

function gradient([top, bottom]) {
  const start = Buffer.from(top.slice(1), "hex");
  const end = Buffer.from(bottom.slice(1), "hex");
  const pixels = Buffer.alloc(height * 2 * 3);
  for (let row = 0; row < height; row++) {
    for (let channel = 0; channel < 3; channel++) {
      const value = Math.round(start[channel] + (end[channel] - start[channel]) * row / (height - 1));
      pixels[row * 6 + channel] = pixels[row * 6 + channel + 3] = value;
    }
  }
  return Buffer.concat([Buffer.from(`P6\n2 ${height}\n255\n`), pixels]);
}

function reelTitles(reel, slot, titleCard) {
  const color = reel.accent.slice(1).match(/../g).reverse().join("");
  const escape = text => text.replace(/[\\{}\p{C}]/gu, " ").replace(/ +/g, " ");
  const line = (text, y, size, foreground) => (
    `Dialogue: 0,0:00:00.00,1:00:00.00,Default,,0,0,0,,{\\an5\\pos(540,${y})\\fs${size}\\c&H${foreground}&}${escape(text)}`
  );
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${reel.font},55,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,0,5,55,55,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${line("TOP 5", 80, 44, color)}
${line(reel.title, 175, 53, "FFFFFF")}
${line(`#${slot.rank}`, titleCard ? 770 : 1680, titleCard ? 168 : 64, color)}
${line(slot.title, titleCard ? 1030 : 1790, titleCard ? 68 : 49, "FFFFFF")}
`;
}

async function renderSegment(ffmpeg, directory, reel, slot, source, probeMedia, index) {
  const filename = `segment-${index}.mp4`;
  const subtitles = `titles-${index}.ass`;
  await writeFile(path.join(directory, subtitles), reelTitles(reel, slot, !source));
  const args = ["-loop", "1", "-framerate", "30", "-i", "background.ppm"];
  let duration = 3;
  let audioInput = "1:a:0";
  let videoFilter = `[0:v]scale=${width}:${height},setsar=1`;
  if (source) {
    const info = await probeMedia(source);
    if (!(info.duration > 0)) throw new Error("One of the selected clips could not be read.");
    duration = Math.min(maximumClipSeconds, info.duration);
    args.push("-i", source);
    const hasAudio = await run(ffmpeg, ["-hide_banner", "-i", source])
      .then(() => false, error => /^\s*Stream #0:.*Audio:/m.test(error.stderr ?? ""));
    if (!hasAudio) {
      args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
      audioInput = "2:a:0";
    }
    videoFilter += "[bg];[1:v]scale=980:1330:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1[clip];[bg][clip]overlay=(W-w)/2:250+(1330-h)/2";
  } else {
    args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
  }
  await run(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-nostdin", ...args,
    "-filter_complex_threads", "2", "-filter_complex", `${videoFilter},ass=${subtitles}:fontsdir=fonts[v]`,
    "-map", "[v]", "-map", audioInput, "-af", "apad", "-t", String(duration),
    "-r", "30", "-c:v", "libx264", "-preset", "fast", "-crf", "20",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", filename,
  ], { cwd: directory, timeout: 120_000 });
  return filename;
}

export function registerReelRoutes(app, { authenticate, findFfmpeg, getClipPath, probeMedia, fontsDirectory }) {
  const downloads = new Map();
  let rendering = false;

  app.post("/api/reels/render", async (request, response) => {
    const user = await authenticate(request).catch(() => null);
    if (!user) return response.status(401).json({ error: "Sign in to render a reel." });
    const parsed = reelInput.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Enter a reel title and one to five clip titles." });
    if (rendering) return response.status(503).json({ error: "A reel is already rendering. Try again in a moment." });
    rendering = true;
    let directory;
    let ready = false;
    try {
      const reel = parsed.data;
      const sources = await Promise.all(reel.slots.map(slot => (
        slot.clipId === null ? null : getClipPath(slot.clipId, user.id)
      )));
      if (reel.slots.some((slot, index) => slot.clipId !== null && !sources[index])) {
        return response.status(404).json({ error: "One of the selected clips is unavailable. Choose a finished clip." });
      }
      const ffmpeg = await findFfmpeg();
      if (!ffmpeg) return response.status(503).json({ error: "FFmpeg is unavailable on this server." });
      directory = await mkdtemp(path.join(os.tmpdir(), "shortspro-reel-"));
      await symlink(fontsDirectory, path.join(directory, "fonts"), "dir");
      await writeFile(path.join(directory, "background.ppm"), gradient(reel.background));
      const segments = [];
      for (const [index, slot] of reel.slots.entries()) {
        if (response.destroyed) return;
        segments.push(await renderSegment(ffmpeg, directory, reel, slot, sources[index], probeMedia, index));
      }
      await writeFile(path.join(directory, "segments.txt"), segments.map(segment => `file '${segment}'\n`).join(""));
      await run(ffmpeg, [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-f", "concat", "-safe", "1", "-i", "segments.txt",
        "-c", "copy", "-movflags", "+faststart", "shortspro-reel.mp4",
      ], { cwd: directory, timeout: 60_000 });
      if (response.destroyed) return;

      const token = randomUUID();
      downloads.set(token, { owner: user.id, file: path.join(directory, "shortspro-reel.mp4") });
      setTimeout(() => {
        downloads.delete(token);
        void rm(directory, { recursive: true, force: true }).catch(console.error);
      }, expiry).unref();
      ready = true;
      response.json({ url: `/api/reels/${token}`, expiresAt: Date.now() + expiry });
    } catch (error) {
      console.error("[Reel]", error.stderr || error.message);
      if (!response.destroyed) response.status(500).json({ error: "Couldn’t render this reel. Try again." });
    } finally {
      rendering = false;
      if (directory && !ready) await rm(directory, { recursive: true, force: true }).catch(console.error);
    }
  });

  app.get("/api/reels/:token", async (request, response) => {
    const user = await authenticate(request).catch(() => null);
    if (!user) return response.status(401).json({ error: "Sign in to download the reel." });
    const item = downloads.get(request.params.token);
    if (!item || item.owner !== user.id) return response.status(404).json({ error: "This reel has expired or is unavailable." });
    response.set("Cache-Control", "private, no-store");
    response.download(item.file, "shortspro-reel.mp4");
  });
}
