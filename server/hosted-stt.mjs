/**
 * Hosted speech-to-text with word timings, through the Inworld STT API.
 *
 * Used instead of local Whisper when the server has INWORLD_API_KEY: it takes
 * seconds rather than minutes and needs no GPU or spare memory. The audio is
 * cut into short MP3 pieces (the synchronous endpoint accepts 16 MiB per
 * request, base64 included), each piece is transcribed, and the word times are
 * shifted back onto the full recording.
 *
 * Returns null when the API cannot give word timings, so the caller can fall
 * back to local Whisper; captions need a start and end for every word.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

/* Overridable so the flow can be tested against a local stand-in. */
const STT_URL = process.env.INWORLD_STT_URL || "https://api.inworld.ai/stt/v1/transcribe";
const CHUNK_SECONDS = 300;
const PARALLEL = 3;

/** Models to try, in order. The first that returns word timings is kept. */
function candidateModels() {
  const override = process.env.INWORLD_STT_MODEL?.trim();
  return override ? [override] : ["groq/whisper-large-v3", "inworld/inworld-stt-1"];
}
let workingModel = null;

export function hostedSttAvailable() {
  return Boolean(process.env.INWORLD_API_KEY?.trim()) && process.env.CLIP_MAKER_HOSTED_STT !== "0";
}

/** Words from one API response, in seconds from the start of that piece. */
export function wordsFromResponse(payload) {
  const list = payload?.transcription?.wordTimestamps;
  if (!Array.isArray(list)) return [];
  const words = [];
  for (const item of list) {
    const word = typeof item?.word === "string" ? item.word.trim() : "";
    const start = Number(item?.startTimeMs) / 1000;
    let end = Number(item?.endTimeMs) / 1000;
    if (!word || !Number.isFinite(start) || start < 0) continue;
    if (!Number.isFinite(end) || end <= start) end = start + 0.2;
    words.push({ word, start, end });
  }
  return words;
}

async function transcribePiece(file, { apiKey, modelId, language }) {
  const audio = await readFile(file);
  const response = await fetch(STT_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      transcribeConfig: {
        modelId,
        audioEncoding: "MP3",
        includeWordTimestamps: true,
        ...(language ? { language } : {}),
      },
      audioData: { content: audio.toString("base64") },
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`Inworld STT ${response.status} (${modelId}): ${detail.slice(0, 200)}`);
  }
  const payload = await response.json();
  return { text: String(payload?.transcription?.transcript ?? "").trim(), words: wordsFromResponse(payload) };
}

/**
 * Transcribes `audioPath`. Resolves to `{ text, words, model }`, or null when
 * hosted transcription is unavailable or returns no word timings.
 */
export async function hostedWords({ audioPath, language = "auto", ffmpeg, workDirectory, onProgress }) {
  if (!hostedSttAvailable() || !ffmpeg) return null;
  const apiKey = process.env.INWORLD_API_KEY.trim();
  const code = language && language !== "auto" ? language.split("-")[0].toLowerCase() : "";
  const directory = await mkdtemp(path.join(workDirectory, "stt-"));
  try {
    await promisify(execFile)(ffmpeg, [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-i", audioPath,
      "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k",
      "-f", "segment", "-segment_time", String(CHUNK_SECONDS), "-reset_timestamps", "1",
      path.join(directory, "piece-%04d.mp3"),
    ], { timeout: 600_000, maxBuffer: 4 * 1024 * 1024 });
    const pieces = (await readdir(directory)).filter((name) => name.endsWith(".mp3")).sort();
    if (pieces.length === 0) return null;

    /* Settle on a model with the first piece before spending on the rest. */
    let first = null;
    let modelId = workingModel;
    const failures = [];
    for (const candidate of modelId ? [modelId] : candidateModels()) {
      try {
        const result = await transcribePiece(path.join(directory, pieces[0]), { apiKey, modelId: candidate, language: code });
        /* Speech with no word timings means this model cannot time words. A
         * silent first piece says nothing either way, so it is accepted. */
        if (result.text && result.words.length === 0) {
          failures.push(`${candidate}: no word timings`);
          continue;
        }
        first = result;
        modelId = candidate;
        break;
      } catch (error) {
        failures.push(String(error.message ?? error));
      }
    }
    if (!first) {
      console.warn("[HostedSTT] unavailable, using local Whisper:", failures.join(" | ").slice(0, 500));
      return null;
    }
    workingModel = modelId;

    const results = [first];
    let done = 1;
    onProgress?.(done / pieces.length);
    const pending = pieces.slice(1).map((name, i) => ({ name, index: i + 1 }));
    const worker = async () => {
      for (let job = pending.shift(); job; job = pending.shift()) {
        const file = path.join(directory, job.name);
        const options = { apiKey, modelId, language: code };
        /* One retry: a single dropped request should not cost the whole video. */
        results[job.index] = await transcribePiece(file, options).catch(() => transcribePiece(file, options));
        onProgress?.(++done / pieces.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, pending.length) }, worker));

    const words = [];
    const texts = [];
    results.forEach((result, index) => {
      const offset = index * CHUNK_SECONDS;
      if (result.text) texts.push(result.text);
      for (const w of result.words) {
        const start = Math.max(w.start + offset, words.length ? words[words.length - 1].start : 0);
        const end = Math.max(w.end + offset, start + 0.05);
        words.push({ word: w.word, start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000 });
      }
    });
    return { text: texts.join(" ").trim(), words, model: modelId };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
