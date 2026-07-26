import { describe, expect, test } from "bun:test";
import { parsePatch, patchSideContent } from "../src/diff/patch";
import { cleanup, tempDir, write } from "./helpers";

describe("unified patch ingestion", () => {
  test("parses portable diff -u output and strips paired directory roots", () => {
    const patch = [
      "--- before/src/app.ts\t2026-07-25 10:00:00",
      "+++ after/src/app.ts\t2026-07-25 10:01:00",
      "@@ -1,3 +1,3 @@",
      " export function value() {",
      "-  return 1;",
      "+  return 2;",
      " }",
      "",
    ].join("\n");
    const parsed = parsePatch(patch, 1);

    expect(parsed.manifest).toMatchObject({
      range: "patch",
      revision: 1,
      additions: 1,
      deletions: 1,
      files: [{ path: "src/app.ts", status: "modified", additions: 1, deletions: 1 }],
    });
    expect(parsed.raw).toStartWith("diff --git a/src/app.ts b/src/app.ts\n");
    expect(parsed.files.get("src/app.ts")?.hunks).toHaveLength(1);
    expect(patchSideContent(parsed, "new", "src/app.ts")?.[1]).toBe("  return 2;");
    expect(patchSideContent(parsed, "old", "src/app.ts")?.[1]).toBe("  return 1;");
  });

  test("parses multiple Git sections, additions, and deletions", () => {
    const patch = [
      "diff --git a/added.txt b/added.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/added.txt",
      "@@ -0,0 +1,2 @@",
      "+one",
      "+two",
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-old",
      "",
    ].join("\n");
    const parsed = parsePatch(patch, 3);

    expect(parsed.manifest.files.map((file) => [file.path, file.status])).toEqual([
      ["added.txt", "added"],
      ["gone.txt", "deleted"],
    ]);
    expect(parsed.manifest.additions).toBe(2);
    expect(parsed.manifest.deletions).toBe(1);
    expect(patchSideContent(parsed, "old", "added.txt")).toBeNull();
    expect(patchSideContent(parsed, "new", "gone.txt")).toBeNull();
  });

  test("preserves a pure Git rename without hunks", () => {
    const patch = [
      "diff --git a/old name.txt b/new name.txt",
      "similarity index 100%",
      "rename from old name.txt",
      "rename to new name.txt",
      "",
    ].join("\n");
    const parsed = parsePatch(patch, 1);

    expect(parsed.manifest.files).toEqual([
      {
        path: "new name.txt",
        old_path: "old name.txt",
        status: "renamed",
        additions: 0,
        deletions: 0,
        binary: false,
        large: false,
      },
    ]);
  });

  test("accepts an empty diff and rejects non-diff input", () => {
    expect(parsePatch("", 1).manifest.files).toEqual([]);
    expect(() => parsePatch("this is not a unified diff\n", 1)).toThrow(
      "expected unified diff",
    );
  });

  test("consumes real diff -ruN output", async () => {
    const root = await tempDir("unix-diff");
    try {
      await write(root, "before/app.txt", "one\nold\n");
      await write(root, "after/app.txt", "one\nnew\n");
      await write(root, "after/added.txt", "added\n");
      const proc = Bun.spawn(["diff", "-ruN", "before", "after"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, code] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ]);
      expect(code).toBe(1); // canonical diff status: differences found
      const parsed = parsePatch(stdout, 1);
      expect(parsed.manifest.files.map((file) => [file.path, file.status])).toEqual([
        ["added.txt", "modified"],
        ["app.txt", "modified"],
      ]);
      expect(parsed.manifest.additions).toBe(2);
      expect(parsed.manifest.deletions).toBe(1);
    } finally {
      await cleanup(root);
    }
  });
});
