/**
 * Search-jump target resolution (QA gap §1.3): map a server search match
 * ({file, side, line}) onto the row model, so jumping works in both unified
 * and split view. Pure and DOM-free for unit testing.
 */

import type { HunkLine } from "../types";
import type { Row } from "./rows";

export interface MatchTarget {
  file: string;
  side: "old" | "new";
  line: number;
}

function lineHits(line: HunkLine | null, target: MatchTarget): boolean {
  if (line === null) return false;
  return target.side === "new" ? line.new_line === target.line : line.old_line === target.line;
}

/** Index of the row rendering the matched line, or -1. */
export function findMatchRow(rows: readonly Row[], target: MatchTarget): number {
  return rows.findIndex((row) => {
    if (row.kind === "line") return row.path === target.file && lineHits(row.line, target);
    if (row.kind === "pair") {
      return (
        row.path === target.file &&
        (lineHits(row.pair.left, target) || lineHits(row.pair.right, target))
      );
    }
    return false;
  });
}

/** Fallback anchor when the exact line isn't rendered: the file's header. */
export function findFileRow(rows: readonly Row[], file: string): number {
  return rows.findIndex((row) => row.kind === "file" && row.file.path === file);
}
