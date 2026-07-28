import type { Bounds } from "@excalidraw/common";

import { updateBoundElements } from "./binding";
import { getElementBounds } from "./bounds";
import { newElementWith } from "./mutateElement";
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
 * Hard alignment ("alignment lock").
 *
 * Excalidraw ships a *soft* alignment system — snapping — that nudges a
 * dragged element onto guide lines but never moves the reference
 * elements. Hard alignment persists a chosen alignment as data on the
 * elements (`ExcalidrawElement.alignments`) so that afterwards moving
 * one element drags its aligned partners to preserve the alignment.
 *
 * The relationship is per-axis: two elements sharing a vertical edge
 * (left / right / horizontal-center) are locked on the **x** axis, so
 * moving one horizontally moves the other, while vertical motion is
 * unconstrained. Sharing a horizontal edge locks the **y** axis.
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
 * The centre-to-edge pairs are last because they're the weakest reading
 * of a coincidence, but they *are* included: soft snapping already
 * offers them (`getElementsCorners` exposes the centre as an anchor
 * alongside the corners), and hard alignment is committed from a snap
 * the user can see, so refusing to lock one would silently drop an
 * alignment the guide just promised.
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
 * edges may match (left-to-left) or differ (A's right to B's left). At
 * most one link per axis, using the first matching pair in `EDGE_PAIRS`.
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
    for (const [selfEdge, otherEdge] of EDGE_PAIRS) {
      if (
        roughlyEqual(
          edgeCoord(boundsA, axis, selfEdge),
          edgeCoord(boundsB, axis, otherEdge),
        )
      ) {
        links.push({ axis, selfEdge, otherEdge });
        break; // one link per axis
      }
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
  if (existing.some((l) => l.elementId === partnerId && l.axis === axis)) {
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
 * The hard-align-on-drag gesture (Alt held while dragging): the drag's
 * *soft* snapping has just placed the moved elements edge-to-edge with
 * other elements, and we persist those coincidences as hard links.
 *
 * Unlike {@link lockAlignments} (which only pairs elements *within* the
 * selection), here each moved element is paired against every other
 * scene element it now shares an edge with. Linear elements and
 * container-bound labels are skipped — they aren't soft-snap targets
 * either (see `snapping.ts`), so they should never become hard targets.
 */
export const lockDraggedAlignments = (
  movedElements: readonly NonDeletedExcalidrawElement[],
  elementsMap: ElementsMap,
): Map<string, ExcalidrawElement> => {
  const movedIds = new Set(movedElements.map((el) => el.id));
  const nextLinks = new Map<string, ElementAlignment[]>();
  const touched = new Set<string>();

  const linksFor = (el: ExcalidrawElement) =>
    nextLinks.get(el.id) ?? (el.alignments ? el.alignments.slice() : []);

  for (const a of movedElements) {
    for (const b of elementsMap.values()) {
      if (
        b.id === a.id ||
        isLinearElement(b) ||
        isBoundToContainer(b) ||
        // moved/moved pairs are handled once, from the lower-id side, to
        // avoid linking a pair twice (harmless, but wasteful)
        (movedIds.has(b.id) && b.id < a.id)
      ) {
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
  const isHardWith = (el: NonDeletedExcalidrawElement, otherId: string, axis: Axis) =>
    (el.alignments ?? []).some((l) => l.elementId === otherId && l.axis === axis);

  for (const el of selected) {
    for (const other of elementsMap.values()) {
      if (
        other.id === el.id ||
        other.isDeleted ||
        isLinearElement(other) ||
        isBoundToContainer(other)
      ) {
        continue;
      }
      for (const link of getAlignedLinks(el, other, elementsMap)) {
        if (isHardWith(el, other.id, link.axis)) {
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
 * Demote a single hard link back to soft (the unlock icon): drop just
 * this pair's link on the given axis, on both sides. The elements stay
 * edge-coincident, so `getAlignmentGuides` re-surfaces it as a soft
 * guide immediately.
 */
export const unlockAlignmentPair = (
  aId: string,
  bId: string,
  axis: Axis,
  elementsMap: ElementsMap,
): Map<string, ExcalidrawElement> => {
  const updated = new Map<string, ExcalidrawElement>();
  const drop = (fromId: string, toId: string) => {
    const el = elementsMap.get(fromId);
    if (!el?.alignments?.length) {
      return;
    }
    const filtered = el.alignments.filter(
      (l) => !(l.elementId === toId && l.axis === axis),
    );
    if (filtered.length !== el.alignments.length) {
      updated.set(el.id, newElementWith(el, { alignments: filtered }));
    }
  };
  drop(aId, bId);
  drop(bId, aId);
  return updated;
};

/**
 * Transitive set of elements reachable from `seeds` by following
 * alignment links restricted to a single `axis`. Includes the seeds.
 */
const collectAlignedComponent = (
  seeds: Set<string>,
  axis: "x" | "y",
  elementsMap: ElementsMap,
): Set<string> => {
  const visited = new Set<string>(seeds);
  const queue = [...seeds];
  while (queue.length > 0) {
    const id = queue.pop()!;
    const el = elementsMap.get(id);
    const links = el?.alignments;
    if (!links) {
      continue;
    }
    for (const link of links) {
      if (link.axis === axis && !visited.has(link.elementId)) {
        visited.add(link.elementId);
        queue.push(link.elementId);
      }
    }
  }
  return visited;
};

/**
 * Which elements move on each axis when `seeds` are dragged, following
 * hard-alignment links transitively. An element hard-aligned to a seed
 * on the x axis shifts horizontally with it (and likewise for y); the
 * two axes are independent, so an element may comove on one, both, or
 * neither. Includes the seeds themselves. Used by the snapping system to
 * drop a comoving partner's stale snap points on the axis it tracks.
 */
export const getAlignmentMovers = (
  seeds: Set<string>,
  elementsMap: ElementsMap,
): { x: Set<string>; y: Set<string> } => ({
  x: collectAlignedComponent(seeds, "x", elementsMap),
  y: collectAlignedComponent(seeds, "y", elementsMap),
});

/**
 * Which axes a drag of `directlyMovedIds` is frozen on by an alignment
 * anchor. If the aligned component on an axis contains an
 * `alignmentLocked` element that isn't itself being dragged, that
 * element can't be pushed; since the component moves rigidly, nothing in
 * it — including the dragged elements — can move on that axis, so the
 * offset is zeroed there. A locked element that *is* being dragged is
 * the direct target and doesn't freeze itself.
 */
export const getAlignmentLockedAxes = (
  directlyMovedIds: Set<string>,
  elementsMap: ElementsMap,
): { x: boolean; y: boolean } => {
  const frozenOn = (axis: Axis): boolean => {
    for (const id of collectAlignedComponent(directlyMovedIds, axis, elementsMap)) {
      if (!directlyMovedIds.has(id) && elementsMap.get(id)?.alignmentLocked) {
        return true;
      }
    }
    return false;
  };
  return { x: frozenOn("x"), y: frozenOn("y") };
};

/**
 * After the directly-dragged elements have been moved by `offset`, drag
 * their hard-aligned partners to preserve the alignment.
 *
 * Handled per-axis: everything x-linked (transitively) to a dragged
 * element shifts by `offset.x`, everything y-linked shifts by
 * `offset.y`. An element may be pulled on one axis, both, or neither.
 * Partner positions are computed from their drag-start snapshot
 * (`originalElements`, which holds every element), so repeated
 * pointermove events don't accumulate drift.
 *
 * `directlyMovedIds` are skipped — they were already moved by the caller
 * (with snapping / grid applied); partners simply inherit that final
 * offset.
 */
export const dragAlignedElements = (
  originalElements: PointerDownState["originalElements"],
  directlyMovedIds: Set<string>,
  offset: { x: number; y: number },
  scene: Scene,
) => {
  const elementsMap = scene.getNonDeletedElementsMap();

  const xComponent = collectAlignedComponent(directlyMovedIds, "x", elementsMap);
  const yComponent = collectAlignedComponent(directlyMovedIds, "y", elementsMap);

  const partners = new Set<string>();
  for (const id of xComponent) {
    if (!directlyMovedIds.has(id)) {
      partners.add(id);
    }
  }
  for (const id of yComponent) {
    if (!directlyMovedIds.has(id)) {
      partners.add(id);
    }
  }

  for (const id of partners) {
    const element = elementsMap.get(id);
    if (!element) {
      continue;
    }
    const original = originalElements.get(id) ?? element;
    const dx = xComponent.has(id) ? offset.x : 0;
    const dy = yComponent.has(id) ? offset.y : 0;

    scene.mutateElement(element, {
      x: original.x + dx,
      y: original.y + dy,
    });
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
const floodAxis = (
  deltaById: Map<string, number>,
  axis: Axis,
  barriers: Set<string>,
  elementsMap: ElementsMap,
) => {
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
        !elementsMap.get(link.elementId)?.alignmentLocked
      ) {
        deltaById.set(link.elementId, delta);
        queue.push(link.elementId);
      }
    }
  }
};

/**
 * After the selected elements have been resized, drag their hard-aligned
 * partners so the shared edge stays aligned.
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
export const resizeAlignedElements = (
  originalElements: PointerDownState["originalElements"],
  resizedIds: Set<string>,
  scene: Scene,
) => {
  const elementsMap = scene.getNonDeletedElementsMap();

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
        // an anchored partner is never pushed (resize just falls out of
        // alignment with it)
        elementsMap.get(link.elementId)?.alignmentLocked
      ) {
        continue;
      }
      // The driver's own edge is what moved; the partner translates
      // rigidly, so its `otherEdge` tracks it automatically.
      const delta =
        edgeCoord(newBounds, link.axis, link.selfEdge) -
        edgeCoord(origBounds, link.axis, link.selfEdge);
      // Direct partners are authoritative (last driver wins on conflict).
      (link.axis === "x" ? dxById : dyById).set(link.elementId, delta);
    }
  }

  floodAxis(dxById, "x", resizedIds, elementsMap);
  floodAxis(dyById, "y", resizedIds, elementsMap);

  const movedIds = new Set<string>([...dxById.keys(), ...dyById.keys()]);
  for (const id of movedIds) {
    const partner = elementsMap.get(id);
    if (!partner) {
      continue;
    }
    const original = originalElements.get(id) ?? partner;
    scene.mutateElement(partner, {
      x: original.x + (dxById.get(id) ?? 0),
      y: original.y + (dyById.get(id) ?? 0),
    });
    updateBoundElements(partner, scene);
  }
};
