import { Emitter } from "@excalidraw/common";

import type { DurableIncrement } from "@excalidraw/element";
import type { ExcalidrawElement } from "@excalidraw/element/types";

import { applyOpsToScene } from "./applyOps";
import { classifyEntries } from "./classify";

import type {
  LogEntry,
  LogMoment,
  LogOperation,
  LogPropertyMap,
  Remap,
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
  /**
   * The currently-selected element ids. Read at ingest time (i.e. when
   * the gesture commits), so this is the set the user directly
   * manipulated — used by the classifier to tell a driver apart from an
   * element that only followed via a hard-alignment link.
   */
  getSelectedElementIds: () => ReadonlySet<string>;
}

/**
 * Default ring-buffer size, in *moments* (not operations). Each
 * moment may carry many ops — a multi-select drag, a paste, etc.
 */
const DEFAULT_MAX_MOMENTS = 1000;

/**
 * In-memory version log. Subscribes to `Store.onDurableIncrementEmitter`
 */
export class VersionLog {
  public readonly onChangeEmitter = new Emitter<[]>();

  private moments: LogMoment[] = [];
  private readonly maxMoments: number;
  private unsubscribe: (() => void) | null = null;
  private nextEntrySeq = 0;
  /**
   * The id of the moment the document is currently at. `null` when
   * the log is empty.
   *
   * When a new moment arrives while the cursor is not at the head,
   * every moment newer than the cursor is discarded first — we
   * model this as "make a new branch and discard the old one." Real
   * branching is iteration 3+ work.
   */
  private currentMomentId: string | null = null;
  /**
   * DEBUG: dependency-highlight set, populated by the sidebar's
   * hover handler via `findDependencies`. The panel reads this to
   * tint rows that the currently-hovered op depends on. 
   * 
   * `null` when nothing is hovered. 
   * 
   * A UI affordance, so not actually part of the data model.
   */
  private dependencyHighlight: {
    hard: Set<LogOperation>;
    soft: Set<LogOperation>;
  } | null = null;
  /**
   * Click-to-filter focus. When set, the panel collapses to just the
   * ops in `ops` (the dependency neighbourhood of `focus`), with
   * `focus` styled as the anchor. 
   * 
   * `null` means no filter, so show the whole log.
   * 
   * A UI affordance, so not actually part of the data model.
   */
  private filter: {
    focus: LogOperation;
    ops: Set<LogOperation>;
  } | null = null;
  /**
   * Ids of moments the user has selectively deactivated. They
   * remain visible but are not applied to the current scene.
   */
  private inactiveMomentIds: Set<string> = new Set();
  /**
   * Scene state captured immediately BEFORE the first moment was
   * ingested. 
   * 
   * `null` until the first ingest. 
   * reset to `null` on `clear()`.
   */
  private baselineScene: Map<string, ExcalidrawElement> | null = null;
  /**
   * Ops the most recent replay had to skip because their referent
   * element / group was missing (typically because an earlier op in
   * their dependency chain is currently inactive). Per-op set; the
   * panel uses it to put a warning indicator on the row.
   */
  private skippedByReplay: Set<LogOperation> = new Set();
  /**
   * User-supplied referent remaps, keyed by ORIGINAL referent id.
   * Populated when the conflict-resolution modal submits a decision
   * ("apply move-group X to group Y instead" / "skip everything that
   * touched element X"). Read by the replay engine before every
   * referent-presence check.
   *
   * Stale-remap cleanup (when the upstream `create` / `group` becomes
   * active again, so the referent is naturally live) is deferred — for
   * v1 these remaps persist until the user explicitly clears them, or
   * until the log is cleared. See VERSION_CONTROL_PLAN.md.
   */
  private remaps: Map<string, Remap> = new Map();
  /**
   * Highest element `version` this log has ever observed.
   * Used when reconstructing the scene to ensure that the Excalidraw store
   * adopts the replayed state, since elements with lower versions could be ignored.
   */
  private highWaterVersion = 0;

  constructor(opts: { maxMoments?: number } = {}) {
    this.maxMoments = opts.maxMoments ?? DEFAULT_MAX_MOMENTS;
  }

  /**
   * Attach to Ecalidraw store's durable-increment emitter.
   * 
   * The `scene` context is used at ingest time for group detection (we need to
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
    this.moments = [];
    this.onChangeEmitter.clear();
  }

  public getMoments(): readonly LogMoment[] {
    return this.moments;
  }

  public getCurrentMomentId(): string | null {
    return this.currentMomentId;
  }

  public setCurrentMomentId(id: string | null) {
    if (this.currentMomentId === id) {
      return;
    }
    this.currentMomentId = id;
    this.onChangeEmitter.trigger();
  }

  /**
   * Move the cursor to a specific moment. Does not mutate the scene
   * but triggers `onChangeEmitter` so the panel re-renders.
   */


  public getInactiveMomentIds(): ReadonlySet<string> {
    return this.inactiveMomentIds;
  }

  /**
   * Toggle a moment between active and inactive. 
   * The scene change is the caller's responsibility
   * 
   * Note: App invokes a replay via `replayActiveOps` after this fires.
   */
  public toggleMomentActive(id: string): void {
    if (this.inactiveMomentIds.has(id)) {
      this.inactiveMomentIds.delete(id);
    } else {
      this.inactiveMomentIds.add(id);
    }
    this.onChangeEmitter.trigger();
  }

  public getBaselineScene(): ReadonlyMap<string, ExcalidrawElement> | null {
    return this.baselineScene;
  }

  /**
   * Reserve a fresh element `version` for a replay to stamp onto the
   * elements it commits. Strictly greater than every version this log
   * has observed (real edits) AND every stamp handed to a prior replay,
   * so the store's `detectChangedElements` — which gates on a strict
   * `snapshot.version < next.version` — always adopts the replayed
   * state. Called once per replay; the elements share the stamp (the
   * check is per-element, so one value clearing every element's snapshot
   * version is enough).
   */
  public reserveReplayVersion(): number {
    this.highWaterVersion += 1;
    return this.highWaterVersion;
  }

  /** Ops the most recent replay skipped due to missing referents. */
  public getSkippedByReplay(): ReadonlySet<LogOperation> {
    return this.skippedByReplay;
  }

  /**
   * Record the conflict set produced by the latest replay. Triggers
   * `onChangeEmitter` so the panel re-renders the warning indicators.
   */
  public setSkippedByReplay(skipped: Set<LogOperation>): void {
    this.skippedByReplay = skipped;
    this.onChangeEmitter.trigger();
  }

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

  public getFilter(): {
    focus: LogOperation;
    ops: Set<LogOperation>;
  } | null {
    return this.filter;
  }

  public setFilter(
    filter: { focus: LogOperation; ops: Set<LogOperation> } | null,
  ) {
    if (this.filter === filter) {
      return;
    }
    this.filter = filter;
    this.onChangeEmitter.trigger();
  }

  public getRemaps(): ReadonlyMap<string, Remap> {
    return this.remaps;
  }

  /**
   * Merge new remap entries into the map (overwriting existing keys).
   * Setting a value to `{ to: null, ... }` records an explicit "skip"
   * for that referent. Callers pass the result of one modal submission.
   */
  public addRemaps(entries: Iterable<[string, Remap]>): void {
    let changed = false;
    for (const [id, remap] of entries) {
      this.remaps.set(id, remap);
      changed = true;
    }
    if (changed) {
      this.onChangeEmitter.trigger();
    }
  }

  public clearRemaps(): void {
    if (this.remaps.size === 0) {
      return;
    }
    this.remaps.clear();
    this.onChangeEmitter.trigger();
  }

  public clear() {
    if (
      this.moments.length === 0 &&
      this.currentMomentId === null &&
      this.inactiveMomentIds.size === 0 &&
      this.baselineScene === null
    ) {
      return;
    }
    this.moments = [];
    this.currentMomentId = null;
    this.inactiveMomentIds = new Set();
    this.baselineScene = null;
    this.skippedByReplay = new Set();
    this.remaps = new Map();
    this.filter = null;
    this.highWaterVersion = 0;
    this.onChangeEmitter.trigger();
  }

  // Debug printing
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
   * On any user action: convert the resulting durable increment from Excalidraw
   * into a `LogMoment` and prepend it. 
   */
  private ingest(increment: DurableIncrement, scene: VersionLogSceneContext) {
    // Debug
    this.printIncrement(increment);

    const { added, removed, updated } = increment.delta.elements;

    // The elements that were changed in this increment
    // (in their post-changed state)
    const changedElements = increment.change.elements;

    // Track the highest element version we've seen so a later replay can
    // mark all changed elements with a higher version to ensure that
    // the Excalidraw store registers the change
    for (const el of Object.values(changedElements)) {
      if (el.version > this.highWaterVersion) {
        this.highWaterVersion = el.version;
      }
    }

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
      scene.getSelectedElementIds(),
    );

    // The classifier can empty an increment out: an increment whose only
    // content is a rebuilt-but-identical `alignments` / `gapAlignments`
    // array describes no change a user made, so it gets no Moment rather
    // than an empty card.
    if (operations.length === 0) {
      return;
    }

    const logMoment: LogMoment = {
      id: increment.delta.id,
      timestamp: Date.now(),
      operations,
      counts,
      // retained for revert / branch — see VERSION_CONTROL_PLAN.md.
      delta: increment.delta,
    };

    // First-ever ingest: capture the baseline scene by undoing this
    // moment on the current scene state. The selective-undo replay
    // starts from this baseline + forward-applies active ops.
    if (this.baselineScene == null) {
      const baseline = new Map<string, ExcalidrawElement>();
      for (const el of scene.getAllElements()) {
        baseline.set(el.id, el);
        // Seed the high-water mark from pre-existing elements too, so a
        // replay stamp dominates elements that were never edited after
        // the log started (whose only recorded version is the baseline's).
        if (el.version > this.highWaterVersion) {
          this.highWaterVersion = el.version;
        }
      }
      // `applyOpsToScene` is typed against the live scene's
      // OrderedExcalidrawElement; ExcalidrawElement is the supertype
      // and shape-compatible for the fields applyOps reads/writes.
      applyOpsToScene(
        logMoment.operations,
        baseline as unknown as Parameters<typeof applyOpsToScene>[1],
        "backward",
      );
      this.baselineScene = baseline;
    }

    // If the cursor isn't at the head when a new moment arrives,
    // every moment newer than the cursor is dropped from the log.
    // 
    // Conceptually we're starting a new branch from the cursor's position.
    if (this.currentMomentId != null) {
      const cursorIdx = this.moments.findIndex(
        (m) => m.id === this.currentMomentId,
      );
      if (cursorIdx > 0) {
        this.moments = this.moments.slice(cursorIdx);
      }
    }

    this.moments = [logMoment, ...this.moments];
    if (this.moments.length > this.maxMoments) {
      this.moments.length = this.maxMoments;
    }
    this.currentMomentId = logMoment.id;

    // Clear the filter
    this.filter = null;

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
