# Known test failures

The upstream tests this fork fails, and why. Nearly all of them assert
upstream behaviour the fork changed on purpose, or snapshot state the fork
added to; none were introduced by the alignment solver (`91b04ac4` fails
exactly the same 234 tests as its parent).

Triaged against `91b04ac4` on 2026-09-21, then snapshots regenerated:
**94 failed, 1760 passed** across 121 files (18 failing). Every failure left
is an assertion. The per-section counts below are approximate, and sum to a
little over 94. Entries are point-in-time — when a full run disagrees with
this file, diff the failing names against it before re-triaging:

```bash
yarn test:app --watch=false --reporter=default --reporter=json --outputFile.json=test-results.json
```

Companion to `limitations.md` (behaviour the fork bounds on purpose), which
several of these are the test-side shadow of.

---

## Snapshots

Regenerated with `yarn test:update` on 2026-09-21, clearing 140 snapshot-only
failures: `appState` had gained `alignmentResizeMoverIds`,
`alignmentResizeStretchAnchorIds` and `expandedAlignmentCluster`, and
elements `shortId`. Snapshots now record the fork's behaviour, so a snapshot
that changes is a behaviour change — not evidence of anything predating
that date.

## Badges and the anvil take the press (~23)

Alignment badges, equal-gap badges, cluster badges and the anchor anvil all
consume pointer-down (see `CLAUDE.md` → Hard alignment → UI). The anvil sits
over the centre of a single selected element, and soft-guide badges sit at
guide midpoints — which, for shapes laid out corner to corner, is often
exactly where a test clicks. Confirmed by disabling the four press handlers
in `onPointerDown`: every assertion below went green except `viewMode`,
whose cursor comes from the anvil's hover rather than its press.

- `align.test.tsx` — the six "nested group while in group edit mode" tests.
  The final shift-click at (200,200) lands on two soft-guide badges.
- `frame.test.tsx` — the six "dragging elements into the frame" tests.
- `regressionTests.test.tsx` — "click to select a shape", "click on an
  element and drag it", "alt-drag duplicates an element", "shift-click to
  multiselect, then drag", "noop interaction after undo shouldn't create
  history entry" (the extra undo entry is a badge toggled soft → hard),
  "shift click on selected element should deselect it on pointer up",
  "given element A and group of elements B … when user clicks on B".
- `history.test.tsx` — "should iterate through the history when element
  changes relate only to remotely deleted elements" and "should not let
  remote changes to interfere with in progress resizing" (undo stack one
  short).
- `elementLocking.test.tsx` — "dragging element that's below a locked
  element". Not in the confirming run; same shape as the `frame` cases.
- `viewMode.test.tsx` — "cursor should stay as grabbing type": the anvil's
  hover sets `pointer`.

## Double-click no longer creates text (~27)

`handleCanvasDoubleClick` only edits text that already exists; creating it
by double-click is disabled.

- `textWysiwyg.test.tsx` — all eleven "Test container-bound text" failures.
- `drawShape.test.tsx` — all eight "autoshape double-click to type" tests;
  each creates its first text by double-click.
- `linearElementEditor.test.tsx` — "should not enter line editor on dblclick
  (arrow)", the four "should not toggle the … arrowhead … on endpoint
  dblclick", "should bind text to arrow when double clicked".
- `elementLocking.test.tsx` — "should ignore text under cursor when
  double-clicked with selection tool", "bound text shouldn't be editable via
  double-click".

## Resize clamp and bound-text auto-fit (~17)

A handle can no longer fold an element through itself (`MIN_RESIZE_EXTENT`),
and a container keeps its size while its bound text refits (see `CLAUDE.md`
→ Bound-text auto-fit).

- `resize.test.tsx` — every "flips while resizing" (eight handles, plus
  line, freedraw, image and multiple selection), "flips the fixed point
  binding on negative resize for group selection", and "resizes from center
  with multi-line label" from `n` and `s`.
- `clipboard.test.tsx` — "should fix ellipse bounding box", "should fix
  diamond bounding box": the container is no longer grown to fit.

## Arrows bind only inside a shape or at an edge midpoint (~8)

`getBindingStrategyForDraggingBindingElementEndpoints_simple` refuses
upstream's orbit binding everywhere on the outline except the four edge
midpoints, and turns the midpoints off under angle lock and grid mode.

- `binding.test.tsx` — the two "single-click finalize" self-binding tests
  (the end at 13px outside never binds, so nothing finalizes) and "should
  handle new arrow end point binding".
- `arrowBinding.test.tsx` — "does not snap angle-locked binding to grid when
  grid mode is disabled", "uses the incoming direction to choose the grid
  axis for rotated bindables".
- `stats.test.tsx` — both "binding with linear elements" tests: the arrow is
  unbound before the stats edit.
- `move.test.tsx` — "rectangles with binding arrow" (arrow height 82.3 vs
  88). Plausible rather than traced.

## Arrows have no transform handles (~4)

`getTransformHandles` returns none for any arrow; arrows are edited through
their points.

- `binding.test.tsx` — "should unbind arrow when arrow is resized", "… is
  rotated".
- `linearElementEditor.test.tsx` — "should resize and position the bound
  text and bounding box correctly when 3 pointer arrow element resized".
- `resize.test.tsx` — "arrow element > resizes with a label".

## Ctrl+drag on an element moves it (3)

Upstream box-selects when Ctrl+drag starts on an element, which is how shapes
nested inside a filled one get selected. The fork moves the element instead
(with snapping toggled); box selection starts only on empty canvas.
Introduced in `ee159f7e`.

- `selection.test.tsx` — the three "inner box-selection" tests.

## `contextmenu` finds two rectangle tools (~14)

`UI.clickTool("rectangle")` throws "Found multiple elements with tool name:
rectangle" in every test that draws through the toolbar. The fork renders a
second button with that tool name; which one is untraced.

- `contextmenu.test.tsx` — every test that clicks a tool.

## Untraced (9)

- `selection.test.tsx` — "selection element" (3) and "select single element
  on the scene" (5): `renderInteractiveScene` is called fewer times than
  upstream expects. These count repaints rather than assert behaviour.
- `MermaidToExcalidraw.test.tsx` — "should show error in preview when mermaid
  library throws error": the dialog's editor never appears. Not yet checked
  against `master`, so it may be inherited.
