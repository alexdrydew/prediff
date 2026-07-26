import { describe, expect, test } from "bun:test";
import { filePatch, lineInDiff, pierreFileDiff } from "./diffs";
import type { FileDiff, ManifestFile } from "../types";

const file: ManifestFile = {
  path: "src/value.ts",
  status: "modified",
  additions: 1,
  deletions: 1,
  binary: false,
  large: false,
};

const diff: FileDiff = {
  path: file.path,
  binary: false,
  large: false,
  hunks: [
    {
      old_start: 2,
      old_lines: 1,
      new_start: 2,
      new_lines: 1,
      header: "value",
      lines: [
        { kind: "del", old_line: 2, new_line: null, text: "old" },
        { kind: "add", old_line: null, new_line: 2, text: "new" },
      ],
    },
  ],
};

describe("Diffs adapter", () => {
  test("serializes Prediff hunks as a standard unified patch", () => {
    expect(filePatch(file, diff)).toContain(
      "@@ -2 +2 @@ value\n-old\n+new\n",
    );
  });

  test("lets @pierre/diffs parse partial patches", () => {
    const parsed = pierreFileDiff(
      file,
      { status: "ready", diff, revision: 1 },
      "rev-1",
    );
    expect(parsed.isPartial).toBe(true);
    expect(parsed.hunks).toHaveLength(1);
    expect(parsed.additionLines).toEqual(["new\n"]);
  });

  test("supplies complete sides for native unchanged-line expansion", () => {
    const parsed = pierreFileDiff(
      file,
      {
        status: "ready",
        diff,
        revision: 1,
        oldContent: "top\nold\nbottom",
        newContent: "top\nnew\nbottom",
      },
      "rev-1-full",
    );
    expect(parsed.isPartial).toBe(false);
    expect(parsed.additionLines).toHaveLength(3);
    expect(parsed.hunks[0]?.collapsedBefore).toBe(1);
  });

  test("recognizes lines carried by a structured diff", () => {
    expect(lineInDiff(diff, "old", 2)).toBe(true);
    expect(lineInDiff(diff, "new", 2)).toBe(true);
    expect(lineInDiff(diff, "new", 1)).toBe(false);
  });

  test("changes Diffs' cache key when a placeholder becomes real content", () => {
    const placeholder = pierreFileDiff(file, undefined, "session:1:file");
    const loaded = pierreFileDiff(
      file,
      { status: "ready", diff, revision: 1 },
      "session:1:file",
    );
    expect(loaded.cacheKey).not.toBe(placeholder.cacheKey);
    expect(loaded.splitLineCount).toBeGreaterThan(placeholder.splitLineCount);
  });
});
