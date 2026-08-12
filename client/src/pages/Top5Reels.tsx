import { useEffect, useMemo, useState } from "react";
import AppLayout from "@/components/AppLayout";
import { toast } from "sonner";
import {
  Check,
  Download,
  Play,
  RotateCcw,
  Sparkles,
  TimerReset,
} from "lucide-react";

interface RankItem {
  id: number;
  rank: number;
  text: string;
}

const DEFAULT_RANKS: RankItem[] = [
  { id: 5, rank: 5, text: "Fifth moment" },
  { id: 4, rank: 4, text: "Fourth moment" },
  { id: 3, rank: 3, text: "Third moment" },
  { id: 2, rank: 2, text: "Second moment" },
  { id: 1, rank: 1, text: "Best moment" },
];

const ACCENT_COLORS = [
  { name: "Signal red", value: "#ef4444" },
  { name: "Acid green", value: "#a3e635" },
  { name: "Electric blue", value: "#38bdf8" },
  { name: "Gold", value: "#facc15" },
  { name: "Violet", value: "#a78bfa" },
];

function splitHeadline(title: string, accentWord: string) {
  const cleanTitle = title.trim() || "YOUR TOP 5";
  const cleanAccent = accentWord.trim();

  if (!cleanAccent) {
    return <span>{cleanTitle}</span>;
  }

  const expression = new RegExp(`(${cleanAccent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig");
  return cleanTitle.split(expression).map((part, index) =>
    part.toLowerCase() === cleanAccent.toLowerCase() ? (
      <span key={`${part}-${index}`} className="text-[var(--rank-accent)]">{part}</span>
    ) : (
      <span key={`${part}-${index}`}>{part}</span>
    ),
  );
}

function TextOnlyPreview({
  title,
  accentWord,
  accentColor,
  ranks,
  activeRank,
}: {
  title: string;
  accentWord: string;
  accentColor: string;
  ranks: RankItem[];
  activeRank: number | null;
}) {
  return (
    <div
      className="relative isolate aspect-[9/16] w-full max-w-[280px] overflow-hidden rounded-[1.75rem] bg-black text-white shadow-2xl"
      style={{ "--rank-accent": accentColor } as React.CSSProperties}
    >
      <div className="absolute inset-x-0 top-0 h-1 bg-[var(--rank-accent)]" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_83%_16%,rgba(255,255,255,0.10),transparent_26%),linear-gradient(180deg,#090909_0%,#000_74%)]" />

      <div className="relative flex h-full flex-col px-[10%] pb-[9%] pt-[12%]">
        <p className="mb-2 font-mono text-[8px] font-semibold uppercase tracking-[0.28em] text-white/55">
          COUNTDOWN
        </p>
        <h3 className="max-w-full text-[25px] font-black uppercase leading-[0.91] tracking-[-0.075em]">
          {splitHeadline(title, accentWord)}
        </h3>

        <div className="mt-auto space-y-3.5">
          {ranks.map((item) => {
            const active = activeRank === item.rank;
            return (
              <div
                key={item.id}
                className="group flex items-center gap-3 transition-all duration-300"
                style={{
                  opacity: activeRank === null || active ? 1 : 0.42,
                  transform: active ? "translateX(4px)" : "translateX(0)",
                }}
              >
                <span
                  className="w-[29px] shrink-0 text-center text-[42px] font-black leading-none tracking-[-0.12em]"
                  style={{
                    color: active ? accentColor : "transparent",
                    WebkitTextStroke: active ? "0" : "1.5px rgba(255,255,255,0.96)",
                    textShadow: active ? `0 0 20px ${accentColor}75` : "none",
                  }}
                >
                  {item.rank}
                </span>
                <span className="min-w-0 text-[16px] font-extrabold uppercase leading-tight tracking-[-0.04em] text-white">
                  {item.text.trim() || `Rank ${item.rank}`}
                </span>
              </div>
            );
          })}
        </div>

        <div className="mt-7 flex items-center gap-2 font-mono text-[7px] font-medium uppercase tracking-[0.2em] text-white/38">
          <span className="h-px flex-1 bg-white/15" />
          TEXT ONLY TEMPLATE
          <span className="h-px flex-1 bg-white/15" />
        </div>
      </div>
    </div>
  );
}

export default function Top5ReelsPage() {
  const [ranks, setRanks] = useState<RankItem[]>(DEFAULT_RANKS);
  const [title, setTitle] = useState("TOP 5 INSANE MOMENTS");
  const [accentWord, setAccentWord] = useState("INSANE");
  const [accentColor, setAccentColor] = useState("#a3e635");
  const [activeRank, setActiveRank] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  const completedCount = useMemo(
    () => ranks.filter((item) => item.text.trim().length > 0).length,
    [ranks],
  );

  useEffect(() => {
    if (!isPlaying) return;

    let step = 0;
    const orderedRanks = ranks.map((item) => item.rank);
    setActiveRank(orderedRanks[0] ?? null);

    const interval = window.setInterval(() => {
      step += 1;
      if (step >= orderedRanks.length) {
        window.clearInterval(interval);
        setIsPlaying(false);
        setActiveRank(null);
        return;
      }
      setActiveRank(orderedRanks[step]);
    }, 950);

    return () => window.clearInterval(interval);
  }, [isPlaying, ranks]);

  const updateRank = (id: number, text: string) => {
    setRanks((current) => current.map((item) => (item.id === id ? { ...item, text } : item)));
  };

  const reset = () => {
    setRanks(DEFAULT_RANKS);
    setTitle("TOP 5 INSANE MOMENTS");
    setAccentWord("INSANE");
    setAccentColor("#a3e635");
    setActiveRank(null);
    setIsPlaying(false);
    toast.info("The Top 5 layout has been reset.");
  };

  const downloadLayout = () => {
    const layout = {
      template: "minimal-text-top-5",
      aspectRatio: "9:16",
      title,
      accentWord,
      accentColor,
      order: ranks.map(({ rank, text }) => ({ rank, text })),
    };
    const blob = new Blob([JSON.stringify(layout, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "top-5-text-layout.json";
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success("Top 5 text layout saved.");
  };

  return (
    <AppLayout title="Top 5 Reels">
      <div className="mx-auto max-w-6xl">
        <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2 font-mono text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5" style={{ color: accentColor }} />
              Minimal text template
            </div>
            <h2 className="text-3xl font-black tracking-[-0.06em] text-foreground sm:text-4xl">
              Top 5 Countdown
            </h2>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Create a clean 5-to-1 ranking overlay with only headline text, numbered rows, and one accent color.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={reset}
              className="inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset
            </button>
            <button
              type="button"
              onClick={downloadLayout}
              className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2.5 text-sm font-bold text-foreground transition-colors hover:border-foreground/25"
            >
              <Download className="h-4 w-4" />
              Save layout
            </button>
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <section className="space-y-5">
            <div className="glass rounded-2xl p-5 sm:p-6">
              <div className="mb-5 flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-bold text-foreground">Copy</p>
                  <p className="mt-1 text-xs text-muted-foreground">Keep every line short so it stays legible in a vertical short.</p>
                </div>
                <span className="rounded-full bg-secondary px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  {completedCount}/5 rows
                </span>
              </div>

              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_180px]">
                <label className="block">
                  <span className="mb-2 block text-xs font-semibold text-foreground">Headline</span>
                  <input
                    value={title}
                    onChange={(event) => setTitle(event.target.value.toUpperCase())}
                    maxLength={56}
                    placeholder="TOP 5 INSANE MOMENTS"
                    className="w-full rounded-xl border border-border bg-input px-3.5 py-3 text-sm font-bold uppercase tracking-[-0.02em] text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
                  />
                </label>
                <label className="block">
                  <span className="mb-2 block text-xs font-semibold text-foreground">Accent word</span>
                  <input
                    value={accentWord}
                    onChange={(event) => setAccentWord(event.target.value.toUpperCase())}
                    maxLength={18}
                    placeholder="INSANE"
                    className="w-full rounded-xl border border-border bg-input px-3.5 py-3 text-sm font-bold uppercase tracking-[-0.02em] text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
                  />
                </label>
              </div>
            </div>

            <div className="glass rounded-2xl p-5 sm:p-6">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-bold text-foreground">Countdown lines</p>
                  <p className="mt-1 text-xs text-muted-foreground">The order is locked from 5 down to 1 for a natural reveal.</p>
                </div>
                <TimerReset className="h-4 w-4" style={{ color: accentColor }} />
              </div>

              <div className="divide-y divide-border rounded-xl border border-border bg-card">
                {ranks.map((item) => (
                  <label key={item.id} className="flex items-center gap-4 px-4 py-3.5 transition-colors focus-within:bg-secondary/35">
                    <span
                      className="w-9 text-center text-3xl font-black leading-none tracking-[-0.12em]"
                      style={{ color: item.rank === 1 ? accentColor : "var(--foreground)" }}
                    >
                      {item.rank}
                    </span>
                    <input
                      value={item.text}
                      onChange={(event) => updateRank(item.id, event.target.value)}
                      maxLength={42}
                      placeholder={`Rank ${item.rank} text`}
                      className="min-w-0 flex-1 bg-transparent py-1 text-sm font-bold uppercase tracking-[-0.02em] text-foreground outline-none placeholder:text-muted-foreground/55"
                    />
                    {item.text.trim() && <Check className="h-4 w-4 shrink-0" style={{ color: accentColor }} />}
                  </label>
                ))}
              </div>
            </div>

            <div className="glass rounded-2xl p-5 sm:p-6">
              <p className="mb-3 text-sm font-bold text-foreground">Accent</p>
              <div className="flex flex-wrap gap-2.5">
                {ACCENT_COLORS.map((color) => (
                  <button
                    key={color.value}
                    type="button"
                    onClick={() => setAccentColor(color.value)}
                    title={color.name}
                    aria-label={`Use ${color.name} accent`}
                    className="flex items-center gap-2 rounded-full border px-3 py-2 text-xs font-semibold transition-all"
                    style={{
                      borderColor: accentColor === color.value ? color.value : "var(--border)",
                      background: accentColor === color.value ? `${color.value}18` : "transparent",
                      color: accentColor === color.value ? color.value : "var(--muted-foreground)",
                    }}
                  >
                    <span className="h-3 w-3 rounded-full" style={{ background: color.value }} />
                    {color.name}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <aside className="lg:sticky lg:top-6 lg:h-fit">
            <div className="glass rounded-2xl p-5">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <p className="text-sm font-bold text-foreground">Live preview</p>
                  <p className="mt-1 text-xs text-muted-foreground">1080 × 1920 composition</p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsPlaying((current) => !current)}
                  className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold text-black transition-transform hover:scale-[1.02]"
                  style={{ background: accentColor }}
                >
                  <Play className="h-3.5 w-3.5 fill-current" />
                  {isPlaying ? "Playing" : "Preview"}
                </button>
              </div>

              <div className="mx-auto flex justify-center">
                <TextOnlyPreview
                  title={title}
                  accentWord={accentWord}
                  accentColor={accentColor}
                  ranks={ranks}
                  activeRank={activeRank}
                />
              </div>

              <div className="mt-4 rounded-xl border border-border bg-secondary/35 p-3 text-xs leading-relaxed text-muted-foreground">
                <strong className="font-semibold text-foreground">Text-only by design.</strong> This template leaves the video fully visible and adds no image card, background image, or decorative clip panel.
              </div>
            </div>
          </aside>
        </div>
      </div>
    </AppLayout>
  );
}
