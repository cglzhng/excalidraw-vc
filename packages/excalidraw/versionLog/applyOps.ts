/**
 * Apply a sequence of `LogOperation`s to a scene snapshot, in either
 * direction. Used by `App.jumpToVersionLogIncrement` so that jumps no
 * longer depend on the raw `StoreDelta` retained on each `LogIncrement`
 * — every change is reconstructed from the semantic op data.
 *
 * Direction:
 *   - "forward":  apply each op as it was originally — moves x/y by
 *                 +(dx, dy), sets angle to `op.to`, etc.
 *   - "backward": invert each op — moves x/y by -(dx, dy), sets angle
 *                 to `op.from`, etc.
 *
 * The caller is responsible for walking the right increments in the
 * right outer order. Inside this module:
 *   - `applyOpsToScene` walks the ops array, reversing its order for
 *     backward direction (so ops are undone in reverse-chronological
 *     sequence within an increment).
 *   - `applyOpToScene` switches on `op.kind`.
 *
 * Known approximations (acceptable for iteration 2; revisit if they
 * cause visible round-trip drift):
 *
 *   - `arrow-bind` / `arrow-move-binding` restore the binding payload
 *     but leave the derived `points` / `x` / `y` / `width` / `height`
 *     in whatever state the scene was in when the op fires. The
 *     original binding event would have shifted the endpoint and
 *     recomputed the bbox; we don't have that data on the op.
 *   - Group transforms (`rotate-group`, `resize-group`) accumulate
 *     float drift across repeated round-trips.
 */

import type { OrderedExcalidrawElement } from "@excalidraw/element/types";
import type { Radians } from "@excalidraw/math";

import { collectElementIdsFromGroupNode } from "./types";

import type { LogOperation } from "./types";

/**
 * Mutable scene snapshot used during op application. Keyed by element
 * id; values are the element objects (treated as immutable — we
 * replace via `scene.set(id, { ...el, …updates })`).
 */
export type SceneSnapshot = Map<string, OrderedExcalidrawElement>;

export type ApplyDirection = "forward" | "backward";

/**
 * Apply every op in `ops` to `scene` in the given direction. For
 * backward direction the iteration order is reversed so each op's
 * inverse runs in the right sequence within an increment.
 *
 * Mutates `scene` in place — pass in a cloned `Map` if the caller
 * needs to retain the original.
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
 * Replace the element at `id` with the result of merging `updates` on
 * top of the existing object. Treats elements as immutable — if there's
 * no existing element, the call is a no-op (we don't fabricate ids).
 *
 * Always increments `version`. Excalidraw's store uses a strict
 * `prev.version < next.version` check in `detectChangedElements` to
 * decide whether to refresh its snapshot for a given element. Without
 * a bump, our jump produces elements with the SAME version the scene
 * already has, the store concludes "nothing changed", and the
 * snapshot drifts out of sync with the canvas. The next real edit
 * then computes its delta against that stale snapshot and surfaces
 * "phantom" reverts of whatever the jump undid.
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
 * Recompute the bounding box (x, y, width, height) from a `points`
 * array. Excalidraw stores `points` in element-local coordinates
 * starting at `[0, 0]`, with the element's world position carried by
 * `x` and `y`. When points change we have to shift both the world
 * anchor and the bbox dimensions.
 *
 * Returns the deltas relative to a starting `(x, y)` of the element.
 */
const bboxFromPoints = (
  points: ReadonlyArray<readonly [number, number]>,
): { width: number; height: number; offsetX: number; offsetY: number } => {
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
    // The element's world (x, y) corresponds to the local origin; if
    // the local origin shifts within the bbox, x and y need to shift
    // by the negative amount to keep the same world position.
    offsetX: minX,
    offsetY: minY,
  };
};

/**
 * Rotate point `(px, py)` around pivot `(cx, cy)` by `angle` radians,
 * counter-clockwise.
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
      // Forward: element exists (post-create). Backward: hide it via
      // soft-delete. Excalidraw never removes elements from the
      // SceneElementsMap; deletion is `isDeleted: true`.
      if (forward) {
        updateElement(scene, op.elementId, {
          ...(op.values as Partial<OrderedExcalidrawElement>),
          isDeleted: false,
        });
      } else {
        updateElement(scene, op.elementId, { isDeleted: true });
      }
      break;
    }
    case "delete": {
      if (forward) {
        updateElement(scene, op.elementId, { isDeleted: true });
      } else {
        updateElement(scene, op.elementId, {
          ...(op.lastValues as Partial<OrderedExcalidrawElement>),
          isDeleted: false,
        });
      }
      break;
    }

    // -------------------- translation --------------------
    case "move": {
      const el = scene.get(op.elementId);
      if (!el) {
        break;
      }
      updateElement(scene, op.elementId, {
        x: el.x + sign * op.dx,
        y: el.y + sign * op.dy,
      });
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
      break;
    }

    // -------------------- rotation --------------------
    case "rotate":
    case "arrow-rotate": {
      const angle = (forward ? op.to : op.from) as Radians;
      updateElement(scene, op.elementId, { angle });
      break;
    }
    case "rotate-group": {
      // Rotate each member's center around `op.center` by `±op.angle`,
      // and bump its own `angle` by the same delta.
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
      break;
    }

    // -------------------- resize --------------------
    case "resize":
    case "arrow-resize": {
      const dims = forward ? op.to : op.from;
      const el = scene.get(op.elementId);
      if (!el) {
        break;
      }
      // If we have a resize center, scale the element's (x, y) around
      // it. This preserves the anchor corner during a corner drag.
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
      const el = scene.get(op.elementId);
      if (!el) {
        break;
      }
      const { width, height, offsetX, offsetY } = bboxFromPoints(points);
      // Local origin of `points` is shifted by (offsetX, offsetY) from
      // the bbox origin. Excalidraw normalizes so the first point is
      // `[0, 0]` and the world position is in (x, y) — we re-apply
      // that here.
      updateElement(scene, op.elementId, {
        points: points.map(
          ([px, py]) => [px - offsetX, py - offsetY] as [number, number],
        ),
        x: el.x + offsetX,
        y: el.y + offsetY,
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
    // Both `group` and `ungroup` reduce to two canonical actions:
    //
    //   "install" the group's id into every affected element's
    //   `groupIds` at the position just inner to `parentGroupId`;
    //
    //   "uninstall" the gid by filtering it out.
    //
    // Direction picks which: forward-of-group = install,
    // backward-of-group = uninstall; ungroup is the opposite.
    case "group":
    case "ungroup": {
      const install =
        (op.kind === "group" && forward) ||
        (op.kind === "ungroup" && !forward);
      const gid = op.group.id;
      const affectedIds = collectElementIdsFromGroupNode(op.group);

      for (const id of affectedIds) {
        const el = scene.get(id);
        if (!el) {
          continue;
        }
        if (install) {
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

    // -------------------- raw fallback --------------------
    case "raw": {
      // For unclassified entries we have the original before/after
      // property maps — apply them directly. This is the safety net
      // for any op we couldn't classify into a semantic kind.
      const entry = op.entry;
      const values = forward ? entry.after : entry.before;
      if (entry.type === "create") {
        // Forward of a create entry sets isDeleted: false + values;
        // backward marks deleted. Mirrors the `create` op above.
        if (forward) {
          updateElement(scene, entry.elementId, {
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
          updateElement(scene, entry.elementId, {
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
