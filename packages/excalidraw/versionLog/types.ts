/**
 * Types for the in-memory version log / audit log.
 *
 * The primitive unit is a `LogIncrement` — one store increment, holding
 * one or more semantic `LogOperation`s derived from the raw element
 * deltas. This mirrors the upstream `DurableIncrement` shape and keeps
 * related changes (e.g. a multi-select drag, a paste) bound together
 * for display, revert, branching, etc.
 *
 * Operations are a higher-level view than the raw `Delta<ElementPartial>`
 * the store emits: "moved group G by (dx, dy)" instead of "elements A, B,
 * C each had x and y change." When classification fails for any single
 * change in an increment, the whole increment falls back to `raw`
 * operations (one per untouched entry) so no information is lost.
 */

import type { StoreDelta } from "@excalidraw/element";
import type { FixedPointBinding } from "@excalidraw/element/types";

import type { TransformMatrix } from "./transform";

/**
 * The shape of `startBinding` / `endBinding` on an arrow element.
 * Re-exported from Excalidraw so the rest of the version-log code can
 * stay free of `unknown` casts.
 *
 * `null` represents "not bound" — both endpoints are independently
 * bindable, and either may be unset.
 */
export type ArrowBinding = FixedPointBinding | null;

export type LogEntryType = "create" | "update" | "delete";

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
  /** Stable id for React keys + future persistence. Unique within an increment. */
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
 * carries just the data needed to describe that operation; consumers
 * use `getOperationElementIds` to enumerate the ids it touches (for
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
      /** Last-known property values before tombstoning. */
      lastValues: LogPropertyMap;
    }
  // Geometric ---------------------------------------------------------
  | {
      kind: "move";
      elementId: string;
      elementType?: string;
      dx: number;
      dy: number;
      transform: TransformMatrix;
    }
  | {
      kind: "move-group";
      /** The innermost group id whose members all moved by (dx, dy). */
      groupId: string;
      /** All element ids that participated in the group move. */
      elementIds: string[];
      dx: number;
      dy: number;
      transform: TransformMatrix;
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
    }
  | {
      kind: "resize-group";
      groupId: string;
      elementIds: string[];
      scaleX: number;
      scaleY: number;
      center: readonly [number, number] | null;
      transform: TransformMatrix;
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
    }
  | {
      kind: "rotate-group";
      groupId: string;
      elementIds: string[];
      angle: number;
      center: readonly [number, number] | null;
      transform: TransformMatrix;
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
  // element's `groupIds`. We emit one op per event, listing all
  // members. Detected as a pre-pass before per-entry classification.
  | {
      kind: "group";
      /** The group id added to every member. */
      groupId: string;
      /** Element ids that received the new group id. */
      elementIds: string[];
    }
  | {
      kind: "ungroup";
      /** The group id removed from every member. */
      groupId: string;
      /** Element ids that lost the group id. */
      elementIds: string[];
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
    case "move":
    case "resize":
    case "rotate":
    case "restyle":
    case "arrow-edit-points":
    case "arrow-bind":
    case "arrow-move-binding":
    case "arrow-resize":
    case "arrow-rotate":
      return [op.elementId];
    case "move-group":
    case "rotate-group":
    case "resize-group":
    case "group":
    case "ungroup":
      return op.elementIds;
    case "raw":
      return [op.entry.elementId];
  }
};

export interface LogIncrement {
  id: string;
  /** Wall-clock time the increment was observed, ms since epoch. */
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
   * The original store delta this increment was derived from. Retained
   * so we can `StoreDelta.inverse(...)` it later for revert / branch.
   * Not serialized when we add IndexedDB persistence — will need
   * re-hydration via `StoreDelta.restore()` at load time.
   */
  delta: StoreDelta;
}

/** Reserved for future filtering UI; unused in v1. */
export interface LogQuery {
  type?: LogEntryType;
  elementId?: string;
  since?: number;
  until?: number;
}
