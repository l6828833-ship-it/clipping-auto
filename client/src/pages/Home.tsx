/**
 * Cut Room design system: an airy, creator-first Clip Maker page built around a coded
 * Input → Highlights → Subtitles → Edit → Export dashboard, with original video guide characters.
 */
import { useState } from "react";
import { useLocation } from "wouter";
import {
  ArrowRight,
  AudioLines,
  BarChart3,
  Captions,
  Check,
  ChevronDown,
  Clapperboard,
  Clock3,
  Download,
  FileVideo2,
  FolderOpen,
  Highlighter,
  LayoutDashboard,
  Link2,
  ListVideo,
  Menu,
  Moon,
  MoreHorizontal,
  Play,
  Plus,
  Scissors,
  Sparkles,
  UploadCloud,
  UserRound,
  WandSparkles,
  X,
  Youtube,
} from "lucide-react";
import { toast } from "sonner";

const wizardSteps = ["Input", "Highlights", "Subtitles", "Edit", "Export"];

const faqItems = [
  ["What videos can I use with Clip Maker?", "Upload MP4 or MOV files, or paste a supported public video link to start a project."],
  ["How does Clip Maker find highlights?", "It reads the transcript, pacing, and spoken context to surface moments you can review before you export."],
  ["Can I change the captions and framing?", "Yes. You stay in control of subtitle style, active words, vertical framing, clip length, and the final export."],
  ["Which platforms are supported?", "Your finished shorts are prepared for the vertical formats used by TikTok, Instagram Reels, and YouTube Shorts."],
];

function ClipMakerMark({ className = "" }: { className?: string }) {
  return <span className={`clip-maker-mark ${className}`} aria-hidden="true"><Play size={15} fill="currentColor" /></span>;
}

function Brand() {
  return (
    <a href="#top" className="sp-brand" aria-label="Clip Maker home">
      <ClipMakerMark className="sp-brand-mark" />
      <span>Clip <b>Maker</b></span>
      <small>AI video studio</small>
    </a>
  );
}

function DarkButton({ children, onClick, wide = false }: { children: React.ReactNode; onClick: () => void; wide?: boolean }) {
  return <button className={`sp-dark-button ${wide ? "sp-dark-button-wide" : ""}`} onClick={onClick}>{children}<ArrowRight size={15} /></button>;
}

export default function Home() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeStep, setActiveStep] = useState(0);
  const [sourceMode, setSourceMode] = useState<"url" | "upload">("url");
  const [subtitles, setSubtitles] = useState(true);
  const [openFaq, setOpenFaq] = useState(0);
  const [, setLocation] = useLocation();

  const beginCreating = () => setLocation("/login");
  const notify = (action: string) => {
    toast(action, { description: "Sign in to start creating with Clip Maker." });
    beginCreating();
  };
  const moveNext = () => setActiveStep((current) => Math.min(current + 1, wizardSteps.length - 1));

  return (
    <div className="shorts-site" id="top">
      <header className="sp-header">
        <div className="sp-header-inner">
          <Brand />
          <nav className="sp-nav" aria-label="Primary navigation">
            <a href="#workflow">Product <ChevronDown size={12} /></a>
            <a href="#creators">Use cases</a>
            <a href="#features">Features</a>
            <a href="#faq">Resources</a>
          </nav>
          <div className="sp-header-actions">
            <button className="sp-account" onClick={beginCreating}>Log in</button>
            <DarkButton onClick={beginCreating}>Create shorts</DarkButton>
            <button className="sp-menu" onClick={() => setMenuOpen(!menuOpen)} aria-label={menuOpen ? "Close menu" : "Open menu"}>{menuOpen ? <X size={21} /> : <Menu size={21} />}</button>
          </div>
        </div>
        {menuOpen && <nav className="sp-mobile-nav"><a href="#workflow" onClick={() => setMenuOpen(false)}>Product</a><a href="#creators" onClick={() => setMenuOpen(false)}>Use cases</a><a href="#features" onClick={() => setMenuOpen(false)}>Features</a><a href="#faq" onClick={() => setMenuOpen(false)}>Resources</a><DarkButton onClick={() => notify("Create shorts")}>Create shorts</DarkButton></nav>}
      </header>

      <main>
        <section className="sp-hero">
          <div className="sp-grid sp-grid-top" />
          <div className="sp-hero-copy">
            <span className="sp-eyebrow"><Sparkles size={12} /> Automatic clipping for video that deserves a second life</span>
            <h1>Turn one long video into <em>ready-to-post clips.</em></h1>
            <p>Clip Maker finds the moments worth watching, trims them with context, and turns them into vertical clips ready to share.</p>
            <div className="sp-hero-ctas"><DarkButton onClick={() => notify("Auto-clip your first video")} wide>Auto-clip a video</DarkButton><button className="sp-ghost-button" onClick={() => document.getElementById("workflow")?.scrollIntoView({ behavior: "smooth" })}><Play size={14} fill="currentColor" /> See the workflow</button></div>
          </div>

          <div className="sp-studio-wrap" id="workflow">
            <div className="sp-hero-characters" aria-hidden="true">
              <img className="crew-auto-scout" src="/brand/clip-maker-auto-scout.png" alt="" />
              <img className="crew-clip-finisher" src="/brand/clip-maker-clip-finisher-transparent.png" alt="" />
              <span className="crew-hey">clip!</span>
            </div>
            <div className="sp-dashboard-shell">
              <aside className="sp-dash-sidebar">
                <div className="dash-mini-brand"><ClipMakerMark className="dash-brand-mark" /><div><b>Clip Maker</b><span>AI video studio</span></div></div>
                <div className="dash-nav"><button><LayoutDashboard size={15} />Dashboard</button><button className="dash-nav-active"><WandSparkles size={15} />Create</button><button><BarChart3 size={15} />Top 5 Reels</button><button><ListVideo size={15} />Clips</button><button><UserRound size={15} />Profile</button></div>
                <div className="dash-user"><span>AC</span><div><b>claire</b><small>creator@clip-maker.com</small></div><MoreHorizontal size={16} /></div>
              </aside>
              <section className="sp-dash-main">
                <div className="dash-top"><b>Create</b><div><button aria-label="Theme"><Moon size={15} /></button><button onClick={() => notify("New project")}><Plus size={15} /> New project</button></div></div>
                <div className="dash-content">
                  <div className="wizard-steps">{wizardSteps.map((step, index) => <button className={activeStep === index ? "wizard-step active" : activeStep > index ? "wizard-step done" : "wizard-step"} onClick={() => setActiveStep(index)} key={step}><span>{activeStep > index ? <Check size={12} /> : index + 1}</span>{step}<i>›</i></button>)}</div>
                  {activeStep === 0 ? <section className="create-panel"><div className="create-title"><span className="sp-panel-label">NEW PROJECT</span><h2>Add your video</h2><p>Paste a video URL or upload a file. We’ll find the strongest moments and make them ready for vertical.</p></div><div className="subtitle-setting"><div className="subtitle-setting-icon"><Captions size={17} /></div><div><b>Captions for this video</b><span>Turn spoken words into animated, on-brand subtitles.</span></div><button className={subtitles ? "toggle active" : "toggle"} onClick={() => setSubtitles(!subtitles)} aria-pressed={subtitles}><i /></button></div><div className="source-tabs"><button className={sourceMode === "url" ? "selected" : ""} onClick={() => setSourceMode("url")}><Link2 size={14} /> Video URL</button><button className={sourceMode === "upload" ? "selected" : ""} onClick={() => setSourceMode("upload")}><UploadCloud size={14} /> Upload file</button></div>{sourceMode === "url" ? <><label className="input-label">Video URL</label><div className="video-url-field"><Youtube size={16} /><span>https://youtube.com/watch?v=your_video</span><button>English <ChevronDown size={12} /></button></div><p className="input-help">Supports YouTube, Vimeo, TikTok, direct MP4 links, and more.</p></> : <div className="upload-drop"><UploadCloud size={22} /><b>Drop your video here</b><span>or browse files · MP4, MOV up to 5GB</span></div>}<div className="process-card"><div><span className="loading-ring" /><b>{subtitles ? "Checking the transcript and scenes…" : "Reading your video structure…"}</b></div><div className="process-line"><i /></div><small><em>✓</em> Import <em>◌</em> Analyze <em>○</em> Create clips</small></div><label className="input-label">Video title <span>Optional</span></label><div className="title-field">e.g. Three ideas from this week’s episode</div><button className="continue-button" onClick={moveNext}>Find my best moments <ArrowRight size={15} /></button></section> : <WorkflowState step={activeStep} moveNext={moveNext} notify={notify} />}
                </div>
              </section>
            </div>
            <span className="sp-float-tag tag-left"><Scissors size={14} /> Find the hook, not the hassle</span><span className="sp-float-tag tag-right"><Check size={14} /> 9:16 ready</span>
          </div>
        </section>

        <section className="sp-proof-strip"><p>From raw recording to a run of clips you’re proud to post.</p><div><span>INPUT</span><i /> <span>FIND</span><i /> <span>POLISH</span><i /> <span>PUBLISH</span></div></section>

        <section className="sp-character-section" id="creators"><div className="sp-character-copy"><span className="sp-eyebrow">Meet the auto crew</span><h2>Your footage has more <em>to say.</em></h2><p>Auto scouts your long video for the strongest beat. Clip turns that beat into a clean, finished vertical short.</p><DarkButton onClick={() => notify("Build a first project")}>Build a first project</DarkButton></div><div className="sp-character-stage"><div className="stage-orbit orbit-a" /><div className="stage-orbit orbit-b" /><img src="/brand/clip-maker-auto-scout.png" alt="Clip Maker Auto Scout finding the strongest video moment" className="stage-video" /><img src="/brand/clip-maker-clip-finisher-transparent.png" alt="Clip Maker Clip Finisher preparing a share-ready short" className="stage-short" /><span className="stage-hello">clip!</span><div className="stage-chip chip-a"><Scissors size={14} /> Auto-find beats</div><div className="stage-chip chip-b"><Sparkles size={14} /> Ready to post</div></div></section>

        <section className="sp-flow-section" id="features"><div className="sp-section-heading"><span className="sp-eyebrow">A clean cut from start to finish</span><h2>One workflow.<br />More <em>watchable moments.</em></h2><p>Clip Maker runs the full clipping loop in one simple flow, so you can keep moving instead of rebuilding your edit in five places.</p></div><div className="sp-flow-rail"><FlowCard index="01" title="Drop in the full story" body="Import a podcast, talk, lesson, or interview from a link or a file." icon={<FileVideo2 size={18} />} tone="blue" /><FlowCard index="02" title="Spot the strongest beats" body="Review AI-detected clips with a clear reason behind every pick." icon={<Highlighter size={18} />} tone="coral" /><FlowCard index="03" title="Make every word visible" body="Generate lively subtitles, then tune the look to match your channel." icon={<Captions size={18} />} tone="mint" /><FlowCard index="04" title="Export ready to share" body="Download vertical cuts that are formatted for the platforms you use." icon={<Download size={18} />} tone="lavender" /></div></section>

        <section className="sp-preview-section"><div className="sp-preview-heading"><span className="sp-eyebrow">The edit, without the clutter</span><h2>Every short gets its <em>own stage.</em></h2><p>Start with the transcript. Refine the moment. Give it a frame that feels native to the feed.</p></div><div className="clip-editor"><aside><b>CLIP 03</b><button className="clip-active"><Play size={15} fill="currentColor" /> Preview</button><button><Captions size={15} /> Captions</button><button><AudioLines size={15} /> Sound</button><button><Sparkles size={15} /> Style</button></aside><div className="clip-video"><div className="video-ratio"><div className="video-sky" /><div className="video-person"><span /></div><div className="caption-sample"><b>MAKE THE</b><strong>FIRST <em>10</em> SECONDS</strong><b>COUNT.</b></div><div className="video-badge">00:18 <span>•</span> 9:16</div></div><div className="timeline"><button><Play size={13} fill="currentColor" /></button><div className="timeline-track"><i /><b /><span /></div><time>00:12 / 00:46</time></div></div><aside className="editor-settings"><span className="sp-panel-label">CAPTION STYLE</span><div className="setting-row"><b>Preset</b><button>Bold pop <ChevronDown size={12} /></button></div><div className="setting-row"><b>Active word</b><span className="color-dot coral" /></div><div className="setting-row"><b>Position</b><button>Lower third <ChevronDown size={12} /></button></div><div className="safe-area"><span>SAFE AREA</span><div><i /><i /><i /></div></div></aside></div></section>

        <section className="sp-usecases-section"><div className="sp-section-heading compact"><span className="sp-eyebrow">More ways to keep creating</span><h2>Built for the people<br />behind the <em>channel.</em></h2></div><div className="sp-usecases-grid"><UseCase prompt="“Find five useful clips in this recorded episode.”" title="Podcasts & interviews" copy="Turn long conversations into a month of thought-provoking shorts." icon={<AudioLines size={16} />} /><UseCase prompt="“Keep every lesson moving after it leaves the classroom.”" title="Educators & coaches" copy="Make clear, captioned explanations that travel farther than the original lesson." icon={<Sparkles size={16} />} /><UseCase prompt="“Give this launch story more than one chance to land.”" title="Teams & brands" copy="Reframe a strong message for every feed without losing its point of view." icon={<Clapperboard size={16} />} /></div></section>

        <section className="sp-start-section"><span className="sp-eyebrow">Make your first cut in minutes</span><h2>Start with a video.<br />Leave with <em>momentum.</em></h2><p>Clip Maker works best when you give it something worth watching. We’ll help you find what comes next.</p><div className="sp-start-columns"><article><span>01</span><h3>Bring the long version</h3><p>Paste a link or upload the file you already have.</p><DarkButton onClick={() => notify("Add your video")}>Add a video</DarkButton></article><article><span>02</span><h3>Choose your highlights</h3><p>Review the strongest sections before they become clips.</p><div className="mini-list"><b><Check size={13} /> Opening hook</b><b><Check size={13} /> Strong takeaway</b><b><Check size={13} /> Great quote</b></div></article><article className="sp-start-art"><span>03</span><h3>Share the short</h3><p>Make the most of the moment you already made.</p><img src="/brand/clip-maker-clip-finisher-transparent.png" alt="Clip Maker Clip Finisher celebrating a completed short" /></article></div></section>

        <section className="sp-statement"><div className="sp-grid sp-grid-bottom" /><div className="statement-player"><i /><i /><ClipMakerMark className="statement-brand-mark" /><i /><i /></div><h2>Good stories don’t end<br />when the recording does.</h2><p>Give every great moment a second chance to be seen.</p><DarkButton onClick={() => notify("Create shorts free")} wide>Create shorts free</DarkButton></section>

        <section className="sp-principles"><div><span className="sp-eyebrow">A clearer creative loop</span><h2>Made for your work,<br />not more <em>work.</em></h2><p>Clip Maker keeps the original video, the best moments, and every export in one calm place.</p></div><div className="principle-grid"><Principle icon={<Clock3 size={20} />} title="Less rewatching" copy="Find memorable moments without scrubbing the whole recording again." /><Principle icon={<Scissors size={20} />} title="More control" copy="Review every selected moment before it becomes a finished clip." /><Principle icon={<Captions size={20} />} title="Captions included" copy="Create accessible, active subtitles from the same project." /><Principle icon={<FolderOpen size={20} />} title="Projects stay tidy" copy="Keep a clear record of source videos, cuts, and exports." /></div></section>

        <section className="sp-faq" id="faq"><div className="faq-copy"><span className="sp-eyebrow">Questions, answered</span><h2>Everything you need<br />to know about Clip Maker.</h2><p>If your question is not here, our team can help you find the right workflow.</p><DarkButton onClick={() => notify("Contact support")}>Contact us</DarkButton></div><div className="faq-list">{faqItems.map(([question, answer], index) => <article className={openFaq === index ? "open" : ""} key={question}><button onClick={() => setOpenFaq(openFaq === index ? -1 : index)}><span>{question}</span><b>{openFaq === index ? "−" : "+"}</b></button>{openFaq === index && <p>{answer}</p>}</article>)}</div></section>

        <section className="sp-final"><span className="sp-eyebrow">Ready when your footage is</span><h2>Your next clip is already<br />inside the <em>long version.</em></h2><DarkButton onClick={() => notify("Start a free Clip Maker project")} wide>Start auto-clipping free</DarkButton><p>No credit card needed to make the first cut.</p></section>
      </main>
      <footer className="sp-footer"><div className="sp-footer-main"><div><Brand /><p>More life for every good story.</p></div><div className="sp-footer-links"><section><b>Product</b><a href="#workflow">How it works</a><a href="#features">Features</a><a href="#creators">Use cases</a></section><section><b>Studio</b><a href="#workflow">Create</a><a href="#features">Clip editor</a><a href="#faq">Help center</a></section><section><b>Company</b><a href="#faq">About</a><a href="#faq">Contact</a><a href="#faq">Privacy</a></section><section><b>Follow</b><a href="#top">YouTube</a><a href="#top">TikTok</a><a href="#top">Instagram</a></section></div></div><div className="sp-footer-bottom"><span>© 2026 Clip Maker AI</span><span>Turn long-form into more.</span></div></footer>
    </div>
  );
}

function WorkflowState({ step, moveNext, notify }: { step: number; moveNext: () => void; notify: (text: string) => void }) {
  const states = [
    { label: "HIGHLIGHTS READY", title: "We found 8 moments with momentum.", copy: "Review the beats that make people stop, stay, and share.", action: "Review subtitles", icon: <Highlighter size={19} /> },
    { label: "CAPTIONS ACTIVE", title: "Every word now has somewhere to land.", copy: "Use animated captions to make silent scrolling feel intentional.", action: "Open the editor", icon: <Captions size={19} /> },
    { label: "VERTICAL EDIT", title: "Give the best part of the frame the stage.", copy: "Nudge the crop, adjust the duration, and make the story fit the feed.", action: "Prepare export", icon: <Scissors size={19} /> },
    { label: "EXPORT READY", title: "Your next post is ready to go.", copy: "Download a clean 9:16 clip with captions, framing, and sound already in place.", action: "Download clip", icon: <Download size={19} /> },
  ][step - 1];
  return <section className="workflow-state"><span className="sp-panel-label">{states.label}</span><div className="workflow-state-icon">{states.icon}</div><h2>{states.title}</h2><p>{states.copy}</p><div className="state-preview"><div><b>00:18</b><span>Strong opening line</span><i>92</i></div><div><b>00:32</b><span>The practical takeaway</span><i>88</i></div><div><b>00:44</b><span>Closing thought</span><i>84</i></div></div><button className="continue-button" onClick={() => step === 4 ? notify("Export started") : moveNext()}>{states.action} <ArrowRight size={15} /></button></section>;
}

function FlowCard({ index, title, body, icon, tone }: { index: string; title: string; body: string; icon: React.ReactNode; tone: string }) {
  return <article className="flow-card"><div className={`flow-icon ${tone}`}>{icon}</div><span>{index}</span><h3>{title}</h3><p>{body}</p></article>;
}

function UseCase({ prompt, title, copy, icon }: { prompt: string; title: string; copy: string; icon: React.ReactNode }) {
  return <article><div className="use-prompt">{prompt}</div><div className="use-window"><span>● ● ●</span><div>{icon}<b>{title}</b><small>New clips ready</small></div><p><i /> transcript analyzed <em>View clips</em></p></div><h3>{title}</h3><p>{copy}</p></article>;
}

function Principle({ icon, title, copy }: { icon: React.ReactNode; title: string; copy: string }) {
  return <article><span>{icon}</span><h3>{title}</h3><p>{copy}</p></article>;
}
