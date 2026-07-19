/**
 * The row model: flattens manifest + loaded hunks + comments + open composers
 * + expanded context into one flat array that a single virtualizer windows
 * over. This is the core of the "50k lines with bounded DOM" strategy — the
 * whole review is one list; only visible rows materialize as DOM nodes.
 */

import type { FileDiff, Hunk, HunkLine, ManifestFile, ReviewComment, Side } from "../types";
import type { ComposerTarget, FileDiffState, ViewMode } from "../state/store";
import { pairHunkLines, type PairedLine } from "./pairing";

// ---------------------------------------------------------------------------
// Row types

export interface HunkHeaderInfo {
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  header: string;
}

export type MetaVariant = "binary" | "large" | "loading" | "error" | "empty" | "unavailable";

/** One unexpanded context gap ("Expand context" control, spec §3.2). */
export interface GapInfo {
  /** Gap index: 0 = above the first hunk … hunkCount = after the last. */
  index: number;
  /** Hidden line count; null when the file length isn't known yet. */
  hidden: number | null;
  /** Whether new-side content has been fetched for this file. */
  loaded: boolean;
  /** Directions that reveal lines (leading gap only expands up, etc.). */
  up: boolean;
  down: boolean;
}

export type Row =
  | {
      kind: "file";
      key: string;
      file: ManifestFile;
      expanded: boolean;
      viewed: boolean;
      commentCount: number;
      unresolvedCount: number;
    }
  | { kind: "hunk"; key: string; path: string; hunk: HunkHeaderInfo; hunkIdx: number; hunkCount: number }
  | {
      kind: "line";
      key: string;
      path: string;
      line: HunkLine;
      hunkIdx: number;
      /** Text of the paired del/add line, for word-level marks (spec §3.2). */
      counterpart?: string;
    }
  | { kind: "pair"; key: string; path: string; pair: PairedLine; hunkIdx: number }
  /** path null = review-level comment (QA gap §1.1), rendered above files. */
  | { kind: "thread"; key: string; path: string | null; comment: ReviewComment; detached: boolean }
  | { kind: "composer"; key: string; path: string; target: ComposerTarget }
  | {
      kind: "meta";
      key: string;
      path: string;
      variant: MetaVariant;
      message?: string;
      /** Changed-line count, for the "large diff withheld" copy (QA §2.5). */
      lines?: number;
    }
  | { kind: "expand"; key: string; path: string; gap: GapInfo; hunkIdx: number }
  /** Section header of the review-level comment block (QA gap §1.1). */
  | { kind: "review-label"; key: string; count: number }
  /** The open review-level comment composer (no line anchor). */
  | { kind: "review-composer"; key: string };

/** Per-gap reveal state: lines shown from the gap's top / bottom edge. */
export interface GapReveal {
  top: number;
  bottom: number;
}

export interface RowsInput {
  files: readonly ManifestFile[];
  expanded: ReadonlySet<string>;
  viewedFiles: ReadonlySet<string>;
  fileDiffs: Readonly<Record<string, FileDiffState>>;
  comments: readonly ReviewComment[];
  composers: Readonly<Record<string, ComposerTarget>>;
  viewMode: ViewMode;
  /** New-side full file content, fetched on first "Expand context". */
  contextContent: Readonly<Record<string, readonly string[]>>;
  contextExpansion: Readonly<Record<string, Readonly<Record<number, GapReveal>>>>;
  /** The review-level composer is open (QA gap §1.1). */
  reviewComposerOpen?: boolean;
  /** Interdiff mode: path → reason its interdiff can't be served (§1.4). */
  unavailable?: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------

interface FileAttachments {
  comments: ReviewComment[];
  composers: ComposerTarget[];
}

function groupByFile(
  comments: readonly ReviewComment[],
  composers: Readonly<Record<string, ComposerTarget>>,
): Map<string, FileAttachments> {
  const map = new Map<string, FileAttachments>();
  const entry = (file: string): FileAttachments => {
    let e = map.get(file);
    if (!e) {
      e = { comments: [], composers: [] };
      map.set(file, e);
    }
    return e;
  };
  // Review-level comments (file null) live in the review block, not on a file.
  for (const c of comments) {
    if (c.file !== null) entry(c.file).comments.push(c);
  }
  for (const c of Object.values(composers)) entry(c.file).composers.push(c);
  return map;
}

export function buildRows(input: RowsInput): Row[] {
  const rows: Row[] = [];
  const attachments = groupByFile(input.comments, input.composers);

  // Review-level block (QA gap §1.1): comments about the change as a whole
  // render in a dedicated block ABOVE the first file, GitHub-summary style.
  const reviewComments = input.comments.filter((c) => c.file === null);
  if (reviewComments.length > 0 || input.reviewComposerOpen === true) {
    rows.push({ kind: "review-label", key: "review-label", count: reviewComments.length });
    for (const comment of reviewComments) {
      rows.push({ kind: "thread", key: `t:${comment.id}`, path: null, comment, detached: false });
    }
    if (input.reviewComposerOpen === true) {
      rows.push({ kind: "review-composer", key: "review-composer" });
    }
  }

  for (const file of input.files) {
    const fileAtt = attachments.get(file.path) ?? { comments: [], composers: [] };
    const expanded = input.expanded.has(file.path);
    rows.push({
      kind: "file",
      key: `f:${file.path}`,
      file,
      expanded,
      viewed: input.viewedFiles.has(file.path),
      commentCount: fileAtt.comments.length,
      unresolvedCount: fileAtt.comments.filter((c) => c.state !== "resolved").length,
    });
    if (!expanded) continue;

    // File-level notes (line 0, converted orphans — spec §6.4) render right
    // under the file header, before any hunk.
    const placed = new Set<ReviewComment | ComposerTarget>();
    for (const comment of fileAtt.comments) {
      if (comment.line === 0) {
        placed.add(comment);
        rows.push({
          kind: "thread",
          key: `t:${comment.id}`,
          path: file.path,
          comment,
          detached: false,
        });
      }
    }

    const unavailableReason = input.unavailable?.[file.path];
    if (unavailableReason !== undefined) {
      rows.push({
        kind: "meta",
        key: `m:${file.path}`,
        path: file.path,
        variant: "unavailable",
        message: unavailableReason,
      });
      continue;
    }

    if (file.binary) {
      rows.push({ kind: "meta", key: `m:${file.path}`, path: file.path, variant: "binary" });
      continue;
    }

    const state = input.fileDiffs[file.path];
    if (!state || (state.status === "loading" && !state.diff)) {
      rows.push({ kind: "meta", key: `m:${file.path}`, path: file.path, variant: "loading" });
      continue;
    }
    if (state.status === "error") {
      rows.push({
        kind: "meta",
        key: `m:${file.path}`,
        path: file.path,
        variant: "error",
        ...(state.error !== undefined ? { message: state.error } : {}),
      });
      continue;
    }
    const diff = state.diff;
    if (!diff) continue;
    if (diff.large && diff.hunks.length === 0) {
      rows.push({
        kind: "meta",
        key: `m:${file.path}`,
        path: file.path,
        variant: "large",
        lines: file.additions + file.deletions,
      });
      continue;
    }
    if (diff.hunks.length === 0) {
      rows.push({ kind: "meta", key: `m:${file.path}`, path: file.path, variant: "empty" });
      continue;
    }

    pushDiffRows(rows, file.path, diff, input, fileAtt, placed);

    // Anything that didn't land on a rendered line (orphaned comments, lines
    // outside hunk context) is appended at the end of the file so nothing is
    // ever invisible.
    for (const comment of fileAtt.comments) {
      if (!placed.has(comment)) {
        rows.push({
          kind: "thread",
          key: `t:${comment.id}`,
          path: file.path,
          comment,
          detached: true,
        });
      }
    }
    for (const composer of fileAtt.composers) {
      if (!placed.has(composer)) {
        rows.push({
          kind: "composer",
          key: `c:${composer.key}`,
          path: file.path,
          target: composer,
        });
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Context gaps

interface Gap {
  index: number;
  /** New-side inclusive range [start, end]; end null = unknown (EOF gap,
   * content not fetched). */
  start: number;
  end: number | null;
  /** new-line − old-line offset inside this gap. */
  delta: number;
}

/** The context gaps around/between hunks, in new-side line numbers. */
export function fileGaps(hunks: readonly Hunk[], fileLines: number | null): Gap[] {
  const gaps: Gap[] = [];
  for (let i = 0; i <= hunks.length; i++) {
    const prev = hunks[i - 1];
    const next = hunks[i];
    const start = prev ? prev.new_start + prev.new_lines : 1;
    let end: number | null;
    if (next) {
      end = next.new_start - 1;
    } else {
      end = fileLines; // null while unknown
    }
    const delta = next
      ? next.new_start - next.old_start
      : prev
        ? prev.new_start + prev.new_lines - (prev.old_start + prev.old_lines)
        : 0;
    if (end !== null && end < start) continue; // no gap
    gaps.push({ index: i, start, end, delta });
  }
  return gaps;
}

function pushDiffRows(
  rows: Row[],
  path: string,
  diff: FileDiff,
  input: RowsInput,
  att: FileAttachments,
  placed: Set<ReviewComment | ComposerTarget>,
): void {
  // Attachment lookup: side + end_line → items to render after that line.
  const bySideLine = new Map<string, FileAttachments>();
  const slot = (side: Side, line: number): FileAttachments => {
    const key = `${side}:${line}`;
    let e = bySideLine.get(key);
    if (!e) {
      e = { comments: [], composers: [] };
      bySideLine.set(key, e);
    }
    return e;
  };
  for (const c of att.comments) {
    if (c.line > 0) slot(c.side, c.end_line).comments.push(c);
  }
  for (const c of att.composers) slot(c.side, c.end_line).composers.push(c);

  const emitAttachmentsAt = (side: Side, n: number | null): void => {
    if (n === null) return;
    const e = bySideLine.get(`${side}:${n}`);
    if (!e) return;
    for (const comment of e.comments) {
      if (placed.has(comment)) continue;
      placed.add(comment);
      rows.push({ kind: "thread", key: `t:${comment.id}`, path, comment, detached: false });
    }
    for (const composer of e.composers) {
      if (placed.has(composer)) continue;
      placed.add(composer);
      rows.push({ kind: "composer", key: `c:${composer.key}`, path, target: composer });
    }
  };

  const emitAttachments = (line: HunkLine | PairedLine): void => {
    if ("kind" in line) {
      emitAttachmentsAt("old", line.old_line);
      emitAttachmentsAt("new", line.new_line);
    } else {
      emitAttachmentsAt("old", line.left?.old_line ?? null);
      emitAttachmentsAt("new", line.right?.new_line ?? null);
    }
  };

  const content = input.contextContent[path];
  const expansion = input.contextExpansion[path] ?? {};
  const gaps = fileGaps(diff.hunks, content ? content.length : null);
  const gapByIndex = new Map(gaps.map((g) => [g.index, g]));
  const hunkCount = diff.hunks.length;

  const emitContextLine = (newLine: number, delta: number, hunkIdx: number): void => {
    const text = content?.[newLine - 1];
    if (text === undefined) return;
    const line: HunkLine = {
      kind: "context",
      old_line: newLine - delta,
      new_line: newLine,
      text,
    };
    if (input.viewMode === "unified") {
      rows.push({ kind: "line", key: `x:${path}:${newLine}`, path, line, hunkIdx });
    } else {
      rows.push({
        kind: "pair",
        key: `x:${path}:${newLine}`,
        path,
        pair: { left: line, right: line },
        hunkIdx,
      });
    }
    emitAttachments(line);
  };

  /** Emit a gap's revealed lines and (if lines remain hidden) an expand row.
   * `hunkIdx` is the following hunk (or hunkCount for the trailing gap). */
  const emitGap = (index: number): void => {
    const gap = gapByIndex.get(index);
    if (!gap) return;
    const hunkIdx = Math.min(index, hunkCount - 1);
    const reveal = expansion[index] ?? { top: 0, bottom: 0 };
    const loaded = content !== undefined;
    const isLeading = index === 0;
    const isTrailing = index === hunkCount;

    if (gap.end !== null) {
      const total = gap.end - gap.start + 1;
      const top = Math.min(isLeading ? 0 : reveal.top, total);
      const bottom = Math.min(isTrailing ? 0 : reveal.bottom, total - top);
      const hidden = total - top - bottom;
      for (let n = gap.start; n < gap.start + top; n++) emitContextLine(n, gap.delta, hunkIdx);
      if (hidden > 0) {
        // "up" reveals lines above the next hunk (needs a next hunk);
        // "down" reveals lines below the previous hunk (needs a previous one).
        rows.push({
          kind: "expand",
          key: `e:${path}:${index}`,
          path,
          hunkIdx,
          gap: { index, hidden, loaded, up: !isTrailing, down: !isLeading },
        });
      }
      for (let n = gap.end - bottom + 1; n <= gap.end; n++) emitContextLine(n, gap.delta, hunkIdx);
    } else {
      // Trailing gap with unknown length: offer the control; clicking fetches.
      rows.push({
        kind: "expand",
        key: `e:${path}:${index}`,
        path,
        hunkIdx,
        gap: { index, hidden: null, loaded, up: false, down: true },
      });
    }
  };

  emitGap(0);
  for (let h = 0; h < diff.hunks.length; h++) {
    const hunk = diff.hunks[h];
    if (!hunk) continue;
    rows.push({
      kind: "hunk",
      key: `h:${path}:${h}`,
      path,
      hunkIdx: h,
      hunkCount,
      hunk: {
        old_start: hunk.old_start,
        old_lines: hunk.old_lines,
        new_start: hunk.new_start,
        new_lines: hunk.new_lines,
        header: hunk.header,
      },
    });
    if (input.viewMode === "unified") {
      // Word-level marks need the paired counterpart; derive it from the same
      // pairing the split view uses (object identity ties them together).
      const counterpartOf = new Map<HunkLine, string>();
      for (const pair of pairHunkLines(hunk.lines)) {
        if (pair.left && pair.right && pair.left !== pair.right) {
          counterpartOf.set(pair.left, pair.right.text);
          counterpartOf.set(pair.right, pair.left.text);
        }
      }
      for (let i = 0; i < hunk.lines.length; i++) {
        const line = hunk.lines[i];
        if (!line) continue;
        const counterpart = counterpartOf.get(line);
        rows.push({
          kind: "line",
          key: lineKey(path, line, h, i),
          path,
          line,
          hunkIdx: h,
          ...(counterpart !== undefined ? { counterpart } : {}),
        });
        emitAttachments(line);
      }
    } else {
      const pairs = pairHunkLines(hunk.lines);
      for (let i = 0; i < pairs.length; i++) {
        const pair = pairs[i];
        if (!pair) continue;
        rows.push({ kind: "pair", key: `p:${path}:${h}:${i}`, path, pair, hunkIdx: h });
        emitAttachments(pair);
      }
    }
    emitGap(h + 1);
  }
}

/** Stable-ish line key: prefers real line numbers so rows keep identity across
 * refreshes when content merely shifts. */
function lineKey(path: string, line: HunkLine, hunkIdx: number, lineIdx: number): string {
  if (line.old_line !== null || line.new_line !== null) {
    return `l:${path}:${line.old_line ?? ""}:${line.new_line ?? ""}`;
  }
  return `l:${path}:${hunkIdx}:${lineIdx}`;
}

// ---------------------------------------------------------------------------
// Height estimation for the virtualizer. Line rows are fixed-height (no
// wrapping; horizontal overflow scrolls), so only thread/composer rows need
// real measurement.

export const LINE_ROW_PX = 22;
export const FILE_ROW_PX = 36;
export const HUNK_ROW_PX = 28;
export const META_ROW_PX = 30;
export const EXPAND_ROW_PX = 26;
export const THREAD_ROW_ESTIMATE_PX = 120;
export const COMPOSER_ROW_ESTIMATE_PX = 170;

export function estimateRowHeight(row: Row): number {
  switch (row.kind) {
    case "line":
    case "pair":
      return LINE_ROW_PX;
    case "file":
      return FILE_ROW_PX;
    case "hunk":
      return HUNK_ROW_PX;
    case "meta":
      return META_ROW_PX;
    case "expand":
      return EXPAND_ROW_PX;
    case "thread":
      return THREAD_ROW_ESTIMATE_PX;
    case "composer":
    case "review-composer":
      return COMPOSER_ROW_ESTIMATE_PX;
    case "review-label":
      return HUNK_ROW_PX;
  }
}

/** Rows whose height varies with content and must be measured after mount. */
export function isDynamicRow(row: Row): boolean {
  return row.kind === "thread" || row.kind === "composer" || row.kind === "review-composer";
}
