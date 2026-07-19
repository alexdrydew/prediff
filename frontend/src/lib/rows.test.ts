import { describe, expect, test } from "bun:test";
import type { FileDiff, HunkLine, ManifestFile, ReviewComment } from "../types";
import type { ComposerTarget, FileDiffState } from "../state/store";
import { buildRows, estimateRowHeight, LINE_ROW_PX, type Row, type RowsInput } from "./rows";

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

const ready = (d: FileDiff): FileDiffState => ({ status: "ready", diff: d, revision: 1 });

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
  kind: ln === 0 ? "file-note" : "line",
  text: "needs work",
  state: "submitted",
  tag: null,
  suggestion: null,
  revision: 1,
  anchor: { context_before: [], lines: [], context_after: [] },
  replies: [],
  batch_id: null,
  created_at: "",
  updated_at: "",
  ...overrides,
});

const baseInput = (overrides: Partial<RowsInput>): RowsInput => ({
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

/** Row kinds, without expand-context control rows (asserted separately). */
const kinds = (rows: Row[]): string[] =>
  rows.filter((r) => r.kind !== "expand").map((r) => r.kind);

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
    expect(kinds(rows)).toEqual(["file", "hunk", "line", "line", "line"]);
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
    expect(kinds(rows)).toEqual(["file", "hunk", "pair"]);
  });

  test("unified del/add pairs carry each other's text for word-diff marks", () => {
    const lines = [line("del", 2, null), line("add", null, 2)];
    const rows = buildRows(
      baseInput({
        files: [file("a.ts")],
        expanded: new Set(["a.ts"]),
        fileDiffs: { "a.ts": ready(diff("a.ts", lines)) },
      }),
    );
    const lineRows = rows.filter((r) => r.kind === "line");
    expect(lineRows[0]).toMatchObject({ counterpart: lines[1]!.text });
    expect(lineRows[1]).toMatchObject({ counterpart: lines[0]!.text });
  });

  test("expanded-but-unfetched file shows a loading row", () => {
    const rows = buildRows(baseInput({ files: [file("a.ts")], expanded: new Set(["a.ts"]) }));
    expect(rows.map((r) => r.kind)).toEqual(["file", "meta"]);
    expect(rows[1]).toMatchObject({ variant: "loading" });
  });

  test("binary and withheld-large files show meta rows", () => {
    const rows = buildRows(
      baseInput({
        files: [
          file("bin", { binary: true }),
          file("big", { large: true, additions: 6000, deletions: 1200 }),
        ],
        expanded: new Set(["bin", "big"]),
        fileDiffs: {
          big: ready({ path: "big", binary: false, large: true, hunks: [] }),
        },
      }),
    );
    expect(rows.map((r) => r.kind)).toEqual(["file", "meta", "file", "meta"]);
    expect(rows[1]).toMatchObject({ variant: "binary" });
    // the withheld row carries the changed-line count for its copy (QA §2.5)
    expect(rows[3]).toMatchObject({ variant: "large", lines: 7200 });
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
    expect(kinds(rows)).toEqual(["file", "hunk", "line", "line", "thread", "line"]);
    const thread = rows.find((r) => r.kind === "thread");
    expect(thread).toMatchObject({ comment: { id: "c1" }, detached: false });
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
    expect(kinds(rows)).toEqual(["file", "hunk", "line", "line", "thread", "line"]);
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
    // thread should follow the del row, not the add row
    expect(kinds(rows)).toEqual(["file", "hunk", "line", "thread", "line"]);
  });

  test("orphaned comment with no matching line is appended detached, never dropped", () => {
    const lines = [line("context", 1, 1)];
    const rows = buildRows(
      baseInput({
        files: [file("a.ts")],
        expanded: new Set(["a.ts"]),
        fileDiffs: { "a.ts": ready(diff("a.ts", lines)) },
        comments: [comment("gone", "a.ts", 999, { state: "orphaned" })],
      }),
    );
    const last = rows[rows.length - 1];
    expect(last).toMatchObject({ kind: "thread", detached: true, comment: { id: "gone" } });
  });

  test("file-level note (line 0) renders right under the file header", () => {
    const lines = [line("context", 1, 1)];
    const rows = buildRows(
      baseInput({
        files: [file("a.ts")],
        expanded: new Set(["a.ts"]),
        fileDiffs: { "a.ts": ready(diff("a.ts", lines)) },
        comments: [comment("note", "a.ts", 0, { end_line: 0 })],
      }),
    );
    expect(kinds(rows)).toEqual(["file", "thread", "hunk", "line"]);
    expect(rows[1]).toMatchObject({ detached: false });
  });

  test("review-level comments render in a dedicated block above the first file", () => {
    const rows = buildRows(
      baseInput({
        files: [file("a.ts")],
        comments: [
          comment("r1", "a.ts", 0, { file: null, kind: "review", end_line: 0 }),
          comment("c1", "a.ts", 1),
        ],
      }),
    );
    expect(rows.map((r) => r.kind)).toEqual(["review-label", "thread", "file"]);
    expect(rows[0]).toMatchObject({ count: 1 });
    expect(rows[1]).toMatchObject({ path: null, comment: { id: "r1" }, detached: false });
    // the line comment stays counted on its (collapsed) file header
    expect(rows[2]).toMatchObject({ kind: "file", commentCount: 1 });
  });

  test("open review composer emits its row at the end of the review block", () => {
    const rows = buildRows(baseInput({ files: [file("a.ts")], reviewComposerOpen: true }));
    expect(rows.map((r) => r.kind)).toEqual(["review-label", "review-composer", "file"]);
  });

  test("interdiff-unavailable files render an explanatory meta row", () => {
    const rows = buildRows(
      baseInput({
        files: [file("a.bin")],
        expanded: new Set(["a.bin"]),
        unavailable: { "a.bin": "binary file at revision 1" },
      }),
    );
    expect(rows.map((r) => r.kind)).toEqual(["file", "meta"]);
    expect(rows[1]).toMatchObject({
      variant: "unavailable",
      message: "binary file at revision 1",
    });
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
    expect(rows[0]).toMatchObject({ kind: "file", commentCount: 2, unresolvedCount: 1 });
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
    expect(kinds(rows)).toEqual(["file", "hunk", "line", "composer", "line"]);
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

// ---------------------------------------------------------------------------
// Expand context (spec §3.2)

describe("expand context", () => {
  /** One hunk at new lines 10–12 (old 8–10), file content 1..30. */
  const middleHunk = (): FileDiff => ({
    path: "a.ts",
    binary: false,
    large: false,
    hunks: [
      {
        old_start: 8,
        old_lines: 3,
        new_start: 10,
        new_lines: 3,
        header: "",
        lines: [line("context", 8, 10), line("add", null, 11), line("context", 9, 12)],
      },
    ],
  });
  const content = Array.from({ length: 30 }, (_, i) => `content line ${i + 1}`);

  test("gaps produce expand rows above and below a hunk", () => {
    const rows = buildRows(
      baseInput({
        files: [file("a.ts")],
        expanded: new Set(["a.ts"]),
        fileDiffs: { "a.ts": ready(middleHunk()) },
        contextContent: { "a.ts": content },
      }),
    );
    const expands = rows.filter((r) => r.kind === "expand");
    expect(expands).toHaveLength(2);
    expect(expands[0]).toMatchObject({ gap: { index: 0, hidden: 9, up: true, down: false } });
    expect(expands[1]).toMatchObject({ gap: { index: 1, hidden: 18, up: false, down: true } });
  });

  test("trailing gap is offered even before content is fetched", () => {
    const rows = buildRows(
      baseInput({
        files: [file("a.ts")],
        expanded: new Set(["a.ts"]),
        fileDiffs: { "a.ts": ready(middleHunk()) },
      }),
    );
    const expands = rows.filter((r) => r.kind === "expand");
    expect(expands.map((r) => (r.kind === "expand" ? r.gap.hidden : -1))).toEqual([9, null]);
  });

  test("revealed context lines get correct old/new numbers", () => {
    const rows = buildRows(
      baseInput({
        files: [file("a.ts")],
        expanded: new Set(["a.ts"]),
        fileDiffs: { "a.ts": ready(middleHunk()) },
        contextContent: { "a.ts": content },
        // reveal 3 lines above the hunk (bottom edge of leading gap)
        contextExpansion: { "a.ts": { 0: { top: 0, bottom: 3 } } },
      }),
    );
    const synthetic = rows.filter((r) => r.kind === "line" && r.key.startsWith("x:"));
    expect(synthetic).toHaveLength(3);
    expect(synthetic[0]).toMatchObject({
      line: { new_line: 7, old_line: 5, text: "content line 7", kind: "context" },
    });
    expect(synthetic[2]).toMatchObject({ line: { new_line: 9, old_line: 7 } });
    // gap shrinks accordingly
    const expand0 = rows.find((r) => r.kind === "expand" && r.gap.index === 0);
    expect(expand0).toMatchObject({ gap: { hidden: 6 } });
  });

  test("fully revealed gap emits no expand row", () => {
    const rows = buildRows(
      baseInput({
        files: [file("a.ts")],
        expanded: new Set(["a.ts"]),
        fileDiffs: { "a.ts": ready(middleHunk()) },
        contextContent: { "a.ts": content },
        contextExpansion: {
          "a.ts": { 0: { top: 0, bottom: 100 }, 1: { top: 100, bottom: 0 } },
        },
      }),
    );
    expect(rows.filter((r) => r.kind === "expand")).toHaveLength(0);
    const synthetic = rows.filter((r) => r.kind === "line" && r.key.startsWith("x:"));
    expect(synthetic).toHaveLength(9 + 18); // whole file except the hunk
  });
});

// ---------------------------------------------------------------------------

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
