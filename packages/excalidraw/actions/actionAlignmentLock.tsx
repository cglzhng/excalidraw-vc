import {
  CaptureUpdateAction,
  unlockAlignments,
  unlockGapAlignments,
} from "@excalidraw/element";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import { register } from "./register";

/**
 * Hard-alignment actions (see `alignment.ts`).
 *
 * `unlockAlignment` (Alt+Shift+L): remove all alignment links from the
 * selection — edge links (and the reciprocal links pointing back at it)
 * and equal-gap triples alike. One key clears every constraint on the
 * selection, so the user never has to know which kind is holding them.
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
      .some(
        (el) =>
          (el.alignments?.length ?? 0) > 0 ||
          (el.gapAlignments?.length ?? 0) > 0,
      ),
  perform: (elements, appState, _, app) => {
    const selected = app.scene.getSelectedElements(appState);
    const elementsMap = app.scene.getNonDeletedElementsMap();
    // Both passes read the same (unmodified) map, so their updates are
    // built independently; merge them, with the gap pass applied on top
    // of whatever the edge pass produced for the same element.
    const updated = unlockAlignments(selected, elementsMap);
    for (const [id, el] of unlockGapAlignments(selected, elementsMap)) {
      const edgeCleared = updated.get(id);
      updated.set(
        id,
        edgeCleared
          ? { ...edgeCleared, gapAlignments: el.gapAlignments }
          : el,
      );
    }
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
