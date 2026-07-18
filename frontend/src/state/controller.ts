/**
 * Imperative bridges between components that must not re-render each other:
 * the virtualized diff panel (scrolling) and the file-tree filter input
 * (focus). Registered by the owning component on mount.
 */

import { store } from "./store";
import { selectRows } from "./selectors";
import {
  INITIAL_FOCUS,
  interactedWithRow,
  keyboardMovedTo,
  resolveFocusIndex,
  userScrolled,
  type FocusState,
} from "../lib/focus";

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
