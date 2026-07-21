import React, { useState } from "react";

import {
  collectElementIdsFromGroupNode,
  getOperationElementIds,
  type LogEntry,
  type LogEntryType,
  type LogMoment,
  type LogOperation,
} from "../versionLog/types";

// --------------------------- shared helpers --------------------------

// Colors resolve to `--vlog-*` custom properties defined in
// `VersionLogPanel.scss` (scoped to `.VersionLogPanel`, which every
// card renders inside). Edit the palette there, not here.
const TYPE_COLOR: Record<LogEntryType, string> = {
  create: "var(--vlog-type-create)",
  update: "var(--vlog-type-update)",
  delete: "var(--vlog-type-delete)",
};

/**
 * Per-operation accent color, one `--vlog-op-*` variable per kind.
 */
const OP_COLOR: Record<LogOperation["kind"], string> = {
  create: "var(--vlog-op-create)",
  delete: "var(--vlog-op-delete)",
  move: "var(--vlog-op-move)",
  "move-group": "var(--vlog-op-move-group)",
  resize: "var(--vlog-op-resize)",
  "resize-group": "var(--vlog-op-resize-group)",
  rotate: "var(--vlog-op-rotate)",
  "rotate-group": "var(--vlog-op-rotate-group)",
  restyle: "var(--vlog-op-restyle)",
  "arrow-edit-points": "var(--vlog-op-arrow-edit-points)",
  "arrow-bind": "var(--vlog-op-arrow-bind)",
  "arrow-move-binding": "var(--vlog-op-arrow-move-binding)",
  "arrow-resize": "var(--vlog-op-arrow-resize)",
  "arrow-rotate": "var(--vlog-op-arrow-rotate)",
  group: "var(--vlog-op-group)",
  ungroup: "var(--vlog-op-ungroup)",
  alignment: "var(--vlog-op-alignment)",
  raw: "var(--vlog-op-raw)",
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

/**
 * Render a (possibly null) world-space pivot point. `null` means
 * "no unique fixed point" (e.g. an axis-only scale or a degenerate
 * matrix); we show "—" so the row still parses visually.
 */
const formatCenter = (center: readonly [number, number] | null): string =>
  center == null
    ? "—"
    : `(${formatValue(center[0])}, ${formatValue(center[1])})`;

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
 *
 * Exported because the panel's filter banner reuses it to label the
 * click-to-filter focus op.
 */
export const renderOpContent = (op: LogOperation): React.ReactNode => {
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
          <br />
          Center: {formatCenter(op.center)}
        </>
      );

    case "rotate":
      return (
        <>
          <strong>Rotated</strong> {formatElementLabel(op.elementType)}{" "}
          {Math.round(radToDeg(op.from))}° → {Math.round(radToDeg(op.to))}°
          <br />
          Center: {formatCenter(op.center)}
        </>
      );
    case "rotate-group":
      return (
        <>
          <strong>Rotated group</strong> of {op.elementIds.length} by{" "}
          {formatValue(op.angle)}
          <br />
          Center: {formatCenter(op.center)}
        </>
      );
    case "restyle":
      return (
        <>
          <strong>Restyled</strong> {formatElementLabel(op.elementType)}{" "}
          {op.property}: <code>{formatValue(op.from)}</code> →{" "}
          <code>{formatValue(op.to)}</code>
        </>
      );
    case "arrow-edit-points": {
      const before = op.before;
      const after = op.after;
      // Headline depends on the kind of edit: count change, single
      // point moved, or general reshape.
      if (before.length !== after.length) {
        const delta = after.length - before.length;
        return (
          <>
            <strong>{delta > 0 ? "Added" : "Removed"} arrow waypoint</strong> (
            {before.length} → {after.length} points)
          </>
        );
      }
      // Same length: count which points differ.
      let differing = 0;
      let lastChangedIdx = -1;
      for (let i = 0; i < before.length; i++) {
        if (before[i][0] !== after[i][0] || before[i][1] !== after[i][1]) {
          differing += 1;
          lastChangedIdx = i;
        }
      }
      if (differing === 1) {
        const isEndpoint =
          lastChangedIdx === 0 || lastChangedIdx === before.length - 1;
        return (
          <>
            <strong>
              {isEndpoint ? "Moved arrow endpoint" : "Moved arrow waypoint"}
            </strong>{" "}
            ({formatValue(before[lastChangedIdx][0])},{" "}
            {formatValue(before[lastChangedIdx][1])}) → (
            {formatValue(after[lastChangedIdx][0])},{" "}
            {formatValue(after[lastChangedIdx][1])})
          </>
        );
      }
      return (
        <>
          <strong>Reshaped arrow</strong> ({differing} of {before.length} points
          changed)
        </>
      );
    }
    case "arrow-bind": {
      // Describe each affected side as bind / unbind / rebind based
      // on the null-vs-value shape of before/after.
      const describe = (
        side: "start" | "end",
        change: { before: unknown; after: unknown },
      ): string => {
        if (change.before == null && change.after != null) {
          return `Bound ${side}`;
        }
        if (change.before != null && change.after == null) {
          return `Unbound ${side}`;
        }
        return `Rebound ${side}`;
      };
      const parts: string[] = [];
      if (op.start) {
        parts.push(describe("start", op.start));
      }
      if (op.end) {
        parts.push(describe("end", op.end));
      }
      return (
        <>
          <strong>{parts.join(" + ")}</strong> on arrow
        </>
      );
    }
    case "arrow-move-binding": {
      // List which sides had their anchor moved, with the bound
      // element id for context.
      const parts: string[] = [];
      if (op.start) {
        parts.push(`start on ${op.start.boundElementId.slice(0, 6)}…`);
      }
      if (op.end) {
        parts.push(`end on ${op.end.boundElementId.slice(0, 6)}…`);
      }
      return (
        <>
          <strong>Moved arrow anchor</strong> ({parts.join(" + ")})
        </>
      );
    }
    case "arrow-resize":
      return (
        <>
          <strong>Resized arrow</strong> {Math.round(op.from.width)}×
          {Math.round(op.from.height)} → {Math.round(op.to.width)}×
          {Math.round(op.to.height)}
          <br />({formatValue(op.scaleX)}, {formatValue(op.scaleY)})
        </>
      );
    case "arrow-rotate":
      return (
        <>
          <strong>Rotated arrow</strong> {Math.round(radToDeg(op.from))}° →{" "}
          {Math.round(radToDeg(op.to))}°
        </>
      );
    case "group":
      return (
        <>
          <strong>Grouped</strong>{" "}
          {collectElementIdsFromGroupNode(op.group).length} elements
        </>
      );
    case "ungroup":
      return (
        <>
          <strong>Ungrouped</strong>{" "}
          {collectElementIdsFromGroupNode(op.group).length} elements
        </>
      );
    case "alignment":
      return (
        <>
          <strong>
            {op.action === "lock" ? "Locked" : "Unlocked"} alignment
          </strong>{" "}
          of {op.elementIds.length} elements
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
  /** Debug: this op is a HARD dependency of whatever is being hovered. */
  isHardDep?: boolean;
  /** Debug: this op is a SOFT dependency of whatever is being hovered. */
  isSoftDep?: boolean;
  /**
   * True when the most recent replay had to skip this op because a
   * referent was missing — usually caused by an earlier selectively-
   * undone op. Surfaced with a small warning icon.
   */
  isSkipped?: boolean;
  /**
   * True when this op is the anchor of the active click-to-filter —
   * the row the user clicked to collapse the timeline around.
   */
  isFilterFocus?: boolean;
  onHoverOperation?: (op: LogOperation | null) => void;
  /** Click-to-filter: collapse the log to this op's dependency neighbourhood. */
  onFilterOperation?: (op: LogOperation) => void;
}> = ({
  op,
  isHardDep,
  isSoftDep,
  isSkipped,
  isFilterFocus,
  onHoverOperation,
  onFilterOperation,
}) => {
  const ids = getOperationElementIds(op);
  const color = OP_COLOR[op.kind];

  // Consequence ops absorbed into this op at classification time (a bound
  // arrow following a moved/resized/rotated element). Present only on the
  // transform kinds; rendered as smaller, indented sub-rows so the moment
  // still reads as "one action" while the follow-on stays visible.
  const consequentOps: LogOperation[] =
    (op as { consequentOps?: LogOperation[] }).consequentOps ?? [];

  const handleMouseEnter = () => onHoverOperation?.(op);
  const handleMouseLeave = () => onHoverOperation?.(null);
  const handleClick = () => onFilterOperation?.(op);

  // Background priority: filter focus (primary wash) > hard dep (red) >
  // soft dep (amber) > none. Hover-driven dep tints and the click-driven
  // focus can both be active, so focus wins to stay legible.
  const background = isFilterFocus
    ? "var(--vlog-focus-bg)"
    : isHardDep
    ? "var(--vlog-hard-dep-bg)"
    : isSoftDep
    ? "var(--vlog-soft-dep-bg)"
    : "var(--vlog-entry-bg)";

  return (
    <li
      className="VersionLogPanel__entry"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={onFilterOperation ? handleClick : undefined}
      title={
        onFilterOperation
          ? "Filter the log to this change and its dependencies"
          : undefined
      }
      style={{
        borderLeft: `3px solid ${color}`,
        padding: "6px 8px",
        marginBottom: 4,
        fontSize: 12,
        fontFamily: "var(--vlog-font)",
        background,
        cursor: onFilterOperation ? "pointer" : undefined,
        outline: isFilterFocus ? "1px solid var(--vlog-primary)" : undefined,
      }}
    >
      <div
        className="VersionLogPanel__entryHeader"
        style={{ display: "flex", justifyContent: "space-between", gap: 8 }}
      >
        <span style={{ color }}>
          {isSkipped && (
            <span
              title="Skipped during replay: a referenced element / group is missing because an earlier op is deactivated"
              style={{
                marginRight: 4,
                color: "var(--vlog-danger)",
                fontWeight: 700,
                cursor: "help",
              }}
            >
              ⚠
            </span>
          )}
          {renderOpContent(op)}
        </span>
        <span
          style={{ opacity: 0.5, fontFamily: "monospace", fontSize: 11 }}
          title={ids.join(", ")}
        >
          {ids.length === 1 ? `${ids[0].slice(0, 8)}…` : `${ids.length} ids`}
        </span>
      </div>
      {op.kind === "raw" && <RawChangedProperties entry={op.entry} />}
      {consequentOps.length > 0 && (
        <ul
          className="VersionLogPanel__consequents"
          style={{ listStyle: "none", margin: "3px 0 0 0", padding: 0 }}
        >
          {consequentOps.map((cop, i) => (
            <li
              key={i}
              className="VersionLogPanel__consequent"
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 4,
                marginTop: 2,
                marginLeft: 14,
                paddingLeft: 6,
                borderLeft: `2px solid ${OP_COLOR[cop.kind]}`,
                fontSize: 10.5,
                lineHeight: 1.3,
                // Muted + smaller so it reads as a secondary detail of the
                // parent op rather than a peer operation.
                opacity: 0.7,
                color: OP_COLOR[cop.kind],
              }}
            >
              <span aria-hidden="true" style={{ opacity: 0.6 }}>
                ↳
              </span>
              <span>{renderOpContent(cop)}</span>
            </li>
          ))}
        </ul>
      )}
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

export const VersionLogMomentCard: React.FC<{
  moment: LogMoment;
  /**
   * True when this moment is the one the document is currently at
   * (matches `VersionLog.getCurrentMomentId()`). Disables the Jump
   * button and shows a "Current" badge instead.
   */
  isCurrent: boolean;
  /** True when this moment is selectively deactivated. */
  isInactive: boolean;
  /** Debug: ops that are HARD dependencies of the hovered op. */
  hardDeps?: Set<LogOperation>;
  /** Debug: ops that are SOFT dependencies of the hovered op. */
  softDeps?: Set<LogOperation>;
  /** Per-op set of replay-skipped ops; matches put a warning icon on the row. */
  skippedOps?: ReadonlySet<LogOperation>;
  /**
   * When set, only ops in this set are shown (click-to-filter active).
   * The card is force-expanded so the surviving ops are visible.
   */
  filterOps?: Set<LogOperation>;
  /** The click-to-filter anchor op, styled distinctly when present in this card. */
  focusOp?: LogOperation | null;
  onJump?: (momentId: string) => void;
  onToggleActive?: (momentId: string) => void;
  onHoverOperation?: (op: LogOperation | null) => void;
  onFilterOperation?: (op: LogOperation) => void;
}> = ({
  moment,
  isCurrent,
  isInactive,
  hardDeps,
  softDeps,
  skippedOps,
  filterOps,
  focusOp,
  onJump,
  onToggleActive,
  onHoverOperation,
  onFilterOperation,
}) => {
  const [isExpanded, setIsExpanded] = useState(true);

  const toggle = () => setIsExpanded((v) => !v);

  // When a filter is active, show only the matching ops and keep the
  // card open regardless of the local collapse state — the user is
  // focused on this dependency neighbourhood.
  const visibleOps = filterOps
    ? moment.operations.filter((op) => filterOps.has(op))
    : moment.operations;
  const showOps = isExpanded || filterOps != null;

  const handleJump = (e: React.MouseEvent) => {
    // don't toggle the card when clicking the button
    e.stopPropagation();
    onJump?.(moment.id);
  };

  const handleToggleActive = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleActive?.(moment.id);
  };

  return (
    <li
      className="VersionLogPanel__increment"
      style={{
        listStyle: "none",
        marginBottom: 10,
        padding: 6,
        // Accent the current card so it stands out from the timeline.
        border: isCurrent
          ? "1px solid var(--vlog-primary)"
          : "1px solid var(--vlog-card-border)",
        borderRadius: 6,
        background: isCurrent ? "var(--vlog-current-bg)" : "var(--vlog-card-bg)",
        // Selectively-deactivated cards fade out so the timeline
        // reads as "these ops are paused / hidden from replay."
        opacity: isInactive ? 0.5 : 1,
        textDecoration: isInactive ? "line-through" : "none",
      }}
    >
      <div
        className="VersionLogPanel__incrementHeader"
        aria-expanded={isExpanded}
        style={{
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
          <button
            type="button"
            aria-label="Toggle"
            onClick={toggle}
            style={{
              background: "none",
              border: "none",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 10,
              padding: 0,
              transition: "transform 120ms ease",
              transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
              opacity: 0.6,
            }}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M3 1.5L7 5L3 8.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <CountChip n={moment.counts.create} type="create" symbol="+" />
          <CountChip n={moment.counts.update} type="update" symbol="~" />
          <CountChip n={moment.counts.delete} type="delete" symbol="−" />
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
          <span>{formatTimestamp(moment.timestamp)}</span>
          {onToggleActive && (
            <button
              type="button"
              onClick={handleToggleActive}
              title={
                isInactive
                  ? "Re-include this change in replay"
                  : "Skip this change during replay (selective undo)"
              }
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                all: "unset",
                cursor: "pointer",
                padding: "2px 6px",
                fontSize: 10,
                fontWeight: 600,
                color: isInactive ? "var(--vlog-primary)" : "var(--vlog-danger)",
                border: `1px solid ${
                  isInactive ? "var(--vlog-primary)" : "var(--vlog-danger)"
                }`,
                borderRadius: 4,
              }}
            >
              {isInactive ? "Restore" : "Skip"}
            </button>
          )}
          {isCurrent ? (
            <span
              title="The document is at this point"
              style={{
                padding: "2px 6px",
                fontSize: 10,
                fontWeight: 600,
                color: "var(--vlog-primary)",
                opacity: 1,
              }}
            >
              Current
            </span>
          ) : (
            onJump && (
              <button
                type="button"
                onClick={handleJump}
                title="Jump the document to this point"
                onMouseDown={(e) => e.stopPropagation()}
                style={{
                  all: "unset",
                  cursor: "pointer",
                  padding: "2px 6px",
                  fontSize: 10,
                  fontWeight: 600,
                  color: "var(--vlog-primary)",
                  border: "1px solid var(--vlog-primary)",
                  borderRadius: 4,
                }}
              >
                Jump
              </button>
            )
          )}
        </span>
      </div>
      {showOps && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {visibleOps.map((op, i) => (
            <VersionLogOperationRow
              key={i}
              op={op}
              isHardDep={hardDeps?.has(op)}
              isSoftDep={softDeps?.has(op)}
              isSkipped={skippedOps?.has(op)}
              isFilterFocus={focusOp === op}
              onHoverOperation={onHoverOperation}
              onFilterOperation={onFilterOperation}
            />
          ))}
        </ul>
      )}
    </li>
  );
};
