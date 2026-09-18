# Plan: solver-based alignment engine

## Why

The engine today refuses gestures that are perfectly achievable, because it can
only ever *translate* the elements it moves. The goal is to invert the priority:
**the user's action wins, and everything else moves or resizes to accommodate
it.** Only anchored elements are exempt, and only strictly impossible gestures
are refused.

Concretely, the thing we cannot currently express:

> `A` is right-linked to a free `C`, and `C` is right-linked to an anchored
> `B`. Drag `A` right by `d`. `C`'s left edge must move by `d` and its right
> edge cannot move at all — so `C` shrinks by `d`, and the drag goes through.
> Today: the axis is frozen and nothing happens.

## Where the current engine stands

Three propagators with three different notions of "unsatisfiable":

- **`solveAlignmentDragFactors`** (`alignment.ts`) carries **one scalar per
  element per axis** — a multiple of the drag offset. One number can only
  describe a translation, so a drag that would need a partner to change size is
  structurally inexpressible and `getAlignmentLockedAxes` freezes the axis.
- **`propagateResizeOnAxis`** (`alignment.ts`) carries `EdgeDelta {min, max}`,
  which *can* describe a stretch, and implements move-else-stretch. But it is a
  greedy BFS that takes **first-wins** on a second demand, so it silently drops
  constraints rather than solving them.
- **`correctGapAlignments`** (`gapAlignment.ts`) handles chains in a separate
  iterative pass that relaxes every gap toward the mean and gives up after
  `MAX_GAP_CORRECTION_PASSES`.

Each refuses more than it has to:

| refusal | fires when | actually possible? |
| --- | --- | --- |
| `getAlignmentLockedAxes` | any anchor in the dragged component | often — a partner in between could stretch |
| `getAlignmentResizeLockedAxes` | a pair locked at two places on one axis | yes — the partner resizes to match |
| gap chain, two pinned members | no arithmetic progression fits | often — a free member can change width |
| `propagateResizeOnAxis`, centre demand | no stretched reading | yes, with a real solve |

## Strategy

Replace all three with one linear solve. Everything the engine constrains is
linear in per-edge displacements, so the whole thing is a small equality-
constrained least-squares problem, and the cases above stop being special.

### One representation

Per element, per axis, two unknowns: `δmin` and `δmax`, measured from the
gesture-start geometry. A translation is `δmin = δmax`; a stretch is the two
differing. This is the existing `EdgeDelta`, promoted from the resize path to
being the only currency. The drag path's scalar factor becomes the case where
the answer happens to be a translation.

### The response is linear in the gesture

Every row below is homogeneous in the driver's degrees of freedom, so the
answer is a **linear response** to the gesture and can be computed once at
pointer-down:

```
solveAlignmentResponse(driverIds, axis, elementsMap, opts)
  -> { response, feasible, blockers, stretchers }
```

`response` is `Map<id, EdgeDelta[]>` — per element, one `EdgeDelta` per driver
degree of freedom. Each frame is then a linear combination, so per-frame cost
stays O(n), exactly where today's factor map puts it.

Degrees of freedom per axis: **1 for a drag** (the offset), **2 for a resize**
(the driver's `δmin` and `δmax`). A multi-element resize is also 2, because
every member's bounds are affine in the selection box's two edges. Aspect-ratio
locking couples the *driver's* dofs across axes, not the response, so it needs
nothing here — the driver's edge deltas are still derived geometrically each
frame and then combined.

## The constraint rows

With `expr(e, "min") = δmin`, `expr(e, "max") = δmax`, and
`expr(e, "center") = (δmin + δmax) / 2`:

### Hard rows

| source | row |
| --- | --- |
| edge link `(e, f, selfEdge, otherEdge)` | `expr(e, selfEdge) - expr(f, otherEdge) = 0` |
| gap chain `ids`, for each `i <= n-3` | `(δmin[i+1] - δmax[i]) - (δmin[i+2] - δmax[i+1]) = 0` |
| anchor | `δmin = 0`, `δmax = 0` |
| driver | `δmin = dof`, `δmax = dof` (drag), or one dof each (resize) |
| cannot stretch | `δmin - δmax = 0` |

The rigidity row is how **rotation stays out of scope**: a rotated element gets
one, so it may translate but never stretch, with no special case anywhere in the
traversal. Lifting the restriction later means dropping the row and adding the
cross-axis coupling (a rotated AABB *is* linear in width and height, so it is
modellable — it just couples the two axes into one system of twice the size).

The same row covers anything else a constraint should not resize. Start with:

- `angle !== 0`
- text elements, whose wrapping would change under a width change

### Soft rows: the "feel" rules

Two behaviours of the current engine are **choices**, not consequences, and a
plain minimum-disturbance solve does not reproduce them. From `fitProgression`
(`alignment.ts`), which has three branches: two-or-more knowns is *determined*
and makes no choice; the other two are

- **end drag** — one known member, at an end of the chain: the **far end holds
  still**, so the run compresses between the two ends and every gap gives up an
  equal share.
- **interior drag** — one known member, in the interior: `q = 0`, so the chain
  **travels rigidly**.

That is the entire content of the heuristic. It fires in exactly one situation:
a gap chain with a single member driven from outside.

Without these rules, a minimum-disturbance objective picks the slope that
minimises total displacement, and that is always cheaper if the far end drifts
*backwards*:

| gesture | today | minimum-disturbance |
| --- | --- | --- |
| 3-chain, drag end by `d` | `1, ½, 0` | `1, 0.4, -0.2` |
| 4-chain, drag end by `d` | `1, ⅔, ⅓, 0` | `1, 0.571, 0.143, -0.286` |
| 4-chain, drag interior by `d` | `1, 1, 1, 1` | `1.333, 1, 0.667, 0.333` |

So the far element of a row slides *against* the drag, the run shrinks by
`1.2d` when you pushed into it by `d`, and a sideways drag of an interior
element silently squeezes the chain. (The 3-chain interior drag is symmetric and
comes out rigid either way; the divergence starts at length 4.)

Note this is not an artefact of weighting. Holding the far end costs `0.25d²` in
the 3-chain and letting it drift costs `0.20d²`; any quadratic displacement
penalty prefers the drift. Only a lexicographic preference recovers the current
rule.

Everything else is unaffected either way:

- **Edge alignments** are *determined* once the driver is pinned — no slack for
  an objective to choose within.
- **The resize-side chain correction** already picks
  `origins.reduce(sum) / length` (`gapAlignment.ts`), and the mean of the
  candidate origins is exactly the least-squares choice. That heuristic is a
  minimum-disturbance rule wearing a heuristic's clothes.
- **Stretch distribution on the resize path does change.** Today's
  move-else-stretch is local and greedy: the first partner the BFS reaches that
  cannot travel absorbs the whole demand. A global solve spreads it — with
  `driver — X — Y — anchor`, today `X` shrinks by `d` and `Y` is untouched; a
  solve has each shrink by `d/2`. Neither is obviously right.

### How the soft rows are applied

Soft rows are **offered** to the row reduction after the hard ones, and kept
only if they survive it. When the hard system already determines a chain the
rule reduces away as redundant or is declined as inconsistent; when it leaves
slack the rule is kept and pins the answer to exactly today's.

Two things about the offer, both learned by getting them wrong first:

- **A rule is offered whole.** Its rows go in together and are rolled back
  together, because part of a rule is not a weaker version of it but a
  different claim. Keep one of "this element does not move"'s two rows and the
  element isn't held still — it is held by one edge and stretched by whatever
  pulls the other.
- **"Does not move" means both edges.** Encoded as "its centre holds still",
  the far-end rule is weak enough that a chain pulling on one of the far end's
  edges can satisfy both the chain and the rule by *stretching* it, instead of
  the rule being declined. The chain-around-an-anchor case does exactly that.

A chain gets a soft row when a BFS from the drivers over **edge links and group
membership only** (not chains — that is the pre-pass `spreadEdgeLinks` already
performs) reaches exactly one of its members:

- that member is an end of the chain: row `δ(far end) = 0`
- it is interior: rows `δ(ids[i]) - δ(ids[i+1]) = 0` for each consecutive pair

Being generous here is safe: a redundant or conflicting soft row on an
already-determined chain is discarded by the nullspace projection rather than
corrupting the answer.

### What this deletes

`solveChains`'s pin logic (`pinningAnchors`, `overridesDefault`, the
`unsolvable` re-check) exists to make an anchored chain member override the
default slope. With the anchor as a hard row and the default as a soft row, the
anchor wins automatically and the chain reshapes around it. Likewise
`factorsSatisfyAlignments`: verifying the answer afterwards is unnecessary when
no constraint was dropped in the first place.

### Toggling the soft rows

They must be switchable in code, to compare the two behaviours. All of it lives
behind one flag in `alignmentSolve.ts`, and the two rules toggle independently
so each can be tried on its own:

```ts
export const ALIGNMENT_FEEL_ROWS = {
  /** Dragging an end member holds the far end still. */
  endDragHoldsFarEnd: true,
  /** Dragging an interior member travels the whole chain rigidly. */
  interiorDragTravelsRigidly: true,
};
```

Only the feel-row block in `solve()` reads them, so flipping a flag changes
which rows are offered and nothing else — no dead code paths, no commented-out
blocks. Exported (and mutable) so `alignmentSolve.test.ts` can assert both sets
of numbers; no production caller should be choosing per gesture which behaviour
the editor has.

## The solve

Three steps, all per axis and shared across the driver's degrees of freedom.

1. **Incremental row reduction** of the hard rows. Each row is reported as
   *kept*, *redundant* (already implied) or *inconsistent* (it contradicts what
   came before). An inconsistent row means **infeasible**, and that is now the
   only refusal in the engine.
2. **Offer the feel rows to the same reduction.** A rule the hard rows leave
   room for is kept and pins the free slope exactly; one that contradicts them
   is declined and has no effect at all.

   This is where the implementation departs from "soft rows in the objective"
   as first sketched. Offering them to the reduction is *exact* — the rule
   either applies or it doesn't — where a large finite weight would only
   approximate it, and it removes the largest of the three weights and with it
   about four orders of magnitude of conditioning. It is also the right
   semantics: "hold the far end still" is a statement, not a preference, and
   approximately holding it means nothing.
3. **Minimise `w_stretch · ||stretch||² + ||translate||²`** on the affine set
   the kept rows describe, via the KKT system

   ```
   [ 2Q  Cᵀ ] [x]   [ 0  ]
   [ C   0  ] [λ] = [ Rd ]
   ```

   solved for every degree of freedom at once. `Q` is positive definite — its
   per-element eigenvalues are the two weights — and the rows are independent
   by construction, so this is non-singular whenever step 1 said the system was
   consistent.

The weight ratio is what makes *move-else-stretch* fall out globally, rather
than as today's greedy local rule. It is finite because a stretch has to stay
*available*; the ratio bounds the residual stretch on an element that should
not have moved, which is why the response is snapped to zero below a matching
epsilon.

**Write the ratio with the expensive side at 1.** Only the ratio matters, but
its placement decides the KKT matrix's scaling, and putting the big number on
stretch lifts the objective block six orders above the constraint block. The
Schur complement elimination leaves in the multiplier columns is then about
`1e-6`, a singularity tolerance scaled to the largest entry reads it as zero,
and **every** solve comes back infeasible — which looks like deliberate
behaviour rather than a bug.

That near-miss is also why `solve` distinguishes an *inconsistent* system from
a *singular* one. Only the first is a refusal, and only the first gets blame
computed for it; a singular system names no blockers, because no arrangement
of anchors produced it.

**Scoping.** Assemble only the component reachable from the drivers through
links and chains. Typical `n` is a handful, so the O(n³) elimination is
irrelevant at that size and runs once per gesture.

**Blame.** Infeasible means some anchor is in the way; to name it, release each
anchor in the component in turn and re-test. Those whose release restores
feasibility are the blockers. Exact, and better than the heuristic sets today's
overlay draws. `stretchers` — for a future "why did this change size" cue — is
just the elements with non-zero stretch in the solved response.

**Numerics.** Pivot tolerance must be tied to the geometric scale
(`EDGE_EPSILON`), not to machine epsilon: links that agree only to within a
pixel produce nearly-redundant rows.

## Files to create

1. **`packages/element/src/alignmentSolve.ts`** — row assembly, the dense
   linear-algebra helpers (incremental row reduction, KKT solve),
   `ALIGNMENT_FEEL_ROWS`, `solveAlignmentResponse`, `applyAlignmentResponse`,
   and the drag / resize driver builders. `isAlignmentAnchor` and
   `getGroupMembers` move here from `alignment.ts`, which re-exports them:
   this module must not depend on the one that will depend on it.
2. **`packages/element/tests/alignmentSolve.test.ts`** — the agreement test,
   the feel-rule numbers with and without, and the gestures the propagator had
   to refuse.

## Files to edit

1. **`packages/element/src/alignment.ts`**
   - *delete*: `solveAlignmentDragFactors`, `fitProgression`,
     `factorsSatisfyAlignments`, `getAlignmentLockedAxes`,
     `getAlignmentResizeLockedAxes`, `propagateResizeOnAxis`,
     `floodAlignmentAxis`, the body of `buildResizeAlignmentDeltas`
   - *rewrite*: `dragAlignedElements` writes `width`/`height` as well as
     `x`/`y`, and refits bound text on a stretched partner — the branch
     `applyAlignmentDeltas` already has, which it can now share
   - *untouched*: all detection, lock/unlock/prune/release, `isAlignmentAnchor`,
     `getGroupMembers`, `spreadAcrossGroups`, `resizeMovesEdge`,
     `applyAlignmentDeltas`
2. **`packages/element/src/gapAlignment.ts`**
   - *delete*: `fitShiftProgression`, `translateChain`, `correctGapAlignments`,
     `getGapAlignmentAnchoredResizeBlockers`, `MAX_GAP_CORRECTION_PASSES` and
     the convergence loop around it. A chain is now solved exactly, in the same
     system as everything else.
   - *merge*: `clampDragToGapAlignments` and `clampSizeToGapAlignments` become
     one function over the response basis. Each gap and each element extent is
     affine in the dofs, so each contributes one bound and the tightest interval
     wins — already how the drag clamp works. The size clamp's two-sample line
     fitting and its `driver.angle !== 0` bail-out both go away.
   - *untouched*: detection, `collectHardChains`, `asOneChain` merging,
     `hasHardGapAlignmentAmong`
   - `propagateAlignmentsAfterResize` becomes a thin caller
3. **`packages/element/src/dragElements.ts`** — the freeze-axis logic becomes:
   infeasible axis, zero it; otherwise clamp the offset against the response
   bounds, then apply.
4. **`packages/element/src/resizeElements.ts`** —
   `clampSizeToFrozenAlignmentAxes` loses the over-constrained check entirely (a
   pair locked at two places is now solvable by stretching) and takes its
   blockers from the solver. `clampSizeToMinimumExtent` and
   `clampMultiElementResize` stay as they are.
5. **`packages/excalidraw/snapping.ts`** — the real work outside the engine.
   `ReferenceSnapPoint.factorX` / `factorY` assume a partner's whole box moves
   by one number; a stretched partner has a moving `min` and a stationary `max`,
   so the factor becomes per-point, read off the edge that point sits on.
   `getSnapComovers` and `shiftCachedGap` follow; the `getAlignmentLockedAxes`
   call takes the new feasibility answer.
6. **`packages/excalidraw/components/App.tsx`** —
   `getAlignmentResizeAnchorEffects`, `getAlignmentResizeMovers` and
   `getAlignmentResizeLockedAxes` collapse into one solver query.
   `appState.alignmentResizeAnchorIds` keeps its shape, so the renderer is
   unchanged.
7. **`packages/excalidraw/renderer/renderAlignmentLocks.ts`** —
   `getAlignmentMovers` keeps its shape; the drag branch can now report
   stretchers as well as movers.
8. **`CLAUDE.md`** — the hard-alignment section is substantially rewritten.
9. **`limitations.md`** — loses five entries (both resize-propagation refusals,
   multi-element uncapped, pinned middle uncapped, rotated driver escapes the
   cap, `correctGapAlignments` is not a general solver) and gains one: the group
   spread carries positions only, so a group containing a stretched member now
   distorts on drags as well as resizes.

## Staging

Each stage is independently committable and leaves the app working.

1. ~~**`alignmentSolve.ts` with no callers**, plus a test asserting it
   reproduces today's factor maps and edge deltas on representative scenes.~~
   **Done.** 20 cases in `alignmentSolve.test.ts`: agreement with the
   propagator (its factor maps, and that it doesn't freeze the axis), the feel
   rules' numbers with the flags on *and* off, the gestures the propagator had
   to refuse, and the two-degree-of-freedom resize path.
2. ~~**Resize path onto it.**~~ **Done.** `getAlignmentResizeEffects` replaces
   five prediction functions with one solve; `buildResizeAlignmentDeltas`
   solves links and chains together, retiring `correctGapAlignments` and its
   fixed-point loop; `getAlignmentResizeLockedAxes` is deleted outright, since
   a pair locked at two places on one axis is now answered by the partner
   changing size.
3. ~~**Drag path onto it.**~~ **Done.** `solveAlignmentDragFactors` and
   `factorsSatisfyAlignments` are gone; `dragAlignedElements` writes sizes and
   shares `applyAlignmentDeltas` with the resize path; `getAlignmentLockedAxes`
   is now "is this axis infeasible" and nothing more. The anvil overlay's
   `permitting` set comes from `alignmentAnchorsInPlay`, which release-tests
   each anchor rather than inferring it structurally. The **drag** clamp moved
   onto the response basis here rather than waiting for stage 4, because a drag
   that can stretch a partner can also squash one through zero width — it now
   bounds element extents as well as gaps.
4. ~~**Remaining clamp onto the response basis.**~~ **Done.**
   `clampSizeToGapAlignments` is now `clampSizeToAlignments`: it asks the solve
   where things end up at a hypothetical length instead of reconstructing the
   propagation, and bounds element extents as well as gaps. With it went
   `fitShiftProgression`, `floodAlignmentAxis` and `GAP_CORRECTION_EPSILON` —
   the last of the old engine.
5. ~~**Snapping, blame / UI, docs.**~~ **Done.** `DragFactors` carries an
   `EdgeDelta` per element per axis instead of one number, so a snap point is
   masked and shifted by the travel of the edge it actually rides, and a cached
   gap's side by the edge that bounds it. Blame landed with stages 2 and 3
   (`getAlignmentResizeEffects`, `alignmentAnchorsInPlay`).

## Decisions already taken

- **Rotation out of scope for v1** — rotated elements get a rigidity row.
- **Limits clamp rather than refuse** — when the only solution would squash a
  partner below the minimum size or close a gap past zero, the gesture proceeds
  up to contact and stops, the way gap crossing is already clamped. Refusal is
  reserved for rank-infeasibility.
- **Groups stay as they are** — `spreadAcrossGroups` remains a post-pass over
  the solved deltas, outside the solver. It only ever fills in members with no
  answer of their own, so it composes with anything; promoting groups to real
  constraint rows is a later decision that needs no solver changes.

## Risks

- **Feel regressions outside the enumerated cases.** The soft-row argument says
  currently-working gestures are preserved, but "the soft row lies in the
  nullspace" is a claim per arrangement, not a theorem. Stage 1's comparison
  test is what makes it checkable rather than hoped-for.
- **Drags now silently resize things.** There is no UI vocabulary for it — the
  anvil says "this is anchored", nothing says "this stretched because of your
  drag". Worth designing after the behaviour exists to feel, not before.
- **Snapshot churn** across stages 2–3.

Total is roughly 1,200–1,600 lines touched, net close to flat: the solver is
larger than any one propagator but replaces three, plus their verification and
blame machinery.
