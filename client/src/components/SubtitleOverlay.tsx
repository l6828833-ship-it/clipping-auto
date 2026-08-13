import { useRef, useState } from "react";

/**
 * Caption overlay drawn on top of our own player.
 *
 * These are our subtitles — the hosted video carries no embedded or
 * third-party captions, so nothing competes with this layer.
 *
 * Sizing uses container query units (`cqw`) so the preview scales with whatever
 * box it is placed in while still matching the burned-in output exactly. The
 * stored `fontSize` is pixels on the 1080-wide export canvas, and 1cqw is 1% of
 * the container width, so `fontSize / 1080 * 100` cqw is the same proportion at
 * any preview size. The parent must set `container-type: size`.
 *
 * Position is stored as a percentage of the frame so it renders identically at
 * any output size or aspect ratio, matching the server's `\pos` calculation.
 */

/** Width of the export canvas the styling is authored against. */
export const CAPTION_CANVAS_W = 1080;

export type SubtitleStyle = {
  font: string;
  /** Pixel height on a 1080-wide canvas. */
  fontSize: number;
  color: string;
  highlightColor: string;
  /** Vertical preset, used when no free position is set. */
  position: "top" | "center" | "bottom";
  outline: boolean;
  /** Free position as a percentage of the frame (0-100), to the text centre. */
  posX?: number;
  posY?: number;
};

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  font: "Montserrat",
  fontSize: 72,
  color: "#FFFFFF",
  highlightColor: "#FFE600",
  position: "bottom",
  outline: true,
};

/** Font size limits offered by the styling UI, in export pixels. */
export const MIN_FONT_SIZE = 32;
export const MAX_FONT_SIZE = 140;

/** Vertical centre (percent) each preset maps to. Mirrors the server. */
export const PRESET_Y = { top: 12, center: 50, bottom: 82 } as const;

/** The effective anchor in percent, whether from a preset or free position. */
export function captionAnchor(
  style: SubtitleStyle,
  override?: { posX?: number; posY?: number }
): { x: number; y: number } {
  const x = override?.posX ?? style.posX ?? 50;
  const y = override?.posY ?? style.posY ?? PRESET_Y[style.position] ?? 82;
  return { x: Math.min(100, Math.max(0, x)), y: Math.min(100, Math.max(0, y)) };
}

export function SubtitleOverlay({
  words,
  activeIndex,
  style,
  onWordClick,
  className,
  positionOverride,
  onPositionChange,
}: {
  words: string[];
  activeIndex: number;
  style: SubtitleStyle;
  onWordClick?: (index: number) => void;
  className?: string;
  /** Per-caption position, when the selected caption overrides the global one. */
  positionOverride?: { posX?: number; posY?: number };
  /** Enables dragging. Receives percentages of the frame. */
  onPositionChange?: (pos: { posX: number; posY: number }) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; fromX: number; fromY: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  if (words.length === 0) return null;

  const anchor = captionAnchor(style, positionOverride);
  const draggable = !!onPositionChange;

  const fontSize = `${(style.fontSize / CAPTION_CANVAS_W) * 100}cqw`;
  // Outline thickness tracks the ASS outline (9% of font size).
  const outline = `${(style.fontSize * 0.09 / CAPTION_CANVAS_W) * 100}cqw`;

  const onPointerDown = (e: React.PointerEvent) => {
    if (!draggable) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, fromX: anchor.x, fromY: anchor.y };
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || !onPositionChange) return;

    // The frame is the nearest positioned ancestor, which is the player box.
    const frame = boxRef.current?.offsetParent as HTMLElement | null;
    const rect = frame?.getBoundingClientRect();
    if (!rect) return;

    const dx = ((e.clientX - d.startX) / rect.width) * 100;
    const dy = ((e.clientY - d.startY) / rect.height) * 100;

    onPositionChange({
      posX: Math.min(100, Math.max(0, d.fromX + dx)),
      posY: Math.min(100, Math.max(0, d.fromY + dy)),
    });
  };

  const endDrag = () => { dragRef.current = null; setDragging(false); };

  return (
    <div
      ref={boxRef}
      className={`absolute z-30 text-center ${draggable ? "" : "pointer-events-none"} ${className ?? ""}`}
      style={{
        // Anchor the caption's centre at the stored point, matching \an5\pos.
        left: `${anchor.x}%`,
        top: `${anchor.y}%`,
        transform: "translate(-50%, -50%)",
        // Keep long captions inside the frame.
        maxWidth: "90%",
        cursor: draggable ? (dragging ? "grabbing" : "grab") : undefined,
        touchAction: draggable ? "none" : undefined,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {draggable && (
        <span
          className="absolute -inset-2 rounded border border-dashed pointer-events-none"
          style={{ borderColor: dragging ? "#39FF14" : "rgba(255,255,255,0.35)" }}
        />
      )}

      <div className="inline-flex flex-wrap justify-center items-baseline gap-x-[0.25em] gap-y-[0.1em]">
        {words.map((word, i) => (
          <span
            key={`${word}-${i}`}
            onClick={onWordClick ? () => onWordClick(i) : undefined}
            className={`font-black uppercase leading-tight transition-colors duration-150 ${onWordClick ? "cursor-pointer" : ""}`}
            style={{
              fontFamily: `${style.font}, Montserrat, sans-serif`,
              fontSize,
              color: i === activeIndex ? style.highlightColor : style.color,
              // Approximates libass's stroke with a ring of shadows.
              textShadow: style.outline
                ? `0 0 ${outline} #000, ${outline} ${outline} 0 #000, -${outline} -${outline} 0 #000, ${outline} -${outline} 0 #000, -${outline} ${outline} 0 #000`
                : "none",
            }}
          >
            {word}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Picks a short run of words to show for a given clip.
 * Real transcript text is used when available so styling is judged against
 * actual content rather than filler.
 */
export function previewWordsFor(
  transcript: string,
  clipStart: number | null | undefined,
  fallback: string[],
  count = 4
): string[] {
  const words = transcript.trim().split(/\s+/).filter(Boolean);
  if (words.length < 4) return fallback;

  // Rough speaking rate, only used to land somewhere relevant in the text.
  const WORDS_PER_SECOND = 2.5;
  const from = Math.min(
    Math.max(0, Math.floor((clipStart ?? 0) * WORDS_PER_SECOND)),
    Math.max(0, words.length - count)
  );
  return words.slice(from, from + count);
}

export default SubtitleOverlay;
