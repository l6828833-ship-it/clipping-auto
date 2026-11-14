import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, RotateCcw, ZoomIn, Play, Pause, Volume2, VolumeX } from "lucide-react";

/**
 * Reframing control.
 *
 * The whole video frame stays visible at its native aspect ratio, and a 9:16
 * crop window sits on top of it. Drag the window (or the video) to choose what
 * survives the vertical crop, and zoom to make the window cover less of the
 * frame. Everything outside the window is dimmed so the result is obvious.
 *
 * Values map directly onto the server's ffmpeg crop:
 *   zoom    1..4  — 1 makes the crop as tall as the frame
 *   offsetX -1..1 — fraction of the horizontal slack, 0 = centred
 *   offsetY -1..1 — same vertically
 *
 * Offsets are fractions of the remaining slack rather than pixels, so the crop
 * can never leave the frame at any zoom level.
 */

export type Framing = { zoom: number; offsetX: number; offsetY: number };

export const DEFAULT_FRAMING: Framing = { zoom: 1, offsetX: 0, offsetY: 0 };

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 4;

/** Output aspect ratio (1080x1920). */
const TARGET_ASPECT = 9 / 16;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Geometry of the crop window inside the displayed video box.
 *
 * Mirrors the server filter: the source is scaled to *cover* a 9:16 target and
 * multiplied by zoom, so the visible crop is the inverse — a window of
 * 1/zoom of the covering size, positioned by the offsets.
 */
export function cropRect(boxW: number, boxH: number, zoom: number, offsetX: number, offsetY: number) {
  if (boxW <= 0 || boxH <= 0) return { w: 0, h: 0, x: 0, y: 0, slackX: 0, slackY: 0 };

  // Largest 9:16 window that fits the displayed frame, then shrink by zoom.
  const fitH = Math.min(boxH, boxW / TARGET_ASPECT);
  const fitW = fitH * TARGET_ASPECT;

  /*
   * Below zoom 1 the window would grow past the frame, which cannot be shown and
   * left the axis reporting no slack — so dragging did nothing. Clamping to the
   * frame is also the truth: once an axis is fully visible the renderer stops
   * cropping it and pads instead, so there is nothing more to reveal there.
   */
  const w = Math.min(boxW, fitW / zoom);
  const h = Math.min(boxH, fitH / zoom);

  // How far the window can travel from centre on each axis.
  const slackX = Math.max(0, (boxW - w) / 2);
  const slackY = Math.max(0, (boxH - h) / 2);

  return {
    w,
    h,
    x: (boxW - w) / 2 + offsetX * slackX,
    y: (boxH - h) / 2 + offsetY * slackY,
    slackX,
    slackY,
  };
}

export function VideoFramer({
  src,
  framing,
  onChange,
  startTime,
  endTime,
  loop = true,
  className,
  followTime,
  followPlaying,
  children,
}: {
  /** Hosted video URL. */
  src: string;
  framing: Framing;
  onChange: (next: Framing) => void;
  startTime?: number | null;
  endTime?: number | null;
  loop?: boolean;
  className?: string;
  /**
   * Position of the main preview, so this player shows the same frame instead of
   * drifting off on its own clock. Stays silent throughout: two audible players
   * of the same file would echo.
   */
  followTime?: number | null;
  /** Whether the main preview is playing, mirrored here. */
  followPlaying?: boolean;
  /** Overlay rendered inside the crop window, e.g. subtitles. */
  children?: React.ReactNode;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  const [dragging, setDragging] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [natural, setNatural] = useState({ w: 16, h: 9 });
  const [box, setBox] = useState({ w: 0, h: 0 });

  const start = Math.max(0, startTime ?? 0);
  const end = endTime ?? null;

  const rangeRef = useRef({ start, end, loop });
  useEffect(() => { rangeRef.current = { start, end, loop }; }, [start, end, loop]);

  // Track the displayed size so crop maths uses real pixels.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Seek to the clip start when the range or source changes.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const seek = () => {
      if (Number.isFinite(v.duration) && start < v.duration) v.currentTime = start;
    };
    if (v.readyState >= 1) seek();
    else v.addEventListener("loadedmetadata", seek, { once: true });
    return () => v.removeEventListener("loadedmetadata", seek);
  }, [start, end, src]);

  const onTimeUpdate = () => {
    const v = videoRef.current;
    if (!v) return;
    const r = rangeRef.current;
    if (r.end != null && v.currentTime >= r.end) {
      if (r.loop) v.currentTime = r.start;
      else { v.pause(); setPlaying(false); }
    }
  };

  /** Whether this player is following another rather than running itself. */
  const followed = followTime != null;

  /*
   * Seek only when the gap is large (> 1s). The RAF loop in CropView fires
   * onTime every frame — if we sought on every tick the bottom player would
   * stall permanently. Small drift (< 1s) is imperceptible and self-corrects.
   */
  useEffect(() => {
    const v = videoRef.current;
    if (!v || followTime == null) return;
    if (Math.abs(v.currentTime - followTime) > 1.0) {
      v.currentTime = Math.max(0, followTime);
    }
  }, [followTime]);

  // Mirror play/pause — only act on the *transition*, not on every render.
  const prevFollowPlayingRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (followPlaying == null) return;
    const v = videoRef.current;
    if (!v) return;
    const prev = prevFollowPlayingRef.current;
    prevFollowPlayingRef.current = followPlaying;
    // Skip the very first render (prev === null) — let the video settle first.
    if (prev === null) return;
    if (followPlaying && v.paused) void v.play().catch(() => {});
    if (!followPlaying && !v.paused) v.pause();
  }, [followPlaying]);

  const rect = useMemo(
    () => cropRect(box.w, box.h, Math.max(1, framing.zoom), framing.offsetX, framing.offsetY),
    [box.w, box.h, framing.zoom, framing.offsetX, framing.offsetY]
  );

  const canPan = rect.slackX > 0.5 || rect.slackY > 0.5;

  const onPointerDown = (e: React.PointerEvent) => {
    if (!canPan) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, ox: framing.offsetX, oy: framing.offsetY };
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;

    // Dragging moves the crop window with the cursor, so no negation here.
    const dx = rect.slackX > 0 ? (e.clientX - d.x) / rect.slackX : 0;
    const dy = rect.slackY > 0 ? (e.clientY - d.y) / rect.slackY : 0;

    onChange({
      zoom: framing.zoom,
      offsetX: clamp(d.ox + dx, -1, 1),
      offsetY: clamp(d.oy + dy, -1, 1),
    });
  };

  const endDrag = () => { dragRef.current = null; setDragging(false); };

  const setZoom = useCallback((zoom: number) => {
    const z = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    const next = cropRect(box.w, box.h, Math.max(1, z), framing.offsetX, framing.offsetY);
    // Zeroing an axis that lost its slack keeps the window inside the frame.
    onChange({
      zoom: z,
      offsetX: next.slackX > 0 ? framing.offsetX : 0,
      offsetY: next.slackY > 0 ? framing.offsetY : 0,
    });
  }, [box.w, box.h, framing.offsetX, framing.offsetY, onChange]);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    setZoom(framing.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08));
  };

  const toggle = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      if (end != null && v.currentTime >= end) v.currentTime = start;
      void v.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    } else { v.pause(); setPlaying(false); }
  };

  // Keyboard nudging, so framing is reachable without a pointer.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.2 : 0.05;
    const map: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0],
      ArrowUp: [0, -step], ArrowDown: [0, step],
    };
    const delta = map[e.key];
    if (delta) {
      e.preventDefault();
      onChange({
        zoom: framing.zoom,
        offsetX: clamp(framing.offsetX + delta[0], -1, 1),
        offsetY: clamp(framing.offsetY + delta[1], -1, 1),
      });
      return;
    }
    if (e.key === "+" || e.key === "=") { e.preventDefault(); setZoom(framing.zoom + 0.1); }
    if (e.key === "-" || e.key === "_") { e.preventDefault(); setZoom(framing.zoom - 0.1); }
  };

  return (
    <div className={className}>
      {/* The full frame at its native ratio — nothing is hidden here. */}
      <div
        ref={boxRef}
        className="relative overflow-hidden bg-black rounded-2xl select-none touch-none"
        style={{ aspectRatio: `${natural.w} / ${natural.h}` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        tabIndex={0}
        role="application"
        aria-label="Reframe the vertical crop. Drag, or use arrow keys and +/- to zoom."
      >
        <video
          ref={videoRef}
          src={src}
          className="absolute inset-0 w-full h-full object-contain pointer-events-none"
          onLoadedMetadata={e => {
            const v = e.currentTarget;
            if (v.videoWidth && v.videoHeight) setNatural({ w: v.videoWidth, h: v.videoHeight });
          }}
          onTimeUpdate={onTimeUpdate}
          onPlaying={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          // Always silent: the main preview carries the sound.
          muted
          autoPlay={!followed}
          playsInline
          loop={end == null && !followed}
        />

        {/*
          Dim only what the crop discards, using four panels around the window.
          A single overlay with a second video punched through it would mean
          decoding the file twice and keeping two elements in sync.
        */}
        {rect.w > 0 && (
          <>
            {([
              { left: 0, top: 0, width: "100%", height: rect.y },
              { left: 0, top: rect.y + rect.h, width: "100%", height: Math.max(0, box.h - rect.y - rect.h) },
              { left: 0, top: rect.y, width: rect.x, height: rect.h },
              { left: rect.x + rect.w, top: rect.y, width: Math.max(0, box.w - rect.x - rect.w), height: rect.h },
            ] as const).map((panel, i) => (
              <div key={i} className="absolute pointer-events-none"
                style={{ ...panel, background: "rgba(0,0,0,0.62)" }} />
            ))}

            {/* Crop window: outline, guides and the caption overlay. */}
            <div
              className="absolute rounded-sm"
              style={{
                left: rect.x, top: rect.y, width: rect.w, height: rect.h,
                border: `2px solid ${dragging ? "#39FF14" : "var(--cobalt)"}`,
                cursor: canPan ? (dragging ? "grabbing" : "grab") : "default",
                // Lets the caption overlay size itself in cqw against the crop,
                // so the preview matches the burned-in output proportionally.
                containerType: "size",
              }}
            >
              {children}
              {/* Thirds guides help centre a subject. */}
              <div className="absolute inset-0 pointer-events-none opacity-30">
                <div className="absolute top-1/3 left-0 right-0 border-t border-white" />
                <div className="absolute top-2/3 left-0 right-0 border-t border-white" />
                <div className="absolute left-1/3 top-0 bottom-0 border-l border-white" />
                <div className="absolute left-2/3 top-0 bottom-0 border-l border-white" />
              </div>
              <span className="absolute top-1 left-1 px-1.5 py-0.5 rounded text-[10px] font-bold text-white pointer-events-none"
                style={{ background: framing.zoom < 1 ? "oklch(0.72 0.22 155)" : "var(--cobalt)" }}>
                {framing.zoom < 1 ? `${Math.round(framing.zoom * 100)}%` : "9:16"}
              </span>
            </div>
          </>
        )}

        {/* Play/pause, kept clear of the drag surface. */}
        <button
          onClick={e => { e.stopPropagation(); toggle(); }}
          onPointerDown={e => e.stopPropagation()}
          aria-label={playing ? "Pause" : "Play"}
          className="absolute bottom-2 left-2 z-20 p-2 rounded-lg text-white/90 hover:text-white transition-colors"
          style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
        >
          {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
        </button>
      </div>

      {/* Zoom controls */}
      <div className="mt-3 space-y-2">
        <div className="flex items-center gap-2">
          <ZoomIn className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <input
            type="range"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={0.05}
            value={framing.zoom}
            onChange={e => setZoom(Number(e.target.value))}
            className="flex-1 accent-[var(--cobalt)]"
            aria-label="Zoom"
          />
          <span className="text-[11px] font-bold text-foreground tabular-nums w-10 text-right">
            {framing.zoom.toFixed(2)}×
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-muted-foreground">
            {canPan ? "Drag the frame · scroll to zoom" : "Zoom in to move the frame"}
          </p>
          <button
            onClick={() => onChange({ ...DEFAULT_FRAMING })}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold text-muted-foreground bg-secondary/60 hover:text-foreground transition-colors shrink-0"
          >
            <RotateCcw className="w-3 h-3" /> Reset
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The crop region as fractions of the source frame. Independent of any
 * display size, so it can drive both the minimap and the output preview.
 */
export function cropFractions(srcW: number, srcH: number, framing: Framing) {
  // A virtual box matching the source aspect keeps the maths identical to the
  // on-screen rect, just normalised.
  const boxW = 1000;
  const boxH = (boxW * srcH) / Math.max(1, srcW);
  const r = cropRect(boxW, boxH, framing.zoom, framing.offsetX, framing.offsetY);
  return {
    wFrac: r.w / boxW,
    hFrac: r.h / boxH,
    xFrac: r.x / boxW,
    yFrac: r.y / boxH,
    slackXFrac: r.slackX / boxW,
    slackYFrac: r.slackY / boxH,
  };
}

/**
 * Large 9:16 preview of the finished crop — what the exported clip will look
 * like. Dragging pans the framing, so this doubles as an editing surface.
 *
 * Because the box is the full output aspect rather than a small window inside a
 * landscape frame, captions are shown at a readable size.
 */
export function CropView({
  src,
  framing,
  onChange,
  startTime,
  endTime,
  loop = true,
  className,
  style,
  onTime,
  seekTo,
  onPlayingChange,
  children,
  scale: videoScale = 1,
  barColor = "#000000",
}: {
  src: string;
  framing: Framing;
  onChange?: (next: Framing) => void;
  startTime?: number | null;
  endTime?: number | null;
  loop?: boolean;
  className?: string;
  style?: React.CSSProperties;
  /**
   * Playback position, reported every animation frame while playing.
   *
   * Driven from rAF rather than the video's `timeupdate` event, which only fires
   * about four times a second — far too coarse to animate a zoom against.
   */
  onTime?: (seconds: number) => void;
  /**
   * Jump to a position. The nonce is what triggers the seek, so scrubbing to the
   * same time twice still works.
   */
  seekTo?: { time: number; nonce: number } | null;
  /** Reports play/pause so another player can be kept in step. */
  onPlayingChange?: (playing: boolean) => void;
  children?: React.ReactNode;
  /** How much of the frame the video fills. 1 = full, <1 shows bars. */
  scale?: number;
  /** Colour for the bars when scale < 1. */
  barColor?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  const [natural, setNatural] = useState({ w: 16, h: 9 });
  const [dragging, setDragging] = useState(false);
  const [playing, setPlaying] = useState(false);
  // Start muted because browsers require it for autoplay. The button below
  // lets the user turn audio on once they interact with the page.
  const [muted, setMuted] = useState(true);

  const start = Math.max(0, startTime ?? 0);
  const end = endTime ?? null;

  const rangeRef = useRef({ start, end, loop });
  useEffect(() => { rangeRef.current = { start, end, loop }; }, [start, end, loop]);

  /*
   * Seek on request. Keyed on the nonce rather than the time so that repeating
   * the same position still seeks, and so reporting playback position back to
   * the parent cannot feed back into another seek.
   */
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !seekTo) return;
    v.currentTime = Math.max(0, seekTo.time);
  }, [seekTo?.nonce]);

  // Let the parent mirror playback elsewhere.
  useEffect(() => { onPlayingChange?.(playing); }, [playing, onPlayingChange]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const seek = () => {
      if (Number.isFinite(v.duration) && start < v.duration) v.currentTime = start;
    };
    if (v.readyState >= 1) seek();
    else v.addEventListener("loadedmetadata", seek, { once: true });
    return () => v.removeEventListener("loadedmetadata", seek);
  }, [start, end, src]);

  const onTimeUpdate = () => {
    const v = videoRef.current;
    if (!v) return;
    const r = rangeRef.current;
    if (r.end != null && v.currentTime >= r.end) {
      if (r.loop) v.currentTime = r.start;
      else { v.pause(); setPlaying(false); }
    }
    onTime?.(v.currentTime);
  };

  /*
   * Report the position each frame while playing, so a caller animating the
   * framing along an easing curve stays in step with the picture.
   */
  const onTimeRef = useRef(onTime);
  useEffect(() => { onTimeRef.current = onTime; }, [onTime]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v) onTimeRef.current?.(v.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const f = useMemo(() => cropFractions(natural.w, natural.h, framing), [natural, framing]);

  /**
   * Where the picture sits inside the 9:16 box, as fractions of the box.
   *
   * Mirrors the renderer exactly: cover-scale the source, multiply by zoom, then
   * crop whichever axis overflows and pad whichever falls short. Expressed as one
   * formula for every zoom so the preview stays continuous through 1 — the same
   * reason the filter chain does.
   *
   * `(1 - size) / 2` is negative when the picture is larger than the box (a crop,
   * so the edge sits outside it) and positive when smaller (a bar), which is why
   * a single expression covers both cases.
   */
  const layout = useMemo(() => {
    const aspect = natural.w / Math.max(1, natural.h);
    const boxHeightInWidths = 1 / TARGET_ASPECT;

    // Picture height in box-width units, cover-scaled then zoomed.
    const pictureH = framing.zoom * Math.max(boxHeightInWidths, 1 / aspect);
    const pictureW = pictureH * aspect;

    // Re-expressed against each box axis.
    const widthFrac = pictureW;
    const heightFrac = pictureH / boxHeightInWidths;

    return {
      widthFrac,
      heightFrac,
      leftFrac: ((1 - widthFrac) / 2) * (1 + framing.offsetX),
      topFrac: ((1 - heightFrac) / 2) * (1 + framing.offsetY),
      // How far the picture can travel on each axis, either side of centre.
      slackX: Math.abs(1 - widthFrac) / 2,
      slackY: Math.abs(1 - heightFrac) / 2,
    };
  }, [natural, framing]);

  const canPan = !!onChange && (layout.slackX > 0.0005 || layout.slackY > 0.0005);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!canPan) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, ox: framing.offsetX, oy: framing.offsetY };
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const box = boxRef.current;
    if (!d || !box || !onChange) return;

    /*
     * Pixel travel available per axis: one unit of offset moves the picture by
     * its slack, so a full -1..1 sweep covers twice that.
     */
    const spanX = box.clientWidth * layout.slackX;
    const spanY = box.clientHeight * layout.slackY;

    /*
     * When the picture overflows (a crop) dragging it right should reveal what is
     * to its left, so the offset moves against the pointer. When it is smaller
     * than the box the picture itself is being placed, so it follows the pointer.
     */
    const cropX = layout.widthFrac > 1 ? -1 : 1;
    const cropY = layout.heightFrac > 1 ? -1 : 1;

    const dx = spanX > 0 ? (cropX * (e.clientX - d.x)) / spanX : 0;
    const dy = spanY > 0 ? (cropY * (e.clientY - d.y)) / spanY : 0;

    onChange({
      zoom: framing.zoom,
      offsetX: clamp(d.ox + dx, -1, 1),
      offsetY: clamp(d.oy + dy, -1, 1),
    });
  };

  const endDrag = () => { dragRef.current = null; setDragging(false); };

  const toggle = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      if (end != null && v.currentTime >= end) v.currentTime = start;
      void v.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    } else { v.pause(); setPlaying(false); }
  };

  return (
    <div
      ref={boxRef}
      className={`relative overflow-hidden rounded-2xl select-none touch-none ${className ?? ""}`}
      style={{
        aspectRatio: "9 / 16",
        // Lets the caption overlay size itself against the real output box.
        containerType: "size",
        cursor: canPan ? (dragging ? "grabbing" : "grab") : "default",
        background: barColor,
        ...style,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {/* Inner container scaled down when videoScale < 1, centred with bars around it */}
      <div
        className="absolute inset-0 overflow-hidden"
        style={{
          width: `${videoScale * 100}%`,
          height: `${videoScale * 100}%`,
          left: `${((1 - videoScale) / 2) * 100}%`,
          top: `${((1 - videoScale) / 2) * 100}%`,
        }}
      >
      {/*
        Scale the video so the crop region exactly fills this box. The computed
        width/height preserve the source aspect ratio by construction, so no
        letterboxing or stretching occurs.
      */}
      <video
        ref={videoRef}
        src={src}
        className="absolute max-w-none pointer-events-none"
        style={{
          width: `${layout.widthFrac * 100}%`,
          height: `${layout.heightFrac * 100}%`,
          left: `${layout.leftFrac * 100}%`,
          top: `${layout.topFrac * 100}%`,
          objectFit: "fill",
        }}
        onLoadedMetadata={e => {
          const v = e.currentTarget;
          if (v.videoWidth && v.videoHeight) setNatural({ w: v.videoWidth, h: v.videoHeight });
        }}
        onTimeUpdate={onTimeUpdate}
        onPlaying={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        /*
         * Starts muted because browsers refuse to autoplay audible media, then
         * follows the mute button. The clip's own sound matters when judging
         * caption timing, so it has to be reachable.
         */
        muted={muted}
        autoPlay
        playsInline
        loop={end == null}
      />

      {children}
      </div>

      {/* Unmute banner — shown until the user explicitly turns on sound */}
      {muted && (
        <button
          onClick={e => { e.stopPropagation(); setMuted(false); }}
          onPointerDown={e => e.stopPropagation()}
          className="absolute top-2 left-1/2 -translate-x-1/2 z-40 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-white text-[11px] font-bold transition-all hover:opacity-90"
          style={{ background: "rgba(200,0,0,0.75)", backdropFilter: "blur(4px)" }}
        >
          <VolumeX className="w-3 h-3" /> Tap to unmute
        </button>
      )}

      {/* Audio & play controls */}
      <div className="absolute bottom-2 right-2 z-40 flex items-center gap-1">
        <button
          onClick={e => { e.stopPropagation(); setMuted(m => !m); }}
          onPointerDown={e => e.stopPropagation()}
          aria-label={muted ? "Unmute" : "Mute"}
          title={muted ? "Click to unmute" : "Click to mute"}
          className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-white/90 hover:text-white transition-colors"
          style={{ background: muted ? "rgba(200,0,0,0.65)" : "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
        >
          {muted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
        </button>
        <button
          onClick={e => { e.stopPropagation(); toggle(); }}
          onPointerDown={e => e.stopPropagation()}
          aria-label={playing ? "Pause" : "Play"}
          className="p-2 rounded-lg text-white/90 hover:text-white transition-colors"
          style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
        >
          {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  );
}

/** Compact read-only framing badge. */
export function FramingBadge({ framing }: { framing: Framing }) {
  const moved = framing.offsetX !== 0 || framing.offsetY !== 0;
  if (framing.zoom === 1 && !moved) return null;
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold"
      style={{ background: "rgba(49, 94, 245, 0.08)", color: "var(--cobalt)" }}>
      <Maximize2 className="w-2.5 h-2.5" />
      {framing.zoom.toFixed(2)}×{moved ? " moved" : ""}
    </span>
  );
}

export default VideoFramer;
