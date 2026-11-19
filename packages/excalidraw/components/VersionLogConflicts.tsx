/**
 * The conflict-resolution bar, floating over the top of the canvas pane.
 *
 * Shown while a toggle has left later ops without a referent (see
 * `AppState.versionLogResolution`). The stand-ins themselves are picked
 * on the canvas; the bar says which element went missing, and
 * holds a three-way switch per missing referent — Show before (the
 * canvas as Cancel would leave it), Skip, or Reassign, the only one in
 * which the canvas takes a pick — plus Cancel and Apply, which waits for
 * every Reassign to have its stand-in.
 * With several missing referents, one chip each switches which one the
 * canvas is picking for.
 */

import clsx from "clsx";
import React from "react";

import { useApp } from "./App";
import { useShortIdOf } from "./VersionLogMomentCard";
import { useUIAppState } from "../context/ui-appState";
import {
  canApplyResolution,
  getActiveConflict,
  getConflictMode,
} from "../versionLog/conflictPicking";
import type { ConflictMode } from "../versionLog/conflictPicking";
import type { PendingConflict } from "../versionLog/types";

import "./VersionLogConflicts.scss";

const MODES: readonly { mode: ConflictMode; label: string; title: string }[] =
  [
    {
      mode: "before",
      label: "Show before",
      title: "The canvas as it was before this change; Apply keeps it",
    },
    {
      mode: "skip",
      label: "Skip",
      title: "Drop the moments that depend on the missing element",
    },
    {
      mode: "reassign",
      label: "Reassign",
      title: "Pick an element on the canvas to take those moments",
    },
  ];

export const VersionLogConflicts: React.FC = () => {
  const app = useApp();
  const session = useUIAppState().versionLogResolution;
  const shortIdOf = useShortIdOf();
  const nameOf = (id: string) => shortIdOf(id) ?? truncateId(id);

  if (session == null) {
    return null;
  }
  const conflict = getActiveConflict(session);
  const referentName = (c: PendingConflict) =>
    c.referentKind === "group"
      ? `group ${truncateId(c.referentId)}`
      : shortIdOf(c.referentId) ??
        // a referent whose creation the toggle skipped isn't in the
        // scene at all; the copy captured when the session opened is
        session.ghosts[c.referentId]?.[0]?.shortId ??
        c.elementType ??
        "element";

  return (
    <div className="VersionLogConflicts">
      <div className="VersionLogConflicts__island">
        {session.conflicts.length > 1 && (
          <div className="VersionLogConflicts__chips">
            {session.conflicts.map((c) => {
              const standIn = session.decisions[c.referentId] ?? null;
              return (
                <button
                  key={c.referentId}
                  type="button"
                  className={clsx("VersionLogConflicts__chip", {
                    "VersionLogConflicts__chip--active":
                      c.referentId === session.activeReferentId,
                  })}
                  onClick={() => app.setActiveVersionLogConflict(c.referentId)}
                >
                  {referentName(c)}
                  <span className="VersionLogConflicts__chipState">
                    {standIn
                    ? `→ ${nameOf(standIn)}`
                    : session.reassigning[c.referentId]
                    ? "→ ?"
                    : "skipped"}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {conflict && (
          <div className="VersionLogConflicts__help">
            {helpText(referentName(conflict))}
          </div>
        )}
        <div className="VersionLogConflicts__buttons">
          {conflict &&
            MODES.map(({ mode, label, title }) => {
              const chosen = getConflictMode(session, conflict.referentId);
              return (
                <button
                  key={mode}
                  type="button"
                  className={clsx("VersionLogConflicts__button", {
                    "VersionLogConflicts__button--chosen": chosen === mode,
                  })}
                  aria-pressed={chosen === mode}
                  // nothing on the canvas can take the moments
                  disabled={
                    mode === "reassign" && conflict.candidates.length === 0
                  }
                  onClick={() => app.setVersionLogConflictMode(mode)}
                  title={title}
                >
                  {label}
                </button>
              );
            })}
          <div className="VersionLogConflicts__spacer" />
          <button
            type="button"
            className="VersionLogConflicts__button"
            onClick={app.cancelVersionLogResolution}
            title="Keep the change you were undoing (Esc)"
          >
            Cancel
          </button>
          <button
            type="button"
            className="VersionLogConflicts__button VersionLogConflicts__button--primary"
            onClick={app.applyVersionLogResolution}
            disabled={!canApplyResolution(session)}
            title={
              canApplyResolution(session)
                ? "Apply these choices (Enter)"
                : "Pick an element on the canvas to reassign to first"
            }
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
};

/**
 * A red tint and border over the whole canvas pane while a session is
 * open — the canvas is showing choices not yet made, and won't take an
 * edit until they are. Over the canvases but under the UI layer, so the
 * toolbar, the bar and the sidebar stay untinted.
 */
export const VersionLogConflictFrame: React.FC<{
  style?: React.CSSProperties;
}> = ({ style }) => {
  const session = useUIAppState().versionLogResolution;
  return session ? (
    <div className="VersionLogConflicts__frame" style={style} />
  ) : null;
};

/**
 * What went missing and what can be done about it — the same whatever
 * the switch says; the switch and the canvas show the rest.
 */
const helpText = (missing: string): string =>
  `${missing} is missing. Moments that depend on ${missing} could not be applied.\nYou can choose to skip them or re-assign those moments to another element.`;

const truncateId = (id: string): string =>
  id.length <= 10 ? id : `${id.slice(0, 8)}…`;

