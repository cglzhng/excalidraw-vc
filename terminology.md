# Terminology

Here we define some of the terms used in this project. Terms are grouped by concern.

---

## Excalidraw terms

These are terms from the original Excalidraw project. 

### Scene
The full set of elements currently in the document, plus the state needed to render and edit them — effectively, "the drawing." Managed by Excalidraw's `Scene` (reachable as `app.scene`).

### Element
A single object on the canvas: rectangle, ellipse, diamond, arrow, line, freedraw, text, image, frame, etc. (`ExcalidrawElement`). Every element has a stable `id` and common fields such as `x`, `y`, `width`, `height`, `angle`, and `groupIds` (the groups it belongs to). Entries and operations are keyed by element id.

### Canvas
The surface elements are rendered onto. Excalidraw draws in layers; the **interactive canvas** is the overlay used for selection outlines and other transient UI, and it's where the version log's **hover preview** ghost is drawn.

### Store
Excalidraw's change-tracking layer. It snapshots element state, computes the diff on each commit, and emits it as a **durable increment**. Our version log subscribes to that stream (`Store.onDurableIncrementEmitter`) and wraps each one as a **moment**.

### Durable increment
Excalidraw's own unit of committed change from the **store** (`DurableIncrement`), carrying the `StoreDelta`. Each one becomes one of our **moments**. (This is Excalidraw's "increment"; our wrapper is a **moment**, a deliberately different word.)

### Delta / StoreDelta
`StoreDelta` is the diff between two store snapshots. Its `elements` field splits changes into `added`, `removed`, and `updated`, each mapping an element id to a per-element `Delta` with `deleted` (before) and `inserted` (after) property maps. A `StoreDelta` can be inverted (`StoreDelta.inverse`) to undo a change. 

### Sidebar (panel)
Excalidraw's docked side panel. The version log is one tab in the default sidebar (`DefaultSidebar`), rendered by `VersionLogPanel`. "The panel" throughout this doc refers to that tab.

### Binding (arrow)
The link between an arrow endpoint and a bindable element (`startBinding` / `endBinding`, a `FixedPointBinding`). When the bound element moves, the arrow's geometry recomputes.

### Bindable element
An element an arrow can attach to (rectangle, ellipse, etc.), as opposed to the arrow itself.

---

## Core data model

### Version log
The in-memory history of everything that has happened to the scene, newest-first. Owned by the `VersionLog` class
(`versionLog/VersionLog.ts`). It subscribes to the store's durable increments, classifies each into semantic operations, and exposes them to the sidebar panel. 

### Moment
One atomic entry in the log — the unit the user thinks of as "a single change." (We deliberately avoid Excalidraw's word "increment" here: our moment is a user-facing wrapper, not the same thing.) Corresponds to one Excalidraw `DurableIncrement` (one store commit) and is stored as a `LogMoment`: an id, a timestamp, the list
of `operations` derived from it, and the raw `delta` it came from. A single moment can hold many operations (a multi-select drag, a paste, a group move).

### Operation (op)
A semantic, human-readable description of part of a moment — "moved rectangle by (12, 8)", "grouped 3 elements", "bound arrow start." Modeled as the `LogOperation` discriminated union (`kind: "move"`, `"move-group"`, `"resize"`, `"rotate"`, `"restyle"`, `"create"`, `"delete"`, `"group"`, `"ungroup"`, the `arrow-*` kinds, and `raw`). Operations are what the sidebar renders as rows and what dependency analysis and replay reason about.

### Entry
A raw, *unclassified* per-element change straight out of the store
delta (`LogEntry`): an element id, a `type` (create/update/delete), and
`before` / `after` property maps. Entries are the classifier's input;
`operations` are its output. When the classifier can't recognize a
pattern, the entry survives as a `raw` operation so nothing is lost.

### Referent
The element or group an operation acts on and therefore depends on
existing — e.g. the rectangle a `move` moves, or the group a
`move-group` transforms. If an op's referent is missing at replay time,
the op can't apply (see **Conflict**).

### Baseline (baseline scene)
The snapshot of the scene captured immediately *before* the first
moment was ingested. Replay reconstructs the canvas by starting from
the baseline and forward-applying operations. `null` until the first
edit; reset on `clear()`.

---

## Navigation & editing actions

### Cursor (current moment)
The moment the document is currently "sitting at" — the latest one
whose effects are visible on the canvas. Tracked as
`currentMomentId`. The sidebar marks it with a **Current** badge.

### Jump
Move the document to a chosen moment — forward or backward along the
timeline — without deleting history. Reconstructs the scene at that
point by replaying operations from the baseline. Triggered by the
**Jump** button on a non-current card
(`App.jumpToVersionLogMoment`).

### Skip / Restore
Selectively deactivate ("Skip") or reactivate ("Restore") a single
moment *in place*, leaving it in the log but excluding its operations
from replay. The default model is "active unless skipped" — only the
exceptions (`inactiveMomentIds`) are tracked. Skipping is how the
user removes one change from the middle of history without touching the
changes around it.

### Selective undo
The capability that Skip enables: undoing a specific change in the
middle of the history while keeping later changes, rather than undoing
strictly newest-first. Implemented by replay over the active subset of
operations.

### Branch / branch-discard
Branching is the (future) ability to fork history. Today only
*branch-discard* exists: if a new edit arrives while the cursor is not
at the head, every moment newer than the cursor is dropped — we
conceptually start a fresh branch from the cursor and abandon the old
future. Real branching is later work.

---

## Replay & selective undo

### Replay
Rebuilding the scene by starting from the **baseline** and applying
operations in order — forward or backward — up to the cursor, skipping
inactive moments and honoring **remaps**. The core of selective undo
and jump (`replay.ts` → `replayActiveOps`; application in
`applyOps.ts`). Replay is deliberately "dumb": it replays recorded
facts and knows nothing about Excalidraw's own binding/geometry engine.

### Apply (forward / backward)
Executing one operation against a scene snapshot. **Forward** performs
the op as it originally happened (move by +dx, set angle to `to`, etc.);
**backward** inverts it (move by −dx, set angle to `from`). Used to walk
the timeline in either direction.

### Consequential change / consequent ops
A change that happened only as a *side effect* of another operation in
the same moment — most commonly a bound arrow's geometry shifting
because the element it's bound to moved. Semantically it's one user
action, so the follow-on is not shown as its own row; instead it's
classified into its own `LogOperation`s and stashed on the causing op as
`consequentOps`, to be replayed alongside it. See `classify.ts` and
`applyConsequentOps` in `applyOps.ts`.

---

## Conflicts & resolution

### Conflict
A situation where an operation can't be applied during replay because a
**referent** it needs is missing — typically because an earlier
`create` or `group` op was skipped. Surfaced to the user for a decision
rather than silently dropped.

### Hard vs soft (conflict / dependency)
- **Hard**: removing the earlier op makes the later op *impossible* to
  apply — its referent element/group wouldn't exist.
- **Soft**: the later op still applies, but onto a *different baseline*
  than it originally expected (it read a `from`/`before` value that an
  earlier op had established), so the visual result may differ.

### Pending conflict
An unresolved hard conflict, grouped by the missing referent so the user
resolves it once per referent rather than once per affected op
(`PendingConflict`). Drives the conflict-resolution modal.

### Skipped (by replay)
The set of operations the most recent replay couldn't apply because a
referent was missing (`skippedByReplay`). The sidebar puts a ⚠ warning
icon on these rows. Distinct from a user **Skip**, which deactivates a
whole moment on purpose.

### Remap
A user-supplied rewrite that redirects an operation from its original
referent to a different live one — "apply this move-group to group G′
instead of the missing G" — or explicitly skips it (`to: null`). Keyed
by the *original* referent id, so one decision (G → G′) automatically
rewrites every op that referenced G. Created via the conflict modal;
read by replay before each referent check (`remap.ts`).

---

## Dependencies & filtering

### Dependency
An earlier operation that a given op relies on. `findDependencies(op)`
walks backward and returns the **hard** and **soft** dependencies of an
op (`dependencyAnalysis.ts`).

### Dependent
The inverse of a dependency: a *later* operation that relies on a given
op. Computed by inverting the dependency edges.

### Related ops / neighbourhood
The transitive closure of an op's dependencies (upstream) *and* its
dependents (downstream), including the op itself — everything connected
to it in the dependency graph (`findRelatedOps`). This is the set the
**filter** shows.

### Filter / focus
Click-to-filter: clicking an operation ("the **focus**") collapses the
sidebar to just that op's **related ops**, hiding everything else.
Stored on the log as `filter = { focus, ops }`; cleared by the banner's
**Clear** button, by clicking the focus again, or automatically on the
next edit.

### Dependency highlight
The transient hover affordance: hovering an op tints its hard
dependencies (red) and soft dependencies (amber) so you can preview the
blast radius of skipping it. Separate from the (sticky) filter.

### Hover preview
The ghost / bounding-box the interactive canvas draws for the op under
the cursor, so you can see *where* on the canvas a log row acts
(`hoverPreview.ts`).

---

## Classification internals

### Classifier
The pass that turns raw **entries** into semantic **operations**
(`classify.ts` → `classifyEntries`). Runs pre-passes for arrow
consequences and group/ungroup detection, then per-entry classification,
then a post-pass to detect group transforms.

### Group / ungroup, group node
`group` and `ungroup` operations record the affected group as a
`GroupNode` tree (nested groups + leaf element ids) rather than a flat
list, so structure is preserved and an ungroup can be correctly redone.

### Transform matrix
The 2D affine matrix (`TransformMatrix`) describing an element's
geometric change between its before- and after-state. Used to recognize
moves/resizes/rotations and to tell whether several elements received
the *same* transform (i.e. moved as a group).

### Tracking props
Element fields that are noise for semantic classification and are
ignored (`version`, `versionNonce`, `index`, and `boundElements`).
`boundElements` is ignored because upstream Excalidraw emits it
unreliably on unbind; the arrow's own `startBinding` / `endBinding` are
treated as authoritative for binding state instead.

## Hard alignment

### Snapping (soft alignment)
Upstream Excalidraw's transient guides: while you drag, edges and gaps
that line up are highlighted and the drag is nudged onto them. Nothing
is stored — release the pointer and the relationship is forgotten.

### Hard alignment
A soft alignment the user has chosen to *keep*, persisted as element
data. Same geometry as snapping, opposite lifetime. Two kinds:

### Edge alignment
The binary kind: two elements share a coordinate on one axis
(`A.edge === B.edge`). Stored as `ExcalidrawElement.alignments`, one
`ElementAlignment` per shared coordinate, written symmetrically on both
partners. A pair can be aligned at several *places* on one axis (two
same-width elements share left, centre and right), so link identity is
`(partner, axis, selfEdge, otherEdge)` — never `(partner, axis)`.

### Gap alignment (equal spacing)
The ternary kind: three elements ordered along an axis whose two gaps
are equal, `gap(a,b) === gap(b,c)`. Stored as
`ExcalidrawElement.gapAlignments`, one `ElementGapAlignment` per triple,
the identical record written on all three members. Equivalent to "the
middle element is centred in the span between its neighbours", which is
the form the propagators solve.

### Drag factor
What each element's share of a drag is, on one axis, as a multiple of
the drag offset — the dragged elements are 1, anything absent doesn't
move. Edge alignments always pass 1 along, so everything they reach
moves rigidly. Gap alignments solve `2·db = da + dc` instead:
dragging an outer member of a triple holds the middle still and mirrors
the move onto the far outer, so both gaps close while the element being
measured against stays put. Computed by `getAlignmentDragFactors`, and
the same map answers "which elements move at all" for anchors and for
snapping.

### Driver / partner
In a resize, the element the user is resizing is the driver; anything
translated to preserve an alignment with it is a partner. Partners are
**translated, never resized** — the rule that makes over-constrained
configurations possible, and why they're refused rather than fudged.

### Anchor
An element alignment must never move (`alignmentLocked`, the anvil
badge; upstream's `locked` implies it too — test with
`isAlignmentAnchor`). Since a component moves rigidly, an anchor freezes
its whole component on the shared axis.

### Over-constrained
A configuration where no translation of the partners satisfies every
alignment at once — e.g. a pair locked at both their left and right
edges pins that dimension. Detected structurally and refused (the size
change is clamped) rather than silently dropping one alignment.
