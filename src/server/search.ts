/**
 * In-diff content search (QA gap §1.3): case-insensitive substring match over
 * the hunk lines of a revision's raw diff. Runs server-side because the
 * virtualized client only materializes visible rows — and collapsed/withheld
 * (large) files never ship their hunks to the client at all, yet must be
 * searchable; the raw diff always has them.
 */

import { parseUnifiedDiff, splitFileSections } from "../git/diff";
import type { SearchMatch } from "../types";

/** Result cap: enough to be useful, small enough to stay instant. */
export const SEARCH_MAX_RESULTS = 500;

/** Preview budget around the first match in a long line. */
const PREVIEW_BEFORE = 32;
const PREVIEW_TOTAL = 140;

export interface SearchOutcome {
  matches: SearchMatch[];
  truncated: boolean;
}

/** Trim a matched line to a readable preview centered on the first hit. */
export function matchPreview(text: string, matchIndex: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= PREVIEW_TOTAL) return trimmed;
  const leadingWs = text.length - text.trimStart().length;
  const idx = Math.max(0, matchIndex - leadingWs);
  const start = Math.max(0, idx - PREVIEW_BEFORE);
  const slice = trimmed.slice(start, start + PREVIEW_TOTAL);
  return `${start > 0 ? "…" : ""}${slice}${start + PREVIEW_TOTAL < trimmed.length ? "…" : ""}`;
}

/**
 * Search every hunk line of `raw` (a multi-file unified diff) for `query`,
 * case-insensitive. Files are visited in path order; matches carry the line
 * number + side the client needs to jump to the row.
 */
export function searchRawDiff(
  raw: string,
  query: string,
  cap: number = SEARCH_MAX_RESULTS,
): SearchOutcome {
  const q = query.toLowerCase();
  const matches: SearchMatch[] = [];
  if (q === "") return { matches, truncated: false };

  const sections = splitFileSections(raw);
  const paths = [...sections.keys()].sort();
  for (const path of paths) {
    const { binary, hunks } = parseUnifiedDiff(sections.get(path) ?? "");
    if (binary) continue;
    for (let h = 0; h < hunks.length; h++) {
      for (const line of hunks[h]!.lines) {
        const idx = line.text.toLowerCase().indexOf(q);
        if (idx === -1) continue;
        if (matches.length >= cap) return { matches, truncated: true };
        matches.push({
          file: path,
          hunk_index: h,
          line: line.new_line ?? line.old_line ?? 0,
          side: line.new_line !== null ? "new" : "old",
          preview: matchPreview(line.text, idx),
        });
      }
    }
  }
  return { matches, truncated: false };
}
