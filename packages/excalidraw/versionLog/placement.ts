/**
 * Where a stand-in has to be for the alignment links it is handed.
 *
 * A reassigned `alignment` op names the stand-in in links that were true of
 * the missing element: its edge sat on its partner's, or it sat in an evenly
 * spaced run. The stand-in is somewhere else, so before those links are
 * written it has to be moved to where they hold (`ALIGNMENT_REASSIGN_PLAN.md`).
 * Two steps:
 *
 * - `getPlacementTarget` works out *where*: per axis, how far each of the
 *   stand-in's two edges travels. Every other element is taken where it
 *   stands — the partners are what the stand-in is measured against.
 * - `solvePlacement` works out what getting there does to everything coupled
 *   to the stand-in, with the partners held still, and `writePlacement`
 *   writes it.
 */

import {
  alignmentDriverFromEdgeDeltas,
  applyAlignmentResponse,
  canAlignmentStretch,
  getElementBounds,
  getGroupMembers,
  isAlignmentAnchor,
  isBoundToContainer,
  isTextElement,
  MIN_ALIGNED_SIZE,
  solveAlignmentResponse,
  spreadAcrossGroups,
} from "@excalidraw/element";

import type { ConstraintRef, EdgeDelta } from "@excalidraw/element";
import type {
  AlignmentEdge,
  ElementsMap,
  ExcalidrawElement,
} from "@excalidraw/element/types";

import { alignmentLinkKey, updateElement } from "./applyOps";

import type { Link, LinkMap, SceneSnapshot } from "./applyOps";
import type { LogOperation } from "./types";

type Axis = "x" | "y";
type AlignmentOp = Extract<LogOperation, { kind: "alignment" }>;

export type PlacementTarget =
  | {
      readonly status: "place";
      /** how far the stand-in's edges travel on each axis; `null` for an
       * axis none of its new links is on */
      readonly x: EdgeDelta | null;
      readonly y: EdgeDelta | null;
      /** the partners the target was measured from, which have to stay put
       * for it to hold */
      readonly held: ReadonlySet<string>;
    }
  | {
      readonly status: "refused";
      /** phrased to follow the stand-in's name, as `standInRefusal`'s are */
      readonly reason: string;
    };

/** One requirement on the stand-in's edge displacements on one axis:
 * `a·δmin + b·δmax = c`. */
type Equation = { a: number; b: number; c: number };

/** Float noise in the arithmetic below; anything above it is a real
 * disagreement. */
const EPSILON = 1e-6;

/** How far apart two edges, or a chain's gaps, may be and still count as
 * equal — the tolerance alignment detection locks at. */
export const ALIGNMENT_HOLD_TOLERANCE = 1;

/** Why alignment can't stretch `el`, phrased to follow its name. */
export const rigidRefusal = (el: ExcalidrawElement) =>
  isTextElement(el)
    ? "is text, which alignment can't resize to fit"
    : "is rotated, which alignment can't resize to fit";

/** A stand-in that couldn't be placed, so its alignment op was skipped. */
export type UnplacedStandIn = {
  readonly standInId: string;
  /** phrased to follow the stand-in's name */
  readonly reason: string;
};

const nameOf = (el: ExcalidrawElement) => el.shortId ?? el.type;

/** The equation putting `edge` of an element spanning `range` at `target`. */
const edgeAt = (
  range: readonly [number, number],
  edge: AlignmentEdge,
  target: number,
): Equation =>
  edge === "min"
    ? { a: 1, b: 0, c: target - range[0] }
    : edge === "max"
    ? { a: 0, b: 1, c: target - range[1] }
    : // the centre is the mean of the two edges
      { a: 1, b: 1, c: 2 * target - (range[0] + range[1]) };

export const coordOf = (
  range: readonly [number, number],
  edge: AlignmentEdge,
) =>
  edge === "min"
    ? range[0]
    : edge === "max"
    ? range[1]
    : (range[0] + range[1]) / 2;

/** The links `op` adds to `ownerId`, applied forward: the ones its recorded
 * field gained (see the `alignment` case of `applyOpToScene`). */
const addedLinks = (op: AlignmentOp, ownerId: string): readonly Link[] => {
  const before = new Set(
    ((op.before as LinkMap)[ownerId] ?? []).map(alignmentLinkKey),
  );
  return ((op.after as LinkMap)[ownerId] ?? []).filter(
    (link) => !before.has(alignmentLinkKey(link)),
  );
};

/**
 * Where `standInId` has to be for the links `op` adds to hold, measured on
 * `snapshot` before any of them is written.
 *
 * Only links the op *adds* ask anything: one it leaves in place was placed
 * by the op that added it, and an unlock adds nothing at all. A partner that
 * isn't live is passed over — writing a link to it is a missing referent of
 * its own, which the replay reports separately.
 */
export const getPlacementTarget = (
  op: AlignmentOp,
  standInId: string,
  snapshot: SceneSnapshot,
): PlacementTarget => {
  const elementsMap = snapshot as unknown as ElementsMap;
  const live = (id: string) => {
    const el = snapshot.get(id);
    return el && !el.isDeleted ? el : null;
  };
  const standIn = live(standInId);
  if (!standIn) {
    return { status: "place", x: null, y: null, held: new Set() };
  }

  const rangeOf = (el: ExcalidrawElement, axis: Axis) => {
    const [minX, minY, maxX, maxY] = getElementBounds(el, elementsMap);
    return (axis === "x" ? [minX, maxX] : [minY, maxY]) as [number, number];
  };

  const equations: Record<Axis, Equation[]> = { x: [], y: [] };
  const held = new Set<string>();
  const chainsSeen = new Set<string>();

  for (const ownerId of op.elementIds) {
    for (const link of addedLinks(op, ownerId)) {
      if ("ids" in link) {
        // the same chain is recorded on every member
        const key = alignmentLinkKey(link);
        if (chainsSeen.has(key) || !link.ids.includes(standInId)) {
          continue;
        }
        chainsSeen.add(key);
        const refusal = chainEquations(
          link.ids,
          link.axis,
          standIn,
          live,
          rangeOf,
          equations[link.axis],
          held,
        );
        if (refusal) {
          return { status: "refused", reason: refusal };
        }
        continue;
      }

      // An edge link is stored on both partners, so the same coincidence
      // arrives from each side; the duplicate equation is harmless.
      let partner: ExcalidrawElement | null;
      let standInEdge: AlignmentEdge;
      let partnerEdge: AlignmentEdge;
      if (ownerId === standInId) {
        partner = link.elementId === standInId ? null : live(link.elementId);
        standInEdge = link.selfEdge;
        partnerEdge = link.otherEdge;
      } else if (link.elementId === standInId) {
        partner = live(ownerId);
        standInEdge = link.otherEdge;
        partnerEdge = link.selfEdge;
      } else {
        continue;
      }
      if (!partner) {
        continue;
      }
      held.add(partner.id);
      equations[link.axis].push(
        edgeAt(
          rangeOf(standIn, link.axis),
          standInEdge,
          coordOf(rangeOf(partner, link.axis), partnerEdge),
        ),
      );
    }
  }

  const deltas: Record<Axis, EdgeDelta | null> = { x: null, y: null };
  for (const axis of ["x", "y"] as const) {
    const solved = solveAxis(
      equations[axis],
      rangeOf(standIn, axis),
      standIn,
    );
    if (typeof solved === "string") {
      return { status: "refused", reason: solved };
    }
    deltas[axis] = solved;
  }
  return { status: "place", x: deltas.x, y: deltas.y, held };
};

/**
 * The equations a gap chain puts on the stand-in, appended to `out`, or why
 * it can't join the chain at all.
 *
 * The chain's common gap comes from the gaps the stand-in isn't part of,
 * where there are any. An end member then sits one gap beyond its neighbour;
 * an interior member sits one gap inside each neighbour, which fixes its
 * width as well as its place. A three-member chain with the stand-in in the
 * middle has no other gap to go by, so the stand-in only has to be centred
 * between its neighbours.
 */
const chainEquations = (
  ids: readonly string[],
  axis: Axis,
  standIn: ExcalidrawElement,
  live: (id: string) => ExcalidrawElement | null,
  rangeOf: (el: ExcalidrawElement, axis: Axis) => [number, number],
  out: Equation[],
  held: Set<string>,
): string | null => {
  const at = ids.indexOf(standIn.id);
  const members = ids.map(live);
  if (members.some((member, i) => i !== at && member == null)) {
    // a missing member is a referent of its own
    return null;
  }
  const ranges = members.map((member) => rangeOf(member!, axis));
  const chainName = members.map((member) => nameOf(member!)).join("–");

  const otherGaps: number[] = [];
  for (let i = 0; i < ids.length - 1; i++) {
    if (i !== at && i + 1 !== at) {
      otherGaps.push(ranges[i + 1][0] - ranges[i][1]);
    }
  }
  if (otherGaps.some((gap) => Math.abs(gap - otherGaps[0]) > ALIGNMENT_HOLD_TOLERANCE)) {
    return `would join ${chainName}, whose other gaps aren't equal`;
  }
  for (let i = 0; i < ids.length; i++) {
    if (i !== at) {
      held.add(ids[i]);
    }
  }

  const own = ranges[at];
  if (otherGaps.length === 0) {
    // the middle of three: centred between its neighbours
    const before = ranges[at - 1];
    const after = ranges[at + 1];
    if (after[0] - before[1] < own[1] - own[0]) {
      const [left, right] = [members[at - 1]!, members[at + 1]!].map(nameOf);
      return `is too wide to fit between ${left} and ${right}`;
    }
    out.push(edgeAt(own, "center", (before[1] + after[0]) / 2));
    return null;
  }

  const gap = otherGaps[0];
  if (at > 0) {
    out.push(edgeAt(own, "min", ranges[at - 1][1] + gap));
  }
  if (at < ids.length - 1) {
    out.push(edgeAt(own, "max", ranges[at + 1][0] - gap));
  }
  return null;
};

/**
 * The displacement of the stand-in's two edges that meets every equation on
 * one axis, or why there is none.
 *
 * Two unknowns, so at most two equations are independent: one leaves the
 * stand-in free to keep its size, and it does (a translation); two fix both
 * edges, which may mean a stretch. Every equation is then checked against
 * the answer, since any beyond those two has to agree with them.
 */
const solveAxis = (
  equations: readonly Equation[],
  range: readonly [number, number],
  standIn: ExcalidrawElement,
): EdgeDelta | string | null => {
  if (equations.length === 0) {
    return null;
  }
  const first = equations[0];
  const second = equations.find(
    (eq) => Math.abs(first.a * eq.b - first.b * eq.a) > EPSILON,
  );

  let delta: EdgeDelta;
  if (!second) {
    const d = first.c / (first.a + first.b);
    delta = { min: d, max: d };
  } else {
    const det = first.a * second.b - first.b * second.a;
    delta = {
      min: (first.c * second.b - first.b * second.c) / det,
      max: (first.a * second.c - first.c * second.a) / det,
    };
  }

  if (
    equations.some(
      (eq) =>
        Math.abs(eq.a * delta.min + eq.b * delta.max - eq.c) >
        EPSILON * (1 + Math.abs(eq.c)),
    )
  ) {
    return "can't meet all of its new alignments at once";
  }
  if (
    Math.abs(delta.max - delta.min) > EPSILON &&
    !canAlignmentStretch(standIn)
  ) {
    return rigidRefusal(standIn);
  }
  if (range[1] + delta.max - (range[0] + delta.min) < MIN_ALIGNED_SIZE) {
    return "would have to shrink to nothing to fit";
  }
  return delta;
};

// ---------------------------------------------------------------------

/** How far each element moves and changes size, in scene units. */
export type PlacementWrite = { dx: number; dy: number; dw: number; dh: number };

export type PlacementSolution =
  | {
      readonly status: "solved";
      /** every element the placement changes, the stand-in among them;
       * container labels aren't in here — `writePlacement` carries them */
      readonly writes: ReadonlyMap<string, PlacementWrite>;
    }
  | { readonly status: "refused"; readonly reason: string };

const isZero = (delta: EdgeDelta) =>
  Math.abs(delta.min) < EPSILON && Math.abs(delta.max) < EPSILON;

/**
 * What moving the stand-in to `target` does to everything coupled to it,
 * or why it can't be done. Writes nothing, so the same call answers
 * `standInRefusal` before a choice and the replay after one.
 *
 * Per axis, one solve: the stand-in driven by its target, every partner it
 * was measured from driven by zero. The solver reads a zero seed as an
 * *offer* — the edge a resize handle holds still — and declines it rather
 * than refuse the gesture, so holding the partners is checked on the answer
 * instead: the stand-in has to land exactly on its target and every partner
 * has to stay put, or the links written next wouldn't hold. What made the
 * solver let go is its `releasedBy`.
 *
 * The solve is asked before the op's links exist. Its rows only say "these
 * edges move together", which can't close a gap of a given size; holding
 * the partners while the stand-in travels is what closes it.
 */
export const solvePlacement = (
  target: Extract<PlacementTarget, { status: "place" }>,
  standInId: string,
  snapshot: SceneSnapshot,
): PlacementSolution => {
  // the solve and the group spread read every element they're handed
  const live = new Map(
    [...snapshot].filter(([, el]) => !el.isDeleted),
  ) as unknown as ElementsMap;
  const standIn = live.get(standInId);
  const writes = new Map<string, PlacementWrite>();
  if (!standIn) {
    return { status: "solved", writes };
  }
  const refused = (reason: string): PlacementSolution => ({
    status: "refused",
    reason,
  });
  const nameOfId = (id: string) => {
    const el = live.get(id);
    return el ? nameOf(el) : id;
  };
  const groupMembers = getGroupMembers(live);

  for (const axis of ["x", "y"] as const) {
    const seed = target[axis];
    if (!seed || isZero(seed)) {
      continue;
    }
    // A driver isn't held by its own anchor flag — its displacement *is*
    // the gesture — so an anchored stand-in has to be caught here.
    if (isAlignmentAnchor(standIn)) {
      return refused("is anchored");
    }

    const seeds = new Map<string, EdgeDelta>([[standInId, seed]]);
    for (const id of target.held) {
      seeds.set(id, { min: 0, max: 0 });
    }
    const response = solveAlignmentResponse(
      alignmentDriverFromEdgeDeltas(seeds),
      axis,
      live,
    );
    if (!response.feasible) {
      return refused(blame(response.refusedBy, standInId, target.held, nameOfId));
    }
    const deltas = applyAlignmentResponse(response, [1]);
    const STILL = { min: 0, max: 0 };
    const own = deltas.get(standInId) ?? STILL;
    if (
      !isZero({ min: own.min - seed.min, max: own.max - seed.max }) ||
      [...target.held].some((id) => !isZero(deltas.get(id) ?? STILL))
    ) {
      return refused(
        blame(response.releasedBy, standInId, target.held, nameOfId),
      );
    }

    const position = new Map<string, number>();
    const size = new Map<string, number>();
    for (const [id, delta] of deltas) {
      if (isZero(delta)) {
        continue;
      }
      position.set(id, delta.min);
      if (Math.abs(delta.max - delta.min) > EPSILON) {
        size.set(id, delta.max - delta.min);
      }
    }
    // Groups as a drag spreads them: a member that moved carries its
    // siblings, anchors excepted. Labels are left to `writePlacement`,
    // which moves them with their container whether or not it's grouped.
    spreadAcrossGroups(
      position,
      groupMembers,
      (id) => isAlignmentAnchor(live.get(id)) || isBoundToContainer(live.get(id)!),
    );
    const carried = [...target.held].find((id) => position.has(id));
    if (carried) {
      return refused(`would carry ${nameOfId(carried)} along with its group`);
    }

    const clash = checkGeometry(axis, position, size, live, nameOfId);
    if (clash) {
      return refused(clash);
    }

    for (const id of new Set([...position.keys(), ...size.keys()])) {
      const write = writes.get(id) ?? { dx: 0, dy: 0, dw: 0, dh: 0 };
      if (axis === "x") {
        write.dx = position.get(id) ?? 0;
        write.dw = size.get(id) ?? 0;
      } else {
        write.dy = position.get(id) ?? 0;
        write.dh = size.get(id) ?? 0;
      }
      writes.set(id, write);
    }
  }
  return { status: "solved", writes };
};

/**
 * Why the solve couldn't place the stand-in, from the constraints it names:
 * an anchor in the way, a partner it is already tied to some other way, or
 * an element alignment won't resize. Phrased to follow the stand-in's name.
 */
const blame = (
  refs: readonly ConstraintRef[],
  standInId: string,
  held: ReadonlySet<string>,
  nameOfId: (id: string) => string,
): string => {
  const list = (ids: Iterable<string>) => [...new Set(ids)].map(nameOfId).join(", ");
  const anchors = refs.flatMap((ref) =>
    ref.kind === "anchor" && ref.elementId !== standInId ? [ref.elementId] : [],
  );
  if (anchors.length > 0) {
    return `would have to move ${list(anchors)}, which ${
      new Set(anchors).size === 1 ? "is" : "are"
    } anchored`;
  }
  const partners = refs.flatMap((ref) =>
    ref.kind === "driver" && held.has(ref.elementId) ? [ref.elementId] : [],
  );
  if (partners.length > 0) {
    return `is already aligned with ${list(partners)} another way`;
  }
  const rigid = refs.flatMap((ref) =>
    ref.kind === "rigid" ? [ref.elementId] : [],
  );
  if (rigid.length > 0) {
    return `would have to resize ${list(rigid)}, which alignment keeps rigid`;
  }
  return "can't get there without breaking an alignment";
};

/**
 * What the drag and resize clamps stop at, as refusals: a gap in a chain
 * pushed through zero (past it the chain reorders), or an element squashed
 * below the alignment minimum. A placement has no pointer to stop short, so
 * it either fits or doesn't.
 */
const checkGeometry = (
  axis: Axis,
  position: ReadonlyMap<string, number>,
  size: ReadonlyMap<string, number>,
  live: ElementsMap,
  nameOfId: (id: string) => string,
): string | null => {
  const rangeOf = (id: string) => {
    const [minX, minY, maxX, maxY] = getElementBounds(live.get(id)!, live);
    return axis === "x" ? [minX, maxX] : [minY, maxY];
  };
  const movedRange = (id: string) => {
    const [min, max] = rangeOf(id);
    const dmin = position.get(id) ?? 0;
    return [min + dmin, max + dmin + (size.get(id) ?? 0)];
  };

  for (const id of size.keys()) {
    const [min, max] = movedRange(id);
    if (max - min < MIN_ALIGNED_SIZE) {
      return `would squash ${nameOfId(id)}`;
    }
  }

  const seen = new Set<string>();
  for (const el of live.values()) {
    for (const chain of el.gapAlignments ?? []) {
      const key = alignmentLinkKey(chain);
      if (chain.axis !== axis || seen.has(key)) {
        continue;
      }
      seen.add(key);
      if (!chain.ids.every((id) => live.has(id))) {
        continue;
      }
      if (!chain.ids.some((id) => position.has(id) || size.has(id))) {
        continue;
      }
      for (let i = 0; i + 1 < chain.ids.length; i++) {
        const gapBefore = rangeOf(chain.ids[i + 1])[0] - rangeOf(chain.ids[i])[1];
        const gapAfter =
          movedRange(chain.ids[i + 1])[0] - movedRange(chain.ids[i])[1];
        // a chain that already overlaps is left alone, as the clamps leave it
        if (gapBefore >= -EPSILON && gapAfter < -EPSILON) {
          return `would push ${chain.ids.map(nameOfId).join("–")} into each other`;
        }
      }
    }
  }
  return null;
};

/** Every element an alignment op names: the members whose field it writes,
 * every edge link's partner and every chain's members. */
export const alignmentReferences = (op: AlignmentOp): Set<string> => {
  const ids = new Set(op.elementIds);
  for (const map of [op.before, op.after] as LinkMap[]) {
    for (const [ownerId, links] of Object.entries(map)) {
      ids.add(ownerId);
      for (const link of links) {
        if ("ids" in link) {
          link.ids.forEach((id) => ids.add(id));
        } else {
          ids.add(link.elementId);
        }
      }
    }
  }
  return ids;
};

/**
 * Place every stand-in in `standInIds` for `op`, one after another, or say
 * why one can't be.
 *
 * In turn rather than together: a second stand-in is measured against the
 * scene the first one's placement left, and if the two are linked to each
 * other, the first is among the partners the second is held against. All or
 * nothing — the placements run on a copy, so a refusal halfway leaves
 * `snapshot` as it was, and only with `commit` does a success reach it. The
 * returned ids are what changed, for the caller to re-place the arrows bound
 * to them.
 */
export const placeStandIns = (
  op: AlignmentOp,
  standInIds: Iterable<string>,
  snapshot: SceneSnapshot,
  commit: boolean,
):
  | { readonly status: "placed"; readonly changed: ReadonlySet<string> }
  | ({ readonly status: "refused" } & UnplacedStandIn) => {
  const trial: SceneSnapshot = new Map(snapshot);
  const changed = new Set<string>();
  for (const standInId of standInIds) {
    const target = getPlacementTarget(op, standInId, trial);
    if (target.status === "refused") {
      return { ...target, standInId };
    }
    const solution = solvePlacement(target, standInId, trial);
    if (solution.status === "refused") {
      return { ...solution, standInId };
    }
    for (const id of writePlacement(solution.writes, trial)) {
      changed.add(id);
    }
  }
  if (commit) {
    for (const id of changed) {
      snapshot.set(id, trial.get(id)!);
    }
  }
  return { status: "placed", changed };
};

/**
 * Write a solved placement to `snapshot`, returning the ids it changed so
 * the caller can re-place the arrows bound to them (`followBindings`).
 *
 * A container's label moves with it: replay has no layout pass to put it
 * back, and a label is never its own constraint. One whose container
 * stretched is moved by its container's centre — re-centred, not refitted.
 */
export const writePlacement = (
  writes: ReadonlyMap<string, PlacementWrite>,
  snapshot: SceneSnapshot,
): Set<string> => {
  const changed = new Set<string>();
  for (const [id, { dx, dy, dw, dh }] of writes) {
    const el = snapshot.get(id);
    if (!el) {
      continue;
    }
    updateElement(snapshot, id, {
      x: el.x + dx,
      y: el.y + dy,
      width: Math.max(1, el.width + dw),
      height: Math.max(1, el.height + dh),
    });
    changed.add(id);
  }
  for (const el of Array.from(snapshot.values())) {
    if (el.isDeleted || !isBoundToContainer(el)) {
      continue;
    }
    const write = writes.get(el.containerId);
    if (!write || writes.has(el.id)) {
      continue;
    }
    updateElement(snapshot, el.id, {
      x: el.x + write.dx + write.dw / 2,
      y: el.y + write.dy + write.dh / 2,
    });
    changed.add(el.id);
  }
  return changed;
};
