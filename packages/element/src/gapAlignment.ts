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
  getGroupMembers,
  getTranslationBlockingAnchors,
  isAlignable,
  isAlignmentAnchor,
  resizeMovesEdge,
  spreadAcrossGroups,
} from "./alignment";
import { newElementWith } from "./mutateElement";

import type { ResizeEdgeOpts } from "./alignment";

import type { Bounds } from "@excalidraw/common";
import type { InclusiveRange } from "@excalidraw/math";

import type { PointerDownState } from "@excalidraw/excalidraw/types";

import type { Scene } from "./Scene";
import type {
  AlignmentEdge,
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
 * perpendicular coordinate is `GapAlignmentGuide.across`, shared by every
 * gap of the chain.
 *
 * `to` may be *less* than `from`: a hard chain whose members have been
 * pushed past each other has negative gaps, which is a perfectly valid
 * state of the constraint (they are still all equal) and one the
 * propagators will reach the moment an end element is dragged far
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
  /** the chain, ordered along `axis`; at least 3 long */
  ids: readonly string[];
  hard: boolean;
  /** the gaps being held equal — one per adjacent pair, in `ids` order */
  gaps: readonly GapSpan[];
  /**
   * The perpendicular coordinate every gap is drawn at: the centre of
   * what *all* the members share on that axis.
   *
   * One coordinate, not one per gap. The gaps are parts of a single
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
 * The gaps of a chain, measured from the elements' current bounds — one
 * per adjacent pair. Returns null only when a member has been deleted,
 * or the chain is too short to have two gaps to hold equal.
 *
 * The measurement is signed and unconditional: whatever the elements are
 * currently doing, the stored order still names the same spans, and
 * equal negative spans satisfy the constraint exactly as equal positive
 * ones do. Requiring positive gaps here would blank the guide the moment
 * a chain was squeezed shut — precisely when the user most needs to see
 * that the relationship is still there — even though the propagators are
 * still holding it.
 */
const measureChain = (
  ids: readonly string[],
  axis: Axis,
  elementsMap: ElementsMap,
): { gaps: readonly GapSpan[]; across: number } | null => {
  if (ids.length < 3) {
    return null;
  }
  const perp = perpendicular(axis);
  const boxes: { along: InclusiveRange; across: InclusiveRange }[] = [];
  for (const id of ids) {
    const element = elementsMap.get(id);
    if (!element || element.isDeleted) {
      return null;
    }
    const bounds = getElementBounds(element, elementsMap);
    boxes.push({
      along: axisRange(bounds, axis),
      across: axisRange(bounds, perp),
    });
  }

  const gaps: GapSpan[] = [];
  for (let i = 0; i < boxes.length - 1; i++) {
    gaps.push({ from: boxes[i].along[1], to: boxes[i + 1].along[0] });
  }

  // The centre of what every member shares on the perpendicular axis,
  // written as bounds rather than as a set so it survives the band
  // closing. Only each *pair* is required to overlap, so the shared band
  // can be empty — and for a hard chain, dragged far enough, even the
  // pairs can separate.
  //
  // `lo` and `hi` are each a max/min of continuous functions of
  // position, so their midpoint is continuous whether or not lo <= hi:
  // at the instant the band closes lo === hi, and the midpoint is
  // exactly that last shared point. Testing for emptiness and falling
  // back elsewhere is what would make the guide jump mid-drag, so we
  // don't test — past closure the midpoint just keeps drifting between
  // the members.
  const lo = Math.max(...boxes.map((box) => box.across[0]));
  const hi = Math.min(...boxes.map((box) => box.across[1]));
  // Held inside the median member, so a wide separation can't leave the
  // guide floating in empty space. A no-op while the band exists (it is
  // a subrange of every member), so this costs nothing in the ordinary
  // case and only bounds the drift after.
  const median = boxes[Math.floor(boxes.length / 2)].across;
  const across = clamp((lo + hi) / 2, median[0], median[1]);

  return { gaps, across };
};

/**
 * Every equal-gap line to draw for the current selection: the persisted
 * hard chains, plus every *other* live equal-gap chain involving a
 * selected element, as a soft convertible guide.
 *
 * Only chains containing a selected element are enumerated — a scene's
 * full set of equal gaps is both enormous and meaningless without a
 * subject. A selected element can occupy any position in a chain, so a
 * triple is sought around it in all three roles and then grown outward.
 *
 * Soft chains are reported **maximal**: four evenly spaced elements
 * surface as one four-member guide rather than as the two overlapping
 * triples inside it, which is both what the arrangement looks like and
 * what the user would want a padlock to pin.
 */
export const getGapAlignmentGuides = (
  selected: readonly NonDeletedExcalidrawElement[],
  elementsMap: ElementsMap,
): GapAlignmentGuide[] => {
  const guides: GapAlignmentGuide[] = [];
  const seen = new Set<string>();

  const add = (axis: Axis, ids: readonly string[], hard: boolean) => {
    const key = guideKey(axis, ids);
    if (seen.has(key)) {
      return;
    }
    const measured = measureChain(ids, axis, elementsMap);
    if (!measured) {
      return;
    }
    seen.add(key);
    guides.push({ axis, ids, hard, ...measured });
  };

  // Hard links first, so a hard chain is never re-emitted as soft.
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

  const equal = (a: number, b: number) => Math.abs(a - b) <= GAP_EPSILON;

  for (const axis of ["x", "y"] as const) {
    const { gapsFrom, gapsTo } = enumerateGaps(candidates, elementsMap, axis);

    /**
     * Grow a seed triple into the longest run of the same gap in both
     * directions, then emit it.
     *
     * Only the maximal run is emitted, so the sub-chains inside it never
     * reach `add` and can't clutter the canvas with nested guides. Where
     * several elements could continue the run (two shapes starting at
     * the same coordinate, overlapping the chain perpendicular), the
     * first is taken — `enumerateGaps` builds its lists in axis order,
     * so the choice is at least stable from frame to frame.
     *
     * Termination is structural: a gap only ever runs from a lower
     * coordinate to a higher one, so each step moves strictly along the
     * axis and can't revisit a member.
     */
    const addMaximalChain = (seed: readonly string[], length: number) => {
      const ids = [...seed];
      const taken = new Set(ids);

      for (;;) {
        const next = (gapsFrom.get(ids[ids.length - 1]) ?? []).find(
          (gap) => equal(gap.length, length) && !taken.has(gap.endId),
        );
        if (!next) {
          break;
        }
        ids.push(next.endId);
        taken.add(next.endId);
      }
      for (;;) {
        const previous = (gapsTo.get(ids[0]) ?? []).find(
          (gap) => equal(gap.length, length) && !taken.has(gap.startId),
        );
        if (!previous) {
          break;
        }
        ids.unshift(previous.startId);
        taken.add(previous.startId);
      }

      add(axis, ids, false);
    };

    for (const id of selectedIds) {
      const before = gapsTo.get(id) ?? [];
      const after = gapsFrom.get(id) ?? [];

      // selected element is the middle: a — [id] — c
      for (const left of before) {
        for (const right of after) {
          if (equal(left.length, right.length)) {
            addMaximalChain([left.startId, id, right.endId], left.length);
          }
        }
      }

      // selected element is first: [id] — b — c
      for (const first of after) {
        for (const second of gapsFrom.get(first.endId) ?? []) {
          if (equal(first.length, second.length)) {
            addMaximalChain([id, first.endId, second.endId], first.length);
          }
        }
      }

      // selected element is last: a — b — [id]
      for (const second of before) {
        for (const first of gapsTo.get(second.startId) ?? []) {
          if (equal(first.length, second.length)) {
            addMaximalChain(
              [first.startId, second.startId, id],
              second.length,
            );
          }
        }
      }
    }
  }

  // A soft chain may run through gaps that are already hard-linked —
  // the arrangement where locking it would extend the existing chain.
  // That hard link has to be surfaced even though no *selected* element
  // belongs to it, or the run it holds would be reported as unlocked:
  // the renderer only suppresses a soft span where it can see a hard
  // guide covering the same gap, and the padlocked badges the user
  // should see come from that guide.
  //
  // Only when the soft chain covers it as a contiguous run, though —
  // the same test `lockGapAlignment` uses to decide what it absorbs. A
  // hard chain that merely shares elements with the selection's soft
  // chain holds different gaps, is none of the selection's business, and
  // would be drawn as an unrelated second constraint.
  const soft = guides.filter((guide) => !guide.hard);
  for (const link of collectHardChains(elementsMap)) {
    if (
      soft.some(
        (guide) =>
          guide.axis === link.axis && isContiguousRun(guide.ids, link.ids),
      )
    ) {
      add(link.axis, link.ids, true);
    }
  }

  return guides;
};

const sameChain = (
  link: ElementGapAlignment,
  axis: Axis,
  ids: readonly string[],
): boolean =>
  link.axis === axis &&
  link.ids.length === ids.length &&
  link.ids.every((id, index) => id === ids[index]);

/**
 * Order a set of members along `axis` and check they form one chain —
 * every consecutive gap equal. Returns the ordered ids, or null if the
 * members don't describe a single evenly spaced run (which is what
 * stops two chains of different spacing from being merged just because
 * they touch).
 */
const asOneChain = (
  ids: readonly string[],
  axis: Axis,
  elementsMap: ElementsMap,
): string[] | null => {
  const ranges = new Map<string, InclusiveRange>();
  for (const id of ids) {
    const element = elementsMap.get(id);
    if (!element || element.isDeleted) {
      return null;
    }
    ranges.set(id, axisRange(getElementBounds(element, elementsMap), axis));
  }
  const ordered = [...ids].sort(
    (a, b) => ranges.get(a)![0] - ranges.get(b)![0],
  );

  let first: number | null = null;
  for (let i = 0; i < ordered.length - 1; i++) {
    const gap = ranges.get(ordered[i + 1])![0] - ranges.get(ordered[i])![1];
    if (first === null) {
      first = gap;
    } else if (Math.abs(gap - first) > GAP_EPSILON) {
      return null;
    }
  }
  return ordered;
};

/** Whether `part` appears as a consecutive slice of `chain` — i.e. the
 * chain holds every gap the part holds. */
const isContiguousRun = (
  chain: readonly string[],
  part: readonly string[],
): boolean => {
  for (let i = 0; i + part.length <= chain.length; i++) {
    if (part.every((id, offset) => chain[i + offset] === id)) {
      return true;
    }
  }
  return false;
};

/**
 * Promote a soft equal-gap guide to a hard one (the padlock). The same
 * record is written to every member — there is no reciprocal form to
 * derive, unlike an edge link.
 *
 * Locking a chain that continues one already locked **merges** them
 * rather than adding a second link: A—B—C plus C—D—E becomes A—B—C—D—E.
 * Two links over the same run would otherwise both be enforced, both be
 * drawn, and have to be unlocked separately, while describing one
 * arrangement. A candidate is absorbed only if it shares a member and
 * the union is still a single evenly spaced run, so two groups that
 * merely touch — or that are spaced differently — stay apart.
 *
 * The search repeats to a fixed point because one new chain can bridge
 * two existing ones that had nothing in common until now.
 */
export const lockGapAlignment = (
  guide: GapAlignmentGuide,
  elementsMap: ElementsMap,
): Map<string, ExcalidrawElement> => {
  const candidates = collectHardChains(elementsMap).filter(
    (link) => link.axis === guide.axis,
  );

  let ids: readonly string[] = guide.ids;
  const tried = new Set<string>();
  for (;;) {
    const members = new Set(ids);
    const candidate = candidates.find(
      (link) =>
        !tried.has(guideKey(link.axis, link.ids)) &&
        link.ids.some((id) => members.has(id)),
    );
    if (!candidate) {
      break;
    }
    tried.add(guideKey(candidate.axis, candidate.ids));
    const merged = asOneChain(
      [...new Set([...ids, ...candidate.ids])],
      guide.axis,
      elementsMap,
    );
    if (merged) {
      ids = merged;
    }
  }

  // Which existing links the new one replaces: those whose members are a
  // *contiguous run* of it, so the new chain holds every gap they held.
  // Sharing members isn't enough — a chain through every other element
  // covers different gaps and is a constraint of its own, which locking
  // this one must not quietly delete. Because a run's members are all in
  // the new chain, no element is left holding a link to something the
  // chain no longer mentions.
  const link: ElementGapAlignment = { axis: guide.axis, ids };
  const replaced = (l: ElementGapAlignment) =>
    l.axis === guide.axis && isContiguousRun(ids, l.ids);

  const updated = new Map<string, ExcalidrawElement>();
  for (const id of ids) {
    const element = elementsMap.get(id);
    if (!element) {
      // a chain is all-or-nothing: if any member is gone, lock nothing
      return new Map();
    }
    const existing = element.gapAlignments ?? [];
    if (existing.some((l) => sameChain(l, guide.axis, ids))) {
      continue;
    }
    updated.set(
      id,
      newElementWith(element, {
        gapAlignments: [...existing.filter((l) => !replaced(l)), link],
      }),
    );
  }
  return updated;
};

/**
 * Demote a hard equal-gap link back to soft: drop the whole chain from
 * every member, whichever of its badges was clicked.
 *
 * All of it, not just the clicked gap. Splitting reads as a fiddly
 * partial edit of something the user thinks of as one arrangement, and
 * an equal-gap chain is one assertion however many gaps it spans. The
 * elements stay equally spaced, so `getGapAlignmentGuides` re-surfaces
 * the whole thing as a soft guide immediately.
 */
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
    const kept = element.gapAlignments.filter(
      (l) => !sameChain(l, guide.axis, guide.ids),
    );
    if (kept.length !== element.gapAlignments.length) {
      updated.set(id, newElementWith(element, { gapAlignments: kept }));
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

    for (const link of collectHardChains(elementsMap)) {
      if (link.axis !== axis) {
        continue;
      }
      const ranges = link.ids.map(rangeOf);
      if (ranges.some((range) => range == null)) {
        continue;
      }
      const spans = ranges as InclusiveRange[];
      const factorOf = link.ids.map((id) => factors.get(id) ?? 0);

      // one bound per gap, over every adjacent pair in the chain
      for (let i = 0; i < spans.length - 1; i++) {
        const gap = spans[i + 1][0] - spans[i][1];
        const slope = factorOf[i + 1] - factorOf[i];
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
 * Both ways a resize reaches a chain are capped, and each is capped in
 * the terms its own correction works in.
 *
 * When the driver is a chain *member*, the correction equalises the gaps
 * to their mean — the middle element absorbs the difference, and moving
 * it trades one gap against the other one-for-one — so the tightest
 * final gap is non-negative exactly when `g1 + g2 >= 0`.
 *
 * When the driver only reaches the chain through *edge* links, nothing
 * in the chain changes width and the correction translates it by an
 * arithmetic progression ({@link translateChain}). Every gap then moves
 * by the progression's slope, so the tightest final gap is the smallest
 * starting gap plus that slope. Predicting it needs the shift the edge
 * pass would hand each member at a hypothetical driver size, which is
 * what `edgeShiftsAt` reproduces.
 *
 * Either quantity is affine in the size, so both are sampled at the
 * proposed size and the original one and solved directly — no search,
 * and exact for the linear system each describes.
 *
 * Scope, deliberately: the single-element resize path on an unrotated
 * driver, and, for a member-driven chain, one whose middle is free to
 * absorb. A rotated element's bounds don't move with its size in a way
 * this prediction models, and if the middle is pinned the correction
 * lands elsewhere; both fall through uncapped rather than capped wrongly.
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

  const chains = collectHardChains(elementsMap);
  if (chains.length === 0) {
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

  /** Where the driver's `edge` sits at a proposed length. */
  const driverEdgeAt = (
    axis: Axis,
    edge: AlignmentEdge,
    length: number,
  ): number => {
    const [min, max] = projected(axis, length);
    return edge === "min" ? min : edge === "max" ? max : (min + max) / 2;
  };

  /**
   * The shift the *edge* pass would hand each element, if the driver were
   * `length` long — the same seed-and-flood `buildResizeAlignmentDeltas`
   * performs, sampled at a hypothetical size instead of the live one.
   *
   * This is what carries a resize into a chain the driver isn't a member
   * of, and so what the cap for those chains has to be written in terms
   * of.
   */
  const edgeShiftsAt = (axis: Axis, length: number): Map<string, number> => {
    const shifts = new Map<string, number>();
    const origDriver = originalElements.get(driver.id) ?? driver;
    const origRange = axisRange(getElementBounds(origDriver, elementsMap), axis);

    for (const link of driver.alignments ?? []) {
      if (
        link.axis !== axis ||
        link.elementId === driver.id ||
        isAlignmentAnchor(elementsMap.get(link.elementId)) ||
        shifts.has(link.elementId)
      ) {
        continue;
      }
      const origin =
        link.selfEdge === "min"
          ? origRange[0]
          : link.selfEdge === "max"
          ? origRange[1]
          : (origRange[0] + origRange[1]) / 2;
      shifts.set(
        link.elementId,
        driverEdgeAt(axis, link.selfEdge, length) - origin,
      );
    }
    floodAlignmentAxis(shifts, axis, new Set([driver.id]), elementsMap);
    return shifts;
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

    const shiftsProposed = edgeShiftsAt(axis, length);
    const shiftsCurrent = edgeShiftsAt(axis, current);

    /**
     * The tightest gap the chain is left with, once the correction has
     * run, if the driver were `driverLength` long.
     *
     * Two chains, two rules, matching `correctGapAlignments`. When the
     * driver is a *member*, the mean rule lands both gaps on the mean, so
     * the sum standing in for the tightest one is exact — and that is the
     * quantity the original cap was written around. When the driver only
     * reaches the chain through edge links, the chain is translated by an
     * arithmetic progression, every gap moves by the same slope, and the
     * tightest gap is the smallest starting gap plus it.
     */
    const marginAt = (
      link: ElementGapAlignment,
      driverLength: number,
      shifts: Map<string, number>,
    ): number | null => {
      const ranges = link.ids.map((id) => rangeOf(id, driverLength));
      if (ranges.some((range) => range == null)) {
        return null;
      }
      const spans = ranges as InclusiveRange[];
      const gaps: number[] = [];
      for (let i = 0; i < spans.length - 1; i++) {
        gaps.push(spans[i + 1][0] - spans[i][1]);
      }

      if (link.ids.includes(driver.id)) {
        return gaps.reduce((total, gap) => total + gap, 0);
      }

      const known: { index: number; shift: number }[] = [];
      link.ids.forEach((id, index) => {
        if (isAlignmentAnchor(elementsMap.get(id))) {
          known.push({ index, shift: 0 });
        } else if (shifts.has(id)) {
          known.push({ index, shift: shifts.get(id)! });
        }
      });
      const shiftAt = fitShiftProgression(known, link.ids.length);
      if (!shiftAt) {
        // nothing reaches this chain, or it can't be satisfied at all —
        // either way this resize is not what closes it
        return null;
      }
      const slope = shiftAt(1) - shiftAt(0);
      return Math.min(...gaps) + slope;
    };

    // Which way the margin runs with the size depends on how the resize
    // reaches the chain, so the contact point can bound the length from
    // either side. Growing a chain member closes the gaps beside it, and
    // the cap is a maximum; shrinking an element the chain's end is
    // aligned to drags that end inward, and the cap is a minimum.
    let lo = -Infinity;
    let hi = Infinity;

    for (const link of chains) {
      // A chain the resize neither belongs to nor reaches by an edge link
      // is not going anywhere, whatever else is true of it
      if (
        link.axis !== axis ||
        (!link.ids.includes(driver.id) &&
          !link.ids.some((id) => shiftsProposed.has(id)))
      ) {
        continue;
      }
      const margin = marginAt(link, length, shiftsProposed);
      const margin0 = marginAt(link, current, shiftsCurrent);
      if (margin == null || margin0 == null || margin >= 0 || margin0 < 0) {
        // already fine, or already crossed before this resize began
        continue;
      }
      const slope = (margin - margin0) / (length - current);
      if (slope === 0) {
        continue;
      }
      // the length at which the tightest gap reaches exactly zero
      const contact = current - margin0 / slope;
      if (slope < 0) {
        hi = Math.min(hi, contact);
      } else {
        lo = Math.max(lo, contact);
      }
    }
    return clamp(length, lo, hi);
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
 * exactly; a longer chain, or two chains sharing a member, need the
 * correction to propagate from triple to triple, which converges
 * geometrically. The cap is generous enough that a chain of a dozen
 * settles well inside it. This is not a general constraint solver — an
 * adversarial graph of chains can leave a small residual error rather
 * than diverging — and that is a deliberate limit for now.
 */
const MAX_GAP_CORRECTION_PASSES = 16;

/** Every distinct hard chain in the scene, deduped across the copies it
 * is stored under (one per member). */
const collectHardChains = (
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
 * The anchors that block a resize because they sit in a hard equal-gap
 * chain the resize would disturb — the equal-gap counterpart of
 * `getAlignmentAnchoredResizeBlockers`, and reported the same way so the
 * clamp and the anvil overlay can treat the two alike.
 *
 * A chain holds its gaps equal by translating its members, so changing
 * any one gap asks every member to shift. An anchor in the chain forbids
 * that, and unlike the edge case there is no partial answer: the
 * correction holds one member still, and a second immovable member
 * leaves it unsatisfiable. So the resize is refused rather than allowed
 * to break the chain.
 *
 * "Would disturb" is per *edge*, which is what leaves the useful gesture
 * alone: a member's leading edge bounds the gap before it and its
 * trailing edge the gap after, so an element at either end of a chain can
 * still be resized outward — that edge bounds no gap.
 */
export const getGapAlignmentAnchoredResizeBlockers = (
  resizedIds: Set<string>,
  elementsMap: ElementsMap,
  opts: ResizeEdgeOpts,
): { x: Set<string>; y: Set<string> } => {
  const blockersOn = (axis: Axis): Set<string> => {
    const blockers = new Set<string>();
    for (const link of collectHardChains(elementsMap)) {
      if (link.axis !== axis) {
        continue;
      }
      // A member is immovable if it is anchored *or* if translating it
      // would have to move an anchor it is edge-linked to. The correction
      // only ever translates members, and it runs after the edge pass, so
      // a member shifted here never gets the chance to carry its own edge
      // partners along — the alignment to the anchor would simply break.
      const anchors = new Set<string>();
      for (const id of link.ids) {
        if (resizedIds.has(id)) {
          continue;
        }
        for (const anchorId of getTranslationBlockingAnchors(
          id,
          axis,
          elementsMap,
          resizedIds,
        )) {
          anchors.add(anchorId);
        }
      }
      if (anchors.size === 0) {
        continue;
      }
      const disturbs = link.ids.some(
        (id, index) =>
          resizedIds.has(id) &&
          ((index > 0 && resizeMovesEdge(axis, "min", opts)) ||
            (index < link.ids.length - 1 &&
              resizeMovesEdge(axis, "max", opts))),
      );
      if (disturbs) {
        for (const id of anchors) {
          blockers.add(id);
        }
      }
    }
    return blockers;
  };

  return { x: blockersOn("x"), y: blockersOn("y") };
};

/**
 * The members of every hard chain a resize sets moving, per axis — the
 * equal-gap half of {@link getAlignmentResizeMovers}, and asked the same
 * "does this edge actually move" question as the blockers above.
 *
 * Reported as the whole chain rather than the members that shift, because
 * a chain is corrected as a unit: the solve sends every gap to the mean
 * and holds one member still, so a member that doesn't move is holding
 * the chain in place rather than sitting outside it.
 */
export const getGapAlignmentResizeMovers = (
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
    for (const link of collectHardChains(elementsMap)) {
      if (link.axis !== axis) {
        continue;
      }
      const disturbs = link.ids.some(
        (id, index) =>
          resizedIds.has(id) &&
          ((index > 0 && resizeMovesEdge(axis, "min", opts)) ||
            (index < link.ids.length - 1 &&
              resizeMovesEdge(axis, "max", opts))),
      );
      if (disturbs) {
        for (const id of link.ids) {
          movers.add(id);
        }
      }
    }
    return movers;
  };

  return { x: moversOn("x"), y: moversOn("y") };
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
 * Each chain is solved outright rather than relaxed triple by triple.
 * Sweeping the triples looks tempting — every adjacent pair is the
 * three-element problem — but it doesn't converge: a triple that fully
 * zeroes its own error undoes the correction its neighbour just made to
 * the member they share, and a chain whose middle is the resized element
 * settles into a two-cycle that never touches one side.
 *
 * The solution is: send every gap to the mean of the current gaps, which
 * leaves the chain's overall extent alone (the members redistribute
 * inside the same span), and hold one member still to fix the position —
 * the immovable one if there is one, otherwise the average, so nothing
 * drifts. For three elements this is exactly what the old
 * middle-takes-half rule produced, whichever member was being resized.
 *
 * All of which is for a chain the resize reaches from *inside*. A chain
 * that merely hangs off the resize by an edge link never has a member
 * change width, so its gaps stay equal under a plain translation and it
 * takes {@link translateChain} instead — the drag's rule, so the same
 * displacement produces the same motion whichever gesture caused it.
 *
 * A *second* immovable member would have to move too, which anchoring
 * forbids — so that resize is refused before it happens (see
 * `getGapAlignmentAnchoredResizeBlockers`) and the chain here never has
 * to satisfy two fixed points at once.
 *
 * Each correction is flooded along *edge* links so a member drags its
 * own aligned partners with it. A member that is both gap-constrained
 * and edge-constrained to the resize holds the position the edge pass
 * gave it, and the chain redistributes around it — see `isMovable`.
 */
/**
 * Re-space a chain that is only being *translated*, by the same rule a
 * drag uses — see `getAlignmentDragFactors`.
 *
 * Nothing in the chain changes width here, so the gaps stay equal exactly
 * when the members' shifts form an arithmetic progression: gap `i` moves
 * by `t(i+1) - t(i)`, and a constant difference moves every gap by the
 * same amount. Two degrees of freedom however long the chain is, so the
 * members whose shift is already decided determine it.
 *
 * Which is why the choice of slope for a single known member is the same
 * choice the drag makes, and has to be: an *end* member pins the far end
 * and shares its travel evenly across the gaps, and an *interior* one
 * takes zero, so the chain travels rigidly. Anything else and dragging an
 * element would move the chain one way while resizing it moved the chain
 * another, for the same displacement of the same edge.
 *
 * Returns whether it wrote anything. The shifts are absolute totals
 * measured from the resize-start snapshot, and every known is fixed for
 * the duration, so a second pass over the same chain computes the same
 * answer and reports no change.
 */
const fitShiftProgression = (
  known: readonly { index: number; shift: number }[],
  chainLength: number,
): ((index: number) => number) | null => {
  if (known.length === 0) {
    // nothing is driving this chain, so there is nothing to solve from
    return null;
  }

  const first = known[0];
  const last = known[known.length - 1];
  let slope: number;
  if (known.length > 1) {
    slope = (last.shift - first.shift) / (last.index - first.index);
  } else if (first.index === 0 || first.index === chainLength - 1) {
    // An end member: the *far* end holds still, so the run compresses
    // between the two of them and every gap takes an equal share.
    const farEnd = first.index === 0 ? chainLength - 1 : 0;
    slope = -first.shift / (farEnd - first.index);
  } else {
    slope = 0;
  }
  const intercept = first.shift - slope * first.index;
  const shiftAt = (index: number) => intercept + slope * index;

  // Every known has to lie on the line the outer two define. One that
  // doesn't — a third driver, or an anchor the progression would have to
  // move — makes the chain unsatisfiable, and it is left out of true
  // rather than dragged somewhere that doesn't fix it.
  return known.some(
    ({ index, shift }) =>
      Math.abs(shiftAt(index) - shift) > GAP_CORRECTION_EPSILON,
  )
    ? null
    : shiftAt;
};

const translateChain = (
  ids: readonly string[],
  axis: Axis,
  deltaById: Map<string, number>,
  isMovable: (id: string, axis: Axis) => boolean,
): boolean => {
  const known: { index: number; shift: number }[] = [];
  ids.forEach((id, index) => {
    if (!isMovable(id, axis)) {
      known.push({ index, shift: deltaById.get(id) ?? 0 });
    }
  });

  const shiftAt = fitShiftProgression(known, ids.length);
  if (!shiftAt) {
    return false;
  }

  let wrote = false;
  ids.forEach((id, index) => {
    if (!isMovable(id, axis)) {
      return;
    }
    const shift = shiftAt(index);
    const current = deltaById.get(id) ?? 0;
    if (Math.abs(shift - current) > GAP_CORRECTION_EPSILON) {
      deltaById.set(id, shift);
      wrote = true;
    }
  });
  return wrote;
};

const correctGapAlignments = (
  resizedIds: Set<string>,
  originalElements: PointerDownState["originalElements"],
  dxById: Map<string, number>,
  dyById: Map<string, number>,
  // Size changes the edge pass handed out, per axis. A partner that could
  // not travel stretched instead, and a chain measures the gaps its far
  // edge bounds — so the range has to grow with it, not just slide.
  sizeById: { x: ReadonlyMap<string, number>; y: ReadonlyMap<string, number> },
  elementsMap: ElementsMap,
  edgePinned: { x: ReadonlySet<string>; y: ReadonlySet<string> },
) => {
  const chains = collectHardChains(elementsMap);
  if (chains.length === 0) {
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

  /**
   * A member the correction may reposition.
   *
   * Three kinds may not. The resized element moved under the pointer and
   * an anchor refuses to move at all — and a member whose delta came out
   * of the *edge* pass is pinned just as firmly, because that delta is
   * what keeps a hard edge alignment to the resize intact. Treating one
   * as movable is how the chain used to drift away from the element it
   * was aligned to: the edge pass would place it, and the mean solve
   * would then shift it somewhere else to even out the gaps.
   *
   * Per axis, since a member can be edge-pinned on one and free on the
   * other. The pinned sets are a snapshot taken before this runs, so the
   * deltas the correction itself writes don't pin anything on a later
   * pass.
   */
  const isMovable = (id: string, axis: Axis) =>
    !resizedIds.has(id) &&
    !edgePinned[axis].has(id) &&
    // anchored itself, or edge-linked to something anchored: shifting it
    // would break that alignment, since the edge pass has already run and
    // the anchor cannot follow anyway
    getTranslationBlockingAnchors(id, axis, elementsMap, resizedIds).size === 0;

  for (let pass = 0; pass < MAX_GAP_CORRECTION_PASSES; pass++) {
    let corrected = false;

    for (const { axis, ids } of chains) {
      const deltaById = axis === "x" ? dxById : dyById;

      // A chain no resized element belongs to is only ever *translated*
      // — every member keeps its width, and the drivers reach it through
      // edge links. That is the drag problem exactly, so it takes the
      // drag's answer rather than the mean rule below, which exists for
      // the case a member's own width changed under the pointer.
      if (!ids.some((id) => resizedIds.has(id))) {
        if (translateChain(ids, axis, deltaById, isMovable)) {
          corrected = true;
        }
        continue;
      }

      const ranges = ids.map((id) => {
        const range = rangeOf(id, axis);
        if (!range) {
          return null;
        }
        const delta = deltaById.get(id) ?? 0;
        const grew = sizeById[axis].get(id) ?? 0;
        return [range[0] + delta, range[1] + delta + grew] as const;
      });
      if (ranges.some((range) => range == null)) {
        continue;
      }
      const spans = ranges as (readonly [number, number])[];

      const gaps: number[] = [];
      for (let i = 0; i < spans.length - 1; i++) {
        gaps.push(spans[i + 1][0] - spans[i][1]);
      }

      // Every gap goes to their mean. That is the correction that leaves
      // the chain's overall extent alone — the members redistribute
      // inside the same span — and for three elements it is exactly what
      // the old middle-takes-half rule produced.
      const target =
        gaps.reduce((total, gap) => total + gap, 0) / gaps.length;
      if (
        gaps.every((gap) => Math.abs(gap - target) <= GAP_CORRECTION_EPSILON)
      ) {
        continue;
      }

      // Where each member's leading edge would sit if every gap were
      // `target`, measured from an origin still to be chosen.
      const layout = [0];
      for (let i = 1; i < spans.length; i++) {
        layout.push(
          layout[i - 1] + (spans[i - 1][1] - spans[i - 1][0]) + target,
        );
      }
      // The origin each member would pick if it were the one to hold
      // still. An immovable member decides it; with none, the average
      // keeps the movement even.
      const origins = spans.map((span, i) => span[0] - layout[i]);
      const held = ids.findIndex((id) => !isMovable(id, axis));
      const origin =
        held >= 0
          ? origins[held]
          : origins.reduce((total, value) => total + value, 0) / origins.length;

      const shifts = spans.map((span, i) => origin + layout[i] - span[0]);

      // A second immovable member that would also have to move makes the
      // chain unsatisfiable. Leave it out of true rather than dragging
      // the movable members somewhere that doesn't fix it — and, since
      // the correction is recomputed every pass, rather than drifting.
      // The resize that would have caused it is refused up front by
      // `getGapAlignmentAnchoredResizeBlockers`, so this is a backstop.
      if (
        ids.some(
          (id, i) =>
            !isMovable(id, axis) &&
            Math.abs(shifts[i]) > GAP_CORRECTION_EPSILON,
        )
      ) {
        continue;
      }

      ids.forEach((id, i) => {
        if (isMovable(id, axis) && shifts[i] !== 0) {
          deltaById.set(id, (deltaById.get(id) ?? 0) + shifts[i]);
          corrected = true;
        }
      });
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
  const { dxById, dyById, dwById, dhById } = buildResizeAlignmentDeltas(
    originalElements,
    resizedIds,
    elementsMap,
  );
  // Everything the edge pass placed, captured before the gap correction
  // adds entries of its own. These positions are not up for negotiation:
  // each is what holds a hard edge alignment to the resize together, so
  // a chain running through one has to redistribute around it.
  const edgePinned = {
    x: new Set(dxById.keys()),
    y: new Set(dyById.keys()),
  };
  correctGapAlignments(
    resizedIds,
    originalElements,
    dxById,
    dyById,
    { x: dwById, y: dhById },
    elementsMap,
    edgePinned,
  );
  // Groups last, over whatever both passes placed: a member either pass
  // moved carries its siblings, so the arrangement the user grouped
  // survives the constraint that moved it. It runs after rather than
  // inside the chain solve because a group is rigid and a chain is not —
  // where the two disagree about one element, the group wins and the
  // chain absorbs it, which is the same order of authority the drag path
  // takes.
  const groupMembers = getGroupMembers(elementsMap);
  const skip = (id: string) =>
    resizedIds.has(id) || isAlignmentAnchor(elementsMap.get(id));
  // Positions only. A sibling of a member that *stretched* travels by
  // that member's leading edge, which keeps the group's arrangement as
  // nearly as anything can — the group's own extent changed, and there is
  // no rigid answer to that.
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
