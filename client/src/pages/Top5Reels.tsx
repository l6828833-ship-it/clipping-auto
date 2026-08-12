import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import AppLayout from "@/components/AppLayout";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import {
  CheckCircle2,
  ChevronDown,
  Download,
  GripVertical,
  Link2,
  Loader2,
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
  state: "idle",
});

const initialRanks = [5, 4, 3, 2, 1].map(createRank);

function timecode(seconds: number) {
  const value = Math.max(0, Math.round(seconds || 0));
  const mins = Math.floor(value / 60);
  return `${mins}:${String(value % 60).padStart(2, "0")}`;
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
  onMove,
}: {
  entry: RankEntry;
  ranks: RankEntry[];
  accent: string;
  onMove: (kind: "number" | "title", point: Point) => void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<"number" | "title" | null>(null);

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

  return (
    <div
      ref={frameRef}
      onPointerMove={move}
      onPointerUp={() => setDragging(null)}
      onPointerCancel={() => setDragging(null)}
      className="relative aspect-[9/16] w-full overflow-hidden rounded-[1.5rem] bg-[#070707] shadow-2xl"
      style={{ backgroundImage: "radial-gradient(circle at 82% 11%, rgba(255,255,255,0.11), transparent 23%), linear-gradient(180deg, #161616 0%, #050505 78%)" }}
    >
      <div className="absolute inset-x-0 top-0 h-1" style={{ background: accent }} />
      <p className="absolute left-[10%] top-[8%] z-10 text-[8px] font-black uppercase tracking-[0.2em] text-white/55">Persistent ranking overlay</p>

      {ranks.map((rankEntry) => {
        const activeNumber = rankEntry.rank === entry.rank;
        const numberStyle = {
          left: `${rankEntry.numberPosition.x * 100}%`,
          top: `${rankEntry.numberPosition.y * 100}%`,
          transform: "translate(-50%, -50%)",
          fontSize: `${previewSize(rankEntry.numberSize, 18)}px`,
          color: rankEntry.rank === 1 ? accent : "transparent",
          WebkitTextStroke: `1.4px ${rankEntry.rank === 1 ? accent : "rgba(255,255,255,0.96)"}`,
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

      <div className="absolute bottom-4 left-5 right-5 rounded-lg border border-white/10 bg-black/45 px-3 py-2 text-center font-mono text-[8px] uppercase tracking-[0.16em] text-white/55 backdrop-blur-sm">
        All rank numbers stay visible · rank {entry.rank} title appears when its clip starts
      </div>
    </div>
  );
}

export default function Top5ReelsPage() {
  const [ranks, setRanks] = useState<RankEntry[]>(initialRanks);
  const [activeRank, setActiveRank] = useState(5);
  const [accent, setAccent] = useState(ACCENTS[0]);
  const [finalUrl, setFinalUrl] = useState<string | null>(null);
  const [isRenderingFinal, setIsRenderingFinal] = useState(false);
  const utils = trpc.useUtils();

  const extract = trpc.extract.transcribe.useMutation();
  const createVideo = trpc.videos.create.useMutation();
  const detectHighlights = trpc.gemini.detectHighlights.useMutation();
  const createClip = trpc.clips.create.useMutation();
  const renderClip = trpc.clips.render.useMutation();
  const composeTop5 = trpc.top5.compose.useMutation();

  const active = ranks.find((entry) => entry.rank === activeRank) ?? ranks[0];
  const completed = useMemo(() => ranks.filter((entry) => entry.selectedId != null).length, [ranks]);

  const patchRank = (rank: number, patch: Partial<RankEntry>) => {
    setRanks((current) => current.map((entry) => entry.rank === rank ? { ...entry, ...patch } : entry));
  };

  const selectedCandidate = (entry: RankEntry) => entry.candidates.find((candidate) => candidate.id === entry.selectedId) ?? entry.candidates[0];

  const analyseRank = async (rank: number) => {
    const entry = ranks.find((item) => item.rank === rank);
    if (!entry?.url.trim()) {
      toast.error(`Paste a YouTube, TikTok, or X link for rank ${rank}.`);
      return;
    }

    setFinalUrl(null);
    patchRank(rank, { state: "analyzing", error: undefined, candidates: [], selectedId: undefined, clipId: undefined });
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
      const candidates: Candidate[] = (analysis.highlights || []).slice(0, 3);
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
    for (const entry of [...ranks].sort((a, b) => b.rank - a.rank)) {
      if (!entry.url.trim()) {
        toast.error(`Add a source link for rank ${entry.rank} before analysing all videos.`);
        return;
      }
    }
    for (const entry of [...ranks].sort((a, b) => b.rank - a.rank)) {
      await analyseRank(entry.rank);
    }
  };

  const chooseCandidate = (rank: number, candidate: Candidate) => {
    patchRank(rank, { selectedId: candidate.id, title: candidate.title, clipId: undefined, state: "ready" });
    setFinalUrl(null);
  };

  const waitForClip = async (clipId: number) => {
    for (let attempt = 0; attempt < 180; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 2000));
      const clips: any[] = await (utils.clips.list as any).fetch();
      const current = clips.find((clip) => clip.id === clipId);
      if (current?.status === "done" && current.downloadUrl) return current;
      if (current?.status === "error") throw new Error(current.errorMessage || "Clip rendering failed.");
    }
    throw new Error("Clip rendering timed out. Check the Clips page for progress.");
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
      for (const snapshot of ordered) {
        const candidate = selectedCandidate(snapshot)!;
        patchRank(snapshot.rank, { state: "rendering", error: undefined });
        let clipId = snapshot.clipId;
        if (!clipId) {
          const created: any = await createClip.mutateAsync({
            videoId: snapshot.videoId!,
            title: snapshot.title.trim() || candidate.title,
            startTime: candidate.startTime,
            endTime: candidate.endTime,
            engagementScore: candidate.engagementScore,
          });
          clipId = created.id;
          patchRank(snapshot.rank, { clipId });
        }
        await renderClip.mutateAsync({ id: clipId, captionsEnabled: true });
        await waitForClip(clipId);
        patchRank(snapshot.rank, { clipId, state: "rendered" });
        built.push({ entry: snapshot, clipId });
      }

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
      toast.success("Your Top 5 video is ready to download.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not render the Top 5 video.");
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
                  <h2 className="text-base font-black text-foreground">1. Add five ranked sources</h2>
                  <p className="mt-1 text-xs text-muted-foreground">Every rank uses its own source. Links are analysed first; only the selected highlight is downloaded for final rendering.</p>
                </div>
                <button type="button" onClick={analyseAll} disabled={extract.isPending || detectHighlights.isPending} className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-black text-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45" style={{ background: accent }}>
                  {extract.isPending || detectHighlights.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                  Analyse all 5
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
                          <span className={`text-[11px] font-semibold ${entry.state === "error" ? "text-destructive" : entry.state === "ready" || entry.state === "rendered" ? "text-emerald-500" : "text-muted-foreground"}`}>{stateCopy(entry.state)}</span>
                        </div>
                        <div className="mt-2 flex gap-2">
                          <div className="relative min-w-0 flex-1">
                            <Link2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                            <input value={entry.url} onFocus={() => setActiveRank(entry.rank)} onChange={(event) => patchRank(entry.rank, { url: event.target.value, state: "idle", candidates: [], selectedId: undefined, clipId: undefined, error: undefined })} placeholder="Paste YouTube, TikTok, or X video link" className="w-full rounded-xl border border-border bg-input py-2.5 pl-9 pr-3 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20" />
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
                  <p className="mt-1 text-xs text-muted-foreground">The first choice is selected automatically. Choose another candidate if you prefer.</p>
                </div>
                <span className="rounded-full bg-secondary px-3 py-1.5 text-xs font-bold text-muted-foreground">{completed}/5 ready</span>
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
                              <span className="font-mono text-xs text-muted-foreground">{timecode(candidate.startTime)}–{timecode(candidate.endTime)}</span>
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
            </div>

            <div className="glass rounded-2xl p-5 sm:p-6">
              <div className="mb-4">
                <h2 className="text-base font-black text-foreground">3. Persistent numbers and timed rank title</h2>
                <p className="mt-1 text-xs text-muted-foreground">All five rank numbers stay on-screen for the whole video. The title for rank {active.rank} appears when that specific source clip begins, then remains visible.</p>
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
                  <h2 className="text-base font-black text-foreground">4. Render the complete Top 5 video</h2>
                  <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">The renderer downloads only the selected ranges at the best available source quality, crops each clip to 1080 × 1920, keeps the full 5-to-1 ranking list visible, and reveals each title when its matching clip begins.</p>
                </div>
                <button type="button" onClick={renderFinal} disabled={isRenderingFinal || completed !== 5} className="inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-black text-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40" style={{ background: accent }}>
                  {isRenderingFinal ? <Loader2 className="h-4 w-4 animate-spin" /> : <Video className="h-4 w-4" />}
                  {isRenderingFinal ? "Rendering Top 5…" : "Render high-quality video"}
                </button>
              </div>
              {finalUrl && <a href={finalUrl} download className="mt-4 flex items-center justify-between rounded-xl border border-emerald-500/35 bg-emerald-500/10 p-4 text-sm font-bold text-foreground transition hover:bg-emerald-500/15"><span className="flex items-center gap-2"><CheckCircle2 className="h-5 w-5 text-emerald-500" /> Your Top 5 video is ready</span><span className="flex items-center gap-2 text-emerald-500"><Download className="h-4 w-4" /> Download MP4</span></a>}
            </div>
          </section>

          <aside className="xl:sticky xl:top-6 xl:h-fit">
            <div className="glass rounded-2xl p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div><p className="text-sm font-black text-foreground">Persistent ranking overlay</p><p className="mt-1 text-xs text-muted-foreground">Drag the active number or title directly in the preview.</p></div>
                <span className="rounded-lg bg-secondary px-2 py-1 font-mono text-[10px] text-muted-foreground">1080 × 1920</span>
              </div>
              <RankOverlayPreview entry={active} ranks={ranks} accent={accent} onMove={(kind, point) => patchRank(active.rank, kind === "number" ? { numberPosition: point } : { titlePosition: point })} />
              <div className="mt-4 rounded-xl border border-border bg-secondary/30 p-3 text-xs leading-relaxed text-muted-foreground">The full rank list stays over every clip. When a clip begins, its own generated title appears beside its number, matching the ranking style in your reference.</div>
              <div className="mt-4 divide-y divide-border rounded-xl border border-border bg-card">
                {ranks.map((entry) => <button key={entry.id} type="button" onClick={() => setActiveRank(entry.rank)} className={`flex w-full items-center gap-3 px-3 py-3 text-left transition ${activeRank === entry.rank ? "bg-secondary/60" : "hover:bg-secondary/35"}`}><span className="flex h-7 w-7 items-center justify-center rounded-lg text-xs font-black" style={{ background: entry.rank === 1 ? accent : "var(--secondary)" }}>{entry.rank}</span><span className="min-w-0 flex-1 truncate text-xs font-bold text-foreground">{entry.title || `Rank ${entry.rank} title`}</span>{entry.state === "ready" || entry.state === "rendered" ? <CheckCircle2 className="h-4 w-4" style={{ color: accent }} /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}</button>)}
              </div>
            </div>
          </aside>
        </div>
      </div>
    </AppLayout>
  );
}
