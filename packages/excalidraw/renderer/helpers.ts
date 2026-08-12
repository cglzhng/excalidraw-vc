import { COLOR_WHITE, THEME, applyDarkModeFilter } from "@excalidraw/common";

import type { StaticCanvasRenderConfig } from "../scene/types";
import type { AppState, StaticCanvasAppState } from "../types";

/**
 * The one colour for alignment indicators — snap guides and hard/soft
 * alignment guides alike. They are the same idea at different levels of
 * commitment, so they must not drift apart; these lived as two separate
 * pairs of hexes before and did exactly that.
 *
 * Zen mode takes the light colour in either theme: there we draw little
 * more than the crosses, and they need the contrast.
 */
const INDICATOR_COLOR_LIGHT = "#e03131";
const INDICATOR_COLOR_DARK = "#ffa8a8";

export const getIndicatorColor = (
  theme: AppState["theme"],
  zenModeEnabled: boolean,
): string =>
  theme === THEME.LIGHT || zenModeEnabled
    ? INDICATOR_COLOR_LIGHT
    : INDICATOR_COLOR_DARK;

/** Radius, in screen px, of a round indicator badge (divided by zoom at
 * draw time). Shared so every badge is the same size and every hit-test
 * agrees with what was drawn. */
export const INDICATOR_BADGE_RADIUS = 9;

/** The inactive state of an icon — an open padlock, a lifted anchor —
 * is drawn faded to read as the weaker of the two. */
export const INACTIVE_ICON_OPACITY = 0.45;

/**
 * The badge disc every indicator icon sits on, with the rim path left
 * current so the caller can stroke it.
 *
 * `filled` paints the disc in the badge's own colour instead of white,
 * for badges whose active state is worth reading at a glance; the glyph
 * then has to invert to white to stay legible, which is what
 * {@link badgeGlyphColor} is for. `backingOpacity` is the disc's own
 * alpha, independent of any fade the glyph gets: at 1 the badge reads as
 * a *control* sitting on the canvas, lower is enough to lift it off busy
 * artwork without looking pressable, and 0 omits the disc entirely.
 */
const fillBadgeDisc = (
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  color: string,
  filled: boolean,
  backingOpacity: number,
) => {
  context.beginPath();
  context.arc(cx, cy, r, 0, Math.PI * 2);
  if (backingOpacity > 0) {
    context.globalAlpha = backingOpacity;
    context.fillStyle = filled ? color : "#ffffff";
    context.fill();
  }
};

/** White on a filled disc, the badge's own colour otherwise — including
 * when there is no disc at all to invert against. */
const badgeGlyphColor = (color: string, filled: boolean): string =>
  filled ? "#ffffff" : color;

/** The padlock silhouette itself, in the current stroke / fill colour.
 * `locked` closes the shackle; open lifts and tilts it to one side. */
const strokePadlockGlyph = (
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  locked: boolean,
) => {
  const bodyW = r * 0.9;
  const bodyH = r * 0.75;
  const bodyTop = cy - bodyH * 0.15;
  const shackleR = bodyW * 0.42;
  const shackleCx = cx + (locked ? 0 : shackleR * 0.6);
  const shackleCy = bodyTop - (locked ? 0 : r * 0.12);

  context.beginPath();
  context.arc(shackleCx, shackleCy, shackleR, Math.PI, locked ? 0 : -0.15);
  context.stroke();

  context.beginPath();
  context.rect(cx - bodyW / 2, bodyTop, bodyW, bodyH);
  context.fill();
};

/**
 * The padlock badge marking an arrow's bound endpoint: always on a white
 * disc, never filled.
 *
 * A binding is not an alignment, and this is not the alignment guides'
 * toggle — it reports a fact about the arrow rather than offering a
 * choice, and it appears on the arrow's point handles, where a solid
 * disc would swamp the handle it is sitting on. `drawAlignmentPadlock`
 * is the one that fills, and the two are kept apart deliberately so
 * tuning one can't quietly restyle the other.
 *
 * `radius` (screen px, defaulting to {@link INDICATOR_BADGE_RADIUS}) lets
 * a caller match a badge it is drawn on top of; everything else scales
 * off it. `backingOpacity` fades the disc for the passive form, shown
 * when the *bound shape* is selected rather than the arrow.
 */
export const drawPadlock = (
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  zoom: number,
  color: string,
  locked: boolean,
  radius: number = INDICATOR_BADGE_RADIUS,
  backingOpacity: number = 1,
) => {
  const r = radius / zoom;

  context.save();
  context.lineWidth = Math.max(1 / zoom, r * 0.14);

  fillBadgeDisc(context, cx, cy, r, color, false, backingOpacity);

  context.globalAlpha = locked ? 1 : INACTIVE_ICON_OPACITY;
  context.strokeStyle = color;
  context.stroke();

  context.fillStyle = color;
  strokePadlockGlyph(context, cx, cy, r, locked);
  context.restore();
};

/**
 * The padlock badge on an edge-alignment guide — the soft/hard toggle,
 * so unlike {@link drawPadlock} it fills when active: these are controls
 * with two states, and a solid chip says "on" without being examined.
 *
 * The other two marks in this vocabulary are deliberately different
 * shapes because they say different things: an anvil
 * ({@link renderAlignmentLocks}) is about one element's own weight, and
 * {@link drawEqualsBadge} is about two gaps being the same size.
 */
export const drawAlignmentPadlock = (
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  zoom: number,
  color: string,
  locked: boolean,
) => {
  const r = INDICATOR_BADGE_RADIUS / zoom;
  const glyph = badgeGlyphColor(color, locked);

  context.save();
  context.lineWidth = Math.max(1 / zoom, r * 0.14);

  fillBadgeDisc(context, cx, cy, r, color, locked, 1);

  context.globalAlpha = locked ? 1 : INACTIVE_ICON_OPACITY;
  context.strokeStyle = color;
  context.stroke();

  context.strokeStyle = glyph;
  context.fillStyle = glyph;
  strokePadlockGlyph(context, cx, cy, r, locked);
  context.restore();
};

/**
 * An equals badge on a white disc — the equal-gap counterpart of
 * {@link drawAlignmentPadlock}, and its sibling in every other respect
 * (same disc, same fill when active, same fade when not).
 *
 * A different icon because it makes a different claim. A padlock says
 * "this pair is pinned together"; the two badges of a gap guide sit in
 * two different gaps and say "these two are the same size". Drawing both
 * as padlocks left the user with four identical chips around a selection
 * meaning two unrelated things — and the equals sign happens to be
 * exactly the assertion, which is the best case an icon can hope for.
 *
 * State is carried by the filled disc and by opacity, not by a shape
 * change (the padlock's open/closed shackle): at badge size there is no
 * room for a legible "broken equals", and the guide's own solid/dashed
 * line is already saying the same thing next to it.
 */
export const drawEqualsBadge = (
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  zoom: number,
  color: string,
  locked: boolean,
) => {
  const r = INDICATOR_BADGE_RADIUS / zoom;
  const halfBar = r * 0.44;
  const barGap = r * 0.26;

  context.save();
  context.lineWidth = Math.max(1 / zoom, r * 0.14);

  fillBadgeDisc(context, cx, cy, r, color, locked, 1);

  context.globalAlpha = locked ? 1 : INACTIVE_ICON_OPACITY;
  context.strokeStyle = color;
  context.stroke();

  context.strokeStyle = badgeGlyphColor(color, locked);
  context.lineWidth = Math.max(1 / zoom, r * 0.2);
  context.lineCap = "round";
  for (const dy of [-barGap, barGap]) {
    context.beginPath();
    context.moveTo(cx - halfBar, cy + dy);
    context.lineTo(cx + halfBar, cy + dy);
    context.stroke();
  }
  context.restore();
};

/** Half-diagonal, in screen px, of the cross marking an anchor point. */
export const INDICATOR_CROSS_SIZE = 2;

/**
 * The X marking a point an indicator line is anchored to — an element
 * corner or centre. `size` is already zoom-scaled by the caller.
 */
export const drawIndicatorCross = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
) => {
  context.save();
  context.beginPath();
  context.moveTo(x - size, y - size);
  context.lineTo(x + size, y + size);
  context.moveTo(x + size, y - size);
  context.lineTo(x - size, y + size);
  context.stroke();
  context.restore();
};

export const getWideIndicatorLineDash = (zoom: number): number[] => [
  5 / zoom,
  4 / zoom,
];

export const getNarrowIndicatorLineDash = (zoom: number): number[] => [
  3 / zoom,
  2 / zoom,
];


export const fillCircle = (
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  stroke: boolean,
  fill = true,
) => {
  context.beginPath();
  context.arc(cx, cy, radius, 0, Math.PI * 2);
  if (fill) {
    context.fill();
  }
  if (stroke) {
    context.stroke();
  }
};

export const getNormalizedCanvasDimensions = (
  canvas: HTMLCanvasElement,
  scale: number,
): [number, number] => {
  // When doing calculations based on canvas width we should used normalized one
  return [canvas.width / scale, canvas.height / scale];
};

export const bootstrapCanvas = ({
  canvas,
  scale,
  normalizedWidth,
  normalizedHeight,
  theme,
  isExporting,
  viewBackgroundColor,
}: {
  canvas: HTMLCanvasElement;
  scale: number;
  normalizedWidth: number;
  normalizedHeight: number;
  theme?: AppState["theme"];
  isExporting?: StaticCanvasRenderConfig["isExporting"];
  viewBackgroundColor?: StaticCanvasAppState["viewBackgroundColor"];
}): CanvasRenderingContext2D => {
  const context = canvas.getContext("2d")!;

  context.setTransform(1, 0, 0, 1, 0, 0);
  context.scale(scale, scale);

  // Paint background
  if (typeof viewBackgroundColor === "string") {
    // An opaque fill repaints every pixel, so clearRect would be redundant.
    // For anything else — transparency, or a value we can't be certain about
    // (e.g. corrupted persisted state like "0000") — clear first so the
    // previous frame can't bleed through.
    //
    // We skip opaque #RRGGBB and #RGB hex colors as a quick optimization.
    const isOpaque = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(viewBackgroundColor);

    if (!isOpaque) {
      context.clearRect(0, 0, normalizedWidth, normalizedHeight);
    }

    if (viewBackgroundColor !== "transparent") {
      context.save();
      // The canvas silently ignores an invalid fillStyle, which would leave a
      // stale color from a previous draw. Seed a sane default so corrupted
      // values fall back to white instead of painting garbage.
      context.fillStyle = COLOR_WHITE;
      context.fillStyle = applyDarkModeFilter(
        viewBackgroundColor,
        theme === THEME.DARK,
      );
      context.fillRect(0, 0, normalizedWidth, normalizedHeight);
      context.restore();
    }
  } else {
    context.clearRect(0, 0, normalizedWidth, normalizedHeight);
  }

  return context;
};

export const strokeRectWithRotation_simple = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  cx: number,
  cy: number,
  angle: number,
  fill: boolean = false,
  /** should account for zoom */
  radius: number = 0,
) => {
  context.save();
  context.translate(cx, cy);
  context.rotate(angle);
  if (fill) {
    context.fillRect(x - cx, y - cy, width, height);
  }
  if (radius && context.roundRect) {
    context.beginPath();
    context.roundRect(x - cx, y - cy, width, height, radius);
    context.stroke();
    context.closePath();
  } else {
    context.strokeRect(x - cx, y - cy, width, height);
  }
  context.restore();
};
