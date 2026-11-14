/**
 * Video styles ("montages") a clip can be exported in. Shared by the editor's
 * picker and the renderer. `split` says what fills the lower half of a
 * split-screen style; single-speaker styles have none.
 */
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
