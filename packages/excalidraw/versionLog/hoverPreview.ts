/**
 * Compute the data the interactive canvas needs to draw a "ghost"
 * preview of a `LogOperation` when the user hovers over it in the
 * version-log sidebar.
 *
 * Strategy: replay the log to land on the side of the hovered op
 * OPPOSITE to where the cursor currently is, then look the affected
 * element ids up in that snapshot.
 *
 *   - When the cursor is at or newer than the hovered op (backward
 *     replay), the live element is already at state(T). We replay
 *     backwards to state(T − 1) so the ghost shows the "before".
 *   - When the cursor is older than the hovered op (forward replay),
 *     the live element is at state(T − 1). We replay forward to
 *     state(T) so the ghost shows the "after".
 *
 * Either way the ghost is the side the live element ISN'T at, which
 * keeps them visually distinct and matches the user's mental model
 * of "preview the change this op represents."
 *
 *   - `ghosts`: full element objects from the opposite-side snapshot.
 *   - `bboxes`: one or more colored bounding boxes for `group` /
 *     `ungroup` ops. `group` emits a single bbox enclosing every
 *     member; `ungroup` emits one bbox per IMMEDIATE child (each
 *     child may itself be a sub-group, in which case the bbox spans
 *     all leaves under it).
 *
 * Ops skipped (no preview):
 *   - `restyle` (per the "ignore styles" decision)
 *   - `arrow-bind`, `arrow-move-binding`: applyOps' backward path
 *     restores the binding payload but leaves derived geometry
 *     stale, so the snapshot wouldn't show a faithful previous
 *     shape. TODO: enrich those ops with prev geometry.
 *   - `raw` (uninterpretable in general)
 */

import type { OrderedExcalidrawElement } from "@excalidraw/element/types";

import { applyOpsToScene } from "./applyOps";

import type { SceneSnapshot } from "./applyOps";

import { collectElementIdsFromGroupNode } from "./types";

import type { GroupChild, LogOperation } from "./types";

import type { VersionLog } from "./VersionLog";

export interface HoverPreview {
  ghosts: OrderedExcalidrawElement[];
  bboxes: { elementIds: string[] }[];
}

export const computeHoverPreview = (
  op: LogOperation,
  log: VersionLog,
  currentScene: SceneSnapshot,
): HoverPreview | null => {
  switch (op.kind) {
    // Skipped — no useful preview.
    case "restyle":
    case "arrow-bind":
    case "arrow-move-binding":
    case "raw":
      return null;

    // `create` always wants to show the created element. Two cases:
    //   - backward (cursor at/after the create): the element exists
    //     in the current scene; use it directly.
    //   - forward (cursor before the create): the element doesn't
    //     exist in the current scene yet, so we replay to state(T)
    //     via the opposite-side snapshot and look it up there.
    case "create": {
      const live = currentScene.get(op.elementId);
      if (live) {
        return { ghosts: [live], bboxes: [] };
      }
      const snapshot = buildOppositeSideSnapshot(op, log, currentScene);
      const created = snapshot?.get(op.elementId);
      return created ? { ghosts: [created], bboxes: [] } : null;
    }

    // Grouping ops don't change element geometry, so the ghost is a
    // bbox computed from the CURRENT scene (no snapshot needed). The
    // bbox renderer in `interactiveScene.ts` looks the ids up at draw
    // time, so we just hand it the id lists.
    case "group":
      return {
        ghosts: [],
        bboxes: [
          {
            elementIds: collectElementIdsFromGroupNode(op.group),
          },
        ],
      };
    case "ungroup":
      return {
        ghosts: [],
        bboxes: op.group.children.map((child) => ({
          elementIds: idsForChild(child),
        })),
      };

    // Everything else: replay to the opposite side and look the
    // element(s) up.
    case "delete":
    case "move":
    case "move-group":
    case "rotate":
    case "rotate-group":
    case "arrow-rotate":
    case "resize":
    case "resize-group":
    case "arrow-resize":
    case "arrow-edit-points": {
      const snapshot = buildOppositeSideSnapshot(op, log, currentScene);
      if (snapshot == null) {
        return null;
      }
      const ids = elementIdsForOp(op);
      const ghosts: OrderedExcalidrawElement[] = [];
      for (const id of ids) {
        const el = snapshot.get(id);
        if (el) {
          // For `delete` backward, the snapshot at T-1 has the
          // element un-deleted (the backward apply of `delete`
          // restored it). For `delete` forward, the snapshot at T
          // still has `isDeleted: true` — the interactive renderer
          // forces it to false at draw time so the ghost shows.
          ghosts.push(el);
        }
      }
      return { ghosts, bboxes: [] };
    }
  }
};

// ---------------------------------------------------------------------

const elementIdsForOp = (op: LogOperation): string[] => {
  switch (op.kind) {
    case "delete":
    case "move":
    case "rotate":
    case "arrow-rotate":
    case "resize":
    case "arrow-resize":
    case "arrow-edit-points":
      return [op.elementId];
    case "move-group":
    case "rotate-group":
    case "resize-group":
      return op.elementIds;
    default:
      return [];
  }
};

const idsForChild = (child: GroupChild): string[] => {
  if (child.kind === "element") {
    return [child.elementId];
  }
  return collectElementIdsFromGroupNode(child.node);
};

/**
 * Build a fresh scene snapshot reflecting the side of `op` OPPOSITE
 * to where the cursor currently is. Returns `null` if we can't
 * locate the op in the log.
 *
 *   - **cursor at or newer than op (backward replay)**: the live
 *     element is at state(T). Land the snapshot at state(T − 1) by
 *     undoing every op from the cursor up to AND INCLUDING the
 *     hovered op.
 *
 *   - **cursor older than op (forward replay)**: the live element
 *     is at state(T − 1). Land the snapshot at state(T) by applying
 *     ops chronologically forward from the cursor up to AND
 *     INCLUDING the hovered op.
 *
 * The caller doesn't have to know which direction the replay went —
 * it just looks the affected element ids up in the returned snapshot.
 */
const buildOppositeSideSnapshot = (
  op: LogOperation,
  log: VersionLog,
  currentScene: SceneSnapshot,
): SceneSnapshot | null => {
  const increments = log.getIncrements();

  // Locate the increment + position of the hovered op.
  let targetIncIdx = -1;
  let targetOpIdx = -1;
  for (let i = 0; i < increments.length; i++) {
    const idx = increments[i].operations.indexOf(op);
    if (idx >= 0) {
      targetIncIdx = i;
      targetOpIdx = idx;
      break;
    }
  }
  if (targetIncIdx < 0) {
    return null;
  }

  // Cursor index. `null` cursor (fresh log) is equivalent to head.
  const cursorId = log.getCurrentIncrementId();
  const cursorIdx =
    cursorId == null
      ? 0
      : increments.findIndex((inc) => inc.id === cursorId);
  if (cursorIdx < 0) {
    return null;
  }

  const snapshot: SceneSnapshot = new Map(currentScene);

  if (cursorIdx <= targetIncIdx) {
    // -------- backward replay --------
    //
    // Undo every full increment between cursor (inclusive) and the
    // hovered op's increment (exclusive). `applyOpsToScene` reverses
    // the ops within an increment internally when given direction
    // "backward".
    for (let i = cursorIdx; i < targetIncIdx; i++) {
      applyOpsToScene(increments[i].operations, snapshot, "backward");
    }

    // Within the hovered op's increment, undo ops from the end of the
    // increment down to AND INCLUDING the hovered op. The slice
    // covers [T, end); "backward" iterates it in reverse, landing the
    // snapshot at state-before-T.
    const targetOps = increments[targetIncIdx].operations.slice(targetOpIdx);
    applyOpsToScene(targetOps, snapshot, "backward");
  } else {
    // -------- forward replay --------
    //
    // Newest-first array: chronological "next" after `cursorIdx` is
    // `cursorIdx - 1`. Walk DOWN from `cursorIdx - 1` to
    // `targetIncIdx + 1`, applying each full increment forward.
    for (let i = cursorIdx - 1; i > targetIncIdx; i--) {
      applyOpsToScene(increments[i].operations, snapshot, "forward");
    }

    // Then within the target increment, apply ops chronologically up
    // to AND INCLUDING the hovered op. The slice covers [0, T + 1);
    // "forward" iterates it in original order, landing the snapshot
    // at state(T) — the "after" side, which the user wants because
    // the live element is currently at the "before" side.
    const targetOps = increments[targetIncIdx].operations.slice(
      0,
      targetOpIdx + 1,
    );
    applyOpsToScene(targetOps, snapshot, "forward");
  }

  return snapshot;
};
