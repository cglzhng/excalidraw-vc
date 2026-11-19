/**
 * The canvas half of a conflict-resolution session: what the active
 * conflict can be resolved onto, and what it lost.
 *
 *  - a wash over everything that can't stand in, so the candidates are
 *    the only things left at full strength;
 *  - a solid outline on the chosen stand-in, labelled with what it now
 *    takes (the candidates on offer are marked by the wash leaving them
 *    out);
 *  - a red outline and label on the missing element's ghost (the ghost
 *    itself is drawn by the caller, with the hover preview's renderer);
 *  - a dashed line from the ghost to the chosen stand-in, reading "this
 *    one now plays that one's part";
 *  - an outline on a dimmed element under the pointer, labelled with why
 *    it can't stand in.
 *
 * Every function expects the context already scaled by zoom, and works in
 * scene coordinates.
 */

import { THEME } from "@excalidraw/common";

import type { Bounds } from "@excalidraw/common";

import { drawElementIdLabel } from "./indicatorHelpers";

import type { InteractiveCanvasAppState } from "../types";

const WASH_LIGHT = "rgba(255, 255, 255, 0.6)";
const WASH_DARK = "rgba(18, 18, 18, 0.6)";
const CANDIDATE_LIGHT = "#6965db";
const CANDIDATE_DARK = "#a5a3f5";
const MISSING_LIGHT = "#e03131";
const MISSING_DARK = "#ff8787";

/** Screen-space px, i.e. divided by zoom before use. */
const OUTLINE_PADDING = 6;
const OUTLINE_WIDTH = 1.5;
const CHOSEN_OUTLINE_WIDTH = 3;
const DASH = [6, 4];

const isLight = (appState: InteractiveCanvasAppState) =>
  appState.theme === THEME.LIGHT;

const pad = ([x1, y1, x2, y2]: Bounds, by: number): Bounds => [
  x1 - by,
  y1 - by,
  x2 + by,
  y2 + by,
];

/**
 * Dim the viewport except for `holes`: one path, the viewport rectangle
 * with a rectangle per hole, filled even-odd. Where two holes overlap the
 * rule washes the overlap again; candidates rarely overlap, and merging
 * the rectangles isn't worth it for a wash.
 */
export const renderConflictWash = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  viewportWidth: number,
  viewportHeight: number,
  holes: readonly Bounds[],
) => {
  const zoom = appState.zoom.value;
  context.save();
  context.translate(appState.scrollX, appState.scrollY);
  context.beginPath();
  context.rect(
    -appState.scrollX,
    -appState.scrollY,
    viewportWidth / zoom,
    viewportHeight / zoom,
  );
  for (const hole of holes) {
    const [x1, y1, x2, y2] = pad(hole, OUTLINE_PADDING / zoom);
    context.rect(x1, y1, x2 - x1, y2 - y1);
  }
  context.fillStyle = isLight(appState) ? WASH_LIGHT : WASH_DARK;
  context.fill("evenodd");
  context.restore();
};

const strokeBounds = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  bounds: Bounds,
  color: string,
  width: number,
  dashed: boolean,
) => {
  const zoom = appState.zoom.value;
  const [x1, y1, x2, y2] = pad(bounds, OUTLINE_PADDING / zoom);
  context.save();
  context.translate(appState.scrollX, appState.scrollY);
  context.strokeStyle = color;
  context.lineWidth = width / zoom;
  context.setLineDash(dashed ? DASH.map((d) => d / zoom) : []);
  context.strokeRect(x1, y1, x2 - x1, y2 - y1);
  context.restore();
};

/**
 * A label centred above an outline drawn with `strokeBounds`: an
 * element's own corner already holds its short id, and a ghost's corner
 * may hold a live element's.
 */
const labelAbove = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  bounds: Bounds,
  text: string,
) => {
  const zoom = appState.zoom.value;
  const [x1, y1, x2] = pad(bounds, OUTLINE_PADDING / zoom);
  context.save();
  context.translate(appState.scrollX, appState.scrollY);
  drawElementIdLabel(
    context,
    (x1 + x2) / 2,
    y1,
    text,
    zoom,
    appState.theme,
    "above",
  );
  context.restore();
};

/** The candidate chosen to stand in for the active conflict's referent:
 * a solid outline, labelled. */
export const renderStandInOutline = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  bounds: Bounds,
  label: string,
) => {
  strokeBounds(
    context,
    appState,
    bounds,
    isLight(appState) ? CANDIDATE_LIGHT : CANDIDATE_DARK,
    CHOSEN_OUTLINE_WIDTH,
    false,
  );
  labelAbove(context, appState, bounds, label);
};

/** The missing referent's ghost: a red dashed outline, labelled. */
export const renderMissingOutline = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  bounds: Bounds,
  label: string,
) => {
  strokeBounds(
    context,
    appState,
    bounds,
    isLight(appState) ? MISSING_LIGHT : MISSING_DARK,
    OUTLINE_WIDTH,
    true,
  );
  labelAbove(context, appState, bounds, label);
};

/**
 * A dimmed element under the pointer, answering for itself: a red outline,
 * and above it why it can't stand in.
 */
export const renderRefusalOutline = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  bounds: Bounds,
  text: string,
) => {
  strokeBounds(
    context,
    appState,
    bounds,
    isLight(appState) ? MISSING_LIGHT : MISSING_DARK,
    OUTLINE_WIDTH,
    false,
  );
  labelAbove(context, appState, bounds, text);
};

/** A dashed line from the missing referent to the stand-in chosen for it. */
export const renderStandInConnector = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  from: Bounds,
  to: Bounds,
) => {
  const zoom = appState.zoom.value;
  context.save();
  context.translate(appState.scrollX, appState.scrollY);
  context.strokeStyle = isLight(appState) ? CANDIDATE_LIGHT : CANDIDATE_DARK;
  context.lineWidth = OUTLINE_WIDTH / zoom;
  context.setLineDash(DASH.map((d) => d / zoom));
  context.beginPath();
  context.moveTo((from[0] + from[2]) / 2, (from[1] + from[3]) / 2);
  context.lineTo((to[0] + to[2]) / 2, (to[1] + to[3]) / 2);
  context.stroke();
  context.restore();
};
