import {
  getAlignmentGuides,
  getAlignmentMovers,
  getElementAbsoluteCoords,
  getElementBounds,
  isAlignmentAnchor,
} from "@excalidraw/element";
import { pointFrom, pointRotateRads } from "@excalidraw/math";

import {
  INDICATOR_CROSS_SIZE,
  drawIndicatorCross,
  getIndicatorColor,
  getWideIndicatorLineDash,
} from "./helpers";

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

/** Padlock badge radius, in screen px (divided by zoom at draw time). */
export const ALIGNMENT_ICON_RADIUS = 9;

/** The inactive state of an icon — an open padlock, a lifted anchor —
 * is drawn faded to read as the weaker of the two. */
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

/**
 * How far along the line an element reaches — the anchor points it
 * contributes, as `[min, max]` on the axis the line *runs* along (the
 * perpendicular of `axis`).
 *
 * This is the rule that makes an alignment guide look like a snap guide:
 * snapping derives its lines from element corners and centres, so a side
 * (min / max) contributes that whole side of the element, while a centre
 * contributes a single point. Hence a centre-to-centre guide is drawn
 * centre-to-centre rather than across both elements, exactly as the
 * transient snap guide for the same coincidence would be.
 */
const anchorExtent = (
  bounds: Bounds,
  axis: "x" | "y",
  edge: "min" | "center" | "max",
): [number, number] => {
  const [lo, hi] =
    axis === "x" ? [bounds[1], bounds[3]] : [bounds[0], bounds[2]];
  if (edge === "center") {
    const mid = (lo + hi) / 2;
    return [mid, mid];
  }
  return [lo, hi];
};

export type AlignmentGuideLine = {
  guide: AlignmentGuide;
  /** line endpoints, scene coords */
  from: [number, number];
  to: [number, number];
  /** anchor points to mark with a cross, scene coords */
  crosses: [number, number][];
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

    // The line spans the union of what each side reaches; each end of
    // each side's reach is an anchor worth marking. Duplicates collapse
    // (two elements can share an anchor exactly).
    const spanA = anchorExtent(boundsA, guide.axis, guide.selfEdge);
    const spanB = anchorExtent(boundsB, guide.axis, guide.otherEdge);
    const along = Array.from(new Set([...spanA, ...spanB])).sort(
      (a, b) => a - b,
    );

    // selfEdge and otherEdge coordinates are equal by construction, so a
    // single line on this element's edge sits on the shared coord.
    const coord = edgeCoord(boundsA, guide.axis, guide.selfEdge);
    const at = (v: number): [number, number] =>
      guide.axis === "x" ? [coord, v] : [v, coord];

    const from = at(along[0]);
    const to = at(along[along.length - 1]);
    lines.push({
      guide,
      from,
      to,
      crosses: along.map(at),
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

/**
 * Anvil silhouette, as offsets from the icon's centre in units of its
 * height: overhanging horn on the left, wide face on top, pinched waist,
 * flared foot. Traced clockwise from the top-left of the face.
 */
const ANVIL_PATH: readonly (readonly [number, number])[] = [
  [-0.25, -0.5], // face, top-left
  [0.57, -0.5], // face, top-right
  [0.57, -0.3], // face, bottom-right
  [0.25, -0.2], // underside sloping in to the waist
  [0.19, 0.1], // waist, right
  [0.45, 0.3], // foot flares out
  [0.45, 0.5], // foot, bottom-right
  [-0.35, 0.5], // foot, bottom-left
  [-0.35, 0.3],
  [-0.09, 0.1], // waist, left
  [-0.19, -0.2],
  [-0.57, -0.28], // horn tip
];

/**
 * An anvil centred on (cx, cy) and `size` tall — the "too heavy to be
 * pushed around" mark for an alignment anchor. The caller owns colour,
 * alpha and any backing.
 *
 * `filled` is the state cue, and here it carries real meaning rather
 * than just convention: a solid anvil is a lump of mass (anchored, won't
 * budge), a hollow one is an empty shell (free to be moved by its
 * alignments). Weight is the whole metaphor, so it should be what the
 * silhouette shows.
 *
 * Anvils are deliberately *not* padlocks: a padlock means "this
 * alignment is committed" (the guide-line icons), while an anvil means
 * "this element holds still and the others move around it". Two
 * different ideas, two different icons.
 */
const drawAnvil = (
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  color: string,
  lineWidth: number,
  filled: boolean,
) => {
  context.save();
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = lineWidth;
  context.lineJoin = "round";

  context.beginPath();
  ANVIL_PATH.forEach(([dx, dy], i) => {
    const x = cx + dx * size;
    const y = cy + dy * size;
    if (i === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  });
  context.closePath();

  if (filled) {
    context.fill();
    // stroke too, so the filled anvil reads at the same outer size as
    // the hollow one rather than shrinking by half a line width
    context.stroke();
  } else {
    context.stroke();
  }

  context.restore();
};

/**
 * The anchor equivalent of {@link drawPadlock}: same white badge, same
 * fade for the inactive state, an anvil instead of a lock.
 */
const drawAnchorBadge = (
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  zoom: number,
  color: string,
  anchored: boolean,
) => {
  const r = ALIGNMENT_ICON_RADIUS / zoom;
  const lineWidth = Math.max(1 / zoom, r * 0.13);

  context.save();

  context.beginPath();
  context.arc(cx, cy, r, 0, Math.PI * 2);
  context.fillStyle = "#ffffff";
  context.fill();

  context.globalAlpha = anchored ? 1 : UNLOCKED_ICON_OPACITY;
  context.strokeStyle = color;
  context.lineWidth = lineWidth;
  context.stroke();

  // the anvil is wider than tall (1.14:1), so height is what has to fit
  drawAnvil(context, cx, cy, r * 1.35, color, lineWidth, anchored);
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
  const color = getIndicatorColor(appState.theme, appState.zenModeEnabled);

  context.save();
  context.translate(appState.scrollX, appState.scrollY);
  context.strokeStyle = color;
  context.lineWidth = 1 / zoom;

  for (const { guide, from, to } of lines) {
    context.setLineDash(guide.hard ? [] : getWideIndicatorLineDash(zoom));
    context.beginPath();
    context.moveTo(from[0], from[1]);
    context.lineTo(to[0], to[1]);
    context.stroke();
  }

  // Crosses mark the anchor points the line is pinned to, as the snap
  // guides do. Solid regardless of the line's dash — they're a couple of
  // pixels across and would disappear into the gaps.
  context.setLineDash([]);
  const crossSize = INDICATOR_CROSS_SIZE / zoom;
  for (const { crosses } of lines) {
    for (const [x, y] of crosses) {
      drawIndicatorCross(context, x, y, crossSize);
    }
  }

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
 * The clickable element-lock (alignment-anchor) toggle, if shown: an
 * anvil badge off the left edge of the single selected element. Like the
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
  // An upstream-locked element is anchored unconditionally and can't be
  // edited, so there's nothing to toggle — offering the badge would just
  // invite a click that appears to do nothing. Matches `getTransformHandles`,
  // which likewise shows no handles on a locked element.
  if (el.locked) {
    return null;
  }
  return {
    elementId: el.id,
    center: lockBadgePosition(el, elementsMap, zoom),
  };
};

/**
 * Element-anchor UI: the anchor toggle off the left edge of the
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
  drawAnchorBadge(
    context,
    toggle.center[0],
    toggle.center[1],
    zoom,
    color,
    isAlignmentAnchor(el),
  );
  context.restore();
};

/** A large, translucent anvil centred on and scaled to an element —
 * the "this anchor is holding you" overlay shown while dragging. Unlike
 * the badge it has no white backing. */
const drawAnchorOverlay = (
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  color: string,
) => {
  context.save();
  context.globalAlpha = 0.4;
  // only ever drawn for an element that *is* anchored
  drawAnvil(context, cx, cy, size, color, Math.max(size * 0.06, 1), true);
  context.restore();
};

/**
 * While dragging, overlay a translucent anvil on every anchored element
 * that constrains the dragged selection — i.e. an anchor sharing an
 * aligned component (either axis) with something being dragged. Shows
 * regardless of drag direction, since the anchor is what holds the
 * component together, and covers upstream-locked elements too (they
 * anchor without carrying the badge).
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
      if (!directlyMoved.has(id) && isAlignmentAnchor(elementsMap.get(id))) {
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
    drawAnchorOverlay(
      context,
      (b[0] + b[2]) / 2,
      (b[1] + b[3]) / 2,
      size,
      color,
    );
  }
  context.restore();
};
