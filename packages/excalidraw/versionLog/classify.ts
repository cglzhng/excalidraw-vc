import type {
  ExcalidrawElement,
  FixedPointBinding,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";

import {
  composeMatrix,
  elementBoxMatrix,
  fixedPoint,
  getMatrixTranslation,
  identityMatrix,
  inverseMatrix,
  isPureTranslation,
  matricesEqual,
} from "./transform";

import { buildGroupNodeFromEntries, getParentGroupId } from "./groupTree";

import type {
  ArrowBinding,
  LogEntry,
  LogOperation,
  LogPropertyMap,
} from "./types";

import type { TransformMatrix } from "./transform";

/**
 * Properties Excalidraw uses for change tracking that are noise for
 * semantic classification. Ignore them throughout.
 */
const TRACKING_PROPS = new Set(["version", "versionNonce", "index"]);

/**
 * Style properties that, when changed in isolation, become a `restyle`
 * operation. One op per property (per Q2 answer).
 */
const STYLE_PROPS: readonly string[] = [
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
];

// Assumption: Only ONE LogEntry per element
export const classifyEntries = (
  entries: readonly LogEntry[],
  changedElements: Record<string, OrderedExcalidrawElement>,
  groupSizeCache: Map<string, number>,
): LogOperation[] => {
  // Pre-pass: detect group / ungroup events. These are inherently
  // multi-entry (the same gid is added to / removed from N members
  // in one user action), so they don't fit the per-entry classifier.
  const { groupingOps, consumed: groupingConsumed } = detectGroupChange(entries);

  // Per-entry classification for everything the pre-pass didn't claim.
  const ops: LogOperation[] = [];
  for (const entry of entries) {
    if (groupingConsumed.has(entry)) {
      continue;
    }
    ops.push(classifyEntry(entry, changedElements));
  }

  // Post-pass: detect generic group-transform events (move-group,
  // resize-group, rotate-group) across the per-entry ops.
  const { groupOps, consumed: geometricConsumed } = detectGroups(
    ops,
    changedElements,
    groupSizeCache,
  );

  return [
    ...groupingOps,
    ...groupOps,
    ...ops.filter((o) => !geometricConsumed.has(o)),
  ];
};

/**
 * Geometry properties of an element that affect its world transform.
 * If an entry doesn't touch a given property, its before/after value is
 * the same as the current scene value.
 */
type GeometryKey = "x" | "y" | "width" | "height" | "angle";

/**
 * Compute the single `TransformMatrix` representing the geometric
 * change to one element between its before- and after-states.
 *
 * Strategy: build the element → world matrix (`elementBoxMatrix`) for
 * each state, then return `M_after · M_before⁻¹`. The result is a pure
 * translation for a move, a pure rotation for a rotate-in-place, a
 * pure scale for a corner-anchored resize, etc. — and crucially, two
 * entries that received the same operation produce the same matrix
 * (use `matricesEqual` to compare).
 *
 * Returns `null` when the change can't be expressed as a single
 * invertible affine map. Two cases:
 *   - the element isn't in the scene any more (deleted concurrently?),
 *   - the before-state has zero `width` or `height` (degenerate box;
 *     `M_before` is singular and has no inverse).
 *
 * Returns the identity matrix when no geometry property changed —
 * that's distinct from `null` and is useful info for the caller
 * ("there was no geometric change" vs "we couldn't compute one").
 */
const buildEntryGeometryMatrix = (
  entry: LogEntry,
  current: OrderedExcalidrawElement,
): TransformMatrix | null => {
  const beforeOf = (key: GeometryKey): number =>
    key in entry.before
      ? (entry.before[key] as number)
      : (current[key] as number);

  const afterOf = (key: GeometryKey): number =>
    key in entry.after
      ? (entry.after[key] as number)
      : (current[key] as number);

  const x1 = beforeOf("x");
  const y1 = beforeOf("y");
  const w1 = beforeOf("width");
  const h1 = beforeOf("height");
  const a1 = beforeOf("angle");

  const x2 = afterOf("x");
  const y2 = afterOf("y");
  const w2 = afterOf("width");
  const h2 = afterOf("height");
  const a2 = afterOf("angle");

  // No geometry change at all → identity. Distinct from `null`.
  if (x1 === x2 && y1 === y2 && w1 === w2 && h1 === h2 && a1 === a2) {
    return identityMatrix();
  }

  // Degenerate before-box → no invertible transform exists.
  if (w1 === 0 || h1 === 0) {
    return null;
  }

  const before = elementBoxMatrix(x1, y1, w1, h1, a1);
  const after = elementBoxMatrix(x2, y2, w2, h2, a2);
  const beforeInv = inverseMatrix(before);
  if (!beforeInv) {
    return null;
  }

  // composeMatrix(A, B) = A · B (B applied first). Here we want the
  // map "world point of before-state → world point of after-state":
  // first untransform via M_before⁻¹ down to model space, then
  // re-transform via M_after up to the after-state world space.
  return composeMatrix(after, beforeInv);
};

// A single entry represent a SINGLE operation on one element
const classifyEntry = (
  entry: LogEntry,
  changedElements: Record<string, OrderedExcalidrawElement>,
): LogOperation => {
  if (entry.type === "create") {
    return {
      kind: "create",
      elementId: entry.elementId,
      elementType: entry.elementType,
      values: entry.after,
    };
  }
  if (entry.type === "delete") {
    return {
      kind: "delete",
      elementId: entry.elementId,
      elementType: entry.elementType,
      lastValues: entry.before,
    };
  }

  const current = changedElements[entry.elementId];
  const changed = getChangedKeys(entry);

  // Arrows have derived geometry (x/y/width/height computed from
  // points) and structural properties (`startBinding`, `endBinding`)
  // that don't fit the generic geometry/style classifier. Dispatch to
  // arrow-specific detection first; if nothing matches, fall through
  // and let the generic paths handle simple cases like translation.
  if (current?.type === "arrow") {
    const arrowOp = classifyArrowEntry(entry, current, changed);
    if (arrowOp) {
      return arrowOp;
    }
  }

  // It's impossible to detect what kind of change it is based on
  // the transform, so just use the properties from the delta.
  const hasAngleChange = changed.has("angle");
  const hasSizeChange = changed.has("width") || changed.has("height");
  const hasPosChange = changed.has("x") || changed.has("y");

  const hasGeometryChange = hasAngleChange || hasSizeChange || hasPosChange;

  changed.delete("angle");
  changed.delete("width");
  changed.delete("height");
  changed.delete("x");
  changed.delete("y");

  if (hasGeometryChange && current && changed.size === 0) {
    const transform = buildEntryGeometryMatrix(entry, current);

    // Without an invertible transform (e.g. degenerate before-box) the
    // geometric op types can't be populated; fall through to raw.
    if (transform == null) {
      return { kind: "raw", entry };
    }

    // Resize: width and/or height changed; angle unchanged. x/y may
    // also have changed if the user dragged from a corner that isn't
    // the anchor — that's the normal case.
    if (hasSizeChange && !hasAngleChange && current) {
      const fromW =
        "width" in entry.before
          ? (entry.before.width as number)
          : (current.width as number);
      const fromH =
        "height" in entry.before
          ? (entry.before.height as number)
          : (current.height as number);
      const toW =
        "width" in entry.after
          ? (entry.after.width as number)
          : (current.width as number);
      const toH =
        "height" in entry.after
          ? (entry.after.height as number)
          : (current.height as number);

      // Local-frame scale: derive directly from the dimension change.
      // This works even when the element is rotated.
      const scaleX = fromW === 0 ? 1 : toW / fromW;
      const scaleY = fromH === 0 ? 1 : toH / fromH;

      return {
        kind: "resize",
        elementId: entry.elementId,
        elementType: current.type,
        from: { width: fromW, height: fromH },
        to: { width: toW, height: toH },
        scaleX,
        scaleY,
        // The resize anchor (un-moved point) exists in world space
        // regardless of rotation; read it off the matrix when we can.
        center: fixedPoint(transform),
        transform,
      };
    }

    // Rotate: angle changed; size unchanged. x/y may have changed to
    // keep some chosen pivot fixed
    if (hasAngleChange && !hasSizeChange && current) {
      const from =
        "angle" in entry.before
          ? (entry.before.angle as number)
          : (current.angle as number);
      const to =
        "angle" in entry.after
          ? (entry.after.angle as number)
          : (current.angle as number);

      return {
        kind: "rotate",
        elementId: entry.elementId,
        elementType: current.type,
        from,
        to,
        // Local-frame delta: just (to - from). Avoids the
        // world-frame decomposition for the same reason as above.
        angle: to - from,
        // Rotation pivot in world coords — read off the matrix.
        center: fixedPoint(transform),
        transform,
      };
    }

    // Move: only x and/or y changed.
    if (hasPosChange && !hasAngleChange && !hasSizeChange) {
      let dx: number;
      let dy: number;
      if (isPureTranslation(transform)) {
        [dx, dy] = getMatrixTranslation(transform);
      } else {
        dx = changed.has("x") ? numericDiff(entry.before, entry.after, "x") : 0;
        dy = changed.has("y") ? numericDiff(entry.before, entry.after, "y") : 0;
      }
      // Absolute before/after positions. Fall back to `current` for
      // axes the entry didn't touch — that side equals the current
      // scene value by definition.
      const fromX =
        "x" in entry.before
          ? (entry.before.x as number)
          : (current?.x as number);
      const fromY =
        "y" in entry.before
          ? (entry.before.y as number)
          : (current?.y as number);
      const toX =
        "x" in entry.after
          ? (entry.after.x as number)
          : (current?.x as number);
      const toY =
        "y" in entry.after
          ? (entry.after.y as number)
          : (current?.y as number);
      return {
        kind: "move",
        elementId: entry.elementId,
        elementType: current?.type,
        from: { x: fromX, y: fromY },
        to: { x: toX, y: toY },
        dx,
        dy,
        transform,
      };
    }
  }

  for (const prop of STYLE_PROPS) {
    if (changed.has(prop)) {
      return {
        kind: "restyle",
        elementId: entry.elementId,
        elementType: current?.type,
        property: prop,
        from: entry.before[prop],
        to: entry.after[prop],
      };
    }
  }

  // Fallback for anything we haven't classified yet
  return {
    kind: "raw",
    entry,
  };
};

/**
 * Return the set of changed property keys on an entry, excluding noise
 * (`version`, `versionNonce`).
 */
const getChangedKeys = (entry: LogEntry): Set<string> => {
  const keys = new Set<string>();
  for (const k of Object.keys(entry.before)) {
    if (!TRACKING_PROPS.has(k)) {
      keys.add(k);
    }
  }
  for (const k of Object.keys(entry.after)) {
    if (!TRACKING_PROPS.has(k)) {
      keys.add(k);
    }
  }
  return keys;
};

const numericDiff = (
  before: LogPropertyMap,
  after: LogPropertyMap,
  key: string,
): number => {
  const a = key in after ? (after[key] as number) : (before[key] as number);
  const b = key in before ? (before[key] as number) : (after[key] as number);
  return (a as number) - (b as number);
};

// ------------------------- Arrow classifier --------------------------

type ArrowPoint = readonly [number, number];

const EPS = 1e-3;

const pointsAlmostEqual = (a: ArrowPoint, b: ArrowPoint, eps: number = EPS) =>
  Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps;

// Check if two bindings are equal or "close enough"
// Sometimes a binding is emitted even if the user did not make a change
const bindingsEqual = (a: ArrowBinding, b: ArrowBinding): boolean => {
  if (a === b) {
    return true;
  }
  if (a == null || b == null) {
    return false;
  }
  return (
    a.elementId === b.elementId &&
    a.mode === b.mode &&
    pointsAlmostEqual(a.fixedPoint, b.fixedPoint)
  );
};

/**
 * True iff the change between `before` and `after` is "structural" — a
 * bind (null → value), unbind (value → null), or rebind that points at
 * a different element.
 * Caller is responsible for first establishing that the change is
 * real.
 */
const isStructuralBindingChange = (
  before: ArrowBinding,
  after: ArrowBinding,
): boolean => {
  if (before == null || after == null) {
    return true;
  }
  return before.elementId !== after.elementId;
};

/**
 * Check if `after` is `before` scaled by `(scaleX, scaleY)` per-point.
 * Used to decide whether a `points` change that accompanies a width /
 * height change is a bbox resize or an independent waypoint edit
 * that just happens to alter the bbox.
 */
const pointsAreScaledBy = (
  before: readonly ArrowPoint[],
  after: readonly ArrowPoint[],
  scaleX: number,
  scaleY: number,
): boolean => {
  if (before.length !== after.length) {
    return false;
  }
  for (let i = 0; i < before.length; i++) {
    const expected: ArrowPoint = [before[i][0] * scaleX, before[i][1] * scaleY];
    if (!pointsAlmostEqual(after[i], expected)) {
      return false;
    }
  }
  return true;
};

/**
 * Try to classify an arrow-specific operation. Returns `null` to
 * indicate "fall back to generic classification" (e.g. a pure move of
 * the arrow body — translation only — which the standard `move` path
 * handles correctly).
 */
const classifyArrowEntry = (
  entry: LogEntry,
  current: OrderedExcalidrawElement,
  changed: Set<string>,
): LogOperation | null => {
  const beforeStart = (entry.before.startBinding ?? null) as ArrowBinding;
  const afterStart = (entry.after.startBinding ?? null) as ArrowBinding;
  const beforeEnd = (entry.before.endBinding ?? null) as ArrowBinding;
  const afterEnd = (entry.after.endBinding ?? null) as ArrowBinding;

  const hasStartChange =
    changed.has("startBinding") && !bindingsEqual(beforeStart, afterStart);
  const hasEndChange =
    changed.has("endBinding") && !bindingsEqual(beforeEnd, afterEnd);
  changed.delete("startBinding");
  changed.delete("endBinding");

  const hasPointsChange = changed.has("points");
  const hasAngleChange = changed.has("angle");
  const hasSizeChange = changed.has("width") || changed.has("height");

  changed.delete("points");
  changed.delete("x");
  changed.delete("y");
  changed.delete("width");
  changed.delete("height");

  // ----- 1. arrow-bind: a binding actually changed value -----------
  //
  // Permits points + bbox residue (binding may shift an endpoint and
  // thus the bbox). Rejected if any unrelated property also changed.

  if (hasStartChange || hasEndChange) {
    if (changed.size === 0) {
      const startStructural =
        hasStartChange && isStructuralBindingChange(beforeStart, afterStart);
      const endStructural =
        hasEndChange && isStructuralBindingChange(beforeEnd, afterEnd);

      if (startStructural || endStructural) {
        const op: Extract<LogOperation, { kind: "arrow-bind" }> = {
          kind: "arrow-bind",
          elementId: entry.elementId,
          elementType: current.type,
        };
        if (hasStartChange) {
          op.start = { before: beforeStart, after: afterStart };
        }
        if (hasEndChange) {
          op.end = { before: beforeEnd, after: afterEnd };
        }
        return op;
      }

      // No structural changes, so the change is a same-element
      // anchor move. Since isStructuralBindingChange
      // returned false, both before and after are
      // non-null with the same `elementId`.
      const op: Extract<LogOperation, { kind: "arrow-move-binding" }> = {
        kind: "arrow-move-binding",
        elementId: entry.elementId,
        elementType: current.type,
      };
      if (hasStartChange && beforeStart != null && afterStart != null) {
        op.start = {
          boundElementId: afterStart.elementId,
          before: beforeStart,
          after: afterStart,
        };
      }
      if (hasEndChange && beforeEnd != null && afterEnd != null) {
        op.end = {
          boundElementId: afterEnd.elementId,
          before: beforeEnd,
          after: afterEnd,
        };
      }
      if (op.start || op.end) {
        return op;
      }
    }
  }

  // ----- 2. arrow-rotate: only `angle` (+ derived bbox) ------------
  //
  // Excalidraw rotates at render time around the element's center, so
  // local `points` should NOT change for a pure rotation.
  if (hasAngleChange && !hasPointsChange) {
    if (changed.size === 0) {
      const transform = buildEntryGeometryMatrix(entry, current);
      if (transform) {
        const from =
          "angle" in entry.before
            ? (entry.before.angle as number)
            : (current.angle as number);
        const to =
          "angle" in entry.after
            ? (entry.after.angle as number)
            : (current.angle as number);
        return {
          kind: "arrow-rotate",
          elementId: entry.elementId,
          elementType: current.type,
          from,
          to,
          angle: to - from,
          center: fixedPoint(transform),
          transform,
        };
      }
    }
  }

  // ----- 3. arrow-resize: bbox change with consistent points scaling -
  //
  // For arrows, `points` changes during a corner-drag resize.
  // We only treat it as a resize when the
  // points change matches the bbox scale; otherwise the user dragged
  // a waypoint and the bbox change is the derived consequence.
  if (hasSizeChange && !hasAngleChange) {
    if (changed.size === 0) {
      const fromW =
        "width" in entry.before
          ? (entry.before.width as number)
          : (current.width as number);
      const fromH =
        "height" in entry.before
          ? (entry.before.height as number)
          : (current.height as number);
      const toW =
        "width" in entry.after
          ? (entry.after.width as number)
          : (current.width as number);
      const toH =
        "height" in entry.after
          ? (entry.after.height as number)
          : (current.height as number);
      const scaleX = fromW === 0 ? 1 : toW / fromW;
      const scaleY = fromH === 0 ? 1 : toH / fromH;

      const beforePts =
        (entry.before.points as readonly ArrowPoint[] | undefined) ?? [];
      const afterPts =
        (entry.after.points as readonly ArrowPoint[] | undefined) ?? [];
      const pointsConsistent = pointsAreScaledBy(
        beforePts,
        afterPts,
        scaleX,
        scaleY,
      );

      if (pointsConsistent) {
        const transform = buildEntryGeometryMatrix(entry, current);
        if (transform) {
          return {
            kind: "arrow-resize",
            elementId: entry.elementId,
            elementType: current.type,
            from: { width: fromW, height: fromH },
            to: { width: toW, height: toH },
            scaleX,
            scaleY,
            center: fixedPoint(transform),
            transform,
          };
        }
      }
      // Inconsistent points → not a resize → try edit-points below.
    }
  }

  // ----- 4. arrow-edit-points: any points change ------------------
  //
  // Permitted residue: derived bbox geometry. Anything else is "edit
  // + something" and falls through.
  if (hasPointsChange) {
    if (changed.size === 0) {
      const before =
        (entry.before.points as readonly ArrowPoint[] | undefined) ?? [];
      const after =
        (entry.after.points as readonly ArrowPoint[] | undefined) ?? [];
      return {
        kind: "arrow-edit-points",
        elementId: entry.elementId,
        elementType: current.type,
        before,
        after,
      };
    }
  }

  // Couldn't classify as arrow-specific — let the generic paths try.
  return null;
};

// ------------------------- Group / ungroup detector ------------------

/**
 * Detect `group` / `ungroup` events by looking at `groupIds` deltas
 * across entries. A group / ungroup event = N (≥ 2) entries that all
 * gained / lost the SAME group id in this increment.
 *
 * Runs as a pre-pass before per-entry classification
 *
 * Residue check: only `groupIds` (and our usual tracking noise) may
 * have changed on each participating entry. If an entry's
 * `groupIds` changed alongside other properties, we don't consume
 * it — the per-entry classifier handles it as best it can.
 */
const detectGroupChange = (
  entries: readonly LogEntry[],
): { groupingOps: LogOperation[]; consumed: Set<LogEntry> } => {
  // gid → entries that added it / removed it (only entries with a
  // clean residue — `groupIds` is the only thing they changed).
  const addedBy = new Map<string, LogEntry[]>();
  const removedBy = new Map<string, LogEntry[]>();

  for (const entry of entries) {
    if (entry.type !== "update") {
      continue;
    }
    const changed = getChangedKeys(entry);
    if (!changed.has("groupIds")) {
      continue;
    }
    changed.delete("groupIds");
    if (changed.size > 0) {
      // groupIds changed alongside other properties — skip.
      continue;
    }

    const beforeArr =
      (entry.before.groupIds as readonly string[] | undefined) ?? [];
    const afterArr =
      (entry.after.groupIds as readonly string[] | undefined) ?? [];
    const beforeSet = new Set(beforeArr);
    const afterSet = new Set(afterArr);

    for (const gid of afterArr) {
      if (!beforeSet.has(gid)) {
        let bucket = addedBy.get(gid);
        if (!bucket) {
          bucket = [];
          addedBy.set(gid, bucket);
        }
        bucket.push(entry);
      }
    }
    for (const gid of beforeArr) {
      if (!afterSet.has(gid)) {
        let bucket = removedBy.get(gid);
        if (!bucket) {
          bucket = [];
          removedBy.set(gid, bucket);
        }
        bucket.push(entry);
      }
    }
  }

  const groupingOps: LogOperation[] = [];
  const consumed = new Set<LogEntry>();

  // Need ≥ 2 members to be a real group operation; a singleton
  // groupIds tweak isn't a "group" event semantically.
  for (const [gid, members] of addedBy) {
    if (members.length < 2) {
      continue;
    }
    groupingOps.push({
      kind: "group",
      // The new group's tree is built from the AFTER state (the gid
      // is present there).
      group: buildGroupNodeFromEntries(gid, members, "after"),
      parentGroupId: getParentGroupId(gid, members, "after"),
    });
    for (const e of members) {
      consumed.add(e);
    }
  }
  for (const [gid, members] of removedBy) {
    if (members.length < 2) {
      continue;
    }
    groupingOps.push({
      kind: "ungroup",
      // The dissolved group's tree is built from the BEFORE state
      // (the gid was present there, not after).
      group: buildGroupNodeFromEntries(gid, members, "before"),
      parentGroupId: getParentGroupId(gid, members, "before"),
    });
    for (const e of members) {
      consumed.add(e);
    }
  }

  return { groupingOps, consumed };
};

// ------------------------- Group detector ----------------------

interface GroupCandidate {
  op: LogOperation;
  element: ExcalidrawElement;
  transform: TransformMatrix;
}

/**
 * Detect "group" operations: a set of entries that are
 *  (a) A geometric operation (move, rotate, or resize)
 *  (b) Transform matrixes are the same
 *  (c) constitute the FULL membership of some group, and
 *  (d) chosen at the innermost qualifying group per Q4.
 *
 * Returns the resulting move-group ops plus the set of entries they
 * consumed (so the caller can skip them in per-entry classification).
 */
const detectGroups = (
  ops: readonly LogOperation[],
  changedElements: Record<string, OrderedExcalidrawElement>,
  groupSizeCache: Map<string, number>,
): { groupOps: LogOperation[]; consumed: Set<LogOperation> } => {
  const candidates: GroupCandidate[] = [];
  for (const op of ops) {
    // Generic and arrow-specific resize/rotate ops bucket together —
    // a mixed group (arrows + non-arrows) being transformed as a unit
    // should produce a single `resize-group` or `rotate-group`, not
    // one per element kind.
    const isCandidate =
      op.kind === "move" ||
      op.kind === "resize" ||
      op.kind === "rotate" ||
      op.kind === "arrow-resize" ||
      op.kind === "arrow-rotate";
    if (!isCandidate) {
      continue;
    }
    const element = changedElements[op.elementId];
    if (!element || element.groupIds.length === 0) {
      continue;
    }
    candidates.push({
      op,
      element,
      transform: op.transform,
    });
  }

  if (candidates.length === 0) {
    return { groupOps: [], consumed: new Set() };
  }

  // Bucket candidates by every group they belong to.
  const byGroupId = new Map<string, GroupCandidate[]>();
  for (const cand of candidates) {
    for (const gid of cand.element.groupIds) {
      let bucket = byGroupId.get(gid);
      if (!bucket) {
        bucket = [];
        byGroupId.set(gid, bucket);
      }
      bucket.push(cand);
    }
  }

  // A group is "valid" if (a) every one of its members changed (count
  // matches scene-wide group size) AND (b) they all had the same transform
  const validGroups = new Set<string>();
  for (const [gid, bucket] of byGroupId) {
    if (bucket.length !== groupSizeCache.get(gid)) {
      continue;
    }
    const { transform } = bucket[0];
    if (bucket.every((c) => matricesEqual(c.transform, transform))) {
      validGroups.add(gid);
    }
  }

  if (validGroups.size === 0) {
    return { groupOps: [], consumed: new Set() };
  }

  // Assign each candidate to its INNERMOST valid group (groupIds is
  // ordered innermost-first per Excalidraw's convention).
  const candsByGid = new Map<string, GroupCandidate[]>();
  const consumed = new Set<LogOperation>();
  for (const cand of candidates) {
    const targetGid = cand.element.groupIds.find((gid) => validGroups.has(gid));
    if (!targetGid) {
      continue;
    }
    let cands = candsByGid.get(targetGid);
    if (!cands) {
      cands = [];
      candsByGid.set(targetGid, cands);
    }
    cands.push(cand);
    consumed.add(cand.op);
  }

  const groupOps: LogOperation[] = [];
  for (const [groupId, cands] of candsByGid) {
    const op = cands[0].op;
    const elementIds = cands.map((c) => c.element.id);
    if (op.kind === "move") {
      // Each candidate's per-entry op is a `move` with its own
      // absolute `from` / `to`; bundle them into Records keyed by
      // element id so the group op carries per-member snapshots.
      const fromPositions: Record<string, { x: number; y: number }> = {};
      const toPositions: Record<string, { x: number; y: number }> = {};
      for (const c of cands) {
        if (c.op.kind === "move") {
          fromPositions[c.op.elementId] = c.op.from;
          toPositions[c.op.elementId] = c.op.to;
        }
      }
      groupOps.push({
        kind: "move-group",
        groupId,
        elementIds,
        fromPositions,
        toPositions,
        dx: op.dx,
        dy: op.dy,
        transform: op.transform,
      });
    }
    if (op.kind === "resize" || op.kind === "arrow-resize") {
      groupOps.push({
        kind: "resize-group",
        groupId,
        elementIds,
        scaleX: op.scaleX,
        scaleY: op.scaleY,
        center: op.center,
        transform: op.transform,
      });
    }
    if (op.kind === "rotate" || op.kind === "arrow-rotate") {
      groupOps.push({
        kind: "rotate-group",
        groupId,
        elementIds,
        angle: op.angle,
        center: op.center,
        transform: op.transform,
      });
    }
  }

  return { groupOps, consumed };
};
