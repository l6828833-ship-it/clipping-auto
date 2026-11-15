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
import { SENTENCE_END, transcriptLines } from "../shared/lines.mjs";

export { transcriptLines };

/** Words a clip should not open on: they point back at something unseen. */
const WEAK_OPENERS = new Set([
  "and", "but", "so", "because", "or", "then", "also", "which", "that",
  "و", "ولكن", "لكن", "حيت", "حيث", "لأن", "ثم", "أو", "يعني",
  "et", "mais", "donc", "parce", "puis", "ou",
]);

const fmt = (seconds) => (Math.round(seconds * 10) / 10).toFixed(1);

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

export function buildHighlightPrompts({ transcript, timed, videoDuration, peaks = [], chapters = [], count = 5, languageInstruction = "", videoTitle = "", channel = "" }) {
  const system = `You are a senior short-form video editor. You cut long videos into clips for TikTok, Instagram Reels and YouTube Shorts, and you are judged on watch-through rate.

A clip is worth making only if a stranger who has never seen the full video would stop scrolling for it and understand it completely. Judge every candidate on:
1. HOOK - the first sentence must create curiosity, tension or a bold claim on its own. Never open on a greeting, an intro, "so", "and", a reply to something unseen, or a pronoun whose subject was named earlier.
2. PAYOFF - the clip must end right after the point lands (the punchline, the answer, the lesson, the reveal). Never end mid-thought and never trail into the next topic. The last line of the clip must finish its sentence: if the speaker is still completing the idea, the answer or the joke in the next line, include that line too. A clip that stops in the middle is worthless.
3. SELF-CONTAINED - one complete idea or story. No dependence on earlier context.
4. DENSITY - cut the wind-up. Start as late as possible and end as early as possible.
Skip intros, outros, sponsor reads, housekeeping ("like and subscribe") and rambling.

HUMOUR. Funny moments are often the best clips, and the easiest to ruin with a bad cut. Read for jokes the way a comedian would:
- A joke is SETUP then PUNCHLINE then REACTION. Find the setup: the line that plants the expectation the punchline breaks. Start the clip there, not on the punchline - a punchline with no setup is not funny.
- End AFTER the reaction, never on the punchline itself. Include the line or two that follow it: the laugh, the comeback, the "no way", the tag that tops the joke. If people keep riffing and each line is funnier, keep going until the last topper lands, then stop before the talk returns to normal.
- Recognise humour that is not announced: teasing and roasting between friends, sarcasm, exaggeration, wordplay, a deliberately wrong answer, an awkward silence, someone losing their composure, a running gag being called back. In Moroccan Darija and other dialects, expect mockery among friends, mixed French and Arabic wordplay, and proverbs twisted for effect.
- A callback only works if its first mention is inside the clip. If it is not, pick a different clip.
- Do not explain or soften the joke in the title. Tease it without giving the punchline away.
Apply the same care to any moment built on timing: a reveal, a challenge, a wrong guess. The clip must contain the question and the answer, the attempt and the result.

TITLES. A title is the reason someone taps, so it must be about THIS clip and no other:
- Build it from what is actually said: the surprising claim, the name, the number, the object, the insult, the question being answered. Quote or closely paraphrase the strongest line.
- A title that would fit any video is a failure. Never write labels that only name the category or the mood, such as "Hilarious moment", "Funny take on marriage", "Comical discussion", "Great advice", "Interesting story", "Emotional moment", "Best moments", or their equivalents in any language. Never use the words "moment", "discussion", "take on", "reaction to" as the subject of a title.
- Make the viewer need the answer: state the tension or the first half of the idea and hold back the payoff. For a joke, tease the setup, never the punchline.
- Bad: "FUNNY TAKE ON MARRIAGE". Good: "HE ASKED HER DAD FOR PERMISSION... TWICE". Bad: "HILARIOUS MISTAKE ABOUT LEBANON". Good: "THEY THOUGHT I WAS LEBANESE FOR 3 YEARS".
- Name names. When the clip is told by or about someone a viewer could search for (the guest, the host, a celebrity they mention), write their name, spelled as in the video title, instead of "he", "she", "his brother" or "a man". "[GUEST NAME]'S BROTHER BROUGHT A CROCODILE HOME" beats "HIS BROTHER BROUGHT A CROCODILE HOME".
- Tie every clip to its video. The video title (given with the transcript) holds the keywords people search for: the guest, the show, the topic. Use them in the titles of the clips that are about them, so each clip is recognisably from this video. Do not force a name into a clip that is not about that person.
- Write it like the hook of a viral post: 3 to 8 words, concrete, with a curiosity gap, a contrast or a surprising number. A short quote from the clip often works best. No hashtags, no emojis, and nothing that is not true to the clip.
- No two titles in the answer may share their main words, apart from the names. "reelTitle" follows the same rules for the video as a whole and names its guest or show.
- "reason" is specific too: say what happens in the clip and why it holds attention, not that it is "engaging" or "relatable".

Return ONLY valid JSON - no markdown, no code fences, no commentary.
${languageInstruction}`;
  const timing = timed
    ? `Each transcript line is "[start-end] text" in seconds. A clip MUST start at the start time of one line and end at the end time of a later line. Copy those numbers exactly; do not invent times between lines.`
    : `The transcript has no timings. Estimate startTime and endTime in seconds from each passage's position in the text and the total duration.`;
  const extras = [];
  /* The names and keywords people search for usually sit in the title, not
   * in what is said: a guest is rarely called by name in their own interview. */
  const source = [
    videoTitle && `VIDEO TITLE: ${String(videoTitle).slice(0, 200)}`,
    channel && `CHANNEL: ${String(channel).slice(0, 120)}`,
  ].filter(Boolean);
  if (source.length) {
    extras.push(`${source.join("\n")}\nThese are the names and keywords viewers search for. Use them in the titles as the TITLES rules say.`);
  }
  if (videoDuration) extras.push(`Total video duration: ${Math.floor(videoDuration)} seconds.`);
  if (peaks.length) {
    extras.push(`MOST REPLAYED (real viewer data - strongly prefer clips that cover these, if they also pass the rules):\n${peaks.map((p) => `- ${fmt(p.start)}s to ${fmt(p.end)}s (intensity ${p.value.toFixed(2)})`).join("\n")}`);
  }
  if (chapters.length) {
    extras.push(`CHAPTERS:\n${chapters.slice(0, 40).map((c) => `- ${fmt(c.start)}s ${String(c.title).slice(0, 80)}`).join("\n")}`);
  }
  const user = `Find the ${count} best clips in this video.

${timing}
Length: 20 to 60 seconds each; go up to 90 only when a story needs it. NEVER shorter than 18 seconds: a clip of a few seconds is a punchline with no setup and means nothing to a stranger. If a moment is short, start earlier so the clip includes what leads up to it. Let the content decide the length - do not pad and do not make every clip the same length.
Clips must not overlap. Take them from wherever the best moments are; do not spread them evenly for its own sake.

${extras.join("\n\n")}

TRANSCRIPT:
${transcript}

Return exactly this JSON shape:
{
  "highlights": [
    {
      "id": 1,
      "title": "specific to this clip, built from what is said in it, max 8 words, in the required language (capitals where the script has them)",
      "startTime": <seconds, the start of the hook line>,
      "endTime": <seconds, the end of the payoff line>,
      "engagementScore": <integer 60-99, honest: 90+ only for a genuinely exceptional hook AND payoff>,
      "kind": "joke" | "story" | "insight" | "debate" | "reveal" | "other",
      "montage": "viral" | "dynamic" | "podcast" | "cinematic" | "normal",
      "hook": "the clip's opening sentence, quoted from the transcript",
      "payoff": "the line the clip ends on, quoted from the transcript (for a joke: the reaction or last topper, not the punchline)",
      "reason": "one sentence: why a stranger would watch this to the end"
    }
  ],
  "reelTitle": "TITLE FOR THE WHOLE SET IN ALL CAPS"
}
"montage" is the editing style that suits the clip best:
- "viral": jokes, banter, hot takes, fast or high-energy moments. Big bold captions carry it.
- "dynamic": explanations, arguments, tips and lists, where key sentences deserve emphasis. Punch-in zooms land on them.
- "podcast": calm conversation and interviews where the words matter more than the energy. Clean, quiet presentation.
- "cinematic": emotional stories, confessions, motivation, serious or dramatic moments. Dark grade and a slow push-in.
- "normal": none of the above clearly fits.
Choose per clip; a set of clips from one video should not all get the same style unless they truly are alike.

Sort highlights by engagementScore, highest first. Return fewer than ${count} rather than include a weak clip.`;
  return { system, user };
}

const wordEnd = (w) => (Number.isFinite(w.end) && w.end > w.start ? w.end : w.start + 0.3);

/**
 * Moves each highlight onto real speech boundaries.
 *
 * Start: the nearest line start within `reach` seconds, preferring a line
 * that begins a sentence and does not open on a connective ("and", "so", "و").
 * End: the nearest line end that finishes a thought (a sentence end or a
 * pause); if the pick stops mid-sentence it is carried on to where the
 * sentence ends. A little air is left before the first word and after the
 * last so the cut is not clipped. Overlapping picks are dropped, weakest first.
 */
export function snapHighlights(highlights, words, { videoDuration, minSeconds = 8, maxSeconds = 95, reach = 3, growTo = 18 } = {}) {
  const usable = (words ?? []).filter((w) => Number.isFinite(w.start));
  const limit = videoDuration && videoDuration > 0 ? videoDuration : Infinity;
  let out = highlights.map((h) => ({ ...h }));
  if (usable.length >= 5) {
    const lines = transcriptLines(usable);
    const LEAD = 0.12, TAIL = 0.3;
    /* Lines also break at a word or time limit, which is not the end of
     * anything. A line really closes a thought when its last word ends a
     * sentence or the speaker pauses after it. Transcripts without
     * punctuation (common for Arabic) still have the pauses. */
    const closes = (i) => i >= lines.length - 1
      || SENTENCE_END.test(String(usable[lines[i].last].word).trim())
      || lines[i + 1].start - lines[i].end >= 0.6;
    const opens = (i) => i === 0 || closes(i - 1);
    out = out.map((h) => {
      const opener = (l) => String(usable[l.first].word).toLowerCase().replace(/[^\p{L}]/gu, "");
      const starts = lines.filter((l) => Math.abs(l.start - h.startTime) <= reach);
      const clean = starts.filter((l) => !WEAK_OPENERS.has(opener(l)));
      const nearest = (list, key, target) => list.reduce((best, l) => (Math.abs(l[key] - target) < Math.abs(best[key] - target) ? l : best));
      /* Best first: starts a sentence and has no weak opener, then either. */
      const fresh = (list) => list.filter((l) => opens(lines.indexOf(l)));
      const pool = [fresh(clean), clean, fresh(starts), starts].find((list) => list.length) ?? [];
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
        const closing = ends.filter((l) => closes(lines.indexOf(l)));
        end = nearest(closing.length ? closing : ends, "end", h.endTime).end;
      } else {
        const prev = [...usable].reverse().find((w) => wordEnd(w) <= h.endTime + 0.05);
        if (prev && h.endTime - wordEnd(prev) <= reach && wordEnd(prev) > start) end = wordEnd(prev);
      }
      /* Too short to mean anything: a few seconds is a punchline with no
       * setup, or half a sentence. Grow it line by line, backwards first (the
       * setup comes before the moment the model picked), then forwards, until
       * it is long enough to stand on its own. */
      if (growTo > 0 && end - start < growTo) {
        let first = lines.findIndex((l) => l.start >= start - 0.01);
        let last = -1;
        for (let i = lines.length - 1; i >= 0; i--) if (lines[i].end <= end + 0.01) { last = i; break; }
        if (first >= 0 && last >= first) {
          let back = true;
          for (let guard = 0; guard < 40 && lines[last].end - lines[first].start < growTo; guard++) {
            const canBack = first > 0 && lines[first].start - lines[first - 1].end < 4;
            const canForward = last + 1 < lines.length && lines[last + 1].start - lines[last].end < 4;
            if (!canBack && !canForward) break;
            if ((back && canBack) || !canForward) first--; else last++;
            back = !back;
          }
          start = lines[first].start;
          end = lines[last].end;
        }
      }
      /* Never stop in the middle of a sentence. If the last line does not
       * close a thought, carry on to the line that does (up to 12 seconds
       * more); failing that, step back to the last line that did. */
      let last = -1;
      for (let i = lines.length - 1; i >= 0; i--) if (lines[i].end <= end + 0.05) { last = i; break; }
      if (last >= 0 && Math.abs(lines[last].end - end) < 0.06 && !closes(last)) {
        let finished = false;
        for (let j = last + 1; j < lines.length; j++) {
          if (lines[j].start - lines[j - 1].end >= 4 || lines[j].end - end > 12 || lines[j].end - start > maxSeconds) break;
          if (closes(j)) { end = lines[j].end; finished = true; break; }
        }
        if (!finished) {
          const floor = start + Math.max(minSeconds, 0.6 * (end - start));
          for (let k = last - 1; k >= 0 && lines[k].end > floor; k--) {
            if (closes(k)) { end = lines[k].end; break; }
          }
        }
      }
      /* Leave air only where there is silence to leave it in. */
      const before = [...usable].reverse().find((w) => wordEnd(w) <= start + 0.01);
      const after = usable.find((w) => w.start >= end - 0.01);
      /* A joke needs its reaction. Laughter is rarely transcribed, so it
       * shows up as a silent gap after the punchline: keep most of that gap,
       * and a short reaction line ("no way", a laugh) if one follows closely. */
      const timed = h.kind === "joke" || h.kind === "reveal";
      let reaction = false;
      if (timed) {
        const next = lines.find((l) => l.start >= end - 0.01);
        if (next && next.start - end <= 2.5 && next.end - next.start <= 2.5 && next.last - next.first < 4
            && next.end - start <= maxSeconds) {
          end = next.end;
          reaction = true;
        }
      }
      const afterEnd = usable.find((w) => w.start >= end - 0.01);
      const lead = Math.min(LEAD, before ? Math.max(0, (start - wordEnd(before)) / 2) : LEAD);
      const tail = timed
        ? Math.min(reaction ? 0.6 : 1.5, afterEnd ? Math.max(0, (afterEnd.start - end) * 0.85) : 1.5)
        : Math.min(TAIL, after ? Math.max(0, (after.start - end) / 2) : TAIL);
      return { ...h, startTime: start - lead, endTime: end + tail };
    });
  }
  const round = (n) => Math.round(n * 100) / 100;
  out = out
    .map((h) => {
      let startTime = round(Math.max(0, Math.min(h.startTime, limit - 1)));
      let endTime = round(Math.min(limit, h.endTime));
      /* Without word timings there are no lines to grow along, so widen a
       * too-short pick around itself, mostly backwards into the setup. */
      if (growTo > 0 && usable.length < 5 && endTime - startTime < growTo) {
        startTime = round(Math.max(0, startTime - (growTo - (endTime - startTime)) * 0.6));
        endTime = round(Math.min(limit, Math.max(endTime, startTime + growTo)));
      }
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

/* ── Language of the generated titles ────────────────────────────────────── */

const SCRIPTS = [
  ["Arabic", /[؀-ۿݐ-ݿ]/g],
  ["Chinese", /[一-鿿]/g],
  ["Japanese", /[぀-ヿ]/g],
  ["Korean", /[가-힯]/g],
  ["Hindi", /[ऀ-ॿ]/g],
  ["Russian", /[Ѐ-ӿ]/g],
];
/* Very common words that rarely appear in the other languages listed. */
const LATIN_WORDS = {
  English: ["the", "and", "you", "that", "this", "with", "was", "have", "what", "they", "are", "it's"],
  French: ["les", "des", "est", "une", "pas", "que", "vous", "mais", "dans", "c'est", "avec", "pour"],
  Spanish: ["los", "las", "que", "una", "pero", "porque", "como", "muy", "esto", "está", "para", "eso"],
  German: ["der", "die", "das", "und", "ist", "nicht", "ich", "auch", "eine", "wir", "aber", "mit"],
  Portuguese: ["não", "uma", "você", "isso", "mas", "com", "para", "muito", "também", "está", "então", "como"],
  /* Darija typed in Latin letters ("3" and "7" stand for Arabic sounds). */
  "Moroccan Darija": ["wach", "bzaf", "dyal", "hada", "hadchi", "ghadi", "3la", "m3a", "7ta", "kayn", "chno", "walakin"],
};
const DARIJA_ARABIC = ["ديال", "بزاف", "واش", "هادشي", "غادي", "دابا", "كاين", "شنو", "علاش", "مزيان", "هاد", "ماشي", "كيفاش", "بغيت"];

/**
 * Names the language a transcript is spoken in, or "" when it cannot tell.
 * A cheap guess from the letters and the commonest words: it only has to be
 * good enough to tell the model which language to answer in.
 */
export function detectTextLanguage(text) {
  const sample = String(text ?? "").slice(0, 60000).toLowerCase();
  const letters = (sample.match(/\p{L}/gu) ?? []).length;
  if (letters < 20) return "";
  for (const [name, pattern] of SCRIPTS) {
    const share = (sample.match(pattern) ?? []).length / letters;
    /* Japanese text is mostly kanji, so a small share of kana is enough. */
    if (share < (name === "Japanese" ? 0.1 : 0.4)) continue;
    if (name === "Chinese" && /[぀-ヿ]/.test(sample)) continue;
    if (name !== "Arabic") return name;
    const tokens = sample.split(/[^\p{L}]+/u);
    const darija = tokens.filter((t) => DARIJA_ARABIC.includes(t)).length;
    return darija >= 3 && darija / tokens.length > 0.004 ? "Moroccan Darija in Arabic script" : "Arabic";
  }
  const tokens = sample.split(/[^\p{L}\p{N}']+/u).filter(Boolean);
  if (tokens.length < 20) return "";
  let best = "", bestHits = 0, second = 0;
  for (const [name, list] of Object.entries(LATIN_WORDS)) {
    const hits = tokens.filter((t) => list.includes(t)).length;
    if (hits > bestHits) { second = bestHits; best = name; bestHits = hits; }
    else if (hits > second) second = hits;
  }
  /* Needs a clear lead: a wrong guess is worse than no guess. */
  return bestHits / tokens.length > 0.03 && bestHits >= second * 1.5 ? best : "";
}
