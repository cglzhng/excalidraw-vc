import {
  pointFrom,
  pointRotateRads,
  rangeInclusive,
  rangeIntersection,
  rangesOverlap,
  type GlobalPoint,
} from "@excalidraw/math";

import { TOOL_TYPE, KEYS, arrayToMap } from "@excalidraw/common";
import {
  clampDragToGapAlignments,
  hasHardGapAlignmentAmong,
  getAlignmentDragFactors,
  getAlignmentLockedAxes,
  getAlignmentResizeMovers,
  getGapAlignmentResizeMovers,
  getCommonBounds,
  getDraggedElementsBounds,
  getElementAbsoluteCoords,
} from "@excalidraw/element";
import { isBoundToContainer, isLinearElement } from "@excalidraw/element";

import { getMaximumGroups } from "@excalidraw/element";

import {
  getSelectedElements,
  getVisibleAndNonSelectedElements,
} from "@excalidraw/element";

import type { InclusiveRange } from "@excalidraw/math";

import type { Bounds } from "@excalidraw/common";
import type { MaybeTransformHandleType } from "@excalidraw/element";
import type {
  ElementsMap,
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";

import type {
  AppClassProperties,
  AppState,
  KeyboardModifiersObject,
} from "./types";

const SNAP_DISTANCE = 8;

// do not comput more gaps per axis than this limit
// TODO increase or remove once we optimize
const VISIBLE_GAPS_LIMIT_PER_AXIS = 99999;

// snap distance with zoom value taken into consideration
export const getSnapDistance = (zoomValue: number) => {
  return SNAP_DISTANCE / zoomValue;
};

type Vector2D = {
  x: number;
  y: number;
};

type PointPair = [GlobalPoint, GlobalPoint];

export type PointSnap = {
  type: "point";
  points: PointPair;
  offset: number;
};

export type Gap = {
  //  start side ↓     length
  // ┌───────────┐◄───────────────►
  // │           │-----------------┌───────────┐
  // │  start    │       ↑         │           │
  // │  element  │    overlap      │  end      │
  // │           │       ↓         │  element  │
  // └───────────┘-----------------│           │
  //                               └───────────┘
  //                               ↑ end side
  startBounds: Bounds;
  endBounds: Bounds;
  /** ids behind each side's bounds — a maximum group, so possibly
   * several. Carried so a gap can be tested against the hard equal-gap
   * links, which are stated in element ids. */
  startIds: readonly string[];
  endIds: readonly string[];
  startSide: [GlobalPoint, GlobalPoint];
  endSide: [GlobalPoint, GlobalPoint];
  overlap: InclusiveRange;
  length: number;
};

export type GapSnap = {
  type: "gap";
  direction:
    | "center_horizontal"
    | "center_vertical"
    | "side_left"
    | "side_right"
    | "side_top"
    | "side_bottom";
  gap: Gap;
  offset: number;
};

export type GapSnaps = GapSnap[];

export type Snap = GapSnap | PointSnap;
export type Snaps = Snap[];

export type PointSnapLine = {
  type: "points";
  points: GlobalPoint[];
};

export type PointerSnapLine = {
  type: "pointer";
  points: PointPair;
  direction: "horizontal" | "vertical";
};

export type GapSnapLine = {
  type: "gap";
  direction: "horizontal" | "vertical";
  points: PointPair;
};

export type SnapLine = PointSnapLine | GapSnapLine | PointerSnapLine;

// -----------------------------------------------------------------------------

/**
 * A cached reference snap point, with a per-axis mask and travel.
 *
 * `snapX`/`snapY` are normally both true; a point is masked off on an
 * axis when its element is hard-aligned to the dragged selection on that
 * axis, so it moves along with the drag and its (frozen, pre-drag)
 * coordinate on that axis would otherwise produce a stale snap.
 *
 * `factorX`/`factorY` say how far it moves — as a multiple of the drag
 * offset, which is what `getAlignmentDragFactors` deals in. An edge
 * partner takes 1, but a gap chain hands its members a whole arithmetic
 * progression, so −1 and ½ are as ordinary as 1. A point that snaps has
 * a factor of 0 by definition; the factor matters for the ones that
 * don't, whose *other* axis may still anchor a snap line, and that line
 * has to reach the element where it now is.
 */
export type ReferenceSnapPoint = {
  point: GlobalPoint;
  snapX: boolean;
  snapY: boolean;
  factorX: number;
  factorY: number;
};

export class SnapCache {
  private static referenceSnapPoints: ReferenceSnapPoint[] | null = null;

  private static visibleGaps: {
    verticalGaps: Gap[];
    horizontalGaps: Gap[];
  } | null = null;

  public static setReferenceSnapPoints = (
    snapPoints: ReferenceSnapPoint[] | null,
  ) => {
    SnapCache.referenceSnapPoints = snapPoints;
  };

  public static getReferenceSnapPoints = () => {
    return SnapCache.referenceSnapPoints;
  };

  public static setVisibleGaps = (
    gaps: {
      verticalGaps: Gap[];
      horizontalGaps: Gap[];
    } | null,
  ) => {
    SnapCache.visibleGaps = gaps;
  };

  public static getVisibleGaps = () => {
    return SnapCache.visibleGaps;
  };

  public static destroy = () => {
    SnapCache.referenceSnapPoints = null;
    SnapCache.visibleGaps = null;
  };
}

// -----------------------------------------------------------------------------

export const isGridModeEnabled = (app: AppClassProperties): boolean =>
  app.props.gridModeEnabled ?? app.state.gridModeEnabled;

export const isSnappingEnabled = ({
  event,
  app,
  selectedElements,
}: {
  app: AppClassProperties;
  event: KeyboardModifiersObject;
  selectedElements: readonly NonDeletedExcalidrawElement[];
}) => {
  // Linear elements (arrows and lines) never participate in soft
  // alignment — they are neither snapped nor used as snap targets (the
  // reference set filters them out separately). Placed before the
  // `event` branch below so it also applies during live gestures.
  if (
    selectedElements.length > 0 &&
    selectedElements.every((element) => isLinearElement(element))
  ) {
    return false;
  }

  if (event) {
    // Allow snapping for lasso tool when dragging selected elements
    // but not during lasso selection phase
    const isLassoDragging =
      app.state.activeTool.type === "lasso" &&
      app.state.selectedElementsAreBeingDragged;

    return (
      (app.state.activeTool.type !== "lasso" || isLassoDragging) &&
      ((app.state.objectsSnapModeEnabled && !event[KEYS.CTRL_OR_CMD]) ||
        (!app.state.objectsSnapModeEnabled &&
          event[KEYS.CTRL_OR_CMD] &&
          !isGridModeEnabled(app)))
    );
  }

  return app.state.objectsSnapModeEnabled;
};

export const areRoughlyEqual = (a: number, b: number, precision = 0.01) => {
  return Math.abs(a - b) <= precision;
};

export const getElementsCorners = (
  elements: readonly NonDeletedExcalidrawElement[],
  elementsMap: ElementsMap,
  {
    omitCenter,
    boundingBoxCorners,
    dragOffset,
  }: {
    omitCenter?: boolean;
    boundingBoxCorners?: boolean;
    dragOffset?: Vector2D;
  } = {
    omitCenter: false,
    boundingBoxCorners: false,
  },
): GlobalPoint[] => {
  let result: GlobalPoint[] = [];

  if (elements.length === 1) {
    const element = elements[0];

    let [x1, y1, x2, y2, cx, cy] = getElementAbsoluteCoords(
      element,
      elementsMap,
    );

    if (dragOffset) {
      x1 += dragOffset.x;
      x2 += dragOffset.x;
      cx += dragOffset.x;

      y1 += dragOffset.y;
      y2 += dragOffset.y;
      cy += dragOffset.y;
    }

    const halfWidth = (x2 - x1) / 2;
    const halfHeight = (y2 - y1) / 2;

    if (
      (element.type === "diamond" || element.type === "ellipse") &&
      !boundingBoxCorners
    ) {
      const leftMid = pointRotateRads<GlobalPoint>(
        pointFrom(x1, y1 + halfHeight),
        pointFrom(cx, cy),
        element.angle,
      );
      const topMid = pointRotateRads<GlobalPoint>(
        pointFrom(x1 + halfWidth, y1),
        pointFrom(cx, cy),
        element.angle,
      );
      const rightMid = pointRotateRads<GlobalPoint>(
        pointFrom(x2, y1 + halfHeight),
        pointFrom(cx, cy),
        element.angle,
      );
      const bottomMid = pointRotateRads<GlobalPoint>(
        pointFrom(x1 + halfWidth, y2),
        pointFrom(cx, cy),
        element.angle,
      );
      const center = pointFrom<GlobalPoint>(cx, cy);

      result = omitCenter
        ? [leftMid, topMid, rightMid, bottomMid]
        : [leftMid, topMid, rightMid, bottomMid, center];
    } else {
      const topLeft = pointRotateRads<GlobalPoint>(
        pointFrom(x1, y1),
        pointFrom(cx, cy),
        element.angle,
      );
      const topRight = pointRotateRads<GlobalPoint>(
        pointFrom(x2, y1),
        pointFrom(cx, cy),
        element.angle,
      );
      const bottomLeft = pointRotateRads<GlobalPoint>(
        pointFrom(x1, y2),
        pointFrom(cx, cy),
        element.angle,
      );
      const bottomRight = pointRotateRads<GlobalPoint>(
        pointFrom(x2, y2),
        pointFrom(cx, cy),
        element.angle,
      );
      const center = pointFrom<GlobalPoint>(cx, cy);

      result = omitCenter
        ? [topLeft, topRight, bottomLeft, bottomRight]
        : [topLeft, topRight, bottomLeft, bottomRight, center];
    }
  } else if (elements.length > 1) {
    const [minX, minY, maxX, maxY] = getDraggedElementsBounds(
      elements,
      dragOffset ?? { x: 0, y: 0 },
    );
    const width = maxX - minX;
    const height = maxY - minY;

    const topLeft = pointFrom<GlobalPoint>(minX, minY);
    const topRight = pointFrom<GlobalPoint>(maxX, minY);
    const bottomLeft = pointFrom<GlobalPoint>(minX, maxY);
    const bottomRight = pointFrom<GlobalPoint>(maxX, maxY);
    const center = pointFrom<GlobalPoint>(minX + width / 2, minY + height / 2);

    result = omitCenter
      ? [topLeft, topRight, bottomLeft, bottomRight]
      : [topLeft, topRight, bottomLeft, bottomRight, center];
  }

  return result.map((p) => pointFrom(round(p[0]), round(p[1])));
};

const getReferenceElements = (
  elements: readonly NonDeletedExcalidrawElement[],
  selectedElements: readonly ExcalidrawElement[],
  appState: AppState,
  elementsMap: ElementsMap,
) =>
  getVisibleAndNonSelectedElements(
    elements,
    selectedElements,
    appState,
    elementsMap,
    // Linear elements (arrows and lines) are never snap targets.
  ).filter((element) => !isLinearElement(element));

export const getVisibleGaps = (
  elements: readonly NonDeletedExcalidrawElement[],
  selectedElements: readonly NonDeletedExcalidrawElement[],
  appState: AppState,
  elementsMap: ElementsMap,
) => {
  const referenceElements: ExcalidrawElement[] = getReferenceElements(
    elements,
    selectedElements,
    appState,
    elementsMap,
  );

  const referenceBounds = getMaximumGroups(referenceElements, elementsMap)
    .filter(
      (elementsGroup) =>
        !(elementsGroup.length === 1 && isBoundToContainer(elementsGroup[0])),
    )
    .map((group) => ({
      bounds: getCommonBounds(group).map((bound) =>
        round(bound),
      ) as unknown as Bounds,
      ids: group.map((element) => element.id),
    }));

  const horizontallySorted = referenceBounds.sort(
    (a, b) => a.bounds[0] - b.bounds[0],
  );

  const horizontalGaps: Gap[] = [];

  let c = 0;

  horizontal: for (let i = 0; i < horizontallySorted.length; i++) {
    const { bounds: startBounds, ids: startIds } = horizontallySorted[i];

    for (let j = i + 1; j < horizontallySorted.length; j++) {
      if (++c > VISIBLE_GAPS_LIMIT_PER_AXIS) {
        break horizontal;
      }

      const { bounds: endBounds, ids: endIds } = horizontallySorted[j];

      const [, startMinY, startMaxX, startMaxY] = startBounds;
      const [endMinX, endMinY, , endMaxY] = endBounds;

      if (
        startMaxX < endMinX &&
        rangesOverlap(
          rangeInclusive(startMinY, startMaxY),
          rangeInclusive(endMinY, endMaxY),
        )
      ) {
        horizontalGaps.push({
          startBounds,
          endBounds,
          startIds,
          endIds,
          startSide: [
            pointFrom(startMaxX, startMinY),
            pointFrom(startMaxX, startMaxY),
          ],
          endSide: [pointFrom(endMinX, endMinY), pointFrom(endMinX, endMaxY)],
          length: endMinX - startMaxX,
          overlap: rangeIntersection(
            rangeInclusive(startMinY, startMaxY),
            rangeInclusive(endMinY, endMaxY),
          )!,
        });
      }
    }
  }

  const verticallySorted = referenceBounds.sort(
    (a, b) => a.bounds[1] - b.bounds[1],
  );

  const verticalGaps: Gap[] = [];

  c = 0;

  vertical: for (let i = 0; i < verticallySorted.length; i++) {
    const { bounds: startBounds, ids: startIds } = verticallySorted[i];

    for (let j = i + 1; j < verticallySorted.length; j++) {
      if (++c > VISIBLE_GAPS_LIMIT_PER_AXIS) {
        break vertical;
      }
      const { bounds: endBounds, ids: endIds } = verticallySorted[j];

      const [startMinX, , startMaxX, startMaxY] = startBounds;
      const [endMinX, endMinY, endMaxX] = endBounds;

      if (
        startMaxY < endMinY &&
        rangesOverlap(
          rangeInclusive(startMinX, startMaxX),
          rangeInclusive(endMinX, endMaxX),
        )
      ) {
        verticalGaps.push({
          startBounds,
          endBounds,
          startIds,
          endIds,
          startSide: [
            pointFrom(startMinX, startMaxY),
            pointFrom(startMaxX, startMaxY),
          ],
          endSide: [pointFrom(endMinX, endMinY), pointFrom(endMaxX, endMinY)],
          length: endMinY - startMaxY,
          overlap: rangeIntersection(
            rangeInclusive(startMinX, startMaxX),
            rangeInclusive(endMinX, endMaxX),
          )!,
        });
      }
    }
  }

  return {
    horizontalGaps,
    verticalGaps,
  };
};

/** Per-axis multiple of the drag offset each element travels by. */
export type DragFactors = {
  x: ReadonlyMap<string, number>;
  y: ReadonlyMap<string, number>;
};

/**
 * How far one side of a cached gap has travelled, or null if its group
 * has come apart.
 *
 * A gap side is a *maximum group*, and grouping is not alignment: two
 * members can be pulled by different constraints and take different
 * factors. There is then no single displacement for that side, and the
 * gap it bounds has stopped being a rectangle anyone can measure, so it
 * is dropped rather than drawn somewhere plausible.
 */
const gapSideShift = (
  ids: readonly string[],
  offset: Vector2D,
  factors: DragFactors,
): Vector2D | null => {
  let fx: number | null = null;
  let fy: number | null = null;
  for (const id of ids) {
    const x = factors.x.get(id) ?? 0;
    const y = factors.y.get(id) ?? 0;
    if (fx === null) {
      fx = x;
      fy = y;
    } else if (fx !== x || fy !== y) {
      return null;
    }
  }
  return fx === null ? { x: 0, y: 0 } : { x: fx * offset.x, y: fy! * offset.y };
};

const shiftBounds = (bounds: Bounds, by: Vector2D): Bounds => [
  bounds[0] + by.x,
  bounds[1] + by.y,
  bounds[2] + by.x,
  bounds[3] + by.y,
];

/**
 * A cached gap moved to where its two elements are *now*.
 *
 * The gap cache is built once at pointer-down, because enumerating every
 * pair is quadratic and has no business on the pointermove path. But a
 * hard alignment means a reference element can be moving while it sits in
 * that cache, and a stale gap is worse than a missing one: the selection
 * snaps into a space that isn't there any more.
 *
 * The set of pairs barely changes during a drag, though — only their
 * coordinates — and those are known exactly, since a comover travels by
 * `factor × offset` (`getAlignmentDragFactors`, the same map the
 * propagator uses). So the enumeration stays cached and only the geometry
 * is brought forward.
 *
 * Returns null when the two sides have drifted out of overlap, since a
 * gap is only defined where the elements face each other. That is the one
 * thing this can't fix by shifting: a pair that starts overlapping mid
 * drag was never enumerated, so it can't appear. Missing a gap that
 * should have shown up is a much quieter failure than offering one that
 * has moved.
 */
const shiftCachedGap = (
  gap: Gap,
  axis: "x" | "y",
  offset: Vector2D,
  factors: DragFactors,
): Gap | null => {
  const start = gapSideShift(gap.startIds, offset, factors);
  const end = gapSideShift(gap.endIds, offset, factors);
  if (!start || !end) {
    return null;
  }
  if (start.x === 0 && start.y === 0 && end.x === 0 && end.y === 0) {
    return gap;
  }

  const startBounds = shiftBounds(gap.startBounds, start);
  const endBounds = shiftBounds(gap.endBounds, end);

  // the gap runs along `axis`; the overlap is measured across it
  const acrossStart: InclusiveRange =
    axis === "x"
      ? rangeInclusive(startBounds[1], startBounds[3])
      : rangeInclusive(startBounds[0], startBounds[2]);
  const acrossEnd: InclusiveRange =
    axis === "x"
      ? rangeInclusive(endBounds[1], endBounds[3])
      : rangeInclusive(endBounds[0], endBounds[2]);
  if (!rangesOverlap(acrossStart, acrossEnd)) {
    return null;
  }

  const length =
    axis === "x"
      ? endBounds[0] - startBounds[2]
      : endBounds[1] - startBounds[3];
  if (length < 0) {
    // the two have crossed; there is no gap between them any more
    return null;
  }

  const shiftPoint = (point: GlobalPoint, by: Vector2D): GlobalPoint =>
    pointFrom(point[0] + by.x, point[1] + by.y);

  return {
    ...gap,
    startBounds,
    endBounds,
    startSide: [
      shiftPoint(gap.startSide[0], start),
      shiftPoint(gap.startSide[1], start),
    ],
    endSide: [
      shiftPoint(gap.endSide[0], end),
      shiftPoint(gap.endSide[1], end),
    ],
    length,
    overlap: rangeIntersection(acrossStart, acrossEnd)!,
  };
};

const getGapSnaps = (
  selectedElements: readonly NonDeletedExcalidrawElement[],
  dragOffset: Vector2D,
  app: AppClassProperties,
  event: KeyboardModifiersObject,
  nearestSnapsX: Snaps,
  nearestSnapsY: Snaps,
  minOffset: Vector2D,
  factors: DragFactors,
) => {
  if (!isSnappingEnabled({ app, event, selectedElements })) {
    return [];
  }

  if (selectedElements.length === 0) {
    return [];
  }

  const visibleGaps = SnapCache.getVisibleGaps();

  if (visibleGaps) {
    // Brought forward from the cache's pre-drag geometry to where the
    // elements actually are this frame — see `shiftCachedGap`.
    const horizontalGaps = visibleGaps.horizontalGaps
      .map((gap) => shiftCachedGap(gap, "x", dragOffset, factors))
      .filter((gap): gap is Gap => gap !== null);
    const verticalGaps = visibleGaps.verticalGaps
      .map((gap) => shiftCachedGap(gap, "y", dragOffset, factors))
      .filter((gap): gap is Gap => gap !== null);

    // A gap the selection is already hard-linked to is not on offer: the
    // spacing is kept by the constraint, so a transient guide proposing
    // it would only restate what the scene enforces — and its line would
    // be drawn from the cache's pre-drag bounds of partners that are
    // comoving. The hard guide (drawn solid, with its equals badges) is
    // what reports the relationship during the drag instead. Same reason
    // `getReferenceSnapPoints` masks hard-aligned partners.
    const elementsMap = app.scene.getNonDeletedElementsMap();
    const selectedIds = selectedElements.map((element) => element.id);
    const alreadyHard = (axis: "x" | "y", gap: Gap) =>
      hasHardGapAlignmentAmong(
        axis,
        selectedIds,
        gap.startIds,
        gap.endIds,
        elementsMap,
      );

    const [minX, minY, maxX, maxY] = getDraggedElementsBounds(
      selectedElements,
      dragOffset,
    ).map((bound) => round(bound));
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    for (const gap of horizontalGaps) {
      if (
        !rangesOverlap(rangeInclusive(minY, maxY), gap.overlap) ||
        alreadyHard("x", gap)
      ) {
        continue;
      }

      // center gap
      const gapMidX = gap.startSide[0][0] + gap.length / 2;
      const centerOffset = round(gapMidX - centerX);
      const gapIsLargerThanSelection = gap.length > maxX - minX;

      if (gapIsLargerThanSelection && Math.abs(centerOffset) <= minOffset.x) {
        if (Math.abs(centerOffset) < minOffset.x) {
          nearestSnapsX.length = 0;
        }
        minOffset.x = Math.abs(centerOffset);

        const snap: GapSnap = {
          type: "gap",
          direction: "center_horizontal",
          gap,
          offset: centerOffset,
        };

        nearestSnapsX.push(snap);
        continue;
      }

      // side gap, from the right
      const [, , endMaxX] = gap.endBounds;
      const distanceToEndElementX = minX - endMaxX;
      const sideOffsetRight = round(gap.length - distanceToEndElementX);

      if (Math.abs(sideOffsetRight) <= minOffset.x) {
        if (Math.abs(sideOffsetRight) < minOffset.x) {
          nearestSnapsX.length = 0;
        }
        minOffset.x = Math.abs(sideOffsetRight);

        const snap: GapSnap = {
          type: "gap",
          direction: "side_right",
          gap,
          offset: sideOffsetRight,
        };
        nearestSnapsX.push(snap);
        continue;
      }

      // side gap, from the left
      const [startMinX, , ,] = gap.startBounds;
      const distanceToStartElementX = startMinX - maxX;
      const sideOffsetLeft = round(distanceToStartElementX - gap.length);

      if (Math.abs(sideOffsetLeft) <= minOffset.x) {
        if (Math.abs(sideOffsetLeft) < minOffset.x) {
          nearestSnapsX.length = 0;
        }
        minOffset.x = Math.abs(sideOffsetLeft);

        const snap: GapSnap = {
          type: "gap",
          direction: "side_left",
          gap,
          offset: sideOffsetLeft,
        };
        nearestSnapsX.push(snap);
        continue;
      }
    }
    for (const gap of verticalGaps) {
      if (
        !rangesOverlap(rangeInclusive(minX, maxX), gap.overlap) ||
        alreadyHard("y", gap)
      ) {
        continue;
      }

      // center gap
      const gapMidY = gap.startSide[0][1] + gap.length / 2;
      const centerOffset = round(gapMidY - centerY);
      const gapIsLargerThanSelection = gap.length > maxY - minY;

      if (gapIsLargerThanSelection && Math.abs(centerOffset) <= minOffset.y) {
        if (Math.abs(centerOffset) < minOffset.y) {
          nearestSnapsY.length = 0;
        }
        minOffset.y = Math.abs(centerOffset);

        const snap: GapSnap = {
          type: "gap",
          direction: "center_vertical",
          gap,
          offset: centerOffset,
        };

        nearestSnapsY.push(snap);
        continue;
      }

      // side gap, from the top
      const [, startMinY, ,] = gap.startBounds;
      const distanceToStartElementY = startMinY - maxY;
      const sideOffsetTop = round(distanceToStartElementY - gap.length);

      if (Math.abs(sideOffsetTop) <= minOffset.y) {
        if (Math.abs(sideOffsetTop) < minOffset.y) {
          nearestSnapsY.length = 0;
        }
        minOffset.y = Math.abs(sideOffsetTop);

        const snap: GapSnap = {
          type: "gap",
          direction: "side_top",
          gap,
          offset: sideOffsetTop,
        };
        nearestSnapsY.push(snap);
        continue;
      }

      // side gap, from the bottom
      const [, , , endMaxY] = gap.endBounds;
      const distanceToEndElementY = round(minY - endMaxY);
      const sideOffsetBottom = gap.length - distanceToEndElementY;

      if (Math.abs(sideOffsetBottom) <= minOffset.y) {
        if (Math.abs(sideOffsetBottom) < minOffset.y) {
          nearestSnapsY.length = 0;
        }
        minOffset.y = Math.abs(sideOffsetBottom);

        const snap: GapSnap = {
          type: "gap",
          direction: "side_bottom",
          gap,
          offset: sideOffsetBottom,
        };
        nearestSnapsY.push(snap);
        continue;
      }
    }
  }
};

/**
 * Which reference elements the gesture will drag along with it, per axis.
 *
 * A drag carries an element whole, so every hard link it holds transmits
 * and `getAlignmentDragFactors` is the answer. A resize moves only the edges
 * its handle controls, so the same pair can comove or not depending on
 * which handle is held — top-aligned elements comove on y when the north
 * handle pulls the shared edge, and not at all when the south handle
 * moves the far one. Asking the drag solver during a resize masks that
 * second case as though the partner were following, which silently
 * removes it as a snap target on the axis they are aligned on.
 */
const getSnapComovers = (
  selectedElements: readonly NonDeletedExcalidrawElement[],
  elementsMap: ElementsMap,
  resize: ResizeSnapContext | null,
): DragFactors => {
  const ids = new Set(selectedElements.map((element) => element.id));
  if (!resize) {
    return {
      x: getAlignmentDragFactors(ids, "x", elementsMap),
      y: getAlignmentDragFactors(ids, "y", elementsMap),
    };
  }

  const opts = {
    handle: resize.handle,
    shouldResizeFromCenter: resize.shouldResizeFromCenter,
    allEdgesMove:
      selectedElements.length > 1 ||
      selectedElements.some((element) => element.angle !== 0),
  };
  // Nothing is treated as frozen here. A frozen axis is one the resize
  // refuses outright, so its partners don't move and masking them would
  // be wrong — but the freeze is decided later in the same pointermove,
  // and being one frame stale would flicker the mask. Assuming free is
  // the conservative side: it can only mask a target that isn't going to
  // move, never expose one that is.
  const frozen = { x: false, y: false };
  const edge = getAlignmentResizeMovers(ids, elementsMap, opts, frozen);
  const gap = getGapAlignmentResizeMovers(ids, elementsMap, opts, frozen);
  // A resize has no single offset for a factor to be a multiple of — its
  // partners move by per-edge amounts. Any non-zero value masks the point
  // correctly, and the travel is never read, because the correction it
  // feeds is only applied on the drag path.
  const asFactors = (a: Set<string>, b: Set<string>) => {
    const factors = new Map<string, number>();
    for (const id of [...a, ...b]) {
      factors.set(id, 1);
    }
    return factors;
  };
  return { x: asFactors(edge.x, gap.x), y: asFactors(edge.y, gap.y) };
};

export type ResizeSnapContext = {
  handle: string | false;
  shouldResizeFromCenter: boolean;
};

export const getReferenceSnapPoints = (
  elements: readonly NonDeletedExcalidrawElement[],
  selectedElements: readonly NonDeletedExcalidrawElement[],
  appState: AppState,
  elementsMap: ElementsMap,
  resize: ResizeSnapContext | null = null,
) => {
  const referenceElements = getReferenceElements(
    elements,
    selectedElements,
    appState,
    elementsMap,
  );
  // Elements hard-aligned to the selection move along with it, per axis.
  // Their pre-gesture coordinate on that axis is frozen in this cache, so
  // we mask those points off on the axis they comove, keeping them as
  // valid snap targets on the free axis.
  const factors = getSnapComovers(selectedElements, elementsMap, resize);

  /**
   * The one factor a whole group travels by, or null when its members
   * disagree.
   *
   * A group's snap points come from its *common* bounds, so they only
   * mean anything if the group moves as one. Grouping is not alignment,
   * though, and two members can be pulled by different constraints — in
   * which case there is no correction to make, and null both masks the
   * axis and leaves the cached coordinate alone.
   */
  const groupFactor = (
    elementGroup: readonly NonDeletedExcalidrawElement[],
    axis: "x" | "y",
  ): number | null => {
    let shared: number | null = null;
    for (const element of elementGroup) {
      const factor = factors[axis].get(element.id) ?? 0;
      if (shared === null) {
        shared = factor;
      } else if (shared !== factor) {
        return null;
      }
    }
    return shared;
  };

  return getMaximumGroups(referenceElements, elementsMap)
    .filter(
      (elementsGroup) =>
        !(elementsGroup.length === 1 && isBoundToContainer(elementsGroup[0])),
    )
    .flatMap((elementGroup): ReferenceSnapPoint[] => {
      const factorX = groupFactor(elementGroup, "x");
      const factorY = groupFactor(elementGroup, "y");
      return getElementsCorners(elementGroup, elementsMap).map((point) => ({
        point,
        // standing still is exactly what makes a point snappable
        snapX: factorX === 0,
        snapY: factorY === 0,
        factorX: factorX ?? 0,
        factorY: factorY ?? 0,
      }));
    });
};

const getPointSnaps = (
  selectedElements: readonly NonDeletedExcalidrawElement[],
  selectionSnapPoints: GlobalPoint[],
  app: AppClassProperties,
  event: KeyboardModifiersObject,
  nearestSnapsX: Snaps,
  nearestSnapsY: Snaps,
  minOffset: Vector2D,
  // Offset the dragged selection has been moved by. A reference point
  // hard-aligned to the selection comoves by this amount on its masked
  // axis, so we shift its (frozen, pre-drag) coordinate there to its
  // current position — otherwise the rendered snap line would stretch
  // back to where the partner used to be.
  comoveOffset: Vector2D = { x: 0, y: 0 },
) => {
  if (
    !isSnappingEnabled({ app, event, selectedElements }) ||
    (selectedElements.length === 0 && selectionSnapPoints.length === 0)
  ) {
    return [];
  }

  const referenceSnapPoints = SnapCache.getReferenceSnapPoints();

  if (referenceSnapPoints) {
    for (const thisSnapPoint of selectionSnapPoints) {
      for (const otherSnapPoint of referenceSnapPoints) {
        const { snapX, snapY } = otherSnapPoint;
        // Carried forward to where the partner is now. A snapping axis
        // has a factor of 0 and so is left alone; a comoving one is
        // moved by its own multiple of the offset, which for a gap chain
        // member is rarely the whole of it. This only affects the point
        // stored for line rendering — comoving axes never snap.
        const point = pointFrom<GlobalPoint>(
          otherSnapPoint.point[0] + otherSnapPoint.factorX * comoveOffset.x,
          otherSnapPoint.point[1] + otherSnapPoint.factorY * comoveOffset.y,
        );
        const offsetX = point[0] - thisSnapPoint[0];
        const offsetY = point[1] - thisSnapPoint[1];

        if (snapX && Math.abs(offsetX) <= minOffset.x) {
          if (Math.abs(offsetX) < minOffset.x) {
            nearestSnapsX.length = 0;
          }

          nearestSnapsX.push({
            type: "point",
            points: [thisSnapPoint, point],
            offset: offsetX,
          });

          minOffset.x = Math.abs(offsetX);
        }

        if (snapY && Math.abs(offsetY) <= minOffset.y) {
          if (Math.abs(offsetY) < minOffset.y) {
            nearestSnapsY.length = 0;
          }

          nearestSnapsY.push({
            type: "point",
            points: [thisSnapPoint, point],
            offset: offsetY,
          });

          minOffset.y = Math.abs(offsetY);
        }
      }
    }
  }
};

export const snapDraggedElements = (
  elements: ExcalidrawElement[],
  dragOffset: Vector2D,
  app: AppClassProperties,
  event: KeyboardModifiersObject,
  elementsMap: ElementsMap,
) => {
  const appState = app.state;
  const selectedElements = getSelectedElements(elements, appState);
  if (
    !isSnappingEnabled({ app, event, selectedElements }) ||
    selectedElements.length === 0
  ) {
    return {
      snapOffset: {
        x: 0,
        y: 0,
      },
      snapLines: [],
    };
  }
  // An alignment anchor freezes its whole hard-aligned component on an
  // axis, so the dragged element doesn't actually go where the pointer
  // says. `dragSelectedElements` zeroes the offset there; do the same
  // here first, or every snap below is computed against a position the
  // element will never reach.
  const lockedAxes = getAlignmentLockedAxes(
    new Set(selectedElements.map((element) => element.id)),
    elementsMap,
  );
  dragOffset.x = lockedAxes.x ? 0 : round(dragOffset.x);
  dragOffset.y = lockedAxes.y ? 0 : round(dragOffset.y);

  // A hard gap alignment caps the offset once its gaps have closed, for
  // the same reason: past the cap the pointer keeps going and the
  // elements do not, so snaps computed from the raw offset would draw
  // guides to positions nothing ever reaches.
  const gapClamped = clampDragToGapAlignments(
    new Set(selectedElements.map((element) => element.id)),
    dragOffset,
    arrayToMap(elements),
    elementsMap,
  );
  const cappedX = gapClamped.x !== dragOffset.x;
  const cappedY = gapClamped.y !== dragOffset.y;
  dragOffset.x = gapClamped.x;
  dragOffset.y = gapClamped.y;

  const nearestSnapsX: Snaps = [];
  const nearestSnapsY: Snaps = [];
  const snapDistance = getSnapDistance(appState.zoom.value);
  const minOffset = {
    // A frozen axis can't be nudged onto a reference, so a near-miss
    // must not register: only an exact coincidence (offset 0) counts,
    // which still draws the guide when the alignment genuinely holds
    // and contributes a no-op snap offset. An axis sitting against its
    // gap cap is in the same position — it has no room left to be
    // nudged with.
    x: lockedAxes.x || cappedX ? 0 : snapDistance,
    y: lockedAxes.y || cappedY ? 0 : snapDistance,
  };

  // What each element travels by, as a multiple of the drag offset. The
  // cached gaps are stated in pre-drag coordinates, and this is what
  // brings the ones bounded by a comoving element up to date.
  const selectedIds = new Set(selectedElements.map((element) => element.id));
  const dragFactors: DragFactors = {
    x: getAlignmentDragFactors(selectedIds, "x", elementsMap),
    y: getAlignmentDragFactors(selectedIds, "y", elementsMap),
  };

  const selectionPoints = getElementsCorners(selectedElements, elementsMap, {
    dragOffset,
  });

  // get the nearest horizontal and vertical point and gap snaps
  getPointSnaps(
    selectedElements,
    selectionPoints,
    app,
    event,
    nearestSnapsX,
    nearestSnapsY,
    minOffset,
    dragOffset,
  );

  getGapSnaps(
    selectedElements,
    dragOffset,
    app,
    event,
    nearestSnapsX,
    nearestSnapsY,
    minOffset,
    dragFactors,
  );

  // using the nearest snaps to figure out how
  // much the elements need to be offset to be snapped
  // to some reference elements
  const snapOffset = {
    x: nearestSnapsX[0]?.offset ?? 0,
    y: nearestSnapsY[0]?.offset ?? 0,
  };

  // once the elements are snapped
  // and moved to the snapped position
  // we want to use the element's snapped position
  // to update nearest snaps so that we can create
  // point and gap snap lines correctly without any shifting

  minOffset.x = 0;
  minOffset.y = 0;
  nearestSnapsX.length = 0;
  nearestSnapsY.length = 0;
  const newDragOffset = {
    x: round(dragOffset.x + snapOffset.x),
    y: round(dragOffset.y + snapOffset.y),
  };

  getPointSnaps(
    selectedElements,
    getElementsCorners(selectedElements, elementsMap, {
      dragOffset: newDragOffset,
    }),
    app,
    event,
    nearestSnapsX,
    nearestSnapsY,
    minOffset,
    newDragOffset,
  );

  getGapSnaps(
    selectedElements,
    newDragOffset,
    app,
    event,
    nearestSnapsX,
    nearestSnapsY,
    minOffset,
    dragFactors,
  );

  const pointSnapLines = createPointSnapLines(nearestSnapsX, nearestSnapsY);

  const gapSnapLines = createGapSnapLines(
    selectedElements,
    newDragOffset,
    [...nearestSnapsX, ...nearestSnapsY].filter(
      (snap) => snap.type === "gap",
    ) as GapSnap[],
  );

  return {
    snapOffset,
    snapLines: [...pointSnapLines, ...gapSnapLines],
  };
};

const round = (x: number) => {
  const decimalPlaces = 6;
  return Math.round(x * 10 ** decimalPlaces) / 10 ** decimalPlaces;
};

const dedupePoints = (points: GlobalPoint[]): GlobalPoint[] => {
  const map = new Map<string, GlobalPoint>();

  for (const point of points) {
    const key = point.join(",");

    if (!map.has(key)) {
      map.set(key, point);
    }
  }

  return Array.from(map.values());
};

const createPointSnapLines = (
  nearestSnapsX: Snaps,
  nearestSnapsY: Snaps,
): PointSnapLine[] => {
  const snapsX = {} as { [key: string]: GlobalPoint[] };
  const snapsY = {} as { [key: string]: GlobalPoint[] };

  if (nearestSnapsX.length > 0) {
    for (const snap of nearestSnapsX) {
      if (snap.type === "point") {
        // key = thisPoint.x
        const key = round(snap.points[0][0]);
        if (!snapsX[key]) {
          snapsX[key] = [];
        }
        snapsX[key].push(
          ...snap.points.map((p) =>
            pointFrom<GlobalPoint>(round(p[0]), round(p[1])),
          ),
        );
      }
    }
  }

  if (nearestSnapsY.length > 0) {
    for (const snap of nearestSnapsY) {
      if (snap.type === "point") {
        // key = thisPoint.y
        const key = round(snap.points[0][1]);
        if (!snapsY[key]) {
          snapsY[key] = [];
        }
        snapsY[key].push(
          ...snap.points.map((p) =>
            pointFrom<GlobalPoint>(round(p[0]), round(p[1])),
          ),
        );
      }
    }
  }

  return Object.entries(snapsX)
    .map(([key, points]) => {
      return {
        type: "points",
        points: dedupePoints(
          points
            .map((p) => {
              return pointFrom<GlobalPoint>(Number(key), p[1]);
            })
            .sort((a, b) => a[1] - b[1]),
        ),
      } as PointSnapLine;
    })
    .concat(
      Object.entries(snapsY).map(([key, points]) => {
        return {
          type: "points",
          points: dedupePoints(
            points
              .map((p) => {
                return pointFrom<GlobalPoint>(p[0], Number(key));
              })
              .sort((a, b) => a[0] - b[0]),
          ),
        } as PointSnapLine;
      }),
    );
};

const dedupeGapSnapLines = (gapSnapLines: GapSnapLine[]) => {
  const map = new Map<string, GapSnapLine>();

  for (const gapSnapLine of gapSnapLines) {
    const key = gapSnapLine.points
      .flat()
      .map((point) => [round(point)])
      .join(",");

    if (!map.has(key)) {
      map.set(key, gapSnapLine);
    }
  }

  return Array.from(map.values());
};

const createGapSnapLines = (
  selectedElements: readonly NonDeletedExcalidrawElement[],
  dragOffset: Vector2D,
  gapSnaps: GapSnap[],
): GapSnapLine[] => {
  const [minX, minY, maxX, maxY] = getDraggedElementsBounds(
    selectedElements,
    dragOffset,
  );

  const gapSnapLines: GapSnapLine[] = [];

  for (const gapSnap of gapSnaps) {
    const [startMinX, startMinY, startMaxX, startMaxY] =
      gapSnap.gap.startBounds;
    const [endMinX, endMinY, endMaxX, endMaxY] = gapSnap.gap.endBounds;

    const verticalIntersection = rangeIntersection(
      rangeInclusive(minY, maxY),
      gapSnap.gap.overlap,
    );

    const horizontalGapIntersection = rangeIntersection(
      rangeInclusive(minX, maxX),
      gapSnap.gap.overlap,
    );

    switch (gapSnap.direction) {
      case "center_horizontal": {
        if (verticalIntersection) {
          const gapLineY =
            (verticalIntersection[0] + verticalIntersection[1]) / 2;

          gapSnapLines.push(
            {
              type: "gap",
              direction: "horizontal",
              points: [
                pointFrom(gapSnap.gap.startSide[0][0], gapLineY),
                pointFrom(minX, gapLineY),
              ],
            },
            {
              type: "gap",
              direction: "horizontal",
              points: [
                pointFrom(maxX, gapLineY),
                pointFrom(gapSnap.gap.endSide[0][0], gapLineY),
              ],
            },
          );
        }
        break;
      }
      case "center_vertical": {
        if (horizontalGapIntersection) {
          const gapLineX =
            (horizontalGapIntersection[0] + horizontalGapIntersection[1]) / 2;

          gapSnapLines.push(
            {
              type: "gap",
              direction: "vertical",
              points: [
                pointFrom(gapLineX, gapSnap.gap.startSide[0][1]),
                pointFrom(gapLineX, minY),
              ],
            },
            {
              type: "gap",
              direction: "vertical",
              points: [
                pointFrom(gapLineX, maxY),
                pointFrom(gapLineX, gapSnap.gap.endSide[0][1]),
              ],
            },
          );
        }
        break;
      }
      case "side_right": {
        if (verticalIntersection) {
          const gapLineY =
            (verticalIntersection[0] + verticalIntersection[1]) / 2;

          gapSnapLines.push(
            {
              type: "gap",
              direction: "horizontal",
              points: [
                pointFrom(startMaxX, gapLineY),
                pointFrom(endMinX, gapLineY),
              ],
            },
            {
              type: "gap",
              direction: "horizontal",
              points: [pointFrom(endMaxX, gapLineY), pointFrom(minX, gapLineY)],
            },
          );
        }
        break;
      }
      case "side_left": {
        if (verticalIntersection) {
          const gapLineY =
            (verticalIntersection[0] + verticalIntersection[1]) / 2;

          gapSnapLines.push(
            {
              type: "gap",
              direction: "horizontal",
              points: [
                pointFrom(maxX, gapLineY),
                pointFrom(startMinX, gapLineY),
              ],
            },
            {
              type: "gap",
              direction: "horizontal",
              points: [
                pointFrom(startMaxX, gapLineY),
                pointFrom(endMinX, gapLineY),
              ],
            },
          );
        }
        break;
      }
      case "side_top": {
        if (horizontalGapIntersection) {
          const gapLineX =
            (horizontalGapIntersection[0] + horizontalGapIntersection[1]) / 2;

          gapSnapLines.push(
            {
              type: "gap",
              direction: "vertical",
              points: [
                pointFrom(gapLineX, maxY),
                pointFrom(gapLineX, startMinY),
              ],
            },
            {
              type: "gap",
              direction: "vertical",
              points: [
                pointFrom(gapLineX, startMaxY),
                pointFrom(gapLineX, endMinY),
              ],
            },
          );
        }
        break;
      }
      case "side_bottom": {
        if (horizontalGapIntersection) {
          const gapLineX =
            (horizontalGapIntersection[0] + horizontalGapIntersection[1]) / 2;

          gapSnapLines.push(
            {
              type: "gap",
              direction: "vertical",
              points: [
                pointFrom(gapLineX, startMaxY),
                pointFrom(gapLineX, endMinY),
              ],
            },
            {
              type: "gap",
              direction: "vertical",
              points: [pointFrom(gapLineX, endMaxY), pointFrom(gapLineX, minY)],
            },
          );
        }
        break;
      }
    }
  }

  return dedupeGapSnapLines(
    gapSnapLines.map((gapSnapLine) => {
      return {
        ...gapSnapLine,
        points: gapSnapLine.points.map((p) =>
          pointFrom(round(p[0]), round(p[1])),
        ) as PointPair,
      };
    }),
  );
};

export const snapResizingElements = (
  // use the latest elements to create snap lines
  selectedElements: readonly NonDeletedExcalidrawElement[],
  // while using the original elements to appy dragOffset to calculate snaps
  selectedOriginalElements: readonly NonDeletedExcalidrawElement[],
  app: AppClassProperties,
  event: KeyboardModifiersObject,
  dragOffset: Vector2D,
  transformHandle: MaybeTransformHandleType,
) => {
  if (
    !isSnappingEnabled({ event, selectedElements, app }) ||
    selectedElements.length === 0 ||
    (selectedElements.length === 1 &&
      !areRoughlyEqual(selectedElements[0].angle, 0))
  ) {
    return {
      snapOffset: { x: 0, y: 0 },
      snapLines: [],
    };
  }

  let [minX, minY, maxX, maxY] = getCommonBounds(selectedOriginalElements);

  if (transformHandle) {
    if (transformHandle.includes("e")) {
      maxX += dragOffset.x;
    } else if (transformHandle.includes("w")) {
      minX += dragOffset.x;
    }

    if (transformHandle.includes("n")) {
      minY += dragOffset.y;
    } else if (transformHandle.includes("s")) {
      maxY += dragOffset.y;
    }
  }

  const selectionSnapPoints: GlobalPoint[] = [];

  if (transformHandle) {
    switch (transformHandle) {
      case "e": {
        selectionSnapPoints.push(pointFrom(maxX, minY), pointFrom(maxX, maxY));
        break;
      }
      case "w": {
        selectionSnapPoints.push(pointFrom(minX, minY), pointFrom(minX, maxY));
        break;
      }
      case "n": {
        selectionSnapPoints.push(pointFrom(minX, minY), pointFrom(maxX, minY));
        break;
      }
      case "s": {
        selectionSnapPoints.push(pointFrom(minX, maxY), pointFrom(maxX, maxY));
        break;
      }
      case "ne": {
        selectionSnapPoints.push(pointFrom(maxX, minY));
        break;
      }
      case "nw": {
        selectionSnapPoints.push(pointFrom(minX, minY));
        break;
      }
      case "se": {
        selectionSnapPoints.push(pointFrom(maxX, maxY));
        break;
      }
      case "sw": {
        selectionSnapPoints.push(pointFrom(minX, maxY));
        break;
      }
    }
  }

  const snapDistance = getSnapDistance(app.state.zoom.value);

  const minOffset = {
    x: snapDistance,
    y: snapDistance,
  };

  const nearestSnapsX: Snaps = [];
  const nearestSnapsY: Snaps = [];

  getPointSnaps(
    selectedOriginalElements,
    selectionSnapPoints,
    app,
    event,
    nearestSnapsX,
    nearestSnapsY,
    minOffset,
  );

  const snapOffset = {
    x: nearestSnapsX[0]?.offset ?? 0,
    y: nearestSnapsY[0]?.offset ?? 0,
  };

  // again, once snap offset is calculated
  // reset to recompute for creating snap lines to be rendered
  minOffset.x = 0;
  minOffset.y = 0;
  nearestSnapsX.length = 0;
  nearestSnapsY.length = 0;

  const [x1, y1, x2, y2] = getCommonBounds(selectedElements).map((bound) =>
    round(bound),
  );

  const corners: GlobalPoint[] = [
    pointFrom(x1, y1),
    pointFrom(x1, y2),
    pointFrom(x2, y1),
    pointFrom(x2, y2),
  ];

  getPointSnaps(
    selectedElements,
    corners,
    app,
    event,
    nearestSnapsX,
    nearestSnapsY,
    minOffset,
  );

  const pointSnapLines = createPointSnapLines(nearestSnapsX, nearestSnapsY);

  return {
    snapOffset,
    snapLines: pointSnapLines,
  };
};

export const snapNewElement = (
  newElement: NonDeletedExcalidrawElement,
  app: AppClassProperties,
  event: KeyboardModifiersObject,
  origin: Vector2D,
  dragOffset: Vector2D,
  elementsMap: ElementsMap,
) => {
  if (!isSnappingEnabled({ event, selectedElements: [newElement], app })) {
    return {
      snapOffset: { x: 0, y: 0 },
      snapLines: [],
    };
  }

  const selectionSnapPoints: GlobalPoint[] = [
    pointFrom(origin.x + dragOffset.x, origin.y + dragOffset.y),
  ];

  const snapDistance = getSnapDistance(app.state.zoom.value);

  const minOffset = {
    x: snapDistance,
    y: snapDistance,
  };

  const nearestSnapsX: Snaps = [];
  const nearestSnapsY: Snaps = [];

  getPointSnaps(
    [newElement],
    selectionSnapPoints,
    app,
    event,
    nearestSnapsX,
    nearestSnapsY,
    minOffset,
  );

  const snapOffset = {
    x: nearestSnapsX[0]?.offset ?? 0,
    y: nearestSnapsY[0]?.offset ?? 0,
  };

  minOffset.x = 0;
  minOffset.y = 0;
  nearestSnapsX.length = 0;
  nearestSnapsY.length = 0;

  const corners = getElementsCorners([newElement], elementsMap, {
    boundingBoxCorners: true,
    omitCenter: true,
  });

  getPointSnaps(
    [newElement],
    corners,
    app,
    event,
    nearestSnapsX,
    nearestSnapsY,
    minOffset,
  );

  const pointSnapLines = createPointSnapLines(nearestSnapsX, nearestSnapsY);

  return {
    snapOffset,
    snapLines: pointSnapLines,
  };
};

export const getSnapLinesAtPointer = (
  elements: readonly NonDeletedExcalidrawElement[],
  app: AppClassProperties,
  pointer: Vector2D,
  event: KeyboardModifiersObject,
  elementsMap: ElementsMap,
) => {
  if (!isSnappingEnabled({ event, selectedElements: [], app })) {
    return {
      originOffset: { x: 0, y: 0 },
      snapLines: [],
    };
  }

  const referenceElements = getVisibleAndNonSelectedElements(
    elements,
    [],
    app.state,
    elementsMap,
  );

  const snapDistance = getSnapDistance(app.state.zoom.value);

  const minOffset = {
    x: snapDistance,
    y: snapDistance,
  };

  const horizontalSnapLines: PointerSnapLine[] = [];
  const verticalSnapLines: PointerSnapLine[] = [];

  for (const referenceElement of referenceElements) {
    const corners = getElementsCorners([referenceElement], elementsMap);

    for (const corner of corners) {
      const offsetX = corner[0] - pointer.x;

      if (Math.abs(offsetX) <= Math.abs(minOffset.x)) {
        if (Math.abs(offsetX) < Math.abs(minOffset.x)) {
          verticalSnapLines.length = 0;
        }

        verticalSnapLines.push({
          type: "pointer",
          points: [corner, pointFrom(corner[0], pointer.y)],
          direction: "vertical",
        });

        minOffset.x = offsetX;
      }

      const offsetY = corner[1] - pointer.y;

      if (Math.abs(offsetY) <= Math.abs(minOffset.y)) {
        if (Math.abs(offsetY) < Math.abs(minOffset.y)) {
          horizontalSnapLines.length = 0;
        }

        horizontalSnapLines.push({
          type: "pointer",
          points: [corner, pointFrom(pointer.x, corner[1])],
          direction: "horizontal",
        });

        minOffset.y = offsetY;
      }
    }
  }

  return {
    originOffset: {
      x:
        verticalSnapLines.length > 0
          ? verticalSnapLines[0].points[0][0] - pointer.x
          : 0,
      y:
        horizontalSnapLines.length > 0
          ? horizontalSnapLines[0].points[0][1] - pointer.y
          : 0,
    },
    snapLines: [...verticalSnapLines, ...horizontalSnapLines],
  };
};

export const isActiveToolNonLinearSnappable = (
  activeToolType: AppState["activeTool"]["type"],
) => {
  return (
    activeToolType === TOOL_TYPE.rectangle ||
    activeToolType === TOOL_TYPE.ellipse ||
    activeToolType === TOOL_TYPE.diamond ||
    activeToolType === TOOL_TYPE.frame ||
    activeToolType === TOOL_TYPE.magicframe ||
    activeToolType === TOOL_TYPE.image ||
    activeToolType === TOOL_TYPE.text
  );
};
