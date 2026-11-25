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
 *      exists. If any referent is missing, emit a `PendingConflict` so
 *      the UI can let the user choose a resolution, and apply the
 *      session's tentative decision for it if there is one — otherwise
 *      record the op as skipped.
 *   4. Return the resulting snapshot + skipped set + conflicts.
 *
 * The caller (App) hands the snapshot to `updateScene` with
 * `captureUpdate: NEVER` and stores the skipped set on the log. If a
 * toggle's replay reports conflicts, it opens a conflict-resolution
 * session instead, which commits a replay under its own decisions.
 */

import {
  isAlignable,
  isArrowElement,
  isBindableElement,
  isBoundToContainer,
  isFreeDrawElement,
  isLinearElement,
  isTextElement,
  orderByFractionalIndex,
} from "@excalidraw/element";

import type { BoundElement, ExcalidrawElement } from "@excalidraw/element/types";

import { applyOpsToScene } from "./applyOps";
import {
  followAlignments,
  isFollowedOp,
  ownElementIds,
  withoutAlignmentFollowers,
} from "./followAlignments";
import { followBindings } from "./followBindings";
import { alignmentReferences, placeStandInsDropping } from "./placement";
import { applyRemapsToOp } from "./remap";
import { collectElementIdsFromGroupNode, getOperationElementIds } from "./types";

import type { SceneSnapshot } from "./applyOps";
import type { DroppedAlignment } from "./placement";
import type {
  LogMoment,
  LogOperation,
  PendingConflict,
  Remap,
} from "./types";
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
  /** What stand-ins were handed but couldn't take, and so went without. */
  dropped: DroppedAlignment[];
}

/**
 * `tentative` holds decisions a conflict-resolution session hasn't
 * committed yet, keyed by missing referent like the log's own remaps.
 * Each applies only where the log's remaps leave that referent missing,
 * and its conflict is still reported — with candidates and affected ops,
 * so the session can offer the choice again — while the decision is
 * applied. The caller tells the two apart by whether the referent has a
 * tentative decision.
 */
export const replayActiveOps = (
  log: VersionLog,
  tentative: ReadonlyMap<string, Remap> = new Map(),
): ReplayResult | null => {
  const baseline = log.getBaselineScene();
  if (baseline == null) {
    return null;
  }

  // Each element is copied, not just the Map: `applyOps` replaces
  // entries rather than mutating them, but the snapshot is handed to the
  // scene, where `mutateElement` writes in place — an element no op
  // touches would otherwise *be* the baseline's object, and the next drag
  // of it would move the baseline too. One level is enough, since
  // `mutateElement` replaces fields rather than editing nested arrays.
  const snapshot: SceneSnapshot = new Map(
    Array.from(baseline, ([id, el]) => [id, { ...el }]),
  ) as unknown as SceneSnapshot;

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
  const dropped: DroppedAlignment[] = [];

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
    applyMomentTracked(
      moment,
      snapshot,
      remaps,
      tentative,
      skipped,
      conflictMap,
      dropped,
      inPlay,
    );
  }

  for (const id of syncBoundElements(snapshot)) {
    inPlay.add(id);
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

  // Order the scene by `index`. Ops write the key and leave the map's
  // insertion order alone, and the commit's `syncInvalidIndices` treats
  // array order as the truth — so without this, every replay would put
  // each element back where it was first inserted and quietly undo
  // every reorder in the log.
  const ordered: SceneSnapshot = new Map(
    orderByFractionalIndex(Array.from(snapshot.values())).map((el) => [
      el.id,
      el,
    ]),
  );

  return {
    snapshot: ordered,
    skipped,
    conflicts: Array.from(conflictMap.values()),
    dropped,
  };
};

// ---------------------------------------------------------------------

/**
 * Rebuild every element's `boundElements` from the relations it is the
 * reverse of: each live arrow's `startBinding` / `endBinding`, and each
 * live label's `containerId`. The log never records the list — an entry
 * carrying only it is bookkeeping (`classify.ts`), since the arrow's or
 * the label's own change is what the user did — so after a replay it
 * would say whatever the baseline or an element's creation left in it.
 * Upstream reads it to find a container's label and the arrows to drag
 * along with an element, so a stale list detaches both.
 *
 * Rewrites only lists whose membership differs, keeping the existing
 * order where it does, and returns their ids so the replay stamps them.
 */
const syncBoundElements = (snapshot: SceneSnapshot): string[] => {
  const derived = new Map<string, BoundElement[]>();
  const add = (ownerId: string, bound: BoundElement) => {
    const list = derived.get(ownerId) ?? [];
    if (!list.some((b) => b.id === bound.id)) {
      list.push(bound);
    }
    derived.set(ownerId, list);
  };
  for (const el of snapshot.values()) {
    if (el.isDeleted) {
      continue;
    }
    if (isArrowElement(el)) {
      for (const binding of [el.startBinding, el.endBinding]) {
        if (binding) {
          add(binding.elementId, { id: el.id, type: "arrow" });
        }
      }
    } else if (isTextElement(el) && el.containerId) {
      add(el.containerId, { id: el.id, type: "text" });
    }
  }

  const changed: string[] = [];
  for (const el of snapshot.values()) {
    const current = el.boundElements ?? [];
    const next = derived.get(el.id) ?? [];
    const same =
      current.length === next.length &&
      next.every((b) => current.some((c) => c.id === b.id && c.type === b.type));
    if (same) {
      continue;
    }
    const kept = current.filter((c) => next.some((b) => b.id === c.id));
    const added = next.filter((b) => !current.some((c) => c.id === b.id));
    const merged = [...kept, ...added];
    snapshot.set(el.id, {
      ...el,
      boundElements: merged.length > 0 ? merged : null,
    });
    changed.push(el.id);
  }
  return changed;
};

const applyMomentTracked = (
  moment: LogMoment,
  snapshot: SceneSnapshot,
  remaps: ReadonlyMap<string, Remap>,
  tentative: ReadonlyMap<string, Remap>,
  skipped: Set<LogOperation>,
  conflictMap: Map<string, PendingConflict>,
  dropped: DroppedAlignment[],
  inPlay: Set<string>,
): void => {
  // The scene as the Moment found it, which its alignment followers are
  // solved against once its ops have run (`followAlignments.ts`), and the
  // elements those ops moved themselves.
  const before = moment.operations.some(isFollowedOp)
    ? new Map(snapshot)
    : null;
  const drivers = new Set<string>();
  const strippedFollowers = new Set<string>();

  for (const op of moment.operations) {
    const remap = applyRemapsToOp(op, remaps);
    if (remap.status === "skip") {
      // User explicitly chose to skip everything that touched this
      // referent. Mark the (original) op for the panel's warning row
      // and move on — no conflict.
      skipped.add(op);
      continue;
    }

    // For group-keyed transforms, the captured `elementIds` is the
    // ORIGINAL member set. After a group remap (G1 → G2) those ids
    // are stale — apply the transform to the live members of G2 in
    // the current snapshot instead.
    let finalOp = resolveLiveGroupMembers(remap.op, snapshot);

    const missing = enumerateMissingReferents(finalOp, snapshot);
    if (missing.length > 0) {
      for (const ref of missing) {
        recordConflict(op, finalOp, ref, snapshot, conflictMap);
      }
      // A session's decision stands in for the user's answer only once
      // it covers every referent this op is missing.
      if (!missing.every((ref) => tentative.has(ref.id))) {
        skipped.add(op);
        continue;
      }
      const decided = applyRemapsToOp(finalOp, tentative);
      if (decided.status === "skip") {
        skipped.add(op);
        continue;
      }
      finalOp = resolveLiveGroupMembers(decided.op, snapshot);
      if (enumerateMissingReferents(finalOp, snapshot).length > 0) {
        skipped.add(op);
        continue;
      }
    }
    // Alignment followers are derived after the Moment's ops rather than
    // replayed, so a stand-in follows the links it took over and a skip
    // that moved a partner is followed from where the partner now is.
    if (isFollowedOp(finalOp)) {
      ownElementIds(finalOp).forEach((id) => drivers.add(id));
      const derived = withoutAlignmentFollowers(finalOp, snapshot);
      finalOp = derived.op;
      derived.stripped.forEach((id) => strippedFollowers.add(id));
    }
    // the ids the op names now, which a remap may have changed: a stand-in
    // has to out-version the store's snapshot like anything else it moves
    for (const id of getOperationElementIds(finalOp)) {
      inPlay.add(id);
    }

    // A reassigned alignment names a stand-in in links that were true of
    // the missing element, so the stand-in is moved to where they hold
    // before they're written (`placement.ts`). Whatever it can't be placed
    // for is dropped and the rest kept: nothing an alignment asks of a
    // stand-in stops it being chosen.
    if (op.kind === "alignment" && finalOp.kind === "alignment") {
      const standIns = alignmentStandIns(op, finalOp, remaps, tentative);
      if (standIns.length > 0) {
        const placed = placeStandInsDropping(finalOp, standIns, snapshot);
        finalOp = placed.op;
        dropped.push(...placed.dropped);
        for (const id of placed.changed) {
          inPlay.add(id);
        }
        // the follow pass after the op only covers the ids it names
        for (const id of followBindings(snapshot, placed.changed)) {
          inPlay.add(id);
        }
      }
    }

    // `applyOpsToScene` reverses ops for "backward" but applies in
    // order for "forward"; single-op call is the same either way. A
    // remapped bind needs nothing extra: its recorded geometry ends where
    // the original element was, and the follow pass re-places it on the
    // new one.
    for (const id of applyOpsToScene([finalOp], snapshot, "forward")) {
      inPlay.add(id);
    }
  }

  if (before && drivers.size > 0) {
    const followed = followAlignments(
      before,
      snapshot,
      drivers,
      strippedFollowers,
    );
    for (const id of followed) {
      inPlay.add(id);
    }
    for (const id of followBindings(snapshot, followed)) {
      inPlay.add(id);
    }
  }
};

/**
 * The stand-ins a remapped alignment op names: where the recorded op named
 * an element the remaps — the log's, then the session's — carried somewhere
 * else, the element it went to. Read off the remaps rather than off which
 * ids are new, since a stand-in may already have been one of the op's own
 * partners.
 */
const alignmentStandIns = (
  op: LogOperation & { kind: "alignment" },
  finalOp: LogOperation & { kind: "alignment" },
  ...maps: ReadonlyMap<string, Remap>[]
): string[] => {
  const named = alignmentReferences(finalOp);
  const standIns = new Set<string>();
  for (const id of alignmentReferences(op)) {
    let to = id;
    for (const map of maps) {
      const remap = map.get(to);
      if (remap?.kind === "element" && remap.to) {
        to = remap.to;
      }
    }
    // a session's decision applies only where its referent is gone, so
    // one the op still names wasn't remapped here
    if (to !== id && !named.has(id) && named.has(to)) {
      standIns.add(to);
    }
  }
  return [...standIns];
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
  /** `op` with the log's remaps applied, which is what a stand-in joins */
  resolved: LogOperation,
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
      // one stand-in takes every op in the bucket, so it has to suit
      // each of them
      if (ref.kind === "element") {
        existing.candidates = existing.candidates.filter((id) => {
          const refusal = standInRefusal(resolved, ref.id, snapshot.get(id));
          if (refusal != null) {
            existing.refusals[id] = refusal;
          }
          return refusal == null;
        });
      }
    }
    return;
  }

  const candidates: string[] = [];
  const refusals: Record<string, string> = {};
  if (ref.kind === "element") {
    for (const el of snapshot.values()) {
      if (el.id === ref.id) {
        continue;
      }
      const refusal = standInRefusal(resolved, ref.id, el);
      if (refusal == null) {
        candidates.push(el.id);
      } else {
        refusals[el.id] = refusal;
      }
    }
  } else {
    candidates.push(...collectGroupCandidates(ref.id, snapshot));
  }
  conflictMap.set(ref.id, {
    referentKind: ref.kind,
    referentId: ref.id,
    elementType: ref.elementType,
    affectedOps: [op],
    candidates,
    refusals,
  });
};

/**
 * Why `el` can't take the place of the missing element `refId` in `op`,
 * or `null` if it can. Only what exists at this point in the replay is
 * asked: an element drawn later in the log isn't there yet to stand in,
 * and gets no reason here at all (`PendingConflict.refusals`).
 *
 * Most ops carry over to any kind of element — a move is a
 * displacement, a restyle a set of style values, a rotation an angle.
 * The exceptions are payloads that only describe one kind of geometry.
 * Each reason is phrased to follow the element's name.
 */
const standInRefusal = (
  op: LogOperation,
  refId: string,
  el: ExcalidrawElement | undefined,
): string | null => {
  if (!el || el.id === refId) {
    return "is the element that went missing";
  }
  if (el.isDeleted) {
    return "is deleted at this point in the log";
  }
  // locked means nothing may change it, a stand-in's placement included
  if (el.locked) {
    return "is locked";
  }
  switch (op.kind) {
    case "arrow-bind":
    case "arrow-move-binding":
      // the binding lives on the arrow; what it binds to only has to be
      // something an arrow can bind to, of any type
      if (refId === op.elementId) {
        return isArrowElement(el) ? null : "isn't an arrow";
      }
      if (el.id === op.elementId) {
        return "is the arrow itself";
      }
      if (isBoundToContainer(el)) {
        return "is a label; it follows its container";
      }
      return isBindableElement(el) ? null : "can't have an arrow bound to it";
    case "resize":
      // Writes width and height alone. That is the whole shape only for
      // a box: a line's or a freedraw's points, or a text's wrapped
      // content, would be left disagreeing with its new size.
      return isLinearElement(el) || isFreeDrawElement(el) || isTextElement(el)
        ? `is a ${el.type}; a resize only carries over to a box`
        : null;
    case "arrow-resize":
    case "arrow-edit-points":
      // points are the shape, so only something made of points
      return isLinearElement(el)
        ? null
        : "isn't a line or arrow, so it has no points to take";
    case "alignment":
      // A link is between two boxes' edges; the engine's own rule. Nothing
      // else an alignment asks of a stand-in — where it has to go, what it
      // would carry along, whether it was already a partner — stops it
      // being chosen: the replay keeps the alignments it can be given and
      // drops the rest (`placeStandInsDropping`).
      return isAlignable(el) ? null : "can't be aligned";
    case "raw":
      // an arbitrary property map is only safe on its own kind
      return el.type === op.entry.elementType
        ? null
        : `isn't a ${op.entry.elementType}, which this change was written for`;
    default:
      // A container's label is never placed or styled on its own: it
      // follows its container, which would undo anything written to it.
      return isBoundToContainer(el)
        ? "is a label; it follows its container"
        : null;
  }
};

const collectGroupCandidates = (
  missingId: string,
  snapshot: SceneSnapshot,
): string[] => {
  // every unique gid currently borne by some live element, minus the
  // missing one
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
 * conflict of its own so the user resolves them
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
    case "reorder":
      // A key on a missing element is never written, and one on a
      // deleted element orders nothing anyone sees — no conflict to
      // resolve either way.
      return out;
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
