/**
 * The zoom percentage, drawn huge across the canvas pane while the user is
 * zooming and faded out once they stop.
 *
 * Watches `zoom.value` rather than hooking the zoom gestures, so the wheel,
 * pinch, the keyboard, the footer buttons and zoom-to-fit all show it alike.
 */

import clsx from "clsx";
import React, { useEffect, useRef, useState } from "react";

import { useAppStateValue } from "../hooks/useAppStateValue";

import "./ZoomOverlay.scss";

/** How long after the last zoom change the overlay starts to fade. */
const HIDE_AFTER_MS = 600;

export const ZoomOverlay: React.FC = () => {
  // a selector, as the footer's zoom label reads it: the UI app state leaves
  // zoom out so that the rest of the UI doesn't re-render on every step
  const zoom = useAppStateValue((appState) => appState.zoom.value);
  const [visible, setVisible] = useState(false);
  const previous = useRef(zoom);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    // the first value is wherever the scene opened, not a zoom
    if (zoom === previous.current) {
      return;
    }
    previous.current = zoom;
    setVisible(true);
    if (timer.current != null) {
      window.clearTimeout(timer.current);
    }
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setVisible(false);
    }, HIDE_AFTER_MS);
  }, [zoom]);

  useEffect(
    () => () => {
      if (timer.current != null) {
        window.clearTimeout(timer.current);
      }
    },
    [],
  );

  return (
    <div
      className={clsx("ZoomOverlay", { "ZoomOverlay--visible": visible })}
      aria-hidden
    >
      <span className="ZoomOverlay__value">{Math.round(zoom * 100)}%</span>
    </div>
  );
};
