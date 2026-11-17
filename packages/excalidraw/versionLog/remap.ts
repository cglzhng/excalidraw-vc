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
 * v1 supports element and group remaps, including the element an
 * arrow's end is bound to (`startBinding.elementId` /
 * `endBinding.elementId`).
 */

import type {
  ElementAlignment,
  ElementGapAlignment,
} from "@excalidraw/element/types";

import type { LogOperation, Remap } from "./types";

export type RemapResult =
  | { status: "ok"; op: LogOperation }
  | { status: "skip" };

/**
 * Rewrite an op against the current remap map. Element-keyed ops have
 * their `elementId` replaced; group-keyed ops (`move-group`,
 * `resize-group`, `rotate-group`) have their `groupId` replaced; an
 * `ungroup` whose target group has been remapped switches to the
 * remapped group too. `alignment` rewrites both its members and the
 * partner ids inside its links, dropping (rather than skipping the whole
 * op) any referent the user chose to skip. `arrow-bind` and
 * `arrow-move-binding` rewrite the arrow and the element each end is
 * bound to. `group` (create) and `reorder` are left unchanged in v1.
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
    case "arrow-resize":
    case "arrow-rotate":
    case "alignment-anchor":
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

    case "arrow-bind":
    case "arrow-move-binding": {
      // Two kinds of referent: the arrow itself, and the element each end
      // is bound to. Only the binding's `elementId` changes; the replay
      // re-places a rebound end on its new element (`reanchorReboundEnds`),
      // since the recorded geometry ends at the old one.
      const resolve = (id: string): string | null | undefined => {
        const remap = remaps.get(id);
        return remap?.kind === "element" ? remap.to : undefined;
      };
      const sides = [op.start, op.end];
      const touched =
        remaps.has(op.elementId) ||
        sides.some(
          (side) =>
            (side?.before && remaps.has(side.before.elementId)) ||
            (side?.after && remaps.has(side.after.elementId)),
        );
      if (!touched) {
        return { status: "ok", op };
      }

      const arrowId = resolve(op.elementId);
      if (arrowId === null) {
        return { status: "skip" };
      }
      // A skipped element the forward apply would bind to skips the op,
      // as for any single-element op: an end bound to nothing the user
      // chose is not the bind that was recorded. One it would only
      // *unbind from* doesn't matter — `before` is never written forward.
      if (
        sides.some((side) => side?.after && resolve(side.after.elementId) === null)
      ) {
        return { status: "skip" };
      }
      const rebind = <B extends { elementId: string } | null>(binding: B): B => {
        const to = binding && resolve(binding.elementId);
        return to ? ({ ...binding, elementId: to } as B) : binding;
      };

      const next: LogOperation =
        op.kind === "arrow-bind"
          ? {
              ...op,
              start: op.start && {
                before: rebind(op.start.before),
                after: rebind(op.start.after),
              },
              end: op.end && {
                before: rebind(op.end.before),
                after: rebind(op.end.after),
              },
            }
          : {
              ...op,
              start: op.start && {
                boundElementId:
                  resolve(op.start.boundElementId) ?? op.start.boundElementId,
                before: rebind(op.start.before),
                after: rebind(op.start.after),
              },
              end: op.end && {
                boundElementId:
                  resolve(op.end.boundElementId) ?? op.end.boundElementId,
                before: rebind(op.end.before),
                after: rebind(op.end.after),
              },
            };
      return {
        status: "ok",
        op: arrowId ? { ...next, elementId: arrowId } : next,
      };
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

    case "reorder":
      // A recorded index is the place the *original* element held among
      // its neighbours then; handed to a stand-in it would just move
      // that one somewhere arbitrary. Left as is, a key for a missing
      // element is never written.
      return { status: "ok", op };

    case "alignment": {
      // An alignment op references elements two ways: the members whose
      // `alignments` field it writes, and the partner id inside each
      // link. Both need rewriting, or a remap would leave the op
      // pointing at a dead element.
      //
      // Unlike the single-element ops above, a skipped referent
      // (`to == null`) drops just that element from the op rather than
      // skipping the whole thing — the op covers several elements and
      // the remaining links are still valid. Only if nothing survives
      // is the op skipped outright.
      const touches = (id: string) => remaps.has(id);
      // A link's referents: the partner of an edge link, or every
      // member of an equal-gap chain.
      const linkReferents = (
        link: ElementAlignment | ElementGapAlignment,
      ): readonly string[] =>
        "elementId" in link ? [link.elementId] : link.ids;

      const isTouched =
        op.elementIds.some(touches) ||
        [op.before, op.after].some((map) =>
          Object.entries(
            map as Record<
              string,
              readonly (ElementAlignment | ElementGapAlignment)[]
            >,
          ).some(
            ([ownerId, links]) =>
              touches(ownerId) ||
              links.some((l) => linkReferents(l).some(touches)),
          ),
        );
      if (!isTouched) {
        return { status: "ok", op };
      }

      // null => the user chose to skip this referent, so drop it
      const resolve = (id: string): string | null => {
        const remap = remaps.get(id);
        if (!remap || remap.kind !== "element") {
          return id;
        }
        return remap.to;
      };

      const remapOwners = <T>(
        map: Record<string, readonly T[]>,
        remapLink: (link: T) => T | null,
      ): Record<string, readonly T[]> => {
        const next: Record<string, readonly T[]> = {};
        for (const [ownerId, links] of Object.entries(map)) {
          const nextOwner = resolve(ownerId);
          if (nextOwner == null) {
            continue;
          }
          const nextLinks: T[] = [];
          for (const link of links) {
            const remapped = remapLink(link);
            if (remapped != null) {
              nextLinks.push(remapped);
            }
          }
          next[nextOwner] = nextLinks;
        }
        return next;
      };

      const remapEdgeLink = (link: ElementAlignment): ElementAlignment | null => {
        const partner = resolve(link.elementId);
        return partner == null
          ? null
          : partner === link.elementId
          ? link
          : { ...link, elementId: partner };
      };

      // A skipped referent drops just that member: a chain of four still
      // means something with one gone. Below three there are no longer
      // two gaps to hold equal, so the link goes.
      const remapGapLink = (
        link: ElementGapAlignment,
      ): ElementGapAlignment | null => {
        const ids = link.ids
          .map((id: string) => resolve(id))
          .filter((id): id is string => id != null);
        return ids.length < 3 ? null : { ...link, ids };
      };

      const elementIds = op.elementIds
        .map(resolve)
        .filter((id): id is string => id != null);

      if (elementIds.length === 0) {
        return { status: "skip" };
      }

      return {
        status: "ok",
        op:
          op.field === "gapAlignments"
            ? {
                ...op,
                elementIds,
                before: remapOwners(op.before, remapGapLink),
                after: remapOwners(op.after, remapGapLink),
              }
            : {
                ...op,
                elementIds,
                before: remapOwners(op.before, remapEdgeLink),
                after: remapOwners(op.after, remapEdgeLink),
              },
      };
    }
  }
};

