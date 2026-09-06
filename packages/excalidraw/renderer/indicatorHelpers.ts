import { THEME } from "@excalidraw/common";

import type { AppState } from "../types";

// ---------------------------------------------------------------------------
// Shared by every indicator
// ---------------------------------------------------------------------------

/** Stroke weight of every indicator line — guides, snap lines, leaders.
 * A hairline: these annotate the drawing, they aren't part of it. */
const INDICATOR_LINE_WIDTH = 1;

/** How far a hovered line's wash spreads either side of it, and how faint
 * it is. Narrower than the badge's halo deliberately: a line is long, so
 * it covers ground a badge never does, and the same spread that reads as
 * a soft glow round a chip reads as a stripe drawn across the canvas. */
const LINE_HOVER_HALO_WIDTH = 2;
const LINE_HOVER_HALO_OPACITY = 0.35;

/**
 * Zen mode draws little more than the crosses and the gap ticks, so what
 * survives is thickened to carry the whole message on its own.
 */
const ZEN_MODE_EMPHASIS = 1.5;

/** The inactive state of an icon — an open padlock, a lifted anvil — is
 * drawn faded to read as the weaker of the two. */
const INACTIVE_ICON_OPACITY = 0.45;

const ALIGNMENT_COLOR_LIGHT = "#e03131";
const ALIGNMENT_COLOR_DARK = "#ffa8a8";

export const getAlignmentIndicatorColor = (
  theme: AppState["theme"],
  zenModeEnabled: boolean,
): string =>
  theme === THEME.LIGHT || zenModeEnabled
    ? ALIGNMENT_COLOR_LIGHT
    : ALIGNMENT_COLOR_DARK;

// ---------------------------------------------------------------------------
// Badges and their glyphs
// ---------------------------------------------------------------------------

// Radius of a round indicator badge. Exported for hit testing.
export const INDICATOR_BADGE_RADIUS = 9;

/** The badge disc's own colour when it isn't filled with the badge's
 * colour. Also the colour a glyph inverts to. */
const BADGE_DISC_COLOR = "#ffffff";

/** Rim and glyph stroke weight, as a fraction of the badge radius — so a
 * badge keeps its proportions at any radius it is drawn at. */
const BADGE_LINE_RATIO = 0.14;

// How far the hover halo extends past the badge's rim
const BADGE_HOVER_HALO_WIDTH = 4;

const BADGE_HOVER_HALO_OPACITY = 0.35;

/** Badge centres closer together than this belong to one cluster. A badge
 * is `2 * INDICATOR_BADGE_RADIUS` across, so anything under that is
 * already overlapping; a little more also catches the ones that merely
 * touch, which are just as hard to aim between. */
export const BADGE_CLUSTER_DISTANCE = 20;

/** The ring a cluster's badges sit on once opened. Big enough that the
 * circumference seats them all without touching, and never so small that
 * the fan reads as one blob — {@link getBadgeFanRadius}. */
const BADGE_FAN_MIN_RADIUS = 20;
const BADGE_FAN_ARC_PER_BADGE = 2.4;

/** The count on a collapsed cluster, as a fraction of the badge radius. */
const BADGE_COUNT_FONT_RATIO = 1.25;

/** The outline drawn round every element a hovered badge's alignment
 * involves: a broad, translucent band rather than a line, so it reads as
 * a wash over the element the way a selection highlight does. Weight is
 * what carries it across a crowded canvas; the alpha is what keeps it
 * from competing with the guides and badges drawn on top of it.
 *
 * Stroked on the bounds themselves rather than offset from them, so the
 * band straddles the element's edge — the same placement as the green
 * selection halo, which is centred on the silhouette it traces. Sitting
 * on the edge is what makes it read as a mark *on* the element; a band
 * floating clear of the bounds reads as a box drawn around it, and next
 * to an alignment guide running along that same edge, a box is one more
 * line to tell apart. */
const ALIGNMENT_HIGHLIGHT_LINE_WIDTH = 6;
const ALIGNMENT_HIGHLIGHT_OPACITY = 0.4;
const ALIGNMENT_HIGHLIGHT_CORNER_RADIUS = 4;

/** The padlock silhouette, in fractions of the badge radius (or, where
 * noted, of another part of the lock). */
const PADLOCK_GLYPH = {
  /** body width and height */
  bodyWidth: 0.9,
  bodyHeight: 0.75,
  /** how far the body's top sits above centre, × bodyHeight */
  bodyRise: 0.15,
  /** shackle radius, × bodyWidth */
  shackleRadius: 0.42,
  /** open: the shackle slides sideways and lifts off the body */
  openShackleShift: 0.6,
  openShackleLift: 0.12,
  /** open: the arc stops short of the body instead of meeting it */
  openShackleEndAngle: -0.15,
} as const;

/** The equals sign, in fractions of the badge radius. */
const EQUALS_GLYPH = {
  halfBar: 0.44,
  /** each bar's distance from centre */
  barGap: 0.26,
  /** bar weight — heavier than the rim, so the sign reads at badge size */
  barWidth: 0.2,
} as const;

// ---------------------------------------------------------------------------
// Anchor crosses
// ---------------------------------------------------------------------------

/** Half-diagonal of the cross marking a point an indicator line is
 * anchored to. */
const INDICATOR_CROSS_SIZE = 2;

// ---------------------------------------------------------------------------
// Gap spans
// ---------------------------------------------------------------------------

/**
 * Half-length of the tick capping each end of a gap span, and of
 * upstream's transient gap snap line. One constant because a hard gap has
 * to read as the same measurement the snap just showed, only kept.
 */
const GAP_CAP_SIZE = 8;

/** The midpoint mark on an unbadged gap span, in fractions of
 * {@link GAP_CAP_SIZE}: a pair of short ticks straddling the centre, half
 * the height of the end caps. */
const GAP_TICK_HALF_HEIGHT = 0.5;
const GAP_TICK_SPREAD = 0.25;

// ---------------------------------------------------------------------------
// Arrow bindings
// ---------------------------------------------------------------------------

// Colour of the arrow-binding padlocks taken from the the point handle stroke
const BINDING_LOCK_COLOR = "#5e5ad8";
const BINDING_LOCK_COLOR_PASSIVE = "#5e5ad8";

/** The passive binding padlock's disc opacity: enough white to keep the
 * glyph readable where the arrow's stroke runs beneath, without the weight
 * of the solid disc the interactive form gets. Its rimlessness is a
 * separate choice — see {@link drawBindingPadlock}. */
const BINDING_LOCK_PASSIVE_BACKING = 0.6;

/** How much wider the binding padlock is than the point handle it covers.
 * This is because the padlock inside the disc create an optical illusion 
 * that makes the badge look smaller than is actually is. */
const BINDING_PADLOCK_HANDLE_PADDING = 2;

/** Radius of the dot capping the binding leader at its port end. */
const BINDING_LEADER_DOT_RADIUS = 2;

// ---------------------------------------------------------------------------
// Anchor anvils
// ---------------------------------------------------------------------------

/** The anchor *button* that toggles whether an element is anchored
 * The purple is taken from Excalidraw's selection color */
const ANCHOR_BUTTON_COLOR = "#6965db";

// Anchor color when the user is attempting a drag that is blocked
const ANCHOR_WARNING_COLOR_LIGHT = "#a51111";
const ANCHOR_WARNING_COLOR_DARK = "#ff6b6b";

/** The anvil's height for an element: a fraction of the element's shorter
 * side, clamped to a screen-space range so it still reads on a tiny shape
 * and doesn't swamp a huge one. */
const ANCHOR_ICON_SIZE_RATIO = 0.6;
const ANCHOR_ICON_MIN_SIZE = 16;
const ANCHOR_ICON_MAX_SIZE = 60;

/** Outline weight as a fraction of the anvil's height. The resting weight
 * is thin enough to sit quietly over the element's own artwork; hover
 * thickens it to the warning overlay's weight, which is the affordance —
 * the icon firms up under the pointer to say it can be clicked. */
const ANCHOR_LINE_RATIO = 0.03;
const ANCHOR_LINE_RATIO_HOVER = 0.06;

/** Opacity of an anvil overlay drawn over an element's own fill: it has
 * to stay translucent enough to read as an annotation rather than as part
 * of the drawing. */
const ANCHOR_OVERLAY_OPACITY = 0.6;

/**
 * Anvil silhouette, as offsets from the icon's centre in units of its
 * height: overhanging horn on the left, wide face on top, pinched waist,
 * flared foot. Traced clockwise from the top-left of the face.
 */
const ANVIL_PATH: readonly (readonly [number, number])[] = [
  [-0.25, -0.5], // face, top-left
  [0.57, -0.5], // face, top-right
  [0.57, -0.3], // face, bottom-right
  [0.25, -0.2], // underside sloping in to the waist
  [0.19, 0.1], // waist, right
  [0.45, 0.3], // foot flares out
  [0.45, 0.5], // foot, bottom-right
  [-0.35, 0.5], // foot, bottom-left
  [-0.35, 0.3],
  [-0.09, 0.1], // waist, left
  [-0.19, -0.2],
  [-0.57, -0.28], // horn tip
];

// ---------------------------------------------------------------------------
// Line style
// ---------------------------------------------------------------------------

/** Stroke weight for any indicator line, at this zoom. Zen mode thickens
 * it, since most of the line work is suppressed there. */
export const getIndicatorLineWidth = (
  zoom: number,
  zenModeEnabled = false,
): number =>
  (zenModeEnabled ? INDICATOR_LINE_WIDTH * ZEN_MODE_EMPHASIS : INDICATOR_LINE_WIDTH) /
  zoom;

/** Dashed means soft: a coincidence that holds right now but isn't kept.
 *
 * Two weights, and which one a line takes says what kind of line it is
 * rather than how strong it is. Edge alignments and point snaps take the
 * wide dash; gap spans take the narrow one, matching upstream's transient
 * gap line, because a soft gap guide is offering exactly the relationship
 * that line just showed. */
export const getWideIndicatorLineDash = (zoom: number): number[] => [
  5 / zoom,
  4 / zoom,
];

export const getNarrowIndicatorLineDash = (zoom: number): number[] => [
  3 / zoom,
  2 / zoom,
];

// ---------------------------------------------------------------------------
// Badge internals
// ---------------------------------------------------------------------------

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
    context.fillStyle = filled ? color : BADGE_DISC_COLOR;
    context.fill();
  }
};

/** White on a filled disc, the badge's own colour otherwise — including
 * when there is no disc at all to invert against. */
const badgeGlyphColor = (color: string, filled: boolean): string =>
  filled ? BADGE_DISC_COLOR : color;

/** The badge's rim and glyph weight at a given radius, never thinner than
 * a device pixel however far out the canvas is zoomed. */
const badgeLineWidth = (r: number, zoom: number): number =>
  Math.max(1 / zoom, r * BADGE_LINE_RATIO);

/**
 * The soft ring drawn behind a badge the pointer is over — the same
 * affordance a linear element's point handle gets on hover
 * (`renderPointHighlight`), in the badge's own colour rather than the
 * handle purple.
 *
 * Drawn first, so the badge's opaque disc covers the middle and only the
 * fringe shows. It carries no state of its own: it says "clickable", and
 * the disc underneath still says locked or not.
 */
const drawBadgeHoverHalo = (
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  zoom: number,
  color: string,
) => {
  context.save();
  context.globalAlpha = BADGE_HOVER_HALO_OPACITY;
  context.fillStyle = color;
  context.beginPath();
  context.arc(cx, cy, r + BADGE_HOVER_HALO_WIDTH / zoom, 0, Math.PI * 2);
  context.fill();
  context.restore();
};

/** The padlock silhouette itself, in the current stroke / fill colour.
 * `locked` closes the shackle; open lifts and tilts it to one side. */
const strokePadlockGlyph = (
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  locked: boolean,
) => {
  const bodyW = r * PADLOCK_GLYPH.bodyWidth;
  const bodyH = r * PADLOCK_GLYPH.bodyHeight;
  const bodyTop = cy - bodyH * PADLOCK_GLYPH.bodyRise;
  const shackleR = bodyW * PADLOCK_GLYPH.shackleRadius;
  const shackleCx =
    cx + (locked ? 0 : shackleR * PADLOCK_GLYPH.openShackleShift);
  const shackleCy = bodyTop - (locked ? 0 : r * PADLOCK_GLYPH.openShackleLift);

  context.beginPath();
  context.arc(
    shackleCx,
    shackleCy,
    shackleR,
    Math.PI,
    locked ? 0 : PADLOCK_GLYPH.openShackleEndAngle,
  );
  context.stroke();

  context.beginPath();
  context.rect(cx - bodyW / 2, bodyTop, bodyW, bodyH);
  context.fill();
};

// ---------------------------------------------------------------------------
// Alignment badges
// ---------------------------------------------------------------------------

/**
 * The padlock badge on an edge-alignment guide — the soft/hard toggle. It
 * fills when active: these are controls with two states, and a solid chip
 * says "on" without being examined.
 *
 * The other two marks in this vocabulary are deliberately different
 * shapes because they say different things: an anvil
 * ({@link drawAnchorOverlayButton}) is about one element's own weight, and
 * {@link drawEqualsBadge} is about two gaps being the same size.
 */
export const drawAlignmentPadlock = (
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  zoom: number,
  color: string,
  locked: boolean,
  hovered = false,
) => {
  const r = INDICATOR_BADGE_RADIUS / zoom;
  const glyph = badgeGlyphColor(color, locked);

  if (hovered) {
    drawBadgeHoverHalo(context, cx, cy, r, zoom, color);
  }

  context.save();
  context.lineWidth = badgeLineWidth(r, zoom);

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
 */
export const drawEqualsBadge = (
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  zoom: number,
  color: string,
  locked: boolean,
  hovered = false,
) => {
  const r = INDICATOR_BADGE_RADIUS / zoom;
  const halfBar = r * EQUALS_GLYPH.halfBar;
  const barGap = r * EQUALS_GLYPH.barGap;

  if (hovered) {
    drawBadgeHoverHalo(context, cx, cy, r, zoom, color);
  }

  context.save();
  context.lineWidth = badgeLineWidth(r, zoom);

  fillBadgeDisc(context, cx, cy, r, color, locked, 1);

  context.globalAlpha = locked ? 1 : INACTIVE_ICON_OPACITY;
  context.strokeStyle = color;
  context.stroke();

  context.strokeStyle = badgeGlyphColor(color, locked);
  context.lineWidth = Math.max(1 / zoom, r * EQUALS_GLYPH.barWidth);
  context.lineCap = "round";
  for (const dy of [-barGap, barGap]) {
    context.beginPath();
    context.moveTo(cx - halfBar, cy + dy);
    context.lineTo(cx + halfBar, cy + dy);
    context.stroke();
  }
  context.restore();
};

// ---------------------------------------------------------------------------
// Badge clusters
// ---------------------------------------------------------------------------

/**
 * How far from its anchor a cluster's badges sit once fanned out.
 *
 * Derived from the count rather than fixed, so the ring grows as it has
 * to: each badge needs a slice of arc a bit wider than itself, and
 * `2πr = n · arc` is what that costs in radius. The floor keeps a pair
 * from opening into a ring so tight it reads as the blob it replaced.
 */
export const getBadgeFanRadius = (count: number, zoom: number): number =>
  Math.max(
    BADGE_FAN_MIN_RADIUS,
    (count * INDICATOR_BADGE_RADIUS * BADGE_FAN_ARC_PER_BADGE) / (2 * Math.PI),
  ) / zoom;

/**
 * A cluster of badges too close to aim between, drawn as one badge
 * carrying how many it stands for.
 *
 * Deliberately not a padlock or an equals sign: it is not a control and
 * toggles nothing, so it must not offer either glyph's promise. It is a
 * count, and what it affords is *opening* — which is why it takes the
 * plain disc and rim every badge shares, and nothing else.
 */
export const drawAlignmentClusterBadge = (
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  zoom: number,
  color: string,
  count: number,
) => {
  const r = INDICATOR_BADGE_RADIUS / zoom;

  context.save();
  context.lineWidth = badgeLineWidth(r, zoom);

  fillBadgeDisc(context, cx, cy, r, color, false, 1);
  context.strokeStyle = color;
  context.stroke();

  context.fillStyle = color;
  context.font = `600 ${r * BADGE_COUNT_FONT_RATIO}px sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(String(count), cx, cy);
  context.restore();
};

// ---------------------------------------------------------------------------
// Binding marks
// ---------------------------------------------------------------------------

/**
 * The padlock marking an arrow's bound endpoint: "this end is attached to
 * that shape".
 *
 * `onHandle` is the whole difference between its two forms, and it is not
 * a style flag — it says whether the arrow itself is selected, i.e.
 * whether there is a point handle underneath. On a handle the badge is a
 * *control*: full-strength purple, a solid disc and a rim, sized to the
 * handle it covers so it reads as that control rather than as something
 * sitting over it. Looking pressable is honest there — the handle really
 * is draggable. Off a handle the same mark is pure *annotation*: the
 * washed-out purple, a translucent disc and no rim, because a stroked
 * edge is the part of a badge that draws a border and invites a click
 * there is nothing to accept. The disc survives either way, since it is
 * what keeps the glyph readable where the arrow's own stroke runs
 * beneath.
 *
 * A binding is not an alignment, so this is deliberately not
 * {@link drawAlignmentPadlock}: purple rather than red, and it reports a
 * fact rather than offering a toggle. `handleRadius` is the point
 * handle's own radius; the padding is added here.
 */
export const drawBindingPadlock = (
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  zoom: number,
  handleRadius: number,
  onHandle: boolean,
) => {
  const r = (handleRadius + BINDING_PADLOCK_HANDLE_PADDING) / zoom;
  const color = onHandle ? BINDING_LOCK_COLOR : BINDING_LOCK_COLOR_PASSIVE;

  context.save();
  context.lineWidth = badgeLineWidth(r, zoom);

  fillBadgeDisc(
    context,
    cx,
    cy,
    r,
    color,
    false,
    onHandle ? 1 : BINDING_LOCK_PASSIVE_BACKING,
  );
  if (onHandle) {
    context.strokeStyle = color;
    context.stroke();
  }

  context.strokeStyle = color;
  context.fillStyle = color;
  strokePadlockGlyph(context, cx, cy, r, true);
  context.restore();
};

/**
 * A dashed leader from an arrow's endpoint to the edge midpoint it is
 * bound to, with a dot on the port end so it reads as pointing *at*
 * something. Coloured to match the padlock at the other end of it — same
 * `onHandle` question, same answer.
 */
export const drawBindingLeader = (
  context: CanvasRenderingContext2D,
  endpoint: readonly [number, number],
  port: readonly [number, number],
  zoom: number,
  onHandle: boolean,
) => {
  const color = onHandle ? BINDING_LOCK_COLOR : BINDING_LOCK_COLOR_PASSIVE;

  context.save();
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = getIndicatorLineWidth(zoom);
  context.setLineDash(getNarrowIndicatorLineDash(zoom));
  context.beginPath();
  context.moveTo(endpoint[0], endpoint[1]);
  context.lineTo(port[0], port[1]);
  context.stroke();

  context.setLineDash([]);
  context.beginPath();
  context.arc(port[0], port[1], BINDING_LEADER_DOT_RADIUS / zoom, 0, Math.PI * 2);
  context.fill();
  context.restore();
};

/**
 * A rounded outline round one element's bounds, marking it as a party to
 * the alignment whose badge the pointer is on.
 *
 * In the alignment colour rather than a state of its own: it answers
 * "which elements is this guide talking about", so it is the same
 * assertion the guide line makes and should look like it. Several
 * alignments in a crowded selection can be geometrically identical, and
 * this is what tells them apart.
 *
 * Drawn on the axis-aligned bounds even for a rotated element, because
 * that is the box alignment itself works from (`getElementBounds`) — an
 * outline hugging the rotated shape would claim a different box than the
 * one the guide is derived from.
 */
export const drawAlignmentHighlight = (
  context: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  zoom: number,
  color: string,
) => {
  const radius = ALIGNMENT_HIGHLIGHT_CORNER_RADIUS / zoom;
  const w = x2 - x1;
  const h = y2 - y1;

  context.save();
  context.globalAlpha = ALIGNMENT_HIGHLIGHT_OPACITY;
  context.strokeStyle = color;
  context.lineWidth = ALIGNMENT_HIGHLIGHT_LINE_WIDTH / zoom;
  context.lineJoin = "round";
  context.setLineDash([]);
  context.beginPath();
  if (context.roundRect) {
    context.roundRect(x1, y1, w, h, radius);
  } else {
    context.rect(x1, y1, w, h);
  }
  context.stroke();
  context.restore();
};

// ---------------------------------------------------------------------------
// Line marks
// ---------------------------------------------------------------------------

/**
 * The wash behind an indicator line the pointer's badge belongs to — the
 * line's own {@link drawBadgeHoverHalo}, spread along it instead of round
 * a point, so hovering the badge lights the whole assertion rather than
 * just the chip that names it.
 *
 * Always solid, whatever dash the line above carries: a dashed halo would
 * read as a second, thicker guide rather than as backing for the one
 * already there. Butt caps, so it stops exactly where the line does — the
 * line's ends are its anchor points, and a cap overhanging them would put
 * colour past the thing being marked.
 */
export const drawIndicatorLineHalo = (
  context: CanvasRenderingContext2D,
  from: readonly [number, number],
  to: readonly [number, number],
  zoom: number,
  color: string,
) => {
  context.save();
  context.globalAlpha = LINE_HOVER_HALO_OPACITY;
  context.strokeStyle = color;
  context.lineWidth =
    getIndicatorLineWidth(zoom) + (LINE_HOVER_HALO_WIDTH * 2) / zoom;
  context.lineCap = "butt";
  context.setLineDash([]);
  context.beginPath();
  context.moveTo(from[0], from[1]);
  context.lineTo(to[0], to[1]);
  context.stroke();
  context.restore();
};

/**
 * The X marking a point an indicator line is anchored to — an element
 * corner or centre. Always solid, whatever dash the line it belongs to
 * carries: it is a couple of px across and would disappear into the gaps.
 */
export const drawIndicatorCross = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  zenModeEnabled = false,
) => {
  const size =
    (zenModeEnabled
      ? INDICATOR_CROSS_SIZE * ZEN_MODE_EMPHASIS
      : INDICATOR_CROSS_SIZE) / zoom;
  context.save();
  context.setLineDash([]);
  context.beginPath();
  context.moveTo(x - size, y - size);
  context.lineTo(x + size, y + size);
  context.moveTo(x + size, y - size);
  context.lineTo(x - size, y + size);
  context.stroke();
  context.restore();
};

/**
 * The tick capping one end of a gap measurement, perpendicular to the
 * axis the gap runs along. Solid for the same reason the cross is: these
 * are the measurement's endpoints.
 */
export const drawGapEndCap = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  axis: "x" | "y",
  zoom: number,
) => {
  const cap = GAP_CAP_SIZE / zoom;
  context.save();
  context.setLineDash([]);
  context.beginPath();
  if (axis === "x") {
    context.moveTo(x, y - cap);
    context.lineTo(x, y + cap);
  } else {
    context.moveTo(x - cap, y);
    context.lineTo(x + cap, y);
  }
  context.stroke();
  context.restore();
};

/**
 * Upstream's midpoint mark for a gap: a pair of short ticks straddling
 * the centre, half the height of the end caps. It is what tells a gap
 * line apart from an alignment line at a glance, so a span with no badge
 * to occupy its middle needs it — where a badge *is* drawn the ticks
 * would only hide behind the disc.
 */
export const drawGapMidpointTicks = (
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  axis: "x" | "y",
  zoom: number,
) => {
  const cap = GAP_CAP_SIZE / zoom;
  const half = cap * GAP_TICK_HALF_HEIGHT;
  const spread = cap * GAP_TICK_SPREAD;

  context.save();
  context.setLineDash([]);
  for (const offset of [-spread, spread]) {
    context.beginPath();
    if (axis === "x") {
      context.moveTo(cx + offset, cy - half);
      context.lineTo(cx + offset, cy + half);
    } else {
      context.moveTo(cx - half, cy + offset);
      context.lineTo(cx + half, cy + offset);
    }
    context.stroke();
  }
  context.restore();
};

// ---------------------------------------------------------------------------
// Anchor anvils
// ---------------------------------------------------------------------------

// Calculate the anvil's height given an element's shorter side.
export const getAnchorIconSize = (
  minDimension: number,
  zoom: number,
): number =>
  Math.min(
    Math.max(minDimension * ANCHOR_ICON_SIZE_RATIO, ANCHOR_ICON_MIN_SIZE / zoom),
    ANCHOR_ICON_MAX_SIZE / zoom,
  );

// An anvil centred on (cx, cy) and `size` tall
const drawAnvil = (
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  color: string,
  lineWidth: number,
  filled: boolean,
) => {
  context.save();
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = lineWidth;
  context.lineJoin = "round";

  context.beginPath();
  ANVIL_PATH.forEach(([dx, dy], i) => {
    const x = cx + dx * size;
    const y = cy + dy * size;
    if (i === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  });
  context.closePath();

  if (filled) {
    context.fill();
    // stroke too, so the filled anvil reads at the same outer size as
    // the hollow one rather than shrinking by half a line width
    context.stroke();
  } else {
    context.stroke();
  }

  context.restore();
};

// A large, translucent anvil centred on and scaled to an element
const drawAnchorOverlay = (
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  color: string,
  anchored: boolean,
  hovered: boolean,
) => {
  const ratio = hovered ? ANCHOR_LINE_RATIO_HOVER : ANCHOR_LINE_RATIO;
  context.save();
  context.globalAlpha = anchored
    ? ANCHOR_OVERLAY_OPACITY
    : ANCHOR_OVERLAY_OPACITY * INACTIVE_ICON_OPACITY;
  drawAnvil(context, cx, cy, size, color, Math.max(size * ratio, 1), anchored);
  context.restore();
};

// The anchor button which can be clicked
export const drawAnchorOverlayButton = (
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  anchored: boolean,
  hovered: boolean,
) => {
  drawAnchorOverlay(
    context,
    cx,
    cy,
    size,
    ANCHOR_BUTTON_COLOR,
    anchored,
    hovered,
  );
};

// The anchor warning shown mid-gesture on an anchored element if it is
// blocking the drag or resize the user is attempting
// Since it is a warning, it is always filled and thick
export const drawAnchorOverlayWarning = (
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  theme: AppState["theme"],
  zenModeEnabled: boolean,
) => {
  const color =
    theme === THEME.LIGHT || zenModeEnabled
      ? ANCHOR_WARNING_COLOR_LIGHT
      : ANCHOR_WARNING_COLOR_DARK;
  drawAnchorOverlay(context, cx, cy, size, color, true, true);
};
