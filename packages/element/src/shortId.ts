import type { ExcalidrawElement } from "./types";

/**
 * Short, human-readable element names — `R3`, `A7`, `T1`.
 *
 * Excalidraw's own `id` is a 20-odd character random string: fine as a
 * key, useless as something to say out loud or read off a card in the
 * version log. This is a second name for the same element, carried
 * alongside the real id and used only where a person has to identify
 * one. Nothing ever keys off it.
 *
 * A letter per element type and a counter per letter, so the name says
 * what the thing is as well as which one it is.
 */
const SHORT_ID_PREFIXES: Record<ExcalidrawElement["type"], string> = {
  rectangle: "R",
  diamond: "D",
  ellipse: "E",
  arrow: "A",
  line: "L",
  freedraw: "P",
  text: "T",
  image: "I",
  frame: "F",
  magicframe: "M",
  embeddable: "B",
  iframe: "W",
  // never persisted, and never labelled — it only exists while a
  // selection box is being dragged
  selection: "S",
};

const SHORT_ID_PATTERN = /^([A-Z]+)(\d+)$/;

/**
 * Give every element in `elements` a short id, in place.
 *
 * Two elements can arrive holding the same short id — paste and
 * duplicate copy the field along with everything else — so a name is
 * only kept by the first element to claim it; the rest are re-issued.
 * That check is why this runs over the whole scene rather than only over
 * what is being added.
 *
 * Counters start above the highest name already in use, **including
 * deleted elements**, so a name is never recycled: a version-log entry
 * naming `R3` would otherwise start pointing at whatever rectangle was
 * drawn after the first `R3` was deleted.
 *
 * Written in place rather than through `newElementWith` deliberately.
 * The name is a label for an element that already exists, not an edit to
 * it, so it must not bump the version, land in the undo stack, or
 * surface as a change in the log (`shortId` is in `TRACKING_PROPS` for
 * the same reason).
 */
export const assignShortIds = (elements: readonly ExcalidrawElement[]) => {
  const claimed = new Set<string>();
  const nextNumber = new Map<string, number>();

  const claim = (shortId: string) => {
    claimed.add(shortId);
    const match = SHORT_ID_PATTERN.exec(shortId);
    if (match) {
      const [, prefix, digits] = match;
      nextNumber.set(
        prefix,
        Math.max(nextNumber.get(prefix) ?? 1, Number(digits) + 1),
      );
    }
  };

  const needsOne: ExcalidrawElement[] = [];
  for (const element of elements) {
    if (element.shortId && !claimed.has(element.shortId)) {
      claim(element.shortId);
    } else {
      needsOne.push(element);
    }
  }

  for (const element of needsOne) {
    const prefix = SHORT_ID_PREFIXES[element.type] ?? "X";
    let number = nextNumber.get(prefix) ?? 1;
    while (claimed.has(`${prefix}${number}`)) {
      number += 1;
    }
    const shortId = `${prefix}${number}`;
    claim(shortId);
    Object.assign(element, { shortId });
  }
};
