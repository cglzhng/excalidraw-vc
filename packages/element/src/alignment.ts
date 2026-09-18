import type { Bounds } from "@excalidraw/common";

import {
  alignmentAnchorsInPlay,
  alignmentDragDriver,
  alignmentDriverFromEdgeDeltas,
  applyAlignmentResponse,
  getGroupMembers,
  isAlignmentAnchor,
  solveAlignmentResponse,
} from "./alignmentSolve";
import { updateBoundElements } from "./binding";
import { getElementBounds } from "./bounds";
import { newElementWith } from "./mutateElement";
import { getBoundTextElement, handleBindTextResize } from "./textElement";
import { isBoundToContainer, isLinearElement } from "./typeChecks";

import type { PointerDownState } from "@excalidraw/excalidraw/types";

import type { AlignmentResponse, EdgeDelta } from "./alignmentSolve";
import type { Scene } from "./Scene";
import type {
  AlignmentEdge,
  ElementAlignment,
  ElementsMap,
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "./types";

// `isAlignmentAnchor` and `getGroupMembers` live in `alignmentSolve.ts`, which
// this file will come to depend on and so must not depend on it. Re-exported
// here because everything else reaches them through this module.
export { getGroupMembers, isAlignmentAnchor };

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
 * Put several guides into one state in a single edit — the concentric
 * badge's gesture, which keeps or releases both centre alignments of a
 * pair at once. Each edit reads what the ones before it wrote: links
 * between the same pair land on the same two elements, and the second
 * would otherwise overwrite the first. Guides already in the requested
 * state are left alone.
 */
export const setAlignmentPairsLocked = (
  guides: readonly AlignmentGuide[],
  lock: boolean,
  elementsMap: ElementsMap,
): Map<string, ExcalidrawElement> => {
  const updated = new Map<string, ExcalidrawElement>();
  const current: ElementsMap = new Map(elementsMap);
  for (const guide of guides) {
    if (guide.hard === lock) {
      continue;
    }
    const edit = lock
      ? lockAlignmentPair(guide, current)
      : unlockAlignmentPair(guide, current);
    for (const [id, element] of edit) {
      current.set(id, element);
      updated.set(id, element);
    }
  }
  return updated;
};

/**
 * The links `element` would keep if every partner that isn't live were
 * released, or null if none of them name a partner that's gone.
 *
 * A gap chain with a missing member is dropped whole rather than
 * shortened: lose a middle member and the gaps either side of it merge
 * into one, so the spacing the chain asserted no longer exists anywhere.
 */
export const pruneAlignmentLinks = (
  element: ExcalidrawElement,
  isLive: (id: string) => boolean,
): {
  alignments?: ExcalidrawElement["alignments"];
  gapAlignments?: ExcalidrawElement["gapAlignments"];
} | null => {
  const alignments = element.alignments?.filter((link) =>
    isLive(link.elementId),
  );
  const gapAlignments = element.gapAlignments?.filter((link) =>
    link.ids.every(isLive),
  );
  const changed =
    (alignments?.length ?? 0) !== (element.alignments?.length ?? 0) ||
    (gapAlignments?.length ?? 0) !== (element.gapAlignments?.length ?? 0);
  return changed ? { alignments, gapAlignments } : null;
};

/**
 * Release every alignment that names a deleted element — the alignment
 * counterpart of `fixBindingsAfterDeletion`, called from the same places
 * a deletion is made.
 *
 * Left alone, the link doesn't go away with its partner: it stays on the
 * survivor, which then behaves as if still held by something no longer
 * on the canvas. And it can't be released by hand, because a guide needs
 * both ends to draw — no line, so no badge to click.
 *
 * `elements` must be the whole scene, deleted elements included, since
 * anything not live in it counts as gone. Survivors that change come back
 * through `newElementWith`, so the release lands in the same captured
 * update as the deletion and one undo restores both. The deleted elements
 * keep their own links for the same reason.
 */
export const releaseAlignmentsToDeleted = <T extends ExcalidrawElement>(
  elements: readonly T[],
): T[] => {
  const live = new Set(
    elements.filter((element) => !element.isDeleted).map((e) => e.id),
  );
  return elements.map((element) => {
    if (element.isDeleted) {
      return element;
    }
    const updates = pruneAlignmentLinks(element, (id) => live.has(id));
    // the two link fields exist on every element type alike
    return updates
      ? (newElementWith(element as ExcalidrawElement, updates) as T)
      : element;
  });
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

/** Smallest extent alignment will leave an element with. Enough to keep
 * every constraint well defined — an element with a positive extent still
 * has a min edge below its max — without meaningfully limiting how small
 * anything can be drawn. */
export const MIN_ALIGNED_SIZE = 2;

/**
 * The anchors that would have to move for `id` to be *translated* on
 * `axis`: every anchor in its hard edge-link component.
 *
 * A translation passes through every link unchanged, so translating one
 * element takes its whole component with it. An anchor anywhere in there
 * means it cannot travel at all — which is the question both propagators
 * ask, of a partner that has been handed a demand and of a chain member
 * the equal-gap correction wants to shift.
 *
 * `barriers` are elements the component stops at: during a resize, the
 * resized elements are the *source* of the demand rather than carriers of
 * it, so a component must not be joined through one.
 */
export const getTranslationBlockingAnchors = (
  id: string,
  axis: Axis,
  elementsMap: ElementsMap,
  barriers: ReadonlySet<string> = new Set(),
): Set<string> => {
  const anchors = new Set<string>();
  const seen = new Set<string>([id]);
  const stack = [id];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (isAlignmentAnchor(elementsMap.get(current))) {
      anchors.add(current);
    }
    for (const link of elementsMap.get(current)?.alignments ?? []) {
      if (
        link.axis === axis &&
        !seen.has(link.elementId) &&
        !barriers.has(link.elementId)
      ) {
        seen.add(link.elementId);
        stack.push(link.elementId);
      }
    }
  }
  return anchors;
};

/** What the scene does per unit of drag offset, on each axis. */
export type AlignmentDragResponse = {
  x: AlignmentResponse;
  y: AlignmentResponse;
};

export const getAlignmentDragResponse = (
  draggedIds: Set<string>,
  elementsMap: ElementsMap,
): AlignmentDragResponse => {
  const driver = alignmentDragDriver(draggedIds);
  return {
    x: solveAlignmentResponse(driver, "x", elementsMap),
    y: solveAlignmentResponse(driver, "y", elementsMap),
  };
};

/**
 * How far each of an element's two edges travels on `axis`, as a multiple of
 * the drag offset.
 *
 * Both edges, not one displacement per element, because a drag can now change
 * a partner's size: the edge the drag pulls moves while the edge an anchor
 * holds does not. Anything anchored to a *particular* edge — a snap point on a
 * corner, the side of a gap — has to ask about that edge rather than about the
 * element.
 *
 * Empty on an axis the drag is refused on, where nothing moves at all.
 */
export const getAlignmentDragEdgeFactors = (
  seeds: Set<string>,
  axis: Axis,
  elementsMap: ElementsMap,
): Map<string, EdgeDelta> => {
  const response = solveAlignmentResponse(
    alignmentDragDriver(seeds),
    axis,
    elementsMap,
  );
  const factors = new Map<string, EdgeDelta>();
  for (const [id, perDof] of response.byElement) {
    factors.set(id, perDof[0]);
  }
  return factors;
};

/**
 * Which elements move on each axis when `seeds` are dragged. The two axes are
 * independent, so an element may comove on one, both or neither. Includes the
 * seeds. Used by the snapping system to drop a comoving partner's stale snap
 * points on the axis it tracks.
 *
 * Membership, not distance: an element that follows at half the offset has
 * just as stale a snap point as one that follows at the full offset — and one
 * that only *stretches* has a stale far edge, so it counts too.
 *
 * Also carries the anchors the overlay should name: `refusing` where the drag
 * is impossible and they are why, `permitting` where it goes through but they
 * shaped where things landed.
 */
export type AlignmentMovers = {
  x: Set<string>;
  y: Set<string>;
  pinAnchors: { permitting: Set<string>; refusing: Set<string> };
};

export const getAlignmentMovers = (
  seeds: Set<string>,
  elementsMap: ElementsMap,
): AlignmentMovers => {
  const driver = alignmentDragDriver(seeds);
  const pinAnchors = {
    permitting: new Set<string>(),
    refusing: new Set<string>(),
  };
  const moversOn = (axis: Axis) => {
    const response = solveAlignmentResponse(driver, axis, elementsMap);
    const moving = new Set<string>();
    if (!response.feasible) {
      response.blockers.forEach((id) => pinAnchors.refusing.add(id));
      return moving;
    }
    alignmentAnchorsInPlay(driver, axis, elementsMap).forEach((id) =>
      pinAnchors.permitting.add(id),
    );
    for (const [id, perDof] of response.byElement) {
      if (perDof[0].min !== 0 || perDof[0].max !== 0) {
        moving.add(id);
      }
    }
    return moving;
  };
  return { x: moversOn("x"), y: moversOn("y"), pinAnchors };
};

/**
 * Which axes a drag of `directlyMovedIds` is refused on.
 *
 * Far fewer than before the engine could answer with a size change. An anchor
 * in the way used to freeze the axis outright, because everything the drag
 * reached could only be translated and a translation carries a whole rigid
 * component with it. A partner between the drag and the anchor now stretches
 * instead, and the drag goes through. What is left is the genuinely
 * impossible: an arrangement where no displacement of anything satisfies the
 * constraints — the driver linked directly to an anchor on the edge it is
 * pulling, say.
 */
export const getAlignmentLockedAxes = (
  directlyMovedIds: Set<string>,
  elementsMap: ElementsMap,
): { x: boolean; y: boolean } => {
  const response = getAlignmentDragResponse(directlyMovedIds, elementsMap);
  return { x: !response.x.feasible, y: !response.y.feasible };
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

/** The seeds that stand for "which of the driver's edges does this handle
 * move" — 1 for one it moves, 0 for one it holds. Every "is this non-zero"
 * test on the response then reads as "does this move at all", so the anchors
 * the real solve will find are found without any geometry. */
const symbolicResizeSeeds = (
  axis: Axis,
  resizedIds: Set<string>,
  elementsMap: ElementsMap,
  opts: ResizeEdgeOpts,
): Map<string, EdgeDelta> => {
  const seeds = new Map<string, EdgeDelta>();
  for (const driverId of resizedIds) {
    const driver = elementsMap.get(driverId);
    if (!driver?.alignments?.length && !driver?.gapAlignments?.length) {
      continue;
    }
    seeds.set(driverId, {
      min: resizeMovesEdge(axis, "min", opts) ? 1 : 0,
      max: resizeMovesEdge(axis, "max", opts) ? 1 : 0,
    });
  }
  return seeds;
};

/**
 * Everything the UI needs to know about a resize before it happens: which
 * axes it is refused on and by which anchors, which anchors are forcing
 * something to change size rather than move, and what it sets moving.
 *
 * One question, so one solve. These used to be four functions over three
 * different propagations — an over-determination check, an edge-link anchor
 * pass, an equal-gap anchor pass, and two movers passes — and keeping their
 * notions of "refused" in step with each other, and with what the resize then
 * actually did, was a standing hazard. Now the prediction *is* the solve, run
 * against symbolic seeds instead of measured ones.
 *
 * `frozen` is its own answer rather than `blockers.size > 0`: a system can be
 * contradictory with no anchor involved at all — two drivers pulling one
 * partner in different directions, say — and the axis is refused just the
 * same, with nothing to point at.
 */
export type ResizeAlignmentEffects = {
  frozen: { x: boolean; y: boolean };
  /** anchors that refuse the resize outright */
  blockers: { x: Set<string>; y: Set<string> };
  /** anchors that permit it but force a partner to change size — the reason
   * an element stretched instead of travelling */
  causes: { x: Set<string>; y: Set<string> };
  /** everything the resize sets moving, drivers included */
  movers: { x: Set<string>; y: Set<string> };
};

export const getAlignmentResizeEffects = (
  resizedIds: Set<string>,
  elementsMap: ElementsMap,
  opts: ResizeEdgeOpts,
): ResizeAlignmentEffects => {
  const onAxis = (axis: Axis) => {
    const seeds = symbolicResizeSeeds(axis, resizedIds, elementsMap, opts);
    const response = solveAlignmentResponse(
      alignmentDriverFromEdgeDeltas(seeds),
      axis,
      elementsMap,
    );

    if (!response.feasible) {
      return {
        frozen: true,
        blockers: new Set(response.blockers),
        causes: new Set<string>(),
        movers: new Set<string>(),
      };
    }

    const movers = new Set<string>();
    for (const [id, perDof] of response.byElement) {
      if (perDof[0].min !== 0 || perDof[0].max !== 0) {
        movers.add(id);
      }
    }

    // An element only stretched because it could not travel, and what stops
    // it travelling is an anchor somewhere in its rigid component. Those are
    // the anchors worth naming, even though they refuse nothing.
    const causes = new Set<string>();
    for (const id of response.stretchers) {
      for (const anchorId of getTranslationBlockingAnchors(
        id,
        axis,
        elementsMap,
        resizedIds,
      )) {
        causes.add(anchorId);
      }
    }

    return { frozen: false, blockers: new Set<string>(), causes, movers };
  };

  const x = onAxis("x");
  const y = onAxis("y");
  return {
    frozen: { x: x.frozen, y: y.frozen },
    blockers: { x: x.blockers, y: y.blockers },
    causes: { x: x.causes, y: y.causes },
    movers: { x: x.movers, y: y.movers },
  };
};

/**
 * After the directly-dragged elements have been moved by `offset`, move and
 * resize their hard-aligned partners to preserve the alignment.
 *
 * Handled per-axis and per-edge: the drag response says how far each of a
 * partner's two edges travels per unit of `offset`, which is 1 on both for
 * everything an edge alignment carries rigidly, may be a fraction across a
 * gap chain, and differs between the two edges for a partner that has to
 * stretch because an anchor stops it travelling. Partner positions are
 * computed from their drag-start snapshot
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
  const response = getAlignmentDragResponse(directlyMovedIds, elementsMap);

  const dxById = new Map<string, number>();
  const dyById = new Map<string, number>();
  const dwById = new Map<string, number>();
  const dhById = new Map<string, number>();

  for (const axis of ["x", "y"] as const) {
    const deltas = applyAlignmentResponse(response[axis], [offset[axis]]);
    const positionById = axis === "x" ? dxById : dyById;
    const sizeById = axis === "x" ? dwById : dhById;
    for (const [id, delta] of deltas) {
      // A delta of zero is a real answer — "this one holds still" — and the
      // directly dragged elements were already placed by the caller, with
      // snapping and the grid applied.
      if (directlyMovedIds.has(id) || (delta.min === 0 && delta.max === 0)) {
        continue;
      }
      positionById.set(id, delta.min);
      if (delta.max !== delta.min) {
        sizeById.set(id, delta.max - delta.min);
      }
    }
  }

  // Groups are a post-pass over what the solve placed rather than constraints
  // in it, so a member it moved carries its siblings here.
  const groupMembers = getGroupMembers(elementsMap);
  const skip = (id: string) =>
    directlyMovedIds.has(id) || isAlignmentAnchor(elementsMap.get(id));
  spreadAcrossGroups(dxById, groupMembers, skip);
  spreadAcrossGroups(dyById, groupMembers, skip);

  // The same writer the resize path uses. Worth sharing now rather than
  // translating by hand as this used to: a drag can change a partner's size,
  // so it has the container-label question — carry it or refit it — that only
  // the resize path used to have.
  applyAlignmentDeltas(originalElements, dxById, dyById, dwById, dhById, scene);
};

/** The driver seeds for one axis, read off how far each resized element's
 * bounds have actually moved. */
const geometricResizeSeeds = (
  axis: Axis,
  originalElements: PointerDownState["originalElements"],
  resizedIds: Set<string>,
  elementsMap: ElementsMap,
): Map<string, EdgeDelta> => {
  const seeds = new Map<string, EdgeDelta>();
  for (const driverId of resizedIds) {
    const driver = elementsMap.get(driverId);
    const original = originalElements.get(driverId);
    if (
      !driver ||
      !original ||
      (!driver.alignments?.length && !driver.gapAlignments?.length)
    ) {
      continue;
    }
    const now = getElementBounds(driver, elementsMap);
    const was = getElementBounds(original, elementsMap);
    seeds.set(driverId, {
      min: edgeCoord(now, axis, "min") - edgeCoord(was, axis, "min"),
      max: edgeCoord(now, axis, "max") - edgeCoord(was, axis, "max"),
    });
  }
  return seeds;
};

/**
 * What every element must do so that a resize of `resizedIds` leaves every
 * hard alignment — edge links and equal-gap chains alike — intact.
 *
 * Both kinds in one solve, which is the whole of the change here. They used to
 * be two passes: an edge propagation, then an equal-gap correction that had to
 * treat whatever the first pass placed as immovable and iterate towards a fixed
 * point it was not guaranteed to reach. A member subject to both was the
 * awkward case, and it is no longer a case at all — its link and its chain are
 * two rows of one system.
 *
 * Deltas off the resize-start snapshot rather than nudges to live positions,
 * so repeated pointermove events can't accumulate drift.
 */
export const buildResizeAlignmentDeltas = (
  originalElements: PointerDownState["originalElements"],
  resizedIds: Set<string>,
  elementsMap: ElementsMap,
): {
  dxById: Map<string, number>;
  dyById: Map<string, number>;
  dwById: Map<string, number>;
  dhById: Map<string, number>;
} => {
  // Position and size rather than the pair of edges the solve works in:
  // a translation is then still a lone entry in `dxById`, which is what
  // every reader of these maps already understands, and only the ones
  // that care about an element's far edge need consult the size.
  const dxById = new Map<string, number>();
  const dyById = new Map<string, number>();
  const dwById = new Map<string, number>();
  const dhById = new Map<string, number>();

  for (const axis of ["x", "y"] as const) {
    const seeds = geometricResizeSeeds(
      axis,
      originalElements,
      resizedIds,
      elementsMap,
    );
    if (seeds.size === 0) {
      continue;
    }
    const response = solveAlignmentResponse(
      alignmentDriverFromEdgeDeltas(seeds),
      axis,
      elementsMap,
    );
    if (!response.feasible) {
      // The size change was refused up front, so there is nothing to carry.
      // Reaching here at all means the clamp let a gesture through that the
      // solve then couldn't answer, which is a bug rather than a state to
      // paper over — but writing a partial answer would break an alignment,
      // and holding still doesn't.
      continue;
    }
    // Evaluated at 1, since the seeds *are* the measurements.
    const deltas = applyAlignmentResponse(response, [1]);
    const positionById = axis === "x" ? dxById : dyById;
    const sizeById = axis === "x" ? dwById : dhById;
    for (const [id, delta] of deltas) {
      if (resizedIds.has(id) || (delta.min === 0 && delta.max === 0)) {
        continue;
      }
      positionById.set(id, delta.min);
      if (delta.max !== delta.min) {
        sizeById.set(id, delta.max - delta.min);
      }
    }
  }

  return { dxById, dyById, dwById, dhById };
};

/**
 * Write the accumulated deltas to the scene, each element placed relative
 * to its resize-start geometry.
 *
 * A partner that only moved carries its label along, as it always has. A
 * partner that *stretched* is a container whose box changed under it, so
 * its label is refitted the same way a directly resized one would be —
 * see the bound-text notes in `CLAUDE.md`. The two are told apart by
 * whether a size delta was recorded at all, which is why the size maps
 * hold only the entries that are really non-zero.
 */
export const applyAlignmentDeltas = (
  originalElements: PointerDownState["originalElements"],
  dxById: ReadonlyMap<string, number>,
  dyById: ReadonlyMap<string, number>,
  dwById: ReadonlyMap<string, number>,
  dhById: ReadonlyMap<string, number>,
  scene: Scene,
) => {
  const elementsMap = scene.getNonDeletedElementsMap();
  const changedIds = new Set<string>([
    ...dxById.keys(),
    ...dyById.keys(),
    ...dwById.keys(),
    ...dhById.keys(),
  ]);
  for (const id of changedIds) {
    const partner = elementsMap.get(id);
    if (!partner) {
      continue;
    }
    const dx = dxById.get(id) ?? 0;
    const dy = dyById.get(id) ?? 0;
    const dw = dwById.get(id) ?? 0;
    const dh = dhById.get(id) ?? 0;
    const original = originalElements.get(id) ?? partner;

    scene.mutateElement(partner, {
      x: original.x + dx,
      y: original.y + dy,
      ...(dw !== 0 ? { width: Math.max(1, original.width + dw) } : {}),
      ...(dh !== 0 ? { height: Math.max(1, original.height + dh) } : {}),
    });

    const boundText = getBoundTextElement(partner, elementsMap);
    if (boundText) {
      if (dw !== 0 || dh !== 0) {
        handleBindTextResize(partner, scene, false);
      } else {
        // the container's label rides along — see `dragAlignedElements`
        const originalText = originalElements.get(boundText.id) ?? boundText;
        scene.mutateElement(boundText, {
          x: originalText.x + dx,
          y: originalText.y + dy,
        });
      }
    }
    updateBoundElements(partner, scene);
  }
};

/**
 * The whole alignment response to a resize: solve, spread across groups, write
 * once.
 *
 * Groups are not constraints — they are a post-pass over whatever the solve
 * placed, so a member it moved carries its siblings and the arrangement the
 * user grouped survives the constraint that moved it. Positions only: a
 * sibling of a member that *stretched* travels by that member's leading edge,
 * which is as near as anything rigid can get to an answer when the group's own
 * extent has changed.
 */
export const propagateAlignmentsAfterResize = (
  originalElements: PointerDownState["originalElements"],
  resizedIds: Set<string>,
  scene: Scene,
) => {
  const elementsMap = scene.getNonDeletedElementsMap();
  const { dxById, dyById, dwById, dhById } = buildResizeAlignmentDeltas(
    originalElements,
    resizedIds,
    elementsMap,
  );
  const groupMembers = getGroupMembers(elementsMap);
  const skip = (id: string) =>
    resizedIds.has(id) || isAlignmentAnchor(elementsMap.get(id));
  spreadAcrossGroups(dxById, groupMembers, skip);
  spreadAcrossGroups(dyById, groupMembers, skip);
  applyAlignmentDeltas(
    originalElements,
    dxById,
    dyById,
    dwById,
    dhById,
    scene,
  );
};
