import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { audioPeaks, sampleTimes, readMediaEvidence, verifyVisualHighlights, withinBudget } from "../server/media-evidence.mjs";
import { clipCountFor, filterSpeechHighlights, snapHighlights } from "../server/highlights.mjs";

test("short videos have room for more than two candidates", () => {
  assert.equal(clipCountFor(140), 5);
  assert.equal(clipCountFor(1001), 5);
  assert.equal(clipCountFor(12), 1);
});

test("a silent candidate cannot use words from elsewhere in the video", () => {
  const words = Array.from({ length: 20 }, (_, i) => ({ word: "spoken", start: i, end: i + 0.4 }));
  const clips = [{ startTime: 0, endTime: 20 }, { startTime: 100, endTime: 130 }];
  assert.deepEqual(filterSpeechHighlights(clips, words), [clips[0]]);
});

test("visual edits retain source timing without stretching toward speech", () => {
  const clip = { startTime: 30, endTime: 41, engagementScore: 90, evidence: "visual" };
  const [result] = snapHighlights([clip], [], { videoDuration: 100, growTo: 0 });
  assert.equal(result.startTime, 30);
  assert.equal(result.endTime, 41);
});

test("sampling includes the entire video and stays bounded", () => {
  const times = sampleTimes(1001, [363, 999, NaN]);
  assert.ok(times.includes(362));
  assert.ok(times.at(-1) < 1001);
  assert.ok(times[0] < 30);
  assert.ok(times.length <= 64);
});

test("audio signals ignore silence and avoid adjacent duplicate peaks", () => {
  const metadata = [0, 1, 2, 40].map((time, i) => `frame:${i} pts_time:${time}\nlavfi.astats.Overall.RMS_level=${[-90, -10, -12, -8][i]}`).join("\n");
  assert.deepEqual(audioPeaks(metadata, 50).map(p => p.time), [1, 40]);
});

test("slow preparation yields a retryable error instead of hanging", async () => {
  await assert.rejects(withinBudget(new Promise(() => {}), 10), /preparation is still running/);
  assert.equal(await withinBudget(Promise.resolve("cached"), 100), "cached");
});

test("real FFmpeg: silent video still supplies frames and visual approval is enforced", async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), "media-evidence-test-"));
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  try {
    const file = path.join(work, "silent.mp4");
    await promisify(execFile)(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=5", "-t", "6", "-c:v", "libx264", file]);
    const evidence = await readMediaEvidence({ file, duration: 6, ffmpeg });
    assert.equal(evidence.frames.length, 3);
    assert.deepEqual(evidence.sound, []);
    assert.ok(evidence.frames.every(f => f.url.startsWith("data:image/jpeg;base64,")));
    const visual = { evidence: "visual", title: "Unsupported goal", reason: "goal", startTime: 0, endTime: 5 };
    const approved = await verifyVisualHighlights({ highlights: [visual], file, duration: 6, ffmpeg,
      ask: async opts => {
        assert.ok(opts.messages[0].content.some(c => c.type === "image_url"));
        return { response: { approved: [] } };
      }, parse: response => response });
    assert.deepEqual(approved, []);
    const missing = await verifyVisualHighlights({ highlights: [visual], file: path.join(work, "missing.mp4"), duration: 6, ffmpeg,
      ask: async () => ({ response: { approved: [0] } }), parse: response => response });
    assert.deepEqual(missing, [], "model approval cannot substitute for decoded frames");
  } finally { await rm(work, { recursive: true, force: true }); }
});
