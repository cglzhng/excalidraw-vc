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

import type { OrderedExcalidrawElement } from "@excalidraw/element/types";
import type { Radians } from "@excalidraw/math";

import { collectElementIdsFromGroupNode } from "./types";

import type { LogOperation } from "./types";

/**
 * Mutable scene snapshot used during op application. Keyed by element
 * id; values are the element objects (treated as immutable).
 */
export type SceneSnapshot = Map<string, OrderedExcalidrawElement>;

export type ApplyDirection = "forward" | "backward";

/**
 * Apply every op in `ops` to `scene` in the given direction.
 * Mutates `scene` in place.
 */
export const applyOpsToScene = (
  ops: readonly LogOperation[],
  scene: SceneSnapshot,
  direction: ApplyDirection,
): void => {
  const iter = direction === "backward" ? [...ops].reverse() : ops;
  for (const op of iter) {
    applyOpToScene(op, scene, direction);
  }
};

// ---------------------------------------------------------------------

/**
 * Replace the element at `id` with the result of merging it with the updated properties contained in `updates`. 
 * If there's no existing element, the call is a no-op.
 *
 * Always increment `version` because Excalidraw checks the version number
 * to decide when to update its internal snapshot. 
 */
const updateElement = (
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
  applyOpsToScene(op.consequentOps, scene, direction);
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
      const dims = forward ? op.to : op.from;
      const el = scene.get(op.elementId);
      if (el) {
        if (op.center) {
          const sx = forward ? op.scaleX : 1 / op.scaleX;
          const sy = forward ? op.scaleY : 1 / op.scaleY;
          updateElement(scene, op.elementId, {
            x: op.center[0] + (el.x - op.center[0]) * sx,
            y: op.center[1] + (el.y - op.center[1]) * sy,
            width: dims.width,
            height: dims.height,
          });
        } else {
          updateElement(scene, op.elementId, {
            width: dims.width,
            height: dims.height,
          });
        }
      }
      if (op.kind === "resize") {
        applyConsequentOps(op, scene, direction);
      }
      break;
    }
    case "resize-group": {
      const sx = forward ? op.scaleX : 1 / op.scaleX;
      const sy = forward ? op.scaleY : 1 / op.scaleY;
      const [cx, cy] = op.center ?? [0, 0];
      for (const id of op.elementIds) {
        const el = scene.get(id);
        if (!el) {
          continue;
        }
        updateElement(scene, id, {
          x: cx + (el.x - cx) * sx,
          y: cy + (el.y - cy) * sy,
          width: el.width * sx,
          height: el.height * sy,
        });
      }
      applyConsequentOps(op, scene, direction);
      break;
    }

    // -------------------- style --------------------
    case "restyle": {
      const value = forward ? op.to : op.from;
      updateElement(scene, op.elementId, {
        [op.property]: value,
      } as Partial<OrderedExcalidrawElement>);
      break;
    }

    // -------------------- arrow-specific --------------------
    case "arrow-edit-points": {
      const points = forward ? op.after : op.before;
      const origin = forward ? op.afterOrigin : op.beforeOrigin;
      const el = scene.get(op.elementId);
      if (!el) {
        break;
      }
      const { width, height } = bboxFromPoints(points);
      updateElement(scene, op.elementId, {
        points,
        x: origin ? origin[0] : el.x,
        y: origin ? origin[1] : el.y,
        width,
        height,
      } as Partial<OrderedExcalidrawElement>);
      break;
    }
    case "arrow-bind": {
      const updates: Partial<OrderedExcalidrawElement> = {};
      if (op.start) {
        (updates as { startBinding: unknown }).startBinding = forward
          ? op.start.after
          : op.start.before;
      }
      if (op.end) {
        (updates as { endBinding: unknown }).endBinding = forward
          ? op.end.after
          : op.end.before;
      }
      updateElement(scene, op.elementId, updates);
      break;
    }
    case "arrow-move-binding": {
      const updates: Partial<OrderedExcalidrawElement> = {};
      if (op.start) {
        (updates as { startBinding: unknown }).startBinding = forward
          ? op.start.after
          : op.start.before;
      }
      if (op.end) {
        (updates as { endBinding: unknown }).endBinding = forward
          ? op.end.after
          : op.end.before;
      }
      updateElement(scene, op.elementId, updates);
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
      // Forward: set each member's `alignments` to the after-state;
      // backward: to the before-state. Missing members are no-ops.
      const map = forward ? op.after : op.before;
      for (const id of op.elementIds) {
        updateElement(scene, id, {
          alignments: map[id],
        } as Partial<OrderedExcalidrawElement>);
      }
      break;
    }

    case "alignment-anchor": {
      updateElement(scene, op.elementId, {
        alignmentLocked: forward ? op.anchored : !op.anchored,
      } as Partial<OrderedExcalidrawElement>);
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
