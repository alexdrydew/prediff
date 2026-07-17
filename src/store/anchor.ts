/**
 * Comment re-anchoring across diff generations.
 *
 * A comment stores the commented lines plus up to CONTEXT lines of context on
 * each side (file content, not diff text). When the diff refreshes we look for
 * that block in the new content, git-apply style: exact match first, then with
 * increasing "fuzz" (dropping outermost context lines), searching positions
 * nearest the original location first. No match → the comment is "outdated",
 * never dropped.
 */

import type { CommentAnchor } from "../types";

export const ANCHOR_CONTEXT = 3;
const MAX_FUZZ = 2;

export function buildAnchor(content: string[], line: number, endLine: number): CommentAnchor {
  const start = line - 1;
  const end = endLine; // exclusive
  return {
    context_before: content.slice(Math.max(0, start - ANCHOR_CONTEXT), start),
    lines: content.slice(start, end),
    context_after: content.slice(end, end + ANCHOR_CONTEXT),
  };
}

export interface Reanchored {
  line: number;
  end_line: number;
}

/**
 * Find the anchored block in `content`. `expectedLine` is the previous 1-based
 * position, used to prefer the nearest match.
 */
export function reanchor(
  anchor: CommentAnchor,
  content: string[],
  expectedLine: number,
): Reanchored | null {
  if (anchor.lines.length === 0) return null;

  for (let fuzz = 0; fuzz <= MAX_FUZZ; fuzz++) {
    const before = anchor.context_before.slice(
      Math.min(fuzz, anchor.context_before.length),
    );
    const after = anchor.context_after.slice(
      0,
      Math.max(0, anchor.context_after.length - fuzz),
    );
    const pattern = [...before, ...anchor.lines, ...after];
    const targetOffset = before.length; // index of the commented block in pattern
    const match = findNearest(pattern, content, expectedLine - 1 - targetOffset);
    if (match !== null) {
      const line = match + targetOffset + 1;
      return { line, end_line: line + anchor.lines.length - 1 };
    }
  }
  return null;
}

/** Index of `pattern` in `content` closest to `expectedStart`, or null. */
function findNearest(pattern: string[], content: string[], expectedStart: number): number | null {
  const last = content.length - pattern.length;
  if (last < 0) return null;
  const origin = Math.min(Math.max(expectedStart, 0), last);
  for (let delta = 0; delta <= Math.max(origin, last - origin); delta++) {
    for (const start of delta === 0 ? [origin] : [origin - delta, origin + delta]) {
      if (start < 0 || start > last) continue;
      if (matchesAt(pattern, content, start)) return start;
    }
  }
  return null;
}

function matchesAt(pattern: string[], content: string[], start: number): boolean {
  for (let i = 0; i < pattern.length; i++) {
    if (content[start + i] !== pattern[i]) return false;
  }
  return true;
}
