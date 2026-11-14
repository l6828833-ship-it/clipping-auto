/**
 * Caption layout and burn-in, shared by the editor preview and the renderer.
 *
 * Everything that decides WHAT a caption looks like lives here so the preview
 * in the browser and the ASS file handed to ffmpeg/libass cannot drift apart:
 * which words share a line, when each line is on screen, which font is used
 * for Arabic text, and how each design ("preset") highlights the spoken word.
 *
 * Plain JavaScript on purpose: the server bundle imports this file directly.
 * Types for the client are in captions.d.mts.
 */

export const CAPTION_CANVAS_W = 1080;
export const CAPTION_CANVAS_H = 1920;

/** Vertical centre (percent of the frame) for each position preset. */
export const PRESET_Y = { top: 12, center: 50, bottom: 82 };

/**
 * Caption designs.
 *  - wordsPerLine: most words shown together.
 *  - uppercase:    default casing (the style's own `uppercase` wins when set).
 */
export const CAPTION_PRESETS = {
  pop: { label: "Word pop", hint: "One word at a time", wordsPerLine: 1, uppercase: true },
  karaoke: { label: "Karaoke", hint: "Line with the spoken word coloured", wordsPerLine: 3, uppercase: true },
  box: { label: "Boxed word", hint: "Spoken word on a colour block", wordsPerLine: 3, uppercase: true },
  impact: { label: "Big word", hint: "Spoken word grows and changes colour", wordsPerLine: 2, uppercase: true },
  clean: { label: "Clean bar", hint: "Sentence case on a dark bar", wordsPerLine: 5, uppercase: false },
};
export const CAPTION_PRESET_IDS = Object.keys(CAPTION_PRESETS);

export const DEFAULT_CAPTION_STYLE = {
  preset: "pop",
  font: "Montserrat",
  fontSize: 72,
  color: "#FFFFFF",
  highlightColor: "#FFE600",
  position: "bottom",
  outline: true,
};

/** Bundled families that contain Arabic glyphs (see assets/fonts/README.md). */
export const ARABIC_FONTS = ["Tajawal", "Almarai"];
export const DEFAULT_ARABIC_FONT = ARABIC_FONTS[0];

const ARABIC_RE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
/** Harakat and tatweel: they add clutter at caption sizes and no meaning. */
const ARABIC_MARKS_RE = /[ً-ٰٟـ]/g;
const SENTENCE_END_RE = /[.!?؟…]["'»)\]]*$/;

export function hasArabic(text) {
  return ARABIC_RE.test(text ?? "");
}

/**
 * The family actually used for `text`. Latin display fonts have no Arabic
 * glyphs, so libass would silently substitute a system font (or draw boxes on
 * a server that has none). Arabic text is routed to a bundled Arabic family.
 */
export function captionFontFor(style, text) {
  const font = style?.font || DEFAULT_CAPTION_STYLE.font;
  if (!hasArabic(text)) return font;
  return ARABIC_FONTS.includes(font) ? font : DEFAULT_ARABIC_FONT;
}

export function resolveCaptionStyle(style) {
  const merged = { ...DEFAULT_CAPTION_STYLE, ...(style ?? {}) };
  if (!CAPTION_PRESETS[merged.preset]) merged.preset = DEFAULT_CAPTION_STYLE.preset;
  if (typeof merged.uppercase !== "boolean") merged.uppercase = CAPTION_PRESETS[merged.preset].uppercase;
  return merged;
}

/** Removes transcript noise: speaker markers, [music], HTML entities, tags. */
export function cleanWord(raw) {
  return String(raw ?? "")
    .replace(/>>+/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/[♪♫♬♩▪●]/g, "")
    .replace(/\*{2,}/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&#39;|&apos;|&quot;/gi, "")
    .replace(/-{2,}/g, "")
    .trim();
}

/** The text drawn for one word under a style. */
export function displayWord(raw, style) {
  let word = cleanWord(raw).replace(ARABIC_MARKS_RE, "");
  /* Commas and full stops read as noise in short on-screen lines; question
   * and exclamation marks carry tone, so they stay. */
  if (style?.preset !== "clean") word = word.replace(/^[«"“(]+/, "").replace(/[.,،؛;:»"”)]+$/, "");
  if (style?.uppercase) word = word.toUpperCase();
  return word;
}

/** Approximate advance width of a bold glyph, as a fraction of font size. */
function charFactor(text, uppercase) {
  if (hasArabic(text)) return 0.5;
  return uppercase ? 0.66 : 0.56;
}

const USABLE_W = CAPTION_CANVAS_W - 120;

function estimateWidth(text, fontSize, uppercase) {
  return text.length * fontSize * charFactor(text, uppercase);
}

/** Scale (0.55–1) that keeps `text` inside the frame on one line. */
export function captionFitScale(text, style) {
  const s = resolveCaptionStyle(style);
  const bump = s.preset === "impact" ? 1.08 : 1;
  const width = estimateWidth(text, s.fontSize, s.uppercase) * bump;
  if (width <= USABLE_W) return 1;
  return Math.max(0.55, USABLE_W / width);
}

/**
 * Splits timed words into on-screen lines.
 *
 * A line ends when it is full (word count or width), when the speaker pauses,
 * at the end of a sentence, or when the next word carries its own position.
 * Returns groups of `{ start, end, words: [{ text, start, end, index, posX, posY }] }`
 * where `index` points back into the input array.
 */
export function groupCaptionWords(words, style, clipDuration = Infinity) {
  const s = resolveCaptionStyle(style);
  const preset = CAPTION_PRESETS[s.preset];
  const maxWords = preset.wordsPerLine;
  const PAUSE = 0.6;
  const groups = [];
  let current = null;
  let prev = null;
  const list = Array.isArray(words) ? words : [];
  for (let index = 0; index < list.length; index++) {
    const w = list[index];
    const text = displayWord(w.word, s);
    if (!text) continue;
    const item = { text, start: Math.max(0, w.start), end: w.end, index, posX: w.posX, posY: w.posY };
    const joined = current ? `${current.words.map((x) => x.text).join(" ")} ${text}` : text;
    const breakHere = !current
      || current.words.length >= maxWords
      || (current.words.length > 0 && estimateWidth(joined, s.fontSize, s.uppercase) > USABLE_W)
      || (prev && item.start - prev.end > PAUSE)
      || (prev && SENTENCE_END_RE.test(cleanWord(list[prev.index].word)))
      || item.posX != null || item.posY != null;
    if (breakHere) {
      current = { start: item.start, end: item.end, words: [] };
      groups.push(current);
    }
    current.words.push(item);
    current.end = Math.max(current.end, item.end);
    prev = item;
  }
  /* Timing: a word stays lit until the next one starts; the line lingers
   * briefly after its last word unless the next line needs the screen. */
  const HOLD = maxWords === 1 ? 0 : 0.35;
  const MAX_WORD = 1.2;
  const MIN_WORD = 0.12;
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    const nextGroupStart = g + 1 < groups.length ? groups[g + 1].start : Infinity;
    for (let i = 0; i < group.words.length; i++) {
      const w = group.words[i];
      const last = i === group.words.length - 1;
      const limit = last ? nextGroupStart : group.words[i + 1].start;
      let end = last ? Math.min(w.end + HOLD, w.start + MAX_WORD + HOLD, limit) : limit;
      if (maxWords === 1) end = Math.min(w.end, limit, w.start + MAX_WORD);
      if (end < w.start + MIN_WORD) end = Math.min(w.start + MIN_WORD, limit);
      w.showUntil = Math.min(end, clipDuration);
    }
    group.end = group.words[group.words.length - 1].showUntil;
  }
  return groups.filter((group) => group.end > group.start);
}

/** The line and lit word at time `t` (seconds in the clip), or null. */
export function captionAt(groups, t) {
  for (const group of groups) {
    if (t < group.start) return null;
    if (t >= group.end) continue;
    let active = 0;
    for (let i = 0; i < group.words.length; i++) {
      if (t >= group.words[i].start) active = i;
    }
    return { group, activeIndex: active };
  }
  return null;
}

/** Black or white, whichever reads better on `hex`. */
export function contrastOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? "").trim());
  if (!m) return "#000000";
  const n = parseInt(m[1], 16);
  const luma = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return luma > 150 ? "#000000" : "#FFFFFF";
}

/* ─── ASS output ─────────────────────────────────────────────────────────── */

export function toAssColor(hex, alpha = "00") {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? "").trim());
  if (!m) return `&H${alpha}FFFFFF`;
  const rgb = m[1];
  return `&H${alpha}${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}`.toUpperCase();
}

export function toAssTime(seconds) {
  const cs = Math.round(Math.max(0, seconds) * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

export function escapeAssText(text) {
  return String(text ?? "").replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}").replace(/\r?\n/g, " ").trim();
}

export function resolveCaptionAnchor(style, word) {
  const xPct = word?.posX ?? style.posX;
  const yPct = word?.posY ?? style.posY;
  if (xPct == null && yPct == null) return null;
  const clamp = (v) => Math.min(100, Math.max(0, v));
  return {
    x: Math.round(clamp(xPct ?? 50) / 100 * CAPTION_CANVAS_W),
    y: Math.round(clamp(yPct ?? PRESET_Y[style.position] ?? 82) / 100 * CAPTION_CANVAS_H),
  };
}

/** ASS text for one line with word `active` lit (-1 lights nothing). */
function lineText(group, active, s, scale, colours) {
  const pct = Math.round(scale * 100);
  const big = Math.round(scale * 115);
  return group.words.map((w, i) => {
    const text = escapeAssText(w.text);
    if (i !== active) return text;
    switch (s.preset) {
      case "impact":
        return `{\\c${colours.highlight}\\fscx${big}\\fscy${big}}${text}{\\c${colours.primary}\\fscx${pct}\\fscy${pct}}`;
      case "box":
        return `{\\c${colours.onHighlight}\\bord0}${text}{\\c${colours.primary}\\bord${colours.outline}}`;
      default:
        return `{\\c${colours.highlight}}${text}{\\c${colours.primary}}`;
    }
  }).join(" ");
}

/**
 * Builds the ASS subtitle file burned into a clip.
 *
 * `synced` is false when timings were estimated from plain text; lines are
 * then shown without lighting individual words, since the guess would be
 * visibly wrong.
 */
export function buildAssFile(words, style, clipDuration, synced = true, overlays = []) {
  const s = resolveCaptionStyle(style);
  const fontSize = Math.max(16, Math.round(s.fontSize));
  const alignment = s.position === "top" ? 8 : s.position === "center" ? 5 : 2;
  const marginV = s.position === "center" ? 0 : Math.round(CAPTION_CANVAS_H * 0.12);
  const outline = s.outline ? Math.max(2, Math.round(fontSize * 0.09)) : 0;
  const colours = {
    primary: toAssColor(s.color),
    highlight: toAssColor(s.highlightColor),
    onHighlight: toAssColor(contrastOn(s.highlightColor)),
    outline,
  };
  const allText = (words ?? []).map((w) => w.word).join(" ");
  const font = captionFontFor(s, allText);
  const boxPad = Math.max(6, Math.round(fontSize * 0.14));
  /* Encoding -1 lets libass pick each line's base direction from its text, so
   * Arabic lines run right-to-left and mixed Arabic/Latin lines order correctly. */
  const styleLine = (name, overrides = {}) => {
    const o = { borderStyle: 1, outline, outlineColour: "&H00000000", back: "&H00000000", shadow: 0, ...overrides };
    return `Style: ${name},${font},${fontSize},${colours.primary},${colours.primary},${o.outlineColour},${o.back},-1,0,0,0,100,100,0,0,${o.borderStyle},${o.outline},${o.shadow},${alignment},60,60,${marginV},-1`;
  };
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${CAPTION_CANVAS_W}`,
    `PlayResY: ${CAPTION_CANVAS_H}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    s.preset === "clean" ? styleLine("Default", { outline: 0 }) : styleLine("Default"),
    /* Dark bar for the "clean" design. Drawn as its own single-run layer:
     * translucent boxes from separate colour runs would overlap and show seams. */
    styleLine("Bar", { borderStyle: 3, outline: boxPad, outlineColour: "&H59000000", back: "&H59000000" }),
    /* Colour block behind the spoken word: an opaque-box copy of the line in
     * which only that word is visible. */
    styleLine("Box", { borderStyle: 3, outline: boxPad, outlineColour: colours.highlight, back: colours.highlight }),
    "Style: Overlay,Montserrat,54,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,0,5,60,60,0,-1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const events = [];
  const push = (layer, start, end, styleName, tags, text) => {
    if (end > start) events.push(`Dialogue: ${layer},${toAssTime(start)},${toAssTime(end)},${styleName},,0,0,0,,${tags ? `{${tags}}` : ""}${text}`);
  };
  const groups = groupCaptionWords(words, s, clipDuration);
  for (const group of groups) {
    const plain = group.words.map((w) => w.text).join(" ");
    const scale = captionFitScale(plain, s);
    const pct = Math.round(scale * 100);
    const anchor = resolveCaptionAnchor(s, group.words[0]);
    const pos = anchor ? `\\an5\\pos(${anchor.x},${anchor.y})` : "";
    const base = `${pos}${pct !== 100 ? `\\fscx${pct}\\fscy${pct}` : ""}`;
    /* A short scale-up when the line appears: reads as a "pop" without moving
     * the text afterwards. */
    const from = Math.round(pct * 0.82);
    const popIn = `\\fscx${from}\\fscy${from}\\t(0,90,\\fscx${pct}\\fscy${pct})`;
    const bar = (start, end, tags) => {
      if (s.preset === "clean") push(0, start, end, "Bar", `${tags}\\1a&HFF&`, escapeAssText(plain));
    };
    if (!synced) {
      const end = Math.min(group.end, clipDuration);
      bar(group.start, end, base);
      push(1, group.start, end, "Default", base, lineText(group, -1, s, scale, colours));
      continue;
    }
    for (let i = 0; i < group.words.length; i++) {
      const w = group.words[i];
      const start = w.start;
      const end = Math.min(w.showUntil, clipDuration);
      const intro = i === 0 && s.preset !== "impact" && s.preset !== "clean" ? popIn : "";
      const tags = `${base}${intro}`;
      if (s.preset === "box") {
        const boxed = group.words.map((x, j) => `{\\alpha&H${j === i ? "00" : "FF"}&}${escapeAssText(x.text)}`).join(" ");
        push(0, start, end, "Box", tags, boxed);
      }
      bar(start, end, tags);
      push(1, start, end, "Default", tags, lineText(group, i, s, scale, colours));
    }
  }
  for (const overlay of overlays ?? []) {
    const end = Math.min(overlay.end, clipDuration);
    if (end <= overlay.start || !String(overlay.text ?? "").trim()) continue;
    const x = Math.round(overlay.posX * CAPTION_CANVAS_W);
    const y = Math.round(overlay.posY * CAPTION_CANVAS_H);
    const fn = hasArabic(overlay.text) ? `\\fn${DEFAULT_ARABIC_FONT}` : "";
    const tag = `{\\an5\\pos(${x},${y})\\fs${overlay.fontSize}\\c${toAssColor(overlay.color)}${fn}}`;
    push(2, overlay.start, end, "Overlay", "", `${tag}${escapeAssText(overlay.text)}`);
  }
  return `${header.join("\n")}\n${events.join("\n")}\n`;
}
