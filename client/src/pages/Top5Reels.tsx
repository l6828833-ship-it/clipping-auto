import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import AppLayout from "@/components/AppLayout";
import { trpc } from "@/lib/trpc";
import { parseYouTubeId, youTubeThumbnail } from "@/lib/videoSource";
import { toast } from "sonner";
import {
  CheckCircle2,
  ChevronDown,
  Download,
  GripVertical,
  Link2,
  Loader2,
  Play,
  Sparkles,
  Trash2,
  Video,
  Wand2,
} from "lucide-react";

type Point = { x: number; y: number };
type Candidate = {
  id: number;
  title: string;
  startTime: number;
  endTime: number;
  engagementScore: number;
  reason: string;
};
type RankState = "idle" | "analyzing" | "ready" | "error" | "rendering" | "rendered";

type RankEntry = {
  id: string;
  rank: number;
  url: string;
  sourceTitle: string;
  videoId?: number;
  duration?: number;
  transcript?: string;
  candidates: Candidate[];
  selectedId?: number;
  title: string;
  showTitle: boolean;
  numberPosition: Point;
  titlePosition: Point;
  /** Full-resolution font sizes used by the final 1080×1920 render. */
  numberSize: number;
  titleSize: number;
  state: RankState;
  error?: string;
  clipId?: number;
  /** Local URL for the finished selected clip, used by the in-page preview. */
  clipUrl?: string;
  /** Hosted source media URL, available before the final clip export finishes. */
  hostedUrl?: string;
  /** Source interval represented by the current hosted preview file. */
  hostedRangeStart?: number;
  hostedRangeEnd?: number;
  /** User-defined full-video timestamp and duration for a custom short clip. */
  customStart?: number;
  customDuration?: number;
  /** Per-rank crop controls shared by live preview and final render. */
  zoom: number;
  offsetX: number;
  offsetY: number;
  /** Color of top-and-bottom bars in horizontal zoom-out mode. */
  barColor: string;
};

const MODEL = "openai/gpt-4o-mini";
const API_KEY = "server";
const ACCENTS = ["#a3e635", "#facc15", "#38bdf8", "#f472b6", "#fb7185"];

const createRank = (rank: number): RankEntry => ({
  id: `rank-${rank}`,
  rank,
  url: "",
  sourceTitle: "",
  candidates: [],
  title: "",
  showTitle: true,
  numberPosition: { x: 0.12, y: 0.31 + (5 - rank) * 0.115 },
  titlePosition: { x: 0.43, y: 0.31 + (5 - rank) * 0.115 },
  numberSize: 96,
  titleSize: 56,
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  barColor: "#000000",
  state: "idle",
});

const initialRanks = [5, 4, 3, 2, 1].map(createRank);
const MAX_TOP5_CLIP_SECONDS = 15;

const roundClipTime = (seconds: number) => Math.round(Math.max(0, seconds || 0) * 10) / 10;

function limitToShortClip(candidate: Candidate, sourceDuration?: number): Candidate {
  const sourceEnd = Number(sourceDuration) > 0 ? Number(sourceDuration) : Infinity;
  /* Keep a legal non-zero interval even when the user selects close to the
   * source end, but never move beyond the actual source duration. */
  const rawStart = Math.max(0, Number(candidate.startTime) || 0);
  const startTime = Number.isFinite(sourceEnd) ? Math.min(rawStart, Math.max(0, sourceEnd - 0.1)) : rawStart;
  const requested = Math.max(0.1, (Number(candidate.endTime) || startTime + MAX_TOP5_CLIP_SECONDS) - startTime);
  const available = Number.isFinite(sourceEnd) ? Math.max(0.1, sourceEnd - startTime) : MAX_TOP5_CLIP_SECONDS;
  const duration = Math.min(MAX_TOP5_CLIP_SECONDS, requested, available);
  return { ...candidate, startTime: roundClipTime(startTime), endTime: roundClipTime(startTime + duration) };
}

function timecode(seconds: number) {
  const value = Math.max(0, Math.round(seconds || 0));
  const mins = Math.floor(value / 60);
  return `${mins}:${String(value % 60).padStart(2, "0")}`;
}

function CustomClipTimeline({
  sourceDuration,
  start,
  duration,
  accent,
  onChange,
  onCommit,
}: {
  sourceDuration?: number;
  start: number;
  duration: number;
  accent: string;
  onChange: (start: number, duration: number) => void;
  onCommit: (start: number, duration: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<"start" | "end" | null>(null);
  const total = Number(sourceDuration) > 0 ? Number(sourceDuration) : MAX_TOP5_CLIP_SECONDS;
  const safeStart = Math.max(0, Math.min(roundClipTime(start), Math.max(0, total - 0.1)));
  const safeDuration = Math.max(0.1, Math.min(MAX_TOP5_CLIP_SECONDS, roundClipTime(duration), Math.max(0.1, total - safeStart)));
  const end = safeStart + safeDuration;
  const pointToTime = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return safeStart;
    return Math.max(0, Math.min(total, ((event.clientX - rect.left) / rect.width) * total));
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const value = pointToTime(event);
    if (dragging === "start") {
      const nextStart = roundClipTime(Math.max(0, Math.min(value, total - safeDuration)));
      onChange(nextStart, safeDuration);
    } else {
      const nextDuration = roundClipTime(Math.max(0.1, Math.min(MAX_TOP5_CLIP_SECONDS, value - safeStart, total - safeStart)));
      onChange(safeStart, nextDuration);
    }
  };
  const finishDrag = () => {
    if (dragging) onCommit(safeStart, safeDuration);
    setDragging(null);
  };
  const handleDown = (event: ReactPointerEvent<HTMLButtonElement>, handle: "start" | "end") => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(handle);
  };
  return (
    <div className="mt-4">
      <div className="mb-2 flex items-center justify-between text-xs font-semibold text-muted-foreground"><span>Drag both handles to choose the live clip</span><span className="font-mono text-foreground">{timecode(safeStart)}–{timecode(end)} · {safeDuration.toFixed(1)}s</span></div>
      <div ref={trackRef} onPointerMove={move} onPointerUp={finishDrag} onPointerCancel={finishDrag} className="relative h-11 touch-none rounded-xl border border-border bg-input/70">
        <div className="absolute inset-x-3 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-secondary" />
        <div className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full" style={{ left: `${(safeStart / total) * 100}%`, width: `${(safeDuration / total) * 100}%`, background: accent }} />
        <button type="button" onPointerDown={(event) => handleDown(event, "start")} className="absolute top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-black shadow-lg" style={{ left: `${(safeStart / total) * 100}%` }} aria-label="Drag clip start" />
        <button type="button" onPointerDown={(event) => handleDown(event, "end")} className="absolute top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-black shadow-lg" style={{ left: `${(end / total) * 100}%` }} aria-label="Drag clip end" />
      </div>
    </div>
  );
}

function sourceLabel(url: string) {
  const value = url.toLowerCase();
  if (value.includes("youtube.com") || value.includes("youtu.be")) return "YouTube";
  if (value.includes("tiktok.com")) return "TikTok";
  if (value.includes("x.com") || value.includes("twitter.com")) return "X";
  return "Video link";
}

function stateCopy(state: RankState) {
  if (state === "analyzing") return "Analysing source";
  if (state === "ready") return "Best clip selected";
  if (state === "rendering") return "Rendering clip";
  if (state === "rendered") return "Ready for final video";
  if (state === "error") return "Needs attention";
  return "Add a source";
}

function RankOverlayPreview({
  entry,
  ranks,
  accent,
  previewUrl,
  hostedUrl,
  previewStart,
  onMove,
}: {
  entry: RankEntry;
  ranks: RankEntry[];
  accent: string;
  previewUrl?: string;
  hostedUrl?: string;
  previewStart?: number;
  onMove: (kind: "number" | "title", point: Point) => void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [dragging, setDragging] = useState<"number" | "title" | null>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || previewUrl || !hostedUrl || previewStart == null) return;
    const seek = () => {
      const maxTime = Math.max(0, (video.duration || previewStart) - 0.15);
      video.currentTime = Math.min(Math.max(0, previewStart), maxTime);
    };
    if (video.readyState >= 1) seek();
    else video.addEventListener("loadedmetadata", seek, { once: true });
    return () => video.removeEventListener("loadedmetadata", seek);
  }, [hostedUrl, previewStart, previewUrl]);

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging || !frameRef.current) return;
    const box = frameRef.current.getBoundingClientRect();
    onMove(dragging, {
      x: Math.max(0.06, Math.min(0.94, (event.clientX - box.left) / box.width)),
      y: Math.max(0.08, Math.min(0.92, (event.clientY - box.top) / box.height)),
    });
  };

  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>, kind: "number" | "title") => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(kind);
  };
  const previewSize = (fullSize: number, min: number) => Math.max(min, Math.round(fullSize * 0.29));
  const youTubeId = parseYouTubeId(entry.url);
  const thumbnailUrl = youTubeId ? youTubeThumbnail(youTubeId) : undefined;
  /* Before a short local preview is hosted, a custom YouTube range opens the
   * original source as a playable navigator at the moving start timestamp. */
  const fullSourceEmbed = youTubeId && entry.customStart !== undefined && !previewUrl && !hostedUrl
    ? `https://www.youtube.com/embed/${youTubeId}?autoplay=1&mute=1&playsinline=1&controls=1&rel=0&start=${Math.floor(Math.max(0, entry.customStart))}`
    : undefined;
  const letterboxMode = entry.zoom < 1 && !!hostedUrl;

  return (
    <div
      ref={frameRef}
      onPointerMove={move}
      onPointerUp={() => setDragging(null)}
      onPointerCancel={() => setDragging(null)}
      className="relative aspect-[9/16] w-full overflow-hidden rounded-[1.5rem] bg-[#070707] shadow-2xl"
      style={{ backgroundImage: "radial-gradient(circle at 82% 11%, rgba(255,255,255,0.11), transparent 23%), linear-gradient(180deg, #161616 0%, #050505 78%)", backgroundColor: letterboxMode ? entry.barColor : undefined }}
    >
      {previewUrl ? (
        <video ref={videoRef} key={previewUrl} src={previewUrl} autoPlay muted loop playsInline controls className="absolute inset-0 h-full w-full object-cover" />
      ) : hostedUrl ? (
        <video ref={videoRef} key={hostedUrl} src={hostedUrl} autoPlay muted loop playsInline controls className={`absolute inset-0 h-full w-full ${letterboxMode ? "object-contain" : "object-cover"}`} style={letterboxMode ? undefined : { transform: `scale(${entry.zoom})`, transformOrigin: `${50 + entry.offsetX * 50}% ${50 + entry.offsetY * 50}%` }} />
      ) : fullSourceEmbed ? (
        <iframe key={fullSourceEmbed} src={fullSourceEmbed} title="Playable full source video" allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen className="absolute inset-0 h-full w-full border-0" />
      ) : thumbnailUrl ? (
        <img src={thumbnailUrl} alt={`${entry.sourceTitle || "Source"} thumbnail`} className="absolute inset-0 h-full w-full object-cover opacity-75" />
      ) : (
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_78%_16%,rgba(255,255,255,0.13),transparent_24%),linear-gradient(180deg,#161616_0%,#050505_78%)]" />
      )}
      <div className="absolute inset-x-0 top-0 z-10 h-1" style={{ background: accent }} />

      {ranks.map((rankEntry) => {
        const activeNumber = rankEntry.rank === entry.rank;
        const numberStyle = {
          left: `${rankEntry.numberPosition.x * 100}%`,
          top: `${rankEntry.numberPosition.y * 100}%`,
          transform: "translate(-50%, -50%)",
          fontSize: `${previewSize(rankEntry.numberSize, 18)}px`,
          color: accent,
          WebkitTextStroke: `1.4px ${accent}`,
        } as React.CSSProperties;
        if (!activeNumber) return <span key={rankEntry.id} className="absolute z-10 select-none font-black leading-none tracking-[-0.12em]" style={numberStyle}>{rankEntry.rank}</span>;
        return (
          <button key={rankEntry.id} type="button" onPointerDown={(event) => startDrag(event, "number")} className="group absolute z-20 cursor-grab touch-none select-none active:cursor-grabbing" style={numberStyle} aria-label="Drag active rank number">
            {rankEntry.rank}
            <span className="absolute -right-4 -top-2 hidden rounded bg-white px-1 py-0.5 text-[8px] text-black group-hover:block"><GripVertical className="h-2.5 w-2.5" /></span>
          </button>
        );
      })}

      {entry.showTitle && (
        <button
          type="button"
          onPointerDown={(event) => startDrag(event, "title")}
          className="group absolute z-20 max-w-[74%] cursor-grab touch-none select-none active:cursor-grabbing"
          style={{ left: `${entry.titlePosition.x * 100}%`, top: `${entry.titlePosition.y * 100}%`, transform: "translate(-50%, -50%)" }}
          aria-label="Drag active clip title"
        >
          <span className="block border border-white/12 bg-black/25 px-2 py-1 text-center font-black uppercase leading-[0.94] tracking-[-0.06em] text-white shadow-xl transition group-hover:border-white/50" style={{ fontSize: `${previewSize(entry.titleSize, 11)}px` }}>
            {entry.title.trim() || "CURRENT CLIP TITLE"}
          </span>
          <span className="absolute -right-4 -top-2 hidden rounded bg-white px-1 py-0.5 text-[8px] text-black group-hover:block"><GripVertical className="h-2.5 w-2.5" /></span>
        </button>
      )}

    </div>
  );
}

export default function Top5ReelsPage() {
  const [ranks, setRanks] = useState<RankEntry[]>(initialRanks);
  const [activeRank, setActiveRank] = useState(5);
  const [accent, setAccent] = useState(ACCENTS[0]);
  const [finalUrl, setFinalUrl] = useState<string | null>(null);
  const [isRenderingFinal, setIsRenderingFinal] = useState(false);
  const [isPreviewingClip, setIsPreviewingClip] = useState(false);
  const [renderStage, setRenderStage] = useState<string | null>(null);
  const utils = trpc.useUtils();

  const extract = trpc.extract.transcribe.useMutation();
  const createVideo = trpc.videos.create.useMutation();
  const detectHighlights = trpc.gemini.detectHighlights.useMutation();
  const createClip = trpc.clips.create.useMutation();
  const renderClip = trpc.clips.render.useMutation();
  const hostVideo = trpc.videos.host.useMutation();
  const composeTop5 = trpc.top5.compose.useMutation();

  const active = ranks.find((entry) => entry.rank === activeRank) ?? ranks[0];
  const completed = useMemo(() => ranks.filter((entry) => entry.selectedId != null).length, [ranks]);
  const rankCount = ranks.length;

  const patchRank = (rank: number, patch: Partial<RankEntry>) => {
    setRanks((current) => current.map((entry) => entry.rank === rank ? { ...entry, ...patch } : entry));
  };

  const selectedCandidate = (entry: RankEntry) => entry.candidates.find((candidate) => candidate.id === entry.selectedId) ?? entry.candidates[0];

  const removeRank = (rank: number) => {
    if (ranks.length === 1) {
      toast.error("Keep at least one rank in the list.");
      return;
    }
    const next = ranks.filter((entry) => entry.rank !== rank);
    setRanks(next);
    if (activeRank === rank) setActiveRank(next[0].rank);
    setFinalUrl(null);
  };

  const previewCustomRange = async (rank: number, startTime: number, requestedDuration: number) => {
    const entry = ranks.find((item) => item.rank === rank);
    const selected = entry && selectedCandidate(entry);
    if (!entry?.videoId || !selected) return;
    const candidate = limitToShortClip({ ...selected, startTime, endTime: startTime + requestedDuration, reason: "Custom live range" }, entry.duration);
    try {
      setIsPreviewingClip(true);
      patchRank(rank, { customStart: candidate.startTime, customDuration: candidate.endTime - candidate.startTime, clipId: undefined, clipUrl: undefined, state: "ready", error: undefined });
      await ensureHostedSource(entry, candidate, true);
      setRenderStage(`Rank ${rank} live range preview is ready.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load this custom range.";
      patchRank(rank, { error: message });
      toast.error(message);
    } finally {
      setIsPreviewingClip(false);
    }
  };

  const addCustomCandidate = (rank: number) => {
    const entry = ranks.find((item) => item.rank === rank);
    if (!entry?.videoId) {
      toast.error(`Analyse rank ${rank} before choosing a custom clip.`);
      return;
    }
    const startTime = Math.max(0, Number(entry.customStart ?? 0));
    const requestedDuration = Math.max(1, Math.min(MAX_TOP5_CLIP_SECONDS, Number(entry.customDuration ?? MAX_TOP5_CLIP_SECONDS)));
    const endTime = entry.duration && entry.duration > 0 ? Math.min(entry.duration, startTime + requestedDuration) : startTime + requestedDuration;
    if (endTime <= startTime) {
      toast.error("Choose a custom start time inside the source video.");
      return;
    }
    const custom = limitToShortClip({
      id: -Date.now(),
      title: "CUSTOM CLIP",
      startTime,
      endTime,
      engagementScore: 0,
      reason: `Custom ${Math.round(endTime - startTime)} second selection`
    }, entry.duration);
    patchRank(rank, {
      candidates: [custom, ...entry.candidates],
      selectedId: custom.id,
      title: "CUSTOM CLIP",
      state: "ready",
      error: undefined,
      clipId: undefined,
      clipUrl: undefined
    });
    setFinalUrl(null);
  };

  const analyseRank = async (rank: number) => {
    const entry = ranks.find((item) => item.rank === rank);
    if (!entry?.url.trim()) {
      toast.error(`Paste a YouTube, TikTok, or X link for rank ${rank}.`);
      return;
    }

    setFinalUrl(null);
    patchRank(rank, { state: "analyzing", error: undefined, candidates: [], selectedId: undefined, clipId: undefined, clipUrl: undefined });
    try {
      const source: any = await extract.mutateAsync({
        url: entry.url.trim(),
        apiKey: API_KEY,
        language: "en",
        allowSpeechToText: true,
      });
      const sourceTitle = source.title || `Rank ${rank} source`;
      const transcript = String(source.transcript || "").trim();
      if (transcript.length < 10) {
        throw new Error("No usable transcript was returned. Choose another source or use a video with speech/captions.");
      }

      const created: any = await createVideo.mutateAsync({
        title: sourceTitle,
        sourceType: "url",
        sourceUrl: entry.url.trim(),
        transcript,
        duration: source.duration || undefined,
        transcriptWords: source.words?.length ? source.words : undefined,
        transcriptionEnabled: true,
      });

      const analysis: any = await detectHighlights.mutateAsync({
        transcript,
        videoDuration: source.duration || undefined,
        model: MODEL,
        apiKey: API_KEY,
        rankingMode: true,
        rank,
        sourceTitle,
      });
      const candidates: Candidate[] = (analysis.highlights || []).slice(0, 3).map((candidate: Candidate) => limitToShortClip(candidate, source.duration));
      if (!candidates.length) throw new Error("The AI did not return a usable highlight from this source.");
      const best = candidates[0];
      patchRank(rank, {
        videoId: created.id,
        sourceTitle,
        duration: source.duration || 0,
        transcript,
        candidates,
        selectedId: best.id,
        title: best.title,
        state: "ready",
      });
      toast.success(`Rank ${rank}: selected a best clip and generated its title.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not analyse this source.";
      patchRank(rank, { state: "error", error: message });
      toast.error(`Rank ${rank}: ${message}`);
    }
  };

  const analyseAll = async () => {
    const entriesWithSources = [...ranks].filter((entry) => entry.url.trim()).sort((a, b) => b.rank - a.rank);
    if (entriesWithSources.length === 0) {
      toast.error("Add at least one source link before analysing.");
      return;
    }
    for (const entry of entriesWithSources) {
      await analyseRank(entry.rank);
    }
  };

  const chooseCandidate = (rank: number, candidate: Candidate) => {
    const entry = ranks.find((item) => item.rank === rank);
    const shortCandidate = limitToShortClip(candidate, entry?.duration);
    patchRank(rank, { selectedId: shortCandidate.id, title: shortCandidate.title, customStart: undefined, customDuration: undefined, clipId: undefined, clipUrl: undefined, state: "ready" });
    setFinalUrl(null);
  };

  const waitForClip = async (clipId: number, rank: number) => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
      /* The render job writes in the background. Always invalidate first so
       * this loop cannot remain on an old cached `rendering` response. */
      await (utils.clips.list as any).invalidate();
      const clips: any[] = await (utils.clips.list as any).fetch(undefined, { staleTime: 0 });
      const current = clips.find((clip) => clip.id === clipId);
      if (current?.status === "done" && current.downloadUrl) return current;
      if (current?.status === "error") throw new Error(current.errorMessage || "Clip rendering failed.");
      setRenderStage(`Encoding rank ${rank} vertical clip… checking completion (${attempt + 1}s)`);
    }
    throw new Error("Clip rendering is still running after 2 minutes. It will continue in the background; refresh the page or check the Clips page for the finished download.");
  };

  const ensureHostedSource = async (snapshot: RankEntry, candidate: Candidate, forceRange = false) => {
    if (!snapshot.videoId) throw new Error(`Rank ${snapshot.rank} has no source video.`);
    const sameRange = Math.abs((snapshot.hostedRangeStart ?? -1) - candidate.startTime) < 0.1 && Math.abs((snapshot.hostedRangeEnd ?? -1) - candidate.endTime) < 0.1;
    let video: any = await (utils.videos.get as any).fetch({ id: snapshot.videoId });
    if (video?.hostedStatus === "ready" && video.hostedUrl && sameRange && !forceRange) {
      patchRank(snapshot.rank, { hostedUrl: video.hostedUrl });
      return video.hostedUrl as string;
    }
    if (video?.hostedStatus === "error" && !forceRange) throw new Error(video.hostError || `Could not import rank ${snapshot.rank} source.`);

    patchRank(snapshot.rank, { hostedUrl: undefined });
    setRenderStage(`Loading rank ${snapshot.rank} live clip preview…`);
    await hostVideo.mutateAsync({ id: snapshot.videoId, startTime: candidate.startTime, endTime: candidate.endTime, force: forceRange || !sameRange });
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 2000));
      video = await (utils.videos.get as any).fetch({ id: snapshot.videoId });
      if (video?.hostedStatus === "ready" && video.hostedUrl) {
        patchRank(snapshot.rank, { hostedUrl: video.hostedUrl, hostedRangeStart: candidate.startTime, hostedRangeEnd: candidate.endTime });
        return video.hostedUrl as string;
      }
      if (video?.hostedStatus === "error") throw new Error(video.hostError || `Could not import rank ${snapshot.rank} source.`);
      const progress = Number(video?.hostProgress || 0);
      setRenderStage(`Downloading rank ${snapshot.rank} source for preview${progress > 0 ? ` (${progress}%)` : ""}…`);
    }
    throw new Error(`Rank ${snapshot.rank} source import timed out after 4 minutes. Try another public video or check Fly logs.`);
  };

  const prepareRankClip = async (snapshot: RankEntry) => {
    const selected = selectedCandidate(snapshot);
    if (!snapshot.videoId || !selected) throw new Error(`Analyse and select a clip for rank ${snapshot.rank} first.`);
    /* A live custom range overrides the AI timestamps immediately, so preview
     * and final export use the handle positions even before pressing a button. */
    const candidate = snapshot.customStart !== undefined
      ? limitToShortClip({
          ...selected,
          startTime: snapshot.customStart,
          endTime: snapshot.customStart + (snapshot.customDuration ?? MAX_TOP5_CLIP_SECONDS),
          reason: "Custom live range"
        }, snapshot.duration)
      : selected;

    patchRank(snapshot.rank, { state: "rendering", error: undefined });
    await ensureHostedSource(snapshot, candidate);
    let clipId = snapshot.clipId;
    if (!clipId) {
      const created: any = await createClip.mutateAsync({
        videoId: snapshot.videoId,
        title: snapshot.title.trim() || candidate.title,
        startTime: candidate.startTime,
        endTime: candidate.endTime,
        engagementScore: candidate.engagementScore,
      });
      clipId = created.id;
      patchRank(snapshot.rank, { clipId });
    }

    const currentClips: any[] = await (utils.clips.list as any).fetch();
    const existing = currentClips.find((clip) => clip.id === clipId);
    if (existing?.status === "done" && existing.downloadUrl) {
      patchRank(snapshot.rank, { clipId, clipUrl: existing.downloadUrl, state: "rendered" });
      return { clipId, downloadUrl: existing.downloadUrl };
    }

    // The ranked layout uses its own title and persistent number overlay; skip
    // speech-to-text captions so each selected clip can render promptly.
    await renderClip.mutateAsync({ id: clipId, captionsEnabled: false, renderProfile: "top5", zoom: snapshot.zoom, offsetX: snapshot.offsetX, offsetY: snapshot.offsetY, barColor: snapshot.barColor });
    setRenderStage(`Encoding rank ${snapshot.rank} vertical clip…`);
    const finished = await waitForClip(clipId, snapshot.rank);
    patchRank(snapshot.rank, { clipId, clipUrl: finished.downloadUrl, state: "rendered" });
    return { clipId, downloadUrl: finished.downloadUrl as string };
  };

  const previewActiveClip = async () => {
    try {
      setIsPreviewingClip(true);
      setRenderStage(`Preparing rank ${active.rank} preview…`);
      const result = await prepareRankClip(active);
      patchRank(active.rank, { clipId: result.clipId, clipUrl: result.downloadUrl, state: "rendered" });
      setRenderStage(`Rank ${active.rank} preview is ready.`);
      toast.success(`Rank ${active.rank} preview is ready in the right panel.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not prepare this preview.";
      patchRank(active.rank, { state: "error", error: message });
      setRenderStage(null);
      toast.error(message);
    } finally {
      setIsPreviewingClip(false);
      await (utils.clips.list as any).invalidate();
    }
  };

  const renderFinal = async () => {
    const ordered = [...ranks].sort((a, b) => b.rank - a.rank);
    const missing = ordered.find((entry) => !entry.videoId || !selectedCandidate(entry));
    if (missing) {
      toast.error(`Analyse and choose a clip for rank ${missing.rank} first.`);
      return;
    }

    setIsRenderingFinal(true);
    setFinalUrl(null);
    try {
      const built: Array<{ entry: RankEntry; clipId: number }> = [];
      for (let index = 0; index < ordered.length; index += 1) {
        const snapshot = ordered[index];
        setRenderStage(`Rendering rank ${snapshot.rank} clip (${index + 1} of ${ordered.length})…`);
        const result = await prepareRankClip(snapshot);
        built.push({ entry: snapshot, clipId: result.clipId });
      }

      setRenderStage(`Adding the ranking overlay and exporting ${built.length} short clip${built.length === 1 ? "" : "s"}…`);
      const output: any = await composeTop5.mutateAsync({
        entries: built.map(({ entry, clipId }) => ({
          clipId,
          rank: entry.rank,
          title: entry.title.trim(),
          // The full 5-to-1 list is always visible over the finished video.
          showNumber: true,
          showTitle: entry.showTitle,
          numberPosition: entry.numberPosition,
          titlePosition: entry.titlePosition,
          numberSize: entry.numberSize,
          titleSize: entry.titleSize,
          accentColor: accent,
        })),
      });
      setFinalUrl(output.url);
      setRenderStage("Your ranked video is ready to download.");
      toast.success("Your ranked video is ready to download.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not render the Top 5 video.";
      setRenderStage(null);
      toast.error(message);
    } finally {
      setIsRenderingFinal(false);
      await (utils.clips.list as any).invalidate();
    }
  };

  const reset = () => {
    setRanks(initialRanks);
    setActiveRank(5);
    setFinalUrl(null);
    setAccent(ACCENTS[0]);
  };

  return (
    <AppLayout title="Top 5 Reels">
      <div className="mx-auto max-w-7xl pb-10">
        <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-primary">Ranked video builder</p>
            <h1 className="text-3xl font-black tracking-[-0.06em] text-foreground sm:text-4xl">Top 5 Video Countdown</h1>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
              Add one YouTube, TikTok, or X video for each rank. The same AI used in Create picks the strongest clip from every source using a ranking-specific prompt, generates the label, and builds one high-quality 5-to-1 export.
            </p>
          </div>
          <button type="button" onClick={reset} className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2.5 text-sm font-bold text-foreground transition hover:border-foreground/30">
            <Trash2 className="h-4 w-4" /> Clear project
          </button>
        </header>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <section className="space-y-5">
            <div className="glass rounded-2xl p-5 sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-black text-foreground">1. Add only the ranks you want</h2>
                  <p className="mt-1 text-xs text-muted-foreground">Each rank is optional. Remove an unused rank instead of adding a link; the final video uses only the remaining ranks.</p>
                </div>
                <button type="button" onClick={analyseAll} disabled={extract.isPending || detectHighlights.isPending} className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-black text-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45" style={{ background: accent }}>
                  {extract.isPending || detectHighlights.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                  Analyse sources
                </button>
              </div>

              <div className="mt-5 space-y-3">
                {ranks.map((entry) => (
                  <div key={entry.id} className={`rounded-2xl border p-3 transition ${activeRank === entry.rank ? "border-primary/60 bg-primary/[0.035]" : "border-border bg-card/40"}`}>
                    <div className="flex gap-3">
                      <button type="button" onClick={() => setActiveRank(entry.rank)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-xl font-black text-black" style={{ background: entry.rank === 1 ? accent : "var(--secondary)" }}>
                        {entry.rank}
                      </button>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground">Rank {entry.rank} · {sourceLabel(entry.url)}</p>
                          <div className="flex items-center gap-2"><span className={`text-[11px] font-semibold ${entry.state === "error" ? "text-destructive" : entry.state === "ready" || entry.state === "rendered" ? "text-emerald-500" : "text-muted-foreground"}`}>{stateCopy(entry.state)}</span><button type="button" onClick={() => removeRank(entry.rank)} className="rounded-lg p-1 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive" aria-label={`Remove rank ${entry.rank}`} title="Remove this rank"><Trash2 className="h-3.5 w-3.5" /></button></div>
                        </div>
                        <div className="mt-2 flex gap-2">
                          <div className="relative min-w-0 flex-1">
                            <Link2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                            <input value={entry.url} onFocus={() => setActiveRank(entry.rank)} onChange={(event) => patchRank(entry.rank, { url: event.target.value, state: "idle", candidates: [], selectedId: undefined, clipId: undefined, clipUrl: undefined, hostedUrl: undefined, error: undefined })} placeholder="Paste YouTube, TikTok, or X video link" className="w-full rounded-xl border border-border bg-input py-2.5 pl-9 pr-3 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20" />
                          </div>
                          <button type="button" onClick={() => analyseRank(entry.rank)} disabled={!entry.url.trim() || entry.state === "analyzing"} className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-secondary px-3 py-2 text-xs font-bold text-foreground transition hover:bg-secondary/70 disabled:cursor-not-allowed disabled:opacity-50">
                            {entry.state === "analyzing" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} Analyse
                          </button>
                        </div>
                        {entry.sourceTitle && <p className="mt-2 truncate text-xs font-semibold text-foreground">{entry.sourceTitle}{entry.duration ? <span className="font-normal text-muted-foreground"> · {timecode(entry.duration)}</span> : null}</p>}
                        {entry.error && <p className="mt-2 text-xs text-destructive">{entry.error}</p>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="glass rounded-2xl p-5 sm:p-6">
              <div className="mb-4 flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-base font-black text-foreground">2. Choose the best clip for rank {active.rank}</h2>
                  <p className="mt-1 text-xs text-muted-foreground">Every AI choice is capped at 15 seconds. Choose a suggestion or make a custom 1–15 second range from the full source.</p>
                </div>
                <span className="rounded-full bg-secondary px-3 py-1.5 text-xs font-bold text-muted-foreground">{completed}/{rankCount} ready</span>
              </div>

              {active.candidates.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">Analyse rank {active.rank} to receive AI-selected moments from that source.</div>
              ) : (
                <div className="space-y-3">
                  {active.candidates.map((candidate, index) => {
                    const selected = active.selectedId === candidate.id;
                    return (
                      <button key={candidate.id} type="button" onClick={() => chooseCandidate(active.rank, candidate)} className={`w-full rounded-xl border p-4 text-left transition ${selected ? "border-primary bg-primary/[0.06]" : "border-border bg-card hover:border-foreground/25"}`}>
                        <div className="flex items-start gap-3">
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-black" style={{ background: selected ? accent : "var(--secondary)", color: selected ? "black" : "var(--foreground)" }}>{index + 1}</span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <p className="font-black uppercase tracking-[-0.03em] text-foreground">{candidate.title}</p>
                              <span className="font-mono text-xs text-muted-foreground">{timecode(candidate.startTime)}–{timecode(candidate.endTime)} · ≤15s</span>
                            </div>
                            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{candidate.reason}</p>
                          </div>
                          {selected && <CheckCircle2 className="h-5 w-5 shrink-0" style={{ color: accent }} />}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}

              {active.videoId && (
                <div className="mt-4 rounded-xl border border-dashed border-primary/35 bg-primary/[0.035] p-4">
                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <p className="text-sm font-black text-foreground">Custom short clip</p>
                      <p className="mt-1 text-xs text-muted-foreground">Choose any moment in the full video. The maximum duration is 15 seconds.</p>
                    </div>
                    <button type="button" onClick={() => addCustomCandidate(active.rank)} className="rounded-xl px-3 py-2 text-xs font-black text-black transition hover:brightness-110" style={{ background: accent }}>Use custom clip</button>
                  </div>
                  <CustomClipTimeline sourceDuration={active.duration} start={active.customStart ?? selectedCandidate(active)?.startTime ?? 0} duration={active.customDuration ?? Math.min(MAX_TOP5_CLIP_SECONDS, Math.max(1, (selectedCandidate(active)?.endTime ?? MAX_TOP5_CLIP_SECONDS) - (selectedCandidate(active)?.startTime ?? 0)))} accent={accent} onChange={(customStart, customDuration) => patchRank(active.rank, { customStart, customDuration, hostedUrl: undefined, clipId: undefined, clipUrl: undefined, state: "ready" })} onCommit={(customStart, customDuration) => void previewCustomRange(active.rank, customStart, customDuration)} />
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label className="block"><span className="mb-1.5 block text-xs font-semibold text-foreground">Start time (seconds)</span><input type="number" min="0" max={active.duration || undefined} step="0.1" value={roundClipTime(active.customStart ?? selectedCandidate(active)?.startTime ?? 0)} onChange={(event) => patchRank(active.rank, { customStart: roundClipTime(Number(event.target.value) || 0), hostedUrl: undefined, clipId: undefined, clipUrl: undefined, state: "ready" })} className="w-full rounded-xl border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary" /></label>
                    <label className="block"><span className="mb-1.5 flex justify-between text-xs font-semibold text-foreground"><span>Duration</span><span className="text-muted-foreground">1–15 sec</span></span><input type="number" min="1" max={MAX_TOP5_CLIP_SECONDS} step="0.1" value={roundClipTime(active.customDuration ?? Math.min(MAX_TOP5_CLIP_SECONDS, Math.max(1, (selectedCandidate(active)?.endTime ?? MAX_TOP5_CLIP_SECONDS) - (selectedCandidate(active)?.startTime ?? 0))))} onChange={(event) => patchRank(active.rank, { customDuration: roundClipTime(Math.max(1, Math.min(MAX_TOP5_CLIP_SECONDS, Number(event.target.value) || 1))), hostedUrl: undefined, clipId: undefined, clipUrl: undefined, state: "ready" })} className="w-full rounded-xl border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary" /></label>
                  </div>
                  <div className="mt-4 rounded-xl border border-border bg-card/70 p-3"><div className="mb-2 flex items-center justify-between text-xs font-semibold text-foreground"><span>Clip zoom</span><span className="font-mono text-muted-foreground">{active.zoom.toFixed(2)}×</span></div><input type="range" min="0.5" max="3" step="0.05" value={active.zoom} onChange={(event) => patchRank(active.rank, { zoom: Number(event.target.value), clipId: undefined, clipUrl: undefined, state: "ready" })} className="w-full accent-primary" />{active.zoom < 1 && <div className="mt-3 flex items-center justify-between rounded-lg border border-border bg-input/60 px-3 py-2"><div><p className="text-xs font-bold text-foreground">Top & bottom bar color</p><p className="text-[11px] text-muted-foreground">The full 16:9 source stays visible between these bars.</p></div><input type="color" value={active.barColor} onChange={(event) => patchRank(active.rank, { barColor: event.target.value, clipId: undefined, clipUrl: undefined, state: "ready" })} className="h-8 w-10 cursor-pointer rounded border-0 bg-transparent p-0" aria-label="Choose letterbox bar color" /></div>}<div className="mt-2 flex items-center justify-between"><span className="text-[11px] text-muted-foreground">Below 1.00× preserves the whole 16:9 video. Only top and bottom bars are added.</span><button type="button" onClick={() => patchRank(active.rank, { zoom: 1, offsetX: 0, offsetY: 0, clipId: undefined, clipUrl: undefined, state: "ready" })} className="rounded-lg border border-border px-2 py-1 text-[11px] font-bold text-foreground hover:bg-secondary">Reset zoom</button></div></div>
                </div>
              )}
            </div>

            <div className="glass rounded-2xl p-5 sm:p-6">
              <div className="mb-4">
                <h2 className="text-base font-black text-foreground">3. Persistent numbers and timed rank title</h2>
                  <p className="mt-1 text-xs text-muted-foreground">All remaining rank numbers stay on-screen for the whole video. The title for rank {active.rank} appears when that specific source clip begins, then remains visible.</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-2 block text-xs font-semibold text-foreground">Generated title for rank {active.rank}</span>
                  <input value={active.title} onChange={(event) => patchRank(active.rank, { title: event.target.value.toUpperCase(), clipId: undefined })} maxLength={72} placeholder="Generated after clip selection" className="w-full rounded-xl border border-border bg-input px-3 py-2.5 text-sm font-black uppercase text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" />
                </label>
                <label className="block">
                  <span className="mb-2 block text-xs font-semibold text-foreground">Title visibility</span>
                  <button type="button" onClick={() => patchRank(active.rank, { showTitle: !active.showTitle })} className={`flex w-full items-center justify-between rounded-xl border px-3 py-2.5 text-sm font-bold transition ${active.showTitle ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}><span>{active.showTitle ? "Title will appear with clip" : "Title hidden for this clip"}</span><span>{active.showTitle ? "On" : "Off"}</span></button>
                </label>
              </div>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="block"><span className="mb-2 flex justify-between text-xs font-semibold text-foreground"><span>Rank number size</span><span className="font-mono text-muted-foreground">{active.numberSize}px</span></span><input type="range" min="42" max="220" step="2" value={active.numberSize} onChange={(event) => patchRank(active.rank, { numberSize: Number(event.target.value) })} className="w-full accent-primary" /></label>
                <label className="block"><span className="mb-2 flex justify-between text-xs font-semibold text-foreground"><span>Clip title size</span><span className="font-mono text-muted-foreground">{active.titleSize}px</span></span><input type="range" min="24" max="112" step="2" value={active.titleSize} onChange={(event) => patchRank(active.rank, { titleSize: Number(event.target.value) })} className="w-full accent-primary" /></label>
              </div>
              <div className="mt-4 flex flex-wrap gap-3">
                <div className="rounded-xl border border-border bg-secondary/30 px-3 py-2 text-xs font-semibold text-muted-foreground">Drag the active rank’s number or title in the preview to reposition it.</div>
                <div className="ml-auto flex items-center gap-2 text-xs font-semibold text-muted-foreground"><span>Accent</span>{ACCENTS.map((color) => <button key={color} type="button" onClick={() => setAccent(color)} className="h-6 w-6 rounded-full border-2 transition" style={{ background: color, borderColor: accent === color ? "white" : "transparent" }} aria-label={`Use ${color} accent`} />)}</div>
              </div>
            </div>

            <div className="glass rounded-2xl p-5 sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="text-base font-black text-foreground">4. Render the ranked video</h2>
                  <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">The renderer uses only the {rankCount} remaining rank{rankCount === 1 ? "" : "s"}. Every selected source range is 15 seconds or less, cropped to 1080 × 1920, with persistent rank numbers and timed titles.</p>
                </div>
                <button type="button" onClick={renderFinal} disabled={isRenderingFinal || completed !== rankCount} className="inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-black text-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40" style={{ background: accent }}>
                  {isRenderingFinal ? <Loader2 className="h-4 w-4 animate-spin" /> : <Video className="h-4 w-4" />}
                  {isRenderingFinal ? "Rendering ranked video…" : "Render high-quality video"}
                </button>
              </div>
              {renderStage && <div className="mt-4 flex items-center gap-3 rounded-xl border border-primary/25 bg-primary/[0.07] p-4 text-sm font-semibold text-foreground"><Loader2 className={`h-4 w-4 shrink-0 ${isRenderingFinal || isPreviewingClip ? "animate-spin" : ""}`} style={{ color: accent }} /><span>{renderStage}</span></div>}
              {(isRenderingFinal || isPreviewingClip) && <div className="mt-3 grid gap-1.5" style={{ gridTemplateColumns: `repeat(${rankCount}, minmax(0, 1fr))` }} aria-label="Ranked-video render progress">{[...ranks].sort((a, b) => b.rank - a.rank).map((item) => <div key={item.rank} className={`h-1.5 rounded-full ${item.state === "rendered" ? "bg-emerald-500" : item.state === "rendering" ? "animate-pulse" : "bg-secondary"}`} style={item.state === "rendering" ? { background: accent } : undefined} />)}</div>}
              {finalUrl && <a href={finalUrl} download className="mt-4 flex items-center justify-between rounded-xl border border-emerald-500/35 bg-emerald-500/10 p-4 text-sm font-bold text-foreground transition hover:bg-emerald-500/15"><span className="flex items-center gap-2"><CheckCircle2 className="h-5 w-5 text-emerald-500" /> Your ranked video is ready</span><span className="flex items-center gap-2 text-emerald-500"><Download className="h-4 w-4" /> Download MP4</span></a>}
            </div>
          </section>

          <aside className="xl:sticky xl:top-6 xl:h-fit">
            <div className="glass rounded-2xl p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div><p className="text-sm font-black text-foreground">Persistent ranking overlay</p><p className="mt-1 text-xs text-muted-foreground">Drag the active number or title directly in the preview.</p></div>
                <span className="rounded-lg bg-secondary px-2 py-1 font-mono text-[10px] text-muted-foreground">1080 × 1920</span>
              </div>
              <RankOverlayPreview entry={active} ranks={ranks} accent={accent} previewUrl={active.clipUrl} hostedUrl={active.hostedUrl} previewStart={active.hostedUrl ? 0 : active.customStart ?? selectedCandidate(active)?.startTime} onMove={(kind, point) => patchRank(active.rank, kind === "number" ? { numberPosition: point } : { titlePosition: point })} />
              <button type="button" onClick={previewActiveClip} disabled={!active.videoId || !selectedCandidate(active) || isPreviewingClip || isRenderingFinal} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 py-3 text-sm font-black text-foreground transition hover:border-primary hover:bg-primary/[0.06] disabled:cursor-not-allowed disabled:opacity-45">
                {isPreviewingClip ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                {isPreviewingClip ? `Preparing rank ${active.rank} preview…` : active.clipUrl ? "Replay selected clip preview" : `Preview rank ${active.rank} selected clip`}
              </button>
              <div className="mt-3 rounded-xl border border-border bg-secondary/30 p-3 text-xs leading-relaxed text-muted-foreground">AI and custom choices are capped at 15 seconds. YouTube sources show their thumbnail immediately after analysis; preview downloads only the selected short range before the vertical export completes. Removed ranks are not included in the final overlay.</div>
              <div className="mt-4 divide-y divide-border rounded-xl border border-border bg-card">
                {ranks.map((entry) => <button key={entry.id} type="button" onClick={() => setActiveRank(entry.rank)} className={`flex w-full items-center gap-3 px-3 py-3 text-left transition ${activeRank === entry.rank ? "bg-secondary/60" : "hover:bg-secondary/35"}`}><span className="flex h-7 w-7 items-center justify-center rounded-lg text-xs font-black" style={{ background: entry.rank === 1 ? accent : "var(--secondary)" }}>{entry.rank}</span><span className="min-w-0 flex-1 truncate text-xs font-bold text-foreground">{entry.title || `Rank ${entry.rank} title`}</span>{entry.state === "rendering" ? <Loader2 className="h-4 w-4 animate-spin" style={{ color: accent }} /> : entry.state === "error" ? <span className="text-xs font-black text-destructive">!</span> : entry.state === "ready" || entry.state === "rendered" ? <CheckCircle2 className="h-4 w-4" style={{ color: accent }} /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}</button>)}
              </div>
            </div>
          </aside>
        </div>
      </div>
    </AppLayout>
  );
}
