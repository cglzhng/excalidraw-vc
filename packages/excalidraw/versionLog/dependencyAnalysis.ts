/**
 * Walk the log backwards from a given op to find every earlier op
 * that op depends on. Used by the version-log sidebar's debug-only
 * dependency-highlight feature, and (later) by selective undo to
 * pre-warn the user about ops that would break.
 *
 * Two kinds of dependency:
 *
 *   - **hard**: removing the earlier op would make the later op
 *     impossible to apply (its referent element / group wouldn't
 *     exist).
 *   - **soft**: the later op carries a `from` snapshot whose value
 *     was established by the earlier op. Removing the earlier op
 *     means the later op applies onto a different baseline — the
 *     visual end state may differ from the original.
 *
 * The walk maintains three "remaining" sets — element ids, group ids,
 * and `(elementId, property)` pairs we haven't found a writer for yet
 * — and short-circuits when all three are empty.
 */

import {
  collectElementIdsFromGroupNode,
  getOperationElementIds,
} from "./types";

import type { GroupNode, LogOperation } from "./types";

import type { VersionLog } from "./VersionLog";

export interface DependencyResult {
  hard: Set<LogOperation>;
  soft: Set<LogOperation>;
}

export const findDependencies = (
  op: LogOperation,
  log: VersionLog,
): DependencyResult => {
  const hard = new Set<LogOperation>();
  const soft = new Set<LogOperation>();

  const remainingElementIds = new Set(getReferencedElementIds(op));
  const remainingGroupIds = new Set(getReferencedGroupIds(op));
  const remainingReads = new Set(
    getReadProperties(op).map(propKey),
  );

  // `op` doesn't depend on itself; skip in the iteration.
  for (const earlier of iterateBackwardFromOp(op, log)) {
    // Hard: element creation
    if (
      earlier.kind === "create" &&
      remainingElementIds.has(earlier.elementId)
    ) {
      hard.add(earlier);
      remainingElementIds.delete(earlier.elementId);
    }

    // Hard: group creation
    if (
      earlier.kind === "group" &&
      remainingGroupIds.has(earlier.group.id)
    ) {
      hard.add(earlier);
      remainingGroupIds.delete(earlier.group.id);
    }

    // Soft: someone wrote a property our op reads
    if (remainingReads.size > 0) {
      const writes = getWrittenProperties(earlier);
      for (const w of writes) {
        const k = propKey(w);
        if (remainingReads.has(k)) {
          soft.add(earlier);
          remainingReads.delete(k);
        }
      }
    }

    if (
      remainingElementIds.size === 0 &&
      remainingGroupIds.size === 0 &&
      remainingReads.size === 0
    ) {
      break;
    }
  }

  return { hard, soft };
};

// ---------------------------------------------------------------------

const propKey = ({
  elementId,
  property,
}: {
  elementId: string;
  property: string;
}) => `${elementId}::${property}`;

/**
 * Iterate every op in the log in reverse-chronological order
 * starting from just before `targetOp`. Yields nothing if the op
 * isn't found in the log.
 */
function* iterateBackwardFromOp(
  targetOp: LogOperation,
  log: VersionLog,
): Generator<LogOperation> {
  const increments = log.getIncrements();

  let foundIncIdx = -1;
  let foundOpIdx = -1;
  for (let i = 0; i < increments.length; i++) {
    const idx = increments[i].operations.indexOf(targetOp);
    if (idx >= 0) {
      foundIncIdx = i;
      foundOpIdx = idx;
      break;
    }
  }
  if (foundIncIdx < 0) {
    return;
  }

  // Earlier ops within the same increment (chronologically before
  // targetOp). Within an increment, op[0] is the earliest, so we
  // iterate `foundOpIdx - 1` down to `0`.
  const sameIncOps = increments[foundIncIdx].operations;
  for (let j = foundOpIdx - 1; j >= 0; j--) {
    yield sameIncOps[j];
  }

  // Older increments. In the newest-first array these have HIGHER
  // index. Within each, the last op is the most recent — iterate in
  // reverse.
  for (let i = foundIncIdx + 1; i < increments.length; i++) {
    const ops = increments[i].operations;
    for (let j = ops.length - 1; j >= 0; j--) {
      yield ops[j];
    }
  }
}

// ---------------------------------------------------------------------

const getReferencedElementIds = (op: LogOperation): string[] => {
  // Every op needs its target element(s) to exist. `getOperationElementIds`
  // already enumerates them per kind (including the recursive walk
  // through group ops).
  const ids = [...getOperationElementIds(op)];

  // Arrow binding ops also reference the BOUND-TO element on each side
  // — the rectangle/ellipse/etc. the arrow is anchored against. Those
  // ids aren't picked up by `getOperationElementIds` (which is the
  // hover-highlight enumerator and intentionally lists only the op's
  // primary subject), but for dependency purposes they very much are
  // referenced: the create op for the bound-to element is a hard dep
  // of the bind, so deactivating it would leave the arrow pointing at
  // a corpse.
  //
  // We include both `before` and `after` sides: `after` is the side
  // the forward apply needs; `before` is the side the inverse needs
  // (and matters for unbind, where after is null). Duplicates are
  // fine — the caller wraps the list in a Set.
  if (op.kind === "arrow-bind") {
    if (op.start?.after) {
      ids.push(op.start.after.elementId);
    }
    if (op.start?.before) {
      ids.push(op.start.before.elementId);
    }
    if (op.end?.after) {
      ids.push(op.end.after.elementId);
    }
    if (op.end?.before) {
      ids.push(op.end.before.elementId);
    }
  } else if (op.kind === "arrow-move-binding") {
    // Anchor moves keep the same bound-to element on each side; one
    // entry per side is enough.
    if (op.start) {
      ids.push(op.start.boundElementId);
    }
    if (op.end) {
      ids.push(op.end.boundElementId);
    }
  }

  return ids;
};

/**
 * Group ids the op references and which must exist for the op to
 * apply correctly. NOT the group ids the op CREATES (those wouldn't
 * be dependencies).
 */
const getReferencedGroupIds = (op: LogOperation): string[] => {
  switch (op.kind) {
    case "move-group":
    case "rotate-group":
    case "resize-group":
      return [op.groupId];
    case "ungroup":
      // The group being dissolved must exist.
      return [op.group.id];
    case "group": {
      // The new group's id is being CREATED, not referenced. But the
      // parent (if any) is referenced, and any sub-groups nested
      // inside the new group are existing groups being re-parented.
      const ids: string[] = [];
      if (op.parentGroupId != null) {
        ids.push(op.parentGroupId);
      }
      ids.push(...collectSubGroupIds(op.group));
      return ids;
    }
    default:
      return [];
  }
};

const collectSubGroupIds = (node: GroupNode): string[] => {
  const ids: string[] = [];
  const walk = (n: GroupNode) => {
    for (const child of n.children) {
      if (child.kind === "group") {
        ids.push(child.node.id);
        walk(child.node);
      }
    }
  };
  walk(node);
  return ids;
};

/**
 * Properties the op consumes via a recorded `from` / `before`
 * snapshot. These are the soft-dep probes: the op expects each
 * property to already be at the snapshotted value.
 */
const getReadProperties = (
  op: LogOperation,
): Array<{ elementId: string; property: string }> => {
  switch (op.kind) {
    case "move":
      // `from` is the absolute pre-move position; depends on whoever
      // last wrote x / y.
      return [
        { elementId: op.elementId, property: "x" },
        { elementId: op.elementId, property: "y" },
      ];
    case "move-group":
      // Per-member from-positions; each member's x / y is a soft-dep
      // probe.
      return op.elementIds.flatMap((id) => [
        { elementId: id, property: "x" },
        { elementId: id, property: "y" },
      ]);
    case "rotate":
    case "arrow-rotate":
      return [{ elementId: op.elementId, property: "angle" }];
    case "resize":
    case "arrow-resize":
      return [
        { elementId: op.elementId, property: "width" },
        { elementId: op.elementId, property: "height" },
      ];
    case "restyle":
      return [{ elementId: op.elementId, property: op.property }];
    case "arrow-edit-points":
      return [{ elementId: op.elementId, property: "points" }];
    case "delete":
      // `lastValues` is a captured before-state but isn't used as a
      // precondition by `applyOps` — delete just needs the element
      // to exist. Skip.
      return [];
    // The remaining ops either have no `from` snapshot (rotate-group
    // / resize-group don't carry per-member snapshots yet),
    // have a derived snapshot we skip (arrow-bind, arrow-move-binding),
    // or are the fallback path (raw).
    default:
      return [];
  }
};

/**
 * Properties the op writes. Used to match against later ops'
 * `from`-snapshots so we can identify "who put this property in the
 * state the later op expected."
 *
 * Conservative — we include every property that may have been
 * mutated by the op's apply path. A few notes on edge cases:
 *
 *   - `create` writes every property of the new element; we proxy
 *     that by listing the keys of `op.values`.
 *   - `move`-family writes x, y. `rotate`-family writes angle.
 *     Resize-family writes x, y, width, height. Group-transforms
 *     also touch x, y on every member.
 *   - `arrow-edit-points` rewrites points + derived bbox.
 *   - `group` / `ungroup` mutate `groupIds` on members.
 *   - `raw` falls back to whatever was in the entry's `after` map.
 */
const getWrittenProperties = (
  op: LogOperation,
): Array<{ elementId: string; property: string }> => {
  switch (op.kind) {
    case "create": {
      const props: Array<{ elementId: string; property: string }> = [];
      for (const key of Object.keys(op.values)) {
        props.push({ elementId: op.elementId, property: key });
      }
      return props;
    }
    case "delete":
      return [{ elementId: op.elementId, property: "isDeleted" }];
    case "move":
      return [
        { elementId: op.elementId, property: "x" },
        { elementId: op.elementId, property: "y" },
      ];
    case "move-group":
      return op.elementIds.flatMap((id) => [
        { elementId: id, property: "x" },
        { elementId: id, property: "y" },
      ]);
    case "rotate":
    case "arrow-rotate":
      return [{ elementId: op.elementId, property: "angle" }];
    case "rotate-group":
      return op.elementIds.flatMap((id) => [
        { elementId: id, property: "x" },
        { elementId: id, property: "y" },
        { elementId: id, property: "angle" },
      ]);
    case "resize":
    case "arrow-resize":
      return [
        { elementId: op.elementId, property: "x" },
        { elementId: op.elementId, property: "y" },
        { elementId: op.elementId, property: "width" },
        { elementId: op.elementId, property: "height" },
      ];
    case "resize-group":
      return op.elementIds.flatMap((id) => [
        { elementId: id, property: "x" },
        { elementId: id, property: "y" },
        { elementId: id, property: "width" },
        { elementId: id, property: "height" },
      ]);
    case "restyle":
      return [{ elementId: op.elementId, property: op.property }];
    case "arrow-edit-points":
      return [
        { elementId: op.elementId, property: "points" },
        { elementId: op.elementId, property: "x" },
        { elementId: op.elementId, property: "y" },
        { elementId: op.elementId, property: "width" },
        { elementId: op.elementId, property: "height" },
      ];
    case "arrow-bind": {
      const props: Array<{ elementId: string; property: string }> = [];
      if (op.start) {
        props.push({ elementId: op.elementId, property: "startBinding" });
      }
      if (op.end) {
        props.push({ elementId: op.elementId, property: "endBinding" });
      }
      return props;
    }
    case "arrow-move-binding": {
      const props: Array<{ elementId: string; property: string }> = [];
      if (op.start) {
        props.push({ elementId: op.elementId, property: "startBinding" });
      }
      if (op.end) {
        props.push({ elementId: op.elementId, property: "endBinding" });
      }
      return props;
    }
    case "group":
    case "ungroup":
      return collectElementIdsFromGroupNode(op.group).map((id) => ({
        elementId: id,
        property: "groupIds",
      }));
    case "raw": {
      const out: Array<{ elementId: string; property: string }> = [];
      for (const key of Object.keys(op.entry.after)) {
        out.push({ elementId: op.entry.elementId, property: key });
      }
      return out;
    }
  }
};
