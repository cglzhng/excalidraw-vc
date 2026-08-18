import { THEME } from "@excalidraw/common";

import {
  getAlignmentGuides,
  getAlignmentMovers,
  getElementBounds,
  getGapAlignmentGuides,
  isAlignable,
  isAlignmentAnchor,
} from "@excalidraw/element";

import {
  INACTIVE_ICON_OPACITY,
  INDICATOR_CROSS_SIZE,
  drawAlignmentPadlock,
  drawEqualsBadge,
  drawIndicatorCross,
  getIndicatorColor,
  getNarrowIndicatorLineDash,
  getWideIndicatorLineDash,
} from "./helpers";

import type { Bounds } from "@excalidraw/common";
import type { AlignmentGuide, GapAlignmentGuide } from "@excalidraw/element";
import type {
  NonDeletedExcalidrawElement,
  NonDeletedSceneElementsMap,
} from "@excalidraw/element/types";

import type { InteractiveCanvasAppState } from "../types";

/**
 * Alignment guides for the current selection. Two kinds share one line
 * style vocabulary:
 *
 *   - hard (persisted `alignments`): solid line, closed padlock;
 *   - soft (live edge coincidence, never stored): dashed line, open
 *     padlock.
 *
 * Clicking a line's padlock toggles between the two (`lockAlignmentPair`
 * / `unlockAlignmentPair`), so this is both the indicator and the only
 * creation UI. The geometry is shared with the pointer handler via
 * `getAlignmentGuideLines`, which hit-tests the same padlock positions.
 */

const edgeCoord = (
  bounds: Bounds,
  axis: "x" | "y",
  edge: "min" | "center" | "max",
): number => {
  const min = axis === "x" ? bounds[0] : bounds[1];
  const max = axis === "x" ? bounds[2] : bounds[3];
  return edge === "min" ? min : edge === "max" ? max : (min + max) / 2;
};

/**
 * How far along the line an element reaches — the anchor points it
 * contributes, as `[min, max]` on the axis the line *runs* along (the
 * perpendicular of `axis`).
 *
 * This is the rule that makes an alignment guide look like a snap guide:
 * snapping derives its lines from element corners and centres, so a side
 * (min / max) contributes that whole side of the element, while a centre
 * contributes a single point. Hence a centre-to-centre guide is drawn
 * centre-to-centre rather than across both elements, exactly as the
 * transient snap guide for the same coincidence would be.
 */
const anchorExtent = (
  bounds: Bounds,
  axis: "x" | "y",
  edge: "min" | "center" | "max",
): [number, number] => {
  const [lo, hi] =
    axis === "x" ? [bounds[1], bounds[3]] : [bounds[0], bounds[2]];
  if (edge === "center") {
    const mid = (lo + hi) / 2;
    return [mid, mid];
  }
  return [lo, hi];
};

export type AlignmentGuideLine = {
  guide: AlignmentGuide;
  /** line endpoints, scene coords */
  from: [number, number];
  to: [number, number];
  /** anchor points to mark with a cross, scene coords */
  crosses: [number, number][];
  /** padlock badge centre, scene coords */
  icon: [number, number];
};

/**
 * The lines to draw for the current selection, with each line's padlock
 * position. Shared by the renderer and the pointer handler so a click
 * hit-tests exactly what is drawn.
 */
export const getAlignmentGuideLines = (
  selectedElements: readonly NonDeletedExcalidrawElement[],
  elementsMap: NonDeletedSceneElementsMap,
): AlignmentGuideLine[] => {
  const lines: AlignmentGuideLine[] = [];
  for (const guide of getAlignmentGuides(selectedElements, elementsMap)) {
    const self = elementsMap.get(guide.selfId);
    const partner = elementsMap.get(guide.elementId);
    if (!self || !partner) {
      continue;
    }
    const boundsA = getElementBounds(self, elementsMap);
    const boundsB = getElementBounds(partner, elementsMap);

    // The line spans the union of what each side reaches; each end of
    // each side's reach is an anchor worth marking. Duplicates collapse
    // (two elements can share an anchor exactly).
    const spanA = anchorExtent(boundsA, guide.axis, guide.selfEdge);
    const spanB = anchorExtent(boundsB, guide.axis, guide.otherEdge);
    const along = Array.from(new Set([...spanA, ...spanB])).sort(
      (a, b) => a - b,
    );

    // selfEdge and otherEdge coordinates are equal by construction, so a
    // single line on this element's edge sits on the shared coord.
    const coord = edgeCoord(boundsA, guide.axis, guide.selfEdge);
    const at = (v: number): [number, number] =>
      guide.axis === "x" ? [coord, v] : [v, coord];

    const from = at(along[0]);
    const to = at(along[along.length - 1]);
    lines.push({
      guide,
      from,
      to,
      crosses: along.map(at),
      icon: [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2],
    });
  }
  return lines;
};

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

/**
 * An anvil centred on (cx, cy) and `size` tall — the "too heavy to be
 * pushed around" mark for an alignment anchor. The caller owns colour,
 * alpha and any backing.
 *
 * `filled` is the state cue, and here it carries real meaning rather
 * than just convention: a solid anvil is a lump of mass (anchored, won't
 * budge), a hollow one is an empty shell (free to be moved by its
 * alignments). Weight is the whole metaphor, so it should be what the
 * silhouette shows.
 *
 * Anvils are deliberately *not* padlocks: a padlock means "this
 * alignment is committed" (the guide-line icons), while an anvil means
 * "this element holds still and the others move around it". Two
 * different ideas, two different icons.
 */
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

/**
 * Whether this badge is the one the pointer is over. Matched by position
 * because that is what `App`'s hit-test reports and what the badge is
 * drawn at — both come from the same guide geometry in the same frame,
 * so they agree exactly; the epsilon is only there to keep a float
 * round-trip from silently dropping the highlight.
 */
const HOVER_MATCH_EPSILON = 0.01;

const isHoveredIcon = (
  appState: InteractiveCanvasAppState,
  icon: readonly [number, number],
): boolean => {
  const hovered = appState.hoveredAlignmentIcon;
  return (
    !!hovered &&
    Math.abs(hovered[0] - icon[0]) < HOVER_MATCH_EPSILON &&
    Math.abs(hovered[1] - icon[1]) < HOVER_MATCH_EPSILON
  );
};

export const renderAlignmentLocks = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  elementsMap: NonDeletedSceneElementsMap,
  selectedElements: readonly NonDeletedExcalidrawElement[],
) => {
  // While dragging, keep the persisted hard lines visible (partners are
  // following), but drop the soft coincidences — those are an at-rest
  // affordance and the transient snap guides already cover the live
  // case. Whatever line is drawn keeps its padlock: the badge is what
  // says the line is a kept alignment rather than a passing snap, so a
  // hard line without one reads as the wrong thing.
  const dragging = appState.selectedElementsAreBeingDragged;
  const lines = getAlignmentGuideLines(selectedElements, elementsMap).filter(
    (line) => !dragging || line.guide.hard,
  );
  if (lines.length === 0) {
    return;
  }

  const zoom = appState.zoom.value;
  const color = getIndicatorColor(appState.theme, appState.zenModeEnabled);

  context.save();
  context.translate(appState.scrollX, appState.scrollY);
  context.strokeStyle = color;
  context.lineWidth = 1 / zoom;

  for (const { guide, from, to } of lines) {
    context.setLineDash(guide.hard ? [] : getWideIndicatorLineDash(zoom));
    context.beginPath();
    context.moveTo(from[0], from[1]);
    context.lineTo(to[0], to[1]);
    context.stroke();
  }

  // Crosses mark the anchor points the line is pinned to, as the snap
  // guides do. Solid regardless of the line's dash — they're a couple of
  // pixels across and would disappear into the gaps.
  context.setLineDash([]);
  const crossSize = INDICATOR_CROSS_SIZE / zoom;
  for (const { crosses } of lines) {
    for (const [x, y] of crosses) {
      drawIndicatorCross(context, x, y, crossSize);
    }
  }

  for (const { guide, icon } of lines) {
    drawAlignmentPadlock(
      context,
      icon[0],
      icon[1],
      zoom,
      color,
      guide.hard,
      isHoveredIcon(appState, icon),
    );
  }

  context.restore();
};

/**
 * Equal-gap guides for the current selection: one measured span per gap,
 * with an equals badge on each.
 *
 * A badge per gap, not one per guide: what's being asserted is an
 * equality *between* the gaps, so marking each is what the constraint
 * actually says — and it's why the badge is an equals sign rather than
 * the edge guides' padlock. It also sidesteps a placement problem: the
 * natural single point would be the chain's centre, which is already
 * occupied by the anchor anvil.
 *
 * Shared with the pointer handler, like {@link getAlignmentGuideLines},
 * so a click hit-tests exactly what is drawn.
 */
export type GapAlignmentGuideLine = {
  guide: GapAlignmentGuide;
  /** the gaps to draw, in `guide.gaps` order — possibly not all of them */
  spans: {
    from: [number, number];
    to: [number, number];
    /** padlock centre, scene coords */
    icon: [number, number];
  }[];
};

/** Key for one gap, by the pair of elements bounding it. */
const gapPairKey = (axis: string, a: string, b: string) => `${axis}:${a}|${b}`;

export const getGapAlignmentGuideLines = (
  selectedElements: readonly NonDeletedExcalidrawElement[],
  elementsMap: NonDeletedSceneElementsMap,
): GapAlignmentGuideLine[] => {
  const guides = getGapAlignmentGuides(selectedElements, elementsMap);

  // A soft chain may run through gaps a hard chain already holds — that
  // is exactly the case where locking it would extend the hard one — but
  // those gaps are already drawn and already badged. Suppress the soft
  // copy so the two don't stack: the chain is still offered whole, it
  // just isn't reported twice where it overlaps.
  const hardGaps = new Set<string>();
  for (const guide of guides) {
    if (guide.hard) {
      for (let i = 0; i < guide.ids.length - 1; i++) {
        hardGaps.add(gapPairKey(guide.axis, guide.ids[i], guide.ids[i + 1]));
      }
    }
  }

  return guides.map((guide) => {
    const at = (along: number): [number, number] =>
      guide.axis === "x" ? [along, guide.across] : [guide.across, along];

    const spans: GapAlignmentGuideLine["spans"] = [];
    guide.gaps.forEach((gap, index) => {
      if (
        !guide.hard &&
        hardGaps.has(
          gapPairKey(guide.axis, guide.ids[index], guide.ids[index + 1]),
        )
      ) {
        return;
      }
      // every gap sits on the one line `guide.across` gives us — see the
      // note there on why it isn't computed per gap
      spans.push({
        from: at(gap.from),
        to: at(gap.to),
        icon: at((gap.from + gap.to) / 2),
      });
    });
    return { guide, spans };
  });
};

/** Half-length of the tick capping each end of a gap span, in screen px.
 * Matches the `FULL` end-cap of upstream's gap snap line so a hard gap
 * reads as the same measurement, just kept. */
const GAP_CAP_SIZE = 8;

/**
 * The equal-gap guides actually drawn for a selection — the geometry
 * minus the ones with nothing left to draw.
 *
 * Unlike the edge guides, soft gap guides stay up during a drag. Equal
 * spacing is the same relationship whether the pointer is down or not,
 * and upstream's transient gap lines report it in a different place and
 * a different number (one per satisfied snap, two lines each, each at
 * its own perpendicular coordinate). Drawing ours throughout and
 * suppressing the ones upstream duplicates — see `renderSnaps` — makes
 * the live feedback and the resting indicator the same picture, because
 * they are the same fact.
 */
export const getVisibleGapGuideLines = (
  elementsMap: NonDeletedSceneElementsMap,
  selectedElements: readonly NonDeletedExcalidrawElement[],
): GapAlignmentGuideLine[] =>
  getGapAlignmentGuideLines(selectedElements, elementsMap).filter(
    (line) => line.spans.length > 0,
  );

/**
 * Whether a guide's gaps carry their equals badges.
 *
 * A soft guide's badge is an offer — click to keep this spacing — and
 * mid-drag there is nothing to click: the arrangement it describes only
 * exists while the pointer is held. So the line reports the spacing and
 * the badge waits for the drag to end. A hard guide's badge stays, as it
 * marks a constraint that is true either way.
 */
const showsBadges = (
  appState: InteractiveCanvasAppState,
  guide: GapAlignmentGuide,
): boolean => guide.hard || !appState.selectedElementsAreBeingDragged;

export const renderGapAlignmentLocks = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  // already computed by the caller, which needs the same lines to tell
  // `renderSnaps` which gaps not to draw
  lines: readonly GapAlignmentGuideLine[],
) => {
  if (lines.length === 0) {
    return;
  }

  const zoom = appState.zoom.value;
  const color = getIndicatorColor(appState.theme, appState.zenModeEnabled);
  const cap = GAP_CAP_SIZE / zoom;

  context.save();
  context.translate(appState.scrollX, appState.scrollY);
  context.strokeStyle = color;
  context.lineWidth = 1 / zoom;

  const stroke = (from: [number, number], to: [number, number]) => {
    context.beginPath();
    context.moveTo(from[0], from[1]);
    context.lineTo(to[0], to[1]);
    context.stroke();
  };

  for (const { guide, spans } of lines) {
    const badged = showsBadges(appState, guide);
    for (const { from, to, icon } of spans) {
      // end caps, always solid — they're the measurement's endpoints and
      // would disappear into a dash pattern
      context.setLineDash([]);
      if (guide.axis === "x") {
        stroke([from[0], from[1] - cap], [from[0], from[1] + cap]);
        stroke([to[0], to[1] - cap], [to[0], to[1] + cap]);
      } else {
        stroke([from[0] - cap, from[1]], [from[0] + cap, from[1]]);
        stroke([to[0] - cap, to[1]], [to[0] + cap, to[1]]);
      }

      // Upstream's midpoint mark: a pair of short ticks straddling the
      // centre, half the height of the end caps. It is what tells a gap
      // line apart from an alignment line at a glance, so a span without
      // a badge to occupy its middle needs it. Where the badge *is*
      // drawn it would only be hidden behind the disc.
      if (!badged) {
        const half = cap / 2;
        const quarter = cap / 4;
        for (const offset of [-quarter, quarter]) {
          if (guide.axis === "x") {
            stroke(
              [icon[0] + offset, icon[1] - half],
              [icon[0] + offset, icon[1] + half],
            );
          } else {
            stroke(
              [icon[0] - half, icon[1] + offset],
              [icon[0] + half, icon[1] + offset],
            );
          }
        }
      }

      // The span itself: solid when hard, dashed when soft — the same
      // vocabulary the edge guides use. The *narrow* dash, though, not
      // the wide one those use: upstream's transient gap line is narrow
      // (`drawGapLine` in renderSnaps.ts), and a soft gap guide is
      // offering exactly the relationship that line just showed, so the
      // two have to look the same.
      context.setLineDash(guide.hard ? [] : getNarrowIndicatorLineDash(zoom));
      stroke(from, to);
    }
  }

  context.setLineDash([]);
  for (const { guide, spans } of lines) {
    if (!showsBadges(appState, guide)) {
      continue;
    }
    for (const { icon } of spans) {
      drawEqualsBadge(
        context,
        icon[0],
        icon[1],
        zoom,
        color,
        guide.hard,
        isHoveredIcon(appState, icon),
      );
    }
  }

  context.restore();
};

/** Where the anvil sits: the centre of the element's bounds — the same
 * point {@link renderAnchorLockOverlays} uses, so the toggle and the
 * drag-time overlay land in exactly the same place. */
const anchorIconCenter = (
  element: NonDeletedExcalidrawElement,
  elementsMap: NonDeletedSceneElementsMap,
): [number, number] => {
  const b = getElementBounds(element, elementsMap);
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
};

/** The anvil's height for an element: scaled to the element, clamped to a
 * sane screen-space range so it still reads on a tiny shape and doesn't
 * swamp a huge one. */
const anchorIconSize = (
  element: NonDeletedExcalidrawElement,
  elementsMap: NonDeletedSceneElementsMap,
  zoom: number,
): number => {
  const b = getElementBounds(element, elementsMap);
  const minDim = Math.min(b[2] - b[0], b[3] - b[1]);
  return Math.min(Math.max(minDim * 0.6, 16 / zoom), 60 / zoom);
};

/**
 * The clickable element-lock (alignment-anchor) toggle, if shown: a large
 * translucent anvil over the middle of the single selected element — the
 * same mark the drag-time overlay uses, so the control and the feedback
 * it predicts are one image. Available on any single selected element
 * (you can anchor before aligning) and only while selected. Returns the
 * target for the pointer handler to hit-test, or null when nothing
 * single-selected.
 */
export const getElementLockToggle = (
  selectedElements: readonly NonDeletedExcalidrawElement[],
  elementsMap: NonDeletedSceneElementsMap,
  zoom: number,
): {
  elementId: string;
  center: [number, number];
  size: number;
  hitRadius: number;
} | null => {
  if (selectedElements.length !== 1) {
    return null;
  }
  const el = selectedElements[0];
  // Anchoring only means "alignment must never move this", so it is
  // meaningless on an element alignment ignores in the first place.
  if (!isAlignable(el)) {
    return null;
  }
  // An upstream-locked element is anchored unconditionally and can't be
  // edited, so there's nothing to toggle — offering the badge would just
  // invite a click that appears to do nothing. Matches `getTransformHandles`,
  // which likewise shows no handles on a locked element.
  if (el.locked) {
    return null;
  }
  const size = anchorIconSize(el, elementsMap, zoom);
  return {
    elementId: el.id,
    center: anchorIconCenter(el, elementsMap),
    size,
    // the anvil is `size` tall and 1.14x that wide, so half the height is
    // a radius that stays inside the silhouette rather than claiming the
    // corners of its box
    hitRadius: size / 2,
  };
};

/**
 * Element-anchor UI: the anchor toggle over the middle of the single
 * selected element — shown whenever an element is selected (and while
 * it's being dragged, so it tracks the element), like a transform handle.
 * `color` is the selection colour, matching the rotation handle.
 */
export const renderElementAlignmentLocks = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  elementsMap: NonDeletedSceneElementsMap,
  selectedElements: readonly NonDeletedExcalidrawElement[],
  color: string,
) => {
  const zoom = appState.zoom.value;
  const toggle = getElementLockToggle(selectedElements, elementsMap, zoom);
  if (!toggle) {
    return;
  }
  const el = elementsMap.get(toggle.elementId);

  context.save();
  context.translate(appState.scrollX, appState.scrollY);
  drawAnchorOverlay(
    context,
    toggle.center[0],
    toggle.center[1],
    toggle.size,
    color,
    isAlignmentAnchor(el),
    appState.hoveredAlignmentAnchorId === toggle.elementId,
  );
  context.restore();
};

/** Opacity of the anvil overlay when the element *is* anchored. It sits
 * over the element's own fill, so it has to stay translucent enough to
 * read as an annotation rather than as part of the drawing. */
const ANCHOR_OVERLAY_OPACITY = 0.6;

/**
 * The drag-time anvil's red — deliberately darker than the alignment
 * indicator red the guide lines use.
 *
 * The overlay is drawn at {@link ANCHOR_OVERLAY_OPACITY} over the element's
 * own artwork, and a mid red washes out to pink at that alpha: it reads
 * light and thin, which is the opposite of what an anvil is for. Starting
 * from a darker red leaves it heavy once the alpha has taken its cut.
 * On a dark canvas "darker" means deeper and more saturated rather than
 * closer to black, which would vanish into the background.
 */
const ANCHOR_OVERLAY_COLOR_LIGHT = "#a51111";
const ANCHOR_OVERLAY_COLOR_DARK = "#ff6b6b";

const getAnchorOverlayColor = (
  theme: InteractiveCanvasAppState["theme"],
  zenModeEnabled: boolean,
): string =>
  theme === THEME.LIGHT || zenModeEnabled
    ? ANCHOR_OVERLAY_COLOR_LIGHT
    : ANCHOR_OVERLAY_COLOR_DARK;

/** Outline weight as a fraction of the anvil's height. The resting weight
 * is thin enough to sit quietly over the element's own artwork; hover
 * thickens it to the drag-overlay's weight, which is the affordance —
 * the icon firms up under the pointer to say it can be clicked. */
const ANCHOR_LINE_RATIO = 0.03;
const ANCHOR_LINE_RATIO_HOVER = 0.06;

/** A large, translucent anvil centred on and scaled to an element — both
 * the anchor toggle and the "this anchor is holding you" overlay shown
 * while dragging. Solid when anchored, and a fainter hollow outline when
 * not, so an offered toggle never competes with the element under it. */
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

/**
 * While dragging, overlay a translucent anvil on every anchored element
 * that constrains the dragged selection — i.e. an anchor sharing an
 * aligned component (either axis) with something being dragged. Shows
 * regardless of drag direction, since the anchor is what holds the
 * component together, and covers upstream-locked elements too (they
 * anchor without carrying the badge).
 *
 * A resize is reported the same way, but the set isn't computed here:
 * whether an anchor is in the way depends on which transform handle is
 * held, which only `App.maybeHandleResize` knows, so it publishes the
 * answer as `alignmentResizeAnchorIds`.
 *
 * Drawn in the alignment red rather than the selection colour the toggle
 * uses. The two anvils say different things: on a selected element it is a
 * control offering a choice, here it is the explanation for a transform
 * that just refused to happen. Red is already this fork's alignment
 * vocabulary (the guides and their padlocks), so the overlay reads as part
 * of the constraint it is reporting — and never as something to click.
 */
export const renderAnchorLockOverlays = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  elementsMap: NonDeletedSceneElementsMap,
  selectedElements: readonly NonDeletedExcalidrawElement[],
) => {
  if (selectedElements.length === 0) {
    return;
  }
  const anchors = new Set<string>(appState.alignmentResizeAnchorIds);

  if (appState.selectedElementsAreBeingDragged) {
    const directlyMoved = new Set(selectedElements.map((el) => el.id));
    const movers = getAlignmentMovers(directlyMoved, elementsMap);
    for (const component of [movers.x, movers.y]) {
      for (const id of component) {
        if (!directlyMoved.has(id) && isAlignmentAnchor(elementsMap.get(id))) {
          anchors.add(id);
        }
      }
    }
  }
  if (anchors.size === 0) {
    return;
  }

  const zoom = appState.zoom.value;
  const color = getAnchorOverlayColor(appState.theme, appState.zenModeEnabled);
  context.save();
  context.translate(appState.scrollX, appState.scrollY);
  for (const id of anchors) {
    const el = elementsMap.get(id);
    if (!el) {
      continue;
    }
    const center = anchorIconCenter(el, elementsMap);
    drawAnchorOverlay(
      context,
      center[0],
      center[1],
      anchorIconSize(el, elementsMap, zoom),
      color,
      // only ever drawn for an element that *is* anchored, and never a
      // hover target — this is feedback during a drag, not a control
      true,
      true,
    );
  }
  context.restore();
};
