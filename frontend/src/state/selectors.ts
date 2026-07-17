/** Memoized derived state. */

import type { AppState } from "./store";
import { buildRows, type Row, type RowsInput } from "../lib/rows";

/** memoize-one over the row-model inputs (all reference-compared). */
let lastInput: RowsInput | null = null;
let lastRows: Row[] = [];

export function selectRows(state: AppState): Row[] {
  if (!state.manifest) return lastRows.length === 0 ? lastRows : (lastRows = []);
  const input: RowsInput = {
    files: state.manifest.files,
    expanded: state.expanded,
    fileDiffs: state.fileDiffs,
    comments: state.comments,
    composers: state.composers,
    viewMode: state.viewMode,
  };
  if (
    lastInput &&
    lastInput.files === input.files &&
    lastInput.expanded === input.expanded &&
    lastInput.fileDiffs === input.fileDiffs &&
    lastInput.comments === input.comments &&
    lastInput.composers === input.composers &&
    lastInput.viewMode === input.viewMode
  ) {
    return lastRows;
  }
  lastInput = input;
  lastRows = buildRows(input);
  return lastRows;
}

export function selectOpenCommentCount(state: AppState): number {
  return state.comments.filter((c) => c.state === "open").length;
}
