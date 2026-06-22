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
 * callers don't have to pass a whole
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

  private increments: LogIncrement[] = [];
  private readonly maxIncrements: number;
  private unsubscribe: (() => void) | null = null;
  private nextEntrySeq = 0;
  /**
   * The increment id the document is currently at — i.e. the latest
   * increment whose effects are visible on the canvas. `null` when
   * the log is empty.
   *
   * Updated by `ingest` (set to the newly-arrived increment's id) and
   * by `App.jumpToVersionLogIncrement` (set to the navigated target).
   *
   * When a new increment arrives while the cursor is not at the head,
   * every increment newer than the cursor is discarded first — we
   * model this as "make a new branch and discard the old one." Real
   * branching is iteration 3+ work.
   */
  private currentIncrementId: string | null = null;
  /**
   * DEBUG: dependency-highlight set, populated by the sidebar's
   * hover handler via `findDependencies`. The panel reads this to
   * tint rows that the currently-hovered op depends on. `null` when
   * nothing is hovered. Not part of the data model proper — purely
   * a UI affordance for previewing selective-undo blast radius.
   */
  private dependencyHighlight: {
    hard: Set<LogOperation>;
    soft: Set<LogOperation>;
  } | null = null;

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

  public getIncrements(): readonly LogIncrement[] {
    return this.increments;
  }

  /**
   * Id of the increment the document is currently at. `null` if the
   * log is empty. The panel uses this to render the "Current" marker
   * and to disable the Jump button on the matching row.
   */
  public getCurrentIncrementId(): string | null {
    return this.currentIncrementId;
  }

  /**
   * Move the cursor to a specific increment. Does not mutate the scene 
   * but triggers `onChangeEmitter` so the panel re-renders.
   */
  /**
   * Current dependency-highlight set, or `null` if nothing is being
   * hovered. The sidebar pushes this via `setDependencyHighlight`.
   */
  public getDependencyHighlight(): {
    hard: Set<LogOperation>;
    soft: Set<LogOperation>;
  } | null {
    return this.dependencyHighlight;
  }

  public setDependencyHighlight(
    deps: { hard: Set<LogOperation>; soft: Set<LogOperation> } | null,
  ) {
    // Cheap pointer equality is fine here — the sidebar always
    // creates a fresh object per hover, so identity-comparing avoids
    // a re-render only in the "still null" case.
    if (this.dependencyHighlight === deps) {
      return;
    }
    this.dependencyHighlight = deps;
    this.onChangeEmitter.trigger();
  }

  public setCurrentIncrementId(id: string | null) {
    if (this.currentIncrementId === id) {
      return;
    }
    this.currentIncrementId = id;
    this.onChangeEmitter.trigger();
  }

  public clear() {
    if (this.increments.length === 0 && this.currentIncrementId === null) {
      return;
    }
    this.increments = [];
    this.currentIncrementId = null;
    this.onChangeEmitter.trigger();
  }

  private printIncrement(increment: DurableIncrement) {
    const { added, removed, updated } = increment.delta.elements;
    const addedIds = Object.keys(added);
    const removedIds = Object.keys(removed);
    const updatedIds = Object.keys(updated);
    if (
      addedIds.length === 0 &&
      removedIds.length === 0 &&
      updatedIds.length === 0
    ) {
      return;
    }
    // eslint-disable-next-line no-console
    console.groupCollapsed(
      `[version-log] +${addedIds.length} ~${updatedIds.length} -${
        removedIds.length
      } @ ${new Date().toISOString()}`,
    );
    // eslint-disable-next-line no-console
    console.log("added:", added);
    // eslint-disable-next-line no-console
    console.log("updated:", updated);
    // eslint-disable-next-line no-console
    console.log("removed:", removed);
    // eslint-disable-next-line no-console
    console.log("full increment:", JSON.stringify(increment));
    // eslint-disable-next-line no-console
    console.groupEnd();
  }

  /**
   * Convert a single durable increment into a `LogIncrement` (with
   * semantic operations) and prepend it. Skips empty deltas.
   */
  private ingest(increment: DurableIncrement, scene: VersionLogSceneContext) {
    // [version-log] temporary console logger for inspecting delta shape.
    // Kept for debugging; safe to remove once the feature is stable.
    this.printIncrement(increment);

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

    // Branch-discard semantics: if the cursor isn't at the head when a
    // new increment arrives, every increment newer than the cursor is
    // dropped from the log. Conceptually we're starting a new branch
    // from the cursor's position and abandoning the old future. (Real
    // branching: iteration 3+.)
    if (this.currentIncrementId != null) {
      const cursorIdx = this.increments.findIndex(
        (inc) => inc.id === this.currentIncrementId,
      );
      if (cursorIdx > 0) {
        this.increments = this.increments.slice(cursorIdx);
      }
    }

    // newest first
    this.increments = [logIncrement, ...this.increments];
    if (this.increments.length > this.maxIncrements) {
      this.increments.length = this.maxIncrements;
    }
    this.currentIncrementId = logIncrement.id;

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
