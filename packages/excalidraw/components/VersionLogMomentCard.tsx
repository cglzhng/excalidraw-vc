import React, { useCallback, useState } from "react";

import {
  collectElementIdsFromGroupNode,
  getOperationElementIds,
  summarizeAlignmentOp,
  type ConsequenceReason,
  type ConsequentOp,
  type LogEntry,
  type LogMoment,
  type LogOperation,
} from "../versionLog/types";

import { THEME } from "@excalidraw/common";

import { useApp, useExcalidrawAppState } from "./App";

// --------------------------- shared helpers --------------------------

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
  "alignment-anchor": "var(--vlog-op-alignment)",
  raw: "var(--vlog-op-raw)",
};

/**
 * How long ago a moment was, rather than the wall-clock time it
 * happened. A column of "6:50:19 p.m." says almost nothing — what the
 * eye is after is how far back a change is and how much happened
 * between one and the next, which elapsed time gives directly. The exact
 * time stays in the tooltip.
 *
 * `now` is passed in so every card in a render agrees, and so the panel
 * can refresh them together.
 */
const formatElapsed = (ms: number, now: number) => {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 10) {
    return "just now";
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : new Date(ms).toLocaleDateString();
};

const formatTimestamp = (ms: number) => new Date(ms).toLocaleString();

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

/** Whole pixels, signed. Sub-pixel digits on a drag are noise: nobody
 * placed a shape at 265.22, the pointer did. */
const formatDelta = (n: number) => {
  const rounded = Math.round(n);
  return rounded >= 0 ? `+${rounded}` : `${rounded}`;
};

/** A translation, always as the pair: every move reads the same way, so
 * the eye can compare one row against the next without first working out
 * which shape this one took. */
const formatMove = (dx: number, dy: number): string =>
  `(${formatDelta(dx)}, ${formatDelta(dy)})`;

const radToDeg = (rad: number) => (rad * 180) / Math.PI;

/**
 * Render a (possibly null) world-space pivot point. `null` means
 * "no unique fixed point" (e.g. an axis-only scale or a degenerate
 * matrix); we show "—" so the row still parses visually.
 */
const formatCenter = (center: readonly [number, number] | null): string =>
  center == null
    ? "—"
    : `(${Math.round(center[0])}, ${Math.round(center[1])})`;

/** An element's short id when it has one, else its type — "R3" rather
 * than "rectangle". The prefix already says what it is, so naming the
 * type as well would be saying it twice. */
const formatElementLabel = (
  elementType: string | undefined,
  shortId?: string,
): string => shortId ?? elementType ?? "element";

/**
 * Look an element's short id up by its real id, deleted ones included —
 * a `delete` op names an element that is, by then, gone from the canvas
 * but still in the scene.
 */
export const useShortIdOf = () => {
  const app = useApp();
  return useCallback(
    (elementId: string): string | undefined =>
      app.scene.getElementsMapIncludingDeleted().get(elementId)?.shortId,
    [app],
  );
};

/** "R1", "R1 and R2", "R1, R2 and R3". */
const formatList = (items: readonly string[]): string =>
  items.length <= 1
    ? items[0] ?? ""
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/**
 * What an alignment's edge is called on each axis.
 *
 * Named by edge rather than by axis: "left" says what the user did,
 * where "horizontally" has to be decoded into which coordinate is being
 * held equal — and the two readings of that word point opposite ways
 * depending on whether you think about the shared line or the row the
 * elements sit in. The middle words differ per axis for the same
 * reason, so a centre alignment still says which one it is.
 */
const EDGE_WORDS: Record<"x" | "y", Record<"min" | "center" | "max", string>> = {
  x: { min: "left", center: "center", max: "right" },
  y: { min: "top", center: "middle", max: "bottom" },
};

// ---------------------- consequence reason marks ---------------------

/**
 * The mark on a consequent row, saying what carried the change to it.
 *
 * The same badges the canvas draws for these relationships, at panel
 * size: the disc and rim, the alignment line lying along its guide's
 * direction, the equal-gap equals sign, the binding padlock — in their
 * own colours rather than the row's, so a badge means one thing wherever
 * it is seen.
 *
 * Drawn in the canvas's *soft* form — pale disc, faded rim and glyph —
 * even though a consequence only ever follows a hard relationship. The
 * filled form reads as a control you could press, and nothing here is
 * pressable: the row reports what happened rather than offering to
 * change it.
 *
 * A group co-move has no canvas badge of its own — nothing on the canvas
 * asserts it — so it takes the same disc with a dashed box, in the
 * panel's own ink.
 */
/** The canvas fades an unkept badge's rim and glyph to 0.45; a little
 * stronger here, where the badge is 13px rather than a screen-scaled
 * one and has row text beside it to hold its own against. */
const SOFT_BADGE_OPACITY = 0.6;

const ConsequenceIcon: React.FC<{ reason: ConsequenceReason }> = ({
  reason,
}) => {
  const { theme } = useExcalidrawAppState();
  // the canvas indicator palette (`indicatorHelpers.ts`)
  const alignment = theme === THEME.DARK ? "#ffa8a8" : "#e03131";
  const binding = "#5e5ad8";
  const disc = "#ffffff";

  const svg = (children: React.ReactNode) => (
    <svg width={13} height={13} viewBox="0 0 14 14" aria-hidden="true">
      {children}
    </svg>
  );

  switch (reason.kind) {
    case "alignment":
      return svg(
        <>
          <circle cx="7" cy="7" r="5.5" fill={disc} />
          <g opacity={SOFT_BADGE_OPACITY} stroke={alignment} fill="none">
            <circle cx="7" cy="7" r="5.5" />
            {/* rim to rim, as a soft guide's line runs through its badge */}
            <path d={reason.axis === "x" ? "M7 1.5v11" : "M1.5 7h11"} />
          </g>
        </>,
      );
    case "centering":
      return svg(
        <>
          <circle cx="7" cy="7" r="5.5" fill={disc} />
          <g opacity={SOFT_BADGE_OPACITY} stroke={alignment} fill="none">
            <circle cx="7" cy="7" r="5.5" />
            {/* both centre lines, crossing — the canvas badge for a
                concentric pair */}
            <path d="M7 1.5v11M1.5 7h11" />
          </g>
        </>,
      );
    case "gap-alignment":
      return svg(
        <>
          <circle cx="7" cy="7" r="5.5" fill={disc} />
          <g opacity={SOFT_BADGE_OPACITY} stroke={alignment} fill="none">
            <circle cx="7" cy="7" r="5.5" />
            <path d="M4.4 5.8h5.2M4.4 8.2h5.2" strokeWidth={1.2} />
          </g>
        </>,
      );
    case "binding":
      return svg(
        <>
          <circle cx="7" cy="7" r="5.5" fill={disc} />
          <g opacity={SOFT_BADGE_OPACITY}>
            <circle cx="7" cy="7" r="5.5" fill="none" stroke={binding} />
            <path
              d="M5.3 6.6V5.5a1.7 1.7 0 0 1 3.4 0v1.1"
              fill="none"
              stroke={binding}
            />
            <rect
              x="4.6"
              y="6.5"
              width="4.8"
              height="4"
              rx="0.6"
              fill={binding}
            />
          </g>
        </>,
      );
    case "group":
      return svg(
        <>
          <circle cx="7" cy="7" r="5.5" fill={disc} />
          <g opacity={SOFT_BADGE_OPACITY} stroke="currentColor" fill="none">
            <circle cx="7" cy="7" r="5.5" />
            <rect x="4" y="4" width="6" height="6" strokeDasharray="1.8 1.4" />
          </g>
        </>,
      );
  }
};

const CONSEQUENCE_TITLES: Record<ConsequenceReason["kind"], string> = {
  centering: "followed a centering",
  alignment: "followed a hard alignment",
  "gap-alignment": "followed an equal-spacing chain",
  binding: "followed the element it is bound to",
  group: "moved with its group",
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
export const renderOpContent = (
  op: LogOperation,
  shortIdOf?: (elementId: string) => string | undefined,
): React.ReactNode => {
  // The op's subject, wherever it keeps it — `raw` holds the id on its
  // entry rather than on itself.
  const subjectId =
    "elementId" in op
      ? op.elementId
      : op.kind === "raw"
      ? op.entry.elementId
      : undefined;
  const shortId = subjectId ? shortIdOf?.(subjectId) : undefined;

  switch (op.kind) {
    case "create":
      return (
        <>
          <strong>Created</strong> {formatElementLabel(op.elementType, shortId)}
        </>
      );
    case "delete":
      return (
        <>
          <strong>Deleted</strong> {formatElementLabel(op.elementType, shortId)}
        </>
      );
    case "move":
      return (
        <>
          <strong>Moved</strong> {formatElementLabel(op.elementType, shortId)} by{" "}
          {formatMove(op.dx, op.dy)}
        </>
      );
    case "move-group":
      return (
        <>
          <strong>Moved group</strong> of {op.elementIds.length} by{" "}
          {formatMove(op.dx, op.dy)}
        </>
      );
    case "resize":
      return (
        <>
          <strong>Resized</strong> {formatElementLabel(op.elementType, shortId)}{" "}
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
          <strong>Rotated</strong> {formatElementLabel(op.elementType, shortId)}{" "}
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
          <strong>Restyled</strong> {formatElementLabel(op.elementType, shortId)}{" "}
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
    case "alignment": {
      const summary = summarizeAlignmentOp(op);
      const name = (id: string) => shortIdOf?.(id) ?? "an element";
      const headline = (
        <strong>
          {op.action === "lock" ? "Locked" : "Unlocked"}{" "}
          {op.field === "gapAlignments"
            ? "equal spacing"
            : summary?.kind === "centering"
            ? "centering"
            : "alignment"}
        </strong>
      );

      if (!summary) {
        // nothing in the diff to describe — an op recorded before this
        // read the links, or one whose payload didn't survive a remap
        return (
          <>
            {headline} of {op.elementIds.length} elements
          </>
        );
      }
      if (summary.kind === "gap") {
        return (
          <>
            {headline} of {formatList(summary.ids.map(name))}{" "}
            {summary.axis === "x" ? "horizontally" : "vertically"}
          </>
        );
      }
      if (summary.kind === "centering") {
        return (
          <>
            {headline} of {name(summary.a)} and {name(summary.b)}
          </>
        );
      }
      return (
        <>
          {headline} of {name(summary.a)}{" "}
          {EDGE_WORDS[summary.axis][summary.aEdge]} to {name(summary.b)}{" "}
          {EDGE_WORDS[summary.axis][summary.bEdge]}
        </>
      );
    }
    case "alignment-anchor":
      return (
        <>
          <strong>{op.anchored ? "Anchored" : "Un-Anchored"}</strong>{" "}
          {formatElementLabel(op.elementType, shortId)}
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
          {formatElementLabel(op.entry.elementType, shortId)}
        </>
      );
  }
};

// ------------------------------ row ---------------------------------

/** The per-row action, shown while the row is pointed at. Stops the
 * click from reaching the row, whose own job is the hover preview. */
const FilterButton: React.FC<{ onClick: () => void }> = ({ onClick }) => (
  <button
    type="button"
    className="VersionLogPanel__filterButton"
    title="Filter the log to this change and its dependencies"
    onMouseDown={(e) => e.stopPropagation()}
    onClick={(e) => {
      e.stopPropagation();
      onClick();
    }}
  >
    Filter
  </button>
);

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
  const color = OP_COLOR[op.kind];
  const shortIdOf = useShortIdOf();
  // consequences are rendered by the card, in its collapsible body

  const handleMouseEnter = () => onHoverOperation?.(op);
  const handleMouseLeave = () => onHoverOperation?.(null);

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
    <div
      className="VersionLogPanel__entry"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={{
        padding: "4px 6px",
        marginBottom: 4,
        fontSize: 12,
        fontFamily: "var(--vlog-font)",
        background,
        outline: isFilterFocus ? "1px solid var(--vlog-primary)" : undefined,
      }}
    >
      <div
        className="VersionLogPanel__entryHeader"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 8,
        }}
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
          {renderOpContent(op, shortIdOf)}
        </span>
        {onFilterOperation && (
          <FilterButton onClick={() => onFilterOperation(op)} />
        )}
      </div>
      {op.kind === "raw" && <RawChangedProperties entry={op.entry} />}
    </div>
  );
};

/**
 * One consequence, in the card's collapsible body: the badge for the
 * relationship that carried the change, then what that change was.
 *
 * Clickable like any other row — a consequence is an op, and "show me
 * everything around this" is as reasonable a question of a follower as
 * of the thing that drove it.
 */
const VersionLogConsequentRow: React.FC<{
  op: ConsequentOp;
  onHoverOperation?: (op: LogOperation | null) => void;
  onFilterOperation?: (op: LogOperation) => void;
  isFilterFocus?: boolean;
}> = ({ op, onHoverOperation, onFilterOperation, isFilterFocus }) => {
  const shortIdOf = useShortIdOf();
  const reason = op.consequenceReason;

  return (
    <div
      className="VersionLogPanel__consequent"
      onMouseEnter={() => onHoverOperation?.(op)}
      onMouseLeave={() => onHoverOperation?.(null)}
      title={reason ? CONSEQUENCE_TITLES[reason.kind] : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        padding: "2px 4px",
        fontSize: 10.5,
        lineHeight: 1.3,
        // Muted + smaller so it reads as a consequence of the card's op
        // rather than a peer of it.
        opacity: 0.75,
        color: OP_COLOR[op.kind],
        borderRadius: 3,
        outline: isFilterFocus ? "1px solid var(--vlog-primary)" : undefined,
        background: isFilterFocus ? "var(--vlog-focus-bg)" : undefined,
      }}
    >
      <span style={{ flex: "0 0 auto", display: "inline-flex" }}>
        {reason ? (
          <ConsequenceIcon reason={reason} />
        ) : (
          // reason unknown — an op recorded before this was tracked, or
          // one whose cause didn't survive a remap
          <span aria-hidden="true">↳</span>
        )}
      </span>
      <span style={{ flex: "1 1 auto", minWidth: 0 }}>
        {renderOpContent(op, shortIdOf)}
      </span>
      {onFilterOperation && (
        <FilterButton onClick={() => onFilterOperation(op)} />
      )}
    </div>
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
  /** The panel's clock, so every card's elapsed time agrees and they
   * can be refreshed together. */
  now: number;
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
  now,
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

  const consequentsOf = (op: LogOperation): ConsequentOp[] =>
    (op as { consequentOps?: ConsequentOp[] }).consequentOps ?? [];

  // When a filter is active, show only the matching ops and keep the
  // card open regardless of the local collapse state — the user is
  // focused on this dependency neighbourhood. An op whose *consequence*
  // matches is kept too, since that consequence is the thing to show.
  const visibleOps = filterOps
    ? moment.operations.filter(
        (op) =>
          filterOps.has(op) ||
          consequentsOf(op).some((cop) => filterOps.has(cop)),
      )
    : moment.operations;

  // A moment is one user action, so its first op is what the card is
  // about; anything else it holds, and every consequence of any of them,
  // is detail about that action and lives in the body.
  const [primaryOp, ...otherOps] = visibleOps;
  const consequents = visibleOps.flatMap((op) =>
    consequentsOf(op).filter(
      (cop) => !filterOps || filterOps.has(cop) || filterOps.has(op),
    ),
  );
  const hasBody = otherOps.length > 0 || consequents.length > 0;
  const showBody = hasBody && (isExpanded || filterOps != null);

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
        style={{ display: "flex", alignItems: "flex-start", gap: 4 }}
      >
        {hasBody && (
          <button
            type="button"
            aria-label="Toggle"
            aria-expanded={isExpanded}
            onClick={toggle}
            style={{
              background: "none",
              border: "none",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 10,
              marginTop: 6,
              padding: 0,
              flex: "0 0 auto",
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
        )}
        <div style={{ flex: "1 1 auto", minWidth: 0 }}>
          {primaryOp && (
            <VersionLogOperationRow
              op={primaryOp}
              isHardDep={hardDeps?.has(primaryOp)}
              isSoftDep={softDeps?.has(primaryOp)}
              isSkipped={skippedOps?.has(primaryOp)}
              isFilterFocus={focusOp === primaryOp}
              onHoverOperation={onHoverOperation}
              onFilterOperation={onFilterOperation}
            />
          )}
        </div>
      </div>
      {showBody && (
        <div
          className="VersionLogPanel__consequents"
          style={{ marginLeft: 14, marginTop: 2 }}
        >
          {otherOps.map((op, i) => (
            <VersionLogOperationRow
              key={`op-${i}`}
              op={op}
              isHardDep={hardDeps?.has(op)}
              isSoftDep={softDeps?.has(op)}
              isSkipped={skippedOps?.has(op)}
              isFilterFocus={focusOp === op}
              onHoverOperation={onHoverOperation}
              onFilterOperation={onFilterOperation}
            />
          ))}
          {consequents.map((cop, i) => (
            <VersionLogConsequentRow
              key={`consequent-${i}`}
              op={cop}
              isFilterFocus={focusOp === cop}
              onHoverOperation={onHoverOperation}
              onFilterOperation={onFilterOperation}
            />
          ))}
        </div>
      )}
      <div
        className="VersionLogPanel__incrementFooter"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
          width: "100%",
          marginTop: 4,
          padding: "2px 4px",
          fontSize: 11,
          fontWeight: 600,
          borderRadius: 4,
          boxSizing: "border-box",
        }}
      >
        <span
          style={{ opacity: 0.6, fontWeight: 400 }}
          title={formatTimestamp(moment.timestamp)}
        >
          {formatElapsed(moment.timestamp, now)}
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
          {onToggleActive && (
            <button
              type="button"
              className={`VersionLogPanel__cardButton${
                isInactive ? "" : " VersionLogPanel__cardButton--danger"
              }`}
              onClick={handleToggleActive}
              title={
                isInactive
                  ? "Re-include this change in replay"
                  : "Skip this change during replay (selective undo)"
              }
              onMouseDown={(e) => e.stopPropagation()}
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
                className="VersionLogPanel__cardButton"
                onClick={handleJump}
                title="Jump the document to this point"
                onMouseDown={(e) => e.stopPropagation()}
              >
                Jump
              </button>
            )
          )}
        </span>
      </div>
    </li>
  );
};
