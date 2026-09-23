import { isTextElement } from "./typeChecks";

import type { AlignmentEdge, ElementsMap, ExcalidrawElement } from "./types";

/**
 * VERSION-LOG: the alignment constraint solver.
 *
 * The engine's answer to "what does the rest of the scene do while the user
 * drags or resizes something" — computed as one linear solve rather than by
 * propagation.
 *
 * The whole of hard alignment is linear in per-edge displacements, so the
 * question is an equality-constrained least-squares problem: the links, chains,
 * anchors and the gesture itself are equations, and where they leave the answer
 * underdetermined a quadratic objective picks among the solutions. Two things
 * follow that the propagators it replaces could not do.
 *
 *   - **Partners may change size.** A displacement here is a pair of numbers,
 *     one per edge, so "this element's left edge follows the drag while its
 *     right edge is pinned by an anchor" is expressible. The old drag path
 *     carried one scalar per element, which is a translation by construction,
 *     and so had to refuse every arrangement that needed a stretch.
 *   - **Nothing is dropped silently.** The propagators took first-wins on a
 *     second demand and verified the result afterwards. Here a constraint that
 *     cannot be met makes the system inconsistent, which is reported, and that
 *     inconsistency is the *only* reason a gesture is refused.
 *
 * The response is linear in the gesture, so it is solved once per gesture and
 * evaluated per frame — see {@link solveAlignmentResponse}.
 *
 * Geometry is deliberately absent: the response depends only on the link
 * topology, never on where anything currently is. Where the elements actually
 * sit matters for how far the gesture may go before a gap closes or an element
 * folds through itself, and that is a separate clamp against the response.
 */

type Axis = "x" | "y";
type Edge = AlignmentEdge;

/**
 * How far each of an element's two edges travels on one axis. Equal values are
 * a translation; different ones are a resize.
 */
export type EdgeDelta = { min: number; max: number };

/** What something anchored to `edge` reads off a displacement: one of the two
 * edges directly, or the centre, which is the mean of them. */
export const deltaAtEdge = (delta: EdgeDelta, edge: Edge): number =>
  edge === "min"
    ? delta.min
    : edge === "max"
    ? delta.max
    : (delta.min + delta.max) / 2;

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
 * The gap-chain "feel" rules, expressed as extra rows.
 *
 * Both describe a choice the hard constraints leave free: a chain driven from
 * a single point has one spare degree of freedom (its slope), and these pick
 * it. They are the behaviour the engine has always had, and they are *not*
 * recoverable from an objective — holding the far end still costs more total
 * displacement than letting it drift, so any minimum-disturbance answer slides
 * the far end backwards against the drag.
 *
 * Turn either off to get that minimum-disturbance behaviour instead and
 * compare. Nothing else in this file reads them, so a flag here changes which
 * rows are built and nothing more. See ALIGNMENT_SOLVER_PLAN.md for the
 * numbers each choice produces, and `alignmentSolve.test.ts`, which asserts
 * both sets.
 *
 * Mutable, and exported for that test rather than for production code: no
 * caller should be choosing per gesture which behaviour the editor has.
 */
export const ALIGNMENT_FEEL_ROWS = {
  /** Dragging a chain's end member holds the far end still, so the run
   * compresses between the two ends and every gap gives up an equal share. */
  endDragHoldsFarEnd: false,
  /** Dragging an interior member travels the whole chain rigidly, so a
   * sideways drag doesn't squeeze the spacing. */
  interiorDragTravelsRigidly: true,
  /**
   * A resize holds the edge its handle isn't moving — the one part of the
   * gesture the user didn't ask about. Offered like the rules above, so it
   * holds wherever it can and lets go where holding it is what makes the
   * gesture impossible: an element centred on an anchor then grows *both*
   * ways instead of being refused.
   *
   * Off, nothing asks that edge to stay and the objective decides. Worth
   * knowing what that means before trying it: translating costs a millionth
   * of what stretching does, so the cheapest way to put the right edge where
   * the pointer asked is usually to move the whole element there. A resize
   * handle then drags rather than resizes, until a constraint makes
   * translation impossible.
   */
  resizeHoldsItsOtherEdge: true,
};

/**
 * Relative cost of changing an element's size against moving it. Moving is far
 * cheaper, so that "move first, stretch only if you can't" falls out of the
 * objective globally rather than being decided element by element as the old
 * propagator decided it.
 *
 * The gap is not infinite, because a stretch has to remain *available*: the
 * whole point is that an arrangement no translation can satisfy is answered
 * rather than refused. The ratio only has to exceed the precision anyone can
 * see, and it bounds the residual stretch on an element that should not have
 * changed size at all — hence {@link RESPONSE_EPSILON} below it.
 *
 * Only the ratio matters, and it is written with the expensive side at 1 so
 * that every entry of the KKT matrix stays at order 1. That normalisation is
 * not cosmetic. With the weights an order of magnitude apart the other way —
 * stretch at 1e6, translation at 1 — the objective block sits six orders above
 * the constraint block, elimination leaves a Schur complement of about 1e-6 in
 * the multiplier columns, and a singularity tolerance scaled to the largest
 * entry reads it as zero. Every solve then comes back infeasible.
 */
const WEIGHT_TRANSLATE = 1e-6;
const WEIGHT_STRETCH = 1;

/** Below this, a solved displacement is noise from the weighting above and is
 * read as an exact zero. */
const RESPONSE_EPSILON = 1e-5;

/** Below this share of the largest multiplier, a constraint is carrying no
 * load. Relative, because a multiplier's size follows the gesture's. */
const MULTIPLIER_EPSILON = 1e-6;

/** Pivot floor for the row reduction. Row coefficients are 0, ±½ or ±1 by
 * construction, so this is an absolute tolerance rather than a scaled one. */
const ROW_EPSILON = 1e-9;

/**
 * What the gesture does, as coefficients rather than distances.
 *
 * Every row in the system is homogeneous in the gesture's degrees of freedom,
 * so the solve is done once against these coefficients and the actual numbers
 * are substituted per frame ({@link applyAlignmentResponse}). A drag has one
 * degree of freedom per axis, the offset; a resize has two, the driver's two
 * edges.
 *
 * Coefficients rather than a `kind` discriminator because a multi-element
 * resize needs them: each member's edges are affine in the selection box's two
 * edges, with a coefficient that depends on where the member sits in the box.
 */
export type AlignmentDriver = {
  readonly dofCount: number;
  /** per driven element, its two edges' coefficients on the degrees of freedom */
  readonly edges: ReadonlyMap<
    string,
    { readonly min: readonly number[]; readonly max: readonly number[] }
  >;
};

/** A drag: one degree of freedom, and both edges of every dragged element
 * follow it exactly — which is what makes a drag a translation. */
export const alignmentDragDriver = (
  ids: Iterable<string>,
): AlignmentDriver => ({
  dofCount: 1,
  edges: new Map(
    [...ids].map((id) => [id, { min: [1], max: [1] }] as const),
  ),
});

/** A single-element resize: the driver's two edges are the two degrees of
 * freedom. A handle that holds an edge still simply passes 0 for it, so the
 * same response answers every handle. */
export const alignmentResizeDriver = (
  ids: Iterable<string>,
): AlignmentDriver => ({
  dofCount: 2,
  edges: new Map(
    [...ids].map((id) => [id, { min: [1, 0], max: [0, 1] }] as const),
  ),
});

/**
 * A gesture already measured: each driven element's edges have moved by a
 * known amount, and the response is wanted at those amounts rather than as a
 * basis to substitute into later.
 *
 * One degree of freedom carrying the measurements as its coefficients, so
 * `applyAlignmentResponse(response, [1])` is the answer.
 *
 * Symbolic seeds go in the same way, and that is the other half of its use: 1
 * for "this edge moves" and 0 for "it doesn't" turns every "is this non-zero"
 * test downstream into "does this edge move at all", so the anchors that will
 * refuse a resize are found by the same solve that would perform it, before
 * any geometry has changed. The prediction and the act cannot drift apart
 * because they are one function.
 */
export const alignmentDriverFromEdgeDeltas = (
  seeds: ReadonlyMap<string, EdgeDelta>,
): AlignmentDriver => ({
  dofCount: 1,
  edges: new Map(
    [...seeds].map(([id, delta]) => [
      id,
      { min: [delta.min], max: [delta.max] },
    ]),
  ),
});

/**
 * What the scene does in response to one gesture.
 *
 * `byElement` is the generalisation of the old drag-factor map: instead of one
 * multiple of the offset per element, one {@link EdgeDelta} per element *per
 * degree of freedom*. An element absent from it is outside the gesture's
 * constraint component and does not move.
 */
export type AlignmentResponse = {
  readonly byElement: ReadonlyMap<string, readonly EdgeDelta[]>;
  readonly dofCount: number;
  /** false when no displacement satisfies the constraints — the one refusal */
  readonly feasible: boolean;
  /** the anchors responsible, when it isn't feasible */
  readonly blockers: ReadonlySet<string>;
  /** elements the answer changes the size of, rather than merely moving */
  readonly stretchers: ReadonlySet<string>;
  /**
   * When it isn't feasible: the constraints that contradict the gesture —
   * the gesture's own rows among them, since a refusal is a conflict
   * *with* it. Exact, and per axis by construction.
   */
  readonly refusedBy: readonly ConstraintRef[];
  /**
   * The constraints actually doing work: those whose multiplier in the
   * solve is non-zero, meaning the answer would be cheaper without them.
   * A link satisfied by everything standing still is not in here.
   */
  readonly activeConstraints: readonly ConstraintRef[];
  /** constraints already implied by the others — releasable with no effect */
  readonly implied: readonly ImpliedConstraint[];
  /**
   * The constraints that made the gesture let go of an edge it was holding —
   * a resize handle's opposite side, released so the gesture could go
   * through at all. Empty for a drag, which holds no edge still, and empty
   * for a resize that kept the edge it meant to.
   *
   * The counterpart of `refusedBy`: same machinery, but the gesture went
   * through in a changed shape rather than being refused, so the UI says
   * "this is why it grew the other way" rather than "this is why nothing
   * happened".
   */
  readonly releasedBy: readonly ConstraintRef[];
  /**
   * Per stretched element, the constraints that made it stretch rather than
   * travel: the load-bearing rows naming it, which is what a "why did this
   * change size" cue would point at. An element stretches only because
   * something holds one of its edges while something else pulls the other,
   * and both of those are in here.
   */
  readonly stretchCauses: ReadonlyMap<string, readonly ConstraintRef[]>;
  /**
   * How many degrees of freedom the constraints leave the component, after
   * the gesture is accounted for. Zero means every element in it is fully
   * pinned by the gesture; the arrangement has no slack left anywhere.
   */
  readonly freedom: number;
};

/** Evaluate a response at an actual gesture: `dofs` is the offset (drag) or
 * the driver's two edge displacements (resize). */
export const applyAlignmentResponse = (
  response: AlignmentResponse,
  dofs: readonly number[],
): Map<string, EdgeDelta> => {
  const deltas = new Map<string, EdgeDelta>();
  for (const [id, perDof] of response.byElement) {
    let min = 0;
    let max = 0;
    for (let k = 0; k < perDof.length && k < dofs.length; k++) {
      min += perDof[k].min * dofs[k];
      max += perDof[k].max * dofs[k];
    }
    deltas.set(id, { min, max });
  }
  return deltas;
};

/**
 * Whether a constraint may change this element's size, as opposed to only
 * moving it.
 *
 * A **rotated** element is excluded because its bounds are not its width and
 * height: the axis-aligned box it presents to the constraints grows with both
 * dimensions at once, which couples the two axes and is deliberately out of
 * scope. **Text** is excluded because a width change rewraps it, so the
 * constraint would be rewriting the element's content rather than its box.
 *
 * Expressed as a row (`δmin = δmax`) rather than a branch in the traversal, so
 * lifting either exclusion is a matter of not emitting the row.
 */
const canStretch = (element: ExcalidrawElement): boolean =>
  element.angle === 0 && !isTextElement(element);

/**
 * The elements a gesture can reach: everything connected to a driven element
 * through same-axis links and gap chains.
 *
 * Scoping to the component is what keeps the solve small — it is cubic in the
 * number of elements it covers, and covering the whole scene would be both
 * wasteful and wrong, since two unrelated arrangements shouldn't share a
 * feasibility answer.
 */
const collectComponent = (
  driverIds: Iterable<string>,
  axis: Axis,
  elementsMap: ElementsMap,
): string[] => {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const id of driverIds) {
    if (elementsMap.has(id) && !seen.has(id)) {
      seen.add(id);
      stack.push(id);
    }
  }
  while (stack.length > 0) {
    const element = elementsMap.get(stack.pop()!);
    if (!element) {
      continue;
    }
    const reach = (id: string) => {
      if (!seen.has(id) && elementsMap.has(id)) {
        seen.add(id);
        stack.push(id);
      }
    };
    for (const link of element.alignments ?? []) {
      if (link.axis === axis) {
        reach(link.elementId);
      }
    }
    for (const link of element.gapAlignments ?? []) {
      if (link.axis === axis) {
        link.ids.forEach(reach);
      }
    }
  }
  return [...seen];
};

/** Every distinct chain on this axis among the component's elements, deduped
 * across the copies it is stored under (one per member). */
const collectChains = (
  ids: readonly string[],
  axis: Axis,
  elementsMap: ElementsMap,
): (readonly string[])[] => {
  const byKey = new Map<string, readonly string[]>();
  for (const id of ids) {
    for (const link of elementsMap.get(id)?.gapAlignments ?? []) {
      if (link.axis === axis && link.ids.length >= 3) {
        byKey.set(link.ids.join("|"), link.ids);
      }
    }
  }
  return [...byKey.values()];
};

/**
 * The elements a gesture reaches *without* passing through a gap chain: the
 * drivers, their same-axis edge partners, and their group siblings.
 *
 * This is what decides whether a chain is driven from a single point, and so
 * whether the feel rules have a free slope to pin. It mirrors the order the
 * old solver ran its passes in — edge links and groups spread first, chains
 * solved against whatever that produced — which is why groups are in here
 * although they are not yet constraints in their own right.
 */
const edgeReachable = (
  driverIds: Iterable<string>,
  axis: Axis,
  elementsMap: ElementsMap,
): Set<string> => {
  const groupMembers = getGroupMembers(elementsMap);
  const seen = new Set<string>(driverIds);
  const stack = [...seen];
  while (stack.length > 0) {
    const element = elementsMap.get(stack.pop()!);
    if (!element) {
      continue;
    }
    const reach = (id: string) => {
      if (!seen.has(id)) {
        seen.add(id);
        stack.push(id);
      }
    };
    for (const link of element.alignments ?? []) {
      if (link.axis === axis) {
        reach(link.elementId);
      }
    }
    const groupId = outermostGroupId(element);
    if (groupId) {
      (groupMembers.get(groupId) ?? []).forEach(reach);
    }
  }
  return seen;
};

/**
 * Incremental row reduction.
 *
 * Rows arrive one at a time and each is reported as kept, redundant (already
 * implied by the ones before it) or inconsistent (it contradicts them). That
 * shape is what lets the feel rules be offered rather than imposed: each is
 * added only if the hard rows leave room for it, and simply declined
 * otherwise, which is exact where a large finite weight would only be
 * approximate.
 *
 * Each row is `[coefficients on the element variables | coefficients on the
 * gesture's degrees of freedom]`, read as `coefficients · x = dof part · d`.
 */
type RowStatus = "kept" | "redundant" | "inconsistent";

/**
 * What a row came from — the constraint it expresses, in the terms the rest
 * of the editor names constraints by.
 *
 * Rows are anonymous arrays of coefficients, and every question of the form
 * "*which* alignment did this" had to be answered by walking the links a
 * second time and hoping the two models agreed. They didn't: a shortest-path
 * walk blamed the axis that was working, and a chain that merely touched the
 * route. A tag per row makes the solve answer for itself.
 *
 * Link and chain refs carry the identity the renderer already draws by, so a
 * blamed row maps onto a guide with no further lookup.
 */
export type ConstraintRef =
  /** the gesture itself, one row per driven edge */
  | { readonly kind: "driver"; readonly elementId: string }
  | {
      readonly kind: "link";
      readonly axis: Axis;
      readonly selfId: string;
      readonly selfEdge: Edge;
      readonly elementId: string;
      readonly otherEdge: Edge;
    }
  /** one gap boundary of a chain: gaps `at` and `at + 1` are equal */
  | {
      readonly kind: "chain";
      readonly axis: Axis;
      readonly ids: readonly string[];
      readonly at: number;
    }
  | { readonly kind: "anchor"; readonly elementId: string }
  /** rotated or text: a constraint may move it but never resize it */
  | { readonly kind: "rigid"; readonly elementId: string }
  | {
      readonly kind: "feel";
      readonly rule: keyof typeof ALIGNMENT_FEEL_ROWS;
      readonly ids: readonly string[];
    };

/** A constraint's identity as a string, for the sets and maps that have to
 * treat two rows from the same constraint as one. */
export const constraintKey = (ref: ConstraintRef): string => {
  switch (ref.kind) {
    case "link":
      return `link:${ref.axis}:${ref.selfId}:${ref.selfEdge}:${ref.elementId}:${ref.otherEdge}`;
    case "chain":
      return `chain:${ref.axis}:${ref.ids.join(",")}:${ref.at}`;
    case "feel":
      return `feel:${ref.rule}:${ref.ids.join(",")}`;
    default:
      return `${ref.kind}:${ref.elementId}`;
  }
};

/** A redundant row and the rows that already implied it — an alignment that
 * could be released without changing anything. */
export type ImpliedConstraint = {
  readonly ref: ConstraintRef;
  readonly impliedBy: readonly ConstraintRef[];
};

/** Below this a combination coefficient is elimination noise rather than a
 * row's genuine part in the result. Relative, because the coefficients are
 * whatever the elimination produced rather than the 0, ±½, ±1 that row
 * coefficients are limited to. */
const COMBINATION_EPSILON = 1e-9;

const createRowReducer = (nVars: number) => {
  const rows: number[][] = [];
  const pivots: number[] = [];
  /** per kept row, its coefficients over the *original* rows — the proof of
   * where it came from, carried through every elimination it survives */
  const combinations: number[][] = [];
  const origins: ConstraintRef[] = [];
  const implied: ImpliedConstraint[] = [];

  /** `target += source * factor`, over combinations that may be shorter than
   * each other: a row added later has coefficients the earlier ones lack. */
  const accumulate = (
    target: number[],
    source: readonly number[],
    factor: number,
  ) => {
    for (let j = 0; j < source.length; j++) {
      target[j] = (target[j] ?? 0) + source[j] * factor;
    }
  };

  /** The rows a combination actually leans on. */
  const support = (combination: readonly number[]): ConstraintRef[] => {
    let largest = 0;
    for (const value of combination) {
      largest = Math.max(largest, Math.abs(value ?? 0));
    }
    const threshold = COMBINATION_EPSILON * Math.max(1, largest);
    const refs: ConstraintRef[] = [];
    for (let j = 0; j < combination.length; j++) {
      if (Math.abs(combination[j] ?? 0) > threshold && origins[j]) {
        refs.push(origins[j]);
      }
    }
    return refs;
  };

  const add = (
    incoming: readonly number[],
    ref: ConstraintRef,
  ): { status: RowStatus; witness: ConstraintRef[] } => {
    const index = origins.length;
    origins.push(ref);

    const row = incoming.slice();
    const combination: number[] = new Array<number>(index + 1).fill(0);
    combination[index] = 1;

    for (let i = 0; i < rows.length; i++) {
      const factor = row[pivots[i]];
      if (factor !== 0) {
        for (let c = 0; c < row.length; c++) {
          row[c] -= factor * rows[i][c];
        }
        accumulate(combination, combinations[i], -factor);
      }
    }

    let pivot = -1;
    let largest = ROW_EPSILON;
    for (let c = 0; c < nVars; c++) {
      if (Math.abs(row[c]) > largest) {
        largest = Math.abs(row[c]);
        pivot = c;
      }
    }

    if (pivot === -1) {
      // Nothing left on the element variables. A wholly empty row restates
      // what we already know; one with a gesture term left over asserts that
      // the gesture equals zero, which it doesn't.
      for (let c = nVars; c < row.length; c++) {
        if (Math.abs(row[c]) > ROW_EPSILON) {
          // The elimination that produced the contradiction is the proof of
          // it: the rows it leaned on are the ones this row contradicts.
          return { status: "inconsistent", witness: support(combination) };
        }
      }
      implied.push({
        ref,
        impliedBy: support(combination).filter((other) => other !== ref),
      });
      return { status: "redundant", witness: [] };
    }

    const scale = row[pivot];
    for (let c = 0; c < row.length; c++) {
      row[c] /= scale;
    }
    for (let j = 0; j < combination.length; j++) {
      combination[j] = (combination[j] ?? 0) / scale;
    }
    rows.forEach((kept, i) => {
      const factor = kept[pivot];
      if (factor !== 0) {
        for (let c = 0; c < kept.length; c++) {
          kept[c] -= factor * row[c];
        }
        accumulate(combinations[i], combination, -factor);
      }
    });
    rows.push(row);
    pivots.push(pivot);
    combinations.push(combination);
    return { status: "kept", witness: [] };
  };

  /**
   * Offer several rows as one indivisible statement: either all of them are
   * taken, or none is.
   *
   * A rule spread over several rows has to be all-or-nothing, because a part
   * of it is not a weaker version of it but a different claim altogether.
   * "This element does not move" is two rows, one per edge; keep only the one
   * the constraints happen to allow and the element is not held still, it is
   * held by one edge and stretched by whatever pulls the other.
   */
  const addAll = (
    incoming: readonly { row: readonly number[]; ref: ConstraintRef }[],
  ): { ok: boolean; witness: ConstraintRef[] } => {
    const savedRows = rows.map((row) => row.slice());
    const savedPivots = pivots.slice();
    const savedCombinations = combinations.map((one) => one.slice());
    const savedOrigins = origins.length;
    const savedImplied = implied.length;
    const restore = () => {
      rows.length = 0;
      rows.push(...savedRows);
      pivots.length = 0;
      pivots.push(...savedPivots);
      combinations.length = 0;
      combinations.push(...savedCombinations);
      // A declined rule was never part of the system, so it must leave no
      // trace: a witness naming one would point at something the user can
      // neither see nor edit.
      origins.length = savedOrigins;
      implied.length = savedImplied;
    };
    for (const { row, ref } of incoming) {
      const { status, witness } = add(row, ref);
      if (status === "inconsistent") {
        restore();
        // The rows that turned the offer down. For a feel rule nobody asks;
        // for the edge a resize handle holds, this is why the element had to
        // change shape in a way the user didn't ask for, and the UI says so.
        return { ok: false, witness };
      }
    }
    return { ok: true, witness: [] };
  };

  return {
    add,
    addAll,
    rows,
    /** rank: one kept row per independent constraint */
    get keptCount() {
      return rows.length;
    },
    /** what each kept row is made of, over the original rows */
    combinations,
    origins,
    implied,
  };
};

/**
 * Gaussian elimination with partial pivoting, several right-hand sides at
 * once. Returns null if the matrix is singular; `a` and `b` are consumed.
 */
const solveLinearSystem = (
  a: number[][],
  b: number[][],
): number[][] | null => {
  const n = a.length;
  const width = b[0]?.length ?? 0;

  let scale = 0;
  for (const row of a) {
    for (const value of row) {
      scale = Math.max(scale, Math.abs(value));
    }
  }
  const tolerance = Math.max(scale, 1) * 1e-12;

  for (let col = 0; col < n; col++) {
    let best = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[best][col])) {
        best = row;
      }
    }
    if (Math.abs(a[best][col]) <= tolerance) {
      return null;
    }
    if (best !== col) {
      [a[col], a[best]] = [a[best], a[col]];
      [b[col], b[best]] = [b[best], b[col]];
    }
    const diagonal = a[col][col];
    for (let row = 0; row < n; row++) {
      if (row === col) {
        continue;
      }
      const factor = a[row][col] / diagonal;
      if (factor === 0) {
        continue;
      }
      for (let c = col; c < n; c++) {
        a[row][c] -= factor * a[col][c];
      }
      for (let c = 0; c < width; c++) {
        b[row][c] -= factor * b[col][c];
      }
    }
  }

  return a.map((row, index) => b[index].map((value) => value / row[index]));
};

/** Add `scale × (the coordinate this edge reads)` to a row. The centre is the
 * mean of the two edges, which is what makes a centre link a single equation
 * rather than a special case. */
const addEdgeTerm = (
  row: number[],
  slot: number,
  edge: Edge,
  scale: number,
) => {
  if (edge === "min") {
    row[slot * 2] += scale;
  } else if (edge === "max") {
    row[slot * 2 + 1] += scale;
  } else {
    row[slot * 2] += scale / 2;
    row[slot * 2 + 1] += scale / 2;
  }
};

/**
 * Why a solve produced nothing, kept apart because the two mean opposite
 * things: an inconsistent system is the engine working — the gesture really
 * cannot be met — while a singular one is a bug, and reporting it as a refusal
 * would hide that behind behaviour that looks deliberate.
 */
type SolveOutcome =
  | { readonly kind: "solved"; readonly response: AlignmentResponse }
  /** the rows contradict each other: no displacement satisfies them, and
   * `refusedBy` is the set that does the contradicting */
  | {
      readonly kind: "inconsistent";
      readonly refusedBy: readonly ConstraintRef[];
    }
  /** the KKT system was not invertible, which should not be reachable — the
   * rows are independent by construction and the objective positive definite */
  | { readonly kind: "singular" };

/**
 * The scene's response to a gesture, as a linear function of it.
 *
 * One solve answers every question asked of it: the displacements, which
 * constraints refuse it, which are load-bearing, which are implied by the
 * rest, and how much freedom is left. Blame used to be release-and-retest —
 * re-solving with one anchor freed, per anchor — which the rows' own
 * provenance has made unnecessary.
 */
const solve = (
  driver: AlignmentDriver,
  axis: Axis,
  elementsMap: ElementsMap,
): SolveOutcome => {
  const ids = collectComponent(driver.edges.keys(), axis, elementsMap);
  const slotOf = new Map(ids.map((id, index) => [id, index]));
  const nVars = ids.length * 2;
  const width = nVars + driver.dofCount;
  const blank = () => new Array<number>(width).fill(0);

  const reducer = createRowReducer(nVars);
  let consistent = true;
  const refusedBy: ConstraintRef[] = [];
  const seenRefs = new Set<string>();
  const addHard = (row: readonly number[], ref: ConstraintRef) => {
    const { status, witness } = reducer.add(row, ref);
    if (status === "inconsistent") {
      // Every contradiction, not just the first. A contradicting row is
      // dropped rather than stored, so the kept system stays consistent and
      // later rows are still reduced against something meaningful — and a
      // gesture can be blocked in two independent places at once, where
      // fixing either one alone leaves it blocked by the other.
      consistent = false;
      for (const found of witness) {
        const key = constraintKey(found);
        if (!seenRefs.has(key)) {
          seenRefs.add(key);
          refusedBy.push(found);
        }
      }
    }
  };

  // The gesture. Written before anything else so that an anchor or a link
  // contradicting it is reported as contradicting *it*, rather than the other
  // way round — the user's action is the thing we are trying to honour.
  //
  // An edge the gesture *holds still* — a resize handle's opposite side, whose
  // coefficients are all zero — is offered rather than imposed, below. It is
  // the one part of a gesture the user didn't ask for: dragging the right
  // handle says "put the right edge here", and says nothing about the left
  // beyond "you needn't move it". Where holding it is impossible — an element
  // centred on an anchor, whose centre may not move — letting it go turns a
  // refusal into a symmetric resize about the centre, which is what the
  // constraint was asking for all along. Every edge the gesture actually
  // moves stays hard, so the opposite side can never take over the resize.
  const heldEdges: { row: number[]; ref: ConstraintRef }[] = [];
  for (const [id, edges] of driver.edges) {
    const slot = slotOf.get(id);
    if (slot === undefined) {
      continue;
    }
    for (const [edge, coefficients] of [
      ["min", edges.min],
      ["max", edges.max],
    ] as const) {
      const row = blank();
      addEdgeTerm(row, slot, edge, 1);
      coefficients.forEach((value, k) => {
        row[nVars + k] = value;
      });
      const ref: ConstraintRef = { kind: "driver", elementId: id };
      if (coefficients.every((value) => value === 0)) {
        // held still by the handle: offered below, or — with the rule off —
        // not asked for at all, leaving the edge to the objective
        if (ALIGNMENT_FEEL_ROWS.resizeHoldsItsOtherEdge) {
          heldEdges.push({ row, ref });
        }
      } else {
        addHard(row, ref);
      }
    }
  }

  for (const id of ids) {
    const element = elementsMap.get(id);
    if (!element || driver.edges.has(id)) {
      // A driver's own displacement is the gesture; it is neither held by an
      // anchor flag of its own nor kept rigid by anything here.
      continue;
    }
    const slot = slotOf.get(id)!;

    if (isAlignmentAnchor(element)) {
      for (const edge of ["min", "max"] as const) {
        const row = blank();
        addEdgeTerm(row, slot, edge, 1);
        addHard(row, { kind: "anchor", elementId: id });
      }
      continue;
    }

    if (!canStretch(element)) {
      const row = blank();
      addEdgeTerm(row, slot, "min", 1);
      addEdgeTerm(row, slot, "max", -1);
      addHard(row, { kind: "rigid", elementId: id });
    }
  }

  // Edge links. Stored symmetrically, so each pair is reached twice and the
  // second copy reduces away as redundant.
  for (const id of ids) {
    const slot = slotOf.get(id)!;
    for (const link of elementsMap.get(id)?.alignments ?? []) {
      const partner = slotOf.get(link.elementId);
      if (link.axis !== axis || partner === undefined) {
        continue;
      }
      const row = blank();
      addEdgeTerm(row, slot, link.selfEdge, 1);
      addEdgeTerm(row, partner, link.otherEdge, -1);
      addHard(row, {
        kind: "link",
        axis,
        selfId: id,
        selfEdge: link.selfEdge,
        elementId: link.elementId,
        otherEdge: link.otherEdge,
      });
    }
  }

  // Gap chains: consecutive gaps stay equal, which is one equation per
  // interior gap boundary.
  const chains = collectChains(ids, axis, elementsMap);
  for (const chain of chains) {
    for (let i = 0; i + 2 < chain.length; i++) {
      const before = slotOf.get(chain[i]);
      const middle = slotOf.get(chain[i + 1]);
      const after = slotOf.get(chain[i + 2]);
      if (before === undefined || middle === undefined || after === undefined) {
        continue;
      }
      const row = blank();
      addEdgeTerm(row, middle, "min", 1);
      addEdgeTerm(row, before, "max", -1);
      addEdgeTerm(row, after, "min", -1);
      addEdgeTerm(row, middle, "max", 1);
      addHard(row, { kind: "chain", axis, ids: chain, at: i });
    }
  }

  if (!consistent) {
    return { kind: "inconsistent", refusedBy };
  }

  // The edges the gesture holds still, offered one at a time: an axis whose
  // held edge cannot stay put should still hold the other one's.
  const releasedBy: ConstraintRef[] = [];
  const seenReleases = new Set<string>();
  for (const held of heldEdges) {
    const { ok, witness } = reducer.addAll([held]);
    if (!ok) {
      for (const ref of witness) {
        const key = constraintKey(ref);
        if (!seenReleases.has(key)) {
          seenReleases.add(key);
          releasedBy.push(ref);
        }
      }
    }
  }

  // The feel rules, offered to whatever freedom the hard rows left. A chain
  // driven at more than one point has no free slope for them to pin, and one
  // driven at none isn't going anywhere, so only a single driven member asks
  // the question they answer.
  const reachable = edgeReachable(driver.edges.keys(), axis, elementsMap);
  for (const chain of chains) {
    const driven = chain.filter((id) => reachable.has(id));
    if (driven.length !== 1) {
      continue;
    }
    const at = chain.indexOf(driven[0]);
    const isEnd = at === 0 || at === chain.length - 1;

    if (isEnd && ALIGNMENT_FEEL_ROWS.endDragHoldsFarEnd) {
      const farEnd = slotOf.get(chain[at === 0 ? chain.length - 1 : 0]);
      if (farEnd !== undefined) {
        // Both edges, because the rule is that the far end does not move —
        // not merely that it stays centred where it was, which a chain pulling
        // on one of its edges could satisfy by stretching it.
        reducer.addAll(
          (["min", "max"] as const).map((edge) => {
            const row = blank();
            addEdgeTerm(row, farEnd, edge, 1);
            return {
              row,
              ref: {
                kind: "feel" as const,
                rule: "endDragHoldsFarEnd" as const,
                ids: chain,
              },
            };
          }),
        );
      }
    } else if (!isEnd && ALIGNMENT_FEEL_ROWS.interiorDragTravelsRigidly) {
      // Every other member *translates*, both edges, by however far the driven
      // member's centre moves. Both edges for the same reason the far-end rule
      // uses both: a member told only where its centre goes can get there by
      // holding one edge and moving the other twice as far, which is a stretch
      // and not what "travels rigidly" says. That is not hypothetical — a
      // member with an edge an anchor holds has no other way to satisfy a
      // centre row, so the rule that is supposed to move a chain rigidly ends
      // up resizing it instead. Written against the driven member's centre
      // rather than member to member so a *resize* of an interior member
      // carries the rest along without spreading its size change to them.
      const drivenSlot = slotOf.get(driven[0]);
      const rigid: { row: number[]; ref: ConstraintRef }[] = [];
      for (const id of chain) {
        const slot = slotOf.get(id);
        if (slot === undefined || drivenSlot === undefined || id === driven[0]) {
          continue;
        }
        for (const edge of ["min", "max"] as const) {
          const row = blank();
          addEdgeTerm(row, slot, edge, 1);
          addEdgeTerm(row, drivenSlot, "center", -1);
          rigid.push({
            row,
            ref: {
              kind: "feel",
              rule: "interiorDragTravelsRigidly",
              ids: chain,
            },
          });
        }
      }
      reducer.addAll(rigid);
    }
  }

  // The objective, as the quadratic form `xᵀQx`. Per element, its translation
  // is (min + max) / 2 and its stretch is max − min, and the weights above say
  // which of the two a constraint should reach for.
  const q: number[][] = Array.from({ length: nVars }, () =>
    new Array<number>(nVars).fill(0),
  );
  for (let slot = 0; slot < ids.length; slot++) {
    const min = slot * 2;
    const max = slot * 2 + 1;
    const diagonal = WEIGHT_TRANSLATE / 4 + WEIGHT_STRETCH;
    const off = WEIGHT_TRANSLATE / 4 - WEIGHT_STRETCH;
    q[min][min] += diagonal;
    q[max][max] += diagonal;
    q[min][max] += off;
    q[max][min] += off;
  }

  // Karush-Kuhn-Tucker: minimise the objective on the affine set the rows
  // describe. `2Qx + Cᵀλ = 0` alongside `Cx = Rd`, solved for every degree of
  // freedom at once. Q is positive definite (its per-element eigenvalues are
  // the two weights) and the rows are independent by construction, so this is
  // non-singular whenever the reduction said the system was consistent.
  const rows = reducer.rows;
  const size = nVars + rows.length;
  const kkt: number[][] = Array.from({ length: size }, () =>
    new Array<number>(size).fill(0),
  );
  const rhs: number[][] = Array.from({ length: size }, () =>
    new Array<number>(driver.dofCount).fill(0),
  );

  for (let r = 0; r < nVars; r++) {
    for (let c = 0; c < nVars; c++) {
      kkt[r][c] = 2 * q[r][c];
    }
  }
  rows.forEach((row, index) => {
    for (let c = 0; c < nVars; c++) {
      kkt[nVars + index][c] = row[c];
      kkt[c][nVars + index] = row[c];
    }
    for (let k = 0; k < driver.dofCount; k++) {
      rhs[nVars + index][k] = row[nVars + k];
    }
  });

  const solution = solveLinearSystem(kkt, rhs);
  if (!solution) {
    return { kind: "singular" };
  }

  const byElement = new Map<string, EdgeDelta[]>();
  const stretchers = new Set<string>();

  ids.forEach((id, slot) => {
    const perDof: EdgeDelta[] = [];
    for (let k = 0; k < driver.dofCount; k++) {
      const rawMin = solution[slot * 2][k];
      const rawMax = solution[slot * 2 + 1][k];

      // Relative, because the coefficients this is solved against are
      // sometimes symbolic (order 1) and sometimes measured in pixels (order
      // hundreds), and the weighting's error scales with them.
      const scale = Math.max(1, Math.abs(rawMin), Math.abs(rawMax));
      const negligible = (value: number) =>
        Math.abs(value) < RESPONSE_EPSILON * scale;

      const min = negligible(rawMin) ? 0 : rawMin;
      // A stretch this small is the weight ratio's residual, not a size
      // change: an element asked only to travel comes back with its edges
      // differing by about `WEIGHT_TRANSLATE / WEIGHT_STRETCH` of how far it
      // went. Snapped back to the translation it was meant to be, so that no
      // consumer has to make the distinction for itself — and several would
      // get it wrong, since "did this element's size change" is the test that
      // decides whether a container's label is carried or refitted.
      const max = negligible(rawMax - rawMin)
        ? min
        : negligible(rawMax)
        ? 0
        : rawMax;

      perDof.push({ min, max });
      // Drivers are excluded: a resize changes the driver's size by
      // definition, and this set exists to name the elements that changed size
      // as a *consequence* — what a "why did this stretch" cue would point at.
      if (!driver.edges.has(id) && max !== min) {
        stretchers.add(id);
      }
    }
    byElement.set(id, perDof);
  });

  // The multipliers say which rows are load-bearing: a row the answer is
  // pressed against has a non-zero one, a row it satisfies without effort has
  // zero. They belong to the *reduced* rows, each of which is a combination
  // of the original ones, so the weight a reduced row carries is shared out
  // over the constraints it was built from.
  const perOrigin = new Array<number>(reducer.origins.length).fill(0);
  reducer.combinations.forEach((combination, index) => {
    for (let k = 0; k < driver.dofCount; k++) {
      const multiplier = solution[nVars + index][k];
      for (let j = 0; j < combination.length; j++) {
        perOrigin[j] += Math.abs(multiplier * (combination[j] ?? 0));
      }
    }
  });
  const largestWeight = Math.max(0, ...perOrigin);
  const activeConstraints = reducer.origins.filter(
    // relative: multipliers carry the objective's units, which the gesture's
    // own scale runs through
    (_, index) => perOrigin[index] > MULTIPLIER_EPSILON * largestWeight,
  );

  // What holds a stretched element's edges: every load-bearing constraint
  // that names it. The gesture's own rows are in there when the driver is
  // what is pulling, which is the usual case and worth saying.
  const stretchCauses = new Map<string, ConstraintRef[]>();
  for (const id of stretchers) {
    const causes = activeConstraints.filter((ref) =>
      ref.kind === "link"
        ? ref.selfId === id || ref.elementId === id
        : ref.kind === "chain" || ref.kind === "feel"
        ? ref.ids.includes(id)
        : ref.elementId === id,
    );
    stretchCauses.set(id, causes);
  }

  return {
    kind: "solved",
    response: {
      byElement,
      dofCount: driver.dofCount,
      feasible: true,
      blockers: new Set(),
      stretchers,
      refusedBy: [],
      releasedBy,
      activeConstraints,
      implied: reducer.implied,
      stretchCauses,
      freedom: nVars - reducer.keptCount,
    },
  };
};

/**
 * What the scene does in response to one gesture on one axis.
 *
 * Solve once per gesture and evaluate per frame with
 * {@link applyAlignmentResponse}: the rows are fixed for the duration of a
 * gesture — links don't appear mid-drag and anchors don't change — so only the
 * numbers substituted into the response change from frame to frame.
 */
export const solveAlignmentResponse = (
  driver: AlignmentDriver,
  axis: Axis,
  elementsMap: ElementsMap,
): AlignmentResponse => {
  const outcome = solve(driver, axis, elementsMap);
  if (outcome.kind === "solved") {
    return outcome.response;
  }

  const refused = (
    blockers: ReadonlySet<string>,
    refusedBy: readonly ConstraintRef[],
  ): AlignmentResponse => ({
    byElement: new Map(),
    dofCount: driver.dofCount,
    feasible: false,
    blockers,
    stretchers: new Set(),
    refusedBy,
    releasedBy: [],
    activeConstraints: [],
    implied: [],
    stretchCauses: new Map(),
    freedom: 0,
  });

  if (outcome.kind === "singular") {
    // Nothing to blame: no arrangement of anchors produced this, so naming one
    // would be inventing a reason.
    return refused(new Set(), []);
  }

  // The anchors among the contradicting rows are the ones whose release would
  // make the gesture possible — which is what release-and-retest used to
  // establish, one extra solve per anchor, and what the witness now says
  // outright. Where the contradiction involves no anchor at all (two links
  // pulling one edge two ways, a rigid element asked to stretch) there is
  // nothing for the anvil overlay to name, and `refusedBy` carries the real
  // answer.
  const blockers = new Set<string>();
  for (const ref of outcome.refusedBy) {
    if (ref.kind === "anchor") {
      blockers.add(ref.elementId);
    }
  }

  return refused(blockers, outcome.refusedBy);
};

/**
 * The anchors that are actually shaping a gesture the engine *allowed* — the
 * ones whose release would change where something ends up.
 *
 * Distinct from `blockers`, which name the anchors behind a refusal. This is
 * the other half of the same question, and it is what the lighter anvil
 * overlay means: not "this is why nothing happened" but "this is why what
 * happened looks like that".
 *
 * Read off the solve's multipliers, which is both exact and free. A
 * constraint's multiplier is what the answer is pressed against it by: zero
 * means the optimum would be the same without it, non-zero means releasing it
 * would move something. So an anchor is in play exactly when one of its two
 * rows is carrying load — the far end of a chain the feel rule already holds
 * at zero has an anchor row doing nothing, and stays out, which is the
 * distinction the old solver spelled out by hand as "does this pin override
 * the default".
 *
 * This used to be release-and-compare: one extra whole solve per anchor,
 * every frame of every gesture near one. The multipliers were always there.
 */
export const alignmentAnchorsInPlay = (
  driver: AlignmentDriver,
  axis: Axis,
  elementsMap: ElementsMap,
): Set<string> => {
  const inPlay = new Set<string>();
  const outcome = solve(driver, axis, elementsMap);
  if (outcome.kind !== "solved") {
    // A refusal is blamed by `solveAlignmentResponse`, on its own terms.
    return inPlay;
  }

  // An anchor whose work a *feel rule* would have done anyway is not why
  // anything landed where it did. The rule was offered and found redundant —
  // the far end of a chain is held at zero by the rule and by the anchor
  // alike — so the anchor's rows carry the load and its multiplier is
  // non-zero, though releasing it would change nothing: the rule, no longer
  // redundant, would simply be kept instead.
  //
  // This is the one place where "load-bearing" and "releasing it would change
  // the answer" come apart, and it is why the feel rules are offered rather
  // than imposed: a row that *is* in the system cannot be substituted for,
  // but a candidate one can.
  const substitutable = new Set<string>();
  for (const { ref, impliedBy } of outcome.response.implied) {
    if (ref.kind !== "feel") {
      continue;
    }
    for (const by of impliedBy) {
      if (by.kind === "anchor") {
        substitutable.add(by.elementId);
      }
    }
  }

  for (const ref of outcome.response.activeConstraints) {
    if (ref.kind === "anchor" && !substitutable.has(ref.elementId)) {
      inPlay.add(ref.elementId);
    }
  }
  return inPlay;
};
