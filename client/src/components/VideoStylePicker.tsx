import { trpc } from "@/lib/trpc";
import { VIDEO_STYLES, VIDEO_STYLE_IDS, type VideoLayout, type VideoStyleId } from "@shared/video-styles.mjs";

type LibraryVideo = { id: number; title?: string | null; sourceType?: string | null; hostedStatus?: string | null };

/**
 * Chooses the video style a clip is exported in. The split-screen footage
 * styles also need a background video, picked from the user's own uploads.
 */
export function VideoStylePicker({ value, onChange, excludeVideoId, disabled }: {
  value: VideoLayout | null | undefined;
  onChange: (layout: VideoLayout) => void;
  /** The clip's own source, which makes no sense as its background. */
  excludeVideoId?: number | null;
  disabled?: boolean;
}) {
  const style: VideoStyleId = value?.style && VIDEO_STYLES[value.style] ? value.style : "normal";
  const needsBackground = VIDEO_STYLES[style].split === "background";
  const { data: videos } = trpc.videos.list.useQuery(undefined, { enabled: needsBackground });
  const backgrounds = ((videos ?? []) as LibraryVideo[]).filter(
    v => v.sourceType === "upload" && v.hostedStatus === "ready" && v.id !== excludeVideoId
  );
  const groups = [...new Set(VIDEO_STYLE_IDS.map(id => VIDEO_STYLES[id].group))];

  return (
    <div className="space-y-3">
      {groups.map(group => (
        <div key={group}>
          <p className="text-[11px] font-semibold text-muted-foreground mb-1.5">{group}</p>
          <div className="grid grid-cols-2 gap-2">
            {VIDEO_STYLE_IDS.filter(id => VIDEO_STYLES[id].group === group).map(id => (
              <button key={id} type="button" disabled={disabled}
                onClick={() => onChange({ style: id, backgroundVideoId: value?.backgroundVideoId ?? null })}
                className={`rounded-lg px-3 py-2 text-left transition-all disabled:opacity-50 ${style === id ? "text-white" : "text-muted-foreground hover:text-foreground bg-secondary/60"}`}
                style={style === id ? { background: "var(--cobalt)" } : {}}>
                <span className="block text-xs font-semibold">{VIDEO_STYLES[id].label}</span>
                <span className="block text-[10px] opacity-80">{VIDEO_STYLES[id].hint}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
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
      {style !== "normal" && (
        <p className="text-[11px] text-muted-foreground">The preview above shows the normal look. The style is applied when the clip is rendered.</p>
      )}
    </div>
  );
}

export default VideoStylePicker;
