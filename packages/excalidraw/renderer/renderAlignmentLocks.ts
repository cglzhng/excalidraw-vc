import { THEME } from "@excalidraw/common";
import { getElementBounds } from "@excalidraw/element";

import type { Bounds } from "@excalidraw/common";
import type {
  NonDeletedExcalidrawElement,
  NonDeletedSceneElementsMap,
} from "@excalidraw/element/types";

import type { InteractiveCanvasAppState } from "../types";

/**
 * Draws the hard-alignment ("alignment lock") indicator: for every
 * selected element that has alignment links, a dashed line runs along
 * the shared edge, spanning from one partner to the other, so the user
 * can see which elements are locked together and on which edge.
 *
 * Distinct from snap lines (solid red, transient): the lock line is
 * dashed and violet, and persists as long as a linked element is
 * selected. Partners need not be selected — the line still reaches them.
 */

const LOCK_COLOR_LIGHT = "#fa5252";
const LOCK_COLOR_DARK = "#ffa8a8";

const edgeCoord = (
  bounds: Bounds,
  axis: "x" | "y",
  edge: "min" | "center" | "max",
): number => {
  const min = axis === "x" ? bounds[0] : bounds[1];
  const max = axis === "x" ? bounds[2] : bounds[3];
  return edge === "min" ? min : edge === "max" ? max : (min + max) / 2;
};

export const renderAlignmentLocks = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  elementsMap: NonDeletedSceneElementsMap,
  selectedElements: readonly NonDeletedExcalidrawElement[],
) => {
  const linked = selectedElements.filter((el) => el.alignments?.length);
  if (linked.length === 0) {
    return;
  }

  const zoom = appState.zoom.value;

  context.save();
  context.translate(appState.scrollX, appState.scrollY);
  context.strokeStyle =
    appState.theme === THEME.LIGHT ? LOCK_COLOR_LIGHT : LOCK_COLOR_DARK;
  context.lineWidth = 1 / zoom;

  // A link is symmetric, so when both partners are selected we'd draw
  // the same line twice; dedupe on the unordered pair + axis + edge.
  const drawn = new Set<string>();

  for (const el of linked) {
    const links = el.alignments;
    if (!links) {
      continue;
    }
    const boundsA = getElementBounds(el, elementsMap);

    for (const link of links) {
      const partner = elementsMap.get(link.elementId);
      if (!partner) {
        continue;
      }

      // Canonicalize the unordered pair of (element, edge) ends so the
      // link and its reciprocal (edges swapped) collapse to one line.
      const ends = [
        `${el.id}:${link.selfEdge}`,
        `${link.elementId}:${link.otherEdge}`,
      ].sort();
      const key = `${link.axis}:${ends[0]}:${ends[1]}`;
      if (drawn.has(key)) {
        continue;
      }
      drawn.add(key);

      const boundsB = getElementBounds(partner, elementsMap);

      // selfEdge and otherEdge coordinates are equal by construction, so
      // a single line on this element's edge sits on the shared coord.
      context.beginPath();
      if (link.axis === "x") {
        const x = edgeCoord(boundsA, "x", link.selfEdge);
        context.moveTo(x, Math.min(boundsA[1], boundsB[1]));
        context.lineTo(x, Math.max(boundsA[3], boundsB[3]));
      } else {
        const y = edgeCoord(boundsA, "y", link.selfEdge);
        context.moveTo(Math.min(boundsA[0], boundsB[0]), y);
        context.lineTo(Math.max(boundsA[2], boundsB[2]), y);
      }
      context.stroke();
    }
  }

  context.restore();
};
