/** Memoized derived state. */

import type { ManifestFile } from "../types";
import { isExpanded, type AppState, type SyncStatus } from "./store";
import { buildRows, type Row, type RowsInput } from "../lib/rows";
import { matchesFilter, parseFilter } from "../lib/filter";

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
  }),
);

export function selectRows(state: AppState): Row[] {
  if (!state.manifest) return EMPTY_ROWS;
  const input = rowsInputMemo(
    state.manifest.files,
    selectExpanded(state),
    state.viewedFiles,
    state.fileDiffs,
    state.comments,
    state.composers,
    state.viewMode,
    state.contextContent,
    state.contextExpansion,
  );
  return rowsMemo(input);
}

const EMPTY_ROWS: Row[] = [];

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
  /** Ordinary, reviewable files (expanded by default). */
  active: TreeItem[];
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
  ): TreeModel => {
    const parsed = parseFilter(filterQuery);
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
      active,
      collapsed,
      totalFiles: files.length,
      viewedFiles: files.filter((f) => viewedFiles.has(f.path)).length,
    };
  },
);

export function selectTree(state: AppState): TreeModel {
  return treeMemo(
    state.manifest?.files ?? EMPTY_FILES,
    state.viewedFiles,
    selectExpanded(state),
    state.comments,
    state.agentTouched,
    state.filterQuery,
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
  const manifest = state.manifest;
  if (!manifest || manifest.additions + manifest.deletions < MINIMAP_THRESHOLD) return null;
  return minimapMemo(selectRows(state));
}
