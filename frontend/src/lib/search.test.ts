import { describe, expect, test } from "bun:test";
import type { FileDiff, HunkLine, ManifestFile } from "../types";
import type { FileDiffState } from "../state/store";
import { buildRows, type RowsInput } from "./rows";
import { findFileRow, findMatchRow } from "./search";

const file = (path: string): ManifestFile => ({
  path,
  status: "modified",
  additions: 1,
  deletions: 1,
  binary: false,
  large: false,
});

const line = (kind: HunkLine["kind"], o: number | null, n: number | null): HunkLine => ({
  kind,
  old_line: o,
  new_line: n,
  text: `${kind} ${o ?? ""}/${n ?? ""}`,
});

const diff = (path: string, lines: HunkLine[]): FileDiff => ({
  path,
  binary: false,
  large: false,
  hunks: [
    {
      old_start: lines.find((l) => l.old_line !== null)?.old_line ?? 1,
      old_lines: lines.filter((l) => l.old_line !== null).length,
      new_start: lines.find((l) => l.new_line !== null)?.new_line ?? 1,
      new_lines: lines.filter((l) => l.new_line !== null).length,
      header: "",
      lines,
    },
  ],
});

const ready = (d: FileDiff): FileDiffState => ({ status: "ready", diff: d, revision: 1 });

const input = (overrides: Partial<RowsInput>): RowsInput => ({
  files: [],
  expanded: new Set(),
  viewedFiles: new Set(),
  fileDiffs: {},
  comments: [],
  composers: {},
  viewMode: "unified",
  contextContent: {},
  contextExpansion: {},
  ...overrides,
});

const LINES = [line("context", 1, 1), line("del", 2, null), line("add", null, 2)];

describe("findMatchRow (search jump target resolution)", () => {
  test("unified: resolves new-side and old-side lines to their rows", () => {
    const rows = buildRows(
      input({
        files: [file("a.ts"), file("b.ts")],
        expanded: new Set(["a.ts", "b.ts"]),
        fileDiffs: { "a.ts": ready(diff("a.ts", LINES)), "b.ts": ready(diff("b.ts", LINES)) },
      }),
    );
    const newIdx = findMatchRow(rows, { file: "b.ts", side: "new", line: 2 });
    expect(rows[newIdx]).toMatchObject({ kind: "line", path: "b.ts", line: { new_line: 2 } });
    const oldIdx = findMatchRow(rows, { file: "b.ts", side: "old", line: 2 });
    expect(rows[oldIdx]).toMatchObject({ kind: "line", path: "b.ts", line: { old_line: 2 } });
    expect(oldIdx).not.toBe(newIdx);
  });

  test("split: a pair row matches either side", () => {
    const rows = buildRows(
      input({
        files: [file("a.ts")],
        expanded: new Set(["a.ts"]),
        fileDiffs: { "a.ts": ready(diff("a.ts", LINES)) },
        viewMode: "split",
      }),
    );
    const idx = findMatchRow(rows, { file: "a.ts", side: "old", line: 2 });
    expect(rows[idx]).toMatchObject({ kind: "pair" });
    expect(findMatchRow(rows, { file: "a.ts", side: "new", line: 2 })).toBe(idx);
  });

  test("collapsed file has no line rows — falls back to the file header", () => {
    const rows = buildRows(input({ files: [file("a.ts")] }));
    expect(findMatchRow(rows, { file: "a.ts", side: "new", line: 2 })).toBe(-1);
    expect(rows[findFileRow(rows, "a.ts")]).toMatchObject({ kind: "file" });
  });

  test("same line number in another file never matches", () => {
    const rows = buildRows(
      input({
        files: [file("a.ts"), file("b.ts")],
        expanded: new Set(["a.ts"]),
        fileDiffs: { "a.ts": ready(diff("a.ts", LINES)) },
      }),
    );
    expect(findMatchRow(rows, { file: "b.ts", side: "new", line: 2 })).toBe(-1);
  });
});
