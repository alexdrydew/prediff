import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import {
  computeFileDiff,
  computeManifest,
  computeRawDiff,
  parseUnifiedDiff,
  resolveRange,
  splitFileSections,
  EMPTY_TREE,
  LARGE_FILE_LINES,
} from "../src/git/diff";
import { cleanup, commitAll, initRepo, sh, write } from "./helpers";

let repo: string;

beforeAll(async () => {
  repo = await initRepo();
  // Base commit: several files exercising the edge cases.
  await write(repo, "plain.txt", "one\ntwo\nthree\n");
  await write(repo, "renamed-from.txt", "alpha\nbeta\ngamma\ndelta\n");
  await write(repo, "no-eof.txt", "first\nlast without newline"); // no trailing \n
  await write(repo, "bin.dat", new Uint8Array([0, 1, 2, 3, 0, 255]));
  await write(repo, "exec.sh", "#!/bin/sh\necho hi\n");
  await write(repo, "日本語/ファイル.txt", "こんにちは\n世界\n");
  await write(repo, "plain-deleted.txt", "goodbye\n");
  await commitAll(repo, "base");

  // Working-tree changes: modify, rename, binary change, mode change,
  // no-newline change, unicode path change, new file, deleted file.
  await write(repo, "plain.txt", "one\nTWO\nthree\nfour\n");
  await fs.rename(path.join(repo, "renamed-from.txt"), path.join(repo, "renamed-to.txt"));
  await write(repo, "bin.dat", new Uint8Array([9, 9, 9, 0, 255, 1]));
  await fs.chmod(path.join(repo, "exec.sh"), 0o755);
  await write(repo, "no-eof.txt", "first\nlast WITH newline\n");
  await write(repo, "日本語/ファイル.txt", "こんにちは\n世界!\n");
  await write(repo, "added.txt", "brand new\n");
  await fs.rm(path.join(repo, "plain-deleted.txt"), { force: true });
  await sh(repo, ["git", "add", "-A"]); // rename detection needs staged paths
});

afterAll(async () => {
  await cleanup(repo);
});

describe("manifest", () => {
  test("covers renames, binary, mode change, unicode, add", async () => {
    const range = await resolveRange(repo, "working");
    const manifest = await computeManifest(repo, range, 1);
    const byPath = new Map(manifest.files.map((f) => [f.path, f]));

    const plain = byPath.get("plain.txt");
    expect(plain).toBeDefined();
    expect(plain!.status).toBe("modified");
    expect(plain!.additions).toBe(2);
    expect(plain!.deletions).toBe(1);
    expect(plain!.binary).toBe(false);

    const renamed = byPath.get("renamed-to.txt");
    expect(renamed).toBeDefined();
    expect(renamed!.status).toBe("renamed");
    expect(renamed!.old_path).toBe("renamed-from.txt");

    const bin = byPath.get("bin.dat");
    expect(bin).toBeDefined();
    expect(bin!.binary).toBe(true);

    const exec = byPath.get("exec.sh");
    expect(exec).toBeDefined();
    expect(exec!.old_mode).toBe("100644");
    expect(exec!.new_mode).toBe("100755");

    const uni = byPath.get("日本語/ファイル.txt");
    expect(uni).toBeDefined();
    expect(uni!.status).toBe("modified");

    const added = byPath.get("added.txt");
    expect(added).toBeDefined();
    expect(added!.status).toBe("added");
    expect(added!.additions).toBe(1);

    const deleted = byPath.get("plain-deleted.txt");
    expect(deleted).toBeDefined();
    expect(deleted!.status).toBe("deleted");
    expect(deleted!.deletions).toBe(1);

    expect(manifest.additions).toBeGreaterThan(0);
    expect(manifest.revision).toBe(1);
  });

  test("staged range equals working here (all changes staged)", async () => {
    const range = await resolveRange(repo, "staged");
    const manifest = await computeManifest(repo, range, 1);
    expect(manifest.files.map((f) => f.path)).toContain("renamed-to.txt");
  });

  test("HEAD range diffs the last commit (against empty tree for root)", async () => {
    const range = await resolveRange(repo, "HEAD");
    expect(range.baseRef).toBe(EMPTY_TREE); // root commit
    const manifest = await computeManifest(repo, range, 1);
    const plain = manifest.files.find((f) => f.path === "plain.txt");
    expect(plain?.status).toBe("added");
  });
});

describe("file hunks", () => {
  test("structured hunks with line numbers", async () => {
    const range = await resolveRange(repo, "working");
    const manifest = await computeManifest(repo, range, 1);
    const plain = manifest.files.find((f) => f.path === "plain.txt")!;
    const diff = await computeFileDiff(repo, range, plain);
    expect(diff.hunks.length).toBe(1);
    const lines = diff.hunks[0]!.lines;
    expect(lines.map((l) => l.kind)).toEqual(["context", "del", "add", "context", "add"]);
    const two = lines.find((l) => l.kind === "del")!;
    expect(two.text).toBe("two");
    expect(two.old_line).toBe(2);
    expect(two.new_line).toBeNull();
    const four = lines[lines.length - 1]!;
    expect(four.text).toBe("four");
    expect(four.new_line).toBe(4);
  });

  test("no-newline-at-eof is flagged", async () => {
    const range = await resolveRange(repo, "working");
    const manifest = await computeManifest(repo, range, 1);
    const f = manifest.files.find((x) => x.path === "no-eof.txt")!;
    const diff = await computeFileDiff(repo, range, f);
    const flagged = diff.hunks.flatMap((h) => h.lines).filter((l) => l.no_newline);
    expect(flagged.length).toBe(1);
    expect(flagged[0]!.kind).toBe("del");
    expect(flagged[0]!.text).toBe("last without newline");
  });

  test("binary file yields no hunks", async () => {
    const range = await resolveRange(repo, "working");
    const manifest = await computeManifest(repo, range, 1);
    const f = manifest.files.find((x) => x.path === "bin.dat")!;
    const diff = await computeFileDiff(repo, range, f);
    expect(diff.binary).toBe(true);
    expect(diff.hunks).toEqual([]);
  });

  test("renamed file diffs via old+new pathspec", async () => {
    const range = await resolveRange(repo, "working");
    const manifest = await computeManifest(repo, range, 1);
    const f = manifest.files.find((x) => x.path === "renamed-to.txt")!;
    const diff = await computeFileDiff(repo, range, f);
    expect(diff.old_path).toBe("renamed-from.txt");
    expect(diff.hunks).toEqual([]); // pure rename, no content change
  });

  test("unicode path diffs cleanly", async () => {
    const range = await resolveRange(repo, "working");
    const manifest = await computeManifest(repo, range, 1);
    const f = manifest.files.find((x) => x.path === "日本語/ファイル.txt")!;
    const diff = await computeFileDiff(repo, range, f);
    const add = diff.hunks.flatMap((h) => h.lines).find((l) => l.kind === "add");
    expect(add?.text).toBe("世界!");
  });
});

describe("ranges", () => {
  test("A..B and single commit-ish", async () => {
    const repo2 = await initRepo();
    try {
      await write(repo2, "a.txt", "1\n");
      await commitAll(repo2, "c1");
      await sh(repo2, ["git", "tag", "v1"]);
      await write(repo2, "a.txt", "1\n2\n");
      await commitAll(repo2, "c2");
      await sh(repo2, ["git", "tag", "v2"]);
      await write(repo2, "a.txt", "1\n2\n3\n");
      await commitAll(repo2, "c3");

      const dots = await resolveRange(repo2, "v1..v2");
      const m1 = await computeManifest(repo2, dots, 1);
      expect(m1.files.length).toBe(1);
      expect(m1.additions).toBe(1);

      const single = await resolveRange(repo2, "v2");
      const m2 = await computeManifest(repo2, single, 1);
      expect(m2.additions).toBe(1); // just c2's change

      const head = await resolveRange(repo2, "HEAD");
      const m3 = await computeManifest(repo2, head, 1);
      expect(m3.files[0]!.additions).toBe(1); // just c3's change
    } finally {
      await cleanup(repo2);
    }
  });

  test("unresolvable range throws", async () => {
    await expect(resolveRange(repo, "no-such-rev")).rejects.toThrow();
  });
});

describe("untracked files", () => {
  let repo3: string;

  beforeAll(async () => {
    repo3 = await initRepo();
    await write(repo3, ".gitignore", "*.log\nignored-dir/\n");
    await write(repo3, "tracked.txt", "one\n");
    await commitAll(repo3, "base");
    // Tracked working change alongside the untracked files.
    await write(repo3, "tracked.txt", "one\ntwo\n");
    // Untracked: plain, nested dirs, binary, empty, ignored.
    await write(repo3, "brand-new.txt", "alpha\nbeta\ngamma\n");
    await write(repo3, "deep/nested/dir/leaf.txt", "leaf\n");
    await write(repo3, "new-bin.dat", new Uint8Array([0, 1, 2, 255, 0, 7]));
    await write(repo3, "new-empty.txt", "");
    await write(repo3, "debug.log", "should stay excluded\n");
    await write(repo3, "ignored-dir/file.txt", "also excluded\n");
  });

  afterAll(async () => {
    await cleanup(repo3);
  });

  test("working manifest includes untracked files as added, with counts and flags", async () => {
    const range = await resolveRange(repo3, "working");
    const manifest = await computeManifest(repo3, range, 1);
    const byPath = new Map(manifest.files.map((f) => [f.path, f]));

    const plain = byPath.get("brand-new.txt");
    expect(plain).toBeDefined();
    expect(plain!.status).toBe("added");
    expect(plain!.additions).toBe(3);
    expect(plain!.deletions).toBe(0);
    expect(plain!.binary).toBe(false);
    expect(plain!.large).toBe(false);
    expect(plain!.untracked).toBe(true);

    // Nested untracked directories are enumerated file-by-file.
    const leaf = byPath.get("deep/nested/dir/leaf.txt");
    expect(leaf).toBeDefined();
    expect(leaf!.status).toBe("added");
    expect(leaf!.additions).toBe(1);

    // Binary detection matches git's ("-" numstat).
    const bin = byPath.get("new-bin.dat");
    expect(bin).toBeDefined();
    expect(bin!.binary).toBe(true);
    expect(bin!.additions).toBe(0);

    // Empty files still show up as added.
    expect(byPath.get("new-empty.txt")?.status).toBe("added");

    // .gitignore'd paths stay excluded.
    expect(byPath.has("debug.log")).toBe(false);
    expect(byPath.has("ignored-dir/file.txt")).toBe(false);

    // Tracked changes still merge in, and totals include untracked adds.
    expect(byPath.get("tracked.txt")?.status).toBe("modified");
    expect(manifest.additions).toBeGreaterThanOrEqual(5); // 1 tracked + 3 + 1
  });

  test("untracked files are absent from staged and HEAD ranges", async () => {
    for (const spec of ["staged", "HEAD"] as const) {
      const range = await resolveRange(repo3, spec);
      const manifest = await computeManifest(repo3, range, 1);
      const paths = manifest.files.map((f) => f.path);
      expect(paths).not.toContain("brand-new.txt");
      expect(paths).not.toContain("deep/nested/dir/leaf.txt");
    }
  });

  test("untracked file hunks are pure additions with correct line numbers", async () => {
    const range = await resolveRange(repo3, "working");
    const manifest = await computeManifest(repo3, range, 1);
    const f = manifest.files.find((x) => x.path === "brand-new.txt")!;
    const diff = await computeFileDiff(repo3, range, f);
    expect(diff.binary).toBe(false);
    expect(diff.hunks.length).toBe(1);
    const lines = diff.hunks[0]!.lines;
    expect(lines.map((l) => l.kind)).toEqual(["add", "add", "add"]);
    expect(lines.map((l) => l.text)).toEqual(["alpha", "beta", "gamma"]);
    expect(lines.map((l) => l.new_line)).toEqual([1, 2, 3]);
    expect(lines.every((l) => l.old_line === null)).toBe(true);
  });

  test("binary untracked file yields no hunks", async () => {
    const range = await resolveRange(repo3, "working");
    const manifest = await computeManifest(repo3, range, 1);
    const f = manifest.files.find((x) => x.path === "new-bin.dat")!;
    const diff = await computeFileDiff(repo3, range, f);
    expect(diff.binary).toBe(true);
    expect(diff.hunks).toEqual([]);
  });

  test("large untracked file withholds hunks unless forced", async () => {
    const big = Array.from({ length: LARGE_FILE_LINES + 1 }, (_, i) => `line ${i}`).join("\n") + "\n";
    await write(repo3, "huge-new.txt", big);
    try {
      const range = await resolveRange(repo3, "working");
      const manifest = await computeManifest(repo3, range, 1);
      const f = manifest.files.find((x) => x.path === "huge-new.txt")!;
      expect(f.large).toBe(true);
      expect(f.additions).toBe(LARGE_FILE_LINES + 1);

      const withheld = await computeFileDiff(repo3, range, f);
      expect(withheld.large).toBe(true);
      expect(withheld.hunks).toEqual([]);

      const forced = await computeFileDiff(repo3, range, f, { force: true });
      expect(forced.large).toBe(false);
      expect(forced.hunks[0]!.lines.length).toBe(LARGE_FILE_LINES + 1);
    } finally {
      await fs.rm(path.join(repo3, "huge-new.txt"), { force: true });
    }
  });

  test("raw working diff carries untracked sections (change detection + history)", async () => {
    const range = await resolveRange(repo3, "working");
    const raw = await computeRawDiff(repo3, range);
    const sections = splitFileSections(raw);
    expect(sections.has("brand-new.txt")).toBe(true);
    expect(sections.has("deep/nested/dir/leaf.txt")).toBe(true);
    expect(sections.has("new-bin.dat")).toBe(true); // binary: header-only section
    expect(sections.has("new-empty.txt")).toBe(true); // empty: header-only section
    expect(sections.has("debug.log")).toBe(false);
    expect(sections.get("brand-new.txt")).toContain("+alpha");

    // Historical hunks are re-parsed from the stored raw text — must match.
    const parsed = parseUnifiedDiff(sections.get("brand-new.txt")!);
    expect(parsed.hunks[0]!.lines.map((l) => l.kind)).toEqual(["add", "add", "add"]);

    // Staged/commit ranges keep the raw diff untouched.
    const staged = await resolveRange(repo3, "staged");
    const stagedSections = splitFileSections(await computeRawDiff(repo3, staged));
    expect(stagedSections.has("brand-new.txt")).toBe(false);
  });
});

describe("parseUnifiedDiff", () => {
  test("handles single-line hunk counts (-l +l with no comma)", () => {
    const text = [
      "diff --git a/f b/f",
      "--- a/f",
      "+++ b/f",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    const { hunks } = parseUnifiedDiff(text);
    expect(hunks.length).toBe(1);
    expect(hunks[0]!.old_lines).toBe(1);
    expect(hunks[0]!.new_lines).toBe(1);
    expect(hunks[0]!.lines.map((l) => l.kind)).toEqual(["del", "add"]);
  });

  test("captures section header text", () => {
    const text = ["@@ -10,2 +10,3 @@ function foo()", " a", "+b", " c", ""].join("\n");
    const { hunks } = parseUnifiedDiff(text);
    expect(hunks[0]!.header).toBe("function foo()");
    expect(hunks[0]!.lines[1]!.new_line).toBe(11);
  });
});
