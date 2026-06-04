import { Emitter } from "@excalidraw/common";

import type { DurableIncrement } from "@excalidraw/element";
import type { ExcalidrawElement } from "@excalidraw/element/types";

import { classifyEntries } from "./classify";

import type {
  LogEntry,
  LogIncrement,
  LogOperation,
  LogPropertyMap,
} from "./types";

type DurableIncrementEmitter = Emitter<[DurableIncrement]>;

/**
 * Minimal scene access the log needs at ingest time. Kept narrow so
 * callers (App.tsx today, tests tomorrow) don't have to pass a whole
 * `Scene`. Implementations typically wrap `app.scene`.
 */
export interface VersionLogSceneContext {
  /** Returns the post-change element by id, or `undefined`. */
  getElement: (id: string) => ExcalidrawElement | undefined;
  /** Returns the iterable of all non-deleted elements in the current scene. */
  getAllElements: () => Iterable<ExcalidrawElement>;
}

/**
 * Default ring-buffer size, in *increments* (not operations). Each
 * increment may carry many ops — a multi-select drag, a paste, etc.
 */
const DEFAULT_MAX_INCREMENTS = 1000;

/**
 * In-memory version log. Subscribes to `Store.onDurableIncrementEmitter`,
 * derives raw per-element entries from each delta, then runs the
 * semantic classifier (`classifyEntries`) to produce a `LogIncrement`
 * whose `operations` are high-level: "moved group G by (dx, dy)",
 * "rotated", "restyled strokeColor", etc.
 *
 * v1: read-only + revert-to-point. When write-back beyond simple revert
 * is added (branching / merging), see `VERSION_CONTROL_PLAN.md` §
 * "Avoiding the feedback loop" for how to prevent our own programmatic
 * updates from re-entering this subscriber.
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
   * Wire this log to a store's durable-increment emitter. The `scene`
   * context is used at ingest time for group detection (we need to
   * know how many elements belong to a group, not just how many changed).
   */
  public subscribe(
    emitter: DurableIncrementEmitter,
    scene: VersionLogSceneContext,
  ): () => void {
    const off = emitter.on((increment) => this.ingest(increment, scene));
    this.unsubscribe = off;
    return off;
  }

  public destroy() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.increments = [];
    this.onChangeEmitter.clear();
  }

  /** Returns increments newest-first. */
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
   * Convert a single durable increment into a `LogIncrement` (with
   * semantic operations) and prepend it. Skips empty deltas.
   */
  private ingest(increment: DurableIncrement, scene: VersionLogSceneContext) {
    const { added, removed, updated } = increment.delta.elements;
    const changedElements = increment.change.elements;

    const rawEntries: LogEntry[] = [];
    const counts = { create: 0, update: 0, delete: 0 };

    for (const [elementId, delta] of Object.entries(added)) {
      rawEntries.push(
        this.makeEntry(
          "create",
          elementId,
          {},
          delta.inserted as LogPropertyMap,
        ),
      );
      counts.create += 1;
    }
    for (const [elementId, delta] of Object.entries(removed)) {
      rawEntries.push(
        this.makeEntry(
          "delete",
          elementId,
          delta.deleted as LogPropertyMap,
          {},
        ),
      );
      counts.delete += 1;
    }
    for (const [elementId, delta] of Object.entries(updated)) {
      rawEntries.push(
        this.makeEntry(
          "update",
          elementId,
          delta.deleted as LogPropertyMap,
          delta.inserted as LogPropertyMap,
        ),
      );
      counts.update += 1;
    }

    if (rawEntries.length === 0) {
      return;
    }

    const groupSizeCache: Map<string, number> = new Map();
    for (const el of scene.getAllElements()) {
      for (const gid of el.groupIds) {
        groupSizeCache.set(gid, (groupSizeCache.get(gid) ?? 0) + 1);
      }
    }

    const operations = classifyEntries(
      rawEntries,
      changedElements,
      groupSizeCache,
    );

    const logIncrement: LogIncrement = {
      id: increment.delta.id,
      timestamp: Date.now(),
      operations,
      counts,
      // retained for revert / branch — see VERSION_CONTROL_PLAN.md.
      delta: increment.delta,
    };

    // newest first
    this.increments = [logIncrement, ...this.increments];
    if (this.increments.length > this.maxIncrements) {
      this.increments.length = this.maxIncrements;
    }

    this.onChangeEmitter.trigger();
  }

  private makeEntry(
    type: LogEntry["type"],
    elementId: string,
    before: LogPropertyMap,
    after: LogPropertyMap,
  ): LogEntry {
    const elementType =
      (after.type as string | undefined) ?? (before.type as string | undefined);

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

// Re-export so downstream code (e.g. the panel) can use the helper
// without importing from `./types` separately.
export type { LogOperation };
