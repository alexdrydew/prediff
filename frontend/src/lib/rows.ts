/**
 * The row model: flattens manifest + loaded hunks + comments + open composers
 * into one flat array that a single virtualizer windows over. This is the
 * core of the "50k lines with bounded DOM" strategy — the whole review is one
 * list; only visible rows materialize as DOM nodes.
 */

import type { FileDiff, HunkLine, ManifestFile, ReviewComment, Side } from "../types";
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

export type MetaVariant = "binary" | "large" | "loading" | "error" | "empty";

export type Row =
  | {
      kind: "file";
      key: string;
      file: ManifestFile;
      expanded: boolean;
      commentCount: number;
      openCommentCount: number;
    }
  | { kind: "hunk"; key: string; path: string; hunk: HunkHeaderInfo }
  | { kind: "line"; key: string; path: string; line: HunkLine }
  | { kind: "pair"; key: string; path: string; pair: PairedLine }
  | { kind: "thread"; key: string; path: string; comment: ReviewComment; detached: boolean }
  | { kind: "composer"; key: string; path: string; target: ComposerTarget }
  | { kind: "meta"; key: string; path: string; variant: MetaVariant; message?: string };

export interface RowsInput {
  files: readonly ManifestFile[];
  expanded: ReadonlySet<string>;
  fileDiffs: Readonly<Record<string, FileDiffState>>;
  comments: readonly ReviewComment[];
  composers: Readonly<Record<string, ComposerTarget>>;
  viewMode: ViewMode;
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
  for (const c of comments) entry(c.file).comments.push(c);
  for (const c of Object.values(composers)) entry(c.file).composers.push(c);
  return map;
}

export function buildRows(input: RowsInput): Row[] {
  const rows: Row[] = [];
  const attachments = groupByFile(input.comments, input.composers);

  for (const file of input.files) {
    const fileAtt = attachments.get(file.path) ?? { comments: [], composers: [] };
    const expanded = input.expanded.has(file.path);
    rows.push({
      kind: "file",
      key: `f:${file.path}`,
      file,
      expanded,
      commentCount: fileAtt.comments.length,
      openCommentCount: fileAtt.comments.filter((c) => c.state === "open").length,
    });
    if (!expanded) continue;

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
      rows.push({ kind: "meta", key: `m:${file.path}`, path: file.path, variant: "large" });
      continue;
    }
    if (diff.hunks.length === 0) {
      rows.push({ kind: "meta", key: `m:${file.path}`, path: file.path, variant: "empty" });
      continue;
    }

    const placed = new Set<ReviewComment | ComposerTarget>();
    pushDiffRows(rows, file.path, diff, input.viewMode, fileAtt, placed);

    // Anything that didn't land on a rendered line (outdated comments, lines
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

function pushDiffRows(
  rows: Row[],
  path: string,
  diff: FileDiff,
  viewMode: ViewMode,
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
  for (const c of att.comments) slot(c.side, c.end_line).comments.push(c);
  for (const c of att.composers) slot(c.side, c.end_line).composers.push(c);

  const emitAttachments = (line: HunkLine | PairedLine): void => {
    const sides: Array<{ side: Side; n: number | null }> =
      "kind" in line
        ? [
            { side: "old", n: line.old_line },
            { side: "new", n: line.new_line },
          ]
        : [
            { side: "old", n: line.left?.old_line ?? null },
            { side: "new", n: line.right?.new_line ?? null },
          ];
    for (const { side, n } of sides) {
      if (n === null) continue;
      const e = bySideLine.get(`${side}:${n}`);
      if (!e) continue;
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
    }
  };

  for (let h = 0; h < diff.hunks.length; h++) {
    const hunk = diff.hunks[h];
    if (!hunk) continue;
    rows.push({
      kind: "hunk",
      key: `h:${path}:${h}`,
      path,
      hunk: {
        old_start: hunk.old_start,
        old_lines: hunk.old_lines,
        new_start: hunk.new_start,
        new_lines: hunk.new_lines,
        header: hunk.header,
      },
    });
    if (viewMode === "unified") {
      for (let i = 0; i < hunk.lines.length; i++) {
        const line = hunk.lines[i];
        if (!line) continue;
        rows.push({ kind: "line", key: lineKey(path, line, h, i), path, line });
        emitAttachments(line);
      }
    } else {
      const pairs = pairHunkLines(hunk.lines);
      for (let i = 0; i < pairs.length; i++) {
        const pair = pairs[i];
        if (!pair) continue;
        rows.push({ kind: "pair", key: `p:${path}:${h}:${i}`, path, pair });
        emitAttachments(pair);
      }
    }
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
export const FILE_ROW_PX = 34;
export const HUNK_ROW_PX = 24;
export const META_ROW_PX = 30;
export const THREAD_ROW_ESTIMATE_PX = 120;
export const COMPOSER_ROW_ESTIMATE_PX = 130;

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
    case "thread":
      return THREAD_ROW_ESTIMATE_PX;
    case "composer":
      return COMPOSER_ROW_ESTIMATE_PX;
  }
}

/** Rows whose height varies with content and must be measured after mount. */
export function isDynamicRow(row: Row): boolean {
  return row.kind === "thread" || row.kind === "composer";
}
