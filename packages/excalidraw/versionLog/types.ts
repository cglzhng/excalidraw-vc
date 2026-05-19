/**
 * Types for the in-memory version log / audit log.
 *
 * The primitive unit is a `LogIncrement` — one store increment, holding
 * one `LogEntry` per element it touched. This mirrors the upstream
 * `DurableIncrement` shape and keeps related changes (e.g. a multi-select
 * drag, a paste) bound together for display, revert, branching, etc.
 */

export type LogEntryType = "create" | "update" | "delete";

/**
 * A shallow snapshot of element property values. Mirrors the shape of
 * `Delta<ElementPartial>.deleted` / `.inserted` — only the keys that
 * actually changed are present.
 */
export type LogPropertyMap = Record<string, unknown>;

export interface LogEntry {
  /** Stable id for React keys + future persistence. Unique within an increment. */
  id: string;
  type: LogEntryType;
  elementId: string;
  /**
   * The element's `type` field (e.g. "rectangle", "arrow", "text") if known.
   * May be undefined if the type did not appear in the delta.
   */
  elementType?: string;
  /**
   * Property values before the change. Empty for `create`.
   * For `update`, only contains the keys that changed.
   */
  before: LogPropertyMap;
  /**
   * Property values after the change. Empty for `delete`.
   * For `update`, only contains the keys that changed.
   */
  after: LogPropertyMap;
}

/**
 * All entries that came from one durable store increment.
 *
 * `id` is the underlying `StoreDelta.id`, so two log increments will never
 * collide and we can look up the original delta later when implementing
 * revert / branch.
 */
export interface LogIncrement {
  id: string;
  /** Wall-clock time the increment was observed, ms since epoch. */
  timestamp: number;
  /** Entries in the order they were emitted by the store (added → removed → updated). */
  entries: LogEntry[];
  /** Pre-computed entry-type tallies — handy for headers and filtering. */
  counts: { create: number; update: number; delete: number };
}

/** Reserved for future filtering UI; unused in v1. */
export interface LogQuery {
  type?: LogEntryType;
  elementId?: string;
  since?: number;
  until?: number;
}
