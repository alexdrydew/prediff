/**
 * In-diff content search (QA gap §1.3):
 *   GET /api/search?q=<text>&revision=N → matches over the diff's hunk lines
 * plus unit coverage of the pure search over a raw multi-file diff.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SearchResult } from "../src/types";
import { Daemon } from "../src/server/server";
import { matchPreview, searchRawDiff } from "../src/server/search";
import { cleanup, commitAll, initRepo, tempDir, write } from "./helpers";

// ---------------------------------------------------------------------------
// Pure search

const RAW = `diff --git a/src/a.ts b/src/a.ts
index 000..111 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 context alpha
-const makeCode = old();
+const makeCode = fresh();
@@ -10,2 +10,3 @@
 more context
+MAKECODE again
diff --git a/src/b.ts b/src/b.ts
index 000..111 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,2 +1,2 @@
-removed makeCode line
+plain line
`;

describe("searchRawDiff", () => {
  test("case-insensitive substring match across files and hunks", () => {
    const { matches, truncated } = searchRawDiff(RAW, "makecode");
    expect(truncated).toBe(false);
    expect(matches).toHaveLength(4);
    expect(matches.map((m) => `${m.file}:${m.hunk_index}:${m.side}:${m.line}`)).toEqual([
      "src/a.ts:0:old:2", // deleted line matches on the old side
      "src/a.ts:0:new:2",
      "src/a.ts:1:new:11",
      "src/b.ts:0:old:1",
    ]);
  });

  test("previews carry the matched line's text", () => {
    const { matches } = searchRawDiff(RAW, "fresh");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.preview).toBe("const makeCode = fresh();");
  });

  test("empty query matches nothing", () => {
    expect(searchRawDiff(RAW, "")).toEqual({ matches: [], truncated: false });
  });

  test("results are capped with a truncated flag", () => {
    const { matches, truncated } = searchRawDiff(RAW, "e", 2);
    expect(matches).toHaveLength(2);
    expect(truncated).toBe(true);
  });

  test("long lines are trimmed around the first hit", () => {
    const long = " ".repeat(4) + "x".repeat(300) + "NEEDLE" + "y".repeat(300);
    const idx = long.toLowerCase().indexOf("needle");
    const preview = matchPreview(long, idx);
    expect(preview.length).toBeLessThanOrEqual(142); // budget + ellipses
    expect(preview.toLowerCase()).toContain("needle");
  });
});

// ---------------------------------------------------------------------------
// Endpoint

let repo: string;
let stateDir: string;
let daemon: Daemon;
let url: string;

async function http<T>(route: string): Promise<T> {
  const res = await fetch(new URL(route, url));
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.error ?? "?"}`);
  return body;
}

async function httpStatus(route: string): Promise<number> {
  const res = await fetch(new URL(route, url));
  await res.text();
  return res.status;
}

beforeAll(async () => {
  repo = await initRepo();
  stateDir = await tempDir("state");
  await write(repo, "src/util.ts", "export const alpha = 1;\n");
  await commitAll(repo, "base");

  // Revision 1: an edit plus a big untracked file (large-file territory).
  await write(repo, "src/util.ts", "export const alpha = 1;\nexport const uniqueNeedle = 2;\n");
  const bigLines = Array.from({ length: 6000 }, (_, i) => `filler line ${i}`);
  bigLines[5432] = "buried TREASURE token";
  await write(repo, "src/big.txt", bigLines.join("\n") + "\n");

  daemon = new Daemon({ repoRoot: repo, stateDir, range: "working", ttlMs: 0 });
  await daemon.start();
  url = daemon.url;
  (daemon as unknown as { watcher: { stop(): void } }).watcher.stop();
});

afterAll(async () => {
  await daemon.close();
  await cleanup(repo, stateDir);
});

describe("GET /api/search", () => {
  test("finds content matches with file/hunk/line/side", async () => {
    const r = await http<SearchResult>("/api/search?q=uniqueneedle");
    expect(r.revision).toBe(1);
    expect(r.truncated).toBe(false);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]).toMatchObject({
      file: "src/util.ts",
      side: "new",
      line: 2,
      hunk_index: 0,
    });
    expect(r.matches[0]!.preview).toContain("uniqueNeedle");
  });

  test("searches inside large files whose hunks are withheld from the UI", async () => {
    const manifest = await http<{ files: Array<{ path: string; large: boolean }> }>("/api/diff");
    expect(manifest.files.find((f) => f.path === "src/big.txt")?.large).toBe(true);
    const r = await http<SearchResult>("/api/search?q=treasure");
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]).toMatchObject({ file: "src/big.txt", side: "new", line: 5433 });
  });

  test("caps results and sets truncated", async () => {
    const r = await http<SearchResult>("/api/search?q=filler");
    expect(r.matches).toHaveLength(500);
    expect(r.truncated).toBe(true);
  });

  test("historic revision search reads the stored snapshot", async () => {
    // Revision 2: the needle line changes.
    await write(
      repo,
      "src/util.ts",
      "export const alpha = 1;\nexport const renamedNeedle = 2;\n",
    );
    const res = await fetch(new URL("/api/refresh", url), { method: "POST", body: "{}" });
    expect(((await res.json()) as { revision: number }).revision).toBe(2);

    const now = await http<SearchResult>("/api/search?q=uniqueneedle");
    expect(now.matches).toHaveLength(0);
    const then = await http<SearchResult>("/api/search?q=uniqueneedle&revision=1");
    expect(then.revision).toBe(1);
    expect(then.matches).toHaveLength(1);
  });

  test("validates params", async () => {
    expect(await httpStatus("/api/search")).toBe(400);
    expect(await httpStatus("/api/search?q=x&revision=0")).toBe(400);
    expect(await httpStatus("/api/search?q=x&revision=99")).toBe(404);
  });
});
