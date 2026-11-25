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
 *  - a label on a dimmed element under the pointer, saying why it can't
 *    stand in, or on a candidate, saying what choosing it would drop;
 *  - in Reassign, the alignments that bear on the pick, with their badges:
 *    the missing element's until something stands in for it, the stand-in's,
 *    and those of the candidate under the pointer;
 *  - the hard alignments these decisions leave not holding, flashing as
 *    a refused gesture's do.
 *
 * Every function expects the context already scaled by zoom, and works in
 * scene coordinates.
 */

import { THEME } from "@excalidraw/common";
import { getElementBounds } from "@excalidraw/element";

import type { Bounds } from "@excalidraw/common";
import type {
  AlignmentEdge,
  ElementsMap,
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
  NonDeletedSceneElementsMap,
} from "@excalidraw/element/types";

import { coordOf } from "../versionLog/placement";

import { drawElementIdLabel, getRefusalFlashColor } from "./indicatorHelpers";
import {
  getAlignmentGuideLines,
  getGapAlignmentGuideLines,
  layOutAlignmentBadges,
  pairCentredGuides,
  renderAlignmentClusterBadges,
  renderAlignmentLockIcons,
  renderAlignmentLocks,
  renderGapAlignmentIcons,
  renderGapAlignmentLocks,
} from "./renderAlignmentLocks";

import type { InteractiveCanvasAppState } from "../types";
import type { BrokenAlignment } from "../versionLog/brokenAlignments";

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

/** An element under the pointer, answering for itself above it: a dimmed
 * one, why it can't stand in; a candidate, what choosing it would drop. */
export const renderRefusalLabel = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  bounds: Bounds,
  text: string,
) => {
  labelAbove(context, appState, bounds, text);
};

/** One edge link, whichever partner it is read from. */
const edgeLinkKey = (
  axis: "x" | "y",
  a: string,
  aEdge: AlignmentEdge,
  b: string,
  bEdge: AlignmentEdge,
) => [`${a}:${aEdge}`, `${b}:${bEdge}`].sort().concat(axis).join("|");

const chainKey = (axis: "x" | "y", ids: readonly string[]) =>
  `${axis}:${ids.join("|")}`;

/**
 * The hard alignments that bear on the pick, drawn as they are anywhere
 * else: a guide line and the badge that says what kind of alignment it is.
 * `missing` is what nothing stands in for yet, whose links the scene no
 * longer has; `candidates` the stand-in and the candidate under the pointer.
 *
 * A link in `broken` is left out, since a guide draws both edges on one
 * coordinate and `renderBrokenAlignments` shows those where they actually
 * are. A missing element's link is kept whether or not its partner is still
 * there to meet it: it says what a stand-in would take on, on the ghost's edge.
 */
export const renderHeldAlignments = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  elementsMap: NonDeletedSceneElementsMap,
  broken: readonly BrokenAlignment[],
  missing: readonly ExcalidrawElement[],
  candidates: readonly ExcalidrawElement[],
) => {
  const scene = new Map<string, ExcalidrawElement>(elementsMap);
  for (const ghost of missing) {
    if (!scene.has(ghost.id)) {
      scene.set(ghost.id, { ...ghost, isDeleted: false });
    }
  }
  const sceneMap = scene as unknown as NonDeletedSceneElementsMap;
  // a group's ghosts are members still in the scene, so read the live copy
  const sources = [
    ...missing.map((ghost) => scene.get(ghost.id)!),
    ...candidates,
  ] as NonDeletedExcalidrawElement[];
  const brokenKeys = new Set(
    broken.map((alignment) =>
      alignment.kind === "edge"
        ? edgeLinkKey(
            alignment.axis,
            alignment.a,
            alignment.aEdge,
            alignment.b,
            alignment.bEdge,
          )
        : chainKey(alignment.axis, alignment.ids),
    ),
  );

  const layout = layOutAlignmentBadges(
    pairCentredGuides(
      getAlignmentGuideLines(sources, sceneMap, true).filter(
        ({ guide }) =>
          !brokenKeys.has(
            edgeLinkKey(
              guide.axis,
              guide.selfId,
              guide.selfEdge,
              guide.elementId,
              guide.otherEdge,
            ),
          ),
      ),
    ),
    getGapAlignmentGuideLines(sources, sceneMap, true).filter(
      ({ guide, spans }) =>
        spans.length > 0 && !brokenKeys.has(chainKey(guide.axis, guide.ids)),
    ),
    appState.zoom.value,
    null,
  );
  // lines before badges, and padlocks over equals signs, as the selection's
  renderGapAlignmentLocks(context, appState, layout.gapLines, null);
  renderAlignmentLocks(context, appState, layout.edgeLines, null);
  renderGapAlignmentIcons(context, appState, layout.gapLines, null);
  renderAlignmentLockIcons(context, appState, layout.edgeLines, null);
  renderAlignmentClusterBadges(context, appState, layout.clusters);
};

/**
 * The alignments that no longer hold. A broken edge link has no shared
 * line to draw, so each element's edge is drawn where it actually is, with
 * a dashed line across the distance between them. A broken chain draws each
 * gap as a capped span, so the unequal lengths can be compared.
 */
export const renderBrokenAlignments = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  broken: readonly BrokenAlignment[],
  elementsMap: ElementsMap,
  flashRuntime: number,
) => {
  const zoom = appState.zoom.value;
  const boundsOf = (id: string) => {
    const el = elementsMap.get(id);
    return el ? getElementBounds(el, elementsMap) : null;
  };
  /** `[min, max]` along the axis and across it. */
  const spans = (bounds: Bounds, axis: "x" | "y") => {
    const x: [number, number] = [bounds[0], bounds[2]];
    const y: [number, number] = [bounds[1], bounds[3]];
    return axis === "x" ? { along: x, across: y } : { along: y, across: x };
  };

  context.save();
  context.translate(appState.scrollX, appState.scrollY);
  context.strokeStyle = getRefusalFlashColor(
    appState.theme,
    appState.zenModeEnabled,
    flashRuntime,
  );
  context.lineWidth = CHOSEN_OUTLINE_WIDTH / zoom;

  for (const alignment of broken) {
    const { axis } = alignment;
    const segment = (
      along1: number,
      across1: number,
      along2: number,
      across2: number,
      dashed = false,
    ) => {
      context.setLineDash(dashed ? DASH.map((d) => d / zoom) : []);
      context.beginPath();
      if (axis === "x") {
        context.moveTo(along1, across1);
        context.lineTo(along2, across2);
      } else {
        context.moveTo(across1, along1);
        context.lineTo(across2, along2);
      }
      context.stroke();
    };

    if (alignment.kind === "edge") {
      const a = boundsOf(alignment.a);
      const b = boundsOf(alignment.b);
      if (!a || !b) {
        continue;
      }
      const spanA = spans(a, axis);
      const spanB = spans(b, axis);
      const coordA = coordOf(spanA.along, alignment.aEdge);
      const coordB = coordOf(spanB.along, alignment.bEdge);
      segment(coordA, spanA.across[0], coordA, spanA.across[1]);
      segment(coordB, spanB.across[0], coordB, spanB.across[1]);
      segment(
        coordA,
        (spanA.across[0] + spanA.across[1]) / 2,
        coordB,
        (spanB.across[0] + spanB.across[1]) / 2,
        true,
      );
      continue;
    }

    const members = alignment.ids.map(boundsOf);
    if (members.some((bounds) => bounds == null)) {
      continue;
    }
    const memberSpans = (members as Bounds[]).map((b) => spans(b, axis));
    const across =
      (Math.min(...memberSpans.map((s) => s.across[0])) +
        Math.max(...memberSpans.map((s) => s.across[1]))) /
      2;
    const cap = OUTLINE_PADDING / zoom;
    for (let i = 0; i + 1 < memberSpans.length; i++) {
      const from = memberSpans[i].along[1];
      const to = memberSpans[i + 1].along[0];
      segment(from, across, to, across);
      segment(from, across - cap, from, across + cap);
      segment(to, across - cap, to, across + cap);
    }
  }
  context.restore();
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
