# Plan: reassigning an alignment to a stand-in

## Why

Conflict resolution lets the user hand the Moments that depended on a missing
element to another one. For an arrow binding that is enough on its own: a
binding can name any bindable element, and replay re-places the arrow's end
from it afterwards (`followBindings.ts`), so the geometry follows the
relationship.

An alignment link can't be handed over that way. A hard alignment is a soft
coincidence the user chose to keep — the two edges *are* at the same
coordinate — and everything outside the solver assumes it: `getAlignedLinks`
identifies a link by the coordinate its edges share, the guide and its badge
are drawn on it, and a gap chain merges only with a run that is still evenly
spaced. Today a reassignment rewrites the ids (`applyRemapsToOp`) and checks
only `isAlignable`, so the stand-in ends up linked to an edge it isn't on. The
solver half-tolerates this — it works in displacements, so the link holds an
*offset* during a gesture — but nothing else does.

So a reassigned alignment needs the counterpart of `followBindings`: when the
op is replayed, **place the stand-in where the link says it is**.

## What exists to build on

- **The solver already takes a measured gesture.**
  `alignmentDriverFromEdgeDeltas` drives any set of elements by known edge
  displacements, and `solveAlignmentResponse` answers what everything coupled
  to them does — moving or stretching partners, keeping rotated elements and
  text rigid, refusing against anchors with `refusedBy` naming the rows. A
  placement is exactly that gesture: "the stand-in's edges move by these
  amounts, its new partners stay where they are".
- **The refusal channel.** `standInRefusal` is asked at the conflict's own
  point in the replay, and its answer is drawn on the canvas beside the
  hovered element. A placement that can't be made is one more reason.
- **The hover preview** replays under the hovered choice and ghosts every
  element it would draw differently, so the stand-in's move — and anything the
  solve drags along with it — previews with no extra work.

## A prerequisite: the alignment op writes whole arrays

`applyOpToScene`'s `alignment` case sets each member's link field to the
recorded array (`op.after[id]`), wholesale. Classification records the
*entire* field before and after (`detectAlignmentChange`), so:

- **A reassigned owner clobbers the stand-in.** When the missing element owned
  links, the remap moves its array onto the stand-in: the stand-in's own links
  are replaced, and it inherits the missing element's links to *other*
  partners, whose side of the link was never remapped — one-sided links.
- **A skip can be undone by a later lock.** Lock L1 at Moment 1 and L2 at
  Moment 2 on a shared element: Moment 2's `after` array includes L1, so
  skipping Moment 1 and replaying Moment 2 writes L1 back. (Read from the code;
  confirm in the app.)

Both go away if the op applies as a **diff**: links in `after` but not `before`
are added to the element's *current* field, links in `before` but not `after`
are removed, and backward is the reverse. Link identity is the one the engine
already uses — `(partner, axis, selfEdge, otherEdge)` for an edge link, the
member list and axis for a gap chain. The recorded shape stays as it is; only
the apply changes. This is worth doing on its own and should land first.

## The design

### Who moves

**The stand-in.** It is taking over the missing element's role, so it goes to
where that role is. The surviving partners keep the positions the log recorded,
which later Moments may depend on.

### Where it goes

From the op's links that name the stand-in once remapped, one target per link,
per axis, in terms of the stand-in's two edges (its `EdgeDelta`):

- **Edge link** — the stand-in's `selfEdge` must reach the partner's
  `otherEdge` (a centre is the mean of the two edges). One equation.
- **Gap chain** — the gaps either side of the stand-in must equal the chain's
  common gap: an interior member's centre is fixed between its neighbours, an
  end member's outer edge is fixed by the next gap in. One equation.

One axis has two unknowns, so:

- **One equation** → translate (`δmin = δmax`). The solver's
  move-else-stretch weighting picks this anyway; stating it as the seed is
  just clearer.
- **Two independent equations** (left *and* right to partners whose edges are
  a different width apart) → stretch, unless the stand-in is rigid (rotated,
  text): then refuse — *"isn't the same width as R2"*.
- **More, or contradictory** → refuse. Within float tolerance, redundant
  equations (left, centre and right to one partner of equal width) are fine.
- **A target that would fold the stand-in through zero width, or reorder a
  gap chain** → refuse, for the reasons the clamps already stop gestures
  there.

### The solve

Per axis, run `solveAlignmentResponse` on the replay's snapshot **before the
op's links are written**, with a driver from `alignmentDriverFromEdgeDeltas`:

- the stand-in, seeded with its target displacement;
- every live partner the op's links name, seeded `{ min: 0, max: 0 }` — held.

Then write the deltas, spread across groups as a drag does
(`spreadAcrossGroups`), and only then write the links.

The links can't be in the scene during the solve: the solver's rows are
homogeneous in the displacements, so a link row says "these edges move
together" — it can't say "close this gap of 40". Holding the partners is what
makes the gap close at the stand-in's end.

Holding them is a hard demand. If a partner is already coupled to the
stand-in some other way (they share a chain, or a third element links both),
moving one moves the other, and the solve refuses — *"is already aligned with
R2 another way"*, from `refusedBy`. An anchor among the stand-in's existing
partners refuses the same way, named. Making the hold an *offer*, declined
when it contradicts, as a resize offers its held edge, is the obvious next step
if this refuses too often; not worth it before seeing that.

### Where it runs

In `replayActiveOps`, when an `alignment` op has been remapped: the stand-ins
are the remap targets that appear in the remapped op. The placement runs on the
working snapshot just before the op is applied, and is derived from the remap
every time — nothing is stored, so nothing to migrate and nothing to keep in
sync.

`standInRefusal` gets the snapshot (it is called where one is in hand) and,
for `alignment`, runs the placement as a dry run: targets, then the solve,
writing nothing. It is still preceded by the cheap `isAlignable` test, so the
solve runs only for elements that could stand in at all — one small solve per
alignable candidate when a conflict is first collected.

### Several alignment ops in one bucket

One stand-in takes every op that depended on the missing element. A second
lock naming it, later in the log, is placed in turn, with the first link now in
the scene as an ordinary hard row, so the second placement carries the first
partner along or refuses.

Refusals are collected with every conflict still skipped, so the dry run for
that second op sees a scene in which the first placement never happened. Its
answer can be wrong. The real replay under the decision is exact. **Recommend:**
when a placement fails during the real replay, skip that op and report it
alongside the drift below, rather than trying to make the collection-time
refusals exact.

## What this does not fix: drift afterwards

Replay doesn't run the solver; followers are only what was recorded
(`limitations.md`, "Replay does not run the alignment solver"). After a
placement:

- the partner's later moves recorded the *missing* element following as
  consequent ops. `remapConsequents` hands those to the stand-in, so it stays
  aligned. A follower resize scales the stand-in by the recorded factors
  (`onStandIn`), and a candidate that can't stretch is refused if the missing
  element was ever stretched as a follower;
- the stand-in's own later moves were recorded while it was free and carry no
  follower, and its *existing* partners never recorded following the new
  partner — from the first such move, a link stops holding.

**The post-replay check** reports what that leaves. After each replay in a
resolution session, `findBrokenAlignments` tests every hard link for
coincidence and every gap chain for equal gaps. The bar says how many no
longer hold (*"2 alignments no longer hold after later Moments."*) and the
canvas flashes them. No automatic repair: releasing or re-solving them would
change data the user hasn't looked at.

The check isn't specific to reassignment — skipping a Moment that moved a
locked element breaks links the same way, and those are counted too, along
with any link already broken when the session opened. It runs only during a
session. How it would surface outside one (the log panel, a badge on the
Moment) is a separate decision.

## Later: the solver in replay

The real fix for drift is running the solver for every replayed move-like op,
so alignment followers are derived the way bound arrow ends already are, and
recorded alignment consequents are ignored at replay (as binding consequents
with absolute points are now). That reaches across `applyOps` and every
move-like op kind, and is a project of its own.

*Done* (`followAlignments.ts`), per Moment rather than per op: the Moment's
own moved elements are one gesture, seeded by their measured edge
displacements, solved against the links as the Moment found them. Where the
scene no longer allows the follow, the moved elements stay as their ops put
them and nothing follows on that axis — the post-replay check reports it.

Nothing above is thrown away by it. Following propagates a displacement; it
does not repair a link that doesn't hold, so placement remains a separate step,
and the post-replay check becomes a safety net instead of the only notice.
Built this way, the only placement-specific choice that might be revisited is
holding the partners hard.

## Decisions

| Question | Recommendation |
| --- | --- |
| Who moves | The stand-in |
| How the partners enter the solve | Held, hard; refuse when that contradicts |
| More targets than the stand-in can meet | Refuse, with the reason |
| Placement fails in the real replay | Skip that op, report it |
| Drift after the placement | Post-replay check, reported in the bar; no repair |
| Scope | Reassigned links only (below) |

**Scope.** A lock replayed onto geometry that no longer coincides isn't only a
reassignment problem: skip a move made *before* a lock, and the lock replays a
coincidence that isn't there. Placement could serve that case too, but it has no
obvious answer to "who moves" — there is no newcomer. Build the placement with
the moving element as a parameter, ship it for reassignment, and decide the
general case separately.

## Steps

1. **Diff-based apply for `alignment`** (`applyOps.ts`). Independent; fixes
   the clobbering and, if confirmed, the skip resurrection. *Done.*
2. **Placement targets** — a pure function from a remapped `alignment` op, the
   stand-in and the snapshot to a per-axis `EdgeDelta`, or a refusal reason.
   *Done:* `getPlacementTarget` (`versionLog/placement.ts`), which also
   returns the partners it measured from — the set step 3 holds.
3. **Placement solve** — the driver above, the response evaluated with
   `applyAlignmentResponse`, written to the snapshot. `applyAlignmentDeltas`
   writes through a `Scene`; the per-element geometry it does (x/width from an
   `EdgeDelta`) needs pulling out so the snapshot can use it. *Done:*
   `solvePlacement` / `writePlacement` (`versionLog/placement.ts`). The
   solver reads a zero seed as an offer, not a demand, so the hold is
   checked on the answer, with `releasedBy` as the blame. Labels of a
   stretched container are re-centred, not refitted.
4. **Wiring** — run it in `replayActiveOps` before a remapped `alignment` op;
   give `standInRefusal` the snapshot and the dry run. *Done:* the stand-ins
   are the ids the op names after remapping and didn't as recorded;
   `placeStandIns` places them in turn on a copy, all or nothing. A failed
   placement skips the op silently until step 5 reports it. The dry run
   copies the scene once per alignable candidate, which is quadratic in
   scene size — fine at prototype scale.
5. **Post-replay check** and its report in the conflict bar. *Done:*
   `findBrokenAlignments` (`versionLog/brokenAlignments.ts`), kept on the
   session as `replayIssues` with the stand-ins that couldn't be placed. The
   bar says so on its own lines and the canvas flashes the broken links.
   Reported only during a session; outside one is still undecided. A
   candidate is also refused if the missing element was ever stretched as a
   follower and the candidate is text or rotated.
6. **Docs** — `CLAUDE.md` (replay now calls the solver, for placement only),
   `limitations.md` (the drift, until the solver runs in replay), and
   `terminology.md` if *placement* earns a glossary entry. *Done*, with an
   entry for placement.
7. **Drop, don't refuse** — superseding 4 and 5's refusals. A refusal was
   asked at the conflict's point, but later ops in the bucket asked it again
   of a scene that already held the placed stand-in, so a candidate could be
   pickable and then refused once picked. Now nothing about placement
   refuses: `placeStandInsDropping` tries the stand-in's alignments in
   recorded order and drops each one that can't hold alongside those kept,
   and a follower resize onto a rigid stand-in is dropped the same way. The
   drops are reported as `replayIssues.dropped` and, per candidate, on the
   hover. Stand-ins are read off the remaps, so one already a partner
   counts. Only kind and upstream's `locked` still refuse.

## Checking it

- A and M edge-aligned, M removed by a skip, reassign to S off to one side: S
  slides along the link's axis onto A's edge; hovering S beforehand ghosts it
  there.
- S has its own hard partner B on the same axis: B comes along, unless B is
  anchored, in which case S is refused, naming B.
- M linked left *and* right to A (same width), S narrower: S stretches, or is
  refused if S is text.
- Gap chain A—M—C, reassign the middle to S: S centres between A and C. End
  member: S lands one gap beyond its neighbour; refused if that would cross it.
- After a reassignment, a later recorded move of S: the post-replay check
  reports the link to A.
