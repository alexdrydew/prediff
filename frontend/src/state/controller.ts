/** Small imperative bridge around @pierre/diffs' CodeView scroll API. */

import { closeInterdiff, flashSearchHighlight, isExpanded, loadFileDiff, store } from "./store";
import type { SearchMatch, Side } from "../types";

export interface DiffLocation {
  file: string;
  side: Side;
  line: number;
}

export interface DiffController {
  scrollToItem(path: string, align?: "start" | "center"): void;
  scrollToLine(location: DiffLocation, align?: "start" | "center"): void;
  scrollToTop(): void;
  clearSelection(): void;
}

let diffController: DiffController | null = null;
let filterInput: HTMLInputElement | null = null;
let activeLine: DiffLocation | null = null;

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

export function noteActiveLine(location: DiffLocation): void {
  activeLine = location;
}

export function currentLocation(): DiffLocation | null {
  if (activeLine?.file === store.getState().activePath) return activeLine;
  return null;
}

export function scrollToPath(path: string): void {
  diffController?.scrollToItem(path);
}

export function scrollToLocation(location: DiffLocation, align: "start" | "center" = "center"): void {
  activeLine = location;
  diffController?.scrollToLine(location, align);
}

export function scrollToTop(): void {
  diffController?.scrollToTop();
}

export function clearDiffSelection(): void {
  diffController?.clearSelection();
}

/** Expand, load, and jump to a server-side search match. */
export async function jumpToSearchMatch(match: SearchMatch): Promise<void> {
  if (store.getState().interdiff !== null) closeInterdiff();
  const state = store.getState();
  const file = state.manifest?.files.find((entry) => entry.path === match.file);
  if (!file) return;
  if (!isExpanded(state, file)) {
    store.setState((current) => ({
      collapsedOverride: { ...current.collapsedOverride, [match.file]: false },
    }));
  }
  const loaded = store.getState().fileDiffs[match.file];
  const withheld = loaded?.diff?.large === true && loaded.diff.hunks.length === 0;
  if (!loaded || loaded.status !== "ready" || withheld) {
    await loadFileDiff(match.file, { force: file.large || withheld });
    // Give React and CodeView one paint to replace the lazy placeholder before
    // resolving the line target against Diffs' virtual layout.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  const location = { file: match.file, side: match.side, line: match.line };
  scrollToLocation(location);
  flashSearchHighlight(location);
}
