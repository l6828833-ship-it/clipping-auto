/**
 * Clip selection helpers for gemini.detectHighlights.
 *
 * The model is good at judging WHAT is worth clipping and poor at timing: asked
 * for seconds from a wall of text it returns round numbers that start
 * mid-sentence. So the work is split. The transcript is handed over as short
 * numbered lines that begin and end where the speaker pauses; the model picks
 * lines; and the chosen range is then snapped onto real word timings so every
 * clip starts on the first word of a thought and ends after the last word of
 * its payoff.
 */

const SENTENCE_END = /[.!?؟…]["'»)\]]*$/;
/** Words a clip should not open on: they point back at something unseen. */
const WEAK_OPENERS = new Set([
  "and", "but", "so", "because", "or", "then", "also", "which", "that",
  "و", "ولكن", "لكن", "حيت", "حيث", "لأن", "ثم", "أو", "يعني",
  "et", "mais", "donc", "parce", "puis", "ou",
]);

const fmt = (seconds) => (Math.round(seconds * 10) / 10).toFixed(1);

/**
 * Groups timed words into lines that break at sentence ends and pauses.
 * Returns `[{ start, end, text, first, last }]` (`first`/`last` index `words`).
 */
export function transcriptLines(words, { maxWords = 16, maxSeconds = 9, pause = 0.7 } = {}) {
  const lines = [];
  let current = null;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const text = String(w.word ?? "").trim();
    if (!text || !Number.isFinite(w.start)) continue;
    const end = Number.isFinite(w.end) && w.end > w.start ? w.end : w.start + 0.3;
    const prev = current ? words[current.last] : null;
    const prevEnd = prev ? (Number.isFinite(prev.end) && prev.end > prev.start ? prev.end : prev.start + 0.3) : 0;
    const breakHere = !current
      || current.count >= maxWords
      || end - current.start > maxSeconds
      || w.start - prevEnd >= pause
      || SENTENCE_END.test(String(prev.word).trim());
    if (breakHere) {
      current = { start: w.start, end, text: "", first: i, last: i, count: 0 };
      lines.push(current);
    }
    current.text += (current.text ? " " : "") + text;
    current.end = Math.max(current.end, end);
    current.last = i;
    current.count += 1;
  }
  return lines;
}

/** The transcript as the model sees it: one `[start-end] text` line per thought. */
export function formatTimedTranscript(lines) {
  return lines.map((l) => `[${fmt(l.start)}-${fmt(l.end)}] ${l.text}`).join("\n");
}

/**
 * The strongest stretches of YouTube's "most replayed" curve, merged into
 * windows. This is real audience behaviour, the best single signal available.
 */
export function replayPeaks(heatmap, limit = 8) {
  const points = (heatmap ?? []).filter((p) => Number.isFinite(p.start) && Number.isFinite(p.end) && Number.isFinite(p.value));
  if (points.length < 5) return [];
  const sorted = [...points].sort((a, b) => b.value - a.value);
  const threshold = Math.max(0.35, sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.2))].value);
  const peaks = [];
  for (const p of points) {
    /* The first seconds are replayed on every video (people restart it). */
    if (p.value < threshold || p.end <= 15) continue;
    const last = peaks[peaks.length - 1];
    if (last && p.start - last.end <= 1) {
      last.end = p.end;
      last.value = Math.max(last.value, p.value);
    } else {
      peaks.push({ start: p.start, end: p.end, value: p.value });
    }
  }
  return peaks.sort((a, b) => b.value - a.value).slice(0, limit).sort((a, b) => a.start - b.start);
}

/** How many clips to ask for, by source length. */
export function clipCountFor(durationSeconds) {
  if (!durationSeconds || durationSeconds <= 0) return 5;
  if (durationSeconds < 150) return 2;
  if (durationSeconds < 360) return 3;
  if (durationSeconds < 1500) return 5;
  if (durationSeconds < 3600) return 7;
  return 8;
}

export function buildHighlightPrompts({ transcript, timed, videoDuration, peaks = [], chapters = [], count = 5, languageInstruction = "" }) {
  const system = `You are a senior short-form video editor. You cut long videos into clips for TikTok, Instagram Reels and YouTube Shorts, and you are judged on watch-through rate.

A clip is worth making only if a stranger who has never seen the full video would stop scrolling for it and understand it completely. Judge every candidate on:
1. HOOK - the first sentence must create curiosity, tension or a bold claim on its own. Never open on a greeting, an intro, "so", "and", a reply to something unseen, or a pronoun whose subject was named earlier.
2. PAYOFF - the clip must end right after the point lands (the punchline, the answer, the lesson, the reveal). Never end mid-thought and never trail into the next topic.
3. SELF-CONTAINED - one complete idea or story. No dependence on earlier context.
4. DENSITY - cut the wind-up. Start as late as possible and end as early as possible.
Skip intros, outros, sponsor reads, housekeeping ("like and subscribe") and rambling.

Return ONLY valid JSON - no markdown, no code fences, no commentary.
${languageInstruction}`;
  const timing = timed
    ? `Each transcript line is "[start-end] text" in seconds. A clip MUST start at the start time of one line and end at the end time of a later line. Copy those numbers exactly; do not invent times between lines.`
    : `The transcript has no timings. Estimate startTime and endTime in seconds from each passage's position in the text and the total duration.`;
  const extras = [];
  if (videoDuration) extras.push(`Total video duration: ${Math.floor(videoDuration)} seconds.`);
  if (peaks.length) {
    extras.push(`MOST REPLAYED (real viewer data - strongly prefer clips that cover these, if they also pass the rules):\n${peaks.map((p) => `- ${fmt(p.start)}s to ${fmt(p.end)}s (intensity ${p.value.toFixed(2)})`).join("\n")}`);
  }
  if (chapters.length) {
    extras.push(`CHAPTERS:\n${chapters.slice(0, 40).map((c) => `- ${fmt(c.start)}s ${String(c.title).slice(0, 80)}`).join("\n")}`);
  }
  const user = `Find the ${count} best clips in this video.

${timing}
Length: 20 to 60 seconds each; go up to 90 only when a story needs it. Let the content decide the length - do not pad and do not make every clip the same length.
Clips must not overlap. Take them from wherever the best moments are; do not spread them evenly for its own sake.

${extras.join("\n\n")}

TRANSCRIPT:
${transcript}

Return exactly this JSON shape:
{
  "highlights": [
    {
      "id": 1,
      "title": "SHORT CATCHY TITLE IN CAPS (max 8 words)",
      "startTime": <seconds, the start of the hook line>,
      "endTime": <seconds, the end of the payoff line>,
      "engagementScore": <integer 60-99, honest: 90+ only for a genuinely exceptional hook AND payoff>,
      "hook": "the clip's opening sentence, quoted from the transcript",
      "reason": "one sentence: why a stranger would watch this to the end"
    }
  ],
  "reelTitle": "TITLE FOR THE WHOLE SET IN ALL CAPS"
}
Sort highlights by engagementScore, highest first. Return fewer than ${count} rather than include a weak clip.`;
  return { system, user };
}

const wordEnd = (w) => (Number.isFinite(w.end) && w.end > w.start ? w.end : w.start + 0.3);

/**
 * Moves each highlight onto real speech boundaries.
 *
 * Start: the nearest line start within `reach` seconds, skipping lines that
 * open on a connective ("and", "so", "و") when a clean one is close.
 * End: the nearest line end. A little air is left before the first word and
 * after the last so the cut is not clipped. Overlapping picks are dropped,
 * weakest first.
 */
export function snapHighlights(highlights, words, { videoDuration, minSeconds = 8, maxSeconds = 95, reach = 3 } = {}) {
  const usable = (words ?? []).filter((w) => Number.isFinite(w.start));
  const limit = videoDuration && videoDuration > 0 ? videoDuration : Infinity;
  let out = highlights.map((h) => ({ ...h }));
  if (usable.length >= 5) {
    const lines = transcriptLines(usable);
    const LEAD = 0.12, TAIL = 0.3;
    out = out.map((h) => {
      const opener = (l) => String(usable[l.first].word).toLowerCase().replace(/[^\p{L}]/gu, "");
      const starts = lines.filter((l) => Math.abs(l.start - h.startTime) <= reach);
      const clean = starts.filter((l) => !WEAK_OPENERS.has(opener(l)));
      const nearest = (list, key, target) => list.reduce((best, l) => (Math.abs(l[key] - target) < Math.abs(best[key] - target) ? l : best));
      const pool = clean.length ? clean : starts;
      let start = h.startTime;
      if (pool.length) {
        start = nearest(pool, "start", h.startTime).start;
      } else {
        /* No line starts nearby: at least avoid cutting into a word. */
        const next = usable.find((w) => w.start >= h.startTime - 0.05);
        if (next && next.start - h.startTime <= reach) start = next.start;
      }
      const ends = lines.filter((l) => Math.abs(l.end - h.endTime) <= reach && l.end > start + minSeconds * 0.6);
      let end = h.endTime;
      if (ends.length) {
        end = nearest(ends, "end", h.endTime).end;
      } else {
        const prev = [...usable].reverse().find((w) => wordEnd(w) <= h.endTime + 0.05);
        if (prev && h.endTime - wordEnd(prev) <= reach && wordEnd(prev) > start) end = wordEnd(prev);
      }
      /* Leave air only where there is silence to leave it in. */
      const before = [...usable].reverse().find((w) => wordEnd(w) <= start + 0.01);
      const after = usable.find((w) => w.start >= end - 0.01);
      const lead = Math.min(LEAD, before ? Math.max(0, (start - wordEnd(before)) / 2) : LEAD);
      const tail = Math.min(TAIL, after ? Math.max(0, (after.start - end) / 2) : TAIL);
      return { ...h, startTime: start - lead, endTime: end + tail };
    });
  }
  const round = (n) => Math.round(n * 100) / 100;
  out = out
    .map((h) => {
      const startTime = round(Math.max(0, Math.min(h.startTime, limit - 1)));
      let endTime = round(Math.min(limit, h.endTime));
      if (endTime - startTime > maxSeconds) endTime = round(startTime + maxSeconds);
      return { ...h, startTime, endTime };
    })
    .filter((h) => Number.isFinite(h.startTime) && Number.isFinite(h.endTime) && h.endTime - h.startTime >= Math.min(minSeconds, 3));
  /* Drop picks that mostly repeat a stronger one. */
  out.sort((a, b) => b.engagementScore - a.engagementScore);
  const kept = [];
  for (const h of out) {
    const clash = kept.some((k) => {
      const overlap = Math.min(k.endTime, h.endTime) - Math.max(k.startTime, h.startTime);
      return overlap > 0.4 * Math.min(k.endTime - k.startTime, h.endTime - h.startTime);
    });
    if (!clash) kept.push(h);
  }
  return kept.map((h, i) => ({ ...h, id: i + 1 }));
}

/** How many highlights sit on a most-replayed peak. */
export function countOnPeaks(highlights, peaks) {
  return highlights.filter((h) => peaks.some((p) => Math.min(p.end, h.endTime) - Math.max(p.start, h.startTime) > 2)).length;
}
