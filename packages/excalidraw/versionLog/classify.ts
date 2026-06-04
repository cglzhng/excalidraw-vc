import type {
  ExcalidrawElement,
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

import type { LogEntry, LogOperation, LogPropertyMap } from "./types";

import type { TransformMatrix } from "./transform";

/**
 * Properties Excalidraw uses for change tracking that are noise for
 * semantic classification. Ignore them throughout.
 */
const TRACKING_PROPS = new Set(["version", "versionNonce"]);

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
  const ops: LogOperation[] = [];

  for (const entry of entries) {
    ops.push(classifyEntry(entry, changedElements));
  }

  const { groupOps, consumed } = detectGroups(
    ops,
    changedElements,
    groupSizeCache,
  );

  return groupOps.concat(ops.filter((o) => !consumed.has(o)));
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
        center: transform ? fixedPoint(transform) : null,
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
        center: transform ? fixedPoint(transform) : null,
        transform,
      };
    }

    // Move: only x and/or y changed.
    if (hasPosChange && !hasAngleChange && !hasSizeChange) {
      // If the matrix is unavailable (e.g. degenerate before-box) we
      // can still read deltas straight from the entry.
      let dx: number;
      let dy: number;
      if (transform && isPureTranslation(transform)) {
        [dx, dy] = getMatrixTranslation(transform);
      } else {
        dx = changed.has("x") ? numericDiff(entry.before, entry.after, "x") : 0;
        dy = changed.has("y") ? numericDiff(entry.before, entry.after, "y") : 0;
      }
      return {
        kind: "move",
        elementId: entry.elementId,
        elementType: current?.type,
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
    if (op.kind === "move" || op.kind === "resize" || op.kind === "rotate") {
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
      groupOps.push({
        kind: "move-group",
        groupId,
        elementIds,
        dx: op.dx,
        dy: op.dy,
        transform: op.transform,
      });
    }
    if (op.kind === "resize") {
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
    if (op.kind === "rotate") {
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
