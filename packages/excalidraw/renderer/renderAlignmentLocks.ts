import {
  getAlignmentGuides,
  getAlignmentMovers,
  getElementBounds,
  getGapAlignmentGuides,
  isAlignable,
  isAlignmentAnchor,
} from "@excalidraw/element";

import {
  BADGE_CLUSTER_DISTANCE,
  drawAlignmentClusterBadge,
  drawAlignmentHighlight,
  drawAlignmentPadlock,
  drawAnchorOverlayButton,
  drawAnchorOverlayWarning,
  drawCentredBadge,
  drawEqualsBadge,
  drawGapEndCap,
  drawGapMidpointTicks,
  drawIndicatorCross,
  drawIndicatorLineHalo,
  getAlignmentIndicatorColor,
  getAnchorIconSize,
  getBadgeFanOffset,
  getIndicatorLineWidth,
  getNarrowIndicatorLineDash,
  getWideIndicatorLineDash,
} from "./indicatorHelpers";

import type { Bounds } from "@excalidraw/common";
import type {
  AlignmentGuide,
  AlignmentMovers,
  GapAlignmentGuide,
} from "@excalidraw/element";
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
 * Where an element meets a guide line: the points it contributes there,
 * projected onto the axis the line *runs* along (the perpendicular of
 * `axis`). The line is drawn between the outermost of these and a cross
 * marks each, which is exactly what the transient snap guide does with
 * the points behind it (`drawPointsSnapLine`).
 *
 * Both ends and the middle, whichever edge is aligned, because that is
 * the set snapping offers: every one of an element's lines carries a
 * point at each end and one in the middle — a side gets its two corners
 * and its edge midpoint, a centre line gets two edge midpoints and the
 * centre itself.
 *
 * A centre was once treated as a single point, which matched the snap
 * line back when a rectangle offered only corners and a centre: nothing
 * then sat on its centre lines except the centre. That is also what made
 * a rectangle centred inside another draw one bare cross — two identical
 * points with no extent between them.
 */
const guideAnchors = (bounds: Bounds, axis: "x" | "y"): number[] => {
  const [lo, hi] =
    axis === "x" ? [bounds[1], bounds[3]] : [bounds[0], bounds[2]];
  return [lo, (lo + hi) / 2, hi];
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
  /** inside a collapsed cluster — the line still draws, the badge does
   * not (see {@link layOutAlignmentBadges}) */
  badgeHidden?: boolean;
  /** on the vertical line of a concentric pair — the centre alignment on
   * x — the pair's other centre line. This line's badge is a crosshair
   * standing for both (see {@link pairCentredGuides}). */
  centredPartner?: AlignmentGuide;
  /** on the other line of that pair: its badge *is* the crosshair, so it
   * draws and hit-tests none of its own, and its `icon` tracks the
   * crosshair's so that hovering it lights both lines */
  badgeMerged?: boolean;
};

/**
 * Fold the two centre alignments of a concentric pair into one badge.
 *
 * Two elements centred on each other share both centre lines, and both
 * lines' midpoints are the shared centre — so their padlocks always land
 * on one spot and always collapse into a "2". Centering is common enough
 * to deserve better, so it gets a badge of its own: a crosshair, carried
 * by the line on x and standing for both. The alignments themselves are
 * untouched — still two ordinary links.
 *
 * Paired over the lines actually visible, so a drag that shows only one
 * of the two draws that one's own padlock rather than half a crosshair.
 */
const pairCentredGuides = (
  lines: AlignmentGuideLine[],
): AlignmentGuideLine[] => {
  const isCentred = (guide: AlignmentGuide) =>
    guide.selfEdge === "center" && guide.otherEdge === "center";
  const pairKey = (guide: AlignmentGuide) =>
    [guide.selfId, guide.elementId].sort().join("|");

  const onY = new Map<string, AlignmentGuideLine>();
  for (const line of lines) {
    if (line.guide.axis === "y" && isCentred(line.guide)) {
      onY.set(pairKey(line.guide), line);
    }
  }
  for (const line of lines) {
    if (line.guide.axis !== "x" || !isCentred(line.guide)) {
      continue;
    }
    const partner = onY.get(pairKey(line.guide));
    if (partner) {
      line.centredPartner = partner.guide;
      partner.badgeMerged = true;
      partner.icon = line.icon;
    }
  }
  return lines;
};

/** How far a partner may overhang and still count as enclosed. Matches
 * the tolerance alignment detection treats two edges as coincident at, so
 * a partner flush with an edge — which is exactly the one that aligns —
 * isn't let out by float noise. */
const ENCLOSURE_EPSILON = 1;

/** Whether `inner` lies wholly within `outer`. */
const isEnclosedBy = (inner: Bounds, outer: Bounds): boolean =>
  inner[0] >= outer[0] - ENCLOSURE_EPSILON &&
  inner[1] >= outer[1] - ENCLOSURE_EPSILON &&
  inner[2] <= outer[2] + ENCLOSURE_EPSILON &&
  inner[3] <= outer[3] + ENCLOSURE_EPSILON;

/**
 * The lines to draw for the current selection, with each line's padlock
 * position. Shared by the renderer and the pointer handler so a click
 * hit-tests exactly what is drawn.
 *
 * A soft guide to a partner the selected element wholly encloses is left
 * out. Whatever sits inside a shape — its contents, a nested frame of
 * boxes — lines up with the shape's edges and centre constantly, mostly
 * by construction, and every one of those coincidences drawn would bury
 * the alignments to the shape's actual neighbours. Hard ones stay: they
 * are constraints the user chose, and the badge is the only way to
 * release them.
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
    if (!guide.hard && isEnclosedBy(boundsB, boundsA)) {
      continue;
    }

    // The line spans the union of what each side reaches, and every point
    // either side puts on it is worth marking. Duplicates collapse (two
    // elements can share an anchor exactly).
    const anchorsA = guideAnchors(boundsA, guide.axis);
    const anchorsB = guideAnchors(boundsB, guide.axis);
    const along = Array.from(new Set([...anchorsA, ...anchorsB])).sort(
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
export type AlignmentDragMovers = AlignmentMovers;

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
    // a resize's anchors are published separately, by the handle-aware
    // `maybeHandleResize`
    return {
      x: new Set(resize.x),
      y: new Set(resize.y),
      pinAnchors: { permitting: new Set(), refusing: new Set() },
    };
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
    return pairCentredGuides(
      getAlignmentGuideLines(selectedElements, elementsMap),
    );
  }

  return pairCentredGuides(
    getAlignmentGuideLines(
      getGuideSourceElements(elementsMap, selectedElements, movers),
      elementsMap,
    ).filter(
      ({ guide }) =>
        guide.hard &&
        movers[guide.axis].has(guide.selfId) &&
        movers[guide.axis].has(guide.elementId),
    ),
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
  for (const { from, to, icon, badgeHidden } of lines) {
    if (!badgeHidden && isHoveredIcon(appState, icon)) {
      drawIndicatorLineHalo(context, from, to, zoom, color);
    }
  }

  // A hovered soft line goes solid: the dash says "not kept yet", and the
  // hover is a preview of the click that would keep it.
  for (const { guide, from, to, icon, badgeHidden } of lines) {
    const solid =
      guide.hard || (!badgeHidden && isHoveredIcon(appState, icon));
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
  for (const { guide, icon, badgeHidden, badgeMerged, centredPartner } of lines) {
    if (badgeHidden || badgeMerged) {
      continue;
    }
    if (centredPartner) {
      drawCentredBadge(
        context,
        icon[0],
        icon[1],
        zoom,
        color,
        guide.hard,
        centredPartner.hard,
        isHoveredIcon(appState, icon),
      );
      continue;
    }
    if (guide.selfEdge === "center" && guide.otherEdge === "center") {
      // a lone centre alignment: the crosshair with only its own arm
      drawCentredBadge(
        context,
        icon[0],
        icon[1],
        zoom,
        color,
        guide.axis === "x" ? guide.hard : null,
        guide.axis === "y" ? guide.hard : null,
        isHoveredIcon(appState, icon),
      );
      continue;
    }
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
    /** inside a collapsed cluster — see {@link AlignmentGuideLine} */
    badgeHidden?: boolean;
  }[];
};

/** Key for one gap, by the pair of elements bounding it. */
const gapPairKey = (axis: string, a: string, b: string) => `${axis}:${a}|${b}`;

/** Below this a gap is two elements touching. Matches the tolerance
 * alignment detection treats two edges as coincident at, which is the
 * same judgement from the other side. */
const ZERO_GAP_EPSILON = 1;

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
      // A soft chain of touching elements is not an offer worth making:
      // there is no spacing to keep equal, and its badge would land on the
      // shared edge, where the edge alignment's own padlock already is. A
      // *hard* one keeps its badges even at zero, or a chain dragged shut
      // against its own contact cap would have no way left to unlock it.
      if (!guide.hard && gap.to - gap.from <= ZERO_GAP_EPSILON) {
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
 * A knot of badges too close together to aim between, and what it does
 * about it.
 *
 * Alignment badges sit at their line's midpoint, and guides from one
 * selected element all share an endpoint, so their midpoints crowd —
 * worst of all when elements are centred, where several lines coincide
 * outright. Since the hit-test takes the *nearest* badge, exactly
 * coincident ones leave all but one permanently unreachable: not merely
 * fiddly, but impossible.
 *
 * Collapsed, a cluster is one badge carrying its count. Opened — the
 * pointer resting on it — its members move out onto a ring, where each is
 * an ordinary badge again, separately hoverable and separately clickable.
 * Nothing about what a badge *means* changes; only where it is drawn.
 */
export type AlignmentBadgeCluster = {
  /** where the cluster sits, and the identity it is remembered by */
  center: [number, number];
  count: number;
  open: boolean;
};

/** One badge's place in the layout, with the way to write its result
 * back to whichever line or span it came from. */
type BadgeSlot = {
  /** stable across frames, so an opened fan doesn't reshuffle */
  key: string;
  icon: [number, number];
  /** which coordinate varies along this badge's own guide line — 0 for a
   * line running horizontally, 1 for one running vertically. An opened
   * badge only ever moves along this, so it never leaves its line. */
  along: 0 | 1;
  place: (icon: [number, number] | null) => void;
};

const badgeSlots = (
  edgeLines: AlignmentGuideLine[],
  gapLines: GapAlignmentGuideLine[],
): BadgeSlot[] => {
  const slots: BadgeSlot[] = [];
  for (const line of edgeLines) {
    if (line.badgeMerged) {
      // placed with the crosshair it merged into, below
      continue;
    }
    const merged = line.centredPartner
      ? edgeLines.find((other) => other.guide === line.centredPartner)
      : undefined;
    const { axis, selfId, selfEdge, elementId, otherEdge } = line.guide;
    slots.push({
      key: `e:${axis}:${selfId}:${selfEdge}:${elementId}:${otherEdge}`,
      icon: line.icon,
      // an alignment *on* x is a line of constant x, so it runs vertically
      along: axis === "x" ? 1 : 0,
      place: (icon) => {
        for (const target of merged ? [line, merged] : [line]) {
          if (icon) {
            target.icon = icon;
          } else {
            target.badgeHidden = true;
          }
        }
      },
    });
  }
  for (const line of gapLines) {
    line.spans.forEach((span, index) => {
      slots.push({
        key: `g:${line.guide.axis}:${line.guide.ids.join(",")}:${index}`,
        icon: span.icon,
        // a gap measured *along* x is a span running horizontally — the
        // opposite of an edge guide on the same axis, which is what keeps
        // the two kinds apart when they crowd together
        along: line.guide.axis === "x" ? 0 : 1,
        place: (icon) => {
          if (icon) {
            span.icon = icon;
          } else {
            span.badgeHidden = true;
          }
        },
      });
    });
  }
  return slots;
};

/** Single-linkage grouping: badges chain into one cluster when each is
 * near the next, which is what makes a row of overlapping badges one knot
 * rather than several pairs. */
const clusterSlots = (
  slots: readonly BadgeSlot[],
  threshold: number,
): number[][] => {
  const parent = slots.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) {
      parent[root] = parent[parent[root]];
      root = parent[root];
    }
    return root;
  };
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const dx = slots[i].icon[0] - slots[j].icon[0];
      const dy = slots[i].icon[1] - slots[j].icon[1];
      if (Math.hypot(dx, dy) < threshold) {
        parent[find(i)] = find(j);
      }
    }
  }
  const groups = new Map<number, number[]>();
  slots.forEach((_, index) => {
    const root = find(index);
    const group = groups.get(root);
    if (group) {
      group.push(index);
    } else {
      groups.set(root, [index]);
    }
  });
  return [...groups.values()];
};

/**
 * Place every badge for a frame, collapsing the crowded ones and fanning
 * out the one the pointer has opened.
 *
 * `expanded` is a cluster's centre, not an index: clusters are derived
 * fresh each frame from wherever the guides currently are, so the only
 * identity that survives between frames is where the thing sits. It is
 * also the same way `hoveredAlignmentIcon` is remembered, for the same
 * reason.
 *
 * A cluster's centre is the mean of its members, so it does not depend on
 * the order they were found in; the fan's *order* is by slot key, so an
 * open ring keeps its arrangement as the pointer moves around it.
 *
 * Returns copies. The renderer and the pointer handler both call this and
 * must agree exactly, so neither may hold the originals.
 */
export const layOutAlignmentBadges = (
  edgeLines: readonly AlignmentGuideLine[],
  gapLines: readonly GapAlignmentGuideLine[],
  zoom: number,
  expanded: readonly [number, number] | null,
): {
  edgeLines: AlignmentGuideLine[];
  gapLines: GapAlignmentGuideLine[];
  clusters: AlignmentBadgeCluster[];
} => {
  const outEdge = edgeLines.map((line) => ({ ...line }));
  const outGap = gapLines.map((line) => ({
    ...line,
    spans: line.spans.map((span) => ({ ...span })),
  }));

  const slots = badgeSlots(outEdge, outGap);
  const clusters: AlignmentBadgeCluster[] = [];

  for (const members of clusterSlots(slots, BADGE_CLUSTER_DISTANCE / zoom)) {
    if (members.length < 2) {
      continue;
    }
    const center: [number, number] = [
      members.reduce((sum, i) => sum + slots[i].icon[0], 0) / members.length,
      members.reduce((sum, i) => sum + slots[i].icon[1], 0) / members.length,
    ];

    if (
      !expanded ||
      Math.abs(expanded[0] - center[0]) >= HOVER_MATCH_EPSILON ||
      Math.abs(expanded[1] - center[1]) >= HOVER_MATCH_EPSILON
    ) {
      for (const index of members) {
        slots[index].place(null);
      }
      clusters.push({ center, count: members.length, open: false });
      continue;
    }

    // Each badge slides along its *own* guide line, never off it, so what
    // it belongs to stays readable without hovering it — which a ring
    // around the cluster could not say, since every position on one is
    // equally arbitrary. Two badges separate because their lines run in
    // different directions, and two on the same line because they take
    // different offsets along it.
    //
    // Measured from the cluster's centre rather than from each badge's
    // own position: the members arrived within a badge's width of each
    // other, so spacing them from where they happened to sit could leave
    // a pair barely apart. Sorted by key, so an open fan keeps its
    // arrangement as the pointer moves around it.
    const ordered = [...members].sort((a, b) =>
      slots[a].key < slots[b].key ? -1 : 1,
    );
    ordered.forEach((index, position) => {
      const slot = slots[index];
      const offset = getBadgeFanOffset(position, ordered.length, zoom);
      const icon: [number, number] = [slot.icon[0], slot.icon[1]];
      // only the coordinate that varies along the line is rewritten; the
      // other is the line's own, and holding it is what keeps the badge on it
      icon[slot.along] = center[slot.along] + offset;
      slot.place(icon);
    });
    clusters.push({ center, count: ordered.length, open: true });
  }

  return { edgeLines: outEdge, gapLines: outGap, clusters };
};

/** The counted badge standing in for each collapsed cluster, drawn with
 * the other badges so nothing is laid over it. */
export const renderAlignmentClusterBadges = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  clusters: readonly AlignmentBadgeCluster[],
) => {
  const zoom = appState.zoom.value;
  const color = getAlignmentIndicatorColor(appState.theme, appState.zenModeEnabled);

  context.save();
  context.translate(appState.scrollX, appState.scrollY);
  context.setLineDash([]);
  for (const cluster of clusters) {
    if (!cluster.open) {
      drawAlignmentClusterBadge(
        context,
        cluster.center[0],
        cluster.center[1],
        zoom,
        color,
        cluster.count,
      );
    }
  }
  context.restore();
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
): boolean =>
  spans.some(
    ({ icon, badgeHidden }) => !badgeHidden && isHoveredIcon(appState, icon),
  );

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
    for (const { icon, badgeHidden } of spans) {
      if (badgeHidden) {
        continue;
      }
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

  for (const { guide, icon, badgeHidden } of edgeLines) {
    if (!badgeHidden && isHoveredIcon(appState, icon)) {
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
 * A drag also names the anchors that pinned a gap chain in place of its
 * default (`AlignmentMovers.pinAnchors`): outlined while the chain
 * re-spaces around them, filled when two pins leave no solution.
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
    movers.pinAnchors.refusing.forEach((id) => anchors.add(id));
  }
  // An anchor that is only reshaping the gesture, not refusing it —
  // forcing a partner to stretch during a resize, or a gap chain to
  // re-space around it during a drag — shown for the same reason, in the
  // lighter form. If one is somehow both, refusing wins: that is the more
  // urgent thing to say.
  const stretchAnchors = new Set(
    [
      ...appState.alignmentResizeStretchAnchorIds,
      ...(movers?.pinAnchors.permitting ?? []),
    ].filter((id) => !anchors.has(id)),
  );
  if (anchors.size === 0 && stretchAnchors.size === 0) {
    return;
  }

  const zoom = appState.zoom.value;
  context.save();
  context.translate(appState.scrollX, appState.scrollY);
  for (const [ids, blocking] of [
    [anchors, true],
    [stretchAnchors, false],
  ] as const) {
    for (const id of ids) {
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
        blocking,
      );
    }
  }
  context.restore();
};
