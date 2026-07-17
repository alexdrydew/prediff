/**
 * Side-by-side alignment: zip runs of deletions with the additions that
 * replace them; context lines occupy both sides.
 */

import type { HunkLine } from "../types";

export interface PairedLine {
  left: HunkLine | null;
  right: HunkLine | null;
}

export function pairHunkLines(lines: readonly HunkLine[]): PairedLine[] {
  const out: PairedLine[] = [];
  let dels: HunkLine[] = [];
  let adds: HunkLine[] = [];

  const flush = (): void => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      out.push({ left: dels[i] ?? null, right: adds[i] ?? null });
    }
    dels = [];
    adds = [];
  };

  for (const line of lines) {
    if (line.kind === "del") {
      // A del after adds starts a new change block (e.g. add-only then del-only).
      if (adds.length > 0) flush();
      dels.push(line);
    } else if (line.kind === "add") {
      adds.push(line);
    } else {
      flush();
      out.push({ left: line, right: line });
    }
  }
  flush();
  return out;
}
