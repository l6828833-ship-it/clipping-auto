import { useEffect, useMemo, useRef, useState } from "react";
import AppLayout from "@/components/AppLayout";
import ClipPreview from "@/components/ClipPreview";
import VideoFramer, { CropView, FramingBadge, DEFAULT_FRAMING, type Framing } from "@/components/VideoFramer";
import SubtitleOverlay, {
  previewWordsFor, DEFAULT_SUBTITLE_STYLE, type SubtitleStyle,
} from "@/components/SubtitleOverlay";
import ClipTimeline, {
  type FramingSegment as TimelineSegment, type TimelineWord, type Keyframe, type MusicTrack,
  type TextOverlay,
} from "@/components/ClipTimeline";
import MusicPlayer from "@/components/MusicPlayer";
import {
  materialiseSegments, setSegmentKeyframe, isAnimated, segmentTarget,
  framingAt, segmentAt,
} from "@shared/framing";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import {
  youTubeThumbnail,
  youTubeWatchUrl,
  parseYouTubeId,
  downloadUrl,
  formatTime,
} from "@/lib/videoSource";
import {
  Film, Download, Clock, TrendingUp, Loader2, Play, CheckCircle2,
  AlertCircle, Zap, X, Maximize2, Scissors, Save, ExternalLink, CloudDownload, Trash2, Mic, Captions,
  ChevronDown, Undo2, Redo2,
} from "lucide-react";

// ─── Status badge ─────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string; icon: React.ElementType }> = {
    pending:   { label: "Pending",   cls: "status-pending",    icon: Clock },
    rendering: { label: "Rendering", cls: "status-processing", icon: Loader2 },
    done:      { label: "Done",      cls: "status-done",       icon: CheckCircle2 },
    error:     { label: "Error",     cls: "status-error",      icon: AlertCircle },
  };
  const s = map[status] ?? { label: status, cls: "status-pending", icon: Clock };
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full ${s.cls}`}>
      <s.icon className={`w-3 h-3 ${status === "rendering" ? "animate-spin" : ""}`} />
      {s.label}
    </span>
  );
}

type ClipRow = {
  id: number;
  videoId: number;
  title: string | null;
  startTime: number | null;
  endTime: number | null;
  engagementScore: number | null;
  status: string;
  downloadUrl: string | null;
  errorMessage?: string | null;
  zoom?: number | null;
  offsetX?: number | null;
  offsetY?: number | null;
  captionsEnabled?: boolean | null;
  framingSegments?: unknown;
  scale?: number | null;
  barColor?: string | null;
  textOverlays?: unknown;
};

type VideoRow = {
  id: number;
  sourceUrl: string | null;
  hostedStatus: string;
  hostedUrl: string | null;
  hostError?: string | null;
  hostProgress?: number | null;
  hostedOffset?: number | null;
  width?: number | null;
  height?: number | null;
  transcript?: string | null;
  transcriptWords?: unknown;
  /** False when imported with subtitles off, so no transcript exists yet. */
  transcriptionEnabled?: boolean | null;
};

// ─── Live preview + trim editor ───────────────────────────────────────────────
function ClipEditorModal({
  clip, video, apiKey, onDelete, onClose,
}: {
  clip: ClipRow;
  video: VideoRow | undefined;
  /** Needed for speech-to-text. */
  apiKey: string;
  onDelete: () => void;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const [title, setTitle] = useState(clip.title ?? `Clip #${clip.id}`);
  const [start, setStart] = useState(Math.max(0, Math.floor(clip.startTime ?? 0)));
  const [end, setEnd] = useState(Math.ceil(clip.endTime ?? (clip.startTime ?? 0) + 30));
  const [framing, setFraming] = useState<Framing>({
    zoom: clip.zoom ?? DEFAULT_FRAMING.zoom,
    offsetX: clip.offsetX ?? DEFAULT_FRAMING.offsetX,
    offsetY: clip.offsetY ?? DEFAULT_FRAMING.offsetY,
  });

  // ─── Undo/Redo for framing ─────────────────────────────────────────────────
  const [framingHistory, setFramingHistory] = useState<Framing[]>([]);
  const [framingFuture, setFramingFuture] = useState<Framing[]>([]);

  /** Wraps setFraming to push the previous value onto the undo stack. */
  const pushFraming = (next: Framing) => {
    setFramingHistory(h => [...h.slice(-30), framing]);
    setFramingFuture([]);
    setFraming(next);
  };

  const undo = () => {
    if (framingHistory.length === 0) return;
    const prev = framingHistory[framingHistory.length - 1];
    setFramingHistory(h => h.slice(0, -1));
    setFramingFuture(f => [...f, framing]);
    setFraming(prev);
  };

  const redo = () => {
    if (framingFuture.length === 0) return;
    const next = framingFuture[framingFuture.length - 1];
    setFramingFuture(f => f.slice(0, -1));
    setFramingHistory(h => [...h, framing]);
    setFraming(next);
  };

  // Ctrl+Z / Ctrl+Shift+Z keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && e.shiftKey) { e.preventDefault(); redo(); }
      if ((e.ctrlKey || e.metaKey) && e.key === "y") { e.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // Whether subtitles get burned into the export.
  const [captionsOn, setCaptionsOn] = useState(clip.captionsEnabled ?? true);
  // Video scale (how much of the 9:16 frame the video fills) and bar colour.
  const [videoScale, setVideoScale] = useState(clip.scale ?? 1);
  const [barColor, setBarColor] = useState(clip.barColor ?? "#000000");
  /*
   * The video was imported with subtitles off, so no speech-to-text has run and
   * there is no transcript. Changes the wording to offer generating one now.
   */
  const subtitlesOffForVideo = video?.transcriptionEnabled === false;

  /*
   * Timeline state. Framing segments and words are clip-relative seconds.
   * `selectedSegment` decides whether the reframe controls edit one section or
   * the whole clip.
   */
  const [segments, setSegments] = useState<TimelineSegment[]>(
    (clip.framingSegments as TimelineSegment[] | null) ?? []
  );
  const [music, setMusic] = useState<MusicTrack | null>(null);
  const [textOverlays, setTextOverlays] = useState<TextOverlay[]>(
    (clip.textOverlays as TextOverlay[] | null) ?? []
  );
  const [selectedSegment, setSelectedSegment] = useState<number | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [showTimeline, setShowTimeline] = useState(false);
  /** The exported MP4 gets a second player only on request; it is tall. */
  const [showRendered, setShowRendered] = useState(false);
  /*
   * Which end of a moving section the preview edits, and whether the preview is
   * currently playing. While playing, the framing follows the easing curve so
   * the move can be watched; when paused it shows the keyframe being edited.
   */
  const [editingKeyframe, setEditingKeyframe] = useState<Keyframe>("from");
  const [previewTime, setPreviewTime] = useState<number | null>(null);

  // Debounced so dragging the sliders does not reload the player on every pixel.
  const [previewRange, setPreviewRange] = useState({ start, end });
  useEffect(() => {
    const t = setTimeout(() => setPreviewRange({ start, end }), 350);
    return () => clearTimeout(t);
  }, [start, end]);

  const update = trpc.clips.update.useMutation({
    onSuccess: async () => {
      await utils.clips.list.invalidate();
      toast.success("Clip updated");
    },
    onError: err => toast.error(err.message),
  });

  const render = trpc.clips.render.useMutation({
    onSuccess: async () => {
      await utils.clips.list.invalidate();
      toast.info("Rendering started. It will play here as an MP4 when ready.");
    },
    onError: err => toast.error(err.message),
  });

  const host = trpc.videos.host.useMutation({
    onSuccess: async () => {
      await utils.videos.list.invalidate();
      toast.info("Importing the video to the server…");
    },
    onError: err => toast.error(err.message),
  });

  const saveSubtitles = trpc.subtitles.save.useMutation({
    onError: err => toast.error(`Could not save subtitles: ${err.message}`),
  });

  const transcribeClip = trpc.clips.transcribe.useMutation({
    onSuccess: async res => {
      await utils.subtitles.get.invalidate({ clipId: clip.id });
      // Transcribing on demand turns subtitles back on for the video.
      await utils.videos.list.invalidate();
      toast.success(
        res.timed
          ? `Transcribed ${res.wordCount} words with speech timings. Re-render to burn them in.`
          : `Transcribed, but the provider returned no word timings (${res.wordCount}).`
      );
    },
    onError: err => toast.error(err.message),
  });

  // Saved caption style, so the reframe view shows what will be burned in.
  const { data: savedSubtitle } = trpc.subtitles.get.useQuery({ clipId: clip.id });
  const captionStyle: SubtitleStyle = {
    ...DEFAULT_SUBTITLE_STYLE,
    ...((savedSubtitle?.style as Partial<SubtitleStyle> | null) ?? {}),
  };
  const captionWords = useMemo(
    () => previewWordsFor(video?.transcript ?? "", clip.startTime, []),
    [video?.transcript, clip.startTime]
  );

  // Per-caption free position (override the global style for a specific caption).
  // Stored as a map from word index → {posX, posY} so each caption can be dragged
  // independently. Cleared whenever the subtitles are reset.
  const [captionPositions, setCaptionPositions] = useState<Record<number, { posX: number; posY: number }>>({});

  /*
   * One transport for both players. `seek` carries a nonce so reporting the
   * playback position back up cannot trigger a further seek, and `playing` lets
   * the full-frame view mirror the main preview instead of running its own clock.
   */
  const [seek, setSeek] = useState<{ time: number; nonce: number } | null>(null);
  const [playing, setPlaying] = useState(false);
  const seekNonce = useRef(0);

  /** Moves the playhead and takes both players with it. */
  const scrubTo = (t: number) => {
    setPlayhead(t);
    setPreviewTime(null);
    seekNonce.current += 1;
    setSeek({ time: Math.max(0, start + t - hostedOffset), nonce: seekNonce.current });
  };



  /*
   * Words for the timeline, rebased to clip-relative seconds. Stored words use
   * absolute source times, which the timeline should not expose.
   */
  const clipStartAbs = clip.startTime ?? 0;
  const [timelineWords, setTimelineWords] = useState<TimelineWord[] | null>(null);

  const storedWords = savedSubtitle?.words as TimelineWord[] | null | undefined;
  const effectiveWords = useMemo<TimelineWord[]>(() => {
    if (timelineWords) return timelineWords;
    if (!Array.isArray(storedWords)) return [];
    return storedWords
      .map(w => ({ word: w.word, start: w.start - clipStartAbs, end: w.end - clipStartAbs }))
      .filter(w => w.end > 0);
  }, [timelineWords, storedWords, clipStartAbs]);

  /**
   * Only the caption belonging at the playhead.
   *
   * The overlay draws every word it is handed, so passing a whole clip's worth
   * stacked the transcript on top of the frame. The renderer shows one word at a
   * time, so the preview matches it. Falls back to the transcript sample when
   * there are no real word timings to place.
   *
   * When the playhead sits between words (or before/after all words), we show
   * the most-recent word that has already started — this prevents "nothing" from
   * appearing when the video is paused between subtitle events.
   */
  const visibleCaption = useMemo(() => {
    if (effectiveWords.length > 0) {
      // Exact match: playhead is inside this word's spoken range.
      const at = effectiveWords.findIndex(w => playhead >= w.start && playhead < w.end);
      if (at !== -1) {
        return { words: [effectiveWords[at].word], activeIndex: 0, wordIndex: at };
      }
      // Between words: show nothing. Displaying a stale word during silence
      // (music, pauses, B-roll) is worse than showing nothing at all.
      return null;
    }
    return captionWords.length > 0 ? { words: captionWords, activeIndex: 0, wordIndex: -1 } : null;
  }, [effectiveWords, playhead, captionWords]);

  const hostedStatus = (video?.hostedStatus ?? "none") as "none" | "downloading" | "ready" | "error";
  const hostedUrl = video?.hostedUrl ?? null;
  // Partial imports shift the hosted timeline; clip times are absolute.
  const hostedOffset = video?.hostedOffset ?? 0;
  const sourceYtId = parseYouTubeId(video?.sourceUrl);
  const duration = Math.max(0, end - start);
  const valid = end > start;
  const isRendered = !!clip.downloadUrl && clip.downloadUrl !== "#";
  const rendering = clip.status === "rendering";
  const canRender = valid && hostedStatus === "ready" && !rendering && !render.isPending && !update.isPending;

  // Persist edits, then render from the saved values.
  /**
   * Framing edits apply to the selected timeline section, or to the whole clip
   * when nothing is selected.
   */
  const applyFraming = (next: Framing) => {
    const list = materialiseSegments(segments, duration, framing);
    if (selectedSegment != null && list[selectedSegment]) {
      const moving = isAnimated(list[selectedSegment]);
      setSegments(setSegmentKeyframe(
        list, selectedSegment, moving ? editingKeyframe : "from", next
      ));
    } else {
      // Track for undo: only push when this is a new distinct change.
      if (
        Math.abs(framing.zoom - next.zoom) > 0.01 ||
        Math.abs(framing.offsetX - next.offsetX) > 0.01 ||
        Math.abs(framing.offsetY - next.offsetY) > 0.01
      ) {
        // Debounce: only push to history if last push was >300ms ago
        const now = Date.now();
        if (now - lastFramingPushRef.current > 300) {
          setFramingHistory(h => [...h.slice(-30), framing]);
          setFramingFuture([]);
          lastFramingPushRef.current = now;
        }
      }
      setFraming(next);
    }
  };
  const lastFramingPushRef = useRef(0);

  /**
   * The framing the preview should show right now.
   *
   * While playing, this follows the animation so the eased move is visible. When
   * paused it shows the keyframe being edited, which is what dragging adjusts.
   */
  const activeFraming: Framing = useMemo(() => {
    const list = materialiseSegments(segments, duration, framing);

    if (previewTime != null) {
      /*
       * Preview time is on the hosted timeline. Segments are relative to the
       * clip's current start, which is what the timeline's axis measures.
       */
      const inClip = previewTime + hostedOffset - start;
      const idx = segmentAt(list, inClip);
      if (idx != null) return framingAt(list[idx], inClip);
    }

    if (selectedSegment != null && list[selectedSegment]) {
      const seg = list[selectedSegment];
      return isAnimated(seg) && editingKeyframe === "to"
        ? segmentTarget(seg)
        : framingAt(seg, seg.start);
    }
    return framing;
  }, [
    segments, duration, framing, previewTime, hostedOffset, start,
    selectedSegment, editingKeyframe,
  ]);

  /**
   * What the preview plays: just the selected section, so its movement can be
   * watched on its own, otherwise the whole clip.
   */
  const previewSpan = useMemo(() => {
    const list = materialiseSegments(segments, duration, framing);
    if (selectedSegment != null && list[selectedSegment]) {
      const seg = list[selectedSegment];
      return { start: start + seg.start, end: start + seg.end };
    }
    return previewRange;
  }, [segments, duration, framing, selectedSegment, start, previewRange]);

  const saveAll = async () => {
    await update.mutateAsync({
      id: clip.id, title, startTime: start, endTime: end,
      ...framing, captionsEnabled: captionsOn,
      scale: videoScale, barColor,
      framingSegments: segments,
      textOverlays: textOverlays.length > 0 ? textOverlays : undefined,
    });

    // Persist edited words back as absolute source times.
    if (timelineWords) {
      await saveSubtitles.mutateAsync({
        clipId: clip.id,
        style: captionStyle,
        words: timelineWords.map(w => ({
          word: w.word,
          start: w.start + clipStartAbs,
          end: w.end + clipStartAbs,
        })),
      });
    }
  };

  const saveAndRender = async () => {
    try {
      await saveAll();
      await render.mutateAsync({ id: clip.id, ...framing, captionsEnabled: captionsOn });
    } catch { /* surfaced by the mutation handlers */ }
  };

  // Esc closes the editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const nudge = (which: "start" | "end", delta: number) => {
    if (which === "start") setStart(s => Math.max(0, s + delta));
    else setEnd(e => Math.max(1, e + delta));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" />
      <div
        className="relative z-10 w-full max-w-5xl max-h-[94vh] overflow-y-auto animate-scale-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold text-white truncate pr-4" style={{ fontFamily: "Montserrat, sans-serif" }}>
            {title}
          </h3>
          <div className="flex items-center gap-1 shrink-0">
            <button onClick={onDelete} title="Delete clip" aria-label="Delete clip"
              className="p-2 rounded-xl text-white/60 hover:text-white transition-colors"
              style={{ background: "rgba(229, 72, 77, 0.08)" }}>
              <Trash2 className="w-4 h-4" />
            </button>
            <button onClick={onClose} className="p-2 rounded-xl text-white/60 hover:text-white hover:bg-white/10 transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="grid gap-5 md:grid-cols-[320px_1fr]">
          {/* Live player — 9:16 */}
          <div className="mx-auto w-full" style={{ maxWidth: "320px" }}>
            {hostedStatus === "ready" && hostedUrl ? (
              <>
                {/* The exported result at full size. */}
                <CropView
                  src={hostedUrl}
                  framing={activeFraming}
                  onChange={applyFraming}
                  startTime={previewSpan.start - hostedOffset}
                  endTime={previewSpan.end - hostedOffset}
                  className="w-full shadow-2xl"
                  scale={videoScale}
                  barColor={barColor}
                  onTime={t => {
                    setPreviewTime(t);
                    setPlayhead(Math.max(0, t + hostedOffset - start));
                  }}
                  seekTo={seek}
                  onPlayingChange={setPlaying}
                >
                  {/* Mirror the toggle so the preview matches the export.
                      The overlay is draggable: each caption's position is
                      stored separately so different words can be placed
                      anywhere on the frame. */}
                  {captionsOn && visibleCaption && (() => {
                    const captionIdx = visibleCaption.wordIndex;
                    const posOverride = captionIdx >= 0 ? captionPositions[captionIdx] : undefined;
                    return (
                      <SubtitleOverlay
                        words={visibleCaption.words}
                        activeIndex={visibleCaption.activeIndex}
                        style={captionStyle}
                        positionOverride={posOverride}
                        onPositionChange={pos => {
                          if (captionIdx >= 0) {
                            setCaptionPositions(prev => ({ ...prev, [captionIdx]: pos }));
                          }
                        }}
                      />
                    );
                  })()}
                  {/* Text overlays visible at current playhead */}
                  {textOverlays.filter(o => playhead >= o.start && playhead < o.end).map(o => (
                    <div
                      key={o.id}
                      className="absolute left-0 right-0 flex justify-center pointer-events-none z-30"
                      style={{ top: `${o.posY * 100}%` }}
                    >
                      <span
                        className="font-black text-center px-2"
                        style={{
                          fontSize: `${o.fontSize * 0.6}%`,
                          color: o.color,
                          textShadow: "0 2px 8px rgba(0,0,0,0.8), 0 0 2px rgba(0,0,0,0.9)",
                          fontFamily: "Montserrat, Inter, sans-serif",
                        }}
                      >
                        {o.text}
                      </span>
                    </div>
                  ))}
                </CropView>

                {/* Full frame, for choosing what the vertical crop keeps. */}
                <div className="mt-3">
                  <p className="text-[11px] font-semibold text-white/70 mb-1.5">
                    {selectedSegment != null
                      ? `Full frame — setting where section ${selectedSegment + 1} ${editingKeyframe === "to" ? "ends" : "starts"}`
                      : "Full frame — drag the box to reframe"}
                  </p>
                  <VideoFramer
                    src={hostedUrl}
                    framing={activeFraming}
                    onChange={applyFraming}
                    startTime={previewSpan.start - hostedOffset}
                    endTime={previewSpan.end - hostedOffset}
                    // previewTime is the raw video currentTime reported by CropView.
                    // Pass it directly so both players show the exact same frame.
                    followTime={previewTime}
                    followPlaying={playing}
                  />
                </div>
              </>
            ) : isRendered ? (
              /*
               * Not imported, but there is a finished MP4. Showing that is far
               * more useful than an empty "not imported" placeholder, and it
               * keeps the modal to one video instead of stacking two.
               */
              <ClipPreview
                url={clip.downloadUrl}
                className="rounded-2xl shadow-2xl w-full"
                style={{ aspectRatio: "9/16" }}
              />
            ) : (
              <ClipPreview
                url={hostedStatus === "error" ? null : (video?.sourceUrl ?? null)}
                hostingStatus={hostedStatus}
                hostingProgress={video?.hostProgress ?? 0}
                onHost={video ? () => host.mutate({ id: video.id, startTime: start, endTime: end }) : undefined}
                className="rounded-2xl shadow-2xl w-full"
                style={{ aspectRatio: "9/16" }}
              />
            )}

            <p className="mt-2 text-[11px] text-center text-white/50">
              {hostedStatus === "ready"
                ? rendering
                  ? "Rendering your MP4 — it will appear here when ready."
                  : isRendered
                    ? "Move the frame to reframe. Re-render to bake in changes."
                    : "Drag the frame to choose what stays in the vertical crop."
                : hostedStatus === "downloading"
                  ? `Importing the video… ${video?.hostProgress ?? 0}%`
                  : isRendered
                    ? "Your exported clip. Import the source again to reframe or re-render it."
                    : "Import the video to preview and edit it here."}
            </p>

            {/* Offer the import without an empty player taking up the space. */}
            {hostedStatus !== "ready" && hostedStatus !== "downloading" && isRendered && video && (
              <button
                onClick={() => host.mutate({ id: video.id, startTime: start, endTime: end })}
                disabled={host.isPending}
                className="mt-2 w-full flex items-center justify-center gap-2 py-2 rounded-xl text-[11px] font-bold transition-colors disabled:opacity-40"
                style={{ background: "rgba(49, 94, 245, 0.08)", color: "var(--cobalt)" }}
              >
                {host.isPending
                  ? <><Loader2 className="w-3 h-3 animate-spin" /> Importing…</>
                  : <><Download className="w-3 h-3" /> Import source to edit</>}
              </button>
            )}

            {hostedStatus === "error" && video?.hostError && (
              <p className="mt-2 text-[11px] text-center leading-relaxed" style={{ color: "oklch(0.72 0.19 45)" }}>
                {video.hostError}
              </p>
            )}

            {/* Captions need a transcript on the video row to burn in. */}
            {hostedStatus === "ready" && !video?.transcript && (
              <p className="mt-2 text-[11px] text-center leading-relaxed" style={{ color: "oklch(0.78 0.16 85)" }}>
                This video has no saved transcript, so the export will have no captions.
                Re-run it through Create to extract one.
              </p>
            )}

            {/* Be explicit about caption sync, since estimated timings drift. */}
            {hostedStatus === "ready" && video?.transcript && (
              <p className="mt-2 text-[11px] text-center leading-relaxed text-white/45">
                {video.transcriptWords
                  ? "Captions use real timings from the source track."
                  : "Captions have no source timings, so they are spread evenly and will drift from speech."}
              </p>
            )}

            {/*
              * The finished clip. Only worth a second player when the editing
              * preview is already occupying the first one — otherwise it is
              * shown above instead. Collapsed by default so the modal does not
              * become two full-height videos tall.
              */}
            {isRendered && hostedStatus === "ready" && (
              <div className="mt-3">
                <button
                  onClick={() => setShowRendered(v => !v)}
                  className="w-full flex items-center justify-between gap-2 text-[11px] font-semibold text-white/70 hover:text-white transition-colors"
                >
                  <span>Rendered result</span>
                  <ChevronDown
                    className={`w-3.5 h-3.5 transition-transform ${showRendered ? "rotate-180" : ""}`}
                  />
                </button>
                {showRendered && (
                  <ClipPreview
                    url={clip.downloadUrl}
                    className="rounded-xl w-full mt-1.5"
                    style={{ aspectRatio: "9/16" }}
                  />
                )}
              </div>
            )}
          </div>

          {/* Live edit controls */}
          <div className="space-y-4">
          <div className="glass rounded-2xl p-5 space-y-5">
            <div className="flex items-center gap-2">
              <Scissors className="w-4 h-4" style={{ color: "var(--cobalt)" }} />
              <span className="text-sm font-bold text-foreground">Live Edit</span>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">Title</label>
              <input
                value={title}
                onChange={e => setTitle(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-input border border-border text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>

            {/* Start */}
            <TrimControl
              label="Start"
              value={start}
              max={Math.max(end + 300, 600)}
              onChange={setStart}
              onNudge={d => nudge("start", d)}
            />

            {/* End */}
            <TrimControl
              label="End"
              value={end}
              max={Math.max(end + 300, 600)}
              onChange={setEnd}
              onNudge={d => nudge("end", d)}
            />

            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Clip length</span>
              <span className={`font-bold ${valid ? "text-foreground" : "text-red-400"}`}>
                {valid ? `${duration}s` : "End must be after start"}
              </span>
            </div>

            {duration > 0 && (duration < 5 || duration > 180) && valid && (
              <p className="text-[11px] text-yellow-400/80">
                {duration < 5
                  ? "Very short clips rarely perform well. 15–60s is the sweet spot."
                  : "Long clips lose retention on short-form platforms."}
              </p>
            )}

            <div className="flex gap-2 pt-1">
              <button
                onClick={() => { void saveAll().then(() => toast.success("Clip saved")).catch(() => {}); }}
                disabled={!valid || update.isPending || saveSubtitles.isPending}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-bold text-foreground bg-secondary/70 transition-all hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {update.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Save className="w-4 h-4" /> Save</>}
              </button>
              <button
                onClick={() => {
                  setTitle(clip.title ?? `Clip #${clip.id}`);
                  setStart(Math.max(0, Math.floor(clip.startTime ?? 0)));
                  setEnd(Math.ceil(clip.endTime ?? (clip.startTime ?? 0) + 30));
                  setFraming({
                    zoom: clip.zoom ?? DEFAULT_FRAMING.zoom,
                    offsetX: clip.offsetX ?? DEFAULT_FRAMING.offsetX,
                    offsetY: clip.offsetY ?? DEFAULT_FRAMING.offsetY,
                  });
                  // Also discard timeline edits, so Reset is a true revert.
                  setSegments((clip.framingSegments as TimelineSegment[] | null) ?? []);
                  setSelectedSegment(null);
                  setTimelineWords(null);
                  setCaptionPositions({});
                }}
                className="px-4 py-2.5 rounded-xl text-sm font-semibold text-muted-foreground bg-secondary/60 hover:text-foreground transition-colors"
              >
                Reset
              </button>
            </div>

            {/* Undo / Redo */}
            <div className="flex items-center gap-1">
              <button
                onClick={undo}
                disabled={framingHistory.length === 0}
                title="Undo (Ctrl+Z)"
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold transition-all hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <Undo2 className="w-3.5 h-3.5" /> Undo
              </button>
              <button
                onClick={redo}
                disabled={framingFuture.length === 0}
                title="Redo (Ctrl+Shift+Z)"
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold transition-all hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <Redo2 className="w-3.5 h-3.5" /> Redo
              </button>
            </div>

            {/* Timeline: per-section zoom and subtitle word editing. */}
            <button
              onClick={() => setShowTimeline(v => !v)}
              disabled={hostedStatus !== "ready"}
              className="w-full flex items-center justify-center gap-2 py-2 rounded-xl text-xs font-bold transition-all hover:opacity-90 disabled:opacity-40"
              style={{ background: "var(--secondary)", color: "var(--foreground)" }}
            >
              <Clock className="w-3.5 h-3.5" />
              {showTimeline ? "Hide timeline" : "Timeline · zoom per section & edit words"}
              {segments.length > 1 && !showTimeline && (
                <span className="px-1.5 py-0.5 rounded text-[10px]"
                  style={{ background: "rgba(49, 94, 245, 0.12)", color: "var(--cobalt)" }}>
                  {segments.length} sections
                </span>
              )}
            </button>

            {/* Video scale — make the video smaller within the 9:16 frame */}
            <div className="space-y-2 py-1">
              <div className="flex items-center gap-2">
                <Maximize2 className="w-4 h-4 text-muted-foreground" />
                <div className="flex-1">
                  <p className="text-sm font-semibold text-foreground leading-tight">Video Size</p>
                  <p className="text-[11px] text-muted-foreground">
                    {videoScale >= 0.999 ? "Full frame" : `${Math.round(videoScale * 100)}% — bars visible`}
                  </p>
                </div>
                <span className="text-[11px] font-bold text-foreground tabular-nums w-10 text-right">
                  {Math.round(videoScale * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={0.3}
                max={1}
                step={0.05}
                value={videoScale}
                onChange={e => setVideoScale(Number(e.target.value))}
                className="w-full accent-[var(--cobalt)]"
                aria-label="Video scale"
              />
              {videoScale < 0.999 && (
                <div className="flex items-center gap-2 pt-1">
                  <span className="text-[11px] text-muted-foreground">Bar colour</span>
                  <input
                    type="color"
                    value={barColor}
                    onChange={e => setBarColor(e.target.value)}
                    className="w-7 h-7 rounded-md border border-white/10 cursor-pointer"
                    style={{ padding: 1 }}
                    aria-label="Background bar colour"
                  />
                  <span className="text-[11px] font-mono text-muted-foreground">{barColor}</span>
                </div>
              )}
            </div>

            {/* Subtitles on/off for the export. */}
            <div className="flex items-center justify-between gap-3 py-1">
              <div className="flex items-center gap-2">
                <Captions className="w-4 h-4" style={{ color: captionsOn ? "var(--cobalt)" : "var(--muted-foreground)" }} />
                <div>
                  <p className="text-sm font-semibold text-foreground leading-tight">Burn in subtitles</p>
                  <p className="text-[11px] text-muted-foreground">
                    {captionsOn ? "Captions baked into the MP4" : "Clean clip, no text"}
                  </p>
                </div>
              </div>
              <button
                role="switch"
                aria-checked={captionsOn}
                aria-label="Burn subtitles into the exported clip"
                onClick={() => setCaptionsOn(v => !v)}
                className="w-11 h-6 rounded-full transition-colors relative shrink-0"
                style={{ background: captionsOn ? "var(--cobalt)" : "var(--secondary)" }}
              >
                <span
                  className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all"
                  style={{ left: captionsOn ? "1.375rem" : "0.125rem" }}
                />
              </button>
            </div>

            {/* Speech-to-text on the clip's own audio: the only way to get
                captions that actually track the speech.

                `force` is set because pressing this button is an explicit
                request, which is also what re-enables subtitles for a video
                that was imported with them switched off. */}
            {captionsOn && <button
              onClick={() => {
                if (!apiKey) { return; }
                transcribeClip.mutate({ id: clip.id, apiKey, force: true });
              }}
              disabled={hostedStatus !== "ready" || transcribeClip.isPending}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-bold transition-all hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ background: "rgba(221, 125, 113, 0.1)", color: "var(--coral)" }}
            >
              {transcribeClip.isPending
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Transcribing audio…</>
                : subtitlesOffForVideo
                  ? <><Mic className="w-4 h-4" /> Generate Transcript Now</>
                  : <><Mic className="w-4 h-4" /> {savedSubtitle?.words ? "Re-transcribe captions" : "Transcribe captions (accurate)"}</>}
            </button>}

            {captionsOn && (subtitlesOffForVideo ? (
              <p className="text-[11px] text-center text-muted-foreground">
                This video was imported with subtitles off, so nothing has been
                transcribed yet and no AI credits were used. Generate a transcript
                to get captions for this clip.
              </p>
            ) : savedSubtitle?.words ? (
              <p className="text-[11px] text-center" style={{ color: "var(--mint)" }}>
                Captions transcribed from this clip's audio.
              </p>
            ) : (
              <p className="text-[11px] text-center text-muted-foreground">
                Transcribe for captions that match the speech. Otherwise the source
                caption track is used, which drifts.
              </p>
            ))}

            {/* Bakes the trim and framing into a real MP4 we host and play. */}
            <button
              onClick={saveAndRender}
              disabled={!canRender}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-bold text-white transition-all hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ background: "linear-gradient(135deg, var(--cobalt), oklch(0.55 0.22 270))" }}
            >
              {rendering || render.isPending
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Rendering…</>
                : <><Film className="w-4 h-4" /> {isRendered ? "Re-render MP4" : "Save & Render MP4"}</>}
            </button>

            {hostedStatus !== "ready" && (
              <p className="text-[11px] text-center text-muted-foreground">
                {hostedStatus === "downloading"
                  ? "Rendering unlocks once the import finishes."
                  : "Import the video first to render clips."}
              </p>
            )}

            {isRendered && clip.downloadUrl && (
              <a
                href={downloadUrl(clip.downloadUrl)}
                download
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-bold transition-all hover:opacity-90"
                style={{ background: "rgba(89, 164, 133, 0.1)", color: "var(--mint)" }}
              >
                <Download className="w-4 h-4" /> Download MP4
              </a>
            )}

            {/* Attribution back to the original source. */}
            {sourceYtId && (
              <a
                href={youTubeWatchUrl(sourceYtId, start)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <ExternalLink className="w-3.5 h-3.5" /> View original at {formatTime(start)}
              </a>
            )}
          </div>

          {/* The timeline sits below the controls so it can span the width. */}
          {/*
            * Not gated on the import: subtitle timings and zoom sections are
            * plain data and editing them needs no video. Only the preview above
            * does, so the timeline stays usable either way.
            */}
          {showTimeline && (
            <ClipTimeline
              duration={Math.max(1, end - start)}
              segments={segments}
              onSegmentsChange={setSegments}
              selectedSegment={selectedSegment}
              onSelectSegment={setSelectedSegment}
              words={effectiveWords}
              onWordsChange={setTimelineWords}
              playheadSeconds={playhead}
              onScrub={scrubTo}
              baseFraming={framing}
              editingKeyframe={editingKeyframe}
              onEditingKeyframeChange={setEditingKeyframe}
              music={music}
              onMusicChange={setMusic}
              textOverlays={textOverlays}
              onTextOverlaysChange={setTextOverlays}
            />
          )}
          </div>
        </div>
      </div>

      {/* Music player — invisible, synced to the clip playhead */}
      {music && (
        <MusicPlayer
          music={music}
          playing={playing}
          playheadSeconds={playhead}
        />
      )}
    </div>
  );
}

function TrimControl({
  label, value, max, onChange, onNudge,
}: {
  label: string;
  value: number;
  max: number;
  onChange: (v: number) => void;
  onNudge: (delta: number) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-muted-foreground">{label}</label>
        <div className="flex items-center gap-1">
          <button onClick={() => onNudge(-1)}
            className="px-2 py-0.5 rounded-md text-xs font-bold bg-secondary/60 text-muted-foreground hover:text-foreground transition-colors">
            −1s
          </button>
          <span className="min-w-[52px] text-center text-xs font-bold text-foreground tabular-nums">
            {formatTime(value)}
          </span>
          <button onClick={() => onNudge(1)}
            className="px-2 py-0.5 rounded-md text-xs font-bold bg-secondary/60 text-muted-foreground hover:text-foreground transition-colors">
            +1s
          </button>
        </div>
      </div>
      <input
        type="range"
        min={0}
        max={max}
        step={1}
        value={Math.min(value, max)}
        onChange={e => onChange(Number(e.target.value))}
        className="w-full accent-[var(--cobalt)]"
        aria-label={`${label} time in seconds`}
      />
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function ClipsPage() {
  // API key is now handled server-side via .env
  const apiKey = "server";
  // Poll so newly created clips appear live without a manual refresh.
  const { data: clips, isLoading } = trpc.clips.list.useQuery(undefined, {
    refetchInterval: 5000,
    refetchOnWindowFocus: true,
  });
  // Poll too, so an in-flight import flips the UI to ready on its own.
  const { data: videos } = trpc.videos.list.useQuery(undefined, { refetchInterval: 5000 });
  const utils = trpc.useUtils();
  const [editingId, setEditingId] = useState<number | null>(null);

  const render = trpc.clips.render.useMutation({
    onSuccess: async () => {
      await utils.clips.list.invalidate();
      toast.info("Rendering started. The clip will appear in our player when it is ready.");
    },
    onError: err => toast.error(err.message),
  });

  const host = trpc.videos.host.useMutation({
    onSuccess: async () => {
      await utils.videos.list.invalidate();
      toast.info("Importing the video to the server…");
    },
    onError: err => toast.error(err.message),
  });

  const remove = trpc.clips.delete.useMutation({
    onSuccess: async () => {
      await utils.clips.list.invalidate();
      toast.success("Clip deleted");
    },
    onError: err => toast.error(err.message),
  });

  const videoFor = (clip: { videoId: number }) =>
    videos?.find(v => v.id === clip.videoId) as VideoRow | undefined;

  const confirmDelete = (clip: ClipRow) => {
    const name = clip.title ?? `Clip #${clip.id}`;
    // Deleting also removes the rendered file, so confirm before doing it.
    if (!window.confirm(`Delete "${name}"? This also removes its rendered MP4 and cannot be undone.`)) return;
    if (editingId === clip.id) setEditingId(null);
    remove.mutate({ id: clip.id });
  };

  const handleRender = (id: number) => render.mutate({ id });

  // Read the clip fresh from polled data so the modal stays current.
  const editingClip = editingId != null
    ? (clips?.find(c => c.id === editingId) as ClipRow | undefined) ?? null
    : null;

  return (
    <AppLayout title="Clips">
      {editingClip && (
        <ClipEditorModal
          clip={editingClip}
          video={videoFor(editingClip)}
          apiKey={apiKey}
          onDelete={() => confirmDelete(editingClip)}
          onClose={() => setEditingId(null)}
        />
      )}

      <div className="mb-6 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-bold text-foreground mb-1" style={{ fontFamily: "Montserrat, sans-serif" }}>Your Clips</h2>
          <p className="text-sm text-muted-foreground">Preview clips live, trim them in place, and export when you are happy.</p>
        </div>
        {clips && clips.length > 0 && (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-secondary/60 text-xs text-muted-foreground">
            <Film className="w-3.5 h-3.5" /> {clips.length} clip{clips.length !== 1 ? "s" : ""}
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : !clips?.length ? (
        <div className="flex flex-col items-center justify-center py-20 gap-4">
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center" style={{ background: "var(--secondary)" }}>
            <Film className="w-8 h-8 text-muted-foreground" />
          </div>
          <div className="text-center">
            <p className="text-base font-semibold text-foreground mb-1">No clips yet</p>
            <p className="text-sm text-muted-foreground">Use the Create workflow or AI Highlights to generate clips.</p>
          </div>
          <a href="/dashboard/create">
            <button className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90"
              style={{ background: "var(--cobalt)" }}>
              <Zap className="w-4 h-4" /> Start Creating
            </button>
          </a>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {clips.map(clip => {
            const row = clip as ClipRow;
            const video = videoFor(clip);
            const hostedStatus = (video?.hostedStatus ?? "none") as "none" | "downloading" | "ready" | "error";
            const ytId = parseYouTubeId(video?.sourceUrl);
            const open = () => setEditingId(clip.id);

            return (
              <div key={clip.id} className="glass rounded-2xl overflow-hidden hover:border-primary/30 transition-colors group">
                {/* Thumbnail — real poster frame when we have one */}
                <div
                  className="relative cursor-pointer overflow-hidden"
                  style={{ aspectRatio: "9/16", maxHeight: "200px", background: "linear-gradient(135deg, #0a0a1a, #1a0a2e)" }}
                  onClick={open}
                >
                  {ytId && (
                    <img
                      src={youTubeThumbnail(ytId)}
                      alt=""
                      className="absolute inset-0 w-full h-full object-cover"
                      loading="lazy"
                    />
                  )}
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="w-12 h-12 rounded-full flex items-center justify-center transition-transform group-hover:scale-110"
                      style={{ background: "rgba(49, 94, 245, 0.18)", backdropFilter: "blur(4px)" }}>
                      <Play className="w-5 h-5 ml-0.5 text-white" />
                    </div>
                  </div>
                  <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    style={{ background: "rgba(0,0,0,0.4)" }}>
                    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold text-white"
                      style={{ background: "var(--cobalt)" }}>
                      <Maximize2 className="w-3.5 h-3.5" /> Preview & Edit
                    </div>
                  </div>
                  <div className="absolute top-2 right-2"><StatusBadge status={clip.status} /></div>

                  {/* Delete — stopPropagation so it does not open the editor. */}
                  <button
                    onClick={e => { e.stopPropagation(); confirmDelete(row); }}
                    disabled={remove.isPending}
                    aria-label={`Delete ${clip.title ?? `clip ${clip.id}`}`}
                    title="Delete clip"
                    className="absolute top-2 left-2 p-1.5 rounded-lg text-white/70 hover:text-white transition-colors disabled:opacity-40"
                    style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(4px)" }}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                  {clip.engagementScore != null && (
                    <div className="absolute bottom-2 left-2 flex items-center gap-1 px-2 py-0.5 rounded-lg text-xs font-bold"
                      style={{ background: "rgba(89, 164, 133, 0.12)", color: "var(--mint)" }}>
                      <TrendingUp className="w-3 h-3" /> {clip.engagementScore}
                    </div>
                  )}
                </div>

                {/* Info */}
                <div className="p-4">
                  <h3 className="text-sm font-bold text-foreground mb-2 truncate" style={{ fontFamily: "Montserrat, sans-serif" }}>
                    {clip.title ?? `Clip #${clip.id}`}
                  </h3>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground mb-3">
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />{formatTime(clip.startTime)}–{formatTime(clip.endTime)}
                    </span>
                    {clip.startTime != null && clip.endTime != null && (
                      <span>{Math.round(clip.endTime - clip.startTime)}s</span>
                    )}
                    <FramingBadge framing={{
                      zoom: row.zoom ?? 1,
                      offsetX: row.offsetX ?? 0,
                      offsetY: row.offsetY ?? 0,
                    }} />
                  </div>

                  {/* Failures state their reason so they are not a dead end. */}
                  {hostedStatus === "error" && video?.hostError ? (
                    <p className="text-[11px] mb-3 leading-relaxed" style={{ color: "oklch(0.72 0.19 45)" }}>
                      {video.hostError}
                    </p>
                  ) : clip.status === "error" && row.errorMessage ? (
                    <p className="text-[11px] mb-3 leading-relaxed" style={{ color: "oklch(0.72 0.19 45)" }}>
                      {row.errorMessage}
                    </p>
                  ) : null}

                  <div className="flex gap-2">
                    <button onClick={open}
                      className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-all hover:opacity-80"
                      style={{ background: "rgba(49, 94, 245, 0.08)", color: "var(--cobalt)" }}>
                      <Play className="w-3.5 h-3.5" /> Preview
                    </button>

                    {/* Importing the video is the gate for everything else. */}
                    {hostedStatus === "none" && video && (
                      <button onClick={() => host.mutate({ id: video.id, startTime: clip.startTime ?? undefined, endTime: clip.endTime ?? undefined })} disabled={host.isPending}
                        className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold text-white transition-all hover:opacity-80 disabled:opacity-50"
                        style={{ background: "var(--cobalt)" }}>
                        <CloudDownload className="w-3.5 h-3.5" /> Import
                      </button>
                    )}
                    {hostedStatus === "downloading" && (
                      <div className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold text-muted-foreground bg-secondary/60">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        {video?.hostProgress ? `${video.hostProgress}%` : "Importing…"}
                      </div>
                    )}

                    {hostedStatus === "ready" && clip.status === "rendering" && (
                      <div className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold text-muted-foreground bg-secondary/60">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Rendering…
                      </div>
                    )}
                    {hostedStatus === "ready" && clip.status !== "rendering" && (
                      clip.downloadUrl && clip.downloadUrl !== "#" ? (
                        <a href={downloadUrl(clip.downloadUrl)} download
                          className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-all hover:opacity-80"
                          style={{ background: "rgba(89, 164, 133, 0.1)", color: "var(--mint)" }}>
                          <Download className="w-3.5 h-3.5" /> Download
                        </a>
                      ) : (
                        <button onClick={() => handleRender(clip.id)} disabled={render.isPending}
                          className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold text-white transition-all hover:opacity-80 disabled:opacity-50"
                          style={{ background: "var(--cobalt)" }}>
                          <Zap className="w-3.5 h-3.5" /> Render MP4
                        </button>
                      )
                    )}
                    {/* A failed import is retried on the video, not the clip. */}
                    {hostedStatus === "error" && video && (
                      <button onClick={() => host.mutate({ id: video.id, startTime: clip.startTime ?? undefined, endTime: clip.endTime ?? undefined })}
                        className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-all hover:opacity-80"
                        style={{ background: "rgba(229, 72, 77, 0.08)", color: "oklch(0.62 0.22 25)" }}>
                        Retry import
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </AppLayout>
  );
}
