/**
 * Apply a sequence of `LogOperation`s to a scene snapshot, in either
 * direction. 
 * 
 * Direction:
 *   - "forward":  apply each op as it was originally — moves x/y by
 *                 +(dx, dy), sets angle to `op.to`, etc.
 *   - "backward": invert each op — moves x/y by -(dx, dy), sets angle
 *                 to `op.from`, etc.
 *
 */

import { isElbowArrow } from "@excalidraw/element";

import type {
  ElementAlignment,
  ElementGapAlignment,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type { Radians } from "@excalidraw/math";

import { followBindings } from "./followBindings";
import { applyMatrixToPoint, inverseMatrix } from "./transform";
import {
  collectElementIdsFromGroupNode,
  getOperationElementIds,
} from "./types";

import type { TransformMatrix } from "./transform";
import type { ArrowGeometryChange, LogOperation } from "./types";

/**
 * Mutable scene snapshot used during op application. Keyed by element
 * id; values are the element objects (treated as immutable).
 */
export type SceneSnapshot = Map<string, OrderedExcalidrawElement>;

export type ApplyDirection = "forward" | "backward";

/**
 * Apply every op in `ops` to `scene` in the given direction.
 * Mutates `scene` in place.
 *
 * After each op, the arrows bound to whatever it changed are re-placed
 * from their bindings (`followBindings`). Returns the ids of the arrows
 * that moved that way — no op names an arrow whose end only follows a
 * remapped or skipped change, so a caller tracking what it touched has
 * to be told.
 */
export const applyOpsToScene = (
  ops: readonly LogOperation[],
  scene: SceneSnapshot,
  direction: ApplyDirection,
): string[] => {
  const iter = direction === "backward" ? [...ops].reverse() : ops;
  const followed: string[] = [];
  for (const op of iter) {
    applyOpToScene(op, scene, direction);
    followed.push(
      ...followBindings(scene, new Set(getOperationElementIds(op))),
    );
  }
  return followed;
};

// ---------------------------------------------------------------------

/**
 * Replace the element at `id` with the result of merging it with the updated properties contained in `updates`. 
 * If there's no existing element, the call is a no-op.
 *
 * Always increment `version` because Excalidraw checks the version number
 * to decide when to update its internal snapshot. 
 */
export const updateElement = (
  scene: SceneSnapshot,
  id: string,
  updates: Partial<OrderedExcalidrawElement>,
): void => {
  const el = scene.get(id);
  if (!el) {
    return;
  }
  // Cast back to OrderedExcalidrawElement: spreading widens the
  // discriminated union (TS forgets which variant `el` was), but at
  // runtime the shape is preserved.
  scene.set(id, {
    ...el,
    ...updates,
    version: el.version + 1,
  } as OrderedExcalidrawElement);
};

/**
 * Same as updateElement, but insert it if it isn't there.
 * Used by `create` forward and `delete` backward.
 * 
 * Expectation: `values` contains the full set of properties
 * so that Excalidraw can render it properly.
 */
const upsertElement = (
  scene: SceneSnapshot,
  id: string,
  values: Partial<OrderedExcalidrawElement>,
): void => {
  const el = scene.get(id);
  if (el) {
    updateElement(scene, id, values);
  } else {
    // Also add the Excalidraw default values (version, groupIds, boundElements)
    // so that Excalidraw doesn't populate them with default values 
    // and emit extra deltas
    scene.set(id, {
      id,
      version: 1,
      groupIds: [],
      boundElements: null,
      ...values,
    } as unknown as OrderedExcalidrawElement);
  }
};

export type Link = ElementAlignment | ElementGapAlignment;
export type LinkMap = Record<string, readonly Link[]>;

/** A link's identity: an edge link is one coincidence with one partner, so
 * a pair linked at two places on an axis holds two; a gap chain is its
 * members in order. */
export const alignmentLinkKey = (link: Link): string =>
  "ids" in link
    ? `gap:${link.axis}:${link.ids.join(",")}`
    : `edge:${link.elementId}:${link.axis}:${link.selfEdge}:${link.otherEdge}`;

/**
 * `current` with the change from `from` to `to` applied: what `from` had and
 * `to` doesn't is removed, what `to` has and `from` didn't is added, and
 * every other link in `current` is left alone. `null` when that changes
 * nothing.
 */
const applyLinkDiff = (
  current: readonly Link[],
  from: readonly Link[],
  to: readonly Link[],
): Link[] | null => {
  const fromKeys = new Set(from.map(alignmentLinkKey));
  const toKeys = new Set(to.map(alignmentLinkKey));
  const kept = current.filter((link) => {
    const key = alignmentLinkKey(link);
    return !fromKeys.has(key) || toKeys.has(key);
  });
  const present = new Set(kept.map(alignmentLinkKey));
  const gained: Link[] = [];
  for (const link of to) {
    const key = alignmentLinkKey(link);
    if (!fromKeys.has(key) && !present.has(key)) {
      present.add(key);
      gained.push(link);
    }
  }
  return kept.length === current.length && gained.length === 0
    ? null
    : [...kept, ...gained];
};

/**
 * Recompute the bounding box (width, height) from a `points` array.
 */
const bboxFromPoints = (
  points: ReadonlyArray<readonly [number, number]>,
): { width: number; height: number; } => {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [px, py] of points) {
    if (px < minX) {
      minX = px;
    }
    if (px > maxX) {
      maxX = px;
    }
    if (py < minY) {
      minY = py;
    }
    if (py > maxY) {
      maxY = py;
    }
  }
  return {
    width: maxX - minX,
    height: maxY - minY,
  };
};

/**
 * The writes that put an arrow on one side of a recorded geometry
 * change. Its origin stays put when the change didn't record one.
 */
const arrowGeometryUpdates = (
  el: OrderedExcalidrawElement,
  change: ArrowGeometryChange,
  forward: boolean,
): Record<string, unknown> => {
  const points = forward ? change.after : change.before;
  const origin = forward ? change.afterOrigin : change.beforeOrigin;
  return {
    points,
    x: origin ? origin[0] : el.x,
    y: origin ? origin[1] : el.y,
    ...bboxFromPoints(points),
  };
};

/**
 * Rotate point `(px, py)` around pivot `(cx, cy)` by `angle` radians counter-clockwise.
 */
const rotateAround = (
  px: number,
  py: number,
  cx: number,
  cy: number,
  angle: number,
): [number, number] => {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = px - cx;
  const dy = py - cy;
  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
};

/**
 * A resize's change matrix in the requested direction, or `null` when
 * going backward through one that can't be inverted (a scale to zero).
 */
const directedTransform = (
  transform: TransformMatrix,
  forward: boolean,
): TransformMatrix | null => (forward ? transform : inverseMatrix(transform));

/**
 * Where a resize puts an element of the given new size. The change
 * matrix maps the old box onto the new one, so it carries the centre to
 * the new centre, and `x`/`y` follow from that and the new size —
 * rotation included, since Excalidraw rotates about the centre.
 *
 * Not the recorded `center` (the matrix's fixed point): that exists only
 * when *both* axes scale. A resize along one axis fixes a whole line, so
 * `fixedPoint` returns `null`, and placing from it would leave the
 * element where it was, which is wrong whenever the stretch also moved
 * its near edge (a partner alignment stretched from the far side).
 */
const resizedPosition = (
  el: OrderedExcalidrawElement,
  transform: TransformMatrix,
  forward: boolean,
  width: number,
  height: number,
): { x: number; y: number } => {
  const m = directedTransform(transform, forward);
  if (!m) {
    return { x: el.x, y: el.y };
  }
  const [cx, cy] = applyMatrixToPoint(m, [
    el.x + el.width / 2,
    el.y + el.height / 2,
  ]);
  return { x: cx - width / 2, y: cy - height / 2 };
};

// ---------------------------------------------------------------------
//TODO: Evaluate if we need to get rid of this function
/**
 * Apply any ops that were absorbed into this op at classification time
 * as consequences of the same user action (a bound arrow's endpoint
 * following a moved/resized/rotated bindable). Each is a fully-formed
 * `LogOperation` in its own right; replaying them here keeps the
 * user-visible "one operation" while still reproducing the arrow's
 * dependent geometry. No-op when there are none, and each nested op
 * self-skips if its arrow isn't in the snapshot.
 */
const applyConsequentOps = (
  op: Extract<
    LogOperation,
    | { kind: "move" }
    | { kind: "resize" }
    | { kind: "rotate" }
    | { kind: "move-group" }
    | { kind: "resize-group" }
    | { kind: "rotate-group" }
  >,
  scene: SceneSnapshot,
  direction: ApplyDirection,
): void => {
  if (!op.consequentOps || op.consequentOps.length === 0) {
    return;
  }
  // The consequences are themselves fully-formed ops (classified from
  // the same moment's arrow entries — typically `arrow-edit-points`
  // / `move`). Replay them through the shared engine so they invert
  // correctly for `backward` and never drift from the arrow handlers.
  //
  // Except a bound arrow's reshape, which recorded absolute points:
  // `followBindings` derives those from where the element now is. A
  // `move` stays — the arrow translating whole is a delta, and it is what
  // carries the midpoints of an arrow whose two ends both moved.
  //
  // Applied without a follow pass of their own: their ids are part of the
  // parent's, so the pass after the parent covers them.
  const replayed = op.consequentOps.filter(
    (c) =>
      c.consequenceReason?.kind !== "binding" ||
      c.kind === "move" ||
      getOperationElementIds(c).some((id) => isElbowArrow(scene.get(id))),
  );
  for (const c of direction === "backward" ? replayed.reverse() : replayed) {
    applyOpToScene(c, scene, direction);
  }
};

const applyOpToScene = (
  op: LogOperation,
  scene: SceneSnapshot,
  direction: ApplyDirection,
): void => {
  const forward = direction === "forward";
  const sign = forward ? 1 : -1;

  switch (op.kind) {
    // -------------------- lifecycle --------------------
    case "create": {
      // Forward: insert / un-soft-delete. 
      // Backward: hide via soft-delete.
      if (forward) {
        upsertElement(scene, op.elementId, {
          ...(op.values as Partial<OrderedExcalidrawElement>),
          isDeleted: false,
        });
      } else {
        updateElement(scene, op.elementId, { isDeleted: true });
      }
      break;
    }
    case "delete": {
      // Forward: soft-delete. 
      // Backward: restore from lastValues using upsertElement
      if (forward) {
        updateElement(scene, op.elementId, { isDeleted: true });
      } else {
        upsertElement(scene, op.elementId, {
          ...(op.lastValues as Partial<OrderedExcalidrawElement>),
          isDeleted: false,
        });
      }
      break;
    }

    // -------------------- translation --------------------
    case "move": {
      const el = scene.get(op.elementId);
      if (el) {
        updateElement(scene, op.elementId, {
          x: el.x + sign * op.dx,
          y: el.y + sign * op.dy,
        });
      }
      applyConsequentOps(op, scene, direction);
      break;
    }
    case "move-group": {
      for (const id of op.elementIds) {
        const el = scene.get(id);
        if (!el) {
          continue;
        }
        updateElement(scene, id, {
          x: el.x + sign * op.dx,
          y: el.y + sign * op.dy,
        });
      }
      applyConsequentOps(op, scene, direction);
      break;
    }

    // -------------------- rotation --------------------
    case "rotate":
    case "arrow-rotate": {
      const angle = (forward ? op.to : op.from) as Radians;
      updateElement(scene, op.elementId, { angle });
      if (op.kind === "rotate") {
        applyConsequentOps(op, scene, direction);
      }
      break;
    }
    case "rotate-group": {
      // In addition to rotating each member by `op.angle`, also 
      // rotate each member's center around `op.center` by `op.angle`
      const angle = sign * op.angle;
      const [cx, cy] = op.center ?? [0, 0];
      for (const id of op.elementIds) {
        const el = scene.get(id);
        if (!el) {
          continue;
        }
        const elcx = el.x + el.width / 2;
        const elcy = el.y + el.height / 2;
        const [newCx, newCy] = rotateAround(elcx, elcy, cx, cy, angle);
        updateElement(scene, id, {
          x: newCx - el.width / 2,
          y: newCy - el.height / 2,
          angle: (el.angle + angle) as Radians,
        });
      }
      applyConsequentOps(op, scene, direction);
      break;
    }

    // -------------------- resize --------------------
    case "resize":
    case "arrow-resize": {
      const el = scene.get(op.elementId);
      // Scaled by the same matrix that places it, a stand-in's edges land
      // wherever that matrix sends them, so any edge it shares with a
      // partner stays shared. Taking the recorded size would not.
      const dims =
        el && op.kind === "resize" && op.onStandIn
          ? {
              width: el.width * (forward ? op.scaleX : 1 / op.scaleX),
              height: el.height * (forward ? op.scaleY : 1 / op.scaleY),
            }
          : forward
          ? op.to
          : op.from;
      if (el) {
        let position: { x: number; y: number };
        let points: { points: [number, number][] } | undefined;
        if (op.kind === "arrow-resize") {
          // An arrow's `x`/`y` is its points' origin, not the corner of
          // its box, so it's mapped as a point rather than placed from
          // the box's centre.
          const m = directedTransform(op.transform, forward);
          const [x, y] = m
            ? applyMatrixToPoint(m, [el.x, el.y])
            : [el.x, el.y];
          position = { x, y };
          // The points are the shape and width / height only their
          // extent, so they scale by as much as the extent changes —
          // about the origin, which is where the matrix just put it.
          // Measured off the element rather than the op's factors, so a
          // stand-in of another size ends up consistent too.
          if ("points" in el) {
            const sx = el.width === 0 ? 1 : dims.width / el.width;
            const sy = el.height === 0 ? 1 : dims.height / el.height;
            points = {
              points: el.points.map(([px, py]) => [px * sx, py * sy]),
            };
          }
        } else {
          position = resizedPosition(
            el,
            op.transform,
            forward,
            dims.width,
            dims.height,
          );
        }
        updateElement(scene, op.elementId, {
          ...position,
          ...points,
          width: dims.width,
          height: dims.height,
        } as Partial<OrderedExcalidrawElement>);
      }
      if (op.kind === "resize") {
        applyConsequentOps(op, scene, direction);
      }
      break;
    }
    case "resize-group": {
      const sx = forward ? op.scaleX : 1 / op.scaleX;
      const sy = forward ? op.scaleY : 1 / op.scaleY;
      for (const id of op.elementIds) {
        const el = scene.get(id);
        if (!el) {
          continue;
        }
        const width = el.width * sx;
        const height = el.height * sy;
        updateElement(scene, id, {
          ...resizedPosition(el, op.transform, forward, width, height),
          width,
          height,
        });
      }
      applyConsequentOps(op, scene, direction);
      break;
    }

    // -------------------- style --------------------
    case "restyle": {
      const updates: Record<string, unknown> = {};
      for (const change of op.changes) {
        updates[change.property] = forward ? change.to : change.from;
      }
      updateElement(
        scene,
        op.elementId,
        updates as Partial<OrderedExcalidrawElement>,
      );
      break;
    }

    // -------------------- arrow-specific --------------------
    case "arrow-edit-points": {
      const el = scene.get(op.elementId);
      if (el) {
        updateElement(
          scene,
          op.elementId,
          arrowGeometryUpdates(el, op, forward),
        );
      }
      break;
    }
    case "arrow-bind":
    case "arrow-move-binding": {
      const el = scene.get(op.elementId);
      if (!el) {
        break;
      }
      // Binding and geometry in one write: the endpoint is where the
      // binding says it is on either side.
      const updates: Record<string, unknown> = op.geometry
        ? arrowGeometryUpdates(el, op.geometry, forward)
        : {};
      if (op.start) {
        updates.startBinding = forward ? op.start.after : op.start.before;
      }
      if (op.end) {
        updates.endBinding = forward ? op.end.after : op.end.before;
      }
      updateElement(
        scene,
        op.elementId,
        updates as Partial<OrderedExcalidrawElement>,
      );
      break;
    }

    // -------------------- grouping --------------------
    //
    // You can create or remove a group.
    //
    // Creating a group with a given groupId, parentGroupId, and elements means adding the groupId
    // into every given elements's array `groupIds` at the position just inner to `parentGroupId`;
    //
    // Removing a group with groupId is to remove the groupId from the `groupIds` array from each element that
    // contains the groupId in its groupIds array.
    //
    case "group":
    case "ungroup": {
      const create =
        (op.kind === "group" && forward) ||
        (op.kind === "ungroup" && !forward);
      const gid = op.group.id;
      const affectedIds = collectElementIdsFromGroupNode(op.group);

      for (const id of affectedIds) {
        const el = scene.get(id);
        if (!el) {
          continue;
        }
        if (create) {
          if (el.groupIds.includes(gid)) {
            continue;
          }
          // Position: just inner to `parentGroupId` (which lands the
          // gid exactly where it sat in the original tree). If there
          // is no parent, the gid goes at the outermost end. If the
          // expected parent isn't actually present (scene drifted),
          // fall back to outermost-end so we don't crash.
          let position: number;
          if (op.parentGroupId == null) {
            position = el.groupIds.length;
          } else {
            const parentIdx = el.groupIds.indexOf(op.parentGroupId);
            position =
              parentIdx >= 0 ? parentIdx : el.groupIds.length;
          }
          const next = [
            ...el.groupIds.slice(0, position),
            gid,
            ...el.groupIds.slice(position),
          ];
          updateElement(scene, id, { groupIds: next });
        } else {
          updateElement(scene, id, {
            groupIds: el.groupIds.filter((g) => g !== gid),
          });
        }
      }
      break;
    }

    // -------------------- hard alignment --------------------
    case "alignment": {
      // Applied as the change it made — the links it added, the links it
      // removed — to each member's *current* field. The recorded fields
      // are snapshots of every link a member had at the time: written
      // back whole, they would restore a link whose Moment is skipped,
      // and on a stand-in replace its own links with the missing
      // element's. Missing members are no-ops.
      const from = (forward ? op.before : op.after) as LinkMap;
      const to = (forward ? op.after : op.before) as LinkMap;
      for (const id of op.elementIds) {
        const el = scene.get(id);
        if (!el) {
          continue;
        }
        const next = applyLinkDiff(
          (el[op.field] ?? []) as readonly Link[],
          from[id] ?? [],
          to[id] ?? [],
        );
        if (next) {
          updateElement(scene, id, {
            [op.field]: next,
          } as Partial<OrderedExcalidrawElement>);
        }
      }
      break;
    }

    case "alignment-anchor": {
      updateElement(scene, op.elementId, {
        alignmentLocked: forward ? op.anchored : !op.anchored,
      } as Partial<OrderedExcalidrawElement>);
      break;
    }

    // -------------------- stacking order --------------------
    //
    // Writes the key only. The snapshot's own order is left alone; the
    // replay sorts by `index` once it has applied everything.
    case "reorder": {
      const indices = forward ? op.to : op.from;
      for (const id of op.elementIds) {
        updateElement(scene, id, {
          index: indices[id],
        } as Partial<OrderedExcalidrawElement>);
      }
      break;
    }

    // -------------------- raw fallback --------------------
    case "raw": {
      // For unclassified entries we have the original before/after
      // property maps — apply them directly. This is the safety net
      // for any op we couldn't classify into a semantic kind.
      const entry = op.entry;
      const values = forward ? entry.after : entry.before;
      if (entry.type === "create") {
        // Same upsert reasoning as the semantic `create` op.
        if (forward) {
          upsertElement(scene, entry.elementId, {
            ...(values as Partial<OrderedExcalidrawElement>),
            isDeleted: false,
          });
        } else {
          updateElement(scene, entry.elementId, { isDeleted: true });
        }
      } else if (entry.type === "delete") {
        if (forward) {
          updateElement(scene, entry.elementId, { isDeleted: true });
        } else {
          upsertElement(scene, entry.elementId, {
            ...(values as Partial<OrderedExcalidrawElement>),
            isDeleted: false,
          });
        }
      } else {
        updateElement(
          scene,
          entry.elementId,
          values as Partial<OrderedExcalidrawElement>,
        );
      }
      break;
    }
  }
};
