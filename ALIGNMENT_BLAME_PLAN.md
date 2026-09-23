# Plan: constraint provenance in the alignment solver

## Why

The UI keeps asking questions of the shape "*which alignments* are doing
this?" — which ones refuse a gesture, which ones made a partner stretch,
which ones are load-bearing enough to draw. The solver knows all of it
exactly and reports none of it: a row goes in as an anonymous array of
coefficients, and what comes back is a displacement per element.

So each question has been answered twice — once by the solve, once by a
second model of the same constraints sitting beside it. The current refusal
overlay is that second model: a breadth-first walk from the gesture to the
refusing anchors (`alignmentPathToAnchors`), plus heuristics patching the
places where it disagrees with the solve. Both bugs found within a day of
writing it are the approximation showing through:

- a pair coupled on **both** axes lit the axis that was working, because the
  refusing anchors were a union rather than per axis;
- a gap chain lit during a *vertical* resize, because "x moved nothing" was
  read as "x was refused" rather than "x was never involved".

Each was patched — per-axis anchors, "two members of a chain, not one". Both
patches are rules about constraints that the reducer already decides properly.

The fix is to have rows carry where they came from, and to report what the
solve already establishes.

## What the solve already knows

- **The row reducer** classifies every row as `kept`, `redundant` or
  `inconsistent`. Inconsistent means: this row contradicts the ones before
  it. The elimination that discovered it *is* the proof — the multipliers it
  used name the earlier rows involved.
- **Row order is already deliberate.** The gesture goes in first, "so that an
  anchor or a link contradicting it is reported as contradicting *it*". A
  witness therefore comes out as "your gesture, against these constraints",
  which is the sentence the UI wants.
- **The KKT solve produces multipliers** (the `λ` block) alongside the
  displacements. A row with a non-zero multiplier is doing work: it is what
  stops the objective moving the answer somewhere cheaper. A row with a zero
  multiplier is satisfied without effort. That is an exact answer to "which
  alignments is this gesture enforcing", which the renderer currently
  approximates with "both ends of the link are in the movers set".

## The design

### A constraint reference

Every row gets a tag naming the thing it came from:

```ts
type ConstraintRef =
  | { kind: "driver"; elementId: string }
  | { kind: "link"; axis; selfId; selfEdge; elementId; otherEdge }
  | { kind: "chain"; axis; ids: readonly string[]; at: number }
  | { kind: "anchor"; elementId: string }
  | { kind: "rigid"; elementId: string }
  | { kind: "feel"; rule: keyof typeof ALIGNMENT_FEEL_ROWS; chainIds };
```

Link and chain refs are the identities the renderer already draws by, so a
blamed row maps onto a guide line without a second lookup. `rigid` and
`anchor` name an element rather than a line, which is what the anvil (and, for
a rotated or text element, some new cue) would point at.

### The witness

`add` keeps, for each stored reduced row, the combination of *original* rows
it was built from. When an incoming row reduces to `0 = non-zero`, the
combination that produced it names the conflicting set. `add` returns that
set with the `inconsistent` status; `solve` collects it as `refusedBy:
ConstraintRef[]`.

Cost: one coefficient vector per row, updated alongside the row itself —
`O(rows²)` memory and the same work again per elimination, on systems of a few
dozen rows.

The witness is *a* conflicting set, not necessarily the smallest one. It is
minimal in the useful sense — every row in it took part in the elimination —
but a differently ordered reduction could name a different set. That is
acceptable, and better than today's shortest-path tie-break, which picks by
graph distance rather than by what the algebra actually used.

### The active set

After the KKT solve, report the rows whose multiplier exceeds a tolerance as
`activeConstraints: ConstraintRef[]`. Scale matters: multipliers carry the
objective's units, so the tolerance is relative to the largest of them rather
than absolute.

## Stages

Stages 1–3 and 5–6 are **done**, along with clamp blame, redundancy and
rigidity reporting from the list below. Stage 4 is open: it changes which
guides are drawn, so it wants looking at rather than just building.

1. **Tag the rows.** `ConstraintRef` and a parallel array in the reducer.
   Nothing reads it yet; the solve's answers are unchanged.
2. **Witness on inconsistency.** Track combinations, return the conflicting
   refs, expose `refusedBy` on the refused response. Tests: an anchor linked
   directly to the driver names the link and the anchor, and nothing else; a
   pair coupled on both axes names only the refusing axis's link.
3. **Refusal UI reads it.** The drag path takes `refusedBy` straight from the
   solve. `App.maybeHandleResize` publishes it per axis. The renderer flashes
   the lines whose identity is in the set.
   *Deletes:* `alignmentPathToAnchors`, `AlignmentDragMovers.blocked`, the
   per-axis anchor plumbing added for it, and both heuristics.
4. **Multipliers.** Report `activeConstraints`; switch the enforced-guide
   filter to it. *Deletes:* the "both ends are in the movers set" rule, which
   is a guess at exactly this.
5. **Blame without re-solving.** `blockers` and `alignmentAnchorsInPlay` are
   release-and-retest: one extra solve per anchor. The anchor rows in
   `refusedBy` are the blockers; the anchor rows in `activeConstraints` are
   the ones in play. *Deletes:* two loops of re-solves — also the largest
   per-frame cost in the engine.
6. **"Why did this stretch."** `stretchers` already names the elements; the
   active anchor or rigidity rows adjacent to one name the reason. This is the
   deferred backlog item, and after stage 4 it is a rendering job only.

Stages 1–3 are the fix. 4–6 are what having provenance makes cheap, and each
stands alone.

## Also worth supporting

Collected while looking at what else the rows could answer.

All of these are now reported by the solve (or, for the clamps, by the clamp),
and none is drawn yet: the data comes first so a cue can be designed against
something real.

- **Redundancy.** The reducer already reports `redundant`, and throws it away.
  Recorded with provenance it would say "this alignment is implied by the
  others" — a link that could be released without changing anything, which is
  worth knowing when a scene has accumulated more constraints than the user
  can keep track of. It also affects blame: a redundant duplicate of a blamed
  row is equally responsible and would currently go unnamed, so it should
  attach to whichever kept row implied it.
- **Clamp blame.** `clampDragToGapAlignments` and `clampSizeToAlignments`
  compute a bound per gap and per stretched extent, then take the tightest.
  The winner is why the gesture stopped where it did, and it is dropped. The
  same cue that flashes a refusal could mark the gap that is at contact.
- **Rigidity reporting.** Whether the rows leave any freedom at all (nVars
  minus rank) says whether an arrangement is fully pinned. A scene the user
  has over-constrained without noticing is worth being able to say out loud.
- **Explain on hover.** With refs on rows, hovering a badge could highlight
  every element its constraint reaches — the constraint's own footprint rather
  than the pair it is stored on.
- **What to release.** The anchors in `refusedBy` are exactly the set whose
  release would make the gesture possible: "hold Alt to override" or a
  one-click release could be offered from it, rather than leaving the user to
  find the anvil themselves.

## Risks and things to watch

- **`appState` shape change.** The resize path must publish blamed constraint
  identities per axis, replacing `alignmentResizeAnchorIds`'s flat array.
  That invalidates the ~115 `appState` snapshots again. Unavoidable on any
  version of this; worth doing in one go with stage 3.
- **Tolerances.** Both the witness (is this residual really non-zero?) and the
  active set (is this multiplier really non-zero?) need scale-relative
  thresholds. The existing `ROW_EPSILON` is absolute because row coefficients
  are 0, ±½ or ±1 by construction; neither of the new quantities has that
  property.
- **Order dependence.** Reordering the rows changes which conflicting set
  comes back. The gesture-first order must stay, and the tests should assert
  the *contents* of a witness on scenes where it is unambiguous rather than
  its order.
- **Feel rows.** A declined feel rule is not a refusal and must never appear
  in `refusedBy`; `addAll` rolls back, so its witness is discarded. Worth a
  test, since the failure would be silent and confusing — flashing a rule the
  user cannot see or edit.
