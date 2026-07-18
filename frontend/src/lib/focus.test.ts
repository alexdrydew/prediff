import { describe, expect, test } from "bun:test";
import {
  INITIAL_FOCUS,
  findRowIndex,
  interactedWithRow,
  keyboardMovedTo,
  resolveFocusIndex,
  userScrolled,
} from "./focus";

/** Minimal stand-in for the row model: stable keys + a kind to navigate by. */
interface TestRow {
  key: string;
  kind: "file" | "line" | "composer" | "thread";
  file: string;
}

const row = (key: string, kind: TestRow["kind"], file: string): TestRow => ({ key, kind, file });

/** Two files; a composer is open mid-file-A (the QA F4 starting point). */
const rowsWithComposer: TestRow[] = [
  row("file:A", "file", "A"),
  row("A:1", "line", "A"),
  row("A:2", "line", "A"),
  row("composer:A", "composer", "A"),
  row("A:3", "line", "A"),
  row("file:B", "file", "B"),
  row("B:1", "line", "B"),
  row("B:2", "line", "B"),
];

/** After "Add draft": the composer row is replaced by a thread row. */
const rowsAfterAddDraft: TestRow[] = rowsWithComposer.map((r) =>
  r.key === "composer:A" ? row("thread:A", "thread", "A") : r,
);

const isFile = (r: TestRow): boolean => r.kind === "file";
const isLine = (r: TestRow): boolean => r.kind === "line";

describe("focus model transitions (QA F4)", () => {
  test("mouse interaction anchors focus to the clicked row", () => {
    const state = interactedWithRow(INITIAL_FOCUS, "B:1");
    // Viewport top is somewhere in file A (stale) — the anchor wins.
    expect(resolveFocusIndex(state, rowsWithComposer, 1)).toBe(6);
  });

  test("user scroll releases the anchor: focus follows the viewport again", () => {
    let state = interactedWithRow(INITIAL_FOCUS, "B:1");
    state = userScrolled(state);
    expect(resolveFocusIndex(state, rowsWithComposer, 1)).toBe(1);
  });

  test("anchored row disappearing falls back to the viewport top (never a stale index)", () => {
    const state = interactedWithRow(INITIAL_FOCUS, "composer:A");
    // "Add draft" replaced the composer row; key no longer exists.
    expect(resolveFocusIndex(state, rowsAfterAddDraft, 2)).toBe(2);
  });

  test("QA F4 scenario: Add draft → n → c anchors in the NEXT file, not the previous one", () => {
    // 1. Mouse click on "Add draft" inside the composer row of file A.
    let state = interactedWithRow(INITIAL_FOCUS, "composer:A");
    // 2. The draft is created: rows change, composer key vanishes.
    const rows = rowsAfterAddDraft;
    // 3. `n` (next file): moves from the resolved focus — file A area.
    const from = resolveFocusIndex(state, rows, 2);
    const next = findRowIndex(rows, from, 1, isFile);
    expect(rows[next]!.key).toBe("file:B");
    // The jump moves the anchor to its target…
    state = keyboardMovedTo(state, rows[next]!.key);
    // 4. `c` immediately after: even if the viewport read is still stale
    //    (topIndex points into file A), focus resolves to file B's header,
    //    and the first code line at/after it belongs to file B.
    const cFrom = resolveFocusIndex(state, rows, /* stale topIndex */ 1);
    expect(cFrom).toBe(5);
    const target = findRowIndex(rows, cFrom - 1, 1, isLine); // first line at/after cFrom
    expect(rows[target]!.file).toBe("B");
  });

  test("n/p always move from the actual focus: p from a mouse-anchored row in file B lands on file B's header, then file A's", () => {
    const state = interactedWithRow(INITIAL_FOCUS, "B:2");
    const from = resolveFocusIndex(state, rowsWithComposer, 0);
    const prev = findRowIndex(rowsWithComposer, from, -1, isFile);
    expect(rowsWithComposer[prev]!.key).toBe("file:B");
    const prev2 = findRowIndex(rowsWithComposer, prev, -1, isFile);
    expect(rowsWithComposer[prev2]!.key).toBe("file:A");
  });

  test("findRowIndex returns -1 when nothing matches in that direction", () => {
    expect(findRowIndex(rowsWithComposer, 0, -1, isFile)).toBe(-1);
    expect(findRowIndex(rowsWithComposer, rowsWithComposer.length - 1, 1, isFile)).toBe(-1);
  });
});
