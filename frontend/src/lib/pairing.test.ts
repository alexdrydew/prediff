import { describe, expect, test } from "bun:test";
import type { HunkLine } from "../types";
import { pairHunkLines } from "./pairing";

const ctx = (o: number, n: number, text = "ctx"): HunkLine => ({
  kind: "context",
  old_line: o,
  new_line: n,
  text,
});
const del = (o: number, text = "old"): HunkLine => ({
  kind: "del",
  old_line: o,
  new_line: null,
  text,
});
const add = (n: number, text = "new"): HunkLine => ({
  kind: "add",
  old_line: null,
  new_line: n,
  text,
});

describe("pairHunkLines", () => {
  test("context lines occupy both sides", () => {
    const pairs = pairHunkLines([ctx(1, 1), ctx(2, 2)]);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]?.left).toBe(pairs[0]?.right ?? null);
  });

  test("balanced change block zips del/add rows", () => {
    const pairs = pairHunkLines([del(5), del(6), add(5), add(6)]);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]?.left?.old_line).toBe(5);
    expect(pairs[0]?.right?.new_line).toBe(5);
    expect(pairs[1]?.left?.old_line).toBe(6);
    expect(pairs[1]?.right?.new_line).toBe(6);
  });

  test("unbalanced block pads the short side with empties", () => {
    const pairs = pairHunkLines([del(5), add(5), add(6), add(7)]);
    expect(pairs).toHaveLength(3);
    expect(pairs[0]?.left?.old_line).toBe(5);
    expect(pairs[1]?.left).toBeNull();
    expect(pairs[2]?.left).toBeNull();
    expect(pairs[2]?.right?.new_line).toBe(7);
  });

  test("add-only then del-only are separate blocks (not zipped)", () => {
    // add(3) appears before del(7): a del after adds must start a new block.
    const pairs = pairHunkLines([add(3), del(7)]);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]?.left).toBeNull();
    expect(pairs[0]?.right?.new_line).toBe(3);
    expect(pairs[1]?.left?.old_line).toBe(7);
    expect(pairs[1]?.right).toBeNull();
  });

  test("context flushes a pending change block", () => {
    const pairs = pairHunkLines([del(1), add(1), ctx(2, 2)]);
    expect(pairs).toHaveLength(2);
    expect(pairs[1]?.left?.kind).toBe("context");
  });
});
