/**
 * Move the elements hard-aligned to what a replayed Moment moved, the way
 * the alignment solver moved them while the gesture happened.
 *
 * Alignment followers are derived state, as bound arrow ends are
 * (`followBindings.ts`): where a partner goes is a function of the links
 * and of how far the elements the user moved went. The log still records
 * each follow, as a consequent op for the panel, but replaying the recorded
 * displacement would put the partner where the scene *was* when the
 * gesture happened — wrong as soon as a skipped Moment has changed it, and
 * blind to a link the recording never knew about, such as one a stand-in
 * took over. So replay drops those consequents (`withoutAlignmentFollowers`)
 * and asks the solver instead, once per Moment, with the Moment's own
 * elements as the gesture: how far each of their edges travelled is the
 * seed (`alignmentDriverFromEdgeDeltas`), and the links are the ones that
 * stood when it began.
 *
 * Where the scene no longer lets them follow — the rows contradict, the
 * solve would have to put a moved element somewhere its op didn't, or a
 * gap would close through zero or a partner squash below the alignment
 * minimum — the moved elements stay as their ops put them and nothing
 * follows on that axis. The links that leaves broken are what
 * `findBrokenAlignments` reports.
 */

import {
  alignmentDriverFromEdgeDeltas,
  applyAlignmentResponse,
  getElementBounds,
  getGroupMembers,
  isAlignmentAnchor,
  isBoundToContainer,
  solveAlignmentResponse,
  spreadAcrossGroups,
} from "@excalidraw/element";

import type { EdgeDelta } from "@excalidraw/element";
import type {
  ElementsMap,
  ExcalidrawElement,
} from "@excalidraw/element/types";

import { updateElement } from "./applyOps";
import { checkGeometry, writePlacement } from "./placement";
import { getOperationElementIds } from "./types";

import type { SceneSnapshot } from "./applyOps";
import type { PlacementWrite } from "./placement";
import type { LogOperation } from "./types";

type Axis = "x" | "y";

/** Float noise in measured displacements; anything above it is a move. */
const EPSILON = 1e-6;

/**
 * The ops whose own elements are a gesture alignment follows: a drag or a
 * resize, of one element or a group. Rotation doesn't move partners while
 * it happens, so a rotate's recorded consequents stand.
 */
export type FollowedOp = Extract<
  LogOperation,
  { kind: "move" | "resize" | "move-group" | "resize-group" }
>;

export const isFollowedOp = (op: LogOperation): op is FollowedOp =>
  op.kind === "move" ||
  op.kind === "resize" ||
  op.kind === "move-group" ||
  op.kind === "resize-group";

/** The elements a followed op moves itself, not the ones that followed. */
export const ownElementIds = (op: FollowedOp): readonly string[] =>
  op.kind === "move" || op.kind === "resize" ? [op.elementId] : op.elementIds;

/**
 * `op` without the followers alignment carried, which `followAlignments`
 * derives instead, and the ids of the ones taken out. A bound arrow's
 * follow stays — `applyConsequentOps` and `followBindings` own those — and
 * so does a container's label, which goes wherever its container went:
 * `followAlignments` re-places the ones whose container it moves.
 */
export const withoutAlignmentFollowers = (
  op: FollowedOp,
  snapshot: SceneSnapshot,
): { op: FollowedOp; stripped: readonly string[] } => {
  if (!op.consequentOps?.length) {
    return { op, stripped: [] };
  }
  const stripped: string[] = [];
  const kept = op.consequentOps.filter((follower) => {
    if (follower.consequenceReason?.kind === "binding") {
      return true;
    }
    const ids = getOperationElementIds(follower);
    if (ids.some((id) => isLabel(snapshot.get(id)))) {
      return true;
    }
    stripped.push(...ids);
    return false;
  });
  return stripped.length === 0
    ? { op, stripped }
    : { op: { ...op, consequentOps: kept }, stripped };
};

const isLabel = (el: ExcalidrawElement | undefined) =>
  el != null && isBoundToContainer(el);

const isZero = (delta: EdgeDelta) =>
  Math.abs(delta.min) < EPSILON && Math.abs(delta.max) < EPSILON;

/** How far `was`'s two edges travelled on `axis` to become `now`. */
const edgeDelta = (
  was: ExcalidrawElement,
  wasMap: ElementsMap,
  now: ExcalidrawElement,
  nowMap: ElementsMap,
  axis: Axis,
): EdgeDelta => {
  const [minX0, minY0, maxX0, maxY0] = getElementBounds(was, wasMap);
  const [minX1, minY1, maxX1, maxY1] = getElementBounds(now, nowMap);
  // An edge the op left alone has to read as exactly zero: the solver
  // takes a zero seed as an edge the gesture only *offers* to hold, the
  // way a resize handle holds its opposite side.
  const clean = (value: number) => (Math.abs(value) < EPSILON ? 0 : value);
  return axis === "x"
    ? { min: clean(minX1 - minX0), max: clean(maxX1 - maxX0) }
    : { min: clean(minY1 - minY0), max: clean(maxY1 - maxY0) };
};

const hasLinksOn = (el: ExcalidrawElement | undefined, axis: Axis) =>
  !!el &&
  (!!el.alignments?.some((link) => link.axis === axis) ||
    !!el.gapAlignments?.some((link) => link.axis === axis));

/**
 * Move whatever is hard-aligned to `drivers` — the elements a Moment's ops
 * moved themselves — by what the solver says, measuring the gesture from
 * `before`, the scene as the Moment found it. `stripped` are the followers
 * the recording had; their labels are re-placed even where the solve no
 * longer moves them. Returns every id it changed, for the caller to stamp
 * and to re-place the arrows bound to them.
 */
export const followAlignments = (
  before: SceneSnapshot,
  snapshot: SceneSnapshot,
  drivers: ReadonlySet<string>,
  stripped: ReadonlySet<string>,
): Set<string> => {
  // most Moments move nothing aligned
  const linked = [...drivers].some(
    (id) => hasLinksOn(before.get(id), "x") || hasLinksOn(before.get(id), "y"),
  );
  if (!linked && stripped.size === 0) {
    return new Set();
  }
  // the solve and the group spread read every element they're handed
  const live = new Map(
    [...before].filter(([, el]) => !el.isDeleted),
  ) as unknown as ElementsMap;
  const nowMap = snapshot as unknown as ElementsMap;
  const writes = new Map<string, PlacementWrite>();
  const groupMembers = getGroupMembers(live);

  for (const axis of ["x", "y"] as const) {
    const seeds = new Map<string, EdgeDelta>();
    for (const id of drivers) {
      const was = live.get(id);
      const now = snapshot.get(id);
      if (was && now && !now.isDeleted) {
        seeds.set(id, edgeDelta(was, live, now, nowMap, axis));
      }
    }
    if (
      [...seeds.values()].every(isZero) ||
      ![...seeds.keys()].some((id) => hasLinksOn(live.get(id), axis))
    ) {
      continue;
    }

    const response = solveAlignmentResponse(
      alignmentDriverFromEdgeDeltas(seeds),
      axis,
      live,
    );
    if (!response.feasible) {
      continue;
    }
    const deltas = applyAlignmentResponse(response, [1]);
    // A moved element the solve would put somewhere else — the edge a
    // resize held, let go — leaves its followers nothing consistent to
    // follow: its op has already placed it.
    const misplaced = [...seeds].some(([id, seed]) => {
      const solved = deltas.get(id);
      return (
        solved != null &&
        !isZero({ min: solved.min - seed.min, max: solved.max - seed.max })
      );
    });
    if (misplaced) {
      continue;
    }

    const position = new Map<string, number>();
    const size = new Map<string, number>();
    for (const [id, delta] of deltas) {
      if (drivers.has(id) || isZero(delta)) {
        continue;
      }
      position.set(id, delta.min);
      if (Math.abs(delta.max - delta.min) > EPSILON) {
        size.set(id, delta.max - delta.min);
      }
    }
    // Groups as the drag spread them: a follower carries its siblings,
    // never onto a moved element, an anchor or a label.
    spreadAcrossGroups(
      position,
      groupMembers,
      (id) =>
        drivers.has(id) ||
        isAlignmentAnchor(live.get(id)) ||
        isLabel(live.get(id)),
    );

    // the clamps' limits, measured with the moved elements where their ops
    // put them, since a gap between one and a follower counts as much as
    // any other
    const checkedPosition = new Map(position);
    const checkedSize = new Map(size);
    for (const [id, seed] of seeds) {
      if (isZero(seed)) {
        continue;
      }
      checkedPosition.set(id, seed.min);
      if (Math.abs(seed.max - seed.min) > EPSILON) {
        checkedSize.set(id, seed.max - seed.min);
      }
    }
    if (
      checkGeometry(axis, checkedPosition, checkedSize, live, (id) => id, drivers)
    ) {
      continue;
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

  const changed = writePlacement(writes, snapshot);

  // A container that followed, or was recorded following, has its label
  // put back where it sits on the container now. The recording moved
  // labels by the displacement their containers had then — as a consequent
  // or as a move of their own — and `writePlacement` carries them again
  // by the one they have now, so neither can be trusted alone: placed from
  // the Moment's start instead, by how far the container's centre went.
  const followers = new Set([...stripped, ...writes.keys()]);
  if (followers.size > 0) {
    for (const el of Array.from(snapshot.values())) {
      if (
        el.isDeleted ||
        !isBoundToContainer(el) ||
        drivers.has(el.containerId) ||
        !followers.has(el.containerId)
      ) {
        continue;
      }
      const wasLabel = before.get(el.id);
      const wasContainer = before.get(el.containerId);
      const container = snapshot.get(el.containerId);
      if (!wasLabel || !wasContainer || !container) {
        continue;
      }
      const x =
        wasLabel.x +
        container.x +
        container.width / 2 -
        (wasContainer.x + wasContainer.width / 2);
      const y =
        wasLabel.y +
        container.y +
        container.height / 2 -
        (wasContainer.y + wasContainer.height / 2);
      if (Math.abs(x - el.x) > EPSILON || Math.abs(y - el.y) > EPSILON) {
        updateElement(snapshot, el.id, { x, y });
        changed.add(el.id);
      }
    }
  }
  return changed;
};
