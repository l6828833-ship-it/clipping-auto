import { Link } from "wouter";
import { useTheme } from "@/contexts/ThemeContext";
import {
  ArrowRight, Zap, Sparkles, Film, Upload, Play,
  CheckCircle2, Sun, Moon, Scissors, Clock, TrendingUp,
  ChevronRight, Star,
} from "lucide-react";

const FEATURES = [
  {
    icon: Upload,
    title: "Upload or Paste URL",
    desc: "Drop a long-form video or paste a YouTube link. We handle the rest.",
    color: "var(--cobalt)",
  },
  {
    icon: Sparkles,
    title: "AI Highlight Detection",
    desc: "Our AI finds the most engaging moments — hooks, insights, emotional peaks.",
    color: "var(--coral)",
  },
  {
    icon: Scissors,
    title: "Auto Clip & Subtitle",
    desc: "Clips are generated in 9:16 format with word-level animated captions.",
    color: "var(--mint)",
  },
  {
    icon: TrendingUp,
    title: "Ready to Post",
    desc: "Download vertical shorts ready for TikTok, Reels, and YouTube Shorts.",
    color: "var(--amber)",
  },
];

const STEPS = [
  { num: "01", title: "Upload your video", desc: "Drag a file or paste any YouTube URL" },
  { num: "02", title: "AI does the work", desc: "Highlights detected, subtitles generated" },
  { num: "03", title: "Download clips", desc: "Vertical shorts ready in minutes" },
];

export default function Home() {
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* ─── Header ─────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 border-b border-border bg-background/90 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-5 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "var(--cobalt)" }}>
              <Zap className="w-4 h-4 text-white" />
            </div>
            <span className="text-base font-black tracking-tight">ShortsPro AI</span>
          </Link>

          <nav className="hidden md:flex items-center gap-8 text-sm text-muted-foreground">
            <a href="#features" className="hover:text-foreground transition-colors">Features</a>
            <a href="#how-it-works" className="hover:text-foreground transition-colors">How it works</a>
            <a href="#pricing" className="hover:text-foreground transition-colors">Pricing</a>
          </nav>

          <div className="flex items-center gap-3">
            <button
              onClick={toggleTheme}
              className="w-9 h-9 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
              title={theme === "dark" ? "Light mode" : "Dark mode"}
            >
              {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
            <Link href="/login" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
              Log in
            </Link>
            <Link href="/register">
              <button className="ink-button">
                Get started <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </Link>
          </div>
        </div>
      </header>

      {/* ─── Hero ───────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden">
        {/* Grid background */}
        <div className="absolute inset-0 pointer-events-none opacity-30"
          style={{
            backgroundImage: "linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px)",
            backgroundSize: "14px 14px",
            maskImage: "radial-gradient(ellipse at center, black 8%, transparent 65%)",
            WebkitMaskImage: "radial-gradient(ellipse at center, black 8%, transparent 65%)",
          }}
        />

        <div className="relative max-w-4xl mx-auto px-5 pt-24 pb-20 text-center">
          <span className="eyebrow mb-4 inline-block">AI-powered video clipping</span>
          <h1 className="text-5xl md:text-7xl font-black tracking-tight leading-[0.92] mb-5">
            Turn long videos into{" "}
            <span className="gradient-text">viral shorts.</span>
          </h1>
          <p className="text-lg text-muted-foreground max-w-xl mx-auto mb-8 leading-relaxed">
            Upload any video. Our AI finds the best moments, adds subtitles, and exports ready-to-post 9:16 clips in minutes.
          </p>
          <div className="flex items-center justify-center gap-4 flex-wrap">
            <Link href="/register">
              <button className="ink-button ink-button-large">
                Start creating free <ArrowRight className="w-4 h-4" />
              </button>
            </Link>
            <a href="#how-it-works" className="inline-flex items-center gap-2 text-sm font-semibold text-muted-foreground hover:text-foreground transition-colors">
              <Play className="w-4 h-4" /> See how it works
            </a>
          </div>

          {/* Stats strip */}
          <div className="mt-16 flex items-center justify-center gap-8 md:gap-14 text-center">
            {[
              { value: "10K+", label: "Clips created" },
              { value: "< 2min", label: "Avg. processing" },
              { value: "95%", label: "Accuracy" },
            ].map(s => (
              <div key={s.label}>
                <div className="text-2xl font-black text-foreground">{s.value}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── Features ───────────────────────────────────────────────────── */}
      <section id="features" className="max-w-5xl mx-auto px-5 py-24">
        <div className="text-center mb-14">
          <span className="eyebrow mb-3 inline-block">What you get</span>
          <h2 className="text-3xl md:text-5xl font-black tracking-tight leading-tight">
            Everything to go from raw footage<br className="hidden md:block" /> to <span className="gradient-text">viral content.</span>
          </h2>
        </div>

        <div className="grid md:grid-cols-2 gap-5">
          {FEATURES.map(f => (
            <div key={f.title} className="glass rounded-2xl p-6 hover:border-primary/20 transition-colors group">
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center mb-4 transition-transform group-hover:scale-105"
                style={{ background: `color-mix(in srgb, ${f.color} 12%, transparent)` }}
              >
                <f.icon className="w-5 h-5" style={{ color: f.color }} />
              </div>
              <h3 className="text-base font-bold text-foreground mb-1.5">{f.title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ─── How it works ───────────────────────────────────────────────── */}
      <section id="how-it-works" className="bg-secondary/40 border-y border-border">
        <div className="max-w-5xl mx-auto px-5 py-24">
          <div className="text-center mb-14">
            <span className="eyebrow mb-3 inline-block">Simple workflow</span>
            <h2 className="text-3xl md:text-5xl font-black tracking-tight">
              Three steps to <span className="gradient-text">done.</span>
            </h2>
          </div>

          <div className="grid md:grid-cols-3 gap-6">
            {STEPS.map(step => (
              <div key={step.num} className="glass rounded-2xl p-6">
                <span className="text-xs font-mono text-muted-foreground">{step.num}</span>
                <h3 className="text-lg font-bold text-foreground mt-3 mb-2">{step.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── Social proof ───────────────────────────────────────────────── */}
      <section className="max-w-4xl mx-auto px-5 py-24 text-center">
        <div className="flex items-center justify-center gap-1 mb-4">
          {[1,2,3,4,5].map(i => <Star key={i} className="w-5 h-5 fill-current" style={{ color: "var(--amber)" }} />)}
        </div>
        <blockquote className="text-xl md:text-2xl font-bold text-foreground leading-snug max-w-2xl mx-auto mb-4">
          "I used to spend 3 hours editing each short. Now I get 5 clips in under 10 minutes. Game changer."
        </blockquote>
        <p className="text-sm text-muted-foreground">— Content creator, 500K+ followers</p>
      </section>

      {/* ─── CTA ────────────────────────────────────────────────────────── */}
      <section id="pricing" className="border-t border-border">
        <div className="max-w-3xl mx-auto px-5 py-24 text-center">
          <span className="eyebrow mb-3 inline-block">Ready to start?</span>
          <h2 className="text-3xl md:text-5xl font-black tracking-tight mb-4">
            Create your first clip<br className="hidden md:block" /> in minutes.
          </h2>
          <p className="text-muted-foreground mb-8 max-w-md mx-auto">
            Free to start. No credit card required. Upload your first video and see the magic.
          </p>
          <Link href="/register">
            <button className="ink-button ink-button-large">
              Start clipping free <ArrowRight className="w-4 h-4" />
            </button>
          </Link>
        </div>
      </section>

      {/* ─── Footer ─────────────────────────────────────────────────────── */}
      <footer className="border-t border-border">
        <div className="max-w-6xl mx-auto px-5 py-10 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded flex items-center justify-center" style={{ background: "var(--cobalt)" }}>
              <Zap className="w-3 h-3 text-white" />
            </div>
            <span className="text-sm font-bold">ShortsPro AI</span>
          </div>
          <div className="flex items-center gap-6 text-xs text-muted-foreground">
            <a href="#features" className="hover:text-foreground transition-colors">Features</a>
            <a href="#how-it-works" className="hover:text-foreground transition-colors">How it works</a>
            <a href="#pricing" className="hover:text-foreground transition-colors">Pricing</a>
          </div>
          <p className="text-xs text-muted-foreground">© 2026 ShortsPro AI</p>
        </div>
      </footer>
    </div>
  );
}
