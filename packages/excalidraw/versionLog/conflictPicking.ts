/**
 * Picking a stand-in on the canvas during a conflict-resolution session.
 *
 * Shared by the pointer handler (what does a click pick? what does a
 * hover preview?) and the interactive renderer (what to outline?), so
 * what is drawn as pickable is exactly what a click picks.
 */

import type {
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";

import type { AppState } from "../types";
import type { PendingConflict, Remap } from "./types";

export type ResolutionSession = NonNullable<AppState["versionLogResolution"]>;

/** A session's decisions in the shape the replay and the log take. */
export const toRemaps = (
  decisions: Readonly<Record<string, string | null>>,
  kinds: ReadonlyMap<string, Remap["kind"]>,
): Map<string, Remap> =>
  new Map(
    Object.entries(decisions).map(([id, to]) => [
      id,
      { kind: kinds.get(id) ?? "element", to } as Remap,
    ]),
  );

/** Bookkeeping a replay rewrites without changing what is drawn: every
 * replay stamps a fresh version, the scene names elements after the
 * replay hands them over, and a stacking change alone looks the same as
 * a ghost drawn on top. */
const UNDRAWN_KEYS = new Set([
  "version",
  "versionNonce",
  "updated",
  "boundElements",
  "index",
  "shortId",
]);

/** Whether `b` would be drawn differently from `a` — the elements of a
 * hover preview worth a ghost. */
export const drawsDifferently = (
  a: ExcalidrawElement,
  b: ExcalidrawElement,
): boolean => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (UNDRAWN_KEYS.has(key)) {
      continue;
    }
    const x = (a as Record<string, unknown>)[key];
    const y = (b as Record<string, unknown>)[key];
    if (x === y) {
      continue;
    }
    // replay rebuilds points, bindings and the like as new objects
    if (
      typeof x === "object" &&
      typeof y === "object" &&
      JSON.stringify(x) === JSON.stringify(y)
    ) {
      continue;
    }
    return true;
  }
  return false;
};

/**
 * What the bar's three-way switch says for `referentId`: the scene as it
 * was before the toggle (session-wide — it is Cancel's answer, not one
 * conflict's), its ops skipped, or reassigned to a stand-in picked on the
 * canvas. Reassign without a pick yet still replays as a skip.
 */
export type ConflictMode = "before" | "skip" | "reassign";

export const getConflictMode = (
  session: ResolutionSession,
  referentId: string,
): ConflictMode =>
  session.showingBefore
    ? "before"
    : session.reassigning[referentId]
    ? "reassign"
    : "skip";

/** Apply needs every conflict answered: showing before answers them all
 * at once, and a reassign needs its stand-in. */
export const canApplyResolution = (session: ResolutionSession): boolean =>
  session.showingBefore ||
  session.conflicts.every(
    (c) =>
      !session.reassigning[c.referentId] ||
      session.decisions[c.referentId] != null,
  );

/** The conflict the canvas is picking for, if it is picking at all. */
export const getPickingConflict = (
  session: ResolutionSession,
): PendingConflict | null => {
  const conflict = getActiveConflict(session);
  return conflict &&
    getConflictMode(session, conflict.referentId) === "reassign"
    ? conflict
    : null;
};

/** The conflict the canvas is picking for. */
export const getActiveConflict = (
  session: ResolutionSession,
): PendingConflict | null =>
  session.conflicts.find((c) => c.referentId === session.activeReferentId) ??
  null;

/**
 * What each candidate of `conflict` is on the canvas: the element itself,
 * or a group's members. A candidate with nothing on the canvas — one the
 * log deletes after the point where the conflict arises — is left out;
 * the panel's list still offers it.
 */
export const getCandidateElements = (
  conflict: PendingConflict,
  elements: Iterable<NonDeletedExcalidrawElement>,
): Map<string, NonDeletedExcalidrawElement[]> => {
  const candidates = new Set(conflict.candidates);
  const out = new Map<string, NonDeletedExcalidrawElement[]>();
  const add = (id: string, element: NonDeletedExcalidrawElement) => {
    const list = out.get(id) ?? [];
    list.push(element);
    out.set(id, list);
  };
  for (const element of elements) {
    if (element.isDeleted) {
      continue;
    }
    if (conflict.referentKind === "element") {
      if (candidates.has(element.id)) {
        add(element.id, element);
      }
    } else {
      for (const groupId of element.groupIds) {
        if (candidates.has(groupId)) {
          add(groupId, element);
        }
      }
    }
  }
  return out;
};

export type ConflictHover =
  | { kind: "pick"; id: string }
  | { kind: "refused"; elementId: string; reason: string };

/**
 * What is under the pointer: the candidate a click would pick, or else
 * the topmost element there and why it can't stand in — so a dimmed
 * element can answer for itself.
 *
 * `hits` is what the editor's own hit test finds at the point
 * (`App.getElementsAtPosition`), bottom first, so a pick lands exactly
 * where a selecting click would — an unfilled shape by its outline, a
 * line by its stroke. Elements that can't stand in are passed over, so a
 * candidate under one is still reachable; among candidates, the topmost
 * wins. For a group conflict, an element in several candidate groups
 * picks the innermost.
 */
export const getConflictHover = (
  conflict: PendingConflict,
  hits: readonly NonDeletedExcalidrawElement[],
): ConflictHover | null => {
  const candidates = new Set(conflict.candidates);
  let topmost: NonDeletedExcalidrawElement | null = null;
  for (let i = hits.length - 1; i >= 0; i--) {
    const element = hits[i];
    const pick =
      conflict.referentKind === "element"
        ? candidates.has(element.id)
          ? element.id
          : null
        : // `groupIds` runs innermost first
          element.groupIds.find((groupId) => candidates.has(groupId)) ?? null;
    if (pick != null) {
      return { kind: "pick", id: pick };
    }
    if (topmost == null) {
      topmost = element;
    }
  }
  return topmost
    ? {
        kind: "refused",
        elementId: topmost.id,
        reason: getRefusal(conflict, topmost),
      }
    : null;
};

/** Why `element` can't stand in for `conflict`'s referent. */
const getRefusal = (
  conflict: PendingConflict,
  element: NonDeletedExcalidrawElement,
): string => {
  if (conflict.referentKind === "group") {
    return element.groupIds.length === 0
      ? "isn't in a group"
      : "is only in groups made later in the log";
  }
  return (
    conflict.refusals[element.id] ??
    // nothing was asked of it where the conflict arose: it wasn't there
    "is drawn later in the log, so it can't stand in this early"
  );
};
