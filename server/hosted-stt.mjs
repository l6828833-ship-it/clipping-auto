/**
 * Hosted speech-to-text with word timings, through the OpenAI API.
 *
 * Off unless the server has both OPENAI_API_KEY and
 * CLIP_MAKER_TRANSCRIBE=openai: an AI key alone must never quietly send every
 * upload to a paid speech service. When on, it replaces local Whisper and
 * takes seconds instead of minutes, with no load on the server.
 *
 * The audio is cut into short MP3 pieces (the API takes 25 MB per request),
 * the pieces are transcribed a few at a time, and the word times are shifted
 * back onto the full recording.
 *
 * Returns null when the API cannot give word timings, so the caller falls back
 * to local Whisper; captions need a start and an end for every word.
 *
 *   OPENAI_API_KEY             the API key
 *   CLIP_MAKER_TRANSCRIBE      "openai" to use it
 *   OPENAI_TRANSCRIBE_MODEL    optional, default "whisper-1" (it must support
 *                              word timestamps)
 *   OPENAI_BASE_URL            optional, for a compatible endpoint or a test stand-in
 */
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const CHUNK_SECONDS = 300;
const PARALLEL = 4;
let retryAfterCredits = 0;

const baseUrl = () => (process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
const modelId = () => process.env.OPENAI_TRANSCRIBE_MODEL?.trim() || "whisper-1";

export function hostedSttAvailable() {
  return Boolean(process.env.OPENAI_API_KEY?.trim())
    && process.env.CLIP_MAKER_TRANSCRIBE?.trim().toLowerCase() === "openai";
}

/*
 * A few everyday Darija words in Arabic script. The API reads the prompt as
 * "earlier text", which steers it to write Darija as Darija instead of
 * turning it into Modern Standard Arabic or French.
 */
const DARIJA_PROMPT = "واش، بزاف، ديال، هادشي، دابا، غادي، كاين، شنو، علاش، مزيان، بغيت، كيفاش، صافي، ماشي.";

/** Words from one API response, in seconds from the start of that piece. */
export function wordsFromResponse(payload) {
  const list = payload?.words;
  if (!Array.isArray(list)) return [];
  const words = [];
  for (const item of list) {
    const word = typeof item?.word === "string" ? item.word.trim() : "";
    const start = Number(item?.start);
    let end = Number(item?.end);
    if (!word || !Number.isFinite(start) || start < 0) continue;
    if (!Number.isFinite(end) || end <= start) end = start + 0.2;
    words.push({ word, start, end });
  }
  return words;
}

async function transcribePiece(file, { apiKey, language, darija, signal }) {
  const form = new FormData();
  form.append("file", new Blob([await readFile(file)], { type: "audio/mpeg" }), path.basename(file));
  form.append("model", modelId());
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("temperature", "0");
  if (language) form.append("language", language);
  if (darija) form.append("prompt", DARIJA_PROMPT);
  const timeout = AbortSignal.timeout(180_000);
  const response = await fetch(`${baseUrl()}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) {
    /* Out of credit or over the rate limit: stop asking for a few minutes. */
    if (response.status === 429 || response.status === 402) retryAfterCredits = Date.now() + 5 * 60_000;
    const detail = await response.text().catch(() => response.statusText);
    throw Object.assign(new Error(`OpenAI transcription ${response.status}: ${detail.slice(0, 200)}`), { status: response.status });
  }
  const payload = await response.json();
  return { text: String(payload?.text ?? "").trim(), words: wordsFromResponse(payload) };
}

/**
 * Transcribes `audioPath`. Resolves to `{ text, words, model }`, or null when
 * hosted transcription is off, unavailable, or returns no word timings.
 */
export async function hostedWords({ audioPath, language = "auto", ffmpeg, workDirectory, onProgress, signal }) {
  signal?.throwIfAborted();
  if (!hostedSttAvailable() || !ffmpeg || Date.now() < retryAfterCredits) return null;
  const apiKey = process.env.OPENAI_API_KEY.trim();
  const darija = language === "ar-ma";
  /* The API takes plain language codes: Darija is sent as Arabic, with the
   * Darija prompt doing the rest. */
  const code = language && language !== "auto" ? language.split("-")[0].toLowerCase() : "";
  const directory = await mkdtemp(path.join(workDirectory, "stt-"));
  try {
    await promisify(execFile)(ffmpeg, [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-i", audioPath,
      "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k",
      "-f", "segment", "-segment_time", String(CHUNK_SECONDS), "-reset_timestamps", "1",
      path.join(directory, "piece-%04d.mp3"),
    ], { timeout: 600_000, maxBuffer: 4 * 1024 * 1024, signal, killSignal: "SIGKILL" });
    const pieces = (await readdir(directory)).filter((name) => name.endsWith(".mp3")).sort();
    if (pieces.length === 0) return null;
    const options = { apiKey, language: code, darija, signal };

    /* The first piece shows whether the model can time words at all, before
     * paying for the rest. A silent first piece says nothing either way. */
    let first;
    try {
      first = await transcribePiece(path.join(directory, pieces[0]), options);
    } catch (error) {
      signal?.throwIfAborted();
      console.warn("[HostedSTT] unavailable, using local Whisper:", String(error.message ?? error).slice(0, 300));
      return null;
    }
    if (first.text && first.words.length === 0) {
      console.warn(`[HostedSTT] ${modelId()} gave no word timings, using local Whisper. Set OPENAI_TRANSCRIBE_MODEL to a model that does (whisper-1).`);
      return null;
    }

    const results = [first];
    let done = 1;
    onProgress?.(done / pieces.length);
    const pending = pieces.slice(1).map((name, i) => ({ name, index: i + 1 }));
    const worker = async () => {
      for (let job = pending.shift(); job; job = pending.shift()) {
        const file = path.join(directory, job.name);
        /* One retry: a single dropped request should not cost the whole video. */
        results[job.index] = await transcribePiece(file, options).catch((error) => {
          if (signal?.aborted || error.status === 402) throw error;
          return transcribePiece(file, options);
        });
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
    console.log(`[HostedSTT] Transcribed ${pieces.length} piece(s) with ${modelId()}.`);
    return { text: texts.join(" ").trim(), words, model: modelId() };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
