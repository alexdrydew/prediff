/**
 * Imperative bridges between components that must not re-render each other:
 * the virtualized diff panel (scrolling) and the file-tree filter input
 * (focus). Registered by the owning component on mount.
 */

import { store } from "./store";
import { selectRows } from "./selectors";

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
  if (index !== -1) diffController?.scrollToIndex(index);
}

export function scrollToRow(index: number, align: "start" | "center" = "start"): void {
  diffController?.scrollToIndex(index, align);
}

export function currentTopIndex(): number {
  return diffController?.getTopIndex() ?? 0;
}
