/**
 * Daemon caching paths (against a real spawned daemon):
 *   - warm `open` reuses the cached manifest when the repo signature is
 *     unchanged (no manifest recompute);
 *   - /api/diff/file is served from the per-revision LRU cache on repeat
 *     requests and invalidated on revision bump;
 *   - the fs-event watcher still bumps the revision over SSE when a
 *     tracked file changes.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import path from "node:path";
import type { FileDiff, OpenResult } from "../src/types";
import { BUN, cleanup, commitAll, initRepo, tempDir, write } from "./helpers";

const CLI = path.join(import.meta.dir, "..", "src", "cli", "index.ts");

interface HealthStats {
  manifest_computes: number;
  file_diff_computes: number;
  file_diff_cache_hits: number;
}

let repo: string;
let stateHome: string;
let env: Record<string, string>;
let opened: OpenResult;

async function cli(args: string[]): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn([BUN, CLI, ...args], {
    cwd: repo,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const timer = setTimeout(() => proc.kill(), 30_000);
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  clearTimeout(timer);
  return { code, stdout };
}

async function http<T>(route: string, init?: RequestInit): Promise<T> {
  const res = await fetch(new URL(route, opened.url), init);
  expect(res.ok).toBe(true);
  return (await res.json()) as T;
}

async function stats(): Promise<HealthStats> {
  const health = await http<{ ok: boolean; stats: HealthStats }>("/api/health");
  return health.stats;
}

beforeAll(async () => {
  repo = await initRepo();
  stateHome = await tempDir("state");
  env = {
    ...process.env,
    PREDIFF_STATE_DIR: stateHome,
    PREDIFF_NO_BROWSER: "1",
  } as Record<string, string>;

  await write(repo, "src/a.ts", "export const a = 1;\n");
  await write(repo, "src/b.ts", "export const b = 1;\n");
  await commitAll(repo, "base");
  // Working-tree changes to review.
  await write(repo, "src/a.ts", "export const a = 2;\n");
  await write(repo, "src/b.ts", "export const b = 2;\n");
});

afterAll(async () => {
  await cli(["stop", "--json"]).catch(() => {});
  await cleanup(repo, stateHome);
});

test("warm open with an unchanged repo does not recompute the manifest", async () => {
  const first = await cli(["open", "working", "--json"]);
  expect(first.code).toBe(0);
  opened = JSON.parse(first.stdout) as OpenResult;
  expect(opened.files).toBe(2);

  // Daemon startup computed the manifest once; the /api/open that followed
  // matched the change signature and reused it.
  expect((await stats()).manifest_computes).toBe(1);

  // Two more warm opens: signature still matches → still exactly one compute.
  for (let i = 0; i < 2; i++) {
    const again = await cli(["open", "working", "--json"]);
    expect(again.code).toBe(0);
    expect((JSON.parse(again.stdout) as OpenResult).session_id).toBe(opened.session_id);
  }
  expect((await stats()).manifest_computes).toBe(1);

  const manifest = await http<{ revision: number }>("/api/diff");
  expect(manifest.revision).toBe(1);
}, 30_000);

test("repeat /api/diff/file is served from the per-revision cache", async () => {
  const route = "/api/diff/file?path=" + encodeURIComponent("src/a.ts");
  const cold = await http<FileDiff>(route);
  expect(cold.hunks.length).toBeGreaterThan(0);

  const warm = await http<FileDiff>(route);
  expect(warm).toEqual(cold);

  const s = await stats();
  expect(s.file_diff_computes).toBe(1);
  expect(s.file_diff_cache_hits).toBe(1);
});

test("revision bump invalidates the file cache; open refreshes on change", async () => {
  await write(repo, "src/a.ts", "export const a = 3;\nexport const extra = true;\n");

  const r = await cli(["open", "working", "--json"]);
  expect(r.code).toBe(0);

  // The signature no longer matches → open refreshed → revision bumped
  // (possibly by the watcher racing us to it; either way it's 2).
  const manifest = await http<{ revision: number }>("/api/diff");
  expect(manifest.revision).toBe(2);

  const before = await stats();
  const fresh = await http<FileDiff>("/api/diff/file?path=" + encodeURIComponent("src/a.ts"));
  const texts = fresh.hunks.flatMap((h) => h.lines.map((l) => l.text));
  expect(texts).toContain("export const extra = true;");

  // Served by a fresh git run, not the stale cache entry.
  const after = await stats();
  expect(after.file_diff_computes).toBe(before.file_diff_computes + 1);
  expect(after.file_diff_cache_hits).toBe(before.file_diff_cache_hits);
}, 30_000);

test("watcher detects an edit and bumps the revision over SSE", async () => {
  const res = await fetch(new URL("/events", opened.url));
  expect(res.ok).toBe(true);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();

  const sawGeneration = (async () => {
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      buf += decoder.decode(value, { stream: true });
      const m = /event: revision\ndata: (.*)\n/.exec(buf);
      if (m) return JSON.parse(m[1]!) as { revision: number };
    }
  })();

  await Bun.sleep(300); // let the SSE subscription settle
  await write(repo, "src/b.ts", "export const b = 3;\nexport const more = 1;\n");

  // fs-event path: settle (100ms) + signature check + debounce (250ms);
  // must be well inside the 7s safety poll.
  const event = await Promise.race([sawGeneration, Bun.sleep(6_000).then(() => null)]);
  await reader.cancel().catch(() => {});
  expect(event).not.toBeNull();
  expect(event!.revision).toBe(3);
}, 30_000);
