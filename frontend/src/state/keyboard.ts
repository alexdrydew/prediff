/**
 * Global keyboard model — exactly the spec §8 table, nothing more:
 *   j/k hunks · n/p files · c comment · Cmd/Ctrl+Enter submit (composer-local)
 *   Esc cancel/close · v viewed · ]/[ unresolved comments · / filter ·
 *   d view toggle · ? shortcut overlay
 */

import {
  cancelReanchor,
  cancelSelection,
  closePanel,
  openComposer,
  setPanel,
  setViewMode,
  store,
  toggleViewed,
} from "./store";
import { selectRows } from "./selectors";
import { currentTopIndex, focusFilter, scrollToRow } from "./controller";
import type { Row } from "../lib/rows";

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function findRow(
  rows: Row[],
  from: number,
  dir: 1 | -1,
  match: (row: Row) => boolean,
): number {
  for (let i = from + dir; i >= 0 && i < rows.length; i += dir) {
    if (match(rows[i]!)) return i;
  }
  return -1;
}

function jump(dir: 1 | -1, match: (row: Row) => boolean, align: "start" | "center" = "start"): void {
  const rows = selectRows(store.getState());
  const index = findRow(rows, currentTopIndex(), dir, match);
  if (index !== -1) scrollToRow(index, align);
}

/** Comment on the hunk currently at the top of the viewport (spec §8 `c`). */
function commentCurrent(): void {
  const rows = selectRows(store.getState());
  const top = currentTopIndex();
  // Find the first code line at/after the current row (skipping backwards to
  // the hunk if we're on a header).
  for (let i = Math.max(0, top); i < rows.length; i++) {
    const row = rows[i]!;
    if (row.kind === "line") {
      const side = row.line.new_line !== null ? "new" : "old";
      const n = side === "new" ? row.line.new_line! : row.line.old_line!;
      openComposer(row.path, side, n, n);
      return;
    }
    if (row.kind === "pair") {
      const line = row.pair.right ?? row.pair.left;
      if (!line) continue;
      const side = line.new_line !== null ? "new" : "old";
      const n = side === "new" ? line.new_line! : line.old_line!;
      openComposer(row.path, side, n, n);
      return;
    }
  }
}

export function initKeyboard(): () => void {
  const onKeyDown = (e: KeyboardEvent): void => {
    const s = store.getState();

    if (e.key === "Escape") {
      if (s.panel !== "none") {
        closePanel();
        e.preventDefault();
        return;
      }
      if (s.reanchoring !== null) {
        cancelReanchor();
        e.preventDefault();
        return;
      }
      if (s.selection !== null) {
        cancelSelection();
        return;
      }
      return;
    }

    if (isEditable(e.target)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    switch (e.key) {
      case "j":
        jump(1, (r) => r.kind === "hunk");
        break;
      case "k":
        jump(-1, (r) => r.kind === "hunk");
        break;
      case "n":
        jump(1, (r) => r.kind === "file");
        break;
      case "p":
        jump(-1, (r) => r.kind === "file");
        break;
      case "c":
        commentCurrent();
        break;
      case "v": {
        const path = s.activePath;
        if (path !== null) void toggleViewed(path);
        break;
      }
      case "]":
        jump(1, (r) => r.kind === "thread" && r.comment.state !== "resolved", "center");
        break;
      case "[":
        jump(-1, (r) => r.kind === "thread" && r.comment.state !== "resolved", "center");
        break;
      case "/":
        focusFilter();
        e.preventDefault();
        break;
      case "d":
        setViewMode(s.viewMode === "unified" ? "split" : "unified");
        break;
      case "?":
        setPanel("shortcuts");
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}
