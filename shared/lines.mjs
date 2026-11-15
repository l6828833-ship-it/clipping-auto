/**
 * Splits timed words into spoken lines. Shared by highlight detection, the
 * renderer and the editor preview, so all three agree on where a line starts.
 */

const SENTENCE_END = /[.!?؟…]["'»)\]]*$/;

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
