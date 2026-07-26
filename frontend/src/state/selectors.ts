/** Memoized derived state. */

import type { ManifestFile } from "../types";
import { isExpanded, type AppState, type SyncStatus } from "./store";
import { matchesFilter, parseFilter } from "../lib/filter";
import { sidebarRows, sortByTreeOrder, type SidebarRow } from "../lib/tree";

// ---------------------------------------------------------------------------
// Shared memoization

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

/** Manifest files in flattened directory-tree order (QA gap §1.6): the diff
 * panel renders in this order, so n/p navigation follows the tree. */
const treeOrderedFilesMemo = memoOne((files: readonly ManifestFile[]): ManifestFile[] =>
  sortByTreeOrder(files),
);

export function selectOrderedFiles(state: AppState): readonly ManifestFile[] {
  return treeOrderedFilesMemo(state.manifest?.files ?? EMPTY_FILES);
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
