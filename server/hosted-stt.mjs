/** Groq word-timed speech recognition. The app's GPT configuration is
 * independent. GROQ_API_KEY opts in, or CLIP_MAKER_TRANSCRIBE=local selects
 * the on-device Whisper path. */
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const CHUNK_SECONDS = 300;
const PARALLEL = 4;
export function speechProvider() {
  const selected = process.env.CLIP_MAKER_TRANSCRIBE?.trim().toLowerCase();
  if (selected === "local") return "local";
  return selected === "groq" || process.env.GROQ_API_KEY?.trim() ? "groq" : "local";
}

/** Names and phrases from the video's title and channel, which the speakers
 * are likely to say and the model should spell the same way. */
export function transcriptionKeywords(...sources) {
  const phrases = new Set();
  for (const source of sources) {
    /* The API refuses a whole request whose keywords hold "<", ">" or a line
     * break, so those split phrases too. */
    for (const part of String(source ?? "").split(/[|•·–—:\/#،,؛!?؟()\[\]"“”«»<>\r\n]+|\s-\s/)) {
      const phrase = part.replace(/\s+/g, " ").trim();
      const words = phrase.split(" ").length;
      /* yt-dlp fills in "Unknown" or "NA" when a source has no channel. */
      if (/^(unknown|n\/?a|untitled( video)?)$/i.test(phrase)) continue;
      if (phrase.length >= 3 && phrase.length <= 40 && words <= 5 && /\p{L}/u.test(phrase)) phrases.add(phrase);
    }
  }
  return [...phrases].slice(0, 10);
}

/*
 * A few everyday Darija words in Arabic script. The API reads the prompt as
 * "earlier text", which steers it to write Darija as Darija instead of
 * turning it into Modern Standard Arabic or French.
 */
const DARIJA_PROMPT = "واش، بزاف، ديال، هادشي، دابا، غادي، كاين، شنو، علاش، مزيان، بغيت، كيفاش، صافي، ماشي.";

export class GroqTranscriptionError extends Error {
  constructor(status) {
    const unavailable = status === 401 || status === 402 || status === 403;
    super(unavailable ? "Audio transcription is temporarily unavailable. Try again later."
      : status === 429 ? "Audio transcription is busy. Try again shortly."
      : "Couldn’t transcribe this audio. Try again shortly or choose a shorter range.");
    this.status = status;
  }
}

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

async function transcribePiece(file, { apiKey, language, prompt, signal, model }) {
  const form = new FormData();
  form.append("file", new Blob([await readFile(file)], { type: "audio/mpeg" }), path.basename(file));
  form.append("model", model);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("temperature", "0");
  if (language) form.append("language", language);
  if (prompt) form.append("prompt", prompt);
  const timeout = AbortSignal.timeout(180_000);
  const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new GroqTranscriptionError(response.status);
  }
  const payload = await response.json();
  return { text: String(payload?.text ?? "").trim(), words: wordsFromResponse(payload), language: payload?.language };
}

/** Transcribe short pieces and move their word times onto the source timeline. */
export async function groqWords({ audioPath, language = "auto", ffmpeg, workDirectory, onProgress, signal, keywords = [] }) {
  signal?.throwIfAborted();
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) throw new GroqTranscriptionError(401);
  if (!ffmpeg) throw new GroqTranscriptionError();
  const model = process.env.GROQ_TRANSCRIBE_MODEL?.trim() || "whisper-large-v3-turbo";
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
    if (pieces.length === 0) throw new GroqTranscriptionError();
    const prompt = [darija ? DARIJA_PROMPT : "", ...keywords].filter(Boolean).join(" ").slice(0, 220);
    const options = { apiKey, language: code, prompt, signal, model };
    const first = await transcribePiece(path.join(directory, pieces[0]), options);
    if (first.text && !first.words.length) throw new GroqTranscriptionError();

    const results = [first];
    let done = 1;
    onProgress?.(done / pieces.length);
    const pending = pieces.slice(1).map((name, i) => ({ name, index: i + 1 }));
    const worker = async () => {
      for (let job = pending.shift(); job; job = pending.shift()) {
        try {
          const file = path.join(directory, job.name);
          results[job.index] = await transcribePiece(file, options).catch((error) => {
            if (signal?.aborted || error.status < 500) throw error;
            return transcribePiece(file, options);
          });
          if (results[job.index].text && !results[job.index].words.length) throw new GroqTranscriptionError();
        } catch (error) {
          pending.length = 0;
          throw error;
        }
        onProgress?.(++done / pieces.length);
      }
    };
    const settled = await Promise.allSettled(Array.from({ length: Math.min(PARALLEL, pending.length) }, worker));
    const failed = settled.find(result => result.status === "rejected");
    if (failed) throw failed.reason;

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
    const detected = results.find(result => result.words.length && typeof result.language === "string")?.language?.toLowerCase();
    const detectedLanguage = /^[a-z]{2,3}$/.test(detected ?? "") ? detected : undefined;
    console.log(`[HostedSTT] Groq transcribed ${pieces.length} piece(s) with ${model}.`);
    return { text: texts.join(" ").trim(), words, model, language: darija ? "ar-ma" : code || detectedLanguage };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
