# CLAUDE.md

## This fork

This is a **fork of Excalidraw** that adds two custom systems on top of upstream:

1. **Version control / time travel** — a semantic version log built by observing the store's durable increments, with jump, selective undo (skip a change), dependency analysis, and interactive conflict resolution. See [Version control](#version-control-time-travel).
2. **Hard alignment** — a persistent "alignment lock" between elements: aligned elements move and resize together to maintain a shared edge. See [Hard alignment](#hard-alignment).

`terminology.md` (repo root) is the glossary for both systems — read it first. `VERSION_CONTROL_PLAN.md` covers the version-control design in depth. When editing, match the surrounding code's comment density and idiom.

## Project Structure

Excalidraw is a **monorepo** with a clear separation between the core library and the application:

- **`packages/excalidraw/`** - Main React component library published to npm as `@excalidraw/excalidraw`
- **`excalidraw-app/`** - Full-featured web application (excalidraw.com) that uses the library
- **`packages/`** - Core packages: `@excalidraw/common`, `@excalidraw/element`, `@excalidraw/math`, `@excalidraw/utils`
- **`examples/`** - Integration examples (NextJS, browser script)

## Development Workflow

1. **Package Development**: Work in `packages/*` for editor features
2. **App Development**: Work in `excalidraw-app/` for app-specific features
3. **Testing**: Always run `yarn test:update` before committing
4. **Type Safety**: Use `yarn test:typecheck` to verify TypeScript

## Development Commands

```bash
yarn test:typecheck  # TypeScript type checking
yarn test:update     # Run all tests (with snapshot updates)
yarn fix             # Auto-fix formatting and linting issues
```

## Architecture Notes

### Package System

- Uses Yarn workspaces for monorepo management
- Internal packages use path aliases (see `vitest.config.mts`)
- Build system uses esbuild for packages, Vite for the app
- TypeScript throughout with strict configuration

## Version control (time travel)

Lives in **`packages/excalidraw/versionLog/`**. It observes the store rather than replacing history: `VersionLog` subscribes to `Store.onDurableIncrementEmitter`, and each durable increment becomes one **Moment** (our user-facing unit — deliberately *not* the same as Excalidraw's `DurableIncrement`; see `terminology.md`).

Key files:

- **`VersionLog.ts`** — the in-memory log. Ingests increments, holds Moments, tracks the cursor (current Moment), inactive (skipped) Moments, filters, and `onChangeEmitter` (a payload-less "something changed, re-pull" signal the sidebar subscribes to).
- **`classify.ts`** — turns raw per-element `LogEntry` deltas into semantic `LogOperation`s (move, resize, group, `arrow-bind`, `alignment`, …). Runs pre-passes for multi-entry gestures (grouping, alignment lock/unlock) and **consequence detection**: a change caused by another (a bound arrow following its element, or a hard-aligned partner following its driver) is absorbed into the causing op's `consequentOps` instead of surfacing separately — one user action, one op. `getChangedKeys` is the central key-diff chokepoint (it also drops phantom deep-equal `alignments` changes).
- **`types.ts`** — the `LogOperation` discriminated union, `LogMoment`, `getOperationElementIds`. Adding an op kind means updating every exhaustive switch (see below).
- **`applyOps.ts`** — replays a `LogOperation[]` forward/backward against a scene snapshot. Replay does **not** run Excalidraw's binding/alignment solvers — consequent ops are what reproduce dependent geometry.
- **`replay.ts`** — selective-undo engine: replays from a baseline, skipping inactive Moments; also uses `reserveReplayVersion` / `highWaterVersion` so replayed elements always out-version the store snapshot (the store gates on strict `version <`).
- **`dependencyAnalysis.ts`**, **`remap.ts`** — dependency edges between ops, and conflict remapping when a selective undo removes a referent.
- UI: **`components/VersionLogPanel.tsx`**, **`VersionLogMomentCard.tsx`** (+ `VersionLogPanel.scss`, whose `--vlog-*` custom properties are the single place to theme the panel), **`VersionControlConflictModal.tsx`**.

**Adding a `LogOperation` kind** requires updating every exhaustive `switch (op.kind)` / `Record<LogOperation["kind"], …>`: `getOperationElementIds` + `OP_COLOR` map, `applyOpToScene`, `getWrittenProperties`, `applyRemapsToOp`, `findMissingReferents`, `computeHoverPreview`, `renderOpContent`, and the conflict modal's `describeOp`.

## Hard alignment

A persistent alignment constraint stored **as element data**, distinct from Excalidraw's transient *snapping* — but created **through** snapping: hard alignment is "commit the soft snap you can already see."

- **Data model**: `ExcalidrawElement.alignments?: readonly ElementAlignment[]` (see `packages/element/src/types.ts`). Each link is `{ elementId, axis, selfEdge, otherEdge }` — a per-axis coupling to a partner, with an edge per side so cross-edge alignment (one element's right to another's left) works. Links are symmetric (stored on both partners). Persisted through `data/restore.ts`.
- **Engine**: `packages/element/src/alignmentLock.ts` — detection (`getAlignedLinks`), link editing (`lockDraggedAlignments` for the drag gesture, `lockAlignments` for within-selection, `unlockAlignments`), and the two propagators: `dragAlignedElements` (called from `dragElements.ts`) and `resizeAlignedElements` (called from `resizeElements.ts`, transitive via `floodAxis`). Partners are **translated, never resized**. The engine lives in `packages/element` because the propagators are called from there; `packages/element` can't import `snapping.ts` (a `packages/excalidraw` module), so the two systems can't be one file — the *decision* to lock is co-located with snapping in the App pointer-up handler + `isSnappingEnabled`.
- **Trigger**: **Alt+drag**. Holding Alt while dragging forces snapping on (`isSnappingEnabled` in `snapping.ts`); on pointer-up, `App.tsx` commits the elements' current soft snaps to persistent links via `lockDraggedAlignments`. (This repurposes Alt, so upstream's alt-drag-to-duplicate is disabled via `ALT_DRAG_DUPLICATES`.) **Alt+Shift+L** unlocks the selection (`actions/actionAlignmentLock.tsx`).
- **Indicator**: `renderer/renderAlignmentLocks.ts` draws a dashed indigo line on the shared edge of a selected linked element (mirrors `renderSnaps`).
- **Version-log integration**: lock/unlock is an `alignment` op; alignment-induced moves are absorbed as `consequentOps` (see `classify.ts`).
