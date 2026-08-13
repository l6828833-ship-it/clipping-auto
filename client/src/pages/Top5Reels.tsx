import { useState } from "react";
import AppLayout from "@/components/AppLayout";
import { toast } from "sonner";
import {
  Plus, X, Play, Zap, Download, Loader2, ChevronUp, ChevronDown,
  Palette, Type, Music, Film, CheckCircle2, Edit3, RotateCcw
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────
interface Slot {
  id: number;
  title: string;
  url: string;
  duration: string;
  active: boolean;
}

const DEFAULT_SLOTS: Slot[] = [
  { id: 1, title: "Slot 1 — Add clip", url: "", duration: "0:00", active: false },
  { id: 2, title: "Slot 2 — Add clip", url: "", duration: "0:00", active: false },
  { id: 3, title: "Slot 3 — Add clip", url: "", duration: "0:00", active: false },
  { id: 4, title: "Slot 4 — Add clip", url: "", duration: "0:00", active: false },
  { id: 5, title: "Slot 5 — Add clip", url: "", duration: "0:00", active: false },
];

const ACCENT_COLORS = [
  { label: "Electric Blue", value: "#00B4FF" },
  { label: "Neon Green",    value: "#39FF14" },
  { label: "Hot Pink",      value: "#FF2D78" },
  { label: "Gold",          value: "#FFE600" },
  { label: "Purple",        value: "#A855F7" },
];

const BG_GRADIENTS = [
  { label: "Deep Space",  value: "linear-gradient(180deg, #0a0a1a 0%, #1a0a2e 100%)" },
  { label: "Midnight",    value: "linear-gradient(180deg, #000000 0%, #0d1117 100%)" },
  { label: "Dark Ocean",  value: "linear-gradient(180deg, #0a1628 0%, #0d2137 100%)" },
  { label: "Dark Forest", value: "linear-gradient(180deg, #0a1a0a 0%, #0d2a0d 100%)" },
];

const TITLE_FONTS = ["Montserrat", "Impact", "Arial Black", "Oswald", "Inter"];

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
  slot, index, accentColor, onUpdate, onMoveUp, onMoveDown, isFirst, isLast
}: {
  slot: Slot; index: number; accentColor: string;
  onUpdate: (id: number, data: Partial<Slot>) => void;
  onMoveUp: (id: number) => void; onMoveDown: (id: number) => void;
  isFirst: boolean; isLast: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [localTitle, setLocalTitle] = useState(slot.title);
  const [localUrl, setLocalUrl] = useState(slot.url);

  const save = () => {
    onUpdate(slot.id, { title: localTitle, url: localUrl, active: localTitle.trim() !== "" && localTitle !== `Slot ${index + 1} — Add clip` });
    setEditing(false);
    toast.success(`Slot ${index + 1} updated`);
  };

  const clear = () => {
    const def = `Slot ${index + 1} — Add clip`;
    setLocalTitle(def);
    setLocalUrl("");
    onUpdate(slot.id, { title: def, url: "", active: false });
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
          {slot.url && <div className="text-xs text-muted-foreground truncate">{slot.url}</div>}
        </div>
        {/* Status */}
        {slot.active && <CheckCircle2 className="w-4 h-4 shrink-0" style={{ color: "var(--mint)" }} />}
        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={() => onMoveUp(slot.id)} disabled={isFirst}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors disabled:opacity-30">
            <ChevronUp className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => onMoveDown(slot.id)} disabled={isLast}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors disabled:opacity-30">
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => setEditing(v => !v)}
            className="p-1.5 rounded-lg transition-colors hover:bg-secondary/60"
            style={{ color: editing ? accentColor : "var(--muted-foreground)" }}>
            <Edit3 className="w-3.5 h-3.5" />
          </button>
          {slot.active && (
            <button onClick={clear}
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
            <label className="text-xs text-muted-foreground mb-1 block">Clip Title</label>
            <input type="text" value={localTitle} onChange={e => setLocalTitle(e.target.value)}
              placeholder="e.g. The Most Shocking Moment"
              className="w-full px-3 py-2 rounded-lg bg-input border border-border text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-all" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Video URL or file path</label>
            <input type="text" value={localUrl} onChange={e => setLocalUrl(e.target.value)}
              placeholder="https://... or leave blank for placeholder"
              className="w-full px-3 py-2 rounded-lg bg-input border border-border text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-all" />
          </div>
          <div className="flex gap-2">
            <button onClick={save}
              className="flex-1 py-2 rounded-lg text-xs font-bold text-white transition-all hover:opacity-80"
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
export default function Top5ReelsPage() {
  const [slots, setSlots] = useState<Slot[]>(DEFAULT_SLOTS);
  const [reelTitle, setReelTitle] = useState("TOP 5 INSANE MOMENTS");
  const [accentColor, setAccentColor] = useState("#00B4FF");
  const [bgGradient, setBgGradient] = useState(BG_GRADIENTS[0].value);
  const [titleFont, setTitleFont] = useState("Montserrat");
  const [activeSlot, setActiveSlot] = useState(1);
  const [rendering, setRendering] = useState(false);
  const [rendered, setRendered] = useState(false);

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

  const handleRender = () => {
    setRendering(true);
    setTimeout(() => { setRendering(false); setRendered(true); toast.success("Top 5 Reel rendered and ready!"); }, 3000);
  };

  const reset = () => { setSlots(DEFAULT_SLOTS); setRendered(false); toast.info("Reset to defaults"); };

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
            <button onClick={reset} className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors">
              <RotateCcw className="w-3.5 h-3.5" /> Reset
            </button>
            {rendered ? (
              <a href="#" onClick={e => { e.preventDefault(); toast.info("In production, this downloads the rendered Top 5 Reel."); }}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold transition-all hover:opacity-80 glow-green"
                style={{ background: "rgba(89, 164, 133, 0.1)", color: "var(--mint)" }}>
                <Download className="w-4 h-4" /> Download Reel
              </a>
            ) : (
              <button onClick={handleRender} disabled={rendering || filledCount === 0}
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
              <input type="text" value={reelTitle} onChange={e => setReelTitle(e.target.value)}
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
                <SlotRow key={slot.id} slot={slot} index={i} accentColor={accentColor}
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
                    <button key={g.label} onClick={() => setBgGradient(g.value)}
                      className={`h-10 rounded-lg border-2 transition-all ${bgGradient === g.value ? "border-white scale-105" : "border-transparent hover:border-border"}`}
                      style={{ background: g.value }} title={g.label} />
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
            {rendered && (
              <div className="glass rounded-2xl p-4 animate-scale-in" style={{ border: "1px solid oklch(0.75 0.20 145 / 0.4)" }}>
                <div className="flex items-center gap-2 mb-2">
                  <CheckCircle2 className="w-4 h-4" style={{ color: "var(--mint)" }} />
                  <span className="text-sm font-semibold" style={{ color: "var(--mint)" }}>Ready to download</span>
                </div>
                <p className="text-xs text-muted-foreground">Your Top 5 Reel has been rendered with all {filledCount} clips and your custom style.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
