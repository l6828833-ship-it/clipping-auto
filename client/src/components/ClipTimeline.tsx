import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Plus, Trash2, Scissors, Type, Maximize2, Clock, ZoomIn, ZoomOut,
  MoveRight, Link2, TrendingUp, Eye, EyeOff, Lock, Unlock, MousePointer2,
  Music, Volume2, VolumeX, Youtube, Upload, X, AlertCircle,
} from "lucide-react";
import { formatTime, parseYouTubeId } from "@/lib/videoSource";
import {
  type Crop, type Ease, type FramingSegment, EASES, EASE_LABELS,
  materialiseSegments, splitSegmentAt, insertZoomAt, trimSegmentEdge, shiftSegment,
  removeSegmentAt, setSegmentKeyframe, setSegmentMoving, setSegmentEase,
  chainToNext, hasJumpAfter, isAnimated, segmentTarget, framingAt,
  DEFAULT_ZOOM_LENGTH,
} from "@shared/framing";

export type { FramingSegment };
/** Which end of a moving segment the preview is editing. */
export type Keyframe = "from" | "to";

/**
 * Timeline editor for a clip.
 *
 * Two tracks over one shared time axis:
 *  - Framing: time ranges each with their own zoom/pan, so the crop can follow
 *    a different subject in different parts of the clip.
 *  - Subtitles: one block per word, which can be trimmed, moved, split and
 *    retyped.
 *
 * The axis is measured in pixels per second rather than percentages so it can
 * be zoomed in: at word level a block is only a few percent wide, which is too
 * small to grab. Both tracks live in the same scroll container so they stay
 * aligned when panned.
 *
 * All times are clip-relative seconds, matching what the renderer expects.
 */

export type TimelineWord = { word: string; start: number; end: number };

/** A text overlay block that appears at a specific time range on the clip. */
export type TextOverlay = {
  id: string;
  text: string;
  start: number;
  end: number;
  /** Horizontal position 0-1 (0.5 = centred). */
  posX: number;
  /** Vertical position 0-1 (0.1 = near top, 0.9 = near bottom). */
  posY: number;
  fontSize: number;
  color: string;
};

/** Shortest a word block may become, in seconds. */
const MIN_WORD = 0.05;
/** How close, on screen, an edge must be to a timestamp before it snaps. */
const SNAP_PX = 8;
/** Pointer travel before an interaction counts as a drag rather than a click. */
const DRAG_THRESHOLD_PX = 3;
/** Zoom range, as a multiple of "the whole clip fits the viewport". */
const MAX_ZOOM = 40;

// ─── Editing operations ───────────────────────────────────────────────────────
// Kept as pure functions so the timing rules can be reasoned about and tested
// independently of the pointer handling.

/**
 * Nearest timestamp worth snapping to, or the input when nothing is close.
 *
 * `tolerance` is in seconds so the caller can convert from a pixel threshold at
 * the current zoom: snapping should feel the same distance on screen however far
 * in the timeline is zoomed.
 */
export function snapToTargets(time: number, targets: number[], tolerance: number): number {
  let best = time, bestDist = Infinity;
  for (const target of targets) {
    const d = Math.abs(target - time);
    if (d < bestDist && d <= tolerance) { best = target; bestDist = d; }
  }
  return best;
}

/** Moves one edge of a block, keeping it valid and clear of its neighbours. */
export function trimWordEdge(
  words: TimelineWord[], index: number, edge: "start" | "end", time: number, duration: number
): TimelineWord[] {
  const w = words[index];
  if (!w) return words;

  if (edge === "start") {
    const floor = index > 0 ? words[index - 1].end : 0;
    const start = Math.max(floor, Math.min(w.end - MIN_WORD, time));
    return words.map((x, i) => (i === index ? { ...x, start } : x));
  }
  const ceiling = index < words.length - 1 ? words[index + 1].start : duration;
  const end = Math.min(ceiling, Math.max(w.start + MIN_WORD, time));
  return words.map((x, i) => (i === index ? { ...x, end } : x));
}

/** Moves a block to a new start time without changing how long it lasts. */
export function shiftWordTo(
  words: TimelineWord[], index: number, newStart: number, duration: number
): TimelineWord[] {
  const w = words[index];
  if (!w) return words;
  const length = w.end - w.start;
  const floor = index > 0 ? words[index - 1].end : 0;
  const ceiling = (index < words.length - 1 ? words[index + 1].start : duration) - length;
  // A block wedged between two neighbours cannot move; never let the clamp
  // invert and fling it backwards.
  const start = Math.max(floor, Math.min(Math.max(floor, ceiling), newStart));
  return words.map((x, i) => (i === index ? { ...x, start, end: start + length } : x));
}

/**
 * Cuts the block spanning `time` into two.
 *
 * A block holding several words splits its text at the nearest space, which is
 * the useful case for grouped captions. A single word keeps its text on both
 * halves so the user can retype one of them.
 */
export function splitWordAtTime(
  words: TimelineWord[], time: number
): { words: TimelineWord[]; selectIndex: number | null } {
  const index = words.findIndex(w => time > w.start + MIN_WORD && time < w.end - MIN_WORD);
  if (index === -1) return { words, selectIndex: null };

  const w = words[index];
  const ratio = (time - w.start) / (w.end - w.start);
  let firstText = w.word, secondText = w.word;

  const pieces = w.word.trim().split(/\s+/).filter(Boolean);
  if (pieces.length > 1) {
    const at = Math.max(1, Math.min(pieces.length - 1, Math.round(pieces.length * ratio)));
    firstText = pieces.slice(0, at).join(" ");
    secondText = pieces.slice(at).join(" ");
  }

  return {
    words: [
      ...words.slice(0, index),
      { ...w, word: firstText, end: time },
      { ...w, word: secondText, start: time },
      ...words.slice(index + 1),
    ],
    // The later half is the one that usually needs retyping.
    selectIndex: index + 1,
  };
}

/** Whether there is a block the playhead could cut. */
export function canSplitAt(words: TimelineWord[], time: number | undefined): boolean {
  if (time == null) return false;
  return words.some(w => time > w.start + MIN_WORD && time < w.end - MIN_WORD);
}

/** Tracks an element's width so the axis can be sized in real pixels. */
function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, width] as const;
}

// ─── Layout ───────────────────────────────────────────────────────────────────

/** Width of the track headers, which do not scroll with the time axis. */
const SIDEBAR_W = 152;
/** Height of the time ruler. */
const RULER_H = 28;

/** What clicking a block does. */
export type Tool = "select" | "split" | "delete";

const TOOL_HINT: Record<Tool, string> = {
  select: "Click to select, drag to move, drag an edge to trim.",
  split: "Click a block to cut it in two at that point.",
  delete: "Click a block to remove it.",
};

/**
 * The tracks, declared once and used to build both the headers and the lanes so
 * the two can never drift out of vertical alignment.
 */
const TRACKS = [
  { id: "framing" as const, name: "Video Flow", kind: "Framing & zoom", height: 62 },
  { id: "subtitle" as const, name: "Subtitle Flow", kind: "Words", height: 46 },
  { id: "text" as const, name: "Text", kind: "Overlays", height: 46 },
  { id: "music" as const, name: "Music", kind: "Background audio", height: 46 },
];
type TrackId = (typeof TRACKS)[number]["id"];

// ─── Music track types ────────────────────────────────────────────────────────

/** A volume keyframe: at `time` seconds the volume reaches `volume` (0–1). */
export type VolumeKeyframe = { time: number; volume: number };

/** Everything the music track needs to know about its audio source. */
export type MusicTrack = {
  /** YouTube video URL (or short ID) or object-URL from a file upload. */
  src: string;
  /** Display name, e.g. the filename or a YouTube title. */
  label: string;
  /** Offset into the audio where playback starts (seconds). */
  offset: number;
  /** Per-frame volume envelope. Two points minimum; sorted by time. */
  keyframes: VolumeKeyframe[];
};

export function ClipTimeline({
  duration,
  segments,
  onSegmentsChange,
  selectedSegment,
  onSelectSegment,
  words,
  onWordsChange,
  playheadSeconds,
  onScrub,
  baseFraming,
  editingKeyframe = "from",
  onEditingKeyframeChange,
  music,
  onMusicChange,
  textOverlays,
  onTextOverlaysChange,
}: {
  /** Clip length in seconds. */
  duration: number;
  segments: FramingSegment[];
  onSegmentsChange: (next: FramingSegment[]) => void;
  /** Index of the segment being reframed, or null for the whole clip. */
  selectedSegment: number | null;
  onSelectSegment: (index: number | null) => void;
  words: TimelineWord[];
  onWordsChange: (next: TimelineWord[]) => void;
  playheadSeconds?: number;
  onScrub?: (seconds: number) => void;
  /** Framing used for the clip when no segments exist yet. */
  baseFraming: Crop;
  /** Which end of a moving segment the preview edits. */
  editingKeyframe?: Keyframe;
  onEditingKeyframeChange?: (k: Keyframe) => void;
  /** Current music track, or null when no music is attached. */
  music?: MusicTrack | null;
  onMusicChange?: (next: MusicTrack | null) => void;
  /** Text overlays on the clip. */
  textOverlays?: TextOverlay[];
  onTextOverlaysChange?: (next: TextOverlay[]) => void;
}) {
  const [scrollRef, viewportWidth] = useElementWidth<HTMLDivElement>();
  const laneRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [tool, setTool] = useState<Tool>("select");
  const [editingWord, setEditingWord] = useState<number | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const movedRef = useRef(false);

  /** Per-track visibility and locking, which genuinely gate editing. */
  const [hidden, setHidden] = useState<Record<TrackId, boolean>>({ framing: false, subtitle: false, text: false, music: false });
  const [locked, setLocked] = useState<Record<TrackId, boolean>>({ framing: false, subtitle: false, text: false, music: false });

  // ─── Music track UI state ────────────────────────────────────────────────────
  const [musicInputMode, setMusicInputMode] = useState<"youtube" | "upload" | null>(null);
  const [musicUrl, setMusicUrl] = useState("");
  const [editingKf, setEditingKf] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [musicUrlError, setMusicUrlError] = useState<string | null>(null);

  const addMusicFromUrl = () => {
    const raw = musicUrl.trim();
    if (!raw) return;

    const ytId = parseYouTubeId(raw);
    if (!ytId) {
      setMusicUrlError("Not a valid YouTube URL — try https://youtube.com/watch?v=…");
      return;
    }

    setMusicUrlError(null);
    // Canonical embed URL from the video ID.
    const canonicalUrl = `https://www.youtube.com/watch?v=${ytId}`;
    const label = raw.length > 44 ? `youtube.com/watch?v=${ytId}` : raw;

    onMusicChange?.({
      src: canonicalUrl,
      label,
      offset: 0,
      keyframes: [
        { time: 0, volume: 1 },
        { time: Math.max(1, duration), volume: 1 },
      ],
    });
    setMusicUrl("");
    setMusicInputMode(null);
  };

  const handleMusicFile = (file: File) => {
    const url = URL.createObjectURL(file);
    onMusicChange?.({
      src: url,
      label: file.name,
      offset: 0,
      keyframes: [
        { time: 0, volume: 1 },
        { time: Math.max(1, duration), volume: 1 },
      ],
    });
    setMusicInputMode(null);
  };

  const updateKfVolume = (idx: number, volume: number) => {
    if (!music) return;
    const kfs = music.keyframes.map((k, i) => i === idx ? { ...k, volume } : k);
    onMusicChange?.({ ...music, keyframes: kfs });
  };

  const addKfAtPlayhead = () => {
    if (!music || playheadSeconds == null) return;
    const t = playheadSeconds;
    const already = music.keyframes.some(k => Math.abs(k.time - t) < 0.05);
    if (already) return;
    // Interpolate volume at t from adjacent keyframes.
    const sorted = [...music.keyframes].sort((a, b) => a.time - b.time);
    let vol = 1;
    const before = sorted.filter(k => k.time <= t);
    const after = sorted.filter(k => k.time > t);
    if (before.length && after.length) {
      const b = before[before.length - 1], a = after[0];
      const frac = (t - b.time) / Math.max(0.001, a.time - b.time);
      vol = b.volume + (a.volume - b.volume) * frac;
    } else if (before.length) {
      vol = before[before.length - 1].volume;
    } else if (after.length) {
      vol = after[0].volume;
    }
    const newKfs = [...music.keyframes, { time: t, volume: Math.round(vol * 100) / 100 }]
      .sort((a, b) => a.time - b.time);
    const newIdx = newKfs.findIndex(k => k.time === t);
    onMusicChange?.({ ...music, keyframes: newKfs });
    setEditingKf(newIdx);
  };

  const removeKf = (idx: number) => {
    if (!music || music.keyframes.length <= 2) return; // keep at least 2
    onMusicChange?.({ ...music, keyframes: music.keyframes.filter((_, i) => i !== idx) });
    setEditingKf(null);
  };

  const safeDuration = Math.max(0.1, duration);
  const basePxPerSec = viewportWidth > 0 ? viewportWidth / safeDuration : 0;
  const pxPerSec = basePxPerSec * zoom;
  const contentWidth = Math.max(viewportWidth, safeDuration * pxPerSec);

  const xOf = useCallback((t: number) => t * pxPerSec, [pxPerSec]);

  const timeAt = useCallback((clientX: number) => {
    const rect = laneRef.current?.getBoundingClientRect();
    if (!rect || pxPerSec <= 0) return 0;
    return Math.max(0, Math.min(safeDuration, (clientX - rect.left) / pxPerSec));
  }, [pxPerSec, safeDuration]);

  const list = useMemo(
    () => materialiseSegments(segments, safeDuration, baseFraming),
    [segments, safeDuration, baseFraming]
  );

  // ─── Snapping ──────────────────────────────────────────────────────────────

  const commonTargets = useMemo(() => {
    const out: number[] = [0, safeDuration];
    if (playheadSeconds != null) out.push(playheadSeconds);
    return out;
  }, [safeDuration, playheadSeconds]);

  const tolerance = pxPerSec > 0 ? SNAP_PX / pxPerSec : 0;

  const snapWord = useCallback((t: number, excludeWord?: number) => {
    if (pxPerSec <= 0) return t;
    const targets = [...commonTargets];
    for (const s of list) targets.push(s.start, s.end);
    words.forEach((w, i) => {
      if (i === excludeWord) return;
      targets.push(w.start, w.end);
    });
    return snapToTargets(t, targets, tolerance);
  }, [pxPerSec, commonTargets, words, list, tolerance]);

  const snapSegment = useCallback((t: number, excludeIndex?: number) => {
    if (pxPerSec <= 0) return t;
    const targets = [...commonTargets];
    for (const w of words) targets.push(w.start, w.end);
    list.forEach((s, i) => {
      if (i === excludeIndex) return;
      targets.push(s.start, s.end);
    });
    return snapToTargets(t, targets, tolerance);
  }, [pxPerSec, commonTargets, words, list, tolerance]);

  // ─── Dragging ──────────────────────────────────────────────────────────────

  /**
   * Runs a pointer drag, reporting the offset from where it started in seconds.
   * Reporting the offset rather than the live position keeps edits from drifting
   * when a value gets clamped part way through. Nothing is reported until the
   * pointer has moved a few pixels, so a plain click still selects.
   */
  const beginDrag = useCallback((
    e: React.PointerEvent,
    key: string,
    onDelta: (deltaSeconds: number) => void,
  ) => {
    if (pxPerSec <= 0) return;
    e.stopPropagation();
    const startX = e.clientX;
    movedRef.current = false;

    const move = (ev: PointerEvent) => {
      if (!movedRef.current && Math.abs(ev.clientX - startX) < DRAG_THRESHOLD_PX) return;
      if (!movedRef.current) { movedRef.current = true; setDragging(key); }
      onDelta((ev.clientX - startX) / pxPerSec);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDragging(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [pxPerSec]);

  // ─── Framing operations ────────────────────────────────────────────────────

  const addZoom = (t: number) => {
    const result = insertZoomAt(list, t, safeDuration, baseFraming, {
      length: Math.min(DEFAULT_ZOOM_LENGTH, safeDuration),
    });
    if (result.selectIndex == null) return;
    onSegmentsChange(result.segments);
    onSelectSegment(result.selectIndex);
    onEditingKeyframeChange?.("to");
  };

  const splitFramingAt = (t: number) => {
    const result = splitSegmentAt(list, t, safeDuration, baseFraming);
    if (result.selectIndex == null) return;
    onSegmentsChange(result.segments);
    onSelectSegment(result.selectIndex);
  };

  const removeSegment = (index: number) => {
    onSegmentsChange(removeSegmentAt(list, index));
    onSelectSegment(null);
  };

  const trimSegment = (index: number, edge: "start" | "end", time: number) => {
    onSegmentsChange(trimSegmentEdge(list, index, edge, snapSegment(time, index), safeDuration));
  };

  const moveSegment = (index: number, newStart: number) => {
    onSegmentsChange(shiftSegment(list, index, snapSegment(newStart, index), safeDuration));
  };

  const setKeyframe = (index: number, which: Keyframe, crop: Crop) => {
    onSegmentsChange(setSegmentKeyframe(list, index, which, crop));
  };

  // ─── Word operations ───────────────────────────────────────────────────────

  const updateWord = (index: number, patch: Partial<TimelineWord>) => {
    onWordsChange(words.map((w, i) => (i === index ? { ...w, ...patch } : w)));
  };

  const removeWord = (index: number) => {
    onWordsChange(words.filter((_, i) => i !== index));
    setEditingWord(null);
  };

  const addWordAt = (t: number) => {
    const start = Math.max(0, Math.min(safeDuration - MIN_WORD, t));
    const next = [...words, { word: "NEW", start, end: Math.min(safeDuration, start + 0.4) }]
      .sort((a, b) => a.start - b.start);
    onWordsChange(next);
    setEditingWord(next.findIndex(w => w.start === start));
  };

  // ─── Text overlay helpers ───────────────────────────────────────────────────
  const [editingTextId, setEditingTextId] = useState<string | null>(null);

  const addTextOverlay = (t: number) => {
    if (!onTextOverlaysChange) return;
    const start = Math.max(0, Math.min(duration - 1, t));
    const overlay: TextOverlay = {
      id: `txt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      text: "YOUR TEXT",
      start,
      end: Math.min(duration, start + 3),
      posX: 0.5,
      posY: 0.15,
      fontSize: 48,
      color: "#FFFFFF",
    };
    onTextOverlaysChange([...(textOverlays ?? []), overlay]);
    setEditingTextId(overlay.id);
  };

  const updateTextOverlay = (id: string, patch: Partial<TextOverlay>) => {
    if (!onTextOverlaysChange || !textOverlays) return;
    onTextOverlaysChange(textOverlays.map(o => o.id === id ? { ...o, ...patch } : o));
  };

  const removeTextOverlay = (id: string) => {
    if (!onTextOverlaysChange || !textOverlays) return;
    onTextOverlaysChange(textOverlays.filter(o => o.id !== id));
    if (editingTextId === id) setEditingTextId(null);
  };

  const splitWordAt = (t: number) => {
    const result = splitWordAtTime(words, t);
    if (result.selectIndex == null) return;
    onWordsChange(result.words);
    setEditingWord(result.selectIndex);
  };

  const trimWord = (index: number, edge: "start" | "end", time: number) => {
    onWordsChange(trimWordEdge(words, index, edge, snapWord(time, index), safeDuration));
  };

  const shiftWord = (index: number, newStart: number) => {
    onWordsChange(shiftWordTo(words, index, snapWord(newStart, index), safeDuration));
  };

  // ─── Tool dispatch ─────────────────────────────────────────────────────────

  /**
   * Applies the active tool to a block. Returns true when the tool consumed the
   * click, so selection does not also happen.
   */
  const applyTool = (track: TrackId, index: number, atTime: number): boolean => {
    if (locked[track]) return true;
    if (tool === "split") {
      if (track === "subtitle") splitWordAt(atTime); else splitFramingAt(atTime);
      return true;
    }
    if (tool === "delete") {
      if (track === "subtitle") removeWord(index); else removeSegment(index);
      return true;
    }
    return false;
  };

  // ─── Ruler ─────────────────────────────────────────────────────────────────

  const ticks = useMemo(() => {
    if (pxPerSec <= 0) return [] as Array<{ t: number; major: boolean }>;
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];
    const major = steps.find(s => s * pxPerSec >= 76) ?? steps[steps.length - 1];
    const minor = major / 5;
    const out: Array<{ t: number; major: boolean }> = [];
    for (let i = 0; i * minor <= safeDuration + 1e-6; i++) {
      const t = Number((i * minor).toFixed(4));
      out.push({ t, major: Math.abs(t / major - Math.round(t / major)) < 1e-6 });
    }
    return out;
  }, [pxPerSec, safeDuration]);

  const selected = selectedSegment != null ? list[selectedSegment] : null;
  const canSplitWord = canSplitAt(words, playheadSeconds);

  /** Keeps the playhead in view when zoomed past the viewport. */
  useEffect(() => {
    if (playheadSeconds == null || pxPerSec <= 0) return;
    const el = scrollRef.current;
    if (!el) return;
    const x = playheadSeconds * pxPerSec;
    if (x < el.scrollLeft + 40 || x > el.scrollLeft + el.clientWidth - 40) {
      el.scrollTo({ left: Math.max(0, x - el.clientWidth / 2), behavior: "smooth" });
    }
  }, [playheadSeconds, pxPerSec, scrollRef]);

  const toolCursor = tool === "split" ? "cursor-crosshair" : tool === "delete" ? "cursor-pointer" : "";

  return (
    <div className="rounded-2xl overflow-hidden border border-border" style={{ background: "#ffffff" }}>
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <Clock className="w-4 h-4 shrink-0" style={{ color: "var(--cobalt)" }} />
          <span className="text-sm font-bold text-foreground">Timeline</span>
          <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
            {playheadSeconds != null ? formatTime(playheadSeconds) : "0:00"} / {formatTime(safeDuration)}
          </span>
          <span className="text-[11px] text-muted-foreground/70 truncate hidden sm:inline">
            · {TOOL_HINT[tool]}
          </span>
        </div>
        <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">{zoom.toFixed(zoom < 10 ? 1 : 0)}×</span>
      </div>

      {/* ── Tracks ───────────────────────────────────────────────────────── */}
      <div className="flex">
        {/* Track headers, pinned while the time axis scrolls. */}
        <div className="shrink-0 border-r border-border" style={{ width: SIDEBAR_W }}>
          <div
            className="flex items-center px-3 border-b border-border text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70"
            style={{ height: RULER_H }}
          >
            Tracks
          </div>
          {TRACKS.map(track => (
            <div
              key={track.id}
              className="flex items-center gap-1.5 px-2 border-b border-border/60"
              style={{ height: track.height }}
            >
              <button
                onClick={() => setHidden(h => ({ ...h, [track.id]: !h[track.id] }))}
                aria-label={`${hidden[track.id] ? "Show" : "Hide"} ${track.name}`}
                title={hidden[track.id] ? "Show track" : "Hide track"}
                className="p-1 rounded transition-colors hover:bg-white/10"
              >
                {hidden[track.id]
                  ? <EyeOff className="w-3.5 h-3.5 text-muted-foreground/50" />
                  : <Eye className="w-3.5 h-3.5 text-muted-foreground" />}
              </button>
              <button
                onClick={() => setLocked(l => ({ ...l, [track.id]: !l[track.id] }))}
                aria-label={`${locked[track.id] ? "Unlock" : "Lock"} ${track.name}`}
                title={locked[track.id] ? "Unlock track" : "Lock track"}
                className="p-1 rounded transition-colors hover:bg-white/10"
              >
                {locked[track.id]
                  ? <Lock className="w-3.5 h-3.5" style={{ color: "var(--amber)" }} />
                  : <Unlock className="w-3.5 h-3.5 text-muted-foreground/50" />}
              </button>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-bold text-foreground truncate leading-tight">{track.name}</p>
                <p className="text-[9px] text-muted-foreground truncate leading-tight">{track.kind}</p>
              </div>
              {track.id === "framing" && (
                <button
                  onClick={() => addZoom(playheadSeconds ?? 0)}
                  disabled={locked[track.id]}
                  aria-label="Add a zoom here"
                  title="Add a zoom at the playhead"
                  className="p-1 rounded transition-colors hover:bg-white/10 disabled:opacity-30"
                >
                  <Plus className="w-3.5 h-3.5 text-muted-foreground" />
                </button>
              )}
              {track.id === "subtitle" && (
                <button
                  onClick={() => addWordAt(playheadSeconds ?? 0)}
                  disabled={locked[track.id]}
                  aria-label="Add a word here"
                  title="Add a word at the playhead"
                  className="p-1 rounded transition-colors hover:bg-white/10 disabled:opacity-30"
                >
                  <Plus className="w-3.5 h-3.5 text-muted-foreground" />
                </button>
              )}
              {track.id === "text" && (
                <button
                  onClick={() => addTextOverlay(playheadSeconds ?? 0)}
                  disabled={locked[track.id]}
                  aria-label="Add text overlay"
                  title="Add a text overlay at the playhead"
                  className="p-1 rounded transition-colors hover:bg-white/10 disabled:opacity-30"
                >
                  <Plus className="w-3.5 h-3.5 text-muted-foreground" />
                </button>
              )}
              {track.id === "music" && (
                <button
                  onClick={() => music ? addKfAtPlayhead() : setMusicInputMode("youtube")}
                  disabled={locked[track.id]}
                  aria-label={music ? "Add volume keyframe" : "Add music"}
                  title={music ? "Add volume keyframe at playhead" : "Add music track"}
                  className="p-1 rounded transition-colors hover:bg-white/10 disabled:opacity-30"
                >
                  {music ? <Plus className="w-3.5 h-3.5 text-muted-foreground" /> : <Music className="w-3.5 h-3.5 text-muted-foreground" />}
                </button>
              )}
            </div>
          ))}
        </div>

        {/* Scrolling time axis: ruler and lanes share one container. */}
        <div ref={scrollRef} className="flex-1 overflow-x-auto overflow-y-hidden min-w-0">
          <div ref={laneRef} className="relative" style={{ width: contentWidth }}>
            {/* Ruler */}
            <div
              className="relative border-b border-border cursor-pointer select-none"
              style={{ height: RULER_H }}
              onPointerDown={e => onScrub?.(timeAt(e.clientX))}
            >
              {ticks.map(({ t, major }) => (
                <div key={t} className="absolute bottom-0" style={{ left: xOf(t) }}>
                  <div
                    className="w-px"
                    style={{
                      height: major ? 9 : 5,
                      background: major ? "rgba(36, 36, 34, 0.12)" : "rgba(36, 36, 34, 0.05)",
                    }}
                  />
                  {major && (
                    <span className="absolute bottom-[11px] left-0 -translate-x-1/2 text-[9px] text-muted-foreground/80 tabular-nums whitespace-nowrap">
                      {formatTime(t)}
                    </span>
                  )}
                </div>
              ))}
            </div>

            {/* Framing lane */}
            <div
              className={`relative border-b border-border/60 ${toolCursor}`}
              style={{ height: TRACKS[0].height, background: "#f7f6f3" }}
              onPointerDown={e => onScrub?.(timeAt(e.clientX))}
            >
              {!hidden.framing && list.map((seg, i) => {
                const active = selectedSegment === i;
                const width = xOf(seg.end - seg.start);
                const moving = isAnimated(seg);
                const from = framingAt(seg, seg.start);
                const to = framingAt(seg, seg.end);
                const jump = hasJumpAfter(list, i);
                return (
                  <div
                    key={i}
                    className="absolute top-1 bottom-1 overflow-hidden rounded"
                    style={{
                      left: xOf(seg.start), width,
                      background: moving
                        ? `linear-gradient(90deg, rgba(49, 94, 245, ${active ? 0.2 : 0.08}), rgba(49, 94, 245, ${active ? 0.35 : 0.16}))`
                        : `rgba(49, 94, 245, ${active ? 0.25 : 0.1})`,
                      border: active ? "1.5px solid var(--cobalt)" : "1px solid rgba(49, 94, 245, 0.3)",
                      opacity: locked.framing ? 0.55 : 1,
                      zIndex: active ? 12 : 4,
                    }}
                    title={`${formatTime(seg.start)}–${formatTime(seg.end)} · ${moving ? `${from.zoom.toFixed(2)}× → ${to.zoom.toFixed(2)}×` : `${from.zoom.toFixed(2)}×`}`}
                  >
                    <button
                      className={`absolute inset-0 flex flex-col items-center justify-center gap-0.5 ${tool === "select" ? "cursor-grab active:cursor-grabbing" : ""}`}
                      onClick={e => {
                        e.stopPropagation();
                        if (movedRef.current) return;
                        if (applyTool("framing", i, timeAt(e.clientX))) return;
                        onSelectSegment(active ? null : i);
                      }}
                      onPointerDown={e => {
                        if (tool !== "select" || locked.framing) { e.stopPropagation(); return; }
                        const original = seg.start;
                        beginDrag(e, `seg${i}-move`, d => moveSegment(i, original + d));
                      }}
                      aria-label={`Framing ${formatTime(seg.start)} to ${formatTime(seg.end)}`}
                    >
                      {width > 56 && (
                        <>
                          <span className="text-[10px] font-black text-white tabular-nums flex items-center gap-1">
                            {moving ? (
                              <>{from.zoom.toFixed(1)}×<MoveRight className="w-2.5 h-2.5 opacity-70" />{to.zoom.toFixed(1)}×</>
                            ) : (<>{from.zoom.toFixed(1)}×</>)}
                          </span>
                          <span className="text-[9px] text-white/55 tabular-nums">{formatTime(seg.start)}</span>
                        </>
                      )}
                    </button>

                    {tool === "select" && !locked.framing && width > 16 && (["start", "end"] as const).map(edge => {
                      const pinned = (edge === "start" && i === 0) || (edge === "end" && i === list.length - 1);
                      if (pinned) return null;
                      return (
                        <div
                          key={edge}
                          role="separator"
                          aria-label={`Trim ${edge} of framing section ${i + 1}`}
                          className="absolute top-0 bottom-0 w-2 cursor-col-resize z-10 bg-white/0 hover:bg-white/60 transition-colors"
                          style={edge === "start" ? { left: 0 } : { right: 0 }}
                          onPointerDown={e => {
                            const original = edge === "start" ? seg.start : seg.end;
                            beginDrag(e, `seg${i}-${edge}`, d => trimSegment(i, edge, original + d));
                          }}
                        />
                      );
                    })}

                    {jump && (
                      <span
                        className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full"
                        style={{ background: "var(--amber)" }}
                        title="The framing jumps at the end of this section"
                      />
                    )}
                  </div>
                );
              })}
              {hidden.framing && (
                <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-[10px] text-muted-foreground/50">
                  Track hidden
                </span>
              )}
            </div>

            {/* Subtitle lane */}
            <div
              className={`relative ${toolCursor}`}
              style={{ height: TRACKS[1].height, background: "#f7f6f3" }}
              onPointerDown={e => onScrub?.(timeAt(e.clientX))}
            >
              {!hidden.subtitle && words.map((w, i) => {
                const width = Math.max(2, xOf(w.end - w.start));
                const isSel = editingWord === i;
                const busy = dragging?.startsWith(`w${i}-`);
                return (
                  <div
                    key={i}
                    className="absolute top-1.5 bottom-1.5 rounded overflow-hidden select-none"
                    style={{
                      left: xOf(w.start), width,
                      background: isSel ? "var(--coral)" : "rgba(221, 125, 113, 0.2)",
                      border: isSel ? "1.5px solid #242422" : "1px solid rgba(221, 125, 113, 0.4)",
                      opacity: locked.subtitle ? 0.55 : 1,
                      zIndex: isSel || busy ? 15 : 5,
                    }}
                    title={`${w.word} · ${w.start.toFixed(2)}s–${w.end.toFixed(2)}s`}
                  >
                    <button
                      className={`absolute inset-0 px-1.5 text-left ${tool === "select" ? "cursor-grab active:cursor-grabbing" : ""}`}
                      onClick={e => {
                        e.stopPropagation();
                        if (movedRef.current) return;
                        if (applyTool("subtitle", i, timeAt(e.clientX))) return;
                        setEditingWord(isSel ? null : i);
                      }}
                      onPointerDown={e => {
                        if (tool !== "select" || locked.subtitle) { e.stopPropagation(); return; }
                        const original = w.start;
                        beginDrag(e, `w${i}-move`, d => shiftWord(i, original + d));
                      }}
                      aria-label={`Subtitle ${w.word}, ${formatTime(w.start)} to ${formatTime(w.end)}`}
                    >
                      {width > 26 && (
                        <span className="text-[10px] font-bold text-white truncate block" style={{ lineHeight: `${TRACKS[1].height - 12}px` }}>
                          {w.word}
                        </span>
                      )}
                    </button>

                    {tool === "select" && !locked.subtitle && width > 14 && (["start", "end"] as const).map(edge => (
                      <div
                        key={edge}
                        role="separator"
                        aria-label={`Trim ${edge} of ${w.word}`}
                        className="absolute top-0 bottom-0 w-1.5 cursor-col-resize z-10 bg-white/0 hover:bg-white/70 transition-colors"
                        style={edge === "start" ? { left: 0 } : { right: 0 }}
                        onPointerDown={e => {
                          const original = edge === "start" ? w.start : w.end;
                          beginDrag(e, `w${i}-${edge}`, d => trimWord(i, edge, original + d));
                        }}
                      />
                    ))}
                  </div>
                );
              })}
              {words.length === 0 && !hidden.subtitle && (
                <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-[10px] text-muted-foreground/50">
                  No words yet — generate subtitles, or add one with +
                </span>
              )}
              {hidden.subtitle && (
                <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-[10px] text-muted-foreground/50">
                  Track hidden
                </span>
              )}
            </div>

            {/* Text overlay lane */}
            <div
              className={`relative border-b border-border/60 ${toolCursor}`}
              style={{ height: TRACKS[2].height, background: "#f7f6f3" }}
              onPointerDown={e => onScrub?.(timeAt(e.clientX))}
            >
              {!hidden.text && (textOverlays ?? []).map(overlay => {
                const width = Math.max(20, xOf(overlay.end - overlay.start));
                const isSel = editingTextId === overlay.id;
                return (
                  <div
                    key={overlay.id}
                    className="absolute top-1.5 bottom-1.5 rounded overflow-hidden select-none"
                    style={{
                      left: xOf(overlay.start), width,
                      background: isSel ? "var(--cobalt)" : "rgba(49, 94, 245, 0.2)",
                      border: isSel ? "1.5px solid #242422" : "1px solid rgba(49, 94, 245, 0.4)",
                      opacity: locked.text ? 0.55 : 1,
                      zIndex: isSel ? 15 : 5,
                    }}
                    title={`"${overlay.text}" · ${overlay.start.toFixed(1)}s–${overlay.end.toFixed(1)}s`}
                  >
                    <button
                      className="absolute inset-0 px-1.5 text-left cursor-pointer"
                      onClick={e => {
                        e.stopPropagation();
                        if (tool === "delete" && !locked.text) { removeTextOverlay(overlay.id); return; }
                        setEditingTextId(isSel ? null : overlay.id);
                      }}
                      aria-label={`Text overlay "${overlay.text}"`}
                    >
                      <span className="text-[10px] font-bold text-white truncate block" style={{ lineHeight: `${TRACKS[2].height - 12}px` }}>
                        <Type className="inline w-3 h-3 mr-0.5 -mt-0.5" />{overlay.text}
                      </span>
                    </button>
                  </div>
                );
              })}
              {(textOverlays ?? []).length === 0 && !hidden.text && (
                <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-[10px] text-muted-foreground/50">
                  No text — click + to add a text overlay
                </span>
              )}
              {hidden.text && (
                <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-[10px] text-muted-foreground/50">
                  Track hidden
                </span>
              )}
            </div>

            {/* Music lane */}
            <div
              className="relative border-b border-border/60"
              style={{ height: TRACKS[3].height, background: "#f7f6f3" }}
              onPointerDown={e => onScrub?.(timeAt(e.clientX))}
            >
              {hidden.music && (
                <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-[10px] text-muted-foreground/50">
                  Track hidden
                </span>
              )}
              {!hidden.music && !music && (
                <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-[10px] text-muted-foreground/50">
                  No music — click + to add YouTube or upload a file
                </span>
              )}
              {!hidden.music && music && (() => {
                // Draw the full-clip bar.
                const barW = xOf(safeDuration);
                return (
                  <>
                    {/* Solid bar representing the audio span */}
                    <div
                      className="absolute top-1.5 bottom-1.5 rounded overflow-hidden"
                      style={{
                        left: 0,
                        width: barW,
                        background: "rgba(89, 164, 133, 0.15)",
                        border: "1px solid rgba(89, 164, 133, 0.4)",
                      }}
                    >
                      <span className="px-1.5 text-[10px] font-bold text-white/80 truncate block leading-[calc(46px-12px)]">
                        🎵 {music.label}
                      </span>
                      {/* Volume envelope drawn as an SVG polyline */}
                      {barW > 30 && music.keyframes.length >= 2 && (() => {
                        const sorted = [...music.keyframes].sort((a, b) => a.time - b.time);
                        const h = TRACKS[2].height - 12;
                        const pts = sorted.map(k => {
                          const px = (k.time / safeDuration) * barW;
                          const py = h - k.volume * h;
                          return `${px},${py}`;
                        }).join(" ");
                        return (
                          <svg
                            className="absolute inset-0 pointer-events-none"
                            style={{ width: barW, height: "100%" }}
                            viewBox={`0 0 ${barW} ${h + 6}`}
                            preserveAspectRatio="none"
                          >
                            <polyline
                              points={pts}
                              fill="none"
                              stroke="var(--mint)"
                              strokeWidth="1.5"
                            />
                          </svg>
                        );
                      })()}
                    </div>

                    {/* Volume keyframe handles */}
                    {music.keyframes.map((kf, ki) => {
                      const kx = xOf(kf.time);
                      const kh = TRACKS[2].height - 12;
                      const ky = (1 - kf.volume) * kh + 6 - 4; // vertical position
                      const isSel = editingKf === ki;
                      return (
                        <button
                          key={ki}
                          title={`Vol ${Math.round(kf.volume * 100)}% @ ${formatTime(kf.time)}`}
                          onClick={e => { e.stopPropagation(); setEditingKf(isSel ? null : ki); }}
                          className="absolute w-2.5 h-2.5 rounded-full -translate-x-1/2 border z-10 transition-colors"
                          style={{
                            left: kx,
                            top: ky,
                            background: isSel ? "var(--mint)" : "var(--mint)",
                            borderColor: isSel ? "#242422" : "rgba(89, 164, 133, 0.4)",
                          }}
                        />
                      );
                    })}
                  </>
                );
              })()}
            </div>

            {/* Playhead, spanning every lane */}
            {playheadSeconds != null && (
              <div
                className="absolute top-0 bottom-0 pointer-events-none z-30"
                style={{ left: xOf(playheadSeconds) }}
              >
                <div className="w-px h-full" style={{ background: "var(--mint)" }} />
                <div
                  className="absolute -top-0 -translate-x-1/2 w-2.5 h-2.5 rotate-45"
                  style={{ background: "var(--mint)" }}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Tool bar ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-t border-border overflow-x-auto">
        {([
          { id: "select" as Tool, icon: MousePointer2, label: "Select" },
          { id: "split" as Tool, icon: Scissors, label: "Split" },
          { id: "delete" as Tool, icon: Trash2, label: "Delete" },
        ]).map(t => (
          <button
            key={t.id}
            onClick={() => setTool(t.id)}
            aria-pressed={tool === t.id}
            className="flex flex-col items-center gap-0.5 px-3 py-1 rounded-lg transition-colors shrink-0"
            style={tool === t.id
              ? { background: "rgba(49, 94, 245, 0.1)", color: "var(--cobalt)" }
              : { color: "var(--muted-foreground)" }}
          >
            <t.icon className="w-4 h-4" />
            <span className="text-[9px] font-bold">{t.label}</span>
          </button>
        ))}

        <div className="w-px self-stretch mx-1 bg-border shrink-0" />

        <button
          onClick={() => splitWordAt(playheadSeconds ?? 0)}
          disabled={!canSplitWord || locked.subtitle}
          title="Cut the subtitle under the playhead"
          className="flex flex-col items-center gap-0.5 px-3 py-1 rounded-lg text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30 shrink-0"
        >
          <Type className="w-4 h-4" />
          <span className="text-[9px] font-bold">Cut word</span>
        </button>
        <button
          onClick={() => addZoom(playheadSeconds ?? 0)}
          disabled={locked.framing}
          title="Add a zoom that eases in and back out at the playhead"
          className="flex flex-col items-center gap-0.5 px-3 py-1 rounded-lg text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30 shrink-0"
        >
          <TrendingUp className="w-4 h-4" />
          <span className="text-[9px] font-bold">Add zoom</span>
        </button>

        <div className="w-px self-stretch mx-1 bg-border shrink-0" />

        <button
          onClick={() => setZoom(z => Math.min(MAX_ZOOM, z * 1.6))}
          disabled={zoom >= MAX_ZOOM}
          title="Zoom in"
          className="flex flex-col items-center gap-0.5 px-3 py-1 rounded-lg text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30 shrink-0"
        >
          <ZoomIn className="w-4 h-4" />
          <span className="text-[9px] font-bold">Zoom In</span>
        </button>
        <button
          onClick={() => setZoom(z => Math.max(1, z / 1.6))}
          disabled={zoom <= 1}
          title="Zoom out"
          className="flex flex-col items-center gap-0.5 px-3 py-1 rounded-lg text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30 shrink-0"
        >
          <ZoomOut className="w-4 h-4" />
          <span className="text-[9px] font-bold">Zoom Out</span>
        </button>
        <button
          onClick={() => setZoom(1)}
          disabled={zoom === 1}
          title="Fit the whole clip"
          className="flex flex-col items-center gap-0.5 px-3 py-1 rounded-lg text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30 shrink-0"
        >
          <Maximize2 className="w-4 h-4" />
          <span className="text-[9px] font-bold">Fit</span>
        </button>
      </div>

      {/* ── Inspector: the selected framing section ──────────────────────── */}
      {selected && selectedSegment != null && (() => {
        const moving = isAnimated(selected);
        const active = editingKeyframe === "to" && moving
          ? segmentTarget(selected)
          : framingAt(selected, selected.start);
        const jump = hasJumpAfter(list, selectedSegment);

        return (
          <div className="border-t border-border p-3 space-y-2.5" style={{ background: "#f7f6f3" }}>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-[11px] font-bold text-foreground tabular-nums">
                Section {selectedSegment + 1} · {formatTime(selected.start)}–{formatTime(selected.end)}
              </span>
              <button
                onClick={() => removeSegment(selectedSegment)}
                className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold transition-colors shrink-0"
                style={{ background: "rgba(229, 72, 77, 0.08)", color: "var(--coral)" }}
              >
                <Trash2 className="w-2.5 h-2.5" /> Remove
              </button>
            </div>

            <div className="flex items-center gap-1.5 flex-wrap">
              {([false, true] as const).map(wants => (
                <button
                  key={String(wants)}
                  onClick={() => {
                    onSegmentsChange(setSegmentMoving(list, selectedSegment, wants));
                    onEditingKeyframeChange?.(wants ? "to" : "from");
                  }}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-bold transition-colors"
                  style={moving === wants
                    ? { background: "var(--cobalt)", color: "white" }
                    : { background: "rgba(232, 230, 225, 0.5)", color: "var(--muted-foreground)" }}
                >
                  {wants ? <><TrendingUp className="w-3 h-3" /> Move</> : <>Hold</>}
                </button>
              ))}
              <span className="text-[10px] text-muted-foreground ml-1">
                {moving ? "The framing glides across this section." : "One fixed framing for this section."}
              </span>
            </div>

            {moving && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[10px] text-muted-foreground w-14">Editing</span>
                {(["from", "to"] as const).map(k => (
                  <button
                    key={k}
                    onClick={() => onEditingKeyframeChange?.(k)}
                    className="px-2.5 py-1 rounded-lg text-[11px] font-bold transition-colors"
                    style={editingKeyframe === k
                      ? { background: "var(--coral)", color: "white" }
                      : { background: "rgba(232, 230, 225, 0.5)", color: "var(--muted-foreground)" }}
                  >
                    {k === "from" ? "Start" : "End"}
                  </button>
                ))}
                <span className="text-[10px] text-muted-foreground ml-1">
                  Drag the frame in the preview to set where it {editingKeyframe === "from" ? "starts" : "ends"}.
                </span>
              </div>
            )}

            <label className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground w-14 shrink-0">
                {moving ? (editingKeyframe === "from" ? "Start zoom" : "End zoom") : "Zoom"}
              </span>
              <input
                type="range" min={1} max={4} step={0.05} value={active.zoom}
                onChange={e => setKeyframe(selectedSegment, moving ? editingKeyframe : "from", {
                  ...active, zoom: Number(e.target.value),
                })}
                className="flex-1 accent-[var(--cobalt)]"
                aria-label="Zoom for this section"
              />
              <span className="text-[11px] font-bold text-foreground tabular-nums w-10 text-right">
                {active.zoom.toFixed(2)}×
              </span>
            </label>

            {moving && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[10px] text-muted-foreground w-14 shrink-0">Curve</span>
                {EASES.map(e => (
                  <button
                    key={e}
                    onClick={() => onSegmentsChange(setSegmentEase(list, selectedSegment, e))}
                    className="px-2 py-0.5 rounded-md text-[10px] font-bold transition-colors"
                    style={(selected.ease ?? "inOut") === e
                      ? { background: "var(--cobalt)", color: "white" }
                      : { background: "rgba(232, 230, 225, 0.5)", color: "var(--muted-foreground)" }}
                  >
                    {EASE_LABELS[e]}
                  </button>
                ))}
              </div>
            )}

            {jump && (
              <button
                onClick={() => onSegmentsChange(chainToNext(list, selectedSegment))}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-bold transition-colors"
                style={{ background: "rgba(241, 203, 103, 0.12)", color: "var(--amber)" }}
              >
                <Link2 className="w-3 h-3" />
                The framing jumps into the next section — glide into it instead
              </button>
            )}
          </div>
        );
      })()}

      {/* ── Inspector: the selected subtitle ─────────────────────────────── */}
      {editingWord != null && words[editingWord] && (
        <div className="border-t border-border p-3 space-y-2" style={{ background: "#f7f6f3" }}>
          <div className="flex items-center gap-2">
            <input
              value={words[editingWord].word}
              onChange={e => updateWord(editingWord, { word: e.target.value })}
              className="flex-1 px-2 py-1 rounded-md bg-input border border-border text-foreground text-xs focus:outline-none focus:ring-1 focus:ring-primary/50"
              aria-label="Subtitle text"
            />
            <button
              onClick={() => removeWord(editingWord)}
              aria-label="Delete subtitle"
              className="p-1.5 rounded-md transition-colors"
              style={{ background: "rgba(229, 72, 77, 0.08)", color: "var(--coral)" }}
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {(["start", "end"] as const).map(field => (
              <label key={field} className="flex items-center gap-1.5">
                <span className="text-[10px] text-muted-foreground w-8 capitalize">{field}</span>
                <input
                  type="number" step={0.05} min={0} max={safeDuration}
                  value={Number(words[editingWord][field].toFixed(2))}
                  onChange={e => {
                    const v = Math.max(0, Math.min(safeDuration, Number(e.target.value)));
                    const w = words[editingWord];
                    updateWord(editingWord, field === "start"
                      ? { start: Math.min(v, w.end - MIN_WORD) }
                      : { end: Math.max(v, w.start + MIN_WORD) });
                  }}
                  className="flex-1 px-1.5 py-1 rounded-md bg-input border border-border text-foreground text-[11px] tabular-nums focus:outline-none focus:ring-1 focus:ring-primary/50"
                />
              </label>
            ))}
          </div>
        </div>
      )}

      {/* ── Music input panel ─────────────────────────────────────────────── */}
      {musicInputMode && (
        <div className="border-t border-border p-3 space-y-3" style={{ background: "#f7f6f3" }}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Music className="w-3.5 h-3.5" style={{ color: "var(--mint)" }} />
              <span className="text-[11px] font-bold text-foreground">Add Music</span>
            </div>
            <button
              onClick={() => { setMusicInputMode(null); setMusicUrlError(null); setMusicUrl(""); }}
              className="p-1 rounded hover:bg-white/10 transition-colors"
              aria-label="Close music panel"
            >
              <X className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
          </div>

          {/* Source selector */}
          <div className="flex gap-2">
            <button
              onClick={() => setMusicInputMode("youtube")}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold transition-colors"
              style={musicInputMode === "youtube"
                ? { background: "rgba(89, 164, 133, 0.15)", color: "var(--mint)" }
                : { background: "rgba(232, 230, 225, 0.5)", color: "var(--muted-foreground)" }}
            >
              <Youtube className="w-3.5 h-3.5" /> YouTube URL
            </button>
            <button
              onClick={() => setMusicInputMode("upload")}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold transition-colors"
              style={musicInputMode === "upload"
                ? { background: "rgba(89, 164, 133, 0.15)", color: "var(--mint)" }
                : { background: "rgba(232, 230, 225, 0.5)", color: "var(--muted-foreground)" }}
            >
              <Upload className="w-3.5 h-3.5" /> Upload file
            </button>
          </div>

          {musicInputMode === "youtube" && (
            <div className="space-y-1.5">
              <div className="flex gap-2">
                <input
                  type="url"
                  placeholder="https://www.youtube.com/watch?v=…"
                  value={musicUrl}
                  onChange={e => { setMusicUrl(e.target.value); setMusicUrlError(null); }}
                  onKeyDown={e => e.key === "Enter" && addMusicFromUrl()}
                  className="flex-1 px-2 py-1.5 rounded-md bg-input border text-foreground text-xs focus:outline-none focus:ring-1 focus:ring-primary/50"
                  style={{ borderColor: musicUrlError ? "var(--coral)" : undefined }}
                />
                <button
                  onClick={addMusicFromUrl}
                  disabled={!musicUrl.trim()}
                  className="px-3 py-1.5 rounded-md text-[11px] font-bold transition-colors disabled:opacity-40"
                  style={{ background: "rgba(89, 164, 133, 0.15)", color: "var(--mint)" }}
                >
                  Add
                </button>
              </div>
              {musicUrlError && (
                <p className="flex items-center gap-1 text-[10px]" style={{ color: "var(--coral)" }}>
                  <AlertCircle className="w-3 h-3 shrink-0" /> {musicUrlError}
                </p>
              )}
              <p className="text-[10px] text-muted-foreground">
                Paste any YouTube URL — full links, youtu.be shorts, or just the video ID
              </p>
            </div>
          )}

          {musicInputMode === "upload" && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*,video/mp4,video/webm"
                className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleMusicFile(f); }}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-[11px] font-bold border border-dashed transition-colors"
                style={{ borderColor: "rgba(89, 164, 133, 0.3)", color: "var(--mint)" }}
              >
                <Upload className="w-3.5 h-3.5" /> Choose audio or video file
              </button>
              <p className="text-[10px] text-muted-foreground">Accepts MP3, WAV, M4A, MP4, WebM…</p>
            </>
          )}
        </div>
      )}

      {/* ── Music inspector: selected keyframe ────────────────────────────── */}
      {music && editingKf != null && music.keyframes[editingKf] && (
        <div className="border-t border-border p-3 space-y-2" style={{ background: "#f7f6f3" }}>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Music className="w-3.5 h-3.5" style={{ color: "var(--mint)" }} />
              <span className="text-[11px] font-bold text-foreground">
                Volume keyframe @ {formatTime(music.keyframes[editingKf].time)}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => removeKf(editingKf)}
                disabled={music.keyframes.length <= 2}
                className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold transition-colors disabled:opacity-30"
                style={{ background: "rgba(229, 72, 77, 0.08)", color: "var(--coral)" }}
              >
                <Trash2 className="w-2.5 h-2.5" /> Remove
              </button>
              <button
                onClick={() => setEditingKf(null)}
                className="p-1 rounded hover:bg-white/10 transition-colors"
              >
                <X className="w-3.5 h-3.5 text-muted-foreground" />
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <VolumeX className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <input
              type="range" min={0} max={1} step={0.01}
              value={music.keyframes[editingKf].volume}
              onChange={e => updateKfVolume(editingKf, Number(e.target.value))}
              className="flex-1 accent-[var(--mint)]"
              aria-label="Volume at keyframe"
            />
            <Volume2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <span className="text-[11px] font-bold text-foreground tabular-nums w-9 text-right">
              {Math.round(music.keyframes[editingKf].volume * 100)}%
            </span>
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-muted-foreground">Music track</span>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground truncate max-w-[160px]">🎵 {music.label}</span>
              <button
                onClick={() => onMusicChange?.(null)}
                className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold transition-colors"
                style={{ background: "rgba(229, 72, 77, 0.08)", color: "var(--coral)" }}
              >
                <Trash2 className="w-2.5 h-2.5" /> Remove track
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Remove music button when music set but no keyframe is selected */}
      {music && editingKf == null && !musicInputMode && (
        <div className="border-t border-border px-3 py-2 flex items-center justify-between" style={{ background: "#f7f6f3" }}>
          <span className="text-[10px] text-muted-foreground truncate">🎵 {music.label}</span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={addKfAtPlayhead}
              disabled={playheadSeconds == null}
              className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold transition-colors disabled:opacity-30"
              style={{ background: "rgba(89, 164, 133, 0.12)", color: "var(--mint)" }}
            >
              <Plus className="w-2.5 h-2.5" /> Vol keyframe
            </button>
            <button
              onClick={() => onMusicChange?.(null)}
              className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold transition-colors"
              style={{ background: "rgba(229, 72, 77, 0.08)", color: "var(--coral)" }}
            >
              <Trash2 className="w-2.5 h-2.5" /> Remove
            </button>
          </div>
        </div>
      )}

      {/* Text overlay editing panel */}
      {editingTextId && (() => {
        const overlay = (textOverlays ?? []).find(o => o.id === editingTextId);
        if (!overlay) return null;
        return (
          <div className="border-t border-border px-3 py-2 space-y-2" style={{ background: "#f7f6f3" }}>
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold text-foreground flex items-center gap-1">
                <Type className="w-3 h-3" /> Text Overlay
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => removeTextOverlay(overlay.id)}
                  className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold transition-colors"
                  style={{ background: "rgba(229, 72, 77, 0.08)", color: "var(--coral)" }}
                >
                  <Trash2 className="w-2.5 h-2.5" /> Delete
                </button>
                <button
                  onClick={() => setEditingTextId(null)}
                  className="p-0.5 rounded transition-colors hover:bg-white/10"
                >
                  <X className="w-3 h-3 text-muted-foreground" />
                </button>
              </div>
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={overlay.text}
                onChange={e => updateTextOverlay(overlay.id, { text: e.target.value })}
                className="flex-1 px-2 py-1 rounded-md text-xs bg-black/30 border border-white/10 text-foreground"
                placeholder="Enter text..."
              />
              <input
                type="color"
                value={overlay.color}
                onChange={e => updateTextOverlay(overlay.id, { color: e.target.value })}
                className="w-7 h-7 rounded-md border border-white/10 cursor-pointer"
                style={{ padding: 1 }}
                title="Text colour"
              />
            </div>
            <div className="flex gap-2 items-center">
              <label className="text-[10px] text-muted-foreground w-12">Start</label>
              <input
                type="number"
                min={0}
                max={overlay.end - 0.1}
                step={0.1}
                value={overlay.start.toFixed(1)}
                onChange={e => updateTextOverlay(overlay.id, { start: Math.max(0, Number(e.target.value)) })}
                className="w-16 px-1.5 py-0.5 rounded text-[10px] bg-black/30 border border-white/10 text-foreground"
              />
              <label className="text-[10px] text-muted-foreground w-12">End</label>
              <input
                type="number"
                min={overlay.start + 0.1}
                max={duration}
                step={0.1}
                value={overlay.end.toFixed(1)}
                onChange={e => updateTextOverlay(overlay.id, { end: Math.min(duration, Number(e.target.value)) })}
                className="w-16 px-1.5 py-0.5 rounded text-[10px] bg-black/30 border border-white/10 text-foreground"
              />
              <label className="text-[10px] text-muted-foreground w-12">Size</label>
              <input
                type="number"
                min={12}
                max={120}
                step={2}
                value={overlay.fontSize}
                onChange={e => updateTextOverlay(overlay.id, { fontSize: Number(e.target.value) })}
                className="w-14 px-1.5 py-0.5 rounded text-[10px] bg-black/30 border border-white/10 text-foreground"
              />
            </div>
            <div className="flex gap-2 items-center">
              <label className="text-[10px] text-muted-foreground w-12">Pos Y</label>
              <input
                type="range"
                min={0.05}
                max={0.95}
                step={0.01}
                value={overlay.posY}
                onChange={e => updateTextOverlay(overlay.id, { posY: Number(e.target.value) })}
                className="flex-1 accent-[var(--cobalt)]"
              />
              <span className="text-[10px] text-muted-foreground w-10 text-right">{Math.round(overlay.posY * 100)}%</span>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

export default ClipTimeline;
