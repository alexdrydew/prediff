/**
 * Suggested-change prefill (QA gap §1.5): the composer's "Suggest change"
 * textarea starts from the anchored lines' CURRENT text. Sourced from the
 * already-loaded hunks (plus expanded-context content when available) so the
 * common case needs no extra fetch. Pure for unit testing.
 */

import type { Hunk, Side } from "../types";

/** Text of one line (1-based, on `side`) from the loaded hunks, or null. */
function hunkLineText(hunks: readonly Hunk[], side: Side, n: number): string | null {
  for (const hunk of hunks) {
    const start = side === "new" ? hunk.new_start : hunk.old_start;
    const count = side === "new" ? hunk.new_lines : hunk.old_lines;
    if (n < start || n >= start + count) continue;
    for (const line of hunk.lines) {
      const ln = side === "new" ? line.new_line : line.old_line;
      if (ln === n) return line.text;
    }
  }
  return null;
}

/**
 * Prefill for lines line..endLine on `side`. `content` is the full file
 * content for that side when it has been fetched (expand-context cache).
 * Returns null when any line can't be resolved locally — the caller then
 * falls back to fetching the file content.
 */
export function suggestionPrefill(
  hunks: readonly Hunk[] | undefined,
  content: readonly string[] | undefined,
  side: Side,
  line: number,
  endLine: number,
): string | null {
  const texts: string[] = [];
  for (let n = line; n <= endLine; n++) {
    const fromHunks = hunks !== undefined ? hunkLineText(hunks, side, n) : null;
    const text = fromHunks ?? content?.[n - 1] ?? null;
    if (text === null) return null;
    texts.push(text);
  }
  return texts.join("\n");
}
