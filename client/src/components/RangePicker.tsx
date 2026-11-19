/**
 * Choosing the part of a video to analyze by watching it.
 *
 * The video plays in the person's own browser: YouTube's player for YouTube
 * links, a plain <video> for direct file links. Nothing goes through the
 * server until Continue, and then the server fetches only the chosen part.
 * Elsewhere the app plays only media it hosts itself (see lib/videoSource);
 * this picker is the exception, since nothing is hosted yet at this point.
 * Other links (Vimeo, TikTok, …) get no preview; the time fields still work.
 *
 * The chosen part is the highlighted band on the timeline: drag its edges to
 * trim it, drag the band to move it, or play the video and mark the start and
 * the end where they happen. "Mini player" pins the video to a corner of the
 * screen, where it can be dragged anywhere and keeps playing while the rest of
 * the form is scrolled.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import {
  ArrowLeftToLine, ArrowRightToLine, GripHorizontal, Loader2, Pause, PictureInPicture2, Play, Repeat, X,
} from "lucide-react";
import { parseYouTubeId } from "@/lib/videoSource";

const MIN_SECONDS = 10;
const MINI_WIDTH = 320;
const MINI_BAR = 28;
const FILE_LINK = /^https?:\/\/\S+\.(mp4|webm|m4v|mov|ogv)(\?|#|$)/i;

type Source = { kind: "youtube"; id: string } | { kind: "file"; url: string };

/** What can be previewed in the browser for this link, if anything. */
export function rangePreviewSource(url: string): Source | null {
  const link = url.trim();
  const id = parseYouTubeId(link);
  if (id) return { kind: "youtube", id };
  return FILE_LINK.test(link) ? { kind: "file", url: link } : null;
}

/** h:mm:ss for an hour or more, else m:ss. */
function clock(seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** What the picker needs from either kind of player. */
type Player = {
  play(): void;
  pause(): void;
  /** `final` false while scrubbing: YouTube then shows the frame without buffering from there. */
  seek(seconds: number, final: boolean): void;
  time(): number;
  duration(): number;
  playing(): boolean;
};

type YouTubePlayer = {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  destroy(): void;
};
type YouTubeApi = { Player: new (host: HTMLElement, options: Record<string, unknown>) => YouTubePlayer };
type YouTubeWindow = { YT?: YouTubeApi; onYouTubeIframeAPIReady?: () => void };

let youtubeApi: Promise<YouTubeApi> | null = null;

/** Loads YouTube's player API once per page. */
function loadYouTube(): Promise<YouTubeApi> {
  const w = window as unknown as YouTubeWindow;
  if (w.YT?.Player) return Promise.resolve(w.YT);
  youtubeApi ??= new Promise<YouTubeApi>((resolve, reject) => {
    const previous = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      previous?.();
      if (w.YT?.Player) resolve(w.YT);
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.onerror = () => {
      youtubeApi = null;
      script.remove();
      reject(new Error("The YouTube player could not load."));
    };
    document.head.appendChild(script);
  });
  return youtubeApi;
}

export default function RangePicker(props: {
  url: string;
  /** Seconds, or null while the typed time is not valid. */
  start: number | null;
  end: number | null;
  maxLength: number;
  disabled?: boolean;
  onChange: (start: number, end: number) => void;
}) {
  const source = rangePreviewSource(props.url);
  if (!source) return null;
  /* A new link is a new player. */
  return <Picker key={source.kind === "youtube" ? source.id : source.url} source={source} {...props} />;
}

function Picker({ source, start, end, maxLength, disabled, onChange }: {
  source: Source;
  start: number | null;
  end: number | null;
  maxLength: number;
  disabled?: boolean;
  onChange: (start: number, end: number) => void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<Player | null>(null);
  const [ready, setReady] = useState(false);
  const [problem, setProblem] = useState("");
  const [duration, setDuration] = useState(0);
  const [now, setNow] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(true);
  const [mini, setMini] = useState(false);
  const [miniAt, setMiniAt] = useState({ x: 0, y: 0 });
  const [movingMini, setMovingMini] = useState(false);

  /* `source` is a new object on every render; the player follows its identity. */
  const sourceKey = source.kind === "youtube" ? source.id : source.url;
  const shortest = duration > 0 ? Math.min(MIN_SECONDS, duration) : MIN_SECONDS;
  const from = Math.max(0, start ?? 0);
  const to = Math.max(from + shortest, end ?? from + 300);
  /* The selection as the timer and the drag handlers see it right now. */
  const latest = useRef({ from, to, loop });
  latest.current = { from, to, loop };

  /* YouTube: the player replaces a div created here, which React never touches. */
  useEffect(() => {
    if (source.kind !== "youtube") return;
    const host = frameRef.current;
    if (!host) return;
    const mount = document.createElement("div");
    host.appendChild(mount);
    let player: YouTubePlayer | null = null;
    let cancelled = false;
    const slow = window.setTimeout(() => {
      if (!playerRef.current) setProblem("The YouTube player is taking too long to load. Type the times below instead.");
    }, 20_000);
    loadYouTube().then((YT) => {
      if (cancelled) return;
      player = new YT.Player(mount, {
        videoId: source.id,
        host: "https://www.youtube-nocookie.com",
        width: "100%",
        height: "100%",
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1, iv_load_policy: 3, start: Math.floor(latest.current.from) },
        events: {
          onReady: () => {
            if (cancelled || !player) return;
            const p = player;
            playerRef.current = {
              play: () => p.playVideo(),
              pause: () => p.pauseVideo(),
              seek: (seconds, final) => p.seekTo(seconds, final),
              time: () => p.getCurrentTime() || 0,
              duration: () => p.getDuration() || 0,
              playing: () => p.getPlayerState() === 1,
            };
            setReady(true);
          },
          onError: (event: { data?: number }) => {
            setProblem(event.data === 101 || event.data === 150
              ? "YouTube doesn’t let this video play on other sites. Type the times below instead."
              : "This video can’t be previewed here. Type the times below instead.");
          },
        },
      });
    }, () => {
      if (!cancelled) setProblem("The YouTube player couldn’t load. Type the times below instead.");
    });
    return () => {
      cancelled = true;
      window.clearTimeout(slow);
      playerRef.current = null;
      try { player?.destroy(); } catch { /* already gone */ }
      host.replaceChildren();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);

  /* A direct file: the browser's own <video>. */
  useEffect(() => {
    if (source.kind !== "file") return;
    const video = videoRef.current;
    if (!video) return;
    const onReady = () => {
      playerRef.current = {
        play: () => { void video.play().catch(() => {}); },
        pause: () => video.pause(),
        seek: (seconds) => { video.currentTime = seconds; },
        time: () => video.currentTime || 0,
        duration: () => (Number.isFinite(video.duration) ? video.duration : 0),
        playing: () => !video.paused && !video.ended,
      };
      if (latest.current.from > 0) video.currentTime = latest.current.from;
      setReady(true);
    };
    const onError = () => setProblem("This file can’t be played in the browser. Type the times below instead.");
    video.addEventListener("loadedmetadata", onReady);
    video.addEventListener("error", onError);
    return () => {
      video.removeEventListener("loadedmetadata", onReady);
      video.removeEventListener("error", onError);
      playerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);

  /* Follows the player, and loops playback inside the chosen part. */
  useEffect(() => {
    if (!ready) return;
    let last = playerRef.current?.time() ?? 0;
    const timer = window.setInterval(() => {
      const player = playerRef.current;
      if (!player) return;
      const length = player.duration();
      if (length > 0) setDuration((d) => (Math.abs(d - length) > 0.5 ? length : d));
      const t = player.time();
      const { from: a, to: b, loop: repeat } = latest.current;
      /* Only playback that runs out of the chosen part jumps back: the rest
       * of the video can still be watched to find where the part should go. */
      if (repeat && player.playing() && last >= a && last < b && t >= b) {
        player.seek(a, true);
        last = a;
        setNow(a);
        return;
      }
      last = t;
      setNow(t);
      setPlaying(player.playing());
    }, 200);
    return () => window.clearInterval(timer);
  }, [ready]);

  /* Once the length is known: keep the chosen part inside the video. */
  const known = duration > 0;
  useEffect(() => {
    if (!known) return;
    const { from: a, to: b } = latest.current;
    const length = Math.floor(duration);
    if (a >= length - 1) onChange(0, Math.min(length, 300, maxLength));
    else if (b > length) onChange(a, length);
    // Only when the length first arrives; later changes come from the person.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [known]);

  /* The mini player stays on screen when the window shrinks. */
  useEffect(() => {
    if (!mini) return;
    const keepVisible = () => setMiniAt(({ x, y }) => ({
      x: clamp(x, 8, Math.max(8, window.innerWidth - MINI_WIDTH - 8)),
      y: clamp(y, 8, Math.max(8, window.innerHeight - (MINI_WIDTH * 9) / 16 - MINI_BAR - 8)),
    }));
    window.addEventListener("resize", keepVisible);
    return () => window.removeEventListener("resize", keepVisible);
  }, [mini]);

  /* Two strips: the whole video, and for a long one a close-up around the
   * chosen part. On an 86-minute video one pixel of the whole strip is about
   * 8 seconds; in the close-up it is about one. The close-up holds still
   * while one of its edges is dragged, so the edge stays under the pointer. */
  type View = readonly [number, number];
  const whole: View = [0, duration];
  const closeUpAround = (a: number, b: number): View => {
    const pad = Math.max(15, (b - a) * 0.5);
    return [Math.max(0, a - pad), Math.min(duration, b + pad)];
  };
  const [draggingCloseUp, setDraggingCloseUp] = useState(false);
  const closeUpView = useRef<View>([0, 0]);
  if (!draggingCloseUp) closeUpView.current = closeUpAround(from, to);
  const closeUp = closeUpView.current;
  const showCloseUp = duration > 0 && closeUp[1] - closeUp[0] < duration * 0.6;
  const percent = (view: View, t: number) =>
    view[1] > view[0] ? (clamp(t, view[0], view[1]) - view[0]) / (view[1] - view[0]) * 100 : 0;

  /** The chosen part with every rule applied: inside the video, at least
   * `shortest` long and at most `maxLength`. `keep` is the edge that stays put. */
  const fit = (a: number, b: number, keep: "start" | "end") => {
    const length = duration > 0 ? duration : Infinity;
    if (keep === "start") {
      a = clamp(a, 0, Math.max(0, length - shortest));
      b = clamp(b, a + shortest, Math.min(length, a + maxLength));
    } else {
      b = clamp(b, Math.min(shortest, length), length);
      a = clamp(a, Math.max(0, b - maxLength), Math.max(0, b - shortest));
    }
    return [Math.round(a), Math.round(b)] as const;
  };
  const choose = (a: number, b: number, keep: "start" | "end") => {
    const [x, y] = fit(a, b, keep);
    if (x !== latest.current.from || y !== latest.current.to) onChange(x, y);
    return [x, y] as const;
  };

  const drag = useRef<{ edge: "start" | "end" | "both"; x: number; from: number; to: number; perPixel: number } | null>(null);
  const beginDrag = (edge: "start" | "end" | "both", view: View, closeUpStrip: boolean) => (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || duration <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    const strip = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!strip?.width) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { edge, x: event.clientX, from, to, perPixel: (view[1] - view[0]) / strip.width };
    if (closeUpStrip) setDraggingCloseUp(true);
    playerRef.current?.pause();
  };
  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const shift = (event.clientX - d.x) * d.perPixel;
    let a: number, b: number;
    if (d.edge === "start") [a, b] = choose(d.from + shift, d.to, "end");
    else if (d.edge === "end") [a, b] = choose(d.from, d.to + shift, "start");
    else {
      const moved = clamp(shift, -d.from, duration - d.to);
      [a, b] = choose(d.from + moved, d.to + moved, "start");
    }
    /* Show the frame at the edge being moved. */
    playerRef.current?.seek(d.edge === "end" ? b : a, false);
    setNow(d.edge === "end" ? b : a);
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setDraggingCloseUp(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const { from: a, to: b } = latest.current;
    playerRef.current?.seek(d.edge === "end" ? b : a, true);
  };
  const nudge = (edge: "start" | "end") => (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const step = event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1
      : event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : 0;
    if (!step) return;
    event.preventDefault();
    const amount = step * (event.shiftKey ? 10 : 1);
    const [a, b] = edge === "start" ? choose(from + amount, to, "end") : choose(from, to + amount, "start");
    playerRef.current?.seek(edge === "end" ? b : a, true);
  };
  /* A press on the strip outside the chosen part moves the playhead there. */
  const seekTrack = (view: View) => (event: PointerEvent<HTMLDivElement>) => {
    const strip = event.currentTarget.getBoundingClientRect();
    if (duration <= 0 || !strip.width) return;
    const t = clamp(view[0] + ((event.clientX - strip.left) / strip.width) * (view[1] - view[0]), 0, duration);
    playerRef.current?.seek(t, true);
    setNow(t);
  };

  const togglePlay = () => {
    const player = playerRef.current;
    if (!player) return;
    if (player.playing()) { player.pause(); setPlaying(false); return; }
    /* Play from the start of the chosen part unless the playhead is in it. */
    const t = player.time();
    if (loop && (t < from || t >= to - 0.5)) player.seek(from, true);
    player.play();
    setPlaying(true);
  };
  /* Marking while watching: the length of the part stays the same when the
   * other edge would otherwise end up on the wrong side. */
  const startHere = () => {
    const t = playerRef.current?.time() ?? now;
    if (t + shortest > to) choose(t, t + (to - from), "start");
    else choose(t, to, "end");
  };
  const endHere = () => {
    const t = playerRef.current?.time() ?? now;
    if (t - shortest < from) choose(t - (to - from), t, "end");
    else choose(from, t, "start");
  };

  const toggleMini = () => {
    if (!mini) {
      setMiniAt({
        x: Math.max(8, window.innerWidth - MINI_WIDTH - 16),
        y: Math.max(8, window.innerHeight - (MINI_WIDTH * 9) / 16 - MINI_BAR - 16),
      });
    }
    setMini((v) => !v);
  };
  const moveMini = useRef<{ dx: number; dy: number } | null>(null);
  const beginMoveMini = (event: PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    moveMini.current = { dx: event.clientX - miniAt.x, dy: event.clientY - miniAt.y };
    setMovingMini(true);
  };
  const dragMini = (event: PointerEvent<HTMLDivElement>) => {
    const m = moveMini.current;
    if (!m) return;
    setMiniAt({
      x: clamp(event.clientX - m.dx, 8, Math.max(8, window.innerWidth - MINI_WIDTH - 8)),
      y: clamp(event.clientY - m.dy, 8, Math.max(8, window.innerHeight - (MINI_WIDTH * 9) / 16 - MINI_BAR - 8)),
    });
  };
  const endMoveMini = (event: PointerEvent<HTMLDivElement>) => {
    moveMini.current = null;
    setMovingMini(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const nativePip = typeof document !== "undefined" && "pictureInPictureEnabled" in document && document.pictureInPictureEnabled;
  const openNativePip = () => { void videoRef.current?.requestPictureInPicture().catch(() => {}); };

  if (problem) {
    return <p className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground">{problem}</p>;
  }

  const controlButton = "inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-secondary/60 disabled:opacity-40";
  const strip = (view: View, isCloseUp: boolean) => (
    <div>
      {isCloseUp && (
        <p className="mb-1 text-[11px] font-semibold text-muted-foreground">Close-up: drag the edges to the exact second</p>
      )}
      <div onPointerDown={seekTrack(view)}
        className={`relative ${isCloseUp ? "h-9" : "h-11"} select-none rounded-lg bg-secondary/70 ${duration > 0 ? "cursor-pointer" : "opacity-50"}`}
        style={{ touchAction: "none" }}>
        {duration > 0 && (
          <>
            <div onPointerDown={beginDrag("both", view, isCloseUp)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}
              className={`absolute inset-y-0 rounded-md border-2 ${disabled ? "" : "cursor-grab active:cursor-grabbing"}`}
              title="Drag to move the chosen part"
              style={{
                left: `${percent(view, from)}%`, width: `${percent(view, to) - percent(view, from)}%`,
                borderColor: "var(--cobalt)", background: "color-mix(in oklab, var(--cobalt) 28%, transparent)",
              }} />
            {(["start", "end"] as const).map((edge) => {
              const at = edge === "start" ? from : to;
              const name = `${edge === "start" ? "Start" : "End"} of the part to analyze${isCloseUp ? " (close-up)" : ""}`;
              return (
                <div key={edge} role="slider" tabIndex={disabled ? -1 : 0} aria-label={name}
                  aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(at)} aria-valuetext={clock(at)}
                  onPointerDown={beginDrag(edge, view, isCloseUp)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}
                  onKeyDown={nudge(edge)}
                  className={`absolute inset-y-0 z-10 -ml-2.5 flex w-5 items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${disabled ? "" : "cursor-ew-resize"}`}
                  style={{ left: `${percent(view, at)}%` }}>
                  <div className={`${isCloseUp ? "h-6" : "h-7"} w-1.5 rounded-full bg-white shadow-md ring-1 ring-black/30`} />
                </div>
              );
            })}
            {now >= view[0] && now <= view[1] && (
              <div className="pointer-events-none absolute inset-y-0 z-20 w-0.5 bg-white"
                style={{ left: `${percent(view, now)}%`, boxShadow: "0 0 0 1px rgba(0,0,0,0.45)" }} />
            )}
          </>
        )}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] tabular-nums text-muted-foreground">
        <span>{clock(view[0])}</span>
        <span>{duration > 0 ? clock(view[1]) : ""}</span>
      </div>
    </div>
  );
  return (
    <div className="space-y-3">
      {mini && (
        <div className="flex aspect-video flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-xs text-muted-foreground">
          The video is playing in the mini player.
          <button type="button" className={controlButton} onClick={() => setMini(false)}>Put it back here</button>
        </div>
      )}
      {/* The same element docked or floating, so the player never reloads. */}
      <div
        className={mini ? "fixed z-50 overflow-hidden rounded-xl border border-border bg-black shadow-2xl" : "relative overflow-hidden rounded-xl bg-black"}
        style={mini ? { left: miniAt.x, top: miniAt.y, width: MINI_WIDTH } : undefined}>
        {mini && (
          <div className="flex cursor-move select-none items-center gap-2 px-2 text-[11px] font-semibold text-white/80"
            style={{ height: MINI_BAR, touchAction: "none", background: "rgba(0,0,0,0.85)" }}
            onPointerDown={beginMoveMini} onPointerMove={dragMini} onPointerUp={endMoveMini} onPointerCancel={endMoveMini}>
            <GripHorizontal className="h-3.5 w-3.5" aria-hidden />
            Drag to move · {clock(from)} – {clock(to)}
            <button type="button" aria-label="Put the player back in the form" onClick={() => setMini(false)}
              className="ml-auto rounded p-0.5 hover:bg-white/10"><X className="h-3.5 w-3.5" /></button>
          </div>
        )}
        <div className="relative aspect-video">
          {source.kind === "youtube" ? (
            <div ref={frameRef} className="absolute inset-0 [&>iframe]:h-full [&>iframe]:w-full"
              style={movingMini ? { pointerEvents: "none" } : undefined} />
          ) : (
            <video ref={videoRef} src={source.url} preload="metadata" playsInline controls
              className="absolute inset-0 h-full w-full" style={movingMini ? { pointerEvents: "none" } : undefined} />
          )}
          {!ready && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <Loader2 className="h-5 w-5 animate-spin text-white/70" aria-label="Loading the video" />
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={controlButton} onClick={togglePlay} disabled={!ready}
          aria-label={playing ? "Pause" : "Play the chosen part"}>
          {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          {playing ? "Pause" : "Play"}
        </button>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">{clock(now)} / {duration > 0 ? clock(duration) : "–:––"}</span>
        <button type="button" className={controlButton} onClick={startHere} disabled={!ready || disabled}>
          <ArrowLeftToLine className="h-3.5 w-3.5" /> Start here
        </button>
        <button type="button" className={controlButton} onClick={endHere} disabled={!ready || disabled}>
          <ArrowRightToLine className="h-3.5 w-3.5" /> End here
        </button>
        <button type="button" className={controlButton} aria-pressed={loop} onClick={() => setLoop((v) => !v)}
          style={loop ? { borderColor: "var(--cobalt)" } : undefined}>
          <Repeat className="h-3.5 w-3.5" /> Loop
        </button>
        <button type="button" className={controlButton} aria-pressed={mini} onClick={toggleMini}>
          <PictureInPicture2 className="h-3.5 w-3.5" /> {mini ? "Dock player" : "Mini player"}
        </button>
        {source.kind === "file" && nativePip && (
          <button type="button" className={controlButton} onClick={openNativePip} disabled={!ready}>
            Picture in picture
          </button>
        )}
      </div>

      {/* The whole video, with the chosen part highlighted. */}
      {strip(whole, false)}
      {/* For a long video, the same part close up, for exact edges. */}
      {showCloseUp && strip(closeUp, true)}
      <p className="text-xs text-muted-foreground">
        Analyzing {clock(from)} – {clock(to)} ({clock(to - from)}, up to {clock(maxLength)}). Drag the edges or the
        band, or play the video and press Start here and End here. Arrow keys move a focused edge by a second
        (with Shift, ten).
      </p>
    </div>
  );
}
