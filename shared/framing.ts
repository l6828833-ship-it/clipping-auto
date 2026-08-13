/** A static crop position. */
export interface Crop {
  zoom: number;
  offsetX: number;
  offsetY: number;
}

/** Supported easing functions. */
export type Ease = "linear" | "in" | "out" | "inOut";

export const EASES: Ease[] = ["linear", "in", "out", "inOut"];
export const EASE_LABELS: Record<Ease, string> = {
  linear: "Linear",
  in: "Ease In",
  out: "Ease Out",
  inOut: "Smooth",
};

/** A time-varying crop segment. */
export interface FramingSegment extends Crop {
  start: number;
  end: number;
  ease?: Ease;
  /** Target crop for animated segments. */
  to?: Crop;
  /** Progress window start (0-1). */
  easeFrom?: number;
  /** Progress window end (0-1). */
  easeTo?: number;
}

export const DEFAULT_ZOOM_LENGTH = 2;

const EASE_FN: Record<Ease, (p: number) => number> = {
  linear: (p) => p,
  in: (p) => p * p,
  out: (p) => 1 - (1 - p) * (1 - p),
  inOut: (p) => p * p * (3 - 2 * p),
};

export function easeExpr(ease: Ease, p: string): string {
  switch (ease) {
    case "linear": return `(${p})`;
    case "in": return `((${p})*(${p}))`;
    case "out": return `(1-(1-(${p}))*(1-(${p})))`;
    case "inOut": return `((${p})*(${p})*(3-2*(${p})))`;
  }
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function interpolateCrop(from: Crop, to: Crop, ease: Ease, progress: number): Crop {
  const e = EASE_FN[ease](clamp01(progress));
  const z0 = Math.max(0.01, from.zoom), z1 = Math.max(0.01, to.zoom);
  return {
    zoom: z0 * Math.pow(z1 / z0, e),
    offsetX: from.offsetX + (to.offsetX - from.offsetX) * e,
    offsetY: from.offsetY + (to.offsetY - from.offsetY) * e,
  };
}

export function segmentTarget(seg: FramingSegment): Crop {
  return seg.to ?? { zoom: seg.zoom, offsetX: seg.offsetX, offsetY: seg.offsetY };
}

export function isAnimated(seg: FramingSegment): boolean {
  if (!seg.to) return false;
  const t = seg.to;
  return Math.abs(t.zoom - seg.zoom) > 1e-3 ||
    Math.abs(t.offsetX - seg.offsetX) > 1e-3 ||
    Math.abs(t.offsetY - seg.offsetY) > 1e-3;
}

function easeWindow(seg: FramingSegment): [number, number] {
  return [clamp01(seg.easeFrom ?? 0), clamp01(seg.easeTo ?? 1)];
}

function curveProgress(seg: FramingSegment, localProgress: number): number {
  const [p0, p1] = easeWindow(seg);
  return p0 + (p1 - p0) * clamp01(localProgress);
}

export function framingAt(seg: FramingSegment, timeInClip: number): Crop {
  const span = seg.end - seg.start;
  if (!isAnimated(seg) || span <= 0) {
    return { zoom: seg.zoom, offsetX: seg.offsetX, offsetY: seg.offsetY };
  }
  const local = (timeInClip - seg.start) / span;
  return interpolateCrop(seg, segmentTarget(seg), seg.ease ?? "inOut", curveProgress(seg, local));
}

function sliceSegment(seg: FramingSegment, start: number, end: number): FramingSegment {
  const span = seg.end - seg.start;
  if (!isAnimated(seg) || span <= 0) return { ...seg, start, end };
  return {
    ...seg,
    start,
    end,
    easeFrom: curveProgress(seg, (start - seg.start) / span),
    easeTo: curveProgress(seg, (end - seg.start) / span),
  };
}

/** Find the index of the segment at a given time. Returns undefined if none found. */
export function segmentAt(segments: FramingSegment[], time: number): number | undefined {
  const idx = segments.findIndex(s => time >= s.start && time < s.end);
  return idx >= 0 ? idx : undefined;
}

/** Ensure segments cover a full duration with no gaps. */
export function materialiseSegments(raw: FramingSegment[] | null | undefined, duration: number, fallback?: Crop): FramingSegment[] {
  const def: Crop = fallback ?? { zoom: 1, offsetX: 0, offsetY: 0 };
  if (!raw || raw.length === 0) return [{ ...def, start: 0, end: duration }];
  const sorted = [...raw].sort((a, b) => a.start - b.start);
  const result: FramingSegment[] = [];
  let cursor = 0;
  for (const seg of sorted) {
    if (seg.start > cursor) {
      result.push({ ...def, start: cursor, end: seg.start });
    }
    result.push(seg);
    cursor = seg.end;
  }
  if (cursor < duration) {
    result.push({ ...def, start: cursor, end: duration });
  }
  return result;
}

/** Split a segment at a given time. */
export function splitSegmentAt(segments: FramingSegment[], time: number): FramingSegment[] {
  const idx = segments.findIndex(s => time > s.start && time < s.end);
  if (idx < 0) return segments;
  const seg = segments[idx];
  const left = sliceSegment(seg, seg.start, time);
  const right = sliceSegment(seg, time, seg.end);
  return [...segments.slice(0, idx), left, right, ...segments.slice(idx + 1)];
}

/** Insert a zoom segment at a given time. */
export function insertZoomAt(segments: FramingSegment[], time: number, crop: Crop, length = DEFAULT_ZOOM_LENGTH): FramingSegment[] {
  const end = time + length;
  const result: FramingSegment[] = [];
  for (const seg of segments) {
    if (seg.end <= time || seg.start >= end) {
      result.push(seg);
    } else {
      if (seg.start < time) result.push(sliceSegment(seg, seg.start, time));
      if (seg.end > end) result.push(sliceSegment(seg, end, seg.end));
    }
  }
  result.push({ ...crop, start: time, end });
  return result.sort((a, b) => a.start - b.start);
}

/** Trim a segment edge (resize). */
export function trimSegmentEdge(segments: FramingSegment[], idx: number, edge: "start" | "end", newTime: number): FramingSegment[] {
  const copy = [...segments];
  const seg = { ...copy[idx] };
  if (edge === "start") {
    seg.start = Math.max(0, Math.min(seg.end - 0.1, newTime));
  } else {
    seg.end = Math.max(seg.start + 0.1, newTime);
  }
  copy[idx] = seg;
  return copy;
}

/** Shift a segment in time. */
export function shiftSegment(segments: FramingSegment[], idx: number, delta: number): FramingSegment[] {
  const copy = [...segments];
  const seg = { ...copy[idx] };
  seg.start += delta;
  seg.end += delta;
  copy[idx] = seg;
  return copy;
}

/** Remove a segment. */
export function removeSegmentAt(segments: FramingSegment[], idx: number): FramingSegment[] {
  return segments.filter((_, i) => i !== idx);
}

/** Set the from or to keyframe of a segment. */
export function setSegmentKeyframe(segments: FramingSegment[], idx: number, keyframe: "from" | "to", crop: Crop): FramingSegment[] {
  const copy = [...segments];
  const seg = { ...copy[idx] };
  if (keyframe === "from") {
    seg.zoom = crop.zoom;
    seg.offsetX = crop.offsetX;
    seg.offsetY = crop.offsetY;
  } else {
    seg.to = crop;
  }
  copy[idx] = seg;
  return copy;
}

/** Set a segment to animated (moving) or static. */
export function setSegmentMoving(segments: FramingSegment[], idx: number, moving: boolean): FramingSegment[] {
  const copy = [...segments];
  const seg = { ...copy[idx] };
  if (moving && !seg.to) {
    seg.to = { zoom: seg.zoom, offsetX: seg.offsetX, offsetY: seg.offsetY };
  } else if (!moving) {
    delete seg.to;
  }
  copy[idx] = seg;
  return copy;
}

/** Set the ease of a segment. */
export function setSegmentEase(segments: FramingSegment[], idx: number, ease: Ease): FramingSegment[] {
  const copy = [...segments];
  copy[idx] = { ...copy[idx], ease };
  return copy;
}

/** Chain the end of one segment to the start of the next. */
export function chainToNext(segments: FramingSegment[], idx: number): FramingSegment[] {
  if (idx >= segments.length - 1) return segments;
  const copy = [...segments];
  const current = { ...copy[idx] };
  const next = copy[idx + 1];
  const target = segmentTarget(current);
  current.to = { zoom: next.zoom, offsetX: next.offsetX, offsetY: next.offsetY };
  if (!isAnimated(current)) {
    current.to = target;
  }
  copy[idx] = current;
  return copy;
}

/** Check if there's a visual jump after this segment. */
export function hasJumpAfter(segments: FramingSegment[], idx: number): boolean {
  if (idx >= segments.length - 1) return false;
  const endCrop = segmentTarget(segments[idx]);
  const next = segments[idx + 1];
  return Math.abs(endCrop.zoom - next.zoom) > 1e-3 ||
    Math.abs(endCrop.offsetX - next.offsetX) > 1e-3 ||
    Math.abs(endCrop.offsetY - next.offsetY) > 1e-3;
}
