import { type GlobalPoint, type LocalPoint } from "@excalidraw/math";

import {
  drawGapEndCap,
  drawGapMidpointTicks,
  drawIndicatorCross,
  getAlignmentIndicatorColor,
  getIndicatorLineWidth,
  getNarrowIndicatorLineDash,
  getWideIndicatorLineDash,
} from "./indicatorHelpers";

import type { PointSnapLine, PointerSnapLine } from "../snapping";
import type { InteractiveCanvasAppState } from "../types";

/** Tolerance for calling a transient gap line the same gap as one an
 * equal-gap guide is already drawing. Both come from the same element
 * bounds; upstream rounds its dragged bounds, so this only has to
 * survive that. */
const GAP_LINE_MATCH_EPSILON = 1;

/**
 * Gaps an equal-gap guide is already reporting, so the transient snap
 * line for the same gap can be skipped.
 *
 * Upstream draws one line per *snap*, two lines per snap, each at its own
 * perpendicular coordinate — so a single evenly-spaced arrangement can
 * report the same gap two or three times, at slightly different offsets.
 * Our guide draws one span per gap on a single shared line. Suppressing
 * the duplicates leaves exactly one picture of the relationship, and it
 * is the same one the user sees when the pointer is up.
 *
 * Matched by interval rather than by identity because a snap line carries
 * only coordinates. Anything unmatched — a gap between grouped elements,
 * say, which our per-element detection doesn't enumerate — still draws,
 * so no snap goes unreported.
 */
export type CoveredGap = {
  direction: "horizontal" | "vertical";
  from: number;
  to: number;
};

const isCovered = (
  snapLine: { direction: "horizontal" | "vertical"; points: readonly [GlobalPoint, GlobalPoint] },
  covered: readonly CoveredGap[],
): boolean => {
  const axisIndex = snapLine.direction === "horizontal" ? 0 : 1;
  const a = snapLine.points[0][axisIndex];
  const b = snapLine.points[1][axisIndex];
  return covered.some(
    (gap) =>
      gap.direction === snapLine.direction &&
      Math.abs(Math.min(gap.from, gap.to) - Math.min(a, b)) <=
        GAP_LINE_MATCH_EPSILON &&
      Math.abs(Math.max(gap.from, gap.to) - Math.max(a, b)) <=
        GAP_LINE_MATCH_EPSILON,
  );
};

export const renderSnaps = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  coveredGaps: readonly CoveredGap[] = [],
) => {
  if (!appState.snapLines.length) {
    return;
  }

  const snapColor = getAlignmentIndicatorColor(appState.theme, appState.zenModeEnabled);
  // in zen mode make the cross more visible since we don't draw the lines
  const snapWidth = getIndicatorLineWidth(
    appState.zoom.value,
    appState.zenModeEnabled,
  );

  context.save();
  context.translate(appState.scrollX, appState.scrollY);

  for (const snapLine of appState.snapLines) {
    if (snapLine.type === "pointer") {
      context.lineWidth = snapWidth;
      context.strokeStyle = snapColor;

      drawPointerSnapLine(snapLine, context, appState);
    } else if (snapLine.type === "gap") {
      if (isCovered(snapLine, coveredGaps)) {
        continue;
      }
      context.lineWidth = snapWidth;
      context.strokeStyle = snapColor;

      drawGapLine(
        snapLine.points[0],
        snapLine.points[1],
        snapLine.direction,
        appState,
        context,
      );
    } else if (snapLine.type === "points") {
      context.lineWidth = snapWidth;
      context.strokeStyle = snapColor;
      drawPointsSnapLine(snapLine, context, appState);
    }
  }

  context.restore();
};

const drawPointsSnapLine = (
  pointSnapLine: PointSnapLine,
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
) => {
  if (!appState.zenModeEnabled) {
    const firstPoint = pointSnapLine.points[0];
    const lastPoint = pointSnapLine.points[pointSnapLine.points.length - 1];

    context.setLineDash(getWideIndicatorLineDash(appState.zoom.value));
    drawLine(firstPoint, lastPoint, context);
    context.setLineDash([]);
  }

  for (const point of pointSnapLine.points) {
    drawCross(point, appState, context);
  }
};

const drawPointerSnapLine = (
  pointerSnapLine: PointerSnapLine,
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
) => {
  drawCross(pointerSnapLine.points[0], appState, context);
  if (!appState.zenModeEnabled) {
    context.setLineDash(getWideIndicatorLineDash(appState.zoom.value));
    drawLine(pointerSnapLine.points[0], pointerSnapLine.points[1], context);
    context.setLineDash([]);
  }
};

const drawCross = <Point extends LocalPoint | GlobalPoint>(
  [x, y]: Point,
  appState: InteractiveCanvasAppState,
  context: CanvasRenderingContext2D,
) => {
  drawIndicatorCross(context, x, y, appState.zoom.value, appState.zenModeEnabled);
};

const drawLine = <Point extends LocalPoint | GlobalPoint>(
  from: Point,
  to: Point,
  context: CanvasRenderingContext2D,
) => {
  context.beginPath();
  context.lineTo(from[0], from[1]);
  context.lineTo(to[0], to[1]);
  context.stroke();
};

const drawGapLine = <Point extends LocalPoint | GlobalPoint>(
  from: Point,
  to: Point,
  direction: "horizontal" | "vertical",
  appState: InteractiveCanvasAppState,
  context: CanvasRenderingContext2D,
) => {
  // a horizontal gap snap line
  // |–––––––||–––––––|
  // ^    ^   ^       ^
  // \    \   \       \
  // (1)  (2) (3)     (4)

  const zoom = appState.zoom.value;
  const axis = direction === "horizontal" ? "x" : "y";
  const halfPoint =
    direction === "horizontal"
      ? [(from[0] + to[0]) / 2, from[1]]
      : [from[0], (from[1] + to[1]) / 2];

  // (1) and (4)
  if (!appState.zenModeEnabled) {
    drawGapEndCap(context, from[0], from[1], axis, zoom);
    drawGapEndCap(context, to[0], to[1], axis, zoom);
  }

  // (3)
  drawGapMidpointTicks(context, halfPoint[0], halfPoint[1], axis, zoom);

  // (2)
  if (!appState.zenModeEnabled) {
    context.setLineDash(getNarrowIndicatorLineDash(zoom));
    drawLine(from, to, context);
    context.setLineDash([]);
  }
};
