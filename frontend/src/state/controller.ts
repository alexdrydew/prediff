/**
 * Imperative bridges between components that must not re-render each other:
 * the virtualized diff panel (scrolling) and the file-tree filter input
 * (focus). Registered by the owning component on mount.
 */

import { closeInterdiff, flashSearchHighlight, isExpanded, loadFileDiff, store } from "./store";
import { selectRows } from "./selectors";
import {
  INITIAL_FOCUS,
  interactedWithRow,
  keyboardMovedTo,
  resolveFocusIndex,
  userScrolled,
  type FocusState,
} from "../lib/focus";
import { findFileRow, findMatchRow } from "../lib/search";
import type { SearchMatch } from "../types";

export interface DiffController {
  scrollToIndex(index: number, align?: "start" | "center"): void;
  /** Index of the row currently at the top of the viewport. */
  getTopIndex(): number;
}

let diffController: DiffController | null = null;
let filterInput: HTMLInputElement | null = null;

export function registerDiffController(controller: DiffController | null): void {
  diffController = controller;
}

export function registerFilterInput(el: HTMLInputElement | null): void {
  filterInput = el;
}

export function focusFilter(): void {
  filterInput?.focus();
  filterInput?.select();
}

export function getDiffController(): DiffController | null {
  return diffController;
}

/** Scroll the diff panel to a file's header row (tree → panel sync, §7.2). */
export function scrollToPath(path: string): void {
  const rows = selectRows(store.getState());
  const index = rows.findIndex((r) => r.kind === "file" && r.file.path === path);
  if (index !== -1) {
    // Explicit navigation: keyboard focus follows (QA F4).
    noteKeyboardFocus(rows[index]!.key);
    markProgrammaticScroll();
    diffController?.scrollToIndex(index);
  }
}

export function scrollToRow(index: number, align: "start" | "center" = "start"): void {
  markProgrammaticScroll();
  diffController?.scrollToIndex(index, align);
}

export function currentTopIndex(): number {
  return diffController?.getTopIndex() ?? 0;
}

/**
 * Jump to a content-search match (QA gap §1.3): expand the file if collapsed
 * (that's the point — matches live in files whose rows don't exist yet),
 * force-load withheld large diffs, scroll to the line and flash it.
 */
export async function jumpToSearchMatch(match: SearchMatch): Promise<void> {
  // Search targets the shown revision's diff; leave the comparison view.
  if (store.getState().interdiff !== null) closeInterdiff();
  const s = store.getState();
  const file = s.manifest?.files.find((f) => f.path === match.file);
  if (!file) return;

  if (!isExpanded(s, file)) {
    store.setState((st) => ({
      collapsedOverride: { ...st.collapsedOverride, [match.file]: false },
    }));
  }
  // Ensure hunks exist; large files withhold them until forced.
  const dstate = store.getState().fileDiffs[match.file];
  const withheld = dstate?.diff !== undefined && dstate.diff.large && dstate.diff.hunks.length === 0;
  if (!dstate || dstate.status !== "ready" || withheld) {
    await loadFileDiff(match.file, { force: file.large || withheld });
  }

  const rows = selectRows(store.getState());
  let index = findMatchRow(rows, match);
  if (index === -1) index = findFileRow(rows, match.file); // e.g. binary/empty
  if (index === -1) return;
  noteKeyboardFocus(rows[index]!.key);
  scrollToRow(index, "center");
  flashSearchHighlight({ file: match.file, side: match.side, line: match.line });
}

// ---------------------------------------------------------------------------
// Keyboard/mouse focus anchor (QA F4) — model in lib/focus.ts.

let focus: FocusState = INITIAL_FOCUS;
/** Programmatic scrolls emit scroll events too; ignore them for a beat so
 * they don't clear the anchor the way a genuine user scroll does. */
let programmaticScrollAt = 0;
const PROGRAMMATIC_SCROLL_GRACE_MS = 250;

function markProgrammaticScroll(): void {
  programmaticScrollAt = Date.now();
}

/** Mouse interaction with a diff row / comment card: re-sync focus to it. */
export function noteRowInteraction(rowKey: string): void {
  focus = interactedWithRow(focus, rowKey);
}

/** A keyboard jump landed on this row. */
export function noteKeyboardFocus(rowKey: string): void {
  focus = keyboardMovedTo(focus, rowKey);
}

/** Called from the diff panel's scroll listener. */
export function noteScroll(): void {
  if (Date.now() - programmaticScrollAt > PROGRAMMATIC_SCROLL_GRACE_MS) {
    focus = userScrolled(focus);
  }
}

/** Row index keyboard navigation acts from (anchor if alive, else viewport). */
export function currentFocusIndex(): number {
  return resolveFocusIndex(focus, selectRows(store.getState()), currentTopIndex());
}
