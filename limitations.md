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

## Hard alignment — resize propagation

**Rotated driver escapes the gap-alignment resize cap.** Resize a *rotated*
member of a hard gap chain and its gaps run straight past zero into
negative; every unrotated member stops at contact. `clampSizeToGapAlignments`
bails out at the top (`if (driver.angle !== 0 || !handle) return size`)
because a rotated element's AABB isn't linear in its width and height, and
the cap solves the zero-crossing as a line through two samples. Drag is
unaffected — `clampDragToGapAlignments` has no angle guard. Three ways out:
leave it; sample-and-bisect instead of solving the line, which handles the
non-linearity; or crudely refuse to shrink a rotated driver once any gap in
its chain is zero.

**Multi-element resize is uncapped.** The crossing cap is only wired into
the single-element path. Per-element proposed bounds come from a common box
scale, so the same prediction doesn't transfer.

**A pinned middle is uncapped.** If a chain's middle element is the driver
or is anchored, `correctGapAlignments` lands the correction on the outer
members, and the "both gaps end at the mean" identity the cap is derived
from no longer holds.

**`correctGapAlignments` is not a general constraint solver.** Two chains
sharing a member can hand that member back and forth, each recomputing it
from its own knowns. The outer loop caps this at
`MAX_GAP_CORRECTION_PASSES` (16) rather than converging, so an adversarial
graph of chains can settle with a small residual error rather than
diverging. Single chains, and chains that don't overlap, are exact.

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

**An anchored group member freezes a drag but not a resize.** On the drag
path the anchor picks up a non-zero factor from its siblings, so
`getAlignmentLockedAxes` freezes the axis and the group holds together — an
anchor anywhere in a group anchors the group, as it should. On the resize
path `floodAlignmentAxis` only *skips* the anchor, so its siblings still move
and the group comes apart around it. Fixing it means teaching
`getAlignmentAnchoredResizeBlockers` about groups; the flood has no way to
refuse, only to not enter.

---

## Version control

**Replay does not run the solvers.** `applyOps.ts` replays operations against
a scene snapshot without invoking Excalidraw's binding or alignment
propagators; dependent geometry is reproduced by the recorded
`consequentOps` instead. An op whose consequences weren't captured at record
time will not grow them at replay time.
