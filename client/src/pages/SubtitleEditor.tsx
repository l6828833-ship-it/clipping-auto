import { useState } from "react";
import AppLayout from "@/components/AppLayout";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import SubtitleOverlay, {
  DEFAULT_SUBTITLE_STYLE, type SubtitleStyle,
} from "@/components/SubtitleOverlay";
import { Type, Palette, Save, Loader2, Eye } from "lucide-react";

const FONTS = ["Montserrat", "Inter", "Arial Black", "Impact", "Oswald"];
const COLORS = [
  { name: "White",        value: "#FFFFFF" },
  { name: "Yellow",       value: "#FFE600" },
  { name: "Neon Green",   value: "#39FF14" },
  { name: "Electric Blue",value: "#00B4FF" },
  { name: "Hot Pink",     value: "#FF2D78" },
];
const HIGHLIGHT_COLORS = [
  { name: "Yellow",       value: "#FFE600" },
  { name: "Neon Green",   value: "#39FF14" },
  { name: "Electric Blue",value: "#00B4FF" },
  { name: "Hot Pink",     value: "#FF2D78" },
];

const SAMPLE_WORDS = ["This", "is", "how", "you", "go", "VIRAL"];

export default function SubtitleEditorPage() {
  const { data: clips, isLoading } = trpc.clips.list.useQuery();
  const [selectedClip, setSelectedClip] = useState<number | null>(null);
  const [font, setFont]       = useState(DEFAULT_SUBTITLE_STYLE.font);
  const [fontSize, setFontSize] = useState(DEFAULT_SUBTITLE_STYLE.fontSize);
  const [color, setColor]     = useState(DEFAULT_SUBTITLE_STYLE.color);
  const [highlightColor, setHighlightColor] = useState(DEFAULT_SUBTITLE_STYLE.highlightColor);
  const [position, setPosition] = useState<"top" | "center" | "bottom">(DEFAULT_SUBTITLE_STYLE.position);
  const [outline, setOutline] = useState(DEFAULT_SUBTITLE_STYLE.outline);
  const [posX, setPosX] = useState<number | undefined>(undefined);
  const [posY, setPosY] = useState<number | undefined>(undefined);
  const [activeWord, setActiveWord] = useState(5);

  const style: SubtitleStyle = { font, fontSize, color, highlightColor, position, outline, posX, posY };

  const saveSubtitles = trpc.subtitles.save.useMutation({
    onSuccess: () => toast.success("Subtitle style saved!"),
    onError: (err) => toast.error(err.message),
  });

  const handleSave = () => {
    if (!selectedClip) { toast.error("Please select a clip first"); return; }
    saveSubtitles.mutate({
      clipId: selectedClip,
      words: SAMPLE_WORDS.map((word, i) => ({ word, start: i * 0.3, end: (i + 1) * 0.3 })),
      style,
    });
  };

  // When a preset is chosen, clear the free position so it re-anchors to the preset.
  const handlePosition = (p: "top" | "center" | "bottom") => {
    setPosition(p);
    setPosX(undefined);
    setPosY(undefined);
  };

  return (
    <AppLayout title="Subtitle Editor">
      <div className="max-w-4xl mx-auto">
        <div className="mb-6">
          <h2 className="text-xl font-bold text-foreground mb-1" style={{ fontFamily: "Montserrat, sans-serif" }}>
            Subtitle Editor
          </h2>
          <p className="text-sm text-muted-foreground">Customize the look of your auto-generated captions.</p>
        </div>

        <div className="grid lg:grid-cols-2 gap-6">
          {/* ── Controls ─────────────────────────────────────────── */}
          <div className="space-y-5">
            {/* Clip selector */}
            <div className="glass rounded-2xl p-5">
              <label className="text-sm font-medium text-foreground mb-3 block">Select Clip</label>
              {isLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading…
                </div>
              ) : !clips?.length ? (
                <p className="text-sm text-muted-foreground">
                  No clips yet.{" "}
                  <a href="/dashboard/highlights" className="underline" style={{ color: "var(--cobalt)" }}>
                    Generate some first.
                  </a>
                </p>
              ) : (
                <select
                  value={selectedClip ?? ""}
                  onChange={e => setSelectedClip(Number(e.target.value) || null)}
                  className="w-full px-3 py-2.5 rounded-xl bg-input border border-border text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                >
                  <option value="">— Choose a clip —</option>
                  {clips.map(c => (
                    <option key={c.id} value={c.id}>{c.title ?? `Clip #${c.id}`}</option>
                  ))}
                </select>
              )}
            </div>

            {/* Typography */}
            <div className="glass rounded-2xl p-5 space-y-4">
              <div className="flex items-center gap-2 mb-1">
                <Type className="w-4 h-4" style={{ color: "var(--cobalt)" }} />
                <span className="text-sm font-semibold text-foreground">Typography</span>
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-2 block">Font Family</label>
                <div className="flex flex-wrap gap-2">
                  {FONTS.map(f => (
                    <button key={f} onClick={() => setFont(f)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${font === f ? "text-white" : "text-muted-foreground hover:text-foreground bg-secondary/60"}`}
                      style={font === f ? { background: "var(--cobalt)" } : {}}
                    >{f}</button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-2 block">
                  Font Size: <span className="text-foreground font-semibold">{fontSize}px</span>
                </label>
                <input type="range" min={32} max={140} value={fontSize} onChange={e => setFontSize(Number(e.target.value))}
                  className="w-full accent-primary" />
              </div>
            </div>

            {/* Colors */}
            <div className="glass rounded-2xl p-5 space-y-4">
              <div className="flex items-center gap-2 mb-1">
                <Palette className="w-4 h-4" style={{ color: "var(--coral)" }} />
                <span className="text-sm font-semibold text-foreground">Colors</span>
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-2 block">Text Color</label>
                <div className="flex gap-2">
                  {COLORS.map(c => (
                    <button key={c.value} onClick={() => setColor(c.value)} title={c.name}
                      className={`w-7 h-7 rounded-full border-2 transition-all ${color === c.value ? "scale-110 border-white" : "border-transparent hover:scale-105"}`}
                      style={{ background: c.value }} />
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-2 block">Highlight Color (active word)</label>
                <div className="flex gap-2">
                  {HIGHLIGHT_COLORS.map(c => (
                    <button key={c.value} onClick={() => setHighlightColor(c.value)} title={c.name}
                      className={`w-7 h-7 rounded-full border-2 transition-all ${highlightColor === c.value ? "scale-110 border-white" : "border-transparent hover:scale-105"}`}
                      style={{ background: c.value }} />
                  ))}
                </div>
              </div>
            </div>

            {/* Position & outline */}
            <div className="glass rounded-2xl p-5 space-y-4">
              <div>
                <label className="text-xs text-muted-foreground mb-2 block">
                  Vertical Position
                  {(posX !== undefined || posY !== undefined) && (
                    <span className="ml-2 text-[10px]" style={{ color: "var(--mint)" }}>
                      (free position — drag in preview)
                    </span>
                  )}
                </label>
                <div className="flex gap-2">
                  {(["top", "center", "bottom"] as const).map(p => (
                    <button key={p} onClick={() => handlePosition(p)}
                      className={`flex-1 py-2 rounded-lg text-xs font-semibold capitalize transition-all ${position === p && posX === undefined ? "text-white" : "text-muted-foreground bg-secondary/60 hover:text-foreground"}`}
                      style={position === p && posX === undefined ? { background: "var(--cobalt)" } : {}}>
                      {p}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center justify-between">
                <label className="text-xs text-muted-foreground">Text Outline (readability)</label>
                <button onClick={() => setOutline(v => !v)}
                  className="w-10 h-5 rounded-full transition-all relative"
                  style={{ background: outline ? "var(--cobalt)" : "var(--secondary)" }}>
                  <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${outline ? "left-5" : "left-0.5"}`} />
                </button>
              </div>
            </div>

            <button onClick={handleSave} disabled={saveSubtitles.isPending || !selectedClip}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl font-semibold text-sm transition-all hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ background: "linear-gradient(135deg, var(--mint), oklch(0.65 0.20 165))", color: "black" }}>
              {saveSubtitles.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Save className="w-4 h-4" /> Save Style</>}
            </button>
          </div>

          {/* ── Preview ──────────────────────────────────────────── */}
          <div className="glass rounded-2xl overflow-hidden">
            <div className="flex items-center gap-2 px-5 py-4 border-b border-border">
              <Eye className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-semibold text-foreground">Live Preview</span>
              <span className="ml-auto text-[11px] text-muted-foreground">Drag the caption to reposition</span>
            </div>
            <div className="p-4 flex flex-col items-center">
              {/* 9:16 preview frame — tall enough to drag comfortably */}
              <div
                className="relative rounded-2xl overflow-hidden w-full"
                style={{
                  maxWidth: "280px",
                  aspectRatio: "9 / 16",
                  background: "linear-gradient(180deg, #0a0a1a 0%, #1a0a2e 100%)",
                  containerType: "size",
                }}
              >
                {/* Fake video content */}
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="text-7xl opacity-20">🎬</div>
                </div>
                {/* Position preset indicators */}
                {posX === undefined && (
                  <div className="absolute inset-x-0 pointer-events-none"
                    style={{ top: position === "top" ? "10%" : position === "center" ? "48%" : "80%", height: 1, background: "rgba(255,255,255,0.12)" }}
                  />
                )}
                {/* Draggable subtitle overlay */}
                <SubtitleOverlay
                  words={SAMPLE_WORDS}
                  activeIndex={activeWord}
                  style={style}
                  positionOverride={posX !== undefined ? { posX, posY } : undefined}
                  onWordClick={i => setActiveWord(i)}
                  onPositionChange={pos => { setPosX(pos.posX); setPosY(pos.posY); }}
                />
              </div>
              <p className="text-xs text-muted-foreground text-center mt-3">
                Click words to preview highlight · Drag caption to reposition freely
              </p>
              {(posX !== undefined || posY !== undefined) && (
                <button
                  onClick={() => { setPosX(undefined); setPosY(undefined); }}
                  className="mt-2 text-[11px] font-semibold px-3 py-1 rounded-lg transition-colors"
                  style={{ background: "rgba(49, 94, 245, 0.08)", color: "var(--cobalt)" }}
                >
                  Reset to {position} preset
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
