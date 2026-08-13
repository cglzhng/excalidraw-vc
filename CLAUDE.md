# CLAUDE.md

## This fork

This is a **fork of Excalidraw** that adds two custom systems on top of upstream:

1. **Version control / time travel** — a semantic version log built by observing the store's durable increments, with jump, selective undo (skip a change), dependency analysis, and interactive conflict resolution. See [Version control](#version-control-time-travel).
2. **Hard alignment** — a persistent "alignment lock" between elements: aligned elements move and resize together to maintain a shared edge, or a shared spacing. See [Hard alignment](#hard-alignment).

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

A persistent alignment constraint stored **as element data**, distinct from Excalidraw's transient *snapping* — but defined by the same geometry: a hard alignment is a soft edge coincidence the user has chosen to keep.

- **Data model**: `ExcalidrawElement.alignments?: readonly ElementAlignment[]` (see `packages/element/src/types.ts`). Each link is `{ elementId, axis, selfEdge, otherEdge }` — a per-axis coupling to a partner, with an edge per side so cross-edge alignment (one element's right to another's left) works. Links are symmetric (stored on both partners). Persisted through `data/restore.ts`. A pair may be linked at **several places on one axis** (same-width elements share left, centre and right); `getAlignedLinks` emits one link per shared *coordinate*, so link identity is `(partner, axis, selfEdge, otherEdge)` — never `(partner, axis)`.
- **Engine**: `packages/element/src/alignment.ts` — detection (`getAlignedLinks`, `getAlignmentGuides`), link editing (`lockAlignmentPair` / `unlockAlignmentPair` for one guide, `lockAlignments` / `unlockAlignments` for a whole selection), and the two propagators: `dragAlignedElements` (called from `dragElements.ts`) and `resizeAlignedElements` (called from `resizeElements.ts`, transitive via `floodAxis`). Partners are **translated, never resized**. The engine lives in `packages/element` because the propagators are called from there; `packages/element` can't import `snapping.ts` (a `packages/excalidraw` module), so the two systems can't be one file.
- **UI**: selecting an element shows every alignment it currently has — persisted ones solid, live soft coincidences dashed — each with a padlock at the line's midpoint. Clicking a padlock toggles that one link between soft and hard, so the indicator *is* the creation UI. There is no modal gesture. Geometry is shared between the renderer and the pointer handler via `getAlignmentGuideLines` (`renderer/renderAlignmentLocks.ts`), so a click hit-tests exactly what is drawn; both badges consume pointer-down but fire on pointer-up. **Alt+Shift+L** / the context menu strips all links from the selection (`actions/actionAlignmentLock.tsx`).
- **Anchors**: `ExcalidrawElement.alignmentLocked` marks an element that alignment must never move — toggled by the badge off its left edge (currently a hand-drawn anvil; see the deferred backlog). Test it with **`isAlignmentAnchor`**, never the raw field: upstream's `locked` implies anchoring too. Because a component moves rigidly, an anchor freezes that whole component on the shared axis (`getAlignmentLockedAxes`, applied in `dragElements.ts` *and* mirrored in `snapDraggedElements` so guides don't promise moves that can't happen).
- **Over-constrained resizes**: partners only translate, so a pair locked at two places on one axis pins that dimension. `getAlignmentResizeLockedAxes` detects this structurally (two distinct `(driver, selfEdge)` demands reaching one rigid component) and `resizeElements.ts` clamps the size rather than silently breaking an alignment.
- **Gap alignment (equal spacing)**: the ternary sibling of edge alignment, in `packages/element/src/gapAlignment.ts`. Three elements ordered along an axis with `gap(a,b) === gap(b,c)`, stored as `ExcalidrawElement.gapAlignments` — the *identical* `ElementGapAlignment` record on all three members, so a member's role is just its index in `ids` (no reciprocal form to keep in sync). Equivalent to "the middle element is centred between its neighbours", which is what the propagators solve. Detection reimplements gap enumeration because `packages/element` can't import `snapping.ts` — the same wall that keeps the two systems in separate files. **Drag** goes through `getAlignmentDragFactors`, which returns a per-element *multiple* of the drag offset rather than a set of comovers: the constraint under translation is `2·db = da + dc`, one equation per triple, solved for whichever member is still unknown. Two unknowns is under-determined and the choice there is the feel of the gesture: middle known → rigid triple (`da = dc = db`); one outer known → the middle holds still (`db = 0`) and the far outer mirrors (`dc = -da`), so both gaps close by the full drag while the element being measured against stays put. `clampDragToGapAlignments` then caps the offset at contact: each gap is affine in it, so each contributes one bound and the tightest interval around 0 wins. Crossing is forbidden because past zero the triple reorders, and equal gaps in the *new* order need the outer elements to be the same width — the constraint would still hold numerically while no longer looking like anything. Edge links always carry a factor of 1, so their rigid coupling is unchanged, and anchors / snapping's stale-point masking read the same map. **Resize** does need one: `propagateAlignmentsAfterResize` builds the edge-alignment deltas first, then `correctGapAlignments` extends the same delta maps (middle element takes half the error; failing that the movable outers share it) and iterates to a fixed point for chained triples. It is deliberately not a general constraint solver.
- **UI**: an equal-gap guide draws both its gaps as capped spans — solid hard, dashed soft — with **an equals badge on each** (`drawEqualsBadge`, not the edge guides' padlock: a padlock means "this pair is pinned", an equals sign means "these two gaps are the same size"). Two badges for one constraint, because the assertion is an equality *between* the two gaps, and because the single natural midpoint is already the anchor anvil's spot. Both gaps draw on one shared perpendicular coordinate (`GapAlignmentGuide.across`, the three-way overlap), matching where upstream's transient gap snap line sits.
- **Version-log integration**: lock/unlock is an `alignment` op, anchoring is an `alignment-anchor` op; alignment-induced moves are absorbed as `consequentOps` (see `classify.ts`). The `alignment` op carries a `field: "alignments" | "gapAlignments"` discriminator rather than splitting into two kinds — that would mean eight more exhaustive-switch arms for what is one gesture with two payloads.
