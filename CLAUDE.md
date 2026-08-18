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
- **`classify.ts`** — turns raw per-element `LogEntry` deltas into semantic `LogOperation`s (move, resize, group, `arrow-bind`, `alignment`, …). Runs pre-passes for multi-entry gestures (grouping, alignment lock/unlock) and **consequence detection**: a change caused by another (a bound arrow following its element, or a hard-aligned partner following its driver) is absorbed into the causing op's `consequentOps` instead of surfacing separately — one user action, one op. `getChangedKeys` is the central key-diff chokepoint. Phantom link changes — `alignments` / `gapAlignments` rebuilt into an equal array, which the store diffs by reference and so reports as changed — are stripped from the entries themselves by `stripPhantomLinkChanges` before any classifier runs, so the `raw` op's property list never shows them either; an increment left with nothing real gets no Moment at all. The same pre-pass folds a bound text's derived `fontSize` onto its `authoredFontSize` (see [Bound-text auto-fit](#bound-text-auto-fit)), so the log reports the size the user picked and auto-fit churn disappears.
- **`types.ts`** — the `LogOperation` discriminated union, `LogMoment`, `getOperationElementIds`. Adding an op kind means updating every exhaustive switch (see below).
- **`applyOps.ts`** — replays a `LogOperation[]` forward/backward against a scene snapshot. Replay does **not** run Excalidraw's binding/alignment solvers — consequent ops are what reproduce dependent geometry.
- **`replay.ts`** — selective-undo engine: replays from a baseline, skipping inactive Moments; also uses `reserveReplayVersion` / `highWaterVersion` so replayed elements always out-version the store snapshot (the store gates on strict `version <`).
- **`dependencyAnalysis.ts`**, **`remap.ts`** — dependency edges between ops, and conflict remapping when a selective undo removes a referent.
- UI: **`components/VersionLogPanel.tsx`**, **`VersionLogMomentCard.tsx`** (+ `VersionLogPanel.scss`, whose `--vlog-*` custom properties are the single place to theme the panel), **`VersionControlConflictModal.tsx`**.

**Adding a `LogOperation` kind** requires updating every exhaustive `switch (op.kind)` / `Record<LogOperation["kind"], …>`: `getOperationElementIds` + `OP_COLOR` map, `applyOpToScene`, `getWrittenProperties`, `applyRemapsToOp`, `findMissingReferents`, `computeHoverPreview`, `renderOpContent`, and the conflict modal's `describeOp`.

## Bound-text auto-fit

Upstream grows a *container* when its bound text no longer fits — whether the text grew (typing) or the box shrank (resize). That turns a one-axis resize into a two-axis one and lets a label overrule a size the user set. This fork inverts it: the **text** is refitted instead, by font size.

- **`fitBoundTextToContainer`** (`packages/element/src/textElement.ts`) is the single answer to "what font size fits?". Wrapped width and height are both monotone in font size, so it bisects between `MIN_FONT_SIZE` and the authored size. Three outcomes: `fits`, `refit` (write these values), `overflows` (no allowed size fits).
- **`ExcalidrawTextElement.authoredFontSize`** is the size the user chose; `fontSize` is derived from it and the container's size. Recorded from the first fit onward and never cleared — measuring against it is what lets a shrunk text grow back. Picking a size in the UI writes both (`actionProperties.tsx`).
- Called from three places, all of which used to grow the box: `handleBindTextResize` (resize), `refreshTextDimensions` (live typing — `redrawTextBoundingBox` only runs on submit, so the live path is the one that matters), and `redrawTextBoundingBox` itself. Each runs on *every* pass, not just overflowing ones, since growing back needs a trigger too. The old growth branches remain as the `overflows` fallback.
- `resizeSingleElement` refuses a frame whose proposed size `overflows`, holding the element at its current size — which is the last one that fit, since every earlier frame passed the same check. Arrow labels are excluded throughout: their box is a fraction of the arrow, not a size anyone set.

## Hard alignment

A persistent alignment constraint stored **as element data**, distinct from Excalidraw's transient *snapping* — but defined by the same geometry: a hard alignment is a soft edge coincidence the user has chosen to keep.

- **Data model**: `ExcalidrawElement.alignments?: readonly ElementAlignment[]` (see `packages/element/src/types.ts`). Each link is `{ elementId, axis, selfEdge, otherEdge }` — a per-axis coupling to a partner, with an edge per side so cross-edge alignment (one element's right to another's left) works. Links are symmetric (stored on both partners). Persisted through `data/restore.ts`. A pair may be linked at **several places on one axis** (same-width elements share left, centre and right); `getAlignedLinks` emits one link per shared *coordinate*, so link identity is `(partner, axis, selfEdge, otherEdge)` — never `(partner, axis)`.
- **Engine**: `packages/element/src/alignment.ts` — detection (`getAlignedLinks`, `getAlignmentGuides`), link editing (`lockAlignmentPair` / `unlockAlignmentPair` for one guide, `lockAlignments` / `unlockAlignments` for a whole selection), and the two propagators: `dragAlignedElements` (called from `dragElements.ts`) and `resizeAlignedElements` (called from `resizeElements.ts`, transitive via `floodAxis`). Partners are **translated, never resized**. The engine lives in `packages/element` because the propagators are called from there; `packages/element` can't import `snapping.ts` (a `packages/excalidraw` module), so the two systems can't be one file.
- **UI**: selecting an element shows every alignment it currently has — persisted ones solid, live soft coincidences dashed — each with a padlock at the line's midpoint. Clicking a padlock toggles that one link between soft and hard, so the indicator *is* the creation UI. There is no modal gesture. Geometry is shared between the renderer and the pointer handler via `getAlignmentGuideLines` (`renderer/renderAlignmentLocks.ts`), so a click hit-tests exactly what is drawn; both badges consume pointer-down but fire on pointer-up. **Alt+Shift+L** / the context menu strips all links from the selection (`actions/actionAlignmentLock.tsx`).
- **Anchors**: `ExcalidrawElement.alignmentLocked` marks an element that alignment must never move — toggled by the badge off its left edge (currently a hand-drawn anvil; see the deferred backlog). Test it with **`isAlignmentAnchor`**, never the raw field: upstream's `locked` implies anchoring too. Because a component moves rigidly, an anchor freezes that whole component on the shared axis (`getAlignmentLockedAxes`, applied in `dragElements.ts` *and* mirrored in `snapDraggedElements` so guides don't promise moves that can't happen). Resize is refused the same way, but the question is per-*edge* rather than per-axis: a resize moves only some of the element's edges, so `getAlignmentAnchoredResizeBlockers` freezes a dimension only when the handle actually moves an edge whose demand reaches an anchor — left-locked to an anchor, the right handle still works. It returns the blocking anchors rather than booleans so the red anvil overlay (`renderAnchorLockOverlays`) can name them; because the answer depends on the transform handle, which the renderer never sees, `App.maybeHandleResize` computes it and publishes it as `appState.alignmentResizeAnchorIds` (transient, unobserved by the store, cleared on pointer-up).
- **Over-constrained resizes**: partners only translate, so a pair locked at two places on one axis pins that dimension. `getAlignmentResizeLockedAxes` detects this structurally (two distinct `(driver, selfEdge)` demands reaching one rigid component) and `resizeElements.ts` clamps the size rather than silently breaking an alignment.
- **Gap alignment (equal spacing)**: the n-ary sibling of edge alignment, in `packages/element/src/gapAlignment.ts`. A **chain** of three or more elements ordered along an axis whose consecutive gaps are all equal, stored as `ExcalidrawElement.gapAlignments` — the *identical* `ElementGapAlignment` record on every member, so a member's role is just its index in `ids` (no reciprocal form to keep in sync). Detection reimplements gap enumeration because `packages/element` can't import `snapping.ts` — the same wall that keeps the two systems in separate files. Soft chains are reported **maximal** (`addMaximalChain` grows a seed triple outward), so four evenly spaced elements are one guide rather than the two triples inside it.
- **Gap alignment — drag**: `getAlignmentDragFactors` returns a per-element *multiple* of the drag offset rather than a set of comovers. Holding one gap equal to the next makes the factors an **arithmetic progression** along the chain, `d(i) = p + q·i` — two degrees of freedom however long the chain is, so two known members determine it and the pass fits the line through them (a third that disagrees is left alone, first-wins). One known member leaves `q` free, and that choice is the feel of the gesture: an *interior* member known → `q = 0`, the chain travels rigidly; an *end* member known → `q = ∓d`, which pins its immediate neighbour and steps the rest along, closing every gap by the full drag while the element being measured against stays put. `clampDragToGapAlignments` caps the offset at contact: each gap is affine in it, so each contributes one bound and the tightest interval around 0 wins. Crossing is forbidden because past zero the chain reorders, and equal gaps in the *new* order need the outer elements to be the same width — the constraint would still hold numerically while no longer looking like anything. Edge links always carry a factor of 1, so their rigid coupling is unchanged, and anchors / snapping's stale-point masking read the same map.
- **Gap alignment — resize**: `propagateAlignmentsAfterResize` builds the edge-alignment deltas first, then `correctGapAlignments` extends the same delta maps. Each chain is solved outright, not relaxed triple by triple — sweeping doesn't converge, since a triple that zeroes its own error undoes what its neighbour just did to the member they share, and a chain whose middle is the resized element settles into a two-cycle. Instead every gap goes to the *mean* of the current gaps (which leaves the chain's extent alone) with one member held still: the immovable one if there is one, else the average. For three elements that is exactly the old middle-takes-half rule. A second immovable member that would also have to move makes the chain unsatisfiable, and it is left out of true. The outer fixed-point loop remains, for chains sharing a member. It is deliberately not a general constraint solver — see the deferred backlog for the uncapped resize cases.
- **Gap alignment — merge**: locking a chain that continues one already locked merges them (`lockGapAlignment` → `asOneChain`), so A—B—C plus C—D—E becomes one five-member link rather than two enforced, drawn, separately-unlockable links. A candidate is absorbed only if it shares a member *and* the union is still a single evenly spaced run; the search repeats to a fixed point, since a new chain can bridge two existing ones. An existing link is replaced only when its members are a **contiguous run** of the new chain — a chain through every other element covers different gaps and survives as its own constraint. Unlocking drops the whole chain, whichever badge is clicked.
- **UI**: an equal-gap guide draws each gap as a capped span — solid hard, dashed soft — with **an equals badge on each** (`drawEqualsBadge`, not the edge guides' padlock: a padlock means "this pair is pinned", an equals sign means "these gaps are the same size"). A badge per gap, because the assertion is an equality *between* them, and because the single natural midpoint is already the anchor anvil's spot. Every gap draws on one shared perpendicular coordinate (`GapAlignmentGuide.across`), matching where upstream's transient gap snap line sits. Gap guides stay up **during a drag** — soft ones swap their badges for upstream's midpoint ticks, since there is nothing to click mid-drag — and `renderSnaps` is handed the gaps they cover so it can drop its own duplicates, which are drawn one per satisfied snap at their own perpendicular offsets. A soft chain's span is likewise suppressed where a hard chain already draws that gap, so the merge candidate shows exactly one unlocked badge on the new gap.
- **Version-log integration**: lock/unlock is an `alignment` op, anchoring is an `alignment-anchor` op; alignment-induced moves are absorbed as `consequentOps` (see `classify.ts`). The `alignment` op carries a `field: "alignments" | "gapAlignments"` discriminator rather than splitting into two kinds — that would mean eight more exhaustive-switch arms for what is one gesture with two payloads.
