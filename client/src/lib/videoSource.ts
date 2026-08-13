/**
 * Video source resolution.
 *
 * Playback always uses media we host ourselves, so there is no third-party
 * player, branding, or burned-in captions. A source URL that has not been
 * hosted yet is not playable — the UI asks for hosting instead of embedding.
 */

export type VideoSource =
  /** A file we host and can play in a plain <video>. */
  | { kind: "hosted"; url: string }
  /** A local object URL from a file the user just picked. */
  | { kind: "local"; url: string }
  /** A remote source that must be hosted before it can play. */
  | { kind: "needs-hosting"; url: string }
  | { kind: "none" };

const YOUTUBE_ID = /^[a-zA-Z0-9_-]{11}$/;

/** Extracts the 11-character video ID from any common YouTube URL shape. */
export function parseYouTubeId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (YOUTUBE_ID.test(raw)) return raw;

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, "").toLowerCase();

  if (host === "youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0];
    return id && YOUTUBE_ID.test(id) ? id : null;
  }

  if (!host.endsWith("youtube.com") && host !== "youtube-nocookie.com") return null;

  const v = url.searchParams.get("v");
  if (v && YOUTUBE_ID.test(v)) return v;

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length >= 2 && ["embed", "shorts", "live", "v"].includes(segments[0])) {
    const id = segments[1];
    if (YOUTUBE_ID.test(id)) return id;
  }

  return null;
}

/** True for URLs served by our own media routes. */
export function isHostedUrl(url: string | null | undefined): boolean {
  return !!url && /^\/api\/media\/(video|clip)\//.test(url);
}

const PLAYABLE_EXT = /\.(mp4|webm|ogg|ogv|m4v)(\?|#|$)/i;

/**
 * Decides how a URL should be treated.
 *
 * Preference order: our hosted file, a local object URL, otherwise it needs
 * hosting. Arbitrary remote URLs are never handed to a <video> element unless
 * they clearly point at a playable file, which is what previously produced
 * "NotSupportedError: The element has no supported sources".
 */
export function resolveVideoSource(raw: string | null | undefined): VideoSource {
  const url = (raw ?? "").trim();
  if (!url || url === "#") return { kind: "none" };

  if (isHostedUrl(url)) return { kind: "hosted", url };

  if (url.startsWith("blob:") || url.startsWith("data:")) return { kind: "local", url };

  if (/^https?:\/\//i.test(url)) {
    // A direct media file can be played as-is; anything else (a YouTube watch
    // page, a Vimeo page) must be hosted first.
    if (PLAYABLE_EXT.test(url)) return { kind: "hosted", url };
    return { kind: "needs-hosting", url };
  }

  if (url.startsWith("/") && PLAYABLE_EXT.test(url)) return { kind: "hosted", url };

  return { kind: "none" };
}

/** Poster image for a YouTube source, used only for thumbnails. */
export function youTubeThumbnail(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

/** Link back to the original source, for attribution. */
export function youTubeWatchUrl(videoId: string, start?: number | null): string {
  const t = start != null ? `&t=${Math.max(0, Math.floor(start))}` : "";
  return `https://www.youtube.com/watch?v=${videoId}${t}`;
}

/** Adds the download flag to one of our media URLs. */
export function downloadUrl(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}download=1`;
}

export function formatTime(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds)) return "0:00";
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, "0")}`;
}
