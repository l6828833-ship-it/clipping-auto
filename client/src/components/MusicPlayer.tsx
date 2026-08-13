import { useEffect, useRef, useState } from "react";
import { parseYouTubeId } from "@/lib/videoSource";
import type { MusicTrack } from "./ClipTimeline";

declare global {
  interface Window {
    YT: {
      Player: new (
        el: string | HTMLElement,
        opts: {
          width: number; height: number; videoId: string;
          playerVars: Record<string, number | string>;
          events: {
            onReady?: (e: { target: YTPlayer }) => void;
            onError?: (e: { data: number }) => void;
          };
        }
      ) => YTPlayer;
      PlayerState: { PLAYING: number; PAUSED: number; ENDED: number };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

type YTPlayer = {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(sec: number, allow: boolean): void;
  setVolume(v: number): void;
  destroy(): void;
};

/** Interpolate volume linearly across keyframes at clip-relative time `t`. */
function volumeAt(keyframes: MusicTrack["keyframes"], t: number): number {
  const sorted = [...keyframes].sort((a, b) => a.time - b.time);
  if (!sorted.length) return 1;
  if (t <= sorted[0].time) return sorted[0].volume;
  if (t >= sorted[sorted.length - 1].time) return sorted[sorted.length - 1].volume;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i];
    if (t <= b.time) {
      const frac = (t - a.time) / (b.time - a.time);
      return a.volume + (b.volume - a.volume) * frac;
    }
  }
  return 1;
}

// ─── YouTube IFrame API loader ────────────────────────────────────────────────
// Guarantees the YT.Player constructor is available before we call it.

let ytResolvers: Array<() => void> = [];
let ytApiState: "idle" | "loading" | "ready" = "idle";

function loadYtApi(): Promise<void> {
  // Already ready — resolve immediately.
  if (ytApiState === "ready" || window.YT?.Player) {
    ytApiState = "ready";
    return Promise.resolve();
  }

  return new Promise(resolve => {
    ytResolvers.push(resolve);

    if (ytApiState === "loading") return; // script already injected, wait
    ytApiState = "loading";

    // Set up the global callback BEFORE injecting the script so it cannot miss.
    const prevCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prevCallback?.();
      ytApiState = "ready";
      const cbs = ytResolvers;
      ytResolvers = [];
      cbs.forEach(r => r());
    };

    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.onerror = () => {
      // Network error — don't leave callers hanging.
      ytApiState = "idle";
      const cbs = ytResolvers;
      ytResolvers = [];
      cbs.forEach(r => r()); // resolve anyway — player creation will just fail
    };
    document.head.appendChild(s);
  });
}

// ─── Component ────────────────────────────────────────────────────────────────

let playerCounter = 0; // unique DOM-id per player instance

export function MusicPlayer({
  music,
  playing,
  playheadSeconds,
}: {
  music: MusicTrack;
  playing: boolean;
  playheadSeconds: number;
}) {
  const ytId = parseYouTubeId(music.src);
  const isYt = !!ytId;

  // ── YouTube ───────────────────────────────────────────────────────────────
  const ytRef = useRef<YTPlayer | null>(null);
  const [ytReady, setYtReady] = useState(false);
  const domIdRef = useRef(`yt-music-${++playerCounter}`);
  const lastSeekRef = useRef<number>(-999);
  // Avoid triggering seeks on every playhead tick; only seek on big jumps.
  const prevPlayheadRef = useRef<number>(-999);

  useEffect(() => {
    if (!isYt) return;
    let cancelled = false;

    loadYtApi().then(() => {
      if (cancelled) return;
      // The YT API replaces the element with an iframe; give it a fresh div.
      const container = document.getElementById(domIdRef.current);
      if (!container) return;

      try {
        const player = new window.YT.Player(domIdRef.current, {
          width: 1,
          height: 1,
          videoId: ytId!,
          playerVars: {
            autoplay: 0,
            controls: 0,
            disablekb: 1,
            fs: 0,
            iv_load_policy: 3,
            modestbranding: 1,
            rel: 0,
            start: Math.floor(music.offset),
          },
          events: {
            onReady: e => {
              if (cancelled) { e.target.destroy(); return; }
              ytRef.current = e.target;
              e.target.setVolume(Math.round(volumeAt(music.keyframes, 0) * 100));
              setYtReady(true);
            },
            onError: e => {
              console.warn("[MusicPlayer] YouTube player error:", e.data);
            },
          },
        });
        // Stash for cleanup — onReady may not have fired yet.
        return () => { player.destroy(); };
      } catch (err) {
        console.warn("[MusicPlayer] Could not create YT.Player:", err);
      }
    }).catch(() => {/* network error */});

    return () => {
      cancelled = true;
      ytRef.current?.destroy();
      ytRef.current = null;
      setYtReady(false);
    };
  // Re-create only when the video ID changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ytId]);

  // Play / pause mirror.
  useEffect(() => {
    if (!ytReady || !ytRef.current) return;
    if (playing) ytRef.current.playVideo();
    else ytRef.current.pauseVideo();
  }, [playing, ytReady]);

  // Seek on large jumps only (scrubbing in timeline, clip start, etc.).
  useEffect(() => {
    if (!ytReady || !ytRef.current) return;
    const target = music.offset + playheadSeconds;
    const delta = Math.abs(target - lastSeekRef.current);
    if (delta > 1.5) {
      ytRef.current.seekTo(target, true);
      lastSeekRef.current = target;
    }
  }, [playheadSeconds, ytReady, music.offset]);

  // Volume envelope — update once per second, not every frame.
  useEffect(() => {
    if (!ytReady || !ytRef.current) return;
    const prev = prevPlayheadRef.current;
    if (Math.abs(playheadSeconds - prev) < 1 && prev !== -999) return;
    prevPlayheadRef.current = playheadSeconds;
    ytRef.current.setVolume(Math.round(volumeAt(music.keyframes, playheadSeconds) * 100));
  }, [playheadSeconds, ytReady, music.keyframes]);

  // ── Uploaded file ─────────────────────────────────────────────────────────
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (isYt) return;
    const a = audioRef.current;
    if (!a) return;
    if (playing) void a.play().catch(() => {});
    else a.pause();
  }, [playing, isYt]);

  useEffect(() => {
    if (isYt) return;
    const a = audioRef.current;
    if (!a) return;
    const target = music.offset + playheadSeconds;
    if (Math.abs(a.currentTime - target) > 1.5) {
      a.currentTime = Math.max(0, target);
    }
  }, [playheadSeconds, isYt, music.offset]);

  useEffect(() => {
    if (isYt) return;
    const a = audioRef.current;
    if (!a) return;
    const prev = prevPlayheadRef.current;
    if (Math.abs(playheadSeconds - prev) < 1 && prev !== -999) return;
    prevPlayheadRef.current = playheadSeconds;
    a.volume = Math.min(1, Math.max(0, volumeAt(music.keyframes, playheadSeconds)));
  }, [playheadSeconds, isYt, music.keyframes]);

  if (isYt) {
    return (
      // The YT IFrame API needs a real DOM element with a stable id.
      // Position it off-screen so it is invisible but not `display:none`
      // (hidden elements cause the API to fail silently on some browsers).
      <div
        id={domIdRef.current}
        style={{
          position: "fixed",
          left: -9999,
          top: -9999,
          width: 1,
          height: 1,
          pointerEvents: "none",
          overflow: "hidden",
        }}
        aria-hidden
      />
    );
  }

  return (
    <audio
      ref={audioRef}
      src={music.src}
      style={{ display: "none" }}
      preload="auto"
    />
  );
}

export default MusicPlayer;
