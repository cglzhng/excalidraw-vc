import type { LocalPoint, Radians } from "@excalidraw/math";

import type {
  FONT_FAMILY,
  ROUNDNESS,
  TEXT_ALIGN,
  THEME,
  VERTICAL_ALIGN,
} from "@excalidraw/common";

import type {
  MakeBrand,
  MarkNonNullable,
  Merge,
  ValueOf,
} from "@excalidraw/common/utility-types";

export type ChartType = "bar" | "line" | "radar";
export type FillStyle = "hachure" | "cross-hatch" | "solid" | "zigzag";
export type FontFamilyKeys = keyof typeof FONT_FAMILY;
export type FontFamilyValues = typeof FONT_FAMILY[FontFamilyKeys];
export type Theme = typeof THEME[keyof typeof THEME];
export type FontString = string & { _brand: "fontString" };
export type GroupId = string;
export type PointerType = "mouse" | "pen" | "touch";
export type StrokeRoundness = "round" | "sharp";
export type RoundnessType = ValueOf<typeof ROUNDNESS>;
export type StrokeStyle = "solid" | "dashed" | "dotted";
export type TextAlign = typeof TEXT_ALIGN[keyof typeof TEXT_ALIGN];

type VerticalAlignKeys = keyof typeof VERTICAL_ALIGN;
export type VerticalAlign = typeof VERTICAL_ALIGN[VerticalAlignKeys];
export type FractionalIndex = string & { _brand: "franctionalIndex" };

export type BoundElement = Readonly<{
  id: ExcalidrawLinearElement["id"];
  type: "arrow" | "text";
}>;

/**
 * Which coordinate of an element's bounds an alignment tracks, on a
 * given axis: "min" — left (x) / top (y); "center" — the midpoint;
 * "max" — right (x) / bottom (y).
 */
export type AlignmentEdge = "min" | "center" | "max";

/**
 * A hard-alignment link to a partner element. `axis` is the axis whose
 * coordinate is held in lockstep: an "x" link keeps the two elements
 * moving together horizontally, a "y" link vertically.
 *
 * `selfEdge` is the edge of *this* element that's aligned, `otherEdge`
 * the edge of the partner it's aligned to — the two coordinates are
 * equal by construction. They usually match (left-to-left) but may
 * differ (this element's right aligned to the partner's left). Edges
 * are irrelevant to dragging (a uniform translation preserves any
 * relationship) but essential to resizing, where each edge moves by a
 * different amount and we must know which one to track.
 */
export type ElementAlignment = Readonly<{
  elementId: string;
  axis: "x" | "y";
  selfEdge: AlignmentEdge;
  otherEdge: AlignmentEdge;
}>;

/**
 * A hard *gap* alignment: a chain of three or more elements, ordered
 * along `axis`, whose consecutive gaps are all held equal — the hard
 * counterpart of the gap that upstream's snapping surfaces while
 * dragging.
 *
 * For the three-element case `gap(a,b) === gap(b,c)` is equivalent to
 * `b.center === (a.max + c.min) / 2` — the middle element stays centred
 * between its neighbours. Longer chains are just that constraint on
 * every adjacent pair, which under translation makes the members'
 * offsets an arithmetic progression.
 *
 * Unlike {@link ElementAlignment} this has no self/other asymmetry to keep
 * in sync: the identical record is stored on every member and a member's
 * role is just its index in `ids`. Identity is `(axis, ids)`.
 */
export type ElementGapAlignment = Readonly<{
  axis: "x" | "y";
  /** the chain, ordered along `axis` at lock time; at least 3 long */
  ids: readonly string[];
}>;

type _ExcalidrawElementBase = Readonly<{
  id: string;
  x: number;
  y: number;
  strokeColor: string;
  backgroundColor: string;
  fillStyle: FillStyle;
  strokeWidth: number;
  strokeStyle: StrokeStyle;
  roundness: null | { type: RoundnessType; value?: number };
  roughness: number;
  opacity: number;
  width: number;
  height: number;
  angle: Radians;
  /** Random integer used to seed shape generation so that the roughjs shape
      doesn't differ across renders. */
  seed: number;
  /** Integer that is sequentially incremented on each change. Used to reconcile
      elements during collaboration or when saving to server. */
  version: number;
  /** Random integer that is regenerated on each change.
      Used for deterministic reconciliation of updates during collaboration,
      in case the versions (see above) are identical. */
  versionNonce: number;
  /** String in a fractional form defined by https://github.com/rocicorp/fractional-indexing.
      Used for ordering in multiplayer scenarios, such as during reconciliation or undo / redo.
      Always kept in sync with the array order by `syncMovedIndices` and `syncInvalidIndices`.
      Could be null, i.e. for new elements which were not yet assigned to the scene. */
  index: FractionalIndex | null;
  isDeleted: boolean;
  /** List of groups the element belongs to.
      Ordered from deepest to shallowest. */
  groupIds: readonly GroupId[];
  frameId: string | null;
  /** other elements that are bound to this element */
  boundElements: readonly BoundElement[] | null;
  /** Hard-alignment links. Each entry pins a shared coordinate to a
      partner element on one axis, so moving either element drags the
      other to keep the alignment. Symmetric — the reciprocal entry is
      stored on the partner. Optional/undefined for the common case of
      no links. See `alignment.ts`. */
  alignments?: readonly ElementAlignment[];
  /** Hard gap-alignment links: chains this element belongs to whose
      consecutive gaps are held equal. The same record is stored on every
      member. Optional/undefined for the common case of none. See
      `gapAlignment.ts`. */
  gapAlignments?: readonly ElementGapAlignment[];
  /** Alignment anchor: when true, the element is never moved by hard-
      alignment propagation. Because an aligned component moves rigidly,
      an anchor freezes its whole component on the shared axis — dragging
      a partner can't move along that axis at all. Distinct from `locked`
      (which blocks selection/drag entirely); an anchored element is still
      freely draggable itself. `locked` implies anchoring but not the
      reverse — test with `isAlignmentAnchor`, never this field alone.
      See `alignment.ts`. */
  alignmentLocked?: boolean;
  /** epoch (ms) timestamp of last element update */
  updated: number;
  link: string | null;
  locked: boolean;
  customData?: Record<string, any>;
}>;

export type ExcalidrawSelectionElement = _ExcalidrawElementBase & {
  type: "selection";
};

export type ExcalidrawRectangleElement = _ExcalidrawElementBase & {
  type: "rectangle";
};

export type ExcalidrawDiamondElement = _ExcalidrawElementBase & {
  type: "diamond";
};

export type ExcalidrawEllipseElement = _ExcalidrawElementBase & {
  type: "ellipse";
};

export type ExcalidrawEmbeddableElement = _ExcalidrawElementBase &
  Readonly<{
    type: "embeddable";
  }>;

export type MagicGenerationData =
  | {
      status: "pending";
    }
  | { status: "done"; html: string }
  | {
      status: "error";
      message?: string;
      code: "ERR_GENERATION_INTERRUPTED" | string;
    };

export type ExcalidrawIframeElement = _ExcalidrawElementBase &
  Readonly<{
    type: "iframe";
    // TODO move later to AI-specific frame
    customData?: { generationData?: MagicGenerationData };
  }>;

export type ExcalidrawIframeLikeElement =
  | ExcalidrawIframeElement
  | ExcalidrawEmbeddableElement;

export type IframeData =
  | {
      intrinsicSize: { w: number; h: number };
      error?: Error;
      sandbox?: { allowSameOrigin?: boolean };
    } & (
      | { type: "video" | "generic"; link: string }
      | { type: "document"; srcdoc: (theme: Theme) => string }
    );

export type ImageCrop = {
  x: number;
  y: number;
  width: number;
  height: number;
  naturalWidth: number;
  naturalHeight: number;
};

export type ExcalidrawImageElement = _ExcalidrawElementBase &
  Readonly<{
    type: "image";
    fileId: FileId | null;
    /** whether respective file is persisted */
    status: "pending" | "saved" | "error";
    /** X and Y scale factors <-1, 1>, used for image axis flipping */
    scale: [number, number];
    /** whether an element is cropped */
    crop: ImageCrop | null;
  }>;

export type InitializedExcalidrawImageElement = MarkNonNullable<
  ExcalidrawImageElement,
  "fileId"
>;

export type ExcalidrawFrameElement = _ExcalidrawElementBase & {
  type: "frame";
  name: string | null;
};

export type ExcalidrawMagicFrameElement = _ExcalidrawElementBase & {
  type: "magicframe";
  name: string | null;
};

export type ExcalidrawFrameLikeElement =
  | ExcalidrawFrameElement
  | ExcalidrawMagicFrameElement;

/**
 * These are elements that don't have any additional properties.
 */
export type ExcalidrawGenericElement =
  | ExcalidrawSelectionElement
  | ExcalidrawRectangleElement
  | ExcalidrawDiamondElement
  | ExcalidrawEllipseElement;

export type ExcalidrawFlowchartNodeElement =
  | ExcalidrawRectangleElement
  | ExcalidrawDiamondElement
  | ExcalidrawEllipseElement;

export type ExcalidrawRectanguloidElement =
  | ExcalidrawRectangleElement
  | ExcalidrawImageElement
  | ExcalidrawTextElement
  | ExcalidrawFreeDrawElement
  | ExcalidrawIframeLikeElement
  | ExcalidrawFrameLikeElement
  | ExcalidrawEmbeddableElement
  | ExcalidrawSelectionElement;

/**
 * ExcalidrawElement should be JSON serializable and (eventually) contain
 * no computed data. The list of all ExcalidrawElements should be shareable
 * between peers and contain no state local to the peer.
 */
export type ExcalidrawElement =
  | ExcalidrawGenericElement
  | ExcalidrawTextElement
  | ExcalidrawLinearElement
  | ExcalidrawArrowElement
  | ExcalidrawFreeDrawElement
  | ExcalidrawImageElement
  | ExcalidrawFrameElement
  | ExcalidrawMagicFrameElement
  | ExcalidrawIframeElement
  | ExcalidrawEmbeddableElement;

export type ExcalidrawNonSelectionElement = Exclude<
  ExcalidrawElement,
  ExcalidrawSelectionElement
>;

export type Ordered<TElement extends ExcalidrawElement> = TElement & {
  index: FractionalIndex;
};

export type OrderedExcalidrawElement = Ordered<ExcalidrawElement>;

export type NonDeleted<TElement extends ExcalidrawElement> = TElement & {
  isDeleted: false;
};

export type NonDeletedExcalidrawElement = NonDeleted<ExcalidrawElement>;

export type ExcalidrawTextElement = _ExcalidrawElementBase &
  Readonly<{
    type: "text";
    fontSize: number;
    /**
     * The font size the author chose, as distinct from `fontSize`, which
     * auto-fitting derives from it and the container's size (see
     * `fitBoundTextToContainer`). Recorded on bound text from the first
     * fit onward and never cleared — it's what the text returns to when
     * there's room, and the only one of the two the user meant. Setting
     * the font size by hand replaces it.
     */
    authoredFontSize?: number;
    fontFamily: FontFamilyValues;
    text: string;
    textAlign: TextAlign;
    verticalAlign: VerticalAlign;
    containerId: ExcalidrawGenericElement["id"] | null;
    originalText: string;
    /**
     * If `true` the width will fit the text. If `false`, the text will
     * wrap to fit the width.
     *
     * @default true
     */
    autoResize: boolean;
    /**
     * Unitless line height (aligned to W3C). To get line height in px, multiply
     *  with font size (using `getLineHeightInPx` helper).
     */
    lineHeight: number & { _brand: "unitlessLineHeight" };
  }>;

export type ExcalidrawBindableElement =
  | ExcalidrawRectangleElement
  | ExcalidrawDiamondElement
  | ExcalidrawEllipseElement
  | ExcalidrawTextElement
  | ExcalidrawImageElement
  | ExcalidrawIframeElement
  | ExcalidrawEmbeddableElement
  | ExcalidrawFrameElement
  | ExcalidrawMagicFrameElement;

export type ExcalidrawTextContainer =
  | ExcalidrawRectangleElement
  | ExcalidrawDiamondElement
  | ExcalidrawEllipseElement
  | ExcalidrawArrowElement;

export type ExcalidrawTextElementWithContainer = {
  containerId: ExcalidrawTextContainer["id"];
} & ExcalidrawTextElement;

export type FixedPoint = [number, number];

export type BindMode = "inside" | "orbit" | "skip";

export type FixedPointBinding = {
  elementId: ExcalidrawBindableElement["id"];

  // Represents the fixed point binding information in form of a vertical and
  // horizontal ratio (i.e. a percentage value in the 0.0-1.0 range). This ratio
  // gives the user selected fixed point by multiplying the bound element width
  // with fixedPoint[0] and the bound element height with fixedPoint[1] to get the
  // bound element-local point coordinate.
  fixedPoint: FixedPoint;

  // Determines whether the arrow remains outside the shape or is allowed to
  // go all the way inside the shape up to the exact fixed point.
  mode: BindMode;
};

type Index = number;

export type PointsPositionUpdates = Map<
  Index,
  { point: LocalPoint; isDragging?: boolean }
>;

export type CardinalityArrowhead =
  | "cardinality_one"
  | "cardinality_many"
  | "cardinality_one_or_many"
  | "cardinality_exactly_one"
  | "cardinality_zero_or_one"
  | "cardinality_zero_or_many";

export type ArrowheadLegacy =
  | "dot"
  | "crowfoot_one"
  | "crowfoot_many"
  | "crowfoot_one_or_many";

export type Arrowhead =
  | "arrow"
  | "bar"
  | "circle"
  | "circle_outline"
  | "triangle"
  | "triangle_outline"
  | "diamond"
  | "diamond_outline"
  | CardinalityArrowhead;

export type AnyArrowhead = Arrowhead | ArrowheadLegacy;

export type ExcalidrawLinearElement = _ExcalidrawElementBase &
  Readonly<{
    type: "line" | "arrow";
    points: readonly LocalPoint[];
    startBinding: FixedPointBinding | null;
    endBinding: FixedPointBinding | null;
    startArrowhead: Arrowhead | null;
    endArrowhead: Arrowhead | null;
  }>;

export type ExcalidrawLineElement = ExcalidrawLinearElement &
  Readonly<{
    type: "line";
    polygon: boolean;
  }>;

export type FixedSegment = {
  start: LocalPoint;
  end: LocalPoint;
  index: Index;
};

export type ExcalidrawArrowElement = ExcalidrawLinearElement &
  Readonly<{
    type: "arrow";
    elbowed: boolean;
  }>;

export type ExcalidrawElbowArrowElement = Merge<
  ExcalidrawArrowElement,
  {
    elbowed: true;
    fixedSegments: readonly FixedSegment[] | null;
    startBinding: FixedPointBinding | null;
    endBinding: FixedPointBinding | null;
    /**
     * Marks that the 3rd point should be used as the 2nd point of the arrow in
     * order to temporarily hide the first segment of the arrow without losing
     * the data from the points array. It allows creating the expected arrow
     * path when the arrow with fixed segments is bound on a horizontal side and
     * moved to a vertical and vica versa.
     */
    startIsSpecial: boolean | null;
    /**
     * Marks that the 3rd point backwards from the end should be used as the 2nd
     * point of the arrow in order to temporarily hide the last segment of the
     * arrow without losing the data from the points array. It allows creating
     * the expected arrow path when the arrow with fixed segments is bound on a
     * horizontal side and moved to a vertical and vica versa.
     */
    endIsSpecial: boolean | null;
  }
>;

export type StrokeVariability = "variable" | "constant";

export type StrokeOptions = Readonly<{
  variability: StrokeVariability;
  streamline: number;
}>;

export type ExcalidrawFreeDrawElement = _ExcalidrawElementBase &
  Readonly<{
    type: "freedraw";
    points: readonly LocalPoint[];
    pressures: readonly number[];
    simulatePressure: boolean;
    strokeOptions: StrokeOptions;
  }>;

export type FileId = string & { _brand: "FileId" };

export type ExcalidrawElementType = ExcalidrawElement["type"];

/**
 * Map of excalidraw elements.
 * Unspecified whether deleted or non-deleted.
 * Can be a subset of Scene elements.
 */
export type ElementsMap = Map<ExcalidrawElement["id"], ExcalidrawElement>;

/**
 * Map of non-deleted elements.
 * Can be a subset of Scene elements.
 */
export type NonDeletedElementsMap = Map<
  ExcalidrawElement["id"],
  NonDeletedExcalidrawElement
> &
  MakeBrand<"NonDeletedElementsMap">;

/**
 * Map of all excalidraw Scene elements, including deleted.
 * Not a subset. Use this type when you need access to current Scene elements.
 */
export type SceneElementsMap = Map<
  ExcalidrawElement["id"],
  Ordered<ExcalidrawElement>
> &
  MakeBrand<"SceneElementsMap">;

/**
 * Map of all non-deleted Scene elements.
 * Not a subset. Use this type when you need access to current Scene elements.
 */
export type NonDeletedSceneElementsMap = Map<
  ExcalidrawElement["id"],
  Ordered<NonDeletedExcalidrawElement>
> &
  MakeBrand<"NonDeletedSceneElementsMap">;

export type ElementsMapOrArray =
  | readonly ExcalidrawElement[]
  | Readonly<ElementsMap>;

export type NonDeletedElementsMapOrArray =
  | readonly NonDeletedExcalidrawElement[]
  | Readonly<NonDeletedElementsMap | NonDeletedSceneElementsMap>;

export type ExcalidrawLinearElementSubType =
  | "line"
  | "sharpArrow"
  | "curvedArrow"
  | "elbowArrow";

export type ConvertibleGenericTypes = "rectangle" | "diamond" | "ellipse";
export type ConvertibleLinearTypes = ExcalidrawLinearElementSubType;
export type ConvertibleTypes = ConvertibleGenericTypes | ConvertibleLinearTypes;
