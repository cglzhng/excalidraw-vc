import { CaptureUpdateAction, unlockAlignments } from "@excalidraw/element";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import { register } from "./register";

/**
 * Hard-alignment actions (see `alignmentLock.ts`).
 *
 * Locking is now a drag gesture — hold Alt while dragging and the soft
 * snap under the pointer is committed to a persistent link on release
 * (see `lockDraggedAlignments` and App's pointer-up handler). This file
 * only retains the keyboard unlock.
 *
 * `unlockAlignment` (Alt+Shift+L): remove all alignment links from the
 * selection (and the reciprocal links pointing back at it).
 */

const applyUpdates = (
  elements: readonly ExcalidrawElement[],
  updated: Map<string, ExcalidrawElement>,
) =>
  updated.size === 0
    ? elements
    : elements.map((el) => updated.get(el.id) ?? el);

export const actionUnlockAlignment = register({
  name: "unlockAlignment",
  label: "labels.unlockAlignment",
  trackEvent: { category: "element" },
  predicate: (elements, appState, _appProps, app) =>
    app.scene
      .getSelectedElements(appState)
      .some((el) => (el.alignments?.length ?? 0) > 0),
  perform: (elements, appState, _, app) => {
    const selected = app.scene.getSelectedElements(appState);
    const updated = unlockAlignments(
      selected,
      app.scene.getNonDeletedElementsMap(),
    );
    return {
      appState,
      elements: applyUpdates(elements, updated),
      captureUpdate:
        updated.size > 0
          ? CaptureUpdateAction.IMMEDIATELY
          : CaptureUpdateAction.EVENTUALLY,
    };
  },
  keyTest: (event) =>
    event.altKey && event.shiftKey && event.code === "KeyL",
});
