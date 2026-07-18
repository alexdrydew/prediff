/**
 * Comment re-anchoring across diff revisions.
 *
 * A comment stores the commented lines plus up to CONTEXT lines of context on
 * each side (file content, not diff text). When the diff refreshes we look for
 * that block in the new content, git-apply style: exact match first, then with
 * increasing "fuzz" (dropping outermost context lines), searching positions
 * nearest the original location first. No match → the comment is "orphaned",
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

// ---------------------------------------------------------------------------
// Three-outcome re-anchoring (spec §6.4)

export type ReanchorOutcome =
  /** Unchanged or shifted: the comment silently follows. */
  | { kind: "match"; line: number; end_line: number }
  /** The anchored region itself was modified; context still locates it. */
  | { kind: "modified"; line: number; end_line: number }
  /** Deleted or changed beyond confident matching. */
  | { kind: "lost" };

/** How much a modified region may grow (vs. the original) and still count as
 * "the same region, edited" rather than "gone". */
function maxModifiedLength(originalLines: number): number {
  return originalLines * 4 + 8;
}

/**
 * Classify what happened to an anchored region in `content`:
 *  1. block (context + lines) still present, possibly fuzzy → match;
 *  2. surrounding context present with *different* content between → modified;
 *  3. otherwise (including context present but region deleted) → lost.
 */
export function reanchorOutcome(
  anchor: CommentAnchor,
  content: string[],
  expectedLine: number,
): ReanchorOutcome {
  const exact = reanchor(anchor, content, expectedLine);
  if (exact) return { kind: "match", ...exact };

  const before = anchor.context_before;
  const after = anchor.context_after;
  if (before.length === 0 && after.length === 0) return { kind: "lost" };

  // Locate the before-context nearest the old position, then scan forward for
  // the after-context within a bounded gap.
  const expectedBefore = expectedLine - 1 - before.length;
  const maxGap = maxModifiedLength(anchor.lines.length);

  let gapStart: number; // index of the first line of the candidate region
  if (before.length > 0) {
    const b = findNearest(before, content, expectedBefore);
    if (b === null) return { kind: "lost" };
    gapStart = b + before.length;
  } else {
    gapStart = 0; // anchor was at the top of the file
  }

  let gapEnd: number; // exclusive
  if (after.length > 0) {
    let found = -1;
    for (let end = gapStart; end <= Math.min(gapStart + maxGap, content.length - after.length); end++) {
      if (matchesAt(after, content, end)) {
        found = end;
        break;
      }
    }
    if (found === -1) return { kind: "lost" };
    gapEnd = found;
  } else {
    gapEnd = Math.min(gapStart + anchor.lines.length, content.length); // anchor ran to EOF
  }

  const gap = gapEnd - gapStart;
  if (gap <= 0) return { kind: "lost" }; // region deleted outright
  return { kind: "modified", line: gapStart + 1, end_line: gapEnd };
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
