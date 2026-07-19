/**
 * Line-level interdiff between revisions (QA gap §1.4):
 *   GET /api/interdiff/manifest?from&to — per-file add/del counts
 *   GET /api/interdiff?file&from&to     — structured hunks (FileDiff shape)
 * Backed by per-revision gzipped new-side file contents stored alongside the
 * revision snapshots and pruned with them.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import type { InterdiffFile, InterdiffManifest } from "../src/types";
import { Daemon } from "../src/server/server";
import { HISTORY_MAX, RevisionStore } from "../src/store/revisions";
import { cleanup, commitAll, initRepo, tempDir, write } from "./helpers";

let repo: string;
let stateDir: string;
let daemon: Daemon;
let url: string;

async function http<T>(route: string, init?: RequestInit): Promise<T> {
  const res = await fetch(new URL(route, url), {
    ...init,
    headers: { "content-type": "application/json" },
  });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.error ?? "?"}`);
  return body;
}

async function httpStatus(route: string): Promise<number> {
  const res = await fetch(new URL(route, url));
  await res.text();
  return res.status;
}

async function refresh(): Promise<number> {
  const r = await http<{ revision: number }>("/api/refresh", { method: "POST", body: "{}" });
  return r.revision;
}

beforeAll(async () => {
  repo = await initRepo();
  stateDir = await tempDir("state");
  await write(repo, "src/a.ts", "alpha\nbeta\ngamma\n");
  await write(repo, "src/b.ts", "one\ntwo\n");
  await commitAll(repo, "base");

  // Revision 1: both files changed vs base.
  await write(repo, "src/a.ts", "alpha\nbeta2\ngamma\n");
  await write(repo, "src/b.ts", "one\ntwo\nthree\n");

  daemon = new Daemon({ repoRoot: repo, stateDir, range: "working", ttlMs: 0 });
  await daemon.start();
  url = daemon.url;
  (daemon as unknown as { watcher: { stop(): void } }).watcher.stop();

  // Revision 2: a.ts edited again, an untracked file appears; b.ts untouched.
  await write(repo, "src/a.ts", "alpha\nbeta3\ngamma\ndelta\n");
  await write(repo, "src/new.ts", "n1\nn2\n");
  expect(await refresh()).toBe(2);

  // Revision 3: the untracked file is deleted again; b.ts grows.
  await fs.rm(path.join(repo, "src/new.ts"));
  await write(repo, "src/b.ts", "one\ntwo\nthree\nfour\n");
  expect(await refresh()).toBe(3);
});

afterAll(async () => {
  await daemon.close();
  await cleanup(repo, stateDir);
});

describe("GET /api/interdiff/manifest", () => {
  test("1→2 lists only files that changed between the revisions, with counts", async () => {
    const m = await http<InterdiffManifest>("/api/interdiff/manifest?from=1&to=2");
    expect(m.from).toBe(1);
    expect(m.to).toBe(2);
    expect(m.files.map((f) => f.path)).toEqual(["src/a.ts", "src/new.ts"]); // b.ts untouched
    const a = m.files.find((f) => f.path === "src/a.ts")!;
    expect(a).toMatchObject({ additions: 2, deletions: 1, available: true }); // beta2→beta3, +delta
    const created = m.files.find((f) => f.path === "src/new.ts")!;
    expect(created).toMatchObject({ additions: 2, deletions: 0, available: true });
    expect(m.additions).toBe(4);
    expect(m.deletions).toBe(1);
  });

  test("2→3 covers a file deleted between revisions", async () => {
    const m = await http<InterdiffManifest>("/api/interdiff/manifest?from=2&to=3");
    expect(m.files.map((f) => f.path)).toEqual(["src/b.ts", "src/new.ts"]);
    expect(m.files.find((f) => f.path === "src/new.ts")).toMatchObject({
      additions: 0,
      deletions: 2,
    });
    expect(m.files.find((f) => f.path === "src/b.ts")).toMatchObject({
      additions: 1,
      deletions: 0,
    });
  });

  test("1→3: a file created and deleted in between never appears", async () => {
    const m = await http<InterdiffManifest>("/api/interdiff/manifest?from=1&to=3");
    expect(m.files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("validation: missing/equal/unknown revisions", async () => {
    expect(await httpStatus("/api/interdiff/manifest?from=1")).toBe(400);
    expect(await httpStatus("/api/interdiff/manifest?from=2&to=2")).toBe(400);
    expect(await httpStatus("/api/interdiff/manifest?from=1&to=99")).toBe(404);
    expect(await httpStatus("/api/interdiff/manifest?from=zero&to=2")).toBe(400);
  });
});

describe("GET /api/interdiff (single file)", () => {
  test("structured hunks with interdiff line numbers", async () => {
    const d = await http<InterdiffFile>(
      "/api/interdiff?file=" + encodeURIComponent("src/a.ts") + "&from=1&to=2",
    );
    expect(d).toMatchObject({ path: "src/a.ts", from: 1, to: 2, binary: false, large: false });
    const lines = d.hunks.flatMap((h) => h.lines);
    expect(lines.filter((l) => l.kind === "del").map((l) => l.text)).toEqual(["beta2"]);
    expect(lines.filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["beta3", "delta"]);
    // Line numbers are positions within the two revisions' contents.
    expect(lines.find((l) => l.text === "beta3")!.new_line).toBe(2);
    expect(lines.find((l) => l.text === "delta")!.new_line).toBe(4);
  });

  test("a file in the diff but untouched between the revisions yields no hunks", async () => {
    const d = await http<InterdiffFile>(
      "/api/interdiff?file=" + encodeURIComponent("src/b.ts") + "&from=1&to=2",
    );
    expect(d.hunks).toEqual([]);
  });

  test("a file deleted between revisions diffs to pure deletions", async () => {
    const d = await http<InterdiffFile>(
      "/api/interdiff?file=" + encodeURIComponent("src/new.ts") + "&from=2&to=3",
    );
    const lines = d.hunks.flatMap((h) => h.lines);
    expect(lines.every((l) => l.kind === "del")).toBe(true);
    expect(lines.map((l) => l.text)).toEqual(["n1", "n2"]);
  });

  test("unknown files are 404; missing params are 400", async () => {
    expect(await httpStatus("/api/interdiff?file=nope.ts&from=1&to=2")).toBe(404);
    expect(await httpStatus("/api/interdiff?from=1&to=2")).toBe(400);
  });

  test("files whose content wasn't materialized (large) are 409/flagged", async () => {
    // An untracked file over the large threshold: content is never stored.
    const big = Array.from({ length: 5_001 }, (_, i) => `line ${i}`).join("\n") + "\n";
    await write(repo, "big.txt", big);
    expect(await refresh()).toBe(4);

    const m = await http<InterdiffManifest>("/api/interdiff/manifest?from=3&to=4");
    const flagged = m.files.find((f) => f.path === "big.txt")!;
    expect(flagged.available).toBe(false);
    expect(flagged.reason).toContain("large");

    expect(await httpStatus("/api/interdiff?file=big.txt&from=3&to=4")).toBe(409);
  });
});

describe("revision-content persistence", () => {
  test("contents are stored gzipped alongside snapshots and pruned with them", async () => {
    const dir = await tempDir("revstore");
    const store = new RevisionStore(dir);
    const manifest = { range: "working", revision: 0, files: [], additions: 0, deletions: 0 };
    for (let n = 1; n <= HISTORY_MAX + 3; n++) {
      await store.save("sess_t", {
        revision: n,
        created_at: new Date().toISOString(),
        manifest: { ...manifest, revision: n },
        raw_diff: `diff ${n}`,
      });
      await store.saveContents("sess_t", {
        revision: n,
        files: { "a.ts": [`content ${n}`] },
        skipped: {},
      });
    }
    expect(await store.loadContents("sess_t", 2)).toBeNull(); // pruned
    expect(await store.hasContents("sess_t", 3)).toBe(false); // pruned
    const kept = await store.loadContents("sess_t", HISTORY_MAX + 3);
    expect(kept?.files["a.ts"]).toEqual([`content ${HISTORY_MAX + 3}`]);
    // Contents files never pollute the revision list.
    const listed = await store.list("sess_t");
    expect(listed.length).toBe(HISTORY_MAX);
    await cleanup(dir);
  });
});
