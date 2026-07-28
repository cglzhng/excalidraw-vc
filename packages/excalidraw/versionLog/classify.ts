import type {
  ElementAlignment,
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

import { buildGroupNodeFromEntries, getParentGroupId } from "./groupTree";

import type {
  ArrowBinding,
  LogEntry,
  LogOperation,
  LogPropertyMap,
} from "./types";

import type { TransformMatrix } from "./transform";

/**
 * Properties that are noise for our own semantic classification.
 * We ignore them throughout.
 *
 * `boundElements` is included here because upstream's emit of this
 * field is unreliable. Instead, we use the `endBinding / startBinding` fields
 * from the arrow element itself to determine if it was changed.
 */
const TRACKING_PROPS = new Set([
  "version",
  "versionNonce",
  "index",
  "boundElements",
]);

/**
 * Properties that result in a `restyle` operation when changed.
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
// Assumption: A single iteration represents a SINGLE operation by the user
// But multiple elements can be operated on at once in these cases:
//
//    Mutiselect: Multiple elements selected, same operation applied to all
//    Dependencies: Operation applied to element(s) caused other element(s) to change
//        e.g. Arrow bindings moved, hard alignments
//
// entries: All the LogEntrys from the App
// changedElements: Contains references to every ExcalidrawElement that was changed
// groupSizeCache: A map that contains the size of each group in the scene
// selectedElementIds: The IDs of the elements that the user directly manipulated
export const classifyEntries = (
  entries: readonly LogEntry[],
  changedElements: Record<string, OrderedExcalidrawElement>,
  groupSizeCache: Map<string, number>,
  selectedElementIds: ReadonlySet<string> = new Set(),
): LogOperation[] => {
  // Pre-pass A: identify entries whose geometric change is purely a
  // consequence of something else being transformed in the same moment
  // — a bound arrow following its bindable (arrow consequences), or a
  // hard-aligned element following its aligned partner (alignment
  // consequences). Both are absorbed into the causing op's
  // `consequentOps` rather than surfaced separately — one user action,
  // one op.
  const arrowConsequences = findConsequentArrowChanges(
    entries,
    changedElements,
  );
  const arrowConsumed = new Set(
    Array.from(arrowConsequences.values()).flat(),
  );

  const alignmentConsequences = findConsequentAlignmentChanges(
    entries,
    changedElements,
    arrowConsumed,
    selectedElementIds,
  );

  // An alignment follower can itself be the cause of an arrow change:
  // the user drags A, hard-aligned B follows, and an arrow bound to B
  // follows B. The arrow consequence is keyed on B, but B is no longer a
  // top-level op — it was just absorbed into A. Walk each arrow's cause
  // up to the root driver so the arrow lands alongside B as a consequent
  // of A, instead of being dropped by `attachConsequences` (which only
  // matches top-level ops). Chains are resolved transitively; the `seen`
  // guard keeps a cycle from looping forever.
  const driverOfFollower = new Map<string, string>();
  for (const [driverId, followers] of alignmentConsequences) {
    for (const follower of followers) {
      driverOfFollower.set(follower.elementId, driverId);
    }
  }
  const resolveDriver = (elementId: string): string => {
    const seen = new Set<string>([elementId]);
    let current = elementId;
    for (;;) {
      const next = driverOfFollower.get(current);
      if (next === undefined || seen.has(next)) {
        return current;
      }
      seen.add(next);
      current = next;
    }
  };

  const consequentialEntries = new Set<LogEntry>([
    ...arrowConsumed,
    ...Array.from(alignmentConsequences.values()).flat(),
  ]);
  const remainingEntries = entries.filter((e) => !consequentialEntries.has(e));

  // Pre-pass B: detect alignment lock / unlock — multi-entry
  // `alignments` changes, one op per gesture.
  const { alignmentOps, consumed: alignmentConsumed } =
    detectAlignmentChange(remainingEntries);

  // Pre-pass C: detect group / ungroup events. These are inherently
  // multi-entry (the same gid is added to / removed from N members
  // in one user action), so they don't fit the per-entry classifier.
  const { groupingOps, consumed: groupingConsumed } =
    detectGroupChange(remainingEntries);

  // Per-entry classification for everything the pre-passes didn't claim.
  const ops: LogOperation[] = [];
  for (const entry of remainingEntries) {
    if (groupingConsumed.has(entry) || alignmentConsumed.has(entry)) {
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

  const finalOps: LogOperation[] = [
    ...groupingOps,
    ...alignmentOps,
    ...groupOps,
    ...ops.filter((o) => !geometricConsumed.has(o)),
  ];

  // Merge alignment + arrow consequences (both keyed by driver element
  // id) and attach them to the ops they originated from. Alignment
  // followers go in first so the consequents read in causal order: the
  // aligned partner moved because the driver did, and the bound arrow
  // moved because the partner did.
  const consequences = new Map<string, LogEntry[]>();
  for (const [id, list] of alignmentConsequences) {
    const existing = consequences.get(id) ?? [];
    existing.push(...list);
    consequences.set(id, existing);
  }
  for (const [id, list] of arrowConsequences) {
    // re-key onto the root driver if this arrow's cause was itself
    // absorbed as an alignment follower
    const target = resolveDriver(id);
    const existing = consequences.get(target) ?? [];
    existing.push(...list);
    consequences.set(target, existing);
  }
  attachConsequences(finalOps, consequences, changedElements);

  // [version-log] debug: dump the classified operations so the shape of
  // each classification can be inspected alongside the raw delta log.
  // Safe to remove once the classifier is stable.
  // eslint-disable-next-line no-console
  console.groupCollapsed(`[version-log] classified ${finalOps.length} op(s)`);
  // eslint-disable-next-line no-console
  console.log(
    finalOps.map((op) => op.kind).join(", ") || "(none)",
  );
  for (const op of finalOps) {
    // eslint-disable-next-line no-console
    console.log(op.kind, op);
  }
  // eslint-disable-next-line no-console
  console.log("full operations:", JSON.stringify(finalOps));
  // eslint-disable-next-line no-console
  console.groupEnd();

  return finalOps;
};

/**
 * Geometry properties of an element that affect its world transform.
 */
type GeometryKey = "x" | "y" | "width" | "height" | "angle";
/**
 * !NOTE: THIE FUNCTION IS ENTIRELY VIBE-CODED. USE WITH CAUTION!
 * !REVISIT WITH A TEXTBOOK!
 *
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

// Turn ONE LogEntry into ONE corresponding LogOperation
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

  // Dispatch to   // arrow-specific detection first.
  // If nothing matches, fall through
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

  if (hasGeometryChange) {
    // Permitted residue: `alignments`. An Alt+drag commits the move and
    // the hard-alignment links it creates in a single increment, so the
    // moved element's entry carries both. `detectAlignmentChange` has
    // already surfaced the link half as its own `alignment` op (and
    // deliberately left this entry unconsumed), so drop the key rather
    // than falling through to `raw`. Gated on there being a geometry
    // change so that an `alignments` + non-geometry entry — which the
    // detector skips entirely — still reaches `raw` with nothing lost.
    changed.delete("alignments");
  }

  if (hasGeometryChange && current && changed.size === 0) {
    const transform = buildEntryGeometryMatrix(entry, current);

    // Without an invertible transform, the
    // geometric op types can't be populated; fall through to raw.
    if (transform == null) {
      return { kind: "raw", entry };
    }

    // Resize: width and/or height changed; angle unchanged. 
    // x and y also change when the user drags from somewhere 
    // other than the top-left corner 
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

      // Derive the scale directly from the dimension change.
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
        angle: to - from,
        center: fixedPoint(transform),
        transform,
      };
    }

    // Move: ONLY x and/or y changed.
    if (hasPosChange && !hasAngleChange && !hasSizeChange) {
      let dx: number;
      let dy: number;
      if (isPureTranslation(transform)) {
        [dx, dy] = getMatrixTranslation(transform);
      } else {
        dx = changed.has("x") ? numericDiff(entry.before, entry.after, "x") : 0;
        dy = changed.has("y") ? numericDiff(entry.before, entry.after, "y") : 0;
      }
      // Absolute before/after positions. If the entry doesn't contain x or y,
      // fall back to current because the before and after will be equal
      const fromX =
        "x" in entry.before
          ? (entry.before.x as number)
          : (current?.x as number);
      const fromY =
        "y" in entry.before
          ? (entry.before.y as number)
          : (current?.y as number);
      const toX =
        "x" in entry.after ? (entry.after.x as number) : (current?.x as number);
      const toY =
        "y" in entry.after ? (entry.after.y as number) : (current?.y as number);
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

  // Toggling the anchor padlock writes `alignmentLocked` on its own, so
  // a single-key check is enough — no multi-entry pre-pass needed.
  if (changed.has("alignmentLocked")) {
    return {
      kind: "alignment-anchor",
      elementId: entry.elementId,
      elementType: current?.type,
      anchored: !!entry.after.alignmentLocked,
    };
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
 * Order-insensitive structural equality for `alignments` link arrays.
 * Each link is a flat record of primitives, so comparing a stable key
 * per link is a full deep-equal. `undefined` is treated as `[]`.
 */
const alignmentsEqual = (
  a: readonly ElementAlignment[] | undefined,
  b: readonly ElementAlignment[] | undefined,
): boolean => {
  const aa = a ?? [];
  const bb = b ?? [];
  if (aa.length !== bb.length) {
    return false;
  }
  const key = (l: ElementAlignment) =>
    `${l.elementId}:${l.axis}:${l.selfEdge}:${l.otherEdge}`;
  const keysA = new Set(aa.map(key));
  return bb.every((l) => keysA.has(key(l)));
};

/**
 * Return the set of changed property keys on an entry, excluding noise
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
  // The store diffs `alignments` by array/element reference, so it can
  // report the field as changed when the links are structurally
  // identical (a rebuilt-but-equal array). A phantom `alignments` key
  // would both emit spurious lock/unlock ops and break the clean-residue
  // checks that classify moves/resizes — so drop it when deep-equal.
  if (
    keys.has("alignments") &&
    alignmentsEqual(
      entry.before.alignments as readonly ElementAlignment[] | undefined,
      entry.after.alignments as readonly ElementAlignment[] | undefined,
    )
  ) {
    keys.delete("alignments");
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
 * Scan the raw entries for arrow updates whose changes are purely
 * geometric AND whose binding points to a bindable element that also
 * received a geometry change in this moment. Return a
 * `causeElementId → arrowEntries[]` map.
 *
 * "Purely geometric" here means the arrow entry's changed keys are a
 * subset of `{points, x, y, width, height}`. If `angle` or a binding
 * changed too, the user did something to the arrow directly and we
 * shouldn't absorb it.
 */

const findConsequentArrowChanges = (
  entries: readonly LogEntry[],
  changedElements: Record<string, OrderedExcalidrawElement>,
): Map<string, LogEntry[]> => {
  const geometricallyChanged = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "update") {
      continue;
    }
    const changed = getChangedKeys(entry);
    if (
      changed.has("x") ||
      changed.has("y") ||
      changed.has("width") ||
      changed.has("height") ||
      changed.has("angle")
    ) {
      geometricallyChanged.add(entry.elementId);
    }
  }

  const out = new Map<string, LogEntry[]>();
  for (const entry of entries) {
    if (entry.type !== "update") {
      continue;
    }
    const current = changedElements[entry.elementId];
    if (current?.type !== "arrow") {
      continue;
    }
    const changed = getChangedKeys(entry);

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

    changed.delete("points");
    changed.delete("x");
    changed.delete("y");
    changed.delete("width");
    changed.delete("height");

    if (hasStartChange || hasEndChange || changed.size !== 0) {
      continue;
    }

    const arrow = current as {
      startBinding?: { elementId: string } | null;
      endBinding?: { elementId: string } | null;
    };

    if (
      arrow.startBinding?.elementId &&
      geometricallyChanged.has(arrow.startBinding.elementId)
    ) {
      const list = out.get(arrow.startBinding.elementId) ?? [];
      list.push(entry);
      out.set(arrow.startBinding.elementId, list);
    }

    if (
      arrow.endBinding?.elementId &&
      geometricallyChanged.has(arrow.endBinding.elementId)
    ) {
      const list = out.get(arrow.endBinding.elementId) ?? [];
      list.push(entry);
      out.set(arrow.endBinding.elementId, list);
    }
  }

  return out;
};

// ------------------- Alignment lock / unlock detector ----------------

/** Keys the per-entry classifier interprets as a geometric transform. */
const GEOMETRY_KEYS = ["x", "y", "width", "height", "angle"] as const;

/**
 * Detect hard-alignment lock / unlock as a single op. Locking or
 * unlocking writes the `alignments` field on several elements at once,
 * so — like grouping — it's multi-entry and doesn't fit the per-entry
 * classifier.
 *
 * Two shapes of entry contribute to the op:
 *
 *   - `alignments` alone — the whole entry is about the link, so it is
 *     **consumed** here.
 *   - `alignments` plus geometry — the Alt+drag gesture commits the move
 *     and the new links in one increment. The link half is recorded into
 *     the op, but the entry is deliberately **not consumed**, so it flows
 *     on to `classifyEntry` and also surfaces as its own move / resize.
 *     (`classifyEntry` correspondingly permits `alignments` as residue.)
 *
 * Anything mixing `alignments` with non-geometry properties is left
 * entirely alone, so its alignment change is never silently dropped —
 * such an entry falls through to `raw`, which preserves it verbatim.
 */
const detectAlignmentChange = (
  entries: readonly LogEntry[],
): { alignmentOps: LogOperation[]; consumed: Set<LogEntry> } => {
  const consumed = new Set<LogEntry>();
  const before: Record<string, readonly ElementAlignment[]> = {};
  const after: Record<string, readonly ElementAlignment[]> = {};
  const elementIds: string[] = [];
  let added = 0;
  let removed = 0;

  for (const entry of entries) {
    if (entry.type !== "update") {
      continue;
    }
    const changed = getChangedKeys(entry);
    if (!changed.has("alignments")) {
      continue;
    }
    changed.delete("alignments");
    const hasGeometryResidue = GEOMETRY_KEYS.some((key) => changed.has(key));
    for (const key of GEOMETRY_KEYS) {
      changed.delete(key);
    }
    if (changed.size > 0) {
      // alignments changed alongside something other than geometry —
      // leave the entry whole for per-entry classification.
      continue;
    }

    const b =
      (entry.before.alignments as readonly ElementAlignment[] | undefined) ?? [];
    const a =
      (entry.after.alignments as readonly ElementAlignment[] | undefined) ?? [];
    before[entry.elementId] = b;
    after[entry.elementId] = a;
    elementIds.push(entry.elementId);
    if (a.length > b.length) {
      added += 1;
    } else if (a.length < b.length) {
      removed += 1;
    }
    if (!hasGeometryResidue) {
      consumed.add(entry);
    }
  }

  if (elementIds.length === 0) {
    return { alignmentOps: [], consumed };
  }

  return {
    alignmentOps: [
      {
        kind: "alignment",
        action: removed > added ? "unlock" : "lock",
        elementIds,
        before,
        after,
      },
    ],
    consumed,
  };
};

// ------------------- Alignment consequence detector ------------------

/**
 * Scan for elements whose pure translation in this moment was caused by
 * a hard-aligned partner being moved or resized — the alignment analog
 * of `findConsequentArrowChanges`. Returns a `driverElementId →
 * followerEntries[]` map so the followers get absorbed as
 * `consequentOps` of the driver rather than surfaced as their own moves.
 *
 * Driver identification, in priority order:
 *   - `selectedIds` is authoritative: a selected element was directly
 *     manipulated (the driver); a non-selected element in the same
 *     aligned component that only translated followed it.
 *   - with no selection overlap (e.g. a programmatic change), fall back
 *     to geometry: an aligned partner that *resized / rotated* is the
 *     driver of the translators aligned to it; failing that, a cluster
 *     of mutually-aligned pure-movers is a drag whose most-displaced
 *     element is the driver.
 *
 * `excluded` are entries already claimed (arrow consequences). A
 * follower that is itself the cause of an arrow change is still absorbed
 * here — the caller re-keys that arrow onto this driver, so the whole
 * chain (drag → aligned partner → the partner's bound arrow) collapses
 * into one top-level op with two consequents. See `classifyEntries`.
 */
const findConsequentAlignmentChanges = (
  entries: readonly LogEntry[],
  changedElements: Record<string, OrderedExcalidrawElement>,
  excluded: Set<LogEntry>,
  selectedIds: ReadonlySet<string>,
): Map<string, LogEntry[]> => {
  const entryById = new Map<string, LogEntry>();
  const transformers = new Set<string>(); // resize / rotate → definite driver
  const translators = new Set<string>(); // pure x/y → follower or move-driver

  for (const e of entries) {
    if (e.type !== "update" || excluded.has(e)) {
      continue;
    }
    const changed = getChangedKeys(e);
    const hasSize = changed.has("width") || changed.has("height");
    const hasAngle = changed.has("angle");
    const hasPos = changed.has("x") || changed.has("y");
    changed.delete("x");
    changed.delete("y");
    changed.delete("width");
    changed.delete("height");
    changed.delete("angle");
    // Permitted residue, as in `classifyEntry`: an Alt+drag writes the
    // newly-created links onto the very element it moved, and that
    // element is precisely the driver this pass is looking for. Without
    // this the driver would be rejected as "not purely geometric" and
    // its partners would surface as their own moves.
    changed.delete("alignments");
    if (changed.size > 0) {
      // Not a purely geometric change — not an alignment participant.
      continue;
    }
    if (hasSize || hasAngle) {
      transformers.add(e.elementId);
      entryById.set(e.elementId, e);
    } else if (hasPos) {
      translators.add(e.elementId);
      entryById.set(e.elementId, e);
    }
  }

  const inPlay = new Set<string>([...transformers, ...translators]);
  if (inPlay.size < 2) {
    return new Map();
  }

  // Undirected alignment adjacency, restricted to elements that changed
  // geometrically this moment.
  const adjacency = new Map<string, Set<string>>();
  const addEdge = (a: string, b: string) => {
    let set = adjacency.get(a);
    if (!set) {
      set = new Set();
      adjacency.set(a, set);
    }
    set.add(b);
  };
  for (const id of inPlay) {
    const links = changedElements[id]?.alignments;
    if (!links) {
      continue;
    }
    for (const link of links) {
      if (inPlay.has(link.elementId)) {
        addEdge(id, link.elementId);
        addEdge(link.elementId, id);
      }
    }
  }

  const consequences = new Map<string, LogEntry[]>();
  const seen = new Set<string>();
  for (const start of inPlay) {
    if (seen.has(start)) {
      continue;
    }
    // Flood the connected component.
    const component: string[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length > 0) {
      const id = stack.pop()!;
      component.push(id);
      for (const neighbor of adjacency.get(id) ?? []) {
        if (!seen.has(neighbor)) {
          seen.add(neighbor);
          stack.push(neighbor);
        }
      }
    }
    if (component.length < 2) {
      // Nothing aligned to this element also moved — a real user move.
      continue;
    }

    const compSelected = component.filter((id) => selectedIds.has(id));
    const compTransformers = component.filter((id) => transformers.has(id));
    const compTranslators = component.filter((id) => translators.has(id));

    let driverId: string | undefined;
    let followers: string[];
    if (compSelected.length > 0) {
      // Selection is authoritative: the selected element(s) were
      // directly manipulated; any non-selected element that only
      // translated followed via alignment. (When the user selects and
      // drags several aligned elements together, they're all selected,
      // so none is absorbed — each stays a top-level op.)
      driverId = [...compSelected].sort()[0];
      followers = component.filter(
        (id) => !selectedIds.has(id) && translators.has(id),
      );
    } else if (compTransformers.length > 0) {
      // Fallback (no selection overlap): resize / rotate gesture.
      driverId = [...compTransformers].sort()[0];
      followers = compTranslators;
    } else {
      // Fallback: pure-move cluster; most-displaced element is the driver.
      driverId = pickMoveDriver(compTranslators, entryById);
      followers = compTranslators.filter((id) => id !== driverId);
    }
    if (!driverId) {
      continue;
    }

    for (const followerId of followers) {
      const entry = entryById.get(followerId);
      if (!entry) {
        continue;
      }
      const list = consequences.get(driverId) ?? [];
      list.push(entry);
      consequences.set(driverId, list);
    }
  }

  return consequences;
};

/**
 * Pick the driver of a pure-move alignment cluster: the element that
 * moved the farthest (its displacement isn't limited to a single
 * coupled axis), breaking ties by smallest id for determinism.
 */
const pickMoveDriver = (
  ids: readonly string[],
  entryById: Map<string, LogEntry>,
): string | undefined => {
  let best: string | undefined;
  let bestScore = -1;
  for (const id of ids) {
    const entry = entryById.get(id);
    if (!entry) {
      continue;
    }
    const dx =
      Number(entry.after.x ?? entry.before.x ?? 0) -
      Number(entry.before.x ?? entry.after.x ?? 0);
    const dy =
      Number(entry.after.y ?? entry.before.y ?? 0) -
      Number(entry.before.y ?? entry.after.y ?? 0);
    const score = dx * dx + dy * dy;
    if (score > bestScore || (score === bestScore && (best === undefined || id < best))) {
      bestScore = score;
      best = id;
    }
  }
  return best;
};

/**
 * Attach the collected consequence entries to the ops they originated
 * from. Single-element ops (move/resize/rotate) key by their
 * `elementId`; group ops (move-group/resize-group/rotate-group) absorb
 * consequences of any of their members.
 *
 * Post-process: the raw consequence entries are run back through
 * `classifyEntry` so each becomes its own semantic op (typically
 * `arrow-edit-points` / `move`). Those nested ops replay through the
 * same engine as any other op — see `applyConsequentOps` in
 * `applyOps.ts`.
 */
const attachConsequences = (
  ops: LogOperation[],
  consequences: Map<string, LogEntry[]>,
  changedElements: Record<string, OrderedExcalidrawElement>,
): void => {
  if (consequences.size === 0) {
    return;
  }
  const toOps = (entries: LogEntry[]): LogOperation[] =>
    entries.map((e) => classifyEntry(e, changedElements));

  for (const op of ops) {
    switch (op.kind) {
      case "move":
      case "resize":
      case "rotate": {
        const c = consequences.get(op.elementId);
        if (c) {
          op.consequentOps = toOps(c);
        }
        break;
      }
      case "move-group":
      case "resize-group":
      case "rotate-group": {
        const agg: LogEntry[] = [];
        for (const id of op.elementIds) {
          const c = consequences.get(id);
          if (c) {
            agg.push(...c);
          }
        }
        if (agg.length > 0) {
          op.consequentOps = toOps(agg);
        }
        break;
      }
      default:
        break;
    }
  }
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
  const hasPosChange = changed.has("x") || changed.has("y");

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
    const beforeOrigin = hasPosChange
      ? ([entry.before.x, entry.before.y] as [number, number])
      : null;
    const afterOrigin = hasPosChange
      ? ([entry.after.x, entry.after.y] as [number, number])
      : null;
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
        beforeOrigin,
        afterOrigin,
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
 * gained / lost the SAME group id in this moment.
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
