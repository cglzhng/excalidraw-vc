# Plan: Version Control / Audit Log Feature

Excalidraw already has a delta-based change system (used by undo/redo and collab). We can piggyback on it rather than instrumenting create/edit/delete separately.

## Strategy

Subscribe a new `VersionLog` to the existing `store.onStoreIncrementEmitter`. Each emitted increment already contains a structured `ElementsDelta` with `added`, `removed`, and `updated` element changes — exactly what an audit log needs. No need to touch `mutateElement`, `Scene.insertElementsAtIndex`, or the delete action.

## Files to create

1. **`packages/excalidraw/versionLog/VersionLog.ts`** — new class. Subscribes to the store emitter, converts each `Increment` into log entries `{ timestamp, type: 'create'|'update'|'delete', elementId, elementType, before?, after? }`, holds them in memory with a bounded ring buffer.
2. **`packages/excalidraw/versionLog/types.ts`** — `LogEntry`, `LogQuery`.
3. **`packages/excalidraw/components/VersionLogPanel.tsx`** — UI panel (sidebar or modal) listing entries with filters and a "restore to this point" affordance.
4. **`packages/excalidraw/versionLog/persistence.ts`** *(optional)* — serialize to IndexedDB so history survives reloads. Mirror the pattern in `excalidraw-app/data/LocalData.ts`.

## Files to edit

1. **`packages/excalidraw/components/App.tsx`** — around line 3137 where `onDurableIncrementEmitter.on(...)` is already wired for `history.record`. Instantiate `VersionLog` and subscribe it the same way. Expose via app state / context so the panel can read it.
2. **`packages/excalidraw/appState.ts`** — add `openSidebar` / UI flag for the new panel (e.g. `"version-log"`), if rendering it as a sidebar tab.
3. **`packages/excalidraw/actions/`** — add `actionToggleVersionLog.ts` and register it in the actions index, so the panel can be opened from the menu / keyboard.
4. **`packages/excalidraw/components/LayerUI.tsx`** *(or equivalent main UI shell)* — mount `<VersionLogPanel>` and a menu item.
5. **`packages/excalidraw/index.tsx`** — if exposing the log to library consumers, export the types and a `getVersionLog()` ref method.
6. **`packages/excalidraw/tests/`** — add tests verifying that create / edit / delete each produce a single correctly-typed log entry.

## Key files to read first (no edits yet)

- `packages/element/src/store.ts` — understand `Increment`, `DurableIncrement` vs `EphemeralIncrement` (you likely want only durable ones to avoid logging every drag-tick).
- `packages/element/src/delta.ts` — `ElementsDelta` shape; this is your log payload source.
- `packages/excalidraw/history.ts` — the existing subscriber is the template to copy.

## Design decisions to confirm before coding

- **Durable vs ephemeral** — log only committed changes (durable), or every intermediate mutation? Durable is almost certainly what you want.
- **Storage** — in-memory only, IndexedDB, or push to a server?
- **Granularity** — one entry per element per increment, or one entry per increment? Per-element is more useful but noisier on multi-select ops.
- **Restore semantics** — read-only log, or also a "revert to this point" button? The latter is essentially `history.redo/undo` over arbitrary distances and is non-trivial. See "Avoiding the feedback loop" below — this is the main design constraint once writes are added.

## Avoiding the feedback loop (revert / branch / merge)

Once `VersionLog` starts programmatically updating the scene (revert-to-point, branch apply, merge), those updates will themselves flow through the store. Whether they re-enter our subscriber depends entirely on the `CaptureUpdateAction` we use when applying them. The store dispatches in `processAction` (`packages/element/src/store.ts:317`):

- `CaptureUpdateAction.IMMEDIATELY` → emits on `onDurableIncrementEmitter` (would re-trigger VersionLog)
- `CaptureUpdateAction.NEVER` → emits only on the ephemeral emitter, **skips the durable channel entirely**
- `CaptureUpdateAction.EVENTUALLY` → ephemeral, snapshot deferred

Excalidraw's own undo/redo faces the same problem and solves it by tagging: `history.record()` (`packages/excalidraw/history.ts:117`) early-returns when it sees a `HistoryDelta` instance come back. Note that undo/redo still emits durably on purpose (`history.ts:199`, "for sync purposes") so collab peers see the change.

### Recommended approach

**v1 (read-only log):** no writes yet, no loop possible — defer the decision.

**v2 (revert-to-point):** apply with `CaptureUpdateAction.NEVER`. Simplest, guaranteed loop-free, no subclassing. Trade-off: collab peers will not see the revert via the durable channel. Acceptable for a local-only feature; revisit if/when this needs to sync.

**v3 (branching / merging, or if multiplayer sync becomes a requirement):** mirror history's pattern — subclass `StoreDelta` as `VersionLogDelta` (or attach a sentinel flag) and early-return in our subscriber when we see one of our own deltas come back. Preserves durable emission so collab and undo/redo still observe the change.

When implementing the "restore" affordance, the subscriber added in `App.tsx` must include this guard before recording a log entry, regardless of which option is chosen.

## Relevant existing code (chokepoints)

- **Element creation** — `Scene.insertElementsAtIndex()` at `packages/element/src/Scene.ts:342`, which calls `Scene.replaceAllElements()` at line 271. Single chokepoint for all adds.
- **Element mutation** — `Scene.mutateElement()` at `packages/element/src/Scene.ts:411`, wrapping low-level `mutateElement()` at `packages/element/src/mutateElement.ts:37`. All edits flow through here.
- **Element deletion** — `actionDeleteSelected` at `packages/excalidraw/actions/actionDeleteSelected.tsx:39` sets `isDeleted: true` via `newElementWith()` at `packages/element/src/mutateElement.ts:146`. Soft-delete, no array removal.
- **Existing subscriber pattern** — `packages/excalidraw/components/App.tsx:3137-3145`:
  ```
  onDurableIncrementEmitter.on((increment) => {
    history.record(increment.delta);
  })
  ```
  The new `VersionLog` subscribes the same way.
