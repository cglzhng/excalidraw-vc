import { useEffect, useState } from "react";

import {
  KEYS,
  matchKey,
  arrayToMap,
  MOBILE_ACTION_BUTTON_BG,
} from "@excalidraw/common";

import { CaptureUpdateAction } from "@excalidraw/element";

import { orderByFractionalIndex } from "@excalidraw/element";

import type { SceneElementsMap } from "@excalidraw/element/types";

import { IconButton } from "../components/IconButton";
import { UndoIcon, RedoIcon } from "../components/icons";
import { HistoryChangedEvent } from "../history";
import { useEmitter } from "../hooks/useEmitter";
import { t } from "../i18n";

import { useStylesPanelMode } from "../components/App";

import type { History } from "../history";
import type { AppClassProperties, AppState } from "../types";
import type { Action, ActionResult } from "./types";

const executeHistoryAction = (
  app: AppClassProperties,
  appState: Readonly<AppState>,
  updater: () => [SceneElementsMap, AppState] | void,
): ActionResult => {
  if (
    !appState.multiElement &&
    !appState.resizingElement &&
    !appState.editingTextElement &&
    !appState.newElement &&
    !appState.selectedElementsAreBeingDragged &&
    !appState.selectionElement &&
    !app.flowchart.isCreatingChart &&
    // a drawShape sketch in progress isn't visible via `newElement` while
    // the stroke is still unrecognized — block history mid-gesture the same
    // way as for the other in-progress interactions above
    !app.drawShape.hasPendingGesture()
  ) {
    const result = updater();

    if (!result) {
      return { captureUpdate: CaptureUpdateAction.EVENTUALLY };
    }

    const [nextElementsMap, nextAppState] = result;

    // order by fractional indices in case the map was accidently modified in the meantime
    const nextElements = orderByFractionalIndex(
      Array.from(nextElementsMap.values()),
    );

    return {
      appState: nextAppState,
      elements: nextElements,
      captureUpdate: CaptureUpdateAction.NEVER,
    };
  }

  return { captureUpdate: CaptureUpdateAction.EVENTUALLY };
};

/**
 * Whether undo / redo walk the version log (`App.undoVersionLogMoment`)
 * or Excalidraw's own history. Excalidraw's commits with
 * `CaptureUpdateAction.NEVER` and so never reaches the log — the next
 * replay brings an undone change back.
 */
export const UNDO_THROUGH_VERSION_LOG = true;

/**
 * The version-log step, behind the same in-progress-interaction guard.
 * The App method updates the scene itself, so the updater returns
 * nothing and the action reports no change.
 */
const executeVersionLogStep = (
  app: AppClassProperties,
  appState: Readonly<AppState>,
  step: () => void,
): ActionResult =>
  executeHistoryAction(app, appState, () => {
    // a toggle is already waiting on the conflict modal
    if (!appState.versionLogPendingConflicts) {
      step();
    }
  });

/** Whether the version log has a moment to undo / redo, kept current. */
const useVersionLogHasTarget = (
  app: AppClassProperties,
  direction: "undo" | "redo",
): boolean => {
  const log = app.versionLog;
  const read = () =>
    (direction === "undo" ? log.getUndoTarget() : log.getRedoTarget()) !=
    null;
  const [hasTarget, setHasTarget] = useState(read);
  useEffect(() => {
    setHasTarget(read());
    return log.onChangeEmitter.on(() => setHasTarget(read()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [log, direction]);
  return hasTarget;
};

type ActionCreator = (history: History) => Action;

export const createUndoAction: ActionCreator = (history) => ({
  name: "undo",
  label: "buttons.undo",
  icon: UndoIcon,
  trackEvent: { category: "history" },
  viewMode: false,
  perform: (elements, appState, value, app) =>
    UNDO_THROUGH_VERSION_LOG
      ? executeVersionLogStep(app, appState, app.undoVersionLogMoment)
      : executeHistoryAction(app, appState, () =>
          history.undo(
            arrayToMap(elements) as SceneElementsMap,
            appState,
            app.renderEnvironment,
          ),
        ),
  keyTest: (event) =>
    event[KEYS.CTRL_OR_CMD] && matchKey(event, KEYS.Z) && !event.shiftKey,
  PanelComponent: ({ appState, updateData, data, app }) => {
    const { isUndoStackEmpty } = useEmitter<HistoryChangedEvent>(
      history.onHistoryChangedEmitter,
      new HistoryChangedEvent(
        history.isUndoStackEmpty,
        history.isRedoStackEmpty,
      ),
    );
    const logCanUndo = useVersionLogHasTarget(app, "undo");
    const disabled = UNDO_THROUGH_VERSION_LOG ? !logCanUndo : isUndoStackEmpty;
    const isMobile = useStylesPanelMode() === "mobile";

    return (
      <IconButton
        type="button"
        icon={UndoIcon}
        aria-label={t("buttons.undo")}
        onClick={updateData}
        size={data?.size || "medium"}
        disabled={disabled}
        data-testid="button-undo"
        style={{
          ...(isMobile ? MOBILE_ACTION_BUTTON_BG : {}),
        }}
      />
    );
  },
});

export const createRedoAction: ActionCreator = (history) => ({
  name: "redo",
  label: "buttons.redo",
  icon: RedoIcon,
  trackEvent: { category: "history" },
  viewMode: false,
  perform: (elements, appState, __, app) =>
    UNDO_THROUGH_VERSION_LOG
      ? executeVersionLogStep(app, appState, app.redoVersionLogMoment)
      : executeHistoryAction(app, appState, () =>
          history.redo(
            arrayToMap(elements) as SceneElementsMap,
            appState,
            app.renderEnvironment,
          ),
        ),
  keyTest: (event) =>
    (event[KEYS.CTRL_OR_CMD] && event.shiftKey && matchKey(event, KEYS.Z)) ||
    (event[KEYS.CTRL_OR_CMD] && !event.shiftKey && matchKey(event, KEYS.Y)),
  PanelComponent: ({ appState, updateData, data, app }) => {
    const { isRedoStackEmpty } = useEmitter(
      history.onHistoryChangedEmitter,
      new HistoryChangedEvent(
        history.isUndoStackEmpty,
        history.isRedoStackEmpty,
      ),
    );
    const logCanRedo = useVersionLogHasTarget(app, "redo");
    const disabled = UNDO_THROUGH_VERSION_LOG ? !logCanRedo : isRedoStackEmpty;
    const isMobile = useStylesPanelMode() === "mobile";

    return (
      <IconButton
        type="button"
        icon={RedoIcon}
        aria-label={t("buttons.redo")}
        onClick={updateData}
        size={data?.size || "medium"}
        disabled={disabled}
        data-testid="button-redo"
        style={{
          ...(isMobile ? MOBILE_ACTION_BUTTON_BG : {}),
        }}
      />
    );
  },
});
