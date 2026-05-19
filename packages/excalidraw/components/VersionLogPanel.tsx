import React, { useEffect, useState } from "react";

import type { VersionLog } from "../versionLog/VersionLog";
import type {
  LogEntry,
  LogEntryType,
  LogIncrement,
} from "../versionLog/types";

/**
 * Subscribes a component to a `VersionLog` instance and returns the
 * current increments (newest-first). Re-renders on each ingest.
 */
const useVersionLogIncrements = (
  log: VersionLog,
): readonly LogIncrement[] => {
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

const TYPE_LABEL: Record<LogEntryType, string> = {
  create: "Created",
  update: "Updated",
  delete: "Deleted",
};

const TYPE_COLOR: Record<LogEntryType, string> = {
  create: "#2f9e44", // green
  update: "#1971c2", // blue
  delete: "#c92a2a", // red
};

const formatTimestamp = (ms: number) => {
  const d = new Date(ms);
  return d.toLocaleTimeString();
};

/**
 * Render a single property value compactly. Objects/arrays are JSON-stringified
 * with a short cap; primitives render as-is.
 */
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
  if (typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  try {
    const json = JSON.stringify(v);
    return json.length > 60 ? `${json.slice(0, 57)}…` : json;
  } catch {
    return String(v);
  }
};

const ChangedProperties: React.FC<{ entry: LogEntry }> = ({ entry }) => {
  const { type, before, after } = entry;

  // For create/delete, show the property snapshot on the relevant side.
  // For update, show before → after per changed key.
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
    const keys = Object.keys(before);
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

  // update — union of keys from both sides, in case the shape differs
  const keys = Array.from(
    new Set([...Object.keys(before), ...Object.keys(after)]),
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

const VersionLogEntryRow: React.FC<{ entry: LogEntry }> = ({ entry }) => {
  return (
    <li
      className="VersionLogPanel__entry"
      style={{
        borderLeft: `3px solid ${TYPE_COLOR[entry.type]}`,
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
        <span style={{ fontWeight: 600, color: TYPE_COLOR[entry.type] }}>
          {TYPE_LABEL[entry.type]} {entry.elementType ?? "element"}
        </span>
        <span
          style={{ opacity: 0.5, fontFamily: "monospace", fontSize: 11 }}
          title={entry.elementId}
        >
          {entry.elementId.slice(0, 8)}…
        </span>
      </div>
      <ChangedProperties entry={entry} />
    </li>
  );
};

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

const VersionLogIncrementCard: React.FC<{ increment: LogIncrement }> = ({
  increment,
}) => {
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
      <div
        className="VersionLogPanel__incrementHeader"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 6,
          padding: "0 2px",
          fontSize: 11,
          fontWeight: 600,
        }}
      >
        <span style={{ display: "flex", gap: 8 }}>
          <CountChip n={increment.counts.create} type="create" symbol="+" />
          <CountChip n={increment.counts.update} type="update" symbol="~" />
          <CountChip n={increment.counts.delete} type="delete" symbol="−" />
        </span>
        <span style={{ opacity: 0.6, fontWeight: 400 }}>
          {formatTimestamp(increment.timestamp)}
        </span>
      </div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {increment.entries.map((entry) => (
          <VersionLogEntryRow key={entry.id} entry={entry} />
        ))}
      </ul>
    </li>
  );
};

export interface VersionLogPanelProps {
  log: VersionLog;
}

export const VersionLogPanel: React.FC<VersionLogPanelProps> = ({ log }) => {
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
          {increments.length}{" "}
          {increments.length === 1 ? "change" : "changes"}
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
          {increments.map((increment) => (
            <VersionLogIncrementCard
              key={increment.id}
              increment={increment}
            />
          ))}
        </ul>
      )}
    </div>
  );
};
