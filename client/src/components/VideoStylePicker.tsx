import { trpc } from "@/lib/trpc";
import { VideoStyleThumb } from "@/components/VideoStyleThumb";
import { VIDEO_STYLES, VIDEO_STYLE_IDS, type VideoLayout, type VideoStyleId } from "@shared/video-styles.mjs";

type LibraryVideo = { id: number; title?: string | null; sourceType?: string | null; hostedStatus?: string | null };

/**
 * Chooses the video style a clip is exported in. The split-screen footage
 * styles also need a background video, picked from the user's own uploads.
 */
export function VideoStylePicker({ value, onChange, excludeVideoId, disabled, allowAuto }: {
  value: VideoLayout | null | undefined;
  onChange: (layout: VideoLayout | null) => void;
  /** The clip's own source, which makes no sense as its background. */
  excludeVideoId?: number | null;
  disabled?: boolean;
  /** Offer "AI chooses" (reported as null) ahead of the styles. */
  allowAuto?: boolean;
}) {
  const auto = Boolean(allowAuto) && !value;
  const style: VideoStyleId = value?.style && VIDEO_STYLES[value.style] ? value.style : "normal";
  const needsBackground = !auto && VIDEO_STYLES[style].split === "background";
  const { data: videos } = trpc.videos.list.useQuery(undefined, { enabled: needsBackground });
  const backgrounds = ((videos ?? []) as LibraryVideo[]).filter(
    v => v.sourceType === "upload" && v.hostedStatus === "ready" && v.id !== excludeVideoId
  );
  const card = (key: string, thumb: VideoStyleId | "auto", label: string, hint: string, selected: boolean, pick: () => void) => (
    <button key={key} type="button" disabled={disabled} onClick={pick} aria-pressed={selected} aria-label={`${label}: ${hint}`}
      className={`rounded-xl p-1.5 text-left transition-all disabled:opacity-50 border-2 ${selected ? "" : "border-transparent hover:border-border"}`}
      style={selected ? { borderColor: "var(--cobalt)", background: "color-mix(in srgb, var(--cobalt) 12%, transparent)" } : {}}>
      <VideoStyleThumb id={thumb} />
      <span className="mt-1.5 block text-[11px] font-bold leading-tight text-foreground">{label}</span>
      <span className="block text-[10px] leading-tight text-muted-foreground">{hint}</span>
    </button>
  );

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5">
        {allowAuto && card("auto", "auto", "AI chooses", "Best style for each clip", auto, () => onChange(null))}
        {VIDEO_STYLE_IDS.map(id =>
          card(id, id, VIDEO_STYLES[id].label, VIDEO_STYLES[id].hint, !auto && style === id,
            () => onChange({ style: id, backgroundVideoId: value?.backgroundVideoId ?? null })))}
      </div>
      {needsBackground && (
        <label className="block text-xs font-semibold text-foreground">
          Background video
          <select
            value={value?.backgroundVideoId ?? ""}
            disabled={disabled}
            onChange={e => onChange({ style, backgroundVideoId: e.target.value ? Number(e.target.value) : null })}
            className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm">
            <option value="">Choose one of your uploads…</option>
            {backgrounds.map(v => <option key={v.id} value={v.id}>{v.title ?? `Video ${v.id}`}</option>)}
          </select>
          <span className="mt-1 block text-[11px] font-normal text-muted-foreground">
            {backgrounds.length === 0
              ? "Upload your gameplay or satisfying footage as a video first (captions off), then choose it here."
              : "It plays muted in the lower half and loops if it is shorter than the clip."}
          </span>
        </label>
      )}
    </div>
  );
}

export default VideoStylePicker;
