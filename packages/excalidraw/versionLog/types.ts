/**
 * Types for the in-memory version log / audit log.
 *
 * The primitive unit is a `LogMoment` — one user-facing change, holding
 * one or more semantic `LogOperation`s derived from the raw element
 * deltas. It wraps one upstream `DurableIncrement` and keeps related
 * changes (e.g. a multi-select drag, a paste) bound together for
 * display, revert, branching, etc.
 *
 * Operations are a higher-level view than the raw `Delta<ElementPartial>`
 * the store emits: "moved group G by (dx, dy)" instead of "elements A, B,
 * C each had x and y change." When classification fails for any single
 * change in a moment, the whole moment falls back to `raw`
 * operations (one per untouched entry) so no information is lost.
 */

import type { StoreDelta } from "@excalidraw/element";
import type {
  ElementAlignment,
  ElementGapAlignment,
  FixedPointBinding,
} from "@excalidraw/element/types";

import type { TransformMatrix } from "./transform";

/**
 * The shape of `startBinding` / `endBinding` on an arrow element.
 * Re-exported from Excalidraw so the rest of the version-log code can
 * stay free of `unknown` casts.
 *
 * `null` represents "not bound"
 */
export type ArrowBinding = FixedPointBinding | null;

export type LogEntryType = "create" | "update" | "delete";

/**
 * A child of a `GroupNode`: either another group (nested) or a leaf
 * element id.
 *
 * This is a tree representation of Excalidraw's flat `groupIds` array
 * on each element. We use it for `group` / `ungroup` ops because the
 * tree encodes structure (in particular the position of a group
 * relative to its siblings and ancestors).
 */
export type GroupChild =
  | { kind: "element"; elementId: string }
  | { kind: "group"; node: GroupNode };

/** A group with its members, in z-order. */
export interface GroupNode {
  id: string;
  children: GroupChild[];
}

/**
 * Collect every element id (recursively) under a `GroupNode`.
 * Defined here in `types.ts` so `getOperationElementIds` can use it
 * without a circular import.
 */
export const collectElementIdsFromGroupNode = (node: GroupNode): string[] => {
  const ids: string[] = [];
  const walk = (n: GroupNode) => {
    for (const child of n.children) {
      if (child.kind === "element") {
        ids.push(child.elementId);
      } else {
        walk(child.node);
      }
    }
  };
  walk(node);
  return ids;
};

/**
 * A shallow snapshot of element property values. Mirrors the shape of
 * `Delta<ElementPartial>.deleted` / `.inserted` — only the keys that
 * actually changed are present.
 */
export type LogPropertyMap = Record<string, unknown>;

/**
 * A raw, unclassified per-element change as it came out of the store.
 * Used as the payload for `LogOperation { kind: "raw" }`, and as the
 * intermediate form that the classifier consumes inside `VersionLog`.
 */
export interface LogEntry {
  /** Stable id for React keys + future persistence. Unique within a moment. */
  id: string;
  type: LogEntryType;
  elementId: string;
  /** The element's `type` field (e.g. "rectangle", "arrow", "text") if known. */
  elementType?: string;
  /** Property values before the change. Empty for `create`. */
  before: LogPropertyMap;
  /** Property values after the change. Empty for `delete`. */
  after: LogPropertyMap;
}

/**
 * Semantic operations derived from raw element deltas. Each variant
 * carries just the data needed to describe that operation.
 * 
 * Use `getOperationElementIds` to enumerate the ids it touches (for
 * hover-highlight, future revert-scope previews, etc.).
 */
export type LogOperation =
  // Lifecycle ---------------------------------------------------------
  | {
      kind: "create";
      elementId: string;
      elementType?: string;
      /** Inserted property values. */
      values: LogPropertyMap;
    }
  | {
      kind: "delete";
      elementId: string;
      elementType?: string;
      /** Last-known property values before user deletion. */
      lastValues: LogPropertyMap;
    }
  // Geometric ---------------------------------------------------------
  | {
      kind: "move";
      elementId: string;
      elementType?: string;
      /**
       * Absolute element positions before / after the move. Carried
       * alongside `dx` / `dy` so the dependency analyzer (and a future
       * selective-undo replay) can detect when the baseline state
       * doesn't match what this op expected.
       */
      from: { x: number; y: number };
      to: { x: number; y: number };
      dx: number;
      dy: number;
      transform: TransformMatrix;
      /**
       * Bound-arrow geometry changes that were captured in the same
       * moment as a consequence of this op (arrow endpoint follows
       * a moved/resized/rotated bindable). Not surfaced as separate
       * ops — the user did one thing, we show one op — but the raw
       * before/after values are stashed here so replay can reproduce
       * the arrow's dependent geometry when applying this op forward
       * or backward. See `versionLog/consequences.ts`.
       */
      consequentOps?: LogOperation[];
    }
  | {
      kind: "move-group";
      /** The innermost group id whose members all moved by (dx, dy). */
      groupId: string;
      /** All element ids that participated in the group move. */
      elementIds: string[];
      /**
       * Absolute starting position of each member, keyed by element id.
       * Each value is the element's `(x, y)` at the moment the move
       * fired. Used for soft-conflict detection (and eventually for
       * selective-undo replay).
       */
      fromPositions: Record<string, { x: number; y: number }>;
      /** Absolute ending positions, same shape as `fromPositions`. */
      toPositions: Record<string, { x: number; y: number }>;
      dx: number;
      dy: number;
      transform: TransformMatrix;
      consequentOps?: LogOperation[];
    }
  | {
      kind: "resize";
      elementId: string;
      elementType?: string;
      /** Absolute element dimensions from the entry. */
      from: { width: number; height: number };
      to: { width: number; height: number };
      /** Per-axis scale factor derived from the change matrix. */
      scaleX: number;
      scaleY: number;
      /**
       * The anchor point (world coords) — i.e. the fixed point of the
       * change matrix. For a corner-drag resize this is the un-moved
       * corner. `null` for pure-scale-from-origin (sx=1 or sy=1 cases
       * where the fixed point is not unique).
       */
      center: readonly [number, number] | null;
      transform: TransformMatrix;
      consequentOps?: LogOperation[];
    }
  | {
      kind: "resize-group";
      groupId: string;
      elementIds: string[];
      scaleX: number;
      scaleY: number;
      center: readonly [number, number] | null;
      transform: TransformMatrix;
      consequentOps?: LogOperation[];
    }
  | {
      kind: "rotate";
      elementId: string;
      elementType?: string;
      /** Absolute element angles in radians, from the entry. */
      from: number;
      to: number;
      /** Signed rotation delta, in radians, derived from the matrix. */
      angle: number;
      /**
       * Rotation center in world coords — the fixed point of the
       * change matrix. For Excalidraw this is normally the element's
       * center; `null` only if the matrix is degenerate.
       */
      center: readonly [number, number] | null;
      transform: TransformMatrix;
      consequentOps?: LogOperation[];
    }
  | {
      kind: "rotate-group";
      groupId: string;
      elementIds: string[];
      angle: number;
      center: readonly [number, number] | null;
      transform: TransformMatrix;
      consequentOps?: LogOperation[];
    }
  // Style -------------------------------------------------------------
  | {
      kind: "restyle";
      elementId: string;
      elementType?: string;
      /** Which style property changed (e.g. "strokeColor"). */
      property: string;
      from: unknown;
      to: unknown;
    }
  // Arrow-specific ---------------------------------------------------
  //
  // Arrows have derived geometry (x / y / width / height are computed
  // from `points`) and structural properties (`startBinding`,
  // `endBinding`) that don't fit the generic geometry/style classifier.
  //
  // For arrows we emit dedicated ops; the regular `move`, `restyle`,
  // `create`, `delete` still apply where appropriate. `arrow-resize`
  // and `arrow-rotate` mirror the shapes of `resize` and `rotate` but
  // exist as distinct kinds so the classifier can permit `points`
  // residue without weakening the generic resize/rotate paths.
  | {
      kind: "arrow-edit-points";
      elementId: string;
      elementType?: string;
      /** Local-space waypoints before the edit. `[0,0]` is always the start. */
      before: ReadonlyArray<readonly [number, number]>;
      after: ReadonlyArray<readonly [number, number]>;
      beforeOrigin: [number, number] | null;
      afterOrigin: [number, number] | null;
    }
  | {
      kind: "arrow-bind";
      elementId: string;
      elementType?: string;
      /**
       * Per-side binding change for STRUCTURAL changes: bind (null →
       * value), unbind (value → null), or rebind to a different
       * element (different `elementId`). Anchor moves within the same
       * element are reported as `arrow-move-binding` instead.
       */
      start?: { before: ArrowBinding; after: ArrowBinding };
      end?: { before: ArrowBinding; after: ArrowBinding };
    }
  | {
      kind: "arrow-move-binding";
      elementId: string;
      elementType?: string;
      /**
       * Per-side anchor move within the SAME bound element.
       * `boundElementId` is the (unchanging) element the arrow is
       * anchored to; `before` and `after` are the full binding
       * payloads so the panel can show the old / new `fixedPoint`,
       * `mode`, etc. Both sides are non-null by construction (an
       * anchor move only makes sense when both states are bound).
       */
      start?: {
        boundElementId: string;
        before: FixedPointBinding;
        after: FixedPointBinding;
      };
      end?: {
        boundElementId: string;
        before: FixedPointBinding;
        after: FixedPointBinding;
      };
    }
  | {
      kind: "arrow-resize";
      elementId: string;
      elementType?: string;
      from: { width: number; height: number };
      to: { width: number; height: number };
      scaleX: number;
      scaleY: number;
      center: readonly [number, number] | null;
      transform: TransformMatrix;
    }
  | {
      kind: "arrow-rotate";
      elementId: string;
      elementType?: string;
      from: number;
      to: number;
      angle: number;
      center: readonly [number, number] | null;
      transform: TransformMatrix;
    }
  // Grouping ----------------------------------------------------------
  //
  // Group / ungroup events are multi-entry by nature: pressing Ctrl+G
  // on a selection adds the same new `groupId` to every selected
  // element's `groupIds`. We model the new (or dissolved) group as a
  // tree — `GroupNode` — rather than a flat element list, so that
  // nested structure is preserved and ungroup-redo can correctly
  // recreate the group at its original position relative to any
  // outer parent.
  | {
      kind: "group";
      /**
       * The new group's tree, with its members captured at the moment
       * of grouping. Member element ids (recursively) are available
       * via `collectElementIdsFromGroupNode`.
       */
      group: GroupNode;
      /**
       * Parent group id at the time of grouping, or `null` if the new
       * group sits at the top level of the scene's group structure.
       * Used at apply time to place the group's id at the right
       * position in each affected element's `groupIds`.
       */
      parentGroupId: string | null;
    }
  | {
      kind: "ungroup";
      /** The dissolved group's tree, with its (former) members. */
      group: GroupNode;
      /** Parent group id at the time of dissolution. */
      parentGroupId: string | null;
    }
  // Hard alignment ----------------------------------------------------
  //
  // Locking (Alt+L) / unlocking (Alt+Shift+L) hard alignments is
  // multi-entry like grouping: one gesture writes the `alignments`
  // field on several elements at once. We model the whole gesture as a
  // single op carrying each member's before/after link arrays so replay
  // can set them in either direction.
  | ({
      kind: "alignment";
      /** "lock" = links added, "unlock" = links removed. */
      action: "lock" | "unlock";
      /** Element ids whose link field changed. */
      elementIds: string[];
    } & (
      | {
          /**
           * Which link field the op writes. Edge alignments and equal-gap
           * triples are the same gesture ("lock what you can see") with
           * incompatible payloads — a triple has no single partner id —
           * so they share the kind and split here rather than adding a
           * second op kind and eight more switch arms.
           */
          field: "alignments";
          /** Per-element link arrays before / after, keyed by element id. */
          before: Record<string, readonly ElementAlignment[]>;
          after: Record<string, readonly ElementAlignment[]>;
        }
      | {
          field: "gapAlignments";
          before: Record<string, readonly ElementGapAlignment[]>;
          after: Record<string, readonly ElementGapAlignment[]>;
        }
    ))
  // Anchoring an element (the padlock badge) pins it against alignment
  // propagation. Unlike `alignment` this is a single-element flag, not a
  // link, so it gets its own op rather than riding along as a `restyle`.
  | {
      kind: "alignment-anchor";
      elementId: string;
      elementType?: string;
      /** `true` = anchored (locked), `false` = released. */
      anchored: boolean;
    }
  // Fallback ----------------------------------------------------------
  | {
      kind: "raw";
      /** The original entry; rendered with before/after key-value diff. */
      entry: LogEntry;
    };

/**
 * Return every element id touched by the operation. Used by the panel
 * for hover-highlight (so hovering a "moved group" outlines all members).
 */
export const getOperationElementIds = (op: LogOperation): string[] => {
  switch (op.kind) {
    case "create":
    case "delete":
    case "restyle":
    case "arrow-edit-points":
    case "arrow-bind":
    case "arrow-move-binding":
    case "arrow-resize":
    case "arrow-rotate":
    case "alignment-anchor":
      return [op.elementId];
    case "move":
    case "resize":
    case "rotate":
      return [op.elementId, ...consequentIds(op)];
    case "move-group":
    case "rotate-group":
    case "resize-group":
      return [...op.elementIds, ...consequentIds(op)];
    case "group":
    case "ungroup":
      return collectElementIdsFromGroupNode(op.group);
    case "alignment":
      return op.elementIds;
    case "raw":
      return [op.entry.elementId];
  }
};

const consequentIds = (op: { consequentOps?: LogOperation[] }): string[] =>
  op.consequentOps?.flatMap((o) => getOperationElementIds(o)) ?? [];

export interface LogMoment {
  id: string;
  /** Wall-clock time the moment was observed, ms since epoch. */
  timestamp: number;
  /**
   * Semantic operations derived from the raw store delta. May be empty
   * only if classification produced no operations (currently impossible
   * since `create` / `delete` always classify and `raw` is a catch-all).
   */
  operations: LogOperation[];
  /** Pre-computed tallies — handy for the card header. */
  counts: { create: number; update: number; delete: number };
  /**
   * The original store delta this moment was derived from.
   * Unused but retained for debugging.
   */
  delta: StoreDelta;
}

/**
 * User-supplied rewrite for ops that reference a particular element or
 * group. Keyed in `VersionLog.remaps` by the ORIGINAL referent id —
 * once a remap exists for id `X`, every subsequent op the replay sees
 * that touches `X` is rewritten (or explicitly skipped if `to` is
 * null) before its referent-presence check runs.
 *
 * Created interactively via the conflict-resolution modal that pops up
 * when a selective-undo causes downstream ops to lose their referent.
 */
export type Remap =
  | { kind: "group"; to: string | null }
  | { kind: "element"; to: string | null };

/**
 * One unresolved hard conflict detected during replay, grouped by the
 * missing referent (so the user resolves once per referent rather than
 * once per affected op). The modal renders one section per conflict.
 *
 * `candidates` is computed at the moment the conflict is hit — they're
 * live referents of the matching kind in the in-progress replay
 * snapshot, so a group that wouldn't yet exist at that point in the
 * timeline isn't offered as a target.
 */
export interface PendingConflict {
  referentKind: "group" | "element";
  referentId: string;
  /** elementType filter (only for element conflicts); informational. */
  elementType?: string;
  /** Ops that couldn't apply because `referentId` is missing. */
  affectedOps: LogOperation[];
  /** Live target ids the user can remap to (same kind). */
  candidates: string[];
}