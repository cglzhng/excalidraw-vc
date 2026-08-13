import {
  type Bounds,
  TEXT_AUTOWRAP_THRESHOLD,
  getGridPoint,
  getFontString,
  DRAGGING_THRESHOLD,
} from "@excalidraw/common";

import type {
  AppState,
  NormalizedZoomValue,
  NullableGridSize,
  PointerDownState,
} from "@excalidraw/excalidraw/types";

import { pointFrom, pointRotateRads } from "@excalidraw/math";

import type { LocalPoint, Radians } from "@excalidraw/math";

import type { NonDeletedExcalidrawElement } from "@excalidraw/element/types";

import { dragAlignedElements, getAlignmentLockedAxes } from "./alignment";
import { clampDragToGapAlignments } from "./gapAlignment";
import { updateBoundElements } from "./binding";
import { getCommonBounds } from "./bounds";
import { LinearElementEditor } from "./linearElementEditor";
import { getPerfectElementSize } from "./sizeHelpers";
import { getBoundTextElement } from "./textElement";
import { getMinTextElementWidth } from "./textMeasurements";
import {
  isArrowElement,
  isElbowArrow,
  isFrameLikeElement,
  isImageElement,
  isLinearElement,
  isTextElement,
} from "./typeChecks";

import type { Scene } from "./Scene";

import type {
  ExcalidrawElement,
  ExcalidrawLinearElement,
  ExcalidrawTextElement,
  NonDeleted,
  PointsPositionUpdates,
} from "./types";

export const dragSelectedElements = (
  pointerDownState: PointerDownState,
  _selectedElements: NonDeletedExcalidrawElement[],
  offset: { x: number; y: number },
  scene: Scene,
  snapOffset: {
    x: number;
    y: number;
  },
  gridSize: NullableGridSize,
) => {
  if (
    _selectedElements.length === 1 &&
    isElbowArrow(_selectedElements[0]) &&
    (_selectedElements[0].startBinding || _selectedElements[0].endBinding)
  ) {
    return;
  }

  const selectedElements = _selectedElements.filter((element) => {
    if (isElbowArrow(element) && element.startBinding && element.endBinding) {
      const startElement = _selectedElements.find(
        (el) => el.id === element.startBinding?.elementId,
      );
      const endElement = _selectedElements.find(
        (el) => el.id === element.endBinding?.elementId,
      );

      return startElement && endElement;
    }

    return true;
  });

  // we do not want a frame and its elements to be selected at the same time
  // but when it happens (due to some bug), we want to avoid updating element
  // in the frame twice, hence the use of set
  const elementsToUpdate = new Set<NonDeletedExcalidrawElement>(
    selectedElements,
  );
  const frames = selectedElements
    .filter((e) => isFrameLikeElement(e))
    .map((f) => f.id);

  if (frames.length > 0) {
    for (const element of scene.getNonDeletedElements()) {
      if (element.frameId !== null && frames.includes(element.frameId)) {
        elementsToUpdate.add(element);
      }
    }
  }

  const origElements: ExcalidrawElement[] = [];

  for (const element of elementsToUpdate) {
    const origElement = pointerDownState.originalElements.get(element.id);
    // if original element is not set (e.g. when you duplicate during a drag
    // operation), exit to avoid undefined behavior
    if (!origElement) {
      return;
    }
    origElements.push(origElement);
  }

  const rawOffset = calculateOffset(
    getCommonBounds(origElements),
    offset,
    snapOffset,
    gridSize,
  );

  const elementsToUpdateIds = new Set(
    Array.from(elementsToUpdate, (el) => el.id),
  );

  // Alignment anchors freeze the shared axis: if a hard-aligned component
  // of the dragged set contains a locked element (that isn't itself being
  // dragged), the component can't move on that axis at all, so zero the
  // offset there before it's applied to the dragged elements or flooded
  // to their partners.
  const lockedAxes = getAlignmentLockedAxes(
    elementsToUpdateIds,
    scene.getNonDeletedElementsMap(),
  );
  // Then hard gap alignments cap how far the offset can go before a gap
  // would close past zero and its triple change order. Both adjustments
  // happen here, before the offset reaches either the dragged elements
  // or their partners, so everything moves by one agreed amount.
  const adjustedOffset = clampDragToGapAlignments(
    elementsToUpdateIds,
    {
      x: lockedAxes.x ? 0 : rawOffset.x,
      y: lockedAxes.y ? 0 : rawOffset.y,
    },
    pointerDownState.originalElements,
    scene.getNonDeletedElementsMap(),
  );

  elementsToUpdate.forEach((element) => {
    const isArrow = !isArrowElement(element);
    const isStartBoundElementSelected =
      isArrow ||
      (element.startBinding
        ? elementsToUpdateIds.has(element.startBinding.elementId)
        : false);
    const isEndBoundElementSelected =
      isArrow ||
      (element.endBinding
        ? elementsToUpdateIds.has(element.endBinding.elementId)
        : false);

    if (!isArrowElement(element)) {
      updateElementCoords(pointerDownState, element, scene, adjustedOffset);

      // skip arrow labels since we calculate its position during render
      const textElement = getBoundTextElement(
        element,
        scene.getNonDeletedElementsMap(),
      );
      if (textElement) {
        updateElementCoords(
          pointerDownState,
          textElement,
          scene,
          adjustedOffset,
        );
      }
      updateBoundElements(element, scene, {
        simultaneouslyUpdated: Array.from(elementsToUpdate),
      });
    } else if (
      // NOTE: Add a little initial drag to the arrow dragging when the arrow
      // is the single element being dragged to avoid accidentally unbinding
      // the arrow when the user just wants to select it.

      elementsToUpdate.size > 1 ||
      Math.max(Math.abs(adjustedOffset.x), Math.abs(adjustedOffset.y)) >
        DRAGGING_THRESHOLD ||
      (!element.startBinding && !element.endBinding)
    ) {
      // VERSION-LOG: dragging a bound arrow moves its free points, and
      // never breaks the binding.
      //
      // Upstream unbinds instead: translating the whole arrow drags a bound
      // endpoint off its shape, and the alternative to unbinding there was
      // the endpoint snapping back and collapsing the arrow. But that makes
      // a plain drag — the least deliberate gesture there is — destroy a
      // relationship that is fiddly to rebuild.
      //
      // An endpoint bound to a shape that is being dragged too travels with
      // it, so only bindings to something staying put pin a point. Applying
      // the offset to the remaining points keeps every pinned endpoint
      // exactly where it is, so nothing has to be unbound and the arrow
      // stretches rather than travelling. Unbinding stays available where it
      // belongs: drag the endpoint itself, off the shape.
      const pinnedStart = !!element.startBinding && !isStartBoundElementSelected;
      const pinnedEnd = !!element.endBinding && !isEndBoundElementSelected;

      if (!pinnedStart && !pinnedEnd) {
        updateElementCoords(pointerDownState, element, scene, adjustedOffset);
      } else {
        dragArrowFreePoints(pointerDownState, element, scene, adjustedOffset, {
          start: pinnedStart,
          end: pinnedEnd,
        });
      }
    }
  });

  // Hard alignment: drag any elements hard-aligned to the moved set so
  // the alignment is preserved. Runs after the direct moves so partners
  // inherit the snapped / grid-adjusted offset.
  dragAlignedElements(
    pointerDownState.originalElements,
    elementsToUpdateIds,
    adjustedOffset,
    scene,
  );
};

const calculateOffset = (
  commonBounds: Bounds,
  dragOffset: { x: number; y: number },
  snapOffset: { x: number; y: number },
  gridSize: NullableGridSize,
): { x: number; y: number } => {
  const [x, y] = commonBounds;
  let nextX = x + dragOffset.x + snapOffset.x;
  let nextY = y + dragOffset.y + snapOffset.y;

  if (snapOffset.x === 0 || snapOffset.y === 0) {
    const [nextGridX, nextGridY] = getGridPoint(
      x + dragOffset.x,
      y + dragOffset.y,
      gridSize,
    );

    if (snapOffset.x === 0) {
      nextX = nextGridX;
    }

    if (snapOffset.y === 0) {
      nextY = nextGridY;
    }
  }
  return {
    x: nextX - x,
    y: nextY - y,
  };
};

/**
 * Applies a drag offset to the points of an arrow that has at least one
 * endpoint pinned by a binding, leaving the pinned endpoints untouched.
 *
 * The offset is taken from the *original* points each frame rather than
 * applied incrementally, and re-expressed in the element's current frame:
 * moving point 0 shifts `x`/`y` (point 0 is invariantly `[0,0]`), so by the
 * next frame the element's origin has already moved under us.
 */
const dragArrowFreePoints = (
  pointerDownState: PointerDownState,
  element: NonDeleted<ExcalidrawLinearElement>,
  scene: Scene,
  dragOffset: { x: number; y: number },
  pinned: { start: boolean; end: boolean },
) => {
  const original = pointerDownState.originalElements.get(element.id);
  if (!original || !isLinearElement(original)) {
    return;
  }

  const lastIndex = original.points.length - 1;
  // points live in the element's unrotated frame, so a global translation
  // has to be rotated into it
  const localOffset = pointRotateRads(
    pointFrom(dragOffset.x, dragOffset.y),
    pointFrom(0, 0),
    -element.angle as Radians,
  );

  const pointUpdates: PointsPositionUpdates = new Map();
  for (let idx = 0; idx <= lastIndex; idx++) {
    if ((idx === 0 && pinned.start) || (idx === lastIndex && pinned.end)) {
      continue;
    }
    pointUpdates.set(idx, {
      point: pointFrom<LocalPoint>(
        original.x + original.points[idx][0] + localOffset[0] - element.x,
        original.y + original.points[idx][1] + localOffset[1] - element.y,
      ),
      isDragging: true,
    });
  }

  // every point pinned — a two-point arrow bound at both ends. There is
  // nothing it can do without breaking a binding, so it holds still.
  if (pointUpdates.size === 0) {
    return;
  }

  LinearElementEditor.movePoints(element, scene, pointUpdates);
};

const updateElementCoords = (
  pointerDownState: PointerDownState,
  element: ExcalidrawElement,
  scene: Scene,
  dragOffset: { x: number; y: number },
) => {
  const originalElement =
    pointerDownState.originalElements.get(element.id) ?? element;

  const nextX = originalElement.x + dragOffset.x;
  const nextY = originalElement.y + dragOffset.y;

  scene.mutateElement(element, {
    x: nextX,
    y: nextY,
  });
};

export const getDragOffsetXY = (
  selectedElements: NonDeletedExcalidrawElement[],
  x: number,
  y: number,
): [number, number] => {
  const [x1, y1] = getCommonBounds(selectedElements);
  return [x - x1, y - y1];
};

/**
 * Sizes a text element as it is dragged out.
 *
 * A dragged text pins one point and grows away from it; `anchorRatio` says
 * where along the box that point sits — 0 for its left edge, 1 for its right,
 * 0.5 for its centre.
 *
 * A free text pins the point the drag started from and takes the ratio from
 * the drag direction, so it can be pulled either way. A text bound to an arrow
 * endpoint instead pins whatever the binding placed it against and takes the
 * ratio from its alignment — which is also what keeps it from growing back
 * over the arrow, since dragging that way makes no progress rather than
 * flipping the box around.
 */
export const dragNewTextElement = ({
  newElement,
  anchorX,
  anchorRatio,
  pointerX,
  nextY,
  zoom,
  scene,
  informMutation = true,
}: {
  newElement: ExcalidrawTextElement;
  anchorX: number;
  /** 0 = anchored by its left edge, 1 = by its right, 0.5 = by its centre */
  anchorRatio: number;
  pointerX: number;
  /** free text re-tops itself to the drag origin; a bound one must not move */
  nextY?: number;
  zoom: NormalizedZoomValue;
  scene: Scene;
  informMutation?: boolean;
}) => {
  const offset = pointerX - anchorX;

  // how far the pointer has travelled away from the anchor along the direction
  // the box may grow — negative once it heads back the other way
  const reach =
    anchorRatio === 0 ? offset : anchorRatio === 1 ? -offset : Math.abs(offset);

  const width = Math.max(
    // a centred box grows on both sides, so it widens at twice the reach
    anchorRatio === 0.5 ? reach * 2 : reach,
    getMinTextElementWidth(
      getFontString({
        fontSize: newElement.fontSize,
        fontFamily: newElement.fontFamily,
      }),
      newElement.lineHeight,
    ),
  );

  scene.mutateElement(
    newElement,
    {
      x: anchorX - width * anchorRatio,
      ...(nextY === undefined ? {} : { y: nextY }),
      width,
      ...(reach > TEXT_AUTOWRAP_THRESHOLD / zoom ? { autoResize: false } : {}),
    },
    { informMutation, isDragging: false },
  );
};

export const dragNewElement = ({
  newElement,
  elementType,
  originX,
  originY,
  x,
  y,
  width,
  height,
  shouldMaintainAspectRatio,
  shouldResizeFromCenter,
  zoom,
  scene,
  widthAspectRatio = null,
  originOffset = null,
  informMutation = true,
}: {
  newElement: NonDeletedExcalidrawElement;
  elementType: AppState["activeTool"]["type"];
  originX: number;
  originY: number;
  x: number;
  y: number;
  width: number;
  height: number;
  shouldMaintainAspectRatio: boolean;
  shouldResizeFromCenter: boolean;
  zoom: NormalizedZoomValue;
  scene: Scene;
  /** whether to keep given aspect ratio when `isResizeWithSidesSameLength` is
      true */
  widthAspectRatio?: number | null;
  originOffset?: {
    x: number;
    y: number;
  } | null;
  informMutation?: boolean;
}) => {
  if (shouldMaintainAspectRatio && newElement.type !== "selection") {
    if (widthAspectRatio) {
      height = width / widthAspectRatio;
    } else {
      // Depending on where the cursor is at (x, y) relative to where the starting point is
      // (originX, originY), we use ONLY width or height to control size increase.
      // This allows the cursor to always "stick" to one of the sides of the bounding box.
      if (Math.abs(y - originY) > Math.abs(x - originX)) {
        ({ width, height } = getPerfectElementSize(
          elementType,
          height,
          x < originX ? -width : width,
        ));
      } else {
        ({ width, height } = getPerfectElementSize(
          elementType,
          width,
          y < originY ? -height : height,
        ));
      }

      if (height < 0) {
        height = -height;
      }
    }
  }

  if (isTextElement(newElement)) {
    // a text is only ever sized horizontally — its height follows the wrapped
    // content — so it grows away from the point the drag started at
    dragNewTextElement({
      newElement,
      anchorX: originX + (originOffset?.x ?? 0),
      anchorRatio: shouldResizeFromCenter ? 0.5 : x < originX ? 1 : 0,
      pointerX: x,
      nextY: originY + (originOffset?.y ?? 0),
      zoom,
      scene,
      informMutation,
    });
    return;
  }

  let newX = x < originX ? originX - width : originX;
  let newY = y < originY ? originY - height : originY;

  if (shouldResizeFromCenter) {
    width += width;
    height += height;
    newX = originX - width / 2;
    newY = originY - height / 2;
  }

  if (width !== 0 && height !== 0) {
    let imageInitialDimension = null;
    if (isImageElement(newElement)) {
      imageInitialDimension = {
        initialWidth: width,
        initialHeight: height,
      };
    }

    scene.mutateElement(
      newElement,
      {
        x: newX + (originOffset?.x ?? 0),
        y: newY + (originOffset?.y ?? 0),
        width,
        height,
        ...imageInitialDimension,
      },
      { informMutation, isDragging: false },
    );
  }
};
