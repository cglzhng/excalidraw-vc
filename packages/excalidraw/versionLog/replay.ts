/**
 * Replay the active subset of the log to produce a fresh scene snapshot. 
 * Entry point for selective undo.
 * 
 * Algorithm:
 *
 *   1. Clone the baseline scene captured just before the first
 *      moment was ingested.
 *   2. Walk moments oldest-first, up to AND INCLUDING the cursor.
 *      Skip any whose id is in the inactive set entirely.
 *   3. For each remaining moment, walk its ops in chronological
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
import { applyRemapsToOp } from "./remap";
import { collectElementIdsFromGroupNode, getOperationElementIds } from "./types";

import type { SceneSnapshot } from "./applyOps";
import type { LogMoment, LogOperation, PendingConflict } from "./types";
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

  const moments = log.getMoments();
  const inactive = log.getInactiveMomentIds();
  const remaps = log.getRemaps();

  // Cursor index. If unset, treat as head (newest = index 0). Empty
  // log was handled by the baseline === null guard above.
  const cursorId = log.getCurrentMomentId();
  const cursorIdx =
    cursorId == null
      ? 0
      : moments.findIndex((m) => m.id === cursorId);
  if (cursorIdx < 0) {
    return null;
  }

  const skipped = new Set<LogOperation>();
  // Conflicts are accumulated under their missing-referent id so
  // multiple ops referencing the same dead group/element collapse
  // into a single user decision.
  const conflictMap = new Map<string, PendingConflict>();

  // Elements any walked moment touches — active OR skipped. These are
  // the only ones whose state can differ from the store's snapshot, so
  // they're the only ones that need a version bump at commit time (see
  // the stamping pass below). Collected across every moment in range,
  // skipped ones included: skipping a moment reverts elements that no
  // active op re-writes, and those still need to dominate the snapshot.
  const inPlay = new Set<string>();

  // Walk oldest-first (high array index → low). Stop after applying
  // the cursor's moment.
  for (let i = moments.length - 1; i >= cursorIdx; i--) {
    const moment = moments[i];
    for (const op of moment.operations) {
      for (const id of getOperationElementIds(op)) {
        inPlay.add(id);
      }
    }
    if (inactive.has(moment.id)) {
      // Moment is deactivated wholesale; nothing to apply, no
      // conflicts to record at this level — its ops simply didn't
      // happen.
      continue;
    }
    applyMomentTracked(moment, snapshot, remaps, skipped, conflictMap);
  }

  // Stamp the in-play elements with a version that dominates the store's
  // snapshot so the commit is adopted wholesale despite the store's
  // strict `snapshot.version < next.version` gate. Untouched-since-
  // baseline elements are deliberately left alone: their version already
  // matches the store, so they stay out of the ephemeral change the
  // commit emits (onChange / collab / persistence). See
  // `VersionLog.reserveReplayVersion`.
  const replayVersion = log.reserveReplayVersion();
  for (const id of inPlay) {
    const el = snapshot.get(id);
    if (el) {
      snapshot.set(id, { ...el, version: replayVersion } as typeof el);
    }
  }

  return { snapshot, skipped, conflicts: Array.from(conflictMap.values()) };
};

// ---------------------------------------------------------------------

const applyMomentTracked = (
  moment: LogMoment,
  snapshot: SceneSnapshot,
  remaps: ReadonlyMap<string, import("./types").Remap>,
  skipped: Set<LogOperation>,
  conflictMap: Map<string, PendingConflict>,
): void => {
  for (const op of moment.operations) {
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

    const missing = enumerateMissingReferents(finalOp, snapshot);
    if (missing.length > 0) {
      skipped.add(op);
      for (const ref of missing) {
        recordConflict(op, ref, snapshot, conflictMap);
      }
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

interface MissingReferent {
  kind: "element" | "group";
  id: string;
  elementType?: string;
}

const recordConflict = (
  op: LogOperation,
  ref: MissingReferent,
  snapshot: SceneSnapshot,
  conflictMap: Map<string, PendingConflict>,
): void => {
  const existing = conflictMap.get(ref.id);
  if (existing) {
    // Multiple ops can converge on the same missing referent (e.g. a
    // create + the moves that followed); add this op to the existing
    // bucket only if it isn't already there (an arrow-bind with two
    // distinct missing bound-to elements would otherwise double-list).
    if (!existing.affectedOps.includes(op)) {
      existing.affectedOps.push(op);
    }
    return;
  }
  // Suppress remap candidates when the missing referent is an arrow's
  // BOUND-TO element (not the arrow itself). Arrow-binding rebinds
  // aren't yet supported by `applyRemapsToOp`, so offering a target
  // here would store a remap that never actually rewrites the
  // binding — the conflict would re-fire on every replay. Forcing
  // Skip-only avoids the loop; proper rebind support is tracked
  // separately.
  const isArrowBoundToConflict =
    (op.kind === "arrow-bind" || op.kind === "arrow-move-binding") &&
    ref.kind === "element" &&
    ref.id !== op.elementId;

  conflictMap.set(ref.id, {
    referentKind: ref.kind,
    referentId: ref.id,
    elementType: ref.elementType,
    affectedOps: [op],
    candidates: isArrowBoundToConflict
      ? []
      : collectCandidates(ref.kind, ref.id, ref.elementType, snapshot),
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
 * Enumerate every referent of `op` that's currently missing from the
 * scene snapshot. Empty array means the op can apply cleanly.
 *
 * For ops with multiple potential referents (notably `arrow-bind`,
 * which can fail because the arrow itself OR either bound-to element
 * is gone), every missing one is surfaced — each becomes its own
 * entry in the conflict modal so the user resolves them
 * independently.
 *
 * `create` and `group` always return [] — they introduce referents
 * rather than depending on them. (Group with all-dead members still
 * no-ops harmlessly; we don't surface a conflict.)
 */
const enumerateMissingReferents = (
  op: LogOperation,
  snapshot: SceneSnapshot,
): MissingReferent[] => {
  const isLive = (id: string): boolean => {
    const el = snapshot.get(id);
    return el != null && !el.isDeleted;
  };
  const out: MissingReferent[] = [];

  switch (op.kind) {
    case "create":
      return out;
    case "delete":
    case "move":
    case "rotate":
    case "arrow-rotate":
    case "resize":
    case "arrow-resize":
    case "arrow-edit-points":
    case "restyle":
    case "alignment-anchor":
      if (!isLive(op.elementId)) {
        out.push({
          kind: "element",
          id: op.elementId,
          elementType: op.elementType,
        });
      }
      return out;

    case "arrow-bind": {
      // The arrow itself + each side's bound-to element on the AFTER
      // side (forward apply writes that side). Unbinds (after === null)
      // contribute no bound-to referent for forward apply.
      if (!isLive(op.elementId)) {
        out.push({
          kind: "element",
          id: op.elementId,
          elementType: op.elementType,
        });
      }
      const boundTo = (b: typeof op.start) => b?.after?.elementId;
      const startTarget = boundTo(op.start);
      const endTarget = boundTo(op.end);
      if (startTarget && !isLive(startTarget)) {
        out.push({ kind: "element", id: startTarget });
      }
      if (endTarget && startTarget !== endTarget && !isLive(endTarget)) {
        out.push({ kind: "element", id: endTarget });
      }
      return out;
    }

    case "arrow-move-binding": {
      // Same arrow + per-side boundElementId (which is unchanged
      // between before/after by construction — only the anchor
      // location moves).
      if (!isLive(op.elementId)) {
        out.push({
          kind: "element",
          id: op.elementId,
          elementType: op.elementType,
        });
      }
      if (op.start && !isLive(op.start.boundElementId)) {
        out.push({ kind: "element", id: op.start.boundElementId });
      }
      if (
        op.end &&
        op.end.boundElementId !== op.start?.boundElementId &&
        !isLive(op.end.boundElementId)
      ) {
        out.push({ kind: "element", id: op.end.boundElementId });
      }
      return out;
    }

    case "move-group":
    case "rotate-group":
    case "resize-group":
      // The group itself must still exist — at least one captured
      // member must currently bear this group id. If none do, the
      // `group` op that established this group has been deactivated
      // and the transform has no group to act on.
      if (
        !op.elementIds.some((id) => {
          const el = snapshot.get(id);
          return (
            el != null && !el.isDeleted && el.groupIds.includes(op.groupId)
          );
        })
      ) {
        out.push({ kind: "group", id: op.groupId });
      }
      return out;

    case "group": {
      // Creating a new group: harmless no-op if no captured members
      // are alive, but the gid isn't a referent so we don't surface
      // a conflict the user could resolve.
      return out;
    }
    case "ungroup": {
      // Dissolving an existing group: at least one captured member
      // must still bear the group id.
      const ids = collectElementIdsFromGroupNode(op.group);
      if (
        !ids.some((id) => {
          const el = snapshot.get(id);
          return (
            el != null && !el.isDeleted && el.groupIds.includes(op.group.id)
          );
        })
      ) {
        out.push({ kind: "group", id: op.group.id });
      }
      return out;
    }
    case "alignment": {
      // Writing `alignments` onto a missing *member* is a harmless
      // no-op. A link *pointing at* a missing element is not: it would
      // leave a live element carrying a dangling, one-sided alignment
      // to something that no longer exists. So the referents are the
      // partner ids inside the links this op would write — and only for
      // owners that are themselves still live, since a dead owner's
      // links never get written anyway.
      const partnerIds = new Set<string>();
      for (const [ownerId, links] of Object.entries(
        op.after as Record<string, readonly unknown[]>,
      )) {
        if (!isLive(ownerId)) {
          continue;
        }
        for (const link of links) {
          // an edge link names one partner; a gap chain names every
          // member (the owner among them, which `isLive` filters below)
          if (typeof link === "object" && link != null) {
            if ("elementId" in link) {
              partnerIds.add((link as { elementId: string }).elementId);
            } else if ("ids" in link) {
              for (const id of (link as { ids: readonly string[] }).ids) {
                partnerIds.add(id);
              }
            }
          }
        }
      }
      for (const id of partnerIds) {
        if (!isLive(id)) {
          out.push({ kind: "element", id });
        }
      }
      return out;
    }

    case "raw":
      if (!isLive(op.entry.elementId)) {
        out.push({
          kind: "element",
          id: op.entry.elementId,
          elementType: op.entry.elementType,
        });
      }
      return out;
  }
};
