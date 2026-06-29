/**
 * Apply user-supplied referent remaps to a `LogOperation`.
 *
 * Selective undo can leave a downstream op pointing at an element or
 * group that no longer exists (the create / group op that introduced
 * it has been deactivated). The user resolves these via the conflict
 * modal, which stores a `Map<originalId, Remap>` on the version log.
 *
 * This module is the single point where those rewrites are applied
 * during replay. The function returns either:
 *
 *   - `{ status: "ok", op }`        — apply the (possibly-rewritten) op
 *   - `{ status: "skip" }`          — explicitly skipped by the user
 *
 * v1 supports element and group remaps. Arrow-binding rebinds (which
 * would rewrite `startBinding.elementId` / `endBinding.elementId`)
 * are NOT handled yet — arrow ops have other open bugs and we'd want
 * to land those first.
 */

import type { LogOperation, Remap } from "./types";

export type RemapResult =
  | { status: "ok"; op: LogOperation }
  | { status: "skip" };

/**
 * Rewrite an op against the current remap map. Element-keyed ops have
 * their `elementId` replaced; group-keyed ops (`move-group`,
 * `resize-group`, `rotate-group`) have their `groupId` replaced; an
 * `ungroup` whose target group has been remapped switches to the
 * remapped group too. `group` (create) and `arrow-*` are left
 * unchanged in v1.
 */
export const applyRemapsToOp = (
  op: LogOperation,
  remaps: ReadonlyMap<string, Remap>,
): RemapResult => {
  switch (op.kind) {
    case "create":
    case "delete":
    case "move":
    case "resize":
    case "rotate":
    case "restyle":
    case "arrow-edit-points":
    case "arrow-bind":
    case "arrow-move-binding":
    case "arrow-resize":
    case "arrow-rotate":
    case "raw": {
      const targetId =
        op.kind === "raw" ? op.entry.elementId : op.elementId;
      const remap = remaps.get(targetId);
      if (!remap || remap.kind !== "element") {
        return { status: "ok", op };
      }
      if (remap.to == null) {
        return { status: "skip" };
      }
      if (op.kind === "raw") {
        return {
          status: "ok",
          op: { ...op, entry: { ...op.entry, elementId: remap.to } },
        };
      }
      return { status: "ok", op: { ...op, elementId: remap.to } };
    }

    case "move-group":
    case "resize-group":
    case "rotate-group": {
      const remap = remaps.get(op.groupId);
      if (!remap || remap.kind !== "group") {
        return { status: "ok", op };
      }
      if (remap.to == null) {
        return { status: "skip" };
      }
      // We rewrite the gid; the live elementIds for the new group are
      // resolved by the replay engine at apply time (it consults the
      // current snapshot rather than trusting the captured list).
      return { status: "ok", op: { ...op, groupId: remap.to } };
    }

    case "ungroup": {
      const remap = remaps.get(op.group.id);
      if (!remap || remap.kind !== "group") {
        return { status: "ok", op };
      }
      if (remap.to == null) {
        return { status: "skip" };
      }
      return {
        status: "ok",
        op: { ...op, group: { ...op.group, id: remap.to } },
      };
    }

    case "group":
      // The gid being introduced is brand-new; remapping it doesn't
      // make sense. Children element-id remaps are out of scope for v1.
      return { status: "ok", op };
  }
};

