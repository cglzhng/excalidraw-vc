import {
  clamp,
  rangeInclusive,
  rangeIntersection,
  rangesOverlap,
} from "@excalidraw/math";

import { getElementBounds } from "./bounds";
import {
  applyAlignmentDeltas,
  buildResizeAlignmentDeltas,
  floodAlignmentAxis,
  getAlignmentDragFactors,
  isAlignable,
  isAlignmentAnchor,
} from "./alignment";
import { newElementWith } from "./mutateElement";

import type { Bounds } from "@excalidraw/common";
import type { InclusiveRange } from "@excalidraw/math";

import type { PointerDownState } from "@excalidraw/excalidraw/types";

import type { Scene } from "./Scene";
import type {
  ElementGapAlignment,
  ElementsMap,
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "./types";

/**
 * VERSION-LOG: hard *gap* alignment — the equal-spacing counterpart of
 * `alignment.ts`.
 *
 * Excalidraw's snapping already surfaces equal gaps while you drag: line
 * three elements up with matching spaces between them and it offers to
 * hold that spacing. Like every other snap it is forgotten the moment you
 * release. This module persists that relationship, so the spacing
 * survives later moves and resizes.
 *
 * WHY A SEPARATE FILE FROM `alignment.ts`
 *
 * An edge alignment is a *binary* relation — `A.edge === B.edge` — which
 * is why `ElementAlignment` is a link from one element to a partner. An
 * equal gap is *ternary*: three elements ordered along an axis with
 * `gap(a,b) === gap(b,c)`. Neither the storage shape nor the detection
 * loop carries over, so they live apart and share only the predicates
 * (`isAlignable`, `isAlignmentAnchor`) and, later, the propagators'
 * per-axis component walk.
 *
 * THE INVARIANT
 *
 *   gap(a,b) === gap(b,c)
 *     ⟺  b.min - a.max === c.min - b.max
 *     ⟺  b.min + b.max === a.max + c.min
 *     ⟺  b.center === (a.max + c.min) / 2
 *
 * "the middle element is centred in the span between its neighbours".
 * One equation per triple per axis. Detection reads it as two equal
 * lengths (which is what the user sees); the propagators solve the
 * centred form (which is what's easy to restore).
 *
 * NOTE ON LAYERING: `packages/element` cannot import `snapping.ts` (a
 * `packages/excalidraw` module), so upstream's `getVisibleGaps` is not
 * reusable here and gap enumeration is reimplemented below. Same wall
 * that already keeps hard alignment and snapping in separate files.
 */

type Axis = "x" | "y";

/** Gap lengths within this many units of each other count as equal. */
const GAP_EPSILON = 1;

/**
 * Ceiling on enumerated gaps per axis. Enumeration is O(n²) in the
 * scene's alignable elements and runs on demand (render + hit-test), so
 * a pathological scene gets truncated rather than janky. Mirrors
 * upstream's `VISIBLE_GAPS_LIMIT_PER_AXIS`.
 */
const GAP_LIMIT_PER_AXIS = 2000;

/** The empty space between two elements, on one axis. */
type Gap = {
  startId: string;
  endId: string;
  /** where the gap begins: the start element's far edge */
  from: number;
  /** where it ends: the end element's near edge */
  to: number;
  length: number;
  /** the two elements' shared extent on the *perpendicular* axis */
  overlap: InclusiveRange;
};

const axisRange = (bounds: Bounds, axis: Axis): InclusiveRange =>
  axis === "x"
    ? rangeInclusive(bounds[0], bounds[2])
    : rangeInclusive(bounds[1], bounds[3]);

const perpendicular = (axis: Axis): Axis => (axis === "x" ? "y" : "x");

/**
 * Every gap on one axis between the given elements, plus indexes by
 * which element sits on each side. A pair only counts when the two
 * elements overlap on the perpendicular axis — otherwise the "gap"
 * spans empty space the user would never read as spacing. Same rule
 * upstream's snapping uses.
 */
const enumerateGaps = (
  elements: readonly ExcalidrawElement[],
  elementsMap: ElementsMap,
  axis: Axis,
): { gapsFrom: Map<string, Gap[]>; gapsTo: Map<string, Gap[]> } => {
  const perp = perpendicular(axis);
  const boxes = elements.map((element) => ({
    id: element.id,
    along: axisRange(getElementBounds(element, elementsMap), axis),
    across: axisRange(getElementBounds(element, elementsMap), perp),
  }));
  boxes.sort((a, b) => a.along[0] - b.along[0]);

  const gapsFrom = new Map<string, Gap[]>();
  const gapsTo = new Map<string, Gap[]>();
  const push = (map: Map<string, Gap[]>, key: string, gap: Gap) => {
    const list = map.get(key);
    if (list) {
      list.push(gap);
    } else {
      map.set(key, [gap]);
    }
  };

  let count = 0;
  outer: for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (++count > GAP_LIMIT_PER_AXIS) {
        break outer;
      }
      const start = boxes[i];
      const end = boxes[j];
      if (start.along[1] >= end.along[0]) {
        // touching or overlapping — no gap to speak of
        continue;
      }
      const overlap = rangeIntersection(start.across, end.across);
      if (!overlap || !rangesOverlap(start.across, end.across)) {
        continue;
      }
      const gap: Gap = {
        startId: start.id,
        endId: end.id,
        from: start.along[1],
        to: end.along[0],
        length: end.along[0] - start.along[1],
        overlap,
      };
      push(gapsFrom, gap.startId, gap);
      push(gapsTo, gap.endId, gap);
    }
  }

  return { gapsFrom, gapsTo };
};

/**
 * Where one gap of a guide sits along the guide's axis. The
 * perpendicular coordinate is `GapAlignmentGuide.across`, shared by both
 * gaps of a triple.
 *
 * `to` may be *less* than `from`: a hard triple whose members have been
 * pushed past each other has negative gaps, which is a perfectly valid
 * state of the constraint (both gaps are still equal) and one the
 * propagators will reach the moment an outer element is dragged far
 * enough. Consumers should treat the pair as an interval, not a
 * direction.
 */
export type GapSpan = {
  from: number;
  to: number;
};

/**
 * One equal-gap relationship to surface for the current selection.
 * `hard` ones are the persisted `gapAlignments`; soft ones are live
 * equalities detected on the fly that the user can promote by clicking
 * a padlock — the same hard/soft split `AlignmentGuide` uses.
 */
export type GapAlignmentGuide = {
  axis: Axis;
  ids: readonly [string, string, string];
  hard: boolean;
  /** the two gaps being held equal, in `ids` order */
  gaps: readonly [GapSpan, GapSpan];
  /**
   * The perpendicular coordinate both gaps are drawn at: the centre of
   * what all *three* members share on that axis.
   *
   * One coordinate, not one per gap. The two gaps are halves of a single
   * measurement and have to sit on a single line to read as one — and
   * this is where upstream puts the transient gap snap line during a
   * drag (`createGapSnapLines` intersects the outer pair's overlap with
   * the dragged element's range), so the hard guide lands exactly where
   * the soft one that offered it did.
   */
  across: number;
};

const guideKey = (axis: Axis, ids: readonly string[]): string =>
  `${axis}:${ids.join("|")}`;

/**
 * The two gaps of a triple, measured from the elements' current bounds.
 * Returns null only when a member has been deleted.
 *
 * The measurement is signed and unconditional: whatever the three
 * elements are currently doing, the stored order still names two spans,
 * and equal negative spans satisfy the constraint exactly as equal
 * positive ones do. Requiring positive gaps here would blank the guide
 * the moment a triple was squeezed shut — precisely when the user most
 * needs to see that the relationship is still there — even though the
 * propagators are still holding it.
 */
const measureTriple = (
  ids: readonly [string, string, string],
  axis: Axis,
  elementsMap: ElementsMap,
): { gaps: readonly [GapSpan, GapSpan]; across: number } | null => {
  const perp = perpendicular(axis);
  const boxes = ids.map((id) => {
    const element = elementsMap.get(id);
    if (!element || element.isDeleted) {
      return null;
    }
    const bounds = getElementBounds(element, elementsMap);
    return { along: axisRange(bounds, axis), across: axisRange(bounds, perp) };
  });
  if (boxes.some((box) => box == null)) {
    return null;
  }
  const [a, b, c] = boxes as NonNullable<(typeof boxes)[number]>[];

  const span = (start: typeof a, end: typeof a): GapSpan => ({
    from: start.along[1],
    to: end.along[0],
  });

  const gaps = [span(a, b), span(b, c)] as const;

  // The centre of what all three share on the perpendicular axis,
  // written as bounds rather than as a set so it survives the band
  // closing. Only each *pair* is required to overlap, so the three-way
  // band can be empty — and for a hard triple, dragged far enough, the
  // pairs can separate too.
  //
  // `lo` and `hi` are each a max/min of continuous functions of
  // position, so their midpoint is continuous whether or not lo <= hi:
  // at the instant the band closes lo === hi, and the midpoint is
  // exactly that last shared point. Testing for emptiness and falling
  // back elsewhere is what would make the guide jump mid-drag, so we
  // don't test — past closure the midpoint just keeps drifting between
  // the members.
  const lo = Math.max(a.across[0], b.across[0], c.across[0]);
  const hi = Math.min(a.across[1], b.across[1], c.across[1]);
  // Held inside the middle element, the one member both gaps touch, so
  // a wide separation can't leave the guide floating in empty space.
  // A no-op while the band exists (it is a subrange of b), so this costs
  // nothing in the ordinary case and only bounds the drift after.
  const across = clamp((lo + hi) / 2, b.across[0], b.across[1]);

  return { gaps, across };
};

/**
 * Every equal-gap line to draw for the current selection: the persisted
 * hard triples, plus every *other* live equal-gap triple involving a
 * selected element, as a soft convertible guide.
 *
 * Only triples containing a selected element are enumerated — a scene's
 * full set of equal gaps is both enormous and meaningless without a
 * subject. A selected element can occupy any of the three roles, so all
 * three are searched.
 */
export const getGapAlignmentGuides = (
  selected: readonly NonDeletedExcalidrawElement[],
  elementsMap: ElementsMap,
): GapAlignmentGuide[] => {
  const guides: GapAlignmentGuide[] = [];
  const seen = new Set<string>();

  const add = (
    axis: Axis,
    ids: readonly [string, string, string],
    hard: boolean,
  ) => {
    const key = guideKey(axis, ids);
    if (seen.has(key)) {
      return;
    }
    const measured = measureTriple(ids, axis, elementsMap);
    if (!measured) {
      return;
    }
    seen.add(key);
    guides.push({ axis, ids, hard, ...measured });
  };

  // Hard links first, so a hard triple is never re-emitted as soft.
  for (const element of selected) {
    for (const link of element.gapAlignments ?? []) {
      add(link.axis, link.ids, true);
    }
  }

  const candidates: ExcalidrawElement[] = [];
  for (const element of elementsMap.values()) {
    if (!element.isDeleted && isAlignable(element)) {
      candidates.push(element);
    }
  }
  const selectedIds = new Set(
    selected.filter(isAlignable).map((element) => element.id),
  );
  if (selectedIds.size === 0) {
    return guides;
  }

  const equal = (a: Gap, b: Gap) => Math.abs(a.length - b.length) <= GAP_EPSILON;

  for (const axis of ["x", "y"] as const) {
    const { gapsFrom, gapsTo } = enumerateGaps(candidates, elementsMap, axis);

    for (const id of selectedIds) {
      const before = gapsTo.get(id) ?? [];
      const after = gapsFrom.get(id) ?? [];

      // selected element is the middle: a — [id] — c
      for (const left of before) {
        for (const right of after) {
          if (equal(left, right)) {
            add(axis, [left.startId, id, right.endId], false);
          }
        }
      }

      // selected element is first: [id] — b — c
      for (const first of after) {
        for (const second of gapsFrom.get(first.endId) ?? []) {
          if (equal(first, second)) {
            add(axis, [id, first.endId, second.endId], false);
          }
        }
      }

      // selected element is last: a — b — [id]
      for (const second of before) {
        for (const first of gapsTo.get(second.startId) ?? []) {
          if (equal(first, second)) {
            add(axis, [first.startId, second.startId, id], false);
          }
        }
      }
    }
  }

  return guides;
};

const sameTriple = (
  link: ElementGapAlignment,
  axis: Axis,
  ids: readonly [string, string, string],
): boolean =>
  link.axis === axis &&
  link.ids[0] === ids[0] &&
  link.ids[1] === ids[1] &&
  link.ids[2] === ids[2];

/**
 * Promote a soft equal-gap guide to a hard one (the padlock). The same
 * record is written to all three members — there is no reciprocal form
 * to derive, unlike an edge link.
 */
export const lockGapAlignment = (
  guide: GapAlignmentGuide,
  elementsMap: ElementsMap,
): Map<string, ExcalidrawElement> => {
  const updated = new Map<string, ExcalidrawElement>();
  const link: ElementGapAlignment = { axis: guide.axis, ids: guide.ids };

  for (const id of guide.ids) {
    const element = elementsMap.get(id);
    if (!element) {
      // a triple is all-or-nothing: if any member is gone, lock nothing
      return new Map();
    }
    const existing = element.gapAlignments ?? [];
    if (existing.some((l) => sameTriple(l, guide.axis, guide.ids))) {
      continue;
    }
    updated.set(
      id,
      newElementWith(element, { gapAlignments: [...existing, link] }),
    );
  }
  return updated;
};

/** Demote one hard equal-gap link back to soft: drop exactly that triple
 * from all three members. The elements stay equally spaced, so
 * `getGapAlignmentGuides` re-surfaces it as a soft guide immediately. */
export const unlockGapAlignment = (
  guide: GapAlignmentGuide,
  elementsMap: ElementsMap,
): Map<string, ExcalidrawElement> => {
  const updated = new Map<string, ExcalidrawElement>();
  for (const id of guide.ids) {
    const element = elementsMap.get(id);
    if (!element?.gapAlignments?.length) {
      continue;
    }
    const filtered = element.gapAlignments.filter(
      (l) => !sameTriple(l, guide.axis, guide.ids),
    );
    if (filtered.length !== element.gapAlignments.length) {
      updated.set(id, newElementWith(element, { gapAlignments: filtered }));
    }
  }
  return updated;
};

/**
 * Limit a drag offset so no hard gap alignment is pushed through zero.
 *
 * Past zero the triple's members swap places, and the constraint stops
 * describing anything the user can see: the equation is still satisfied
 * — measured in the stored order the gaps are equal and negative — but
 * the *visible* spacing in the new order is
 * `−gap − w(outer) − w(middle)` on each side, which is only equal again
 * when the two outer elements happen to be the same width. So for most
 * triples, crossing silently turns "equally spaced" into a relationship
 * that no longer looks like one, and cannot be restored by dragging back
 * without a jump.
 *
 * Stopping at contact avoids the whole problem, and gives the drag an
 * honest feel: the arrangement closes up, then holds.
 *
 * Each gap is affine in the drag offset `t`, since every element moves
 * by its own multiple of it (`getAlignmentDragFactors`):
 *
 *     gap(t) = gap(0) + (f_far − f_near)·t
 *
 * so each gap contributes one bound on `t`, and the answer is the
 * tightest interval around 0. A gap that is *already* negative — from a
 * scene built before this rule, say — contributes nothing, so an
 * existing crossing is left alone rather than trapping the drag.
 */
export const clampDragToGapAlignments = (
  directlyMovedIds: Set<string>,
  offset: { x: number; y: number },
  originalElements: ReadonlyMap<string, ExcalidrawElement>,
  elementsMap: ElementsMap,
): { x: number; y: number } => {
  const clampAxis = (axis: Axis, t: number): number => {
    if (t === 0) {
      return t;
    }
    const factors = getAlignmentDragFactors(directlyMovedIds, axis, elementsMap);
    let lo = -Infinity;
    let hi = Infinity;

    const rangeOf = (id: string): InclusiveRange | null => {
      const element = originalElements.get(id) ?? elementsMap.get(id);
      return element
        ? axisRange(getElementBounds(element, elementsMap), axis)
        : null;
    };

    for (const link of collectHardTriples(elementsMap)) {
      if (link.axis !== axis) {
        continue;
      }
      const ranges = link.ids.map(rangeOf);
      if (ranges.some((range) => range == null)) {
        continue;
      }
      const [a, b, c] = ranges as InclusiveRange[];
      const [fa, fb, fc] = link.ids.map((id) => factors.get(id) ?? 0);

      for (const [gap, slope] of [
        [b[0] - a[1], fb - fa],
        [c[0] - b[1], fc - fb],
      ]) {
        if (slope === 0 || gap < 0) {
          continue;
        }
        const bound = -gap / slope;
        if (slope < 0) {
          hi = Math.min(hi, bound);
        } else {
          lo = Math.max(lo, bound);
        }
      }
    }

    return Math.min(Math.max(t, lo), hi);
  };

  return { x: clampAxis("x", offset.x), y: clampAxis("y", offset.y) };
};

/**
 * Cap a proposed size so no hard gap alignment closes past zero — the
 * resize counterpart of {@link clampDragToGapAlignments}, and refused
 * for the same reason: past contact the triple reorders and "equally
 * spaced" stops meaning what it looks like.
 *
 * After the correction pass has equalised them, both gaps of a triple
 * end up at the *mean* of what the resize left them at, because the
 * middle element absorbs the difference and moving it trades one gap
 * against the other one-for-one. So the whole condition is
 * `g1 + g2 >= 0`, measured with the driver at its proposed size and
 * everything else where the resize started.
 *
 * That sum is affine in the size, so it is sampled at the proposed size
 * and at the original one and solved directly — no search, and exact
 * for the linear system it describes.
 *
 * Scope, deliberately: the single-element resize path, on an unrotated
 * driver, where the middle is free to absorb. A rotated element's bounds
 * don't move with its size in a way this prediction models, and if the
 * middle is pinned the correction lands elsewhere; both fall through
 * uncapped rather than being capped wrongly.
 */
export const clampSizeToGapAlignments = (
  size: { nextWidth: number; nextHeight: number },
  driver: ExcalidrawElement,
  originalElements: ReadonlyMap<string, ExcalidrawElement>,
  elementsMap: ElementsMap,
  opts: { handle: string | false; shouldResizeFromCenter: boolean },
): { nextWidth: number; nextHeight: number } => {
  const handle = opts.handle;
  if (driver.angle !== 0 || !handle) {
    return size;
  }

  const triples = collectHardTriples(elementsMap).filter((link) =>
    link.ids.includes(driver.id),
  );
  if (triples.length === 0) {
    return size;
  }

  /** The driver's extent on `axis` if it were `length` long: the handle
   * says which side is held, and resizing from centre holds neither. */
  const projected = (axis: Axis, length: number): InclusiveRange => {
    const bounds = getElementBounds(driver, elementsMap);
    const [min, max] = axisRange(bounds, axis);
    // "nw" / "w" hold the right edge and move the left, and so on
    const movesMin = handle.includes(axis === "x" ? "w" : "n");
    if (opts.shouldResizeFromCenter) {
      const centre = (min + max) / 2;
      return rangeInclusive(centre - length / 2, centre + length / 2);
    }
    return movesMin
      ? rangeInclusive(max - length, max)
      : rangeInclusive(min, min + length);
  };

  const clampAxis = (axis: Axis, length: number, current: number): number => {
    const rangeOf = (id: string, driverLength: number): InclusiveRange | null => {
      if (id === driver.id) {
        return projected(axis, driverLength);
      }
      const element = originalElements.get(id) ?? elementsMap.get(id);
      return element
        ? axisRange(getElementBounds(element, elementsMap), axis)
        : null;
    };

    let limit = length;
    for (const link of triples) {
      if (link.axis !== axis) {
        continue;
      }
      const sumAt = (driverLength: number): number | null => {
        const ranges = link.ids.map((id) => rangeOf(id, driverLength));
        if (ranges.some((range) => range == null)) {
          return null;
        }
        const [a, b, c] = ranges as InclusiveRange[];
        return b[0] - a[1] + (c[0] - b[1]);
      };

      const sum = sumAt(length);
      const sum0 = sumAt(current);
      if (sum == null || sum0 == null || sum >= 0 || sum0 < 0) {
        // already fine, or already crossed before this resize began
        continue;
      }
      const slope = (sum - sum0) / (length - current);
      if (slope >= 0) {
        continue;
      }
      limit = Math.min(limit, current - sum0 / slope);
    }
    return limit;
  };

  const bounds = getElementBounds(driver, elementsMap);
  return {
    nextWidth: clampAxis("x", size.nextWidth, bounds[2] - bounds[0]),
    nextHeight: clampAxis("y", size.nextHeight, bounds[3] - bounds[1]),
  };
};

/**
 * How close two gaps must be before the correction pass calls it done.
 * Looser than {@link GAP_EPSILON} would be pointless and tighter would
 * chase floating-point noise across passes.
 */
const GAP_CORRECTION_EPSILON = 0.01;

/**
 * Ceiling on correction passes. One pass settles a single triple
 * exactly; chained triples (four evenly spaced elements are two
 * overlapping triples) need the correction to propagate along the chain,
 * which converges geometrically. This is not a general constraint
 * solver — an adversarial graph of triples can leave a small residual
 * error rather than diverging — and that is a deliberate limit for now.
 */
const MAX_GAP_CORRECTION_PASSES = 8;

/** Every distinct hard triple in the scene, deduped across the three
 * copies each one is stored under. */
const collectHardTriples = (
  elementsMap: ElementsMap,
): ElementGapAlignment[] => {
  const byKey = new Map<string, ElementGapAlignment>();
  for (const element of elementsMap.values()) {
    for (const link of element.gapAlignments ?? []) {
      const key = guideKey(link.axis, link.ids);
      if (!byKey.has(key)) {
        byKey.set(key, link);
      }
    }
  }
  return [...byKey.values()];
};

/**
 * Whether one hard equal-gap triple on `axis` already contains all three
 * participants — a dragged selection and the two elements bounding a
 * candidate gap.
 *
 * Each participant arrives as a list of ids because snapping works in
 * maximum groups, whose bounds are the union of several elements; any
 * member matching is enough. Roles aren't checked: if the same three
 * elements are already pinned to equal spacing, none of the arrangements
 * the snapper might offer between them is news.
 *
 * Used by `snapping.ts` to drop transient gap guides that only restate a
 * constraint the scene already holds — the equal-gap counterpart of
 * masking a hard-aligned partner out of the reference snap points.
 */
export const hasHardGapAlignmentAmong = (
  axis: Axis,
  a: readonly string[],
  b: readonly string[],
  c: readonly string[],
  elementsMap: ElementsMap,
): boolean => {
  for (const id of a) {
    for (const link of elementsMap.get(id)?.gapAlignments ?? []) {
      if (
        link.axis === axis &&
        b.some((other) => link.ids.includes(other)) &&
        c.some((other) => link.ids.includes(other))
      ) {
        return true;
      }
    }
  }
  return false;
};

/**
 * Extend a resize's translation maps so every hard equal-gap triple
 * survives it.
 *
 * A resize moves one element's edges without moving anything else, which
 * is exactly what breaks an equal gap — so unlike a drag this genuinely
 * has to be solved. The correction is expressed as more entries in the
 * same `dxById` / `dyById` maps the edge-alignment pass builds, so both
 * kinds of alignment are resolved before a single element is written to
 * the scene, and everything stays measured from the resize-start
 * snapshot (no drift across pointermove events).
 *
 * Which member gives way, in order:
 *   - the middle element, translated by half the error — it sits between
 *     the two gaps, so moving it by `d` grows one and shrinks the other,
 *     and it is the element the user is least likely to be holding;
 *   - failing that (it's the one being resized, or it's anchored), the
 *     movable outer elements, sharing the correction equally;
 *   - failing that, nothing: the triple is over-constrained and simply
 *     falls out of true, mirroring how an anchored edge partner makes a
 *     resize fall out of alignment.
 *
 * Each correction is flooded along *edge* links so a member drags its
 * own aligned partners with it. Elements that already carry a delta from
 * the edge pass keep it (first-wins, as there), so a member that is both
 * gap-constrained and edge-constrained to the resize can be left with a
 * residual error.
 */
const correctGapAlignments = (
  resizedIds: Set<string>,
  originalElements: PointerDownState["originalElements"],
  dxById: Map<string, number>,
  dyById: Map<string, number>,
  elementsMap: ElementsMap,
) => {
  const triples = collectHardTriples(elementsMap);
  if (triples.length === 0) {
    return;
  }

  // Base geometry: the drivers as they are now (they moved under the
  // pointer), everything else as it was when the resize began. Bounds
  // translate exactly with x/y, so a pending delta can be added to the
  // measured range instead of re-deriving it from a moved clone.
  const baseRange = new Map<string, InclusiveRange | null>();
  const rangeOf = (id: string, axis: Axis): InclusiveRange | null => {
    const key = `${id}:${axis}`;
    if (!baseRange.has(key)) {
      const element = resizedIds.has(id)
        ? elementsMap.get(id)
        : originalElements.get(id) ?? elementsMap.get(id);
      baseRange.set(
        key,
        element ? axisRange(getElementBounds(element, elementsMap), axis) : null,
      );
    }
    return baseRange.get(key)!;
  };

  const isMovable = (id: string) =>
    !resizedIds.has(id) && !isAlignmentAnchor(elementsMap.get(id));

  for (let pass = 0; pass < MAX_GAP_CORRECTION_PASSES; pass++) {
    let corrected = false;

    for (const { axis, ids } of triples) {
      const deltaById = axis === "x" ? dxById : dyById;
      const shifted = ids.map((id) => {
        const range = rangeOf(id, axis);
        if (!range) {
          return null;
        }
        const delta = deltaById.get(id) ?? 0;
        return [range[0] + delta, range[1] + delta] as const;
      });
      if (shifted.some((range) => range == null)) {
        continue;
      }
      const [a, b, c] = shifted as (readonly [number, number])[];

      // positive error means the second gap is the larger one
      const error = c[0] - b[1] - (b[0] - a[1]);
      if (Math.abs(error) <= GAP_CORRECTION_EPSILON) {
        continue;
      }

      const shift = (id: string, delta: number) => {
        deltaById.set(id, (deltaById.get(id) ?? 0) + delta);
      };

      if (isMovable(ids[1])) {
        // moving the middle right by d grows gap 1 and shrinks gap 2,
        // so it closes twice the distance it travels
        shift(ids[1], error / 2);
      } else {
        const outers = [ids[0], ids[2]].filter(isMovable);
        if (outers.length === 0) {
          continue;
        }
        // moving either outer right by d grows the error by d, so the
        // shifts have to sum to -error
        for (const id of outers) {
          shift(id, -error / outers.length);
        }
      }
      corrected = true;
    }

    if (!corrected) {
      break;
    }
    floodAlignmentAxis(dxById, "x", resizedIds, elementsMap);
    floodAlignmentAxis(dyById, "y", resizedIds, elementsMap);
  }
};

/**
 * The whole alignment response to a resize: hard edge links first, then
 * the equal-gap correction on top, then one write to the scene.
 *
 * Both passes have to agree before anything moves — a member of a triple
 * may also be an edge partner — which is why this is one entry point
 * rather than two propagators called in sequence.
 */
export const propagateAlignmentsAfterResize = (
  originalElements: PointerDownState["originalElements"],
  resizedIds: Set<string>,
  scene: Scene,
) => {
  const elementsMap = scene.getNonDeletedElementsMap();
  const { dxById, dyById } = buildResizeAlignmentDeltas(
    originalElements,
    resizedIds,
    elementsMap,
  );
  correctGapAlignments(
    resizedIds,
    originalElements,
    dxById,
    dyById,
    elementsMap,
  );
  applyAlignmentDeltas(originalElements, dxById, dyById, scene);
};

/**
 * Strip every gap link involving any of `elements` — including from the
 * *other* members of those triples, since a triple missing a member is
 * meaningless. The gap-alignment half of the "clear alignments" action.
 */
export const unlockGapAlignments = (
  elements: readonly NonDeletedExcalidrawElement[],
  elementsMap: ElementsMap,
): Map<string, ExcalidrawElement> => {
  const removedIds = new Set(elements.map((el) => el.id));
  const updated = new Map<string, ExcalidrawElement>();

  for (const element of elementsMap.values()) {
    const links = element.gapAlignments;
    if (!links?.length) {
      continue;
    }
    const filtered = links.filter(
      (link) => !link.ids.some((id) => removedIds.has(id)),
    );
    if (filtered.length !== links.length) {
      updated.set(element.id, newElementWith(element, { gapAlignments: filtered }));
    }
  }
  return updated;
};
