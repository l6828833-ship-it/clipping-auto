import { useState, useRef, useMemo, useEffect } from "react";
// (useRef/useEffect drive the one-shot import trigger in StepSubtitles)
import AppLayout from "@/components/AppLayout";
import ClipPreview from "@/components/ClipPreview";
import VideoFramer, { CropView, DEFAULT_FRAMING, type Framing } from "@/components/VideoFramer";
import SubtitleOverlay, {
  previewWordsFor, DEFAULT_SUBTITLE_STYLE, MIN_FONT_SIZE, MAX_FONT_SIZE, PRESET_Y,
} from "@/components/SubtitleOverlay";
import { parseYouTubeId, youTubeThumbnail } from "@/lib/videoSource";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import {
  Upload, Link2, Sparkles, Type, Download, CheckCircle2,
  Loader2, Play, Clock, FileVideo, Youtube,
  X, Palette, Save, Film, ArrowRight, ChevronRight, Zap,
  Brain, AlertCircle, RefreshCw, Wand2, Key, ExternalLink,
  Mic, Captions, Globe2, ChevronDown, Scissors, Move,
} from "lucide-react";
import ClipTimeline, { type TimelineWord, type Keyframe } from "@/components/ClipTimeline";
import {
  materialiseSegments, setSegmentKeyframe, isAnimated, segmentTarget,
  framingAt, segmentAt, type FramingSegment,
} from "@shared/framing";

// ─── Types ────────────────────────────────────────────────────────────────────
type Step = 1 | 2 | 3 | 4 | 5;
const STEPS = [
  { id: 1, label: "Input",      icon: Upload   },
  { id: 2, label: "Highlights", icon: Sparkles },
  { id: 3, label: "Subtitles",  icon: Type     },
  { id: 4, label: "Edit",       icon: Scissors },
  { id: 5, label: "Export",     icon: Download },
] as const;

type Highlight = {
  id: number; title: string; startTime: number; endTime: number;
  engagementScore: number; reason: string;
};
type SubStyle = {
  font: string; fontSize: number; color: string;
  highlightColor: string; position: "top"|"center"|"bottom"; outline: boolean;
  /** Free position as a percentage of the frame; overrides `position`. */
  posX?: number; posY?: number;
};

/**
 * Caption fonts. The first three are bundled with the server (see
 * assets/fonts/README.md) so the burned-in output matches this preview.
 * Impact and Arial Black rely on the server having them installed.
 */
const FONTS = ["Montserrat", "Oswald", "Inter", "Impact", "Arial Black"];
const TEXT_COLORS = ["#FFFFFF","#FFE600","#39FF14","#00B4FF","#FF2D78"];
const HL_COLORS   = ["#FFE600","#39FF14","#00B4FF","#FF2D78"];
const SAMPLE_WORDS = [
  { word:"This",  start:0.0, end:0.3 }, { word:"is",    start:0.3, end:0.5 },
  { word:"how",   start:0.5, end:0.8 }, { word:"you",   start:0.8, end:1.0 },
  { word:"go",    start:1.0, end:1.2 }, { word:"VIRAL", start:1.2, end:1.8 },
];
const LANGUAGES = [
  { code: "en", label: "English" }, { code: "es", label: "Spanish" },
  { code: "fr", label: "French"  }, { code: "de", label: "German"  },
  { code: "pt", label: "Portuguese" }, { code: "ja", label: "Japanese" },
  { code: "zh", label: "Chinese" }, { code: "ar", label: "Arabic"  },
  { code: "hi", label: "Hindi"   }, { code: "ko", label: "Korean"  },
];

function fmt(s: number) {
  const m = Math.floor(s/60), sec = Math.floor(s%60);
  return `${m}:${sec.toString().padStart(2,"0")}`;
}

// ─── No API key warning ───────────────────────────────────────────────────────
function NoKeyWarning() {
  return null;
}

// ─── Extraction progress stages ───────────────────────────────────────────────
type Stage = "idle" | "fetching-info" | "downloading" | "extracting-audio" | "transcribing" | "done" | "error";
const STAGE_LABELS: Record<Stage, string> = {
  idle: "",
  "fetching-info": "Fetching video info…",
  downloading: "Looking for YouTube transcript…",
  "extracting-audio": "Extracting & encoding audio…",
  transcribing: "Transcribing with Whisper (fallback)…",
  done: "Transcript ready!",
  error: "Extraction failed",
};
const STAGE_PROGRESS: Record<Stage, number> = {
  idle: 0, "fetching-info": 15, downloading: 40,
  "extracting-audio": 65, transcribing: 85, done: 100, error: 0,
};

// ─── Step bar ─────────────────────────────────────────────────────────────────
function StepBar({ current, onGo }: { current: Step; onGo: (s: Step) => void }) {
  return (
    <div className="flex items-center gap-0 mb-8">
      {STEPS.map((s, i) => {
        const done = current > s.id, active = current === s.id;
        return (
          <div key={s.id} className="flex items-center flex-1 last:flex-none">
            <button onClick={() => done && onGo(s.id as Step)}
              className={`flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-semibold transition-all duration-200 whitespace-nowrap ${active ? "text-white shadow-lg" : done ? "text-foreground hover:bg-secondary/60 cursor-pointer" : "text-muted-foreground cursor-default"}`}
              style={active ? { background: "linear-gradient(135deg, var(--cobalt), oklch(0.55 0.22 270))", boxShadow: "0 2px 16px rgba(49, 94, 245, 0.18)" } : {}}>
              {done
                ? <CheckCircle2 className="w-4 h-4 shrink-0" style={{ color: "var(--mint)" }} />
                : <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-black shrink-0 ${active ? "bg-white/20" : "bg-secondary"}`}>{s.id}</div>}
              <span className="hidden sm:inline">{s.label}</span>
            </button>
            {i < STEPS.length - 1 && (
              <ChevronRight className={`w-4 h-4 mx-1 shrink-0 ${done ? "" : "text-muted-foreground/40"}`}
                style={done ? { color: "var(--mint)" } : {}} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Step 1: Input with auto-extraction ──────────────────────────────────────
function StepInput({ apiKey, onNext }: {
  apiKey: string;
  onNext: (v: {
    videoId: number; title: string; url: string;
    transcript: string; duration: number; subtitlesOn: boolean;
    words: { word: string; start: number; end: number }[];
    heatmap: { start: number; end: number; value: number }[];
    chapters: { start: number; end: number; title: string }[];
  }) => void
}) {
  /*
   * Whether this video should get subtitles at all.
   *
   * Off means no speech-to-text runs anywhere — no Inworld credits are spent —
   * and the export is a clean video with no burned-in captions. It can be
   * turned back on later from the clip's Subtitles panel.
   */
  const [subtitlesOn, setSubtitlesOn] = useState(true);
  // Real word timings from the source caption track, when it had them.
  const [timedWords, setTimedWords] = useState<{ word: string; start: number; end: number }[]>([]);
  /**
   * YouTube's "most replayed" curve and chapters for this video.
   *
   * Measured engagement, so highlight detection can prioritise the seconds
   * viewers actually rewatched. Empty when the platform published neither.
   */
  const [heatmap, setHeatmap] = useState<{ start: number; end: number; value: number }[]>([]);
  const [chapters, setChapters] = useState<{ start: number; end: number; title: string }[]>([]);
  const [mode, setMode] = useState<"url"|"upload">("url");
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [transcript, setTranscript] = useState("");
  const [language, setLanguage] = useState("en");
  const [showLangPicker, setShowLangPicker] = useState(false);
  const [file, setFile] = useState<File|null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [videoMeta, setVideoMeta] = useState<{ title: string; duration: number; uploader: string } | null>(null);
  const [stageError, setStageError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const utils = trpc.useUtils();

  const createVideo = trpc.videos.create.useMutation({
    onSuccess: async () => {
      await utils.videos.list.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const transcribeMutation = trpc.extract.transcribe.useMutation({
    onError: (err) => {
      setStage("error");
      setStageError(err.message);
      toast.error(err.message);
    },
  });

  const uploadTranscribeMutation = trpc.extract.uploadTranscribe.useMutation({
    onError: (err) => {
      setStage("error");
      setStageError(err.message);
      toast.error(err.message);
    },
  });

  const handleExtractUrl = async () => {
    if (!url.trim()) { toast.error("Please enter a video URL"); return; }

    setStage("fetching-info");
    setStageError("");
    setVideoMeta(null);
    setTranscript("");

    /*
     * Stage hints while the server works. Cleared as soon as we get a result.
     * With subtitles off there is no transcribe stage to hint at.
     */
    const timers = [
      setTimeout(() => setStage("downloading"), 800),
      setTimeout(() => setStage("extracting-audio"), 3000),
      ...(subtitlesOn ? [setTimeout(() => setStage("transcribing"), 6000)] : []),
    ];

    try {
      const result = await transcribeMutation.mutateAsync({
        url: url.trim(),
        // Only send a key when the user has one — the server skips Whisper without it.
        apiKey: apiKey || undefined,
        language,
        // Hard stop on paid speech-to-text when the user turned subtitles off.
        allowSpeechToText: subtitlesOn,
      });

      timers.forEach(clearTimeout);
      setStage("done");
      setTranscript(result.transcript);
      setTimedWords(result.words ?? []);
      // Real viewer rewatch data, when YouTube published it for this video.
      setHeatmap(result.heatmap ?? []);
      setChapters(result.chapters ?? []);
      setVideoMeta({ title: result.title, duration: result.duration, uploader: result.uploader });
      if (!title) setTitle(result.title);

      if (!subtitlesOn) {
        toast.success(`Video ready — ${result.title}. Subtitles are off, so nothing was transcribed.`);
      } else if (result.transcript) {
        const label = result.source === "youtube" ? "YouTube captions" : "Whisper";
        const synced = (result.words ?? []).length > 0;
        toast.success(
          `Transcript ready from ${label}! ${result.wordCount} words` +
          (synced ? " with speech timings." : " (timings estimated).")
        );
      } else {
        toast.info(result.note || "No captions found. You can paste a transcript manually below.");
      }
    } catch {
      timers.forEach(clearTimeout);
      // error handled by mutation onError
    }
  };

  const handleExtractFile = async () => {
    if (!file) { toast.error("Please select a file"); return; }

    /*
     * With subtitles off there is nothing to send to the transcriber, so the
     * upload needs no API key and no round trip at all.
     */
    if (!subtitlesOn) {
      setStage("done");
      setStageError("");
      setTranscript("");
      setTimedWords([]);
      if (!title) setTitle(file.name.replace(/\.[^.]+$/, ""));
      toast.success("Video ready. Subtitles are off, so nothing was transcribed.");
      return;
    }

    setStage("extracting-audio");
    setStageError("");
    setTranscript("");

    try {
      // Read file as base64
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          resolve(result.split(",")[1] ?? "");
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      setTimeout(() => setStage("transcribing"), 1000);

      const result = await uploadTranscribeMutation.mutateAsync({
        fileBase64: base64, fileName: file.name, apiKey, language
      });

      setStage("done");
      setTranscript(result.transcript);
      if (!title) setTitle(file.name.replace(/\.[^.]+$/, ""));
      toast.success(`Transcript ready! ${result.wordCount} words extracted.`);
    } catch {
      // error handled by mutation onError
    }
  };

  const handleProceed = async () => {
    if (!title.trim()) { toast.error("Please enter a title"); return; }

    const videoResult = await createVideo.mutateAsync({
      title: title.trim(),
      sourceType: mode,
      sourceUrl: mode === "url" ? url.trim() : file?.name,
      transcript: transcript.trim() || undefined,
      duration: videoMeta?.duration || undefined,
      transcriptWords: timedWords.length > 0 ? timedWords : undefined,
      transcriptionEnabled: subtitlesOn,
    });

    // No video import here — transcript extraction is subtitles-only (fast).
    // The actual video section will be imported later, after the user picks
    // which clips they want, so only the needed portion is downloaded.
    onNext({
      videoId: videoResult.id,
      title,
      url: mode === "url" ? url : (file?.name ?? ""),
      transcript,
      duration: videoMeta?.duration ?? 0,
      subtitlesOn,
      // Carried forward so highlight detection can anchor clips to the words
      // actually spoken instead of estimating times from the text.
      words: timedWords,
      // Measured engagement signals, when the platform exposed them.
      heatmap,
      chapters,
    });
  };

  const isExtracting = stage !== "idle" && stage !== "done" && stage !== "error";
  const progress = STAGE_PROGRESS[stage];

  return (
    <div className="max-w-2xl mx-auto animate-slide-up">
      <div className="mb-6">
        <h2 className="text-2xl font-black text-foreground mb-1" style={{ fontFamily: "Montserrat, sans-serif" }}>Add Your Video</h2>
        <p className="text-sm text-muted-foreground">Paste any video URL or upload a file — we'll grab the YouTube transcript if available, or use Whisper AI as a fallback.</p>
      </div>

      {!apiKey && <NoKeyWarning />}

      {/* Subtitles on/off — decided before anything is transcribed */}
      <button
        type="button"
        role="switch"
        aria-checked={subtitlesOn}
        onClick={() => { setSubtitlesOn(v => !v); setStage("idle"); setTranscript(""); setTimedWords([]); }}
        className="w-full glass rounded-2xl p-4 mb-5 flex items-center gap-3 text-left transition-colors hover:bg-secondary/30">
        <Captions className="w-5 h-5 shrink-0" style={{ color: subtitlesOn ? "var(--coral)" : "var(--muted-foreground)" }} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-foreground">Subtitles for this video</p>
          <p className="text-xs text-muted-foreground">
            {subtitlesOn
              ? "Transcribe the speech and burn captions into your clips."
              : "No transcription and no captions — faster, and uses no AI credits."}
          </p>
        </div>
        <div className={`relative w-11 h-6 rounded-full shrink-0 transition-colors ${subtitlesOn ? "" : "bg-secondary"}`}
          style={subtitlesOn ? { background: "var(--mint)" } : {}}>
          <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${subtitlesOn ? "left-[22px]" : "left-0.5"}`} />
        </div>
      </button>

      {/* Mode toggle */}
      <div className="flex gap-2 p-1 rounded-xl bg-secondary/40 mb-6 w-fit">
        {(["url","upload"] as const).map(m => (
          <button key={m} onClick={() => { setMode(m); setStage("idle"); setTranscript(""); setVideoMeta(null); }}
            className={`flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-semibold transition-all duration-200 ${mode === m ? "text-white" : "text-muted-foreground hover:text-foreground"}`}
            style={mode === m ? { background: "var(--cobalt)" } : {}}>
            {m === "url" ? <Link2 className="w-4 h-4" /> : <Upload className="w-4 h-4" />}
            {m === "url" ? "Video URL" : "Upload File"}
          </button>
        ))}
      </div>

      <div className="space-y-5">
        {/* URL input */}
        {mode === "url" && (
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Video URL</label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Youtube className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input type="url" value={url} onChange={e => { setUrl(e.target.value); setStage("idle"); setTranscript(""); setVideoMeta(null); }}
                  placeholder="https://youtube.com/watch?v=... or any video URL"
                  className="w-full pl-10 pr-4 py-3 rounded-xl bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-all text-sm" />
              </div>
              {/* Language picker */}
              <div className="relative">
                <button onClick={() => setShowLangPicker(v => !v)}
                  className="flex items-center gap-1.5 px-3 py-3 rounded-xl bg-secondary/60 hover:bg-secondary text-sm font-semibold text-foreground transition-colors whitespace-nowrap">
                  <Globe2 className="w-4 h-4" />
                  {LANGUAGES.find(l => l.code === language)?.label ?? language}
                  <ChevronDown className="w-3 h-3" />
                </button>
                {showLangPicker && (
                  <div className="absolute right-0 top-full mt-1 z-20 glass rounded-xl shadow-xl border border-border p-1 w-40 max-h-48 overflow-y-auto">
                    {LANGUAGES.map(l => (
                      <button key={l.code} onClick={() => { setLanguage(l.code); setShowLangPicker(false); }}
                        className={`w-full text-left px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${language === l.code ? "text-white" : "text-muted-foreground hover:text-foreground hover:bg-secondary/60"}`}
                        style={language === l.code ? { background: "var(--cobalt)" } : {}}>
                        {l.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">Supports YouTube, Vimeo, Twitter/X, TikTok, direct MP4 links, and 1000+ sites via yt-dlp.</p>
          </div>
        )}

        {/* File upload */}
        {mode === "upload" && (
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Video File</label>
            <div
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f?.type.startsWith("video/") || f?.type.startsWith("audio/")) { setFile(f); setStage("idle"); setTranscript(""); } else toast.error("Please drop a video or audio file"); }}
              onClick={() => fileRef.current?.click()}
              className={`relative flex flex-col items-center justify-center gap-3 p-8 rounded-2xl border-2 border-dashed cursor-pointer transition-all duration-200 ${dragOver ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 hover:bg-secondary/30"}`}>
              <input ref={fileRef} type="file" accept="video/*,audio/*" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) { setFile(f); setStage("idle"); setTranscript(""); } }} />
              {file ? (
                <>
                  <CheckCircle2 className="w-8 h-8" style={{ color: "var(--mint)" }} />
                  <p className="text-sm font-semibold text-foreground">{file.name}</p>
                  <p className="text-xs text-muted-foreground">{(file.size / (1024*1024)).toFixed(1)} MB</p>
                  <button type="button" onClick={e => { e.stopPropagation(); setFile(null); setStage("idle"); setTranscript(""); }}
                    className="absolute top-3 right-3 p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"><X className="w-4 h-4" /></button>
                </>
              ) : (
                <>
                  <FileVideo className="w-8 h-8" style={{ color: "var(--cobalt)" }} />
                  <p className="text-sm font-semibold text-foreground">Drop your video or audio here</p>
                  <p className="text-xs text-muted-foreground">MP4, MOV, AVI, WebM, MP3, WAV — any duration</p>
                </>
              )}
            </div>
          </div>
        )}

        {/* Extract button */}
        {stage === "idle" || stage === "error" ? (
          <button
            onClick={mode === "url" ? handleExtractUrl : handleExtractFile}
            disabled={(subtitlesOn && !apiKey) || (mode === "url" ? !url.trim() : !file)}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl font-bold text-sm text-white transition-all hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: "linear-gradient(135deg, var(--coral), oklch(0.65 0.20 300))" }}>
            {subtitlesOn ? <Mic className="w-4 h-4" /> : <FileVideo className="w-4 h-4" />}
            {subtitlesOn
              ? (mode === "url" ? "Extract & Transcribe Video" : "Upload & Transcribe")
              : (mode === "url" ? "Extract Video Info" : "Upload Video")}
          </button>
        ) : null}

        {/* Progress bar */}
        {isExtracting && (
          <div className="glass rounded-2xl p-5 space-y-3">
            <div className="flex items-center gap-3">
              <Loader2 className="w-4 h-4 animate-spin shrink-0" style={{ color: "var(--cobalt)" }} />
              <span className="text-sm font-semibold text-foreground">{STAGE_LABELS[stage]}</span>
            </div>
            <div className="h-2 rounded-full bg-secondary overflow-hidden">
              <div className="h-full rounded-full transition-all duration-700"
                style={{ width: `${progress}%`, background: "linear-gradient(90deg, var(--cobalt), var(--coral))" }} />
            </div>
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              {[
                { s: "downloading", label: "Download" },
                { s: "extracting-audio", label: "Audio" },
                { s: "transcribing", label: "Transcribe" },
              ].map(({ s, label }) => {
                const stageOrder = ["downloading","extracting-audio","transcribing","done"];
                const currentIdx = stageOrder.indexOf(stage);
                const thisIdx = stageOrder.indexOf(s);
                const done = currentIdx > thisIdx;
                const active = currentIdx === thisIdx;
                return (
                  <div key={s} className="flex items-center gap-1">
                    {done ? <CheckCircle2 className="w-3 h-3" style={{ color: "var(--mint)" }} />
                      : active ? <Loader2 className="w-3 h-3 animate-spin" style={{ color: "var(--cobalt)" }} />
                      : <div className="w-3 h-3 rounded-full border border-border" />}
                    <span className={done ? "" : active ? "text-foreground font-medium" : ""}>{label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Error state */}
        {stage === "error" && stageError && (
          <div className="glass rounded-2xl p-4 border border-destructive/30">
            <div className="flex items-center gap-2 mb-1">
              <AlertCircle className="w-4 h-4 text-destructive" />
              <span className="text-sm font-semibold text-destructive">Extraction failed</span>
            </div>
            <p className="text-xs text-muted-foreground">{stageError}</p>
          </div>
        )}

        {/* Video metadata card */}
        {videoMeta && stage === "done" && (
          <div className="glass rounded-2xl p-4 flex items-center gap-3 border border-green-500/20">
            <CheckCircle2 className="w-5 h-5 shrink-0" style={{ color: "var(--mint)" }} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-foreground truncate">{videoMeta.title}</p>
              <p className="text-xs text-muted-foreground">
                {videoMeta.uploader && <span>{videoMeta.uploader} · </span>}
                {videoMeta.duration > 0 && <span>{fmt(videoMeta.duration)} duration</span>}
              </p>
            </div>
          </div>
        )}

        {/* Transcript is extracted and stored silently — only show a
            compact status, not the full text, so the UI stays clean. */}
        {subtitlesOn && (stage === "done" || transcript) && transcript.trim() && (
          <div className="flex items-center gap-2 text-xs">
            <Captions className="w-4 h-4 shrink-0" style={{ color: "var(--coral)" }} />
            <span className="text-muted-foreground">
              {transcript.trim().split(/\s+/).length} words extracted
              {timedWords.length > 0 && " · speech-synced"}
            </span>
            <button onClick={() => setTranscript("")}
              className="text-muted-foreground hover:text-foreground transition-colors ml-auto">
              Clear
            </button>
          </div>
        )}

        {/* Manual transcript fallback — kept minimal */}
        {subtitlesOn && stage === "idle" && !transcript && (
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground flex items-center gap-2">
              <Captions className="w-3.5 h-3.5" />
              Or paste a transcript manually
            </label>
            <textarea
              value={transcript}
              onChange={e => setTranscript(e.target.value)}
              rows={3}
              placeholder="Paste transcript here if you already have one…"
              className="w-full px-4 py-3 rounded-xl bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-all text-sm resize-none leading-relaxed"
            />
          </div>
        )}

        {/* Title */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">Video Title</label>
          <input type="text" value={title} onChange={e => setTitle(e.target.value)}
            placeholder={videoMeta?.title ?? "e.g. Top 5 Moments from My Podcast"}
            className="w-full px-4 py-3 rounded-xl bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-all text-sm" />
        </div>

        {/* Proceed button */}
        <button
          onClick={handleProceed}
          disabled={!title.trim() || createVideo.isPending}
          className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl font-bold text-sm text-white transition-all hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed glow-blue"
          style={{ background: "linear-gradient(135deg, var(--cobalt), oklch(0.55 0.22 270))" }}>
          {createVideo.isPending
            ? <Loader2 className="w-4 h-4 animate-spin" />
            : <><ArrowRight className="w-4 h-4" /> Continue</>}
        </button>
      </div>
    </div>
  );
}

/**
 * Fallback for step 2 when there is no transcript to analyse.
 *
 * Shown when subtitles were turned off at import, or when the video had no
 * captions and no key to transcribe with. Lets the user type the clip range
 * directly so the workflow still reaches the editor.
 */
function ManualClipPicker({ videoTitle, videoDuration, subtitlesOn, onNext }: {
  videoTitle: string; videoDuration: number; subtitlesOn: boolean;
  onNext: (clips: Highlight[], reelTitle: string) => void;
}) {
  const [start, setStart] = useState("0:00");
  const [end, setEnd] = useState(() => fmt(Math.min(45, videoDuration || 45)));
  const [reelTitle, setReelTitle] = useState(videoTitle);

  // Accepts "m:ss", "h:mm:ss" or a plain number of seconds.
  const parseTime = (s: string): number | null => {
    const t = s.trim();
    if (!t) return null;
    if (!/^\d+(:\d{1,2}){0,2}$/.test(t)) return null;
    const secs = t.split(":").reduce((acc, p) => acc * 60 + Number(p), 0);
    return Number.isFinite(secs) ? secs : null;
  };

  const startSec = parseTime(start);
  const endSec = parseTime(end);
  const valid =
    startSec !== null && endSec !== null && endSec > startSec &&
    (videoDuration <= 0 || endSec <= Math.ceil(videoDuration));
  const length = valid ? endSec! - startSec! : 0;

  const proceed = () => {
    if (!valid) return;
    onNext(
      [{
        id: 1,
        title: reelTitle.trim() || videoTitle || "Clip 1",
        startTime: startSec!,
        endTime: endSec!,
        engagementScore: 0,
        reason: "Range chosen manually.",
      }],
      reelTitle.trim() || videoTitle,
    );
  };

  return (
    <div className="max-w-2xl mx-auto animate-slide-up">
      <div className="mb-6">
        <h2 className="text-2xl font-black text-foreground mb-1" style={{ fontFamily: "Montserrat, sans-serif" }}>Choose Your Clip</h2>
        <p className="text-sm text-muted-foreground">From: <span className="text-foreground font-medium">{videoTitle}</span></p>
      </div>

      <div className="glass rounded-2xl p-4 mb-5 flex items-start gap-3">
        <Captions className="w-5 h-5 shrink-0 mt-0.5" style={{ color: "var(--cobalt)" }} />
        <div className="text-xs text-muted-foreground leading-relaxed">
          {subtitlesOn ? (
            <>No transcript is available for this video, so AI highlight detection has nothing to read. Pick the section you want and carry on — you can transcribe just that clip on the next step.</>
          ) : (
            <>Subtitles are off for this video, so nothing was transcribed and AI highlight detection is skipped. Pick the section you want to turn into a clip. You can switch subtitles on later from the clip's Subtitles panel.</>
          )}
        </div>
      </div>

      <div className="glass rounded-2xl p-5 space-y-4 mb-5">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Start</label>
            <input type="text" value={start} onChange={e => setStart(e.target.value)} placeholder="0:00"
              className="w-full px-4 py-3 rounded-xl bg-input border border-border text-foreground font-mono focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-all text-sm" />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">End</label>
            <input type="text" value={end} onChange={e => setEnd(e.target.value)} placeholder="0:45"
              className="w-full px-4 py-3 rounded-xl bg-input border border-border text-foreground font-mono focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-all text-sm" />
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">Clip Title</label>
          <input type="text" value={reelTitle} onChange={e => setReelTitle(e.target.value)}
            placeholder={videoTitle || "My clip"}
            className="w-full px-4 py-3 rounded-xl bg-input border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-all text-sm" />
        </div>

        <div className="flex items-center gap-2 text-xs">
          {valid ? (
            <>
              <Clock className="w-3.5 h-3.5" style={{ color: "var(--mint)" }} />
              <span className="text-muted-foreground">
                {length}s clip
                {videoDuration > 0 && <> · source is {fmt(videoDuration)} long</>}
              </span>
            </>
          ) : (
            <>
              <AlertCircle className="w-3.5 h-3.5 text-destructive" />
              <span className="text-destructive">
                {videoDuration > 0
                  ? `Enter a valid range within 0:00–${fmt(videoDuration)} (end after start).`
                  : "Enter a valid range — end must be after start."}
              </span>
            </>
          )}
        </div>
      </div>

      <button onClick={proceed} disabled={!valid}
        className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl font-bold text-sm text-white transition-all hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed glow-blue"
        style={{ background: "linear-gradient(135deg, var(--cobalt), oklch(0.55 0.22 270))" }}>
        Use This Clip <ArrowRight className="w-4 h-4" />
      </button>
    </div>
  );
}

// ─── Step 2: Highlights ───────────────────────────────────────────────────────
function StepHighlights({
  videoTitle, transcript, apiKey, model, videoDuration, subtitlesOn,
  transcriptWords, heatmap, chapters,
  onNext
}: {
  videoTitle: string; transcript: string; apiKey: string; model: string;
  videoDuration: number; subtitlesOn: boolean;
  /** Word timings, so detected clips land on the words actually spoken. */
  transcriptWords: { word: string; start: number; end: number }[];
  /** YouTube's most-replayed curve, when available — real engagement data. */
  heatmap: { start: number; end: number; value: number }[];
  chapters: { start: number; end: number; title: string }[];
  onNext: (clips: Highlight[], reelTitle: string) => void
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [reelTitle, setReelTitle] = useState("");

  const detect = trpc.gemini.detectHighlights.useMutation({
    onSuccess: (data) => {
      setReelTitle(data.reelTitle);
      setSelected(new Set(data.highlights.map(h => h.id)));
      toast.success(
        data.heatPeaksUsed > 0
          ? `Found ${data.highlights.length} moments, guided by ${data.heatPeaksUsed} most-replayed peaks.`
          : `Found ${data.highlights.length} viral moments!`
      );
      /*
       * Without word timings the boundaries are the model's estimate from the
       * text, so they can drift from what the title describes. Say so rather
       * than letting a mismatched clip look like a bug.
       */
      if (!data.hasWordTimings) {
        toast.info("This transcript has no word timings, so clip times are approximate. Nudge the start/end in the editor if a clip looks off.");
      }
    },
    onError: (err) => toast.error(`AI error: ${err.message}`),
  });

  /** Everything the detector needs, including whichever signals this source had. */
  const detectInput = {
    transcript, model, apiKey, videoDuration,
    transcriptWords: transcriptWords.length > 0 ? transcriptWords : undefined,
    heatmap: heatmap.length > 0 ? heatmap : undefined,
    chapters: chapters.length > 0 ? chapters : undefined,
  };

  const toggle = (id: number) => setSelected(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
  const proceed = () => {
    if (!detect.data) return;
    onNext(detect.data.highlights.filter(h => selected.has(h.id)), reelTitle);
  };
  const highlights = detect.data?.highlights ?? [];

  /*
   * AI highlight detection reads the transcript, so with no transcript there is
   * nothing for it to work with. That happens when subtitles were turned off at
   * import, and also when a video simply has no captions. Either way the user
   * needs a way to pick a clip range by hand instead of being stuck here.
   */
  if (!transcript.trim()) {
    return (
      <ManualClipPicker
        videoTitle={videoTitle}
        videoDuration={videoDuration}
        subtitlesOn={subtitlesOn}
        onNext={onNext}
      />
    );
  }

  return (
    <div className="max-w-2xl mx-auto animate-slide-up">
      <div className="mb-6">
        <h2 className="text-2xl font-black text-foreground mb-1" style={{ fontFamily: "Montserrat, sans-serif" }}>Gemini AI Highlights</h2>
        <p className="text-sm text-muted-foreground">Analyzing: <span className="text-foreground font-medium">{videoTitle}</span></p>
      </div>
      {!apiKey && <NoKeyWarning />}
      {!detect.data && !detect.isPending && (
        <button onClick={() => detect.mutate(detectInput)}
          disabled={!apiKey}
          className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl font-bold text-sm text-white mb-6 transition-all hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ background: "linear-gradient(135deg, var(--coral), oklch(0.65 0.20 300))" }}>
          <Sparkles className="w-4 h-4" /> Detect Highlights with AI
        </button>
      )}
      {detect.isPending && (
        <div className="glass rounded-2xl p-8 mb-6 text-center">
          <div className="flex justify-center gap-1 mb-4">
            {[0,1,2,3,4].map(i => (
              <div key={i} className="w-1.5 rounded-full animate-pulse"
                style={{ height:`${20+i*8}px`, background:"var(--cobalt)", animationDelay:`${i*0.1}s` }} />
            ))}
          </div>
          <p className="text-sm font-semibold text-foreground mb-1">AI is analyzing your transcript…</p>
          <p className="text-xs text-muted-foreground">Detecting the best moments…</p>
        </div>
      )}
      {detect.isError && (
        <div className="glass rounded-2xl p-5 mb-5 border border-destructive/30">
          <div className="flex items-center gap-2 mb-2">
            <AlertCircle className="w-4 h-4 text-destructive" />
            <span className="text-sm font-semibold text-destructive">Analysis failed</span>
          </div>
          <p className="text-xs text-muted-foreground mb-3">{detect.error?.message}</p>
          <button onClick={() => detect.mutate(detectInput)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold text-white transition-all hover:opacity-80"
            style={{ background: "var(--cobalt)" }}>
            <RefreshCw className="w-3.5 h-3.5" /> Retry
          </button>
        </div>
      )}
      {highlights.length > 0 && (
        <>
          {reelTitle && (
            <div className="glass rounded-xl p-3 mb-4 flex items-center gap-3">
              <Wand2 className="w-4 h-4 shrink-0" style={{ color: "var(--mint)" }} />
              <div className="flex-1 min-w-0">
                <p className="text-xs text-muted-foreground">Gemini suggested reel title:</p>
                <p className="text-sm font-bold text-foreground truncate">{reelTitle}</p>
              </div>
            </div>
          )}
          <div className="space-y-3 mb-6">
            {highlights.map(h => {
              const sel = selected.has(h.id);
              const color = h.engagementScore >= 90 ? "var(--mint)" : h.engagementScore >= 80 ? "var(--cobalt)" : "var(--amber)";
              return (
                <div key={h.id} onClick={() => toggle(h.id)}
                  className={`glass rounded-2xl p-4 cursor-pointer transition-all duration-200 border-2 ${sel ? "border-primary" : "border-transparent hover:border-border"}`}
                  style={sel ? { boxShadow: "0 0 0 1px oklch(0.62 0.22 255 / 0.3)" } : {}}>
                  <div className="flex items-start gap-3">
                    <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0 mt-0.5 transition-all ${sel ? "border-primary" : "border-border"}`}
                      style={sel ? { background: "var(--cobalt)" } : {}}>
                      {sel && <CheckCircle2 className="w-3.5 h-3.5 text-white" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className="text-sm font-bold text-foreground" style={{ fontFamily: "Montserrat, sans-serif" }}>{h.title}</span>
                        <span className="text-xs font-black px-2 py-0.5 rounded-full shrink-0" style={{ color, background: `${color}22` }}>{h.engagementScore}</span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground mb-2">
                        <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{fmt(h.startTime)}–{fmt(h.endTime)}</span>
                        <span>{h.endTime - h.startTime}s</span>
                      </div>
                      <p className="text-xs text-muted-foreground italic">{h.reason}</p>
                      <div className="mt-2 h-1 rounded-full bg-secondary overflow-hidden">
                        <div className="h-full rounded-full" style={{ width:`${h.engagementScore}%`, background: color }} />
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex gap-3">
            <button onClick={() => detect.mutate(detectInput)}
              className="flex items-center gap-2 px-4 py-3 rounded-xl text-sm font-semibold text-muted-foreground bg-secondary/60 hover:text-foreground transition-colors">
              <RefreshCw className="w-4 h-4" /> Re-analyze
            </button>
            <button onClick={proceed} disabled={selected.size === 0}
              className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl font-bold text-sm text-white transition-all hover:opacity-90 disabled:opacity-40 glow-blue"
              style={{ background: "linear-gradient(135deg, var(--cobalt), oklch(0.55 0.22 270))" }}>
              Use {selected.size} Clip{selected.size !== 1 ? "s" : ""} — Style Subtitles <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Step 3: Subtitles ────────────────────────────────────────────────────────
function StepSubtitles({
  clips, videoId, transcript, captionsOn, onCaptionsChange, onNext,
}: {
  clips: Highlight[];
  videoId: number | null;
  transcript: string;
  /** Whether captions get burned into the exports. */
  captionsOn: boolean;
  onCaptionsChange: (on: boolean) => void;
  onNext: (style: SubStyle) => void;
}) {
  const [font, setFont] = useState(DEFAULT_SUBTITLE_STYLE.font);
  // Pixels on the 1080-wide export canvas, so the preview and the burned-in
  // captions are the same size.
  const [fontSize, setFontSize] = useState(DEFAULT_SUBTITLE_STYLE.fontSize);
  const [color, setColor] = useState(DEFAULT_SUBTITLE_STYLE.color);
  const [hlColor, setHlColor] = useState(DEFAULT_SUBTITLE_STYLE.highlightColor);
  const [position, setPosition] = useState<"top"|"center"|"bottom">(DEFAULT_SUBTITLE_STYLE.position);
  const [outline, setOutline] = useState(DEFAULT_SUBTITLE_STYLE.outline);
  const [activeWord, setActiveWord] = useState(0);
  // Which selected clip the preview is showing.
  const [previewIdx, setPreviewIdx] = useState(0);
  /**
   * Caption position as a percentage of the frame. Null means the preset above
   * is in use; dragging the caption on screen switches to a free position.
   *
   * This is the style shared by every clip. The Edit step can override it per
   * clip, which is why reframing stays there — but placing the caption is part
   * of the look, so it belongs here too.
   */
  const [freePos, setFreePos] = useState<{ posX: number; posY: number } | null>(null);
  const style: SubStyle = {
    font, fontSize, color, highlightColor: hlColor, position, outline,
    ...(freePos ?? {}),
  };

  const clip = clips[previewIdx] ?? clips[0];
  const utils = trpc.useUtils();

  /*
   * Poll this specific video while the import runs, so the preview lights up on
   * its own. Fetching the row directly avoids depending on it being present in
   * a cached list.
   */
  const { data: video, error: videoError } = trpc.videos.get.useQuery(
    { id: videoId ?? 0 },
    { enabled: videoId != null, refetchInterval: 3000, retry: false }
  );
  const hostedUrl = video?.hostedUrl ?? null;
  const hostedStatus = (video?.hostedStatus ?? "none") as "none" | "downloading" | "ready" | "error";
  /**
   * A partial import starts partway into the source, so the hosted file's t=0
   * is `hostedOffset` seconds into the original. Clip times are absolute and
   * must be rebased before being handed to a player.
   */
  const hostedOffset = video?.hostedOffset ?? 0;

  const host = trpc.videos.host.useMutation({
    onSuccess: async () => {
      await utils.videos.get.invalidate();
      await utils.videos.list.invalidate();
    },
    onError: err => toast.error(`Import failed: ${err.message}`),
  });

  /** Span covering every selected clip — the only part worth downloading. */
  const clipSpan = useMemo(() => {
    if (clips.length === 0) return null;
    const validClips = clips.filter(c => c.startTime != null && c.endTime != null);
    if (validClips.length === 0) return null;
    return {
      startTime: Math.min(...validClips.map(c => c.startTime)),
      endTime: Math.max(...validClips.map(c => c.endTime)),
    };
  }, [clips]);

  // Start the import as soon as this step opens, so the preview fills in on its
  // own. Guarded so it fires once per video rather than on every poll.
  const importStarted = useRef<number | null>(null);
  useEffect(() => {
    if (videoId == null || !clipSpan) return;
    if (importStarted.current === videoId) return;
    // Wait for the row to load before deciding whether an import is needed.
    if (!video) return;

    // Already done or in flight: nothing to start.
    if (hostedStatus === "ready" || hostedStatus === "downloading") {
      importStarted.current = videoId;
      return;
    }

    importStarted.current = videoId;
    host.mutate({ id: videoId, ...clipSpan });
    // `host` is stable for the component's lifetime; excluded deliberately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, clipSpan, video, hostedStatus]);

  const previewWords = useMemo(
    () => previewWordsFor(transcript, clip?.startTime, SAMPLE_WORDS.map(w => w.word)),
    [transcript, clip?.startTime]
  );

  // Keep the highlighted word inside the current slice.
  useEffect(() => {
    if (activeWord >= previewWords.length) setActiveWord(0);
  }, [previewWords.length, activeWord]);
  return (
    <div className="animate-slide-up">
      <div className="mb-6">
        <h2 className="text-2xl font-black text-foreground mb-1" style={{ fontFamily: "Montserrat, sans-serif" }}>Style Your Subtitles</h2>
        <p className="text-sm text-muted-foreground">Customize captions for {clips.length} selected clip{clips.length !== 1 ? "s" : ""}.</p>
      </div>
      <div className="grid lg:grid-cols-2 gap-6">
        <div className="space-y-4">
          <div className="glass rounded-2xl p-5 space-y-4">
            <div className="flex items-center gap-2"><Type className="w-4 h-4" style={{ color: "var(--cobalt)" }} /><span className="text-sm font-semibold">Typography</span></div>
            <div>
              <label className="text-xs text-muted-foreground mb-2 block">Font Family</label>
              <div className="flex flex-wrap gap-2">{FONTS.map(f => <button key={f} onClick={() => setFont(f)} className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${font === f ? "text-white" : "text-muted-foreground hover:text-foreground bg-secondary/60"}`} style={font === f ? { background: "var(--cobalt)" } : {}}>{f}</button>)}</div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-2 block">Font Size: <span className="text-foreground font-semibold">{fontSize}px</span></label>
              <input type="range" min={MIN_FONT_SIZE} max={MAX_FONT_SIZE} step={2} value={fontSize}
                onChange={e => setFontSize(Number(e.target.value))} className="w-full accent-primary" />
            </div>
          </div>
          <div className="glass rounded-2xl p-5 space-y-4">
            <div className="flex items-center gap-2"><Palette className="w-4 h-4" style={{ color: "var(--coral)" }} /><span className="text-sm font-semibold">Colors</span></div>
            <div><label className="text-xs text-muted-foreground mb-2 block">Text Color</label><div className="flex gap-2">{TEXT_COLORS.map(c => <button key={c} onClick={() => setColor(c)} className={`w-7 h-7 rounded-full border-2 transition-all ${color === c ? "scale-110 border-white" : "border-transparent hover:scale-105"}`} style={{ background: c }} />)}</div></div>
            <div><label className="text-xs text-muted-foreground mb-2 block">Highlight Color</label><div className="flex gap-2">{HL_COLORS.map(c => <button key={c} onClick={() => setHlColor(c)} className={`w-7 h-7 rounded-full border-2 transition-all ${hlColor === c ? "scale-110 border-white" : "border-transparent hover:scale-105"}`} style={{ background: c }} />)}</div></div>
          </div>
          <div className="glass rounded-2xl p-5 space-y-4">
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-muted-foreground">Position</label>
                {freePos && (
                  <span className="text-[10px] font-bold tabular-nums" style={{ color: "var(--cobalt)" }}>
                    free · {Math.round(freePos.posX)}%, {Math.round(freePos.posY)}%
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                {(["top","center","bottom"] as const).map(p => (
                  <button key={p}
                    onClick={() => { setPosition(p); setFreePos(null); }}
                    className={`flex-1 py-2 rounded-lg text-xs font-semibold capitalize transition-all ${position === p && !freePos ? "text-white" : "text-muted-foreground bg-secondary/60 hover:text-foreground"}`}
                    style={position === p && !freePos ? { background: "var(--cobalt)" } : {}}>
                    {p}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground mt-1.5">
                {freePos
                  ? "Dragged to a custom spot — pick a preset above to reset."
                  : "Drag the caption in the preview to place it anywhere."}
              </p>
            </div>
            <div className="flex items-center justify-between"><label className="text-xs text-muted-foreground">Text Outline</label><button onClick={() => setOutline(v => !v)} className="w-10 h-5 rounded-full transition-all relative" style={{ background: outline ? "var(--cobalt)" : "var(--secondary)" }}><div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${outline ? "left-5" : "left-0.5"}`} /></button></div>
          </div>

          {/* Master switch: export with captions burned in, or clean. */}
          <div className="glass rounded-2xl p-5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Captions className="w-4 h-4" style={{ color: captionsOn ? "var(--cobalt)" : "var(--muted-foreground)" }} />
                <div>
                  <p className="text-sm font-semibold text-foreground leading-tight">Burn in subtitles</p>
                  <p className="text-[11px] text-muted-foreground">
                    {captionsOn ? "Captions baked into every clip" : "Clean clips, no text"}
                  </p>
                </div>
              </div>
              <button
                role="switch"
                aria-checked={captionsOn}
                aria-label="Burn subtitles into exported clips"
                onClick={() => onCaptionsChange(!captionsOn)}
                className="w-11 h-6 rounded-full transition-colors relative shrink-0"
                style={{ background: captionsOn ? "var(--cobalt)" : "var(--secondary)" }}
              >
                <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all"
                  style={{ left: captionsOn ? "1.375rem" : "0.125rem" }} />
              </button>
            </div>
          </div>
        </div>
        <div className="glass rounded-2xl overflow-hidden self-start">
          <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-2">
            <span className="text-sm font-semibold">Live Preview</span>
            <span className="text-[10px] text-muted-foreground">Styling only</span>
          </div>
          <div className="p-4 flex flex-col items-center gap-3">
            {/* Clip switcher, when more than one is selected. */}
            {clips.length > 1 && (
              <div className="flex flex-wrap justify-center gap-1.5">
                {clips.map((c, i) => (
                  <button key={c.id} onClick={() => setPreviewIdx(i)}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all ${i === previewIdx ? "text-white" : "text-muted-foreground bg-secondary/60 hover:text-foreground"}`}
                    style={i === previewIdx ? { background: "var(--cobalt)" } : {}}>
                    #{i + 1}
                  </button>
                ))}
              </div>
            )}

            {hostedStatus === "ready" && hostedUrl ? (
              /*
               * No `onChange`, so the frame cannot be panned here — reframing is
               * a per-clip decision made in Edit. The caption IS draggable,
               * because where it sits is part of the look being styled.
               */
              <CropView
                src={hostedUrl}
                framing={DEFAULT_FRAMING}
                startTime={(clip?.startTime ?? 0) - hostedOffset}
                endTime={(clip?.endTime ?? 0) - hostedOffset}
                className="w-full shadow-2xl"
                style={{ maxWidth: "300px" }}
              >
                {captionsOn && (
                  <SubtitleOverlay
                    words={previewWords}
                    activeIndex={activeWord}
                    style={style}
                    onWordClick={setActiveWord}
                    onPositionChange={setFreePos}
                  />
                )}
              </CropView>
            ) : (
              <div className="w-full" style={{ maxWidth: "300px" }}>
                <ClipPreview
                  url={video?.sourceUrl ?? null}
                  hostingStatus={hostedStatus}
                  hostingProgress={video?.hostProgress ?? 0}
                  onHost={videoId != null && clipSpan
                    ? () => host.mutate({ id: videoId, ...clipSpan })
                    : undefined}
                  className="rounded-2xl w-full"
                  style={{ aspectRatio: "9/16" }}
                />
              </div>
            )}

            {hostedStatus === "error" && video?.hostError && (
              <p className="text-[11px] text-center leading-relaxed" style={{ color: "oklch(0.72 0.19 45)" }}>
                {video.hostError}
              </p>
            )}

            <p className="text-xs text-muted-foreground text-center">
              {clip ? <>Clip #{previewIdx + 1} · {fmt(clip.startTime)}–{fmt(clip.endTime)}<br /></> : null}
              {previewWords.length > 0
                ? "Click words to preview the highlight"
                : "Extract a transcript in step 1 to preview captions"}
            </p>

            {/* Make the import state explicit rather than leaving a bare
                placeholder that gives no clue what is happening. */}
            {videoError ? (
              <p className="text-[11px] text-center leading-relaxed" style={{ color: "oklch(0.72 0.19 45)" }}>
                Could not load the video: {videoError.message}
              </p>
            ) : (
              <p className="text-[10px] text-muted-foreground/60 text-center">
                {videoId == null
                  ? "No video linked — go back to step 1"
                  : `video #${videoId} · ${hostedStatus}${hostedStatus === "downloading" ? ` ${video?.hostProgress ?? 0}%` : ""}`}
              </p>
            )}
          </div>
        </div>
      </div>
      <button onClick={() => onNext(style)} className="mt-6 w-full flex items-center justify-center gap-2 py-3.5 rounded-xl font-bold text-sm transition-all hover:opacity-90 glow-green" style={{ background: "linear-gradient(135deg, var(--mint), oklch(0.65 0.20 165))", color: "black" }}>
        <Save className="w-4 h-4" /> Save Style & Edit Clips <ArrowRight className="w-4 h-4" />
      </button>
    </div>
  );
}

// ─── Step 4: Edit ─────────────────────────────────────────────────────────────

/** Everything the editor tracks for one clip. */
type ClipEdit = {
  /** Row id, needed before framing or subtitles can be saved. */
  clipId: number;
  framing: Framing;
  segments: FramingSegment[];
  words: TimelineWord[];
  /** Caption position as a percentage of the frame, or null for the preset. */
  capPos: { posX: number; posY: number } | null;
};

/**
 * Timeline editing for every selected clip, on one page.
 *
 * Clip rows are created here rather than at export, because framing sections and
 * subtitle timings are per-clip data and cannot be saved without a row to attach
 * them to. Export then just renders what this step has already saved.
 */
function StepEdit({
  clips, videoId, style, captionsOn, onNext,
}: {
  clips: Highlight[];
  videoId: number | null;
  style: SubStyle;
  captionsOn: boolean;
  onNext: (clipIds: Record<number, number>) => void;
}) {
  const utils = trpc.useUtils();
  const [active, setActive] = useState(0);
  const [edits, setEdits] = useState<Record<number, ClipEdit>>({});
  const [selectedSegment, setSelectedSegment] = useState<number | null>(null);
  const [editingKeyframe, setEditingKeyframe] = useState<Keyframe>("from");
  const [playhead, setPlayhead] = useState(0);
  const [previewTime, setPreviewTime] = useState<number | null>(null);
  /*
   * One transport for both players. `seek` is a nonce-carrying request so that
   * reporting playback position back up cannot trigger another seek, and
   * `playing` lets the full-frame view mirror the main preview.
   */
  const [seek, setSeek] = useState<{ time: number; nonce: number } | null>(null);
  const [playing, setPlaying] = useState(false);
  const seekNonce = useRef(0);
  const [saving, setSaving] = useState(false);
  const [rendering, setRendering] = useState<Set<number>>(new Set());
  const [rendered, setRendered] = useState<Set<number>>(new Set());

  const clip = clips[active];

  const { data: video } = trpc.videos.get.useQuery(
    { id: videoId ?? 0 },
    { enabled: videoId != null, refetchInterval: 3000, retry: false }
  );
  const hostedUrl = video?.hostedUrl ?? null;
  const hostedStatus = (video?.hostedStatus ?? "none") as "none" | "downloading" | "ready" | "error";
  const hostedOffset = video?.hostedOffset ?? 0;

  /*
   * Rows already on this video. Re-entering the step must reuse them rather than
   * creating a second row per clip, which is what would happen if the user went
   * back to Subtitles and forward again.
   */
  const { data: existingClips } = trpc.clips.listByVideo.useQuery(
    { videoId: videoId ?? 0 },
    { enabled: videoId != null, retry: false }
  );

  const createClip = trpc.clips.create.useMutation();
  const updateClip = trpc.clips.update.useMutation();
  const saveSubtitles = trpc.subtitles.save.useMutation();
  const startRender = trpc.clips.render.useMutation();
  const transcribeClip = trpc.clips.transcribe.useMutation();
  const host = trpc.videos.host.useMutation({
    onSuccess: async () => { await utils.videos.get.invalidate(); },
    onError: err => toast.error(`Import failed: ${err.message}`),
  });

  const clipSpan = useMemo(() => {
    if (clips.length === 0) return null;
    const validClips = clips.filter(c => c.startTime != null && c.endTime != null);
    if (validClips.length === 0) return null;
    return {
      startTime: Math.min(...validClips.map(c => c.startTime)),
      endTime: Math.max(...validClips.map(c => c.endTime)),
    };
  }, [clips]);

  /**
   * Words for a clip, in clip-relative seconds.
   *
   * Real timings from the source caption track when the video has them,
   * otherwise the track starts empty — inventing timings would put captions out
   * of sync with the speech, which is worse than showing none.
   */
  const seedWords = (h: Highlight): TimelineWord[] => {
    const timed = video?.transcriptWords as Array<{ word: string; start: number; end: number }> | null | undefined;
    if (!Array.isArray(timed)) return [];
    return timed
      .filter(w => w.end > h.startTime && w.start < h.endTime)
      .map(w => ({
        word: w.word,
        start: Math.max(0, w.start - h.startTime),
        end: Math.min(h.endTime - h.startTime, w.end - h.startTime),
      }))
      .filter(w => w.end > w.start);
  };

  /*
   * Create a row per selected clip, once. The ref guard matters: this effect can
   * run twice in development and duplicate rows would be created otherwise.
   */
  const creating = useRef(false);
  useEffect(() => {
    if (videoId == null || clips.length === 0 || creating.current) return;
    // Wait for the existing rows, so a reusable one is never missed.
    if (!existingClips) return;
    if (clips.every(h => edits[h.id])) return;
    creating.current = true;

    (async () => {
      const next: Record<number, ClipEdit> = {};
      for (const h of clips) {
        if (edits[h.id]) { next[h.id] = edits[h.id]; continue; }

        // Same range on the same video is the same clip.
        const found = existingClips.find(c =>
          Math.abs((c.startTime ?? -1) - h.startTime) < 0.5 &&
          Math.abs((c.endTime ?? -1) - h.endTime) < 0.5
        );

        if (found) {
          next[h.id] = {
            clipId: found.id,
            framing: {
              zoom: found.zoom ?? DEFAULT_FRAMING.zoom,
              offsetX: found.offsetX ?? DEFAULT_FRAMING.offsetX,
              offsetY: found.offsetY ?? DEFAULT_FRAMING.offsetY,
            },
            segments: (found.framingSegments as FramingSegment[] | null) ?? [],
            words: seedWords(h),
            capPos: null,
          };
          continue;
        }

        try {
          const { id } = await createClip.mutateAsync({
            videoId,
            title: h.title,
            startTime: h.startTime,
            endTime: h.endTime,
            engagementScore: h.engagementScore,
          });
          next[h.id] = {
            clipId: id,
            framing: DEFAULT_FRAMING,
            segments: [],
            words: seedWords(h),
            capPos: null,
          };
        } catch (err) {
          toast.error(err instanceof Error ? err.message : `Could not prepare "${h.title}"`);
        }
      }
      setEdits(prev => ({ ...next, ...prev }));
      await utils.clips.list.invalidate();
      await utils.clips.listByVideo.invalidate();
      creating.current = false;
    })();
    // Deliberately keyed on the clip set, the video, and the existing rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, clips, existingClips]);

  // Seed subtitle tracks once the video's timings arrive after the rows exist.
  useEffect(() => {
    if (!video?.transcriptWords) return;
    setEdits(prev => {
      let changed = false;
      const next = { ...prev };
      for (const h of clips) {
        const e = next[h.id];
        if (!e || e.words.length > 0) continue;
        const seeded = seedWords(h);
        if (seeded.length > 0) { next[h.id] = { ...e, words: seeded }; changed = true; }
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video?.transcriptWords, clips]);

  /*
   * Auto-transcribe each clip when the video is hosted.
   * This gives accurate Inworld STT words instead of YouTube's coarse captions.
   * Runs once per clip, costs ~$0.001 per clip (30-60s audio).
   */
  const transcribing = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (hostedStatus !== "ready") return;
    const apiKey = "server";
    for (const h of clips) {
      const e = edits[h.id];
      if (!e || transcribing.current.has(e.clipId)) continue;
      transcribing.current.add(e.clipId);
      transcribeClip.mutateAsync({ id: e.clipId, apiKey, language: "en", force: true })
        .then((result: any) => {
          if (result?.words?.length > 0) {
            const clipWords = result.words.map((w: any) => ({
              word: w.word,
              start: Math.max(0, w.start - h.startTime),
              end: Math.max(0, w.end - h.startTime),
            })).filter((w: any) => w.end > w.start);
            if (clipWords.length > 0) {
              setEdits(prev => {
                const existing = prev[h.id];
                if (!existing) return prev;
                return { ...prev, [h.id]: { ...existing, words: clipWords } };
              });
            }
          }
        })
        .catch(() => { /* fallback to YouTube captions already seeded */ });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostedStatus, clips, edits]);

  // Start the import if it has not begun, so the preview can fill in.
  const importStarted = useRef<number | null>(null);
  useEffect(() => {
    if (videoId == null || !clipSpan || !video) return;
    if (importStarted.current === videoId) return;
    importStarted.current = videoId;
    if (hostedStatus === "ready" || hostedStatus === "downloading") return;
    host.mutate({ id: videoId, ...clipSpan });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, clipSpan, video, hostedStatus]);

  const current = clip ? edits[clip.id] : undefined;
  const duration = clip ? Math.max(1, (clip.endTime ?? 0) - (clip.startTime ?? 0)) : 1;

  const patch = (next: Partial<ClipEdit>) => {
    if (!clip || !current) return;
    setEdits(prev => ({ ...prev, [clip.id]: { ...prev[clip.id], ...next } }));
  };

  /** Writes one clip's edits to the server. */
  const persist = async (h: Highlight, e: ClipEdit) => {
    await updateClip.mutateAsync({
      id: e.clipId,
      ...e.framing,
      framingSegments: e.segments,
      captionsEnabled: captionsOn,
    });
    if (captionsOn) {
      await saveSubtitles.mutateAsync({
        clipId: e.clipId,
        style: { ...style, ...(e.capPos ?? {}) },
        // Absolute source times, which is what the renderer expects.
        words: e.words.length > 0
          ? e.words.map(w => ({
            word: w.word,
            start: w.start + h.startTime,
            end: w.end + h.startTime,
          }))
          : undefined,
      });
    }
  };

  const saveAll = async () => {
    setSaving(true);
    try {
      for (const h of clips) {
        const e = edits[h.id];
        if (e) await persist(h, e);
      }
      toast.success("Edits saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the edits");
    } finally {
      setSaving(false);
    }
  };

  /** Saves then renders one clip. */
  const renderOne = async (h: Highlight) => {
    const e = edits[h.id];
    if (!e) return;
    setRendering(prev => new Set(Array.from(prev).concat(h.id)));
    try {
      await persist(h, e);
      await startRender.mutateAsync({ id: e.clipId, ...e.framing, captionsEnabled: captionsOn });
      setRendered(prev => new Set(Array.from(prev).concat(h.id)));
      toast.success(`"${h.title}" is rendering.`);
    } catch (err) {
      toast.error(`${h.title}: ${err instanceof Error ? err.message : "render failed"}`);
    } finally {
      setRendering(prev => { const s = new Set(prev); s.delete(h.id); return s; });
    }
  };

  /** Renders every clip, reporting each failure separately. */
  const renderAll = async () => {
    for (const h of clips) {
      if (rendered.has(h.id) || rendering.has(h.id)) continue;
      await renderOne(h);
    }
    await utils.clips.list.invalidate();
  };

  // ── Framing, honouring the animation while the preview plays ───────────────

  const activeFraming: Framing = useMemo(() => {
    if (!current) return DEFAULT_FRAMING;
    const list = materialiseSegments(current.segments, duration, current.framing);

    if (previewTime != null && clip) {
      const inClip = previewTime + hostedOffset - clip.startTime;
      const idx = segmentAt(list, inClip);
      if (idx != null) return framingAt(list[idx], inClip);
    }
    if (selectedSegment != null && list[selectedSegment]) {
      const seg = list[selectedSegment];
      return isAnimated(seg) && editingKeyframe === "to"
        ? segmentTarget(seg)
        : framingAt(seg, seg.start);
    }
    return current.framing;
  }, [current, duration, previewTime, clip, hostedOffset, selectedSegment, editingKeyframe]);

  const applyFraming = (next: Framing) => {
    if (!current) return;
    const list = materialiseSegments(current.segments, duration, current.framing);
    if (selectedSegment != null && list[selectedSegment]) {
      const moving = isAnimated(list[selectedSegment]);
      patch({ segments: setSegmentKeyframe(list, selectedSegment, moving ? editingKeyframe : "from", next) });
    } else {
      patch({ framing: next });
    }
  };

  /** Plays just the selected section, so its movement can be watched alone. */
  const previewSpan = useMemo(() => {
    if (!clip) return { start: 0, end: 1 };
    if (current && selectedSegment != null) {
      const list = materialiseSegments(current.segments, duration, current.framing);
      const seg = list[selectedSegment];
      if (seg) return { start: clip.startTime + seg.start, end: clip.startTime + seg.end };
    }
    return { start: clip.startTime ?? 0, end: clip.endTime ?? 1 };
  }, [clip, current, selectedSegment, duration]);

  const previewStyle: SubStyle = { ...style, ...(current?.capPos ?? {}) };

  /**
   * Only the caption that belongs at the playhead.
   *
   * The overlay draws every word it is given, so handing it the whole clip
   * stacked the entire transcript on the frame. The renderer shows one word at a
   * time, so the preview does the same.
   */
  const visibleCaption = useMemo(() => {
    if (!current || current.words.length === 0) return null;
    const at = current.words.findIndex(w => playhead >= w.start && playhead < w.end);
    if (at === -1) return null;
    return { words: [current.words[at].word], activeIndex: 0 };
  }, [current, playhead]);

  /** Moves the playhead and takes both players with it. */
  const scrubTo = (t: number) => {
    setPlayhead(t);
    setPreviewTime(null);
    if (!clip) return;
    seekNonce.current += 1;
    setSeek({ time: Math.max(0, clip.startTime + t - hostedOffset), nonce: seekNonce.current });
  };

  if (clips.length === 0) {
    return (
      <div className="max-w-2xl mx-auto animate-slide-up glass rounded-2xl p-8 text-center">
        <AlertCircle className="w-8 h-8 mx-auto mb-3 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No clips selected — go back and pick a moment first.</p>
      </div>
    );
  }

  return (
    <div className="animate-slide-up">
      <div className="mb-4 flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-2xl font-black text-foreground mb-1" style={{ fontFamily: "Montserrat, sans-serif" }}>
            Edit
          </h2>
          <p className="text-sm text-muted-foreground">
            Move the frame, add zooms and fix subtitle timings for each clip.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={saveAll}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold transition-colors disabled:opacity-50"
            style={{ background: "oklch(1 0 0 / 0.07)", color: "var(--foreground)" }}
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
          </button>
          <button
            onClick={renderAll}
            disabled={rendering.size > 0}
            className="flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-bold text-white transition-all hover:opacity-90 disabled:opacity-50"
            style={{ background: "linear-gradient(135deg, var(--coral), oklch(0.65 0.20 300))" }}
          >
            {rendering.size > 0
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Rendering {rendering.size}…</>
              : <><Zap className="w-4 h-4" /> Render all {clips.length}</>}
          </button>
        </div>
      </div>

      {/* ── Clip tabs ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1.5 mb-4 overflow-x-auto pb-1">
        {clips.map((h, i) => {
          const e = edits[h.id];
          const isActive = i === active;
          return (
            <button
              key={h.id}
              onClick={() => {
                setActive(i);
                setSelectedSegment(null);
                setPlayhead(0);
                setPreviewTime(null);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors shrink-0"
              style={isActive
                ? { background: "var(--cobalt)", color: "white" }
                : { background: "oklch(1 0 0 / 0.06)", color: "var(--muted-foreground)" }}
              title={`${h.title} · ${fmt(h.startTime)}–${fmt(h.endTime)}`}
            >
              #{i + 1}
              {rendered.has(h.id) && <CheckCircle2 className="w-3 h-3" style={{ color: isActive ? "white" : "var(--mint)" }} />}
              {rendering.has(h.id) && <Loader2 className="w-3 h-3 animate-spin" />}
              {!e && <span className="text-[9px] opacity-70">…</span>}
            </button>
          );
        })}
        <span className="text-[11px] text-muted-foreground ml-2 shrink-0">
          {clip ? `${fmt(clip.startTime)}–${fmt(clip.endTime)} · ${Math.round(duration)}s` : ""}
        </span>
      </div>

      <div className="grid lg:grid-cols-[300px_1fr] gap-5 items-start">
        {/* ── Preview ───────────────────────────────────────────────────── */}
        <div className="space-y-3">
          {hostedStatus === "ready" && hostedUrl && clip ? (
            <>
              <CropView
                src={hostedUrl}
                framing={activeFraming}
                onChange={applyFraming}
                startTime={previewSpan.start - hostedOffset}
                endTime={previewSpan.end - hostedOffset}
                className="w-full shadow-2xl"
                onTime={t => {
                  setPreviewTime(t);
                  setPlayhead(Math.max(0, t + hostedOffset - clip.startTime));
                }}
                seekTo={seek}
                onPlayingChange={setPlaying}
              >
                {captionsOn && visibleCaption && (
                  <SubtitleOverlay
                    words={visibleCaption.words}
                    activeIndex={visibleCaption.activeIndex}
                    style={previewStyle}
                    onPositionChange={p => patch({ capPos: p })}
                  />
                )}
              </CropView>

              <div>
                <p className="text-[11px] font-semibold text-muted-foreground mb-1.5 flex items-center gap-1.5">
                  <Move className="w-3 h-3" />
                  {selectedSegment != null
                    ? `Full frame — where section ${selectedSegment + 1} ${editingKeyframe === "to" ? "ends" : "starts"}`
                    : "Full frame — drag the box to reframe"}
                </p>
                <VideoFramer
                  src={hostedUrl}
                  framing={activeFraming}
                  onChange={applyFraming}
                  startTime={previewSpan.start - hostedOffset}
                  endTime={previewSpan.end - hostedOffset}
                  // Follows the main preview so both show the same frame.
                  followTime={clip.startTime + playhead - hostedOffset}
                  followPlaying={playing}
                />
              </div>

              <p className="text-[10px] text-muted-foreground/70 leading-relaxed">
                Drag inside either player to move the frame. Drag the caption to place it
                anywhere. Both apply to this clip only.
              </p>
            </>
          ) : (
            <ClipPreview
              url={video?.sourceUrl ?? null}
              hostingStatus={hostedStatus}
              hostingProgress={video?.hostProgress ?? 0}
              onHost={videoId != null && clipSpan
                ? () => host.mutate({ id: videoId, ...clipSpan })
                : undefined}
              className="rounded-2xl w-full"
              style={{ aspectRatio: "9/16" }}
            />
          )}

          {hostedStatus === "error" && video?.hostError && (
            <p className="text-[11px] leading-relaxed" style={{ color: "oklch(0.72 0.19 45)" }}>
              {video.hostError}
            </p>
          )}
        </div>

        {/* ── Timeline ──────────────────────────────────────────────────── */}
        <div className="space-y-3 min-w-0">
          {current ? (
            <>
              <ClipTimeline
                duration={duration}
                segments={current.segments}
                onSegmentsChange={next => patch({ segments: next })}
                selectedSegment={selectedSegment}
                onSelectSegment={setSelectedSegment}
                words={current.words}
                onWordsChange={next => patch({ words: next })}
                playheadSeconds={playhead}
                onScrub={scrubTo}
                baseFraming={current.framing}
                editingKeyframe={editingKeyframe}
                onEditingKeyframeChange={setEditingKeyframe}
              />

              {captionsOn && current.words.length === 0 && (
                <p className="text-[11px] leading-relaxed p-3 rounded-xl" style={{ background: "oklch(0.78 0.18 55 / 0.1)", color: "oklch(0.82 0.17 60)" }}>
                  No word timings for this clip. The export will spread the transcript evenly,
                  which drifts from the speech. Transcribe the clip on the Clips page for
                  captions that follow the audio, or add words with the + on the subtitle track.
                </p>
              )}

              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => renderOne(clips[active])}
                  disabled={rendering.has(clips[active]?.id)}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-colors disabled:opacity-50"
                  style={{ background: "rgba(49, 94, 245, 0.08)", color: "var(--cobalt)" }}
                >
                  {rendering.has(clips[active]?.id)
                    ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Rendering…</>
                    : <><Zap className="w-3.5 h-3.5" /> Render this clip</>}
                </button>
              </div>
            </>
          ) : (
            <div className="glass rounded-2xl p-8 text-center">
              <Loader2 className="w-6 h-6 mx-auto mb-3 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Preparing this clip…</p>
            </div>
          )}
        </div>
      </div>

      <button
        onClick={async () => {
          await saveAll();
          const ids: Record<number, number> = {};
          for (const h of clips) if (edits[h.id]) ids[h.id] = edits[h.id].clipId;
          onNext(ids);
        }}
        disabled={saving || Object.keys(edits).length === 0}
        className="mt-6 w-full flex items-center justify-center gap-2 py-3.5 rounded-xl font-bold text-sm transition-all hover:opacity-90 disabled:opacity-50 glow-green"
        style={{ background: "linear-gradient(135deg, var(--mint), oklch(0.65 0.20 165))", color: "black" }}
      >
        <Save className="w-4 h-4" /> Save & Continue to Export <ArrowRight className="w-4 h-4" />
      </button>
    </div>
  );
}

// ─── Step 5: Export ───────────────────────────────────────────────────────────
function StepExport({ clips, style, videoTitle, reelTitle, videoUrl, clipIds, captionsOn, apiKey, model }: {
  clips: Highlight[]; style: SubStyle; videoTitle: string; reelTitle: string;
  videoUrl: string;
  /** Row ids created by the Edit step, keyed by highlight id. */
  clipIds: Record<number, number>;
  /** Burn captions into the exports. */
  captionsOn: boolean;
  apiKey: string; model: string;
}) {
  const [rendered, setRendered] = useState<Set<number>>(new Set());
  const [rendering, setRendering] = useState<Set<number>>(new Set());
  const utils = trpc.useUtils();
  const startRender = trpc.clips.render.useMutation({ onSuccess: () => utils.clips.list.invalidate() });
  const generateTitle = trpc.gemini.generateTitle.useMutation();
  const [hookTitles, setHookTitles] = useState<Record<number, { title: string; hook: string; hashtags: string[] }>>({});

  /**
   * Renders the row the Edit step already created and saved. Nothing is created
   * here, so the framing sections and subtitle timings made in Edit are exactly
   * what gets burned in.
   */
  const renderClip = async (h: Highlight) => {
    const clipId = clipIds[h.id];
    if (clipId == null) {
      toast.error("This clip was not prepared — go back to the Edit step.");
      return;
    }
    setRendering(prev => new Set(Array.from(prev).concat(h.id)));
    try {
      await startRender.mutateAsync({ id: clipId, captionsEnabled: captionsOn });
      setRendered(prev => new Set(Array.from(prev).concat(h.id)));
      toast.success(`"${h.title}" is rendering — track it on the Clips page.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start the render");
    } finally {
      setRendering(prev => { const s = new Set(prev); s.delete(h.id); return s; });
    }
  };

  const genHook = async (h: Highlight) => {
    try {
      const result = await generateTitle.mutateAsync({ clipContent: `${h.title}: ${h.reason}`, style: "tiktok", apiKey, model });
      setHookTitles(prev => ({ ...prev, [h.id]: result }));
      toast.success("AI generated a viral hook!");
    } catch { toast.error("Failed to generate hook"); }
  };

  const renderAll = () => clips.forEach(h => { if (!rendered.has(h.id) && !rendering.has(h.id)) renderClip(h); });

  return (
    <div className="animate-slide-up">
      <div className="mb-6 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-black text-foreground mb-1" style={{ fontFamily: "Montserrat, sans-serif" }}>Export Your Clips</h2>
          <p className="text-sm text-muted-foreground">{clips.length} clip{clips.length !== 1 ? "s" : ""} from <span className="text-foreground font-medium">{videoTitle}</span></p>
          {reelTitle && <p className="text-xs text-muted-foreground mt-0.5">Reel title: <span style={{ color: "var(--mint)" }}>{reelTitle}</span></p>}
        </div>
        <button onClick={renderAll} className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold text-white transition-all hover:opacity-90" style={{ background: "linear-gradient(135deg, var(--coral), oklch(0.65 0.20 300))" }}>
          <Zap className="w-4 h-4" /> Render All
        </button>
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {clips.map(h => {
          const isRendering = rendering.has(h.id), isDone = rendered.has(h.id);
          const scoreColor = h.engagementScore >= 90 ? "var(--mint)" : "var(--cobalt)";
          const hook = hookTitles[h.id];
          const ytId = parseYouTubeId(videoUrl);
          const thumbnail = ytId ? youTubeThumbnail(ytId) : null;
          return (
            <div key={h.id} className="glass rounded-2xl overflow-hidden hover:border-primary/30 transition-colors">
              <div className="relative flex items-center justify-center overflow-hidden" style={{ height:"140px", background:"linear-gradient(135deg, #0a0a1a, #1a0a2e)" }}>
                {thumbnail && (
                  <img src={thumbnail} alt="" className="absolute inset-0 w-full h-full object-cover opacity-70" loading="lazy" />
                )}
                <div className="relative w-12 h-12 rounded-full flex items-center justify-center" style={{ background:"rgba(49, 94, 245, 0.18)", backdropFilter: "blur(4px)" }}>
                  <Play className="w-5 h-5 ml-0.5 text-white" />
                </div>
                <div className="absolute bottom-3 left-0 right-0 text-center px-2">
                  <span className="text-xs font-black uppercase" style={{ fontFamily: style.font, color: style.color, textShadow: style.outline ? "0 0 3px #000, 1px 1px 0 #000" : "none" }}>
                    {hook?.title ?? h.title.split(" ").slice(0,3).join(" ")}…
                  </span>
                </div>
                <div className="absolute top-2 right-2 text-xs font-black px-1.5 py-0.5 rounded" style={{ color: scoreColor, background: `${scoreColor}22` }}>{h.engagementScore}</div>
              </div>
              <div className="p-4">
                <h3 className="text-sm font-bold text-foreground mb-1 truncate" style={{ fontFamily: "Montserrat, sans-serif" }}>{h.title}</h3>
                <p className="text-xs text-muted-foreground mb-1">{fmt(h.startTime)} – {fmt(h.endTime)} · {h.endTime - h.startTime}s</p>
                {hook && (
                  <div className="mb-2 p-2 rounded-lg bg-secondary/40">
                    <p className="text-xs font-semibold text-foreground mb-1">{hook.hook}</p>
                    <div className="flex flex-wrap gap-1">{hook.hashtags.map(t => <span key={t} className="text-[10px] font-semibold px-1.5 py-0.5 rounded" style={{ color:"var(--cobalt)", background:"rgba(49, 94, 245, 0.06)" }}>#{t}</span>)}</div>
                  </div>
                )}
                <div className="flex gap-2 flex-wrap">
                  {!hook && <button onClick={() => genHook(h)} disabled={generateTitle.isPending} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-80" style={{ background:"rgba(221, 125, 113, 0.1)", color:"var(--coral)" }}><Wand2 className="w-3 h-3" /> AI Hook</button>}
                  {isDone ? (
                    <a href="/dashboard/clips" className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-bold transition-all hover:opacity-80" style={{ background:"rgba(89, 164, 133, 0.1)", color:"var(--mint)" }}><Film className="w-3.5 h-3.5" /> View in Clips</a>
                  ) : isRendering ? (
                    <div className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-semibold text-muted-foreground bg-secondary/60"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Rendering…</div>
                  ) : (
                    <button onClick={() => renderClip(h)} className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-bold text-white transition-all hover:opacity-80" style={{ background:"var(--cobalt)" }}><Zap className="w-3.5 h-3.5" /> Render</button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-6 glass rounded-2xl p-5 flex items-center gap-4">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background:"rgba(89, 164, 133, 0.1)" }}>
          <Film className="w-5 h-5" style={{ color:"var(--mint)" }} />
        </div>
        <div>
          <p className="text-sm font-semibold text-foreground">All clips saved to your library</p>
          <p className="text-xs text-muted-foreground">View and manage them in the <a href="/dashboard/clips" className="underline" style={{ color:"var(--cobalt)" }}>Clips page</a></p>
        </div>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function CreatePage() {
  const apiKey = "server"; // Key is now in backend .env
  const model = "openai/gpt-4o-mini";
  const [step, setStep] = useState<Step>(1);
  const [videoTitle, setVideoTitle] = useState("");
  const [videoDuration, setVideoDuration] = useState(0);
  const [transcript, setTranscript] = useState("");
  /**
   * Per-word timings from the caption track, when the source had them.
   *
   * Highlight detection uses these to anchor each clip to the words actually
   * spoken; without them the model can only estimate times from the text.
   */
  const [transcriptWords, setTranscriptWords] = useState<
    { word: string; start: number; end: number }[]
  >([]);
  /** Measured engagement signals from the platform, when it published them. */
  const [heatmap, setHeatmap] = useState<{ start: number; end: number; value: number }[]>([]);
  const [chapters, setChapters] = useState<{ start: number; end: number; title: string }[]>([]);
  // Kept so later steps can actually show and render the video.
  const [videoId, setVideoId] = useState<number | null>(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [selectedClips, setSelectedClips] = useState<Highlight[]>([]);
  const [reelTitle, setReelTitle] = useState("");
  const [subStyle, setSubStyle] = useState<SubStyle|null>(null);
  /**
   * Clip rows created by the Edit step, keyed by highlight id. Export renders
   * these rather than creating its own, so the per-clip edits survive.
   */
  const [clipIds, setClipIds] = useState<Record<number, number>>({});
  // Framing is per-clip now and lives in the Edit step.
  // Whether captions get burned into the exported clips.
  const [captionsOn, setCaptionsOn] = useState(true);
  /*
   * The import-time subtitles decision. Kept so later steps know whether a
   * transcript is expected at all, and so the highlights step can fall back to
   * manual clip selection instead of stalling with nothing to analyse.
   */
  const [subtitlesOn, setSubtitlesOn] = useState(true);

  return (
    <AppLayout title="Create">
      <div className="max-w-4xl mx-auto">
        <StepBar current={step} onGo={s => setStep(s)} />
        {step === 1 && (
          <StepInput apiKey={apiKey} onNext={v => {
            setVideoId(v.videoId); setVideoUrl(v.url);
            setVideoTitle(v.title); setTranscript(v.transcript); setVideoDuration(v.duration);
            setTranscriptWords(v.words);
            setHeatmap(v.heatmap); setChapters(v.chapters);
            setSubtitlesOn(v.subtitlesOn);
            // Subtitles off at import means nothing to burn in at export either.
            setCaptionsOn(v.subtitlesOn);
            setStep(2);
          }} />
        )}
        {step === 2 && (
          <StepHighlights videoTitle={videoTitle} transcript={transcript} apiKey={apiKey} model={model} videoDuration={videoDuration}
            transcriptWords={transcriptWords}
            heatmap={heatmap} chapters={chapters}
            subtitlesOn={subtitlesOn}
            onNext={(clips, rt) => {
              setSelectedClips(clips);
              setReelTitle(rt);

              // The import is started by StepSubtitles on mount, so it covers
              // the clips actually in play and retries cleanly on remount.
              setStep(3);
            }} />
        )}
        {step === 3 && (
          <StepSubtitles clips={selectedClips} videoId={videoId} transcript={transcript}
            captionsOn={captionsOn} onCaptionsChange={setCaptionsOn}
            onNext={style => { setSubStyle(style); setStep(4); }} />
        )}
        {step === 4 && subStyle && (
          <StepEdit clips={selectedClips} videoId={videoId} style={subStyle}
            captionsOn={captionsOn}
            onNext={ids => { setClipIds(ids); setStep(5); }} />
        )}
        {step === 5 && subStyle && (
          <StepExport clips={selectedClips} style={subStyle} videoTitle={videoTitle} reelTitle={reelTitle}
            videoUrl={videoUrl} clipIds={clipIds} captionsOn={captionsOn}
            apiKey={apiKey} model={model} />
        )}
      </div>
    </AppLayout>
  );
}
