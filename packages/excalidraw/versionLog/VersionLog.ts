import { Emitter } from "@excalidraw/common";

import type { DurableIncrement } from "@excalidraw/element";

import type {
  LogEntry,
  LogEntryType,
  LogIncrement,
  LogPropertyMap,
} from "./types";

type DurableIncrementEmitter = Emitter<[DurableIncrement]>;

/**
 * Default ring-buffer size, in *increments* (not entries). Each increment
 * may carry many entries — a multi-select drag, a paste, etc. Tune as
 * needed once we add IndexedDB persistence.
 */
const DEFAULT_MAX_INCREMENTS = 1000;

/**
 * In-memory version log. Subscribes to `Store.onDurableIncrementEmitter`,
 * converts each increment into a `LogIncrement` (one record per store
 * increment, containing one `LogEntry` per element it touched), and
 * exposes them to UI via `getIncrements()` + `onChangeEmitter`.
 *
 * v1: read-only. When write-back (revert / branch) is added, see
 * `VERSION_CONTROL_PLAN.md` § "Avoiding the feedback loop" for how to
 * prevent our own programmatic updates from re-entering this subscriber.
 */
export class VersionLog {
  public readonly onChangeEmitter = new Emitter<[]>();

  /** Newest-first. */
  private increments: LogIncrement[] = [];
  private readonly maxIncrements: number;
  private unsubscribe: (() => void) | null = null;
  private nextEntrySeq = 0;

  constructor(opts: { maxIncrements?: number } = {}) {
    this.maxIncrements = opts.maxIncrements ?? DEFAULT_MAX_INCREMENTS;
  }

  /**
   * Wire this log to a store's durable-increment emitter.
   * Returns an unsubscribe function; also retained internally so
   * `destroy()` can clean up.
   */
  public subscribe(emitter: DurableIncrementEmitter): () => void {
    const off = emitter.on((increment) => this.ingest(increment));
    this.unsubscribe = off;
    return off;
  }

  public destroy() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.increments = [];
    this.onChangeEmitter.clear();
  }

  /**
   * Returns increments newest-first.
   */
  public getIncrements(): readonly LogIncrement[] {
    return this.increments;
  }

  public clear() {
    if (this.increments.length === 0) {
      return;
    }
    this.increments = [];
    this.onChangeEmitter.trigger();
  }

  /**
   * Convert a single durable increment into a `LogIncrement` and prepend
   * it. Skips empty deltas (no element changes).
   */
  private ingest(increment: DurableIncrement) {
    const { added, removed, updated } = increment.delta.elements;
    const entries: LogEntry[] = [];
    const counts = { create: 0, update: 0, delete: 0 };

    for (const [elementId, delta] of Object.entries(added)) {
      entries.push(
        this.makeEntry(
          "create",
          elementId,
          // for "create" the meaningful payload is the inserted values
          {},
          delta.inserted as LogPropertyMap,
        ),
      );
      counts.create += 1;
    }

    for (const [elementId, delta] of Object.entries(removed)) {
      entries.push(
        this.makeEntry(
          "delete",
          elementId,
          // for "delete" the meaningful payload is the last-known values
          delta.deleted as LogPropertyMap,
          {},
        ),
      );
      counts.delete += 1;
    }

    for (const [elementId, delta] of Object.entries(updated)) {
      entries.push(
        this.makeEntry(
          "update",
          elementId,
          delta.deleted as LogPropertyMap,
          delta.inserted as LogPropertyMap,
        ),
      );
      counts.update += 1;
    }

    if (entries.length === 0) {
      return;
    }

    const logIncrement: LogIncrement = {
      id: increment.delta.id,
      timestamp: Date.now(),
      entries,
      counts,
    };

    // newest first
    this.increments = [logIncrement, ...this.increments];

    // bound ring buffer
    if (this.increments.length > this.maxIncrements) {
      this.increments.length = this.maxIncrements;
    }

    this.onChangeEmitter.trigger();
  }

  private makeEntry(
    type: LogEntryType,
    elementId: string,
    before: LogPropertyMap,
    after: LogPropertyMap,
  ): LogEntry {
    // Element type usually only appears in the delta if it changed (rare),
    // so fall back to whichever side has it.
    const elementType =
      (after.type as string | undefined) ??
      (before.type as string | undefined);

    return {
      id: `vle-${this.nextEntrySeq++}`,
      type,
      elementId,
      elementType,
      before,
      after,
    };
  }
}
