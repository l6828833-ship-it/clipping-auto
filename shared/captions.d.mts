export type CaptionPresetId = "pop" | "karaoke" | "box" | "impact" | "clean";

export type CaptionStyle = {
  /** Caption design. */
  preset?: CaptionPresetId;
  /** Overrides the design's default casing. */
  uppercase?: boolean;
  font: string;
  /** Pixel height on a 1080-wide canvas. */
  fontSize: number;
  color: string;
  highlightColor: string;
  position: "top" | "center" | "bottom";
  outline: boolean;
  /** Free position as a percentage of the frame (0-100), to the text centre. */
  posX?: number;
  posY?: number;
};

export type CaptionWord = { word: string; start: number; end: number; posX?: number; posY?: number };
export type CaptionGroupWord = { text: string; start: number; end: number; index: number; showUntil: number; posX?: number; posY?: number };
export type CaptionGroup = { start: number; end: number; words: CaptionGroupWord[] };

export const CAPTION_CANVAS_W: number;
export const CAPTION_CANVAS_H: number;
export const PRESET_Y: { top: number; center: number; bottom: number };
export const CAPTION_PRESETS: Record<CaptionPresetId, { label: string; hint: string; wordsPerLine: number; uppercase: boolean }>;
export const CAPTION_PRESET_IDS: CaptionPresetId[];
export const DEFAULT_CAPTION_STYLE: CaptionStyle & { preset: CaptionPresetId };
export const ARABIC_FONTS: string[];
export const DEFAULT_ARABIC_FONT: string;
export function hasArabic(text: string): boolean;
export function captionFontFor(style: Partial<CaptionStyle>, text: string): string;
export function resolveCaptionStyle(style: Partial<CaptionStyle>): CaptionStyle & { preset: CaptionPresetId; uppercase: boolean };
export function cleanWord(raw: string): string;
export function displayWord(raw: string, style: Partial<CaptionStyle>): string;
export function captionFitScale(text: string, style: Partial<CaptionStyle>): number;
export function groupCaptionWords(words: CaptionWord[], style: Partial<CaptionStyle>, clipDuration?: number): CaptionGroup[];
export function captionAt(groups: CaptionGroup[], t: number): { group: CaptionGroup; activeIndex: number } | null;
export function contrastOn(hex: string): string;
export function buildAssFile(words: CaptionWord[], style: Partial<CaptionStyle>, clipDuration: number, synced?: boolean, overlays?: unknown[]): string;
