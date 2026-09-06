import type { Bounds } from "@excalidraw/common";

import { updateBoundElements } from "./binding";
import { getElementBounds } from "./bounds";
import { newElementWith } from "./mutateElement";
import { getBoundTextElement } from "./textElement";
import { isBoundToContainer, isLinearElement } from "./typeChecks";

import type { PointerDownState } from "@excalidraw/excalidraw/types";

import type { Scene } from "./Scene";
import type {
  AlignmentEdge,
  ElementAlignment,
  ElementsMap,
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "./types";

/**
 * VERSION-LOG: New feature hard alignment ("alignment lock")
 *
 * Excalidraw ships a soft alignment system: snapping.
 * Dragged elements can be nudged onto guides based on other elements, 
 * but aren't permanently attached to them.
 * 
 * Hard alignment persists a chosen alignment as data on the
 * elements (`ExcalidrawElement.alignments`) so that afterwards moving
 * one element drags its aligned partners to preserve the alignment.
 *
 * 
 * TERMINOLOGY:
 *  
 *  Two elements sharing a vertical edge (left / right / horizontal-center) 
 *  are locked on the **x** axis, so moving one horizontally moves the other,
 *  while vertical motion is unconstrained. 
 * 
 *  Sharing a horizontal edge locks the **y** axis.
 */

type Axis = "x" | "y";
type Edge = AlignmentEdge;
/** A directional link from element A to B: A's edge aligned to B's. */
type AlignAxisEdge = { axis: Axis; selfEdge: Edge; otherEdge: Edge };

/**
 * Edge pairs to test per axis, as [A's edge, B's edge], in priority
 * order — the first match on an axis wins, so the list runs from most to
 * least "obvious" alignment:
 *
 * 1. same-edge (left-to-left, …),
 * 2. the "opposite" crosses (A's right to B's left, and vice versa) so
 *    two abutting elements lock,
 * 3. centre-to-edge.
 *
 */
const EDGE_PAIRS: readonly (readonly [Edge, Edge])[] = [
  ["min", "min"],
  ["center", "center"],
  ["max", "max"],
  ["max", "min"],
  ["min", "max"],
  ["center", "min"],
  ["center", "max"],
  ["min", "center"],
  ["max", "center"],
];

/**
 * Whether an element can take part in hard alignment at all.
 *
 * Alignment is a statement about two boxes sharing an edge, so it only
 * means anything for elements whose bounding box *is* the shape. Lines
 * and arrows are excluded: their bounds are an artefact of where their
 * points happen to sit rather than a drawn edge, so aligning to one
 * couples elements along a line nobody can see — and an arrow bound to a
 * shape is already moved by its binding, which would fight the
 * propagator. Container-bound labels are excluded for the same reason
 * they aren't snap targets: they move with their container.
 */
export const isAlignable = (element: ExcalidrawElement | null): boolean =>
  element != null && !isLinearElement(element) && !isBoundToContainer(element);

const EDGE_EPSILON = 1;

const roughlyEqual = (a: number, b: number, epsilon = EDGE_EPSILON) =>
  Math.abs(a - b) <= epsilon;

/** The coordinate of one edge of an AABB on a given axis. */
const edgeCoord = (bounds: Bounds, axis: Axis, edge: Edge): number => {
  const min = axis === "x" ? bounds[0] : bounds[1];
  const max = axis === "x" ? bounds[2] : bounds[3];
  return edge === "min" ? min : edge === "max" ? max : (min + max) / 2;
};

/**
 * The directional links (from A's perspective) two elements are aligned
 * on, judged from their current axis-aligned bounds. A coinciding pair
 * of vertical edges yields an "x" lock; horizontal edges yield "y". The
 * edges may match (left-to-left) or differ (A's right to B's left).
 *
 * A pair can align at several *places* on one axis — two same-width
 * elements share their left edge, their centre and their right edge, at
 * three distinct coordinates — and each of those is an independently
 * lockable alignment, so we emit one link per place rather than one per
 * axis. What we do collapse is redundant *descriptions* of a single
 * place: when several edge pairs land on the same coordinate, only the
 * highest-priority one (per `EDGE_PAIRS`) survives, so a shared line is
 * never reported twice under different names.
 */
export const getAlignedLinks = (
  a: ExcalidrawElement,
  b: ExcalidrawElement,
  elementsMap: ElementsMap,
): AlignAxisEdge[] => {
  const boundsA = getElementBounds(a, elementsMap);
  const boundsB = getElementBounds(b, elementsMap);

  const links: AlignAxisEdge[] = [];
  for (const axis of ["x", "y"] as const) {
    // coordinates already claimed on this axis, so a second edge pair
    // describing the same line is dropped
    const claimed: number[] = [];
    for (const [selfEdge, otherEdge] of EDGE_PAIRS) {
      const coord = edgeCoord(boundsA, axis, selfEdge);
      if (!roughlyEqual(coord, edgeCoord(boundsB, axis, otherEdge))) {
        continue;
      }
      if (claimed.some((claimedCoord) => roughlyEqual(coord, claimedCoord))) {
        continue;
      }
      claimed.push(coord);
      links.push({ axis, selfEdge, otherEdge });
    }
  }
  return links;
};

const withLink = (
  links: readonly ElementAlignment[] | undefined,
  partnerId: string,
  { axis, selfEdge, otherEdge }: AlignAxisEdge,
): ElementAlignment[] => {
  const existing = links ?? [];
  // Identity is (partner, axis, *edges*): a pair may be locked at several
  // places on one axis, so only the exact same edge pair is a duplicate.
  if (
    existing.some(
      (l) =>
        l.elementId === partnerId &&
        l.axis === axis &&
        l.selfEdge === selfEdge &&
        l.otherEdge === otherEdge,
    )
  ) {
    return existing.slice();
  }
  return [...existing, { elementId: partnerId, axis, selfEdge, otherEdge }];
};

/**
 * Build the updated `alignments` arrays for a set of elements so that
 * every pair that currently shares an edge becomes hard-aligned on the
 * matching axis. Links are symmetric (written on both partners).
 *
 * Returns a map of elementId -> new element (only for elements that
 * actually gained a link); callers splice these into the scene.
 */
export const lockAlignments = (
  elements: readonly NonDeletedExcalidrawElement[],
  elementsMap: ElementsMap,
): Map<string, ExcalidrawElement> => {
  // accumulate new link arrays keyed by id, seeded from current state
  const nextLinks = new Map<string, ElementAlignment[]>();
  const touched = new Set<string>();

  const linksFor = (el: ExcalidrawElement) =>
    nextLinks.get(el.id) ?? (el.alignments ? el.alignments.slice() : []);

  for (let i = 0; i < elements.length; i++) {
    for (let j = i + 1; j < elements.length; j++) {
      const a = elements[i];
      const b = elements[j];
      if (!isAlignable(a) || !isAlignable(b)) {
        continue;
      }
      for (const link of getAlignedLinks(a, b, elementsMap)) {
        nextLinks.set(a.id, withLink(linksFor(a), b.id, link));
        // reciprocal link from B's perspective — edges swap
        nextLinks.set(
          b.id,
          withLink(linksFor(b), a.id, {
            axis: link.axis,
            selfEdge: link.otherEdge,
            otherEdge: link.selfEdge,
          }),
        );
        touched.add(a.id);
        touched.add(b.id);
      }
    }
  }

  const updated = new Map<string, ExcalidrawElement>();
  for (const id of touched) {
    const el = elementsMap.get(id);
    if (el) {
      updated.set(id, newElementWith(el, { alignments: nextLinks.get(id) }));
    }
  }
  return updated;
};

/**
 * Strip every alignment link from the given elements (and, on the other
 * side, the reciprocal links pointing back at them). Returns the updated
 * elements keyed by id.
 */
export const unlockAlignments = (
  elements: readonly NonDeletedExcalidrawElement[],
  elementsMap: ElementsMap,
): Map<string, ExcalidrawElement> => {
  const removedIds = new Set(elements.map((el) => el.id));
  const updated = new Map<string, ExcalidrawElement>();

  // clear links on the selected elements
  for (const el of elements) {
    if (el.alignments && el.alignments.length > 0) {
      updated.set(el.id, newElementWith(el, { alignments: [] }));
    }
  }

  // drop reciprocal links that point at any cleared element
  for (const el of elementsMap.values()) {
    if (removedIds.has(el.id) || !el.alignments?.length) {
      continue;
    }
    const filtered = el.alignments.filter((l) => !removedIds.has(l.elementId));
    if (filtered.length !== el.alignments.length) {
      updated.set(el.id, newElementWith(el, { alignments: filtered }));
    }
  }

  return updated;
};

/**
 * A single alignment line to surface for a selected element. `hard`
 * links are the persisted `alignments`; `soft` ones are live edge
 * coincidences detected on the fly (never stored) that the user can
 * promote to hard by clicking the line's lock icon. `selfId` is the
 * selected element the line hangs off; the fields otherwise mirror
 * `ElementAlignment`.
 */
export type AlignmentGuide = {
  selfId: string;
  elementId: string;
  axis: Axis;
  selfEdge: Edge;
  otherEdge: Edge;
  hard: boolean;
};

/** Canonical key for an unordered (element, edge) pair on an axis, so a
 * link and its reciprocal — or the same pair reached from two selected
 * elements — collapse to one guide. */
const guideKey = (g: {
  selfId: string;
  elementId: string;
  axis: Axis;
  selfEdge: Edge;
  otherEdge: Edge;
}): string => {
  const ends = [`${g.selfId}:${g.selfEdge}`, `${g.elementId}:${g.otherEdge}`]
    .sort()
    .join("|");
  return `${g.axis}:${ends}`;
};

/**
 * Every alignment line to draw for the current selection: the persisted
 * hard links, plus every *other* current edge coincidence as a soft,
 * convertible guide. Soft guides are detected with the same
 * `getAlignedLinks` geometry hard links use, so the two are defined
 * consistently; a coincidence already stored as hard is not re-emitted
 * as soft. Linear elements and container-bound labels are never
 * partners (they aren't snap targets either).
 */
export const getAlignmentGuides = (
  selected: readonly NonDeletedExcalidrawElement[],
  elementsMap: ElementsMap,
): AlignmentGuide[] => {
  const guides: AlignmentGuide[] = [];
  const seen = new Set<string>();

  // Hard links first, so a hard pair is never also emitted as soft.
  for (const el of selected) {
    if (!isAlignable(el)) {
      continue;
    }
    for (const link of el.alignments ?? []) {
      const guide: AlignmentGuide = {
        selfId: el.id,
        elementId: link.elementId,
        axis: link.axis,
        selfEdge: link.selfEdge,
        otherEdge: link.otherEdge,
        hard: true,
      };
      const key = guideKey(guide);
      if (!seen.has(key)) {
        seen.add(key);
        guides.push(guide);
      }
    }
  }

  // Soft coincidences: any current alignment not already stored as hard.
  // Matched on the edges too, so a pair locked at one place on an axis
  // still surfaces its *other* coincidences on that axis as soft.
  const isHardWith = (
    el: NonDeletedExcalidrawElement,
    otherId: string,
    link: AlignAxisEdge,
  ) =>
    (el.alignments ?? []).some(
      (l) =>
        l.elementId === otherId &&
        l.axis === link.axis &&
        l.selfEdge === link.selfEdge &&
        l.otherEdge === link.otherEdge,
    );

  for (const el of selected) {
    if (!isAlignable(el)) {
      continue;
    }
    for (const other of elementsMap.values()) {
      if (other.id === el.id || other.isDeleted || !isAlignable(other)) {
        continue;
      }
      for (const link of getAlignedLinks(el, other, elementsMap)) {
        if (isHardWith(el, other.id, link)) {
          continue;
        }
        const guide: AlignmentGuide = {
          selfId: el.id,
          elementId: other.id,
          axis: link.axis,
          selfEdge: link.selfEdge,
          otherEdge: link.otherEdge,
          hard: false,
        };
        const key = guideKey(guide);
        if (!seen.has(key)) {
          seen.add(key);
          guides.push(guide);
        }
      }
    }
  }

  return guides;
};

/**
 * Promote a single soft guide to a hard link (the lock icon). Writes the
 * reciprocal pair, mirroring `lockAlignments` for one pair.
 */
export const lockAlignmentPair = (
  guide: AlignmentGuide,
  elementsMap: ElementsMap,
): Map<string, ExcalidrawElement> => {
  const a = elementsMap.get(guide.selfId);
  const b = elementsMap.get(guide.elementId);
  const updated = new Map<string, ExcalidrawElement>();
  if (!a || !b) {
    return updated;
  }
  updated.set(
    a.id,
    newElementWith(a, {
      alignments: withLink(a.alignments, b.id, {
        axis: guide.axis,
        selfEdge: guide.selfEdge,
        otherEdge: guide.otherEdge,
      }),
    }),
  );
  updated.set(
    b.id,
    newElementWith(b, {
      alignments: withLink(b.alignments, a.id, {
        axis: guide.axis,
        selfEdge: guide.otherEdge,
        otherEdge: guide.selfEdge,
      }),
    }),
  );
  return updated;
};

/**
 * Demote a single hard link back to soft (the unlock icon): drop exactly
 * the guide's edge pair, on both sides. Matching on the edges — not just
 * the axis — matters because the same two elements may be locked at
 * several places on one axis; unlocking one padlock must leave the
 * others alone. The elements stay edge-coincident, so
 * `getAlignmentGuides` re-surfaces the dropped one as a soft guide
 * immediately.
 */
export const unlockAlignmentPair = (
  guide: AlignmentGuide,
  elementsMap: ElementsMap,
): Map<string, ExcalidrawElement> => {
  const updated = new Map<string, ExcalidrawElement>();
  const drop = (fromId: string, toId: string, selfEdge: Edge, otherEdge: Edge) => {
    const el = elementsMap.get(fromId);
    if (!el?.alignments?.length) {
      return;
    }
    const filtered = el.alignments.filter(
      (l) =>
        !(
          l.elementId === toId &&
          l.axis === guide.axis &&
          l.selfEdge === selfEdge &&
          l.otherEdge === otherEdge
        ),
    );
    if (filtered.length !== el.alignments.length) {
      updated.set(el.id, newElementWith(el, { alignments: filtered }));
    }
  };
  drop(guide.selfId, guide.elementId, guide.selfEdge, guide.otherEdge);
  // the reciprocal link stores the edges swapped
  drop(guide.elementId, guide.selfId, guide.otherEdge, guide.selfEdge);
  return updated;
};

/**
 * Whether an element holds still against alignment propagation.
 *
 * Two independent reasons, and either is sufficient:
 *   - `alignmentLocked`, our anvil badge — "keep this one put while its
 *     partners move";
 *   - `locked`, upstream's element lock — the user can't edit it at all,
 *     so alignment must not move it either. Without this an aligned
 *     partner could shove a locked element around, which is exactly what
 *     the lock is supposed to forbid.
 */
export const isAlignmentAnchor = (
  element: ExcalidrawElement | undefined,
): boolean => !!element && (!!element.alignmentLocked || element.locked);

/**
 * The group an element moves with, or null if it is in none.
 *
 * The **outermost** group, because that is the unit a click selects and
 * so the unit the user is positioning. Inner groups are only addressable
 * after entering one, which is editor state the alignment engine has no
 * access to and no notion of.
 */
const outermostGroupId = (element: ExcalidrawElement): string | null =>
  element.groupIds.length > 0
    ? element.groupIds[element.groupIds.length - 1]
    : null;

/** Outermost group id → its member ids, in one sweep, so a propagator
 * can ask "what else moves with this" without rescanning per element. */
export const getGroupMembers = (
  elementsMap: ElementsMap,
): Map<string, string[]> => {
  const byGroup = new Map<string, string[]>();
  for (const element of elementsMap.values()) {
    const groupId = outermostGroupId(element);
    if (!groupId) {
      continue;
    }
    const members = byGroup.get(groupId);
    if (members) {
      members.push(element.id);
    } else {
      byGroup.set(groupId, [element.id]);
    }
  }
  return byGroup;
};

/**
 * Spread a per-element quantity across group membership: a group keeps
 * its layout, so a member with no value of its own takes a sibling's.
 *
 * This is what makes an alignment move a *group* move. Alignment links
 * are between elements, and without this an element dragged along by a
 * link would slide out of the group it was drawn as part of — the
 * arrangement the user grouped in order to preserve is exactly what the
 * constraint would break.
 *
 * Never overwrites an existing value. Two members can already disagree —
 * one pinned by a gap chain, another pulled by an edge link — and no
 * rigid translation satisfies both; first-wins is the same backstop the
 * over-constrained cases elsewhere in this file take. Only ever adding
 * also keeps the fixed-point loops that call this monotone, so they
 * terminate.
 */
export const spreadAcrossGroups = <T>(
  valueById: Map<string, T>,
  groupMembers: ReadonlyMap<string, string[]>,
  skip?: (id: string) => boolean,
): boolean => {
  let changed = false;
  for (const members of groupMembers.values()) {
    let value: T | undefined;
    for (const id of members) {
      if (skip?.(id)) {
        continue;
      }
      value = valueById.get(id);
      if (value !== undefined) {
        break;
      }
    }
    if (value === undefined) {
      continue;
    }
    for (const id of members) {
      if (!valueById.has(id) && !skip?.(id)) {
        valueById.set(id, value);
        changed = true;
      }
    }
  }
  return changed;
};

/** Bound on the propagation passes below. A chain settles in a pass or
 * two; the cap is only there so a cyclic link graph can't spin. */
const MAX_DRAG_FACTOR_PASSES = 8;

/**
 * How far each element travels on one axis when `seeds` are dragged, as
 * a multiple of the drag offset. The seeds themselves are 1; an element
 * absent from the map doesn't move. Includes the seeds.
 *
 * A multiple rather than a set, because gap alignment doesn't move
 * everything by the same amount. Holding one gap equal to the next says
 *
 *     d(i+1) − d(i) = d(i+2) − d(i+1)
 *
 * so along a chain the factors are an **arithmetic progression**,
 * `d(i) = p + q·i`, however long the chain is. Two degrees of freedom,
 * so two known members determine the rest and the passes below fit the
 * line through them. (A third known member that disagrees is left alone
 * — the chain is then over-constrained, and first-wins is the same
 * backstop the edge propagator uses.)
 *
 * One known member leaves `q` free, and the choice there is what gives
 * gap dragging its feel:
 *
 *   - an **interior** member is the known one: `q = 0`, so the chain
 *     travels rigidly. Translating everything preserves every gap
 *     whatever their sizes, and this is the case when the user drags a
 *     member with neighbours on both sides.
 *   - an **end** member is the known one: `q = ∓d`, which puts its
 *     immediate neighbour at 0 and steps the rest of the chain along
 *     from there. Dragging the first element toward the chain by `d`
 *     closes every gap by `d` while the second element stays exactly
 *     where it was.
 *
 * Holding the neighbour is what makes the gesture legible: the element
 * you are moving toward is the one you are measuring against, so moving
 * it would change the thing being kept equal. Squeezing from an end
 * leaves it as the fixed point of the arrangement.
 *
 * Edge alignments are the simple case throughout: a partner inherits its
 * neighbour's factor exactly, which is the rigid coupling they've always
 * had.
 */
export const getAlignmentDragFactors = (
  seeds: Set<string>,
  axis: Axis,
  elementsMap: ElementsMap,
): Map<string, number> => {
  const factors = new Map<string, number>();
  for (const id of seeds) {
    factors.set(id, 1);
  }
  const groupMembers = getGroupMembers(elementsMap);

  /** Edge links: a partner moves exactly as its neighbour does. */
  const spreadEdgeLinks = (): boolean => {
    let changed = false;
    const queue = [...factors.keys()];
    while (queue.length > 0) {
      const id = queue.pop()!;
      const factor = factors.get(id)!;
      for (const link of elementsMap.get(id)?.alignments ?? []) {
        if (link.axis === axis && !factors.has(link.elementId)) {
          factors.set(link.elementId, factor);
          queue.push(link.elementId);
          changed = true;
        }
      }
    }
    return changed;
  };

  /** One pass of the progression fit over every gap chain on this axis. */
  const solveChains = (): boolean => {
    let changed = false;
    for (const el of elementsMap.values()) {
      for (const link of el.gapAlignments ?? []) {
        if (link.axis !== axis || link.ids.length < 3) {
          continue;
        }
        const known: { index: number; factor: number }[] = [];
        link.ids.forEach((id, index) => {
          const factor = factors.get(id);
          if (factor !== undefined) {
            known.push({ index, factor });
          }
        });
        if (known.length === 0 || known.length === link.ids.length) {
          // nothing to solve from, or nothing left to solve
          continue;
        }

        const first = known[0];
        const last = known[known.length - 1];
        let slope: number;
        if (known.length > 1) {
          slope = (last.factor - first.factor) / (last.index - first.index);
        } else if (first.index === 0) {
          // dragging the head: the next member holds still
          slope = -first.factor;
        } else if (first.index === link.ids.length - 1) {
          // dragging the tail: the previous member holds still
          slope = first.factor;
        } else {
          // dragging from inside: the whole chain travels together
          slope = 0;
        }
        const intercept = first.factor - slope * first.index;

        link.ids.forEach((id, index) => {
          if (!factors.has(id)) {
            // 0 is recorded rather than left absent, so a chain further
            // along can solve against a member that holds still
            factors.set(id, intercept + slope * index);
            changed = true;
          }
        });
      }
    }
    return changed;
  };

  // Groups are spread before the chains solve, so a chain solving against
  // a grouped member sees the factor the group actually gives it rather
  // than pinning it and having the group contradict that afterwards.
  for (let pass = 0; pass < MAX_DRAG_FACTOR_PASSES; pass++) {
    const spread = spreadEdgeLinks();
    const grouped = spreadAcrossGroups(factors, groupMembers);
    const solved = solveChains();
    if (!spread && !grouped && !solved) {
      break;
    }
  }

  return factors;
};

/**
 * Which elements move on each axis when `seeds` are dragged, following
 * hard-alignment links transitively. An element hard-aligned to a seed
 * on the x axis shifts horizontally with it (and likewise for y); the
 * two axes are independent, so an element may comove on one, both, or
 * neither. Includes the seeds themselves. Used by the snapping system to
 * drop a comoving partner's stale snap points on the axis it tracks.
 *
 * Membership, not distance: an element that follows at half the offset
 * has just as stale a snap point as one that follows at the full offset.
 */
export const getAlignmentMovers = (
  seeds: Set<string>,
  elementsMap: ElementsMap,
): { x: Set<string>; y: Set<string> } => {
  const moversOn = (axis: Axis) => {
    const moving = new Set<string>();
    for (const [id, factor] of getAlignmentDragFactors(
      seeds,
      axis,
      elementsMap,
    )) {
      if (factor !== 0) {
        moving.add(id);
      }
    }
    return moving;
  };
  return { x: moversOn("x"), y: moversOn("y") };
};

/**
 * Which axes a drag of `directlyMovedIds` is frozen on by an alignment
 * anchor. If preserving the alignments on an axis would require moving
 * an anchored element that isn't itself being dragged, that element
 * can't be pushed — and since the rest is rigidly tied to it, nothing on
 * that axis can move, so the offset is zeroed there. An anchor that *is*
 * being dragged is the direct target and doesn't freeze itself.
 *
 * Only elements that would actually have to move count. An anchor on the
 * far side of a gap triple keeps its factor of 0 when an outer is
 * dragged, so it no longer freezes a drag it was never in the way of.
 */
export const getAlignmentLockedAxes = (
  directlyMovedIds: Set<string>,
  elementsMap: ElementsMap,
): { x: boolean; y: boolean } => {
  const frozenOn = (axis: Axis): boolean => {
    for (const [id, factor] of getAlignmentDragFactors(
      directlyMovedIds,
      axis,
      elementsMap,
    )) {
      if (
        factor !== 0 &&
        !directlyMovedIds.has(id) &&
        isAlignmentAnchor(elementsMap.get(id))
      ) {
        return true;
      }
    }
    return false;
  };
  return { x: frozenOn("x"), y: frozenOn("y") };
};

/**
 * Which axes a resize of `resizedIds` is frozen on because the alignment
 * constraints there are over-determined.
 *
 * Partners are translated, never resized, so every alignment a partner
 * holds with a resized element demands one translation of it. Locking A
 * and B on x at *both* their left and right edges says "A and B span the
 * same x range", which pins A's width to B's: widening A moves its right
 * edge but not its left, so B is asked to shift by two different amounts
 * at once. No translation satisfies both, and rather than silently
 * dropping one alignment we refuse the size change on that axis — the
 * same move alignment anchors make for drags.
 *
 * Detection needs no geometry: it's enough that a rigid partner
 * component receives demands from two distinct `(driver, selfEdge)`
 * sources, since two different driver edges never move together under a
 * resize. Demands from two *different* drivers are treated as conflicting
 * too — they can move independently, and we can't prove otherwise
 * up front.
 */
export const getAlignmentResizeLockedAxes = (
  resizedIds: Set<string>,
  elementsMap: ElementsMap,
): { x: boolean; y: boolean } => {
  const overConstrainedOn = (axis: Axis): boolean => {
    // The links the resize itself imposes: partner id -> demand source.
    // Mirrors the seeding in `resizeAlignedElements`, including its two
    // exclusions (a resized element moved under the pointer, an anchored
    // one is never pushed).
    const isDrivable = (id: string) =>
      !resizedIds.has(id) && !isAlignmentAnchor(elementsMap.get(id));

    const seeds = new Map<string, string>();
    for (const driverId of resizedIds) {
      for (const link of elementsMap.get(driverId)?.alignments ?? []) {
        if (link.axis !== axis || !isDrivable(link.elementId)) {
          continue;
        }
        const source = `${driverId}:${link.selfEdge}`;
        const existing = seeds.get(link.elementId);
        if (existing !== undefined && existing !== source) {
          return true;
        }
        seeds.set(link.elementId, source);
      }
    }

    // A demand doesn't stop at the direct partner: it floods through
    // same-axis links (as `floodAxis` does), and everything it reaches
    // moves rigidly with it. So two seeds meeting in one component
    // conflict just as surely as two demands on one element.
    const sourceOf = new Map<string, string>();
    for (const [seedId, source] of seeds) {
      const queue = [seedId];
      while (queue.length > 0) {
        const id = queue.pop()!;
        const seen = sourceOf.get(id);
        if (seen !== undefined) {
          if (seen !== source) {
            return true;
          }
          continue;
        }
        sourceOf.set(id, source);
        for (const link of elementsMap.get(id)?.alignments ?? []) {
          if (link.axis === axis && isDrivable(link.elementId)) {
            queue.push(link.elementId);
          }
        }
      }
    }
    return false;
  };

  return { x: overConstrainedOn("x"), y: overConstrainedOn("y") };
};

/**
 * The anchors that block a resize of `resizedIds`, per axis: elements
 * that preserving an alignment there would require moving, and that
 * anchoring forbids moving. A non-empty set means that axis is frozen —
 * and *which* anchors are in it is what the drag-style anvil overlay
 * needs in order to point at the reason.
 *
 * The drag counterpart is `getAlignmentLockedAxes`; the difference is
 * that a resize doesn't move the whole element, only some of its edges,
 * so this is a question about *edges* rather than the axis as a whole. If
 * A's left edge is locked to an anchored B, dragging A's right handle is
 * fine — A's left edge never moves — while dragging its left handle would
 * ask B to follow, which anchoring forbids. So the axis is frozen only
 * when the resize actually moves an edge that carries a demand onto an
 * anchor.
 *
 * As with drags, a demand doesn't stop at the direct partner: it floods
 * through same-axis links, so an anchor anywhere in the partner's rigid
 * component freezes the resize just the same.
 */
export type ResizeEdgeOpts = {
  handle: string | false;
  shouldResizeFromCenter: boolean;
  /**
   * Treat every edge as moving. True when the geometry doesn't let us
   * say which edges the handle holds still — a rotated element, whose
   * bounds both move with either dimension, or a multi-element resize,
   * where members move by a box scale rather than by the handle.
   */
  allEdgesMove: boolean;
};

/**
 * Whether a resize moves a given edge of a resized element. Shared with
 * the equal-gap blocker, which asks the same question of the edges that
 * bound a chain's gaps.
 */
export const resizeMovesEdge = (
  axis: Axis,
  edge: Edge,
  opts: ResizeEdgeOpts,
): boolean => {
  if (opts.allEdgesMove) {
    return true;
  }
  if (!opts.handle) {
    return false;
  }
  if (opts.shouldResizeFromCenter) {
    // both bounds grow outward, the centre stays put
    return edge !== "center";
  }
  // "nw" / "w" hold the right edge and move the left, and so on
  const movesMin = opts.handle.includes(axis === "x" ? "w" : "n");
  const movesMax = opts.handle.includes(axis === "x" ? "e" : "s");
  if (!movesMin && !movesMax) {
    // a pure "n" / "s" handle doesn't touch x at all
    return false;
  }
  // whichever side moves, the centre moves with it (by half)
  return edge === "center" || (edge === "min" ? movesMin : movesMax);
};

export const getAlignmentAnchoredResizeBlockers = (
  resizedIds: Set<string>,
  elementsMap: ElementsMap,
  opts: ResizeEdgeOpts,
): { x: Set<string>; y: Set<string> } => {
  const movesEdge = (axis: Axis, edge: Edge) =>
    resizeMovesEdge(axis, edge, opts);

  const blockersOn = (axis: Axis): Set<string> => {
    const blockers = new Set<string>();

    /** Every anchor the demand on `startId` reaches. Propagation doesn't
     * stop at the first one: each is equally a reason the resize is
     * refused, and the overlay marks them all. */
    const collectAnchors = (startId: string) => {
      // resized elements are barriers: they move under the pointer, and
      // an anchored one being resized is a direct action, not a push
      const seen = new Set<string>(resizedIds);
      const queue = [startId];
      while (queue.length > 0) {
        const id = queue.pop()!;
        if (seen.has(id)) {
          continue;
        }
        seen.add(id);
        if (isAlignmentAnchor(elementsMap.get(id))) {
          blockers.add(id);
          // an anchor doesn't move, so nothing past it is demanded
          continue;
        }
        for (const link of elementsMap.get(id)?.alignments ?? []) {
          if (link.axis === axis) {
            queue.push(link.elementId);
          }
        }
      }
    };

    for (const driverId of resizedIds) {
      for (const link of elementsMap.get(driverId)?.alignments ?? []) {
        if (
          link.axis === axis &&
          !resizedIds.has(link.elementId) &&
          movesEdge(axis, link.selfEdge)
        ) {
          collectAnchors(link.elementId);
        }
      }
    }
    return blockers;
  };

  return { x: blockersOn("x"), y: blockersOn("y") };
};

/**
 * Which elements a resize of `resizedIds` sets moving, per axis — the
 * resize counterpart of {@link getAlignmentMovers}.
 *
 * A resize propagates differently from a drag, and the difference is the
 * edge: a drag moves an element whole, so every link it holds transmits,
 * whereas a resize moves only the edges its handle controls. A link
 * anchored to an edge that stays put demands nothing, so it moves nothing
 * — which is why this asks {@link resizeMovesEdge} per link rather than
 * flooding from the resized element outright.
 *
 * A resized element is itself reported as moving on an axis when at least
 * one of its links there is transmitting. That makes the answer usable as
 * a plain "does this element move on this axis" test, including for the
 * driver, while still leaving out a driver whose links all hang off
 * stationary edges.
 *
 * The flood stops at anchors, and it never starts on an axis the resize
 * is frozen on: an anchor in the way refuses the size change entirely
 * (`clampSizeToFrozenAlignmentAxes`), so nothing on that axis moves at
 * all — including the partners that would otherwise have followed.
 */
export const getAlignmentResizeMovers = (
  resizedIds: Set<string>,
  elementsMap: ElementsMap,
  opts: ResizeEdgeOpts,
  frozen: { x: boolean; y: boolean },
): { x: Set<string>; y: Set<string> } => {
  const moversOn = (axis: Axis): Set<string> => {
    const movers = new Set<string>();
    if (frozen[axis]) {
      return movers;
    }

    /** Everything the demand on `startId` carries to, anchors excluded —
     * an anchor holds still, so nothing past it is reached either. */
    const flood = (startId: string) => {
      const queue = [startId];
      while (queue.length > 0) {
        const id = queue.pop()!;
        if (movers.has(id) || resizedIds.has(id)) {
          continue;
        }
        if (isAlignmentAnchor(elementsMap.get(id))) {
          continue;
        }
        movers.add(id);
        for (const link of elementsMap.get(id)?.alignments ?? []) {
          if (link.axis === axis) {
            queue.push(link.elementId);
          }
        }
      }
    };

    for (const driverId of resizedIds) {
      for (const link of elementsMap.get(driverId)?.alignments ?? []) {
        if (
          link.axis === axis &&
          !resizedIds.has(link.elementId) &&
          resizeMovesEdge(axis, link.selfEdge, opts)
        ) {
          movers.add(driverId);
          flood(link.elementId);
        }
      }
    }
    return movers;
  };

  return { x: moversOn("x"), y: moversOn("y") };
};

/**
 * After the directly-dragged elements have been moved by `offset`, drag
 * their hard-aligned partners to preserve the alignment.
 *
 * Handled per-axis and per-element: `getAlignmentDragFactors` says what
 * multiple of `offset` each partner takes on each axis, which is 1 for
 * everything an edge alignment reaches and may be a fraction across a
 * gap triple. An element may be pulled on one axis, both, or neither.
 * Partner positions are computed from their drag-start snapshot
 * (`originalElements`, which holds every element), so repeated
 * pointermove events don't accumulate drift.
 *
 * `directlyMovedIds` are skipped — they were already moved by the caller
 * (with snapping / grid applied); partners inherit from that final
 * offset.
 */
export const dragAlignedElements = (
  originalElements: PointerDownState["originalElements"],
  directlyMovedIds: Set<string>,
  offset: { x: number; y: number },
  scene: Scene,
) => {
  const elementsMap = scene.getNonDeletedElementsMap();

  const xFactors = getAlignmentDragFactors(directlyMovedIds, "x", elementsMap);
  const yFactors = getAlignmentDragFactors(directlyMovedIds, "y", elementsMap);

  const partners = new Set<string>();
  for (const id of [...xFactors.keys(), ...yFactors.keys()]) {
    // a factor of 0 is a real answer — "this one holds still" — so it is
    // in the map but has nothing to write
    if (
      !directlyMovedIds.has(id) &&
      ((xFactors.get(id) ?? 0) !== 0 || (yFactors.get(id) ?? 0) !== 0)
    ) {
      partners.add(id);
    }
  }

  for (const id of partners) {
    const element = elementsMap.get(id);
    if (!element) {
      continue;
    }
    const dx = offset.x * (xFactors.get(id) ?? 0);
    const dy = offset.y * (yFactors.get(id) ?? 0);

    const translate = (target: ExcalidrawElement) => {
      const original = originalElements.get(target.id) ?? target;
      scene.mutateElement(target, {
        x: original.x + dx,
        y: original.y + dy,
      });
    };

    translate(element);
    // A container's label is positioned absolutely rather than relative
    // to its container, so it has to be carried by hand — exactly as the
    // direct drag does in `dragElements.ts`. That code also skips arrow
    // labels (their position is recomputed at render time); no check is
    // needed here, since `isAlignable` keeps arrows out of alignment
    // altogether.
    const boundText = getBoundTextElement(element, elementsMap);
    if (boundText) {
      translate(boundText);
    }
    updateBoundElements(element, scene);
  }
};

/**
 * Flood a per-axis translation outward through same-axis alignment
 * links. `deltaById` starts seeded with the elements whose translation
 * is already known (the resized elements' direct partners); every
 * further element reachable by same-axis links inherits its neighbour's
 * delta, so a chain A—B—C all shifts together.
 *
 * Already-seeded entries are authoritative (never overwritten), and
 * `barriers` (the resized elements themselves) are never entered — they
 * moved under the pointer, not by a uniform translation.
 */
export const floodAlignmentAxis = (
  deltaById: Map<string, number>,
  axis: Axis,
  barriers: Set<string>,
  elementsMap: ElementsMap,
) => {
  const flood = (): boolean => {
    let changed = false;
    const queue = [...deltaById.keys()];
    while (queue.length > 0) {
      const id = queue.pop()!;
      const delta = deltaById.get(id)!;
      const links = elementsMap.get(id)?.alignments;
      if (!links) {
        continue;
      }
      for (const link of links) {
        if (
          link.axis === axis &&
          !barriers.has(link.elementId) &&
          !deltaById.has(link.elementId) &&
          // an anchor stops propagation — the chain doesn't move past it
          !isAlignmentAnchor(elementsMap.get(link.elementId))
        ) {
          deltaById.set(link.elementId, delta);
          queue.push(link.elementId);
          changed = true;
        }
      }
    }
    return changed;
  };

  // A group translates as one, so a member the flood reaches carries its
  // siblings — and those siblings have links of their own to flood on
  // from, hence the alternation rather than a single pass at the end.
  // Both steps only add entries, so this settles.
  const groupMembers = getGroupMembers(elementsMap);
  const skip = (id: string) =>
    // the resized elements moved under the pointer, not by a translation,
    // and an anchor must not move at all
    barriers.has(id) || isAlignmentAnchor(elementsMap.get(id));

  for (;;) {
    const flooded = flood();
    const grouped = spreadAcrossGroups(deltaById, groupMembers, skip);
    if (!flooded && !grouped) {
      break;
    }
  }
};

/**
 * The per-axis translation each element needs after a resize so that
 * every hard *edge* alignment survives it.
 *
 * Split out from the application step so an equal-gap correction pass
 * can extend the same maps before anything is written to the scene (see
 * `propagateAlignmentsAfterResize` in `gapAlignment.ts`). Working in
 * deltas off the resize-start snapshot — rather than nudging live
 * positions — is also what keeps repeated pointermove events from
 * accumulating drift.
 *
 * Unlike a drag, a resize moves each edge by a different amount, so a
 * direct partner is translated by the change in the *specific* shared
 * coordinate recorded on the link (`edge`): if a partner is left-aligned
 * (x/min) with a resized element whose left edge moved by `d`, it shifts
 * by `d` on x. Partners are translated, never resized — matching the
 * drag behavior.
 *
 * The translation then ripples transitively: a partner's own partners
 * (and theirs, …) inherit the same per-axis shift, so a whole aligned
 * chain moves as one. Positions are computed from the resize-start
 * snapshot to avoid drift across pointermove events. Resized elements
 * are barriers — they moved under the pointer and are never dragged by
 * this pass.
 */
export const buildResizeAlignmentDeltas = (
  originalElements: PointerDownState["originalElements"],
  resizedIds: Set<string>,
  elementsMap: ElementsMap,
): { dxById: Map<string, number>; dyById: Map<string, number> } => {
  // Per-axis translation, seeded from the resized elements' direct
  // partners then flooded outward.
  const dxById = new Map<string, number>();
  const dyById = new Map<string, number>();

  for (const driverId of resizedIds) {
    const driver = elementsMap.get(driverId);
    const origDriver = originalElements.get(driverId);
    if (!driver || !origDriver || !driver.alignments?.length) {
      continue;
    }

    const newBounds = getElementBounds(driver, elementsMap);
    const origBounds = getElementBounds(origDriver, elementsMap);

    for (const link of driver.alignments) {
      if (
        resizedIds.has(link.elementId) ||
        // an anchored partner is never pushed — the size change that
        // would have moved it was already refused by
        // `getAlignmentAnchoredResizeAxes`, so this is a backstop
        isAlignmentAnchor(elementsMap.get(link.elementId))
      ) {
        continue;
      }
      // The driver's own edge is what moved; the partner translates
      // rigidly, so its `otherEdge` tracks it automatically.
      const delta =
        edgeCoord(newBounds, link.axis, link.selfEdge) -
        edgeCoord(origBounds, link.axis, link.selfEdge);
      // Direct partners are authoritative. Conflicting demands should
      // not reach here — `getAlignmentResizeLockedAxes` freezes the
      // resize on an over-determined axis before any geometry changes —
      // so first-wins is just a deterministic backstop.
      const deltaById = link.axis === "x" ? dxById : dyById;
      if (!deltaById.has(link.elementId)) {
        deltaById.set(link.elementId, delta);
      }
    }
  }

  floodAlignmentAxis(dxById, "x", resizedIds, elementsMap);
  floodAlignmentAxis(dyById, "y", resizedIds, elementsMap);

  return { dxById, dyById };
};

/**
 * Write the accumulated per-axis translations to the scene, each element
 * placed relative to its resize-start position.
 */
export const applyAlignmentDeltas = (
  originalElements: PointerDownState["originalElements"],
  dxById: ReadonlyMap<string, number>,
  dyById: ReadonlyMap<string, number>,
  scene: Scene,
) => {
  const elementsMap = scene.getNonDeletedElementsMap();
  const movedIds = new Set<string>([...dxById.keys(), ...dyById.keys()]);
  for (const id of movedIds) {
    const partner = elementsMap.get(id);
    if (!partner) {
      continue;
    }
    const dx = dxById.get(id) ?? 0;
    const dy = dyById.get(id) ?? 0;

    const translate = (target: ExcalidrawElement) => {
      const original = originalElements.get(target.id) ?? target;
      scene.mutateElement(target, { x: original.x + dx, y: original.y + dy });
    };

    translate(partner);
    // the container's label rides along — see `dragAlignedElements`
    const boundText = getBoundTextElement(partner, elementsMap);
    if (boundText) {
      translate(boundText);
    }
    updateBoundElements(partner, scene);
  }
};
