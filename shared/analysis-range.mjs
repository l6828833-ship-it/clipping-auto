export const MAX_ANALYSIS_RANGE_SECONDS = 15 * 60;

export function parseAnalysisTime(value) {
  const parts = value.trim().split(":");
  if (parts.length > 3 || parts.some(part => !/^\d+$/.test(part))) return null;
  if (parts.slice(1).some(part => Number(part) >= 60)) return null;
  const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

export function wordsWithinRange(words, { start, end }) {
  return words.flatMap(word => {
    const wordEnd = word.end ?? word.start + 0.3;
    if (word.start >= end || wordEnd <= start) return [];
    return [{ ...word, start: Math.max(word.start, start), end: Math.min(wordEnd, end) }];
  });
}
