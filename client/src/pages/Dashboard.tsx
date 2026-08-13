import AppLayout from "@/components/AppLayout";
import { trpc } from "@/lib/trpc";
import { Link } from "wouter";
import { Film, Upload, Sparkles, TrendingUp, Clock, CheckCircle2, AlertCircle, Loader2, ArrowRight, Zap, Play, Trash2, HardDriveDownload } from "lucide-react";
import { toast } from "sonner";

function StatCard({ label, value, icon: Icon, color, sub }: {
  label: string; value: string | number; icon: React.ElementType; color: string; sub?: string;
}) {
  return (
    <div className="glass rounded-2xl p-5 flex items-start gap-4 hover:border-primary/30 transition-colors group">
      <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 transition-transform group-hover:scale-105"
        style={{ background: `color-mix(in srgb, ${color} 12%, transparent)` }}>
        <Icon className="w-5 h-5" style={{ color }} />
      </div>
      <div>
        <div className="text-2xl font-bold text-foreground">{value}</div>
        <div className="text-sm font-medium text-foreground">{label}</div>
        {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    pending:     { label: "Pending",     cls: "status-pending" },
    transcribing:{ label: "Transcribing",cls: "status-processing" },
    analyzing:   { label: "Analyzing",  cls: "status-processing" },
    done:        { label: "Done",        cls: "status-done" },
    error:       { label: "Error",       cls: "status-error" },
    rendering:   { label: "Rendering",  cls: "status-processing" },
  };
  const s = map[status] ?? { label: status, cls: "status-pending" };
  return <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${s.cls}`}>{s.label}</span>;
}

export default function DashboardPage() {
  const utils = trpc.useUtils();
  const { data: videos, isLoading: vLoading } = trpc.videos.list.useQuery();
  const { data: clips, isLoading: cLoading } = trpc.clips.list.useQuery();

  const releaseHosted = trpc.videos.releaseHosted.useMutation({
    onSuccess: async () => {
      await utils.videos.list.invalidate();
      toast.success("Hosted file removed — disk space freed. You can re-import it any time.");
    },
    onError: err => toast.error(err.message),
  });

  const deleteVideo = trpc.videos.delete.useMutation({
    onSuccess: async () => {
      await utils.videos.list.invalidate();
      await utils.clips.list.invalidate();
      toast.success("Video and all its clips deleted.");
    },
    onError: err => toast.error(err.message),
  });

  const handleRelease = (v: { id: number; title: string | null; hostedStatus: string }) => {
    if (v.hostedStatus !== "ready") {
      toast.info("No hosted file to remove — nothing to free.");
      return;
    }
    if (!window.confirm(`Remove the imported copy of "${v.title ?? "this video"}" from disk?\n\nYour clips are kept. You can re-import the video later to edit or re-render them.`)) return;
    releaseHosted.mutate({ id: v.id });
  };

  const handleDelete = (v: { id: number; title: string | null }) => {
    if (!window.confirm(`Permanently delete "${v.title ?? "this video"}" and ALL its clips?\n\nThis cannot be undone.`)) return;
    deleteVideo.mutate({ id: v.id });
  };

  const totalVideos = videos?.length ?? 0;
  const totalClips = clips?.length ?? 0;
  const processing = videos?.filter(v => ["pending","transcribing","analyzing"].includes(v.status)).length ?? 0;
  const doneClips = clips?.filter(c => c.status === "done").length ?? 0;

  const recentVideos = [...(videos ?? [])].slice(0, 5);

  return (
    <AppLayout title="Dashboard">
      {/* Welcome banner */}
      <div className="relative rounded-2xl overflow-hidden mb-8 p-6 border border-border"
        style={{ background: "#ffffff" }}>
        <div className="absolute right-0 top-0 w-64 h-full opacity-5 pointer-events-none"
          style={{ background: "radial-gradient(circle at 80% 50%, var(--cobalt), transparent 60%)" }} />
        <div className="relative z-10">
          <div className="flex items-center gap-2 mb-2">
            <Zap className="w-5 h-5" style={{ color: "var(--cobalt)" }} />
            <span className="text-sm font-semibold" style={{ color: "var(--cobalt)" }}>AI-Powered Platform</span>
          </div>
          <h2 className="text-2xl font-black text-foreground mb-1">
            Create Viral Short-Form Videos
          </h2>
          <p className="text-sm text-muted-foreground mb-4 max-w-lg">
            Upload a long-form video or paste a YouTube URL. Our AI detects the most engaging moments and generates ready-to-post clips with auto-subtitles.
          </p>
          <Link href="/dashboard/video-input">
            <button className="ink-button ink-button-large">
              <Upload className="w-4 h-4" /> Start Creating <ArrowRight className="w-4 h-4" />
            </button>
          </Link>
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="Videos Created" value={vLoading ? "—" : totalVideos} icon={Film} color="var(--cobalt)" sub="All time" />
        <StatCard label="Clips Generated" value={cLoading ? "—" : totalClips} icon={Play} color="var(--mint)" sub={`${doneClips} ready`} />
        <StatCard label="Processing Queue" value={vLoading ? "—" : processing} icon={Loader2} color="var(--amber)" sub="In progress" />
        <StatCard label="Completed" value={cLoading ? "—" : doneClips} icon={CheckCircle2} color="var(--mint)" sub="Ready to download" />
      </div>

      {/* Recent videos + Quick actions */}
      <div className="grid lg:grid-cols-3 gap-6">
        {/* Recent videos */}
        <div className="lg:col-span-2 glass rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-semibold text-foreground">Recent Videos</span>
            </div>
            <Link href="/dashboard/clips" className="text-xs font-medium hover:opacity-80 transition-opacity" style={{ color: "var(--cobalt)" }}>
              View all
            </Link>
          </div>
          {vLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : recentVideos.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <div className="w-12 h-12 rounded-2xl flex items-center justify-center bg-secondary">
                <Film className="w-6 h-6 text-muted-foreground" />
              </div>
              <p className="text-sm text-muted-foreground">No videos yet</p>
              <Link href="/dashboard/video-input">
                <button className="text-xs font-semibold px-4 py-2 rounded-lg transition-colors hover:opacity-80" style={{ color: "var(--cobalt)", background: "rgba(49, 94, 245, 0.08)" }}>
                  Upload your first video
                </button>
              </Link>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {recentVideos.map(v => (
                <div key={v.id} className="flex items-center gap-4 px-5 py-3.5 hover:bg-secondary/50 transition-colors group">
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: "rgba(49, 94, 245, 0.08)" }}>
                    <Film className="w-4 h-4" style={{ color: "var(--cobalt)" }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-foreground truncate">{v.title ?? "Untitled Video"}</div>
                    <div className="text-xs text-muted-foreground">{new Date(v.createdAt).toLocaleDateString()}</div>
                  </div>
                  <StatusBadge status={v.status} />
                  {/* Space-saving actions — visible on hover */}
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <button
                      onClick={() => handleRelease(v)}
                      disabled={releaseHosted.isPending || v.hostedStatus !== "ready"}
                      title="Free disk space — removes the imported copy, keeps your clips"
                      className="p-1.5 rounded-lg transition-colors hover:bg-secondary disabled:opacity-30"
                      style={{ color: "var(--amber)" }}
                    >
                      <HardDriveDownload className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleDelete(v)}
                      disabled={deleteVideo.isPending}
                      title="Delete video and all clips"
                      className="p-1.5 rounded-lg transition-colors hover:bg-secondary disabled:opacity-30"
                      style={{ color: "var(--coral)" }}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Quick actions */}
        <div className="glass rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-border">
            <span className="text-sm font-semibold text-foreground">Quick Actions</span>
          </div>
          <div className="p-4 space-y-2">
            {[
              { href: "/dashboard/video-input",      icon: Upload,   label: "Upload Video",      desc: "Start from a file or URL", color: "var(--cobalt)" },
              { href: "/dashboard/highlights",       icon: Sparkles, label: "AI Highlights",     desc: "Detect viral moments",     color: "var(--coral)" },
              { href: "/dashboard/subtitle-editor",  icon: TrendingUp, label: "Edit Subtitles", desc: "Style your captions",      color: "var(--mint)" },
              { href: "/dashboard/clips",            icon: Film,     label: "View Clips",        desc: "Download your shorts",     color: "var(--amber)" },
            ].map(a => (
              <Link key={a.href} href={a.href}>
                <div className="flex items-center gap-3 p-3 rounded-xl hover:bg-secondary transition-colors cursor-pointer group">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-transform group-hover:scale-105"
                    style={{ background: `color-mix(in srgb, ${a.color} 10%, transparent)` }}>
                    <a.icon className="w-4 h-4" style={{ color: a.color }} />
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-foreground">{a.label}</div>
                    <div className="text-xs text-muted-foreground">{a.desc}</div>
                  </div>
                  <ArrowRight className="w-3.5 h-3.5 text-muted-foreground ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
