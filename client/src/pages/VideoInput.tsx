import { useState, useRef } from "react";
import AppLayout from "@/components/AppLayout";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { Upload, Link2, Film, X, CheckCircle2, Loader2, ArrowRight, Youtube, FileVideo } from "lucide-react";

export default function VideoInputPage() {
  const [, navigate] = useLocation();
  const [mode, setMode] = useState<"upload" | "url">("url");
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const utils = trpc.useUtils();

  const createVideo = trpc.videos.create.useMutation({
    onSuccess: async (data) => {
      await utils.videos.list.invalidate();
      toast.success("Video added to processing queue!");
      navigate("/dashboard/highlights");
    },
    onError: (err) => toast.error(err.message),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) { toast.error("Please enter a title"); return; }
    if (mode === "url" && !url.trim()) { toast.error("Please enter a URL"); return; }
    if (mode === "upload" && !file) { toast.error("Please select a file"); return; }
    createVideo.mutate({
      title: title.trim(),
      sourceType: mode,
      sourceUrl: mode === "url" ? url.trim() : file?.name,
    });
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith("video/")) {
      setFile(f);
      if (!title) setTitle(f.name.replace(/\.[^.]+$/, ""));
    } else {
      toast.error("Please drop a video file");
    }
  };

  return (
    <AppLayout title="Video Input">
      <div className="max-w-2xl mx-auto">
        <div className="mb-6">
          <h2 className="text-xl font-bold text-foreground mb-1" style={{ fontFamily: "Montserrat, sans-serif" }}>
            Add Your Video
          </h2>
          <p className="text-sm text-muted-foreground">Upload a video file or paste a YouTube / video URL to get started.</p>
        </div>

        {/* Mode toggle */}
        <div className="flex gap-2 p-1 rounded-xl bg-secondary/40 mb-6 w-fit">
          {(["url", "upload"] as const).map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-semibold transition-all duration-200 ${
                mode === m ? "text-white shadow-md" : "text-muted-foreground hover:text-foreground"
              }`}
              style={mode === m ? { background: "var(--cobalt)" } : {}}
            >
              {m === "url" ? <Link2 className="w-4 h-4" /> : <Upload className="w-4 h-4" />}
              {m === "url" ? "Paste URL" : "Upload File"}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Title */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Video Title</label>
            <input
              type="text"
              required
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="e.g. Top 5 Moments from My Podcast"
              className="w-full px-4 py-3 rounded-xl bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-all text-sm"
            />
          </div>

          {/* URL input */}
          {mode === "url" && (
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Video URL</label>
              <div className="relative">
                <Youtube className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input
                  type="url"
                  required
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  placeholder="https://youtube.com/watch?v=... or any video URL"
                  className="w-full pl-10 pr-4 py-3 rounded-xl bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-all text-sm"
                />
              </div>
              <p className="text-xs text-muted-foreground">Supports YouTube, Vimeo, direct MP4 links, and more.</p>
            </div>
          )}

          {/* File upload */}
          {mode === "upload" && (
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Video File</label>
              <div
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileRef.current?.click()}
                className={`relative flex flex-col items-center justify-center gap-3 p-10 rounded-2xl border-2 border-dashed cursor-pointer transition-all duration-200 ${
                  dragOver ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 hover:bg-secondary/30"
                }`}
              >
                <input
                  ref={fileRef}
                  type="file"
                  accept="video/*"
                  className="hidden"
                  onChange={e => {
                    const f = e.target.files?.[0];
                    if (f) { setFile(f); if (!title) setTitle(f.name.replace(/\.[^.]+$/, "")); }
                  }}
                />
                {file ? (
                  <>
                    <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: "rgba(89, 164, 133, 0.1)" }}>
                      <CheckCircle2 className="w-6 h-6" style={{ color: "var(--mint)" }} />
                    </div>
                    <div className="text-center">
                      <p className="text-sm font-semibold text-foreground">{file.name}</p>
                      <p className="text-xs text-muted-foreground">{(file.size / 1024 / 1024).toFixed(1)} MB</p>
                    </div>
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); setFile(null); }}
                      className="absolute top-3 right-3 p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </>
                ) : (
                  <>
                    <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: "rgba(49, 94, 245, 0.08)" }}>
                      <FileVideo className="w-6 h-6" style={{ color: "var(--cobalt)" }} />
                    </div>
                    <div className="text-center">
                      <p className="text-sm font-semibold text-foreground">Drop your video here</p>
                      <p className="text-xs text-muted-foreground">or click to browse — MP4, MOV, AVI, WebM</p>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={createVideo.isPending}
            className="w-full flex items-center justify-center gap-2 py-3 px-6 rounded-xl font-semibold text-sm text-white transition-all hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed glow-blue"
            style={{ background: "linear-gradient(135deg, var(--cobalt), oklch(0.55 0.22 270))" }}
          >
            {createVideo.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Film className="w-4 h-4" /> Process Video <ArrowRight className="w-4 h-4" /></>}
          </button>
        </form>

        {/* Info cards */}
        <div className="mt-8 grid grid-cols-3 gap-3">
          {[
            { step: "01", title: "Input", desc: "Upload or paste a URL", color: "var(--cobalt)" },
            { step: "02", title: "AI Analysis", desc: "Detect viral moments", color: "var(--coral)" },
            { step: "03", title: "Export", desc: "Download your clips", color: "var(--mint)" },
          ].map(s => (
            <div key={s.step} className="glass rounded-xl p-4 text-center">
              <div className="text-xs font-black mb-1" style={{ color: s.color, fontFamily: "Montserrat, sans-serif" }}>{s.step}</div>
              <div className="text-sm font-semibold text-foreground">{s.title}</div>
              <div className="text-xs text-muted-foreground mt-0.5">{s.desc}</div>
            </div>
          ))}
        </div>
      </div>
    </AppLayout>
  );
}
