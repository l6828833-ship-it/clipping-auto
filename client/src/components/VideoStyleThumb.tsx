import type { VideoStyleId } from "@shared/video-styles.mjs";

/** A person: head and shoulders, centred on `cx`, with the head at `cy`. */
function Person({ cx, cy, r, fill }: { cx: number; cy: number; r: number; fill: string }) {
  return (
    <g fill={fill}>
      <circle cx={cx} cy={cy} r={r} />
      <path d={`M${cx - r * 2.1} ${cy + r * 4.2} Q${cx - r * 2.1} ${cy + r * 1.3} ${cx} ${cy + r * 1.3} Q${cx + r * 2.1} ${cy + r * 1.3} ${cx + r * 2.1} ${cy + r * 4.2} Z`} />
    </g>
  );
}

/** Caption words as rounded bars; `hot` is the index drawn in the accent colour. */
function Caption({ y, widths, h = 7, hot = -1, color = "#fff", accent = "#FFD43B", gap = 3 }: {
  y: number; widths: number[]; h?: number; hot?: number; color?: string; accent?: string; gap?: number;
}) {
  const total = widths.reduce((a, b) => a + b, 0) + gap * (widths.length - 1);
  let x = 45 - total / 2;
  return (
    <g>
      {widths.map((w, i) => {
        const rect = <rect key={i} x={x} y={y} width={w} height={h} rx={h / 3} fill={i === hot ? accent : color} />;
        x += w + gap;
        return rect;
      })}
    </g>
  );
}

/**
 * A small drawn example of what a video style looks like on a phone screen.
 * Drawings rather than screenshots, so they need no image files and are sharp
 * at any size.
 */
export function VideoStyleThumb({ id }: { id: VideoStyleId | "auto" }) {
  const clip = `thumb-${id}`;
  let content: React.ReactNode;
  switch (id) {
    case "auto":
      content = (
        <>
          <rect width="90" height="160" fill="#312e81" />
          <rect width="90" height="160" fill="url(#thumb-glow)" />
          <path d="M45 46 L51 68 L73 74 L51 80 L45 102 L39 80 L17 74 L39 68 Z" fill="#fff" />
          <path d="M68 100 L71 109 L80 112 L71 115 L68 124 L65 115 L56 112 L65 109 Z" fill="#FFD43B" />
          <path d="M22 32 L24 38 L30 40 L24 42 L22 48 L20 42 L14 40 L20 38 Z" fill="#a5b4fc" />
        </>
      );
      break;
    case "dynamic":
      content = (
        <>
          <rect width="90" height="160" fill="#1e3a5f" />
          <Person cx={45} cy={62} r={21} fill="#7fb2e5" />
          <g stroke="#FFD43B" strokeWidth="3" fill="none" strokeLinecap="round">
            <path d="M8 22 V10 H20" /><path d="M82 22 V10 H70" /><path d="M8 138 V150 H20" /><path d="M82 138 V150 H70" />
          </g>
          <Caption y={120} widths={[18, 26, 14]} hot={1} />
        </>
      );
      break;
    case "podcast":
      content = (
        <>
          <rect width="90" height="160" fill="#3b3f4a" />
          <Person cx={45} cy={56} r={14} fill="#aab1c2" />
          <rect x="60" y="78" width="7" height="16" rx="3.5" fill="#1b1d23" />
          <path d="M63.5 94 V112" stroke="#1b1d23" strokeWidth="2.5" />
          <rect x="10" y="126" width="70" height="16" rx="3" fill="#000" opacity="0.6" />
          <Caption y={131.5} widths={[14, 20, 10, 12]} h={5} gap={2.5} />
        </>
      );
      break;
    case "cinematic":
      content = (
        <>
          <rect width="90" height="160" fill="#2a2018" />
          <Person cx={45} cy={60} r={15} fill="#b08a5c" />
          <rect width="90" height="160" fill="url(#thumb-vignette)" />
          <rect width="90" height="14" fill="#000" /><rect y="146" width="90" height="14" fill="#000" />
          <Caption y={126} widths={[12, 18, 12]} h={4} color="#f1dcc0" gap={2.5} />
        </>
      );
      break;
    case "viral":
      content = (
        <>
          <rect width="90" height="160" fill="#4c1d95" />
          <Person cx={45} cy={50} r={15} fill="#c4a6f5" />
          <Caption y={102} widths={[30, 34]} h={13} hot={1} gap={4} />
          <Caption y={120} widths={[44]} h={13} />
        </>
      );
      break;
    case "gaming":
    case "gameplay":
      content = (
        <>
          <rect width="90" height="80" fill="#1e3a5f" />
          <Person cx={45} cy={30} r={12} fill="#7fb2e5" />
          <rect y="80" width="90" height="80" fill="#7ec8f2" />
          <rect y="124" width="90" height="36" fill="#5a9c3a" />
          <rect y="134" width="90" height="26" fill="#8a5a2b" />
          {[[10, 104], [30, 114], [50, 104], [70, 94]].map(([x, y]) => <rect key={x} x={x} y={y} width="10" height="10" fill="#6b6b6b" />)}
          <rect x="38" y="112" width="8" height="12" fill="#e8413c" />
          <Caption y={74} widths={[20, 26, 16]} h={10} hot={1} />
        </>
      );
      break;
    case "satisfying":
      content = (
        <>
          <rect width="90" height="80" fill="#1e3a5f" />
          <Person cx={45} cy={30} r={12} fill="#7fb2e5" />
          <rect y="80" width="90" height="80" fill="#fde2ef" />
          {["#f472b6", "#fb923c", "#facc15", "#4ade80", "#38bdf8"].map((c, i) => (
            <path key={c} d={`M-5 ${98 + i * 13} Q22 ${88 + i * 13} 45 ${98 + i * 13} T95 ${98 + i * 13} V${112 + i * 13} H-5 Z`} fill={c} />
          ))}
          <Caption y={74} widths={[20, 26, 16]} h={10} hot={1} />
        </>
      );
      break;
    case "dual":
      content = (
        <>
          <rect width="90" height="80" fill="#1e3a5f" />
          <Person cx={45} cy={30} r={12} fill="#7fb2e5" />
          <rect y="80" width="90" height="80" fill="#5b2333" />
          <Person cx={45} cy={110} r={12} fill="#f09aae" />
          <Caption y={74} widths={[20, 26, 16]} h={10} hot={1} />
        </>
      );
      break;
    case "reaction":
      content = (
        <>
          <rect width="90" height="80" fill="#1e3a5f" />
          <Person cx={45} cy={34} r={18} fill="#7fb2e5" />
          <rect y="80" width="90" height="80" fill="#14532d" />
          <path d="M0 150 L28 112 L46 134 L62 118 L90 150 V160 H0 Z" fill="#22c55e" />
          <circle cx="68" cy="100" r="7" fill="#fde047" />
          <Person cx={20} cy={132} r={5} fill="#0b2e18" />
          <Caption y={74} widths={[20, 26, 16]} h={10} hot={1} />
        </>
      );
      break;
    default:
      content = (
        <>
          <rect width="90" height="160" fill="#1e3a5f" />
          <Person cx={45} cy={58} r={15} fill="#7fb2e5" />
          <Caption y={118} widths={[18, 24, 14]} h={8} hot={1} />
        </>
      );
  }
  return (
    <svg viewBox="0 0 90 160" className="block w-full h-auto" role="img" aria-hidden="true">
      <defs>
        <clipPath id={clip}><rect width="90" height="160" rx="9" /></clipPath>
        <radialGradient id="thumb-vignette" cx="50%" cy="42%" r="70%">
          <stop offset="45%" stopColor="#000" stopOpacity="0" /><stop offset="100%" stopColor="#000" stopOpacity="0.75" />
        </radialGradient>
        <radialGradient id="thumb-glow" cx="50%" cy="45%" r="60%">
          <stop offset="0%" stopColor="#818cf8" stopOpacity="0.7" /><stop offset="100%" stopColor="#818cf8" stopOpacity="0" />
        </radialGradient>
      </defs>
      <g clipPath={`url(#${clip})`}>{content}</g>
    </svg>
  );
}

export default VideoStyleThumb;
