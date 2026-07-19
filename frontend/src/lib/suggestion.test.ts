import { describe, expect, test } from "bun:test";
import type { Hunk } from "../types";
import { suggestionPrefill } from "./suggestion";

/** One hunk: new lines 10..12 (ctx, add, ctx), old lines 8..9. */
const HUNKS: Hunk[] = [
  {
    old_start: 8,
    old_lines: 3,
    new_start: 10,
    new_lines: 3,
    header: "",
    lines: [
      { kind: "context", old_line: 8, new_line: 10, text: "const a = 1;" },
      { kind: "del", old_line: 9, new_line: null, text: "return old;" },
      { kind: "add", old_line: null, new_line: 11, text: "return fresh;" },
      { kind: "context", old_line: 10, new_line: 12, text: "}" },
    ],
  },
];

describe("suggestionPrefill", () => {
  test("single new-side line comes from the hunk", () => {
    expect(suggestionPrefill(HUNKS, undefined, "new", 11, 11)).toBe("return fresh;");
  });

  test("multi-line range joins the anchored lines", () => {
    expect(suggestionPrefill(HUNKS, undefined, "new", 10, 12)).toBe(
      "const a = 1;\nreturn fresh;\n}",
    );
  });

  test("old-side lines resolve against old line numbers", () => {
    expect(suggestionPrefill(HUNKS, undefined, "old", 9, 9)).toBe("return old;");
  });

  test("line outside the hunks falls back to fetched file content", () => {
    const content = Array.from({ length: 20 }, (_, i) => `file line ${i + 1}`);
    expect(suggestionPrefill(HUNKS, content, "new", 3, 4)).toBe("file line 3\nfile line 4");
    // hunk text wins over content for lines the diff already has
    expect(suggestionPrefill(HUNKS, content, "new", 11, 11)).toBe("return fresh;");
  });

  test("unresolvable lines return null (caller fetches)", () => {
    expect(suggestionPrefill(HUNKS, undefined, "new", 3, 4)).toBeNull();
    expect(suggestionPrefill(undefined, undefined, "new", 1, 1)).toBeNull();
    // range straddling known and unknown lines is unresolvable as a whole
    expect(suggestionPrefill(HUNKS, undefined, "new", 12, 14)).toBeNull();
  });
});
