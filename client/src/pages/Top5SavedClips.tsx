import { useEffect, useState } from "react";
import AppLayout from "@/components/AppLayout";
import { formatTime } from "@/lib/videoSource";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import {
  X, Play, Zap, Download, Loader2, ChevronUp, ChevronDown,
  Palette, Type, Film, CheckCircle2, Edit3, RotateCcw
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────
interface Slot {
  id: number;
  title: string;
  clipId: number | null;
  duration: string;
  active: boolean;
}

const DEFAULT_SLOTS: Slot[] = [
  { id: 1, title: "", clipId: null, duration: "", active: false },
  { id: 2, title: "", clipId: null, duration: "", active: false },
  { id: 3, title: "", clipId: null, duration: "", active: false },
  { id: 4, title: "", clipId: null, duration: "", active: false },
  { id: 5, title: "", clipId: null, duration: "", active: false },
];

const ACCENT_COLORS = [
  { label: "Electric Blue", value: "#00B4FF" },
  { label: "Neon Green",    value: "#39FF14" },
  { label: "Hot Pink",      value: "#FF2D78" },
  { label: "Gold",          value: "#FFE600" },
  { label: "Purple",        value: "#A855F7" },
];

const BG_GRADIENTS = [
  { label: "Deep Space",  colors: ["#0a0a1a", "#1a0a2e"] },
  { label: "Midnight",    colors: ["#000000", "#0d1117"] },
  { label: "Dark Ocean",  colors: ["#0a1628", "#0d2137"] },
  { label: "Dark Forest", colors: ["#0a1a0a", "#0d2a0d"] },
];

const TITLE_FONTS = ["Montserrat", "Impact", "Arial Black", "Oswald", "Inter"];
const DEFAULT_TITLE = "TOP 5 INSANE MOMENTS";
type LibraryClip = { id: number; title: string | null; startTime: number | null; endTime: number | null };

// ─── 9:16 Preview ─────────────────────────────────────────────────────────────
function ReelPreview({
  slots, title, accentColor, bgGradient, titleFont, activeSlot
}: {
  slots: Slot[]; title: string; accentColor: string; bgGradient: string; titleFont: string; activeSlot: number;
}) {
  return (
    <div className="relative rounded-2xl overflow-hidden mx-auto shadow-2xl"
      style={{ width: "200px", height: "356px", background: bgGradient, border: "1px solid var(--border)" }}>
      {/* Top header */}
      <div className="absolute top-0 left-0 right-0 px-3 pt-3 pb-2 z-10"
        style={{ background: "linear-gradient(180deg, rgba(0,0,0,0.8) 0%, transparent 100%)" }}>
        <div className="text-center">
          <div className="text-[9px] font-black uppercase tracking-widest mb-0.5" style={{ color: accentColor }}>
            ★ TOP 5 ★
          </div>
          <div className="text-[11px] font-black uppercase leading-tight text-white" style={{ fontFamily: titleFont }}>
            {title || "YOUR TITLE HERE"}
          </div>
        </div>
      </div>

      {/* Slot list */}
      <div className="absolute inset-0 flex flex-col justify-center px-2 gap-1 mt-10">
        {slots.map((slot, i) => {
          const isActive = i + 1 === activeSlot;
          const isFilled = slot.active;
          return (
            <div key={slot.id}
              className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg transition-all duration-300"
              style={{
                background: isActive ? `${accentColor}25` : "rgba(255,255,255,0.05)",
                border: isActive ? `1px solid ${accentColor}60` : "1px solid rgba(255,255,255,0.08)",
                transform: isActive ? "scale(1.03)" : "scale(1)",
              }}>
              {/* Number badge */}
              <div className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-black shrink-0"
                style={{ background: isActive ? accentColor : "rgba(255,255,255,0.15)", color: isActive ? "#000" : "#fff" }}>
                {i + 1}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[9px] font-bold text-white truncate leading-tight" style={{ fontFamily: titleFont }}>
                  {isFilled ? slot.title : `Clip ${i + 1}`}
                </div>
                {isFilled && (
                  <div className="text-[8px] text-white/50">{slot.duration}</div>
                )}
              </div>
              {isActive && (
                <div className="w-1.5 h-1.5 rounded-full shrink-0 animate-pulse" style={{ background: accentColor }} />
              )}
              {isFilled && !isActive && (
                <CheckCircle2 className="w-3 h-3 shrink-0" style={{ color: accentColor }} />
              )}
            </div>
          );
        })}
      </div>

      {/* Bottom watermark */}
      <div className="absolute bottom-2 left-0 right-0 text-center">
        <span className="text-[8px] font-bold uppercase tracking-widest" style={{ color: `${accentColor}80` }}>
          ShortsPro AI
        </span>
      </div>
    </div>
  );
}

// ─── Slot Editor Row ──────────────────────────────────────────────────────────
function SlotRow({
  slot, index, accentColor, library, onUpdate, onMoveUp, onMoveDown, isFirst, isLast
}: {
  slot: Slot; index: number; accentColor: string;
  library: LibraryClip[];
  onUpdate: (id: number, data: Partial<Slot>) => void;
  onMoveUp: (id: number) => void; onMoveDown: (id: number) => void;
  isFirst: boolean; isLast: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [localTitle, setLocalTitle] = useState(slot.title);
  const [localClipId, setLocalClipId] = useState(slot.clipId);

  const save = () => {
    const selected = library.find(clip => clip.id === localClipId);
    const title = localTitle.trim();
    if (!title) return;
    onUpdate(slot.id, {
      title, clipId: localClipId, active: true,
      duration: selected ? formatTime(Math.min(60, (selected.endTime ?? 0) - (selected.startTime ?? 0))) : "0:03",
    });
    setEditing(false);
    toast.success(`Slot ${index + 1} updated`);
  };

  const clear = () => {
    setLocalTitle("");
    setLocalClipId(null);
    onUpdate(slot.id, { title: "", clipId: null, duration: "", active: false });
    setEditing(false);
  };

  return (
    <div className="glass rounded-xl overflow-hidden transition-all duration-200 hover:border-primary/20">
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Number */}
        <div className="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-black shrink-0"
          style={{ background: `${accentColor}22`, color: accentColor }}>
          {index + 1}
        </div>
        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-foreground truncate">
            {slot.active ? slot.title : <span className="text-muted-foreground italic">Empty slot — click Edit to add</span>}
          </div>
          {slot.active && <div className="text-xs text-muted-foreground">{slot.clipId ? slot.duration : "Title card · 3 seconds"}</div>}
        </div>
        {/* Status */}
        {slot.active && <CheckCircle2 className="w-4 h-4 shrink-0" style={{ color: "var(--mint)" }} />}
        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          <button aria-label={`Move slot ${index + 1} up`} onClick={() => onMoveUp(slot.id)} disabled={isFirst}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors disabled:opacity-30">
            <ChevronUp className="w-3.5 h-3.5" />
          </button>
          <button aria-label={`Move slot ${index + 1} down`} onClick={() => onMoveDown(slot.id)} disabled={isLast}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors disabled:opacity-30">
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
          <button aria-label={`Edit slot ${index + 1}`} onClick={() => { setLocalTitle(slot.title); setLocalClipId(slot.clipId); setEditing(v => !v); }}
            className="p-1.5 rounded-lg transition-colors hover:bg-secondary/60"
            style={{ color: editing ? accentColor : "var(--muted-foreground)" }}>
            <Edit3 className="w-3.5 h-3.5" />
          </button>
          {slot.active && (
            <button aria-label={`Clear slot ${index + 1}`} onClick={clear}
              className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
      {/* Inline editor */}
      {editing && (
        <div className="px-4 pb-4 pt-1 border-t border-border space-y-3 animate-slide-up">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block" htmlFor={`slot-title-${slot.id}`}>Clip Title</label>
            <input id={`slot-title-${slot.id}`} type="text" value={localTitle} maxLength={120} onChange={e => setLocalTitle(e.target.value)}
              placeholder="e.g. The Most Shocking Moment"
              className="w-full px-3 py-2 rounded-lg bg-input border border-border text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-all" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block" htmlFor={`slot-source-${slot.id}`}>Source</label>
            <select id={`slot-source-${slot.id}`} value={localClipId ?? ""}
              onChange={e => {
                const id = e.target.value ? Number(e.target.value) : null;
                setLocalClipId(id);
                if (!localTitle.trim()) setLocalTitle(library.find(clip => clip.id === id)?.title?.slice(0, 120) ?? "");
              }}
              className="w-full px-3 py-2 rounded-lg bg-input border border-border text-foreground text-sm">
              <option value="">Title card</option>
              {library.map(clip => <option key={clip.id} value={clip.id}>{clip.title ?? "Untitled clip"}</option>)}
            </select>
            {library.length === 0 && <p className="mt-1 text-xs text-muted-foreground">Render a clip to add it from your library.</p>}
          </div>
          <div className="flex gap-2">
            <button onClick={save} disabled={!localTitle.trim()}
              className="flex-1 py-2 rounded-lg text-xs font-bold text-white transition-all hover:opacity-80 disabled:opacity-40"
              style={{ background: accentColor }}>
              Save
            </button>
            <button onClick={() => setEditing(false)}
              className="px-4 py-2 rounded-lg text-xs font-semibold text-muted-foreground bg-secondary/60 hover:text-foreground transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function Top5SavedClipsPage() {
  const [slots, setSlots] = useState<Slot[]>(DEFAULT_SLOTS);
  const [reelTitle, setReelTitle] = useState(DEFAULT_TITLE);
  const [accentColor, setAccentColor] = useState("#00B4FF");
  const [background, setBackground] = useState(BG_GRADIENTS[0]);
  const [titleFont, setTitleFont] = useState("Montserrat");
  const [activeSlot, setActiveSlot] = useState(1);
  const [rendering, setRendering] = useState(false);
  const [output, setOutput] = useState<{ url: string; options: string; expiresAt: number } | null>(null);
  const { data: clips = [] } = trpc.clips.list.useQuery();
  const library: LibraryClip[] = clips.filter(clip => clip.status === "done" && clip.downloadUrl);
  const reelSlots = slots.flatMap((slot, index) => slot.active
    ? [{ rank: index + 1, title: slot.title, clipId: slot.clipId }]
    : []);
  const options = JSON.stringify({ title: reelTitle, accent: accentColor, background: background.colors, font: titleFont, slots: reelSlots });
  const download = output?.options === options ? output.url : null;
  const bgGradient = `linear-gradient(180deg, ${background.colors[0]}, ${background.colors[1]})`;

  useEffect(() => {
    if (!output) return;
    const timer = setTimeout(() => setOutput(null), Math.max(0, output.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [output]);

  // Auto-cycle active slot for preview animation
  const cycleSlot = () => setActiveSlot(prev => prev >= 5 ? 1 : prev + 1);

  const updateSlot = (id: number, data: Partial<Slot>) => {
    setSlots(prev => prev.map(s => s.id === id ? { ...s, ...data } : s));
  };

  const moveUp = (id: number) => {
    setSlots(prev => {
      const idx = prev.findIndex(s => s.id === id);
      if (idx <= 0) return prev;
      const next = [...prev];
      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
      return next;
    });
  };

  const moveDown = (id: number) => {
    setSlots(prev => {
      const idx = prev.findIndex(s => s.id === id);
      if (idx >= prev.length - 1) return prev;
      const next = [...prev];
      [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
      return next;
    });
  };

  const handleRender = async () => {
    setRendering(true);
    try {
      const response = await fetch("/api/reels/render", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: options,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.url) throw new Error(data?.error ?? "Couldn’t render this reel.");
      setOutput({ url: data.url, options, expiresAt: data.expiresAt });
      toast.success("Reel ready to download.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn’t render this reel.");
    } finally {
      setRendering(false);
    }
  };

  const reset = () => {
    setSlots(DEFAULT_SLOTS);
    setReelTitle(DEFAULT_TITLE);
    setAccentColor(ACCENT_COLORS[0].value);
    setBackground(BG_GRADIENTS[0]);
    setTitleFont(TITLE_FONTS[0]);
    setActiveSlot(1);
    setOutput(null);
  };

  const filledCount = slots.filter(s => s.active).length;

  return (
    <AppLayout title="Top 5 Reels">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-2xl font-black text-foreground mb-1" style={{ fontFamily: "Montserrat, sans-serif" }}>
              Top 5 Reels Template
            </h2>
            <p className="text-sm text-muted-foreground">Build a viral "Top 5" countdown reel with a 9:16 vertical format.</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={reset} disabled={rendering} className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors">
              <RotateCcw className="w-3.5 h-3.5" /> Reset
            </button>
            {download ? (
              <a href={download} download
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold transition-all hover:opacity-80 glow-green"
                style={{ background: "rgba(89, 164, 133, 0.1)", color: "var(--mint)" }}>
                <Download className="w-4 h-4" /> Download Reel
              </a>
            ) : (
              <button onClick={handleRender} disabled={rendering || filledCount === 0 || !reelTitle.trim()}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold text-white transition-all hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed glow-blue"
                style={{ background: "linear-gradient(135deg, var(--cobalt), oklch(0.55 0.22 270))" }}>
                {rendering ? <><Loader2 className="w-4 h-4 animate-spin" /> Rendering…</> : <><Zap className="w-4 h-4" /> Render Reel</>}
              </button>
            )}
          </div>
        </div>

        <div className="grid lg:grid-cols-3 gap-6">
          {/* Left: Slot editor */}
          <div className="lg:col-span-2 space-y-4">
            {/* Reel title */}
            <div className="glass rounded-2xl p-5">
              <label className="text-sm font-medium text-foreground mb-2 block">Reel Title</label>
              <input type="text" value={reelTitle} maxLength={100} onChange={e => setReelTitle(e.target.value)}
                placeholder="TOP 5 INSANE MOMENTS"
                className="w-full px-4 py-3 rounded-xl bg-input border border-border text-foreground text-sm font-bold uppercase focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-all" />
            </div>

            {/* Slots */}
            <div className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <span className="text-sm font-semibold text-foreground">Clip Slots</span>
                <span className="text-xs text-muted-foreground">{filledCount}/5 filled</span>
              </div>
              {slots.map((slot, i) => (
                <SlotRow key={slot.id} slot={slot} index={i} accentColor={accentColor} library={library}
                  onUpdate={updateSlot} onMoveUp={moveUp} onMoveDown={moveDown}
                  isFirst={i === 0} isLast={i === slots.length - 1} />
              ))}
            </div>

            {/* Style controls */}
            <div className="glass rounded-2xl p-5 space-y-5">
              <span className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Palette className="w-4 h-4" style={{ color: "var(--coral)" }} /> Style
              </span>
              {/* Accent color */}
              <div>
                <label className="text-xs text-muted-foreground mb-2 block">Accent Color</label>
                <div className="flex gap-2 flex-wrap">
                  {ACCENT_COLORS.map(c => (
                    <button key={c.value} onClick={() => setAccentColor(c.value)} title={c.label}
                      className={`w-8 h-8 rounded-full border-2 transition-all ${accentColor === c.value ? "scale-110 border-white shadow-lg" : "border-transparent hover:scale-105"}`}
                      style={{ background: c.value }} />
                  ))}
                </div>
              </div>
              {/* Background */}
              <div>
                <label className="text-xs text-muted-foreground mb-2 block">Background</label>
                <div className="grid grid-cols-4 gap-2">
                  {BG_GRADIENTS.map(g => (
                    <button key={g.label} onClick={() => setBackground(g)}
                      className={`h-10 rounded-lg border-2 transition-all ${background.label === g.label ? "border-white scale-105" : "border-transparent hover:border-border"}`}
                      style={{ background: `linear-gradient(180deg, ${g.colors[0]}, ${g.colors[1]})` }} title={g.label} />
                  ))}
                </div>
              </div>
              {/* Title font */}
              <div>
                <label className="text-xs text-muted-foreground mb-2 block flex items-center gap-1"><Type className="w-3 h-3" /> Title Font</label>
                <div className="flex flex-wrap gap-2">
                  {TITLE_FONTS.map(f => (
                    <button key={f} onClick={() => setTitleFont(f)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${titleFont === f ? "text-white" : "text-muted-foreground bg-secondary/60 hover:text-foreground"}`}
                      style={titleFont === f ? { background: accentColor } : {}}>{f}</button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Right: Preview */}
          <div className="space-y-4">
            <div className="glass rounded-2xl p-5 flex flex-col items-center gap-4">
              <div className="flex items-center justify-between w-full">
                <span className="text-sm font-semibold text-foreground">9:16 Preview</span>
                <button onClick={cycleSlot}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors hover:bg-secondary/60"
                  style={{ color: accentColor }}>
                  <Play className="w-3 h-3" /> Animate
                </button>
              </div>
              <ReelPreview slots={slots} title={reelTitle} accentColor={accentColor} bgGradient={bgGradient} titleFont={titleFont} activeSlot={activeSlot} />
              <p className="text-xs text-muted-foreground text-center">Click Animate to cycle through slots</p>
            </div>

            {/* Info card */}
            <div className="glass rounded-2xl p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Film className="w-4 h-4" style={{ color: "var(--cobalt)" }} />
                <span className="text-sm font-semibold text-foreground">Format Info</span>
              </div>
              {[
                { label: "Aspect Ratio", value: "9:16 (Vertical)" },
                { label: "Resolution",  value: "1080 × 1920" },
                { label: "Format",      value: "MP4 / H.264" },
                { label: "Platforms",   value: "TikTok, Reels, Shorts" },
              ].map(r => (
                <div key={r.label} className="flex justify-between text-xs">
                  <span className="text-muted-foreground">{r.label}</span>
                  <span className="text-foreground font-medium">{r.value}</span>
                </div>
              ))}
            </div>

            {/* Render status */}
            {download && (
              <div className="glass rounded-2xl p-4 animate-scale-in" style={{ border: "1px solid oklch(0.75 0.20 145 / 0.4)" }}>
                <div className="flex items-center gap-2 mb-2">
                  <CheckCircle2 className="w-4 h-4" style={{ color: "var(--mint)" }} />
                  <span className="text-sm font-semibold" style={{ color: "var(--mint)" }}>Ready to download</span>
                </div>
                <p className="text-xs text-muted-foreground">The download is available for one hour.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
