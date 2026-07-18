/**
 * App state: a single zustand vanilla store (React binding lives in the
 * components via useStore). Server data is authoritative; the store caches it
 * plus purely-client state (collapse overrides, composers, view prefs).
 * Comment data is never kept in localStorage — the server is the source of
 * truth (spec §4.2, §9.1); localStorage holds view preferences only.
 */

import { createStore } from "zustand/vanilla";
import { useStore as useZustandStore } from "zustand";
import type {
  CommentTag,
  DiffManifest,
  FileDiff,
  ManifestFile,
  ReviewComment,
  RevisionInfo,
  SessionState,
  Side,
} from "../types";
import { api } from "../api/client";
import type { ConnectionStatus } from "../api/sse";
import { defaultCollapsed, hasGeneratedHeader } from "../lib/collapse";
import type { GapReveal } from "../lib/rows";
import { readPref, writePref } from "../lib/prefs";
import type { Theme } from "../lib/theme";
import { currentTheme } from "../lib/theme";

// ---------------------------------------------------------------------------
// Types

export type ViewMode = "unified" | "split";

export type Panel = "none" | "send" | "ready" | "attention" | "history" | "shortcuts";

/** Top-bar sync indicator states (spec §6.5). */
export type SyncStatus = "synced" | "saving" | "agent-revising" | "offline" | "error";

export interface FileDiffState {
  status: "loading" | "ready" | "error";
  /** Present when status is "ready" (kept during reload for soft refresh). */
  diff?: FileDiff;
  /** Revision this diff was fetched for. */
  revision: number;
  /** Longest line (tab-expanded chars), for sizing the horizontal canvas. */
  maxLineChars?: number;
  error?: string;
}

/** Longest line in ch (tabs ≈ 4), capped so one absurd line can't blow up layout. */
const MAX_CANVAS_CHARS = 400;

function maxLineChars(diff: FileDiff): number {
  let max = 0;
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      const tabs = line.text.includes("\t") ? line.text.split("\t").length - 1 : 0;
      const len = line.text.length + tabs * 3;
      if (len > max) max = len;
      if (max >= MAX_CANVAS_CHARS) return MAX_CANVAS_CHARS;
    }
  }
  return max;
}

/** Where an open comment composer is anchored. */
export interface ComposerTarget {
  key: string;
  file: string;
  side: Side;
  line: number;
  end_line: number;
}

/** In-progress line-range selection (mouse drag over the gutter). */
export interface LineSelection {
  file: string;
  side: Side;
  anchor: number;
  head: number;
}

export interface SessionMeta {
  session_id: string;
  range: string;
  /** The server's current (latest) revision. */
  revision: number;
  session_state: SessionState;
  scope: string | null;
}

export interface AppState {
  manifest: DiffManifest | null;
  session: SessionMeta | null;
  comments: ReviewComment[];
  viewedFiles: ReadonlySet<string>;
  connection: ConnectionStatus;
  loadError: string | null;

  /** Revision pinned in the viewer; null = tracking the latest (spec §6.1). */
  viewingRevision: number | null;
  /** A newer revision exists and hasn't been applied (banner, §6.1/§6.3). */
  pendingRevision: number | null;
  /** Feedback sent, no revision arrived yet ("Agent is revising", §6.5). */
  agentRevising: boolean;
  revisionList: RevisionInfo[] | null;
  /** Files whose diff changed in the most recent applied revision (§2). */
  agentTouched: ReadonlySet<string>;

  /** In-flight autosaves/actions (drives the "Saving…" indicator). */
  savingCount: number;
  /** A save/send failed; comments involved are safely drafts (spec §9.7). */
  syncError: string | null;

  viewMode: ViewMode;
  theme: Theme;
  treeWidth: number;
  kbarDismissed: boolean;
  filterQuery: string;

  /** Explicit user collapse/expand choices; wins over default collapse rules. */
  collapsedOverride: Readonly<Record<string, boolean>>;
  /** Files auto-collapsed after a @generated/DO-NOT-EDIT header was seen. */
  autoCollapsed: ReadonlySet<string>;

  fileDiffs: Readonly<Record<string, FileDiffState>>;
  /** New-side full content per path (expand context). */
  contextContent: Readonly<Record<string, readonly string[]>>;
  contextExpansion: Readonly<Record<string, Readonly<Record<number, GapReveal>>>>;

  /** Open composers, keyed by ComposerTarget.key — participates in row layout. */
  composers: Readonly<Record<string, ComposerTarget>>;
  /** Composer text per key — separate so typing doesn't invalidate rows. */
  draftText: Readonly<Record<string, string>>;
  selection: LineSelection | null;

  /** Comment id being manually re-anchored (click a line to place it, §6.4). */
  reanchoring: string | null;

  panel: Panel;
  /** File the viewport is currently inside (sticky header / tree highlight). */
  activePath: string | null;
  activeHunk: { idx: number; count: number } | null;
}

export const composerKey = (file: string, side: Side, line: number, endLine: number): string =>
  `${file} ${side} ${line} ${endLine}`;

// ---------------------------------------------------------------------------
// Store

export const store = createStore<AppState>(() => ({
  manifest: null,
  session: null,
  comments: [],
  viewedFiles: new Set<string>(),
  connection: "connecting",
  loadError: null,

  viewingRevision: null,
  pendingRevision: null,
  agentRevising: false,
  revisionList: null,
  agentTouched: new Set<string>(),

  savingCount: 0,
  syncError: null,

  viewMode: readPref<ViewMode>("viewMode", "split"),
  theme: "dark",
  treeWidth: readPref<number>("treeWidth", 280),
  kbarDismissed: readPref<boolean>("kbarDismissed", false),
  filterQuery: "",

  collapsedOverride: {},
  autoCollapsed: new Set<string>(),

  fileDiffs: {},
  contextContent: {},
  contextExpansion: {},

  composers: {},
  draftText: {},
  selection: null,

  reanchoring: null,

  panel: "none",
  activePath: null,
  activeHunk: null,
}));

const { setState, getState } = store;

export function useStore<T>(selector: (state: AppState) => T): T {
  return useZustandStore(store, selector);
}

/** The revision the viewer is showing (viewing pin, else server current). */
export function shownRevision(s: AppState): number | null {
  return s.viewingRevision ?? s.session?.revision ?? null;
}

/** Effective expanded-state for a file (spec §7.1 defaults + user override). */
export function isExpanded(s: AppState, file: ManifestFile): boolean {
  const override = s.collapsedOverride[file.path];
  if (override !== undefined) return !override;
  return !(defaultCollapsed(file) || s.autoCollapsed.has(file.path));
}

// ---------------------------------------------------------------------------
// Saving wrapper — drives the "Saving…" / "Sync failed" indicator (§6.5).

async function tracked<T>(op: () => Promise<T>): Promise<T> {
  setState((s) => ({ savingCount: s.savingCount + 1, syncError: null }));
  try {
    return await op();
  } catch (err) {
    setState({ syncError: err instanceof Error ? err.message : String(err) });
    throw err;
  } finally {
    setState((s) => ({ savingCount: Math.max(0, s.savingCount - 1) }));
  }
}

export function clearSyncError(): void {
  setState({ syncError: null });
}

// ---------------------------------------------------------------------------
// Server-data actions

export function upsertComment(comment: ReviewComment): void {
  setState((s) => {
    const idx = s.comments.findIndex((c) => c.id === comment.id);
    const comments =
      idx === -1 ? [...s.comments, comment] : s.comments.map((c, i) => (i === idx ? comment : c));
    return { comments };
  });
}

export function removeComment(id: string): void {
  setState((s) => ({ comments: s.comments.filter((c) => c.id !== id) }));
}

export function setSessionState(sessionState: SessionState): void {
  setState((s) =>
    s.session ? { session: { ...s.session, session_state: sessionState } } : {},
  );
}

export function setConnection(connection: ConnectionStatus): void {
  setState({ connection });
}

export function setAgentRevising(agentRevising: boolean): void {
  setState({ agentRevising });
}

export function setViewedFiles(files: readonly string[]): void {
  setState({ viewedFiles: new Set(files) });
}

/** Fetch manifest + session; used at boot and after resyncs. Never silently
 * swaps the shown revision: a newer one found here is queued (spec §6.1). */
export async function loadServerState(): Promise<void> {
  try {
    const session = await api.session();
    const s = getState();
    const shown = s.viewingRevision ?? s.manifest?.revision ?? null;
    let viewing = s.viewingRevision;
    let pending: number | null = null;
    if (shown !== null && session.revision > shown) {
      viewing = shown; // pin what the reviewer is looking at
      pending = session.revision;
    }
    let manifest: DiffManifest;
    try {
      manifest = await api.manifest(viewing);
    } catch {
      // Pinned revision no longer on disk (pruned): fall back to latest.
      manifest = await api.manifest(null);
      viewing = null;
      pending = null;
    }
    setState({
      manifest,
      comments: session.comments,
      viewedFiles: new Set(session.viewed_files),
      session: {
        session_id: session.session_id,
        range: session.range,
        revision: session.revision,
        session_state: session.session_state,
        scope: session.scope,
      },
      viewingRevision: viewing,
      pendingRevision: pending,
      loadError: null,
    });
  } catch (err) {
    setState({ loadError: err instanceof Error ? err.message : String(err) });
  }
}

/** Fetch hunks for one file; keeps stale content visible while reloading. */
export async function loadFileDiff(path: string, opts?: { force?: boolean }): Promise<void> {
  const s = getState();
  const revision = shownRevision(s) ?? 0;
  const existing = s.fileDiffs[path];
  if (existing?.status === "loading") return;
  if (existing?.status === "ready" && existing.revision === revision && !opts?.force) return;

  setState((st) => ({
    fileDiffs: {
      ...st.fileDiffs,
      [path]: { status: "loading", revision, ...(existing?.diff ? { diff: existing.diff } : {}) },
    },
  }));
  try {
    const viewing = getState().viewingRevision;
    const diff = await api.fileDiff(path, { ...(opts ?? {}), revision: viewing });
    setState((st) => {
      const next: Partial<AppState> = {
        fileDiffs: {
          ...st.fileDiffs,
          [path]: { status: "ready", diff, revision, maxLineChars: maxLineChars(diff) },
        },
      };
      // Header-based generated detection (spec §7.1): collapse once, unless
      // the user already made an explicit choice for this file.
      if (
        !st.autoCollapsed.has(path) &&
        st.collapsedOverride[path] === undefined &&
        hasGeneratedHeader(diff)
      ) {
        next.autoCollapsed = new Set(st.autoCollapsed).add(path);
      }
      return next;
    });
  } catch (err) {
    setState((st) => ({
      fileDiffs: {
        ...st.fileDiffs,
        [path]: {
          status: "error",
          revision,
          error: err instanceof Error ? err.message : String(err),
        },
      },
    }));
  }
}

// ---------------------------------------------------------------------------
// Revisions (spec §6.1/§6.3): never auto-apply.

/** SSE `revision`: pin the currently-shown revision, queue the new one. */
export function handleRevisionArrived(newRevision: number): void {
  setState((s) => {
    if (!s.session) return {};
    const shown = s.viewingRevision ?? s.session.revision;
    return {
      session: { ...s.session, revision: newRevision },
      viewingRevision: shown,
      pendingRevision: newRevision > shown ? newRevision : s.pendingRevision,
      agentRevising: false,
      revisionList: null, // stale; refetched on demand
    };
  });
}

/** "Keep reviewing Rev N": acknowledge the banner; stay pinned. The
 * viewing-older banner keeps a path back to the latest revision. */
export function dismissPendingRevision(): void {
  setState({ pendingRevision: null });
}

/** Switch the viewer to a revision (null = latest). Scroll offset, collapse
 * overrides, composers and drafts are all preserved (spec §6.1). */
export async function applyRevision(revision: number | null): Promise<void> {
  const s = getState();
  const current = s.session?.revision ?? null;
  const target = revision !== null && revision === current ? null : revision;
  const previousManifest = s.manifest;
  setState({
    viewingRevision: target,
    pendingRevision: null,
    contextContent: {}, // content is current-revision only
    contextExpansion: {},
  });
  try {
    const [manifest, session] = await Promise.all([api.manifest(target), api.session()]);
    setState((st) => ({
      manifest,
      comments: session.comments,
      viewedFiles: new Set(session.viewed_files),
      session: {
        session_id: session.session_id,
        range: session.range,
        revision: session.revision,
        session_state: session.session_state,
        scope: session.scope,
      },
      agentTouched:
        target === null && previousManifest !== null
          ? changedFiles(previousManifest, manifest)
          : st.agentTouched,
      loadError: null,
    }));
    await reloadExpandedDiffs();
  } catch (err) {
    setState({ loadError: err instanceof Error ? err.message : String(err) });
  }
}

/** Files whose stats/status changed between two manifests ("agent-touched"). */
function changedFiles(prev: DiffManifest, next: DiffManifest): Set<string> {
  const before = new Map(prev.files.map((f) => [f.path, f]));
  const touched = new Set<string>();
  for (const f of next.files) {
    const b = before.get(f.path);
    if (!b || b.additions !== f.additions || b.deletions !== f.deletions || b.status !== f.status) {
      touched.add(f.path);
    }
  }
  return touched;
}

async function reloadExpandedDiffs(): Promise<void> {
  const st = getState();
  const manifest = st.manifest;
  if (!manifest) return;
  const revision = shownRevision(st) ?? 0;
  const toReload = manifest.files
    .filter((f) => isExpanded(st, f))
    .map((f) => f.path)
    .filter((p) => {
      const d = st.fileDiffs[p];
      return d !== undefined && d.revision !== revision;
    });
  // Modest concurrency so a wide refresh doesn't stampede the daemon.
  const CONCURRENCY = 4;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, toReload.length) }, async () => {
      while (next < toReload.length) {
        const path = toReload[next++];
        if (path !== undefined) await loadFileDiff(path, { force: true });
      }
    }),
  );
}

export async function loadRevisionList(): Promise<void> {
  try {
    const result = await api.revisions();
    setState({ revisionList: result.revisions });
  } catch {
    // panel shows a fallback
  }
}

// ---------------------------------------------------------------------------
// Feedback / session actions (spec §5)

export async function sendFeedback(): Promise<void> {
  await tracked(async () => {
    const result = await api.sendFeedback();
    for (const c of result.comments) upsertComment(c);
    setState({ agentRevising: true, panel: "none" });
  });
}

export async function sendCommentNow(id: string): Promise<void> {
  await tracked(async () => {
    upsertComment(await api.sendComment(id));
    setState({ agentRevising: true });
  });
}

export async function markReady(): Promise<void> {
  await tracked(async () => {
    await api.markReady();
    setSessionState("ready");
    setState({ panel: "none" });
  });
}

export async function reopenSession(): Promise<void> {
  await tracked(async () => {
    await api.reopen();
    setSessionState("reviewing");
  });
}

export async function toggleViewed(path: string, viewed?: boolean): Promise<void> {
  const s = getState();
  const next = viewed ?? !s.viewedFiles.has(path);
  // Optimistic; SSE viewed.changed reconciles.
  const set = new Set(s.viewedFiles);
  if (next) set.add(path);
  else set.delete(path);
  const touched = new Set(s.agentTouched);
  touched.delete(path);
  setState({ viewedFiles: set, agentTouched: touched });
  try {
    await api.setViewed([path], next);
  } catch {
    setState((st) => {
      const revert = new Set(st.viewedFiles);
      if (next) revert.delete(path);
      else revert.add(path);
      return { viewedFiles: revert };
    });
  }
}

/** Bulk: mark every collapsed (generated/deleted/large) file viewed (§7.5). */
export async function markCollapsedViewed(): Promise<void> {
  const s = getState();
  const files = (s.manifest?.files ?? [])
    .filter((f) => !isExpanded(s, f) && !s.viewedFiles.has(f.path))
    .map((f) => f.path);
  if (files.length === 0) return;
  const set = new Set(s.viewedFiles);
  for (const f of files) set.add(f);
  setState({ viewedFiles: set });
  await tracked(() => api.setViewed(files, true));
}

// ---------------------------------------------------------------------------
// Comment actions

const autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const AUTOSAVE_MS = 1_000;

/** Edit a draft comment locally and autosave (debounced ~1s, spec §4.2). */
export function editDraft(id: string, patch: { text?: string; tag?: CommentTag | null }): void {
  setState((s) => ({
    comments: s.comments.map((c) => (c.id === id ? { ...c, ...patch } : c)),
  }));
  const existing = autosaveTimers.get(id);
  if (existing !== undefined) clearTimeout(existing);
  autosaveTimers.set(
    id,
    setTimeout(() => {
      autosaveTimers.delete(id);
      const comment = getState().comments.find((c) => c.id === id);
      if (!comment) return;
      void tracked(() => api.updateComment(id, { text: comment.text, tag: comment.tag })).then(
        (c) => upsertComment(c),
        () => undefined, // syncError already set by tracked()
      );
    }, AUTOSAVE_MS),
  );
}

/** Flush a pending autosave immediately (before send-now etc.). */
export async function flushDraft(id: string): Promise<void> {
  const timer = autosaveTimers.get(id);
  if (timer === undefined) return;
  clearTimeout(timer);
  autosaveTimers.delete(id);
  const comment = getState().comments.find((c) => c.id === id);
  if (!comment) return;
  await tracked(() => api.updateComment(id, { text: comment.text, tag: comment.tag })).then(
    (c) => upsertComment(c),
    () => undefined,
  );
}

export async function resolveComment(id: string): Promise<void> {
  await tracked(async () => upsertComment(await api.updateComment(id, { state: "resolved" })));
}

export async function reopenComment(id: string): Promise<void> {
  await tracked(async () => upsertComment(await api.updateComment(id, { state: "submitted" })));
}

export async function deleteComment(id: string): Promise<void> {
  await tracked(async () => {
    await api.deleteComment(id);
    removeComment(id);
  });
}

export async function replyToComment(id: string, text: string): Promise<void> {
  await tracked(async () => upsertComment(await api.replyToComment(id, text)));
}

// ---------------------------------------------------------------------------
// Orphan triage (spec §6.4)

export function beginReanchor(id: string): void {
  setState({ reanchoring: id, panel: "none" });
}

export function cancelReanchor(): void {
  setState({ reanchoring: null });
}

export async function reanchorTo(side: Side, line: number): Promise<void> {
  const id = getState().reanchoring;
  if (id === null) return;
  setState({ reanchoring: null });
  await tracked(async () =>
    upsertComment(await api.reanchorComment(id, { line, end_line: line, side })),
  );
}

export async function convertToFileNote(id: string): Promise<void> {
  await tracked(async () => upsertComment(await api.reanchorComment(id, { file_note: true })));
}

export async function dismissOrphan(id: string): Promise<void> {
  await resolveComment(id);
}

// ---------------------------------------------------------------------------
// UI actions

export function setViewMode(viewMode: ViewMode): void {
  setState({ viewMode });
  writePref("viewMode", viewMode);
}

export function setTheme(theme: Theme): void {
  setState({ theme });
}

export function initThemeState(): void {
  setState({ theme: currentTheme() });
}

export function setTreeWidth(width: number): void {
  const clamped = Math.min(480, Math.max(200, Math.round(width)));
  setState({ treeWidth: clamped });
  writePref("treeWidth", clamped);
}

export function setFilterQuery(filterQuery: string): void {
  setState({ filterQuery });
}

export function dismissKbar(): void {
  setState({ kbarDismissed: true });
  writePref("kbarDismissed", true);
}

export function setPanel(panel: Panel): void {
  setState((s) => ({ panel: s.panel === panel ? "none" : panel }));
  if (panel === "history") void loadRevisionList();
}

export function closePanel(): void {
  setState({ panel: "none" });
}

export function setActiveContext(
  path: string | null,
  hunk: { idx: number; count: number } | null,
): void {
  const s = getState();
  if (
    s.activePath === path &&
    s.activeHunk?.idx === hunk?.idx &&
    s.activeHunk?.count === hunk?.count
  ) {
    return;
  }
  setState({ activePath: path, activeHunk: hunk });
}

export function toggleFile(path: string): void {
  setState((s) => {
    const file = s.manifest?.files.find((f) => f.path === path);
    if (!file) return {};
    const expanded = isExpanded(s, file);
    return { collapsedOverride: { ...s.collapsedOverride, [path]: expanded } };
  });
  const st = getState();
  const file = st.manifest?.files.find((f) => f.path === path);
  if (file && isExpanded(st, file)) void loadFileDiff(path);
}

export function collapseAll(): void {
  setState((s) => {
    const override: Record<string, boolean> = {};
    for (const f of s.manifest?.files ?? []) override[f.path] = true;
    return { collapsedOverride: override };
  });
}

// ---------------------------------------------------------------------------
// Expand context (spec §3.2)

const EXPAND_STEP = 20;

export async function ensureFileContent(path: string): Promise<void> {
  if (getState().contextContent[path] !== undefined) return;
  try {
    const result = await api.fileContent(path, "new");
    setState((s) => ({ contextContent: { ...s.contextContent, [path]: result.lines } }));
  } catch {
    // leave unexpanded; the control stays available
  }
}

/** Reveal more context in a gap. direction: "up" reveals above the next hunk,
 * "down" below the previous one, "all" the whole gap. */
export async function expandContext(
  path: string,
  gapIndex: number,
  direction: "up" | "down" | "all",
): Promise<void> {
  await ensureFileContent(path);
  if (getState().contextContent[path] === undefined) return;
  setState((s) => {
    const fileExp: Record<number, GapReveal> = { ...(s.contextExpansion[path] ?? {}) };
    const cur = fileExp[gapIndex] ?? { top: 0, bottom: 0 };
    const next: GapReveal =
      direction === "all"
        ? { top: Number.MAX_SAFE_INTEGER / 4, bottom: 0 }
        : direction === "up"
          ? { ...cur, bottom: cur.bottom + EXPAND_STEP }
          : { ...cur, top: cur.top + EXPAND_STEP };
    fileExp[gapIndex] = next;
    return { contextExpansion: { ...s.contextExpansion, [path]: fileExp } };
  });
}

// ---------------------------------------------------------------------------
// Selection / composer actions

export function beginSelection(file: string, side: Side, line: number): void {
  setState({ selection: { file, side, anchor: line, head: line } });
  // Attach the commit listener immediately (not in a React effect) so a
  // fast click — mousedown+mouseup in the same tick — still commits.
  const onUp = (): void => {
    window.removeEventListener("mouseup", onUp);
    commitSelection();
  };
  window.addEventListener("mouseup", onUp);
}

export function extendSelection(file: string, side: Side, line: number): void {
  setState((s) =>
    s.selection && s.selection.file === file && s.selection.side === side
      ? { selection: { ...s.selection, head: line } }
      : {},
  );
}

/** Finish a drag: open a composer over the selected range. */
export function commitSelection(): void {
  const { selection } = getState();
  if (!selection) return;
  const line = Math.min(selection.anchor, selection.head);
  const endLine = Math.max(selection.anchor, selection.head);
  openComposer(selection.file, selection.side, line, endLine);
  setState({ selection: null });
}

export function cancelSelection(): void {
  setState({ selection: null });
}

export function openComposer(file: string, side: Side, line: number, endLine: number): void {
  const key = composerKey(file, side, line, endLine);
  setState((s) => ({
    composers: { ...s.composers, [key]: { key, file, side, line, end_line: endLine } },
    draftText: key in s.draftText ? s.draftText : { ...s.draftText, [key]: "" },
  }));
}

export function setDraftText(key: string, text: string): void {
  setState((s) => ({ draftText: { ...s.draftText, [key]: text } }));
}

export function closeComposer(key: string): void {
  setState((s) => {
    const composers = { ...s.composers };
    const draftText = { ...s.draftText };
    delete composers[key];
    delete draftText[key];
    return { composers, draftText };
  });
}

/** Create the draft comment (spec §4.2: POST creates drafts; the agent only
 * sees it after Send Feedback). */
export async function submitComposer(key: string, tag: CommentTag | null): Promise<void> {
  const target = getState().composers[key];
  const text = getState().draftText[key]?.trim();
  if (!target || !text) return;
  await tracked(async () => {
    const comment = await api.createComment({
      file: target.file,
      side: target.side,
      line: target.line,
      end_line: target.end_line,
      text,
      tag,
    });
    upsertComment(comment); // SSE will echo it; upsert dedupes by id
    closeComposer(key);
  });
}
