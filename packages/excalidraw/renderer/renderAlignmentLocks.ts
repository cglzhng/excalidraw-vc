import { THEME } from "@excalidraw/common";
import {
  getAlignmentGuides,
  getAlignmentMovers,
  getElementAbsoluteCoords,
  getElementBounds,
} from "@excalidraw/element";
import { pointFrom, pointRotateRads } from "@excalidraw/math";

import type { Bounds } from "@excalidraw/common";
import type { AlignmentGuide } from "@excalidraw/element";
import type { GlobalPoint } from "@excalidraw/math";
import type {
  NonDeletedExcalidrawElement,
  NonDeletedSceneElementsMap,
} from "@excalidraw/element/types";

import type { InteractiveCanvasAppState } from "../types";

/**
 * Alignment guides for the current selection. Two kinds share one line
 * style vocabulary:
 *
 *   - hard (persisted `alignments`): solid line, closed padlock;
 *   - soft (live edge coincidence, never stored): dashed line, open
 *     padlock.
 *
 * Clicking a line's padlock toggles between the two (`lockAlignmentPair`
 * / `unlockAlignmentPair`), so this is both the indicator and the only
 * creation UI. The geometry is shared with the pointer handler via
 * `getAlignmentGuideLines`, which hit-tests the same padlock positions.
 */

const GUIDE_COLOR_LIGHT = "#fa5252";
const GUIDE_COLOR_DARK = "#ffa8a8";

/** Padlock badge radius, in screen px (divided by zoom at draw time). */
export const ALIGNMENT_ICON_RADIUS = 9;

/** Open padlocks are drawn faded to read as the weaker of the two states. */
const UNLOCKED_ICON_OPACITY = 0.45;

const edgeCoord = (
  bounds: Bounds,
  axis: "x" | "y",
  edge: "min" | "center" | "max",
): number => {
  const min = axis === "x" ? bounds[0] : bounds[1];
  const max = axis === "x" ? bounds[2] : bounds[3];
  return edge === "min" ? min : edge === "max" ? max : (min + max) / 2;
};

export type AlignmentGuideLine = {
  guide: AlignmentGuide;
  /** line endpoints, scene coords */
  from: [number, number];
  to: [number, number];
  /** padlock badge centre, scene coords */
  icon: [number, number];
};

/**
 * The lines to draw for the current selection, with each line's padlock
 * position. Shared by the renderer and the pointer handler so a click
 * hit-tests exactly what is drawn.
 */
export const getAlignmentGuideLines = (
  selectedElements: readonly NonDeletedExcalidrawElement[],
  elementsMap: NonDeletedSceneElementsMap,
): AlignmentGuideLine[] => {
  const lines: AlignmentGuideLine[] = [];
  for (const guide of getAlignmentGuides(selectedElements, elementsMap)) {
    const self = elementsMap.get(guide.selfId);
    const partner = elementsMap.get(guide.elementId);
    if (!self || !partner) {
      continue;
    }
    const boundsA = getElementBounds(self, elementsMap);
    const boundsB = getElementBounds(partner, elementsMap);

    let from: [number, number];
    let to: [number, number];
    // selfEdge and otherEdge coordinates are equal by construction, so a
    // single line on this element's edge sits on the shared coord.
    if (guide.axis === "x") {
      const x = edgeCoord(boundsA, "x", guide.selfEdge);
      from = [x, Math.min(boundsA[1], boundsB[1])];
      to = [x, Math.max(boundsA[3], boundsB[3])];
    } else {
      const y = edgeCoord(boundsA, "y", guide.selfEdge);
      from = [Math.min(boundsA[0], boundsB[0]), y];
      to = [Math.max(boundsA[2], boundsB[2]), y];
    }
    lines.push({
      guide,
      from,
      to,
      icon: [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2],
    });
  }
  return lines;
};

/** Draw a small padlock badge, closed (hard) or open (soft). */
const drawPadlock = (
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  zoom: number,
  color: string,
  locked: boolean,
) => {
  const r = ALIGNMENT_ICON_RADIUS / zoom;
  const bodyW = r * 0.9;
  const bodyH = r * 0.75;
  const bodyTop = cy - bodyH * 0.15;
  const shackleR = bodyW * 0.42;
  // open padlock lifts and tilts the shackle to one side
  const shackleCx = cx + (locked ? 0 : shackleR * 0.6);
  const shackleCy = bodyTop - (locked ? 0 : r * 0.12);

  context.save();
  context.lineWidth = Math.max(1 / zoom, r * 0.14);

  // badge background so the line doesn't show through — always opaque,
  // the fade below applies only to the padlock itself
  context.beginPath();
  context.arc(cx, cy, r, 0, Math.PI * 2);
  context.fillStyle = "#ffffff";
  context.fill();

  // An open padlock is the "not committed yet" state, so draw it faded;
  // closed reads as the solid, active one.
  context.globalAlpha = locked ? 1 : UNLOCKED_ICON_OPACITY;
  context.strokeStyle = color;
  context.stroke();

  // shackle (arc)
  context.beginPath();
  context.arc(shackleCx, shackleCy, shackleR, Math.PI, locked ? 0 : -0.15);
  context.stroke();

  // body
  context.beginPath();
  const bx = cx - bodyW / 2;
  context.rect(bx, bodyTop, bodyW, bodyH);
  context.fillStyle = color;
  context.fill();
  context.restore();
};

export const renderAlignmentLocks = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  elementsMap: NonDeletedSceneElementsMap,
  selectedElements: readonly NonDeletedExcalidrawElement[],
) => {
  // While dragging, keep the persisted hard lines visible (partners are
  // following), but drop the soft coincidences — those are an at-rest
  // affordance and the transient snap guides already cover the live
  // case. Padlocks are at-rest only (not clickable mid-drag).
  const dragging = appState.selectedElementsAreBeingDragged;
  const lines = getAlignmentGuideLines(selectedElements, elementsMap).filter(
    (line) => !dragging || line.guide.hard,
  );
  if (lines.length === 0) {
    return;
  }

  const zoom = appState.zoom.value;
  const color =
    appState.theme === THEME.LIGHT ? GUIDE_COLOR_LIGHT : GUIDE_COLOR_DARK;

  context.save();
  context.translate(appState.scrollX, appState.scrollY);
  context.strokeStyle = color;
  context.lineWidth = 1 / zoom;

  for (const { guide, from, to } of lines) {
    context.setLineDash(
      guide.hard ? [] : [4 / zoom, 4 / zoom],
    );
    context.beginPath();
    context.moveTo(from[0], from[1]);
    context.lineTo(to[0], to[1]);
    context.stroke();
  }

  context.setLineDash([]);
  if (!dragging) {
    for (const { guide, icon } of lines) {
      drawPadlock(context, icon[0], icon[1], zoom, color, guide.hard);
    }
  }

  context.restore();
};

/** Gap (screen px) between the element's left edge and the badge, beyond
 * the badge radius — mirrors the rotation handle's offset above the top
 * edge so the lock badge reads as a sibling handle. */
const LOCK_ICON_GAP = 14;

/**
 * The lock badge's scene position: off the *left* edge of the element,
 * vertically centred, then rotated with the element about its centre —
 * placed like the rotation handle (which sits above the top edge) so it's
 * clear of the drag-grab area and tracks the element's rotation.
 */
const lockBadgePosition = (
  element: NonDeletedExcalidrawElement,
  elementsMap: NonDeletedSceneElementsMap,
  zoom: number,
): [number, number] => {
  const [x1, , , , cx, cy] = getElementAbsoluteCoords(element, elementsMap);
  // left-middle of the element's own (unrotated) box, nudged outwards
  const px = x1 - (ALIGNMENT_ICON_RADIUS + LOCK_ICON_GAP) / zoom;
  const rotated = pointRotateRads<GlobalPoint>(
    pointFrom(px, cy),
    pointFrom(cx, cy),
    element.angle,
  );
  return [rotated[0], rotated[1]];
};

/**
 * The clickable element-lock (alignment-anchor) toggle, if shown: a
 * padlock off the left edge of the single selected element. Like the
 * rotation handle it's available on any single selected element (you can
 * anchor before aligning) and only while selected. Returns the target for
 * the pointer handler to hit-test, or null when nothing single-selected.
 */
export const getElementLockToggle = (
  selectedElements: readonly NonDeletedExcalidrawElement[],
  elementsMap: NonDeletedSceneElementsMap,
  zoom: number,
): { elementId: string; center: [number, number] } | null => {
  if (selectedElements.length !== 1) {
    return null;
  }
  const el = selectedElements[0];
  return {
    elementId: el.id,
    center: lockBadgePosition(el, elementsMap, zoom),
  };
};

/**
 * Element-anchor UI: the open/closed lock toggle off the left edge of the
 * single selected element — shown whenever an element is selected (and
 * while it's being dragged, so it tracks the element), like a transform
 * handle. `color` is the selection colour, matching the rotation handle.
 */
export const renderElementAlignmentLocks = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  elementsMap: NonDeletedSceneElementsMap,
  selectedElements: readonly NonDeletedExcalidrawElement[],
  color: string,
) => {
  const zoom = appState.zoom.value;
  const toggle = getElementLockToggle(selectedElements, elementsMap, zoom);
  if (!toggle) {
    return;
  }
  const el = elementsMap.get(toggle.elementId);

  context.save();
  context.translate(appState.scrollX, appState.scrollY);
  drawPadlock(
    context,
    toggle.center[0],
    toggle.center[1],
    zoom,
    color,
    !!el?.alignmentLocked,
  );
  context.restore();
};

/** A large, translucent closed padlock centred on and scaled to an
 * element — the "this anchor is holding you" overlay shown while
 * dragging. Unlike the badge it has no white backing and is filled. */
const drawLockOverlay = (
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  color: string,
) => {
  const r = size / 2;
  const bodyW = r * 1.1;
  const bodyH = r * 0.95;
  const bodyTop = cy - bodyH * 0.1;
  const shackleR = bodyW * 0.4;

  context.save();
  context.globalAlpha = 0.4;
  context.fillStyle = color;
  context.strokeStyle = color;
  context.lineWidth = Math.max(bodyW * 0.16, 1);

  // shackle
  context.beginPath();
  context.arc(cx, bodyTop, shackleR, Math.PI, 0);
  context.stroke();

  // body
  context.beginPath();
  context.rect(cx - bodyW / 2, bodyTop, bodyW, bodyH);
  context.fill();
  context.restore();
};

/**
 * While dragging, overlay a translucent lock on every anchored element
 * that constrains the dragged selection — i.e. a locked element sharing
 * an aligned component (either axis) with something being dragged. Shows
 * regardless of drag direction, since the anchor is what holds the
 * component together.
 */
export const renderAnchorLockOverlays = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  elementsMap: NonDeletedSceneElementsMap,
  selectedElements: readonly NonDeletedExcalidrawElement[],
  color: string,
) => {
  if (!appState.selectedElementsAreBeingDragged || selectedElements.length === 0) {
    return;
  }
  const directlyMoved = new Set(selectedElements.map((el) => el.id));
  const movers = getAlignmentMovers(directlyMoved, elementsMap);

  const anchors = new Set<string>();
  for (const component of [movers.x, movers.y]) {
    for (const id of component) {
      if (!directlyMoved.has(id) && elementsMap.get(id)?.alignmentLocked) {
        anchors.add(id);
      }
    }
  }
  if (anchors.size === 0) {
    return;
  }

  const zoom = appState.zoom.value;
  context.save();
  context.translate(appState.scrollX, appState.scrollY);
  for (const id of anchors) {
    const el = elementsMap.get(id);
    if (!el) {
      continue;
    }
    const b = getElementBounds(el, elementsMap);
    const minDim = Math.min(b[2] - b[0], b[3] - b[1]);
    // scale with the element, but clamp to a sane screen-space range
    const size = Math.min(
      Math.max(minDim * 0.6, 16 / zoom),
      60 / zoom,
    );
    drawLockOverlay(
      context,
      (b[0] + b[2]) / 2,
      (b[1] + b[3]) / 2,
      size,
      color,
    );
  }
  context.restore();
};
