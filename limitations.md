# Known limitations

Ways this fork **behaves** less than fully, with the cause diagnosed where it
is known. These are not bugs waiting to be discovered — they are places we
chose a bounded answer over a general one, or stopped short.

Behaviour only. Cosmetic work, internal cleanups and performance notes are
tracked separately; nothing belongs here unless a user could see the program
do the wrong thing.

Companion to `CLAUDE.md` (how the systems work) and `terminology.md` (what
the words mean). Verify against the code before acting: entries are
point-in-time.

---

## Hard alignment — the constraint solver

Alignment is solved rather than propagated: every link, chain, anchor and the
gesture itself is a row in one linear system, and a gesture is refused only
when no displacement of anything satisfies it. See `ALIGNMENT_SOLVER_PLAN.md`
for the design and the remaining stages. What follows is what it still does
not cover.

**Rotated elements never change size.** A rotated element gets a rigidity row
(`δmin = δmax`), so alignment may move it but never stretch it, and a
constraint that could only be met by stretching one is refused. Its
axis-aligned box *is* linear in its width and height, so this is modellable —
it couples the two axes into one system of twice the size, which is
deliberately out of scope for now. Text is excluded on the same row for a
different reason: a width change rewraps it, so the constraint would be
rewriting the element's content rather than its box.

**Multi-element resize is uncapped.** Both clamps are wired into the
single-element path only. Per-element proposed bounds come from a common box
scale, so the driver's edges are not affine in one proposed length the way
`clampSizeToAlignments` needs them to be. A multi-element resize can therefore
close a gap past contact or squash a partner below `MIN_ALIGNED_SIZE`.

**Rotated driver escapes the resize cap.** Resize a *rotated* member of a hard
gap chain and its gaps run straight past zero into negative; every unrotated
member stops at contact. `clampSizeToAlignments` bails out at the top
(`if (driver.angle !== 0 || !handle) return size`) because a rotated element's
axis-aligned box moves on *both* axes as either dimension changes, which breaks
the per-axis independence the cap assumes. Drag is unaffected —
`clampDragToGapAlignments` has no angle guard, because a drag doesn't change
the driver's size.

**A gap side's overlap range is approximate when its element stretches across
the gap.** `gapSideShift` translates a cached gap's side rigidly, taking its
position on the gap's own axis from the edge that bounds it — so the gap's
*length* is exact. Across the gap it uses the leading edge, so a partner the
gesture stretches in that direction has its side drawn with the right position
and a slightly wrong extent, which can include or exclude an overlap near the
threshold. The gap's measurement is unaffected.

---

## Hard alignment — snapping

**The gap cache enumerates pairs once.** `getVisibleGaps` is quadratic in
reference elements and so is built at pointer-down. `shiftCachedGap` brings
each cached gap's *geometry* forward every frame using the drag factors, so
gaps bounded by comoving elements land correctly — but a pair that only
*starts* overlapping mid-drag was never enumerated and cannot appear. A gap
that fails to show up, rather than one drawn in the wrong place.

**The resize snap mask treats frozen axes as free.** `getSnapComovers` passes
`frozen: {x: false, y: false}`, because the freeze is decided later in the
same pointermove and reading it would be a frame stale and flicker the mask.
The effect is over-masking: a partner that won't move because the axis is
refused is still removed as a snap target there.

**Stale snap line on resize.** Soft-snap guides can still render to a
hard-aligned partner's pre-resize position. The uniform-offset correction
used for drags doesn't transfer: snapping runs *before* the mutation each
frame, so partner deltas must be predicted, and resize partners move by
per-edge amounts rather than one shared offset. Now more tractable than it
was — `getAlignmentResizeMovers` answers the per-edge question — and the
drag-side machinery (`factorX`/`factorY` on `ReferenceSnapPoint`) is the
shape to copy.

---

## Hard alignment — groups

Alignment is **element-level** by design: a link is always between two
elements, never between an element and a group. Snapping now matches — the
reference caches enumerate elements rather than maximum groups, so a group's
members are each snappable and the group's union box is not a target at all.

Both sides of snapping now follow that rule. A multi-element drag snaps
*from* the element it was grabbed by — not the selection's common bounding
box, which is a rectangle no element occupies — and snaps *to* individual
elements, group members included.

**A multi-selection grabbed by its empty interior does not snap.** Excalidraw
lets you drag a multi-selection from anywhere inside its bounding box; when
that point is over no element there is nothing to measure from, and the box
is deliberately not a substitute, so the drag runs unsnapped. Deliberate, and
the reason the behaviour is worth knowing rather than fixing: the alternative
is snapping by a rectangle the user cannot see or point at.

Moving is the one place a group *is* a unit: when a constraint moves an
element, `spreadAcrossGroups` carries its group siblings by the same amount,
so the arrangement the user grouped survives the constraint that moved it.
Three things follow, all bounded.

**Always the outermost group.** Entering a group to work on its inner
structure is editor state (`editingGroupId`) that the alignment engine, which
lives in `packages/element`, cannot see. Alignment therefore always moves the
outermost group, even while you are editing an inner one.

**Group and constraint conflicts are first-wins, not reconciled.** If two
members of one group already have different displacements — one pinned by a
gap chain, another pulled by an edge link — no rigid translation satisfies
both. The spread only fills in members with no displacement of their own and
never overwrites, so the group silently distorts rather than the conflict
being reported. This is the same backstop the over-constrained edge and chain
cases take, and keeping the spread purely additive is also what guarantees
the fixed-point loops around it terminate.

**An anchored group member no longer freezes anything.** Group membership is
not a row in the solver — it stays the post-pass `spreadAcrossGroups` applies
to the solved deltas — so the solve never sees that moving a member would have
to move an anchored sibling. The anchor itself is skipped and stays put, its
siblings move, and the group comes apart around it. This used to hold on the
drag path, where the anchor picked up a non-zero factor from its siblings
during the propagator's alternating passes and froze the axis; it now behaves
as the resize path always did. The fix is the same one that fixes the item
below — make group membership a constraint — and it is the strongest argument
for doing that sooner rather than later.

**Group propagation does not re-enter the solve.** The old drag propagator
alternated spreading across groups with following links, so a sibling pulled
along by its group then dragged *its* own alignment partners. The post-pass
runs once, after the solve, so that second hop no longer happens.

---

## Version control

**Replay does not run the solvers.** `applyOps.ts` replays operations against
a scene snapshot without invoking Excalidraw's binding or alignment
propagators; dependent geometry is reproduced by the recorded
`consequentOps` instead. An op whose consequences weren't captured at record
time will not grow them at replay time.
