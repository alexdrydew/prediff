/**
 * Keyboard/mouse focus model for diff navigation (QA F4).
 *
 * Keyboard navigation used to derive "current position" purely from the
 * viewport's top row, read from the virtualizer at keypress time. After a
 * mouse interaction (e.g. clicking "Add draft") or immediately after a
 * programmatic jump, that read could be stale — `n` then `c` anchored a
 * comment to the PREVIOUS file's context line.
 *
 * This model tracks an explicit focus anchor (a stable row KEY, not an
 * index, so row-list changes can't silently retarget it):
 *  - any mouse interaction with a diff row or comment card re-syncs the
 *    anchor to that row;
 *  - every keyboard jump (n/p/j/k/]/[) moves the anchor to its target, so
 *    chained keys act from where navigation actually went — never from a
 *    stale viewport read;
 *  - a genuine user scroll clears the anchor: navigation falls back to
 *    following the viewport (the pre-existing behavior);
 *  - if the anchored row no longer exists (e.g. a composer row was replaced
 *    by its new thread row), resolution falls back to the viewport top.
 *
 * Pure and DOM-free so the transitions are unit-testable.
 */

export interface FocusState {
  /** Stable key of the row the user last interacted with / navigated to. */
  anchorKey: string | null;
}

export const INITIAL_FOCUS: FocusState = { anchorKey: null };

/** Mouse interaction with a row (line, gutter, thread card, composer…). */
export function interactedWithRow(_state: FocusState, rowKey: string): FocusState {
  return { anchorKey: rowKey };
}

/** A keyboard jump landed on this row. */
export function keyboardMovedTo(_state: FocusState, rowKey: string): FocusState {
  return { anchorKey: rowKey };
}

/** A user-initiated scroll: focus follows the viewport again. */
export function userScrolled(_state: FocusState): FocusState {
  return { anchorKey: null };
}

/**
 * Resolve the row index navigation should act FROM: the anchored row when it
 * still exists, otherwise the current viewport-top row.
 */
export function resolveFocusIndex(
  state: FocusState,
  rows: readonly { key: string }[],
  topIndex: number,
): number {
  if (state.anchorKey !== null) {
    const index = rows.findIndex((r) => r.key === state.anchorKey);
    if (index !== -1) return index;
  }
  return topIndex;
}

/** First row index in `dir` from `from` (exclusive) matching `match`. */
export function findRowIndex<R>(
  rows: readonly R[],
  from: number,
  dir: 1 | -1,
  match: (row: R) => boolean,
): number {
  for (let i = from + dir; i >= 0 && i < rows.length; i += dir) {
    if (match(rows[i]!)) return i;
  }
  return -1;
}
