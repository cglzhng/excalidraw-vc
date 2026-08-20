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
  drawIndicatorLineHalo,
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
 * Everything the gesture in progress sets in motion, per axis — or null
 * when there is no gesture, which is when the guides fall back to simply
 * describing the selection.
 *
 * The two gestures answer it from different places, because they know it
 * at different times. A **drag** is solvable here: `getAlignmentMovers`
 * is the solver `dragElements.ts` itself uses, and the seeds are all it
 * needs. A **resize** is not: which edges move depends on the transform
 * handle, which only `App.maybeHandleResize` sees, so it solves the same
 * question there and publishes the answer as `alignmentResizeMoverIds`.
 * Either way what comes back is what the propagator will actually move,
 * so the guides show the constraints being enforced rather than a guess
 * at them.
 *
 * Null means *no gesture*, not "a gesture that moves nothing" — hence
 * the read of `isResizing` rather than a test on the published sets. A
 * resize whose element has no hard links, or whose links all hang off
 * edges the handle leaves alone, drives nothing and publishes empty
 * sets, but it is still a gesture and the guides behave there as in any
 * other resize.
 *
 * Computed once per frame by the caller and handed to each pass that
 * needs it. The drag solve sweeps every element's chains to a fixed
 * point, so three passes asking separately would be three sweeps a frame
 * for one answer that cannot have changed between them.
 */
export type AlignmentDragMovers = { x: Set<string>; y: Set<string> };

export const getAlignmentDragMovers = (
  elementsMap: NonDeletedSceneElementsMap,
  selectedElements: readonly NonDeletedExcalidrawElement[],
  appState: InteractiveCanvasAppState,
): AlignmentDragMovers | null => {
  if (appState.selectedElementsAreBeingDragged) {
    return getAlignmentMovers(
      new Set(selectedElements.map((element) => element.id)),
      elementsMap,
    );
  }

  if (appState.isResizing) {
    const resize = appState.alignmentResizeMoverIds;
    return { x: new Set(resize.x), y: new Set(resize.y) };
  }

  return null;
};

/**
 * The elements to build guides from during a gesture: everything moving,
 * plus the selection itself.
 *
 * The selection is in there even when it moves nothing, because the soft
 * gap guides are still scoped to it and still drawn — a resize that
 * drives no alignment must not come out looking like a scene with no
 * alignments in it. What the selection's *hard* links do is then decided
 * by the filters, not by this list.
 */
const getGuideSourceElements = (
  elementsMap: NonDeletedSceneElementsMap,
  selectedElements: readonly NonDeletedExcalidrawElement[],
  movers: AlignmentDragMovers,
): NonDeletedExcalidrawElement[] => {
  const elements = [...selectedElements];
  const seen = new Set(selectedElements.map((element) => element.id));
  for (const id of new Set([...movers.x, ...movers.y])) {
    if (seen.has(id)) {
      continue;
    }
    const element = elementsMap.get(id);
    if (element) {
      elements.push(element);
    }
  }
  return elements;
};

/**
 * The edge-alignment guides actually drawn for a selection.
 *
 * At rest that is simply the selection's own guides. During a gesture —
 * drag or resize alike — it is every hard link the gesture is
 * *enforcing*, which reaches past the selection: dragging A moves its
 * partner B, and B's own link to C is what then moves C, so all three
 * lines are load-bearing and the user should see why C moved. Soft
 * coincidences are dropped, because their padlock is an offer that
 * cannot be taken up with the pointer already down, and the transient
 * snap guides report the live coincidences anyway. Whatever line is
 * drawn keeps its padlock: the badge is what says the line is a kept
 * alignment rather than a passing snap.
 *
 * A link counts as enforced only when *both* its ends are moving on its
 * own axis. That excludes two things a looser "touches something that
 * moved" test would wrongly include: a link on the other axis, which the
 * gesture isn't transmitting through, and a link whose ends both sit
 * still — a gap chain can hold a member in place while its neighbours
 * travel, and a resize handle moves only the edges it controls, so
 * either way the links hanging off what stayed put are being satisfied
 * by nothing happening rather than by doing any work.
 */
export const getVisibleAlignmentGuideLines = (
  elementsMap: NonDeletedSceneElementsMap,
  selectedElements: readonly NonDeletedExcalidrawElement[],
  movers: AlignmentDragMovers | null,
): AlignmentGuideLine[] => {
  if (!movers) {
    return getAlignmentGuideLines(selectedElements, elementsMap);
  }

  return getAlignmentGuideLines(
    getGuideSourceElements(elementsMap, selectedElements, movers),
    elementsMap,
  ).filter(
    ({ guide }) =>
      guide.hard &&
      movers[guide.axis].has(guide.selfId) &&
      movers[guide.axis].has(guide.elementId),
  );
};

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

  // Halos first, so a neighbouring line is never buried under one.
  for (const { from, to, icon } of lines) {
    if (isHoveredIcon(appState, icon)) {
      drawIndicatorLineHalo(context, from, to, zoom, color);
    }
  }

  // A hovered soft line goes solid: the dash says "not kept yet", and the
  // hover is a preview of the click that would keep it.
  for (const { guide, from, to, icon } of lines) {
    const solid = guide.hard || isHoveredIcon(appState, icon);
    context.setLineDash(solid ? [] : getWideIndicatorLineDash(zoom));
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
 *
 * During a drag the *hard* chains reach past the selection, for the same
 * reason the edge guides do: a chain two links away can be what is
 * stepping an element along, and the user should see the constraint that
 * moved it. A chain qualifies once any one member is moving on its axis —
 * unlike an edge link, a chain does its work precisely when its members
 * move by *different* amounts, so a still member is a sign of the
 * constraint working rather than idling.
 *
 * The wider set is enumerated in the same pass rather than a second call,
 * so `getGapAlignmentGuideLines` still sees every hard chain at once when
 * it decides which soft spans to suppress. Soft chains are then held back
 * to the selection's own, since an unlocked coincidence between two
 * elements the user isn't touching is not an offer they asked for.
 */
export const getVisibleGapGuideLines = (
  elementsMap: NonDeletedSceneElementsMap,
  selectedElements: readonly NonDeletedExcalidrawElement[],
  movers: AlignmentDragMovers | null,
): GapAlignmentGuideLine[] => {
  if (!movers) {
    return getGapAlignmentGuideLines(selectedElements, elementsMap).filter(
      (line) => line.spans.length > 0,
    );
  }

  const selectedIds = new Set(selectedElements.map((element) => element.id));

  return getGapAlignmentGuideLines(
    getGuideSourceElements(elementsMap, selectedElements, movers),
    elementsMap,
  ).filter(
    (line) =>
      line.spans.length > 0 &&
      (line.guide.hard
        ? line.guide.ids.some((id) => movers[line.guide.axis].has(id))
        : line.guide.ids.some((id) => selectedIds.has(id))),
  );
};

/**
 * Whether a guide's gaps carry their equals badges.
 *
 * A soft guide's badge is an offer — click to keep this spacing — and
 * mid-gesture there is nothing to click: the pointer is already down, and
 * the arrangement it describes only exists while it is held. So the line
 * reports the spacing and the badge waits for the gesture to end. A hard
 * guide's badge stays, as it marks a constraint that is true either way.
 *
 * A resize counts as a gesture here for the same reason a drag does,
 * which is also why the soft *edge* guides drop out entirely during one.
 */
const showsBadges = (
  appState: InteractiveCanvasAppState,
  guide: GapAlignmentGuide,
): boolean =>
  guide.hard ||
  !(appState.selectedElementsAreBeingDragged || appState.isResizing);

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

  // Halos first, so a neighbouring span is never buried under one.
  for (const { spans } of lines) {
    if (isHoveredGapGuide(appState, spans)) {
      for (const { from, to } of spans) {
        drawIndicatorLineHalo(context, from, to, zoom, color);
      }
    }
  }

  for (const { guide, spans } of lines) {
    const badged = showsBadges(appState, guide);
    // Hovering any one badge lights the whole chain, so the whole chain's
    // spans go solid together — the same rule the badges follow, for the
    // same reason: one hover, one constraint.
    const solid = guide.hard || isHoveredGapGuide(appState, spans);
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
      context.setLineDash(solid ? [] : getNarrowIndicatorLineDash(zoom));
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
  movers: AlignmentDragMovers | null,
) => {
  if (selectedElements.length === 0) {
    return;
  }
  const anchors = new Set<string>(appState.alignmentResizeAnchorIds);

  if (movers) {
    const directlyMoved = new Set(selectedElements.map((el) => el.id));
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
