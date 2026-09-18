import { describe, expect, it } from "vitest";

import type { Mutable } from "@excalidraw/common/utility-types";

import {
  getAlignmentDragEdgeFactors,
  getAlignmentLockedAxes,
  getAlignmentMovers,
} from "../src/alignment";
import {
  ALIGNMENT_FEEL_ROWS,
  alignmentDragDriver,
  alignmentResizeDriver,
  solveAlignmentResponse,
} from "../src/alignmentSolve";

import type { AlignmentResponse } from "../src/alignmentSolve";
import type {
  AlignmentEdge,
  ElementsMap,
  ExcalidrawElement,
} from "../src/types";

type Axis = "x" | "y";

/**
 * The solver reads link topology and nothing else — no geometry enters the
 * response — so these elements carry only what it looks at.
 */
const rect = (
  id: string,
  overrides: Partial<ExcalidrawElement> = {},
): Mutable<ExcalidrawElement> =>
  ({
    id,
    type: "rectangle",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    angle: 0,
    groupIds: [],
    locked: false,
    isDeleted: false,
    ...overrides,
  } as Mutable<ExcalidrawElement>);

const sceneOf = (...elements: ExcalidrawElement[]): ElementsMap =>
  new Map(elements.map((element) => [element.id, element])) as ElementsMap;

/** Link two elements at one place on an axis, writing both sides as the
 * editor does. */
const linkPair = (
  a: Mutable<ExcalidrawElement>,
  b: Mutable<ExcalidrawElement>,
  axis: Axis,
  aEdge: AlignmentEdge,
  bEdge: AlignmentEdge,
) => {
  a.alignments = [
    ...(a.alignments ?? []),
    { elementId: b.id, axis, selfEdge: aEdge, otherEdge: bEdge },
  ];
  b.alignments = [
    ...(b.alignments ?? []),
    { elementId: a.id, axis, selfEdge: bEdge, otherEdge: aEdge },
  ];
};

/** Put the elements into one equal-gap chain, the identical record on every
 * member. */
const chainOf = (axis: Axis, ...elements: Mutable<ExcalidrawElement>[]) => {
  const ids = elements.map((element) => element.id);
  for (const element of elements) {
    element.gapAlignments = [...(element.gapAlignments ?? []), { axis, ids }];
  }
};

/** A drag response read back as one number per element — valid only where the
 * answer is a translation, which every assertion using it also checks. */
const dragFactors = (response: AlignmentResponse): Map<string, number> => {
  const factors = new Map<string, number>();
  for (const [id, perDof] of response.byElement) {
    expect(perDof[0].min).toBeCloseTo(perDof[0].max, 4);
    factors.set(id, perDof[0].min);
  }
  return factors;
};

const dragOn = (ids: string[], axis: Axis, elementsMap: ElementsMap) =>
  solveAlignmentResponse(alignmentDragDriver(ids), axis, elementsMap);

const expectDelta = (
  actual: { min: number; max: number } | undefined,
  expected: { min: number; max: number },
) => {
  expect(actual).toBeDefined();
  expect(actual!.min).toBeCloseTo(expected.min, 4);
  expect(actual!.max).toBeCloseTo(expected.max, 4);
};

const expectFactors = (
  response: AlignmentResponse,
  expected: Record<string, number>,
) => {
  expect(response.feasible).toBe(true);
  const factors = dragFactors(response);
  for (const [id, value] of Object.entries(expected)) {
    expect(factors.get(id), `factor for ${id}`).toBeCloseTo(value, 4);
  }
};

/**
 * That the drag path agrees with the solver it is now built on, and lets the
 * gesture through.
 *
 * During stage 1 this compared the solver against the propagator it replaces.
 * That propagator is gone as of stage 3, so what is left is the integration
 * point: `getAlignmentLockedAxes` and `getAlignmentDragEdgeFactors` are what
 * `dragElements.ts` and the snapping system actually call, and the hardcoded
 * factors in each test are the reference the old implementation used to be.
 */
const expectDragPathAgrees = (
  ids: string[],
  axis: Axis,
  elementsMap: ElementsMap,
) => {
  expect(getAlignmentLockedAxes(new Set(ids), elementsMap)[axis]).toBe(false);
  const viaDragPath = getAlignmentDragEdgeFactors(
    new Set(ids),
    axis,
    elementsMap,
  );
  const factors = dragFactors(dragOn(ids, axis, elementsMap));
  for (const [id, delta] of viaDragPath) {
    expect(factors.get(id), `factor for ${id}`).toBeCloseTo(delta.min, 4);
  }
};

const withoutFeelRows = (body: () => void) => {
  const saved = { ...ALIGNMENT_FEEL_ROWS };
  ALIGNMENT_FEEL_ROWS.endDragHoldsFarEnd = false;
  ALIGNMENT_FEEL_ROWS.interiorDragTravelsRigidly = false;
  try {
    body();
  } finally {
    Object.assign(ALIGNMENT_FEEL_ROWS, saved);
  }
};

describe("alignment solver — agreement with the propagator it replaces", () => {
  it("carries an edge link at the full offset", () => {
    const a = rect("a");
    const b = rect("b");
    linkPair(a, b, "x", "min", "min");
    const scene = sceneOf(a, b);

    expectFactors(dragOn(["a"], "x", scene), { a: 1, b: 1 });
    expectDragPathAgrees(["a"], "x", scene);
  });

  it("carries a chain of edge links transitively", () => {
    const a = rect("a");
    const b = rect("b");
    const c = rect("c");
    linkPair(a, b, "x", "max", "min");
    linkPair(b, c, "x", "max", "min");
    const scene = sceneOf(a, b, c);

    expectFactors(dragOn(["a"], "x", scene), { a: 1, b: 1, c: 1 });
    expectDragPathAgrees(["a"], "x", scene);
  });

  it("leaves the other axis alone", () => {
    const a = rect("a");
    const b = rect("b");
    linkPair(a, b, "x", "min", "min");
    const scene = sceneOf(a, b);

    expectFactors(dragOn(["a"], "y", scene), { a: 1 });
    expect(dragOn(["a"], "y", scene).byElement.has("b")).toBe(false);
  });

  it("holds the far end of a three-chain dragged by an end", () => {
    const [a, b, c] = ["a", "b", "c"].map((id) => rect(id));
    chainOf("x", a, b, c);
    const scene = sceneOf(a, b, c);

    expectFactors(dragOn(["a"], "x", scene), { a: 1, b: 0.5, c: 0 });
    expectDragPathAgrees(["a"], "x", scene);
  });

  it("holds the far end of a four-chain dragged by an end", () => {
    const [a, b, c, d] = ["a", "b", "c", "d"].map((id) => rect(id));
    chainOf("x", a, b, c, d);
    const scene = sceneOf(a, b, c, d);

    expectFactors(dragOn(["a"], "x", scene), {
      a: 1,
      b: 2 / 3,
      c: 1 / 3,
      d: 0,
    });
    expectDragPathAgrees(["a"], "x", scene);
  });

  it("travels a four-chain rigidly when dragged from the inside", () => {
    const [a, b, c, d] = ["a", "b", "c", "d"].map((id) => rect(id));
    chainOf("x", a, b, c, d);
    const scene = sceneOf(a, b, c, d);

    expectFactors(dragOn(["b"], "x", scene), { a: 1, b: 1, c: 1, d: 1 });
    expectDragPathAgrees(["b"], "x", scene);
  });

  it("reshapes a chain around an anchored member", () => {
    const [a, b, c] = ["a", "b", "c"].map((id) => rect(id));
    b.alignmentLocked = true;
    chainOf("x", a, b, c);
    const scene = sceneOf(a, b, c);

    // the anchor is a second known factor of zero, so the progression runs
    // through it and the far side travels backwards
    expectFactors(dragOn(["a"], "x", scene), { a: 1, b: 0, c: -1 });
    expectDragPathAgrees(["a"], "x", scene);
  });

  it("moves nothing that isn't linked", () => {
    const a = rect("a");
    const loner = rect("loner");
    const scene = sceneOf(a, loner);

    expect(dragOn(["a"], "x", scene).byElement.has("loner")).toBe(false);
  });
});

describe("alignment solver — the feel rules", () => {
  it("lets the far end drift backwards without them", () => {
    const [a, b, c] = ["a", "b", "c"].map((id) => rect(id));
    chainOf("x", a, b, c);
    const scene = sceneOf(a, b, c);

    withoutFeelRows(() => {
      expectFactors(dragOn(["a"], "x", scene), { a: 1, b: 0.4, c: -0.2 });
    });
  });

  it("lets a four-chain's far end drift backwards without them", () => {
    const [a, b, c, d] = ["a", "b", "c", "d"].map((id) => rect(id));
    chainOf("x", a, b, c, d);
    const scene = sceneOf(a, b, c, d);

    withoutFeelRows(() => {
      expectFactors(dragOn(["a"], "x", scene), {
        a: 1,
        b: 4 / 7,
        c: 1 / 7,
        d: -2 / 7,
      });
    });
  });

  it("fans a four-chain on an interior drag without them", () => {
    const [a, b, c, d] = ["a", "b", "c", "d"].map((id) => rect(id));
    chainOf("x", a, b, c, d);
    const scene = sceneOf(a, b, c, d);

    withoutFeelRows(() => {
      expectFactors(dragOn(["b"], "x", scene), {
        a: 4 / 3,
        b: 1,
        c: 2 / 3,
        d: 1 / 3,
      });
    });
  });

  it("agrees either way on a three-chain dragged from the inside", () => {
    const [a, b, c] = ["a", "b", "c"].map((id) => rect(id));
    chainOf("x", a, b, c);
    const scene = sceneOf(a, b, c);

    const expected = { a: 1, b: 1, c: 1 };
    expectFactors(dragOn(["b"], "x", scene), expected);
    withoutFeelRows(() => {
      expectFactors(dragOn(["b"], "x", scene), expected);
    });
  });

  it("declines a feel rule the hard rows leave no room for", () => {
    // The far end is anchored, which already decides the slope; the rule
    // asking for the same thing must not make the system inconsistent.
    const [a, b, c] = ["a", "b", "c"].map((id) => rect(id));
    c.alignmentLocked = true;
    chainOf("x", a, b, c);
    const scene = sceneOf(a, b, c);

    expectFactors(dragOn(["a"], "x", scene), { a: 1, b: 0.5, c: 0 });
  });
});

describe("alignment solver — gestures the propagator had to refuse", () => {
  it("shrinks a partner pinned between the drag and an anchor", () => {
    const a = rect("a");
    const c = rect("c");
    const anchor = rect("anchor", { alignmentLocked: true });
    linkPair(a, c, "x", "max", "min");
    linkPair(c, anchor, "x", "max", "max");
    const scene = sceneOf(a, c, anchor);

    // the drag path lets it through — the old propagator froze the axis here,
    // having no way to express a partner changing size
    expect(getAlignmentLockedAxes(new Set(["a"]), scene).x).toBe(false);

    const response = dragOn(["a"], "x", scene);
    expect(response.feasible).toBe(true);
    // c's left edge follows the drag, its right edge is held by the anchor
    expectDelta(response.byElement.get("c")?.[0], { min: 1, max: 0 });
    expectDelta(response.byElement.get("anchor")?.[0], { min: 0, max: 0 });
    expect(response.stretchers).toEqual(new Set(["c"]));
  });

  it("grows a chain member between two anchored ones", () => {
    const [a, b, c, d] = ["a", "b", "c", "d"].map((id) => rect(id));
    b.alignmentLocked = true;
    d.alignmentLocked = true;
    chainOf("x", a, b, c, d);
    const scene = sceneOf(a, b, c, d);

    expect(getAlignmentLockedAxes(new Set(["a"]), scene).x).toBe(false);

    const response = dragOn(["a"], "x", scene);
    expect(response.feasible).toBe(true);
    // both gaps either side of c close by one, so c takes up the slack
    expectDelta(response.byElement.get("c")?.[0], { min: -1, max: 1 });
    expect(response.stretchers).toEqual(new Set(["c"]));
  });

  it("still refuses a drag that nothing can absorb", () => {
    const a = rect("a");
    const anchor = rect("anchor", { alignmentLocked: true });
    linkPair(a, anchor, "x", "min", "min");
    const scene = sceneOf(a, anchor);

    const response = dragOn(["a"], "x", scene);
    expect(response.feasible).toBe(false);
    expect(response.blockers).toEqual(new Set(["anchor"]));
  });

  it("refuses when the partner that would absorb it cannot be stretched", () => {
    const a = rect("a");
    const c = rect("c", { angle: 0.4 as ExcalidrawElement["angle"] });
    const anchor = rect("anchor", { alignmentLocked: true });
    linkPair(a, c, "x", "max", "min");
    linkPair(c, anchor, "x", "max", "max");
    const scene = sceneOf(a, c, anchor);

    const response = dragOn(["a"], "x", scene);
    expect(response.feasible).toBe(false);
    expect(response.blockers).toEqual(new Set(["anchor"]));
  });

  it("names every anchor when no single release is enough", () => {
    const a = rect("a");
    const first = rect("first", { alignmentLocked: true });
    const second = rect("second", { alignmentLocked: true });
    linkPair(a, first, "x", "min", "min");
    linkPair(a, second, "x", "max", "max");
    const scene = sceneOf(a, first, second);

    const response = dragOn(["a"], "x", scene);
    expect(response.feasible).toBe(false);
    expect(response.blockers).toEqual(new Set(["first", "second"]));
  });
});

describe("alignment solver — which anchors the overlay names", () => {
  it("says nothing about an anchor that changes nothing", () => {
    // The far end of a chain is held at zero by the feel rule anyway, so
    // anchoring it is not why anything landed where it did.
    const [a, b, c] = ["a", "b", "c"].map((id) => rect(id));
    c.alignmentLocked = true;
    chainOf("x", a, b, c);
    const scene = sceneOf(a, b, c);

    const movers = getAlignmentMovers(new Set(["a"]), scene);
    expect(movers.pinAnchors.permitting).toEqual(new Set());
    expect(movers.pinAnchors.refusing).toEqual(new Set());
  });

  it("names an anchor that reshapes the chain around it", () => {
    // Anchoring the middle overrides the far-end rule: the chain now pivots
    // about b, which is not what the drag would otherwise have done.
    const [a, b, c] = ["a", "b", "c"].map((id) => rect(id));
    b.alignmentLocked = true;
    chainOf("x", a, b, c);
    const scene = sceneOf(a, b, c);

    const movers = getAlignmentMovers(new Set(["a"]), scene);
    expect(movers.pinAnchors.permitting).toEqual(new Set(["b"]));
    expect(movers.pinAnchors.refusing).toEqual(new Set());
  });

  it("names an anchor that forces a partner to change size", () => {
    const a = rect("a");
    const c = rect("c");
    const anchor = rect("anchor", { alignmentLocked: true });
    linkPair(a, c, "x", "max", "min");
    linkPair(c, anchor, "x", "max", "max");
    const scene = sceneOf(a, c, anchor);

    const movers = getAlignmentMovers(new Set(["a"]), scene);
    expect(movers.pinAnchors.permitting).toEqual(new Set(["anchor"]));
    expect(movers.pinAnchors.refusing).toEqual(new Set());
    // a stretched partner has a stale far edge, so it counts as moving
    expect(movers.x.has("c")).toBe(true);
  });

  it("names an anchor that refuses the drag", () => {
    const a = rect("a");
    const anchor = rect("anchor", { alignmentLocked: true });
    linkPair(a, anchor, "x", "min", "min");
    const scene = sceneOf(a, anchor);

    const movers = getAlignmentMovers(new Set(["a"]), scene);
    expect(movers.pinAnchors.refusing).toEqual(new Set(["anchor"]));
    expect(movers.pinAnchors.permitting).toEqual(new Set());
    expect(movers.x).toEqual(new Set());
  });
});

describe("alignment solver — resize gestures", () => {
  it("carries only the edge the handle moves", () => {
    const driver = rect("driver");
    const partner = rect("partner");
    linkPair(driver, partner, "x", "min", "min");
    const scene = sceneOf(driver, partner);

    const response = solveAlignmentResponse(
      alignmentResizeDriver(["driver"]),
      "x",
      scene,
    );
    expect(response.feasible).toBe(true);
    expect(response.dofCount).toBe(2);

    const [byMin, byMax] = response.byElement.get("partner")!;
    // the driver's left edge translates the partner; its right edge is linked
    // to nothing and so moves nothing
    expect(byMin.min).toBeCloseTo(1, 4);
    expect(byMin.max).toBeCloseTo(1, 4);
    expect(byMax.min).toBeCloseTo(0, 4);
    expect(byMax.max).toBeCloseTo(0, 4);
    expect(response.stretchers.size).toBe(0);
  });

  it("stretches a partner whose far edge an anchor holds", () => {
    const driver = rect("driver");
    const partner = rect("partner");
    const anchor = rect("anchor", { alignmentLocked: true });
    linkPair(driver, partner, "x", "max", "min");
    linkPair(partner, anchor, "x", "max", "max");
    const scene = sceneOf(driver, partner, anchor);

    const response = solveAlignmentResponse(
      alignmentResizeDriver(["driver"]),
      "x",
      scene,
    );
    expect(response.feasible).toBe(true);

    const [byMin, byMax] = response.byElement.get("partner")!;
    // widening the driver rightwards pushes the partner's left edge only
    expect(byMax.min).toBeCloseTo(1, 4);
    expect(byMax.max).toBeCloseTo(0, 4);
    expect(byMin.min).toBeCloseTo(0, 4);
    expect(byMin.max).toBeCloseTo(0, 4);
    expect(response.stretchers).toEqual(new Set(["partner"]));
  });
});
