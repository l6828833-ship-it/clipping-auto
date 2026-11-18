export type VideoStyleId = "normal" | "dynamic" | "podcast" | "cinematic" | "viral" | "gameplay" | "gaming" | "satisfying" | "dual" | "reaction";
export type VideoLayout = { style: VideoStyleId; backgroundVideoId?: number | null };
export const VIDEO_STYLES: Record<VideoStyleId, { label: string; hint: string; group: string; split?: "background" | "dual" | "reaction" | "gaming" }>;
export type SourceRegion = { x: number; y: number; w: number; h: number };
export type GamingSplit = { top: SourceRegion; bottom: SourceRegion };
export const VIDEO_STYLE_IDS: VideoStyleId[];
export const AI_VIDEO_STYLES: VideoStyleId[];
/** Caption settings a person can choose; the ones in a style's `own` beat the video style. */
export type OwnableCaptionField = "preset" | "fontSize" | "color" | "highlightColor" | "position" | "outline";
export const OWNABLE_CAPTION_FIELDS: OwnableCaptionField[];
export function montageCaptionStyle<T extends Record<string, unknown>>(styleId: string | null | undefined, style: T): T;
/** Clip-relative `[start, end]` ranges the Dynamic Zoom style punches in on. */
export function punchIns(words: { word?: string; start: number; end?: number }[] | null | undefined, duration: number): [number, number][];
