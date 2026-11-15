import { toast } from "sonner";
import { downloadUrl } from "@/lib/videoSource";

/** Largest answer the server sends at once, and the size above which a file is fetched in pieces. */
const PIECE = 8 * 1024 * 1024;
const WHOLE_LIMIT = 30 * 1024 * 1024;

/**
 * Saves one of our media files (a rendered clip, an import) to the device.
 *
 * The server first says how big the file is and, when it is kept in the
 * storage bucket, gives a signed link to download it straight from there.
 * Otherwise a large file comes down from the server in 8 MiB pieces and is
 * put back together here: the host refuses any single response over 32 MiB,
 * so a long clip could not be downloaded in one go.
 */
export async function saveMedia(url: string, onProgress?: (fraction: number) => void): Promise<void> {
  const link = downloadUrl(url);
  const name = url.split("?")[0].split("/").pop() || "clip.mp4";
  const answer = await fetch(`${link}&check=1`, { credentials: "same-origin" }).catch(() => null);
  if (answer?.status === 404) throw new Error("This export is missing. Render the clip again to download it.");
  const info: { size?: number; url?: string } | null = answer?.ok ? await answer.json().catch(() => null) : null;
  if (info?.url) {
    window.location.assign(info.url);
    return;
  }
  const size = info?.size ?? 0;
  if (!size || size <= WHOLE_LIMIT) {
    window.location.assign(link);
    return;
  }
  const parts: Blob[] = [];
  for (let start = 0; start < size; start += PIECE) {
    const end = Math.min(size, start + PIECE) - 1;
    const piece = await fetch(link, { credentials: "same-origin", headers: { Range: `bytes=${start}-${end}` } });
    if (piece.status !== 206 && piece.status !== 200) throw new Error(`The download stopped (HTTP ${piece.status}). Try again.`);
    parts.push(await piece.blob());
    onProgress?.(Math.min(1, (end + 1) / size));
    if (piece.status === 200) break; // The whole file came back at once.
  }
  const file = URL.createObjectURL(new Blob(parts, { type: "video/mp4" }));
  const anchor = document.createElement("a");
  anchor.href = file;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(file), 60_000);
}

/** Click handler for a download link to one of our media files, with progress shown for large ones. */
export function downloadMedia(url: string) {
  return (event: { preventDefault(): void }) => {
    event.preventDefault();
    const id = toast.loading("Preparing the download…");
    saveMedia(url, (fraction) => toast.loading(`Downloading… ${Math.round(fraction * 100)}%`, { id }))
      .then(() => toast.dismiss(id))
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "The download failed. Try again.", { id }));
  };
}
