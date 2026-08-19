import {
  getAlignmentGuides,
  getAlignmentMovers,
  getElementBounds,
  getGapAlignmentGuides,
  isAlignable,
  isAlignmentAnchor,
} from "@excalidraw/element";

import {
  drawAlignmentHighlight,
  drawAlignmentPadlock,
  drawAnchorOverlayButton,
  drawAnchorOverlayWarning,
  drawEqualsBadge,
  drawGapEndCap,
  drawGapMidpointTicks,
  drawIndicatorCross,
  getAlignmentIndicatorColor,
  getAnchorIconSize,
  getIndicatorLineWidth,
  getNarrowIndicatorLineDash,
  getWideIndicatorLineDash,
} from "./indicatorHelpers";

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

/**
 * The edge-alignment guides actually drawn for a selection.
 *
 * While dragging, keep the persisted hard lines visible (partners are
 * following), but drop the soft coincidences — those are an at-rest
 * affordance and the transient snap guides already cover the live case.
 * Whatever line is drawn keeps its padlock: the badge is what says the
 * line is a kept alignment rather than a passing snap, so a hard line
 * without one reads as the wrong thing.
 */
export const getVisibleAlignmentGuideLines = (
  elementsMap: NonDeletedSceneElementsMap,
  selectedElements: readonly NonDeletedExcalidrawElement[],
  appState: InteractiveCanvasAppState,
): AlignmentGuideLine[] =>
  getAlignmentGuideLines(selectedElements, elementsMap).filter(
    (line) => !appState.selectedElementsAreBeingDragged || line.guide.hard,
  );

export const renderAlignmentLocks = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  lines: readonly AlignmentGuideLine[],
) => {
  if (lines.length === 0) {
    return;
  }

  const zoom = appState.zoom.value;
  const color = getAlignmentIndicatorColor(appState.theme, appState.zenModeEnabled);

  context.save();
  context.translate(appState.scrollX, appState.scrollY);
  context.strokeStyle = color;
  context.lineWidth = getIndicatorLineWidth(zoom);

  for (const { guide, from, to } of lines) {
    context.setLineDash(guide.hard ? [] : getWideIndicatorLineDash(zoom));
    context.beginPath();
    context.moveTo(from[0], from[1]);
    context.lineTo(to[0], to[1]);
    context.stroke();
  }

  // Crosses mark the anchor points the line is pinned to, as the snap
  // guides do.
  for (const { crosses } of lines) {
    for (const [x, y] of crosses) {
      drawIndicatorCross(context, x, y, zoom);
    }
  }

  context.restore();
};

/** The padlocks for {@link renderAlignmentLocks}' guides, drawn in a
 * separate pass so no guide line can be laid over a badge. */
export const renderAlignmentLockIcons = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  lines: readonly AlignmentGuideLine[],
) => {
  if (lines.length === 0) {
    return;
  }
  const zoom = appState.zoom.value;
  const color = getAlignmentIndicatorColor(appState.theme, appState.zenModeEnabled);

  context.save();
  context.translate(appState.scrollX, appState.scrollY);
  context.setLineDash([]);
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
  const color = getAlignmentIndicatorColor(appState.theme, appState.zenModeEnabled);

  context.save();
  context.translate(appState.scrollX, appState.scrollY);
  context.strokeStyle = color;
  context.lineWidth = getIndicatorLineWidth(zoom);

  const stroke = (from: [number, number], to: [number, number]) => {
    context.beginPath();
    context.moveTo(from[0], from[1]);
    context.lineTo(to[0], to[1]);
    context.stroke();
  };

  for (const { guide, spans } of lines) {
    const badged = showsBadges(appState, guide);
    for (const { from, to, icon } of spans) {
      drawGapEndCap(context, from[0], from[1], guide.axis, zoom);
      drawGapEndCap(context, to[0], to[1], guide.axis, zoom);

      if (!badged) {
        drawGapMidpointTicks(context, icon[0], icon[1], guide.axis, zoom);
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

  context.restore();
};

/** Whether the pointer is on any of a gap guide's badges — one hover
 * answers for the whole chain, since they are one constraint and one
 * click. */
const isHoveredGapGuide = (
  appState: InteractiveCanvasAppState,
  spans: GapAlignmentGuideLine["spans"],
): boolean => spans.some(({ icon }) => isHoveredIcon(appState, icon));

/**
 * The equals badges for {@link renderGapAlignmentLocks}' guides, drawn in
 * a separate pass so no guide line can be laid over a badge.
 *
 * Every badge of a chain lights together, unlike the edge padlocks, which
 * light one at a time. That difference is the constraint's: a padlock is
 * its own alignment, so hovering it says something about that line alone,
 * whereas a chain's badges are one assertion written in several places —
 * clicking any of them toggles all of them, and the hover has to promise
 * the same thing the click will do.
 */
export const renderGapAlignmentIcons = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  lines: readonly GapAlignmentGuideLine[],
) => {
  if (lines.length === 0) {
    return;
  }
  const zoom = appState.zoom.value;
  const color = getAlignmentIndicatorColor(appState.theme, appState.zenModeEnabled);

  context.save();
  context.translate(appState.scrollX, appState.scrollY);
  context.setLineDash([]);
  for (const { guide, spans } of lines) {
    if (!showsBadges(appState, guide)) {
      continue;
    }
    const hovered = isHoveredGapGuide(appState, spans);
    for (const { icon } of spans) {
      drawEqualsBadge(context, icon[0], icon[1], zoom, color, guide.hard, hovered);
    }
  }
  context.restore();
};

/**
 * The elements the hovered badge's alignment is about, minus the ones
 * already selected — those carry a selection border and a second outline
 * on top of it would say nothing.
 *
 * A gap badge lights the whole chain rather than the two elements
 * bounding its own gap: the chain is one constraint, and the equality it
 * asserts is between gaps that all belong to it.
 */
const getHighlightedAlignmentIds = (
  appState: InteractiveCanvasAppState,
  selectedElements: readonly NonDeletedExcalidrawElement[],
  edgeLines: readonly AlignmentGuideLine[],
  gapLines: readonly GapAlignmentGuideLine[],
): Set<string> => {
  const ids = new Set<string>();
  if (!appState.hoveredAlignmentIcon) {
    return ids;
  }

  for (const { guide, icon } of edgeLines) {
    if (isHoveredIcon(appState, icon)) {
      ids.add(guide.selfId);
      ids.add(guide.elementId);
    }
  }
  for (const { guide, spans } of gapLines) {
    if (isHoveredGapGuide(appState, spans)) {
      for (const id of guide.ids) {
        ids.add(id);
      }
    }
  }

  for (const element of selectedElements) {
    ids.delete(element.id);
  }
  return ids;
};

/**
 * Outline every element the badge under the pointer is talking about.
 *
 * Two alignments in a crowded selection can be drawn in nearly the same
 * place — a guide to one partner and a guide to another that happens to
 * share the edge, or two chains through overlapping members — and the
 * lines alone can't say which is which. Hovering a badge names its
 * participants directly, which is the question the line can't answer.
 *
 * Drawn before the guides so a highlight never covers the line or badge
 * that produced it.
 */
export const renderAlignmentHoverHighlights = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  elementsMap: NonDeletedSceneElementsMap,
  selectedElements: readonly NonDeletedExcalidrawElement[],
  edgeLines: readonly AlignmentGuideLine[],
  gapLines: readonly GapAlignmentGuideLine[],
) => {
  const ids = getHighlightedAlignmentIds(
    appState,
    selectedElements,
    edgeLines,
    gapLines,
  );
  if (ids.size === 0) {
    return;
  }

  const color = getAlignmentIndicatorColor(
    appState.theme,
    appState.zenModeEnabled,
  );

  context.save();
  context.translate(appState.scrollX, appState.scrollY);
  for (const id of ids) {
    const element = elementsMap.get(id);
    if (!element) {
      continue;
    }
    const b = getElementBounds(element, elementsMap);
    drawAlignmentHighlight(
      context,
      b[0],
      b[1],
      b[2],
      b[3],
      appState.zoom.value,
      color,
    );
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

/** The anvil's height for an element — the element's shorter side, handed
 * to {@link getAnchorIconSize} to be scaled and clamped. */
const anchorIconSize = (
  element: NonDeletedExcalidrawElement,
  elementsMap: NonDeletedSceneElementsMap,
  zoom: number,
): number => {
  const b = getElementBounds(element, elementsMap);
  return getAnchorIconSize(Math.min(b[2] - b[0], b[3] - b[1]), zoom);
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
 */
export const renderElementAlignmentLocks = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  elementsMap: NonDeletedSceneElementsMap,
  selectedElements: readonly NonDeletedExcalidrawElement[],
) => {
  const zoom = appState.zoom.value;
  const toggle = getElementLockToggle(selectedElements, elementsMap, zoom);
  if (!toggle) {
    return;
  }
  const el = elementsMap.get(toggle.elementId);

  context.save();
  context.translate(appState.scrollX, appState.scrollY);
  drawAnchorOverlayButton(
    context,
    toggle.center[0],
    toggle.center[1],
    toggle.size,
    isAlignmentAnchor(el),
    appState.hoveredAlignmentAnchorId === toggle.elementId,
  );
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
 * Drawn as the *warning* anvil rather than the toggle's button form — see
 * {@link drawAnchorOverlayWarning} for why the two look different.
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
  context.save();
  context.translate(appState.scrollX, appState.scrollY);
  for (const id of anchors) {
    const el = elementsMap.get(id);
    if (!el) {
      continue;
    }
    const center = anchorIconCenter(el, elementsMap);
    drawAnchorOverlayWarning(
      context,
      center[0],
      center[1],
      anchorIconSize(el, elementsMap, zoom),
      appState.theme,
      appState.zenModeEnabled,
    );
  }
  context.restore();
};
