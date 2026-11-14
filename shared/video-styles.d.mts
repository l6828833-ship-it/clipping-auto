export type VideoStyleId = "normal" | "dynamic" | "podcast" | "cinematic" | "viral" | "gameplay" | "satisfying" | "dual" | "reaction";
export type VideoLayout = { style: VideoStyleId; backgroundVideoId?: number | null };
export const VIDEO_STYLES: Record<VideoStyleId, { label: string; hint: string; group: string; split?: "background" | "dual" | "reaction" }>;
export const VIDEO_STYLE_IDS: VideoStyleId[];
export const AI_VIDEO_STYLES: VideoStyleId[];
