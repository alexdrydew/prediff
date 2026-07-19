/** Memoized derived state. */

import type { InterdiffManifest, ManifestFile, ReviewComment } from "../types";
import {
  isExpanded,
  type AppState,
  type FileDiffState,
  type InterdiffState,
  type SyncStatus,
} from "./store";
import { buildRows, type Row, type RowsInput } from "../lib/rows";
import { matchesFilter, parseFilter } from "../lib/filter";
import { sidebarRows, sortByTreeOrder, type SidebarRow } from "../lib/tree";

// ---------------------------------------------------------------------------
// Row model

/** memoize-one helper keyed on reference-compared inputs. */
function memoOne<I extends readonly unknown[], O>(fn: (...args: I) => O): (...args: I) => O {
  let lastArgs: I | null = null;
  let lastOut: O;
  return (...args: I): O => {
    if (lastArgs !== null && lastArgs.length === args.length && lastArgs.every((a, i) => a === args[i])) {
      return lastOut;
    }
    lastArgs = args;
    lastOut = fn(...args);
    return lastOut;
  };
}

/** Stable fallbacks — fresh literals would defeat memoization and make
 * getSnapshot return a new object every call (infinite render loop). */
const EMPTY_FILES: readonly ManifestFile[] = [];

const expandedSet = memoOne(
  (
    files: readonly ManifestFile[],
    collapsedOverride: AppState["collapsedOverride"],
    autoCollapsed: AppState["autoCollapsed"],
  ): ReadonlySet<string> => {
    const state = { collapsedOverride, autoCollapsed } as AppState;
    const set = new Set<string>();
    for (const f of files) if (isExpanded(state, f)) set.add(f.path);
    return set;
  },
);

/** Effective per-file expansion (defaults + overrides), memoized. */
export function selectExpanded(state: AppState): ReadonlySet<string> {
  return expandedSet(state.manifest?.files ?? EMPTY_FILES, state.collapsedOverride, state.autoCollapsed);
}

const rowsMemo = memoOne((input: RowsInput): Row[] => buildRows(input));

const rowsInputMemo = memoOne(
  (
    files: readonly ManifestFile[],
    expanded: ReadonlySet<string>,
    viewedFiles: ReadonlySet<string>,
    fileDiffs: AppState["fileDiffs"],
    comments: AppState["comments"],
    composers: AppState["composers"],
    viewMode: AppState["viewMode"],
    contextContent: AppState["contextContent"],
    contextExpansion: AppState["contextExpansion"],
    reviewComposerOpen: boolean,
  ): RowsInput => ({
    files,
    expanded,
    viewedFiles,
    fileDiffs,
    comments,
    composers,
    viewMode,
    contextContent,
    contextExpansion,
    reviewComposerOpen,
  }),
);

/** Manifest files in flattened directory-tree order (QA gap §1.6): the diff
 * panel renders in this order, so n/p navigation follows the tree. */
const treeOrderedFilesMemo = memoOne((files: readonly ManifestFile[]): ManifestFile[] =>
  sortByTreeOrder(files),
);

export function selectOrderedFiles(state: AppState): readonly ManifestFile[] {
  return treeOrderedFilesMemo(state.manifest?.files ?? EMPTY_FILES);
}

export function selectRows(state: AppState): Row[] {
  if (state.interdiff !== null) return selectInterdiffRows(state);
  if (!state.manifest) return EMPTY_ROWS;
  const input = rowsInputMemo(
    selectOrderedFiles(state),
    selectExpanded(state),
    state.viewedFiles,
    state.fileDiffs,
    state.comments,
    state.composers,
    state.viewMode,
    state.contextContent,
    state.contextExpansion,
    state.reviewComposerOpen,
  );
  return rowsMemo(input);
}

const EMPTY_ROWS: Row[] = [];

// ---------------------------------------------------------------------------
// Interdiff mode (QA gap §1.4): same row machinery over synthesized inputs.

/** Interdiff manifest entries as ManifestFile stubs for the row model. */
const interdiffFilesMemo = memoOne((manifest: InterdiffManifest): ManifestFile[] =>
  manifest.files.map((f) => ({
    path: f.path,
    status: "modified" as const,
    additions: f.additions,
    deletions: f.deletions,
    binary: false,
    large: false,
  })),
);

/** path → reason for files whose interdiff can't be served. */
const interdiffUnavailableMemo = memoOne(
  (manifest: InterdiffManifest): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const f of manifest.files) {
      if (!f.available) out[f.path] = f.reason ?? "content not recorded";
    }
    return out;
  },
);

/** Interdiff per-file states mapped onto the row model's FileDiffState. */
const interdiffDiffsMemo = memoOne(
  (diffs: InterdiffState["diffs"]): Record<string, FileDiffState> => {
    const out: Record<string, FileDiffState> = {};
    for (const [path, d] of Object.entries(diffs)) {
      if (d.status === "ready" && d.diff) out[path] = { status: "ready", diff: d.diff, revision: 0 };
      else if (d.status === "error") {
        out[path] = { status: "error", revision: 0, ...(d.error !== undefined ? { error: d.error } : {}) };
      } else if (d.status === "loading") out[path] = { status: "loading", revision: 0 };
      // "unavailable" renders through RowsInput.unavailable, not fileDiffs.
    }
    return out;
  },
);

const interdiffExpandedMemo = memoOne(
  (files: readonly ManifestFile[], collapsed: ReadonlySet<string>): ReadonlySet<string> => {
    const set = new Set<string>();
    for (const f of files) if (!collapsed.has(f.path)) set.add(f.path);
    return set;
  },
);

const EMPTY_COMMENTS: readonly ReviewComment[] = [];
const EMPTY_COMPOSERS: AppState["composers"] = {};

const interdiffRowsInputMemo = memoOne(
  (
    files: readonly ManifestFile[],
    expanded: ReadonlySet<string>,
    fileDiffs: Record<string, FileDiffState>,
    viewMode: AppState["viewMode"],
    unavailable: Record<string, string>,
  ): RowsInput => ({
    files,
    expanded,
    viewedFiles: new Set<string>(),
    fileDiffs,
    comments: EMPTY_COMMENTS,
    composers: EMPTY_COMPOSERS,
    viewMode,
    contextContent: {},
    contextExpansion: {},
    unavailable,
  }),
);

function selectInterdiffRows(state: AppState): Row[] {
  const mode = state.interdiff;
  if (!mode || mode.manifest === null) return EMPTY_ROWS;
  const files = interdiffFilesMemo(mode.manifest);
  const input = interdiffRowsInputMemo(
    files,
    interdiffExpandedMemo(files, mode.collapsed),
    interdiffDiffsMemo(mode.diffs),
    state.viewMode,
    interdiffUnavailableMemo(mode.manifest),
  );
  return rowsMemo(input);
}

// ---------------------------------------------------------------------------
// Counts

const draftsMemo = memoOne((comments: AppState["comments"]) =>
  comments.filter((c) => c.state === "draft"),
);

/** Draft comments (memoized — safe to use directly as a snapshot). */
export function selectDrafts(state: AppState): AppState["comments"] {
  return draftsMemo(state.comments);
}

const orphansMemo = memoOne((comments: AppState["comments"]) =>
  comments.filter((c) => c.state === "orphaned"),
);

/** Orphaned comments (memoized — safe to use directly as a snapshot). */
export function selectOrphans(state: AppState): AppState["comments"] {
  return orphansMemo(state.comments);
}

export function selectDraftCount(state: AppState): number {
  return state.comments.filter((c) => c.state === "draft").length;
}

export function selectUnresolvedCount(state: AppState): number {
  return state.comments.filter((c) => c.state !== "resolved").length;
}

export function selectOrphanCount(state: AppState): number {
  return state.comments.filter((c) => c.state === "orphaned").length;
}

/** Sync indicator state (spec §6.5), derived. */
export function selectSyncStatus(state: AppState): SyncStatus {
  if (state.syncError !== null) return "error";
  if (state.connection !== "online") return "offline";
  if (state.savingCount > 0) return "saving";
  if (state.agentRevising) return "agent-revising";
  return "synced";
}

// ---------------------------------------------------------------------------
// File tree

export interface TreeItem {
  /** file.path, hoisted for the directory-tree grouping (§1.6). */
  path: string;
  file: ManifestFile;
  viewed: boolean;
  expanded: boolean;
  commentCount: number;
  unresolvedCount: number;
  agentTouched: boolean;
  /** Why this file was flagged outside the stated scope, or null (tooltip). */
  scopeFlag: string | null;
}

export interface TreeModel {
  /** Sidebar rows for ordinary files: directory tree, or a flat list while
   * the filter is active (QA gap §1.6). */
  rows: SidebarRow<TreeItem>[];
  /** Auto-collapsed files (generated / deleted / oversized) — §7.1. */
  collapsed: TreeItem[];
  totalFiles: number;
  viewedFiles: number;
}

const treeMemo = memoOne(
  (
    files: readonly ManifestFile[],
    viewedFiles: ReadonlySet<string>,
    expanded: ReadonlySet<string>,
    comments: AppState["comments"],
    agentTouched: ReadonlySet<string>,
    filterQuery: string,
    collapsedDirs: ReadonlySet<string>,
  ): TreeModel => {
    const parsed = parseFilter(filterQuery);
    const filterActive = filterQuery.trim() !== "";
    const byFile = new Map<string, { total: number; unresolved: number }>();
    for (const c of comments) {
      if (c.file === null) continue; // review-level: not attached to any file
      const e = byFile.get(c.file) ?? { total: 0, unresolved: 0 };
      e.total++;
      if (c.state !== "resolved") e.unresolved++;
      byFile.set(c.file, e);
    }
    const active: TreeItem[] = [];
    const collapsed: TreeItem[] = [];
    for (const file of files) {
      const counts = byFile.get(file.path) ?? { total: 0, unresolved: 0 };
      const item: TreeItem = {
        path: file.path,
        file,
        viewed: viewedFiles.has(file.path),
        expanded: expanded.has(file.path),
        commentCount: counts.total,
        unresolvedCount: counts.unresolved,
        agentTouched: agentTouched.has(file.path),
        // Server-computed (content-aware heuristic, QA §1.2) — read, not derived.
        scopeFlag: file.scope_flag?.reason ?? null,
      };
      if (
        !matchesFilter(
          file.path,
          {
            viewed: item.viewed,
            commentCount: item.commentCount,
            agentTouched: item.agentTouched,
          },
          parsed,
        )
      ) {
        continue;
      }
      (item.expanded ? active : collapsed).push(item);
    }
    return {
      // Group into a directory tree; the filter flattens to full paths.
      rows: sidebarRows(active, collapsedDirs, filterActive),
      collapsed,
      totalFiles: files.length,
      viewedFiles: files.filter((f) => viewedFiles.has(f.path)).length,
    };
  },
);

export function selectTree(state: AppState): TreeModel {
  return treeMemo(
    selectOrderedFiles(state),
    state.viewedFiles,
    selectExpanded(state),
    state.comments,
    state.agentTouched,
    state.filterQuery,
    state.collapsedDirs,
  );
}

// ---------------------------------------------------------------------------
// Minimap (spec §7.3): only above ~500 changed lines.

export const MINIMAP_THRESHOLD = 500;

export interface MinimapModel {
  /** Row indices of hunk headers. */
  ticks: number[];
  /** Row indices of comment threads with their state. */
  comments: Array<{ index: number; state: string }>;
  rowCount: number;
}

const minimapMemo = memoOne((rows: Row[]): MinimapModel => {
  const ticks: number[] = [];
  const comments: MinimapModel["comments"] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.kind === "hunk") ticks.push(i);
    else if (row.kind === "thread") comments.push({ index: i, state: row.comment.state });
  }
  return { ticks, comments, rowCount: rows.length };
});

export function selectMinimap(state: AppState): MinimapModel | null {
  if (state.interdiff !== null) return null; // comparison view keeps chrome minimal
  const manifest = state.manifest;
  if (!manifest || manifest.additions + manifest.deletions < MINIMAP_THRESHOLD) return null;
  return minimapMemo(selectRows(state));
}
