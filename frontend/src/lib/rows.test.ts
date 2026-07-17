import { describe, expect, test } from "bun:test";
import type { FileDiff, HunkLine, ManifestFile, ReviewComment } from "../types";
import type { ComposerTarget, FileDiffState } from "../state/store";
import { buildRows, estimateRowHeight, LINE_ROW_PX, type RowsInput } from "./rows";

// ---------------------------------------------------------------------------
// fixtures

const file = (path: string, overrides: Partial<ManifestFile> = {}): ManifestFile => ({
  path,
  status: "modified",
  additions: 1,
  deletions: 1,
  binary: false,
  large: false,
  ...overrides,
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

const ready = (d: FileDiff): FileDiffState => ({ status: "ready", diff: d, generation: 1 });

const comment = (
  id: string,
  filePath: string,
  ln: number,
  overrides: Partial<ReviewComment> = {},
): ReviewComment => ({
  id,
  file: filePath,
  line: ln,
  end_line: ln,
  side: "new",
  text: "needs work",
  state: "open",
  generation: 1,
  anchor: { context_before: [], lines: [], context_after: [] },
  replies: [],
  created_at: "",
  updated_at: "",
  ...overrides,
});

const baseInput = (overrides: Partial<RowsInput>): RowsInput => ({
  files: [],
  expanded: new Set(),
  fileDiffs: {},
  comments: [],
  composers: {},
  viewMode: "unified",
  ...overrides,
});

// ---------------------------------------------------------------------------

describe("buildRows", () => {
  test("collapsed files render as headers only", () => {
    const rows = buildRows(baseInput({ files: [file("a.ts"), file("b.ts")] }));
    expect(rows.map((r) => r.kind)).toEqual(["file", "file"]);
  });

  test("expanded file emits hunk header + one row per line", () => {
    const lines = [line("context", 1, 1), line("del", 2, null), line("add", null, 2)];
    const rows = buildRows(
      baseInput({
        files: [file("a.ts")],
        expanded: new Set(["a.ts"]),
        fileDiffs: { "a.ts": ready(diff("a.ts", lines)) },
      }),
    );
    expect(rows.map((r) => r.kind)).toEqual(["file", "hunk", "line", "line", "line"]);
  });

  test("split mode pairs del/add into one row", () => {
    const lines = [line("del", 2, null), line("add", null, 2)];
    const rows = buildRows(
      baseInput({
        files: [file("a.ts")],
        expanded: new Set(["a.ts"]),
        fileDiffs: { "a.ts": ready(diff("a.ts", lines)) },
        viewMode: "split",
      }),
    );
    expect(rows.map((r) => r.kind)).toEqual(["file", "hunk", "pair"]);
  });

  test("expanded-but-unfetched file shows a loading row", () => {
    const rows = buildRows(baseInput({ files: [file("a.ts")], expanded: new Set(["a.ts"]) }));
    expect(rows.map((r) => r.kind)).toEqual(["file", "meta"]);
    expect(rows[1]).toMatchObject({ variant: "loading" });
  });

  test("binary and withheld-large files show meta rows", () => {
    const rows = buildRows(
      baseInput({
        files: [file("bin", { binary: true }), file("big", { large: true })],
        expanded: new Set(["bin", "big"]),
        fileDiffs: {
          big: ready({ path: "big", binary: false, large: true, hunks: [] }),
        },
      }),
    );
    expect(rows.map((r) => r.kind)).toEqual(["file", "meta", "file", "meta"]);
    expect(rows[1]).toMatchObject({ variant: "binary" });
    expect(rows[3]).toMatchObject({ variant: "large" });
  });

  test("comment thread lands directly under its anchored line", () => {
    const lines = [line("context", 1, 1), line("add", null, 2), line("context", 2, 3)];
    const rows = buildRows(
      baseInput({
        files: [file("a.ts")],
        expanded: new Set(["a.ts"]),
        fileDiffs: { "a.ts": ready(diff("a.ts", lines)) },
        comments: [comment("c1", "a.ts", 2)],
      }),
    );
    const kinds = rows.map((r) => r.kind);
    expect(kinds).toEqual(["file", "hunk", "line", "line", "thread", "line"]);
    expect(rows[4]).toMatchObject({ comment: { id: "c1" }, detached: false });
  });

  test("range comment anchors at its end line", () => {
    const lines = [line("add", null, 1), line("add", null, 2), line("add", null, 3)];
    const rows = buildRows(
      baseInput({
        files: [file("a.ts")],
        expanded: new Set(["a.ts"]),
        fileDiffs: { "a.ts": ready(diff("a.ts", lines)) },
        comments: [comment("c1", "a.ts", 1, { end_line: 2 })],
      }),
    );
    expect(rows.map((r) => r.kind)).toEqual(["file", "hunk", "line", "line", "thread", "line"]);
  });

  test("old-side comment anchors on old line numbers", () => {
    const lines = [line("del", 5, null), line("add", null, 5)];
    const rows = buildRows(
      baseInput({
        files: [file("a.ts")],
        expanded: new Set(["a.ts"]),
        fileDiffs: { "a.ts": ready(diff("a.ts", lines)) },
        comments: [comment("c1", "a.ts", 5, { side: "old" })],
      }),
    );
    // thread should follow the del row (index 2), not the add row
    expect(rows.map((r) => r.kind)).toEqual(["file", "hunk", "line", "thread", "line"]);
  });

  test("comment with no matching line is appended detached, never dropped", () => {
    const lines = [line("context", 1, 1)];
    const rows = buildRows(
      baseInput({
        files: [file("a.ts")],
        expanded: new Set(["a.ts"]),
        fileDiffs: { "a.ts": ready(diff("a.ts", lines)) },
        comments: [comment("gone", "a.ts", 999, { state: "outdated" })],
      }),
    );
    const last = rows[rows.length - 1];
    expect(last).toMatchObject({ kind: "thread", detached: true, comment: { id: "gone" } });
  });

  test("comments on collapsed files are counted on the header", () => {
    const rows = buildRows(
      baseInput({
        files: [file("a.ts")],
        comments: [
          comment("c1", "a.ts", 1),
          comment("c2", "a.ts", 2, { state: "resolved" }),
        ],
      }),
    );
    expect(rows[0]).toMatchObject({ kind: "file", commentCount: 2, openCommentCount: 1 });
  });

  test("open composer renders under its target line", () => {
    const lines = [line("add", null, 1), line("add", null, 2)];
    const target: ComposerTarget = {
      key: "k1",
      file: "a.ts",
      side: "new",
      line: 1,
      end_line: 1,
    };
    const rows = buildRows(
      baseInput({
        files: [file("a.ts")],
        expanded: new Set(["a.ts"]),
        fileDiffs: { "a.ts": ready(diff("a.ts", lines)) },
        composers: { k1: target },
      }),
    );
    expect(rows.map((r) => r.kind)).toEqual(["file", "hunk", "line", "composer", "line"]);
  });

  test("same comment is placed exactly once even when line numbers repeat across hunks", () => {
    const d: FileDiff = {
      path: "a.ts",
      binary: false,
      large: false,
      hunks: [
        { old_start: 1, old_lines: 1, new_start: 1, new_lines: 1, header: "", lines: [line("context", 1, 1)] },
        { old_start: 1, old_lines: 1, new_start: 1, new_lines: 1, header: "", lines: [line("context", 1, 1)] },
      ],
    };
    const rows = buildRows(
      baseInput({
        files: [file("a.ts")],
        expanded: new Set(["a.ts"]),
        fileDiffs: { "a.ts": ready(d) },
        comments: [comment("c1", "a.ts", 1)],
      }),
    );
    expect(rows.filter((r) => r.kind === "thread")).toHaveLength(1);
  });
});

describe("windowing math", () => {
  test("line rows have fixed height; total size is predictable", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => line("add", null, i + 1));
    const rows = buildRows(
      baseInput({
        files: [file("a.ts")],
        expanded: new Set(["a.ts"]),
        fileDiffs: { "a.ts": ready(diff("a.ts", lines)) },
      }),
    );
    const lineRows = rows.filter((r) => r.kind === "line");
    expect(lineRows).toHaveLength(1000);
    for (const r of lineRows.slice(0, 5)) expect(estimateRowHeight(r)).toBe(LINE_ROW_PX);
    const total = rows.reduce((sum, r) => sum + estimateRowHeight(r), 0);
    expect(total).toBeGreaterThan(1000 * LINE_ROW_PX);
  });

  test("50k lines flatten quickly and keys are unique", () => {
    const files: ManifestFile[] = [];
    const fileDiffs: Record<string, FileDiffState> = {};
    const expanded = new Set<string>();
    for (let f = 0; f < 10; f++) {
      const path = `f${f}.ts`;
      const lines = Array.from({ length: 5000 }, (_, i) =>
        i % 2 === 0 ? line("del", i + 1, null) : line("add", null, i + 1),
      );
      files.push(file(path));
      fileDiffs[path] = ready(diff(path, lines));
      expanded.add(path);
    }
    const started = performance.now();
    const rows = buildRows(baseInput({ files, expanded, fileDiffs }));
    const elapsed = performance.now() - started;
    expect(rows.length).toBeGreaterThan(50_000);
    expect(elapsed).toBeLessThan(500); // row model must never be the bottleneck
    const keys = new Set(rows.map((r) => r.key));
    expect(keys.size).toBe(rows.length);
  });
});
