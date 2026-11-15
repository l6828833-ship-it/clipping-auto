/**
 * Video styles ("montages") a clip can be exported in. Shared by the editor's
 * picker and the renderer. `split` says what fills the lower half of a
 * split-screen style; single-speaker styles have none.
 */
import { transcriptLines } from "./lines.mjs";

export const VIDEO_STYLES = {
  normal: { label: "Normal", hint: "Full-screen speaker, your caption design", group: "Single speaker" },
  dynamic: { label: "Dynamic Zoom", hint: "Punch-in zooms on alternate sentences", group: "Single speaker" },
  podcast: { label: "Clean Podcast", hint: "Calm framing, small sentence-case captions", group: "Single speaker" },
  cinematic: { label: "Cinematic Talk", hint: "Dark grade, slow push-in, elegant captions", group: "Single speaker" },
  viral: { label: "Viral Captions", hint: "Big bold captions, spoken word pops", group: "Single speaker" },
  gameplay: { label: "Speaker + Gameplay", hint: "Speaker on top, your gameplay video below", group: "Split screen", split: "background" },
  satisfying: { label: "Speaker + Satisfying", hint: "Speaker on top, your satisfying video below", group: "Split screen", split: "background" },
  dual: { label: "Dual Speaker", hint: "Two people stacked, one per half", group: "Split screen", split: "dual" },
  reaction: { label: "Reaction Split", hint: "Creator's face on top, full picture below", group: "Split screen", split: "reaction" },
};
export const VIDEO_STYLE_IDS = Object.keys(VIDEO_STYLES);
/** Styles the AI may suggest: the ones that need nothing but the clip itself. */
export const AI_VIDEO_STYLES = ["normal", "dynamic", "podcast", "cinematic", "viral"];

/** Caption style for a video style. The user's colours and font are kept. */
export function montageCaptionStyle(styleId, style) {
  const s = { ...style };
  const centre = () => { if (s.posX == null && s.posY == null) s.position = "center"; };
  switch (styleId) {
    case "podcast":
      return { ...s, preset: "clean", uppercase: false, fontSize: Math.min(s.fontSize ?? 72, 54) };
    case "cinematic":
      return { ...s, preset: "karaoke", uppercase: false, fontSize: Math.min(s.fontSize ?? 72, 56), color: "#F4EFE6", highlightColor: "#E8C98A" };
    case "viral":
      return { ...s, preset: "impact", uppercase: true, fontSize: Math.max(s.fontSize ?? 72, 96), outline: true };
    case "gameplay": case "satisfying": case "dual": case "reaction":
      centre();
      return s.preset && s.preset !== "pop" ? s : { ...s, preset: "karaoke" };
    default:
      return s;
  }
}

/** Seconds ranges to punch in on: every other spoken line. */
export function punchIns(words, duration) {
  const usable = (words ?? []).filter((w) => Number.isFinite(w.start) && w.start < duration);
  const ranges = [];
  if (usable.length >= 4) {
    transcriptLines(usable, { maxWords: 12, maxSeconds: 5 }).forEach((line, i) => {
      if (i % 2 === 1 && line.end - line.start >= 0.8) ranges.push([Math.max(0, line.start - 0.05), Math.min(duration, line.end + 0.15)]);
    });
  } else {
    for (let t = 3; t < duration - 1; t += 6) ranges.push([t, Math.min(duration, t + 3)]);
  }
  return ranges.slice(0, 16);
}
