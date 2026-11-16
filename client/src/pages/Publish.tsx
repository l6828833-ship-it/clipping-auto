import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { CheckCircle2, ExternalLink, Loader2, Send, Unplug } from "lucide-react";
import AppLayout from "@/components/AppLayout";
import { trpc } from "@/lib/trpc";

type Platform = "youtube" | "instagram" | "tiktok";
type Connection = { platform: Platform; configured: boolean; account: { label: string } | null };
type Post = { id: string; clipId: number; platform: Platform; status: string; url?: string; error?: string };
type Creator = { label: string; username: string; privacy: string[]; commentDisabled: boolean; duetDisabled: boolean; stitchDisabled: boolean; maxDuration: number };
type Clip = { id: number; title: string | null; status: string; downloadUrl: string | null };
const names = { youtube: "YouTube", instagram: "Instagram", tiktok: "TikTok" };
const privacyNames: Record<string, string> = { public: "Public", private: "Private", unlisted: "Unlisted", PUBLIC_TO_EVERYONE: "Everyone", MUTUAL_FOLLOW_FRIENDS: "Friends", FOLLOWER_OF_CREATOR: "Followers", SELF_ONLY: "Only me" };
const inputClass = "w-full rounded-xl border border-border bg-input px-3 py-2.5 text-sm";

async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`/api/social${path}`, {
    method, credentials: "same-origin", headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "Publishing is unavailable. Please try again.");
  return data;
}

export default function PublishPage() {
  return <AppLayout title="Publish"><Publishing /></AppLayout>;
}

function Publishing() {
  const { data: clips = [], isLoading: clipsLoading } = (trpc as any).clips.list.useQuery();
  const ready = (clips as Clip[]).filter(clip => clip.status === "done" && clip.downloadUrl);
  const [clipId, setClipId] = useState(Number(new URLSearchParams(window.location.search).get("clip")) || 0);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [platform, setPlatform] = useState<Platform>("youtube");
  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  const [privacy, setPrivacy] = useState("");
  const [kids, setKids] = useState("");
  const [creator, setCreator] = useState<Creator | null>(null);
  const [creatorLoading, setCreatorLoading] = useState(false);
  const [creatorError, setCreatorError] = useState("");
  const [comments, setComments] = useState(false);
  const [duet, setDuet] = useState(false);
  const [stitch, setStitch] = useState(false);
  const [branded, setBranded] = useState(false);
  const [commercial, setCommercial] = useState(false);
  const [ownBrand, setOwnBrand] = useState(false);
  const [aiGenerated, setAiGenerated] = useState(false);
  const [consent, setConsent] = useState(false);
  const [ownsContent, setOwnsContent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tiktokPublic, setTiktokPublic] = useState(false);
  const [connectionBusy, setConnectionBusy] = useState<string | null>(null);
  const requestId = useRef<string | null>(null);
  const clip = ready.find(row => row.id === clipId);
  const connection = connections.find(row => row.platform === platform);

  async function load() {
    const [accounts, history] = await Promise.all([api("/accounts"), api("/posts")]);
    setConnections(accounts.platforms);
    setTiktokPublic(accounts.tiktokPublicPosting);
    setPosts(history.posts);
  }
  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get("connection");
    if (result === "success") setNotice("Your account is connected. Choose a clip to publish.");
    if (result === "failed") setError("The account connection could not finish. Try again and allow publishing access.");
    if (result === "busy") setError("Wait for the current post to finish before changing accounts.");
    load().catch(e => setError(e.message)).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (clip) { setTitle((clip.title || "My clip").slice(0, 100)); setCaption(clip.title || ""); }
  }, [clip?.id]);

  useEffect(() => {
    let cancelled = false;
    setCreator(null); setCreatorError(""); setPrivacy("");
    setComments(false); setDuet(false); setStitch(false); setConsent(false);
    if (platform !== "tiktok" || !connection?.account) { setCreatorLoading(false); return; }
    setCreatorLoading(true);
    api("/creator/tiktok").then(data => { if (!cancelled) setCreator(data.creator); })
      .catch(e => { if (!cancelled) setCreatorError(e.message); })
      .finally(() => { if (!cancelled) setCreatorLoading(false); });
    return () => { cancelled = true; };
  }, [platform, connection?.account?.label]);

  useEffect(() => {
    if (!posts.some(post => ["processing", "uploading", "checking"].includes(post.status))) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        for (const post of posts.filter(row => row.status === "processing")) await api(`/posts/${post.id}/refresh`, "POST", {});
        const history = await api("/posts");
        if (!cancelled) setPosts(history.posts);
      } catch (e) {
        if (!cancelled) { setError((e as Error).message); setPosts(current => [...current]); }
      }
    }, 10_000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [posts]);

  async function connect(provider: Platform) {
    setConnectionBusy(provider); setError("");
    try {
      const data = await api(`/connect/${provider}`, "POST", {});
      window.location.assign(data.url);
    } catch (e) { setError((e as Error).message); setConnectionBusy(null); }
  }
  async function disconnect(provider: Platform) {
    setConnectionBusy(provider); setError("");
    try {
      const result = await api(`/accounts/${provider}`, "DELETE"); await load();
      setNotice(result.revoked ? "Account disconnected." : "Account disconnected from Clip Maker. Also remove Clip Maker in your social account’s connected-app settings; the platform could not confirm revocation.");
    }
    catch (e) { setError((e as Error).message); }
    finally { setConnectionBusy(null); }
  }

  async function publish(event: React.FormEvent) {
    event.preventDefault();
    if (!clip || busy) return;
    setBusy(true); setError(""); setNotice("");
    // Preserve this key after a lost response. Checking the same request must
    // never upload a second copy of the clip.
    requestId.current ||= crypto.randomUUID();
    try {
      const { post } = await api("/posts", "POST", {
        id: requestId.current, clipId, platform, title, caption,
        privacy: platform === "instagram" ? "public" : privacy,
        ...(platform === "youtube" ? { madeForKids: kids === "yes" } : {}),
        consent, ownsContent, aiGenerated, allowComments: comments, allowDuet: duet, allowStitch: stitch,
        brandedContent: branded, ownBrand,
      });
      setPosts(current => [post, ...current.filter(row => row.id !== post.id)]);
      if (post.status === "unknown" || post.status === "failed") setError(post.error);
      else setNotice("Your clip was sent. Its publishing status appears below.");
    } catch (e) {
      setError(`${(e as Error).message} Use “Check this request” to check before starting another post.`);
    } finally { setBusy(false); }
  }

  const resetRequest = () => {
    requestId.current = null; setConsent(false); setNotice(""); setError("");
  };
  const privacyOptions = platform === "tiktok" ? creator?.privacy || [] : ["private", "unlisted", "public"];
  const blocked = busy || !clip || !connection?.account || !title.trim() || !consent || !ownsContent ||
    (platform !== "instagram" && !privacy) || (platform === "youtube" && !kids) ||
    (platform === "tiktok" && (!creator || !!creatorError || (commercial && !branded && !ownBrand) || (branded && privacy === "SELF_ONLY")));

  return <div className="mx-auto max-w-5xl space-y-6">
    <div><h1 className="text-2xl font-bold">Publish your clips</h1><p className="mt-1 text-sm text-muted-foreground">Connect your accounts, review your clip, and choose where to post it.</p></div>
    {error && <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="rounded-xl bg-secondary p-4 text-sm">{notice}</p>}
    {loading ? <p className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading accounts…</p> :
      <div className="grid gap-3 sm:grid-cols-3">{connections.map(row => <div key={row.platform} className="glass rounded-2xl border border-border p-4">
        <h2 className="font-bold">{names[row.platform]}</h2>
        <p className="my-2 text-sm text-muted-foreground">{row.account ? row.account.label : row.platform === "instagram" ? "Business or Creator account" : "Connect your account"}</p>
        {row.account ? <button type="button" onClick={() => disconnect(row.platform)} disabled={!!connectionBusy || busy} className="flex items-center gap-1 text-xs text-muted-foreground disabled:opacity-50"><Unplug className="h-3.5 w-3.5" /> Disconnect</button> :
          <button type="button" onClick={() => connect(row.platform)} disabled={!row.configured || !!connectionBusy || busy} className="rounded-lg bg-primary px-3 py-2 text-xs font-bold text-primary-foreground disabled:opacity-50">{!row.configured ? "Coming soon" : connectionBusy === row.platform ? "Connecting…" : `Connect ${names[row.platform]}`}</button>}
      </div>)}</div>}
    <form onSubmit={publish} className="glass grid gap-6 rounded-2xl border border-border p-5 md:grid-cols-2">
      <div className="space-y-4">
        <label className="block text-sm font-semibold">Finished clip
          <select className={`${inputClass} mt-2`} value={clipId || ""} disabled={busy || !!requestId.current} onChange={e => setClipId(Number(e.target.value))}>
            <option value="">Choose a rendered clip</option>{ready.map(row => <option key={row.id} value={row.id}>{row.title || `Clip ${row.id}`}</option>)}
          </select>
        </label>
        {!clipsLoading && !ready.length && <p className="text-sm text-muted-foreground">Render a clip first in <Link className="underline" href="/dashboard/clips">your clip library</Link>.</p>}
        {clip?.downloadUrl && <video key={clip.id} src={clip.downloadUrl} controls preload="metadata" className="max-h-96 w-full rounded-xl bg-black" />}
        <p className="text-xs text-muted-foreground">This posts the finished MP4, including its framing and captions.</p>
      </div>
      <fieldset disabled={busy || !!requestId.current} className="space-y-4 disabled:opacity-70">
        <label className="block text-sm font-semibold">Post to
          <select className={`${inputClass} mt-2`} value={platform} onChange={e => setPlatform(e.target.value as Platform)}>{Object.entries(names).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
        </label>
        {connection?.account && <p className="text-sm">Posting as <strong>{platform === "tiktok" && creator ? creator.label : connection.account.label}</strong></p>}
        {platform === "youtube" && <label className="block text-sm font-semibold">Title<input className={`${inputClass} mt-2`} maxLength={100} required value={title} onChange={e => setTitle(e.target.value)} /></label>}
        <label className="block text-sm font-semibold">{platform === "youtube" ? "Description" : "Caption"}<textarea className={`${inputClass} mt-2 min-h-24`} maxLength={2200} value={caption} onChange={e => setCaption(e.target.value)} placeholder="Add your caption and hashtags" /></label>
        {platform !== "instagram" ? <label className="block text-sm font-semibold">Who can see this video?
          <select required className={`${inputClass} mt-2`} value={privacy} onChange={e => setPrivacy(e.target.value)}><option value="">Choose visibility</option>{privacyOptions.map(value => <option key={value} value={value} disabled={platform === "tiktok" && branded && value === "SELF_ONLY"}>{privacyNames[value] || value}</option>)}</select>
        </label> : <p className="text-sm text-muted-foreground">Published as a Reel to your Instagram professional account and feed.</p>}
        {platform === "youtube" && <label className="block text-sm font-semibold">Is this video made for kids?
          <select required className={`${inputClass} mt-2`} value={kids} onChange={e => setKids(e.target.value)}><option value="">Choose audience</option><option value="no">No, it is not made for kids</option><option value="yes">Yes, it is made for kids</option></select>
        </label>}
        {platform === "tiktok" && <div className="space-y-2 text-sm">
          {creatorLoading && <p>Checking TikTok publishing options…</p>}
          {creatorError && <p role="alert" className="text-destructive">{creatorError}</p>}
          {!tiktokPublic && <p className="text-xs text-muted-foreground">TikTok posts are private while public posting is awaiting approval.</p>}
          {creator && <p className="text-xs text-muted-foreground">Maximum video length for this account: {creator.maxDuration} seconds.</p>}
          <Toggle checked={comments} onChange={setComments} disabled={creator?.commentDisabled}>Allow comments</Toggle>
          <Toggle checked={duet} onChange={setDuet} disabled={creator?.duetDisabled}>Allow Duet</Toggle>
          <Toggle checked={stitch} onChange={setStitch} disabled={creator?.stitchDisabled}>Allow Stitch</Toggle>
          <Toggle checked={commercial} onChange={value => { setCommercial(value); if (!value) { setOwnBrand(false); setBranded(false); } }}>This video promotes a brand, product, or service</Toggle>
          {commercial && <>
            <Toggle checked={ownBrand} onChange={setOwnBrand}>Promotes my own business</Toggle>
            <Toggle checked={branded} onChange={setBranded} disabled={privacy === "SELF_ONLY"}>Paid partnership or promotes another brand</Toggle>
            <p className="text-xs text-muted-foreground">{branded ? "Your video will be labeled Paid partnership." : ownBrand ? "Your video will be labeled Promotional content." : "Choose whether this promotes your brand, another brand, or both."}</p>
          </>}
          {branded && privacy === "SELF_ONLY" && <p className="text-destructive">Branded content cannot use Only me visibility.</p>}
        </div>}
        {platform !== "instagram" && <Toggle checked={aiGenerated} onChange={setAiGenerated}>Contains realistic AI-generated or altered content</Toggle>}
        <Toggle checked={ownsContent} onChange={setOwnsContent}>I own this content or have permission to publish it.</Toggle>
        <Toggle checked={consent} onChange={setConsent}>
          {platform === "tiktok" ? <>I agree to TikTok’s <a target="_blank" rel="noreferrer" className="underline" href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en">Music Usage Confirmation</a>{(branded || ownBrand) && <> and <a target="_blank" rel="noreferrer" className="underline" href="https://www.tiktok.com/legal/page/global/bc-policy/en">Branded Content Policy</a></>} and authorize this post.</> : `I authorize publishing this clip to ${names[platform]}.`}
        </Toggle>
      </fieldset>
      <div className="md:col-span-2 flex flex-wrap items-center justify-end gap-3">
        {requestId.current && !busy && <button type="button" onClick={resetRequest} className="rounded-xl border border-border px-4 py-2 text-sm">Prepare another post</button>}
        <button type="submit" disabled={blocked} className="flex items-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-bold text-primary-foreground disabled:opacity-40">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}{busy ? "Sending your clip…" : requestId.current ? "Check this request" : `Publish to ${names[platform]}`}</button>
      </div>
    </form>
    <section className="space-y-3"><h2 className="text-lg font-bold">Recent posts</h2>
      {!posts.length && <p className="text-sm text-muted-foreground">Your publishing history will appear here.</p>}
      {posts.map(post => <div key={post.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4">
        <div><p className="text-sm font-semibold">{names[post.platform]} · {ready.find(row => row.id === post.clipId)?.title || `Clip ${post.clipId}`}</p>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">{post.status === "published" && <CheckCircle2 className="h-3.5 w-3.5" />}{({ uploading: "Uploading", processing: "Platform is processing your video", checking: "Checking publication", published: "Posted with your chosen visibility", failed: "Could not publish", unknown: "Check your social account before retrying" } as Record<string, string>)[post.status] || post.status}</p>
          {post.error && <p className="mt-1 text-xs text-destructive">{post.error}</p>}
        </div>
        {post.url && <a className="flex items-center gap-1 text-sm underline" href={post.url} target="_blank" rel="noreferrer">View on {names[post.platform]} <ExternalLink className="h-3 w-3" /></a>}
      </div>)}
    </section>
  </div>;
}

function Toggle({ checked, onChange, disabled, children }: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; children: React.ReactNode }) {
  return <label className={`flex items-start gap-2 text-sm ${disabled ? "opacity-40" : ""}`}><input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} className="mt-0.5" /><span>{children}</span></label>;
}
