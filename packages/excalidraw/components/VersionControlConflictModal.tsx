/**
 * Conflict-resolution modal for the version-log selective-undo feature.
 *
 * Opens when toggling an increment off would leave one or more later
 * ops pointing at a now-missing element or group. The user resolves
 * each missing referent independently — Skip (drop every op that
 * touched it) or Remap (apply those ops to a different live referent
 * of the same kind).
 *
 * Submitting writes one `Remap` per resolved referent into
 * `versionLog.remaps` and asks the host to re-run the replay.
 * Cancel reverts the underlying toggle so the canvas snaps back.
 */

import React, { useMemo, useState } from "react";

import { Dialog } from "./Dialog";
import { getOperationElementIds } from "../versionLog/types";

import type {
  LogOperation,
  PendingConflict,
  Remap,
} from "../versionLog/types";

import "./VersionControlConflictModal.scss";

export type ConflictDecision =
  | { kind: "skip" }
  | { kind: "remap"; to: string };

export interface ConflictResolutionModalProps {
  conflicts: PendingConflict[];
  onSubmit: (decisions: Map<string, Remap>) => void;
  onCancel: () => void;
}

export const ConflictResolutionModal: React.FC<
  ConflictResolutionModalProps
> = ({ conflicts, onSubmit, onCancel }) => {
  // Default every referent to "skip" — matches the prior behaviour
  // (silent skip on conflict). Submit forwards each decision verbatim.
  const [decisions, setDecisions] = useState<Map<string, ConflictDecision>>(
    () => {
      const init = new Map<string, ConflictDecision>();
      for (const c of conflicts) {
        init.set(c.referentId, { kind: "skip" });
      }
      return init;
    },
  );

  const setDecision = (referentId: string, decision: ConflictDecision) => {
    setDecisions((prev) => {
      const next = new Map(prev);
      next.set(referentId, decision);
      return next;
    });
  };

  const handleSubmit = () => {
    const out = new Map<string, Remap>();
    for (const c of conflicts) {
      const d = decisions.get(c.referentId) ?? { kind: "skip" };
      out.set(c.referentId, {
        kind: c.referentKind,
        to: d.kind === "skip" ? null : d.to,
      } as Remap);
    }
    onSubmit(out);
  };

  return (
    <Dialog
      onCloseRequest={onCancel}
      title="Resolve version-log conflicts"
      size="regular"
      closeOnClickOutside={false}
    >
      <div className="ConflictResolutionModal">
        <p className="ConflictResolutionModal__intro">
          Skipping this change leaves some later operations without a
          target. Choose what to do with each one.
        </p>
        {conflicts.map((c) => (
          <ConflictSection
            key={c.referentId}
            conflict={c}
            decision={decisions.get(c.referentId) ?? { kind: "skip" }}
            onChange={(d) => setDecision(c.referentId, d)}
          />
        ))}
        <div className="ConflictResolutionModal__footer">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="ConflictResolutionModal__primary"
            onClick={handleSubmit}
          >
            Apply
          </button>
        </div>
      </div>
    </Dialog>
  );
};

// ---------------------------------------------------------------------

const ConflictSection: React.FC<{
  conflict: PendingConflict;
  decision: ConflictDecision;
  onChange: (decision: ConflictDecision) => void;
}> = ({ conflict, decision, onChange }) => {
  const referentLabel =
    conflict.referentKind === "group"
      ? `group ${shortId(conflict.referentId)}`
      : `${conflict.elementType ?? "element"} ${shortId(conflict.referentId)}`;

  // If the user selects Remap but no candidate is chosen yet, default
  // to the first candidate so submit always has a target.
  const remapTarget =
    decision.kind === "remap"
      ? decision.to
      : conflict.candidates[0] ?? "";

  return (
    <div className="ConflictResolutionModal__section">
      <div className="ConflictResolutionModal__sectionHeader">
        Missing {referentLabel}
      </div>
      <ul className="ConflictResolutionModal__ops">
        {conflict.affectedOps.map((op, i) => (
          <li key={i}>{describeOp(op)}</li>
        ))}
      </ul>
      <div className="ConflictResolutionModal__choice">
        <label>
          <input
            type="radio"
            checked={decision.kind === "skip"}
            onChange={() => onChange({ kind: "skip" })}
          />
          Skip these operations
        </label>
        <label
          className={
            conflict.candidates.length === 0
              ? "ConflictResolutionModal__choice--disabled"
              : ""
          }
        >
          <input
            type="radio"
            checked={decision.kind === "remap"}
            disabled={conflict.candidates.length === 0}
            onChange={() =>
              onChange({ kind: "remap", to: remapTarget })
            }
          />
          Apply to:
          <select
            disabled={
              decision.kind !== "remap" || conflict.candidates.length === 0
            }
            value={remapTarget}
            onChange={(e) =>
              onChange({ kind: "remap", to: e.target.value })
            }
          >
            {conflict.candidates.length === 0 ? (
              <option value="">(no candidates)</option>
            ) : (
              conflict.candidates.map((id) => (
                <option key={id} value={id}>
                  {shortId(id)}
                </option>
              ))
            )}
          </select>
        </label>
      </div>
    </div>
  );
};

const shortId = (id: string): string =>
  id.length <= 10 ? id : `${id.slice(0, 8)}…`;

const describeOp = (op: LogOperation): string => {
  const ids = getOperationElementIds(op).map(shortId).join(", ");
  switch (op.kind) {
    case "move":
      return `Move ${ids} by (${round(op.dx)}, ${round(op.dy)})`;
    case "move-group":
      return `Move group by (${round(op.dx)}, ${round(op.dy)})`;
    case "resize":
    case "arrow-resize":
      return `Resize ${ids} (×${round(op.scaleX)}, ×${round(op.scaleY)})`;
    case "resize-group":
      return `Resize group (×${round(op.scaleX)}, ×${round(op.scaleY)})`;
    case "rotate":
    case "arrow-rotate":
      return `Rotate ${ids} to ${round((op.to * 180) / Math.PI)}°`;
    case "rotate-group":
      return `Rotate group by ${round((op.angle * 180) / Math.PI)}°`;
    case "restyle":
      return `Restyle ${op.property} of ${ids}`;
    case "delete":
      return `Delete ${ids}`;
    case "ungroup":
      return `Ungroup ${shortId(op.group.id)}`;
    case "arrow-edit-points":
      return `Edit arrow ${ids} points`;
    case "arrow-bind":
      return `Rebind arrow ${ids}`;
    case "arrow-move-binding":
      return `Move arrow ${ids} binding`;
    case "raw":
      return `Update ${ids} (raw)`;
    case "create":
    case "group":
      // Shouldn't appear in conflicts (no missing referent), but
      // included for exhaustiveness.
      return op.kind;
  }
};

const round = (n: number): string => (Math.round(n * 100) / 100).toString();
