/**
 * Jump cuts: ranges inside a clip that are removed from the export.
 *
 * Cuts are stored as clip-relative seconds, `[{ start, end }]`. Detection
 * works from word timings: dead air between words and stand-alone filler
 * sounds are removed, leaving a short natural pause. Everything else placed on
 * the clip's timeline (captions, framing, text overlays) is shifted to match.
 */

/** Hesitation sounds, compared after stripping punctuation and case. */
const FILLERS = new Set([
  "um", "uh", "uhm", "umm", "er", "erm", "hmm", "mm", "mhm", "ah",
  "euh", "heu", "hum", "bah",
  "اه", "آه", "ااه", "امم", "اممم", "ممم", "اا", "ايه",
]);

const bare = (word) => String(word ?? "").toLowerCase().replace(/[^\p{L}]/gu, "");

/** Sorted, merged, clamped cuts. Tiny cuts are dropped: they only add a click. */
export function normaliseCuts(cuts, duration) {
  const list = (Array.isArray(cuts) ? cuts : [])
    .map((c) => ({ start: Math.max(0, Number(c?.start)), end: Math.min(duration, Number(c?.end)) }))
    .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end - c.start >= 0.12)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const cut of list) {
    const last = merged[merged.length - 1];
    if (last && cut.start <= last.end + 0.05) last.end = Math.max(last.end, cut.end);
    else merged.push({ start: Math.round(cut.start * 1000) / 1000, end: Math.round(cut.end * 1000) / 1000 });
  }
  /* Never cut a clip down to nothing. */
  const removed = merged.reduce((sum, c) => sum + c.end - c.start, 0);
  return duration - removed >= Math.min(3, duration) ? merged : [];
}

export function cutSeconds(cuts) {
  return cuts.reduce((sum, c) => sum + c.end - c.start, 0);
}

/**
 * Finds pauses and fillers to remove.
 *
 * `words` are `{ word, start, end }` in clip-relative seconds. A pause longer
 * than `minPause` is trimmed so `keepPause` of it remains, split unevenly:
 * more after the previous word (speech tails off) than before the next one.
 */
export function detectCuts(words, duration, { minPause = 0.6, keepPause = 0.3, edgePause = 0.9 } = {}) {
  const spoken = (words ?? [])
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start && w.end > 0 && w.start < duration)
    .filter((w) => !FILLERS.has(bare(w.word)) && bare(w.word))
    .sort((a, b) => a.start - b.start);
  if (spoken.length < 2) return [];
  const after = keepPause * 0.6, before = keepPause * 0.4;
  const cuts = [];
  /* Silence before the first word and after the last. A little is kept so
   * the clip does not start on a clipped consonant. */
  if (spoken[0].start > edgePause) cuts.push({ start: 0, end: spoken[0].start - 0.2 });
  for (let i = 0; i + 1 < spoken.length; i++) {
    const gapStart = Math.max(0, spoken[i].end);
    const gapEnd = Math.min(duration, spoken[i + 1].start);
    if (gapEnd - gapStart >= minPause) cuts.push({ start: gapStart + after, end: gapEnd - before });
  }
  const last = spoken[spoken.length - 1];
  if (duration - last.end > edgePause) cuts.push({ start: last.end + 0.45, end: duration });
  return normaliseCuts(cuts, duration);
}

/** Maps a time on the original clip to the time after the cuts are removed. */
export function timeAfterCuts(t, cuts) {
  let removed = 0;
  for (const cut of cuts) {
    if (t <= cut.start) break;
    removed += Math.min(t, cut.end) - cut.start;
  }
  return t - removed;
}

/** Shifts timed items onto the cut timeline, dropping any that fall inside a cut. */
export function shiftTimed(items, cuts) {
  if (!cuts.length || !Array.isArray(items)) return items;
  return items
    .map((item) => ({ ...item, start: timeAfterCuts(item.start, cuts), end: timeAfterCuts(item.end, cuts) }))
    .filter((item) => item.end - item.start > 0.02);
}

/** ffmpeg select expression that keeps everything outside the cuts. */
export function keepExpression(cuts, duration) {
  const keep = [];
  let cursor = 0;
  for (const cut of cuts) {
    if (cut.start > cursor) keep.push([cursor, cut.start]);
    cursor = cut.end;
  }
  if (duration > cursor) keep.push([cursor, duration]);
  /* gte/lt rather than between(): between is inclusive at both ends, which
   * would keep one frame from each cut boundary twice over. */
  return keep.map(([a, b]) => `gte(t\\,${a.toFixed(3)})*lt(t\\,${b.toFixed(3)})`).join("+");
}
