/**
 * Replay the active subset of the log to produce a fresh scene
 * snapshot. The selective-undo entry point.
 *
 * Algorithm:
 *
 *   1. Clone the baseline scene captured at the moment the first
 *      increment was ingested.
 *   2. Walk increments oldest-first, up to AND INCLUDING the cursor.
 *      Skip any whose id is in the inactive set entirely.
 *   3. For each remaining increment, walk its ops in chronological
 *      order. Before applying each op, check whether its referenced
 *      element(s) and group(s) actually exist (and aren't tombstoned).
 *      If any referent is missing, record the op as skipped instead
 *      of applying it — that's a hard conflict caused by an earlier
 *      op having been deactivated.
 *   4. Return the resulting snapshot + the conflict set.
 *
 * The caller (App) hands the snapshot to `updateScene` with
 * `captureUpdate: NEVER` and stores the conflict set on the log for
 * UI consumption.
 */

import { applyOpsToScene } from "./applyOps";
import { collectElementIdsFromGroupNode } from "./types";

import type { SceneSnapshot } from "./applyOps";
import type { LogIncrement, LogOperation } from "./types";
import type { VersionLog } from "./VersionLog";

export interface ReplayResult {
  snapshot: SceneSnapshot;
  /** Ops that couldn't apply because a referent was missing. */
  skipped: Set<LogOperation>;
}

export const replayActiveOps = (log: VersionLog): ReplayResult | null => {
  const baseline = log.getBaselineScene();
  if (baseline == null) {
    return null;
  }

  // Deep-enough clone: a fresh Map is sufficient because `applyOps`
  // never mutates element objects in place — it replaces map entries
  // with `{ ...el, ...updates }`.
  const snapshot: SceneSnapshot = new Map(baseline) as unknown as SceneSnapshot;

  const increments = log.getIncrements();
  const inactive = log.getInactiveIncrementIds();

  // Cursor index. If unset, treat as head (newest = index 0). Empty
  // log was handled by the baseline === null guard above.
  const cursorId = log.getCurrentIncrementId();
  const cursorIdx =
    cursorId == null
      ? 0
      : increments.findIndex((inc) => inc.id === cursorId);
  if (cursorIdx < 0) {
    return null;
  }

  const skipped = new Set<LogOperation>();

  // Walk oldest-first (high array index → low). Stop after applying
  // the cursor's increment.
  for (let i = increments.length - 1; i >= cursorIdx; i--) {
    const inc = increments[i];
    if (inactive.has(inc.id)) {
      // Increment is deactivated wholesale; nothing to apply, no
      // conflicts to record at this level — its ops simply didn't
      // happen.
      continue;
    }
    applyIncrementTracked(inc, snapshot, skipped);
  }

  return { snapshot, skipped };
};

// ---------------------------------------------------------------------

/**
 * Apply one increment's ops in chronological order, recording any
 * that couldn't fire because a referent was missing.
 */
const applyIncrementTracked = (
  inc: LogIncrement,
  snapshot: SceneSnapshot,
  skipped: Set<LogOperation>,
): void => {
  for (const op of inc.operations) {
    if (hasMissingReferent(op, snapshot)) {
      skipped.add(op);
      continue;
    }
    // `applyOpsToScene` reverses ops for "backward" but applies in
    // order for "forward"; single-op call is the same either way.
    applyOpsToScene([op], snapshot, "forward");
  }
};

/**
 * True iff the op would be a no-op or incorrect because something it
 * references isn't currently in the scene. `create` is exempted — it
 * doesn't require its target to pre-exist.
 */
const hasMissingReferent = (
  op: LogOperation,
  snapshot: SceneSnapshot,
): boolean => {
  const isLive = (id: string): boolean => {
    const el = snapshot.get(id);
    return el != null && !el.isDeleted;
  };

  switch (op.kind) {
    case "create":
      // No precondition — create either inserts or restores.
      return false;
    case "delete":
    case "move":
    case "rotate":
    case "arrow-rotate":
    case "resize":
    case "arrow-resize":
    case "arrow-edit-points":
    case "arrow-bind":
    case "arrow-move-binding":
    case "restyle":
      return !isLive(op.elementId);
    case "move-group":
    case "rotate-group":
    case "resize-group":
      // The group itself must still exist — at least one captured
      // member must currently bear this group id. If none do, the
      // `group` op that established this group has been deactivated
      // and the transform has no group to act on (e.g. the user
      // skipped the grouping; moving the now-loose elements together
      // wasn't the intent of the move-group op).
      //
      // We don't separately require every member element to be alive
      // — `applyOpsToScene` silently no-ops on missing element ids,
      // so partial members are handled naturally.
      return !op.elementIds.some((id) => {
        const el = snapshot.get(id);
        return el != null && !el.isDeleted && el.groupIds.includes(op.groupId);
      });
    case "group": {
      // Creating a new group: the gid is being introduced, so we
      // only care that there's something to group. Hard conflict
      // only if NO captured member still exists.
      const ids = collectElementIdsFromGroupNode(op.group);
      return !ids.some((id) => isLive(id));
    }
    case "ungroup": {
      // Dissolving an existing group: at least one captured member
      // must still bear this group id. Otherwise the `group` op
      // that established it has been deactivated and there's
      // nothing to dissolve.
      const ids = collectElementIdsFromGroupNode(op.group);
      return !ids.some((id) => {
        const el = snapshot.get(id);
        return (
          el != null && !el.isDeleted && el.groupIds.includes(op.group.id)
        );
      });
    }
    case "raw":
      return !isLive(op.entry.elementId);
  }
};
