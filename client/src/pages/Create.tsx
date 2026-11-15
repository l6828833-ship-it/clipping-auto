import { useState, useRef, useMemo, useEffect } from "react";
// (useRef/useEffect drive the one-shot import trigger in StepSubtitles)
import AppLayout from "@/components/AppLayout";
import ClipPreview from "@/components/ClipPreview";
import { CropView, DEFAULT_FRAMING, type Framing } from "@/components/VideoFramer";
import SubtitleOverlay, {
  DEFAULT_SUBTITLE_STYLE, MIN_FONT_SIZE, MAX_FONT_SIZE,
  CAPTION_FONTS, CaptionPresetPicker,
} from "@/components/SubtitleOverlay";
import type { CaptionPresetId } from "@shared/captions.mjs";
import { AI_VIDEO_STYLES, VIDEO_STYLES, montageCaptionStyle, type VideoLayout, type VideoStyleId } from "@shared/video-styles.mjs";
import VideoStylePicker from "@/components/VideoStylePicker";
import { downloadUrl, parseYouTubeId, youTubeThumbnail } from "@/lib/videoSource";
import { trpc } from "@/lib/trpc";
import { useSourceTranscription, type SourceTranscriptionStage } from "@/hooks/useSourceTranscription";
import { toast } from "sonner";
import {
  Upload, Link2, Sparkles, Type, Download, CheckCircle2,
  Loader2, Play, Clock, FileVideo, Youtube,
  X, Palette, Save, Film, ArrowRight, ChevronRight, Zap,
  AlertCircle, RefreshCw, Wand2,
  Mic, Captions, Globe2, ChevronDown,
} from "lucide-react";
import type { TimelineWord } from "@/components/ClipTimeline";
import { framingAt, segmentAt, type FramingSegment } from "@shared/framing";

// ─── Types ────────────────────────────────────────────────────────────────────
type Step = 1 | 2 | 3 | 4;
const STEPS = [
  { id: 1, label: "Input",      icon: Upload   },
  { id: 2, label: "Highlights", icon: Sparkles },
  { id: 3, label: "Captions",   icon: Type     },
  { id: 4, label: "Export",     icon: Download },
] as const;

type Highlight = {
  id: number; title: string; startTime: number; endTime: number;
  engagementScore: number; reason: string;
  /** Editing style the AI suggested for this clip. */
  montage?: string;
};
type SubStyle = {
  preset?: CaptionPresetId;
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
const FONTS = CAPTION_FONTS;
const TEXT_COLORS = ["#FFFFFF","#FFE600","#39FF14","#00B4FF","#FF2D78"];
const HL_COLORS   = ["#FFE600","#39FF14","#00B4FF","#FF2D78"];
const LANGUAGES = [
  { code: "auto", label: "Auto-detect" }, { code: "ar-ma", label: "Moroccan Darija" },
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
type Stage = "idle" | SourceTranscriptionStage | "uploading" | "done" | "error";
const STAGE_LABELS: Record<Stage, string> = {
  idle: "",
  "fetching-info": "Fetching video info…",
  "checking-captions": "Checking for YouTube captions…",
  downloading: "Downloading source audio…",
  transcribing: "Transcribing the audio…",
  uploading: "Uploading and preparing your file…",
  done: "Transcript ready!",
  error: "Extraction failed",
};
const STAGE_PROGRESS: Record<Stage, number> = {
  idle: 0, "fetching-info": 15, "checking-captions": 35, downloading: 55,
  transcribing: 75, uploading: 0, done: 100, error: 0,
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
function StepInput({ apiKey, layout, onLayoutChange, onNext }: {
  apiKey: string;
  /** Video style for every clip of this video; null lets the AI pick per clip. */
  layout: VideoLayout | null;
  onLayoutChange: (layout: VideoLayout | null) => void;
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
   * Off skips speech-to-text and exports without burned-in captions. It can be
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
  const [language, setLanguage] = useState("auto");
  const [detectedLanguage, setDetectedLanguage] = useState("auto");
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

  const transcribeSource = useSourceTranscription();

  const handleExtractUrl = async () => {
    if (!url.trim()) { toast.error("Please enter a video URL"); return; }

    setStage("fetching-info");
    setStageError("");
    setVideoMeta(null);
    setTranscript("");
    setTimedWords([]);
    setDetectedLanguage("auto");

    try {
      const result = await transcribeSource({
        url: url.trim(),
        language,
        allowSpeechToText: subtitlesOn,
      }, setStage);

      setStage("done");
      setTranscript(result.transcript);
      setTimedWords(result.words ?? []);
      setDetectedLanguage(result.language ?? "auto");
      // Real viewer rewatch data, when YouTube published it for this video.
      setHeatmap(result.heatmap ?? []);
      setChapters(result.chapters ?? []);
      setVideoMeta({ title: result.title, duration: result.duration, uploader: result.uploader });
      if (!title) setTitle(result.title);

      if (!subtitlesOn) {
        toast.success(`Video ready — ${result.title}. Subtitles are off, so nothing was transcribed.`);
      } else if (result.transcript) {
        const label = result.source === "youtube" ? "YouTube captions" : "local Whisper";
        toast.success(`Transcript ready from ${label}. ${result.wordCount} timed words.`);
      } else {
        toast.info(result.note || "No captions found. You can paste a transcript manually below.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Video analysis failed.";
      setStage("error");
      setStageError(message);
      toast.error(message);
    }
  };

  const selectFile = (selected: File | null) => {
    setFile(selected);
    setStage("idle");
    setTranscript("");
    setTimedWords([]);
    if (selected && (!title || title === file?.name.replace(/\.[^.]+$/, ""))) {
      setTitle(selected.name.replace(/\.[^.]+$/, "").slice(0, 512));
    }
  };

  const handleProceed = async () => {
    if (!title.trim()) { toast.error("Please enter a title"); return; }
    if (mode === "upload") {
      if (!file || stage === "uploading") return;
      setStage("uploading");
      setStageError("");
      const parameters = new URLSearchParams({
        title: title.trim(),
        captions: subtitlesOn ? "on" : "off",
        language,
      });
      try {
        const response = await fetch(`/api/media/upload?${parameters}`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/octet-stream" },
          body: file,
        });
        const result = await response.json().catch(() => null);
        if (!response.ok || !result?.id) {
          throw new Error(result?.error ?? "Upload failed. Check your connection and try again.");
        }
        void utils.videos.list.invalidate();
        if (result.note) toast.info(result.note);
        onNext({
          videoId: result.id, title: title.trim(), url: "", duration: result.duration,
          subtitlesOn, transcript: result.transcript, words: result.words, heatmap: [], chapters: [],
        });
      } catch (error) {
        setStage("error");
        setStageError(error instanceof Error ? error.message : "Upload failed. Try again.");
      }
      return;
    }

    const videoResult = await createVideo.mutateAsync({
      title: title.trim(),
      sourceType: "url",
      sourceUrl: url.trim(),
      transcript: transcript.trim() || undefined,
      duration: videoMeta?.duration || undefined,
      transcriptWords: timedWords.length > 0 ? timedWords : undefined,
      captionLanguage: language === "auto" && stage === "done" ? detectedLanguage : language,
      transcriptionEnabled: subtitlesOn,
    }).catch(() => null);
    if (!videoResult) return;

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

      {/* Video style, chosen once for every clip made from this video */}
      <div className="glass rounded-2xl p-4 mb-5">
        <p className="text-sm font-bold text-foreground">Video style</p>
        <p className="text-xs text-muted-foreground mb-3">How your clips will look. Applies to every clip from this video.</p>
        <VideoStylePicker value={layout} onChange={onLayoutChange} allowAuto />
      </div>

      {/* Subtitles on/off — decided before anything is transcribed */}
      <button
        type="button"
        role="switch"
        aria-checked={subtitlesOn}
        disabled={isExtracting}
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
          <button key={m} disabled={isExtracting} onClick={() => { setMode(m); setStage("idle"); setTranscript(""); setTimedWords([]); setVideoMeta(null); setHeatmap([]); setChapters([]); }}
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
                <input type="url" value={url} disabled={isExtracting} onChange={e => { setUrl(e.target.value); setStage("idle"); setTranscript(""); setTimedWords([]); setVideoMeta(null); setHeatmap([]); setChapters([]); }}
                  placeholder="https://youtube.com/watch?v=... or any video URL"
                  className="w-full pl-10 pr-4 py-3 rounded-xl bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-all text-sm" />
              </div>
              {/* Language picker */}
              <div className="relative">
                <button onClick={() => setShowLangPicker(v => !v)} disabled={isExtracting}
                  className="flex items-center gap-1.5 px-3 py-3 rounded-xl bg-secondary/60 hover:bg-secondary text-sm font-semibold text-foreground transition-colors whitespace-nowrap">
                  <Globe2 className="w-4 h-4" />
                  {LANGUAGES.find(l => l.code === language)?.label ?? language}
                  <ChevronDown className="w-3 h-3" />
                </button>
                {showLangPicker && (
                  <div className="absolute right-0 top-full mt-1 z-20 glass rounded-xl shadow-xl border border-border p-1 w-40 max-h-48 overflow-y-auto">
                    {LANGUAGES.map(l => (
                      <button key={l.code} onClick={() => {
                        setShowLangPicker(false);
                        if (l.code === language) return;
                        setLanguage(l.code);
                        setStage("idle");
                        setTranscript("");
                        setTimedWords([]);
                      }}
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
              onDrop={e => { e.preventDefault(); setDragOver(false); if (!isExtracting && e.dataTransfer.files[0]) selectFile(e.dataTransfer.files[0]); }}
              onClick={() => { if (!isExtracting) fileRef.current?.click(); }}
              className={`relative flex flex-col items-center justify-center gap-3 p-8 rounded-2xl border-2 border-dashed cursor-pointer transition-all duration-200 ${dragOver ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 hover:bg-secondary/30"}`}>
              <input ref={fileRef} type="file" accept="video/*,audio/*" className="hidden"
                aria-label="Video or audio file" disabled={isExtracting}
                onChange={e => { const f = e.target.files?.[0]; if (f) selectFile(f); e.target.value = ""; }} />
              {file ? (
                <>
                  <CheckCircle2 className="w-8 h-8" style={{ color: "var(--mint)" }} />
                  <p className="text-sm font-semibold text-foreground">{file.name}</p>
                  <p className="text-xs text-muted-foreground">{(file.size / (1024*1024)).toFixed(1)} MB</p>
                  <button type="button" aria-label="Remove selected file" disabled={isExtracting} onClick={e => { e.stopPropagation(); selectFile(null); }}
                    className="absolute top-3 right-3 p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"><X className="w-4 h-4" /></button>
                </>
              ) : (
                <>
                  <FileVideo className="w-8 h-8" style={{ color: "var(--cobalt)" }} />
                  <button type="button" className="text-sm font-semibold text-foreground"
                    onClick={e => { e.stopPropagation(); fileRef.current?.click(); }}>Choose a video or audio file</button>
                  <p className="text-xs text-muted-foreground">MP4, MOV, AVI, WebM, MP3, or WAV · up to 500 MB</p>
                </>
              )}
            </div>
            {subtitlesOn && (
              <label className="flex items-center gap-3 text-sm font-medium">
                Caption language
                <select value={language} onChange={e => setLanguage(e.target.value)} disabled={isExtracting}
                  className="rounded-lg border border-border bg-input px-3 py-2">
                  {LANGUAGES.map(option => <option key={option.code} value={option.code}>{option.label}</option>)}
                </select>
              </label>
            )}
          </div>
        )}

        {/* Extract button */}
        {mode === "url" && (stage === "idle" || stage === "error") && (
          <button
            onClick={handleExtractUrl}
            disabled={!url.trim()}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl font-bold text-sm text-white transition-all hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: "linear-gradient(135deg, var(--coral), oklch(0.65 0.20 300))" }}>
            {subtitlesOn ? <Mic className="w-4 h-4" /> : <FileVideo className="w-4 h-4" />}
            {subtitlesOn ? "Extract & Transcribe Video" : "Extract Video Info"}
          </button>
        )}

        {/* Progress bar */}
        {isExtracting && (
          <div className="glass rounded-2xl p-5 space-y-3">
            <div className="flex items-center gap-3">
              <Loader2 className="w-4 h-4 animate-spin shrink-0" style={{ color: "var(--cobalt)" }} />
              <span className="text-sm font-semibold text-foreground">{STAGE_LABELS[stage]}</span>
            </div>
            {stage !== "uploading" && <><div className="h-2 rounded-full bg-secondary overflow-hidden">
              <div className="h-full rounded-full transition-all duration-700"
                style={{ width: `${progress}%`, background: "linear-gradient(90deg, var(--cobalt), var(--coral))" }} />
            </div>
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              {[
                { s: "checking-captions", label: "Captions" },
                { s: "downloading", label: "Audio" },
                { s: "transcribing", label: "Transcribe" },
              ].map(({ s, label }) => {
                const stageOrder = ["checking-captions", "downloading", "transcribing", "done"];
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
            </div></>}
          </div>
        )}

        {/* Error state */}
        {stage === "error" && stageError && (
          <div className="glass rounded-2xl p-4 border border-destructive/30">
            <div className="flex items-center gap-2 mb-1">
              <AlertCircle className="w-4 h-4 text-destructive" />
              <span className="text-sm font-semibold text-destructive">{mode === "upload" ? "Upload failed" : "Extraction failed"}</span>
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
        {mode === "url" && subtitlesOn && stage === "idle" && !transcript && (
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground flex items-center gap-2">
              <Captions className="w-3.5 h-3.5" />
              Or paste a transcript manually
            </label>
            <textarea
              dir="auto"
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
          <input type="text" value={title} disabled={isExtracting} maxLength={512} onChange={e => setTitle(e.target.value)}
            placeholder={videoMeta?.title ?? "e.g. Top 5 Moments from My Podcast"}
            className="w-full px-4 py-3 rounded-xl bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-all text-sm" />
        </div>

        {/* Proceed button */}
        <button
          onClick={handleProceed}
          disabled={!title.trim() || isExtracting || createVideo.isPending || (mode === "upload" ? !file : !url.trim())}
          className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl font-bold text-sm text-white transition-all hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed glow-blue"
          style={{ background: "linear-gradient(135deg, var(--cobalt), oklch(0.55 0.22 270))" }}>
          {createVideo.isPending || stage === "uploading"
            ? <><Loader2 className="w-4 h-4 animate-spin" /> {stage === "uploading" ? "Preparing upload…" : "Saving…"}</>
            : <><ArrowRight className="w-4 h-4" /> {mode === "upload" ? "Upload & Continue" : "Continue"}</>}
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
function ManualClipPicker({ videoTitle, videoDuration, onNext }: {
  videoTitle: string; videoDuration: number;
  onNext: (clips: Highlight[], reelTitle: string) => void;
}) {
  const [start, setStart] = useState("0:00");
  const [end, setEnd] = useState(() => String(Number(Math.min(45, videoDuration || 45).toFixed(3))));
  const [reelTitle, setReelTitle] = useState(videoTitle);

  // Accepts "m:ss", "h:mm:ss" or a plain number of seconds.
  const parseTime = (s: string): number | null => {
    const t = s.trim();
    if (!t) return null;
    if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d{1,3})?$/.test(t)) return null;
    const secs = t.split(":").reduce((acc, p) => acc * 60 + Number(p), 0);
    return Number.isFinite(secs) ? secs : null;
  };

  const startSec = parseTime(start);
  const endSec = parseTime(end);
  const valid =
    startSec !== null && endSec !== null && endSec > startSec &&
    (videoDuration <= 0 || endSec <= videoDuration + 0.001);
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

      <div className="glass rounded-2xl p-5 space-y-4 mb-5">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Start</label>
            <input type="text" aria-label="Clip start" value={start} onChange={e => setStart(e.target.value)} placeholder="0:00"
              className="w-full px-4 py-3 rounded-xl bg-input border border-border text-foreground font-mono focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-all text-sm" />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">End</label>
            <input type="text" aria-label="Clip end" value={end} onChange={e => setEnd(e.target.value)} placeholder="0:45"
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
  videoTitle, transcript, apiKey, model, videoDuration,
  transcriptWords, heatmap, chapters, titleLanguage, onTitleLanguageChange,
  onNext
}: {
  videoTitle: string; transcript: string; apiKey: string; model: string;
  videoDuration: number;
  /** Word timings, so detected clips land on the words actually spoken. */
  transcriptWords: { word: string; start: number; end: number }[];
  /** YouTube's most-replayed curve, when available — real engagement data. */
  heatmap: { start: number; end: number; value: number }[];
  chapters: { start: number; end: number; title: string }[];
  titleLanguage: string;
  onTitleLanguageChange: (language: string) => void;
  onNext: (clips: Highlight[], reelTitle: string) => void
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [reelTitle, setReelTitle] = useState("");
  const [manual, setManual] = useState(false);
  const [generatedLanguage, setGeneratedLanguage] = useState("");

  const detect = trpc.gemini.detectHighlights.useMutation({
    onSuccess: (data) => {
      setGeneratedLanguage(titleLanguage);
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
    transcript, model, apiKey, videoDuration, titleLanguage,
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
  if (manual || !transcript.trim()) {
    return (
      <ManualClipPicker
        videoTitle={videoTitle}
        videoDuration={videoDuration}
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
      <label className="mb-4 block text-sm font-semibold text-foreground">
        Highlight title language
        <select value={titleLanguage} disabled={detect.isPending}
          onChange={event => onTitleLanguageChange(event.target.value)}
          className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm">
          {LANGUAGES.map(({ code, label }) => (
            <option key={code} value={code}>{code === "auto" ? "Same as video" : label}</option>
          ))}
        </select>
      </label>
      {!apiKey && <NoKeyWarning />}
      {!detect.isPending && (
        <button type="button" onClick={() => setManual(true)}
          className="mb-4 rounded-lg border border-border px-4 py-2 text-sm font-semibold">
          Choose Clip Manually
        </button>
      )}
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
                <p dir="auto" className="text-sm font-bold text-foreground truncate">{reelTitle}</p>
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
                        <span dir="auto" className="text-sm font-bold text-foreground" style={{ fontFamily: "Montserrat, sans-serif" }}>{h.title}</span>
                        <span className="text-xs font-black px-2 py-0.5 rounded-full shrink-0" style={{ color, background: `${color}22` }}>{h.engagementScore}</span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground mb-2">
                        <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{fmt(h.startTime)}–{fmt(h.endTime)}</span>
                        <span>{Math.round(h.endTime - h.startTime)}s</span>
                      </div>
                      <p dir="auto" className="text-xs text-muted-foreground italic">{h.reason}</p>
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
              <RefreshCw className="w-4 h-4" /> {generatedLanguage === titleLanguage ? "Re-analyze" : "Regenerate in selected language"}
            </button>
            <button onClick={proceed} disabled={selected.size === 0 || generatedLanguage !== titleLanguage}
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

function useClipPreviewImport(
  videoId: number | null,
  clip: Highlight | undefined,
  video: { sourceUrl?: string | null; hostedStatus: string; hostedUrl?: string | null; hostedOffset?: number | null; hostedDuration?: number | null } | undefined,
  request: (input: { id: number; startTime: number; endTime: number; force: boolean }) => void,
) {
  const attempted = useRef("");
  const offset = video?.hostedOffset ?? 0;
  const coversClip = !clip || video?.hostedDuration == null || (
    clip.startTime >= offset - 0.15 && clip.endTime <= offset + video.hostedDuration + 0.15
  );
  const ready = video?.hostedStatus === "ready" && !!video.hostedUrl && coversClip;
  const canImport = videoId != null && !!clip && !!video?.sourceUrl;
  const importClip = canImport && clip && videoId != null ? () => request({
    id: videoId, startTime: clip.startTime, endTime: clip.endTime,
    force: video?.hostedStatus === "ready",
  }) : undefined;

  useEffect(() => {
    if (ready) {
      attempted.current = "";
      return;
    }
    if (!importClip || video?.hostedStatus === "downloading" || video?.hostedStatus === "error") return;
    const target = `${videoId}:${clip?.startTime}:${clip?.endTime}:${video?.hostedUrl ?? ""}`;
    if (attempted.current === target) return;
    attempted.current = target;
    importClip();
  }, [videoId, clip, video, ready, importClip]);

  return {
    hostedUrl: ready ? video?.hostedUrl : null,
    hostedStatus: (ready ? "ready" : video?.hostedStatus === "ready" ? "none" : video?.hostedStatus ?? "none") as
      "none" | "downloading" | "ready" | "error",
    importClip,
  };
}

// ─── Step 3: Subtitles ────────────────────────────────────────────────────────
function StepSubtitles({
  clips, videoId, layout, captionsOn, onCaptionsChange, onNext,
}: {
  clips: Highlight[];
  videoId: number | null;
  /** Video style chosen in the first step; null uses the AI's pick per clip. */
  layout: VideoLayout | null;
  /** Whether captions get burned into the exports. */
  captionsOn: boolean;
  onCaptionsChange: (on: boolean) => void;
  onNext: (style: SubStyle) => void;
}) {
  const [font, setFont] = useState(DEFAULT_SUBTITLE_STYLE.font);
  const [preset, setPreset] = useState<CaptionPresetId>("karaoke");
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
   * The caption style is shared by every clip.
   */
  const [freePos, setFreePos] = useState<{ posX: number; posY: number } | null>(null);
  const style: SubStyle = {
    preset, font, fontSize, color, highlightColor: hlColor, position, outline,
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
  const host = trpc.videos.host.useMutation({
    onSuccess: async () => {
      await utils.videos.get.invalidate();
      await utils.videos.list.invalidate();
    },
    onError: err => toast.error(`Import failed: ${err.message}`),
  });

  /*
   * Which selected clips are already imported, and where each plays from.
   * A clip that is on the server is shown straight from its own file, so
   * going to another clip and back never starts its import again. Polled
   * until every clip is in.
   */
  const ranges = useMemo(
    () => clips.slice(0, 12).map(c => ({ startTime: c.startTime, endTime: c.endTime })),
    [clips],
  );
  const [allImported, setAllImported] = useState(false);
  const { data: sectionData } = trpc.videos.sections.useQuery(
    { id: videoId ?? 0, ranges },
    { enabled: videoId != null && ranges.length > 0, refetchInterval: allImported ? false : 4000 },
  );
  const sections = (sectionData as { sections?: ({ url: string; offset: number; duration: number } | null)[] } | undefined)?.sections;
  useEffect(() => {
    setAllImported(!!sections && sections.length === ranges.length && sections.every(Boolean));
  }, [sections, ranges.length]);
  const section = sections?.[previewIdx] ?? null;

  /* Only a clip that is not on the server yet asks for its import. */
  const imported = useClipPreviewImport(videoId, section ? undefined : clip, video, host.mutate);
  const importClip = imported.importClip;
  const hostedUrl = section?.url ?? imported.hostedUrl;
  const hostedStatus = section ? "ready" as const : imported.hostedStatus;
  /* The playing file's t=0 is `hostedOffset` seconds into the original. */
  const hostedOffset = section?.offset ?? video?.hostedOffset ?? 0;

  /* Fetch every selected clip's part of the video in the background, once, so
   * switching the preview to clip 2, 3, 4… and the export that follows find
   * them already downloaded instead of starting from zero. */
  const prefetch = trpc.videos.prefetch.useMutation();
  const prefetched = useRef("");
  useEffect(() => {
    if (videoId == null || clips.length === 0) return;
    const key = `${videoId}:${clips.map(c => `${c.startTime}-${c.endTime}`).join(",")}`;
    if (prefetched.current === key) return;
    prefetched.current = key;
    /* Best effort, with one more try: nothing breaks if it fails, the clips
     * are simply fetched when they are needed. */
    prefetch.mutateAsync({ id: videoId, ranges })
      .catch(() => new Promise(resolve => setTimeout(resolve, 4000)).then(() => prefetch.mutateAsync({ id: videoId, ranges })))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, clips]);

  const previewWords = useMemo(
    () => clip ? wordsInClip(video?.transcriptWords, clip).slice(0, 4).map(word => word.word) : [],
    [video?.transcriptWords, clip]
  );

  /* The video style this clip will be exported in, imitated by the preview. */
  const clipStyle = layout?.style
    ?? (clip?.montage && (AI_VIDEO_STYLES as string[]).includes(clip.montage) ? clip.montage : "normal");
  const { data: library } = trpc.videos.list.useQuery(undefined, { enabled: layout?.backgroundVideoId != null });
  const backgroundUrl = layout?.backgroundVideoId != null
    ? ((library as { id: number; hostedUrl?: string | null }[] | undefined)?.find(v => v.id === layout.backgroundVideoId)?.hostedUrl ?? null)
    : null;
  const shownStyle = montageCaptionStyle(clipStyle, style) as SubStyle;

  /* The framing the export will use: the server follows the speaker's face,
   * and for Dual Speaker also says which shots have two people in them.
   * Asked for once the clip's part of the video is imported, so the preview
   * shows the same picture as the finished clip rather than the plain centre. */
  const { data: autoFraming } = trpc.videos.previewFraming.useQuery(
    {
      id: videoId ?? 0, startTime: clip?.startTime ?? 0, endTime: clip?.endTime ?? 0,
      ...(clipStyle === "dual" ? { style: "dual" as const } : {}),
    },
    { enabled: videoId != null && !!clip && hostedStatus === "ready", staleTime: Infinity },
  );
  /** Playback position in the clip, in steps coarse enough not to re-render every frame. */
  const [previewTime, setPreviewTime] = useState(0);
  useEffect(() => { setPreviewTime(0); }, [clip?.id]);
  const plan = useMemo(
    () => ((autoFraming as { segments?: PlanSegment[] } | undefined)?.segments ?? []),
    [autoFraming],
  );
  const planIndex = plan.length ? segmentAt(plan, previewTime) : undefined;
  const planSegment = planIndex != null ? plan[planIndex] : undefined;
  /* Two people on screen right now: one per half. */
  const pair = clipStyle === "dual" && planSegment?.dual?.length === 2
    ? { top: planSegment.dual[0], bottom: planSegment.dual[1] } : null;
  const previewFraming = planSegment && !planSegment.dual ? framingAt(planSegment, previewTime) : DEFAULT_FRAMING;
  /* Captions sit across the join while the picture is split. */
  const captionStyle = pair && shownStyle.posX == null && shownStyle.posY == null
    ? { ...shownStyle, position: "center" as const } : shownStyle;

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
              <label className="text-xs text-muted-foreground mb-2 block">Design</label>
              <CaptionPresetPicker value={preset} onChange={setPreset} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-2 block">Font Family <span className="opacity-70">(Arabic text always uses Tajawal or Almarai)</span></label>
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
            <span className="text-[10px] text-muted-foreground">{VIDEO_STYLES[clipStyle as VideoStyleId]?.label ?? "Normal"} style</span>
          </div>
          <div className="p-4 flex flex-col items-center gap-3">
            {/* Clip switcher, when more than one is selected. */}
            {clips.length > 1 && (
              <div className="flex flex-wrap justify-center gap-1.5">
                {clips.map((c, i) => {
                  const ready = !!sections?.[i];
                  return (
                    <button key={c.id} onClick={() => setPreviewIdx(i)}
                      title={ready ? "Ready to preview" : "Still importing this part of the video"}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all ${i === previewIdx ? "text-white" : "text-muted-foreground bg-secondary/60 hover:text-foreground"}`}
                      style={i === previewIdx ? { background: "var(--cobalt)" } : {}}>
                      #{i + 1}
                      <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full ${ready ? "" : "animate-pulse"}`}
                        style={{ background: ready ? "var(--mint)" : "var(--amber)" }} />
                    </button>
                  );
                })}
              </div>
            )}

            {hostedStatus === "ready" && hostedUrl ? (
              /*
               * No `onChange`, so the frame cannot be panned here: the export
               * follows the speaker by itself. The caption IS draggable,
               * because where it sits is part of the look being styled.
               */
              <CropView
                src={hostedUrl}
                framing={previewFraming}
                startTime={(clip?.startTime ?? 0) - hostedOffset}
                endTime={(clip?.endTime ?? 0) - hostedOffset}
                className="w-full shadow-2xl"
                style={{ maxWidth: "300px" }}
                look={{ style: clipStyle, backgroundUrl, dual: pair, hasDual: plan.some(seg => seg.dual) }}
                onTime={t => setPreviewTime(Math.max(0, Math.round((t + hostedOffset - (clip?.startTime ?? 0)) * 20) / 20))}
              >
                {captionsOn && previewWords.length > 0 && (
                  <SubtitleOverlay
                    words={previewWords}
                    activeIndex={activeWord}
                    style={captionStyle}
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
                  onHost={importClip}
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
              {captionsOn && (previewWords.length > 0
                ? "Click words to preview the highlight"
                : "No timed captions for this preview")}
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
        <Save className="w-4 h-4" /> Save & Export Clips <ArrowRight className="w-4 h-4" />
      </button>
    </div>
  );
}

/** A framing segment from the server; a two-person shot carries the crop for each half. */
type PlanSegment = FramingSegment & { dual?: Framing[] };

/** The words spoken inside a clip, in clip-relative seconds. */
function wordsInClip(words: TimelineWord[] | null | undefined, clip: Highlight): TimelineWord[] {
  if (!Array.isArray(words)) return [];
  return words
    .filter(word => word.end > clip.startTime && word.start < clip.endTime)
    .map(word => ({
      word: word.word,
      start: Math.max(0, word.start - clip.startTime),
      end: Math.min(clip.endTime - clip.startTime, word.end - clip.startTime),
    }))
    .filter(word => word.end > word.start);
}

// ─── Step 4: Export ───────────────────────────────────────────────────────────
/**
 * Creates a clip row for every selected highlight, saves the caption design
 * and video style on it, then renders them all, one after another, without
 * waiting to be asked. The server imports each clip's part of the video,
 * follows the speaker and transcribes as part of the render, so there is
 * nothing to prepare by hand in between.
 */
function StepExport({ clips, style, layout, videoId, videoTitle, reelTitle, videoUrl, captionsOn, renderLog, apiKey, model, titleLanguage }: {
  clips: Highlight[]; style: SubStyle; videoTitle: string; reelTitle: string;
  /** Video style chosen in the first step; null uses the AI's pick per clip. */
  layout: VideoLayout | null;
  videoId: number | null;
  videoUrl: string;
  /** Burn captions into the exports. */
  captionsOn: boolean;
  /**
   * What each clip was last rendered with, kept by the page so it survives
   * leaving this step. A clip is rendered again only when that has changed.
   */
  renderLog: { current: Record<number, string> };
  apiKey: string; model: string; titleLanguage: string;
}) {
  const utils = trpc.useUtils();
  const { data: exports = [] } = trpc.clips.list.useQuery(undefined, { refetchInterval: 2500 });
  const exportById = new Map<number, { status: string; downloadUrl?: string | null; errorMessage?: string | null }>(
    exports.map(clip => [clip.id, clip]),
  );
  /* Always fetched afresh on entering this step: a cached list from an earlier
   * visit would not include the rows made then, and they would be duplicated. */
  const { data: existingClips, isFetchedAfterMount, error: listError, refetch: reloadClips } = trpc.clips.listByVideo.useQuery(
    { videoId: videoId ?? 0 },
    { enabled: videoId != null, refetchOnMount: "always" },
  );
  const createClip = trpc.clips.create.useMutation();
  const updateClip = trpc.clips.update.useMutation();
  const saveSubtitles = trpc.subtitles.save.useMutation();
  const startRender = trpc.clips.render.useMutation({ onSuccess: () => utils.clips.list.invalidate() });
  const generateTitle = trpc.gemini.generateTitle.useMutation();
  const [hookTitles, setHookTitles] = useState<Record<number, { title: string; hook: string; hashtags: string[] }>>({});

  /** Row ids, keyed by highlight id, filled in as each clip is saved. */
  const [clipIds, setClipIds] = useState<Record<number, number>>({});
  /** Highlights waiting their turn, and the one whose render is being started. */
  const [queued, setQueued] = useState<Set<number>>(new Set());
  const [rendering, setRendering] = useState<Set<number>>(new Set());
  const [failed, setFailed] = useState<Record<number, string>>({});

  /** Everything that changes how a clip looks, to tell when a re-render is due. */
  const signature = JSON.stringify([captionsOn, captionsOn ? style : null, layout]);

  const renderClip = async (h: Highlight, clipId: number) => {
    setRendering(prev => new Set(prev).add(h.id));
    setFailed(prev => { const next = { ...prev }; delete next[h.id]; return next; });
    try {
      /* Resolves once this clip's part of the video is on the server and the
       * render is under way; the card then follows the clip's status. */
      await startRender.mutateAsync({ id: clipId, captionsEnabled: captionsOn });
      renderLog.current[clipId] = signature;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not start the render";
      setFailed(prev => ({ ...prev, [h.id]: message }));
      toast.error(`${h.title}: ${message}`);
    } finally {
      setRendering(prev => { const next = new Set(prev); next.delete(h.id); return next; });
    }
  };

  /* One at a time: each render first imports its own part of the video, and
   * starting them together only makes them compete for the same download. */
  const line = useRef<Promise<void>>(Promise.resolve());
  const enqueue = (h: Highlight, clipId: number) => {
    setQueued(prev => new Set(prev).add(h.id));
    line.current = line.current.then(async () => {
      setQueued(prev => { const next = new Set(prev); next.delete(h.id); return next; });
      await renderClip(h, clipId);
    });
  };

  /*
   * Save every clip, then render. Runs once per visit to this step, after the
   * video's existing rows are known so a clip made earlier is reused rather
   * than duplicated. The ref guard matters: effects can run twice in
   * development.
   */
  const started = useRef(false);
  const [saving, setSaving] = useState(true);
  useEffect(() => {
    if (videoId == null || !existingClips || !isFetchedAfterMount || started.current) return;
    started.current = true;
    (async () => {
      for (const h of clips) {
        try {
          // Same range on the same video is the same clip.
          const found = existingClips.find(c =>
            Math.abs((c.startTime ?? -1) - h.startTime) < 0.5 &&
            Math.abs((c.endTime ?? -1) - h.endTime) < 0.5
          );
          // The style chosen in the first step, else the one the AI suggested.
          const wanted: VideoLayout | null = layout
            ?? (h.montage && (AI_VIDEO_STYLES as string[]).includes(h.montage) ? { style: h.montage as VideoStyleId } : null);
          let id = found?.id;
          if (id == null) {
            ({ id } = await createClip.mutateAsync({
              videoId,
              title: h.title,
              startTime: h.startTime,
              endTime: h.endTime,
              engagementScore: h.engagementScore,
              ...(wanted ? { style: wanted.style } : {}),
            }));
          }
          const saved = (found as { layout?: VideoLayout | null } | undefined)?.layout ?? null;
          const styleChanged = wanted != null && (found
            ? saved?.style !== wanted.style || (saved?.backgroundVideoId ?? null) !== (wanted.backgroundVideoId ?? null)
            : wanted.backgroundVideoId != null);
          await updateClip.mutateAsync({ id, captionsEnabled: captionsOn, ...(styleChanged ? { layout: wanted } : {}) });
          if (captionsOn) await saveSubtitles.mutateAsync({ clipId: id, style });
          setClipIds(prev => ({ ...prev, [h.id]: id }));

          const status = found?.status;
          const upToDate = status === "done" && (renderLog.current[id] ?? signature) === signature && !styleChanged;
          if (!upToDate && status !== "rendering") enqueue(h, id);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Could not save this clip";
          setFailed(prev => ({ ...prev, [h.id]: message }));
          toast.error(`${h.title}: ${message}`);
        }
      }
      setSaving(false);
      await utils.clips.list.invalidate();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, existingClips, isFetchedAfterMount]);

  const genHook = async (h: Highlight) => {
    try {
      const result = await generateTitle.mutateAsync({ clipContent: `${h.title}: ${h.reason}`, style: "tiktok", apiKey, model, titleLanguage });
      setHookTitles(prev => ({ ...prev, [h.id]: result }));
      toast.success("AI generated a viral hook!");
    } catch { toast.error("Failed to generate hook"); }
  };

  const busy = (h: Highlight) => queued.has(h.id) || rendering.has(h.id) || exportById.get(clipIds[h.id])?.status === "rendering";
  const renderAll = () => clips.forEach(h => {
    const id = clipIds[h.id];
    if (id != null && !busy(h) && exportById.get(id)?.status !== "done") enqueue(h, id);
  });
  const finished = clips.filter(h => exportById.get(clipIds[h.id])?.status === "done" && !busy(h)).length;
  const working = saving || clips.some(busy);

  return (
    <div className="animate-slide-up">
      <div className="mb-6 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-black text-foreground mb-1" style={{ fontFamily: "Montserrat, sans-serif" }}>Export Your Clips</h2>
          <p className="text-sm text-muted-foreground">{clips.length} clip{clips.length !== 1 ? "s" : ""} from <span className="text-foreground font-medium">{videoTitle}</span></p>
          {listError && !existingClips && (
            <p className="text-xs text-destructive mt-0.5" role="alert">
              Could not load this video's clips ({listError.message}).{" "}
              <button type="button" className="underline font-semibold" onClick={() => void reloadClips()}>Try again</button>
            </p>
          )}
          <p className="text-xs text-muted-foreground mt-0.5" role="status">
            {working
              ? `Making your clips, one after another: ${finished} of ${clips.length} ready. You can leave this page; they keep rendering.`
              : `${finished} of ${clips.length} ready.`}
          </p>
          {reelTitle && <p className="text-xs text-muted-foreground mt-0.5">Reel title: <span style={{ color: "var(--mint)" }}>{reelTitle}</span></p>}
        </div>
        {!working && finished < clips.length && (
          <button onClick={renderAll} className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold text-white transition-all hover:opacity-90" style={{ background: "linear-gradient(135deg, var(--coral), oklch(0.65 0.20 300))" }}>
            <Zap className="w-4 h-4" /> Render the rest
          </button>
        )}
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {clips.map(h => {
          const clipId = clipIds[h.id];
          const result = exportById.get(clipId);
          const isRendering = busy(h);
          const file = result?.status === "done" && !isRendering ? result.downloadUrl : null;
          const progressLabel = clipId == null ? "Saving…"
            : queued.has(h.id) ? "Waiting its turn…"
            : rendering.has(h.id) ? "Importing this part of the video…"
            : "Rendering…";
          const problem = failed[h.id] ?? (result?.status === "error" ? result.errorMessage ?? "Rendering failed." : null);
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
                <p className="text-xs text-muted-foreground mb-1">{fmt(h.startTime)} – {fmt(h.endTime)} · {Math.round(h.endTime - h.startTime)}s</p>
                {hook && (
                  <div className="mb-2 p-2 rounded-lg bg-secondary/40">
                    <p className="text-xs font-semibold text-foreground mb-1">{hook.hook}</p>
                    <div className="flex flex-wrap gap-1">{hook.hashtags.map(t => <span key={t} className="text-[10px] font-semibold px-1.5 py-0.5 rounded" style={{ color:"var(--cobalt)", background:"rgba(49, 94, 245, 0.06)" }}>#{t}</span>)}</div>
                  </div>
                )}
                <div className="flex gap-2 flex-wrap">
                  {!hook && <button onClick={() => genHook(h)} disabled={generateTitle.isPending} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-80" style={{ background:"rgba(221, 125, 113, 0.1)", color:"var(--coral)" }}><Wand2 className="w-3 h-3" /> AI Hook</button>}
                  {file ? (
                    <a href={downloadUrl(file)} download className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-bold transition-all hover:opacity-80" style={{ background:"rgba(89, 164, 133, 0.1)", color:"var(--mint)" }}><Download className="w-3.5 h-3.5" /> Download MP4</a>
                  ) : isRendering || clipId == null ? (
                    <div className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-semibold text-muted-foreground bg-secondary/60"><Loader2 className="w-3.5 h-3.5 animate-spin" /> {progressLabel}</div>
                  ) : (
                    <button onClick={() => enqueue(h, clipId)} className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-bold text-white transition-all hover:opacity-80" style={{ background:"var(--cobalt)" }}><Zap className="w-3.5 h-3.5" /> {problem ? "Try again" : "Render"}</button>
                  )}
                </div>
                {problem && !isRendering && <p role="alert" className="mt-2 text-xs text-destructive">{problem}</p>}
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
  const [titleLanguage, setTitleLanguage] = useState("auto");
  const [subStyle, setSubStyle] = useState<SubStyle|null>(null);
  /** What each clip was last rendered with; see StepExport. */
  const renderLog = useRef<Record<number, string>>({});
  // Whether captions get burned into the exported clips.
  const [captionsOn, setCaptionsOn] = useState(true);
  /* Video style for the whole video, chosen up front. Null: AI picks per clip. */
  const [videoLayout, setVideoLayout] = useState<VideoLayout | null>(null);
  return (
    <AppLayout title="Create">
      <div className="max-w-4xl mx-auto">
        <StepBar current={step} onGo={s => setStep(s)} />
        {step === 1 && (
          <StepInput apiKey={apiKey} layout={videoLayout} onLayoutChange={setVideoLayout} onNext={v => {
            setVideoId(v.videoId); setVideoUrl(v.url);
            setVideoTitle(v.title); setTranscript(v.transcript); setVideoDuration(v.duration);
            setTranscriptWords(v.words);
            setHeatmap(v.heatmap); setChapters(v.chapters);
            // Subtitles off at import means nothing to burn in at export either.
            setCaptionsOn(v.subtitlesOn);
            setStep(2);
          }} />
        )}
        {step === 2 && (
          <StepHighlights videoTitle={videoTitle} transcript={transcript} apiKey={apiKey} model={model} videoDuration={videoDuration}
            transcriptWords={transcriptWords}
            heatmap={heatmap} chapters={chapters}
            titleLanguage={titleLanguage} onTitleLanguageChange={setTitleLanguage}
            onNext={(clips, rt) => {
              setSelectedClips(clips);
              setReelTitle(rt);

              // The import is started by StepSubtitles on mount, so it covers
              // the clips actually in play and retries cleanly on remount.
              setStep(3);
            }} />
        )}
        {step === 3 && (
          <StepSubtitles clips={selectedClips} videoId={videoId} layout={videoLayout}
            captionsOn={captionsOn} onCaptionsChange={setCaptionsOn}
            onNext={style => { setSubStyle(style); setStep(4); }} />
        )}
        {step === 4 && subStyle && (
          <StepExport clips={selectedClips} style={subStyle} layout={videoLayout} videoId={videoId}
            videoTitle={videoTitle} reelTitle={reelTitle} videoUrl={videoUrl}
            captionsOn={captionsOn} renderLog={renderLog}
            apiKey={apiKey} model={model} titleLanguage={titleLanguage} />
        )}
      </div>
    </AppLayout>
  );
}
