import React, { useCallback, useEffect, useState } from "react";

import {
  findDependencies,
  findRelatedOps,
} from "../versionLog/dependencyAnalysis";
import { computeHoverPreview } from "../versionLog/hoverPreview";

import { useApp, useExcalidrawSetAppState } from "./App";
import {
  VersionLogMomentCard,
  renderOpContent,
} from "./VersionLogMomentCard";

import type { LogMoment, LogOperation } from "../versionLog/types";

import type { VersionLog } from "../versionLog/VersionLog";

import "./VersionLogPanel.scss";

/**
 * Subscribes a component to a `VersionLog` instance and returns the
 * current moments (newest-first). Re-renders on each ingest.
 */
const useVersionLogMoments = (log: VersionLog): readonly LogMoment[] => {
  const [moments, setMoments] = useState<readonly LogMoment[]>(() =>
    log.getMoments(),
  );

  useEffect(() => {
    setMoments(log.getMoments());
    const off = log.onChangeEmitter.on(() => {
      setMoments(log.getMoments());
    });
    return off;
  }, [log]);

  return moments;
};

/**
 * Subscribe to the cursor (current-moment id) on a `VersionLog`.
 * The panel uses this both to render the "Current" badge and to
 * decide whether the Jump button on a row is a no-op.
 */
const useVersionLogCursor = (log: VersionLog): string | null => {
  const [cursor, setCursor] = useState<string | null>(() =>
    log.getCurrentMomentId(),
  );

  useEffect(() => {
    setCursor(log.getCurrentMomentId());
    const off = log.onChangeEmitter.on(() => {
      setCursor(log.getCurrentMomentId());
    });
    return off;
  }, [log]);

  return cursor;
};

/**
 * Subscribe to the set of selectively-deactivated moment ids on
 * a `VersionLog`. The panel uses this to render inactive cards as
 * struck-through and to drive the toggle button's state.
 */
const useVersionLogInactive = (log: VersionLog): ReadonlySet<string> => {
  const [inactive, setInactive] = useState<ReadonlySet<string>>(() =>
    log.getInactiveMomentIds(),
  );
  useEffect(() => {
    setInactive(log.getInactiveMomentIds());
    const off = log.onChangeEmitter.on(() => {
      setInactive(log.getInactiveMomentIds());
    });
    return off;
  }, [log]);
  return inactive;
};

/**
 * Subscribe to the set of ops the most recent replay couldn't apply
 * because a referent was missing — typically because an earlier op
 * in the dependency chain is currently inactive. Per-op set; the
 * panel puts a warning icon on matching rows.
 */
const useVersionLogSkipped = (log: VersionLog): ReadonlySet<LogOperation> => {
  const [skipped, setSkipped] = useState<ReadonlySet<LogOperation>>(() =>
    log.getSkippedByReplay(),
  );
  useEffect(() => {
    setSkipped(log.getSkippedByReplay());
    const off = log.onChangeEmitter.on(() => {
      setSkipped(log.getSkippedByReplay());
    });
    return off;
  }, [log]);
  return skipped;
};

/**
 * Subscribe to the debug dependency-highlight set on a `VersionLog`.
 * Each op in `hard` would become unapplicable if the hovered op were
 * selectively undone; each op in `soft` would still apply but with
 * a different baseline. Used by the panel to tint matching rows.
 */
const useVersionLogDependencyHighlight = (
  log: VersionLog,
): { hard: Set<LogOperation>; soft: Set<LogOperation> } | null => {
  const [deps, setDeps] = useState(() => log.getDependencyHighlight());
  useEffect(() => {
    setDeps(log.getDependencyHighlight());
    const off = log.onChangeEmitter.on(() => {
      setDeps(log.getDependencyHighlight());
    });
    return off;
  }, [log]);
  return deps;
};

/**
 * Subscribe to the click-to-filter focus on a `VersionLog`. When set,
 * the panel collapses to just `ops` (the focus op's dependency
 * neighbourhood) with `focus` styled as the anchor. `null` = show all.
 */
const useVersionLogFilter = (
  log: VersionLog,
): { focus: LogOperation; ops: Set<LogOperation> } | null => {
  const [filter, setFilter] = useState(() => log.getFilter());
  useEffect(() => {
    setFilter(log.getFilter());
    const off = log.onChangeEmitter.on(() => {
      setFilter(log.getFilter());
    });
    return off;
  }, [log]);
  return filter;
};

// ----------------------------- panel --------------------------------

export const VersionLogPanel: React.FC = () => {
  const app = useApp();
  const setAppState = useExcalidrawSetAppState();
  const log: VersionLog = app.versionLog;

  /**
   * Hover: compute the ghost / bbox preview for this op and hand it to
   * the interactive canvas via appState. Also (debug) compute the op's
   * dependency set so the panel can tint hard / soft dependency rows.
   */
  const onHoverOperation = useCallback(
    (op: LogOperation | null) => {
      if (op == null) {
        setAppState({ versionLogHoverPreview: null });
        log.setDependencyHighlight(null);
        return;
      }
      const elementsMap = app.scene.getElementsMapIncludingDeleted();
      setAppState({
        versionLogHoverPreview: computeHoverPreview(
          op,
          log,
          new Map(elementsMap),
        ),
      });
      log.setDependencyHighlight(findDependencies(op, log));
    },
    [app, log, setAppState],
  );

  /**
   * Click-to-filter, as a toggle: clicking the current focus (or the
   * banner's Clear, which passes null) drops the filter; any other op
   * focuses its dependency neighbourhood.
   */
  const onFilterOperation = useCallback(
    (op: LogOperation | null) => {
      const current = log.getFilter();
      if (op == null || current?.focus === op) {
        log.setFilter(null);
        return;
      }
      log.setFilter({ focus: op, ops: findRelatedOps(op, log) });
    },
    [log],
  );

  const onJump = app.jumpToVersionLogMoment;
  const onToggleActive = app.toggleVersionLogMoment;

  const moments = useVersionLogMoments(log);
  const cursorId = useVersionLogCursor(log);
  const depHighlight = useVersionLogDependencyHighlight(log);
  const inactiveIds = useVersionLogInactive(log);
  const skippedOps = useVersionLogSkipped(log);
  const filter = useVersionLogFilter(log);

  // With a filter active, hide moments that contribute no ops to
  // the neighbourhood; the surviving cards force-expand to reveal only
  // their matching ops.
  const visibleMoments = filter
    ? moments.filter((m) => m.operations.some((op) => filter.ops.has(op)))
    : moments;

  return (
    <div
      className="VersionLogPanel"
      style={{
        // participate in the parent sidebar tabpanel's flex column;
        // `min-height: 0` is required so the inner scroll region can
        // actually shrink below its content size.
        display: "flex",
        flexDirection: "column",
        flex: "1 1 0",
        minHeight: 0,
        padding: 8,
        boxSizing: "border-box",
      }}
    >
      <div
        className="VersionLogPanel__header"
        style={{
          // pinned header — does not scroll
          flex: "0 0 auto",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 13 }}>Version log</h3>
        <span style={{ fontSize: 11, opacity: 0.6 }}>
          {filter
            ? `${filter.ops.size} related`
            : `${moments.length} ${
                moments.length === 1 ? "moment" : "moments"
              }`}
        </span>
      </div>
      {filter && (
        <div
          className="VersionLogPanel__filterBanner"
          style={{
            flex: "0 0 auto",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
            marginBottom: 8,
            padding: "4px 8px",
            fontSize: 11,
            borderRadius: 4,
          }}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
            Filtering by{" "}
            <span style={{ opacity: 0.85 }}>
              {renderOpContent(filter.focus)}
            </span>
          </span>
          <button
            type="button"
            onClick={() => onFilterOperation(null)}
            style={{
              all: "unset",
              cursor: "pointer",
              flex: "0 0 auto",
              padding: "2px 6px",
              fontSize: 10,
              fontWeight: 600,
              color: "var(--vlog-primary)",
              border: "1px solid var(--vlog-primary)",
              borderRadius: 4,
            }}
          >
            Clear
          </button>
        </div>
      )}
      {moments.length === 0 ? (
        <p style={{ fontSize: 12, opacity: 0.6 }}>
          No moments recorded yet. Create, edit, or delete something on the
          canvas.
        </p>
      ) : (
        <ul
          className="VersionLogPanel__list"
          style={{
            // the actual scroll region
            flex: "1 1 auto",
            minHeight: 0,
            overflowY: "auto",
            listStyle: "none",
            margin: 0,
            padding: 0,
          }}
        >
          {visibleMoments.map((moment) => (
            <VersionLogMomentCard
              key={moment.id}
              moment={moment}
              // Cursor-driven: the moment whose id matches the log's
              // cursor is "current". Falls back to the head when the
              // cursor is null (fresh log).
              isCurrent={
                cursorId == null
                  ? moment.id === moments[0]?.id
                  : moment.id === cursorId
              }
              isInactive={inactiveIds.has(moment.id)}
              hardDeps={depHighlight?.hard}
              softDeps={depHighlight?.soft}
              skippedOps={skippedOps}
              filterOps={filter?.ops}
              focusOp={filter?.focus ?? null}
              onJump={onJump}
              onToggleActive={onToggleActive}
              onHoverOperation={onHoverOperation}
              onFilterOperation={onFilterOperation}
            />
          ))}
        </ul>
      )}
    </div>
  );
};
