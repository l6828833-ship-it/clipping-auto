/**
 * What each video style does to a render: caption overrides, picture filters
 * and split-screen geometry. Pure functions; the ffmpeg graph is assembled in
 * the renderer.
 *
 * Split-screen styles stack two 1080x960 panels. The speaker panel reuses the
 * normal crop pipeline at that height, so framing offsets made for the 9:16
 * frame are converted to keep the same point of the source centred.
 */
import { VIDEO_STYLES } from "../shared/video-styles.mjs";
import { montageCaptionStyle, punchIns } from "../shared/video-styles.mjs";

export const PANEL_W = 1080;
export const PANEL_H = 960;

const clamp = (v, lo = -1, hi = 1) => Math.min(hi, Math.max(lo, v));

export function splitKind(styleId) {
  return VIDEO_STYLES[styleId]?.split ?? null;
}

export { montageCaptionStyle, punchIns };

const zoomPan = (z, fps, anchorY) =>
  `zoompan=z='${z}':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)*${anchorY}':d=1:s=${PANEL_W}x1920:fps=${fps}`;

/** ffmpeg filters applied to the finished 1080x1920 picture, before captions. */
export function montageFilters(styleId, { words, duration, fps }) {
  switch (styleId) {
    case "dynamic": {
      const ranges = punchIns(words, duration);
      if (!ranges.length) return [];
      const lit = ranges.map(([a, b]) => `between(it\\,${a.toFixed(2)}\\,${b.toFixed(2)})`).join("+");
      return [zoomPan(`1+0.16*(${lit})`, fps, 0.3)];
    }
    case "cinematic":
      return [
        "eq=contrast=1.1:brightness=-0.04:saturation=0.85",
        "colorbalance=rs=-0.05:bs=0.06:rh=0.05:bh=-0.05",
        "vignette=angle=PI/5",
        /* Zoom on a 2x canvas: zoompan rounds to whole pixels, which shows
         * as a shimmer on a slow move at native size. */
        "scale=2160:3840:flags=bicubic",
        zoomPan(`1+0.08*min(1\\,it/${Math.max(1, duration).toFixed(2)})`, fps, 0.35),
      ];
    case "podcast":
      return ["eq=contrast=1.04:saturation=1.05"];
    default:
      return [];
  }
}

/** Crop (zoom, offsets) that centres a face in a 1080x960 panel. */
function faceCrop(person, srcW, srcH, facePixels, maxZoom) {
  const cover = Math.max(PANEL_W / srcW, PANEL_H / srcH);
  const scaledW = srcW * cover, scaledH = srcH * cover;
  const zoom = clamp(facePixels / Math.max(1, person.w * scaledW), 1, maxZoom);
  const freeX = 1 - PANEL_W / (zoom * scaledW), freeY = 1 - PANEL_H / (zoom * scaledH);
  return {
    zoom: Math.round(zoom * 100) / 100,
    offsetX: freeX > 0.001 ? clamp((person.cx - 0.5) / (freeX / 2)) : 0,
    /* Aim a little below the face centre so the chin and shoulders show. */
    offsetY: freeY > 0.001 ? clamp((person.cy + 0.04 - 0.5) / (freeY / 2)) : 0,
  };
}

/** Crop that fills one half of the frame with one person of a two-person shot. */
export function facePanelCrop(person, srcW, srcH) {
  return faceCrop(person, srcW, srcH, 260, 2.2);
}

/** Stable faces near an edge are more likely to be a streamer's facecam. */
export function gamingSplitPlan(people, srcW, srcH) {
  if (!(srcW > 0 && srcH > 0)) return null;
  const edge = p => Math.min(p.cx, 1 - p.cx, p.cy, 1 - p.cy);
  const face = people.filter(p => p.share >= 0.45 && p.w > 0 && p.w <= 0.24 && p.h > 0 && p.h <= 0.4 && edge(p) <= 0.27)
    .sort((a, b) => (b.share - edge(b)) - (a.share - edge(a)))[0];
  if (!face) return null;

  const ratio = (PANEL_W / PANEL_H) * srcH / srcW;
  const h = Math.min(1, 1 / ratio, Math.max(3.4 * face.h, 3.2 * face.w / ratio, 0.12));
  const w = ratio * h;
  const top = { x: clamp(face.cx - w / 2, 0, 1 - w), y: clamp(face.cy + 0.25 * face.h - h / 2, 0, 1 - h), w, h };
  // Remove the smallest border strip that excludes the estimated camera
  // inset. When that would hide too much of the game, keep the full feed.
  const left = clamp(face.cx - 1.65 * face.w, 0, 1);
  const right = clamp(face.cx + 1.65 * face.w, 0, 1);
  const above = clamp(face.cy - 1.55 * face.h, 0, 1);
  const below = clamp(face.cy + 2.15 * face.h, 0, 1);
  const candidates = [
    { x: right, y: 0, w: 1 - right, h: 1 },
    { x: 0, y: 0, w: left, h: 1 },
    { x: 0, y: below, w: 1, h: 1 - below },
    { x: 0, y: 0, w: 1, h: above },
  ];
  const area = r => r.w * r.h;
  const best = candidates.sort((a, b) => area(b) - area(a))[0];
  return { top, bottom: area(best) >= 0.72 ? best : { x: 0, y: 0, w: 1, h: 1 } };
}

export function gamingPanelFilter(region, srcW, srcH) {
  const even = n => Math.floor(n / 2) * 2;
  const x = even(region.x * srcW), y = even(region.y * srcH);
  const w = Math.max(2, even(Math.min(region.w * srcW, srcW - x)));
  const h = Math.max(2, even(Math.min(region.h * srcH, srcH - y)));
  return `crop=${w}:${h}:${x}:${y},scale=${PANEL_W}:${PANEL_H}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,pad=${PANEL_W}:${PANEL_H}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p`;
}

/**
 * Geometry for a split-screen render.
 * Returns `{ crop, segments, bottom }` for the top panel and what goes below:
 * `{ type: "background" }` or `{ type: "source", crop }`. Null means the
 * style cannot be built from what was found (not enough faces).
 */
export function planSplit({ kind, people = [], gaming, srcW, srcH, crop, segments }) {
  if (!(srcW > 0 && srcH > 0)) return null;
  if (kind === "background") {
    /* Keep the same source point centred in the wider panel. */
    const aspect = srcW / srcH;
    const keptTall = (9 / 16) / aspect, keptPanel = (PANEL_W / PANEL_H) / aspect;
    const factor = keptPanel < 0.999 && keptTall < 0.999 ? (1 - keptTall) / (1 - keptPanel) : 0;
    const shift = (c) => ({ ...c, offsetX: clamp((c.offsetX ?? 0) * factor) });
    return {
      crop: shift(crop),
      segments: Array.isArray(segments) ? segments.map((s) => ({ ...shift(s), ...(s.to ? { to: shift(s.to) } : {}) })) : segments,
      bottom: { type: "background" },
    };
  }
  if (kind === "reaction") {
    if (people.length < 1) return null;
    return { crop: { ...crop, ...faceCrop(people[0], srcW, srcH, 320, 3.5) }, segments: [], bottom: { type: "source", crop: { ...crop, zoom: 1, offsetX: 0, offsetY: 0 } } };
  }
  if (kind === "gaming" && gaming) {
    return { crop, segments: [], bottom: { type: "gameplay", region: gaming.bottom } };
  }
  return null;
}
