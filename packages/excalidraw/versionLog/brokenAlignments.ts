/**
 * The hard alignments a replayed scene no longer satisfies.
 *
 * Replay reproduces followers from what was recorded rather than running
 * the solver, so a link can stop holding: a stand-in's own later drag was
 * recorded while it had no partners to carry, and a skipped Moment can take
 * away a move that one side of a link depended on. Nothing repairs that
 * here — releasing or re-solving a link would change data the user hasn't
 * looked at — so a conflict-resolution session just shows them.
 */

import { getElementBounds } from "@excalidraw/element";

import type {
  AlignmentEdge,
  ElementsMap,
} from "@excalidraw/element/types";

import { ALIGNMENT_HOLD_TOLERANCE, coordOf } from "./placement";

import type { SceneSnapshot } from "./applyOps";

export type BrokenAlignment =
  | {
      readonly kind: "edge";
      readonly axis: "x" | "y";
      readonly a: string;
      readonly aEdge: AlignmentEdge;
      readonly b: string;
      readonly bEdge: AlignmentEdge;
    }
  | {
      readonly kind: "gap";
      readonly axis: "x" | "y";
      readonly ids: readonly string[];
    };

/**
 * Every hard edge link whose two edges have come apart, and every gap chain
 * whose gaps are no longer equal. A link naming an element that isn't live
 * is passed over: it has no geometry to disagree with.
 */
export const findBrokenAlignments = (
  snapshot: SceneSnapshot,
): BrokenAlignment[] => {
  const elementsMap = snapshot as unknown as ElementsMap;
  const rangeOf = (id: string, axis: "x" | "y") => {
    const el = snapshot.get(id);
    if (!el || el.isDeleted) {
      return null;
    }
    const [minX, minY, maxX, maxY] = getElementBounds(el, elementsMap);
    return (axis === "x" ? [minX, maxX] : [minY, maxY]) as [number, number];
  };

  const broken: BrokenAlignment[] = [];
  const seen = new Set<string>();
  for (const el of snapshot.values()) {
    if (el.isDeleted) {
      continue;
    }
    for (const link of el.alignments ?? []) {
      // stored on both partners, so each is reached twice
      const key = [`${el.id}:${link.selfEdge}`, `${link.elementId}:${link.otherEdge}`]
        .sort()
        .concat(link.axis)
        .join("|");
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const own = rangeOf(el.id, link.axis);
      const partner = rangeOf(link.elementId, link.axis);
      if (
        own &&
        partner &&
        Math.abs(coordOf(own, link.selfEdge) - coordOf(partner, link.otherEdge)) >
          ALIGNMENT_HOLD_TOLERANCE
      ) {
        broken.push({
          kind: "edge",
          axis: link.axis,
          a: el.id,
          aEdge: link.selfEdge,
          b: link.elementId,
          bEdge: link.otherEdge,
        });
      }
    }

    for (const chain of el.gapAlignments ?? []) {
      // the identical record is stored on every member
      const key = `gap:${chain.axis}:${chain.ids.join(",")}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const ranges = chain.ids.map((id) => rangeOf(id, chain.axis));
      if (ranges.some((range) => range == null)) {
        continue;
      }
      const spans = ranges as [number, number][];
      const gaps = spans.slice(1).map((span, i) => span[0] - spans[i][1]);
      if (Math.max(...gaps) - Math.min(...gaps) > ALIGNMENT_HOLD_TOLERANCE) {
        broken.push({ kind: "gap", axis: chain.axis, ids: chain.ids });
      }
    }
  }
  return broken;
};
