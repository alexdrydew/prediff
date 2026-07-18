import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import {
  computeFileDiff,
  computeManifest,
  parseUnifiedDiff,
  resolveRange,
  EMPTY_TREE,
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
