/**
 * Build a `GroupNode` (tree) from raw log entries that participated in
 * a group / ungroup event. Used by `classify.ts → detectGroupChange`.
 *
 * The flat representation Excalidraw uses (`groupIds: string[]` on
 * each element, innermost-first) is easy to detect changes on but
 * loses the nested structure that's needed to correctly redo an
 * ungroup. Building a tree at detection time freezes the structure
 * so it can be replayed.
 */

import type { GroupChild, GroupNode, LogEntry } from "./types";

interface EntryPath {
  elementId: string;
  /**
   * The element's `groupIds` from index 0 (innermost) up to but not
   * including the group being analysed. The OUTERMOST entry in this
   * array (i.e. the highest-index one) is the immediate sub-group of
   * the group being analysed that contains this element. An empty
   * array means the element is a direct child.
   */
  pathInside: string[];
}

/**
 * Recursive builder. `entries` are the elements being placed inside
 * `gid`, with their paths-inside-gid already computed. The outermost
 * entry of each path tells us the immediate sub-group of `gid` that
 * contains the element; we bucket by that, recurse for each bucket,
 * and emit element-children for entries with empty paths.
 */
const buildGroupNode = (gid: string, entries: EntryPath[]): GroupNode => {
  const directElements: string[] = [];
  const subgroupBuckets = new Map<string, EntryPath[]>();

  for (const entry of entries) {
    if (entry.pathInside.length === 0) {
      directElements.push(entry.elementId);
      continue;
    }
    // pathInside is innermost-first; the OUTERMOST entry (highest
    // index) is the direct sub-group of `gid` that contains the
    // element. Strip it for the recursive call.
    const directChildGid = entry.pathInside[entry.pathInside.length - 1];
    let bucket = subgroupBuckets.get(directChildGid);
    if (!bucket) {
      bucket = [];
      subgroupBuckets.set(directChildGid, bucket);
    }
    bucket.push({
      elementId: entry.elementId,
      pathInside: entry.pathInside.slice(0, -1),
    });
  }

  const children: GroupChild[] = [];
  for (const elementId of directElements) {
    children.push({ kind: "element", elementId });
  }
  for (const [subGid, subEntries] of subgroupBuckets) {
    children.push({ kind: "group", node: buildGroupNode(subGid, subEntries) });
  }

  return { id: gid, children };
};

/**
 * Construct a `GroupNode` for a `group` (forward) or `ungroup`
 * (forward) event. `side` controls which `groupIds` we look at:
 *
 *   - `"after"` for a `group` event — the new gid is present in
 *     `entry.after.groupIds`.
 *   - `"before"` for an `ungroup` event — the old gid was present
 *     in `entry.before.groupIds`.
 */
export const buildGroupNodeFromEntries = (
  gid: string,
  members: readonly LogEntry[],
  side: "before" | "after",
): GroupNode => {
  const paths: EntryPath[] = members.map((entry) => {
    const arr =
      ((side === "before" ? entry.before : entry.after).groupIds as
        | readonly string[]
        | undefined) ?? [];
    const idx = arr.indexOf(gid);
    return {
      elementId: entry.elementId,
      // Everything inner to `gid` is the path-inside-gid.
      pathInside: arr.slice(0, idx === -1 ? 0 : idx) as string[],
    };
  });
  return buildGroupNode(gid, paths);
};

/**
 * Identify the parent group id for a group / ungroup event. The
 * parent is whichever gid sits immediately outer to `gid` in each
 * member's `groupIds`. All members should have the same parent (a
 * group occupies one place in the tree); we trust the first member.
 *
 * Returns `null` if `gid` is at the outermost position (no parent).
 */
export const getParentGroupId = (
  gid: string,
  members: readonly LogEntry[],
  side: "before" | "after",
): string | null => {
  if (members.length === 0) {
    return null;
  }
  const first = members[0];
  const arr =
    ((side === "before" ? first.before : first.after).groupIds as
      | readonly string[]
      | undefined) ?? [];
  const idx = arr.indexOf(gid);
  if (idx < 0 || idx + 1 >= arr.length) {
    return null;
  }
  return arr[idx + 1];
};
