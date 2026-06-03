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

import type { TransformMatrix } from "./transform";

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
      return [op.elementId];
    case "move-group":
    case "rotate-group":
    case "resize-group":
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
