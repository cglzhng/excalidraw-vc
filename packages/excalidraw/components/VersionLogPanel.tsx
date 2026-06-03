import React, { useEffect, useState } from "react";

import {
  getOperationElementIds,
  type LogEntry,
  type LogEntryType,
  type LogIncrement,
  type LogOperation,
} from "../versionLog/types";

import type { VersionLog } from "../versionLog/VersionLog";

/**
 * Subscribes a component to a `VersionLog` instance and returns the
 * current increments (newest-first). Re-renders on each ingest.
 */
const useVersionLogIncrements = (log: VersionLog): readonly LogIncrement[] => {
  const [increments, setIncrements] = useState<readonly LogIncrement[]>(() =>
    log.getIncrements(),
  );

  useEffect(() => {
    setIncrements(log.getIncrements());
    const off = log.onChangeEmitter.on(() => {
      setIncrements(log.getIncrements());
    });
    return off;
  }, [log]);

  return increments;
};

// --------------------------- shared helpers --------------------------

const TYPE_COLOR: Record<LogEntryType, string> = {
  create: "#2f9e44", // green
  update: "#1971c2", // blue
  delete: "#c92a2a", // red
};

/**
 * Per-operation accent color. Lifecycle ops borrow from the create /
 * update / delete palette; semantic ops get their own shades so the
 * timeline is scannable at a glance.
 */
const OP_COLOR: Record<LogOperation["kind"], string> = {
  create: TYPE_COLOR.create,
  delete: TYPE_COLOR.delete,
  move: "#1971c2",
  "move-group": "#1864ab",
  resize: "#7048e8",
  rotate: "#9c36b5",
  restyle: "#d9480f",
  raw: "#868e96",
};

const formatTimestamp = (ms: number) => {
  const d = new Date(ms);
  return d.toLocaleTimeString();
};

const formatValue = (v: unknown): string => {
  if (v === undefined) {
    return "—";
  }
  if (v === null) {
    return "null";
  }
  if (typeof v === "string") {
    return v.length > 40 ? `${v.slice(0, 37)}…` : v;
  }
  if (typeof v === "number") {
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }
  if (typeof v === "boolean") {
    return String(v);
  }
  try {
    const json = JSON.stringify(v);
    return json.length > 60 ? `${json.slice(0, 57)}…` : json;
  } catch {
    return String(v);
  }
};

const formatDelta = (n: number) => {
  const rounded = Math.round(n * 100) / 100;
  return rounded >= 0 ? `+${rounded}` : `${rounded}`;
};

const radToDeg = (rad: number) => (rad * 180) / Math.PI;

const formatElementLabel = (
  elementType: string | undefined,
  count = 1,
): string => {
  const base = elementType ?? "element";
  return count === 1 ? base : `${count} ${base}s`;
};

// ------------------------- raw-entry rendering ----------------------

const RawChangedProperties: React.FC<{ entry: LogEntry }> = ({ entry }) => {
  const { type, before, after } = entry;

  if (type === "create") {
    const keys = Object.keys(after);
    if (keys.length === 0) {
      return null;
    }
    return (
      <ul className="VersionLogPanel__props">
        {keys.map((k) => (
          <li key={k}>
            <span className="VersionLogPanel__propKey">{k}</span>:{" "}
            <span className="VersionLogPanel__propAfter">
              {formatValue(after[k])}
            </span>
          </li>
        ))}
      </ul>
    );
  }

  if (type === "delete") {
    const keys = Object.keys(before).filter(
      (k) => k !== "version" && k !== "versionNonce",
    );
    if (keys.length === 0) {
      return null;
    }
    return (
      <ul className="VersionLogPanel__props">
        {keys.map((k) => (
          <li key={k}>
            <span className="VersionLogPanel__propKey">{k}</span>:{" "}
            <span className="VersionLogPanel__propBefore">
              {formatValue(before[k])}
            </span>
          </li>
        ))}
      </ul>
    );
  }

  const keys = Array.from(
    new Set([...Object.keys(before), ...Object.keys(after)]),
  ).filter((k) => k !== "version" && k !== "versionNonce");
  if (keys.length === 0) {
    return null;
  }
  return (
    <ul className="VersionLogPanel__props">
      {keys.map((k) => (
        <li key={k}>
          <span className="VersionLogPanel__propKey">{k}</span>:{" "}
          <span className="VersionLogPanel__propBefore">
            {formatValue(before[k])}
          </span>{" "}
          →{" "}
          <span className="VersionLogPanel__propAfter">
            {formatValue(after[k])}
          </span>
        </li>
      ))}
    </ul>
  );
};

// --------------------------- per-op header --------------------------

/**
 * The headline line for an operation row. Returns a short, human title
 * (e.g. "Moved rectangle", "Restyled rectangle stroke color").
 */
const renderOpContent = (op: LogOperation): React.ReactNode => {
  switch (op.kind) {
    case "create":
      return (
        <>
          <strong>Created</strong> {formatElementLabel(op.elementType)}
        </>
      );
    case "delete":
      return (
        <>
          <strong>Deleted</strong> {formatElementLabel(op.elementType)}
        </>
      );
    case "move":
      return (
        <>
          <strong>Moved</strong> {formatElementLabel(op.elementType)} by (
          {formatDelta(op.dx)}, {formatDelta(op.dy)})
        </>
      );
    case "move-group":
      return (
        <>
          <strong>Moved group</strong> of {op.elementIds.length} by (
          {formatDelta(op.dx)}, {formatDelta(op.dy)})
        </>
      );
    case "resize":
      return (
        <>
          <strong>Resized</strong> {formatElementLabel(op.elementType)}{" "}
          {Math.round(op.from.width)}×{Math.round(op.from.height)} →{" "}
          {Math.round(op.to.width)}×{Math.round(op.to.height)}
          <br />({formatValue(op.scaleX)}, {formatValue(op.scaleY)})
        </>
      );
    case "resize-group":
      return (
        <>
          <strong>Resized group</strong> of {op.elementIds.length} by (
          {formatValue(op.scaleX)}, {formatValue(op.scaleY)})
          <br />Center: ({formatValue(op.center[0])}, {formatValue(op.center[1])})
        </>
      );

    case "rotate":
      return (
        <>
          <strong>Rotated</strong> {formatElementLabel(op.elementType)}{" "}
          {Math.round(radToDeg(op.from))}° → {Math.round(radToDeg(op.to))}°
          <br />Center: ({formatValue(op.center[0])}, {formatValue(op.center[1])})
        </>
      );
    case "rotate-group":
      return (
        <>
          <strong>Rotated group</strong> of {op.elementIds.length} by{" "}
          {formatValue(op.angle)}
          <br />Center: ({formatValue(op.center[0])}, {formatValue(op.center[1])})
        </>
      );    case "restyle":
      return (
        <>
          <strong>Restyled</strong> {formatElementLabel(op.elementType)}{" "}
          {op.property}: <code>{formatValue(op.from)}</code> →{" "}
          <code>{formatValue(op.to)}</code>
        </>
      );
    case "raw":
      return (
        <>
          <strong>
            {op.entry.type === "create"
              ? "Created"
              : op.entry.type === "delete"
              ? "Deleted"
              : "Changed"}
          </strong>{" "}
          {formatElementLabel(op.entry.elementType)}
        </>
      );
  }
};

// ------------------------------ row ---------------------------------

const VersionLogOperationRow: React.FC<{
  op: LogOperation;
  onHighlightElements?: (elementIds: string[] | null) => void;
}> = ({ op, onHighlightElements }) => {
  const ids = getOperationElementIds(op);
  const color = OP_COLOR[op.kind];

  const handleMouseEnter = () => onHighlightElements?.(ids);
  const handleMouseLeave = () => onHighlightElements?.(null);

  return (
    <li
      className="VersionLogPanel__entry"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={{
        borderLeft: `3px solid ${color}`,
        padding: "6px 8px",
        marginBottom: 4,
        fontSize: 12,
        fontFamily: "var(--ui-font, sans-serif)",
        background: "var(--default-bg-color, transparent)",
      }}
    >
      <div
        className="VersionLogPanel__entryHeader"
        style={{ display: "flex", justifyContent: "space-between", gap: 8 }}
      >
        <span style={{ color }}>{renderOpContent(op)}</span>
        <span
          style={{ opacity: 0.5, fontFamily: "monospace", fontSize: 11 }}
          title={ids.join(", ")}
        >
          {ids.length === 1 ? `${ids[0].slice(0, 8)}…` : `${ids.length} ids`}
        </span>
      </div>
      {op.kind === "raw" && <RawChangedProperties entry={op.entry} />}
    </li>
  );
};

// --------------------------- count chips ----------------------------

const CountChip: React.FC<{
  n: number;
  type: LogEntryType;
  symbol: string;
}> = ({ n, type, symbol }) => {
  if (n === 0) {
    return null;
  }
  return (
    <span
      style={{
        color: TYPE_COLOR[type],
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {symbol}
      {n}
    </span>
  );
};

// ----------------------------- card ---------------------------------

const VersionLogIncrementCard: React.FC<{
  increment: LogIncrement;
  /** True when this is the newest increment in the log — revert is a no-op there. */
  isCurrent: boolean;
  onRevert?: (incrementId: string) => void;
  onHighlightElements?: (elementIds: string[] | null) => void;
}> = ({ increment, isCurrent, onRevert, onHighlightElements }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const toggle = () => setIsExpanded((v) => !v);

  const handleRevert = (e: React.MouseEvent) => {
    // don't toggle the card when clicking the button
    e.stopPropagation();
    onRevert?.(increment.id);
  };

  return (
    <li
      className="VersionLogPanel__increment"
      style={{
        listStyle: "none",
        marginBottom: 10,
        padding: 6,
        border: "1px solid var(--sidebar-border-color, #d0d0d0)",
        borderRadius: 6,
        background: "var(--island-bg-color, rgba(0, 0, 0, 0.02))",
      }}
    >
      <button
        type="button"
        className="VersionLogPanel__incrementHeader"
        aria-expanded={isExpanded}
        onClick={toggle}
        onKeyDown={(e) => {
          // make Space toggle too (Enter already fires onClick on buttons)
          if (e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
        style={{
          // reset native button look
          all: "unset",
          cursor: "pointer",
          // layout
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
          width: "100%",
          marginBottom: isExpanded ? 6 : 0,
          padding: "2px 4px",
          fontSize: 11,
          fontWeight: 600,
          borderRadius: 4,
          boxSizing: "border-box",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            aria-hidden="true"
            style={{
              display: "inline-block",
              width: 10,
              textAlign: "center",
              transition: "transform 120ms ease",
              transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
              opacity: 0.6,
            }}
          >
            ▸
          </span>
          <CountChip n={increment.counts.create} type="create" symbol="+" />
          <CountChip n={increment.counts.update} type="update" symbol="~" />
          <CountChip n={increment.counts.delete} type="delete" symbol="−" />
        </span>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            opacity: 0.6,
            fontWeight: 400,
          }}
        >
          <span>{formatTimestamp(increment.timestamp)}</span>
          {onRevert && (
            <button
              type="button"
              onClick={handleRevert}
              disabled={isCurrent}
              title={
                isCurrent
                  ? "This is the current state"
                  : "Revert the document to this point"
              }
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                all: "unset",
                cursor: isCurrent ? "default" : "pointer",
                padding: "2px 6px",
                fontSize: 10,
                fontWeight: 600,
                color: isCurrent ? "inherit" : "var(--color-primary, #5b57d1)",
                border: `1px solid ${
                  isCurrent
                    ? "var(--sidebar-border-color, #d0d0d0)"
                    : "var(--color-primary, #5b57d1)"
                }`,
                borderRadius: 4,
                opacity: isCurrent ? 0.4 : 1,
              }}
            >
              Revert
            </button>
          )}
        </span>
      </button>
      {isExpanded && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {increment.operations.map((op, i) => (
            <VersionLogOperationRow
              key={i}
              op={op}
              onHighlightElements={onHighlightElements}
            />
          ))}
        </ul>
      )}
    </li>
  );
};

// ----------------------------- panel --------------------------------

export interface VersionLogPanelProps {
  log: VersionLog;
  /**
   * Called when the user clicks "Revert" on a card. The panel itself
   * does not perform the revert — App owns that side-effect (see
   * `App.revertToVersionLogIncrement`).
   */
  onRevert?: (incrementId: string) => void;
  /**
   * Called on op mouse-enter (with all element ids the op touches) and
   * mouse-leave (with `null`). Owners typically write this into
   * `appState.versionLogHighlightedElementIds`.
   */
  onHighlightElements?: (elementIds: string[] | null) => void;
}

export const VersionLogPanel: React.FC<VersionLogPanelProps> = ({
  log,
  onRevert,
  onHighlightElements,
}) => {
  const increments = useVersionLogIncrements(log);

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
          {increments.length} {increments.length === 1 ? "change" : "changes"}
        </span>
      </div>
      {increments.length === 0 ? (
        <p style={{ fontSize: 12, opacity: 0.6 }}>
          No changes recorded yet. Create, edit, or delete something on the
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
          {increments.map((increment, i) => (
            <VersionLogIncrementCard
              key={increment.id}
              increment={increment}
              // newest-first ordering: index 0 == current state
              isCurrent={i === 0}
              onRevert={onRevert}
              onHighlightElements={onHighlightElements}
            />
          ))}
        </ul>
      )}
    </div>
  );
};
