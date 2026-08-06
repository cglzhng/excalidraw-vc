import { COLOR_WHITE, THEME, applyDarkModeFilter } from "@excalidraw/common";

import type { StaticCanvasRenderConfig } from "../scene/types";
import type { AppState, StaticCanvasAppState } from "../types";

/**
 * The one colour for alignment indicators — snap guides and hard/soft
 * alignment guides alike. They are the same idea at different levels of
 * commitment, so they must not drift apart; these lived as two separate
 * pairs of hexes before and did exactly that.
 *
 * Zen mode takes the light colour in either theme: there we draw little
 * more than the crosses, and they need the contrast.
 */
const INDICATOR_COLOR_LIGHT = "#e03131";
const INDICATOR_COLOR_DARK = "#ffa8a8";

export const getIndicatorColor = (
  theme: AppState["theme"],
  zenModeEnabled: boolean,
): string =>
  theme === THEME.LIGHT || zenModeEnabled
    ? INDICATOR_COLOR_LIGHT
    : INDICATOR_COLOR_DARK;

/** Half-diagonal, in screen px, of the cross marking an anchor point. */
export const INDICATOR_CROSS_SIZE = 2;

/**
 * The X marking a point an indicator line is anchored to — an element
 * corner or centre. `size` is already zoom-scaled by the caller.
 */
export const drawIndicatorCross = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
) => {
  context.save();
  context.beginPath();
  context.moveTo(x - size, y - size);
  context.lineTo(x + size, y + size);
  context.moveTo(x + size, y - size);
  context.lineTo(x - size, y + size);
  context.stroke();
  context.restore();
};

export const getWideIndicatorLineDash = (zoom: number): number[] => [
  5 / zoom,
  4 / zoom,
];

export const getNarrowIndicatorLineDash = (zoom: number): number[] => [
  3 / zoom,
  2 / zoom,
];


export const fillCircle = (
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  stroke: boolean,
  fill = true,
) => {
  context.beginPath();
  context.arc(cx, cy, radius, 0, Math.PI * 2);
  if (fill) {
    context.fill();
  }
  if (stroke) {
    context.stroke();
  }
};

export const getNormalizedCanvasDimensions = (
  canvas: HTMLCanvasElement,
  scale: number,
): [number, number] => {
  // When doing calculations based on canvas width we should used normalized one
  return [canvas.width / scale, canvas.height / scale];
};

export const bootstrapCanvas = ({
  canvas,
  scale,
  normalizedWidth,
  normalizedHeight,
  theme,
  isExporting,
  viewBackgroundColor,
}: {
  canvas: HTMLCanvasElement;
  scale: number;
  normalizedWidth: number;
  normalizedHeight: number;
  theme?: AppState["theme"];
  isExporting?: StaticCanvasRenderConfig["isExporting"];
  viewBackgroundColor?: StaticCanvasAppState["viewBackgroundColor"];
}): CanvasRenderingContext2D => {
  const context = canvas.getContext("2d")!;

  context.setTransform(1, 0, 0, 1, 0, 0);
  context.scale(scale, scale);

  // Paint background
  if (typeof viewBackgroundColor === "string") {
    // An opaque fill repaints every pixel, so clearRect would be redundant.
    // For anything else — transparency, or a value we can't be certain about
    // (e.g. corrupted persisted state like "0000") — clear first so the
    // previous frame can't bleed through.
    //
    // We skip opaque #RRGGBB and #RGB hex colors as a quick optimization.
    const isOpaque = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(viewBackgroundColor);

    if (!isOpaque) {
      context.clearRect(0, 0, normalizedWidth, normalizedHeight);
    }

    if (viewBackgroundColor !== "transparent") {
      context.save();
      // The canvas silently ignores an invalid fillStyle, which would leave a
      // stale color from a previous draw. Seed a sane default so corrupted
      // values fall back to white instead of painting garbage.
      context.fillStyle = COLOR_WHITE;
      context.fillStyle = applyDarkModeFilter(
        viewBackgroundColor,
        theme === THEME.DARK,
      );
      context.fillRect(0, 0, normalizedWidth, normalizedHeight);
      context.restore();
    }
  } else {
    context.clearRect(0, 0, normalizedWidth, normalizedHeight);
  }

  return context;
};

export const strokeRectWithRotation_simple = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  cx: number,
  cy: number,
  angle: number,
  fill: boolean = false,
  /** should account for zoom */
  radius: number = 0,
) => {
  context.save();
  context.translate(cx, cy);
  context.rotate(angle);
  if (fill) {
    context.fillRect(x - cx, y - cy, width, height);
  }
  if (radius && context.roundRect) {
    context.beginPath();
    context.roundRect(x - cx, y - cy, width, height, radius);
    context.stroke();
    context.closePath();
  } else {
    context.strokeRect(x - cx, y - cy, width, height);
  }
  context.restore();
};
