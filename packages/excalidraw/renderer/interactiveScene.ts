import {
  clamp,
  pointFrom,
  pointsEqual,
  type GlobalPoint,
  type LocalPoint,
  type Radians,
  bezierEquation,
  pointRotateRads,
  pointDistance,
} from "@excalidraw/math";

import {
  arrayToMap,
  BIND_MODE_TIMEOUT,
  DEFAULT_TRANSFORM_HANDLE_SPACING,
  FRAME_STYLE,
  getFeatureFlag,
  invariant,
  shouldRotateWithDiscreteAngle,
  THEME,
} from "@excalidraw/common";

import {
  deconstructDiamondElement,
  deconstructRectanguloidElement,
  elementCenterPoint,
  getDiamondBaseCorners,
  FOCUS_POINT_SIZE,
  getOmitSidesForEditorInterface,
  getTransformHandles,
  getTransformHandlesFromCoords,
  hasBoundingBox,
  hitElementItself,
  isArrowElement,
  isBindableElement,
  isElbowArrow,
  isFrameLikeElement,
  isImageElement,
  isLinearElement,
  isLineElement,
  maxBindingDistance_simple,
  isTextElement,
  LinearElementEditor,
  getActiveTextElement,
  getElementsInGroup,
  getSelectedGroupIds,
  isSelectedViaGroup,
  selectGroupsFromGivenElements,
} from "@excalidraw/element";

import { renderElement, renderSelectionElement } from "@excalidraw/element";

import {
  getCommonBounds,
  getElementAbsoluteCoords,
  getElementLineSegments,
} from "@excalidraw/element";
import {
  getGlobalFixedPointForBindableElement,
  isFocusPointVisible,
} from "@excalidraw/element";

import rough from "roughjs/bin/rough";

import type { EditorInterface } from "@excalidraw/common";

import type {
  TransformHandles,
  TransformHandleType,
} from "@excalidraw/element";

import type {
  ElementsMap,
  ExcalidrawArrowElement,
  ExcalidrawBindableElement,
  ExcalidrawElement,
  ExcalidrawFrameLikeElement,
  ExcalidrawImageElement,
  ExcalidrawLinearElement,
  ExcalidrawTextElement,
  GroupId,
  NonDeleted,
  NonDeletedExcalidrawElement,
  NonDeletedSceneElementsMap,
} from "@excalidraw/element/types";

import {
  renderAlignmentLocks,
  renderElementAlignmentLocks,
  renderGapAlignmentLocks,
  renderAnchorLockOverlays,
} from "../renderer/renderAlignmentLocks";
import { renderSnaps } from "../renderer/renderSnaps";
import { roundRect } from "../renderer/roundRect";
import {
  getScrollBars,
  SCROLLBAR_COLOR,
  SCROLLBAR_WIDTH,
} from "../scene/scrollbars";

import { getClientColor, renderRemoteCursors } from "../clients";
import {
  getTextAutoResizeHandle,
  getTextBoxPadding,
} from "../textAutoResizeHandle";

import {
  bootstrapCanvas,
  drawPadlock,
  fillCircle,
  getNarrowIndicatorLineDash,
  getWideIndicatorLineDash,
  getNormalizedCanvasDimensions,
  strokeRectWithRotation_simple,
} from "./helpers";

import type {
  AppState,
  AppClassProperties,
  InteractiveCanvasAppState,
} from "../types";
import type {
  InteractiveCanvasRenderConfig,
  InteractiveSceneRenderConfig,
  RenderableElementsMap,
} from "../scene/types";

const renderElbowArrowMidPointHighlight = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
) => {
  invariant(appState.selectedLinearElement, "selectedLinearElement is null");

  const { segmentMidPointHoveredCoords } = appState.selectedLinearElement;

  invariant(segmentMidPointHoveredCoords, "midPointCoords is null");

  highlightPoint(segmentMidPointHoveredCoords, context, appState);
};

const renderLinearElementPointHighlight = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  elementsMap: ElementsMap,
) => {
  const { elementId, hoverPointIndex } = appState.selectedLinearElement!;
  if (
    appState.selectedLinearElement?.isEditing &&
    appState.selectedLinearElement?.selectedPointsIndices?.includes(
      hoverPointIndex,
    )
  ) {
    return;
  }
  if (appState.selectedLinearElement?.isDragging) {
    return;
  }
  const element = LinearElementEditor.getElement(elementId, elementsMap);

  if (!element) {
    return;
  }
  const point = LinearElementEditor.getPointAtIndexGlobalCoordinates(
    element,
    hoverPointIndex,
    elementsMap,
  );
  highlightPoint(point, context, appState);
};

/** draws the point marker in scene coordinates */
const highlightPoint = <Point extends LocalPoint | GlobalPoint>(
  point: Point,
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
) => {
  context.save();
  context.translate(appState.scrollX, appState.scrollY);

  context.fillStyle = "rgba(105, 101, 219, 0.4)";

  fillCircle(
    context,
    point[0],
    point[1],
    LinearElementEditor.POINT_HANDLE_SIZE / appState.zoom.value,
    false,
  );

  context.restore();
};

/**
 * Marks where on the hovered arrow the text tool would attach text — a free
 * endpoint, or the midpoint the arrow's label would center on.
 *
 * Purely presentational: `AppArrowText` maintains the anchor at every event
 * that can change it (pointermove, the ctrl/cmd binding toggle, pointerdown,
 * tool switches, finalize). The element lookup below only guards against the
 * arrow vanishing through channels no local event covers, e.g. a collaborator
 * deleting it.
 */
const renderHoveredArrowTextAnchor = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  elementsMap: ElementsMap,
) => {
  const { elementId, anchor } = appState.hoveredArrowTextAnchor!;

  const element = elementsMap.get(elementId);

  if (!element || !isArrowElement(element) || element.isDeleted) {
    return;
  }

  const point =
    anchor === "label"
      ? LinearElementEditor.getBoundTextElementCenter(element, elementsMap)
      : LinearElementEditor.getPointAtIndexGlobalCoordinates(
          element,
          anchor === "start" ? 0 : -1,
          elementsMap,
        );

  highlightPoint(point, context, appState);
};

const renderSingleLinearPoint = <Point extends GlobalPoint | LocalPoint>(
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  point: Point,
  radius: number,
  isSelected: boolean,
  isPhantomPoint: boolean,
  isOverlappingPoint: boolean,
) => {
  context.strokeStyle = "#5e5ad8";
  context.setLineDash([]);
  context.fillStyle = "rgba(255, 255, 255, 0.9)";
  if (isSelected) {
    context.fillStyle = "rgba(134, 131, 226, 0.9)";
  } else if (isPhantomPoint) {
    context.fillStyle = "rgba(177, 151, 252, 0.7)";
  }

  fillCircle(
    context,
    point[0],
    point[1],
    (isOverlappingPoint
      ? radius * (appState.selectedLinearElement?.isEditing ? 1.5 : 2)
      : radius) / appState.zoom.value,
    !isPhantomPoint,
    !isOverlappingPoint || isSelected,
  );
};

const renderBindingHighlightForBindableElement_simple = (
  context: CanvasRenderingContext2D,
  suggestedBinding: NonNullable<AppState["suggestedBinding"]>,
  elementsMap: ElementsMap,
  appState: InteractiveCanvasAppState,
  pointerCoords: GlobalPoint | null,
  angleLocked = false,
) => {
  const enclosingFrame =
    suggestedBinding.element.frameId &&
    elementsMap.get(suggestedBinding.element.frameId);
  if (enclosingFrame && isFrameLikeElement(enclosingFrame)) {
    context.translate(enclosingFrame.x, enclosingFrame.y);

    context.beginPath();

    if (FRAME_STYLE.radius && context.roundRect) {
      context.roundRect(
        -1,
        -1,
        enclosingFrame.width + 1,
        enclosingFrame.height + 1,
        FRAME_STYLE.radius / appState.zoom.value,
      );
    } else {
      context.rect(-1, -1, enclosingFrame.width + 1, enclosingFrame.height + 1);
    }

    context.clip();

    context.translate(-enclosingFrame.x, -enclosingFrame.y);
  }

  switch (suggestedBinding.element.type) {
    case "magicframe":
    case "frame":
      context.save();

      context.translate(suggestedBinding.element.x, suggestedBinding.element.y);

      context.lineWidth = FRAME_STYLE.strokeWidth / appState.zoom.value;
      context.strokeStyle =
        appState.theme === THEME.DARK
          ? `rgba(3, 93, 161, 1)`
          : `rgba(106, 189, 252, 1)`;

      if (FRAME_STYLE.radius && context.roundRect) {
        context.beginPath();
        context.roundRect(
          0,
          0,
          suggestedBinding.element.width,
          suggestedBinding.element.height,
          FRAME_STYLE.radius / appState.zoom.value,
        );
        context.stroke();
        context.closePath();
      } else {
        context.strokeRect(
          0,
          0,
          suggestedBinding.element.width,
          suggestedBinding.element.height,
        );
      }

      context.restore();
      break;
    default:
      context.save();

      const center = elementCenterPoint(suggestedBinding.element, elementsMap);

      context.translate(center[0], center[1]);
      context.rotate(suggestedBinding.element.angle as Radians);
      context.translate(-center[0], -center[1]);

      context.translate(suggestedBinding.element.x, suggestedBinding.element.y);

      context.lineWidth =
        clamp(1.75, suggestedBinding.element.strokeWidth, 4) /
        Math.max(0.25, appState.zoom.value);
      context.strokeStyle =
        appState.theme === THEME.DARK
          ? `rgba(3, 93, 161, 1)`
          : `rgba(106, 189, 252, 1)`;

      switch (suggestedBinding.element.type) {
        case "ellipse":
          context.beginPath();
          context.ellipse(
            suggestedBinding.element.width / 2,
            suggestedBinding.element.height / 2,
            suggestedBinding.element.width / 2,
            suggestedBinding.element.height / 2,
            0,
            0,
            2 * Math.PI,
          );
          context.closePath();
          context.stroke();
          break;
        case "diamond":
          {
            const [segments, curves] = deconstructDiamondElement(
              suggestedBinding.element,
            );

            // Draw each line segment individually
            segments.forEach((segment) => {
              context.beginPath();
              context.moveTo(
                segment[0][0] - suggestedBinding.element.x,
                segment[0][1] - suggestedBinding.element.y,
              );
              context.lineTo(
                segment[1][0] - suggestedBinding.element.x,
                segment[1][1] - suggestedBinding.element.y,
              );
              context.stroke();
            });

            // Draw each curve individually (for rounded corners)
            curves.forEach((curve) => {
              const [start, control1, control2, end] = curve;
              context.beginPath();
              context.moveTo(
                start[0] - suggestedBinding.element.x,
                start[1] - suggestedBinding.element.y,
              );
              context.bezierCurveTo(
                control1[0] - suggestedBinding.element.x,
                control1[1] - suggestedBinding.element.y,
                control2[0] - suggestedBinding.element.x,
                control2[1] - suggestedBinding.element.y,
                end[0] - suggestedBinding.element.x,
                end[1] - suggestedBinding.element.y,
              );
              context.stroke();
            });
          }

          break;
        default:
          {
            const [segments, curves] = deconstructRectanguloidElement(
              suggestedBinding.element,
            );

            // Draw each line segment individually
            segments.forEach((segment) => {
              context.beginPath();
              context.moveTo(
                segment[0][0] - suggestedBinding.element.x,
                segment[0][1] - suggestedBinding.element.y,
              );
              context.lineTo(
                segment[1][0] - suggestedBinding.element.x,
                segment[1][1] - suggestedBinding.element.y,
              );
              context.stroke();
            });

            // Draw each curve individually (for rounded corners)
            curves.forEach((curve) => {
              const [start, control1, control2, end] = curve;
              context.beginPath();
              context.moveTo(
                start[0] - suggestedBinding.element.x,
                start[1] - suggestedBinding.element.y,
              );
              context.bezierCurveTo(
                control1[0] - suggestedBinding.element.x,
                control1[1] - suggestedBinding.element.y,
                control2[0] - suggestedBinding.element.x,
                control2[1] - suggestedBinding.element.y,
                end[0] - suggestedBinding.element.x,
                end[1] - suggestedBinding.element.y,
              );
              context.stroke();
            });
          }

          break;
      }

      context.restore();

      break;
  }

  if (
    appState.isMidpointSnappingEnabled &&
    !appState.gridModeEnabled &&
    !angleLocked &&
    (isFrameLikeElement(suggestedBinding.element) ||
      isBindableElement(suggestedBinding.element))
  ) {
    // Draw midpoint indicators
    const linearElement = appState.selectedLinearElement;
    const arrow =
      linearElement?.elementId &&
      LinearElementEditor.getElement(linearElement?.elementId, elementsMap);
    const cursorIsInsideBindable =
      pointerCoords &&
      hitElementItself({
        point: pointerCoords,
        element: suggestedBinding.element,
        elementsMap,
        threshold: 0,
        overrideShouldTestInside: true,
      });

    const isElbow =
      (arrow && isElbowArrow(arrow)) ||
      (appState.activeTool.type === "arrow" &&
        appState.currentItemArrowType === "elbow");

    // VERSION-LOG: the four midpoints are drawn for every arrow type,
    // and all four at once, rather than only the one being approached.
    //
    // They are the only places on the outline an arrow may attach (see
    // `isAtEdgeMidpoint` in binding.ts), so they have to be visible
    // *before* the pointer is near one — revealing a port only once you
    // have already found it is no help in finding it. This is what elbow
    // arrows have always done; the branch below now takes it for
    // everything.
    {
      context.save();

      const center = elementCenterPoint(suggestedBinding.element, elementsMap);

      let midpoints: GlobalPoint[];
      if (suggestedBinding.element.type === "diamond") {
        const center = elementCenterPoint(
          suggestedBinding.element,
          elementsMap,
        );
        midpoints = getDiamondBaseCorners(suggestedBinding.element).map(
          (curve) => {
            const point = bezierEquation(curve, 0.5);
            const rotatedPoint = pointRotateRads(
              point,
              center,
              suggestedBinding.element.angle,
            );

            return pointFrom<GlobalPoint>(rotatedPoint[0], rotatedPoint[1]);
          },
        );
      } else {
        const basePoints = [
          {
            x: suggestedBinding.element.width,
            y: suggestedBinding.element.height / 2,
          }, // RIGHT
          {
            x: suggestedBinding.element.width / 2,
            y: suggestedBinding.element.height,
          }, // BOTTOM
          { x: 0, y: suggestedBinding.element.height / 2 }, // LEFT
          { x: suggestedBinding.element.width / 2, y: 0 }, // TOP
        ];
        midpoints = basePoints.map((point) => {
          const globalPoint = pointFrom<GlobalPoint>(
            point.x + suggestedBinding.element.x,
            point.y + suggestedBinding.element.y,
          );
          const rotatedPoint = pointRotateRads(
            globalPoint,
            center,
            suggestedBinding.element.angle,
          );
          return pointFrom<GlobalPoint>(rotatedPoint[0], rotatedPoint[1]);
        });
      }

      const hoveredMidpoint =
        pointerCoords &&
        midpoints.reduce(
          (
            closestIdx: {
              idx: number;
              distance: number;
            },
            point,
            idx,
          ) => {
            const distance = pointDistance(point, pointerCoords);
            if (idx === -1 || distance < closestIdx.distance) {
              return { idx, distance };
            }
            return closestIdx;
          },
          {
            idx: -1,
            distance: Infinity,
          },
        );

      const midpointRadius = 4 / appState.zoom.value;
      const highlightThreshold =
        maxBindingDistance_simple(appState.zoom) +
        suggestedBinding.element.strokeWidth / 2;

      midpoints.forEach((midpoint, idx) => {
        const isHighlighted =
          (!cursorIsInsideBindable || isElbow) &&
          hoveredMidpoint?.idx === idx &&
          hoveredMidpoint.distance <= highlightThreshold;

        // Every other midpoint is drawn in the resting style. Only the
        // highlight stays conditional on the cursor being outside the
        // shape: inside, the arrow binds to the interior, so highlighting
        // a port would promise an attachment that won't happen.
        const isShown = !isHighlighted;

        if (isHighlighted) {
          context.fillStyle =
            appState.theme === THEME.DARK
              ? `rgba(3, 93, 161, 1)`
              : `rgba(106, 189, 252, 1)`;

          context.beginPath();
          context.arc(midpoint[0], midpoint[1], midpointRadius, 0, 2 * Math.PI);
          context.fill();
        } else if (isShown) {
          context.fillStyle =
            appState.theme === THEME.DARK
              ? `rgba(0, 0, 0, 0.8)`
              : `rgba(65, 65, 65, 0.5)`;
          context.beginPath();
          context.arc(midpoint[0], midpoint[1], midpointRadius, 0, 2 * Math.PI);
          context.fill();
        }
      });

      context.restore();
    }
  }
};

const renderBindingHighlightForBindableElement_complex = (
  app: AppClassProperties,
  context: CanvasRenderingContext2D,
  element: ExcalidrawBindableElement,
  allElementsMap: NonDeletedSceneElementsMap,
  appState: InteractiveCanvasAppState,
  deltaTime: number,
  state?: { runtime: number },
) => {
  const countdownInProgress =
    app.state.bindMode === "orbit" && app.bindModeHandler !== null;

  const remainingTime =
    BIND_MODE_TIMEOUT -
    (state?.runtime ?? (countdownInProgress ? 0 : BIND_MODE_TIMEOUT));
  const opacity = clamp((1 / BIND_MODE_TIMEOUT) * remainingTime, 0.0001, 1);
  const offset = element.strokeWidth / 2;

  const enclosingFrame = element.frameId && allElementsMap.get(element.frameId);
  if (enclosingFrame && isFrameLikeElement(enclosingFrame)) {
    context.translate(enclosingFrame.x, enclosingFrame.y);

    context.beginPath();

    if (FRAME_STYLE.radius && context.roundRect) {
      context.roundRect(
        -1,
        -1,
        enclosingFrame.width + 1,
        enclosingFrame.height + 1,
        FRAME_STYLE.radius / appState.zoom.value,
      );
    } else {
      context.rect(-1, -1, enclosingFrame.width + 1, enclosingFrame.height + 1);
    }

    context.clip();

    context.translate(-enclosingFrame.x, -enclosingFrame.y);
  }

  switch (element.type) {
    case "magicframe":
    case "frame":
      context.save();

      context.translate(element.x, element.y);

      context.lineWidth = FRAME_STYLE.strokeWidth / appState.zoom.value;
      context.strokeStyle =
        appState.theme === THEME.DARK
          ? `rgba(3, 93, 161, ${opacity})`
          : `rgba(106, 189, 252, ${opacity})`;

      if (FRAME_STYLE.radius && context.roundRect) {
        context.beginPath();
        context.roundRect(
          0,
          0,
          element.width,
          element.height,
          FRAME_STYLE.radius / appState.zoom.value,
        );
        context.stroke();
        context.closePath();
      } else {
        context.strokeRect(0, 0, element.width, element.height);
      }

      context.restore();
      break;
    default:
      context.save();

      const center = elementCenterPoint(element, allElementsMap);
      const cx = center[0] + appState.scrollX;
      const cy = center[1] + appState.scrollY;

      context.translate(cx, cy);
      context.rotate(element.angle as Radians);
      context.translate(-cx, -cy);

      context.translate(
        element.x + appState.scrollX - offset,
        element.y + appState.scrollY - offset,
      );

      context.lineWidth =
        clamp(2.5, element.strokeWidth * 1.75, 4) /
        Math.max(0.25, appState.zoom.value);
      context.strokeStyle =
        appState.theme === THEME.DARK
          ? `rgba(3, 93, 161, ${opacity / 2})`
          : `rgba(106, 189, 252, ${opacity / 2})`;

      switch (element.type) {
        case "ellipse":
          context.beginPath();
          context.ellipse(
            (element.width + offset * 2) / 2,
            (element.height + offset * 2) / 2,
            (element.width + offset * 2) / 2,
            (element.height + offset * 2) / 2,
            0,
            0,
            2 * Math.PI,
          );
          context.closePath();
          context.stroke();
          break;
        case "diamond":
          {
            const [segments, curves] = deconstructDiamondElement(
              element,
              offset,
            );

            // Draw each line segment individually
            segments.forEach((segment) => {
              context.beginPath();
              context.moveTo(
                segment[0][0] - element.x + offset,
                segment[0][1] - element.y + offset,
              );
              context.lineTo(
                segment[1][0] - element.x + offset,
                segment[1][1] - element.y + offset,
              );
              context.stroke();
            });

            // Draw each curve individually (for rounded corners)
            curves.forEach((curve) => {
              const [start, control1, control2, end] = curve;
              context.beginPath();
              context.moveTo(
                start[0] - element.x + offset,
                start[1] - element.y + offset,
              );
              context.bezierCurveTo(
                control1[0] - element.x + offset,
                control1[1] - element.y + offset,
                control2[0] - element.x + offset,
                control2[1] - element.y + offset,
                end[0] - element.x + offset,
                end[1] - element.y + offset,
              );
              context.stroke();
            });
          }

          break;
        default:
          {
            const [segments, curves] = deconstructRectanguloidElement(
              element,
              offset,
            );

            // Draw each line segment individually
            segments.forEach((segment) => {
              context.beginPath();
              context.moveTo(
                segment[0][0] - element.x + offset,
                segment[0][1] - element.y + offset,
              );
              context.lineTo(
                segment[1][0] - element.x + offset,
                segment[1][1] - element.y + offset,
              );
              context.stroke();
            });

            // Draw each curve individually (for rounded corners)
            curves.forEach((curve) => {
              const [start, control1, control2, end] = curve;
              context.beginPath();
              context.moveTo(
                start[0] - element.x + offset,
                start[1] - element.y + offset,
              );
              context.bezierCurveTo(
                control1[0] - element.x + offset,
                control1[1] - element.y + offset,
                control2[0] - element.x + offset,
                control2[1] - element.y + offset,
                end[0] - element.x + offset,
                end[1] - element.y + offset,
              );
              context.stroke();
            });
          }

          break;
      }

      context.restore();

      break;
  }

  // Middle indicator is not rendered after it expired
  if (!countdownInProgress || (state?.runtime ?? 0) > BIND_MODE_TIMEOUT) {
    return;
  }

  const radius = 0.5 * (Math.min(element.width, element.height) / 2);

  // Draw center snap area
  if (!isFrameLikeElement(element)) {
    context.save();
    context.translate(
      element.x + appState.scrollX,
      element.y + appState.scrollY,
    );

    const PROGRESS_RATIO = (1 / BIND_MODE_TIMEOUT) * remainingTime;

    context.strokeStyle = "rgba(0, 0, 0, 0.2)";
    context.lineWidth = 1 / appState.zoom.value;
    context.setLineDash(getWideIndicatorLineDash(appState.zoom.value));
    context.lineDashOffset = (-PROGRESS_RATIO * 10) / appState.zoom.value;

    context.beginPath();
    context.ellipse(
      element.width / 2,
      element.height / 2,
      radius,
      radius,
      0,
      0,
      2 * Math.PI,
    );
    context.stroke();

    // context.strokeStyle = "transparent";
    context.fillStyle = "rgba(0, 0, 0, 0.04)";
    context.beginPath();
    context.ellipse(
      element.width / 2,
      element.height / 2,
      radius * (1 - opacity),
      radius * (1 - opacity),
      0,
      0,
      2 * Math.PI,
    );

    context.fill();

    context.restore();

    if (
      appState.isMidpointSnappingEnabled &&
      !appState.gridModeEnabled &&
      (!app.lastPointerMoveEvent ||
        !shouldRotateWithDiscreteAngle(app.lastPointerMoveEvent))
    ) {
      // Draw midpoint indicators
      context.save();
      context.translate(
        element.x + appState.scrollX,
        element.y + appState.scrollY,
      );

      const midpointRadius = 5 / appState.zoom.value;
      const cutoutPadding = 5 / appState.zoom.value;
      const cutoutRadius = midpointRadius + cutoutPadding;

      let midpoints;
      if (element.type === "diamond") {
        const [, curves] = deconstructDiamondElement(element);
        const center = elementCenterPoint(element, allElementsMap);

        midpoints = curves.map((curve) => {
          const point = bezierEquation(curve, 0.5);
          const rotatedPoint = pointRotateRads(point, center, element.angle);
          return {
            x: rotatedPoint[0] - element.x,
            y: rotatedPoint[1] - element.y,
          };
        });
      } else {
        const center = elementCenterPoint(element, allElementsMap);
        const basePoints = [
          { x: element.width / 2, y: 0 }, // TOP
          { x: element.width, y: element.height / 2 }, // RIGHT
          { x: element.width / 2, y: element.height }, // BOTTOM
          { x: 0, y: element.height / 2 }, // LEFT
        ];
        midpoints = basePoints.map((point) => {
          const globalPoint = pointFrom<GlobalPoint>(
            point.x + element.x,
            point.y + element.y,
          );
          const rotatedPoint = pointRotateRads(
            globalPoint,
            center,
            element.angle,
          );
          return {
            x: rotatedPoint[0] - element.x,
            y: rotatedPoint[1] - element.y,
          };
        });
      }

      // Clear cutouts around midpoints
      midpoints.forEach((midpoint) => {
        context.clearRect(
          midpoint.x - cutoutRadius,
          midpoint.y - cutoutRadius,
          cutoutRadius * 2,
          cutoutRadius * 2,
        );
      });

      context.fillStyle =
        appState.theme === THEME.DARK
          ? `rgba(3, 93, 161, ${opacity})`
          : `rgba(106, 189, 252, ${opacity})`;

      midpoints.forEach((midpoint) => {
        context.beginPath();
        context.arc(midpoint.x, midpoint.y, midpointRadius, 0, 2 * Math.PI);
        context.fill();
      });

      context.restore();
    }
  }

  return {
    runtime: (state?.runtime ?? 0) + deltaTime,
  };
};

const renderBindingHighlightForBindableElement = (
  app: AppClassProperties,
  context: CanvasRenderingContext2D,
  suggestedBinding: AppState["suggestedBinding"],
  allElementsMap: NonDeletedSceneElementsMap,
  appState: InteractiveCanvasAppState,
  deltaTime: number,
  state?: { runtime: number },
) => {
  if (suggestedBinding === null) {
    return;
  }

  if (getFeatureFlag("COMPLEX_BINDINGS")) {
    return renderBindingHighlightForBindableElement_complex(
      app,
      context,
      suggestedBinding.element,
      allElementsMap,
      appState,
      deltaTime,
      state,
    );
  }

  context.save();
  context.translate(appState.scrollX, appState.scrollY);
  const pointerCoords = app.lastPointerMoveCoords
    ? pointFrom<GlobalPoint>(
        app.lastPointerMoveCoords.x,
        app.lastPointerMoveCoords.y,
      )
    : null;
  const angleLocked =
    !!app.lastPointerMoveEvent &&
    shouldRotateWithDiscreteAngle(app.lastPointerMoveEvent);
  renderBindingHighlightForBindableElement_simple(
    context,
    suggestedBinding,
    allElementsMap,
    appState,
    pointerCoords,
    angleLocked,
  );
  context.restore();
};

type ElementSelectionBorder = {
  angle: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  selectionColors: string[];
  dashed?: boolean;
  cx: number;
  cy: number;
  activeEmbeddable: boolean;
  padding?: number;
};

const renderSelectionBorder = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  elementProperties: ElementSelectionBorder,
) => {
  const {
    angle,
    x1,
    y1,
    x2,
    y2,
    selectionColors,
    cx,
    cy,
    dashed,
    activeEmbeddable,
  } = elementProperties;
  const elementWidth = x2 - x1;
  const elementHeight = y2 - y1;

  const padding =
    elementProperties.padding ?? DEFAULT_TRANSFORM_HANDLE_SPACING * 2;

  const linePadding = padding / appState.zoom.value;
  const lineWidth = 8 / appState.zoom.value;
  const spaceWidth = 4 / appState.zoom.value;

  context.save();
  context.translate(appState.scrollX, appState.scrollY);
  context.lineWidth = (activeEmbeddable ? 4 : 1) / appState.zoom.value;

  const count = selectionColors.length;
  for (let index = 0; index < count; ++index) {
    context.strokeStyle = selectionColors[index];
    if (dashed) {
      context.setLineDash([
        lineWidth,
        spaceWidth + (lineWidth + spaceWidth) * (count - 1),
      ]);
    }
    context.lineDashOffset = (lineWidth + spaceWidth) * index;
    strokeRectWithRotation_simple(
      context,
      x1 - linePadding,
      y1 - linePadding,
      elementWidth + linePadding * 2,
      elementHeight + linePadding * 2,
      cx,
      cy,
      angle,
    );
  }
  context.restore();
};

/**
 * VERSION-LOG: the selection halo — a thick green tracing of each
 * selected element's own silhouette.
 *
 * The dashed boxes upstream draws are a poor answer to "what is selected"
 * in this fork: an arrow has no box at all now (see `hasBoundingBox`), a
 * single selection's box is easily read as a transform frame rather than
 * a membership marker, and a multi-selection stacks per-element boxes,
 * group boxes and the common box until none of them reads as anything.
 * Tracing the shape itself can't be ambiguous — the mark is *on* the
 * thing that's selected.
 *
 * Green, not blue: blue is already spoken for several times over in this
 * editor — frame highlights, binding suggestions, the link affordance,
 * remote cursors — so a blue halo would be one more thing to
 * disambiguate rather than the unambiguous answer it's meant to be.
 *
 * It also has to be unmistakably editor chrome rather than artwork,
 * since a user can draw a green stroke of any width. Nothing about the
 * colour alone can guarantee that, so the halo leans on properties a
 * drawn stroke doesn't have: it's translucent while the shape underneath
 * stays fully opaque, it's much wider than any default stroke width, and
 * it holds that width in *screen* space, so it doesn't scale with zoom.
 *
 * Drawn as one path per element and stroked once, so the overlaps where
 * segments meet don't compound the alpha into darker blobs at corners.
 */
const SELECTION_HALO_COLOR = "rgba(0, 184, 100, 0.4)";
/** Screen-space px, i.e. divided by zoom before use. */
const SELECTION_HALO_WIDTH = 10;

const renderSelectionHalo = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  selectedElements: readonly NonDeletedExcalidrawElement[],
  elementsMap: ElementsMap,
) => {
  if (selectedElements.length === 0) {
    return;
  }

  context.save();
  context.translate(appState.scrollX, appState.scrollY);
  context.setLineDash([]);
  context.strokeStyle = SELECTION_HALO_COLOR;
  context.lineWidth = SELECTION_HALO_WIDTH / appState.zoom.value;
  context.lineCap = "round";
  context.lineJoin = "round";

  for (const element of selectedElements) {
    // a frame's own border already reads as a container edge, and a halo
    // on it would swamp everything inside
    if (isFrameLikeElement(element)) {
      continue;
    }
    context.beginPath();
    // `getElementLineSegments` samples curves and rounded corners into
    // segments, so this follows the real outline for every element type —
    // including arrows, which is the case the boxes never covered.
    for (const [from, to] of getElementLineSegments(element, elementsMap)) {
      context.moveTo(from[0], from[1]);
      context.lineTo(to[0], to[1]);
    }
    context.stroke();
  }

  context.restore();
};

const renderFrameHighlight = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  frame: NonDeleted<ExcalidrawFrameLikeElement>,
  elementsMap: ElementsMap,
) => {
  const [x1, y1, x2, y2] = getElementAbsoluteCoords(frame, elementsMap);
  const width = x2 - x1;
  const height = y2 - y1;

  context.strokeStyle = "rgb(0,118,255)";
  context.lineWidth = FRAME_STYLE.strokeWidth / appState.zoom.value;

  context.save();
  context.translate(appState.scrollX, appState.scrollY);
  strokeRectWithRotation_simple(
    context,
    x1,
    y1,
    width,
    height,
    x1 + width / 2,
    y1 + height / 2,
    frame.angle,
    false,
    FRAME_STYLE.radius / appState.zoom.value,
  );
  context.restore();
};

const renderElementsBoxHighlight = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  elements: readonly NonDeletedExcalidrawElement[],
  config?: { colors?: string[]; dashed?: boolean },
) => {
  const { colors = ["rgb(0,118,255)"], dashed = false } = config || {};
  const individualElements = elements.filter(
    (element) => element.groupIds.length === 0,
  );

  const elementsInGroups = elements.filter(
    (element) => element.groupIds.length > 0,
  );

  const getSelectionFromElements = (elements: ExcalidrawElement[]) => {
    const [x1, y1, x2, y2] = getCommonBounds(elements);
    return {
      angle: 0,
      x1,
      x2,
      y1,
      y2,
      selectionColors: colors,
      dashed,
      cx: x1 + (x2 - x1) / 2,
      cy: y1 + (y2 - y1) / 2,
      activeEmbeddable: false,
    };
  };

  const getSelectionForGroupId = (groupId: GroupId) => {
    const groupElements = getElementsInGroup(elements, groupId);
    return getSelectionFromElements(groupElements);
  };

  Object.entries(selectGroupsFromGivenElements(elementsInGroups, appState))
    .filter(([id, isSelected]) => isSelected)
    .map(([id, isSelected]) => id)
    .map((groupId) => getSelectionForGroupId(groupId))
    .concat(
      individualElements.map((element) => getSelectionFromElements([element])),
    )
    .forEach((selection) =>
      renderSelectionBorder(context, appState, selection),
    );
};

const renderLinearPointHandles = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  element: NonDeleted<ExcalidrawLinearElement>,
  elementsMap: RenderableElementsMap,
) => {
  if (!appState.selectedLinearElement) {
    return;
  }
  context.save();
  context.translate(appState.scrollX, appState.scrollY);
  context.lineWidth = 1 / appState.zoom.value;
  const points: GlobalPoint[] = LinearElementEditor.getPointsGlobalCoordinates(
    element,
    elementsMap,
  );

  const { POINT_HANDLE_SIZE } = LinearElementEditor;
  const radius = appState.selectedLinearElement?.isEditing
    ? POINT_HANDLE_SIZE
    : POINT_HANDLE_SIZE / 2;

  const _isElbowArrow = isElbowArrow(element);
  const _isLineElement = isLineElement(element);

  points.forEach((point, idx) => {
    if (_isElbowArrow && idx !== 0 && idx !== points.length - 1) {
      return;
    }

    const isOverlappingPoint =
      idx > 0 &&
      (idx !== points.length - 1 || !_isLineElement || !element.polygon) &&
      pointsEqual(
        point,
        idx === points.length - 1 ? points[0] : points[idx - 1],
        2 / appState.zoom.value,
      );

    let isSelected =
      !!appState.selectedLinearElement?.isEditing &&
      !!appState.selectedLinearElement?.selectedPointsIndices?.includes(idx);
    // when element is a polygon, highlight the last point as well if first
    // point is selected since they overlap and the last point tends to be
    // rendered on top
    if (
      _isLineElement &&
      element.polygon &&
      !isSelected &&
      idx === element.points.length - 1 &&
      !!appState.selectedLinearElement?.isEditing &&
      !!appState.selectedLinearElement?.selectedPointsIndices?.includes(0)
    ) {
      isSelected = true;
    }

    renderSingleLinearPoint(
      context,
      appState,
      point,
      radius,
      isSelected,
      false,
      isOverlappingPoint,
    );
  });

  // Rendering segment mid points
  if (isElbowArrow(element)) {
    const fixedSegments =
      element.fixedSegments?.map((segment) => segment.index) || [];
    points.slice(0, -1).forEach((p, idx) => {
      if (
        !LinearElementEditor.isSegmentTooShort(
          element,
          points[idx + 1],
          points[idx],
          idx,
          appState.zoom,
          elementsMap,
        )
      ) {
        renderSingleLinearPoint(
          context,
          appState,
          pointFrom<GlobalPoint>(
            (p[0] + points[idx + 1][0]) / 2,
            (p[1] + points[idx + 1][1]) / 2,
          ),
          POINT_HANDLE_SIZE / 2,
          false,
          !fixedSegments.includes(idx + 1),
          false,
        );
      }
    });
  } else {
    const midPoints = LinearElementEditor.getEditorMidPoints(
      element,
      elementsMap,
      appState,
    ).filter(
      (midPoint, idx, midPoints): midPoint is GlobalPoint =>
        midPoint !== null &&
        !(isElbowArrow(element) && (idx === 0 || idx === midPoints.length - 1)),
    );

    midPoints.forEach((segmentMidPoint) => {
      if (appState.selectedLinearElement?.isEditing || points.length === 2) {
        renderSingleLinearPoint(
          context,
          appState,
          segmentMidPoint,
          POINT_HANDLE_SIZE / 2,
          false,
          true,
          false,
        );
      }
    });
  }

  context.restore();
};

/** Colour of the binding affordances — the focus-point padlock and its
 * connection line. A violet kept distinct from the red alignment
 * vocabulary, because a binding is a different kind of relationship. */
const BINDING_INDICATOR_COLOR = "rgba(134, 131, 226, 0.6)";
const BINDING_INDICATOR_COLOR_HOVER = "rgba(134, 131, 226, 0.9)";

const renderFocusPointConnectionLine = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  fromPoint: GlobalPoint,
  toPoint: GlobalPoint,
) => {
  context.save();
  context.translate(appState.scrollX, appState.scrollY);

  context.strokeStyle = BINDING_INDICATOR_COLOR;
  context.lineWidth = 1 / appState.zoom.value;
  context.setLineDash(getWideIndicatorLineDash(appState.zoom.value));

  context.beginPath();
  context.moveTo(fromPoint[0], fromPoint[1]);
  context.lineTo(toPoint[0], toPoint[1]);
  context.stroke();

  context.restore();
};

const renderFocusPointCicle = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  point: GlobalPoint,
  radius: number,
  isHovered: boolean,
) => {
  context.save();
  context.translate(appState.scrollX, appState.scrollY);
  context.strokeStyle = BINDING_INDICATOR_COLOR;
  context.lineWidth = 1 / appState.zoom.value;
  context.setLineDash([]);
  context.fillStyle = isHovered
    ? BINDING_INDICATOR_COLOR_HOVER
    : "rgba(255, 255, 255, 0.9)";

  fillCircle(
    context,
    point[0],
    point[1],
    radius / appState.zoom.value,
    true,
    true,
  );
  context.restore();
};

/**
 * Colour of the endpoint padlocks — the point handles' own stroke, so the
 * badge reads as part of that control rather than a separate mark.
 */
const BINDING_LOCK_COLOR = "#5e5ad8";

/**
 * The same padlock, washed out, for an endpoint surfaced because the
 * *shape* is selected rather than the arrow. There is no point handle
 * under it then — nothing to grab, nothing to drag — so it is pure
 * annotation, and the lighter weight says so before the user tries.
 */
const BINDING_LOCK_COLOR_PASSIVE = "#aeacec";

/** Just enough white behind the passive padlock to keep it readable when
 * the arrow's own stroke runs through it — well short of the solid disc
 * that makes the interactive badge look pressable. */
const BINDING_LOCK_PASSIVE_BACKING = 0.6;

/**
 * A padlock over each bound arrow endpoint the current selection makes
 * relevant, saying "this end is attached to that shape". Drawn on top of
 * the point handle it belongs to, so it marks the thing the user would
 * grab to detach it.
 *
 * A binding is a relationship, so either end of it can be the reason to
 * show the badge: selecting the arrow surfaces both of its bound ends,
 * and selecting a shape surfaces the ends bound *to that shape* — not the
 * far ends, which belong to a relationship the user hasn't asked about.
 *
 * This is the product-facing half of what Visual Debug shows as the ∞ on
 * a binding; the debug view draws both directions of the relationship
 * because it is checking them against each other, whereas here one badge
 * per bound endpoint is the whole story.
 */
const renderBindingLocks = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  selectedElements: readonly NonDeletedExcalidrawElement[],
  elementsMap: NonDeletedSceneElementsMap,
) => {
  // (arrow, end) pairs to mark, deduped — a selected arrow bound to a
  // selected shape is reached from both sides. `onHandle` records whether
  // the arrow itself is selected, i.e. whether there is a point handle
  // under the badge; reaching the same endpoint both ways keeps it.
  const marks = new Map<
    string,
    {
      arrow: NonDeleted<ExcalidrawArrowElement>;
      type: "start" | "end";
      onHandle: boolean;
    }
  >();

  const mark = (
    arrow: NonDeleted<ExcalidrawArrowElement>,
    type: "start" | "end",
    onHandle: boolean,
  ) => {
    const binding = type === "start" ? arrow.startBinding : arrow.endBinding;
    const bindableElement =
      binding?.elementId && elementsMap.get(binding.elementId);

    if (
      !bindableElement ||
      !isBindableElement(bindableElement) ||
      bindableElement.isDeleted
    ) {
      return;
    }
    const key = `${arrow.id}:${type}`;
    marks.set(key, {
      arrow,
      type,
      onHandle: onHandle || !!marks.get(key)?.onHandle,
    });
  };

  for (const element of selectedElements) {
    if (element.locked) {
      continue;
    }

    if (isArrowElement(element)) {
      mark(element, "start", true);
      mark(element, "end", true);
    }

    // arrows bound to this shape, via its own record of them
    for (const bound of element.boundElements ?? []) {
      if (bound.type !== "arrow") {
        continue;
      }
      const arrow = elementsMap.get(bound.id);
      if (!arrow || !isArrowElement(arrow) || arrow.isDeleted) {
        continue;
      }
      if (arrow.startBinding?.elementId === element.id) {
        mark(arrow, "start", false);
      }
      if (arrow.endBinding?.elementId === element.id) {
        mark(arrow, "end", false);
      }
    }
  }

  if (marks.size === 0) {
    return;
  }

  context.save();
  context.translate(appState.scrollX, appState.scrollY);
  context.setLineDash([]);

  for (const { arrow, type, onHandle } of marks.values()) {
    const point = LinearElementEditor.getPointAtIndexGlobalCoordinates(
      arrow,
      type === "start" ? 0 : arrow.points.length - 1,
      elementsMap,
    );

    renderMidpointBindingLeader(
      context,
      appState,
      arrow,
      type,
      point,
      elementsMap,
      onHandle ? BINDING_LOCK_COLOR : BINDING_LOCK_COLOR_PASSIVE,
    );

    drawPadlock(
      context,
      point[0],
      point[1],
      appState.zoom.value,
      onHandle ? BINDING_LOCK_COLOR : BINDING_LOCK_COLOR_PASSIVE,
      true,
      // sized off the handle it covers, so the badge reads as that control
      // rather than as something sitting over it — but a couple of px
      // wider, because the padlock inside the disc makes a same-radius
      // badge look smaller than the plain dot it replaces
      LinearElementEditor.POINT_HANDLE_SIZE / 2 + 2,
      // the solid white disc is what makes a badge look like a chip you
      // can press; the passive mark keeps only a hint of it
      onHandle ? 1 : BINDING_LOCK_PASSIVE_BACKING,
    );
  }

  context.restore();
};

/** Fixed-point ratios of the four edge midpoints, and how far a stored
 * ratio may sit from one and still be that port. Loose enough to absorb
 * `normalizeFixedPoint`'s 0.5 → 0.5001 nudge and any rounding on the way
 * in, tight enough that an interior binding is never mistaken for one. */
const MIDPOINT_FIXED_POINTS: readonly (readonly [number, number])[] = [
  [0.5, 0],
  [1, 0.5],
  [0.5, 1],
  [0, 0.5],
];
const MIDPOINT_FIXED_POINT_EPSILON = 0.02;

/** Below this screen-space distance the endpoint is close enough to its
 * port that a leader would be a smudge rather than an explanation. */
const MIDPOINT_LEADER_MIN_GAP = 6;

/**
 * VERSION-LOG: a dashed leader from an arrow's endpoint to the edge
 * midpoint it is bound to, drawn only when the two aren't in the same
 * place.
 *
 * An arrow bound to a port does not necessarily *touch* it: the visible
 * attachment is resolved to the outline crossing nearest the arrow's
 * other end (`updateBoundPoint`), so an arrow approaching from a shallow
 * angle lands somewhere else on the perimeter entirely. The binding is
 * correct and behaves correctly, but on screen it looks arbitrary —
 * there is nothing to say which port it belongs to.
 *
 * The leader says it. It is the same relationship debug mode draws
 * between an arrow and its binding, promoted to something a user can
 * see, and it costs nothing when the endpoint is already on its port.
 */
const renderMidpointBindingLeader = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  arrow: NonDeleted<ExcalidrawArrowElement>,
  type: "start" | "end",
  endpoint: GlobalPoint,
  elementsMap: NonDeletedSceneElementsMap,
  color: string,
) => {
  const binding = type === "start" ? arrow.startBinding : arrow.endBinding;
  const target = binding && elementsMap.get(binding.elementId);
  if (!binding || !target || !isBindableElement(target)) {
    return;
  }
  const isMidpoint = MIDPOINT_FIXED_POINTS.some(
    ([mx, my]) =>
      Math.abs(binding.fixedPoint[0] - mx) <= MIDPOINT_FIXED_POINT_EPSILON &&
      Math.abs(binding.fixedPoint[1] - my) <= MIDPOINT_FIXED_POINT_EPSILON,
  );
  if (!isMidpoint) {
    return;
  }

  const zoom = appState.zoom.value;
  const port = getGlobalFixedPointForBindableElement(
    binding.fixedPoint,
    target,
    elementsMap,
  );
  if (pointDistance(endpoint, port) <= MIDPOINT_LEADER_MIN_GAP / zoom) {
    return;
  }

  context.save();
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = 1 / zoom;
  context.setLineDash(getNarrowIndicatorLineDash(zoom));
  context.beginPath();
  context.moveTo(endpoint[0], endpoint[1]);
  context.lineTo(port[0], port[1]);
  context.stroke();

  // a dot on the port end, so the leader reads as pointing *at* something
  context.setLineDash([]);
  context.beginPath();
  context.arc(port[0], port[1], 2 / zoom, 0, Math.PI * 2);
  context.fill();
  context.restore();
};

const renderFocusPointIndicator = ({
  arrow,
  appState,
  type,
  context,
  elementsMap,
}: {
  arrow: NonDeleted<ExcalidrawArrowElement>;
  appState: InteractiveCanvasAppState;
  context: CanvasRenderingContext2D;
  elementsMap: NonDeletedSceneElementsMap;
  type: "start" | "end";
}) => {
  const binding = type === "start" ? arrow.startBinding : arrow.endBinding;
  const bindableElement =
    binding?.elementId && elementsMap.get(binding.elementId);

  if (
    !bindableElement ||
    !isBindableElement(bindableElement) ||
    bindableElement.isDeleted
  ) {
    return;
  }

  const focusPoint = getGlobalFixedPointForBindableElement(
    binding.fixedPoint,
    bindableElement,
    elementsMap,
  );

  // Only render if focus point is within the bindable element
  if (
    !isFocusPointVisible(
      focusPoint,
      arrow,
      bindableElement,
      elementsMap,
      appState,
      type,
    )
  ) {
    return;
  }

  const linearState = appState.selectedLinearElement;
  const isDragging = !!linearState?.isDragging;
  const pointIndex = type === "start" ? 0 : arrow.points.length - 1;
  const pointSelected =
    !!linearState?.selectedPointsIndices?.includes(pointIndex);

  // render focus point highlight
  // ----------------------------

  if (
    linearState?.hoveredFocusPointBinding === type &&
    !linearState.draggedFocusPointBinding
  ) {
    highlightPoint(focusPoint, context, appState);
  }

  // render focus point
  // ----------------------------

  if (!(pointSelected && isDragging)) {
    const focusPoint = getGlobalFixedPointForBindableElement(
      binding.fixedPoint,
      bindableElement,
      elementsMap,
    );

    const isHovered = linearState?.hoveredFocusPointBinding === type;

    // Render dashed line from arrow start point to focus point
    const arrowPoint = LinearElementEditor.getPointAtIndexGlobalCoordinates(
      arrow,
      pointIndex,
      elementsMap,
    );

    renderFocusPointConnectionLine(context, appState, arrowPoint, focusPoint);

    renderFocusPointCicle(
      context,
      appState,
      focusPoint,
      FOCUS_POINT_SIZE / 1.5,
      isHovered,
    );
  }
};

const renderTransformHandles = (
  context: CanvasRenderingContext2D,
  renderConfig: InteractiveCanvasRenderConfig,
  appState: InteractiveCanvasAppState,
  transformHandles: TransformHandles,
  angle: number,
): void => {
  Object.keys(transformHandles).forEach((key) => {
    const transformHandle = transformHandles[key as TransformHandleType];
    if (transformHandle !== undefined) {
      const [x, y, width, height] = transformHandle;

      context.save();
      context.lineWidth = 1 / appState.zoom.value;
      if (renderConfig.selectionColor) {
        context.strokeStyle = renderConfig.selectionColor;
      }
      if (key === "rotation") {
        fillCircle(context, x + width / 2, y + height / 2, width / 2, true);
        // prefer round corners if roundRect API is available
      } else if (context.roundRect) {
        context.beginPath();
        context.roundRect(x, y, width, height, 2 / appState.zoom.value);
        context.fill();
        context.stroke();
      } else {
        strokeRectWithRotation_simple(
          context,
          x,
          y,
          width,
          height,
          x + width / 2,
          y + height / 2,
          angle,
          true, // fill before stroke
        );
      }
      context.restore();
    }
  });
};

const renderCropHandles = (
  context: CanvasRenderingContext2D,
  renderConfig: InteractiveCanvasRenderConfig,
  appState: InteractiveCanvasAppState,
  croppingElement: ExcalidrawImageElement,
  elementsMap: ElementsMap,
): void => {
  const [x1, y1, , , cx, cy] = getElementAbsoluteCoords(
    croppingElement,
    elementsMap,
  );

  const LINE_WIDTH = 3;
  const LINE_LENGTH = 20;

  const ZOOMED_LINE_WIDTH = LINE_WIDTH / appState.zoom.value;
  const ZOOMED_HALF_LINE_WIDTH = ZOOMED_LINE_WIDTH / 2;

  const HALF_WIDTH = cx - x1 + ZOOMED_LINE_WIDTH;
  const HALF_HEIGHT = cy - y1 + ZOOMED_LINE_WIDTH;

  const HORIZONTAL_LINE_LENGTH = Math.min(
    LINE_LENGTH / appState.zoom.value,
    HALF_WIDTH,
  );
  const VERTICAL_LINE_LENGTH = Math.min(
    LINE_LENGTH / appState.zoom.value,
    HALF_HEIGHT,
  );

  context.save();
  context.fillStyle = renderConfig.selectionColor;
  context.strokeStyle = renderConfig.selectionColor;
  context.lineWidth = ZOOMED_LINE_WIDTH;

  const handles: Array<
    [
      [number, number],
      [number, number],
      [number, number],
      [number, number],
      [number, number],
    ]
  > = [
    [
      // x, y
      [-HALF_WIDTH, -HALF_HEIGHT],
      // horizontal line: first start and to
      [0, ZOOMED_HALF_LINE_WIDTH],
      [HORIZONTAL_LINE_LENGTH, ZOOMED_HALF_LINE_WIDTH],
      // vertical line: second  start and to
      [ZOOMED_HALF_LINE_WIDTH, 0],
      [ZOOMED_HALF_LINE_WIDTH, VERTICAL_LINE_LENGTH],
    ],
    [
      [HALF_WIDTH - ZOOMED_HALF_LINE_WIDTH, -HALF_HEIGHT],
      [ZOOMED_HALF_LINE_WIDTH, ZOOMED_HALF_LINE_WIDTH],
      [
        -HORIZONTAL_LINE_LENGTH + ZOOMED_HALF_LINE_WIDTH,
        ZOOMED_HALF_LINE_WIDTH,
      ],
      [0, 0],
      [0, VERTICAL_LINE_LENGTH],
    ],
    [
      [-HALF_WIDTH, HALF_HEIGHT],
      [0, -ZOOMED_HALF_LINE_WIDTH],
      [HORIZONTAL_LINE_LENGTH, -ZOOMED_HALF_LINE_WIDTH],
      [ZOOMED_HALF_LINE_WIDTH, 0],
      [ZOOMED_HALF_LINE_WIDTH, -VERTICAL_LINE_LENGTH],
    ],
    [
      [HALF_WIDTH - ZOOMED_HALF_LINE_WIDTH, HALF_HEIGHT],
      [ZOOMED_HALF_LINE_WIDTH, -ZOOMED_HALF_LINE_WIDTH],
      [
        -HORIZONTAL_LINE_LENGTH + ZOOMED_HALF_LINE_WIDTH,
        -ZOOMED_HALF_LINE_WIDTH,
      ],
      [0, 0],
      [0, -VERTICAL_LINE_LENGTH],
    ],
  ];

  handles.forEach((handle) => {
    const [[x, y], [x1s, y1s], [x1t, y1t], [x2s, y2s], [x2t, y2t]] = handle;

    context.save();
    context.translate(cx, cy);
    context.rotate(croppingElement.angle);

    context.beginPath();
    context.moveTo(x + x1s, y + y1s);
    context.lineTo(x + x1t, y + y1t);
    context.stroke();

    context.beginPath();
    context.moveTo(x + x2s, y + y2s);
    context.lineTo(x + x2t, y + y2t);
    context.stroke();
    context.restore();
  });

  context.restore();
};

const renderTextBox = (
  text: ExcalidrawTextElement,
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  selectionColor: InteractiveCanvasRenderConfig["selectionColor"],
) => {
  context.save();
  const padding = getTextBoxPadding(appState.zoom.value);
  const width = text.width + padding * 2;
  const height = text.height + padding * 2;
  const cx = text.x + text.width / 2;
  const cy = text.y + text.height / 2;
  const shiftX = -(text.width / 2 + padding);
  const shiftY = -(text.height / 2 + padding);
  context.translate(cx + appState.scrollX, cy + appState.scrollY);
  context.rotate(text.angle);
  context.lineWidth = 1 / appState.zoom.value;
  context.strokeStyle = selectionColor;
  context.globalAlpha = 0.5;
  context.setLineDash([6 / appState.zoom.value, 4 / appState.zoom.value]);
  context.strokeRect(shiftX, shiftY, width, height);
  context.restore();
};

const renderResetAutoResizeHandle = (
  text: ExcalidrawTextElement,
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  selectionColor: InteractiveCanvasRenderConfig["selectionColor"],
  formFactor: EditorInterface["formFactor"],
) => {
  const autoResizeHandle = getTextAutoResizeHandle(
    text,
    appState.zoom.value,
    formFactor,
  );

  if (!autoResizeHandle) {
    return;
  }

  context.save();
  context.globalAlpha = 0.5;
  context.lineWidth = 1.5 / appState.zoom.value;
  context.lineCap = "round";
  context.strokeStyle = selectionColor;
  context.beginPath();
  context.moveTo(
    autoResizeHandle.start[0] + appState.scrollX,
    autoResizeHandle.start[1] + appState.scrollY,
  );
  context.lineTo(
    autoResizeHandle.end[0] + appState.scrollX,
    autoResizeHandle.end[1] + appState.scrollY,
  );
  context.stroke();
  context.restore();
};

const _renderInteractiveScene = ({
  app,
  canvas,
  elementsMap,
  visibleElements,
  selectedElements,
  allElementsMap,
  scale,
  appState,
  renderConfig,
  editorInterface,
  animationState,
  deltaTime,
}: InteractiveSceneRenderConfig): {
  scrollBars?: ReturnType<typeof getScrollBars>;
  animationState?: typeof animationState;
} => {
  if (canvas === null) {
    return {};
  }

  const [normalizedWidth, normalizedHeight] = getNormalizedCanvasDimensions(
    canvas,
    scale,
  );
  let nextAnimationState = animationState;

  const context = bootstrapCanvas({
    canvas,
    scale,
    normalizedWidth,
    normalizedHeight,
  });

  // Apply zoom
  context.save();
  context.scale(appState.zoom.value, appState.zoom.value);

  let editingLinearElement: NonDeleted<ExcalidrawLinearElement> | undefined =
    undefined;

  visibleElements.forEach((element) => {
    // Getting the element using LinearElementEditor during collab mismatches version - being one head of visible elements due to
    // ShapeCache returns empty hence making sure that we get the
    // correct element from visible elements
    if (
      appState.selectedLinearElement?.isEditing &&
      appState.selectedLinearElement.elementId === element.id
    ) {
      if (element) {
        editingLinearElement = element as NonDeleted<ExcalidrawLinearElement>;
      }
    }
  });

  if (editingLinearElement) {
    renderLinearPointHandles(
      context,
      appState,
      editingLinearElement,
      elementsMap,
    );
  }

  // Paint selection element
  if (appState.selectionElement && !appState.isCropping) {
    try {
      renderSelectionElement(
        appState.selectionElement,
        context,
        appState,
        renderConfig.selectionColor,
      );
    } catch (error: any) {
      console.error(error);
    }
  }

  const activeTextElement = getActiveTextElement(selectedElements, appState);

  if (activeTextElement && !activeTextElement.autoResize) {
    renderResetAutoResizeHandle(
      activeTextElement,
      context,
      appState,
      renderConfig.selectionColor,
      editorInterface.formFactor,
    );
  }

  if (appState.editingTextElement) {
    const textElement = allElementsMap.get(appState.editingTextElement.id) as
      | ExcalidrawTextElement
      | undefined;
    if (textElement && !textElement.autoResize) {
      renderTextBox(
        textElement,
        context,
        appState,
        renderConfig.selectionColor,
      );
    }
  }

  if (appState.isBindingEnabled && appState.suggestedBinding) {
    nextAnimationState = {
      ...animationState,
      bindingHighlight: renderBindingHighlightForBindableElement(
        app,
        context,
        appState.suggestedBinding,
        allElementsMap,
        appState,
        deltaTime,
        animationState?.bindingHighlight,
      ),
    };
  } else {
    nextAnimationState = {
      ...animationState,
      bindingHighlight: undefined,
    };
  }

  if (appState.hoveredArrowTextAnchor) {
    renderHoveredArrowTextAnchor(context, appState, allElementsMap);
  }

  if (appState.frameToHighlight) {
    renderFrameHighlight(
      context,
      appState,
      appState.frameToHighlight,
      elementsMap,
    );
  }

  if (appState.elementsToHighlight) {
    renderElementsBoxHighlight(context, appState, appState.elementsToHighlight);
  }

  // version-log DEBUG: dashed outlines via a manually-set appState
  // field. Not wired to any UI today; kept around so we can poke
  // `debugVersionLogHighlightedElementIds` from DevTools when
  // diagnosing what `getOperationElementIds` is returning.
  if (appState.debugVersionLogHighlightedElementIds) {
    const ids = Object.keys(appState.debugVersionLogHighlightedElementIds);
    if (ids.length > 0) {
      const vlColor = "rgb(255,140,0)";
      for (const id of ids) {
        const element = allElementsMap.get(id);
        if (!element) {
          continue;
        }
        const [x1, y1, x2, y2] = getCommonBounds([element]);
        renderSelectionBorder(context, appState, {
          angle: 0,
          x1,
          x2,
          y1,
          y2,
          selectionColors: [vlColor],
          dashed: false,
          cx: x1 + (x2 - x1) / 2,
          cy: y1 + (y2 - y1) / 2,
          activeEmbeddable: false,
        });
      }
    }
  }

  // version-log hover preview: ghosts (low-alpha element renders) +
  // group / ungroup bboxes. Driven by mousing over a row in the
  // version-log sidebar. See packages/excalidraw/versionLog/hoverPreview.ts.
  if (appState.versionLogHoverPreview) {
    const { ghosts, bboxes } = appState.versionLogHoverPreview;

    // Ghost elements: render each at low alpha using the same
    // per-element renderer the static canvas uses. We translate by
    // (scrollX, scrollY) to match the canvas coords the static scene
    // already uses for these renderers.
    if (ghosts.length > 0) {
      const rc = rough.canvas(canvas);
      const ghostRenderConfig = {
        // Minimal config — most fields are only consulted by code
        // paths that don't apply to hover (export, eraser tool, etc.).
        canvasBackgroundColor: "#ffffff" as AppState["viewBackgroundColor"],
        imageCache: app.imageCache,
        renderGrid: false,
        isExporting: false,
        embedsValidationStatus: new Map(),
        elementsPendingErasure: new Set<string>(),
        pendingFlowchartNodes: null,
        theme: appState.theme,
      };

      for (const ghost of ghosts) {
        // Deleted ghost? We still want to draw them (e.g. the
        // pre-delete preview), so force isDeleted: false on a clone.
        const drawable =
          ghost.isDeleted === false
            ? ghost
            : ({ ...ghost, isDeleted: false } as typeof ghost);
        context.save();
        // `globalAlpha` doesn't work here — `renderElement` resets it
        // to 1 via `getRenderOpacity` before drawing. CSS-style
        // `filter` composes at draw time and is not touched by that
        // path, so the ghost actually comes out translucent.
        context.filter = "opacity(0.35)";
        try {
          renderElement(
            drawable as NonDeleted<ExcalidrawElement>,
            elementsMap,
            allElementsMap,
            rc,
            context,
            ghostRenderConfig,
            appState,
          );
        } catch (e) {
          // Per-ghost render shouldn't be able to take down the
          // whole interactive scene.
          // eslint-disable-next-line no-console
          console.warn("[version-log] ghost render failed", e);
        }
        context.restore();
      }
    }

    // Group / ungroup bboxes: one teal box per entry, enclosing every
    // element in its `elementIds` list.
    if (bboxes.length > 0) {
      const bboxColor = "rgb(11,114,133)";
      for (const { elementIds } of bboxes) {
        const elements: ExcalidrawElement[] = [];
        for (const id of elementIds) {
          const el = allElementsMap.get(id);
          if (el) {
            elements.push(el);
          }
        }
        if (elements.length === 0) {
          continue;
        }
        const [x1, y1, x2, y2] = getCommonBounds(elements);
        renderSelectionBorder(context, appState, {
          angle: 0,
          x1,
          x2,
          y1,
          y2,
          selectionColors: [bboxColor],
          dashed: false,
          cx: x1 + (x2 - x1) / 2,
          cy: y1 + (y2 - y1) / 2,
          activeEmbeddable: false,
        });
      }
    }
  }

  if (appState.activeLockedId) {
    const element = allElementsMap.get(appState.activeLockedId);
    const elements = element
      ? [element]
      : getElementsInGroup(allElementsMap, appState.activeLockedId);
    renderElementsBoxHighlight(
      context,
      appState,
      elements as NonDeletedExcalidrawElement[], // We don't typecheck runtime because of performance
      {
        colors: ["#ced4da"],
        dashed: true,
      },
    );
  }

  const isFrameSelected = selectedElements.some((element) =>
    isFrameLikeElement(element),
  );

  // Getting the element using LinearElementEditor during collab mismatches version - being one head of visible elements due to
  // ShapeCache returns empty hence making sure that we get the
  // correct element from visible elements
  if (
    selectedElements.length === 1 &&
    appState.selectedLinearElement?.isEditing &&
    appState.selectedLinearElement.elementId === selectedElements[0].id
  ) {
    renderLinearPointHandles(
      context,
      appState,
      selectedElements[0] as NonDeleted<ExcalidrawLinearElement>,
      elementsMap,
    );
  }

  const linearState = appState.selectedLinearElement;
  // `selectedLinearElement` outlives the selection: clicking a shape while
  // an arrow is selected leaves the editor pointing at that arrow (see the
  // `: prevState.selectedLinearElement` fallback in App's pointer-up
  // selection). Its affordances — endpoint highlights, focus points — must
  // follow the actual selection, or they appear on an arrow the user has
  // already moved on from. `renderLinearPointHandles` below always made
  // this check; the hover affordances did not.
  const selectedLinearElement =
    linearState &&
    appState.selectedElementIds[linearState.elementId] &&
    LinearElementEditor.getElement(linearState.elementId, allElementsMap);
  // Arrows have a different highlight behavior when
  // they are the only selected element
  if (selectedLinearElement) {
    if (!appState.selectedLinearElement.isDragging) {
      if (linearState.segmentMidPointHoveredCoords) {
        renderElbowArrowMidPointHighlight(context, appState);
      } else if (
        isElbowArrow(selectedLinearElement)
          ? linearState.hoverPointIndex === 0 ||
            linearState.hoverPointIndex ===
              selectedLinearElement.points.length - 1
          : linearState.hoverPointIndex >= 0
      ) {
        renderLinearElementPointHighlight(context, appState, elementsMap);
      }
    }

    if (isArrowElement(selectedLinearElement)) {
      renderFocusPointIndicator({
        arrow: selectedLinearElement,
        elementsMap: allElementsMap,
        appState,
        context,
        type: "start",
      });

      renderFocusPointIndicator({
        arrow: selectedLinearElement,
        elementsMap: allElementsMap,
        appState,
        context,
        type: "end",
      });
    }
  }

  // Paint selected elements
  if (
    !appState.multiElement &&
    !appState.newElement &&
    !appState.selectedLinearElement?.isEditing
  ) {
    const showBoundingBox = hasBoundingBox(
      selectedElements,
      appState,
      editorInterface,
    );

    // under the point handles / badges, so those stay legible on top of it
    renderSelectionHalo(context, appState, selectedElements, elementsMap);

    const isSingleLinearElementSelected =
      selectedElements.length === 1 && isLinearElement(selectedElements[0]);
    // render selected linear element points
    if (
      isSingleLinearElementSelected &&
      appState.selectedLinearElement?.elementId === selectedElements[0].id &&
      !selectedElements[0].locked
    ) {
      renderLinearPointHandles(
        context,
        appState,
        selectedElements[0] as NonDeleted<ExcalidrawLinearElement>,
        elementsMap,
      );
    }

    // after the point handles, so a badge sits on top of the endpoint dot
    renderBindingLocks(context, appState, selectedElements, allElementsMap);

    const selectionColor = renderConfig.selectionColor || "#000";

    if (showBoundingBox) {
      // Optimisation for finding quickly relevant element ids
      const locallySelectedIds = arrayToMap(selectedElements);

      const selections: ElementSelectionBorder[] = [];

      for (const element of elementsMap.values()) {
        const selectionColors = [];
        const remoteClients = renderConfig.remoteSelectedElementIds.get(
          element.id,
        );
        if (
          !(
            // Elbow arrow elements cannot be selected when bound on either end
            (
              isSingleLinearElementSelected &&
              isElbowArrow(element) &&
              (element.startBinding || element.endBinding)
            )
          )
        ) {
          // local user
          if (
            locallySelectedIds.has(element.id) &&
            !isSelectedViaGroup(appState, element)
          ) {
            selectionColors.push(selectionColor);
          }
          // remote users
          if (remoteClients) {
            selectionColors.push(
              ...remoteClients.map((socketId) => {
                const background = getClientColor(
                  socketId,
                  appState.collaborators.get(socketId),
                );
                return background;
              }),
            );
          }
        }

        if (selectionColors.length) {
          const [x1, y1, x2, y2, cx, cy] = getElementAbsoluteCoords(
            element,
            elementsMap,
            true,
          );
          selections.push({
            angle: element.angle,
            x1,
            y1,
            x2,
            y2,
            selectionColors: element.locked ? ["#ced4da"] : selectionColors,
            // always dashed (upstream dashes only remote/locked selections)
            dashed: true,
            cx,
            cy,
            activeEmbeddable:
              appState.activeEmbeddable?.element === element &&
              appState.activeEmbeddable.state === "active",
            padding:
              element.id === appState.croppingElementId ||
              isImageElement(element)
                ? 0
                : undefined,
          });
        }
      }

      const addSelectionForGroupId = (groupId: GroupId) => {
        const groupElements = getElementsInGroup(elementsMap, groupId);
        const [x1, y1, x2, y2] = getCommonBounds(groupElements);
        selections.push({
          angle: 0,
          x1,
          x2,
          y1,
          y2,
          selectionColors: groupElements.some((el) => el.locked)
            ? ["#ced4da"]
            : ["#000"],
          dashed: true,
          cx: x1 + (x2 - x1) / 2,
          cy: y1 + (y2 - y1) / 2,
          activeEmbeddable: false,
        });
      };

      for (const groupId of getSelectedGroupIds(appState)) {
        // TODO: support multiplayer selected group IDs
        addSelectionForGroupId(groupId);
      }

      if (appState.editingGroupId) {
        addSelectionForGroupId(appState.editingGroupId);
      }

      selections.forEach((selection) =>
        renderSelectionBorder(context, appState, selection),
      );
    }
    // Paint resize transformHandles
    context.save();
    context.translate(appState.scrollX, appState.scrollY);

    if (selectedElements.length === 1) {
      context.fillStyle = "#fff";
      const transformHandles = getTransformHandles(
        selectedElements[0],
        appState.zoom,
        elementsMap,
        "mouse", // when we render we don't know which pointer type so use mouse,
        getOmitSidesForEditorInterface(editorInterface),
      );
      if (
        !appState.viewModeEnabled &&
        showBoundingBox &&
        // do not show transform handles when text is being edited
        !isTextElement(appState.editingTextElement) &&
        // do not show transform handles when image is being cropped
        !appState.croppingElementId
      ) {
        renderTransformHandles(
          context,
          renderConfig,
          appState,
          transformHandles,
          selectedElements[0].angle,
        );
      }

      if (appState.croppingElementId && !appState.isCropping) {
        const croppingElement = elementsMap.get(appState.croppingElementId);

        if (croppingElement && isImageElement(croppingElement)) {
          renderCropHandles(
            context,
            renderConfig,
            appState,
            croppingElement,
            elementsMap,
          );
        }
      }
    } else if (
      selectedElements.length > 1 &&
      !appState.isRotating &&
      !selectedElements.some((el) => el.locked)
    ) {
      const dashedLinePadding =
        (DEFAULT_TRANSFORM_HANDLE_SPACING * 2) / appState.zoom.value;
      context.fillStyle = "#fff";
      const [x1, y1, x2, y2] = getCommonBounds(selectedElements, elementsMap);
      const initialLineDash = context.getLineDash();
      context.setLineDash([2 / appState.zoom.value]);
      const lineWidth = context.lineWidth;
      context.lineWidth = 1 / appState.zoom.value;
      context.strokeStyle = selectionColor;
      strokeRectWithRotation_simple(
        context,
        x1 - dashedLinePadding,
        y1 - dashedLinePadding,
        x2 - x1 + dashedLinePadding * 2,
        y2 - y1 + dashedLinePadding * 2,
        (x1 + x2) / 2,
        (y1 + y2) / 2,
        0,
      );
      context.lineWidth = lineWidth;
      context.setLineDash(initialLineDash);
      const transformHandles = getTransformHandlesFromCoords(
        [x1, y1, x2, y2, (x1 + x2) / 2, (y1 + y2) / 2],
        0 as Radians,
        appState.zoom,
        "mouse",
        isFrameSelected
          ? {
              ...getOmitSidesForEditorInterface(editorInterface),
              rotation: true,
            }
          : getOmitSidesForEditorInterface(editorInterface),
      );
      if (selectedElements.some((element) => !element.locked)) {
        renderTransformHandles(
          context,
          renderConfig,
          appState,
          transformHandles,
          0,
        );
      }
    }
    context.restore();
  }

  appState.searchMatches?.matches.forEach(({ id, focus, matchedLines }) => {
    const element = elementsMap.get(id);

    if (element) {
      const [elementX1, elementY1, , , cx, cy] = getElementAbsoluteCoords(
        element,
        elementsMap,
        true,
      );

      context.save();
      if (appState.theme === THEME.LIGHT) {
        if (focus) {
          context.fillStyle = "rgba(255, 124, 0, 0.4)";
        } else {
          context.fillStyle = "rgba(255, 226, 0, 0.4)";
        }
      } else if (focus) {
        context.fillStyle = "rgba(229, 82, 0, 0.4)";
      } else {
        context.fillStyle = "rgba(99, 52, 0, 0.4)";
      }

      const zoomFactor = isFrameLikeElement(element) ? appState.zoom.value : 1;

      context.translate(appState.scrollX, appState.scrollY);
      context.translate(cx, cy);
      context.rotate(element.angle);

      matchedLines.forEach((matchedLine) => {
        (matchedLine.showOnCanvas || focus) &&
          context.fillRect(
            elementX1 + matchedLine.offsetX / zoomFactor - cx,
            elementY1 + matchedLine.offsetY / zoomFactor - cy,
            matchedLine.width / zoomFactor,
            matchedLine.height / zoomFactor,
          );
      });

      context.restore();
    }
  });

  renderSnaps(context, appState);

  renderAlignmentLocks(context, appState, allElementsMap, selectedElements);
  renderGapAlignmentLocks(context, appState, allElementsMap, selectedElements);
  renderElementAlignmentLocks(
    context,
    appState,
    allElementsMap,
    selectedElements,
    renderConfig.selectionColor,
  );
  renderAnchorLockOverlays(context, appState, allElementsMap, selectedElements);

  context.restore();

  renderRemoteCursors({
    context,
    renderConfig,
    appState,
    normalizedWidth,
    normalizedHeight,
  });

  // Paint scrollbars
  let scrollBars;
  if (renderConfig.renderScrollbars) {
    scrollBars = getScrollBars(
      elementsMap,
      normalizedWidth,
      normalizedHeight,
      appState,
    );

    context.save();
    context.fillStyle = SCROLLBAR_COLOR;
    context.strokeStyle = "rgba(255,255,255,0.8)";
    [scrollBars.horizontal, scrollBars.vertical].forEach((scrollBar) => {
      if (scrollBar) {
        roundRect(
          context,
          scrollBar.x,
          scrollBar.y,
          scrollBar.width,
          scrollBar.height,
          SCROLLBAR_WIDTH / 2,
        );
      }
    });
    context.restore();
  }

  return {
    scrollBars,
    animationState: nextAnimationState,
  };
};

/**
 * Interactive scene is the ui-canvas where we render bounding boxes, selections
 * and other ui stuff.
 */
export const renderInteractiveScene = <
  U extends typeof _renderInteractiveScene,
>(
  renderConfig: InteractiveSceneRenderConfig,
): ReturnType<U> => {
  const ret = _renderInteractiveScene(renderConfig);
  renderConfig.callback(ret);
  return ret as ReturnType<U>;
};
