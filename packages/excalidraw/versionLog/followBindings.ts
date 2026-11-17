/**
 * Put bound arrow ends where their bindings say, after an op has moved
 * what they are bound to.
 *
 * A bound end is derived state: the binding's `fixedPoint` is a position
 * relative to the element it names, so where the end goes is a function
 * of that element's geometry. The log still records each follow (as a
 * consequent op, for the panel), but replaying the recorded points would
 * put the end where the element *was* when the follow happened — wrong as
 * soon as a skipped Moment has put the element somewhere else. So the
 * points are recomputed instead, by the same `updateBoundPoint` upstream
 * calls while the element is being dragged, and placed the way
 * `LinearElementEditor.movePoints` places them.
 *
 * Elbow arrows are left out: moving an end of one needs the router, which
 * works on a `Scene` rather than a snapshot, so their recorded follows
 * still replay (`applyConsequentOps`).
 */

import { getSizeFromPoints } from "@excalidraw/common";
import {
  getElementPointsCoords,
  isArrowElement,
  isBindableElement,
  isElbowArrow,
  updateBoundPoint,
} from "@excalidraw/element";
import { pointFrom, pointRotateRads } from "@excalidraw/math";

import type {
  ElementsMap,
  ExcalidrawArrowElement,
  NonDeleted,
} from "@excalidraw/element/types";
import type { LocalPoint } from "@excalidraw/math";

import type { SceneSnapshot } from "./applyOps";

/**
 * Re-place the bound ends of every arrow that is itself in `changedIds`
 * or is bound to something that is. Returns the ids of the arrows it
 * rewrote.
 */
export const followBindings = (
  scene: SceneSnapshot,
  changedIds: ReadonlySet<string>,
): string[] => {
  const rewritten: string[] = [];
  const elementsMap = scene as unknown as ElementsMap;
  for (const el of Array.from(scene.values())) {
    if (el.isDeleted || !isArrowElement(el) || isElbowArrow(el)) {
      continue;
    }
    const arrow = el as NonDeleted<ExcalidrawArrowElement>;
    const startId = arrow.startBinding?.elementId;
    const endId = arrow.endBinding?.elementId;
    if (
      !changedIds.has(arrow.id) &&
      !(startId && changedIds.has(startId)) &&
      !(endId && changedIds.has(endId))
    ) {
      continue;
    }

    // Both ends from the arrow as it stands, as upstream computes them:
    // each end's placement aims at the other end's current position.
    const last = arrow.points.length - 1;
    const updates = new Map<number, LocalPoint>();
    for (const prop of ["startBinding", "endBinding"] as const) {
      const bindable = scene.get(arrow[prop]?.elementId ?? "");
      if (!bindable || bindable.isDeleted || !isBindableElement(bindable)) {
        continue;
      }
      const point = updateBoundPoint(
        arrow,
        prop,
        arrow[prop],
        bindable,
        elementsMap,
      );
      if (point) {
        updates.set(prop === "startBinding" ? 0 : last, point);
      }
    }
    if (updates.size === 0) {
      continue;
    }

    // An arrow bound to one element at both ends moves with it whole —
    // its midpoints travel with its start rather than staying put.
    const moveMidPoints = !!startId && startId === endId;
    // The start point stays at [0, 0]; the origin moves instead.
    const [offsetX, offsetY] = updates.get(0) ?? pointFrom<LocalPoint>(0, 0);
    const points = arrow.points.map((p, idx) => {
      const current = updates.get(idx) ?? p;
      if (moveMidPoints && idx !== 0 && idx !== last && !updates.has(idx)) {
        return current;
      }
      return pointFrom<LocalPoint>(current[0] - offsetX, current[1] - offsetY);
    });
    if (
      offsetX === 0 &&
      offsetY === 0 &&
      points.every(
        (p, idx) =>
          p[0] === arrow.points[idx][0] && p[1] === arrow.points[idx][1],
      )
    ) {
      continue;
    }

    // A rotated arrow rotates about its centre, which moves with the
    // points — the correction `_updatePoints` makes.
    let dx = offsetX;
    let dy = offsetY;
    if (arrow.angle !== 0) {
      const next = getElementPointsCoords(arrow, points);
      const prev = getElementPointsCoords(arrow, arrow.points);
      [dx, dy] = pointRotateRads(
        pointFrom(offsetX, offsetY),
        pointFrom(
          (prev[0] + prev[2]) / 2 - (next[0] + next[2]) / 2,
          (prev[1] + prev[3]) / 2 - (next[1] + next[3]) / 2,
        ),
        arrow.angle,
      );
    }

    scene.set(arrow.id, {
      ...arrow,
      points,
      x: arrow.x + dx,
      y: arrow.y + dy,
      ...getSizeFromPoints(points),
      version: arrow.version + 1,
    } as typeof el);
    rewritten.push(arrow.id);
  }
  return rewritten;
};
