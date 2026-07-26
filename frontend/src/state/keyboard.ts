/** Global review shortcuts, backed by @pierre/diffs' item/line scroll API. */

import {
  cancelReanchor,
  closeInterdiff,
  closePanel,
  closeSearch,
  openComposer,
  openSearch,
  setPanel,
  setViewMode,
  store,
  toggleViewed,
  toggleWrapLines,
} from "./store";
import { selectOrderedFiles } from "./selectors";
import {
  clearDiffSelection,
  currentLocation,
  focusFilter,
  scrollToLocation,
  scrollToPath,
  type DiffLocation,
} from "./controller";
import type { FileDiff, Side } from "../types";

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function filePaths(): string[] {
  const state = store.getState();
  return state.interdiff?.manifest
    ? state.interdiff.manifest.files.map((file) => file.path)
    : selectOrderedFiles(state).map((file) => file.path);
}

function jumpFile(direction: 1 | -1): void {
  const state = store.getState();
  const paths = filePaths();
  const current = state.activePath ? paths.indexOf(state.activePath) : -1;
  const index = current === -1 ? (direction === 1 ? 0 : paths.length - 1) : current + direction;
  const path = paths[index];
  if (path) scrollToPath(path);
}

function loadedDiff(path: string): FileDiff | undefined {
  const state = store.getState();
  if (state.interdiff) return state.interdiff.diffs[path]?.diff;
  return state.fileDiffs[path]?.diff;
}

function hunkTargets(): DiffLocation[] {
  const targets: DiffLocation[] = [];
  for (const path of filePaths()) {
    for (const hunk of loadedDiff(path)?.hunks ?? []) {
      const side: Side = hunk.new_lines > 0 ? "new" : "old";
      targets.push({
        file: path,
        side,
        line: side === "new" ? hunk.new_start : hunk.old_start,
      });
    }
  }
  return targets;
}

function locationOrder(location: DiffLocation): number {
  const paths = filePaths();
  return paths.indexOf(location.file) * 1_000_000_000 + location.line;
}

function jumpLocation(direction: 1 | -1, targets: DiffLocation[]): void {
  const state = store.getState();
  const current =
    currentLocation() ??
    (state.activePath ? { file: state.activePath, side: "new" as const, line: 0 } : null);
  const ordered = targets.slice().sort((a, b) => locationOrder(a) - locationOrder(b));
  const target =
    direction === 1
      ? ordered.find((candidate) => !current || locationOrder(candidate) > locationOrder(current))
      : ordered
          .slice()
          .reverse()
          .find((candidate) => !current || locationOrder(candidate) < locationOrder(current));
  if (target) scrollToLocation(target);
}

function unresolvedTargets(): DiffLocation[] {
  return store
    .getState()
    .comments.filter(
      (comment) => comment.file !== null && comment.line > 0 && comment.state !== "resolved",
    )
    .map((comment) => ({ file: comment.file!, side: comment.side, line: comment.line }));
}

function commentCurrent(): void {
  const state = store.getState();
  let location = currentLocation();
  if (!location && state.activePath) {
    const hunk = loadedDiff(state.activePath)?.hunks[0];
    if (hunk) {
      const side: Side = hunk.new_lines > 0 ? "new" : "old";
      location = {
        file: state.activePath,
        side,
        line: side === "new" ? hunk.new_start : hunk.old_start,
      };
    }
  }
  if (location) openComposer(location.file, location.side, location.line, location.line);
}

export function initKeyboard(): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    const state = store.getState();
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === "f"
    ) {
      openSearch();
      event.preventDefault();
      return;
    }
    if (event.key === "Escape") {
      if (state.panel !== "none") closePanel();
      else if (state.search.open) closeSearch();
      else if (state.interdiff !== null) closeInterdiff();
      else if (state.reanchoring !== null) cancelReanchor();
      else clearDiffSelection();
      return;
    }
    if (isEditable(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;

    switch (event.key) {
      case "j":
        jumpLocation(1, hunkTargets());
        break;
      case "k":
        jumpLocation(-1, hunkTargets());
        break;
      case "n":
        jumpFile(1);
        break;
      case "p":
        jumpFile(-1);
        break;
      case "c":
        commentCurrent();
        break;
      case "v":
        if (state.interdiff === null && state.activePath) void toggleViewed(state.activePath);
        break;
      case "]":
        jumpLocation(1, unresolvedTargets());
        break;
      case "[":
        jumpLocation(-1, unresolvedTargets());
        break;
      case "/":
        focusFilter();
        break;
      case "d":
        setViewMode(state.viewMode === "unified" ? "split" : "unified");
        break;
      case "w":
        toggleWrapLines();
        break;
      case "?":
        setPanel("shortcuts");
        break;
      default:
        return;
    }
    event.preventDefault();
  };
  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}
