import { useEffect, useMemo, useRef, useState } from "react";
import { Film, Play, Pause, Volume2, VolumeX, RotateCcw, CloudDownload, AlertCircle, Loader2 } from "lucide-react";
import { resolveVideoSource, formatTime } from "@/lib/videoSource";

/**
 * Clip preview.
 *
 * Plays only media we host, in our own player. A source that has not been
 * hosted yet shows a prompt rather than an external embed, so no third-party
 * player chrome or captions can appear anywhere in the app.
 */
export function ClipPreview({
  url,
  startTime,
  endTime,
  className,
  style,
  autoPlay = false,
  loop = true,
  hostingStatus,
  hostingProgress,
  onHost,
  children,
}: {
  url: string | null | undefined;
  startTime?: number | null;
  endTime?: number | null;
  className?: string;
  style?: React.CSSProperties;
  autoPlay?: boolean;
  loop?: boolean;
  /** Drives the not-yet-hosted state. */
  hostingStatus?: "none" | "downloading" | "ready" | "error";
  /** 0-100 while importing. */
  hostingProgress?: number;
  onHost?: () => void;
  /** Overlay content, e.g. subtitles. */
  children?: React.ReactNode;
}) {
  const source = useMemo(() => resolveVideoSource(url), [url]);

  // When the video is being imported (or needs to be), show that state
  // regardless of what the URL resolves to — it is not playable yet.
  if (hostingStatus === "downloading" || hostingStatus === "none") {
    return (
      <NeedsHosting
        className={className}
        style={style}
        status={hostingStatus}
        progress={hostingProgress ?? 0}
        onHost={onHost}
      />
    );
  }

  if (source.kind === "hosted" || source.kind === "local") {
    return (
      <HostedClip
        src={source.url}
        startTime={startTime}
        endTime={endTime}
        className={className}
        style={style}
        autoPlay={autoPlay}
        loop={loop}
      >
        {children}
      </HostedClip>
    );
  }

  if (source.kind === "needs-hosting") {
    return (
      <NeedsHosting
        className={className}
        style={style}
        status={hostingStatus ?? "none"}
        progress={hostingProgress ?? 0}
        onHost={onHost}
      />
    );
  }

  return <Placeholder className={className} style={style} message={
    hostingStatus === "error"
      ? "The import failed. Try again."
      : undefined
  } icon={hostingStatus === "error" ? "error" : "film"} />;
}

// ─── Our player ───────────────────────────────────────────────────────────────
function HostedClip({
  src, startTime, endTime, className, style, autoPlay, loop, children,
}: {
  src: string;
  startTime?: number | null;
  endTime?: number | null;
  className?: string;
  style?: React.CSSProperties;
  autoPlay?: boolean;
  loop?: boolean;
  children?: React.ReactNode;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(!!autoPlay);
  const [progress, setProgress] = useState(0);
  const [failed, setFailed] = useState(false);
  const [waiting, setWaiting] = useState(true);

  /**
   * A rendered clip already contains only the selected range, so it plays from
   * 0. A hosted full-length source needs the in/out points applied.
   */
  const isRenderedClip = /\/api\/media\/clip\//.test(src);
  const start = isRenderedClip ? 0 : Math.max(0, startTime ?? 0);
  const end = isRenderedClip ? null : (endTime ?? null);

  // Labels always show the real clip times.
  const labelStart = Math.max(0, Math.floor(startTime ?? 0));
  const labelEnd = Math.ceil(endTime ?? labelStart);

  useEffect(() => { setFailed(false); setWaiting(true); }, [src]);

  // Seek to the in point whenever the range or source changes.
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

  const toggle = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      if (end != null && v.currentTime >= end) v.currentTime = start;
      void v.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    } else {
      v.pause();
      setPlaying(false);
    }
  };

  const onTimeUpdate = () => {
    const v = videoRef.current;
    if (!v) return;

    if (end != null && v.currentTime >= end) {
      if (loop) v.currentTime = start;
      else { v.pause(); setPlaying(false); return; }
    }

    const to = end ?? (Number.isFinite(v.duration) ? v.duration : 0);
    const span = to - start;
    setProgress(span > 0 ? Math.min(100, Math.max(0, ((v.currentTime - start) / span) * 100)) : 0);
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const v = videoRef.current;
    if (!v) return;
    const to = end ?? (Number.isFinite(v.duration) ? v.duration : 0);
    const span = to - start;
    if (span <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    v.currentTime = start + Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * span;
  };

  if (failed) {
    return (
      <Placeholder
        className={className}
        style={style}
        icon="error"
        message="This file could not be loaded. Try re-hosting or re-rendering it."
      />
    );
  }

  return (
    <div
      className={`relative overflow-hidden bg-black ${className ?? ""}`}
      // Container queries let a caption overlay scale with this box.
      style={{ containerType: "size", ...style }}
    >
      <video
        ref={videoRef}
        src={src}
        className="absolute inset-0 w-full h-full object-contain"
        onTimeUpdate={onTimeUpdate}
        onCanPlay={() => setWaiting(false)}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => { setWaiting(false); setPlaying(true); }}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          if (loop) {
            const v = videoRef.current;
            if (v) { v.currentTime = start; void v.play(); }
          } else setPlaying(false);
        }}
        onError={() => setFailed(true)}
        muted={muted}
        autoPlay={autoPlay}
        playsInline
      />

      {children}

      <div className="absolute inset-0 cursor-pointer" onClick={toggle}>
        {waiting && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40">
            <Loader2 className="w-6 h-6 animate-spin text-white/70" />
          </div>
        )}
        {!playing && !waiting && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-16 h-16 rounded-full flex items-center justify-center"
              style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}>
              <Play className="w-7 h-7 text-white ml-1" />
            </div>
          </div>
        )}
      </div>

      {/* Our controls */}
      <div className="absolute bottom-0 left-0 right-0 p-3 z-20"
        style={{ background: "linear-gradient(0deg, rgba(0,0,0,0.85) 0%, transparent 100%)" }}>
        <div className="h-1.5 rounded-full bg-white/25 mb-3 cursor-pointer group" onClick={seek}>
          <div className="h-full rounded-full relative" style={{ width: `${progress}%`, background: "var(--cobalt)" }}>
            <span className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 w-3 h-3 rounded-full bg-white opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        </div>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <button onClick={toggle} aria-label={playing ? "Pause" : "Play"}
              className="p-1.5 rounded-lg text-white/90 hover:text-white hover:bg-white/15 transition-colors">
              {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            </button>
            <button onClick={() => { const v = videoRef.current; if (v) v.currentTime = start; }}
              aria-label="Restart clip"
              className="p-1.5 rounded-lg text-white/90 hover:text-white hover:bg-white/15 transition-colors">
              <RotateCcw className="w-4 h-4" />
            </button>
          </div>
          <span className="text-[11px] font-semibold text-white/80 tabular-nums">
            {formatTime(labelStart)}–{formatTime(labelEnd)}
          </span>
          <button
            onClick={() => { const v = videoRef.current; if (!v) return; v.muted = !v.muted; setMuted(v.muted); }}
            aria-label={muted ? "Unmute" : "Mute"}
            className="p-1.5 rounded-lg text-white/90 hover:text-white hover:bg-white/15 transition-colors">
            {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Not hosted yet ───────────────────────────────────────────────────────────
function NeedsHosting({
  className, style, status, progress, onHost,
}: {
  className?: string;
  style?: React.CSSProperties;
  status: "none" | "downloading" | "ready" | "error";
  progress: number;
  onHost?: () => void;
}) {
  const downloading = status === "downloading";
  const pct = Math.max(0, Math.min(100, Math.round(progress)));

  return (
    <div className={`relative flex flex-col items-center justify-center gap-3 px-6 text-center ${className ?? ""}`}
      style={{ background: "linear-gradient(135deg, #0a0a1a, #1a0a2e)", ...style }}>
      <div className="w-14 h-14 rounded-full flex items-center justify-center"
        style={{ background: "rgba(49, 94, 245, 0.1)" }}>
        {downloading
          ? <Loader2 className="w-6 h-6 animate-spin" style={{ color: "var(--cobalt)" }} />
          : <CloudDownload className="w-6 h-6" style={{ color: "var(--cobalt)" }} />}
      </div>
      <div>
        <p className="text-xs font-bold text-white mb-1">
          {downloading ? `Importing video… ${pct}%` : "Video not imported yet"}
        </p>
        <p className="text-[11px] text-white/55 leading-relaxed">
          {downloading
            ? "Editing unlocks automatically when this finishes."
            : "Import it once, then preview, reframe and edit it right here."}
        </p>
      </div>

      {downloading && (
        <div className="w-full max-w-[180px] h-1.5 rounded-full bg-white/15 overflow-hidden">
          <div className="h-full rounded-full transition-[width] duration-500"
            style={{ width: `${pct}%`, background: "var(--cobalt)" }} />
        </div>
      )}

      {!downloading && onHost && (
        <button onClick={onHost}
          className="px-4 py-2 rounded-xl text-xs font-bold text-white transition-all hover:opacity-90"
          style={{ background: "var(--cobalt)" }}>
          Import video
        </button>
      )}
    </div>
  );
}

// ─── Placeholder ──────────────────────────────────────────────────────────────
function Placeholder({
  className, style, message, icon = "film",
}: {
  className?: string;
  style?: React.CSSProperties;
  message?: string;
  icon?: "film" | "error";
}) {
  const Icon = icon === "error" ? AlertCircle : Film;
  const color = icon === "error" ? "oklch(0.72 0.19 45)" : "var(--cobalt)";
  return (
    <div className={`relative flex flex-col items-center justify-center gap-3 ${className ?? ""}`}
      style={{ background: "linear-gradient(135deg, #0a0a1a, #1a0a2e)", ...style }}>
      <div className="w-14 h-14 rounded-full flex items-center justify-center"
        style={{ background: "rgba(49, 94, 245, 0.1)" }}>
        <Icon className="w-6 h-6" style={{ color }} />
      </div>
      <p className="text-xs text-white/60 text-center px-6 leading-relaxed">
        {message ?? "No video yet. Add a video URL to get started."}
      </p>
    </div>
  );
}

export default ClipPreview;
