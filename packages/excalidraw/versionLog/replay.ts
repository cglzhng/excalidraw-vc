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
 *      order. Apply user-supplied remaps; then before applying each
 *      op, check whether its (possibly-rewritten) referent actually
 *      exists. If any referent is missing, record the op as skipped
 *      AND emit a `PendingConflict` so the UI can let the user choose
 *      a resolution.
 *   4. Return the resulting snapshot + skipped set + conflicts.
 *
 * The caller (App) hands the snapshot to `updateScene` with
 * `captureUpdate: NEVER`, stores the skipped set on the log, and — if
 * `conflicts` is non-empty — opens the conflict-resolution modal
 * INSTEAD of committing the snapshot.
 */

import { applyOpsToScene } from "./applyOps";
import { applyRemapsToOp, getOpMissingReferent } from "./remap";
import { collectElementIdsFromGroupNode } from "./types";

import type { SceneSnapshot } from "./applyOps";
import type { LogIncrement, LogOperation, PendingConflict } from "./types";
import type { VersionLog } from "./VersionLog";

export interface ReplayResult {
  snapshot: SceneSnapshot;
  /** Ops that couldn't apply because a referent was missing. */
  skipped: Set<LogOperation>;
  /**
   * Unresolved hard conflicts, grouped by the missing referent.
   * Empty when every skipped op was explicitly resolved (via a remap
   * to `null`) or there were no missing referents in the first place.
   */
  conflicts: PendingConflict[];
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
  const remaps = log.getRemaps();

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
  // Conflicts are accumulated under their missing-referent id so
  // multiple ops referencing the same dead group/element collapse
  // into a single user decision.
  const conflictMap = new Map<string, PendingConflict>();

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
    applyIncrementTracked(inc, snapshot, remaps, skipped, conflictMap);
  }

  return { snapshot, skipped, conflicts: Array.from(conflictMap.values()) };
};

// ---------------------------------------------------------------------

const applyIncrementTracked = (
  inc: LogIncrement,
  snapshot: SceneSnapshot,
  remaps: ReadonlyMap<string, import("./types").Remap>,
  skipped: Set<LogOperation>,
  conflictMap: Map<string, PendingConflict>,
): void => {
  for (const op of inc.operations) {
    const remap = applyRemapsToOp(op, remaps);
    if (remap.status === "skip") {
      // User explicitly chose to skip everything that touched this
      // referent. Mark the (original) op for the panel's warning row
      // and move on — no conflict.
      skipped.add(op);
      continue;
    }

    const rewritten = remap.op;

    // For group-keyed transforms, the captured `elementIds` is the
    // ORIGINAL member set. After a group remap (G1 → G2) those ids
    // are stale — apply the transform to the live members of G2 in
    // the current snapshot instead.
    const finalOp = resolveLiveGroupMembers(rewritten, snapshot);

    if (hasMissingReferent(finalOp, snapshot)) {
      skipped.add(op);
      recordConflict(op, snapshot, conflictMap);
      continue;
    }
    // `applyOpsToScene` reverses ops for "backward" but applies in
    // order for "forward"; single-op call is the same either way.
    applyOpsToScene([finalOp], snapshot, "forward");
  }
};

/**
 * For group transforms whose `groupId` may have been remapped, swap
 * `elementIds` for the live members of the (possibly new) group in
 * the current snapshot. For all other ops, return as-is.
 */
const resolveLiveGroupMembers = (
  op: LogOperation,
  snapshot: SceneSnapshot,
): LogOperation => {
  if (
    op.kind !== "move-group" &&
    op.kind !== "rotate-group" &&
    op.kind !== "resize-group"
  ) {
    return op;
  }
  const liveMembers: string[] = [];
  for (const el of snapshot.values()) {
    if (!el.isDeleted && el.groupIds.includes(op.groupId)) {
      liveMembers.push(el.id);
    }
  }
  if (
    liveMembers.length === op.elementIds.length &&
    liveMembers.every((id, idx) => id === op.elementIds[idx])
  ) {
    return op;
  }
  return { ...op, elementIds: liveMembers };
};

const recordConflict = (
  op: LogOperation,
  snapshot: SceneSnapshot,
  conflictMap: Map<string, PendingConflict>,
): void => {
  const ref = getOpMissingReferent(op);
  if (ref == null) {
    // Op has no single referent (e.g. `group` create). Don't surface
    // it via the modal — `applyOpsToScene` will just no-op against
    // missing children.
    return;
  }
  const existing = conflictMap.get(ref.id);
  if (existing) {
    existing.affectedOps.push(op);
    return;
  }
  conflictMap.set(ref.id, {
    referentKind: ref.kind,
    referentId: ref.id,
    elementType: ref.elementType,
    affectedOps: [op],
    candidates: collectCandidates(ref.kind, ref.id, ref.elementType, snapshot),
  });
};

const collectCandidates = (
  kind: "element" | "group",
  missingId: string,
  elementType: string | undefined,
  snapshot: SceneSnapshot,
): string[] => {
  if (kind === "element") {
    const ids: string[] = [];
    for (const el of snapshot.values()) {
      if (el.isDeleted || el.id === missingId) {
        continue;
      }
      if (elementType && el.type !== elementType) {
        continue;
      }
      ids.push(el.id);
    }
    return ids;
  }
  // group: collect every unique gid currently borne by some live
  // element, minus the missing one.
  const gids = new Set<string>();
  for (const el of snapshot.values()) {
    if (el.isDeleted) {
      continue;
    }
    for (const gid of el.groupIds) {
      if (gid !== missingId) {
        gids.add(gid);
      }
    }
  }
  return Array.from(gids);
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
